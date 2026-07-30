import type { EngineContext, System } from '@/engine/System';

/** PLACEHOLDER — implementation pending. See docs/WORKSTREAMS.md. */
export class PostFX implements System {
  readonly name = 'postfx';
  readonly phase = 600;
  init(_ctx: EngineContext): void {}
  update(_dt: number, _elapsed: number): void {}
}

export default PostFX;
