import { describe, expect, it } from 'vitest';
import { estimatePhotometry } from '../src/lib/align/photometric';
import { computeEdgeFill } from '../src/lib/render/skyfill';
import { addPanoramaXmp } from '../src/lib/render/encode';
import { gimbalToRotation } from '../src/lib/geometry';
import { hamming, matchGated } from '../src/lib/align/matching';

describe('edge fill', () => {
  const W = 64;
  const H = 32;
  const covered = (from: number, to: number) => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = from; y < to; y++) {
      for (let x = 0; x < W; x++) rgba.set([51, 102, 204, 255], (y * W + x) * 4);
    }
    return rgba;
  };

  it('finds the top edge and its colour per column', () => {
    const fill = computeEdgeFill(covered(12, H), W, H)!;
    expect(fill.zenith[0]).toBeCloseTo(0.2, 2);
    expect(fill.zenith[2]).toBeCloseTo(0.8, 2);
    // Edge row 12 is at latitude (0.5 - 12.5/32) * PI; the stored boundary is slightly lower to stay inclusive.
    const lat = fill.columns[3];
    expect(lat).toBeLessThan((0.5 - 12.5 / H) * Math.PI);
    expect(lat).toBeGreaterThan((0.5 - 15 / H) * Math.PI);
  });

  it('also finds where the ground ends', () => {
    const fill = computeEdgeFill(covered(4, 24), W, H)!;
    const lat = fill.columns[W * 4 + 3];
    // Last covered row 23 sits at (0.5 - 23.5/32) * PI; the boundary is slightly higher to stay inclusive.
    expect(lat).toBeGreaterThan((0.5 - 23.5 / H) * Math.PI);
    expect(lat).toBeLessThan((0.5 - 20 / H) * Math.PI);
    expect(fill.nadir[2]).toBeCloseTo(0.8, 2);
  });

  it('gives up when the photos cover too little', () => {
    expect(computeEdgeFill(new Uint8ClampedArray(16 * 16 * 4), 16, 16)).toBeNull();
  });
});

describe('panorama metadata', () => {
  it('inserts GPano XMP after the JFIF header', async () => {
    const jfif = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, ...jfif, 0xff, 0xdb, 0x00, 0x02, 0xff, 0xd9])]);
    const out = new Uint8Array(await (await addPanoramaXmp(jpeg, { width: 8192, height: 4096, software: 'test' })).arrayBuffer());
    expect(Array.from(out.slice(0, 4))).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(Array.from(out.slice(20, 22))).toEqual([0xff, 0xe1]);
    const text = new TextDecoder().decode(out.slice(22, 22 + ((out[22] << 8) | out[23])));
    expect(text).toContain('<GPano:FullPanoWidthPixels>8192</GPano:FullPanoWidthPixels>');
    expect(text).toContain('equirectangular');
    expect(Array.from(out.slice(-6))).toEqual([0xff, 0xdb, 0x00, 0x02, 0xff, 0xd9]);
  });
});

describe('feature matching', () => {
  const make = (words: number[][]) => ({
    count: words.length,
    xy: Float32Array.from(words.map((_, i) => [i * 10, 0]).flat()),
    desc: Uint32Array.from(words.flat()),
  });
  const w = (seed: number) => {
    let s = seed * 7919 + 1;
    return Array.from({ length: 8 }, () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s;
    });
  };

  it('computes hamming distance', () => {
    expect(hamming(Uint32Array.from([0, 0, 0, 0, 0, 0, 0, 0b111]), 0, new Uint32Array(8), 0)).toBe(3);
  });

  it('only matches inside the gate and keeps matches one-to-one', () => {
    const a = make([w(1), w(2), w(3)]);
    const b = make([w(3), w(1), w(2)]);
    // Features move +10 px in b, so an identity prediction with a 6 px gate cannot see the partner.
    const m = matchGated(a, b, (x, y) => [x, y], 6, 0.9, 80);
    expect(m).toHaveLength(0);
    const shifted = matchGated(a, b, (x, y) => (x === 0 ? [10, y] : x === 10 ? [20, y] : [0, y]), 6, 0.9, 80);
    expect(shifted).toHaveLength(12);
  });
});

describe('photometric estimation', () => {
  it('measures the exposure ratio between two views of the same scene', () => {
    const W = 400;
    const H = 300;
    const scene = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = 70 + 40 * Math.sin(x / 23) * Math.cos(y / 17) + (x / W) * 20;
        scene.set([v, v * 0.9, v * 0.8], (y * W + x) * 3);
      }
    }
    const brighter = scene.map((v) => Math.min(255, v * 1.4));
    const R = gimbalToRotation(0, 0, 0);
    const { gains } = estimatePhotometry(
      [
        { width: W, height: H, data: scene },
        { width: W, height: H, data: brighter },
      ],
      [R, R],
      0.73,
      0,
    );
    expect(gains[0][1] / gains[1][1]).toBeCloseTo(1.4, 1);
  });
});
