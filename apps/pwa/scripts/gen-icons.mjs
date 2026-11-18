/**
 * Icon generator — no image libraries, no network, no design tool.
 *
 * Emits the PNG set a PWA needs to be installable on both platforms:
 *   icon-192.png, icon-512.png        ("any" — rounded corners)
 *   icon-maskable-512.png             (full-bleed, glyph inside the 80% safe zone)
 *   apple-touch-icon.png              (180px, opaque — iOS composites this on its own)
 *
 * The mark is a rounded-square gate with a dot: legible down to 32px.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "../public/icons");
mkdirSync(outDir, { recursive: true });

/* ---------- minimal PNG encoder (RGBA, 8-bit, no interlace) ---------- */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- geometry ---------- */

/** Signed distance to a rounded rectangle, in pixels. */
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Antialiased coverage from a signed distance (1px feather). */
const cover = (d) => Math.min(Math.max(0.5 - d, 0), 1);

const lerp = (a, b, t) => a + (b - a) * t;

/** indigo-600 -> violet-600 diagonal gradient */
function gradientAt(x, y, size) {
  const t = Math.min(Math.max((x / size + y / size) / 2, 0), 1);
  return [lerp(0x4f, 0x7c, t), lerp(0x46, 0x3a, t), lerp(0xe5, 0xed, t)];
}

/**
 * @param {number} size    canvas size in px
 * @param {object} opts
 * @param {number} opts.inset          fraction of size kept as outer margin
 * @param {number} opts.cornerRadius   outer corner radius as a fraction of size
 * @param {boolean} opts.opaque        fill the whole canvas (apple-touch / maskable)
 * @param {number} opts.glyphScale     glyph size relative to the icon box
 */
function renderIcon(size, { inset = 0, cornerRadius = 0.22, opaque = false, glyphScale = 1 }) {
  const px = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const boxHalf = half - inset * size;

  // Glyph geometry, centred.
  const outerHalf = boxHalf * 0.62 * glyphScale;
  const stroke = boxHalf * 0.145 * glyphScale;
  const dotR = boxHalf * 0.135 * glyphScale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;

      // Background: opaque full canvas, or a rounded square tile.
      const bgCover = opaque ? 1 : cover(sdRoundRect(cx, cy, half, half, boxHalf, boxHalf, cornerRadius * size * 0.5));
      const [r, g, b] = gradientAt(x, y, size);

      // Glyph: rounded-square ring + centre dot, composited on top.
      const dOuter = sdRoundRect(cx, cy, half, half, outerHalf, outerHalf, outerHalf * 0.42);
      const dInner = sdRoundRect(
        cx,
        cy,
        half,
        half,
        outerHalf - stroke,
        outerHalf - stroke,
        Math.max(outerHalf - stroke, 0) * 0.42,
      );
      const ring = Math.min(cover(dOuter), 1 - cover(dInner));
      const dot = cover(Math.hypot(cx - half, cy - half) - dotR);
      const glyphCover = Math.max(ring, dot);

      // White glyph over gradient.
      const ar = lerp(r, 255, glyphCover);
      const ag = lerp(g, 255, glyphCover);
      const ab = lerp(b, 255, glyphCover);
      const alpha = Math.max(bgCover, glyphCover * bgCover);

      const i = (y * size + x) * 4;
      // Un-premultiply so the white glyph keeps its brightness on the edge.
      const a = alpha === 0 ? 0 : alpha;
      px[i] = Math.round(a === 0 ? 0 : (ar * bgCover) / Math.max(a, 0.0001));
      px[i + 1] = Math.round(a === 0 ? 0 : (ag * bgCover) / Math.max(a, 0.0001));
      px[i + 2] = Math.round(a === 0 ? 0 : (ab * bgCover) / Math.max(a, 0.0001));
      px[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, px);
}

const outputs = [
  ["icon-192.png", renderIcon(192, {})],
  ["icon-512.png", renderIcon(512, {})],
  // Maskable: full bleed + glyph pulled into the central safe zone so Android
  // can crop to a circle, squircle or teardrop without clipping the mark.
  ["icon-maskable-512.png", renderIcon(512, { opaque: true, glyphScale: 0.72 })],
  // iOS applies its own mask and does not honour transparency.
  ["apple-touch-icon.png", renderIcon(180, { opaque: true, glyphScale: 0.86 })],
];

for (const [name, buffer] of outputs) {
  writeFileSync(join(outDir, name), buffer);
  console.log(`wrote ${name} (${buffer.length} bytes)`);
}

writeFileSync(
  join(outDir, "icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Portal">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4f46e5"/>
      <stop offset="1" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <rect x="151" y="151" width="210" height="210" rx="88" fill="none" stroke="#fff" stroke-width="46"/>
  <circle cx="256" cy="256" r="42" fill="#fff"/>
</svg>
`,
);
console.log("wrote icon.svg");
