import { describe, expect, test } from 'vitest';
import { clampCommandCoordinate } from '../src/game/sim/CommandBounds';

describe('clampCommandCoordinate', () => {
  test('keeps formation destinations inside the simulation world', () => {
    expect(clampCommandCoordinate(0)).toBe(0);
    expect(clampCommandCoordinate(512)).toBe(512);
    expect(clampCommandCoordinate(-512)).toBe(-512);
    expect(clampCommandCoordinate(609.5)).toBe(512);
    expect(clampCommandCoordinate(-609.5)).toBe(-512);
  });
});
