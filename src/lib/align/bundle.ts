import { expSO3, mul, orthonormalize, type Mat3, type Vec3 } from '../geometry';

export interface BAMatches {
  count: number;
  i: Int32Array;
  j: Int32Array;
  /** xi, yi, xj, yj per match in pixels of the (width x height) alignment images. */
  p: Float32Array;
}

export interface BAParams {
  rot: Mat3[];
  /** ln(focal length in pixels). */
  lf: number;
  k1: number;
}

export interface BAOptions {
  width: number;
  height: number;
  /** Rotations the solver is gently pulled towards (drone gimbal readings). */
  priorRot: Mat3[];
  priorSigmaRad: number;
  /** Prior on ln f, relative sigma. */
  priorLfSigma: number;
  lf0: number;
  optimizeFocal: boolean;
  optimizeK1: boolean;
  /** Cauchy scale in pixels. */
  robustPx: number;
  maxIter: number;
}

export interface BAResult {
  params: BAParams;
  cost: number;
  iterations: number;
}

const SIGMA_PX = 1;

function cholSolve(H: Float64Array, g: Float64Array, n: number, lambda: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= r; c++) {
      let s = H[r * n + c];
      if (r === c) s += lambda * (H[r * n + r] + 1e-9) + 1e-12;
      for (let k = 0; k < c; k++) s -= L[r * n + k] * L[c * n + k];
      if (r === c) {
        if (s <= 0) return null;
        L[r * n + r] = Math.sqrt(s);
      } else {
        L[r * n + c] = s / L[c * n + c];
      }
    }
  }
  const y = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    let s = -g[r];
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

/** Per-pixel ray (unit, world) plus its derivatives with respect to ln f and k1. */
function rayWithLensJac(
  R: Mat3,
  f: number,
  k1: number,
  width: number,
  height: number,
  x: number,
  y: number,
  ray: Float64Array,
  dLf: Float64Array,
  dK1: Float64Array,
): void {
  const xn = (x - width / 2) / f;
  const yn = (y - height / 2) / f;
  const r2 = xn * xn + yn * yn;
  const s = 1 + k1 * r2;
  const u0 = xn * s;
  const u1 = yn * s;
  const inv = 1 / Math.hypot(u0, u1, 1);
  const uh0 = u0 * inv;
  const uh1 = u1 * inv;
  const uh2 = inv;
  // d u / d lf  (u depends on f through xn, yn)
  const du0 = -u0 - 2 * xn * k1 * r2;
  const du1 = -u1 - 2 * yn * k1 * r2;
  // d u / d k1
  const dk0 = xn * r2;
  const dk1 = yn * r2;
  const project = (a0: number, a1: number, a2: number, out: Float64Array) => {
    const d = uh0 * a0 + uh1 * a1 + uh2 * a2;
    const p0 = (a0 - uh0 * d) * inv;
    const p1 = (a1 - uh1 * d) * inv;
    const p2 = (a2 - uh2 * d) * inv;
    out[0] = R[0] * p0 + R[1] * p1 + R[2] * p2;
    out[1] = R[3] * p0 + R[4] * p1 + R[5] * p2;
    out[2] = R[6] * p0 + R[7] * p1 + R[8] * p2;
  };
  ray[0] = R[0] * uh0 + R[1] * uh1 + R[2] * uh2;
  ray[1] = R[3] * uh0 + R[4] * uh1 + R[5] * uh2;
  ray[2] = R[6] * uh0 + R[7] * uh1 + R[8] * uh2;
  project(du0, du1, 0, dLf);
  project(dk0, dk1, 0, dK1);
}

function applyDelta(params: BAParams, delta: Float64Array, opts: BAOptions): BAParams {
  const N = params.rot.length;
  const rot = params.rot.map((R, i) => {
    const w: Vec3 = [delta[i * 3], delta[i * 3 + 1], delta[i * 3 + 2]];
    return orthonormalize(mul(expSO3(w), R));
  });
  let o = N * 3;
  let lf = params.lf;
  let k1 = params.k1;
  if (opts.optimizeFocal) lf += delta[o++];
  if (opts.optimizeK1) k1 += delta[o++];
  return { rot, lf, k1: Math.max(-0.3, Math.min(0.3, k1)) };
}

function cauchy(e: number, c: number): number {
  const t = e / c;
  return 0.5 * c * c * Math.log(1 + t * t);
}

