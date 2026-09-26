import { getEvictedCount } from '../traffic-store'

export function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function err(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// requestId 조회 실패 메시지에 링 버퍼 축출 컨텍스트를 붙인다 — 축출이 한 번도
// 없었다면 "없는 ID"이고, 있었다면 "축출됐을 수 있는 ID"라는 디버깅 단서를 준다.
export function unknownRequestId(requestId: string): string {
  const evicted = getEvictedCount()
  const suffix =
    evicted > 0
      ? ` — ${evicted} older entr${evicted === 1 ? 'y was' : 'ies were'} evicted from the traffic ring buffer; this requestId may have been among them`
      : ''
  return `unknown requestId: ${requestId}${suffix}`
}
