import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { STEP_ROWS_SHOWN, VIDEO_SHARE_LEAST, previewFrameHeight, recordPage, type Chapter } from "../src/core/record.ts";
import { tempDir } from "./helpers.ts";

const CHROMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
const chrome = CHROMES.find((name) => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0) ?? null;
const skip = chrome ? false : "needs Chrome or Chromium";

const PHONE_CLIP = "1080x1600";
const DESKTOP_CLIP = "1280x834";

interface Measured {
  readonly dark: boolean;
  readonly viewport: number;
  readonly video: number;
  readonly list: { readonly shown: number; readonly whole: number; readonly scrolls: boolean };
  readonly page: number;
}

function steps(count: number): Chapter[] {
  return Array.from({ length: count }, (_, index) => ({ at: index * 2, real: index * 5, text: `It checks step ${index + 1} of the run`, result: { passed: index % 3 !== 2, text: `Step ${index + 1} shows what it should` } }));
}

const MEASURE = `<script>addEventListener("load", () => {
  const list = document.querySelector("ol");
  document.title = JSON.stringify({
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    viewport: innerHeight,
    video: document.querySelector("video").getBoundingClientRect().height,
    list: list ? { shown: list.clientHeight, whole: list.scrollHeight, scrolls: getComputedStyle(list).overflowY === "auto" } : { shown: 0, whole: 0, scrolls: false },
    page: document.documentElement.scrollHeight,
  });
});</script>`;

function measure(size: string, count: number, width: number, dark: boolean): Measured {
  const folder = tempDir("record-page");
  const page = join(folder, "clip.html");
  writeFileSync(page, recordPage("Box a", "clip.mp4", steps(count)).replace("</body>", `${MEASURE}</body>`));
  const height = previewFrameHeight(size, count);
  const flags = ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=2000", `--window-size=${width},${height}`, ...(dark ? ["--force-dark-mode", "--blink-settings=preferredColorScheme=0"] : []), "--dump-dom", `file://${page}`];
  const run = spawnSync(chrome!, flags, { encoding: "utf8", timeout: 60_000 });
  const title = /<title>(\{.*\})<\/title>/.exec(run.stdout)?.[1];
  assert.ok(title, `Chrome measured nothing: ${run.stderr.slice(-400)}`);
  return JSON.parse(title.replace(/&quot;/g, '"')) as Measured;
}

for (const dark of [false, true]) {
  for (const width of [360, 640]) {
    test(`a phone's clip with 20 steps keeps its video and scrolls its steps, ${width} px wide, ${dark ? "dark" : "light"} (059)`, { skip, timeout: 120_000 }, () => {
      const many = measure(PHONE_CLIP, 20, width, dark);

      assert.equal(many.dark, dark, "the colour scheme asked for");
      assert.ok(many.video >= many.viewport * (VIDEO_SHARE_LEAST / 100) - 1, `the video keeps at least ${VIDEO_SHARE_LEAST}% of the frame: ${many.video} of ${many.viewport} px`);
      assert.ok(many.list.scrolls && many.list.whole > many.list.shown, `the steps scroll: ${many.list.shown} of ${many.list.whole} px shown`);
      assert.ok(many.page <= many.viewport + 1, `the page fits its frame: ${many.page} of ${many.viewport} px`);

      const two = measure(PHONE_CLIP, 2, width, dark);

      assert.ok(two.list.whole <= two.list.shown + 1, "two steps show whole");
      assert.ok(two.video >= two.viewport - two.list.shown - 1, "and the video takes the rest");
    });
  }
}

test("a phone's preview is capped to a screen's height, steps past four scroll, and a desktop's keeps its height (059)", () => {
  assert.equal(previewFrameHeight(PHONE_CLIP, 0), 568);
  assert.equal(previewFrameHeight(PHONE_CLIP, 2), 568 + 16 + 2 * 46);
  assert.equal(previewFrameHeight(PHONE_CLIP, 20), 568 + 16 + STEP_ROWS_SHOWN * 46);
  assert.equal(previewFrameHeight(DESKTOP_CLIP, 2), 425 + 16 + 2 * 46);
});
