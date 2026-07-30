#!/usr/bin/env node
/**
 * Builds side-by-side comparison sheets from captured shots.
 *
 * Compositing is done by rendering an HTML page in the same headless Chromium
 * the capture harness uses, which avoids pulling in an image library for what
 * is fundamentally a layout problem.
 *
 *   node tools/compare.mjs --a baseline --b latest            # A/B every shot
 *   node tools/compare.mjs --a baseline --b latest --blind    # hide which is which
 *   node tools/compare.mjs --sheet latest                     # contact sheet of one run
 */
import { chromium } from 'playwright-core';
import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function parseArgs(argv) {
  const args = { a: null, b: null, sheet: null, out: null, blind: false, width: 2400 };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'blind') { args.blind = true; continue; }
    const next = argv[++i];
    if (next === undefined) continue;
    args[key] = key === 'width' ? Number(next) : next;
  }
  return args;
}

const asDataUri = async (file) => `data:image/png;base64,${(await readFile(file)).toString('base64')}`;

async function shotsIn(label) {
  const dir = path.join(ROOT, 'shots', label);
  if (!existsSync(dir)) throw new Error(`no shots at shots/${label}`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
  return files.map((f) => ({ name: path.basename(f, '.png'), file: path.join(dir, f) }));
}

async function render(html, width, height, outFile) {
  const browser = await chromium.launch({
    executablePath: existsSync(CHROME) ? CHROME : undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb'],
  });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: outFile, fullPage: true });
  await browser.close();
}

const PAGE_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0c0e11; font-family:ui-sans-serif,system-ui,sans-serif; color:#dfe6ee; padding:20px; }
  h2 { font-size:19px; letter-spacing:.14em; text-transform:uppercase; color:#8fa6bd; margin:26px 0 10px; font-weight:600; }
  h2:first-child { margin-top:0; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:8px; }
  .cell { position:relative; border:1px solid #232a33; border-radius:4px; overflow:hidden; background:#000; }
  .cell img { display:block; width:100%; height:auto; }
  .tag { position:absolute; top:9px; left:9px; background:rgba(6,9,13,.86); color:#cfe0f2;
         font-size:13px; font-weight:700; letter-spacing:.1em; padding:4px 11px; border-radius:3px; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
`;

async function buildAB(args) {
  const a = await shotsIn(args.a);
  const b = await shotsIn(args.b);
  const names = [...new Set([...a.map((s) => s.name), ...b.map((s) => s.name)])].sort();

  const sections = [];
  for (const name of names) {
    const fa = a.find((s) => s.name === name);
    const fb = b.find((s) => s.name === name);
    if (!fa || !fb) continue;
    // In blind mode the left/right order flips per shot from a hash of the name,
    // so a reviewer cannot learn "left is always the new one".
    const flip = args.blind && [...name].reduce((h, c) => h + c.charCodeAt(0), 0) % 2 === 1;
    const [first, second] = flip ? [fb, fa] : [fa, fb];
    const [ta, tb] = args.blind ? ['A', 'B'] : flip ? [args.b, args.a] : [args.a, args.b];
    sections.push(`<h2>${name}</h2><div class="row">
      <div class="cell"><span class="tag">${ta}</span><img src="${await asDataUri(first.file)}"></div>
      <div class="cell"><span class="tag">${tb}</span><img src="${await asDataUri(second.file)}"></div>
    </div>`);
    if (args.blind) {
      sections.push(`<!-- key ${name}: A=${flip ? args.b : args.a} B=${flip ? args.a : args.b} -->`);
    }
  }

  const outName = args.out ?? `compare-${args.a}-vs-${args.b}${args.blind ? '-blind' : ''}`;
  const outDir = path.join(ROOT, 'shots', '_compare');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${outName}.png`);

  await render(
    `<style>${PAGE_CSS}</style>${sections.join('\n')}`,
    args.width,
    Math.round(args.width * 0.4),
    outFile,
  );

  if (args.blind) {
    const key = names.map((n) => {
      const flip = [...n].reduce((h, c) => h + c.charCodeAt(0), 0) % 2 === 1;
      return `${n}: A=${flip ? args.b : args.a}  B=${flip ? args.a : args.b}`;
    });
    await writeFile(path.join(outDir, `${outName}.key.txt`), key.join('\n'));
  }
  process.stdout.write(`✓ ${path.relative(ROOT, outFile)}\n`);
}

async function buildSheet(args) {
  const shots = await shotsIn(args.sheet);
  const cells = [];
  for (const s of shots) {
    cells.push(`<div class="cell"><span class="tag">${s.name}</span><img src="${await asDataUri(s.file)}"></div>`);
  }
  const outDir = path.join(ROOT, 'shots', '_compare');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `sheet-${args.sheet}.png`);
  await render(
    `<style>${PAGE_CSS}</style><h2>${args.sheet}</h2><div class="grid">${cells.join('\n')}</div>`,
    args.width,
    Math.round(args.width * 0.6),
    outFile,
  );
  process.stdout.write(`✓ ${path.relative(ROOT, outFile)}\n`);
}

const args = parseArgs(process.argv);
if (args.sheet) await buildSheet(args);
else if (args.a && args.b) await buildAB(args);
else {
  process.stderr.write('usage: compare.mjs --a <label> --b <label> [--blind] | --sheet <label>\n');
  process.exit(1);
}
