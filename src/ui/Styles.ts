import { brushTile, noiseTile } from './Icons';
import { DISPLAY_FAMILY } from './Typeface';

/**
 * The HUD stylesheet.
 *
 * Written as one injected sheet rather than a `.css` file so the procedural
 * texture tiles (grain, brushed metal) can be generated at runtime and bound to
 * custom properties before the first paint.
 *
 * Three rules keep it from looking like a web page:
 *   - No untreated rectangles. Every panel is clipped to an angular silhouette
 *     with a 1px hairline frame, drawn as two stacked pseudo-elements because a
 *     CSS border cannot follow a clip-path.
 *   - No flat fills. Every surface is a gradient plus grain plus an inset bevel.
 *   - No browser controls. Buttons, tabs, scrollbars and sliders are all built
 *     from divs so nothing inherits the platform look.
 */

const STYLE_ID = 'vs-hud-style';

export function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css();
  document.head.appendChild(style);
}

function css(): string {
  const grain = noiseTile(96, 0.06);
  const brush = brushTile(128, 64);

  return `
.vs-hud {
  --grain: url(${grain});
  --brush: url(${brush});
  --font-display: '${DISPLAY_FAMILY}', 'Bahnschrift', 'DIN Alternate', 'Liberation Sans', Arial, sans-serif;
  --font-ui: 'Liberation Sans', 'Segoe UI', Arial, sans-serif;

  --ink: #d8e6ee;
  --ink-dim: #8399a6;
  --ink-mute: #4e616d;
  --credit: #66ffae;
  --power: #54c8ff;
  --power-warn: #ffb02e;
  --power-bad: #ff4633;
  --danger: #ff3b2a;
  --ok: #63e08a;
  --ally: #3fa9ff;
  --enemy: #ff5a3c;

  --accent: #ffb42a;
  --accent-soft: #ffd98a;
  --accent-deep: #8a5c07;
  --cool: #6fc9ff;
  --panel-lo: #070c10;
  --panel-hi: #16212a;
  --edge: rgba(255,180,42,.34);
  --edge-hot: rgba(255,208,120,.95);

  --sidebar-w: 322px;
  --gutter: 14px;

  position: absolute;
  inset: 0;
  pointer-events: none;
  font-family: var(--font-ui);
  color: var(--ink);
  font-size: 12px;
  line-height: 1.25;
  z-index: 1;
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
}

.vs-hud * { pointer-events: inherit; }

/* ---------------------------------------------------------------- plates */

.vs-plate {
  position: relative;
  --clip: polygon(0 0, 100% 0, 100% 100%, 0 100%);
  --fill: linear-gradient(160deg, var(--panel-hi) 0%, var(--panel-lo) 52%, #04070a 100%);
  --frame: linear-gradient(150deg, var(--edge-hot) 0%, var(--edge) 30%, rgba(255,255,255,.06) 60%, var(--edge) 100%);
}
.vs-plate::before {
  content: ''; position: absolute; inset: 0; clip-path: var(--clip);
  background: var(--frame); opacity: .85;
}
.vs-plate::after {
  content: ''; position: absolute; inset: 1px; clip-path: var(--clip);
  background: var(--fill), var(--grain);
  background-blend-mode: normal, overlay;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.10),
    inset 0 -1px 0 rgba(0,0,0,.75),
    inset 0 22px 34px -26px rgba(255,255,255,.16),
    inset 0 0 46px rgba(0,0,0,.55);
}
.vs-plate > * { position: relative; z-index: 1; }

.cut-l  { --clip: polygon(0 13px, 13px 0, 100% 0, 100% 100%, 13px 100%, 0 calc(100% - 13px)); }
.cut-tr { --clip: polygon(0 0, calc(100% - 13px) 0, 100% 13px, 100% 100%, 0 100%); }
.cut-br { --clip: polygon(0 0, 100% 0, 100% calc(100% - 13px), calc(100% - 13px) 100%, 0 100%); }
.cut-tl-br { --clip: polygon(13px 0, 100% 0, 100% calc(100% - 13px), calc(100% - 13px) 100%, 0 100%, 0 13px); }
.cut-tr-bl { --clip: polygon(0 0, calc(100% - 13px) 0, 100% 13px, 100% 100%, 13px 100%, 0 calc(100% - 13px)); }
.cut-all { --clip: polygon(11px 0, calc(100% - 11px) 0, 100% 11px, 100% calc(100% - 11px), calc(100% - 11px) 100%, 11px 100%, 0 calc(100% - 11px), 0 11px); }
.cut-sm { --clip: polygon(0 6px, 6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%); }

/* Corner brackets: the cheapest way to say "instrument", not "card". */
.vs-bracket { position: absolute; width: 13px; height: 13px; pointer-events: none; z-index: 3; }
.vs-bracket::before, .vs-bracket::after { content: ''; position: absolute; background: var(--accent); opacity: .9; }
.vs-bracket::before { width: 100%; height: 2px; }
.vs-bracket::after { width: 2px; height: 100%; }
.vs-bracket.tl { left: -1px; top: -1px; }
.vs-bracket.tr { right: -1px; top: -1px; }
.vs-bracket.tr::before { right: 0; } .vs-bracket.tr::after { right: 0; }
.vs-bracket.bl { left: -1px; bottom: -1px; }
.vs-bracket.bl::before { bottom: 0; } .vs-bracket.bl::after { bottom: 0; }
.vs-bracket.br { right: -1px; bottom: -1px; }
.vs-bracket.br::before { right: 0; bottom: 0; } .vs-bracket.br::after { right: 0; bottom: 0; }

/* ------------------------------------------------------------ typography */

.t-display { font-family: var(--font-display); font-weight: 400; }
.t-h1 {
  font-family: var(--font-display); font-size: 14px; letter-spacing: .3em;
  text-transform: uppercase; color: var(--accent-soft);
  text-shadow: 0 0 12px rgba(255,180,42,.28);
}
.t-h2 {
  font-family: var(--font-display); font-size: 11px; letter-spacing: .28em;
  text-transform: uppercase; color: var(--ink-dim);
}
.t-micro {
  font-family: var(--font-display); font-size: 9.5px; letter-spacing: .24em;
  text-transform: uppercase; color: var(--ink-mute);
}
.t-num {
  font-family: var(--font-display); font-variant-numeric: tabular-nums;
  letter-spacing: .04em;
}
.t-body { font-family: var(--font-ui); font-size: 11.5px; color: var(--ink-dim); line-height: 1.45; }

/* A slanted header tab with hazard hatching — used above every panel group. */
.vs-cap {
  display: flex; align-items: center; gap: 8px; height: 22px; padding: 0 10px 0 12px;
  clip-path: polygon(0 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
  background:
    linear-gradient(90deg, rgba(255,180,42,.30), rgba(255,180,42,.05) 62%, transparent),
    repeating-linear-gradient(135deg, rgba(0,0,0,.34) 0 4px, transparent 4px 9px);
  border-bottom: 1px solid var(--edge);
  position: relative;
}
.vs-cap .dot { width: 5px; height: 5px; background: var(--accent); box-shadow: 0 0 7px var(--accent); flex: none; }
.vs-cap .fill { flex: 1; }
.vs-cap .meta { font-family: var(--font-display); font-size: 9.5px; letter-spacing: .2em; color: var(--ink-mute); }

/* Tick rail: fine measurement notches, a real instrument tell. */
.vs-ticks {
  height: 5px;
  background-image: repeating-linear-gradient(90deg, var(--edge) 0 1px, transparent 1px 9px);
  opacity: .7;
}

/* -------------------------------------------------------------- sidebar */

.vs-sidebar {
  position: absolute; top: 0; right: 0; bottom: 0; width: var(--sidebar-w);
  pointer-events: auto;
  display: flex; flex-direction: column; gap: 7px;
  padding: 8px 8px 8px 0;
  background:
    linear-gradient(270deg, rgba(4,7,10,.96) 0%, rgba(4,7,10,.90) 72%, rgba(4,7,10,0) 100%);
}
.vs-sidebar::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background: linear-gradient(180deg, transparent, var(--accent) 12%, var(--accent) 88%, transparent);
  opacity: .5;
}

/* faction header */
.vs-fac { display: flex; align-items: center; gap: 10px; padding: 8px 10px; height: 54px; }
.vs-fac .crest {
  width: 36px; height: 36px; background-size: contain; background-repeat: no-repeat;
  background-position: center; filter: drop-shadow(0 0 8px rgba(255,180,42,.45)); flex: none;
}
.vs-fac .txt { flex: 1; min-width: 0; }
.vs-fac .mark {
  font-family: var(--font-display); font-size: 19px; letter-spacing: .22em; color: var(--accent-soft);
  text-shadow: 0 0 14px rgba(255,180,42,.4);
}
.vs-fac .sub {
  font-family: var(--font-display); font-size: 8.5px; letter-spacing: .19em; color: var(--ink-mute);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.vs-fac .leds { display: flex; flex-direction: column; gap: 3px; }
.vs-fac .led { width: 14px; height: 3px; background: var(--ink-mute); }
.vs-fac .led.on { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.vs-fac .led.warn { background: var(--power-warn); box-shadow: 0 0 6px var(--power-warn); }
.vs-fac .led.bad { background: var(--danger); box-shadow: 0 0 6px var(--danger); animation: vs-blink .7s steps(2) infinite; }

/* minimap */
.vs-minimap { position: relative; }
.vs-minimap .frame { position: relative; padding: 6px; }
.vs-minimap canvas {
  display: block; width: 100%; height: auto; image-rendering: auto;
  box-shadow: inset 0 0 30px rgba(0,0,0,.9), 0 0 0 1px rgba(0,0,0,.8);
  cursor: crosshair;
}
.vs-minimap .glass {
  position: absolute; inset: 6px; pointer-events: none;
  background:
    linear-gradient(160deg, rgba(255,255,255,.10) 0%, rgba(255,255,255,0) 42%),
    repeating-linear-gradient(0deg, rgba(0,0,0,.16) 0 1px, transparent 1px 3px);
  mix-blend-mode: screen; opacity: .55;
}
.vs-minimap .vignette {
  position: absolute; inset: 6px; pointer-events: none;
  box-shadow: inset 0 0 34px rgba(0,0,0,.85);
}
.vs-minimap .coords {
  display: flex; justify-content: space-between; padding: 2px 8px 4px;
  font-family: var(--font-display); font-size: 8.5px; letter-spacing: .2em; color: var(--ink-mute);
}

/* economy */
.vs-econ { padding: 7px 10px 9px; display: flex; flex-direction: column; gap: 7px; }
.vs-credits { display: flex; align-items: baseline; gap: 8px; }
.vs-credits .ico {
  width: 15px; height: 15px; flex: none; align-self: center;
  background-size: contain; background-repeat: no-repeat;
  filter: drop-shadow(0 0 6px rgba(102,255,174,.6));
}
.vs-credits .val {
  font-family: var(--font-display); font-size: 27px; letter-spacing: .06em; color: var(--credit);
  font-variant-numeric: tabular-nums; line-height: 1;
  text-shadow: 0 0 16px rgba(102,255,174,.42);
}
.vs-credits .val.spend { color: var(--power-warn); text-shadow: 0 0 16px rgba(255,176,46,.5); }
.vs-credits .delta {
  font-family: var(--font-display); font-size: 11px; letter-spacing: .1em; color: var(--credit);
  opacity: .8; margin-left: auto;
}
.vs-credits .delta.neg { color: var(--danger); }

.vs-power { display: flex; flex-direction: column; gap: 4px; }
.vs-power .row { display: flex; align-items: center; gap: 6px; }
.vs-power .ico { width: 11px; height: 13px; background-size: contain; background-repeat: no-repeat; }
.vs-power .lbl { font-family: var(--font-display); font-size: 9.5px; letter-spacing: .24em; color: var(--ink-mute); }
.vs-power .num { margin-left: auto; font-family: var(--font-display); font-size: 11px; letter-spacing: .08em; color: var(--ink-dim); font-variant-numeric: tabular-nums; }
.vs-power .bar {
  position: relative; height: 11px; background: #05090c;
  box-shadow: inset 0 1px 3px rgba(0,0,0,.9), inset 0 0 0 1px rgba(255,255,255,.05);
  clip-path: polygon(0 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
  overflow: hidden;
}
.vs-power .bar .used {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0%;
  background: linear-gradient(180deg, var(--power) 0%, #1a6f9c 100%);
  box-shadow: 0 0 12px rgba(84,200,255,.5);
  transition: width .35s cubic-bezier(.2,.7,.3,1), background .3s ease;
}
.vs-power .bar .segs {
  position: absolute; inset: 0;
  background-image: repeating-linear-gradient(90deg, transparent 0 7px, rgba(0,0,0,.62) 7px 9px);
}
.vs-power .bar .cap {
  position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--accent);
  box-shadow: 0 0 8px var(--accent); left: 100%;
}
.vs-power.warn .bar .used { background: linear-gradient(180deg, var(--power-warn) 0%, #7a4f04 100%); box-shadow: 0 0 12px rgba(255,176,46,.55); }
.vs-power.bad .bar .used { background: linear-gradient(180deg, var(--power-bad) 0%, #6d1207 100%); box-shadow: 0 0 14px rgba(255,70,51,.6); }
.vs-power.bad .lbl, .vs-power.bad .num { color: var(--power-bad); }
.vs-power.bad { animation: vs-brownout 1.15s ease-in-out infinite; }

/* tabs */
.vs-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; }
.vs-tab {
  position: relative; height: 40px; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  clip-path: polygon(7px 0, 100% 0, calc(100% - 7px) 100%, 0 100%);
  background: linear-gradient(180deg, #131c23 0%, #080d11 100%), var(--grain);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08), inset 0 -2px 0 rgba(0,0,0,.7);
  transition: background .16s ease, box-shadow .16s ease;
}
.vs-tab .ico { width: 17px; height: 17px; background-size: contain; background-repeat: no-repeat; opacity: .55; transition: opacity .16s ease; }
.vs-tab .lbl { font-family: var(--font-display); font-size: 9px; letter-spacing: .2em; color: var(--ink-mute); }
.vs-tab:hover { background: linear-gradient(180deg, #1b262e 0%, #0c1319 100%); }
.vs-tab:hover .ico { opacity: .8; }
.vs-tab.on {
  background: linear-gradient(180deg, rgba(255,180,42,.30) 0%, rgba(255,180,42,.06) 60%, #0a1116 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.22), inset 0 -2px 0 var(--accent), 0 0 18px rgba(255,180,42,.16);
}
.vs-tab.on .ico { opacity: 1; }
.vs-tab.on .lbl { color: var(--accent-soft); }

/* build grid */
.vs-grid-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
.vs-grid {
  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px;
  align-content: start; padding: 8px 7px 10px;
  scrollbar-width: none;
}
.vs-grid::-webkit-scrollbar { display: none; }
.vs-rail { width: 3px; margin: 8px 3px 10px 0; background: rgba(255,255,255,.05); position: relative; }
.vs-rail i { position: absolute; left: 0; right: 0; background: var(--accent); opacity: .55; }

.vs-btn {
  position: relative; cursor: pointer; user-select: none;
  clip-path: polygon(0 7px, 7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%);
  background: linear-gradient(178deg, #2a3843 0%, #101820 28%, #060a0e 100%);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.22),
    inset 1px 0 0 rgba(255,255,255,.08),
    inset 0 -2px 3px rgba(0,0,0,.85),
    inset 0 0 0 1px rgba(0,0,0,.6);
  transition: transform .10s ease, filter .14s ease, box-shadow .14s ease;
}
.vs-btn .cameo {
  display: block; width: 100%; aspect-ratio: 1 / 1;
  background-size: 96%; background-position: 50% 46%; background-repeat: no-repeat;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.7));
}
.vs-btn .plinth {
  position: absolute; left: 0; right: 0; top: 0; aspect-ratio: 1 / 1;
  background:
    radial-gradient(ellipse at 50% 68%, rgba(255,180,42,.14) 0%, transparent 62%),
    repeating-linear-gradient(0deg, rgba(255,255,255,.030) 0 1px, transparent 1px 4px);
  pointer-events: none;
}
.vs-btn .name {
  display: block; padding: 3px 4px 2px; text-align: center;
  font-family: var(--font-display); font-size: 8.5px; letter-spacing: .1em;
  color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: linear-gradient(180deg, rgba(0,0,0,.5), rgba(0,0,0,.85));
  border-top: 1px solid rgba(255,255,255,.06);
}
.vs-btn .cost {
  position: absolute; left: 0; right: 0; bottom: 15px; height: 15px;
  display: flex; align-items: center; justify-content: flex-end; gap: 3px; padding-right: 4px;
  background: linear-gradient(180deg, rgba(2,5,8,0), rgba(2,5,8,.92));
  font-family: var(--font-display); font-size: 11px; letter-spacing: .04em;
  color: var(--credit); font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 3px #000;
}
.vs-btn:hover {
  filter: brightness(1.28) saturate(1.05);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.34), inset 0 0 0 1px var(--edge),
    inset 0 -2px 3px rgba(0,0,0,.85), 0 0 20px rgba(255,180,42,.22);
}
.vs-btn:active { transform: translateY(1px); filter: brightness(.86); }
.vs-btn .frame { position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 1px rgba(255,255,255,.07); }

/* production overlay */
.vs-btn .sweep {
  position: absolute; left: 0; right: 0; top: 0; aspect-ratio: 1 / 1; pointer-events: none;
  background: conic-gradient(from -90deg, transparent 0 calc(var(--p) * 1turn), rgba(2,6,9,.78) calc(var(--p) * 1turn) 1turn);
  opacity: 0; transition: opacity .2s ease;
}
.vs-btn.building .sweep { opacity: 1; }
.vs-btn .pbar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(0,0,0,.7); opacity: 0; }
.vs-btn .pbar i { display: block; height: 100%; width: 0%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }
.vs-btn.building .pbar { opacity: 1; }
.vs-btn.building .name { color: var(--accent-soft); }
.vs-btn .pct {
  position: absolute; left: 0; right: 0; top: 38%; text-align: center;
  font-family: var(--font-display); font-size: 15px; letter-spacing: .06em; color: #fff;
  text-shadow: 0 0 10px rgba(0,0,0,.9); opacity: 0; pointer-events: none;
}
.vs-btn.building .pct { opacity: 1; }

.vs-btn .badge {
  position: absolute; left: 3px; top: 3px; min-width: 17px; height: 16px; padding: 0 3px;
  display: none; align-items: center; justify-content: center;
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%);
  background: linear-gradient(180deg, var(--accent), var(--accent-deep));
  color: #140b00; font-family: var(--font-display); font-size: 10px; letter-spacing: 0;
  box-shadow: 0 1px 4px rgba(0,0,0,.8);
}
.vs-btn.queued .badge { display: flex; }

.vs-btn.locked { filter: grayscale(.85) brightness(.5); cursor: not-allowed; }
.vs-btn.locked::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(135deg, rgba(255,59,42,.16) 0 5px, transparent 5px 11px);
}
.vs-btn.locked .lock {
  position: absolute; right: 4px; top: 4px; width: 13px; height: 13px;
  background-size: contain; background-repeat: no-repeat; opacity: .85;
}
.vs-btn:not(.locked) .lock { display: none; }
.vs-btn.locked:hover { filter: grayscale(.7) brightness(.62); }

.vs-btn.ready {
  animation: vs-ready 1.05s ease-in-out infinite;
}
.vs-btn.ready .name { color: #08120b; background: var(--ok); font-weight: 700; }
.vs-btn .readyflag {
  position: absolute; left: 0; right: 0; top: 34%; text-align: center; display: none;
  font-family: var(--font-display); font-size: 12px; letter-spacing: .18em; color: #d8ffe6;
  text-shadow: 0 0 12px rgba(99,224,138,.9);
}
.vs-btn.ready .readyflag { display: block; }
.vs-btn.ready .sweep, .vs-btn.ready .pct { opacity: 0; }

/* active production strip */
.vs-active { display: flex; align-items: center; gap: 8px; padding: 6px 8px; height: 46px; }
.vs-active .ico { width: 32px; height: 32px; background-size: contain; background-repeat: no-repeat; flex: none; }
.vs-active .txt { flex: 1; min-width: 0; }
.vs-active .nm { font-family: var(--font-display); font-size: 10.5px; letter-spacing: .16em; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vs-active .eta { font-family: var(--font-display); font-size: 9px; letter-spacing: .2em; color: var(--ink-mute); }
.vs-active .stop {
  width: 24px; height: 24px; flex: none; cursor: pointer;
  clip-path: polygon(0 4px, 4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%);
  background: linear-gradient(180deg, #3a1512, #170706);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.18), inset 0 0 0 1px rgba(255,59,42,.4);
  display: flex; align-items: center; justify-content: center;
}
.vs-active .stop i { width: 11px; height: 11px; background-size: contain; background-repeat: no-repeat; }
.vs-active .stop:hover { background: linear-gradient(180deg, #5c211c, #240a08); }
.vs-active.idle { opacity: .45; }

/* --------------------------------------------------------------- top bar */

.vs-top {
  position: absolute; top: 0; left: 0; right: var(--sidebar-w); height: 44px;
  pointer-events: auto; display: flex; align-items: stretch; gap: 1px;
  padding-right: 6px;
}
.vs-top .bg {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(5,9,12,.94) 0%, rgba(5,9,12,.72) 68%, transparent 100%);
  clip-path: polygon(0 0, 100% 0, 100% 100%, 34px 100%, 20px calc(100% - 14px), 0 calc(100% - 14px));
}
.vs-top .rule {
  position: absolute; left: 0; right: 0; top: 43px; height: 1px;
  background: linear-gradient(90deg, var(--accent) 0%, rgba(255,180,42,.22) 45%, transparent 100%);
  clip-path: polygon(0 0, calc(100% - 60px) 0, calc(100% - 74px) 100%, 0 100%);
}
.vs-top .grp { position: relative; display: flex; align-items: center; gap: 7px; padding: 0 16px 0 14px; }
.vs-top .grp + .grp::before {
  content: ''; position: absolute; left: 0; top: 10px; bottom: 12px; width: 1px;
  background: linear-gradient(180deg, transparent, var(--edge), transparent);
}
.vs-top .ico { width: 14px; height: 14px; background-size: contain; background-repeat: no-repeat; opacity: .75; }
.vs-top .lbl { font-family: var(--font-display); font-size: 8.5px; letter-spacing: .24em; color: var(--ink-mute); }
.vs-top .val { font-family: var(--font-display); font-size: 16px; letter-spacing: .08em; color: var(--ink); font-variant-numeric: tabular-nums; }
.vs-top .val.big { font-size: 22px; color: var(--accent-soft); text-shadow: 0 0 14px rgba(255,180,42,.34); }
.vs-top .val.ok { color: var(--ok); }
.vs-top .val.bad { color: var(--danger); }
.vs-top .stack { display: flex; flex-direction: column; gap: 1px; line-height: 1; }
.vs-top .spacer { flex: 1; }
.vs-top .capbar { width: 62px; height: 5px; background: #060b0e; box-shadow: inset 0 0 0 1px rgba(255,255,255,.07); }
.vs-top .capbar i { display: block; height: 100%; background: linear-gradient(90deg, var(--cool), var(--accent)); }

.vs-sysbtn {
  position: relative; width: 34px; align-self: center; height: 26px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; margin-left: 4px;
  clip-path: polygon(0 5px, 5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%);
  background: linear-gradient(180deg, #1a242c, #080d11);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.06);
}
.vs-sysbtn i { width: 13px; height: 13px; background-size: contain; background-repeat: no-repeat; opacity: .75; }
.vs-sysbtn:hover { background: linear-gradient(180deg, #2a3944, #0d141a); }
.vs-sysbtn:hover i { opacity: 1; }

/* --------------------------------------------------------------- alerts */

.vs-alerts {
  position: absolute; left: var(--gutter); top: 58px; width: 336px;
  display: flex; flex-direction: column; gap: 4px; pointer-events: auto;
}
.vs-alert {
  position: relative; display: flex; align-items: center; gap: 9px; height: 32px; padding: 0 10px 0 12px;
  cursor: pointer; overflow: hidden;
  clip-path: polygon(0 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
  background: linear-gradient(90deg, rgba(10,16,20,.94) 0%, rgba(10,16,20,.62) 78%, rgba(10,16,20,0) 100%);
  animation: vs-alert-in .32s cubic-bezier(.15,.85,.3,1);
  transition: opacity .3s ease;
}
.vs-alert::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--k); }
.vs-alert::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(90deg, color-mix(in srgb, var(--k) 22%, transparent), transparent 46%);
}
.vs-alert .ico { width: 15px; height: 15px; background-size: contain; background-repeat: no-repeat; flex: none; filter: drop-shadow(0 0 5px var(--k)); }
.vs-alert .msg {
  flex: 1; font-family: var(--font-display); font-size: 10.5px; letter-spacing: .13em;
  color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.vs-alert .age { font-family: var(--font-display); font-size: 9px; letter-spacing: .1em; color: var(--ink-mute); }
.vs-alert:hover { background: linear-gradient(90deg, rgba(22,32,40,.98) 0%, rgba(14,20,26,.7) 78%, transparent 100%); }
.vs-alert:hover .msg { color: #fff; }
.vs-alert.k-baseUnderAttack { --k: var(--danger); animation: vs-alert-in .32s cubic-bezier(.15,.85,.3,1), vs-urgent 1s ease-in-out infinite .32s; }
.vs-alert.k-lowPower { --k: var(--power-warn); }
.vs-alert.k-insufficientFunds { --k: var(--power-warn); }
.vs-alert.k-unitLost { --k: #ff7a5c; }
.vs-alert.k-harvesterLost { --k: #ff7a5c; }
.vs-alert.k-buildingComplete { --k: var(--ok); }
.vs-alert.k-unitReady { --k: var(--ok); }
.vs-alert.k-newTech { --k: var(--cool); }
.vs-alert { --k: var(--accent); }

/* base-under-attack screen flash */
.vs-flash {
  position: absolute; inset: 0; pointer-events: none; opacity: 0;
  background: radial-gradient(ellipse at 50% 50%, transparent 34%, rgba(255,40,26,.42) 100%);
}
.vs-flash.on { animation: vs-flash 1.5s ease-out 2; }
.vs-warnband {
  position: absolute; left: 0; right: var(--sidebar-w); top: 30%; height: 46px; pointer-events: none;
  display: flex; align-items: center; justify-content: center; opacity: 0;
  background: linear-gradient(90deg, transparent, rgba(120,10,4,.55) 20%, rgba(160,14,6,.7) 50%, rgba(120,10,4,.55) 80%, transparent);
  border-top: 1px solid rgba(255,70,50,.6); border-bottom: 1px solid rgba(255,70,50,.6);
}
.vs-warnband span {
  font-family: var(--font-display); font-size: 26px; letter-spacing: .38em; color: #ffe2dc;
  text-indent: .38em; text-shadow: 0 0 22px rgba(255,60,40,.9);
}
.vs-warnband.on { animation: vs-band 2.6s ease-out; }

/* ------------------------------------------------------------ selection */

.vs-sel {
  position: absolute; left: var(--gutter); bottom: var(--gutter); width: 452px;
  pointer-events: auto; display: none;
}
.vs-sel.on { display: block; }
.vs-sel .body { display: flex; gap: 9px; padding: 9px 10px 10px; }

.vs-portrait {
  position: relative; width: 92px; height: 92px; flex: none;
  clip-path: polygon(0 8px, 8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%);
  background:
    radial-gradient(ellipse at 50% 66%, rgba(255,180,42,.16) 0%, transparent 64%),
    linear-gradient(180deg, #1a252d 0%, #060a0e 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2), inset 0 0 0 1px rgba(0,0,0,.7);
}
.vs-portrait .img { position: absolute; inset: 0; background-size: 94%; background-position: 50% 46%; background-repeat: no-repeat; }
.vs-portrait .scan {
  position: absolute; inset: 0;
  background: repeating-linear-gradient(0deg, rgba(255,255,255,.04) 0 1px, transparent 1px 3px);
}

.vs-sel .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.vs-sel .nm { font-family: var(--font-display); font-size: 17px; letter-spacing: .18em; color: var(--ink); }
.vs-sel .kd { font-family: var(--font-display); font-size: 9px; letter-spacing: .26em; color: var(--accent); }

.vs-meter { display: flex; flex-direction: column; gap: 2px; }
.vs-meter .head { display: flex; justify-content: space-between; align-items: baseline; }
.vs-meter .head b { font-family: var(--font-display); font-size: 9px; letter-spacing: .24em; color: var(--ink-mute); font-weight: 400; }
.vs-meter .head span { font-family: var(--font-display); font-size: 10.5px; color: var(--ink-dim); font-variant-numeric: tabular-nums; }
.vs-meter .track {
  position: relative; height: 9px; background: #05090c;
  box-shadow: inset 0 1px 3px rgba(0,0,0,.9), inset 0 0 0 1px rgba(255,255,255,.05);
  clip-path: polygon(0 0, 100% 0, calc(100% - 4px) 100%, 0 100%);
}
.vs-meter .track i { display: block; height: 100%; width: 0%; transition: width .25s ease; }
.vs-meter .track .segs {
  position: absolute; inset: 0;
  background-image: repeating-linear-gradient(90deg, transparent 0 6px, rgba(0,0,0,.6) 6px 8px);
}
.vs-meter.hp .track i { background: linear-gradient(180deg, #7dffa4, #17803f); box-shadow: 0 0 10px rgba(99,224,138,.45); }
.vs-meter.hp.mid .track i { background: linear-gradient(180deg, #ffd24d, #8a5c07); box-shadow: 0 0 10px rgba(255,180,42,.45); }
.vs-meter.hp.low .track i { background: linear-gradient(180deg, #ff6d55, #7d1405); box-shadow: 0 0 10px rgba(255,60,40,.5); }
.vs-meter.cargo .track i { background: linear-gradient(180deg, #7de3ff, #12587a); }
.vs-meter.build .track i { background: linear-gradient(180deg, var(--accent-soft), var(--accent-deep)); }

.vs-squad { display: grid; grid-template-columns: repeat(auto-fill, 42px); gap: 4px; align-content: start; }
.vs-chip {
  position: relative; width: 42px; height: 42px; cursor: pointer;
  clip-path: polygon(0 5px, 5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%);
  background: linear-gradient(180deg, #1a242c 0%, #070c10 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(0,0,0,.6);
}
.vs-chip .img { position: absolute; inset: 0 0 5px; background-size: 92%; background-position: 50% 42%; background-repeat: no-repeat; }
.vs-chip .hp { position: absolute; left: 2px; right: 2px; bottom: 2px; height: 3px; background: rgba(0,0,0,.75); }
.vs-chip .hp i { display: block; height: 100%; background: var(--ok); }
.vs-chip.mid .hp i { background: var(--power-warn); }
.vs-chip.low .hp i { background: var(--danger); }
.vs-chip:hover { box-shadow: inset 0 1px 0 rgba(255,255,255,.3), inset 0 0 0 1px var(--edge-hot); }

/* --------------------------------------------------------- world overlay */

.vs-world { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.vs-hpbar {
  position: absolute; width: 44px; height: 6px; margin-left: -22px; margin-top: -3px;
  background: rgba(2,5,8,.82); box-shadow: 0 0 0 1px rgba(0,0,0,.85);
  clip-path: polygon(0 0, 100% 0, calc(100% - 2px) 100%, 0 100%);
  will-change: transform;
}
.vs-hpbar i { display: block; height: 100%; background: var(--ok); }
.vs-hpbar .seg {
  position: absolute; inset: 0;
  background-image: repeating-linear-gradient(90deg, transparent 0 4px, rgba(0,0,0,.75) 4px 5px);
}
.vs-hpbar.mid i { background: var(--power-warn); }
.vs-hpbar.low i { background: var(--danger); }
.vs-hpbar.enemy { box-shadow: 0 0 0 1px rgba(255,90,60,.5); }
.vs-hpbar.sel { height: 7px; box-shadow: 0 0 0 1px var(--edge-hot), 0 0 8px rgba(255,180,42,.4); }

/* ------------------------------------------------------------- tooltip */

.vs-tip {
  position: absolute; max-width: 264px; padding: 0; opacity: 0; pointer-events: none;
  transform: translateY(4px); transition: opacity .12s ease, transform .12s ease; z-index: 40;
}
.vs-tip.on { opacity: 1; transform: translateY(0); }
.vs-tip .in { padding: 8px 11px 10px; }
.vs-tip .ttl { font-family: var(--font-display); font-size: 12.5px; letter-spacing: .2em; color: var(--accent-soft); }
.vs-tip .stats { display: flex; gap: 12px; margin-top: 5px; }
.vs-tip .st { display: flex; flex-direction: column; }
.vs-tip .st b { font-family: var(--font-display); font-size: 8.5px; letter-spacing: .2em; color: var(--ink-mute); font-weight: 400; }
.vs-tip .st span { font-family: var(--font-display); font-size: 12px; color: var(--ink); }
.vs-tip .st span.credit { color: var(--credit); }
.vs-tip .why {
  margin-top: 7px; padding-top: 6px; border-top: 1px solid rgba(255,59,42,.28);
  font-family: var(--font-display); font-size: 9.5px; letter-spacing: .14em; color: #ff8f7c;
}

/* ---------------------------------------------------------------- menu */

.vs-menu {
  position: absolute; inset: 0; pointer-events: auto; display: none;
  background:
    radial-gradient(ellipse at 50% 42%, rgba(20,34,28,.35) 0%, rgba(3,5,8,.97) 62%),
    linear-gradient(180deg, #04070a, #010203);
  overflow: hidden;
}
.vs-menu.on { display: block; }
.vs-menu .bgfx {
  position: absolute; inset: -10%;
  background-image:
    repeating-linear-gradient(0deg, rgba(255,255,255,.022) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(90deg, rgba(255,180,42,.035) 0 1px, transparent 1px 74px),
    repeating-linear-gradient(0deg, rgba(255,180,42,.035) 0 1px, transparent 1px 74px);
  animation: vs-drift 34s linear infinite;
}
.vs-menu .sweep2 {
  position: absolute; left: 50%; top: 42%; width: 1100px; height: 1100px; margin: -550px 0 0 -550px;
  background: conic-gradient(from 0deg, rgba(255,180,42,.16) 0deg, transparent 42deg);
  border-radius: 50%; animation: vs-spin 7s linear infinite; opacity: .5;
  mask-image: radial-gradient(circle, transparent 12%, #000 34%, transparent 72%);
  -webkit-mask-image: radial-gradient(circle, transparent 12%, #000 34%, transparent 72%);
}
.vs-menu .vig { position: absolute; inset: 0; box-shadow: inset 0 0 260px rgba(0,0,0,.95); }

.vs-menu .stage {
  position: relative; height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 22px; padding: 40px;
}
.vs-menu .wordmark { display: block; filter: drop-shadow(0 6px 30px rgba(255,180,42,.28)); }
.vs-menu .tagline {
  font-family: var(--font-display); font-size: 12px; letter-spacing: .62em; color: var(--ink-mute);
  text-indent: .62em; margin-top: -6px;
}
.vs-menu .divider {
  width: min(880px, 78vw); height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity: .5;
}

.vs-cards { display: flex; gap: 18px; }
.vs-card {
  position: relative; width: 320px; cursor: pointer;
  transition: transform .18s cubic-bezier(.2,.8,.3,1), filter .18s ease;
  filter: brightness(.7) saturate(.6);
}
.vs-card:hover { filter: brightness(.92) saturate(.85); transform: translateY(-3px); }
.vs-card.on { filter: none; transform: translateY(-6px); }
.vs-card .in { padding: 18px 18px 20px; display: flex; flex-direction: column; gap: 11px; }
.vs-card .crest { width: 76px; height: 76px; background-size: contain; background-repeat: no-repeat; align-self: center; filter: drop-shadow(0 0 16px currentColor); }
.vs-card .mark { text-align: center; font-family: var(--font-display); font-size: 30px; letter-spacing: .26em; text-indent: .26em; color: var(--c-accent); }
.vs-card .name { text-align: center; font-family: var(--font-display); font-size: 9.5px; letter-spacing: .26em; color: var(--ink-mute); }
.vs-card .doc { font-family: var(--font-ui); font-size: 11.5px; line-height: 1.5; color: var(--ink-dim); min-height: 68px; }
.vs-card .traits { display: flex; flex-direction: column; gap: 5px; }
.vs-card .trait { display: flex; align-items: center; gap: 8px; }
.vs-card .trait b { width: 74px; font-family: var(--font-display); font-size: 8.5px; letter-spacing: .2em; color: var(--ink-mute); font-weight: 400; }
.vs-card .trait .t { flex: 1; height: 6px; background: #05090c; box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
.vs-card .trait .t i { display: block; height: 100%; background: var(--c-accent); box-shadow: 0 0 8px var(--c-accent); }
.vs-card.on::after {
  content: ''; position: absolute; inset: -1px; pointer-events: none;
  box-shadow: 0 0 34px var(--c-accent); opacity: .30;
}

.vs-mbtns { display: flex; gap: 12px; align-items: center; }
.vs-mbtn {
  position: relative; min-width: 216px; height: 46px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  clip-path: polygon(0 10px, 10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%);
  background: linear-gradient(180deg, #1c2831 0%, #080d12 100%), var(--grain);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.18), inset 0 -2px 0 rgba(0,0,0,.8), inset 0 0 0 1px rgba(255,255,255,.05);
  font-family: var(--font-display); font-size: 13px; letter-spacing: .3em; color: var(--ink-dim);
  text-indent: .3em; transition: all .16s ease;
}
.vs-mbtn:hover { color: #fff; background: linear-gradient(180deg, #2b3a45 0%, #0d141a 100%); box-shadow: inset 0 1px 0 rgba(255,255,255,.3), inset 0 0 0 1px var(--edge), 0 0 26px rgba(255,180,42,.18); }
.vs-mbtn:active { transform: translateY(1px); }
.vs-mbtn.primary {
  background: linear-gradient(180deg, var(--accent) 0%, var(--accent-deep) 100%), var(--grain);
  color: #100a00; text-shadow: 0 1px 0 rgba(255,255,255,.25);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.5), inset 0 -3px 0 rgba(0,0,0,.4), 0 0 34px rgba(255,180,42,.34);
}
.vs-mbtn.primary:hover { filter: brightness(1.14); color: #100a00; }

.vs-seg { display: flex; gap: 2px; }
.vs-seg .o {
  padding: 7px 14px; cursor: pointer;
  font-family: var(--font-display); font-size: 10px; letter-spacing: .22em; color: var(--ink-mute);
  clip-path: polygon(0 5px, 5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%);
  background: linear-gradient(180deg, #131c23, #070c10);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
}
.vs-seg .o:hover { color: var(--ink); }
.vs-seg .o.on { color: #100a00; background: linear-gradient(180deg, var(--accent), var(--accent-deep)); }
.vs-optrow { display: flex; gap: 26px; align-items: center; }
.vs-optrow .g { display: flex; flex-direction: column; gap: 5px; align-items: center; }
.vs-optrow .g > b { font-family: var(--font-display); font-size: 8.5px; letter-spacing: .26em; color: var(--ink-mute); font-weight: 400; }

.vs-menu .foot {
  position: absolute; left: 0; right: 0; bottom: 0; height: 34px;
  display: flex; align-items: center; justify-content: space-between; padding: 0 20px;
  font-family: var(--font-display); font-size: 9px; letter-spacing: .24em; color: #2f3f49;
  border-top: 1px solid rgba(255,255,255,.05);
}

/* loading sequence */
.vs-load { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 18px; }
.vs-load.on { display: flex; }
.vs-load .pct { font-family: var(--font-display); font-size: 84px; letter-spacing: .06em; color: var(--accent-soft); line-height: 1; text-shadow: 0 0 40px rgba(255,180,42,.38); font-variant-numeric: tabular-nums; }
.vs-load .barwrap { width: min(720px, 68vw); }
.vs-load .bar { position: relative; height: 6px; background: #05090c; box-shadow: inset 0 0 0 1px rgba(255,255,255,.07); clip-path: polygon(0 0, 100% 0, calc(100% - 4px) 100%, 0 100%); overflow: hidden; }
.vs-load .bar i { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, var(--accent-deep), var(--accent)); box-shadow: 0 0 18px var(--accent); transition: width .2s linear; }
.vs-load .bar .segs { position: absolute; inset: 0; background-image: repeating-linear-gradient(90deg, transparent 0 11px, rgba(0,0,0,.55) 11px 13px); }
.vs-load .log { width: min(720px, 68vw); height: 92px; overflow: hidden; display: flex; flex-direction: column; gap: 3px; }
.vs-load .log div { font-family: var(--font-display); font-size: 10px; letter-spacing: .22em; color: #35505f; }
.vs-load .log div:last-child { color: var(--accent-soft); }
.vs-load .log div::before { content: '> '; color: var(--accent); opacity: .6; }

/* pause */
.vs-pause {
  position: absolute; inset: 0; display: none; pointer-events: auto;
  align-items: center; justify-content: center; flex-direction: column; gap: 18px;
  background: rgba(3,6,9,.78); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
}
.vs-pause.on { display: flex; }
.vs-pause .ttl { font-family: var(--font-display); font-size: 44px; letter-spacing: .34em; text-indent: .34em; color: var(--accent-soft); text-shadow: 0 0 34px rgba(255,180,42,.4); }
.vs-pause .sub { font-family: var(--font-display); font-size: 10px; letter-spacing: .4em; color: var(--ink-mute); text-indent: .4em; }

/* --------------------------------------------------------------- boot in */

.vs-hud[data-phase="match"] .vs-sidebar { animation: vs-slide-r .55s cubic-bezier(.16,.9,.3,1); }
.vs-hud[data-phase="match"] .vs-top { animation: vs-slide-u .5s cubic-bezier(.16,.9,.3,1); }
.vs-hud[data-phase="match"] .vs-sel { animation: vs-slide-l .55s .08s backwards cubic-bezier(.16,.9,.3,1); }

/* ------------------------------------------------------------ keyframes */

@keyframes vs-blink { 50% { opacity: .25; } }
@keyframes vs-ready {
  0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,.22), inset 0 0 0 1px rgba(99,224,138,.5), 0 0 8px rgba(99,224,138,.3); }
  50% { box-shadow: inset 0 1px 0 rgba(255,255,255,.4), inset 0 0 0 2px rgba(140,255,180,.95), 0 0 26px rgba(99,224,138,.75); }
}
@keyframes vs-brownout { 0%, 100% { opacity: 1; } 50% { opacity: .62; } }
@keyframes vs-alert-in { from { opacity: 0; transform: translateX(-22px); } to { opacity: 1; transform: none; } }
@keyframes vs-urgent { 0%, 100% { filter: none; } 50% { filter: brightness(1.7); } }
@keyframes vs-flash { 0% { opacity: 0; } 12% { opacity: 1; } 100% { opacity: 0; } }
@keyframes vs-band {
  0% { opacity: 0; transform: scaleY(.2); }
  12% { opacity: 1; transform: scaleY(1); }
  76% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes vs-spin { to { transform: rotate(360deg); } }
@keyframes vs-drift { to { transform: translate(74px, 74px); } }
@keyframes vs-slide-r { from { transform: translateX(102%); } }
@keyframes vs-slide-l { from { transform: translateX(-110%); opacity: 0; } }
@keyframes vs-slide-u { from { transform: translateY(-102%); } }
@keyframes vs-sweep { to { transform: rotate(360deg); } }

/* ------------------------------------------------------------ responsive */

@media (max-width: 1500px) {
  .vs-hud { --sidebar-w: 286px; }
  .vs-sel { width: 404px; }
  .vs-alerts { width: 300px; }
}
@media (max-height: 900px) {
  .vs-hud { --sidebar-w: 286px; }
  .vs-btn .name { font-size: 8px; }
}
`;
}
