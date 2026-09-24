import { describe, it, expect, beforeEach } from 'vitest'

import { upsertRequest, clearTraffic } from './traffic-store'
import { storedSpec, applyModifications, buildRequestSpec } from './repeater'

beforeEach(() => {
  clearTraffic()
})

describe('storedSpec', () => {
  it('builds a spec from a stored request', () => {
    upsertRequest({
      requestId: 'r1', url: 'https://a.com/x', host: 'a.com', method: 'post',
      requestHeaders: { 'Content-Type': 'application/json', 'X-Keep': '1' },
      requestPostData: '{"a":1}'
    })
    const spec = storedSpec('r1')
    expect(spec.url).toBe('https://a.com/x')
    expect(spec.method).toBe('POST')
    expect(spec.headers['Content-Type']).toBe('application/json')
    expect(spec.body).toBe('{"a":1}')
  })

  it('drops forbidden headers from the stored request', () => {
    upsertRequest({
      requestId: 'r2', url: 'https://a.com/', host: 'a.com',
      requestHeaders: { Origin: 'https://evil', 'Sec-Fetch-Mode': 'cors', 'X-Ok': 'y' }
    })
    const spec = storedSpec('r2')
    expect(spec.headers['Origin']).toBeUndefined()
    expect(spec.headers['Sec-Fetch-Mode']).toBeUndefined()
    expect(spec.headers['X-Ok']).toBe('y')
  })

  it('throws for an evicted/unknown requestId', () => {
    expect(() => storedSpec('nope')).toThrow('unknown requestId')
  })
})

describe('applyModifications', () => {
  const spec = {
    url: 'https://a.com/p', method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: 'orig'
  }

  it('applies url/method/body overrides', () => {
    const out = applyModifications(spec, { url: 'https://a.com/q', method: 'put', body: null })
    expect(out.url).toBe('https://a.com/q')
    expect(out.method).toBe('PUT')
    expect(out.body).toBeUndefined()
  })

  it('keeps original body when body key is omitted', () => {
    expect(applyModifications(spec, { url: 'https://a.com/q' }).body).toBe('orig')
  })

  it('setHeaders replaces case-insensitively and skips forbidden names', () => {
    const out = applyModifications(spec, {
      setHeaders: { authorization: 'Bearer x', Origin: 'https://evil', 'X-New': 'n' }
    })
    expect(out.headers['authorization']).toBe('Bearer x')
    expect(out.headers['Origin']).toBeUndefined()
    expect(out.headers['X-New']).toBe('n')
  })

  it('removeHeaders deletes case-insensitively', () => {
    const out = applyModifications(spec, { removeHeaders: ['AUTHORIZATION'] })
    expect(out.headers['Authorization']).toBeUndefined()
    expect(out.headers['Content-Type']).toBe('application/json')
  })

  it('does not mutate the input spec', () => {
    applyModifications(spec, { setHeaders: { 'X-A': '1' }, removeHeaders: ['Authorization'] })
    expect(spec.headers['X-A']).toBeUndefined()
    expect(spec.headers['Authorization']).toBe('Bearer t')
  })
})

describe('buildRequestSpec', () => {
  it('composes storedSpec + applyModifications (backward compatible)', () => {
    upsertRequest({
      requestId: 'r3', url: 'https://a.com/old', host: 'a.com', method: 'GET',
      requestHeaders: { 'X-H': 'v' }, requestPostData: 'b'
    })
    const out = buildRequestSpec('r3', { url: 'https://a.com/new', body: 'b2' })
    expect(out.url).toBe('https://a.com/new')
    expect(out.body).toBe('b2')
    expect(out.headers['X-H']).toBe('v')
  })
})
