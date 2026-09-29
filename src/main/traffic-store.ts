export interface StoredRequest {
  requestId: string
  url: string
  host: string
  method: string
  resourceType: string
  startedAt: number
  completedAt?: number
  status?: number
  mimeType?: string
  encodedDataLength?: number
  requestHeaders?: Record<string, string>
  requestPostData?: string
  responseHeaders?: Record<string, string>
  responseBody?: string
  responseBodyBase64?: boolean
  responseBodyTruncated?: boolean
  responseBodyError?: string
  // initiator info
  initiatorType?: string
  initiatorStack?: Array<{
    functionName: string
    url: string
    lineNumber: number
    columnNumber: number
  }>
  initiatorUrl?: string
}

// ── WebSocket frames ────────────────────────────────────────────────────────

export interface WSFrame {
  direction: 'sent' | 'received'
  opcode: number
  payloadData: string
  timestamp: number
  mask?: boolean
}

const wsFrames = new Map<string, WSFrame[]>()
// Cap frames per request so a single long-lived socket can't grow unbounded
// even while its request stays inside the ring buffer.
const MAX_WS_FRAMES_PER_REQUEST = 2000

export function appendWsFrame(requestId: string, frame: WSFrame): void {
  let frames = wsFrames.get(requestId)
  if (!frames) {
    frames = []
    wsFrames.set(requestId, frames)
  }
  frames.push(frame)
  if (frames.length > MAX_WS_FRAMES_PER_REQUEST) frames.shift()
}

export function getWsFrames(requestId: string, since?: number): WSFrame[] {
  const frames = wsFrames.get(requestId) ?? []
  if (since == null) return frames
  return frames.filter((f) => f.timestamp >= since)
}

// ── Console logs ────────────────────────────────────────────────────────────

export interface ConsoleEntry {
  ts: number
  type: string
  text: string
  args?: unknown[]
  stackTrace?: unknown
}

const MAX_CONSOLE = 1000
const consoleLogs: ConsoleEntry[] = []

export function appendConsole(entry: ConsoleEntry): void {
  consoleLogs.push(entry)
  if (consoleLogs.length > MAX_CONSOLE) consoleLogs.shift()
}

export function getConsoleSince(since?: number): ConsoleEntry[] {
  if (since == null) return [...consoleLogs]
  return consoleLogs.filter((e) => e.ts >= since)
}

export function getConsoleCount(): number {
  return consoleLogs.length
}

export function clearConsole(): void {
  consoleLogs.length = 0
}

// ── Runtime exceptions ───────────────────────────────────────────────────────

export interface RuntimeException {
  ts: number
  text: string
  exception?: unknown
  stackTrace?: unknown
}

const MAX_EXCEPTIONS = 200
const runtimeExceptions: RuntimeException[] = []

export function appendException(entry: RuntimeException): void {
  runtimeExceptions.push(entry)
  if (runtimeExceptions.length > MAX_EXCEPTIONS) runtimeExceptions.shift()
}

export function getExceptions(): RuntimeException[] {
  return [...runtimeExceptions]
}

export function getExceptionCount(): number {
  return runtimeExceptions.length
}

export function getWebSocketCount(): number {
  let n = 0
  for (const id of order) {
    if (entries.get(id)?.resourceType === 'WebSocket') n++
  }
  return n
}

// 링 버퍼 용량. REVER_TRAFFIC_MAX_ENTRIES env로 조정 가능 (기본 500, 하한 50).
// 장시간 스캔/탐색에서 초반 요청이 축출되면 get_request로 조회 불가 → DAST 엔진처럼
// 스냅샷 폴백을 가진 소비자도 있는 만큼 용량 조정과 축출 관측을 함께 제공한다.
const DEFAULT_MAX_ENTRIES = 500
const MIN_MAX_ENTRIES = 50
let maxEntries = resolveMaxEntries()

function resolveMaxEntries(): number {
  const raw = process.env.REVER_TRAFFIC_MAX_ENTRIES
  if (raw == null || raw === '') return DEFAULT_MAX_ENTRIES
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return DEFAULT_MAX_ENTRIES
  return Math.max(MIN_MAX_ENTRIES, n)
}

