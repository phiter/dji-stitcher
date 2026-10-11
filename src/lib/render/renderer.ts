import type { AlignResult } from '../align/types';
import { computeEdgeFill, type EdgeFill } from './skyfill';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shaders';

const TILE = 1024;
const PROBE_WIDTH = 1024;

// Blend sharpness for the four frequency bands, finest first.
const BAND_POWERS: [number, number, number, number] = [24, 8, 3, 1];

export type TileProgress = (done: number, total: number) => void;
export type Surface = OffscreenCanvas | HTMLCanvasElement;

/** Equirectangular panorama, or a little planet (stereographic view of the ground with the sky around it). */
export type Projection =
  | { kind: 'equirect' }
  | {
      kind: 'planet';
      /** Angle from straight down (degrees) reached at the middle of the shorter image edge. */
      fov: number;
      /** Extra heading in degrees that is turned to the top of the image. */
      rotation: number;
    };

export interface RenderOptions {
  /** Output size in pixels. The height of an equirectangular panorama defaults to width / 2. */
  width: number;
  height?: number;
  projection?: Projection;
  /** Extend the sky above and the ground below the photos instead of leaving them empty. Default true. */
  fillSky?: boolean;
  onProgress?: TileProgress;
  signal?: AbortSignal;
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

const UNIFORMS = [
  'uTex', 'uPose', 'uCount', 'uFull', 'uTile', 'uCenterLon', 'uF', 'uK1', 'uTexSize', 'uVig', 'uBandPow',
  'uFill', 'uFillOn', 'uFillCols', 'uZenith', 'uNadir', 'uMode', 'uPlanetScale', 'uPlanetRot',
] as const;

/** GPU stitcher: uploads all photos once, then renders the panorama tile by tile. */
export class PanoRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private photoTex: WebGLTexture;
  private poseTex: WebGLTexture;
  private fillTex: WebGLTexture;
  private fill: EdgeFill | null = null;
  private uniforms = {} as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private count: number;
  private texW: number;
  private texH: number;
  private canvas: Surface;
  private pixels = new Uint8ClampedArray(TILE * TILE * 4);
  // Renders share one GL context and its uniforms, so they run one at a time.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    bitmaps: ImageBitmap[],
    private alignment: AlignResult,
    private centerLon: number,
  ) {
    this.count = bitmaps.length;
    this.texW = bitmaps[0].width;
    this.texH = bitmaps[0].height;
    this.canvas = createSurface(TILE, TILE);
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL 2 is not available in this browser.');
    this.gl = gl;

    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Shader link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    for (const name of UNIFORMS) this.uniforms[name] = gl.getUniformLocation(program, name);

    this.photoTex = this.uploadPhotos(bitmaps);
    this.poseTex = this.uploadPoses();
    this.fillTex = this.createFillTexture(new Float32Array(PROBE_WIDTH * 8));
  }

  private uploadPhotos(bitmaps: ImageBitmap[]): WebGLTexture {
    const gl = this.gl;
    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (bitmaps.length > maxLayers || Math.max(this.texW, this.texH) > maxSize) {
      throw new Error('This GPU cannot hold the photos as textures.');
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    const levels = Math.floor(Math.log2(Math.max(this.texW, this.texH))) + 1;
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, this.texW, this.texH, bitmaps.length);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    bitmaps.forEach((bmp, i) => {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, this.texW, this.texH, 1, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    });
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private createDataTexture(width: number, height: number, data: Float32Array): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  }

  private uploadPoses(): WebGLTexture {
    const data = new Float32Array(4 * 4 * this.count);
    this.alignment.rotations.forEach((R, i) => {
      const o = i * 16;
      // Rows of the world->camera rotation (the transpose of camera->world).
      data.set([R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0], o);
      data.set([...this.alignment.gains[i], 0], o + 12);
    });
    return this.createDataTexture(4, this.count, data);
  }

  private createFillTexture(columns: Float32Array): WebGLTexture {
    return this.createDataTexture(columns.length / 8, 2, columns);
  }

  private bindFrame(W: number, H: number, fillOn: boolean, projection: Projection = { kind: 'equirect' }): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.photoTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.poseTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fillTex);
    const u = this.uniforms;
    gl.uniform1i(u.uTex, 0);
    gl.uniform1i(u.uPose, 1);
    gl.uniform1i(u.uFill, 2);
    gl.uniform1i(u.uCount, this.count);
    gl.uniform2f(u.uFull, W, H);
    gl.uniform1f(u.uCenterLon, this.centerLon);
    gl.uniform1f(u.uF, this.alignment.focalRel * this.texW);
    gl.uniform1f(u.uK1, this.alignment.k1);
    gl.uniform2f(u.uTexSize, this.texW, this.texH);
    gl.uniform2f(u.uVig, this.alignment.vignette[0], this.alignment.vignette[1]);
    gl.uniform4f(u.uBandPow, ...BAND_POWERS);
    const useFill = fillOn && !!this.fill;
    gl.uniform1i(u.uFillOn, useFill ? 1 : 0);
    gl.uniform1i(u.uFillCols, PROBE_WIDTH);
    const z = this.fill?.zenith ?? [0, 0, 0];
    const n = this.fill?.nadir ?? [0, 0, 0];
    gl.uniform3f(u.uZenith, z[0], z[1], z[2]);
    gl.uniform3f(u.uNadir, n[0], n[1], n[2]);
    if (projection.kind === 'planet') {
      gl.uniform1i(u.uMode, 1);
      gl.uniform1f(u.uPlanetScale, Math.min(W, H) / 2 / Math.tan((projection.fov * Math.PI) / 360));
      gl.uniform1f(u.uPlanetRot, (projection.rotation * Math.PI) / 180);
    } else {
      gl.uniform1i(u.uMode, 0);
    }
  }

  /** Renders one tile and returns its pixels (rows top to bottom). */
  private drawTile(x0: number, y0: number, tw: number, th: number): Uint8ClampedArray {
    const gl = this.gl;
    gl.viewport(0, 0, tw, th);
    gl.uniform2f(this.uniforms.uTile, x0, y0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    return this.pixels;
  }

  /** Measures where the photos end at the top and bottom so the missing sky and ground can be filled in. Call once before rendering. */
  prepare(): void {
    const W = PROBE_WIDTH;
    const H = PROBE_WIDTH / 2;
    this.bindFrame(W, H, false);
    const pixels = this.drawTile(0, 0, W, H);
    this.fill = computeEdgeFill(pixels, W, H);
    if (this.fill) {
      this.gl.deleteTexture(this.fillTex);
      this.fillTex = this.createFillTexture(this.fill.columns);
    }
  }

  /** Renders the output image and returns it as a canvas. */
  render(options: RenderOptions): Promise<Surface> {
    const run = this.queue.then(() => this.renderNow(options));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async renderNow({ width, height, projection, fillSky = true, onProgress, signal }: RenderOptions): Promise<Surface> {
    const gl = this.gl;
    const W = Math.round(width);
    const H = Math.round(height ?? width / 2);
    if (signal?.aborted) throw new DOMException('Rendering cancelled', 'AbortError');
    const out = createSurface(W, H);
    const ctx = out.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Could not allocate an image of this size. Try a smaller output size.');

    this.bindFrame(W, H, fillSky, projection);
    const cols = Math.ceil(W / TILE);
    const rows = Math.ceil(H / TILE);
    const total = cols * rows;
    let done = 0;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        if (signal?.aborted) throw new DOMException('Rendering cancelled', 'AbortError');
        if (gl.isContextLost()) throw new Error('The graphics context was lost. Please try again.');
        const x0 = tx * TILE;
        const y0 = ty * TILE;
        const tw = Math.min(TILE, W - x0);
        const th = Math.min(TILE, H - y0);
        const pixels = this.drawTile(x0, y0, tw, th);
        ctx.putImageData(new ImageData(pixels.slice(0, tw * th * 4), tw, th), x0, y0);
        onProgress?.(++done, total);
        await yieldToBrowser();
      }
    }
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.photoTex);
    gl.deleteTexture(this.poseTex);
    gl.deleteTexture(this.fillTex);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
