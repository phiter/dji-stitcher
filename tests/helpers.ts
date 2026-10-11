import fs from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';
import type { AlignInput } from '../src/lib/align/types';

export const DATA_ROOT = path.resolve(__dirname, '../PANORAMAS');

export function datasetDir(name = process.env.DATASET ?? '100_0997'): string {
  return path.join(DATA_ROOT, name);
}

export function listPhotos(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^DJI_\d+\.JPG$/i.test(f))
    .sort();
}

/** Loads a dataset the same way the browser worker does: grayscale for features, small RGB for exposure. */
export async function loadAlignInput(dir: string, limit?: number): Promise<{ input: AlignInput; names: string[] }> {
  const names = listPhotos(dir).slice(0, limit);
  const gray: AlignInput['gray'] = [];
  const thumbs: AlignInput['thumbs'] = [];
  const priors: AlignInput['priors'] = [];
  let focal35mm: number | null = null;
  for (const name of names) {
    const file = path.join(dir, name);
    const buf = fs.readFileSync(file);
    const tags = await exifr.parse(buf, { xmp: true, mergeOutput: true });
    priors.push({ yaw: tags.GimbalYawDegree, pitch: tags.GimbalPitchDegree, roll: tags.GimbalRollDegree ?? 0 });
    focal35mm = tags.FocalLengthIn35mmFormat ?? focal35mm;
    const g = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    gray.push({ width: g.info.width, height: g.info.height, data: new Uint8Array(g.data) });
    const t = await sharp(buf).resize(400, 300, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    thumbs.push({ width: t.info.width, height: t.info.height, data: new Uint8Array(t.data) });
  }
  return { input: { gray, thumbs, priors, focal35mm }, names };
}
