import type { EngineContext, System } from '@/engine/System';

/** PLACEHOLDER — implementation pending. See docs/WORKSTREAMS.md. */
export class TerrainRenderer implements System {
  readonly name = 'terrainRenderer';
  readonly phase = 400;
  init(_ctx: EngineContext): void {}
  update(_dt: number, _elapsed: number): void {}
}

export default TerrainRenderer;
