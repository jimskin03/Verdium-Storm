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
 * Reads the drawing buffer out of the page as raw RGBA. Runs in page context.
 * Returns a plain array because Playwright cannot structured-clone a typed
 * array across the bridge.
 */
export const READ_PIXELS = () => {
  const gl = window.VS.engine.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  // Base64 over the bridge is dramatically faster than a 8M-element JSON array.
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  }
  return { w, h, b64: btoa(s) };
};

/** Captures the current frame from a Playwright page and writes a PNG buffer. */
export async function capturePage(page) {
  const { w, h, b64 } = await page.evaluate(READ_PIXELS);
  return { buffer: encodePng(Buffer.from(b64, 'base64'), w, h, true), width: w, height: h };
}
