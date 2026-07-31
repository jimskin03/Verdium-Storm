import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const ROOT = '/home/user/Verdium-Storm';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const dist = process.argv[2] ?? 'dist-post';

const port = 4900 + Math.floor(Math.random() * 90);
const child = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port),
  '--strictPort', '--outDir', dist], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('no preview')), 40000);
  const on = (b) => { const m = String(b).match(/https?:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(t); resolve(m[0]); } };
  child.stdout.on('data', on); child.stderr.on('data', on);
});

const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('console', (m) => {
  const t = m.text();
  if (/Shader Error|ERROR:|WARNING:|postfx/i.test(t)) process.stdout.write(`\n===== ${m.type()} =====\n${t}\n`);
});
page.on('pageerror', (e) => process.stdout.write(`\n[pageerror] ${e.message}\n${e.stack}\n`));

await page.goto(`${url}/?quality=high&dpr=1&harness=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.VS?.ready === true, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(4000);
await browser.close();
child.kill('SIGTERM');