/** Robust cost of the current parameters plus per-match residual norms (px). */
export function evaluate(
  params: BAParams,
  m: BAMatches,
  opts: BAOptions,
  residualsOut?: Float64Array,
): number {
  const f = Math.exp(params.lf);
  const f0 = Math.exp(opts.lf0);
  const rayI = new Float64Array(3);
  const rayJ = new Float64Array(3);
  const dummy = new Float64Array(3);
  let cost = 0;
  const c = opts.robustPx / SIGMA_PX;
  for (let k = 0; k < m.count; k++) {
    const p = k * 4;
    rayWithLensJac(params.rot[m.i[k]], f, params.k1, opts.width, opts.height, m.p[p], m.p[p + 1], rayI, dummy, dummy);
    rayWithLensJac(params.rot[m.j[k]], f, params.k1, opts.width, opts.height, m.p[p + 2], m.p[p + 3], rayJ, dummy, dummy);
    const e = (Math.hypot(rayI[0] - rayJ[0], rayI[1] - rayJ[1], rayI[2] - rayJ[2]) * f0) / SIGMA_PX;
    if (residualsOut) residualsOut[k] = e * SIGMA_PX;
    cost += cauchy(e, c);
  }
  cost += priorCost(params, opts);
  return cost;
}

function priorCost(params: BAParams, opts: BAOptions): number {
  let cost = 0;
  for (let i = 0; i < params.rot.length; i++) {
    const d = mul(params.rot[i], transposeOf(opts.priorRot[i]));
    const tr = d[0] + d[4] + d[8];
    const ang = Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2)));
    const e = ang / opts.priorSigmaRad;
    cost += 0.5 * e * e;
  }
  if (opts.optimizeFocal) {
    const e = (params.lf - opts.lf0) / opts.priorLfSigma;
    cost += 0.5 * e * e;
  }
  if (opts.optimizeK1) {
    const e = params.k1 / 0.15;
    cost += 0.5 * e * e;
  }
  return cost;
}

