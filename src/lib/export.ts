import type { ExportFormat } from './render/encode';
import { addPanoramaXmp, surfaceToBlob } from './render/encode';
import type { Projection } from './render/renderer';
import type { SizeOption } from './sizes';
import type { StitchSession } from './stitch';

export interface ExportStatus {
  label: string;
  fraction: number;
}

export interface ExportRequest {
  size: SizeOption;
  projection: Projection;
  format: ExportFormat;
  fillSky: boolean;
}

/** Renders the image at full quality and encodes it. */
export async function exportImage(
  session: StitchSession,
  { size, projection, format, fillSky }: ExportRequest,
  onStatus: (s: ExportStatus) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const surface = await session.renderer.render({
    width: size.width,
    height: size.height,
    projection,
    fillSky,
    signal,
    onProgress: (done, total) => onStatus({ label: 'Rendering', fraction: (done / total) * 0.85 }),
  });
  onStatus({ label: 'Encoding image', fraction: 0.88 });
  await new Promise((r) => setTimeout(r, 0));
  const blob = await surfaceToBlob(surface, format, 0.95);
  // Only equirectangular panoramas are tagged for 360 viewers.
  if (format !== 'jpeg' || projection.kind !== 'equirect') return blob;
  return addPanoramaXmp(blob, { width: size.width, height: size.height, software: 'Drone Pano Stitcher' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
