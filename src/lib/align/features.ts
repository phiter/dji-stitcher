import * as cvModule from '@techstark/opencv-js';
import type { GrayImage } from './types';

type CV = typeof cvModule;

export interface Features {
  count: number;
  /** x, y pairs in image pixels. */
  xy: Float32Array;
  /** 256-bit ORB descriptors packed as 8 uint32 words each. */
  desc: Uint32Array;
}

let cvPromise: Promise<CV> | undefined;

/** Loads OpenCV.js once (works in browsers, workers and Node). */
export function loadCv(): Promise<CV> {
  cvPromise ??= (async () => {
    // The package exports a promise (or a module that finishes initialising later).
    let cv: any = (cvModule as any).default ?? cvModule;
    if (cv instanceof Promise) cv = await cv;
    else if (!cv.Mat) await new Promise<void>((resolve) => { cv.onRuntimeInitialized = () => resolve(); });
    return cv as CV;
  })();
  return cvPromise;
}

/** Brightens dark frames so corner detection also works on night photos. */
function normalizeForDetection(img: GrayImage): Uint8Array {
  const { data } = img;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  // Stretch between the 1st and 99.7th percentile, then apply a gamma lift for dark scenes.
  const total = data.length;
  let acc = 0;
  let lo = 0;
  while (lo < 255 && acc + hist[lo] < total * 0.01) acc += hist[lo++];
  acc = 0;
  let hi = 255;
  while (hi > lo + 1 && acc + hist[hi] < total * 0.003) acc += hist[hi--];
  const span = Math.max(32, hi - lo);
  let mean = 0;
  for (let v = 0; v < 256; v++) mean += v * hist[v];
  mean /= total;
  const gamma = mean < 70 ? 0.55 : mean < 110 ? 0.75 : 1;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - lo) / span));
    lut[v] = Math.round(255 * Math.pow(t, gamma));
  }
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = lut[data[i]];
  return out;
}

export function detectFeatures(cv: CV, img: GrayImage, maxFeatures = 5000): Features {
  const mat = new cv.Mat(img.height, img.width, cv.CV_8UC1);
  mat.data.set(normalizeForDetection(img));
  const orb = new cv.ORB(maxFeatures, 1.2, 8, 31, 0, 2, cv.ORB_HARRIS_SCORE, 31, 10);
  const kps = new cv.KeyPointVector();
  const desc = new cv.Mat();
  const mask = new cv.Mat();
  try {
    orb.detectAndCompute(mat, mask, kps, desc);
    const count = kps.size();
    const xy = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const pt = kps.get(i).pt;
      xy[i * 2] = pt.x;
      xy[i * 2 + 1] = pt.y;
    }
    const bytes = desc.data as Uint8Array;
    const packed = new Uint32Array(count * 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, count * 32);
    for (let i = 0; i < count * 8; i++) packed[i] = view.getUint32(i * 4, true);
    return { count, xy, desc: packed };
  } finally {
    mat.delete();
    orb.delete();
    kps.delete();
    desc.delete();
    mask.delete();
  }
}
