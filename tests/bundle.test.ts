import { describe, expect, it } from 'vitest';
import { bundleAdjust, evaluate, type BAMatches, type BAOptions } from '../src/lib/align/bundle';
import { pixelToWorld, worldToPixel, type Lens } from '../src/lib/camera';
import { expSO3, gimbalToRotation, lonLatToDir, mul, orthonormalize, rotationAngle, transpose, type Mat3 } from '../src/lib/geometry';

// Small deterministic generator so the test is reproducible.
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('bundle adjustment', () => {
  it('recovers rotations and focal length from noisy matches', () => {
    const rand = rng(7);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const lens: Lens = { width: 2000, height: 1500, f: 1456, k1: 0 };

    const poses: [number, number][] = [];
    for (let col = 0; col < 8; col++) for (const pitch of [15, -20, -55]) poses.push([col * 45, pitch]);
    const truth = poses.map(([yaw, pitch]) => gimbalToRotation(yaw, pitch, 0));

    const I: number[] = [];
    const J: number[] = [];
    const P: number[] = [];
    for (let n = 0; n < 40000; n++) {
      const dir = lonLatToDir(rand() * 2 * Math.PI, Math.asin(rand() * 1.5 - 0.9));
      const hits: { i: number; p: [number, number] }[] = [];
      truth.forEach((R, i) => {
        const p = worldToPixel(lens, R, dir);
        if (p && p[0] > 20 && p[0] < 1980 && p[1] > 20 && p[1] < 1480) hits.push({ i, p });
      });
      for (let a = 0; a < hits.length; a++) {
        for (let b = a + 1; b < hits.length; b++) {
          I.push(hits[a].i);
          J.push(hits[b].i);
          P.push(hits[a].p[0] + gauss() * 0.5, hits[a].p[1] + gauss() * 0.5, hits[b].p[0] + gauss() * 0.5, hits[b].p[1] + gauss() * 0.5);
        }
      }
    }
    // A few gross outliers must not matter.
    for (let k = 0; k < 200; k++) P[Math.floor(rand() * P.length)] += 300 * (rand() - 0.5);
    const matches: BAMatches = { count: I.length, i: Int32Array.from(I), j: Int32Array.from(J), p: Float32Array.from(P) };
    expect(matches.count).toBeGreaterThan(1000);

    // Drone readings are a couple of degrees off and the focal estimate is 5% too long.
    const prior = truth.map((R) => orthonormalize(mul(expSO3([gauss() * 0.03, gauss() * 0.03, gauss() * 0.03]), R)));
    const opts: BAOptions = {
      width: lens.width,
      height: lens.height,
      priorRot: prior,
      priorSigmaRad: 2.5 * (Math.PI / 180),
      priorLfSigma: 0.08,
      lf0: Math.log(lens.f * 1.05),
      optimizeFocal: true,
      optimizeK1: false,
      robustPx: 3,
      maxIter: 60,
    };
    const start = { rot: prior, lf: opts.lf0, k1: 0 };
    const before = evaluate(start, matches, opts);
    const { params, cost } = bundleAdjust(start, matches, opts);

    expect(cost).toBeLessThan(before);
    expect(Math.exp(params.lf)).toBeCloseTo(lens.f, -1); // within ~5 px
    // The solution is only defined up to a global rotation; compare relative orientations.
    const rel = (R: Mat3[], i: number) => mul(transpose(R[0]), R[i]);
    let worst = 0;
    for (let i = 1; i < truth.length; i++) {
      worst = Math.max(worst, rotationAngle(mul(transpose(rel(truth, i)), rel(params.rot, i))));
    }
    expect(worst * (180 / Math.PI)).toBeLessThan(0.15);
  });

  it('keeps the drone orientation when there are no matches', () => {
    const R = gimbalToRotation(10, -10, 0);
    const opts: BAOptions = {
      width: 100, height: 100, priorRot: [R], priorSigmaRad: 0.04, priorLfSigma: 0.08, lf0: Math.log(100),
      optimizeFocal: true, optimizeK1: false, robustPx: 3, maxIter: 5,
    };
    const empty: BAMatches = { count: 0, i: new Int32Array(0), j: new Int32Array(0), p: new Float32Array(0) };
    const { params } = bundleAdjust({ rot: [R], lf: opts.lf0, k1: 0 }, empty, opts);
    expect(rotationAngle(mul(transpose(R), params.rot[0]))).toBeLessThan(1e-6);
    expect(pixelToWorld({ width: 100, height: 100, f: 100, k1: 0 }, R, 50, 50)).toHaveLength(3);
  });
});
