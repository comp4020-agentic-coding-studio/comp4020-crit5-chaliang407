import { createInitialState, resizeArena, step, type GameState } from "./game.ts";
import { createInputSource } from "./input.ts";
import { createRenderer } from "./render.ts";
import { consumeHitStop, createVfx, pushTrail, reactToEvents, updateVfx, type VfxState } from "./vfx.ts";

const maybeCanvas = document.querySelector<HTMLCanvasElement>("#arena");
if (!maybeCanvas) throw new Error("missing #arena canvas");
const canvas: HTMLCanvasElement = maybeCanvas;

function sizeCanvas(): { width: number; height: number } {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height };
}

let { width, height } = sizeCanvas();
let state: GameState = createInitialState(width, height);
let vfx: VfxState = createVfx();

const input = createInputSource(canvas);
const renderer = createRenderer(canvas);

window.addEventListener("resize", () => {
  ({ width, height } = sizeCanvas());
  state = resizeArena(state, width, height);
});

let lastTime = performance.now();

function frame(now: number): void {
  const rawDt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  const dt = consumeHitStop(vfx, rawDt);

  const raw = input.poll();

  if (state.phase === "dead" || state.phase === "cleared") {
    if (raw.clicked) {
      state = createInitialState(width, height);
      vfx = createVfx();
    }
  } else {
    state = step(
      state,
      {
        up: raw.up,
        down: raw.down,
        left: raw.left,
        right: raw.right,
        dashPressed: raw.dashPressed,
        attackPressed: raw.clicked,
        attackTarget: raw.pointer,
        decisionClick: raw.clicked ? raw.pointer : null,
      },
      dt,
    );
    reactToEvents(vfx, state);
    if (state.player.dashTimeLeft > 0) pushTrail(vfx, state.player.pos, state.player.facing);
  }

  updateVfx(vfx, dt);
  renderer.render(state, vfx, dt);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