export function setTrafficMaxEntries(n: number): void {
  // NaN/±Infinity는 Math.max를 통과하면서 maxEntries를 비유한값으로 오염시킨다
  // (NaN이면 order.length > NaN이 항상 false라 축출이 완전히 멈춘다) — 거부한다.
  if (!Number.isFinite(n)) return
  maxEntries = Math.max(MIN_MAX_ENTRIES, Math.floor(n))
  evictIfNeeded()
}

export function getTrafficMaxEntries(): number {
  return maxEntries
}
// Per-body byte ceiling. 8MB sits above webcrack's 5MB deobfuscation limit, so
// large JS bundles (the whole point of this tool) survive intact, while a
// pathological multi-hundred-MB body can't blow up the ring buffer. Bodies past
// the cap are truncated and flagged.
const MAX_BODY_CHARS = 8 * 1024 * 1024
// 전체 바디 누적 예산: 256MB. 초과 시 가장 오래된 엔트리의 responseBody를 비워낸다.
const MAX_TOTAL_BODY_BYTES = 256 * 1024 * 1024

function capBody<T extends Partial<StoredRequest>>(req: T): T {
  if (req.responseBody != null && req.responseBody.length > MAX_BODY_CHARS) {
    return { ...req, responseBody: req.responseBody.slice(0, MAX_BODY_CHARS), responseBodyTruncated: true }
  }
  return req
}

const order: string[] = []
const entries = new Map<string, StoredRequest>()
// 현재 누적 바디 바이트 수 (UTF-16 코드 유닛 기준, JS string.length)
let totalBodyBytes = 0

// 프로세스 시작 이후 링 버퍼에서 축출된 엔트리 수. 조회 도구는 이 카운터를
// 노출해 "조용한 데이터 유실"을 관측 가능하게 한다 (issue/12 참조).
let totalEvicted = 0

export function getEvictedCount(): number {
  return totalEvicted
}

function evictIfNeeded() {
  while (order.length > maxEntries) {
    const oldest = order.shift()
    if (oldest) {
      const e = entries.get(oldest)
      if (e?.responseBody) {
        totalBodyBytes = Math.max(0, totalBodyBytes - e.responseBody.length)
      }
      entries.delete(oldest)
      totalEvicted++
      // Free any WebSocket frames keyed by this requestId — otherwise the
      // wsFrames map grows forever as requests churn through the ring buffer.
      wsFrames.delete(oldest)
    }
  }
  // 전역 바디 예산 초과 시 가장 오래된 엔트리부터 responseBody를 비운다.
  // 엔트리 자체는 유지해 메타데이터(URL, status 등)는 접근 가능하게 한다.
  if (totalBodyBytes > MAX_TOTAL_BODY_BYTES) {
    for (const id of order) {
      if (totalBodyBytes <= MAX_TOTAL_BODY_BYTES) break
      const e = entries.get(id)
      if (e?.responseBody) {
        totalBodyBytes = Math.max(0, totalBodyBytes - e.responseBody.length)
        e.responseBody = undefined
        e.responseBodyTruncated = true
      }
    }
  }
}

export function upsertRequest(rawReq: Partial<StoredRequest> & { requestId: string }) {
  const req = capBody(rawReq)
  const existing = entries.get(req.requestId)
  if (existing) {
    // responseBody가 교체될 때 전역 카운터를 갱신한다.
    if (req.responseBody !== undefined) {
      const old = existing.responseBody?.length ?? 0
      const next = req.responseBody?.length ?? 0
      totalBodyBytes = Math.max(0, totalBodyBytes - old) + next
    }
    Object.assign(existing, req)
    evictIfNeeded()
    return
  }
  const newEntry: StoredRequest = {
    url: '',
    host: '',
    method: '',
    resourceType: 'Other',
    startedAt: Date.now(),
    ...req
  }
  if (newEntry.responseBody) {
    totalBodyBytes += newEntry.responseBody.length
  }
  entries.set(req.requestId, newEntry)
  order.push(req.requestId)
  evictIfNeeded()
}

