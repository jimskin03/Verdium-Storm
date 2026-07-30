import type { EngineContext, System } from '@/engine/System';

/** PLACEHOLDER — implementation pending. See docs/WORKSTREAMS.md. */
export class Effects implements System {
  readonly name = 'effects';
  readonly phase = 500;
  init(_ctx: EngineContext): void {}
  update(_dt: number, _elapsed: number): void {}
}

export default Effects;
