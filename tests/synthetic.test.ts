import { describe, expect, it } from 'vitest';
import { alignPhotos } from '../src/lib/align/align';
import type { AlignInput } from '../src/lib/align/types';
import { gimbalToRotation, mulVec, normalize, rotationAngle, mul, transpose, type Mat3 } from '../src/lib/geometry';
import { analyzeSelection } from '../src/lib/selection';
import type { PhotoMeta } from '../src/lib/metadata';

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const TEX_W = 4096;
const TEX_H = 2048;

/** Equirectangular scene made of random rectangles, which gives plenty of corners for feature detection. */
function makeScene(rand: () => number): Uint8Array {
  const tex = new Uint8Array(TEX_W * TEX_H);
  for (let y = 0; y < TEX_H; y++) tex.fill(70 + Math.round((y / TEX_H) * 60), y * TEX_W, (y + 1) * TEX_W);
  for (let k = 0; k < 9000; k++) {
    const w = 4 + Math.floor(rand() * 90);
    const h = 4 + Math.floor(rand() * 70);
    const x0 = Math.floor(rand() * TEX_W);
    const y0 = Math.floor(rand() * (TEX_H - h));
    const v = 20 + Math.floor(rand() * 210);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) tex[y * TEX_W + (x % TEX_W)] = v;
    }
  }
  return tex;
}

function render(tex: Uint8Array, R: ArrayLike<number>, w: number, h: number, f: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = normalize(mulVec(R, [(x + 0.5 - w / 2) / f, (y + 0.5 - h / 2) / f, 1]));
      const lon = Math.atan2(d[0], d[1]);
      const lat = Math.asin(d[2]);
      const u = (lon / (2 * Math.PI) + 0.5) * TEX_W - 0.5;
      const v = (0.5 - lat / Math.PI) * TEX_H - 0.5;
      const x0 = Math.floor(u);
      const y0 = Math.max(0, Math.min(TEX_H - 2, Math.floor(v)));
      const fx = u - x0;
      const fy = v - y0;
      const at = (xx: number, yy: number) => tex[yy * TEX_W + ((xx % TEX_W) + TEX_W) % TEX_W];
      out[y * w + x] =
        (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    }
  }
  return out;
}

// A 33 photo layout: four rows of eight plus a nadir shot.
const POSES: [number, number][] = [];
for (const pitch of [45, 15, -15, -45]) for (let col = 0; col < 8; col++) POSES.push([col * 45 + (pitch % 2 ? 22 : 0), pitch]);
POSES.push([0, -90]);

describe('other drones', () => {
  it('aligns 33 photos from a longer lens with an inaccurate focal length hint', async () => {
    const rand = rng(11);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const tex = makeScene(rand);
    const W = 2000;
    const H = 1500;
    const fTrue = 1750;
    const rotations = POSES.map(([yaw, pitch]) => gimbalToRotation(yaw, pitch, 0));

    const input: AlignInput = {
      gray: rotations.map((R) => ({ width: W, height: H, data: render(tex, R, W, H, fTrue) })),
      thumbs: rotations.map((R) => {
        const g = render(tex, R, 400, 300, fTrue * 0.2);
        const rgb = new Uint8Array(400 * 300 * 3);
        g.forEach((v, i) => rgb.fill(v, i * 3, i * 3 + 3));
        return { width: 400, height: 300, data: rgb };
      }),
      // Drone readings are off by roughly 1.5 degrees; the 24 mm hint is ~20% too short a focal length.
      priors: POSES.map(([yaw, pitch]) => ({ yaw: yaw + gauss() * 1.5, pitch: pitch + gauss() * 1.5, roll: gauss() * 0.5 })),
      focal35mm: 24,
    };

    const result = await alignPhotos(input);
    expect(result.focalRel * W).toBeGreaterThan(fTrue * 0.98);
    expect(result.focalRel * W).toBeLessThan(fTrue * 1.02);
    expect(result.stats.rmsPx).toBeLessThan(3);

    // Orientations match the truth up to one global rotation.
    const rel = (R: Mat3[], i: number) => mul(transpose(R[0]), R[i]);
    let worst = 0;
    for (let i = 1; i < rotations.length; i++) {
      worst = Math.max(worst, rotationAngle(mul(transpose(rel(rotations, i)), rel(result.rotations, i))));
    }
    expect(worst * (180 / Math.PI)).toBeLessThan(0.3);
  });
});

describe('selection check', () => {
  const photo = (yaw: number, pitch: number): PhotoMeta =>
    ({ yaw, pitch, roll: 0, focal35mm: 24, focalRel: null, width: 2000, height: 1500 }) as PhotoMeta;

  it('accepts a full sphere set and reports its coverage', () => {
    const report = analyzeSelection(POSES.map(([y, p]) => photo(y, p)));
    expect(report.warnings).toEqual([]);
    expect(report.coverage).toBeGreaterThan(0.6);
  });

  it('flags a selection that contains several panoramas', () => {
    const twice = [...POSES, ...POSES].map(([y, p], i) => photo(y + (i >= POSES.length ? 3 : 0), p));
    expect(analyzeSelection(twice).warnings.join(' ')).toMatch(/more than one panorama/);
  });

  it('flags tiny coverage', () => {
    const report = analyzeSelection([photo(0, 0), photo(40, 0), photo(80, 0)]);
    expect(report.warnings.join(' ')).toMatch(/only cover/);
  });
});
