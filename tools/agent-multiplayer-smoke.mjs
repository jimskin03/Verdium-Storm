#!/usr/bin/env node
/** Two-browser, no-WebGL smoke test for the agent control plane and room server. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error('Chrome/Edge executable not found; set CHROME_PATH.');

function waitForOutput(child, pattern, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`process did not become ready: ${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += String(chunk);
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      resolve();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`process exited ${code}: ${output}`));
    });
  });
}

let multiplayer;
let preview;
let browser;
try {
  multiplayer = spawn(node, ['index.mjs'], {
    cwd: path.join(root, 'server'),
    env: {
      ...process.env,
      PORT: '8787',
      ALLOWED_ORIGINS: 'http://127.0.0.1:4174,http://localhost:4174',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForOutput(multiplayer, /listening on/);

  preview = spawn(node, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', '4174', '--strictPort', '--outDir', 'dist'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForOutput(preview, /127\.0\.0\.1:4174/);

  browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-webgl', '--disable-webgl2', '--mute-audio'],
  });
  const [hostContext, guestContext] = await Promise.all([browser.newContext(), browser.newContext()]);
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  const url = 'http://127.0.0.1:4174/?agent=1&render=none&pacing=deliberate';
  await Promise.all([hostPage.goto(url), guestPage.goto(url)]);
  await Promise.all([
    hostPage.waitForFunction(() => window.VS_AGENT?.ready === true),
    guestPage.waitForFunction(() => window.VS_AGENT?.ready === true),
  ]);

  const password = 'agent-passphrase';
  const host = await hostPage.evaluate((pass) => window.VS_AGENT.createRoom(pass), password);
  if (!host.roomCode || !host.isHost) throw new Error(`host room creation failed: ${JSON.stringify(host)}`);
  const guest = await guestPage.evaluate(({ code, pass }) => window.VS_AGENT.joinRoom(code, pass), { code: host.roomCode, pass: password });
  if (guest.roomCode !== host.roomCode || guest.isHost) throw new Error(`guest join failed: ${JSON.stringify(guest)}`);

  await Promise.all([
    hostPage.waitForFunction(() => window.VS_AGENT.roomStatus().state === 'ready'),
    guestPage.waitForFunction(() => window.VS_AGENT.roomStatus().state === 'ready'),
  ]);
  if (!await hostPage.evaluate(() => window.VS_AGENT.launchRoom())) throw new Error('host launch was rejected');
  await Promise.all([
    hostPage.waitForFunction(() => window.VS_AGENT.roomStatus().state === 'launched'),
    guestPage.waitForFunction(() => window.VS_AGENT.roomStatus().state === 'launched'),
  ]);

  await Promise.all([
    hostPage.evaluate(() => window.VS_AGENT.start()),
    guestPage.evaluate(() => window.VS_AGENT.start()),
  ]);
  const hostUnit = await hostPage.evaluate(() => window.VS_AGENT.observe().own.find((entity) => entity.kind === 'unit'));
  if (!hostUnit) throw new Error('host observation did not contain a controllable unit');
  const relayedEvent = guestPage.evaluate(() => window.VS_AGENT.waitFor({
    types: ['command_applied'], timeoutMs: 5000,
  }));
  const commandAck = await hostPage.evaluate((unit) => window.VS_AGENT.command('smoke-move', {
    type: 'move', ref: unit.id, x: unit.x + 8, z: unit.z,
  }), hostUnit);
  if (commandAck.status !== 'accepted') throw new Error(`headless command rejected: ${JSON.stringify(commandAck)}`);
  const remoteEvent = await relayedEvent;
  if (!remoteEvent) {
    const diagnostics = await guestPage.evaluate(() => ({
      room: window.VS_AGENT.roomStatus(),
      tick: window.VS_AGENT.observe().tick,
      events: window.VS_AGENT.events(0, 200).map((event) => event.type),
    }));
    throw new Error(`guest did not observe the relayed command event: ${JSON.stringify(diagnostics)}`);
  }
  await Promise.all([
    hostPage.evaluate(() => window.VS_AGENT.step(30)),
    guestPage.evaluate(() => window.VS_AGENT.step(30)),
  ]);
  const [hostObservation, guestObservation] = await Promise.all([
    hostPage.evaluate(() => window.VS_AGENT.observe()),
    guestPage.evaluate(() => window.VS_AGENT.observe()),
  ]);
  if (hostObservation.tick <= 0 || guestObservation.tick <= 0) throw new Error('headless multiplayer simulation did not advance');
  process.stdout.write(JSON.stringify({
    roomCode: host.roomCode,
    hostTeam: hostObservation.team,
    guestTeam: guestObservation.team,
    hostTick: hostObservation.tick,
    guestTick: guestObservation.tick,
    command: commandAck.status,
    guestSawCommand: true,
  }, null, 2) + '\n');
  await hostContext.close();
  await guestContext.close();
} finally {
  await browser?.close();
  multiplayer?.kill('SIGTERM');
  preview?.kill('SIGTERM');
}
