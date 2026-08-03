import * as THREE from 'three';
import { Phase, type EngineContext, type System } from '@/engine/System';
import { tryGet, whenReady } from '@/engine/Services';
import type { GameStateService } from '@/game/GameState';
import type { Faction } from '@/entities/Types';

import { installStyles } from './Styles';
import { installDisplayFont } from './Typeface';
import { FACTIONS, applyTheme, type FactionTheme } from './Theme';
import { MockGame } from './MockGame';
import { Sidebar } from './Sidebar';
import { Tooltip } from './Tooltip';
import { TopBar } from './TopBar';
import { AlertFeed } from './Alerts';
import { SelectionPanel } from './SelectionPanel';
import { WorldLayer } from './WorldLayer';
import { Menu, type MenuOptions } from './Menu';
import { asProbe, simProbe, type WorldProbe } from './WorldProbe';
import { div, el, shieldInput } from './dom';

/**
 * The HUD system: owns every pixel of interface outside the 3D viewport.
 *
 * Structure mirrors a C&C command layout — a right-hand command bar carrying
 * the tactical map, resources and production; a status strip along the top; the
 * selection readout bottom-left; the event feed under the strip; and an
 * in-world layer for health bars. Everything is DOM, styled by one injected
 * sheet, so nothing inherits a browser control's look.
 *
 * Data flow is one-directional. The HUD reads {@link GameStateService} and
 * writes commands back through it; it never touches the simulation's internals
 * except through the optional {@link WorldProbe}, which is duck-typed and
 * degrades to "no in-world layer" when unavailable. If the simulation is absent
 * entirely — another stream still building it — a {@link MockGame} stands in so
 * the interface can be developed and reviewed on its own.
 *
 * Update cost is deliberately uneven: panels refresh on a fixed 30 Hz tick or
 * when the simulation signals a change, while the world layer and the minimap
 * frustum run every frame because they track camera motion.
 */

type HudPhase = 'menu' | 'match';

const PANEL_HZ = 30;

/** Camera rig surface the HUD uses. Read through the harness, never imported. */
interface RigLike {
  target: THREE.Vector3;
  distance: number;
  setPose(
    pose: { target?: THREE.Vector3; distance?: number; yaw?: number; pitch?: number },
    instant?: boolean,
  ): void;
}

export class Hud implements System {
  readonly name = 'hud';
  readonly phase = Phase.PRESENT;

  private root!: HTMLDivElement;
  private theme: FactionTheme = FACTIONS.gdi;

  private sidebar!: Sidebar;
  private topBar!: TopBar;
  private alerts!: AlertFeed;
  private selection!: SelectionPanel;
  private world!: WorldLayer;
  private tooltip!: Tooltip;
  private menu!: Menu;
  private pause!: HTMLDivElement;

  private camera!: THREE.PerspectiveCamera;
  private viewport!: HTMLElement;

  private game!: GameStateService;
  private mock: MockGame | null = null;
  private probe: WorldProbe = {};
  private unsubscribe: (() => void) | null = null;

  private hudPhase: HudPhase = 'menu';
  private accum = 0;
  private dirty = true;
  private showWorldLayer = true;

  private readonly focusPoint = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();

  /* ================================================================== *
   * Lifecycle
   * ================================================================== */

