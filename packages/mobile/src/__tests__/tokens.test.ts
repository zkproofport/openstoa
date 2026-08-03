/**
 * Design-token contract for the mobile mini-app.
 *
 * `src/theme/tokens.ts` is only worth having if it is (a) the same scale the
 * web resolves to and (b) actually the source every screen reads from. Both
 * are asserted here by statically parsing the real files — the package's
 * vitest runs in a node environment with no renderer, so this is a source
 * contract, not a render test. Rendered-layout verification (does a long
 * Korean label clip on a 320pt screen?) is a simulator concern and is called
 * out as such rather than faked here.
 *
 * Edge-case matrix rows covered:
 *   contract   — every screen/component file is scanned; a new raw numeric
 *                fontSize/borderRadius anywhere fails, so the consolidation
 *                cannot silently regress
 *   integrity  — every exported step is used at least once (no orphan values)
 *                AND every used step exists (no phantom step)
 *   boundary   — the 12px floor and the 44pt touch target are asserted as
 *                exact values, and the scale is asserted strictly ascending
 *   UTF-8      — the Korean-legibility floor: the steps a Korean string can
 *                land on are enumerated, and the `label` step is asserted to
 *                be the only sub-`bodySmall` step besides `caption`
 *   cross-client — each step is compared byte-for-byte with the web's
 *                `src/styles/tokens.ts`, so a one-sided edit fails
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { RADIUS, TOUCH_TARGET_MIN, TYPE_SCALE } from '../theme/tokens';

const MOBILE_SRC = join(__dirname, '..');
const WEB_TOKENS = join(__dirname, '../../../../src/styles/tokens.ts');

/** Every first-party source file, excluding tests and tool scratch dirs. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const FILES = sourceFiles(MOBILE_SRC);

describe('token module shape', () => {
  it('exposes exactly the seven type steps the web defines', () => {
    expect(Object.keys(TYPE_SCALE)).toEqual([
      'label',
      'caption',
      'bodySmall',
      'body',
      'bodyLarge',
      'headingSmall',
      'headingLarge',
    ]);
  });

  it('exposes exactly the four radius steps the web defines', () => {
    expect(Object.keys(RADIUS)).toEqual(['control', 'card', 'modal', 'pill']);
  });

  it('type steps ascend strictly — no two roles collapse onto one size', () => {
    const values = Object.values(TYPE_SCALE);
    for (let i = 1; i < values.length; i++) {
      expect(values[i], `step ${i}`).toBeGreaterThan(values[i - 1]);
    }
  });

  it('radius steps ascend strictly', () => {
    const values = Object.values(RADIUS);
    for (let i = 1; i < values.length; i++) {
      expect(values[i], `step ${i}`).toBeGreaterThan(values[i - 1]);
    }
  });

  it('pins the boundary values: 12px type floor, 44pt touch target', () => {
    expect(TYPE_SCALE.label).toBe(12);
    expect(Math.min(...Object.values(TYPE_SCALE))).toBe(12);
    expect(TOUCH_TARGET_MIN).toBe(44);
  });

  it('keeps a Korean-safe floor: only label and caption sit below bodySmall', () => {
    const belowBodySmall = Object.entries(TYPE_SCALE)
      .filter(([, v]) => v < TYPE_SCALE.bodySmall)
      .map(([k]) => k);
    expect(belowBodySmall).toEqual(['label', 'caption']);
    // Running prose lands on `body`; that is the value the rule is written
    // against, so it is pinned rather than merely ordered.
    expect(TYPE_SCALE.body).toBe(16);
    expect(TYPE_SCALE.bodySmall).toBe(14);
  });
});

describe('web/mobile scale parity', () => {
  const webSource = readFileSync(WEB_TOKENS, 'utf-8');

  /** Pulls `key: 123,` pairs out of the named `export const X = { ... }`. */
  function parseWebConst(name: string): Record<string, number> {
    const start = webSource.indexOf(`export const ${name} = {`);
    expect(start, `${name} missing from web tokens`).toBeGreaterThan(-1);
    const end = webSource.indexOf('} as const;', start);
    const body = webSource.slice(start, end);
    const out: Record<string, number> = {};
    for (const m of body.matchAll(/^\s{2}([A-Za-z]+):\s*(\d+),/gm)) out[m[1]] = Number(m[2]);
    return out;
  }

  it('TYPE_SCALE matches the web value-for-value', () => {
    expect(parseWebConst('TYPE_SCALE')).toEqual({ ...TYPE_SCALE });
  });

  it('RADIUS matches the web value-for-value', () => {
    expect(parseWebConst('RADIUS')).toEqual({ ...RADIUS });
  });

  it('TOUCH_TARGET_MIN matches the web', () => {
    const m = webSource.match(/export const TOUCH_TARGET_MIN = (\d+);/);
    expect(m?.[1]).toBe(String(TOUCH_TARGET_MIN));
  });
});

describe('every screen reads from the token module', () => {
  it('no raw numeric fontSize survives anywhere in src/', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const [i, line] of readFileSync(file, 'utf-8').split('\n').entries()) {
        if (/\bfontSize:\s*\d/.test(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no raw numeric radius (any corner) survives anywhere in src/', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const [i, line] of readFileSync(file, 'utf-8').split('\n').entries()) {
        if (/\bborder(Top|Bottom|Start|End)?(Left|Right)?Radius:\s*\d/.test(line)) {
          offenders.push(`${file}:${i + 1} ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no radius is computed as 'size / 2' — that shape is RADIUS.pill", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const [i, line] of readFileSync(file, 'utf-8').split('\n').entries()) {
        if (/Radius:\s*[A-Za-z_$][\w$]*\s*\/\s*2\b/.test(line)) {
          offenders.push(`${file}:${i + 1} ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('no orphan and no phantom steps', () => {
  const usage = (() => {
    const type = new Set<string>();
    const radius = new Set<string>();
    for (const file of FILES) {
      const src = readFileSync(file, 'utf-8');
      for (const m of src.matchAll(/TYPE_SCALE\.([A-Za-z]+)/g)) type.add(m[1]);
      for (const m of src.matchAll(/RADIUS\.([A-Za-z]+)/g)) radius.add(m[1]);
    }
    return { type, radius };
  })();

  it('every exported type step is used by at least one file', () => {
    const unused = Object.keys(TYPE_SCALE).filter((k) => !usage.type.has(k));
    expect(unused).toEqual([]);
  });

  it('every exported radius step is used by at least one file', () => {
    const unused = Object.keys(RADIUS).filter((k) => !usage.radius.has(k));
    expect(unused).toEqual([]);
  });

  it('no file references a step that does not exist', () => {
    const phantomType = [...usage.type].filter((k) => !(k in TYPE_SCALE));
    const phantomRadius = [...usage.radius].filter((k) => !(k in RADIUS));
    expect({ phantomType, phantomRadius }).toEqual({ phantomType: [], phantomRadius: [] });
  });

  it('TOUCH_TARGET_MIN is used, not merely exported', () => {
    const used = FILES.some(
      (f) => !f.endsWith(join('theme', 'tokens.ts')) && readFileSync(f, 'utf-8').includes('TOUCH_TARGET_MIN'),
    );
    expect(used).toBe(true);
  });
});
