import { agentMessage } from "./pointer.ts";
import { LiveShape, type ActionShape, type LiveAct } from "./pointer-shapes.ts";

export interface AgentShapesDeps {
  now(): number;
  schedule(run: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
  send(boxId: string, message: string): void;
}

interface BoxShape {
  readonly live: LiveShape;
  x: number;
  y: number;
  shape: ActionShape;
  timer: unknown;
}

const NO_TIMER = null;
const LEAST_TIMER_MS = 1;

export class AgentShapes {
  readonly #boxes = new Map<string, BoxShape>();
  readonly #deps: AgentShapesDeps;

  constructor(deps: AgentShapesDeps) {
    this.#deps = deps;
  }

  acted(boxId: string, act: LiveAct): void {
    const now = this.#deps.now();
    const box = this.#boxes.get(boxId) ?? { live: new LiveShape(now), x: act.x, y: act.y, shape: "arrow", timer: NO_TIMER };
    this.#boxes.set(boxId, box);
    box.live.act(act, now);
    box.x = act.x;
    box.y = act.y;
    this.#publish(boxId, box);
  }

  told(boxId: string): string[] {
    const box = this.#boxes.get(boxId);
    return box ? [this.#message(box)] : [];
  }

  pending(boxId: string): boolean {
    return (this.#boxes.get(boxId)?.timer ?? NO_TIMER) !== NO_TIMER;
  }

  forget(boxId: string): void {
    const box = this.#boxes.get(boxId);
    if (!box) return;
    this.#stopTimer(box);
    this.#boxes.delete(boxId);
    if (box.shape === "arrow") return;
    box.shape = "arrow";
    this.#deps.send(boxId, this.#message(box));
  }

  dispose(): void {
    for (const box of this.#boxes.values()) this.#stopTimer(box);
    this.#boxes.clear();
  }

  #publish(boxId: string, box: BoxShape): void {
    this.#stopTimer(box);
    const now = this.#deps.now();
    const { shape, changesAt } = box.live.now(now);
    if (shape !== box.shape) {
      box.shape = shape;
      this.#deps.send(boxId, this.#message(box));
    }
    if (changesAt === null) return;
    box.timer = this.#deps.schedule(() => {
      box.timer = NO_TIMER;
      if (this.#boxes.get(boxId) === box) this.#publish(boxId, box);
    }, Math.max(LEAST_TIMER_MS, (changesAt - now) * 1000));
  }

  #stopTimer(box: BoxShape): void {
    if (box.timer === NO_TIMER) return;
    this.#deps.cancel(box.timer);
    box.timer = NO_TIMER;
  }

  #message(box: BoxShape): string {
    return agentMessage({ act: "shape", x: box.x, y: box.y, shape: box.shape });
  }
}
