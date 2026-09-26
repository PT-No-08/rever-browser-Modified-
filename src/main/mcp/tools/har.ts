import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { listRequests, getRequest, getEvictedCount } from '../../traffic-store'
import { toHeaders } from '../har-build'
import { ok, err, errorMessage } from '../utils'

// per-entry 본문 최대 256KB, 전체 JSON 응답 최대 50MB
const BODY_TRUNCATE_BYTES = 256 * 1024
const HAR_RESPONSE_SIZE_LIMIT = 50 * 1024 * 1024
// 2026-09-23: MCP Streamable HTTP는 응답을 하나의 SSE 이벤트로 보내는데, 널리 쓰이는
// 클라이언트(httpx2)가 이벤트당 1MB 상한(DEFAULT_MAX_EVENT_SIZE_BYTES)을 강제한다 —
// 넘으면 스트림이 응답 없이 끊겨 클라이언트엔 "SSE stream ended without a response"로
// 보인다. 그 한계에 못 미치게 출력 크기를 스스로 제한하고, 잘린 만큼은 _nextBefore
// 커서로 이어 받게 한다(호출자가 limit를 잘못 잡아도 스트림 사망 대신 잘린 결과가 돌아옴).
const SSE_SAFE_RESPONSE_BYTES = 900 * 1024

