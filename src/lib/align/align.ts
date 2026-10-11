import { initialFocalPx, pixelToWorld, worldToPixel, type Lens } from '../camera';
import { gimbalToRotation, rotationAngle, mul, transpose, type Mat3 } from '../geometry';
import { bundleAdjust, evaluate, type BAMatches, type BAOptions, type BAParams } from './bundle';
import { detectFeatures, loadCv, type Features } from './features';
import { matchGated } from './matching';
import { estimatePhotometry } from './photometric';
import type { AlignInput, AlignResult, ProgressFn } from './types';

interface Round {
  radius: number;
  ratio: number;
  maxDist: number;
  robustPx: number;
  prunePx: number;
  optimizeK1: boolean;
}

// Coarse-to-fine: loose gating while the focal length is still uncertain, then tighter.
const ROUNDS: Round[] = [
  { radius: 220, ratio: 0.9, maxDist: 80, robustPx: 10, prunePx: 30, optimizeK1: false },
  { radius: 70, ratio: 0.85, maxDist: 72, robustPx: 3, prunePx: 9, optimizeK1: true },
  { radius: 28, ratio: 0.85, maxDist: 72, robustPx: 1.5, prunePx: 3.5, optimizeK1: true },
];

const MIN_PAIR_MATCHES = 12;

// Round 0 is accepted when most matches fit after the first optimisation; otherwise other focal guesses are tried.
const HEALTHY_KEPT_FRACTION = 0.75;
const HEALTHY_MEDIAN_PX = 6;
const TIGHT_PX = 3;
const FOCAL_SCALES = [1, 1.1, 0.9, 1.2, 0.8];

function overlapFraction(lens: Lens, Ra: Mat3, Rb: Mat3): number {
  let inside = 0;
  let total = 0;
  for (let gy = 0; gy < 5; gy++) {
    for (let gx = 0; gx < 7; gx++) {
      const x = ((gx + 0.5) / 7) * lens.width;
      const y = ((gy + 0.5) / 5) * lens.height;
      const p = worldToPixel(lens, Rb, pixelToWorld(lens, Ra, x, y));
      total++;
      if (p && p[0] >= 0 && p[0] <= lens.width && p[1] >= 0 && p[1] <= lens.height) inside++;
    }
  }
  return inside / total;
}

export function findOverlappingPairs(lens: Lens, rot: Mat3[], minFraction = 0.06): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < rot.length; i++) {
    for (let j = i + 1; j < rot.length; j++) {
      const f = Math.max(overlapFraction(lens, rot[i], rot[j]), overlapFraction(lens, rot[j], rot[i]));
      if (f >= minFraction) pairs.push([i, j]);
    }
  }
  return pairs;
}

function collectMatches(
  features: Features[],
  pairs: [number, number][],
  lens: Lens,
  rot: Mat3[],
  round: Round,
): BAMatches {
  const I: number[] = [];
  const J: number[] = [];
  const P: number[] = [];
  for (const [a, b] of pairs) {
    const predict = (x: number, y: number) => worldToPixel(lens, rot[b], pixelToWorld(lens, rot[a], x, y));
    const m = matchGated(features[a], features[b], predict, round.radius, round.ratio, round.maxDist);
    const count = m.length / 4;
    if (count < MIN_PAIR_MATCHES) continue;
    for (let k = 0; k < count; k++) {
      I.push(a);
      J.push(b);
      P.push(m[k * 4], m[k * 4 + 1], m[k * 4 + 2], m[k * 4 + 3]);
    }
  }
  return { count: I.length, i: Int32Array.from(I), j: Int32Array.from(J), p: Float32Array.from(P) };
}

function subset(m: BAMatches, keep: (k: number) => boolean): BAMatches {
  const I: number[] = [];
  const J: number[] = [];
  const P: number[] = [];
  for (let k = 0; k < m.count; k++) {
    if (!keep(k)) continue;
    I.push(m.i[k]);
    J.push(m.j[k]);
    P.push(m.p[k * 4], m.p[k * 4 + 1], m.p[k * 4 + 2], m.p[k * 4 + 3]);
  }
  return { count: I.length, i: Int32Array.from(I), j: Int32Array.from(J), p: Float32Array.from(P) };
}

