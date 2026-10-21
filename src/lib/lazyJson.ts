// lazyJson.ts — skip oversized JSON strings during parse.
//
// Why: GET /api/traces/:id returns the whole JSONL line inline
// (ARCHITECTURE.md §6.3) and a trace with image / file payloads can
// carry multi-MB base64 strings. Materializing those strings through
// JSON.parse blocks the main thread and is the dominant cost of
// opening the detail panel. This module scans the raw response text
// for JSON string literals at or above LAZY_MIN_CHARS, swaps each for
// a small token, and parses the shrunken document. The original
// literal stays as an offset into the raw text and is decoded only
// when a consumer asks for it (media render on scroll-in, "load full
// text" click, raw-view expand).
//
// Token shape: `__apilog_lazy_<n>__` — a plain string, so every type
// in the adapter / block pipeline (`data_b64?: string` etc.) is
// unchanged; consumers call isLazyToken() / hydrateLazyString()
// instead of touching the value blindly. `<n>` is a process-global
// counter, so tokens from multiple parsed traces never collide.
//
// Memory: each LazyScope holds its tokens' offset entries pointing at
// one shared raw text per parse call. dispose() drops the references
// so the raw text becomes collectable. materializeLazy() caches the
// decoded value on first use.
//
// Everything here is pure (no Svelte imports) so the scanner is
// testable via `pnpm test` with plain tsx assertions.

/** Strings at or above this many characters are elided at parse time. */
export const LAZY_MIN_CHARS = 256 * 1024;

const LAZY_TOKEN_INFIX = '__apilog_lazy_';
const LAZY_TOKEN_RE = /^__apilog_lazy_\d+__$/;
const LAZY_TOKEN_FIND_RE = /__apilog_lazy_\d+__/g;

interface LazyEntry {
  doc: LazyDoc;
  /** Byte range of the JSON string literal (including quotes) in doc.text. */
  start: number;
  end: number;
  /** Approximate decoded length: literal length minus the two quotes. */
  chars: number;
  /** Cached decoded value after the first materializeLazy call. */
  value?: string;
}

class LazyDoc {
  constructor(readonly text: string) {}
}

const registry = new Map<string, LazyEntry>();
let seq = 0;

/**
 * Per-parse-call lifetime handle. Register tokens with the scope that
 * owns the parse; dispose() unregisters them (call on trace switch /
 * effect cleanup) so the backing raw text can be garbage-collected.
 */
export class LazyScope {
  private tokens: string[] = [];

  register(token: string, entry: LazyEntry): void {
    registry.set(token, entry);
    this.tokens.push(token);
  }

  dispose(): void {
    for (const t of this.tokens) registry.delete(t);
    this.tokens = [];
  }
}

export function createLazyScope(): LazyScope {
  return new LazyScope();
}

/** True when `v` is exactly one lazy token. Plain boolean on purpose:
 *  a `v is string` predicate would narrow the negative branch to
 *  `never` for callers that already hold a string. */
export function isLazyToken(v: unknown): boolean {
  return typeof v === 'string' && LAZY_TOKEN_RE.test(v);
}

/** True when `s` is a token or embeds token(s) inside a joined string. */
export function hasLazyContent(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.indexOf(LAZY_TOKEN_INFIX) !== -1;
}

/**
 * True when any string inside a JSON-ish value (object / array) is or
 * embeds a token. Allocation-free walk — used to decide whether a
 * structured payload needs the "load" chip before it is stringified.
 */
export function deepHasLazyContent(v: unknown): boolean {
  if (typeof v === 'string') return hasLazyContent(v);
  if (Array.isArray(v)) return v.some(deepHasLazyContent);
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v as Record<string, unknown>)) {
      if (deepHasLazyContent((v as Record<string, unknown>)[k])) return true;
    }
  }
  return false;
}

/**
 * Approximate original string length (chars), counting tokens at their
 * recorded length instead of the 18-char token. For display labels
 * only — base64 consumers convert with *3/4 as before.
 */
export function lazyApproxChars(s: string | null | undefined): number {
  if (typeof s !== 'string') return 0;
  if (isLazyToken(s)) {
    const e = registry.get(s);
    return e ? e.chars : s.length;
  }
  if (!hasLazyContent(s)) return s.length;
  let total = 0;
  let last = 0;
  LAZY_TOKEN_FIND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LAZY_TOKEN_FIND_RE.exec(s)) !== null) {
    total += m.index - last;
    const e = registry.get(m[0]);
    total += e ? e.chars : m[0].length;
    last = m.index + m[0].length;
  }
  total += s.length - last;
  return total;
}

/**
 * Decode a single token back to its original string value. Unknown or
 * already-disposed tokens return themselves (defensive: the UI shows
 * the token rather than throwing mid-render).
 */
export function materializeLazy(token: string): string {
  const e = registry.get(token);
  if (!e) return token;
  if (e.value !== undefined) return e.value;
  try {
    const v = JSON.parse(e.doc.text.slice(e.start, e.end));
    e.value = typeof v === 'string' ? v : String(v);
    return e.value;
  } catch {
    return token;
  }
}

/**
 * Return `s` with every lazy token (embedded or whole) replaced by its
 * materialized value. Non-lazy strings pass through untouched — zero
 * allocation on the hot path.
 */
export function hydrateLazyString(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return s;
  if (isLazyToken(s)) return materializeLazy(s);
  if (!hasLazyContent(s)) return s;
  LAZY_TOKEN_FIND_RE.lastIndex = 0;
  return s.replace(LAZY_TOKEN_FIND_RE, (tok) => materializeLazy(tok));
}

function isJsonKey(text: string, after: number): boolean {
  let k = after;
  while (k < text.length) {
    const c = text.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      k++;
      continue;
    }
    return c === 58; // ':'
  }
  return false;
}

/**
 * JSON.parse with oversized string literals elided to tokens.
 * Scanning is linear: `indexOf` hops between quote bytes and only
 * walks content when escaped quotes force it, so a 30 MB base64
 * literal costs two native scans, not a per-char loop.
 */
export function parseJsonLazily(text: string, scope: LazyScope): unknown {
  const n = text.length;
  const doc = new LazyDoc(text);
  const parts: string[] = [];
  let last = 0;
  let i = 0;
  let elided = 0;

  while (i < n) {
    const q = text.indexOf('"', i);
    if (q < 0) break;

    // Find the closing quote. A quote preceded by an odd number of
    // backslashes is escaped and stays inside the literal.
    let j = q + 1;
    let closed = false;
    while (j < n) {
      const nextQ = text.indexOf('"', j);
      if (nextQ < 0) {
        j = n;
        break;
      }
      let k = nextQ - 1;
      let bs = 0;
      while (k > q && text.charCodeAt(k) === 92) {
        bs++;
        k--;
      }
      if (bs % 2 === 0) {
        j = nextQ;
        closed = true;
        break;
      }
      j = nextQ + 1;
    }
    const literalEnd = closed ? j + 1 : n;
    const chars = literalEnd - q - 2;

    if (chars >= LAZY_MIN_CHARS && !isJsonKey(text, literalEnd)) {
      parts.push(text.slice(last, q));
      const token = LAZY_TOKEN_INFIX + ++seq + '__';
      scope.register(token, { doc, start: q, end: literalEnd, chars });
      parts.push('"' + token + '"');
      last = literalEnd;
      elided++;
    }
    i = literalEnd;
  }

  if (elided === 0) return JSON.parse(text);
  parts.push(text.slice(last));
  return JSON.parse(parts.join(''));
}
