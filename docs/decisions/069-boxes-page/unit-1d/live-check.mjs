import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { boxes, expect, heading, home, makeReport, pathOf, pause, rpc, skipSetup, waitFor } from "./live-lib.mjs";

const label = process.argv[2] ?? "run";
const { line, check, results } = makeReport(label);
const SEARCH = "docker";
const SORT_WORDS = "Sort: Created, descending";
const LIST_PATHS = ["/plugins/bb-box/desktop", "/plugins/bb-box/desktop/threads", "/plugins/bb-box/desktop/machines"];

const all = await rpc("allBoxes");
const threadBoxes = all.filter((entry) => entry.owner !== "yours" && entry.box.state !== "releasing");
const stopped = threadBoxes.find((entry) => entry.box.state === "stopped");
if (!stopped) {
  const first = threadBoxes.find((entry) => entry.box.state === "ready");
  await rpc("stop", { threadId: first.threadId, box: first.box.id });
  line(`Stopped ${first.box.name}, so the Ready filter leaves it out.`);
}
line(`Thread boxes: ${threadBoxes.map((entry) => `${entry.box.name} (${entry.box.state})`).join(", ")}.`);
line("");

const browser = await chromium.launch();
const statePath = join(home, "live", "state.json");
const context = await browser.newContext({ viewport: { width: 1440, height: 640 }, ...(existsSync(statePath) ? { storageState: statePath } : {}) });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
await skipSetup(page);
await context.storageState({ path: statePath });

const shotsDir = process.env.LIVE_SHOTS ? join(home, "live-results", "shots") : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const rowOf = (id) => page.locator("[data-resource-row]").filter({ has: page.locator(`[data-row-name="${id}"]`) });
const nameOf = (id) => page.locator(`[data-row-name="${id}"]`);

async function listShown() {
  await page.locator("[data-row-name]").first().waitFor();
  return page.evaluate(() => {
    const names = Array.from(document.querySelectorAll("[data-row-name]"));
    const scroller = names[0]?.closest(".overflow-y-auto") ?? null;
    const search = document.querySelector('input[aria-label="Search boxes"]');
    const box = scroller?.getBoundingClientRect();
    return {
      ids: names.map((name) => name.getAttribute("data-row-name")),
      labels: names.map((name) => name.getAttribute("aria-label")),
      scrollTop: scroller?.scrollTop ?? null,
      scrollRoom: scroller ? scroller.scrollHeight - scroller.clientHeight : null,
      searchTop: search?.getBoundingClientRect().top ?? null,
      searchInScroller: scroller && search ? scroller.contains(search) : null,
      focused: document.activeElement?.getAttribute("data-row-name") ?? null,
      visible: box ? names.filter((name) => {
        const rect = name.closest("[data-resource-row]").getBoundingClientRect();
        return rect.top >= box.top && rect.bottom <= box.bottom;
      }).map((name) => name.getAttribute("data-row-name")) : [],
    };
  });
}

async function openList() {
  await page.goto(boxes);
  const skip = page.getByText("Skip setup");
  if (await skip.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
    await skip.click();
    await pause(1500);
    await context.storageState({ path: statePath });
    await page.goto(boxes);
  }
}

async function setPlace() {
  await openList();
  await page.getByRole("tab", { name: /^Threads/ }).click();
  const search = page.getByRole("textbox", { name: "Search boxes" });
  await search.fill(SEARCH);
  await page.getByRole("button", { name: "Filters" }).click();
  const ready = page.getByRole("menuitemcheckbox", { name: /^Ready/ });
  if ((await ready.getAttribute("aria-checked")) !== "true") await ready.click();
  await page.keyboard.press("Escape");
  const sort = page.getByRole("button", { name: /^Sort: / });
  for (let tries = 0; tries < 4 && (await sort.getAttribute("aria-label")) !== SORT_WORDS; tries++) {
    await sort.click();
    await page.getByRole("menuitem", { name: "Created" }).click();
    await pause(150);
  }
  expect((await sort.getAttribute("aria-label")) === SORT_WORDS, "the sort did not reach Created, descending");
}

async function scrollToMiddle() {
  const shown = await listShown();
  expect(shown.scrollRoom > 40, `the list does not scroll (room ${shown.scrollRoom} px)`);
  await page.evaluate((top) => {
    document.querySelector("[data-row-name]").closest(".overflow-y-auto").scrollTop = top;
  }, Math.round(shown.scrollRoom / 2));
  await waitFor(async () => (await listShown()).scrollTop > 0, "the list to scroll");
  await pause(200);
  return listShown();
}

