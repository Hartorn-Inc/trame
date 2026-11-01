/**
 * ============================================================================
 * GENERATED E2E FIXTURES: BATTLEMAP PNG & UNIVERSAL VTT BUNDLE (fixtures.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Builds the binary inputs the browser suite uploads (a background PNG and a
 * `.uvtt` map bundle) in memory, so the repository carries no binary test
 * assets and every run imports byte-identical files.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Valid PNG Stream`:
 *    - Signature + IHDR + one zlib-compressed IDAT + IEND, each chunk with its
 *      CRC-32, so the server's magic-byte check and image decoder accept it.
 * 2. `Grid-Aligned Map`:
 *    - The UVTT image is `cols * pixelsPerGrid` by `rows * pixelsPerGrid`
 *      pixels, matching `resolution.map_size`, so imported wall coordinates
 *      (grid units) land on the drawn grid lines.
 * ============================================================================
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGB color, each channel in `0..=255`. */
type Rgb = [number, number, number];

/**
 * Encodes a `width` x `height` RGB PNG: a stone-floor checkerboard of
 * `cellPx` squares with darker grid lines.
 */
export function gridPng(width: number, height: number, cellPx: number, light: Rgb, dark: Rgb): Buffer {
  const line: Rgb = [40, 36, 32];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const onLine = x % cellPx === 0 || y % cellPx === 0;
      const checker = (Math.floor(x / cellPx) + Math.floor(y / cellPx)) % 2 === 0;
      const [r, g, b] = onLine ? line : checker ? light : dark;
      const px = row + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Grid size of the generated UVTT map, in cells. */
export const UVTT_COLS = 12;
export const UVTT_ROWS = 10;
/** Pixels per grid cell of the generated UVTT map (`px`). */
export const UVTT_PPG = 70;

/**
 * Universal VTT bundle: a 12x10 grid crypt with one wall run along the east
 * side (column 10), one closed door portal, and one torch light.
 */
export function uvttBundle(): Buffer {
  const image = gridPng(UVTT_COLS * UVTT_PPG, UVTT_ROWS * UVTT_PPG, UVTT_PPG, [168, 160, 148], [150, 142, 130]);
  const doc = {
    format: 0.3,
    resolution: {
      map_origin: { x: 0, y: 0 },
      map_size: { x: UVTT_COLS, y: UVTT_ROWS },
      pixels_per_grid: UVTT_PPG,
    },
    line_of_sight: [
      [
        { x: 10, y: 0 },
        { x: 10, y: 4 },
      ],
      [
        { x: 10, y: 6 },
        { x: 10, y: 10 },
      ],
    ],
    portals: [
      {
        position: { x: 10, y: 5 },
        bounds: [
          { x: 10, y: 4 },
          { x: 10, y: 6 },
        ],
        rotation: 0,
        closed: true,
        freestanding: false,
      },
    ],
    lights: [{ position: { x: 3, y: 3 }, range: 6, color: 'ffd28a', intensity: 1, shadows: true }],
    image: image.toString('base64'),
  };
  return Buffer.from(JSON.stringify(doc));
}

/** Background image uploaded over the imported scene (warmer palette, same size). */
export function backgroundPng(): Buffer {
  return gridPng(UVTT_COLS * UVTT_PPG, UVTT_ROWS * UVTT_PPG, UVTT_PPG, [120, 140, 110], [100, 122, 92]);
}
