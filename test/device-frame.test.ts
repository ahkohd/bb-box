import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applied,
  frameShape,
  outerBounds,
  placement,
  screenOnStage,
  stageToVideo,
  turnsBetween,
  videoToStage,
  type FitRequest,
} from "../src/core/device-frame.ts";
import { clockwiseTurns, deviceModel, ORIENTATIONS, type Orientation } from "../src/core/device.ts";
import { clockwiseTurnedPixels, pngPixels, rgbaPng } from "../src/core/png.ts";
import { contentOrientation } from "../src/device/ios-driver.ts";

const PHONE = deviceModel("iPhone 18 Pro");
const FOLD = deviceModel("Pixel Fold");
const FIT: FitRequest = { area: { width: 800, height: 900 }, margin: 24, below: 0, pixelRatio: 2, pixelForPixel: false };
const UPRIGHT_VIDEO = { width: 1206, height: 2622 };
const SIDEWAYS_VIDEO = { width: 2622, height: 1206 };

function close(actual: { x: number; y: number }, expected: { x: number; y: number }): void {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-6 && Math.abs(actual.y - expected.y) < 1e-6, `${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`);
}

describe("the device frame's shape", () => {
  test("puts the screen inside the bezel, the island on the screen, and the buttons outside the body", () => {
    const shape = frameShape(PHONE, null, true);
    assert.deepEqual(shape.body, { width: 1206 + 108, height: 2622 + 108, radius: 240 });
    assert.deepEqual({ x: shape.screen.x, y: shape.screen.y, radius: shape.screen.radius }, { x: 54, y: 54, radius: 186 });
    assert.deepEqual(shape.cutout, { x: 54 + 461, y: 54 + 42, width: 284, height: 110, shape: "pill" });
    assert.ok(shape.buttons.every((button) => button.x + button.width <= 0 || button.x >= shape.body.width));
    const bounds = outerBounds(shape);
    assert.ok(bounds.x < 0 && bounds.width > shape.body.width);
  });

  test("without the frame is the screen alone, with its own corners and island", () => {
    const shape = frameShape(PHONE, null, false);
    assert.deepEqual(shape.body, { width: 1206, height: 2622, radius: 186 });
    assert.equal(shape.buttons.length, 0);
    assert.equal(shape.cutout?.x, 461);
  });

  test("draws a foldable closed on its outer screen, and open on its inner one with the crease down the hinge, shaded half open", () => {
    const closed = frameShape(FOLD, { screen: "outer", posture: "closed" }, true);
    assert.equal(closed.screen.width, 1080);
    assert.equal(closed.crease, null);
    const open = frameShape(FOLD, { screen: "inner", posture: "open" }, true);
    assert.equal(open.screen.width, 2208);
    assert.deepEqual(open.crease, { hinge: "vertical", at: 56 + 1104, shaded: false });
    assert.equal(frameShape(FOLD, { screen: "inner", posture: "half-open" }, true).crease?.shaded, true);
  });
});

