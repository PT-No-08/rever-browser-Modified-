export interface HarHeader {
  name: string
  value: string
}

/** Convert a header record into HAR's name/value array form. */
export function toHeaders(h: Record<string, string> | undefined): HarHeader[] {
  if (!h) return []
  const out: HarHeader[] = []
  for (const [name, value] of Object.entries(h)) {
    // CDP folds repeated header fields (Set-Cookie, Warning, ...) into one
    // '\n'-joined value; HAR requires one entry per field line, and header
    // field-values themselves can never contain a raw newline, so splitting
    // is always safe.
    for (const line of value.split('\n')) {
      out.push({ name, value: line })
    }
  }
  return out
}
