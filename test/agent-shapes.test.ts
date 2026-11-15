import "./check-test-machine.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentShapes } from "../src/core/agent-shapes.ts";
import { agentPlaceOf } from "../src/core/pointer.ts";
import type { LiveAct } from "../src/core/pointer-shapes.ts";

const BOX = "box-1";
const STEP_S = 0.01;

interface Timer {
  readonly at: number;
  readonly run: () => void;
  cancelled: boolean;
}

function world() {
  let now = 0;
  const timers: Timer[] = [];
  const sent: { at: number; message: string }[] = [];
  const shapes = new AgentShapes({
    now: () => now,
    schedule: (run, ms) => {
      const timer: Timer = { at: now + ms / 1000, run, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      (timer as Timer).cancelled = true;
    },
    send: (boxId, message) => {
      if (boxId === BOX) sent.push({ at: now, message });
    },
  });
  const pending = () => timers.filter((timer) => !timer.cancelled);
  const advance = (to: number) => {
    for (;;) {
      const due = pending()
        .filter((timer) => timer.at <= to)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      now = Math.max(now, due.at);
      due.run();
    }
    now = to;
  };
  return { shapes, sent, pending, advance, setNow: (to: number) => (now = to) };
}

function shapeOf(messages: readonly string[]): string {
  let shape = "arrow";
  for (const message of messages) {
    const place = agentPlaceOf(message.slice("BB_AGENT,".length));
    if (place?.act === "shape") shape = place.shape!;
  }
  return shape;
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function randomActs(next: () => number, count: number): [number, LiveAct][] {
  const acts: [number, LiveAct][] = [];
  let at = 0;
  let typing = false;
  for (let index = 0; index < count; index++) {
    at += Math.round((0.02 + next() * 0.6) * 100) / 100;
    const x = 10 * Math.floor(next() * 3);
    const roll = next();
    if (roll < 0.5) acts.push([at, { act: "click", x, y: 20, shape: (["arrow", "hand", "ibeam"] as const)[Math.floor(next() * 3)]! }]);
    else if (roll < 0.65) acts.push([at, { act: "scroll", x, y: 20 }]);
    else if (!typing) {
      acts.push([at, { act: "typing", x, y: 20 }]);
      typing = true;
    } else {
      acts.push([at, { act: "typed", x, y: 20 }]);
      typing = false;
    }
  }
  return acts;
}

test("a viewer that connects is shown the same shape as one watching all along, at every 10 ms, in random runs (105)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const next = random(seed);
    const acts = randomActs(next, 30);
    const end = acts.at(-1)![0] + 3;
    const connectAt = Math.round(next() * end * 100) / 100 + STEP_S / 2;
    const { shapes, sent, pending, advance, setNow } = world();
    let joined: string[] | null = null;
    let joinedFrom = 0;
    let index = 0;
    for (let step = 0; step * STEP_S <= end; step++) {
      const t = step * STEP_S;
      while (index < acts.length && acts[index]![0] <= t + 1e-9) {
        const [at, act] = acts[index++]!;
        advance(at);
        setNow(at);
        shapes.acted(BOX, act);
      }
      advance(t);
      if (joined === null && t >= connectAt) {
        joined = shapes.told(BOX);
        joinedFrom = sent.length;
      }
      if (joined !== null) {
        const watching = shapeOf(sent.map((each) => each.message));
        const connected = shapeOf([...joined, ...sent.slice(joinedFrom).map((each) => each.message)]);
        assert.equal(connected, watching, `seed ${seed} at ${t.toFixed(2)} s`);
      }
      assert.ok(pending().length <= 1, `seed ${seed}: ${pending().length} timers at ${t.toFixed(2)} s`);
    }
  }
});

test("a hold that ends is told to every viewer when it ends, by one timer (105)", () => {
  const { shapes, sent, pending, advance } = world();
  shapes.acted(BOX, { act: "click", x: 10, y: 20, shape: "hand" });
  assert.deepEqual(sent.map((each) => each.message), ["BB_AGENT,shape,10,20,hand"]);
  assert.equal(pending().length, 1);
  advance(0.29);
  assert.equal(sent.length, 1);
  advance(0.31);
  assert.deepEqual(sent.map((each) => [each.at, each.message]), [
    [0, "BB_AGENT,shape,10,20,hand"],
    [0.3, "BB_AGENT,shape,10,20,arrow"],
  ]);
  assert.equal(pending().length, 0);
});

test("forgetting a box, as at a take-over, cancels its timer, tells viewers the arrow, and keeps nothing to tell (105)", () => {
  const { shapes, sent, pending, advance } = world();
  shapes.acted(BOX, { act: "click", x: 10, y: 20, shape: "ibeam" });
  shapes.acted(BOX, { act: "click", x: 30, y: 20, shape: "hand" });
  assert.equal(pending().length, 1);
  assert.equal(shapes.pending(BOX), true);
  shapes.forget(BOX);
  assert.equal(pending().length, 0);
  assert.equal(shapes.pending(BOX), false);
  assert.equal(sent.at(-1)!.message, "BB_AGENT,shape,30,20,arrow");
  assert.deepEqual(shapes.told(BOX), []);
  const told = sent.length;
  advance(5);
  assert.equal(sent.length, told, "nothing more is told after it is forgotten");
});

test("stopping the plugin cancels every box's timer (105)", () => {
  const { shapes, pending } = world();
  shapes.acted(BOX, { act: "click", x: 10, y: 20, shape: "hand" });
  shapes.acted("box-2", { act: "click", x: 10, y: 20, shape: "hand" });
  assert.equal(pending().length, 2);
  shapes.dispose();
  assert.equal(pending().length, 0);
});
