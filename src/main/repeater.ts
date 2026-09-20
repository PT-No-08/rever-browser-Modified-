import { getActiveTarget } from './chrome-cdp'
import { getRequest } from './traffic-store'

export interface RepeaterModifications {
  url?: string
  method?: string
  setHeaders?: Record<string, string>
  removeHeaders?: string[]
  body?: string | null
}

export interface RepeaterRequestSpec {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export interface RepeaterResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  bodyTruncated: boolean
  bodyByteLength: number
  timeMs: number
  error?: string
}

const MAX_BODY_BYTES = 64 * 1024

// fetch() refuses to set these. Strip them from copied request headers and from
// caller-provided overrides so the page-side fetch doesn't throw a TypeError.
const FORBIDDEN_HEADER_RE =
  /^(?:host|connection|content-length|trailer|transfer-encoding|upgrade|keep-alive|te|expect|cookie2|date|origin|referer|user-agent|accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|via|sec-.+|proxy-.+)$/i

function dropForbidden(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (FORBIDDEN_HEADER_RE.test(k)) continue
    out[k] = v
  }
  return out
}

// The fuzzing tools (crlf_test, lfi_probe, payload_probe) mark the injection
// slot with a literal §. But a § typed into a page URL is captured percent-
// encoded (%C2%A7 in UTF-8), so the marker never survives into stored traffic
// and the tools reported "marker § not found" on every real request. Decode
// the encoded form back to a literal § in the fields the marker can appear in,
// so a captured request works as the base for a fuzz run.
const ENCODED_MARKER_RE = /%c2%a7/gi

export function restoreMarker(spec: RepeaterRequestSpec): RepeaterRequestSpec {
  return {
    ...spec,
    url: spec.url.replace(ENCODED_MARKER_RE, '§'),
    headers: Object.fromEntries(
      Object.entries(spec.headers).map(([k, v]) => [k, v.replace(ENCODED_MARKER_RE, '§')])
    ),
    body: spec.body?.replace(ENCODED_MARKER_RE, '§')
  }
}

export function buildRequestSpec(
  requestId: string,
  mods: RepeaterModifications | undefined
): RepeaterRequestSpec {
  const stored = getRequest(requestId)
  if (!stored) throw new Error(`unknown requestId: ${requestId}`)

  const url = mods?.url ?? stored.url
  const method = (mods?.method ?? stored.method ?? 'GET').toUpperCase()

  const headers: Record<string, string> = stored.requestHeaders
    ? dropForbidden(stored.requestHeaders)
    : {}

  if (mods?.removeHeaders) {
    for (const name of mods.removeHeaders) {
      const lc = name.toLowerCase()
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === lc) delete headers[k]
      }
    }
  }
  if (mods?.setHeaders) {
    for (const [k, v] of Object.entries(mods.setHeaders)) {
      if (FORBIDDEN_HEADER_RE.test(k)) continue
      const lc = k.toLowerCase()
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === lc) delete headers[existing]
      }
      headers[k] = v
    }
  }

  let body: string | undefined
  if (mods && 'body' in mods) {
    body = mods.body == null ? undefined : mods.body
  } else {
    body = stored.requestPostData
  }

  return { url, method, headers, body }
}

// 페이지 안에서 실행되는 fetch()에 원래 타임아웃이 전혀 없었다 — 타겟이 응답을
// 끝내지 않으면(NestJS가 500을 로그만 찍고 응답을 안 닫는 버그 등, 실측 확인됨:
// docs/issue/09-tier1-engine_rever-browser-cdp-session-stability.md) 그 fetch()가 영원히 안
// 풀려서 브라우저의 오리진당 커넥션 슬롯을 하나씩 영구히 갉아먹었다. 이 상수를
// Runtime.evaluate 자체의 CDP 레벨 타임아웃(아래 30_000)보다 짧게 잡아야
// AbortController가 먼저 발동해서 슬롯을 확실히 반납한다.
const FETCH_TIMEOUT_MS = 15_000

