import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getActiveTarget } from '../../chrome-cdp'
import { getRequest } from '../../traffic-store'
import { ok, err, errorMessage, unknownRequestId } from '../utils'

const MAX_BYTES = 8 * 1024 * 1024

// Headers that must not be forwarded on a re-fetch (Node sets its own, and some
// break the request).
const DROP_HEADERS = /^(host|content-length|connection|accept-encoding|:.*)/i

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 1024)
  for (let i = 0; i < n; i++) {
    const b = buf[i]
    if (b === 0) return true
  }
  return false
}

export function registerBodyTools(mcp: McpServer) {
  mcp.registerTool(
    'fetch_body',
    {
      description:
        'Force-retrieve the response body for a captured request whose body was skipped (image/video/font/css are skipped by default) or dropped (served from cache / a service worker). Tries the live CDP copy first, then re-fetches the URL reusing the original request headers (so auth/cookies still apply). Binary bodies are returned base64. Use when you decided after the fact that you need a body list_requests/get_request does not have.',
      inputSchema: {
        requestId: z.string().describe('requestId from list_requests')
      }
    },
    async ({ requestId }) => {
      const entry = getRequest(requestId)
      if (!entry) return err(unknownRequestId(requestId))
      if (entry.responseBody) {
        return ok(
          JSON.stringify({
            source: 'already-captured',
            note: 'This request already has a stored body — use get_request.',
            requestId
          })
        )
      }

      // 1) Try the live CDP copy (still available if not evicted).
      const target = getActiveTarget()
      if (target) {
        try {
          const res = (await target.dbg.sendCommand('Network.getResponseBody', {
            requestId
          })) as { body: string; base64Encoded: boolean }
          if (res && typeof res.body === 'string') {
            const capped = res.body.length > MAX_BYTES ? res.body.slice(0, MAX_BYTES) : res.body
            return ok(
              JSON.stringify({
                source: 'cdp',
                base64: res.base64Encoded,
                truncated: res.body.length > MAX_BYTES,
                url: entry.url,
                body: capped
              })
            )
          }
        } catch {
          // fall through to re-fetch
        }
      }

      // 2) Re-fetch the URL with the original request headers.
      if (!entry.url || !/^https?:/i.test(entry.url)) {
        return err('no live CDP body and the URL is not http(s) — cannot re-fetch')
      }
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(entry.requestHeaders ?? {})) {
        if (!DROP_HEADERS.test(k)) headers[k] = v
      }
      try {
        const r = await fetch(entry.url, {
          method: entry.method && entry.method !== 'GET' ? entry.method : 'GET',
          headers
        })
        const buf = Buffer.from(await r.arrayBuffer())
        const truncated = buf.length > MAX_BYTES
        const use = truncated ? buf.subarray(0, MAX_BYTES) : buf
        const binary = looksBinary(use)
        return ok(
          JSON.stringify({
            source: 're-fetch',
            status: r.status,
            base64: binary,
            truncated,
            byteLength: buf.length,
            url: entry.url,
            body: binary ? use.toString('base64') : use.toString('utf8')
          })
        )
      } catch (e) {
        return err(errorMessage(e))
      }
    }
  )
}
