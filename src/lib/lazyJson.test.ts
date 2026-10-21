// lazyJson.test.ts — plain assertion table for parseJsonLazily and the
// token helpers. Same runner convention as promptSource.test.ts: no
// test framework, run directly via tsx (`pnpm test`).
//
// To run manually:
//   npx tsx src/lib/lazyJson.test.ts

import {
  createLazyScope,
  deepHasLazyContent,
  hasLazyContent,
  hydrateLazyString,
  isLazyToken,
  lazyApproxChars,
  materializeLazy,
  parseJsonLazily,
  LAZY_MIN_CHARS,
} from './lazyJson';

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`        got:  ${g}`);
    console.error(`        want: ${w}`);
  }
}

const BIG = 'A'.repeat(LAZY_MIN_CHARS + 10);
const BIG_PNGISH = 'iVBORw0KGgo'.repeat(Math.ceil((LAZY_MIN_CHARS + 10) / 11));

// ---------------------------------------------------------------------
// parseJsonLazily — small docs untouched
// ---------------------------------------------------------------------

{
  const scope = createLazyScope();
  const src = JSON.stringify({ a: 'small', b: [1, 2, 3], c: { d: null } });
  check('small doc round-trips', parseJsonLazily(src, scope), JSON.parse(src));
  scope.dispose();
}

// ---------------------------------------------------------------------
// parseJsonLazily — big values elided, small neighbors intact
// ---------------------------------------------------------------------

{
  const scope = createLazyScope();
  const doc = { name: 'trace', data: BIG, tail: 'ok' };
  const out = parseJsonLazily(JSON.stringify(doc), scope) as Record<string, string>;
  check('big value becomes token', isLazyToken(out.data), true);
  check('neighbors intact', [out.name, out.tail], ['trace', 'ok']);
  check('materialize restores value', materializeLazy(out.data), BIG);
  check('materialize caches', materializeLazy(out.data) === BIG, true);
  scope.dispose();
}

// ---------------------------------------------------------------------
// escaped content inside a big literal survives the scanner
// ---------------------------------------------------------------------

{
  const scope = createLazyScope();
  const tricky = ('line with \\" quote and \\\\ backslash\n\tand tab\n'.repeat(
    Math.ceil((LAZY_MIN_CHARS + 10) / 52),
  )).slice(0, LAZY_MIN_CHARS + 10);
  const out = parseJsonLazily(JSON.stringify({ v: tricky, k: 1 }), scope) as Record<string, unknown>;
  check('escaped big literal elided', isLazyToken(out.v), true);
  check('escaped big literal round-trips', materializeLazy(out.v as string), tricky);
  scope.dispose();
}

// ---------------------------------------------------------------------
// big KEYS are never elided (structure must survive)
// ---------------------------------------------------------------------

{
  const scope = createLazyScope();
  const src = `{"${BIG}":"small","x":2}`;
  const out = parseJsonLazily(src, scope) as Record<string, unknown>;
  check('big key preserved', BIG in out, true);
  check('big key value preserved', out[BIG], 'small');
  scope.dispose();
}

// ---------------------------------------------------------------------
// several big values in one doc get distinct tokens
// ---------------------------------------------------------------------

{
  const scope = createLazyScope();
  const out = parseJsonLazily(JSON.stringify({ a: BIG, b: BIG_PNGISH }), scope) as Record<string, string>;
  check('distinct tokens', out.a !== out.b, true);
  check('both materialize', [materializeLazy(out.a) === BIG, materializeLazy(out.b) === BIG_PNGISH], [true, true]);
  scope.dispose();
}

// ---------------------------------------------------------------------
// scope dispose invalidates tokens (defensive passthrough)
// ---------------------------------------------------------------------

{
  const scope = createLazyScope();
  const out = parseJsonLazily(JSON.stringify({ a: BIG }), scope) as Record<string, string>;
  const tok = out.a;
  scope.dispose();
  check('disposed token returns itself', materializeLazy(tok), tok);
}

// ---------------------------------------------------------------------
// hasLazyContent / lazyApproxChars / hydrateLazyString
// ---------------------------------------------------------------------

{
  const scope = createLazyScope();
  const out = parseJsonLazily(JSON.stringify({ a: BIG }), scope) as Record<string, string>;
  const tok = out.a;

  check('isLazyToken plain', isLazyToken('hello'), false);
  check('hasLazyContent plain', hasLazyContent('hello'), false);
  check('hasLazyContent token', hasLazyContent(tok), true);
  check('lazyApproxChars token', lazyApproxChars(tok) >= LAZY_MIN_CHARS, true);
  check('lazyApproxChars plain', lazyApproxChars('abc'), 3);

  // Embedded token inside a joined string (adapters concatenate parts).
  const joined = 'before[' + tok + ']after';
  check('hasLazyContent embedded', hasLazyContent(joined), true);
  check('hydrate embedded', hydrateLazyString(joined), 'before[' + BIG + ']after');
  check('hydrate plain passthrough', hydrateLazyString('plain'), 'plain');
  check('lazyApproxChars embedded', lazyApproxChars(joined) > LAZY_MIN_CHARS, true);

  scope.dispose();
}

// ---------------------------------------------------------------------
// deepHasLazyContent — object / array walk
// ---------------------------------------------------------------------

{
  const scope = createLazyScope();
  const out = parseJsonLazily(JSON.stringify({ a: BIG }), scope) as Record<string, string>;
  const tok = out.a;
  check('deep plain object', deepHasLazyContent({ x: 1, y: 'str' }), false);
  check('deep nested token', deepHasLazyContent({ x: { y: [1, { z: tok }] } }), true);
  check('deep embedded token', deepHasLazyContent({ x: [{ y: 'a' + tok + 'b' }] }), true);
  check('deep null leaf', deepHasLazyContent({ x: null }), false);
  scope.dispose();
}

console.log(`lazyJson: ${passed} passed, ${failed} failed.`);
if (failed > 0) throw new Error(`${failed} lazyJson test(s) failed`);
