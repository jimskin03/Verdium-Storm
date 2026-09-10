import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Battlefield } from '../src/game/Battlefield';
import type { EngineContext, QualitySettings } from '../src/engine/System';
import { MultiplayerLobby } from '../src/game/Multiplayer';

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

describe('Battlefield Agent Surface', () => {
  it('initializes and produces rich tactical observations with numeric IDs', () => {
    const battlefield = new Battlefield();
    const ctx = createMockContext();
    battlefield.init(ctx);

    const obs = battlefield.agentObserve();
    expect(obs.schemaVersion).toBe(1);
    expect(obs.team).toBe(0);
    expect(obs.tick).toBe(0);
    expect(typeof obs.matchTime).toBe('number');
    expect(obs.status).toBe('active');
    expect(obs.objectives.status).toBe('active');

    // Map bounds
    expect(obs.map).toEqual({
      minX: -512,
      maxX: 512,
      minZ: -512,
      maxZ: 512,
      size: 1024,
    });

    // Available commands
    expect(obs.availableCommands).toContain('move');
    expect(obs.availableCommands).toContain('attack');
    expect(obs.availableCommands).toContain('queue-build');
    expect(obs.availableCommands).toContain('place-building');

    // Resources
    expect(obs.resources.length).toBeGreaterThan(0);
    const field0 = obs.resources[0];
    expect(typeof field0.id).toBe('number');
    expect(typeof field0.x).toBe('number');
    expect(typeof field0.z).toBe('number');
    expect(typeof field0.radius).toBe('number');
    expect(typeof field0.remaining).toBe('number');

    // Production info
    expect(obs.production.available.length).toBeGreaterThan(0);
    expect(obs.production.queue).toBeDefined();

    // Entities have strictly numeric IDs
    expect(obs.own.length).toBeGreaterThan(0);
    for (const entity of obs.own) {
      expect(typeof entity.id).toBe('number');
      expect(Number.isInteger(entity.id)).toBe(true);
      expect(entity.id).toBeGreaterThan(0);
      expect(entity.can).toBeDefined();
      expect(Array.isArray(entity.can)).toBe(true);
      if (entity.kind === 'unit') {
        expect(typeof entity.order).toBe('string');
      }
    }

    // Units array contains friendly units
    expect(obs.units.length).toBeGreaterThan(0);
    for (const unit of obs.units) {
      expect(typeof unit.id).toBe('number');
      expect(unit.kind).toBe('unit');
    }

    battlefield.dispose();
  });

  it('validates commands and provides granular rejection codes', () => {
    const battlefield = new Battlefield();
    const ctx = createMockContext();
    battlefield.init(ctx);

    // Invalid requestId
    const badReq = battlefield.agentCommand('bad request id with spaces!', { type: 'move', x: 0, z: 0 });
    expect(badReq.status).toBe('rejected');
    expect(badReq.code).toBe('REQUEST_INVALID');

    // Unknown action type
    const badAction = battlefield.agentCommand('req-1', { type: 'nonexistent-action' } as any);
    expect(badAction.status).toBe('rejected');
    expect(badAction.code).toBe('UNKNOWN_COMMAND');

    // place-building when no building is ready
    const placeNoReady = battlefield.agentCommand('req-2', { type: 'place-building', x: -300, z: -300 });
    expect(placeNoReady.status).toBe('rejected');
    expect(placeNoReady.code).toBe('NO_BUILDING_READY');

    // move command with non-existent entity ref
    const moveBadRef = battlefield.agentCommand('req-3', { type: 'move', ref: 99999999, x: 0, z: 0 });
    expect(moveBadRef.status).toBe('rejected');
    expect(moveBadRef.code).toBe('ENTITY_NOT_FOUND');

    // queue-build tech locked unit (e.g. mammoth tank before factory/lab)
    const lockedUnit = battlefield.agentCommand('req-4', { type: 'queue-build', id: 'mammoth' });
    expect(lockedUnit.status).toBe('rejected');
    expect(lockedUnit.code).toBe('TECH_LOCKED');

    battlefield.dispose();
  });

  it('accepts and normalizes unit orders with string or numeric IDs', () => {
    const battlefield = new Battlefield();
    const ctx = createMockContext();
    battlefield.init(ctx);

    const obs = battlefield.agentObserve();
    const friendlyUnit = obs.own.find((e) => e.kind === 'unit');
    expect(friendlyUnit).toBeDefined();
    const unitId = friendlyUnit!.id;

    // Order with numeric ID
    const moveAck1 = battlefield.agentCommand('req-move-1', {
      type: 'move',
      ref: unitId,
      x: friendlyUnit!.x + 10,
      z: friendlyUnit!.z + 10,
    });
    expect(moveAck1.status).toBe('accepted');

    // Order with string ID (e.g. "unit:12345" or "12345")
    const moveAck2 = battlefield.agentCommand('req-move-2', {
      type: 'move',
      ref: `unit:${unitId}`,
      x: friendlyUnit!.x + 20,
      z: friendlyUnit!.z + 20,
    });
    expect(moveAck2.status).toBe('accepted');

    // Convenience stance command
    const stanceAck = battlefield.agentCommand('req-stance-1', {
      type: 'stance',
      refs: [unitId],
      stance: 'defensive',
    });
    expect(stanceAck.status).toBe('accepted');

    // Convenience stop command
    const stopAck = battlefield.agentCommand('req-stop-1', {
      type: 'stop',
      ref: unitId,
    });
    expect(stopAck.status).toBe('accepted');

    // Generic order command with string order name
    const orderAck = battlefield.agentCommand('req-order-1', {
      type: 'order',
      ref: unitId,
      order: 'move',
      x: friendlyUnit!.x + 30,
      z: friendlyUnit!.z + 30,
    });
    expect(orderAck.status).toBe('accepted');

    battlefield.dispose();
  });

  it('provides spectator information and enforces read-only for spectator role', () => {
    const battlefield = new Battlefield();
    const ctx = createMockContext();
    battlefield.init(ctx);

    // In single player practice mode
    const specInfo = battlefield.getSpectatorInfo();
    expect(specInfo.available).toBe(false);
    expect(specInfo.instructions).toContain('requires an active multiplayer match room');

    // In a multiplayer lobby configured as spectator
    const fakeLobby = {
      team: 2 as const,
      seed: 12345,
      roomCode: 'TEST66',
      passcode: 'secret123',
      onAction: () => () => {},
      sendAction: () => {},
    } as unknown as MultiplayerLobby;

    battlefield.configureMatch('gdi', fakeLobby);
    expect(battlefield.team).toBe(2);

    const spectatorInfo = battlefield.getSpectatorInfo();
    expect(spectatorInfo.available).toBe(true);
    expect(spectatorInfo.roomCode).toBe('TEST66');
    expect(spectatorInfo.passcode).toBe('secret123');
    expect(spectatorInfo.url).toContain('spectate=TEST66');
    expect(spectatorInfo.url).toContain('pass=secret123');
    expect(spectatorInfo.instructions).toContain('TEST66');
    expect(spectatorInfo.instructions).toContain('secret123');

    // Spectator observe has spectator info
    const obs = battlefield.agentObserve();
    expect(obs.team).toBe(2);
    expect(obs.spectator.available).toBe(true);
    expect(obs.spectator.roomCode).toBe('TEST66');

    // Spectator commands are rejected with SPECTATOR_READ_ONLY
    const rejectAck = battlefield.agentCommand('spec-cmd-1', { type: 'move', ref: 1, x: 0, z: 0 });
    expect(rejectAck.status).toBe('rejected');
    expect(rejectAck.code).toBe('SPECTATOR_READ_ONLY');

    battlefield.dispose();
  });
});
