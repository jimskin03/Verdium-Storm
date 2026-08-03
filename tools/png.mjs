/**
 * Minimal PNG encoder.
 *
 * The obvious capture path — canvas.toDataURL('image/png') — costs 34-50
 * seconds per frame under SwiftShader, because the PNG encode runs on the
 * software rasteriser's readback path. gl.readPixels costs ~140ms for the same
 * frame, so we pull raw RGBA out of the GL context and deflate it here instead.
 * Node's zlib is doing the only expensive part, and it is doing it natively.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const forCrc = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(forCrc), data.length + 8);
  return out;
}

/**
 * @param {Uint8Array} rgba  Tightly packed RGBA rows.
 * @param {number} width
 * @param {number} height
 * @param {boolean} flipY    True for gl.readPixels output, which is bottom-up.
 * @returns {Buffer} PNG file bytes.
 */
export function encodePng(rgba, width, height, flipY = true) {
  const stride = width * 4;
  // One filter byte per scanline; filter 0 (None) keeps the CPU cost here at
  // essentially a memcpy and lets zlib do the actual work.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = (flipY ? height - 1 - y : y) * stride;
    const dst = y * (stride + 1);
    raw[dst] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + src, stride).copy(raw, dst + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Reads the drawing buffer into a page-side staging buffer.
 *
 * The pixels come back to node in bands rather than one payload: at 1080p the
 * frame is 8.3 MB, and base64-encoding that in one go builds ~30 MB of
 * intermediate JavaScript strings, which is enough to OOM the tab partway
 * through a multi-shot run.
 */
const BEGIN_CAPTURE = () => {
  const gl = window.VS.engine.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  window.__vsCapture = buf;
  return { w, h, bytes: buf.length };
};

const READ_BAND = ([offset, length]) => {
  const buf = window.__vsCapture;
  const end = Math.min(offset + length, buf.length);
  let s = '';
  const CH = 0x8000;
  for (let i = offset; i < end; i += CH) {
    s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + CH, end)));
  }
  return btoa(s);
};

const END_CAPTURE = () => {
  delete window.__vsCapture;
};

/** Captures the current frame from a Playwright page and returns PNG bytes. */
export async function capturePage(page) {
  const { w, h, bytes } = await page.evaluate(BEGIN_CAPTURE);
  const BAND = 1 << 20; // 1 MB of pixels per hop
  const parts = [];
  for (let offset = 0; offset < bytes; offset += BAND) {
    const b64 = await page.evaluate(READ_BAND, [offset, BAND]);
    parts.push(Buffer.from(b64, 'base64'));
  }
  await page.evaluate(END_CAPTURE);
  return { buffer: encodePng(Buffer.concat(parts), w, h, true), width: w, height: h };
}
