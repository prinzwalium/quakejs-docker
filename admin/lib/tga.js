'use strict';
// Converts small TGA images (the player model icons) to PNG, using only Node built-ins.
// Supports true-color TGA, uncompressed (type 2) and RLE (type 10), 24 or 32 bit.

const zlib = require('zlib');

const MAX_PIXELS = 512 * 512;

function decodeTga(buf) {
  if (buf.length < 18) throw new Error('not a TGA file');
  const idLen = buf[0];
  const colorMapType = buf[1];
  const type = buf[2];
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const bpp = buf[16];
  const desc = buf[17];
  if (colorMapType !== 0 || (type !== 2 && type !== 10)) throw new Error('unsupported TGA type');
  if (bpp !== 24 && bpp !== 32) throw new Error('unsupported TGA depth');
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('unsupported TGA size');
  const bytes = bpp / 8;
  const count = width * height;
  const rgba = Buffer.alloc(count * 4);
  let src = 18 + idLen;
  let px = 0;

  const put = (at) => {
    if (at + bytes > buf.length) throw new Error('truncated TGA');
    const o = px * 4;
    rgba[o] = buf[at + 2];
    rgba[o + 1] = buf[at + 1];
    rgba[o + 2] = buf[at];
    rgba[o + 3] = bytes === 4 ? buf[at + 3] : 255;
    px++;
  };

  if (type === 2) {
    while (px < count) { put(src); src += bytes; }
  } else {
    while (px < count) {
      if (src >= buf.length) throw new Error('truncated TGA');
      const header = buf[src++];
      const n = (header & 0x7f) + 1;
      if (px + n > count) throw new Error('corrupt TGA');
      if (header & 0x80) {
        for (let i = 0; i < n; i++) put(src);
        src += bytes;
      } else {
        for (let i = 0; i < n; i++) { put(src); src += bytes; }
      }
    }
  }

  // TGA rows are stored bottom-up unless bit 5 of the descriptor is set.
  if (!(desc & 0x20)) {
    const row = width * 4;
    const tmp = Buffer.alloc(row);
    for (let y = 0; y < height >> 1; y++) {
      const a = y * row;
      const b = (height - 1 - y) * row;
      rgba.copy(tmp, 0, a, a + row);
      rgba.copy(rgba, a, b, b + row);
      tmp.copy(rgba, b);
    }
  }
  return { width, height, rgba };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function tgaToPng(buf) {
  return encodePng(decodeTga(buf));
}

module.exports = { tgaToPng, decodeTga, encodePng };
