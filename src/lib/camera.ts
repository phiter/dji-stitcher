import { mulVec, mulVecT, normalize, type Mat3, type Vec3 } from './geometry';

/** Pinhole lens with one radial term in the pixel -> ray direction: p_u = p_d * (1 + k1 * |p_d|^2). */
export interface Lens {
  width: number;
  height: number;
  /** Focal length in pixels. */
  f: number;
  k1: number;
}

const DIAG_35MM = 43.2666;

export function initialFocalPx(width: number, height: number, focal35mm: number | null): number {
  const diag = Math.hypot(width, height);
  if (focal35mm && focal35mm > 5) return (focal35mm * diag) / DIAG_35MM;
  // DJI consumer drones: ~83 degree diagonal field of view.
  return diag / 2 / Math.tan((83 / 2) * (Math.PI / 180));
}

/** Pixel to unnormalized camera-frame ray (x right, y down, z forward). */
export function pixelToCam(lens: Lens, x: number, y: number): Vec3 {
  const xn = (x - lens.width / 2) / lens.f;
  const yn = (y - lens.height / 2) / lens.f;
  const s = 1 + lens.k1 * (xn * xn + yn * yn);
  return [xn * s, yn * s, 1];
}

/** Pixel to unit world direction, given the camera-to-world rotation. */
export function pixelToWorld(lens: Lens, rot: ArrayLike<number>, x: number, y: number): Vec3 {
  return normalize(mulVec(rot, pixelToCam(lens, x, y)));
}

/** Camera-frame direction to pixel; null when behind the camera. */
export function camToPixel(lens: Lens, c: Vec3): [number, number] | null {
  if (c[2] <= 1e-6) return null;
  const xu = c[0] / c[2];
  const yu = c[1] / c[2];
  let xd = xu;
  let yd = yu;
  if (lens.k1 !== 0) {
    for (let i = 0; i < 8; i++) {
      const s = 1 + lens.k1 * (xd * xd + yd * yd);
      xd = xu / s;
      yd = yu / s;
    }
  }
  return [xd * lens.f + lens.width / 2, yd * lens.f + lens.height / 2];
}

export function worldToPixel(lens: Lens, rot: Mat3 | ArrayLike<number>, dir: Vec3): [number, number] | null {
  return camToPixel(lens, mulVecT(rot, dir));
}

export function inImage(lens: Lens, p: [number, number] | null, margin = 0): p is [number, number] {
  return !!p && p[0] >= margin && p[0] <= lens.width - margin && p[1] >= margin && p[1] <= lens.height - margin;
}
