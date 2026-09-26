import { describe, it, expect, beforeEach } from 'vitest'

import {
  upsertRequest,
  listRequests,
  getRequest,
  clearTraffic,
  appendWsFrame,
  getWsFrames,
  appendConsole,
  getConsoleSince,
  clearConsole,
  appendException,
  getExceptions,
  mergeExtraResponseHeaders,
  takePendingExtraResponseHeaders
} from './traffic-store'

beforeEach(() => {
  clearTraffic()
  clearConsole()
})

describe('upsertRequest / getRequest', () => {
  it('creates a new entry with defaults', () => {
    upsertRequest({ requestId: 'r1', url: 'https://a.com/x', host: 'a.com' })
    const r = getRequest('r1')
    expect(r?.url).toBe('https://a.com/x')
    expect(r?.resourceType).toBe('Other')
    expect(typeof r?.startedAt).toBe('number')
  })

  it('merges fields into an existing entry instead of replacing it', () => {
    upsertRequest({ requestId: 'r1', url: 'https://a.com', host: 'a.com', method: 'GET' })
    upsertRequest({ requestId: 'r1', status: 200, mimeType: 'application/json' })
    const r = getRequest('r1')
    expect(r?.method).toBe('GET') // preserved
    expect(r?.status).toBe(200) // added
    expect(r?.mimeType).toBe('application/json')
  })
})

describe('listRequests', () => {
  beforeEach(() => {
    upsertRequest({ requestId: 'r1', url: 'https://a.com/1', host: 'a.com', method: 'GET', resourceType: 'XHR', startedAt: 100 })
    upsertRequest({ requestId: 'r2', url: 'https://b.com/2', host: 'b.com', method: 'POST', resourceType: 'Fetch', startedAt: 200 })
    upsertRequest({ requestId: 'r3', url: 'https://a.com/3', host: 'a.com', method: 'GET', resourceType: 'Script', startedAt: 300 })
  })

  it('returns newest-first', () => {
    expect(listRequests().map((r) => r.requestId)).toEqual(['r3', 'r2', 'r1'])
  })

  it('respects the limit', () => {
    expect(listRequests({ limit: 2 }).map((r) => r.requestId)).toEqual(['r3', 'r2'])
  })

  it('filters by host substring', () => {
    expect(listRequests({ host: 'a.com' }).map((r) => r.requestId)).toEqual(['r3', 'r1'])
  })

  it('filters by method (case-insensitive)', () => {
    expect(listRequests({ methodOrType: 'post' }).map((r) => r.requestId)).toEqual(['r2'])
  })

  it('filters by resourceType', () => {
    expect(listRequests({ methodOrType: 'script' }).map((r) => r.requestId)).toEqual(['r3'])
  })

  it('filters by since timestamp', () => {
    expect(listRequests({ since: 250 }).map((r) => r.requestId)).toEqual(['r3'])
  })

  // 2026-09-21 사용자 리뷰 항목 4: before(상한)로 "다음 페이지(더 오래된 것)"를 가져올 수
  // 있어야 안전한 크기로 나눠 받는 페이지네이션이 가능하다. inclusive(<=)로 바꿔서
  // 같은 ms 경계에 걸린 형제 entry가 조용히 사라지지 않게 한다(호출부가 중복 제거).
  it('filters by before timestamp (inclusive upper bound)', () => {
    expect(listRequests({ before: 300 }).map((r) => r.requestId)).toEqual(['r3', 'r2', 'r1'])
  })

  it('before excludes strictly newer entries only', () => {
    expect(listRequests({ before: 299 }).map((r) => r.requestId)).toEqual(['r2', 'r1'])
  })

  it('before and since together select a window (both inclusive on their own side)', () => {
    expect(listRequests({ since: 150, before: 299 }).map((r) => r.requestId)).toEqual(['r2'])
  })

  it('before at the oldest entry still includes it (cursor re-fetch case)', () => {
    // 페이지네이션이 이전 페이지의 가장 오래된 entry의 startedAt을 커서로 재사용하는
    // 상황을 흉내낸다 — inclusive라 그 entry 자신이 다시 포함돼야 한다(호출부 중복 제거 전제).
    expect(listRequests({ before: 100 }).map((r) => r.requestId)).toEqual(['r1'])
  })

  it('before older than every entry returns empty', () => {
    expect(listRequests({ before: 50 }).map((r) => r.requestId)).toEqual([])
  })

  it('before is inclusive across multiple entries sharing the exact same ms (boundary case)', () => {
    upsertRequest({ requestId: 'r4', url: 'https://c.com/4', host: 'c.com', method: 'GET', resourceType: 'XHR', startedAt: 300 })
    // r3와 r4가 같은 ms(300)를 공유 — limit이 그 경계에서 잘려도(예: 이전 페이지가
    // limit=1로 r3만 가져갔다면) before:300(inclusive)로 다시 조회하면 r4도 나와야 한다.
    expect(listRequests({ before: 300 }).map((r) => r.requestId).sort()).toEqual(['r1', 'r2', 'r3', 'r4'])
  })
})

