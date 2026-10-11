import exifr from 'exifr';

export interface PhotoMeta {
  id: string;
  file: File;
  name: string;
  /** Gimbal heading in degrees, clockwise from north. */
  yaw: number;
  /** Gimbal pitch in degrees, positive looking up. */
  pitch: number;
  roll: number;
  focal35mm: number | null;
  /** Calibrated focal length divided by image width (newer DJI models record it in pixels). */
  focalRel: number | null;
  /** Pixel size from EXIF, if present. */
  width: number | null;
  height: number | null;
  exposureTime: number | null;
  iso: number | null;
  model: string | null;
}

export interface RejectedFile {
  name: string;
  reason: string;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export async function readPhotoMeta(file: File, index: number): Promise<PhotoMeta | RejectedFile> {
  if (!/\.jpe?g$/i.test(file.name)) return { name: file.name, reason: 'Not a JPEG file' };
  let tags: Record<string, unknown> | undefined;
  try {
    tags = await exifr.parse(file, { xmp: true, mergeOutput: true });
  } catch {
    return { name: file.name, reason: 'Could not read metadata' };
  }
  const yaw = num(tags?.GimbalYawDegree);
  const pitch = num(tags?.GimbalPitchDegree);
  if (yaw === null || pitch === null) {
    return { name: file.name, reason: 'No DJI gimbal angles (already stitched or not a drone photo)' };
  }
  const width = num(tags?.ExifImageWidth);
  const calibrated = num(tags?.CalibratedFocalLength);
  // Plausible horizontal field of view: 40 to 120 degrees.
  const rel = calibrated && width ? calibrated / width : null;
  return {
    id: `${index}-${file.name}-${file.size}`,
    file,
    name: file.name,
    yaw,
    pitch,
    roll: num(tags?.GimbalRollDegree) ?? 0,
    focal35mm: num(tags?.FocalLengthIn35mmFormat),
    focalRel: rel !== null && rel > 0.29 && rel < 1.37 ? rel : null,
    width,
    height: num(tags?.ExifImageHeight),
    exposureTime: num(tags?.ExposureTime),
    iso: num(tags?.ISO),
    model: typeof tags?.Model === 'string' ? tags.Model : null,
  };
}

export const isRejected = (r: PhotoMeta | RejectedFile): r is RejectedFile => 'reason' in r;

export async function readAllMeta(files: File[]): Promise<{ photos: PhotoMeta[]; rejected: RejectedFile[] }> {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const results = await Promise.all(sorted.map((f, i) => readPhotoMeta(f, i)));
  const photos: PhotoMeta[] = [];
  const rejected: RejectedFile[] = [];
  for (const r of results) {
    if (isRejected(r)) rejected.push(r);
    else photos.push(r);
  }
  return { photos, rejected };
}
