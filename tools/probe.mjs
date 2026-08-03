#!/usr/bin/env node
/**
 * Pixel probe.
 *
 * Boots the game like `shoot.mjs` does, then — instead of writing a whole PNG —
 * runs a list of *conditions* and reports the mean sRGB value of a few small
 * pixel patches for each one. A condition is a snippet of JS evaluated in the
 * page before the frame is stepped, so uniforms, lights and debug modes can be
 * toggled live without a rebuild.
 *
 * That makes "which term is blue?" a numeric question answerable in one run,
 * which is the only way to make progress on a colour defect under a software
 * rasteriser that takes ~20 s per frame.
 *
 *   node tools/probe.mjs --dist dist --shot overview \
 *     --patch valley:820,760,40,40 --patch slope:1310,520,40,40 \
 *     --case baseline: --case nofog:'VS.sky.uFogA.value.set(0,1,0,1)'
 *
 * Patch geometry is `name:x,y,w,h` in image pixels from the top-left.
 * Conditions are `name:javascript`; the JS is evaluated with `VS` in scope and
 * may return a value, which is printed alongside the samples.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findChrome() {
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    process.env.CHROME_PATH,
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--mute-audio',
];

function parseArgs(argv) {
  const args = {
    dist: 'dist', shot: 'overview', width: 1920, height: 1080, quality: 'ultra',
    settle: 8, timeout: 240000, patches: [], cases: [], tod: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[++i];
    if (next === undefined) continue;
    if (key === 'patch') {
      const [name, rect] = splitOnce(next, ':');
      const [x, y, w, h] = rect.split(',').map(Number);
      args.patches.push({ name, x, y, w, h });
    } else if (key === 'case') {
      const [name, js] = splitOnce(next, ':');
      args.cases.push({ name, js });
    } else if (key === 'casefile') {
      const [name, file] = splitOnce(next, ':');
      args.cases.push({ name, js: readFileSync(file, 'utf8') });
    } else if (['width', 'height', 'settle', 'timeout'].includes(key)) {
      args[key] = Number(next);
    } else if (key === 'tod') {
      args.tod = Number(next);
    } else {
      args[key] = next;
    }
  }
  if (!args.patches.length) args.patches.push({ name: 'valley', x: 920, y: 800, w: 40, h: 40 });
  if (!args.cases.length) args.cases.push({ name: 'baseline', js: '' });
  return args;
}

function splitOnce(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

async function startPreview(distDir) {
  if (!existsSync(path.join(ROOT, distDir, 'index.html'))) {
    throw new Error(`${distDir}/index.html not found — build first`);
  }
  // Random port: a previous run's preview may still be shutting down.
  const port = 4700 + Math.floor(Math.random() * 900);
  const child = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port),
    '--strictPort', '--outDir', distDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite preview did not start')), 40000);
    const onData = (buf) => {
      const m = String(buf).match(/https?:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (c) => reject(new Error(`vite preview exited ${c}`)));
  });
  return { child, url };
}

/** Mean RGB of each patch, read straight out of the drawing buffer. */
const SAMPLE = (patches) => {
  const gl = window.VS.engine.renderer.getContext();
  const H = gl.drawingBufferHeight;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const out = {};
  for (const p of patches) {
    const buf = new Uint8Array(p.w * p.h * 4);
    gl.readPixels(p.x, H - p.y - p.h, p.w, p.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < buf.length; i += 4) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
    const n = buf.length / 4;
    out[p.name] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }
  return out;
};

async function main() {
  const args = parseArgs(process.argv);
  const server = await startPreview(args.dist);
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: CHROME_ARGS });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: args.width, height: args.height }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e.message)));

  const target = `${server.url}/?quality=${args.quality}&dpr=1&harness=1`;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: args.timeout });
  await page.waitForFunction(() => window.VS?.ready === true, null, { timeout: args.timeout });
  await page.evaluate(() => window.VS.setFogOfWar?.(false));
  await page.waitForTimeout(2500);
  await page.evaluate((n) => window.VS.setPreset(n), args.shot);
  if (args.tod !== null) await page.evaluate((t) => window.VS.setTimeOfDay(t), args.tod);
  await page.waitForTimeout(900);

  process.stdout.write(`shot=${args.shot} dist=${args.dist}\n`);
  const results = [];
  for (const c of args.cases) {
    let ret = null;
    try {
      ret = await page.evaluate((js) => {
        const VS = window.VS;
        // eslint-disable-next-line no-new-func
        const r = js ? new Function('VS', js)(VS) : null;
        return r === undefined ? null : r;
      }, c.js);
    } catch (e) {
      process.stdout.write(`  ! ${c.name} eval failed: ${String(e.message).split('\n')[0]}\n`);
    }
    await page.evaluate((n) => { window.VS.freeze(); window.VS.step(n); }, args.settle);
    const s = await page.evaluate(SAMPLE, args.patches);
    await page.evaluate(() => window.VS.thaw());
    results.push({ name: c.name, samples: s, ret });
    const cells = Object.entries(s)
      .map(([k, v]) => `${k}=rgb(${v[0]},${v[1]},${v[2]}) R-B=${v[0] - v[2]}`)
      .join('  ');
    process.stdout.write(`  ${c.name.padEnd(18)} ${cells}${ret !== null ? '  ret=' + JSON.stringify(ret) : ''}\n`);
  }

  const faulted = await page.evaluate(() => window.VS.faulted());
  process.stdout.write(`faulted=${JSON.stringify(faulted)}\n`);
  if (errors.length) process.stdout.write(`errors:\n  ${errors.slice(0, 8).join('\n  ')}\n`);
  process.stdout.write(`JSON ${JSON.stringify(results)}\n`);

  await browser.close();
  server.child.kill('SIGTERM');
}

main().catch((e) => { console.error(e); process.exit(1); });