describe('response body cap', () => {
  const MAX = 8 * 1024 * 1024

  it('truncates and flags bodies above the byte ceiling', () => {
    upsertRequest({ requestId: 'big', url: 'https://x/b.js', host: 'x', responseBody: 'a'.repeat(MAX + 100) })
    const r = getRequest('big')
    expect(r?.responseBody?.length).toBe(MAX)
    expect(r?.responseBodyTruncated).toBe(true)
  })

  it('leaves normal bodies untouched', () => {
    upsertRequest({ requestId: 'ok', url: 'https://x/s.js', host: 'x', responseBody: 'hello' })
    const r = getRequest('ok')
    expect(r?.responseBody).toBe('hello')
    expect(r?.responseBodyTruncated).toBeUndefined()
  })
})

describe('eviction', () => {
  it('drops the oldest entries past MAX_ENTRIES (500)', () => {
    for (let i = 0; i < 510; i++) {
      upsertRequest({ requestId: `e${i}`, url: `https://x/${i}`, host: 'x', startedAt: i })
    }
    expect(getRequest('e0')).toBeUndefined() // evicted
    expect(getRequest('e9')).toBeUndefined() // evicted
    expect(getRequest('e10')).toBeDefined() // first survivor
    expect(getRequest('e509')).toBeDefined()
    expect(listRequests({ limit: 1000 }).length).toBe(500)
  })
})

describe('websocket frames', () => {
  it('appends frames per requestId and filters by since', () => {
    appendWsFrame('ws1', { direction: 'sent', opcode: 1, payloadData: 'a', timestamp: 10 })
    appendWsFrame('ws1', { direction: 'received', opcode: 1, payloadData: 'b', timestamp: 20 })
    expect(getWsFrames('ws1')).toHaveLength(2)
    expect(getWsFrames('ws1', 15).map((f) => f.payloadData)).toEqual(['b'])
    expect(getWsFrames('missing')).toEqual([])
  })

  it('caps frames per request so a long-lived socket cannot grow unbounded', () => {
    for (let i = 0; i < 2100; i++) {
      appendWsFrame('wsCap', { direction: 'received', opcode: 1, payloadData: `f${i}`, timestamp: i })
    }
    const frames = getWsFrames('wsCap')
    expect(frames.length).toBe(2000) // MAX_WS_FRAMES_PER_REQUEST
    expect(frames[0].payloadData).toBe('f100') // oldest 100 dropped
    expect(frames.at(-1)?.payloadData).toBe('f2099')
  })

  it('drops frames when their request is evicted from the ring buffer', () => {
    upsertRequest({ requestId: 'wsEvict', url: 'wss://x', host: 'x', resourceType: 'WebSocket', startedAt: 0 })
    appendWsFrame('wsEvict', { direction: 'sent', opcode: 1, payloadData: 'p', timestamp: 1 })
    expect(getWsFrames('wsEvict')).toHaveLength(1)
    // Push the WS request out of the 500-entry window.
    for (let i = 0; i < 500; i++) {
      upsertRequest({ requestId: `pad${i}`, url: `https://x/${i}`, host: 'x', startedAt: i + 1 })
    }
    expect(getRequest('wsEvict')).toBeUndefined() // evicted
    expect(getWsFrames('wsEvict')).toEqual([]) // frames freed, no leak
  })

  it('drops all frames when traffic is cleared', () => {
    upsertRequest({ requestId: 'wsClear', url: 'wss://x', host: 'x', resourceType: 'WebSocket' })
    appendWsFrame('wsClear', { direction: 'sent', opcode: 1, payloadData: 'p', timestamp: 1 })
    clearTraffic()
    expect(getWsFrames('wsClear')).toEqual([])
  })
})

