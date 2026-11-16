import "./check-test-machine.mjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentPointer } from "../src/app/agent-pointer.ts";

const PICTURE = { left: 0, top: 0, width: 960, height: 540, desktopWidth: 1920, desktopHeight: 1080 };

function watched() {
  const container = document.createElement("div");
  const pointer = new AgentPointer(container);
  pointer.place(PICTURE, false);
  const shown = () => container.querySelector<HTMLElement>("[data-testid=agent-pointer]");
  const svg = () => shown()!.querySelector("svg")!;
  return {
    pointer,
    shape: () => shown()?.dataset.shape,
    at: () => [shown()!.style.left, shown()!.style.top],
    hotspot: () => [svg().style.left, svg().style.top],
    rings: () => container.querySelectorAll("[data-testid=agent-ring]").length,
  };
}

describe("the agent's pointer on a Linux desktop (105)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
  afterEach(() => vi.useRealTimers());

  test("draws the shape the plugin tells it, with that shape's hotspot, and keeps it until told another", () => {
    const { pointer, shape, at, hotspot } = watched();
    pointer.message("BB_AGENT,click,640,360");
    expect(shape()).toBe("arrow");
    expect(hotspot()).toEqual(["-10.5px", "-10.5px"]);
    pointer.message("BB_AGENT,shape,640,360,hand");
    expect(shape()).toBe("hand");
    expect(hotspot()).toEqual(["-15.375px", "-6.875px"]);
    vi.advanceTimersByTime(60_000);
    expect(shape()).toBe("hand");
    pointer.message("BB_AGENT,shape,700,400,ibeam");
    expect(shape()).toBe("ibeam");
    expect(at()).toEqual(["350px", "200px"]);
    pointer.message("BB_AGENT,scroll,100,100");
    expect(shape()).toBe("ibeam");
    pointer.message("BB_AGENT,shape,100,100,arrow");
    expect(shape()).toBe("arrow");
  });

  test("reads an earlier version's shape forms as the place alone, with the arrow", () => {
    const { pointer, shape, at, rings } = watched();
    for (const message of ["BB_AGENT,click,640,360,hand", "BB_AGENT,held,640,360,ibeam,100", "BB_AGENT,held,640,360,hand,100,300", "BB_AGENT,typing,640,360,1500,2000", "BB_AGENT,typing,640,360", "BB_AGENT,typed,640,360"]) {
      expect(pointer.message(message)).toBe(true);
      expect(shape()).toBe("arrow");
      expect(at()).toEqual(["320px", "180px"]);
    }
    expect(rings()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(shape()).toBe("arrow");
  });

  test("ignores a place off the screen, or one that is not a whole pixel", () => {
    const { pointer, shape, at } = watched();
    pointer.message("BB_AGENT,shape,640,360,hand");
    for (const message of ["BB_AGENT,shape,1920,360,ibeam", "BB_AGENT,shape,640,1080,ibeam", `BB_AGENT,shape,${"9".repeat(400)},360,ibeam`, "BB_AGENT,shape,-1,360,ibeam", "BB_AGENT,click,64.5,360"]) {
      pointer.message(message);
      expect(shape()).toBe("hand");
      expect(at()).toEqual(["320px", "180px"]);
    }
  });
});

test("forgetting the agent removes its pointer and ring before the box pointer returns", () => {
  const container = document.createElement("div");
  const pointer = new AgentPointer(container);
  pointer.place(PICTURE, false);
  pointer.message("BB_AGENT,click,640,360");
  pointer.message("BB_AGENT,clear");
  expect(container.querySelector<HTMLElement>("[data-testid=agent-pointer]")?.style.display).toBe("none");
  expect(container.querySelector("[data-testid=agent-ring]")).toBeNull();
  expect(pointer.active).toBe(false);
});
