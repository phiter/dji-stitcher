export interface EdgeFill {
  /** RGBA texels, `width` for the top edge followed by `width` for the bottom edge. */
  columns: Float32Array;
  width: number;
  zenith: [number, number, number];
  nadir: [number, number, number];
}

type Rgb = [number, number, number];

interface Side {
  /** Boundary row of the covered area per column, -1 when the column has no coverage. */
  row: Int32Array;
  /** Colour just inside the covered area, smoothed around the circle (-1 where unknown). */
  color: Float32Array;
  mean: Rgb;
}

function scanSide(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number, fromTop: boolean): Side {
  const step = fromTop ? 1 : -1;
  const row = new Int32Array(W).fill(-1);
  const raw = new Float32Array(W * 3);
  for (let x = 0; x < W; x++) {
    for (let k = 0; k < H - 4; k++) {
      const y = fromTop ? k : H - 1 - k;
      let covered = true;
      for (let d = 0; d < 4 && covered; d++) covered = rgba[((y + d * step) * W + x) * 4 + 3] > 0;
      if (!covered) continue;
      row[x] = y;
      let n = 0;
      for (let d = 2; d < 10; d++) {
        const yy = y + d * step;
        if (yy < 0 || yy >= H) break;
        n++;
        for (let c = 0; c < 3; c++) raw[x * 3 + c] += rgba[(yy * W + x) * 4 + c] / 255;
      }
      for (let c = 0; c < 3; c++) raw[x * 3 + c] /= Math.max(1, n);
      break;
    }
  }

  // Smooth the edge colours around the circle so the fill has no vertical stripes.
  const radius = Math.round(W * 0.02);
  const color = new Float32Array(W * 3);
  const mean: Rgb = [0, 0, 0];
  for (let x = 0; x < W; x++) {
    let n = 0;
    const acc = [0, 0, 0];
    for (let d = -radius; d <= radius; d++) {
      const xx = (x + d + W) % W;
      if (row[xx] < 0) continue;
      n++;
      for (let c = 0; c < 3; c++) acc[c] += raw[xx * 3 + c];
    }
    for (let c = 0; c < 3; c++) {
      color[x * 3 + c] = n ? acc[c] / n : -1;
      if (n) mean[c] += color[x * 3 + c] / W;
    }
  }
  return { row, color, mean };
}

/**
 * Reads a low resolution render (RGBA, alpha 0 = not covered) and derives, for the top and the bottom edge of
 * the covered area, each column's edge colour and latitude so uncovered sky/ground can be extended smoothly.
 */
export function computeEdgeFill(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number): EdgeFill | null {
  const top = scanSide(rgba, W, H, true);
  if (top.row.filter((r) => r >= 0).length < W * 0.5) return null;
  const bottom = scanSide(rgba, W, H, false);

  const columns = new Float32Array(W * 8);
  for (let x = 0; x < W; x++) {
    // Be inclusive: use the most generous boundary of the neighbouring columns so no sliver stays empty.
    let topRow = -1;
    let bottomRow = H;
    for (let d = -2; d <= 2; d++) {
      const xx = (x + d + W) % W;
      if (top.row[xx] >= 0) topRow = Math.max(topRow, top.row[xx]);
      if (bottom.row[xx] >= 0) bottomRow = Math.min(bottomRow, bottom.row[xx]);
    }
    const topLat = topRow < 0 ? -Math.PI / 2 : (0.5 - (topRow + 1.5) / H) * Math.PI;
    const bottomLat = bottomRow >= H ? -Math.PI / 2 : (0.5 - (bottomRow - 0.5) / H) * Math.PI;
    for (let c = 0; c < 3; c++) {
      columns[x * 4 + c] = top.color[x * 3] < 0 ? top.mean[c] : top.color[x * 3 + c];
      columns[(W + x) * 4 + c] = bottom.color[x * 3] < 0 ? bottom.mean[c] : bottom.color[x * 3 + c];
    }
    columns[x * 4 + 3] = topLat;
    columns[(W + x) * 4 + 3] = bottomLat;
  }
  return { columns, width: W, zenith: top.mean, nadir: bottom.mean };
}
