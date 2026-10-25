import { describe, expect, it } from 'vitest';
import { camToPixel, pixelToWorld, worldToPixel, type Lens } from '../src/lib/camera';
import {
  DEG,
  dirToLonLat,
  expSO3,
  gimbalToRotation,
  lonLatToDir,
  mulVec,
  orthonormalize,
  rotationAngle,
} from '../src/lib/geometry';

const close = (a: number[], b: number[], eps = 1e-9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)));

describe('geometry', () => {
  it('points the camera along the gimbal heading and pitch', () => {
    const east = gimbalToRotation(90, 0, 0);
    close(mulVec(east, [0, 0, 1]), [1, 0, 0]);
    const down = gimbalToRotation(40, -90, 0);
    close(mulVec(down, [0, 0, 1]), [0, 0, -1]);
    const up45 = gimbalToRotation(0, 45, 0);
    close(mulVec(up45, [0, 0, 1]), [0, Math.SQRT1_2, Math.SQRT1_2]);
  });

  it('keeps image-right to the right of the heading and image-down towards the ground', () => {
    const R = gimbalToRotation(0, 0, 0);
    close(mulVec(R, [1, 0, 0]), [1, 0, 0]);
    close(mulVec(R, [0, 1, 0]), [0, 0, -1]);
  });

  it('produces proper rotations', () => {
    const R = gimbalToRotation(123, -37, 4);
    const RtR = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => R[i] * R[j] + R[3 + i] * R[3 + j] + R[6 + i] * R[6 + j]));
    close(RtR, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const det =
      R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
    expect(det).toBeCloseTo(1, 9);
  });

  it('exponential map has the requested angle and re-orthonormalizes', () => {
    const R = expSO3([0.1, -0.2, 0.3]);
    expect(rotationAngle(R)).toBeCloseTo(Math.hypot(0.1, 0.2, 0.3), 9);
    const noisy = R.map((v) => v + 1e-4) as typeof R;
    expect(rotationAngle(orthonormalize(noisy))).toBeCloseTo(rotationAngle(R), 3);
  });

  it('converts between directions and longitude/latitude', () => {
    const [lon, lat] = dirToLonLat(lonLatToDir(2.1, -0.7));
    expect(lon).toBeCloseTo(2.1, 9);
    expect(lat).toBeCloseTo(-0.7, 9);
    expect(dirToLonLat([1, 0, 0])[0]).toBeCloseTo(90 * DEG, 9);
  });
});

describe('camera', () => {
  it.each([0, -0.05, 0.08])('round-trips pixels and rays with k1=%d', (k1) => {
    const lens: Lens = { width: 2000, height: 1500, f: 1450, k1 };
    const R = gimbalToRotation(30, -20, 0);
    for (const [x, y] of [[100, 80], [1000, 750], [1900, 1400], [300, 1300]]) {
      const ray = pixelToWorld(lens, R, x, y);
      const p = worldToPixel(lens, R, ray)!;
      expect(p[0]).toBeCloseTo(x, 4);
      expect(p[1]).toBeCloseTo(y, 4);
    }
  });

  it('rejects directions behind the camera', () => {
    expect(camToPixel({ width: 100, height: 100, f: 100, k1: 0 }, [0, 0, -1])).toBeNull();
  });

  it('does not invent positions for rays far outside the field of view when k1 is negative', () => {
    const lens: Lens = { width: 4032, height: 3024, f: 2958, k1: -0.042 };
    const R = gimbalToRotation(0, 0, 0);
    for (let deg = 65; deg < 89; deg += 1) {
      const dir = lonLatToDir(deg * DEG, 0);
      expect(worldToPixel(lens, R, dir)).toBeNull();
    }
    expect(worldToPixel(lens, R, lonLatToDir(20 * DEG, 0))).not.toBeNull();
  });
});
