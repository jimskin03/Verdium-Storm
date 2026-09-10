#!/usr/bin/env node
/** Deterministic headless smoke runner for the guarded VS_AGENT bridge. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = { url: null, ticks: 180, pacing: 'deliberate' };
for (let i = 2; i < process.argv.length; i++) { const key = process.argv[i].replace(/^--/, ''); const value = process.argv[++i]; if (value !== undefined && key in args) args[key] = key === 'ticks' ? Number(value) : value; }
const chrome = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((candidate) => candidate && existsSync(candidate));

async function preview() {
  const outDir = existsSync(path.join(root, 'dist-agent')) ? 'dist-agent' : 'dist';
  const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort', '--outDir', outDir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent preview did not start within 30s')), 30_000);
    const ready = (chunk) => {
      const clean = String(chunk).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      const match = clean.match(/https?:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      } else if (clean.includes('127.0.0.1:4173') || clean.includes('localhost:4173')) {
        clearTimeout(timer);
        resolve('http://127.0.0.1:4173');
      }
    };
    child.stdout.on('data', ready);
    child.stderr.on('data', ready);
    child.on('exit', (code) => reject(new Error(`preview exited ${code}`)));
  });
  return { child, url };
}

let server;
try {
  server = args.url ? null : await preview();
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${args.url ?? server.url}/?agent=1&pacing=${args.pacing}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.VS_AGENT?.ready === true, null, { timeout: 120_000 });
  await page.evaluate(() => window.VS_AGENT.start());
  const before = await page.evaluate(() => window.VS_AGENT.observe());
  await page.evaluate((ticks) => window.VS_AGENT.step(ticks), args.ticks);
  const after = await page.evaluate(() => window.VS_AGENT.observe());
  const events = await page.evaluate(() => window.VS_AGENT.events(0, 20));
  if (after.tick <= before.tick) throw new Error(`simulation did not advance (${before.tick} -> ${after.tick})`);
  if (errors.length) throw new Error(errors.join('; '));
  process.stdout.write(JSON.stringify({ beforeTick: before.tick, afterTick: after.tick, own: after.own.length, visibleEnemies: after.visibleEnemies.length, events: events.map((event) => event.type) }, null, 2) + '\n');
  await browser.close();
} finally {
  if (server) server.child.kill('SIGTERM');
}
