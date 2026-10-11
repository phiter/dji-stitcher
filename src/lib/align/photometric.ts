import { camToPixel, type Lens } from '../camera';
import { mulVec, mulVecT, type Mat3, type Vec3 } from '../geometry';
import type { ThumbImage } from './types';

export interface Photometry {
  /** Per photo RGB multipliers (encoded domain) that equalise exposure and white balance. */
  gains: [number, number, number][];
  /** log V(r) = v1 r^2 + v2 r^4, r normalised by the half diagonal. */
  vignette: [number, number];
}

interface Samples {
  n: number;
  i: Int32Array;
  j: Int32Array;
  ri2: Float32Array;
  rj2: Float32Array;
  /** log colour ratio (i over j) for L, R, G, B. */
  d: Float32Array;
}

const MIN_VALUE = 14;
const MAX_VALUE = 244;
const SAMPLES_PER_PAIR = 500;

function bilinear(img: ThumbImage, x: number, y: number, out: number[]): void {
  const x0 = Math.min(img.width - 2, Math.max(0, Math.floor(x - 0.5)));
  const y0 = Math.min(img.height - 2, Math.max(0, Math.floor(y - 0.5)));
  const fx = Math.min(1, Math.max(0, x - 0.5 - x0));
  const fy = Math.min(1, Math.max(0, y - 0.5 - y0));
  for (let c = 0; c < 3; c++) {
    const a = img.data[(y0 * img.width + x0) * 3 + c];
    const b = img.data[(y0 * img.width + x0 + 1) * 3 + c];
    const cc = img.data[((y0 + 1) * img.width + x0) * 3 + c];
    const d = img.data[((y0 + 1) * img.width + x0 + 1) * 3 + c];
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
  }
}

function collectSamples(thumbs: ThumbImage[], rotations: Mat3[], focalRel: number, k1: number): Samples {
  const N = thumbs.length;
  const w = thumbs[0].width;
  const h = thumbs[0].height;
  const lens: Lens = { width: w, height: h, f: focalRel * w, k1 };
  const halfDiag = Math.hypot(w, h) / 2;
  const marginX = w * 0.04;
  const marginY = h * 0.04;
  const I: number[] = [];
  const J: number[] = [];
  const RI: number[] = [];
  const RJ: number[] = [];
  const D: number[] = [];
  const ca = [0, 0, 0];
  const cb = [0, 0, 0];
  const step = 3;

  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      // Optical axes more than ~87 degrees apart cannot share image content.
      const ra = rotations[a];
      const rb = rotations[b];
      if (ra[2] * rb[2] + ra[5] * rb[5] + ra[8] * rb[8] < 0.05) continue;
      const local: number[] = [];
      for (let y = marginY; y < h - marginY; y += step) {
        for (let x = marginX; x < w - marginX; x += step) {
          const cam: Vec3 = [(x - w / 2) / lens.f, (y - h / 2) / lens.f, 1];
          const s = 1 + k1 * (cam[0] * cam[0] + cam[1] * cam[1]);
          const dirWorld = mulVec(rotations[a], [cam[0] * s, cam[1] * s, 1]);
          const p = camToPixel(lens, mulVecT(rotations[b], dirWorld));
          if (!p || p[0] < marginX || p[0] > w - marginX || p[1] < marginY || p[1] > h - marginY) continue;
          bilinear(thumbs[a], x, y, ca);
          bilinear(thumbs[b], p[0], p[1], cb);
          const la = (ca[0] + ca[1] + ca[2]) / 3;
          const lb = (cb[0] + cb[1] + cb[2]) / 3;
          if (la < MIN_VALUE || lb < MIN_VALUE || la > MAX_VALUE || lb > MAX_VALUE) continue;
          if (ca.some((v) => v < 6 || v > 250) || cb.some((v) => v < 6 || v > 250)) continue;
          const ra = Math.hypot(x - w / 2, y - h / 2) / halfDiag;
          const rb = Math.hypot(p[0] - w / 2, p[1] - h / 2) / halfDiag;
          local.push(
            a, b, ra * ra, rb * rb,
            Math.log(la / lb), Math.log(ca[0] / cb[0]), Math.log(ca[1] / cb[1]), Math.log(ca[2] / cb[2]),
          );
        }
      }
      const count = local.length / 8;
      if (count < 20) continue;
      const stride = Math.max(1, Math.floor(count / SAMPLES_PER_PAIR));
      for (let k = 0; k < count; k += stride) {
        const o = k * 8;
        I.push(local[o]);
        J.push(local[o + 1]);
        RI.push(local[o + 2]);
        RJ.push(local[o + 3]);
        D.push(local[o + 4], local[o + 5], local[o + 6], local[o + 7]);
      }
    }
  }
  return {
    n: I.length,
    i: Int32Array.from(I),
    j: Int32Array.from(J),
    ri2: Float32Array.from(RI),
    rj2: Float32Array.from(RJ),
    d: Float32Array.from(D),
  };
}

