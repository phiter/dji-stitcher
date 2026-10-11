import type { AlignResult } from './align/types';
import type { PhotoMeta } from './metadata';
import { PanoRenderer, type Surface } from './render/renderer';
import { MAX_OUTPUT_WIDTH } from './sizes';
import type { AlignMessage, AlignRequest } from '../workers/align.worker';

export interface StitchSession {
  renderer: PanoRenderer;
  alignment: AlignResult;
  focalPx: number;
  photoWidth: number;
  photoHeight: number;
  preview: Surface;
}

export type StageProgress = (stage: string, overall: number) => void;

// [start, end] of the overall progress bar covered by each stage.
const STAGES: Record<string, [number, number]> = {
  'Reading photos': [0, 0.08],
  'Detecting features': [0.08, 0.4],
  'Aligning photos': [0.4, 0.72],
  'Balancing exposure': [0.72, 0.78],
  'Preparing GPU': [0.78, 0.82],
  'Rendering preview': [0.82, 1],
};

const PREVIEW_WIDTH = 4096;

function runAlignment(photos: PhotoMeta[], report: StageProgress): Promise<AlignResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/align.worker.ts', import.meta.url), { type: 'module' });
    const request: AlignRequest = {
      files: photos.map((p) => p.file),
      priors: photos.map((p) => ({ yaw: p.yaw, pitch: p.pitch, roll: p.roll })),
      focal35mm: photos.find((p) => p.focal35mm)?.focal35mm ?? null,
      focalHintRel: photos.find((p) => p.focalRel)?.focalRel ?? null,
    };
    worker.onmessage = (e: MessageEvent<AlignMessage>) => {
      const m = e.data;
      if (m.type === 'progress') {
        const [a, b] = STAGES[m.stage] ?? [0, 0];
        report(m.stage, a + (b - a) * m.fraction);
      } else if (m.type === 'done') {
        worker.terminate();
        resolve(m.result);
      } else {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The alignment worker crashed.'));
    };
    worker.postMessage(request);
  });
}

// Upper bound for the photo texture array (with mipmaps) so large sources do not exhaust GPU memory.
const MAX_TEXTURE_BYTES = 1.2e9;

async function decode(file: File, size?: { width: number; height: number }): Promise<ImageBitmap> {
  const resize: ImageBitmapOptions = size
    ? { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' }
    : {};
  try {
    return await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', ...resize });
  } catch {
    // Some browsers reject these decode options.
    return createImageBitmap(file, resize);
  }
}

/** Decodes photos at full resolution (capped by what the output can show and by GPU memory), all the same size. */
async function loadBitmaps(files: File[], focalRel: number): Promise<ImageBitmap[]> {
  const probe = await decode(files[0]);
  const full = { width: probe.width, height: probe.height };
  probe.close();
  // Photo pixels per radian at the centre must not exceed the densest panorama (with a little slack).
  const maxWidth = Math.floor((1.2 * MAX_OUTPUT_WIDTH) / (2 * Math.PI) / focalRel);
  let { width, height } = full;
  if (width > maxWidth) {
    height = Math.round((height * maxWidth) / width);
    width = maxWidth;
  }
  const bytes = width * height * 4 * 1.34 * files.length;
  if (bytes > MAX_TEXTURE_BYTES) {
    const scale = Math.sqrt(MAX_TEXTURE_BYTES / bytes);
    width = Math.floor(width * scale);
    height = Math.floor(height * scale);
  }
  const resized = width !== full.width || height !== full.height;
  const bitmaps: ImageBitmap[] = [];
  for (const file of files) {
    let bmp = await decode(file, resized ? { width, height } : undefined);
    if (bmp.width !== width || bmp.height !== height) {
      bmp.close();
      bmp = await decode(file, { width, height });
    }
    bitmaps.push(bmp);
  }
  return bitmaps;
}

/** Heading (radians) of the first roughly horizontal photo; it is shown in the middle of the panorama. */
function centerHeading(alignment: AlignResult): number {
  for (const R of alignment.rotations) {
    const fx = R[2];
    const fy = R[5];
    const fz = R[8];
    if (Math.abs(fz) < 0.7) return Math.atan2(fx, fy);
  }
  return 0;
}

export async function stitchPhotos(photos: PhotoMeta[], report: StageProgress): Promise<StitchSession> {
  report('Reading photos', 0);
  const alignment = await runAlignment(photos, report);

  report('Preparing GPU', 0);
  const bitmaps = await loadBitmaps(photos.map((p) => p.file), alignment.focalRel);
  const photoWidth = bitmaps[0].width;
  const photoHeight = bitmaps[0].height;
  const renderer = new PanoRenderer(bitmaps, alignment, centerHeading(alignment));
  bitmaps.forEach((b) => b.close());
  renderer.prepare();

  const [a, b] = STAGES['Rendering preview'];
  const preview = await renderer.render({
    width: PREVIEW_WIDTH,
    onProgress: (done, total) => report('Rendering preview', a + ((b - a) * done) / total),
  });
  return { renderer, alignment, focalPx: alignment.focalRel * photoWidth, photoWidth, photoHeight, preview };
}
