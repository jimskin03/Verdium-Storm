#!/usr/bin/env node
/**
 * Integration check for the combined build.
 *
 * Each workstream verifies itself against its own isolated build, so the place
 * things actually break is where they meet: two systems both claiming the
 * render hook, a system that assumes a service that initialised after it, a
 * post chain that leaves the frame in an offscreen target. This boots the real
 * build and asserts the invariants that catch those.
 *
 *   node tools/verify.mjs
 *   node tools/verify.mjs --dist dist --quality high
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const args = { dist: 'dist', quality: 'high', url: null };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  const next = process.argv[++i];
  if (next !== undefined) args[key] = next;
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  process.stdout.write(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

async function startPreview(distDir) {
  if (!existsSync(path.join(ROOT, distDir, 'index.html'))) {
    throw new Error(`${distDir}/index.html not found — run \`npm run build\` first`);
  }
  const port = 4700 + Math.floor(Math.random() * 300);
  const child = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port),
    '--strictPort', '--outDir', distDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview did not start')), 40000);
    const onData = (b) => {
      const m = String(b).match(/https?:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (c) => reject(new Error(`preview exited ${c}`)));
  });
  return { child, url };
}

/**
 * Frame statistics computed in-page from the canvas, so we can detect a broken
 * render (all black, all one colour, NaN-white) without decoding PNGs here.
 */
const FRAME_STATS = () => {
  const src = window.VS.engine.renderer.domElement;
  const w = 480;
  const h = Math.round((src.height / src.width) * w);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;

  let sum = 0, sumSq = 0, n = 0, black = 0, white = 0;
  const hist = new Array(16).fill(0);
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    lum[p] = l;
    sum += l; sumSq += l * l; n++;
    if (l < 0.012) black++;
    if (l > 0.988) white++;
    hist[Math.min(15, (l * 16) | 0)]++;
  }
  const mean = sum / n;
  const stdev = Math.sqrt(Math.max(0, sumSq / n - mean * mean));

  // Mean absolute gradient — a proxy for how much detail is in the frame.
  let edge = 0, edgeN = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      edge += Math.abs(lum[p] - lum[p + 1]) + Math.abs(lum[p] - lum[p + w]);
      edgeN += 2;
    }
  }
  // Occupied histogram buckets: a healthy frame uses most of the range.
  const buckets = hist.filter((v) => v > n * 0.002).length;
  return {
    mean: +mean.toFixed(4),
    stdev: +stdev.toFixed(4),
    blackFrac: +(black / n).toFixed(4),
    whiteFrac: +(white / n).toFixed(4),
    edge: +(edge / edgeN).toFixed(5),
    buckets,
  };
};

async function main() {
  const server = args.url ? null : await startPreview(args.dist);
  const baseUrl = args.url ?? server.url;

  const browser = await chromium.launch({
    executablePath: existsSync(CHROME) ? CHROME : undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
           '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb',
           '--hide-scrollbars', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon\.ico|404 \(Not Found\)/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  process.stdout.write(`→ ${baseUrl} (quality=${args.quality})\n`);
  let booted = true;
  try {
    await page.goto(`${baseUrl}/?quality=${args.quality}&dpr=1&harness=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => window.VS?.ready === true, null, { timeout: 120000 });
  } catch {
    booted = false;
  }
  check('engine boots and exposes the harness', booted);

  if (booted) {
    await page.waitForTimeout(3000);

    const systems = await page.evaluate(() => window.VS.systems());
    check('systems registered', systems.length >= 3, `${systems.length}: ${systems.join(', ')}`);

    const stats = await page.evaluate(() => window.VS.stats());
    check('scene draws geometry', stats.drawCalls > 0, `${stats.drawCalls} calls, ${stats.triangles} tris`);

    // Step deterministically, then measure — this is also what the capture path
    // does, so a failure here means captures are unreliable too.
    await page.evaluate(() => { window.VS.freeze(); window.VS.step(20); });
    const frame = await page.evaluate(FRAME_STATS);
    await page.evaluate(() => window.VS.thaw());

    check('frame is not black', frame.blackFrac < 0.6, `${(frame.blackFrac * 100).toFixed(1)}% black, mean ${frame.mean}`);
    check('frame is not blown out', frame.whiteFrac < 0.35, `${(frame.whiteFrac * 100).toFixed(1)}% white`);
    check('frame has tonal range', frame.stdev > 0.05 && frame.buckets >= 5, `stdev ${frame.stdev}, ${frame.buckets}/16 buckets`);
    check('frame has detail', frame.edge > 0.004, `edge energy ${frame.edge}`);

    // A second capture after further stepping catches temporal instability
    // (a TAA history that diverges, particles that never settle).
    await page.evaluate(() => { window.VS.freeze(); window.VS.step(20); });
    const frame2 = await page.evaluate(FRAME_STATS);
    await page.evaluate(() => window.VS.thaw());
    check('frame is temporally stable', Math.abs(frame2.mean - frame.mean) < 0.06,
      `mean ${frame.mean} → ${frame2.mean}`);

    // Resize must not throw or blank the frame; render targets have to follow.
    await page.setViewportSize({ width: 900, height: 600 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => { window.VS.freeze(); window.VS.step(12); });
    const resized = await page.evaluate(FRAME_STATS);
    await page.evaluate(() => window.VS.thaw());
    check('survives resize', resized.blackFrac < 0.6, `${(resized.blackFrac * 100).toFixed(1)}% black after resize`);

    process.stdout.write(`\n  frame: ${JSON.stringify(frame)}\n`);
  }

  check('no console errors', errors.length === 0, errors.length ? `${errors.length}` : 'clean');
  for (const e of errors.slice(0, 10)) process.stdout.write(`      ${e.slice(0, 200)}\n`);

  await browser.close();
  if (server) server.child.kill('SIGTERM');

  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n${failed.length ? `✗ ${failed.length} check(s) failed` : '✓ all checks passed'}\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
