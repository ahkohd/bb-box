import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DeviceStage, TURN_MS } from "../src/app/device-stage.ts";
import type { DeviceState, Orientation } from "../src/core/device.ts";

const UPRIGHT = { width: 1206, height: 2622 };
const SIDEWAYS = { width: 2622, height: 1206 };
const UNREAD = { known: false, why: "" } as const;

function state(generation: number, physical: Orientation, content: Orientation, video: { width: number; height: number }): DeviceState {
  return {
    platform: "ios",
    model: "iPhone 18 Pro",
    power: { is: "booted", awake: true },
    geometry: { generation, physical, content, video },
    settings: { appearance: UNREAD, textSize: UNREAD, location: { set: null, at: null }, statusBar: { set: null, at: null } },
    at: 0,
  };
}

const picture = () => document.createElement("canvas");

describe("the device stage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("holds the old picture through a turn, and shows the first frame of the new generation when the turn ends", () => {
    const stage = new DeviceStage(document.createElement("canvas"), "iPhone 18 Pro");
    stage.setState(state(1, "upright", "upright", UPRIGHT));
    expect(stage.paint(picture(), UPRIGHT.width, UPRIGHT.height, 1)).toBe(true);
    stage.setState(state(2, "turned-left", "turned-left", SIDEWAYS));
    expect(stage.holding).toBe(true);
    expect(stage.paint(picture(), UPRIGHT.width, UPRIGHT.height, 1)).toBe(false);
    expect(stage.paint(picture(), SIDEWAYS.width, SIDEWAYS.height, 2)).toBe(false);
    expect(stage.shownGeneration).toBe(1);
    vi.advanceTimersByTime(TURN_MS);
    expect(stage.holding).toBe(false);
    expect(stage.shownGeneration).toBe(2);
    stage.dispose();
  });

  test("veils a turned picture whose new frame is late, and shows that frame at once when it comes", () => {
    const stage = new DeviceStage(document.createElement("canvas"), "iPhone 18 Pro");
    stage.setState(state(1, "upright", "upright", UPRIGHT));
    stage.paint(picture(), UPRIGHT.width, UPRIGHT.height, 1);
    stage.setState(state(2, "turned-right", "turned-right", SIDEWAYS));
    vi.advanceTimersByTime(TURN_MS);
    expect(stage.times?.veiled).not.toBeNull();
    expect(stage.paint(picture(), SIDEWAYS.width, SIDEWAYS.height, 2)).toBe(true);
    expect(stage.holding).toBe(false);
    stage.dispose();
  });

  test("lets a turn finish when the device's new layout follows it, then shows that layout", () => {
    const stage = new DeviceStage(document.createElement("canvas"), "iPhone 18 Pro");
    stage.setState(state(1, "upright", "upright", UPRIGHT));
    stage.paint(picture(), UPRIGHT.width, UPRIGHT.height, 1);
    stage.setState(state(2, "turned-left", "upright", UPRIGHT));
    vi.advanceTimersByTime(50);
    stage.setState(state(3, "turned-left", "turned-left", SIDEWAYS));
    expect(stage.paint(picture(), SIDEWAYS.width, SIDEWAYS.height, 3)).toBe(false);
    vi.advanceTimersByTime(TURN_MS - 50);
    expect(stage.shownGeneration).toBe(3);
    stage.dispose();
  });

  test("shows a new generation with the same layout at once, and drops frames from before it", () => {
    const stage = new DeviceStage(document.createElement("canvas"), "iPhone 18 Pro");
    stage.setState(state(1, "upright", "upright", UPRIGHT));
    stage.paint(picture(), UPRIGHT.width, UPRIGHT.height, 1);
    stage.setState(state(2, "upright", "upright", UPRIGHT));
    expect(stage.holding).toBe(false);
    expect(stage.paint(picture(), UPRIGHT.width, UPRIGHT.height, 1)).toBe(false);
    expect(stage.paint(picture(), UPRIGHT.width, UPRIGHT.height, 2)).toBe(true);
    stage.dispose();
  });
});
