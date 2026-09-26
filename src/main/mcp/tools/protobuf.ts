import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getRequest } from '../../traffic-store'
import { decodeProtobuf } from '../protobuf-decode'
import { ok, err, errorMessage, unknownRequestId } from '../utils'

/** Response body first, request body as fallback — gRPC calls carry both. */
function bytesForRequest(requestId: string): Buffer | string {
  const entry = getRequest(requestId)
  if (!entry) return unknownRequestId(requestId)
  if (entry.responseBody) {
    return entry.responseBodyBase64
      ? Buffer.from(entry.responseBody, 'base64')
      : Buffer.from(entry.responseBody, 'binary')
  }
  if (entry.requestPostData) return Buffer.from(entry.requestPostData, 'binary')
  return 'that request has no captured body (try get_request first, or pass data + encoding)'
}

export function registerProtobufTools(mcp: McpServer) {
  mcp.registerTool(
    'protobuf_decode',
    {
      description:
        'Decode an opaque protobuf / gRPC-web body into a field-number → value structure without a .proto schema (the `protoc --decode_raw` equivalent). Pass a captured requestId (response body, falling back to the request body) or raw bytes as base64/hex. gRPC framing (1-byte flag + 4-byte big-endian length, including gRPC-web-text base64) is detected and stripped automatically. Keys are `#<field-number>`; length-delimited values are shown as a nested message, a string, or raw bytes, and varints carry both the raw and the zigzag-signed reading.',
      inputSchema: {
        requestId: z
          .string()
          .optional()
          .describe('Captured request whose body is protobuf / gRPC-web'),
        data: z.string().optional().describe('Raw body bytes (alternative to requestId)'),
        encoding: z
          .enum(['base64', 'hex'])
          .optional()
          .describe('How `data` is encoded (default: base64)'),
        grpcWeb: z
          .boolean()
          .optional()
          .describe('Force (true) or skip (false) gRPC frame parsing. Auto-detected when omitted.')
      }
    },
    async ({ requestId, data, encoding, grpcWeb }) => {
      let buf: Buffer
      try {
        if (data !== undefined) {
          buf = Buffer.from(data.trim(), encoding ?? 'base64')
          if (buf.length === 0) return err('data decoded to zero bytes — wrong encoding?')
        } else if (requestId) {
          const bytes = bytesForRequest(requestId)
          if (typeof bytes === 'string') return err(bytes)
          buf = bytes
        } else {
          return err('pass either requestId or data')
        }
      } catch (e) {
        return err(`could not read bytes: ${errorMessage(e)}`)
      }

      const result = decodeProtobuf(buf, { grpcWeb })
      return ok(
        JSON.stringify(
          {
            ...result,
            legend:
              'Keys are #<field-number>. kind: varint (value = raw, signed = zigzag) | fixed32/fixed64 (uint + float/double) | message (nested) | string | bytes. A varint may really be a bool or an enum.'
          },
          null,
          2
        )
      )
    }
  )
}