export async function repeaterSendRaw(spec: RepeaterRequestSpec): Promise<RepeaterResponse> {
  const target = getActiveTarget()
  if (!target) throw new Error('no active webview attached')

  const cleanedHeaders = dropForbidden(spec.headers)
  const expression = buildEvalExpression(
    { ...spec, headers: cleanedHeaders },
    MAX_BODY_BYTES,
    FETCH_TIMEOUT_MS
  )

  const result = (await target.dbg.sendCommand('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30_000
  })) as {
    result: { value?: RepeaterResponse }
    exceptionDetails?: { text: string; exception?: { description?: string } }
  }

  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    return {
      status: 0,
      statusText: '',
      headers: {},
      body: '',
      bodyTruncated: false,
      bodyByteLength: 0,
      timeMs: 0,
      error: msg
    }
  }
  if (!result.result.value) throw new Error('repeater: empty result')
  return result.result.value
}

export async function repeaterSend(
  requestId: string,
  mods: RepeaterModifications | undefined
): Promise<RepeaterResponse> {
  return repeaterSendRaw(buildRequestSpec(requestId, mods))
}

function buildEvalExpression(spec: RepeaterRequestSpec, maxBytes: number, timeoutMs: number): string {
  const hasBody = spec.body !== undefined && spec.method !== 'GET' && spec.method !== 'HEAD'
  return `
(async () => {
  const t0 = performance.now()
  // AbortController 없이는 타겟이 응답을 안 끝낼 때 이 fetch()가 영원히 안 풀려
  // 브라우저의 오리진당 커넥션 슬롯을 하나 영구히 점유한다(실측 확인된 버그).
  const __revAc = new AbortController()
  const __revTimer = setTimeout(() => __revAc.abort(), ${timeoutMs})
  try {
    const init = {
      method: ${JSON.stringify(spec.method)},
      headers: ${JSON.stringify(spec.headers)},
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      signal: __revAc.signal
    }
    ${hasBody ? `init.body = ${JSON.stringify(spec.body)}` : ''}
    const res = await fetch(${JSON.stringify(spec.url)}, init)
    clearTimeout(__revTimer)
    const buf = await res.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const total = bytes.length
    const slice = total > ${maxBytes} ? bytes.slice(0, ${maxBytes}) : bytes
    // Decode with the charset the response declared — euc-kr/cp949 responses
    // read as mojibake when forced through utf-8. An unknown label makes the
    // TextDecoder constructor throw, so fall back to utf-8.
    const ctm = /charset\\s*=\\s*["']?([^;"'\\s]+)/i.exec(res.headers.get('content-type') || '')
    let body
    try {
      body = new TextDecoder(ctm ? ctm[1].toLowerCase() : 'utf-8', { fatal: false }).decode(slice)
    } catch (_e) {
      body = new TextDecoder('utf-8', { fatal: false }).decode(slice)
    }
    if (body.charCodeAt(0) === 0xfeff) body = body.slice(1)
    // Slicing at a byte cap can cut a multi-byte character in half; drop the
    // replacement chars it decodes to so the tail is not visibly corrupt.
    if (total > ${maxBytes}) body = body.replace(/\\uFFFD+$/, '')
    const headers = {}
    res.headers.forEach((v, k) => { headers[k] = v })
    return {
      status: res.status,
      statusText: res.statusText,
      headers,
      body,
      bodyTruncated: total > ${maxBytes},
      bodyByteLength: total,
      timeMs: Math.round(performance.now() - t0)
    }
  } catch (e) {
    clearTimeout(__revTimer)
    const isAbort = e && (e.name === 'AbortError')
    return {
      status: 0,
      statusText: '',
      headers: {},
      body: '',
      bodyTruncated: false,
      bodyByteLength: 0,
      timeMs: Math.round(performance.now() - t0),
      error: isAbort
        ? 'repeater: fetch aborted after ${timeoutMs}ms with no response (target likely hung)'
        : ((e && e.message) ? e.message : String(e))
    }
  }
})()
`
}