describe("the frame's transform", () => {
  test("turns the shortest way, a half turn clockwise", () => {
    assert.equal(turnsBetween("upright", "turned-left"), -1);
    assert.equal(turnsBetween("turned-left", "upright"), 1);
    assert.equal(turnsBetween("turned-left", "turned-right"), 2);
    assert.equal(turnsBetween("upside-down", "upside-down"), 0);
  });

  test("never draws the screen larger than its own pixels, and Pixel for pixel draws it at them", () => {
    const shape = frameShape(PHONE, null, true);
    assert.ok(placement(shape, "upright", { ...FIT, area: { width: 4000, height: 4000 } }).scale <= 0.5);
    assert.equal(placement(shape, "upright", { ...FIT, pixelForPixel: true }).scale, 0.5);
    const fitted = placement(shape, "upright", FIT);
    assert.ok(fitted.scale < 0.5);
    assert.ok(outerBounds(shape).height * fitted.scale <= FIT.area.height - FIT.margin * 2 + 1e-9);
    const sideways = placement(shape, "turned-left", FIT);
    assert.ok(outerBounds(shape).height * sideways.scale <= FIT.area.width - FIT.margin * 2 + 1e-9);
  });

  test("maps every corner of the video to the device's matching corner, however it is held and drawn", () => {
    const shape = frameShape(PHONE, null, true);
    const cases: readonly [Orientation, Orientation, { width: number; height: number }][] = [
      ["upright", "upright", UPRIGHT_VIDEO],
      ["turned-left", "turned-left", SIDEWAYS_VIDEO],
      ["turned-right", "turned-right", SIDEWAYS_VIDEO],
      ["turned-left", "upright", UPRIGHT_VIDEO],
      ["upside-down", "upright", UPRIGHT_VIDEO],
      ["upside-down", "turned-right", SIDEWAYS_VIDEO],
    ];
    for (const [physical, content, video] of cases) {
      const place = placement(shape, physical, FIT);
      const toStage = videoToStage(shape, physical, content, video, place);
      const island = applied(toStage, contentPoint(content, video, { x: 603, y: 97 }));
      const screen = screenOnStage(shape, physical, place);
      const where = { left: island.x - screen.x < screen.width * 0.2, right: screen.x + screen.width - island.x < screen.width * 0.2, top: island.y - screen.y < screen.height * 0.2, bottom: screen.y + screen.height - island.y < screen.height * 0.2 };
      const expected = { upright: "top", "turned-left": "left", "turned-right": "right", "upside-down": "bottom" }[physical];
      assert.ok(where[expected as keyof typeof where], `${physical}, drawn ${content}: the island's pixel is not at the ${expected}: ${JSON.stringify({ island, screen })}`);
      for (const corner of [{ x: 0, y: 0 }, { x: video.width - 1, y: video.height - 1 }, { x: 100, y: 700 }]) {
        close(stageToVideo(shape, physical, content, video, place, applied(toStage, { x: corner.x + 0.5, y: corner.y + 0.5 }))!, corner);
      }
    }
  });

  test("refuses a point off the screen", () => {
    const shape = frameShape(PHONE, null, true);
    const place = placement(shape, "upright", FIT);
    assert.equal(stageToVideo(shape, "upright", "upright", UPRIGHT_VIDEO, place, { x: 1, y: 1 }), null);
  });
});

function contentPoint(content: Orientation, video: { width: number; height: number }, native: { x: number; y: number }): { x: number; y: number } {
  const turns = clockwiseTurns(content);
  const nativeSize = turns % 2 ? { width: video.height, height: video.width } : video;
  if (turns === 0) return native;
  if (turns === 1) return { x: nativeSize.height - native.y, y: native.x };
  if (turns === 2) return { x: nativeSize.width - native.x, y: nativeSize.height - native.y };
  return { x: native.y, y: nativeSize.width - native.x };
}

describe("iOS's content orientation", () => {
  test("follows a sideways picture to the side the device is held, and keeps the last side while it is upside down", () => {
    assert.equal(contentOrientation("turned-right", SIDEWAYS_VIDEO, PHONE), "turned-right");
    assert.equal(contentOrientation("turned-left", UPRIGHT_VIDEO, PHONE), "upright");
    assert.equal(contentOrientation("upside-down", SIDEWAYS_VIDEO, PHONE, "turned-right"), "turned-right");
    assert.equal(contentOrientation("upright", SIDEWAYS_VIDEO, PHONE), "turned-left");
    assert.equal(contentOrientation("upright", SIDEWAYS_VIDEO, PHONE, "turned-right"), "turned-right");
    assert.equal(contentOrientation("upside-down", UPRIGHT_VIDEO, PHONE), "upright");
    assert.equal(contentOrientation("upside-down", { width: 2064, height: 2752 }, deviceModel("iPad Pro 13-inch (M5)")), "upside-down");
    assert.deepEqual(ORIENTATIONS.map(clockwiseTurns), [0, 3, 2, 1]);
  });
});

describe("turning a screenshot", () => {
  test("reads a PNG back and turns it a quarter at a time", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255, 1, 2, 3, 255, 4, 5, 6, 255]);
    const pixels = pngPixels(rgbaPng(3, 2, rgba));
    assert.deepEqual({ width: pixels.width, height: pixels.height }, { width: 3, height: 2 });
    assert.deepEqual([...pixels.rgba], [...rgba]);
    const right = clockwiseTurnedPixels(pixels, 1);
    assert.deepEqual({ width: right.width, height: right.height }, { width: 2, height: 3 });
    assert.deepEqual([...right.rgba.subarray(0, 8)], [9, 9, 9, 255, 255, 0, 0, 255]);
    const back = clockwiseTurnedPixels(clockwiseTurnedPixels(right, 1), 2);
    assert.deepEqual([...back.rgba], [...rgba]);
  });
});
