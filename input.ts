// Raw input capture: keyboard + pointer, polled once per frame by main.ts.
// Knows nothing about game rules --- it just reports what happened since the
// last poll.

import type { Vec2 } from "./game.ts";

export interface RawInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  dashPressed: boolean;
  clicked: boolean;
  pointer: Vec2;
}

const MOVE_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

export function createInputSource(canvas: HTMLCanvasElement) {
  const keys = new Set<string>();
  let dashQueued = false;
  let clickQueued = false;
  let pointer: Vec2 = { x: 0, y: 0 };

  function updatePointer(e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") dashQueued = true;
    if (MOVE_KEYS.has(e.code) || e.code === "Space") e.preventDefault();
    keys.add(e.code);
  });

  window.addEventListener("keyup", (e) => {
    keys.delete(e.code);
  });

  canvas.addEventListener("pointermove", updatePointer);

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    updatePointer(e);
    clickQueued = true;
  });

  return {
    poll(): RawInput {
      const snapshot: RawInput = {
        up: keys.has("KeyW") || keys.has("ArrowUp"),
        down: keys.has("KeyS") || keys.has("ArrowDown"),
        left: keys.has("KeyA") || keys.has("ArrowLeft"),
        right: keys.has("KeyD") || keys.has("ArrowRight"),
        dashPressed: dashQueued,
        clicked: clickQueued,
        pointer,
      };
      dashQueued = false;
      clickQueued = false;
      return snapshot;
    },
  };
}