  init(ctx: EngineContext): void {
    this.camera = ctx.camera;
    this.viewport = ctx.viewport;

    installStyles();
    // The face compiles to a TTF at runtime; the HUD renders in the fallback
    // stack for the frame or two before it lands.
    void installDisplayFont();

    this.bindGame(tryGet('game'));

    this.root = div('vs-hud', ctx.uiRoot);
    applyTheme(this.root, this.theme);

    this.world = new WorldLayer(this.root, this.mock !== null);
    this.topBar = new TopBar(this.root, this.theme, () => this.togglePause(), () => this.openMenu());
    this.alerts = new AlertFeed(this.root, () => this.game);
    this.selection = new SelectionPanel(this.root, this.theme, () => this.game);
    this.tooltip = new Tooltip(this.root);
    this.sidebar = new Sidebar(this.root, this.theme, this.tooltip, () => this.game, (x, z) => this.seek(x, z));
    this.pause = this.buildPause();
    this.menu = new Menu(
      this.root,
      (faction) => this.startMatch(faction),
      (faction) => this.setFaction(faction),
      (key, value) => this.applyOption(key, value),
    );

    this.resize(ctx.width, ctx.height);
    window.addEventListener('keydown', this.onKey);

    // The review harness boots straight into the match: a menu covering the
    // frame would make every automated capture a picture of the menu.
    if (isHarness()) this.startMatch(this.theme.id);
    else this.openMenu();

    // The simulation may register after the HUD initialises; swap to it the
    // moment it appears so the mock is never more than a stand-in.
    if (this.mock) {
      void whenReady('game').then((service) => {
        if (service === this.game) return;
        this.bindGame(service);
        this.world.setDecals(false);
        this.dirty = true;
      });
    }

    this.exposeHarness();
  }

  private bindGame(service: GameStateService | undefined): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (service) {
      this.mock = null;
      this.game = service;
      // The real simulation draws its own ground selection rings, so the DOM
      // reticles stay off there and the health bars come from the sim stores.
      this.probe = simProbe(service) ?? asProbe(service);
    } else {
      const mock = new MockGame();
      mock.onFocus = (p) => this.seek(p.x, p.z);
      this.mock = mock;
      this.game = mock;
      this.probe = asProbe(mock);
    }