const median = (a: ArrayLike<number>): number => {
  const s = Array.from(a).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

export async function alignPhotos(
  input: AlignInput,
  onProgress: ProgressFn = () => {},
): Promise<AlignResult> {
  const N = input.gray.length;
  const { width, height } = input.gray[0];
  const warnings: string[] = [];
  const priorRot = input.priors.map((e) => gimbalToRotation(e.yaw, e.pitch, e.roll));
  const f0 = input.focalHintRel ? input.focalHintRel * width : initialFocalPx(width, height, input.focal35mm);

  const cv = await loadCv();
  const features: Features[] = [];
  for (let i = 0; i < N; i++) {
    onProgress('Detecting features', i / N);
    features.push(detectFeatures(cv, input.gray[i]));
  }

  const baseOpts = {
    width,
    height,
    priorRot,
    priorSigmaRad: (2.5 * Math.PI) / 180,
    priorLfSigma: 0.12,
    optimizeFocal: true,
    maxIter: 40,
  };
  const noMatches: BAMatches = { count: 0, i: new Int32Array(0), j: new Int32Array(0), p: new Float32Array(0) };

  // One matching + optimisation pass; `ok` is false when too few features could be matched.
  const runRound = (r: number, start: BAParams, lf0: number) => {
    const round = ROUNDS[r];
    const lens: Lens = { width, height, f: Math.exp(start.lf), k1: start.k1 };
    const pairs = findOverlappingPairs(lens, start.rot);
    const raw = collectMatches(features, pairs, lens, start.rot, round);
    if (raw.count < 30) return { params: start, matches: raw, pairs: pairs.length, ok: false, tight: 0, healthy: false };
    const opts: BAOptions = { ...baseOpts, lf0, optimizeK1: round.optimizeK1, robustPx: round.robustPx };
    let params = bundleAdjust(start, raw, opts).params;
    const res = new Float64Array(raw.count);
    evaluate(params, raw, opts, res);
    const matches = subset(raw, (k) => res[k] <= round.prunePx);
    // A good focal guess leaves most matches consistent after the first optimisation.
    const tight = res.filter((v) => v <= TIGHT_PX).length;
    const healthy = matches.count >= HEALTHY_KEPT_FRACTION * raw.count && median(res) <= HEALTHY_MEDIAN_PX;
    params = bundleAdjust(params, matches, opts).params;
    return { params, matches, pairs: pairs.length, ok: true, tight, healthy };
  };

  // Round 0 with a few focal length guesses (the metadata is only approximate for some drones).
  let best: (ReturnType<typeof runRound> & { lf0: number }) | null = null;
  for (const scale of FOCAL_SCALES) {
    onProgress('Aligning photos', 0);
    const lf0 = Math.log(f0 * scale);
    const start: BAParams = { rot: priorRot.map((r) => [...r] as Mat3), lf: lf0, k1: 0 };
    const stage = runRound(0, start, lf0);
    if (!best || stage.tight > best.tight) best = { ...stage, lf0 };
    if (stage.healthy) break;
  }

  let params = best!.params;
  let matches = best!.matches;
  let pairCount = best!.pairs;
  const lf0 = best!.lf0;
  if (!best!.ok) {
    warnings.push('Very few matching features were found; the drone orientation data is used as is.');
    params = { rot: priorRot.map((r) => [...r] as Mat3), lf: Math.log(f0), k1: 0 };
    matches = noMatches;
  } else {
    for (let r = 1; r < ROUNDS.length; r++) {
      onProgress('Aligning photos', r / ROUNDS.length);
      const stage = runRound(r, params, lf0);
      if (!stage.ok) break;
      params = stage.params;
      matches = stage.matches;
      pairCount = stage.pairs;
    }
  }

  const finalOpts: BAOptions = { ...baseOpts, lf0, optimizeK1: true, robustPx: 1.5 };
  const res = new Float64Array(matches.count);
  evaluate(params, matches, finalOpts, res);
  const perImage = new Array<number>(N).fill(0);
  for (let k = 0; k < matches.count; k++) {
    perImage[matches.i[k]]++;
    perImage[matches.j[k]]++;
  }
  let sq = 0;
  for (const v of res) sq += v * v;
  let maxCorrection = 0;
  for (let i = 0; i < N; i++) {
    maxCorrection = Math.max(maxCorrection, rotationAngle(mul(params.rot[i], transpose(priorRot[i]))));
  }
  perImage.forEach((c, i) => {
    if (c < 40) warnings.push(`Photo ${i + 1} has few matching features (${c}); its drone orientation is mostly kept.`);
  });

  onProgress('Balancing exposure', 0.9);
  const photometry = estimatePhotometry(input.thumbs, params.rot, Math.exp(params.lf) / width, params.k1);

  return {
    focalRel: Math.exp(params.lf) / width,
    k1: params.k1,
    rotations: params.rot,
    gains: photometry.gains,
    vignette: photometry.vignette,
    stats: {
      pairs: pairCount,
      matches: matches.count,
      rmsPx: Math.sqrt(sq / Math.max(1, matches.count)),
      medianPx: median(res),
      perImageMatches: perImage,
      maxCorrectionDeg: (maxCorrection * 180) / Math.PI,
    },
    warnings,
  };
}
