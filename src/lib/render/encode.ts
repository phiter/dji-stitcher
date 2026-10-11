import type { Surface } from './renderer';

export type ExportFormat = 'jpeg' | 'png';

export async function surfaceToBlob(surface: Surface, format: ExportFormat, quality = 0.95): Promise<Blob> {
  const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  if (typeof OffscreenCanvas !== 'undefined' && surface instanceof OffscreenCanvas) {
    return surface.convertToBlob({ type, quality });
  }
  const canvas = surface as HTMLCanvasElement;
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode the image.'))), type, quality);
  });
}

export interface PanoXmpInfo {
  width: number;
  height: number;
  software: string;
}

function buildXmpSegment(info: PanoXmpInfo): Uint8Array<ArrayBuffer> {
  const xml =
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/">` +
    `<GPano:UsePanoramaViewer>True</GPano:UsePanoramaViewer>` +
    `<GPano:ProjectionType>equirectangular</GPano:ProjectionType>` +
    `<GPano:CroppedAreaImageWidthPixels>${info.width}</GPano:CroppedAreaImageWidthPixels>` +
    `<GPano:CroppedAreaImageHeightPixels>${info.height}</GPano:CroppedAreaImageHeightPixels>` +
    `<GPano:FullPanoWidthPixels>${info.width}</GPano:FullPanoWidthPixels>` +
    `<GPano:FullPanoHeightPixels>${info.height}</GPano:FullPanoHeightPixels>` +
    `<GPano:CroppedAreaLeftPixels>0</GPano:CroppedAreaLeftPixels>` +
    `<GPano:CroppedAreaTopPixels>0</GPano:CroppedAreaTopPixels>` +
    `<GPano:PoseHeadingDegrees>0</GPano:PoseHeadingDegrees>` +
    `<GPano:StitchingSoftware>${info.software}</GPano:StitchingSoftware>` +
    `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const header = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
  const body = new TextEncoder().encode(xml);
  const length = 2 + header.length + body.length;
  const seg = new Uint8Array(new ArrayBuffer(2 + length));
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = length >> 8;
  seg[3] = length & 0xff;
  seg.set(header, 4);
  seg.set(body, 4 + header.length);
  return seg;
}

/** Inserts Google photo-sphere XMP so viewers and photo services treat the JPEG as a 360 panorama. */
export async function addPanoramaXmp(jpeg: Blob, info: PanoXmpInfo): Promise<Blob> {
  const head = new Uint8Array(await jpeg.slice(0, 32).arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8) return jpeg;
  let insertAt = 2;
  // Keep the JFIF header first when present.
  if (head[2] === 0xff && head[3] === 0xe0) insertAt = 4 + ((head[4] << 8) | head[5]);
  return new Blob([jpeg.slice(0, insertAt), buildXmpSegment(info), jpeg.slice(insertAt)], { type: 'image/jpeg' });
}