export function registerHarTools(mcp: McpServer) {
  mcp.registerTool(
    'har_export',
    {
      description:
        'Export captured traffic as HAR 1.2 JSON. Suitable for loading into Burp Suite, Caido, or any HAR-compatible analyzer. ' +
        'If the output would exceed the client SSE event-size limit it is automatically truncated to the newest entries — ' +
        'the response then contains log._nextBefore: re-call with before=<that value> to continue fetching the older remainder.',
      inputSchema: {
        host: z.string().optional().describe('Substring host filter'),
        limit: z.number().int().positive().max(2000).optional().describe('Max entries (default 500)'),
        includeBodies: z
          .boolean()
          .optional()
          .describe('Include response bodies (default true, may be large)'),
        before: z
          .number()
          .optional()
          .describe(
            'Only include entries started strictly before this epoch-ms timestamp. ' +
              '2026-09-21: lets a client page through large traffic sets in safe-sized chunks ' +
              '(avoids MCP SSE client event-size limits) by re-calling with the oldest ' +
              "entry's startedAt from the previous page — when the server auto-truncates a " +
              'response, log._nextBefore carries exactly the cursor value to pass here.'
          )
      }
    },
    async ({ host, limit, includeBodies = true, before }) => {
      try {
        const entries = listRequests({ host, limit: limit ?? 500, before })
        const harEntries: Record<string, unknown>[] = []
        const startedAts: number[] = [] // harEntries와 같은 순서 — _nextBefore 커서 계산용
        let skippedEntries = 0
        entries.forEach((r) => {
          const full = getRequest(r.requestId) ?? r
          const startedDateTime = new Date(full.startedAt).toISOString()
          const timeMs = full.completedAt ? full.completedAt - full.startedAt : -1

          const reqHeaders = toHeaders(full.requestHeaders)
          const respHeaders = toHeaders(full.responseHeaders)

          let queryString: { name: string; value: string }[]
          try {
            const reqUrl = new URL(full.url)
            queryString = Array.from(reqUrl.searchParams.entries()).map(([name, value]) => ({
              name,
              value
            }))
          } catch {
            // 2026-09-23: chrome://·devtools://·빈 URL처럼 URL 파싱이 안 되는 entry 하나가
            // 섞이면 export 전체가 "Invalid URL"로 죽었다 — 건너뛰고 개수만 남긴다.
            skippedEntries += 1
            return
          }

          startedAts.push(full.startedAt)
          harEntries.push({
            // 표준 HAR 필드가 아닌 커스텀 확장(HAR 스펙이 명시적으로 허용하는 `_` 접두사) —
            // 표준 HAR 파서(Burp/Caido)는 무시하고, 우리 쪽 오케스트레이터는 이 값으로
            // repeater_send/get_request를 다시 호출해 Tier1 재전송을 수행한다.
            _requestId: full.requestId,
            // 표준 HAR 필드가 아닌 커스텀 확장 — 오케스트레이터가 정적 리소스(스크립트/스타일/폰트 등)를
            // 스캔 대상에서 제외하는 데 쓴다. traffic-store는 이미 이 값을 추적하고 있었다.
            _resourceType: full.resourceType,
            startedDateTime,
            time: timeMs,
            request: {
              method: full.method,
              url: full.url,
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: reqHeaders,
              queryString,
              headersSize: -1,
              bodySize: full.requestPostData ? full.requestPostData.length : 0,
              ...(full.requestPostData
                ? {
                    postData: {
                      mimeType:
                        full.requestHeaders?.['content-type'] ??
                        full.requestHeaders?.['Content-Type'] ??
                        'application/octet-stream',
                      text: full.requestPostData
                    }
                  }
                : {})
            },
            response: {
              status: full.status ?? 0,
              statusText: '',
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: respHeaders,
              content: {
                size: full.responseBody?.length ?? 0,
                mimeType: full.mimeType ?? '',
                ...(includeBodies && full.responseBody
                  ? (() => {
                      const body = full.responseBody
                      const truncated = body.length > BODY_TRUNCATE_BYTES
                      return {
                        text: truncated ? body.slice(0, BODY_TRUNCATE_BYTES) : body,
                        ...(full.responseBodyBase64 ? { encoding: 'base64' } : {}),
                        ...(truncated ? { comment: `truncated (original ${body.length} bytes)` } : {})
                      }
                    })()
                  : {})
              },
              redirectURL: '',
              headersSize: -1,
              bodySize: full.encodedDataLength ?? -1
            },
            cache: {},
            timings: {
              send: 0,
              wait: timeMs > 0 ? timeMs : -1,
              receive: 0
            }
          })
        })

        const har: { log: Record<string, unknown> } = {
          log: {
            version: '1.2',
            creator: { name: 'rever-browser', version: '0.1.0' },
            entries: harEntries,
            ...(skippedEntries > 0 ? { _skippedEntries: skippedEntries } : {}),
            // 링 버퍼 용량을 넘겨 영구 삭제된 엔트리 수 — 이 export에 없는 과거 요청이
            // 있을 수 있음을 소비자가 알 수 있도록 조용한 유실을 표면화한다.
            ...(getEvictedCount() > 0 ? { _evictedEntries: getEvictedCount() } : {})
          }
        }

        // SSE 안전 크기(위 SSE_SAFE_RESPONSE_BYTES 주석 참고)를 넘으면 최신 쪽부터 잘라낸다 —
        // entries는 최신→오래된 순이라 뒤(오래된 쪽)를 버리고, 버린 구간은 _nextBefore로
        // 이어 받을 수 있다(before가 inclusive라 커서 entry 자신이 다음 호출에 다시 나옴).
        let serialized = JSON.stringify(har, null, 2)
        let kept = harEntries.length
        while (serialized.length > SSE_SAFE_RESPONSE_BYTES && kept > 1) {
          kept = Math.max(1, Math.floor(kept / 2))
          har.log.entries = harEntries.slice(0, kept)
          serialized = JSON.stringify(har, null, 2)
        }
        if (serialized.length > SSE_SAFE_RESPONSE_BYTES) {
          return err(
            `HAR output exceeds the SSE-safe size (${serialized.length} bytes) even with a single entry. ` +
              'Fetch it directly with get_request instead.'
          )
        }
        if (kept < harEntries.length) {
          har.log._truncated = true
          har.log._droppedEntries = harEntries.length - kept
          har.log._nextBefore = startedAts[kept - 1]
          har.log._continuationHint =
            'Response was cut to fit the MCP SSE event-size limit. Re-call har_export with before=_nextBefore to fetch the older remainder.'
          serialized = JSON.stringify(har, null, 2)
        }
        if (serialized.length > HAR_RESPONSE_SIZE_LIMIT) {
          return err(
            `HAR output too large (${serialized.length} bytes). Reduce limit or use host filter.`
          )
        }
        return ok(serialized)
      } catch (e) {
        return err(errorMessage(e))
      }
    }
  )
}
