/** Largest long edge browsers can reliably encode. */
export const MAX_OUTPUT_WIDTH = 16384;
/** Largest output area we try to allocate (a 16K x 8K panorama). */
export const MAX_OUTPUT_PIXELS = 16384 * 8192;

export type Aspect = '1:1' | '16:9' | '9:16';
export const ASPECTS: Aspect[] = ['1:1', '16:9', '9:16'];
const RATIO: Record<Aspect, number> = { '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16 };

export interface SizeOption {
  /** 'max' for the maximum detail entry, otherwise the dimensions. */
  key: string;
  width: number;
  height: number;
  label: string;
}

export interface Optics {
  focalPx: number;
  photoWidth: number;
  photoHeight: number;
}

/** Mean angular pixel density (pixels per radian) across a photo; the edges are denser than the centre. */
export function sourceDensity({ focalPx: f, photoWidth: w, photoHeight: h }: Optics): number {
  return f * (1 + (w * w + h * h) / (12 * f * f));
}

const round8 = (v: number) => Math.max(8, Math.round(v / 8) * 8);

/** Equirectangular sizes; "maximum detail" matches the source pixel density. */
export function panoramaSizes(optics: Optics): SizeOption[] {
  const max = Math.min(MAX_OUTPUT_WIDTH, Math.round((2 * Math.PI * sourceDensity(optics)) / 16) * 16);
  const presets = [
    { width: 4096, label: '4K' },
    { width: 8192, label: '8K' },
    { width: 16384, label: '16K (upscaled)' },
  ].filter((s) => Math.abs(s.width - max) / max > 0.08);
  return [...presets.map((s) => ({ ...s, key: String(s.width) })), { width: max, label: 'Maximum detail', key: 'max' }]
    .sort((a, b) => a.width - b.width)
    .map((s) => ({ ...s, height: s.width / 2 }));
}

const PLANET_PRESETS: { short: number; label: string }[] = [
  { short: 1080, label: 'Full HD' },
  { short: 2160, label: '4K' },
  { short: 4320, label: '8K' },
];

/**
 * Little planet sizes for an aspect ratio and field of view. "Maximum detail" keeps the average photo detail
 * over the ground hemisphere, limited by what a browser canvas can hold.
 */
export function planetSizes(optics: Optics, aspect: Aspect, fovDeg: number): SizeOption[] {
  const ratio = RATIO[aspect];
  const longK = Math.max(ratio, 1 / ratio);
  const portrait = ratio < 1;
  const dims = (short: number) => {
    const long = Math.round(short * longK);
    return portrait ? { width: short, height: long } : { width: long, height: short };
  };

  // Stereographic scale s (px per radian at the horizon ring) that equals the ground detail of the photos.
  const s = Math.SQRT2 * sourceDensity(optics);
  const uncapped = 2 * s * Math.tan((fovDeg * Math.PI) / 360);
  const cap = Math.min(MAX_OUTPUT_WIDTH / longK, Math.sqrt(MAX_OUTPUT_PIXELS / longK));
  const maxShort = round8(Math.min(uncapped, cap));

  const presets = PLANET_PRESETS.filter((p) => p.short < maxShort * 0.9).map((p) => ({
    ...dims(p.short),
    key: `${dims(p.short).width}x${dims(p.short).height}`,
    label: aspect === '1:1' ? '' : p.label,
  }));
  return [...presets, { ...dims(maxShort), key: 'max', label: 'Maximum detail' }];
}
