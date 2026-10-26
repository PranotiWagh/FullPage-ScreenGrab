const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function generatePng(size) {
  const width = size;
  const height = size;

  // Raw image data with 1 byte filter (0) per row
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);

  const cx = width / 2;
  const cy = height / 2;
  const radius = width * 0.45;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter: None

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Camera blue gradient circle background
      if (dist <= radius) {
        // Check if inside camera body rectangle or lens
        const inRect = Math.abs(dx) <= width * 0.28 && Math.abs(dy - height * 0.04) <= height * 0.22;
        const inLens = Math.sqrt(dx * dx + (dy - height * 0.04) * (dy - height * 0.04)) <= width * 0.12;
        const inRim = Math.sqrt(dx * dx + (dy - height * 0.04) * (dy - height * 0.04)) <= width * 0.16;

        if (inLens) {
          // Lens center
          rawData[pxOffset] = 30;     // R
          rawData[pxOffset + 1] = 41;  // G
          rawData[pxOffset + 2] = 59;  // B
          rawData[pxOffset + 3] = 255; // A
        } else if (inRim) {
          // Lens rim (white)
          rawData[pxOffset] = 255;
          rawData[pxOffset + 1] = 255;
          rawData[pxOffset + 2] = 255;
          rawData[pxOffset + 3] = 255;
        } else if (inRect) {
          // Camera body (white/cyan)
          rawData[pxOffset] = 240;
          rawData[pxOffset + 1] = 249;
          rawData[pxOffset + 2] = 255;
          rawData[pxOffset + 3] = 255;
        } else {
          // Gradient background
          const t = (y / height);
          rawData[pxOffset] = Math.round(59 + t * 40);     // Indigo / blue
          rawData[pxOffset + 1] = Math.round(130 - t * 20);
          rawData[pxOffset + 2] = Math.round(246 - t * 20);
          rawData[pxOffset + 3] = 255;
        }
      } else {
        // Transparent outside
        rawData[pxOffset] = 0;
        rawData[pxOffset + 1] = 0;
        rawData[pxOffset + 2] = 0;
        rawData[pxOffset + 3] = 0;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(rawData);

  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = createChunk('IHDR', ihdr);
  const idatChunk = createChunk('IDAT', idat);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([pngHeader, ihdrChunk, idatChunk, iendChunk]);
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 48, 128].forEach(size => {
  const buffer = generatePng(size);
  fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), buffer);
  console.log(`Generated icon-${size}.png (${buffer.length} bytes)`);
});