    this.theme = FACTIONS[this.game.faction] ?? FACTIONS.gdi;
    if (this.root) {
      applyTheme(this.root, this.theme);
      this.sidebar.setTheme(this.theme);
      this.topBar.setTheme(this.theme);
      this.selection.setTheme(this.theme);
    }
    this.unsubscribe = this.game.subscribe(() => {
      this.dirty = true;
    });
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.unsubscribe?.();
    this.root?.remove();
  }

  resize(width: number, height: number): void {
    // `width`/`height` arrive in device pixels; the overlay lives in CSS pixels.
    const cssW = this.viewport?.clientWidth || width;
    const cssH = this.viewport?.clientHeight || height;
    this.world?.resize(cssW, cssH);
  }

  /* ================================================================== *
   * Frame
   * ================================================================== */

  update(dt: number, _elapsed: number): void {
    this.menu.update(dt);
    if (this.hudPhase !== 'match') return;

    const game = this.game;
    this.mock?.update(game.paused ? 0 : dt);

    // Panels are cheap to write but not free to read: several of them ask the
    // simulation to rebuild option lists, so they run on a fixed tick unless
    // the simulation signals that something changed.
    this.accum += dt;
    if (this.accum >= 1 / PANEL_HZ || this.dirty) {
      const panelDt = Math.max(this.accum, 1 / 240);
      this.accum = 0;
      this.dirty = false;
      this.sidebar.update(panelDt, game);
      this.topBar.update(game);
      this.topBar.setPausedIcon(game.paused);
      this.alerts.update(game);
      this.selection.update(game);
      this.tooltip.reposition();
      this.pause.classList.toggle('on', game.paused);
    }

    // Motion-tracking layers run every frame or they visibly lag the camera.
    const rig = this.rig();
    const focus = this.focus(rig);
    this.sidebar.minimap.update(dt, game, this.camera, rig?.distance ?? this.camera.position.y, focus);
    if (this.showWorldLayer) this.world.update(this.camera, this.probe, game.team);
  }

  /* ================================================================== *
   * Camera access
   * ================================================================== */

  private rig(): RigLike | null {
    const vs = (window as unknown as { VS?: { rig?: RigLike } }).VS;
    return vs?.rig ?? null;
  }

  /** Ground point the camera is looking at, for the minimap readouts. */
  private focus(rig: RigLike | null): THREE.Vector3 {
    if (rig?.target) return this.focusPoint.copy(rig.target);
    const dir = this.camera.getWorldDirection(this.scratch);
    const t = dir.y < -1e-3 ? -this.camera.position.y / dir.y : 0;
    return this.focusPoint.copy(this.camera.position).addScaledVector(dir, t);
  }

  /** Minimap click/drag: recentre the camera without touching the rig's code. */
  private seek(x: number, z: number): void {
    const rig = this.rig();
    if (rig?.setPose) {
      rig.setPose({ target: new THREE.Vector3(x, 0, z) });
      return;
    }
    this.game.focusOn(new THREE.Vector3(x, 0, z));
  }

  /* ================================================================== *
   * Phases and controls
   * ================================================================== */

  private buildPause(): HTMLDivElement {
    const root = div('vs-pause', this.root);
    shieldInput(root);
    const title = div('ttl', root);
    title.textContent = 'PAUSED';
    const sub = div('sub', root);
    sub.textContent = 'TACTICAL CLOCK HALTED';
    const buttons = div('vs-mbtns', root);
    const resume = div('vs-mbtn primary', buttons);
    resume.textContent = 'RESUME';
    resume.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setPaused(false);
    });
    const quit = div('vs-mbtn', buttons);
    quit.textContent = 'MAIN MENU';
    quit.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openMenu();
    });
    const hint = el('div', 't-micro', root);
    hint.textContent = 'ESC OR SPACE RESUMES';
    return root;
  }

  private openMenu(): void {
    this.hudPhase = 'menu';
    this.root.dataset.phase = 'menu';
    this.setPaused(true);
    this.pause.classList.remove('on');
    this.menu.show();
  }

  private startMatch(faction: Faction): void {
    this.setFaction(faction);
    this.menu.hide();
    this.hudPhase = 'match';
    this.root.dataset.phase = 'match';
    this.setPaused(false);
    this.dirty = true;
  }

  private setFaction(faction: Faction): void {
    const theme = FACTIONS[faction] ?? FACTIONS.gdi;
    if (theme === this.theme) return;
    this.theme = theme;
    applyTheme(this.root, theme);
    this.sidebar.setTheme(theme);
    this.topBar.setTheme(theme);
    this.selection.setTheme(theme);
    this.mock?.setFaction(faction);
    this.dirty = true;
  }

  private applyOption(key: keyof MenuOptions, value: boolean): void {
    if (key === 'healthBars') {
      this.showWorldLayer = value;
      this.world.root.style.display = value ? '' : 'none';
      return;
    }
    const vs = (window as unknown as { VS?: { setFogOfWar?: (v: boolean) => boolean } }).VS;
    vs?.setFogOfWar?.(value);
  }

  private togglePause(): void {
    this.setPaused(!this.game.paused);
  }

  private setPaused(paused: boolean): void {
    this.game.setPaused(paused);
    this.pause.classList.toggle('on', paused && this.hudPhase === 'match');
    this.topBar.setPausedIcon(paused);
    this.dirty = true;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') {
      e.preventDefault();
      if (this.hudPhase === 'menu') return;
      this.togglePause();
    } else if (e.code === 'Space' && this.hudPhase === 'match') {
      e.preventDefault();
      this.togglePause();
    }
  };

  /* ================================================================== *
   * Automation surface
   * ================================================================== */

  /**
   * Screenshot hooks for tools/shoot-ui.mjs. Separate from `window.VS` because
   * that object belongs to the engine entry point, which this stream does not
   * own — this one appears and disappears with the HUD.
   */
  private exposeHarness(): void {
    (window as unknown as Record<string, unknown>).VSHUD = {
      phase: (): HudPhase => this.hudPhase,
      usingMock: (): boolean => this.mock !== null,
      menu: (): void => this.openMenu(),
      deploy: (faction?: Faction): void => this.startMatch(faction ?? this.theme.id),
      setPaused: (v: boolean): void => this.setPaused(v),
      setFaction: (f: Faction): void => this.setFaction(f),
      /** Forces a full panel refresh before a capture. */
      sync: (): void => {
        this.dirty = true;
        this.update(1 / 60, 0);
      },
    };
  }
}

function isHarness(): boolean {
  return /(?:^|[?&])harness=1/.test(window.location.search);
}

export default Hud;
