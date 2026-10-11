import { describe, expect, it } from 'vitest';
import { ASPECTS, MAX_OUTPUT_PIXELS, MAX_OUTPUT_WIDTH, panoramaSizes, planetSizes } from '../src/lib/sizes';

// Mini 2 SE: 2000x1500 photos, f = 1456 px.
const optics = { focalPx: 1456, photoWidth: 2000, photoHeight: 1500 };

describe('panorama sizes', () => {
  it('includes the source-density maximum and stays 2:1', () => {
    const sizes = panoramaSizes(optics);
    const max = sizes.find((s) => s.key === 'max')!;
    expect(max.width).toBeGreaterThan(10000);
    expect(max.width).toBeLessThanOrEqual(MAX_OUTPUT_WIDTH);
    sizes.forEach((s) => expect(s.height * 2).toBe(s.width));
  });
});

describe('little planet sizes', () => {
  it('offers exact 16:9 and 9:16 video sizes', () => {
    const wide = planetSizes(optics, '16:9', 140).map((s) => `${s.width}x${s.height}`);
    expect(wide).toContain('1920x1080');
    expect(wide).toContain('3840x2160');
    const tall = planetSizes(optics, '9:16', 140).map((s) => `${s.width}x${s.height}`);
    expect(tall).toContain('1080x1920');
  });

  it.each(ASPECTS)('keeps %s within the canvas limits and the requested ratio', (aspect) => {
    for (const fov of [90, 140, 170]) {
      const sizes = planetSizes(optics, aspect, fov);
      const max = sizes[sizes.length - 1];
      expect(max.key).toBe('max');
      expect(Math.max(max.width, max.height)).toBeLessThanOrEqual(MAX_OUTPUT_WIDTH);
      expect(max.width * max.height).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS);
      const [a, b] = aspect.split(':').map(Number);
      expect(max.width / max.height).toBeCloseTo(a / b, 2);
      // Sizes grow towards the maximum.
      sizes.reduce((prev, s) => {
        expect(s.width * s.height).toBeGreaterThanOrEqual(prev);
        return s.width * s.height;
      }, 0);
    }
  });

  it('gives zoomed-in views fewer pixels at the same photo detail', () => {
    const narrow = planetSizes(optics, '1:1', 100).at(-1)!;
    const wide = planetSizes(optics, '1:1', 140).at(-1)!;
    expect(narrow.width).toBeLessThan(wide.width);
  });
});