export interface ListFilter {
  host?: string
  methodOrType?: string
  since?: number
  // 2026-09-21 사용자 리뷰 항목 4: har_export가 한 번에 너무 많은 entry를 실어 보내면
  // 클라이언트 쪽 SSE 파서(1MB 이벤트 크기 제한, httpx2 DEFAULT_MAX_EVENT_SIZE_BYTES)가
  // 스트림을 끊어버린다(rever-browser 쪽 버그가 아니라 클라이언트 쪽 제약으로 확인됨).
  // 이 상한 아래로 안전하게 여러 페이지에 나눠 받으려면 "이 시각보다 오래된 것만"
  // 필터가 필요한데, since(하한)만으로는 "다음 페이지(더 오래된 것)"를 못 구한다.
  // inclusive(<=)다 — 같은 ms에 여러 entry가 몰려 있을 때 페이지 경계에서 그중 일부만
  // 앞 페이지에 실렸다면(그 페이지의 limit이 먼저 찼음) exclusive였다면 나머지 형제
  // entry가 조용히 사라진다. inclusive로 커서 entry를 다음 페이지에서 다시 포함시키고,
  // 호출부가 request_id로 중복 제거하게 한다(orchestrator의 fetch_raw_requests_paged 참고).
  before?: number
  limit?: number
}

export function listRequests(filter: ListFilter = {}): StoredRequest[] {
  const limit = filter.limit ?? 50
  const result: StoredRequest[] = []
  for (let i = order.length - 1; i >= 0 && result.length < limit; i--) {
    const e = entries.get(order[i])
    if (!e) continue
    if (filter.host && !e.host.includes(filter.host)) continue
    if (filter.methodOrType) {
      const needle = filter.methodOrType.toLowerCase()
      if (
        !e.method.toLowerCase().includes(needle) &&
        !e.resourceType.toLowerCase().includes(needle)
      ) {
        continue
      }
    }
    if (filter.since && e.startedAt < filter.since) continue
    if (filter.before !== undefined && e.startedAt > filter.before) continue
    result.push(e)
  }
  return result
}

export function getRequest(requestId: string): StoredRequest | undefined {
  return entries.get(requestId)
}

// ── responseReceivedExtraInfo merge ─────────────────────────────────────────
// Network.responseReceived.response.headers omits Set-Cookie (verified against
// Chrome via CDP: the event's header map carries no Set-Cookie even when the
// server sets one). Chromium delivers the complete raw header block in
// Network.responseReceivedExtraInfo instead — the same event Puppeteer uses
// for rawHeaders. Ordering of the two events is not guaranteed, so whichever
// arrives first is buffered here and merged when the other lands.
const pendingExtraResponseHeaders = new Map<string, Record<string, string>>()
const MAX_PENDING_EXTRA_RESPONSE_HEADERS = 1000

export function mergeExtraResponseHeaders(
  requestId: string,
  extraHeaders: Record<string, string>
): void {
  const existing = entries.get(requestId)
  if (existing?.responseHeaders) {
    // responseReceived already arrived — merge in place. The stored headers
    // win for shared names; the extra info contributes the omitted ones
    // (Set-Cookie, Chromium folds repeated cookies into one '\n'-joined value).
    existing.responseHeaders = { ...extraHeaders, ...existing.responseHeaders }
    return
  }
  if (pendingExtraResponseHeaders.size >= MAX_PENDING_EXTRA_RESPONSE_HEADERS) {
    const oldest = pendingExtraResponseHeaders.keys().next().value
    if (oldest !== undefined) pendingExtraResponseHeaders.delete(oldest)
  }
  pendingExtraResponseHeaders.set(requestId, extraHeaders)
}

export function takePendingExtraResponseHeaders(
  requestId: string
): Record<string, string> | undefined {
  const extra = pendingExtraResponseHeaders.get(requestId)
  if (extra) pendingExtraResponseHeaders.delete(requestId)
  return extra
}

export function clearTraffic() {
  order.length = 0
  entries.clear()
  wsFrames.clear()
  pendingExtraResponseHeaders.clear()
  totalBodyBytes = 0
  totalEvicted = 0
}
