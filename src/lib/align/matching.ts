import type { Features } from './features';

const popcount32 = (v: number): number => {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return Math.imul(v, 0x01010101) >>> 24;
};

export function hamming(a: Uint32Array, ia: number, b: Uint32Array, ib: number): number {
  const oa = ia * 8;
  const ob = ib * 8;
  let d = 0;
  for (let k = 0; k < 8; k++) d += popcount32(a[oa + k] ^ b[ob + k]);
  return d;
}

class Grid {
  private cells = new Map<number, number[]>();
  constructor(private xy: Float32Array, private cell: number) {
    for (let i = 0; i < xy.length / 2; i++) {
      const key = this.key(Math.floor(xy[i * 2] / cell), Math.floor(xy[i * 2 + 1] / cell));
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    }
  }
  private key(cx: number, cy: number): number {
    return (cx + 1024) * 4096 + (cy + 1024);
  }
  near(x: number, y: number, radius: number, out: number[]): void {
    out.length = 0;
    const c0x = Math.floor((x - radius) / this.cell);
    const c1x = Math.floor((x + radius) / this.cell);
    const c0y = Math.floor((y - radius) / this.cell);
    const c1y = Math.floor((y + radius) / this.cell);
    const r2 = radius * radius;
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const list = this.cells.get(this.key(cx, cy));
        if (!list) continue;
        for (const idx of list) {
          const dx = this.xy[idx * 2] - x;
          const dy = this.xy[idx * 2 + 1] - y;
          if (dx * dx + dy * dy <= r2) out.push(idx);
        }
      }
    }
  }
}

export type Predictor = (x: number, y: number) => [number, number] | null;

/**
 * Matches descriptors of `a` against `b`, only considering candidates within `radius` pixels of
 * where `predict` says the feature should appear. Returns flat [xa, ya, xb, yb] quadruples.
 */
export function matchGated(
  a: Features,
  b: Features,
  predict: Predictor,
  radius: number,
  ratio = 0.85,
  maxDist = 72,
): number[] {
  const grid = new Grid(b.xy, Math.max(16, radius));
  const cand: number[] = [];
  // For every feature of b keep the best a so matches are one-to-one.
  const bestForB = new Map<number, { a: number; d: number }>();
  for (let ia = 0; ia < a.count; ia++) {
    const xa = a.xy[ia * 2];
    const ya = a.xy[ia * 2 + 1];
    const p = predict(xa, ya);
    if (!p) continue;
    grid.near(p[0], p[1], radius, cand);
    if (cand.length === 0) continue;
    let best = 257;
    let second = 257;
    let bestIdx = -1;
    for (const ib of cand) {
      const d = hamming(a.desc, ia, b.desc, ib);
      if (d < best) {
        second = best;
        best = d;
        bestIdx = ib;
      } else if (d < second) second = d;
    }
    if (best > maxDist) continue;
    if (second <= 256 && best >= ratio * second) continue;
    const prev = bestForB.get(bestIdx);
    if (!prev || best < prev.d) bestForB.set(bestIdx, { a: ia, d: best });
  }
  const out: number[] = [];
  for (const [ib, { a: ia }] of bestForB) {
    out.push(a.xy[ia * 2], a.xy[ia * 2 + 1], b.xy[ib * 2], b.xy[ib * 2 + 1]);
  }
  return out;
}
