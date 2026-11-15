import "./check-test-machine.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";
import { agentMessage, agentPlaceOf, type AgentPlace } from "../src/core/pointer.ts";
import { SHAPE_HOLD_S, ShapeTimeline, TYPING_TAIL_S, clickHeld, clickShape, resolveShapes, shapeAt, typingHeld, typingShape } from "../src/core/pointer-shapes.ts";

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

test("the agent's place carries a click's shape, and the typing it shows an I-beam for (105)", () => {
  assert.equal(agentMessage({ act: "click", x: 640.4, y: 360, shape: "hand" }), "BB_AGENT,click,640,360,hand");
  assert.equal(agentMessage({ act: "click", x: 640, y: 360 }), "BB_AGENT,click,640,360");
  assert.equal(agentMessage({ act: "typing", x: 640, y: 360 }), "BB_AGENT,typing,640,360");
  assert.deepEqual(agentPlaceOf("click,640,360,ibeam"), { act: "click", x: 640, y: 360, shape: "ibeam" });
  assert.deepEqual(agentPlaceOf("click,640,360,grab"), { act: "click", x: 640, y: 360 });
  assert.deepEqual(agentPlaceOf("scroll,640,360,hand"), { act: "scroll", x: 640, y: 360 });
  assert.deepEqual(agentPlaceOf("typed,640,360"), { act: "typed", x: 640, y: 360 });
  assert.equal(agentPlaceOf("typing,x,360"), null);
});

type Act = readonly [number, AgentPlace];

function replica(original: ShapeTimeline, at: number): ShapeTimeline {
  const copy = new ShapeTimeline(at);
  const told = original.replay(at).map((place) => agentPlaceOf(agentMessage(place).slice("BB_AGENT,".length))!);
  for (const place of told) copy.act(place, at);
  return copy;
}

function assertConverges(acts: readonly Act[], connectAt: number, until: number): ShapeTimeline {
  const original = new ShapeTimeline(0);
  const earlier = acts.filter(([at]) => at <= connectAt);
  const later = acts.filter(([at]) => at > connectAt);
  for (const [at, place] of earlier) original.act(place, at);
  const copy = replica(original, connectAt);
  let next = 0;
  const betweenMarks = 0.005;
  for (let step = 0; connectAt + betweenMarks + step * 0.01 <= until; step++) {
    const t = connectAt + betweenMarks + step * 0.01;
    while (next < later.length && later[next]![0] <= t) {
      const [at, place] = later[next++]!;
      original.act(place, at);
      copy.act(place, at);
    }
    assert.equal(copy.now(t).shape, original.now(t).shape, `at ${t.toFixed(2)} s`);
  }
  return copy;
}

test("a viewer that connects behind a hold sees the shape pending after it, as one connected all along does (105)", () => {
  const copy = assertConverges(
    [
      [0, { act: "click", x: 10, y: 20, shape: "hand" }],
      [0.1, { act: "click", x: 30, y: 40, shape: "ibeam" }],
    ],
    0.15,
    3,
  );
  assert.equal(copy.now(0.5).shape, "ibeam");
});

test("a viewer that connects mid-shape converges on the shapes of one connected all along (105)", () => {
  const typing: Act[] = [
    [0, { act: "click", x: 10, y: 20, shape: "ibeam" }],
    [0.5, { act: "typing", x: 10, y: 20 }],
    [3, { act: "typed", x: 10, y: 20 }],
    [3.2, { act: "click", x: 50, y: 60, shape: "hand" }],
    [5, { act: "scroll", x: 70, y: 80 }],
  ];
  for (const connectAt of [0.1, 0.4, 1, 3.1, 3.3, 3.9, 4.5]) assertConverges(typing, connectAt, 7);
  const quick: Act[] = [
    [0, { act: "click", x: 10, y: 20, shape: "ibeam" }],
    [0.2, { act: "scroll", x: 30, y: 40 }],
    [0.25, { act: "click", x: 50, y: 60, shape: "hand" }],
  ];
  for (const connectAt of [0.05, 0.22, 0.4, 0.6]) assertConverges(quick, connectAt, 2);
});

test("a hold already over at the connection shows no shape (105)", () => {
  const original = new ShapeTimeline(0);
  original.act({ act: "click", x: 10, y: 20, shape: "hand" }, 0);
  assert.equal(replica(original, 0.31).now(0.31).shape, "arrow");
  assert.equal(replica(original, 0.2).now(0.2).shape, "hand");
  assert.equal(replica(original, 0.2).now(0.31).shape, "arrow");
});

test("a held shape's message says how long ago it began and how long it lasts, or nothing for one held until the pointer moves (105)", () => {
  assert.equal(agentMessage({ act: "held", x: 10, y: 20, shape: "hand", agoMs: 99.6, forMs: 300 }), "BB_AGENT,held,10,20,hand,100,300");
  assert.equal(agentMessage({ act: "held", x: 10, y: 20, shape: "ibeam", agoMs: 50 }), "BB_AGENT,held,10,20,ibeam,50");
  assert.equal(agentMessage({ act: "typing", x: 10, y: 20, agoMs: 1500 }), "BB_AGENT,typing,10,20,1500");
  assert.deepEqual(agentPlaceOf("held,10,20,hand,100,300"), { act: "held", x: 10, y: 20, shape: "hand", agoMs: 100, forMs: 300 });
  assert.deepEqual(agentPlaceOf("held,10,20,ibeam,50"), { act: "held", x: 10, y: 20, shape: "ibeam", agoMs: 50 });
  assert.deepEqual(agentPlaceOf("typing,10,20,1500,2000"), { act: "typing", x: 10, y: 20, agoMs: 1500, forMs: 2000 });
  assert.deepEqual(agentPlaceOf("typing,10,20"), { act: "typing", x: 10, y: 20 });
});

test("a held shape with a duration that is not a whole number of milliseconds is refused, not held until the pointer moves (105)", () => {
  for (const rest of ["held,10,20", "held,10,20,ibeam", "held,10,20,grab,0,100", "held,10,20,hand,0", "held,10,20,ibeam,0,1,2"]) assert.equal(agentPlaceOf(rest), null, rest);
  for (const bad of ["NaN", "Infinity", "-1", "1.5", "1e3", "", " 5", "abc"]) {
    assert.equal(agentPlaceOf(`held,10,20,ibeam,${bad}`), null, `ago ${bad}`);
    assert.equal(agentPlaceOf(`held,10,20,ibeam,0,${bad}`), null, `for ${bad}`);
    assert.equal(agentPlaceOf(`typing,10,20,${bad}`), null, `typing ago ${bad}`);
    assert.equal(agentPlaceOf(`typing,10,20,0,${bad}`), null, `typing for ${bad}`);
  }
});
