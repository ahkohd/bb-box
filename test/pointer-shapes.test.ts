import "./check-test-machine.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";
import { agentMessage, agentPlaceOf } from "../src/core/pointer.ts";
import { LiveShape, SHAPE_HOLD_S, TYPING_TAIL_S, clickHeld, clickShape, resolveShapes, shapeAt, typingHeld, typingShape, type LiveAct } from "../src/core/pointer-shapes.ts";

test("a click on a link or button is a hand, on a text field an I-beam, and on an element of a role not known the arrow (105)", () => {
  for (const role of ["link", "AXLink", "push button", "button", "AXButton", "toggle button"]) assert.equal(clickShape(role), "hand", role);
  for (const role of ["text", "entry", "textbox", "AXTextField", "editable text", "searchbox"]) assert.equal(clickShape(role), "ibeam", role);
  for (const role of [null, undefined, "", "heading", "list item", "static", "document web", "frame"]) assert.equal(clickShape(role), "arrow", String(role));
});

test("typing is an I-beam only into a known text field, and never for a secret (105)", () => {
  assert.equal(typingShape({ characters: 8, secret: false, role: "text" }), "ibeam");
  assert.equal(typingShape({ characters: 8, secret: false, role: "AXTextField" }), "ibeam");
  assert.equal(typingShape({ characters: 8, secret: true, role: "text" }), "arrow");
  assert.equal(typingShape({ characters: 8, secret: false, role: null }), "arrow");
  assert.equal(typingShape({ characters: 8, secret: false, role: "push button" }), "arrow");
  assert.equal(typingShape({ characters: 0, secret: false, role: "text" }), "arrow");
});

test("each shape is held as long live as in a recording: a hand 0.3 s, an I-beam until the pointer moves, and typing 1 s after it ends (105)", () => {
  const hand = resolveShapes([clickHeld("hand", 1, 1)!], 10);
  assert.equal(shapeAt(hand, 1 + SHAPE_HOLD_S - 0.01), "hand");
  assert.equal(shapeAt(hand, 1 + SHAPE_HOLD_S + 0.01), "arrow");
  const field = resolveShapes([clickHeld("ibeam", 1, 4)!], 10);
  assert.equal(shapeAt(field, 3.9), "ibeam");
  assert.equal(shapeAt(field, 4.1), "arrow");
  const typed = resolveShapes([typingHeld(2, 3)], 10);
  assert.equal(shapeAt(typed, 1.9), "arrow");
  assert.equal(shapeAt(typed, 3 + TYPING_TAIL_S - 0.01), "ibeam");
  assert.equal(shapeAt(typed, 3 + TYPING_TAIL_S + 0.01), "arrow");
  assert.equal(TYPING_TAIL_S, 1);
  assert.equal(clickHeld("arrow", 1, 4), null);
});

type Timed = readonly [number, LiveAct];

function liveShapes(acts: readonly Timed[], times: readonly number[]): string[] {
  const live = new LiveShape(0);
  let next = 0;
  return times.map((t) => {
    while (next < acts.length && acts[next]![0] <= t) {
      const [at, act] = acts[next++]!;
      live.act(act, at);
    }
    return live.now(t).shape;
  });
}

const BETWEEN_MARKS_S = 0.005;

function sampleTimes(until: number): number[] {
  return Array.from({ length: Math.round(until / 0.01) }, (_, step) => step * 0.01 + BETWEEN_MARKS_S);
}

test("the live shape, worked out as actions come, is the shape recordings work out from the whole history (105)", () => {
  const acts: Timed[] = [
    [0.6, { act: "click", x: 10, y: 20, shape: "ibeam" }],
    [0.85, { act: "scroll", x: 20, y: 20 }],
    [1.1, { act: "typing", x: 20, y: 20 }],
    [1.2, { act: "click", x: 30, y: 20, shape: "hand" }],
    [1.9, { act: "click", x: 40, y: 20, shape: "hand" }],
  ];
  const whole = resolveShapes([clickHeld("ibeam", 0.6, 0.85)!, typingHeld(1.1, Infinity), clickHeld("hand", 1.2, 1.2)!, clickHeld("hand", 1.9, 1.9)!].map((request) => ({ ...request, to: Math.min(request.to, 4) })), 4);
  const times = sampleTimes(4);
  assert.deepEqual(liveShapes(acts, times), times.map((t) => shapeAt(whole, t)));
  const [atTwoQuarter] = liveShapes(acts, [2.25]);
  assert.equal(atTwoQuarter, "ibeam");
});

test("2,000 clicks on a text field at one place keep the live shape's state the same size (105)", () => {
  const live = new LiveShape(0);
  const kept: number[] = [];
  for (let click = 0; click < 2_000; click++) {
    live.act({ act: "click", x: 10, y: 20, shape: "ibeam" }, click * 0.05);
    kept.push(live.holdsKept);
  }
  assert.ok(Math.max(...kept) <= 1, `holds kept: ${Math.max(...kept)}`);
  assert.equal(live.now(200).shape, "ibeam");
  for (let click = 0; click < 2_000; click++) live.act({ act: "click", x: 10 + (click % 2), y: 20, shape: click % 3 ? "hand" : "ibeam" }, 200 + click * 0.01);
  assert.ok(live.holdsKept <= 3, `holds kept: ${live.holdsKept}`);
});

test("the agent's shape message names a place and a shape, and nothing else (105)", () => {
  assert.equal(agentMessage({ act: "shape", x: 640.4, y: 360, shape: "hand" }), "BB_AGENT,shape,640,360,hand");
  assert.equal(agentMessage({ act: "click", x: 640, y: 360 }), "BB_AGENT,click,640,360");
  assert.deepEqual(agentPlaceOf("shape,640,360,ibeam"), { act: "shape", x: 640, y: 360, shape: "ibeam" });
  assert.deepEqual(agentPlaceOf("shape,640,360,arrow"), { act: "shape", x: 640, y: 360, shape: "arrow" });
  for (const rest of ["shape,640,360", "shape,640,360,grab", "shape,640,360,hand,300", "nope,640,360"]) assert.equal(agentPlaceOf(rest), null, rest);
});

test("the forms of earlier versions give the place and the arrow, never a shape held of their own (105)", () => {
  assert.deepEqual(agentPlaceOf("click,640,360,hand"), { act: "click", x: 640, y: 360 });
  assert.deepEqual(agentPlaceOf("scroll,640,360,hand"), { act: "scroll", x: 640, y: 360 });
  for (const rest of ["held,10,20,ibeam,100", "held,10,20,hand,100,300", "typing,10,20,1500,2000", "typing,10,20", "typed,10,20"]) assert.deepEqual(agentPlaceOf(rest), { act: "at", x: 10, y: 20 }, rest);
});

test("a place that is not a whole screen pixel is refused (105)", () => {
  for (const bad of ["-1", "1.5", "1e3", "NaN", "Infinity", "", " 5", "0x10", "9".repeat(400), "123456"]) {
    assert.equal(agentPlaceOf(`click,${bad},360`), null, `x ${bad}`);
    assert.equal(agentPlaceOf(`shape,640,${bad},hand`), null, `y ${bad}`);
  }
  assert.deepEqual(agentPlaceOf("at,0,99999"), { act: "at", x: 0, y: 99999 });
});
