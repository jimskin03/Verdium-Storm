#!/usr/bin/env node
/**
 * Visual review harness.
 *
 * Boots the game in headless Chromium (SwiftShader), drives the camera through
 * named shot presets and writes PNGs to shots/<label>/. Reviewers read those
 * PNGs directly, so framing must stay stable between runs — that is what makes
 * an iteration-over-iteration comparison meaningful.
 *
 *   node tools/shoot.mjs --label baseline
 *   node tools/shoot.mjs --shots overview,base --width 2560 --height 1440
 *   node tools/shoot.mjs --url http://localhost:5173 --quality ultra
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePage } from './png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = findChrome();

function findChrome() {
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    process.env.CHROME_PATH,
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

function parseArgs(argv) {
  const args = {
    label: 'latest',
    shots: null,
    width: 1920,
    height: 1080,
    quality: 'ultra',
    url: null,
    warmup: 40,
    settle: 12,
    timeout: 180000,
    tod: null,
    keep: false,
    dist: 'dist',
    fog: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    if (key === 'keep') { args.keep = true; continue; }
    if (key === 'fog') { args.fog = true; continue; }
    if (next === undefined) continue;
    i++;
    if (['width', 'height', 'warmup', 'settle', 'timeout'].includes(key)) args[key] = Number(next);
    else if (key === 'tod') args.tod = Number(next);
    else if (key === 'shots') args.shots = next.split(',').map((s) => s.trim()).filter(Boolean);
    else args[key] = next;
  }
  return args;
}

async function startPreview(distDir) {
  const distIndex = path.join(ROOT, distDir, 'index.html');
  if (!existsSync(distIndex)) {
    throw new Error(`${distDir}/index.html not found — run \`npm run build\` first`);
  }
  const port = 4173 + Math.floor(Math.random() * 500);
  const child = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port),
    '--strictPort', '--outDir', distDir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite preview did not start in time')), 40000);
    const onData = (buf) => {
      const text = String(buf);
      const match = text.match(/https?:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`vite preview exited with code ${code}`)));
  });
  return { child, url };
}

// Keep this list minimal. `--disable-frame-rate-limit` and a raised V8 heap
// both destabilise the SwiftShader path in this container and crash the tab
// mid-capture; the flags below are the verified-good set.
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

const launchBrowser = () =>
  chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });

function attachLogging(page, sink) {
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const text = msg.text();
      if (!/DevTools|favicon\.ico|404 \(Not Found\)/.test(text)) sink.push(`[${msg.type()}] ${text}`);
    }
  });
  page.on('pageerror', (err) => sink.push(`[pageerror] ${err.message}`));
}

/** Replaces a crashed tab with a fresh one booted to the same target. */
async function recoverPage(dead, browser, args, target, sink) {
  try { await dead.close({ runBeforeUnload: false }); } catch { /* already gone */ }
  if (!browser.isConnected()) {
    try { await browser.close(); } catch { /* already gone */ }
    browser = await launchBrowser();
  }
  try {
    const page = await browser.newPage({
      viewport: { width: args.width, height: args.height },
      deviceScaleFactor: 1,
    });
    attachLogging(page, sink);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: args.timeout });
    await page.waitForFunction(() => window.VS?.ready === true, null, { timeout: args.timeout });
    await page.waitForTimeout(2000);
    return { browser, page };
  } catch {
    return { browser, page: null };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  let server = null;
  let baseUrl = args.url;

  if (!baseUrl) {
    server = await startPreview(args.dist);
    baseUrl = server.url;
  }

  const outDir = path.join(ROOT, 'shots', args.label);
  if (!args.keep) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  let browser = await launchBrowser();

  const consoleErrors = [];
  let page = await browser.newPage({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1,
  });
  attachLogging(page, consoleErrors);

  const target = `${baseUrl}/?quality=${args.quality}&dpr=1&harness=1`;
  process.stdout.write(`→ loading ${target}\n`);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: args.timeout });

  await page.waitForFunction(() => window.VS?.ready === true, null, { timeout: args.timeout });
  process.stdout.write('→ engine ready\n');

  // Fog of war would otherwise cover most of every shot in opaque shroud.
  if (!args.fog) {
    const off = await page.evaluate(() => window.VS.setFogOfWar?.(false) ?? false);
    process.stdout.write(off ? '→ fog of war disabled for review\n' : '→ fog of war not available\n');
  }

  // Let one-time GPU work (shader compiles, texture uploads) finish before the
  // timed warmups, otherwise the first preset absorbs all of it.
  await page.waitForTimeout(2500);

  const presets = args.shots ?? (await page.evaluate(() => window.VS.presets));
  const report = { label: args.label, url: target, width: args.width, height: args.height, shots: [], errors: [] };

  // Each shot is isolated. Software rasterisation makes some framings — a
  // ground-level camera with parallax occlusion filling the screen — expensive
  // enough to take the tab down, and losing every other shot to that would make
  // the harness useless exactly when the scene gets interesting.
  for (const name of presets) {
    const file = path.join(outDir, `${name}.png`);
    try {
      const ok = await page.evaluate((n) => window.VS.setPreset(n), name);
      if (!ok) {
        process.stdout.write(`  ! unknown preset "${name}"\n`);
        continue;
      }
      if (args.tod !== null) await page.evaluate((t) => window.VS.setTimeOfDay(t), args.tod);

      // Warm up with real animation frames so wind, water and particles are
      // alive, then hold the camera still so temporal effects converge.
      await page.waitForTimeout(Math.max(400, args.warmup * 16));
      await page.evaluate((n) => {
        window.VS.freeze();
        window.VS.step(n);
      }, args.settle);

      const shot = await capturePage(page);
      await writeFile(file, shot.buffer);
      const stats = await page.evaluate(() => window.VS.stats());
      await page.evaluate(() => window.VS.thaw());
      report.shots.push({ name, file: path.relative(ROOT, file), stats });
      process.stdout.write(`  ✓ ${name}  ${stats.fps}fps  ${stats.drawCalls} calls  ${stats.triangles} tris\n`);
    } catch (err) {
      const reason = String(err?.message ?? err).split('\n')[0];
      process.stdout.write(`  ✗ ${name} — ${reason}\n`);
      report.shots.push({ name, failed: reason });
      ({ browser, page } = await recoverPage(page, browser, args, target, consoleErrors));
      if (!page) {
        process.stdout.write('  ! could not recover the page; stopping early\n');
        break;
      }
    }
    // Persist after every shot so a later failure cannot discard earlier work.
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  }

  report.errors = consoleErrors.slice(0, 40);
  report.systems = page ? await page.evaluate(() => window.VS.systems()).catch(() => []) : [];
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  try { await browser.close(); } catch { /* already gone */ }
  if (server) server.child.kill('SIGTERM');

  if (consoleErrors.length) {
    process.stdout.write(`\n⚠ ${consoleErrors.length} console error(s):\n`);
    for (const e of consoleErrors.slice(0, 12)) process.stdout.write(`   ${e}\n`);
  }
  process.stdout.write(`\n✓ shots written to shots/${args.label}/\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
