import type { Lens } from '../camera';
import type { Mat3 } from '../geometry';

/** Single-channel image used for feature detection. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Small RGB copy (3 bytes per pixel) used for exposure estimation. */
export interface ThumbImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Euler {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface AlignInput {
  gray: GrayImage[];
  thumbs: ThumbImage[];
  priors: Euler[];
  focal35mm: number | null;
  /** Calibrated focal length relative to the image width, when the drone records it. */
  focalHintRel?: number | null;
}

export interface AlignStats {
  pairs: number;
  matches: number;
  rmsPx: number;
  medianPx: number;
  /** Matches that survived outlier rejection, per photo. */
  perImageMatches: number[];
  /** Largest rotation change relative to the drone gimbal angles, degrees. */
  maxCorrectionDeg: number;
}

export interface AlignResult {
  /** Focal length relative to image width (resolution independent). */
  focalRel: number;
  k1: number;
  /** Camera-to-world rotations. */
  rotations: Mat3[];
  /** Per photo RGB multipliers applied in the encoded (gamma) domain. */
  gains: [number, number, number][];
  /** log V(r) = v1 r^2 + v2 r^4 with r normalised by the half diagonal. */
  vignette: [number, number];
  stats: AlignStats;
  warnings: string[];
}

export type ProgressFn = (stage: string, fraction: number) => void;

export function lensFor(input: AlignInput, focalPx: number, k1 = 0): Lens {
  return { width: input.gray[0].width, height: input.gray[0].height, f: focalPx, k1 };
}
