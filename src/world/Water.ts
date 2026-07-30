import type { EngineContext, System } from '@/engine/System';

/** PLACEHOLDER — implementation pending. See docs/WORKSTREAMS.md. */
export class Water implements System {
  readonly name = 'water';
  readonly phase = 400;
  init(_ctx: EngineContext): void {}
  update(_dt: number, _elapsed: number): void {}
}

export default Water;