function solveSPD(A: Float64Array, b: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= r; c++) {
      let s = A[r * n + c];
      for (let k = 0; k < c; k++) s -= L[r * n + k] * L[c * n + k];
      if (r === c) L[r * n + r] = Math.sqrt(Math.max(s, 1e-12));
      else L[r * n + c] = s / L[c * n + c];
    }
  }
  const y = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    let s = b[r];
    for (let k = 0; k < r; k++) s -= L[r * n + k] * y[k];
    y[r] = s / L[r * n + r];
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = y[r];
    for (let k = r + 1; k < n; k++) s -= L[k * n + r] * x[k];
    x[r] = s / L[r * n + r];
  }
  return x;
}

/**
 * Robust least squares for  d = a_i - a_j + v1 (ri^2 - rj^2) + v2 (ri^4 - rj^4).
 * With `fixedVignette` the vignette terms are taken as known and only the gains are solved.
 */
function solve(
  s: Samples,
  N: number,
  channel: number,
  fixedVignette: [number, number] | null,
): { a: Float64Array; v: [number, number] } {
  const nv = fixedVignette ? 0 : 2;
  const n = N + nv;
  let a = new Float64Array(N);
  let v: [number, number] = fixedVignette ?? [0, 0];
  const c = 0.12;
  const w = new Float64Array(s.n).fill(1);
  for (let iter = 0; iter < 6; iter++) {
    const A = new Float64Array(n * n);
    const b = new Float64Array(n);
    for (let k = 0; k < s.n; k++) {
      const x1 = s.ri2[k] - s.rj2[k];
      const x2 = s.ri2[k] * s.ri2[k] - s.rj2[k] * s.rj2[k];
      let y = s.d[k * 4 + channel];
      if (fixedVignette) y -= fixedVignette[0] * x1 + fixedVignette[1] * x2;
      const ia = s.i[k];
      const ib = s.j[k];
      const wk = w[k];
      A[ia * n + ia] += wk;
      A[ib * n + ib] += wk;
      A[ia * n + ib] -= wk;
      A[ib * n + ia] -= wk;
      b[ia] += wk * y;
      b[ib] -= wk * y;
      if (nv) {
        const col = [x1, x2];
        for (let t = 0; t < 2; t++) {
          A[ia * n + N + t] += wk * col[t];
          A[(N + t) * n + ia] += wk * col[t];
          A[ib * n + N + t] -= wk * col[t];
          A[(N + t) * n + ib] -= wk * col[t];
          b[N + t] += wk * col[t] * y;
          for (let u = 0; u < 2; u++) A[(N + t) * n + N + u] += wk * col[t] * col[u];
        }
      }
    }
    // Weak priors: gains near 1 keep the system anchored; vignette gets a mild ridge.
    const lambda = 0.02 * Math.max(1, s.n / N);
    for (let t = 0; t < N; t++) A[t * n + t] += lambda;
    for (let t = 0; t < nv; t++) A[(N + t) * n + N + t] += 0.5 * Math.max(1, s.n / N);
    const x = solveSPD(A, b, n);
    a = x.slice(0, N);
    if (nv) v = [x[N], x[N + 1]];
    // Update robust weights.
    for (let k = 0; k < s.n; k++) {
      const x1 = s.ri2[k] - s.rj2[k];
      const x2 = s.ri2[k] * s.ri2[k] - s.rj2[k] * s.rj2[k];
      const r = s.d[k * 4 + channel] - (a[s.i[k]] - a[s.j[k]]) - (v[0] * x1 + v[1] * x2);
      w[k] = 1 / (1 + (r / c) * (r / c));
    }
  }
  return { a, v };
}

export function estimatePhotometry(
  thumbs: ThumbImage[],
  rotations: Mat3[],
  focalRel: number,
  k1: number,
): Photometry {
  const N = thumbs.length;
  const identity: Photometry = {
    gains: Array.from({ length: N }, () => [1, 1, 1] as [number, number, number]),
    vignette: [0, 0],
  };
  const samples = collectSamples(thumbs, rotations, focalRel, k1);
  if (samples.n < 200) return identity;

  const lum = solve(samples, N, 0, null);
  // Keep the vignette model plausible: at most ~2 stops of corner darkening, never brightening.
  let [v1, v2] = lum.v;
  if (v1 + v2 > 0) {
    v1 = 0;
    v2 = 0;
  }
  const corner = v1 + v2;
  if (corner < -0.7) {
    const k = -0.7 / corner;
    v1 *= k;
    v2 *= k;
  }
  const vignette: [number, number] = [v1, v2];

  const gains: [number, number, number][] = Array.from({ length: N }, () => [1, 1, 1]);
  for (let ch = 0; ch < 3; ch++) {
    const { a } = solve(samples, N, ch + 1, vignette);
    let mean = 0;
    for (let i = 0; i < N; i++) mean += a[i];
    mean /= N;
    for (let i = 0; i < N; i++) gains[i][ch] = Math.exp(-(a[i] - mean));
  }
  return { gains, vignette };
}