async function keptCheck(target, before) {
  await waitFor(async () => LIST_PATHS.includes(pathOf(page)), "the list's path", 20_000);
  await waitFor(async () => (await listShown()).focused === target.id, `focus on ${target.name}'s name`, 10_000);
  const after = await listShown();
  const search = await page.getByRole("textbox", { name: "Search boxes" }).inputValue();
  const filtered = ((await page.getByRole("button", { name: "Filters" }).getAttribute("class")) ?? "").includes("bg-state-active");
  const sorted = (await page.getByRole("button", { name: /^Sort: / }).getAttribute("aria-label")) === SORT_WORDS;
  const tab = (await page.getByRole("tab", { name: /^Threads/ }).getAttribute("aria-selected")) === "true";
  expect(search === SEARCH, `search is "${search}"`);
  expect(filtered, "the Ready filter is not kept");
  expect(sorted, "the sort is not kept");
  expect(tab, "the Threads tab is not kept");
  expect(JSON.stringify(after.ids) === JSON.stringify(before.ids), `the rows differ: ${after.labels.join(", ")}`);
  expect(Math.abs(after.scrollTop - before.scrollTop) <= 2, `scroll ${after.scrollTop}, was ${before.scrollTop}`);
  expect(after.searchTop === before.searchTop && after.searchInScroller === false, "the search row moved or scrolls with the rows");
  return `kept: search, Ready, ${SORT_WORDS.slice(6)}, Threads, scroll ${after.scrollTop} of ${after.scrollRoom} px; focus on ${target.name}`;
}

async function viewShown() {
  await waitFor(async () => pathOf(page).endsWith("/terminal/from-list"), "the terminal view");
  await page.getByRole("button", { name: "Back to boxes", exact: true }).waitFor();
}

const OPEN = {
  async name(target) {
    await nameOf(target.id).click();
    await heading(page);
    return "page";
  },
  async chevron(target) {
    await rowOf(target.id).locator("[data-row-action] > a").last().click();
    await heading(page);
    return "page";
  },
  async "quick icon"(target) {
    await rowOf(target.id).getByRole("button", { name: "Open terminal" }).click();
    await viewShown();
    return "view";
  },
  async menu(target) {
    await rowOf(target.id).getByRole("button", { name: `${target.name} actions` }).click();
    await page.getByRole("menuitem", { name: "Open terminal" }).click();
    await viewShown();
    return "view";
  },
};

const trail = () => page.getByRole("navigation", { name: "Where you are" }).getByRole("button", { name: "Back to boxes" });

const BACK = {
  async trail(target, at) {
    if (at === "view") {
      await page.getByRole("link", { name: target.name, exact: true }).click();
      await heading(page);
      expect(pathOf(page) === `/plugins/bb-box/desktop/box/${target.id}/from-list`, `the view's name led to ${pathOf(page)}`);
    }
    await trail().click();
  },
  async "browser Back"() {
    await page.goBack();
  },
  async "view's back"(target, at) {
    if (at === "page") {
      await page.getByRole("link", { name: "Terminal", exact: true }).click();
      await waitFor(async () => pathOf(page).endsWith("/terminal/from-box/from-list"), "the terminal from the page");
      await page.getByRole("button", { name: `Back to ${target.name}`, exact: true }).click();
      await heading(page);
      await trail().click();
      return;
    }
    await page.getByRole("button", { name: "Back to boxes", exact: true }).click();
  },
};

async function pickTarget(shown, turn) {
  const choices = shown.visible.filter((id) => id !== shown.ids.at(-1));
  const id = choices[turn % choices.length];
  const label = shown.labels[shown.ids.indexOf(id)];
  return { id, name: label };
}

async function combos(width, height, pairs, tag) {
  await page.setViewportSize({ width, height });
  await setPlace();
  let before = await scrollToMiddle();
  let turn = 0;
  for (const [way, back] of pairs) {
    const target = await pickTarget(before, turn++);
    await check("G9", `${tag}: open ${target.name} by its ${way}, return by the ${back}`, async () => {
      const at = await OPEN[way](target);
      await BACK[back](target, at);
      return keptCheck(target, before);
    });
    before = await listShown();
    if (!LIST_PATHS.includes(pathOf(page))) {
      await setPlace();
      before = await scrollToMiddle();
    }
  }
}

const EVERY = Object.keys(OPEN).flatMap((way) => Object.keys(BACK).map((back) => [way, back]));
await combos(1440, 640, EVERY, "1440 px");

