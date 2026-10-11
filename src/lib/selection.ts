import { gimbalToRotation, mulVecT, type Vec3 } from './geometry';
import type { PhotoMeta } from './metadata';

export interface SelectionReport {
  /** Fraction (0..1) of the full sphere seen by at least one photo, from the gimbal angles. */
  coverage: number;
  warnings: string[];
}

const SAMPLES = 4000;
const DUPLICATE_ANGLE = Math.cos((10 * Math.PI) / 180);

/** Sanity-checks a photo selection without decoding any image. */
export function analyzeSelection(photos: PhotoMeta[]): SelectionReport {
  const warnings: string[] = [];
  const rots = photos.map((p) => gimbalToRotation(p.yaw, p.pitch, p.roll));

  const first = photos[0];
  const aspect = first.width && first.height ? first.height / first.width : 0.75;
  const hint = photos.find((p) => p.focalRel)?.focalRel;
  // Focal length in image widths; 24 mm equivalent over the 43.27 mm diagonal if nothing better is known.
  const rel = hint ?? ((first.focal35mm ?? 24) * Math.hypot(1, aspect)) / 43.2666;
  const halfX = 0.5 / rel;
  const halfY = (0.5 * aspect) / rel;

  let covered = 0;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < SAMPLES; k++) {
    const z = 1 - (2 * (k + 0.5)) / SAMPLES;
    const r = Math.sqrt(1 - z * z);
    const dir: Vec3 = [r * Math.cos(golden * k), r * Math.sin(golden * k), z];
    const seen = rots.some((R) => {
      const c = mulVecT(R, dir);
      return c[2] > 0.05 && Math.abs(c[0] / c[2]) <= halfX && Math.abs(c[1] / c[2]) <= halfY;
    });
    if (seen) covered++;
  }
  const coverage = covered / SAMPLES;

  let twins = 0;
  for (let i = 0; i < rots.length; i++) {
    const a = rots[i];
    const hasTwin = rots.some((b, j) => j !== i && a[2] * b[2] + a[5] * b[5] + a[8] * b[8] > DUPLICATE_ANGLE);
    if (hasTwin) twins++;
  }
  if (twins >= photos.length * 0.25) {
    warnings.push('Several photos point in the same direction, so the selection probably contains more than one panorama. Select one panorama at a time.');
  }
  if (coverage < 0.5) {
    warnings.push(`These photos only cover ${Math.round(coverage * 100)}% of the full sphere, so the panorama will have large empty areas.`);
  }
  return { coverage, warnings };
}
