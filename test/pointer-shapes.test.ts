import "./check-test-machine.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";
import { agentMessage, agentPlaceOf } from "../src/core/pointer.ts";
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

test("a viewer that connects mid-shape is told the shape and what is left of its hold (105)", () => {
  const shapes = new ShapeTimeline(100);
  shapes.act({ act: "click", x: 10, y: 20, shape: "hand" }, 100);
  assert.deepEqual(shapes.replay(100.1), [{ act: "held", x: 10, y: 20, shape: "hand", forMs: 200 }]);
  assert.deepEqual(shapes.replay(100.4), []);

  shapes.act({ act: "click", x: 30, y: 40, shape: "ibeam" }, 101);
  assert.deepEqual(shapes.replay(150), [{ act: "held", x: 30, y: 40, shape: "ibeam" }], "an I-beam after a click on a text field lasts until the pointer moves");
  shapes.act({ act: "scroll", x: 50, y: 60 }, 151);
  assert.deepEqual(shapes.replay(151.1), []);

  shapes.act({ act: "typing", x: 50, y: 60 }, 160);
  assert.deepEqual(shapes.replay(170), [{ act: "typing", x: 50, y: 60 }]);
  shapes.act({ act: "typed", x: 50, y: 60 }, 172);
  const tail = shapes.replay(172.25);
  assert.equal(tail.length, 1);
  assert.equal(tail[0]!.act, "held");
  assert.equal(tail[0]!.shape, "ibeam");
  assert.ok(Math.abs(tail[0]!.forMs! - (TYPING_TAIL_S - 0.25) * 1000) < 2, String(tail[0]!.forMs));
  assert.deepEqual(shapes.replay(172 + TYPING_TAIL_S + 0.01), []);
});

test("a replayed hold ends when it says, not held to 0.3 s, and the arrow follows (105)", () => {
  const shapes = new ShapeTimeline(0);
  shapes.act({ act: "held", x: 10, y: 20, shape: "hand", forMs: 50 }, 0);
  assert.equal(shapes.now(0.04).shape, "hand");
  assert.equal(shapes.now(0.06).shape, "arrow");
  shapes.act({ act: "held", x: 10, y: 20, shape: "ibeam" }, 1);
  assert.equal(shapes.now(60).shape, "ibeam");
  assert.equal(shapes.now(60).changesAt, null);
  shapes.act({ act: "click", x: 90, y: 20 }, 61);
  assert.equal(shapes.now(61.31).shape, "arrow");
});

test("a held shape's message carries what is left of its hold, and none for one held until the pointer moves (105)", () => {
  assert.equal(agentMessage({ act: "held", x: 10, y: 20, shape: "hand", forMs: 199.6 }), "BB_AGENT,held,10,20,hand,200");
  assert.equal(agentMessage({ act: "held", x: 10, y: 20, shape: "ibeam" }), "BB_AGENT,held,10,20,ibeam");
  assert.deepEqual(agentPlaceOf("held,10,20,hand,200"), { act: "held", x: 10, y: 20, shape: "hand", forMs: 200 });
  assert.deepEqual(agentPlaceOf("held,10,20,ibeam"), { act: "held", x: 10, y: 20, shape: "ibeam" });
  assert.equal(agentPlaceOf("held,10,20"), null);
  assert.equal(agentPlaceOf("held,10,20,grab,100"), null);
});
