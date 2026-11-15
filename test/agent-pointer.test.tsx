import "./check-test-machine.mjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentPointer } from "../src/app/agent-pointer.ts";

const PICTURE = { left: 0, top: 0, width: 960, height: 540, desktopWidth: 1920, desktopHeight: 1080 };

function watched(): { pointer: AgentPointer; shape: () => string | undefined; hotspot: () => [string, string] } {
  const container = document.createElement("div");
  const pointer = new AgentPointer(container);
  pointer.place(PICTURE, false);
  const shown = () => container.querySelector<HTMLElement>("[data-testid=agent-pointer]");
  const svg = () => shown()!.querySelector("svg")!;
  return { pointer, shape: () => shown()?.dataset.shape, hotspot: () => [svg().style.left, svg().style.top] };
}

describe("the agent's pointer on a Linux desktop (105)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
  afterEach(() => vi.useRealTimers());

  test("is a hand for 0.3 s after a click on a link or button, then the arrow", () => {
    const { pointer, shape, hotspot } = watched();
    pointer.message("BB_AGENT,click,640,360,hand");
    expect(shape()).toBe("hand");
    expect(hotspot()).toEqual(["-15.375px", "-6.875px"]);
    vi.advanceTimersByTime(290);
    expect(shape()).toBe("hand");
    vi.advanceTimersByTime(20);
    expect(shape()).toBe("arrow");
    expect(hotspot()).toEqual(["-10.5px", "-10.5px"]);
  });

  test("is an I-beam after a click on a text field until it moves, held at least 0.3 s", () => {
    const { pointer, shape } = watched();
    pointer.message("BB_AGENT,click,640,360,ibeam");
    vi.advanceTimersByTime(5_000);
    expect(shape()).toBe("ibeam");
    pointer.message("BB_AGENT,click,100,100");
    expect(shape()).toBe("arrow");
    pointer.message("BB_AGENT,click,640,360,ibeam");
    vi.advanceTimersByTime(100);
    pointer.message("BB_AGENT,scroll,300,300");
    expect(shape()).toBe("ibeam");
    vi.advanceTimersByTime(210);
    expect(shape()).toBe("arrow");
  });

  test("is an I-beam while the agent types into a text field and for 1 s after, then the arrow", () => {
    const { pointer, shape } = watched();
    pointer.message("BB_AGENT,at,640,360");
    expect(shape()).toBe("arrow");
    pointer.message("BB_AGENT,typing,640,360");
    expect(shape()).toBe("ibeam");
    vi.advanceTimersByTime(4_000);
    expect(shape()).toBe("ibeam");
    pointer.message("BB_AGENT,typed,640,360");
    vi.advanceTimersByTime(990);
    expect(shape()).toBe("ibeam");
    vi.advanceTimersByTime(20);
    expect(shape()).toBe("arrow");
  });

  test("is the arrow for a click whose element's role is not known, and for a shape it does not know", () => {
    const { pointer, shape } = watched();
    pointer.message("BB_AGENT,click,640,360");
    expect(shape()).toBe("arrow");
    pointer.message("BB_AGENT,click,650,360,grab");
    expect(shape()).toBe("arrow");
    vi.advanceTimersByTime(1_000);
    expect(shape()).toBe("arrow");
  });
});
