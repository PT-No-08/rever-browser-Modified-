import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { repeaterSend, repeaterSendRaw, applyModifications } from '../../repeater'
import type { RepeaterModifications } from '../../repeater'
import { ok, err, errorMessage } from '../utils'

export function registerRepeaterTools(mcp: McpServer) {
  mcp.registerTool(
    'repeater_send',
    {
      description:
        'Replay a captured request with optional modifications. Uses the active webview context (cookies, TLS, HTTP/2) so it behaves like the real browser. Returns response status, headers, and body (first 64KB). Note: forbidden fetch headers (Cookie, Host, User-Agent, Origin, Referer, sec-*) are stripped — Cookie is auto-attached from the browser jar via credentials=include.',
      inputSchema: {
        requestId: z.string().describe('requestId returned by list_requests'),
        modifications: z
          .object({
            url: z.string().optional(),
            method: z.string().optional(),
            setHeaders: z
              .record(z.string(), z.string())
              .optional()
              .describe('Headers to add or overwrite (case-insensitive replace)'),
            removeHeaders: z
              .array(z.string())
              .optional()
              .describe('Header names to remove (case-insensitive)'),
            body: z
              .string()
              .nullable()
              .optional()
              .describe('null clears body; omit to keep original')
          })
          .optional()
      }
    },
    async ({ requestId, modifications }) => {
      try {
        const res = await repeaterSend(requestId, modifications)
        return ok(JSON.stringify(res, null, 2))
      } catch (e) {
        return err(errorMessage(e))
      }
    }
  )

  // DAST-6: requestId 없이 명시적 request spec으로 전송한다. traffic-store는
  // MAX_ENTRIES(500) 링 버퍼라 오래된 캡처가 축출되는데, 장기 스캔에서 base
  // request가 축출되면 repeater_send가 전부 실패한다. 호출자가 get_request로
  // spec을 미리 확보해 두면 저장소 생존과 무관하게 재전송할 수 있다.
  const modsSchema = z
    .object({
      url: z.string().optional(),
      method: z.string().optional(),
      setHeaders: z
        .record(z.string(), z.string())
        .optional()
        .describe('Headers to add or overwrite (case-insensitive replace)'),
      removeHeaders: z
        .array(z.string())
        .optional()
        .describe('Header names to remove (case-insensitive)'),
      body: z
        .string()
        .nullable()
        .optional()
        .describe('null clears body; omit to keep original')
    })
    .optional()

  mcp.registerTool(
    'repeater_send_raw',
    {
      description:
        'Send an explicit HTTP request spec (url/method/headers/body) with optional modifications — same browser-context fetch as repeater_send but does NOT require a captured requestId, so it survives traffic-store eviction. Use for long-running scans that replay requests captured much earlier.',
      inputSchema: {
        request: z.object({
          url: z.string(),
          method: z.string().optional().describe('Defaults to GET'),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().nullable().optional()
        }),
        modifications: modsSchema
      }
    },
    async ({ request, modifications }) => {
      try {
        const spec = {
          url: request.url,
          method: (request.method ?? 'GET').toUpperCase(),
          headers: request.headers ?? {},
          body: request.body ?? undefined
        }
        const res = await repeaterSendRaw(
          applyModifications(spec, modifications as RepeaterModifications | undefined)
        )
        return ok(JSON.stringify(res, null, 2))
      } catch (e) {
        return err(errorMessage(e))
      }
    }
  )
}
