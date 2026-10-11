/// <reference lib="webworker" />
import { alignPhotos } from '../lib/align/align';
import type { AlignInput, AlignResult, Euler } from '../lib/align/types';

export interface AlignRequest {
  files: File[];
  priors: Euler[];
  focal35mm: number | null;
  focalHintRel: number | null;
}

export type AlignMessage =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'done'; result: AlignResult }
  | { type: 'error'; message: string };

const ALIGN_WIDTH = 2000;
const THUMB_WIDTH = 400;

async function loadInput(req: AlignRequest, post: (m: AlignMessage) => void): Promise<AlignInput> {
  const gray: AlignInput['gray'] = [];
  const thumbs: AlignInput['thumbs'] = [];
  let gw = 0;
  let gh = 0;
  let tw = 0;
  let th = 0;
  for (let i = 0; i < req.files.length; i++) {
    post({ type: 'progress', stage: 'Reading photos', fraction: i / req.files.length });
    const bmp = await createImageBitmap(req.files[i]);
    if (i === 0) {
      gw = Math.min(ALIGN_WIDTH, bmp.width);
      gh = Math.round((bmp.height * gw) / bmp.width);
      tw = THUMB_WIDTH;
      th = Math.round((bmp.height * tw) / bmp.width);
    }
    const draw = (w: number, h: number) => {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const g = draw(gw, gh);
    const gdata = new Uint8Array(gw * gh);
    for (let p = 0; p < gdata.length; p++) {
      gdata[p] = (g[p * 4] * 77 + g[p * 4 + 1] * 150 + g[p * 4 + 2] * 29) >> 8;
    }
    gray.push({ width: gw, height: gh, data: gdata });
    const t = draw(tw, th);
    const tdata = new Uint8Array(tw * th * 3);
    for (let p = 0; p < tw * th; p++) {
      tdata[p * 3] = t[p * 4];
      tdata[p * 3 + 1] = t[p * 4 + 1];
      tdata[p * 3 + 2] = t[p * 4 + 2];
    }
    thumbs.push({ width: tw, height: th, data: tdata });
    bmp.close();
  }
  return { gray, thumbs, priors: req.priors, focal35mm: req.focal35mm, focalHintRel: req.focalHintRel };
}

self.onmessage = async (event: MessageEvent<AlignRequest>) => {
  const post = (m: AlignMessage) => self.postMessage(m);
  try {
    const input = await loadInput(event.data, post);
    const result = await alignPhotos(input, (stage, fraction) => post({ type: 'progress', stage, fraction }));
    post({ type: 'done', result });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