describe('console logs', () => {
  it('appends and filters by since', () => {
    appendConsole({ ts: 10, type: 'log', text: 'one' })
    appendConsole({ ts: 20, type: 'warn', text: 'two' })
    expect(getConsoleSince().map((e) => e.text)).toEqual(['one', 'two'])
    expect(getConsoleSince(15).map((e) => e.text)).toEqual(['two'])
  })

  it('caps the ring buffer at MAX_CONSOLE (1000)', () => {
    for (let i = 0; i < 1050; i++) appendConsole({ ts: i, type: 'log', text: `m${i}` })
    const all = getConsoleSince()
    expect(all).toHaveLength(1000)
    expect(all[0].text).toBe('m50') // oldest 50 dropped
  })
})

describe('runtime exceptions', () => {
  it('appends and caps at MAX_EXCEPTIONS (200)', () => {
    for (let i = 0; i < 250; i++) appendException({ ts: i, text: `boom${i}` })
    const all = getExceptions()
    // Cap is absolute regardless of prior appends in earlier tests.
    expect(all).toHaveLength(200)
    expect(all.at(-1)?.text).toBe('boom249')
  })
})

describe('responseReceivedExtraInfo merge (Set-Cookie capture)', () => {
  // CDP Network.responseReceived.response.headers omits Set-Cookie; the raw
  // header block arrives in responseReceivedExtraInfo in either order.
  const extra = {
    'Content-Type': 'text/html',
    'Set-Cookie': 'session=abc; HttpOnly\npref=dark; Secure'
  }

  it('merges when ExtraInfo arrives before responseReceived', () => {
    upsertRequest({ requestId: 'r1', url: 'https://a.com/', host: 'a.com' })
    mergeExtraResponseHeaders('r1', extra)
    // responseReceived lands: caller merges pending extra headers under the
    // event's own header map (same shape as chrome-cdp.ts / external-cdp.ts).
    const pending = takePendingExtraResponseHeaders('r1')
    upsertRequest({
      requestId: 'r1',
      status: 200,
      responseHeaders: { ...pending, ...{ 'Content-Type': 'text/html', Server: 'x' } }
    })
    const h = getRequest('r1')?.responseHeaders ?? {}
    expect(h['Set-Cookie']).toBe('session=abc; HttpOnly\npref=dark; Secure')
    expect(h['Server']).toBe('x')
  })

  it('merges when ExtraInfo arrives after responseReceived', () => {
    upsertRequest({
      requestId: 'r2',
      url: 'https://a.com/',
      host: 'a.com',
      responseHeaders: { 'Content-Type': 'text/html' }
    })
    mergeExtraResponseHeaders('r2', extra)
    const h = getRequest('r2')?.responseHeaders ?? {}
    expect(h['Set-Cookie']).toBe('session=abc; HttpOnly\npref=dark; Secure')
    expect(h['Content-Type']).toBe('text/html')
    expect(takePendingExtraResponseHeaders('r2')).toBeUndefined()
  })

  it('returns undefined for requests with no buffered extra info', () => {
    expect(takePendingExtraResponseHeaders('nope')).toBeUndefined()
  })
})