await check("G9", "1440 px: release a box from its page and return; focus on the row now in its place", async () => {
  const before = await listShown();
  const target = await pickTarget(before, 0);
  const next = before.ids[before.ids.indexOf(target.id) + 1];
  await nameOf(target.id).click();
  await heading(page);
  await page.getByRole("button", { name: `${target.name} actions` }).click();
  await page.getByRole("menuitem", { name: /^Release/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Release", exact: true }).click();
  await waitFor(async () => (await page.getByText(/was released|Released/).count()) > 0, "the page to say released", 120_000);
  await trail().click();
  await waitFor(async () => LIST_PATHS.includes(pathOf(page)), "the list");
  await waitFor(async () => {
    const shown = await listShown();
    return !shown.ids.includes(target.id) && shown.focused === next;
  }, `focus on the row after ${target.name}`, 30_000);
  const nextName = (await listShown()).labels[(await listShown()).ids.indexOf(next)];
  const threadId = all.find((entry) => entry.box.id === target.id)?.threadId;
  const made = execFileSync(join(home, "agent-call.sh"), [threadId, "box_acquire", '{"kind":"linux","memory_gib":2}'], { encoding: "utf8" });
  line(`  (A box for the next run: ${/Box ([a-z-]+)/.exec(made)?.[1] ?? made.trim()}.)`);
  return `${target.name} released and gone from the list; focus on ${nextName}, the row now in its place; search, filter and sort kept`;
});

const NARROW_SIZE = [390, 700];

const NARROW = [
  ["name", "trail"],
  ["chevron", "browser Back"],
  ["quick icon", "view's back"],
  ["menu", "browser Back"],
];
await combos(...NARROW_SIZE, NARROW, "390 px");

const focusedWords = () => page.evaluate(() => {
  const active = document.activeElement;
  return active?.getAttribute("aria-label") || active?.textContent?.trim().slice(0, 40) || active?.tagName || "";
});

await check("keyboard", "1440 px, keyboard only: Tab from the search reaches a row's name, Enter opens its page, Shift-Tab reaches the trail, Enter returns with focus on that name; Tab then reaches its actions, Enter on Open terminal, and the browser's Back returns to the name", async () => {
  await page.setViewportSize({ width: 1440, height: 640 });
  await setPlace();
  await page.getByRole("textbox", { name: "Search boxes" }).focus();
  const order = [];
  for (let presses = 0; presses < 30 && !(await listShown()).focused; presses++) {
    await page.keyboard.press("Tab");
    order.push(await focusedWords());
  }
  const first = (await listShown()).focused;
  expect(first, `no row name took focus after ${order.join(" > ")}`);
  const target = { id: first, name: await focusedWords() };
  await page.keyboard.press("Enter");
  await heading(page);
  expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-page-heading")), "the page's name did not take focus");
  await page.keyboard.press("Shift+Tab");
  expect((await focusedWords()) === "Back to boxes", `Shift-Tab reached ${await focusedWords()}`);
  await page.keyboard.press("Enter");
  await waitFor(async () => (await listShown()).focused === target.id, "focus on the name after the trail");
  await page.keyboard.press("Tab");
  const action = await focusedWords();
  expect(action === "Open terminal", `Tab after the name reached ${action}`);
  await page.keyboard.press("Enter");
  await viewShown();
  await page.goBack();
  await waitFor(async () => (await listShown()).focused === target.id, "focus on the name after Back");
  return `Tab order: ${order.join(" > ")}; then ${action}`;
});

if (shotsDir) {
  await page.setViewportSize({ width: 1440, height: 640 });
  await setPlace();
  await scrollToMiddle();
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const [width, height] of [
      [1440, 640],
      [760, 900],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await pause(300);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await page.screenshot({ path: join(shotsDir, `list-${width}-${theme}.png`) });
    }
  }
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 640 });
    await setPlace();
    const shown = await scrollToMiddle();
    const back = await pickTarget(shown, 2);
    await nameOf(back.id).focus();
    await page.keyboard.press("Enter");
    await heading(page);
    await page.screenshot({ path: join(shotsDir, `page-from-list-1440-${theme}.png`) });
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await listShown()).focused === back.id, "focus back");
    await page.screenshot({ path: join(shotsDir, `returned-1440-${theme}.png`) });
    await rowOf(back.id).hover({ position: { x: 400, y: 20 } });
    await pause(300);
    await page.screenshot({ path: join(shotsDir, `hover-1440-${theme}.png`) });
  }
}

const passed = results.filter((result) => result.ok).length;
line("");
line(`${passed} of ${results.length} checks passed.`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
