/**
 * ============================================================================
 * SCREENSHOT PIXEL PROBES (support/pixels.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Decodes Playwright element screenshots (8-bit, non-interlaced RGB/RGBA PNG)
 * and measures mean luminance over rectangles, so the spec can assert what
 * the WebGL table actually drew (darkness, lights, fog) instead of trusting
 * the DOM. The WebGL drawing buffer is not readable after compositing, so
 * the composited screenshot is the only reliable pixel source.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Canvas Pixel Space`:
 *    - Contexts run at `deviceScaleFactor` 1, so one screenshot pixel is one
 *      board pixel and rectangles use board coordinates (`px`).
 * 2. `Fail Loudly On Unsupported PNGs`:
 *    - Palette, 16-bit, or interlaced images throw instead of returning
 *      garbage luminance.
 * ============================================================================
 */
import { inflateSync } from 'node:zlib';

/** Decoded RGBA image, 4 bytes per pixel, row-major. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Axis-aligned probe rectangle in board pixels. */
export interface ProbeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes an 8-bit RGB (type 2) or RGBA (type 6) PNG into RGBA pixels. */
export function decodePng(png: Buffer): RgbaImage {
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colorType, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG (depth ${depth}, color type ${colorType}, interlace ${interlace})`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? rows[dst + i - channels] : 0;
      const b = y > 0 ? rows[dst - stride + i] : 0;
      const c = y > 0 && i >= channels ? rows[dst - stride + i - channels] : 0;
      const x = raw[src + i];
      rows[dst + i] = (filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    data[p * 4] = rows[p * channels];
    data[p * 4 + 1] = rows[p * channels + 1];
    data[p * 4 + 2] = rows[p * channels + 2];
    data[p * 4 + 3] = channels === 4 ? rows[p * channels + 3] : 255;
  }
  return { width, height, data };
}

/** Mean Rec. 601 luma (`0..=255`) over `rect`, clipped to the image. */
export function meanLuma(img: RgbaImage, rect: ProbeRect): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, rect.y); y < Math.min(img.height, rect.y + rect.h); y++) {
    for (let x = Math.max(0, rect.x); x < Math.min(img.width, rect.x + rect.w); x++) {
      const i = (y * img.width + x) * 4;
      sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      n++;
    }
  }
  if (n === 0) throw new Error(`probe ${JSON.stringify(rect)} is outside the ${img.width}x${img.height} image`);
  return Math.round(sum / n);
}
