#!/usr/bin/env node
/**
 * HUD review harness.
 *
 * `tools/shoot.mjs` reads the WebGL drawing buffer directly, which is the right
 * call for judging the render but means the DOM overlay never appears in a
 * shot. This one composites: it drives the same presets, then takes a real
 * `page.screenshot()` so the interface is captured over the frame it sits on.
 *
 * Under SwiftShader a composited screenshot can take 30 s or more while the
 * render loop is busy, so every capture freezes the loop first, shoots, and
 * thaws afterwards. Timeouts are generous for the same reason.
 *
 *   node tools/shoot-ui.mjs
 *   node tools/shoot-ui.mjs --shots base,battle --width 2560 --height 1440
 *   node tools/shoot-ui.mjs --scenes menu,hud --label pass2
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

const CHROME = findChrome();

// Same verified-good flag set as tools/shoot.mjs; anything more destabilises
// the SwiftShader path in this container.
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

/** Scenes are HUD states; shots are camera presets. Both are selectable. */
const DEFAULT_SHOTS = ['base', 'battle', 'overview'];
const DEFAULT_SCENES = ['hud', 'menu', 'paused'];

function parseArgs(argv) {
  const args = {
    label: 'ui',
    shots: DEFAULT_SHOTS,
    scenes: DEFAULT_SCENES,
    width: 1920,
    height: 1080,
    quality: 'high',
    url: null,
    dist: 'dist-ui',
    warmup: 55,
    settle: 10,
    timeout: 180000,
    fog: false,
    keep: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'keep') { args.keep = true; continue; }
    if (key === 'fog') { args.fog = true; continue; }
    const next = argv[++i];
    if (next === undefined) continue;
    if (['width', 'height', 'warmup', 'settle', 'timeout'].includes(key)) args[key] = Number(next);
    else if (key === 'shots' || key === 'scenes') args[key] = next.split(',').map((s) => s.trim()).filter(Boolean);
    else args[key] = next;
  }
  return args;
}

async function startPreview(distDir) {
  if (!existsSync(path.join(ROOT, distDir, 'index.html'))) {
    throw new Error(`${distDir}/index.html not found — run \`npx vite build --outDir ${distDir}\` first`);
  }
  const port = 5200 + Math.floor(Math.random() * 400);
  const child = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port),
    '--strictPort', '--outDir', distDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite preview did not start in time')), 40000);
    const onData = (buf) => {
      const m = String(buf).match(/https?:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`vite preview exited with code ${code}`)));
  });
  return { child, url };
}

/**
 * Freeze → screenshot → thaw.
 *
 * The freeze is what makes this usable: with the rAF loop running, the
 * compositor never gets a quiet moment on the software rasteriser and the
 * screenshot either takes minutes or times out.
 */
async function capture(page, file) {
  await page.evaluate(() => window.VS.freeze());
  try {
    const buffer = await page.screenshot({ type: 'png', timeout: 120000, animations: 'disabled' });
    await writeFile(file, buffer);
    return buffer.length;
  } finally {
    await page.evaluate(() => window.VS.thaw());
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

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
  const page = await browser.newPage({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1,
  });

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      const t = m.text();
      if (!/DevTools|favicon\.ico|404 \(Not Found\)/.test(t)) errors.push(`[${m.type()}] ${t}`);
    }
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

  const target = `${baseUrl}/?quality=${args.quality}&dpr=1&harness=1`;
  process.stdout.write(`→ loading ${target}\n`);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: args.timeout });
  await page.waitForFunction(() => window.VS?.ready === true, null, { timeout: args.timeout });
  await page.waitForFunction(() => typeof window.VSHUD?.phase === 'function', null, { timeout: args.timeout })
    .catch(() => process.stdout.write('  ! window.VSHUD never appeared — the HUD system may have faulted\n'));
  process.stdout.write('→ engine ready\n');

  // The world behind the HUD has to be visible for the composite to be worth
  // judging; fog of war would otherwise shroud most of it.
  if (!args.fog) {
    const off = await page.evaluate(() => window.VS.setFogOfWar?.(false) ?? false);
    process.stdout.write(off ? '→ fog of war disabled\n' : '→ fog of war not available\n');
  }

  await page.waitForTimeout(3000);

  const report = { label: args.label, url: target, width: args.width, height: args.height, shots: [] };
  const faultedAt = async (when) => {
    const f = await page.evaluate(() => window.VS.faulted?.() ?? []);
    if (f.length) process.stdout.write(`  ! faulted after ${when}: ${f.join(', ')}\n`);
    return f;
  };

  const shoot = async (name, prepare) => {
    const file = path.join(outDir, `${name}.png`);
    try {
      await prepare();
      await page.waitForTimeout(Math.max(500, args.warmup * 16));
      await page.evaluate((n) => {
        window.VS.freeze();
        window.VS.step(n);
        window.VS.thaw();
      }, args.settle);
      const bytes = await capture(page, file);
      const stats = await page.evaluate(() => window.VS.stats());
      report.shots.push({ name, file: path.relative(ROOT, file), bytes, stats });
      process.stdout.write(`  ✓ ${name}  ${(bytes / 1024).toFixed(0)} kB  ${stats.drawCalls} calls\n`);
    } catch (err) {
      const reason = String(err?.message ?? err).split('\n')[0];
      report.shots.push({ name, failed: reason });
      process.stdout.write(`  ✗ ${name} — ${reason}\n`);
    }
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  };

  // 1. The HUD over each camera preset.
  if (args.scenes.includes('hud')) {
    for (const preset of args.shots) {
      await shoot(`hud-${preset}`, async () => {
        await page.evaluate((n) => window.VS.setPreset(n), preset);
        await page.evaluate(() => window.VSHUD?.deploy?.());
        await page.evaluate(() => window.VSHUD?.sync?.());
      });
    }
  }

  // 2. Front end and 3. pause overlay.
  if (args.scenes.includes('menu')) {
    await shoot('menu', async () => {
      await page.evaluate(() => window.VS.setPreset('base'));
      await page.evaluate(() => window.VSHUD?.menu?.());
    });
    await shoot('menu-nod', async () => {
      await page.evaluate(() => window.VSHUD?.setFaction?.('nod'));
    });
    await page.evaluate(() => window.VSHUD?.setFaction?.('gdi'));
  }
  if (args.scenes.includes('paused')) {
    await shoot('paused', async () => {
      await page.evaluate(() => window.VS.setPreset('battle'));
      await page.evaluate(() => window.VSHUD?.deploy?.());
      await page.evaluate(() => window.VSHUD?.setPaused?.(true));
    });
    await page.evaluate(() => window.VSHUD?.setPaused?.(false));
  }

  report.faulted = await faultedAt('captures');
  report.usingMock = await page.evaluate(() => window.VSHUD?.usingMock?.() ?? null);
  report.errors = errors.slice(0, 40);
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  await browser.close();
  if (server) server.child.kill('SIGTERM');

  if (errors.length) {
    process.stdout.write(`\n⚠ ${errors.length} console message(s):\n`);
    for (const e of errors.slice(0, 12)) process.stdout.write(`   ${e.slice(0, 220)}\n`);
  }
  process.stdout.write(`\n✓ composited shots written to shots/${args.label}/  (mock=${report.usingMock})\n`);
  if (report.faulted?.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
