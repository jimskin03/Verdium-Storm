import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { Battlefield } from '../src/game/Battlefield';
import { installAgentBridge } from '../src/game/agent/AgentBridge';
import type { AgentBridgeApi } from '../src/game/agent/AgentTypes';
import type { EngineContext, QualitySettings } from '../src/engine/System';
import type { Engine } from '../src/engine/Engine';

const mockQuality: QualitySettings = {
  tier: 'high',
  pixelRatio: 1,
  shadowMapSize: 1024,
  shadowCascades: 1,
  pcssSamples: 0,
  ssao: false,
  ssr: false,
  taa: false,
  bloom: false,
  motionBlur: false,
  depthOfField: false,
  volumetricLight: false,
  volumetricClouds: false,
  grassDensity: 1,
  terrainLodBias: 1,
  maxParticles: 100,
  anisotropy: 1,
};

function createMockContext(): EngineContext {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const viewport = {} as HTMLElement;
  const uiRoot = {} as HTMLElement;
  const renderer = {} as THREE.WebGLRenderer;
  return {
    scene,
    camera,
    viewport,
    uiRoot,
    renderer,
    quality: mockQuality,
    width: 800,
    height: 600,
  };
}

describe('VS_AGENT Bridge', () => {
  let battlefield: Battlefield;
  let mockEngine: Engine;

  beforeEach(() => {
    battlefield = new Battlefield();
    const ctx = createMockContext();
    battlefield.init(ctx);

    mockEngine = {
      get: (name: string) => (name === 'battlefield' ? battlefield : undefined),
      stop: () => {},
      stepManual: (_dt: number) => {},
    } as unknown as Engine;

    // Install bridge
    installAgentBridge(mockEngine);
  });

  it('installs VS_AGENT on globalThis/window with ready: true', () => {
    const agent = (globalThis as unknown as { VS_AGENT?: AgentBridgeApi }).VS_AGENT;
    expect(agent).toBeDefined();
    expect(agent?.ready).toBe(true);
    expect(agent?.version).toBe(1);
    expect(typeof agent?.observe).toBe('function');
    expect(typeof agent?.command).toBe('function');
    expect(typeof agent?.events).toBe('function');
    expect(typeof agent?.waitFor).toBe('function');
    expect(typeof agent?.getSpectatorInfo).toBe('function');
  });

  it('provides rich tactical observation through VS_AGENT.observe()', () => {
    const agent = (globalThis as unknown as { VS_AGENT?: AgentBridgeApi }).VS_AGENT!;
    const obs = agent.observe();
    expect(obs.schemaVersion).toBe(1);
    expect(obs.team).toBe(0);
    expect(obs.units.length).toBeGreaterThan(0);
    expect(obs.resources.length).toBeGreaterThan(0);
    expect(obs.spectator).toBeDefined();
    expect(obs.map.size).toBe(1024);
  });

  it('handles commands through VS_AGENT.command()', () => {
    const agent = (globalThis as unknown as { VS_AGENT?: AgentBridgeApi }).VS_AGENT!;
    const obs = agent.observe();
    const friendlyUnit = obs.own.find((e) => e.kind === 'unit');
    expect(friendlyUnit).toBeDefined();

    const ack = agent.command('bridge-req-1', {
      type: 'move',
      ref: friendlyUnit!.id,
      x: friendlyUnit!.x + 5,
      z: friendlyUnit!.z + 5,
    });
    expect(ack.status).toBe('accepted');
  });

  it('VS_AGENT.waitFor() resolves immediately for already recorded events', async () => {
    const agent = (globalThis as unknown as { VS_AGENT?: AgentBridgeApi }).VS_AGENT!;
    // match_started was appended during init
    const matchEvent = await agent.waitFor({
      afterEventId: 0,
      types: ['match_started'],
      timeoutMs: 1000,
    });
    expect(matchEvent).not.toBeNull();
    expect(matchEvent?.type).toBe('match_started');
  });

  it('VS_AGENT.waitFor() resolves asynchronously when matching event arrives', async () => {
    const agent = (globalThis as unknown as { VS_AGENT?: AgentBridgeApi }).VS_AGENT!;
    const currentObs = agent.observe();

    const waitPromise = agent.waitFor({
      afterEventId: currentObs.lastEventId,
      types: ['command_accepted'],
      timeoutMs: 2000,
    });

    const friendlyUnit = currentObs.own.find((e) => e.kind === 'unit');
    agent.command('bridge-req-async', {
      type: 'stop',
      ref: friendlyUnit!.id,
    });

    const event = await waitPromise;
    expect(event).not.toBeNull();
    expect(event?.type).toBe('command_accepted');
    expect((event?.payload as { requestId?: string })?.requestId).toBe('bridge-req-async');
  });

  it('VS_AGENT.waitFor() resolves with null on timeout if event never occurs', async () => {
    const agent = (globalThis as unknown as { VS_AGENT?: AgentBridgeApi }).VS_AGENT!;
    const currentObs = agent.observe();

    const event = await agent.waitFor({
      afterEventId: currentObs.lastEventId,
      types: ['nonexistent_event_type'],
      timeoutMs: 50,
    });
    expect(event).toBeNull();
  });
});