const transposeOf = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** Levenberg-Marquardt refinement of all rotations (+ shared focal length and k1). */
export function bundleAdjust(start: BAParams, m: BAMatches, opts: BAOptions): BAResult {
  const N = start.rot.length;
  const nFocal = opts.optimizeFocal ? 1 : 0;
  const nK1 = opts.optimizeK1 ? 1 : 0;
  const n = N * 3 + nFocal + nK1;
  const iF = N * 3;
  const iK = N * 3 + nFocal;
  const f0 = Math.exp(opts.lf0);
  const c = opts.robustPx / SIGMA_PX;
  const sigmaPrior = opts.priorSigmaRad;

  let params = start;
  let cost = evaluate(params, m, opts);
  let lambda = 1e-3;
  let iterations = 0;

  const ws = { H: new Float64Array(n * n), g: new Float64Array(n) };
  const rayI = new Float64Array(3);
  const rayJ = new Float64Array(3);
  const dLfI = new Float64Array(3);
  const dLfJ = new Float64Array(3);
  const dKI = new Float64Array(3);
  const dKJ = new Float64Array(3);
  // Local Jacobian: 3 rows x up to (3 + 3 + 2) columns.
  const J = new Float64Array(3 * 8);
  const idx = new Int32Array(8);

  for (let iter = 0; iter < opts.maxIter; iter++) {
    iterations = iter + 1;
    ws.H.fill(0);
    ws.g.fill(0);
    const f = Math.exp(params.lf);

    for (let k = 0; k < m.count; k++) {
      const p = k * 4;
      const a = m.i[k];
      const b = m.j[k];
      rayWithLensJac(params.rot[a], f, params.k1, opts.width, opts.height, m.p[p], m.p[p + 1], rayI, dLfI, dKI);
      rayWithLensJac(params.rot[b], f, params.k1, opts.width, opts.height, m.p[p + 2], m.p[p + 3], rayJ, dLfJ, dKJ);
      const s = f0 / SIGMA_PX;
      const r0 = (rayI[0] - rayJ[0]) * s;
      const r1 = (rayI[1] - rayJ[1]) * s;
      const r2 = (rayI[2] - rayJ[2]) * s;
      const e = Math.hypot(r0, r1, r2);
      const w = 1 / (1 + (e / c) * (e / c));

      // Columns: omega_a (3), omega_b (3), [lf], [k1]
      let cols = 0;
      for (let t = 0; t < 3; t++) idx[cols++] = a * 3 + t;
      for (let t = 0; t < 3; t++) idx[cols++] = b * 3 + t;
      if (nFocal) idx[cols++] = iF;
      if (nK1) idx[cols++] = iK;
      // Row r, column c of the local Jacobian lives at r * stride + c.
      const stride = cols;
      const setRow = (row: number, c0: number, c1: number, c2: number, c3: number, c4: number, c5: number) => {
        J[row * stride + 0] = c0; J[row * stride + 1] = c1; J[row * stride + 2] = c2;
        J[row * stride + 3] = c3; J[row * stride + 4] = c4; J[row * stride + 5] = c5;
      };
      const ax = rayI[0] * s, ay = rayI[1] * s, az = rayI[2] * s;
      const bx = rayJ[0] * s, by = rayJ[1] * s, bz = rayJ[2] * s;
      // d(ray_a)/d omega_a = -[ray_a]x ; d(-ray_b)/d omega_b = +[ray_b]x
      setRow(0, 0, az, -ay, 0, -bz, by);
      setRow(1, -az, 0, ax, bz, 0, -bx);
      setRow(2, ay, -ax, 0, -by, bx, 0);
      let cc = 6;
      if (nFocal) {
        J[0 * stride + cc] = (dLfI[0] - dLfJ[0]) * s;
        J[1 * stride + cc] = (dLfI[1] - dLfJ[1]) * s;
        J[2 * stride + cc] = (dLfI[2] - dLfJ[2]) * s;
        cc++;
      }
      if (nK1) {
        J[0 * stride + cc] = (dKI[0] - dKJ[0]) * s;
        J[1 * stride + cc] = (dKI[1] - dKJ[1]) * s;
        J[2 * stride + cc] = (dKI[2] - dKJ[2]) * s;
      }
      const res = [r0, r1, r2];
      for (let u = 0; u < cols; u++) {
        const gu = idx[u];
        let gsum = 0;
        for (let r = 0; r < 3; r++) gsum += J[r * stride + u] * res[r];
        ws.g[gu] += w * gsum;
        for (let v = u; v < cols; v++) {
          let hsum = 0;
          for (let r = 0; r < 3; r++) hsum += J[r * stride + u] * J[r * stride + v];
          const gv = idx[v];
          ws.H[gu * n + gv] += w * hsum;
          if (gu !== gv) ws.H[gv * n + gu] += w * hsum;
        }
      }
    }

    // Rotation priors (small-angle approximation around the current estimate).
    for (let i = 0; i < N; i++) {
      const d = mul(params.rot[i], transposeOf(opts.priorRot[i]));
      // Axis-angle of d (left perturbation): vee of the skew part.
      const vx = (d[7] - d[5]) / 2;
      const vy = (d[2] - d[6]) / 2;
      const vz = (d[3] - d[1]) / 2;
      const sinA = Math.hypot(vx, vy, vz);
      const tr = d[0] + d[4] + d[8];
      const ang = Math.atan2(sinA, (tr - 1) / 2);
      const k = sinA > 1e-9 ? ang / sinA : 1;
      const wv = [vx * k, vy * k, vz * k];
      const inv2 = 1 / (sigmaPrior * sigmaPrior);
      for (let t = 0; t < 3; t++) {
        ws.g[i * 3 + t] += wv[t] * inv2;
        ws.H[(i * 3 + t) * n + i * 3 + t] += inv2;
      }
    }
    if (nFocal) {
      const inv2 = 1 / (opts.priorLfSigma * opts.priorLfSigma);
      ws.g[iF] += (params.lf - opts.lf0) * inv2;
      ws.H[iF * n + iF] += inv2;
    }
    if (nK1) {
      const inv2 = 1 / (0.15 * 0.15);
      ws.g[iK] += params.k1 * inv2;
      ws.H[iK * n + iK] += inv2;
    }

    let accepted = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const delta = cholSolve(ws.H, ws.g, n, lambda);
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const cand = applyDelta(params, delta, opts);
      const candCost = evaluate(cand, m, opts);
      if (candCost < cost) {
        let step = 0;
        for (let t = 0; t < n; t++) step = Math.max(step, Math.abs(delta[t]));
        const improvement = cost - candCost;
        params = cand;
        cost = candCost;
        lambda = Math.max(lambda / 4, 1e-9);
        accepted = true;
        if (step < 1e-8 || improvement < 1e-6 * Math.max(1, cost)) iter = opts.maxIter;
        break;
      }
      lambda *= 4;
    }
    if (!accepted) break;
  }
  return { params, cost, iterations };
}
