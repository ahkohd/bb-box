import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { DatabaseSync } from "node:sqlite";
import {
  agentResult,
  agentStart,
  bb,
  bbMay,
  boxes,
  containerOf,
  docker,
  expect,
  flag,
  focusIsHeading,
  heading,
  historyLength,
  home,
  makeReport,
  menuItems,
  openBoxMenu,
  pathOf,
  pause,
  rpc,
  settingsUrl,
  skipSetup,
  waitFor,
} from "./live-lib.mjs";

const label = process.argv[2] ?? "run";
const only = new Set((process.env.LIVE_ONLY ?? "").split(",").filter(Boolean));
const thread = process.env.LIVE_THREAD;
const names = JSON.parse(process.env.LIVE_BOXES);
const { line, check, results } = makeReport(label);

async function idOf(name) {
  const all = await rpc("allBoxes");
  const entry = all.find((each) => each.box.name === name);
  if (entry) return entry.box.id;
  const { machines } = await rpc("machines.list");
  const machine = machines.find((each) => each.box.name === name);
  if (!machine) throw new Error(`no box ${name}`);
  return machine.box.id;
}

const A = { name: names.A, id: await idOf(names.A) };
const M = { name: names.M, id: await idOf(names.M) };
const D = { name: names.D, id: await idOf(names.D) };
const B = { name: names.B, id: await idOf(names.B) };
const F = { name: names.F, id: await idOf(names.F) };
line(`Boxes: ${[A, M, D, B, F].map((box) => `${box.name} (${box.id})`).join(", ")}; thread ${thread}.`);
line("");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: join(home, "live", "state.json") });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: process.env.LIVE_BASE ?? "http://127.0.0.1:7801" });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
await skipSetup(page);

const shotsDir = process.env.LIVE_SHOTS ? join(home, "live-results", "shots") : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const SIZES = [
  [1440, 1000],
  [760, 1000],
  [390, 844],
];
async function shoot(name) {
  if (!shotsDir) return;
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await pause(400);
      await page.screenshot({ path: join(shotsDir, `${name}-${width}-${theme}.png`) });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 1000 });
}

const pageUrl = (box, ...rest) => [boxes, "box", box.id, ...rest].join("/");
const goPage = async (box, ...rest) => {
  await page.goto(pageUrl(box, ...rest));
  await heading(page);
};
const atPath = (path) => waitFor(async () => pathOf(page) === path, `the path ${path}`, 15_000).then(() => true);
const boxPath = (box, ...rest) => ["/plugins/bb-box/desktop/box", box.id, ...rest].join("/");
const listPath = "/plugins/bb-box/desktop";
const dialog = () => page.getByRole("alertdialog");
const view = async (box) => (await rpc("boxPage", { box: box.id })).box;
const stateIs = (box, state) => waitFor(async () => (await view(box))?.state === state, `${box.name} ${state}`, 120_000);
const section = (name) => !only.size || only.has(name);

async function settle() {
  for (const name of ["stop-fails", "start-fails", "rm-fails"]) rmSync(join(home, "flags", name), { force: true });
  for (const box of [A, D, M]) {
    const now = await view(box);
    if (now?.state === "stopped") {
      if (box === M) await rpc("machines.start", { box: box.id });
      else await rpc("start", { threadId: thread, box: box.id });
    }
  }
}

async function threadsTab() {
  await page.goto(`${boxes}/threads`);
  await page.locator("[data-resource-row]", { hasText: A.name }).first().waitFor();
}

if (section("entries")) {
  await settle();
  line("## Entries");
  await check("entry", "a link opens the page, its name focused", async () => {
    await goPage(A);
    await waitFor(() => focusIsHeading(page), "focus on the name");
    expect((await (await heading(page)).textContent()).includes(A.name), "the name");
    await shoot("ready");
    return pathOf(page);
  });
  await check("entry", "the Box panel's Open on the Boxes page opens the page", async () => {
    await page.goto(`${process.env.LIVE_BASE ?? "http://127.0.0.1:7801"}/threads/${thread}`);
    await page.getByRole("button", { name: /right panel/ }).first().waitFor();
    if (await page.getByRole("button", { name: "Show right panel (Ctrl + J)" }).count()) await page.getByRole("button", { name: "Show right panel (Ctrl + J)" }).click();
    const actions = page.getByRole("button", { name: `${A.name} actions`, exact: true });
    if (!(await actions.count())) {
      await page.getByRole("button", { name: "Open new tab (Ctrl + T)" }).click();
      await page.getByText("Box", { exact: true }).first().click();
    }
    await actions.first().click();
    const items = await menuItems(page);
    expect(items.includes("Open on the Boxes page"), `items ${items.join(", ")}`);
    await page.getByRole("menuitem", { name: "Open on the Boxes page" }).click();
    await atPath(boxPath(A));
    await heading(page);
    return `menu: ${items.join(", ")}`;
  });
  await check("entry", "the Monitor's Open menu has Page first, which opens the page", async () => {
    await page.goto(`${boxes}/threads`);
    if (!(await page.getByRole("button", { name: "Machine", exact: true }).count())) await page.getByRole("button", { name: "Machine status" }).click();
    await page.getByRole("button", { name: "Machine", exact: true }).click();
    await page.getByRole("option").filter({ hasText: A.name }).first().click();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    const items = await menuItems(page);
    expect(items[0] === "Page", `items ${items.join(", ")}`);
    await page.getByRole("menuitem", { name: "Page" }).click();
    await atPath(boxPath(A));
    return `menu: ${items.join(", ")}`;
  });
  await check("entry", "the box's name in a view's bar opens its page, keeping the view's origin", async () => {
    await page.goto(pageUrl(A, "terminal", "from-list"));
    await page.getByRole("link", { name: A.name, exact: true }).waitFor();
    await shoot("view-bar");
    await page.getByRole("link", { name: A.name, exact: true }).click();
    await atPath(boxPath(A, "from-list"));
    await heading(page);
    return pathOf(page);
  });
  await check("entry", "an old path without from-settings: its back arrow goes to the box's page, replacing the view", async () => {
    await page.goto(`${boxes}/${thread}/${A.id}/terminal`);
    const back = page.getByRole("button", { name: `Back to ${A.name}` });
    await back.waitFor();
    const before = await historyLength(page);
    await back.click();
    await atPath(boxPath(A));
    expect((await historyLength(page)) === before, "a replace, not a push");
    return "replaced with the page";
  });
  await check("entry", "an old path with from-settings: its back arrow is a link to BB Box settings", async () => {
    await page.goto(`${boxes}/operator/${M.id}/terminal/from-settings`);
    const back = page.getByRole("link", { name: "Back to BB Box settings" });
    await back.waitFor();
    expect((await back.getAttribute("href")) === "/settings/plugins/bb-box", "its href");
    await back.click();
    await atPath("/settings/plugins/bb-box");
    return "settings";
  });
}

if (section("history")) {
  await settle();
  line("## Reload, back and forward, a new tab");
  await check("G8", "a reload keeps the page", async () => {
    await goPage(A);
    await page.reload();
    await heading(page);
    await waitFor(() => focusIsHeading(page), "focus on the name");
    return pathOf(page);
  });
  await check("G8", "page, Terminal, browser Back and Forward, then the view's back goes back in history", async () => {
    await goPage(A);
    const before = await historyLength(page);
    await page.getByRole("link", { name: "Terminal", exact: true }).click();
    await atPath(boxPath(A, "terminal", "from-box"));
    expect((await historyLength(page)) === before + 1, "one entry pushed");
    await page.goBack();
    await atPath(boxPath(A));
    await page.goForward();
    await atPath(boxPath(A, "terminal", "from-box"));
    await page.getByRole("button", { name: `Back to ${A.name}` }).click();
    await atPath(boxPath(A));
    expect((await historyLength(page)) === before + 1, "nothing pushed twice");
    await page.goForward();
    await atPath(boxPath(A, "terminal", "from-box"));
    return "Back, Forward and the back arrow agree";
  });
  await check("G8", "a reload on the view, then its back replaces with the page", async () => {
    await goPage(A);
    await page.getByRole("link", { name: "Terminal", exact: true }).click();
    await atPath(boxPath(A, "terminal", "from-box"));
    await page.reload();
    const back = page.getByRole("button", { name: `Back to ${A.name}` });
    await back.waitFor();
    const before = await historyLength(page);
    await back.click();
    await atPath(boxPath(A));
    expect((await historyLength(page)) === before, "a replace");
    await page.goBack();
    await atPath(boxPath(A));
    return "replaced, and Back goes to the page before the view";
  });
  await check("entry", "Control-click on a view opens it in a new tab, whose back replaces with the page", async () => {
    await goPage(A);
    const opened = context.waitForEvent("page");
    await page.getByRole("link", { name: "Terminal", exact: true }).click({ modifiers: ["Control"] });
    const tab = await opened;
    await tab.waitForLoadState();
    await waitFor(async () => pathOf(tab) === boxPath(A, "terminal", "from-box"), "the new tab's path");
    expect(pathOf(page) === boxPath(A), "the page stays");
    const back = tab.getByRole("button", { name: `Back to ${A.name}` });
    await back.waitFor({ timeout: 30_000 });
    await back.click();
    await waitFor(async () => pathOf(tab) === boxPath(A), "the new tab's page");
    await tab.close();
    return "new tab, then its page";
  });
}

if (section("g8")) {
  await settle();
  line("## G8, origin in the path");
  await check("G8", "a row's quick Terminal and back: the list, by going back", async () => {
    await threadsTab();
    const before = await historyLength(page);
    await page.locator("[data-resource-row]", { hasText: A.name }).first().getByRole("button", { name: "Open terminal" }).click();
    await atPath(boxPath(A, "terminal", "from-list"));
    await page.getByRole("button", { name: "Back to boxes" }).click();
    await waitFor(async () => pathOf(page).startsWith(listPath) && !pathOf(page).includes("/box/"), "the list");
    expect((await historyLength(page)) === before + 1, "back in history");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.slice(0, 40) ?? "");
    return `back at ${pathOf(page)}; focus on "${focused}" (focus on the row is unit 1d's G9)`;
  });
  await check("G8", "after visiting another box, a quick icon and back: the list", async () => {
    await goPage(D);
    await threadsTab();
    await page.locator("[data-resource-row]", { hasText: B.name }).first().getByRole("button", { name: "Open terminal" }).click();
    await atPath(boxPath(B, "terminal", "from-list"));
    await page.getByRole("button", { name: "Back to boxes" }).click();
    await waitFor(async () => !pathOf(page).includes("/box/"), "the list");
    return pathOf(page);
  });
  const settingsChain = async (reload) => {
    await page.goto(settingsUrl);
    await page.waitForTimeout(800);
    await goPage(M, "from-settings");
    await page.getByRole("link", { name: "Terminal", exact: true }).click();
    await atPath(boxPath(M, "terminal", "from-box", "from-settings"));
    if (reload) await page.reload();
    await page.getByRole("button", { name: `Back to ${M.name}` }).click();
    await atPath(boxPath(M, "from-settings"));
    const back = page.getByRole("navigation", { name: "Where you are" }).getByRole("link", { name: "Back to BB Box settings" });
    expect((await back.textContent()).includes("BB Box settings"), "the trail names settings");
    await back.click();
    await atPath("/settings/plugins/bb-box");
  };
  await check("G8", "settings, a machine's page, Terminal and back: the page, then settings", async () => {
    await settingsChain(false);
    return "page, then settings";
  });
  await check("G8", "the same after a reload on the view", async () => {
    await settingsChain(true);
    return "page, then settings";
  });
  await check("G8", "a page opened by URL, then Boxes, then browser Back does not return to the page", async () => {
    await threadsTab();
    await goPage(A);
    await page.getByRole("navigation", { name: "Where you are" }).getByRole("button", { name: "Back to boxes" }).click();
    await waitFor(async () => !pathOf(page).includes("/box/"), "the list");
    await page.goBack();
    await pause(800);
    expect(pathOf(page) !== boxPath(A), `Back went to ${pathOf(page)}`);
    return `Back went to ${pathOf(page)}`;
  });
  await check("G8", "a row's quick Terminal, a reload, then back: the list it names", async () => {
    await threadsTab();
    await page.locator("[data-resource-row]", { hasText: A.name }).first().getByRole("button", { name: "Open terminal" }).click();
    await atPath(boxPath(A, "terminal", "from-list"));
    await page.reload();
    await page.getByRole("button", { name: "Back to boxes" }).click();
    await waitFor(async () => !pathOf(page).includes("/box/"), "the list");
    return pathOf(page);
  });
}

if (section("keyboard")) {
  await settle();
  line("## Keyboard only");
  await check("keyboard", "Tab from the name, Shift-Tab to the trail, Enter on a view and back", async () => {
    await goPage(A);
    await waitFor(() => focusIsHeading(page), "focus on the name");
    const order = [];
    for (let step = 0; step < 9; step += 1) {
      await page.keyboard.press("Tab");
      order.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent?.trim().slice(0, 40)));
    }
    const at = (name) => order.findIndex((each) => each === name);
    expect(at("Box ID " + A.id + ": copy") === 0 && at("Copy link") === 1, `ID and link first: ${order.join(", ")}`);
    expect(at("CALL box_list") > at("Copy link") && at("CALL box_list") < at("Terminal"), `the thread before the views: ${order.join(", ")}`);
    expect(at("Terminal") < at("Stop") && at("Stop") < at(`${A.name} actions`), `views, Stop, the menu: ${order.join(", ")}`);
    await page.locator("h1[data-page-heading]").focus();
    await page.keyboard.press("Shift+Tab");
    const trail = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    expect(trail === "Back to boxes", `Shift-Tab reached ${trail}`);
    await page.locator("h1[data-page-heading]").focus();
    let shifts = [];
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Tab");
      if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Terminal") break;
    }
    await page.keyboard.press("Enter");
    await atPath(boxPath(A, "terminal", "from-box"));
    await page.getByText("Connected", { exact: true }).waitFor({ timeout: 30_000 }).catch(() => null);
    shifts = [];
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Shift+Tab");
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent?.trim().slice(0, 30));
      shifts.push(focused);
      if (focused === `Back to ${A.name}`) break;
    }
    const trapped = shifts.at(-1) !== `Back to ${A.name}`;
    if (trapped) {
      line(`- FINDING [keyboard] from the terminal, ${shifts.length} presses of Shift-Tab stay in it, as xterm keeps Tab for the shell, so the back arrow is out of the keyboard's reach there`);
      await page.goBack();
    } else await page.keyboard.press("Enter");
    await atPath(boxPath(A));
    await waitFor(() => focusIsHeading(page), "focus on the name again");
    return `Tab order: ${order.join(" → ")}; from the terminal, ${trapped ? "Shift-Tab stays in the terminal (a finding), and Back returned to the page with focus on its name" : `Shift-Tab reached the back arrow: ${shifts.join(" → ")}`}`;
  });
}

const workingThread = async () => {
  const before = agentStart(thread, "box_run", { box: A.name, command: "sleep 150" });
  await waitFor(async () => (await rpc("boxPage", { box: A.id })).thread?.running === true, "the thread working", 60_000);
  return before;
};

async function expectAsks(where) {
  const asked = dialog();
  await asked.waitFor();
  const title = await asked.getByRole("heading").first().textContent();
  const words = await asked.textContent();
  expect(title === `Stop ${A.name} anyway?`, `title ${title}`);
  expect(words.includes(`is working on ${A.name}.`), `words ${words}`);
  expect(words.includes("CALL box_list"), "names the thread");
  return `${where}: "${title}" "${words.replace(title, "").replace(/Cancel.*$/, "").trim()}"`;
}

if (section("g3")) {
  await settle();
  line("## G3 and G6: Stop, Start and a failed stop from the page");
  await check("G6", "a stop that fails says so, with what bb-box then saw", async () => {
    await goPage(A);
    flag("stop-fails");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const notice = page.getByRole("alert", { name: /^Stop failed / });
    await notice.waitFor({ timeout: 60_000 });
    const words = await notice.textContent();
    expect(/It is still running \(checked .+\)\./.test(words), words);
    expect(/permission denied/.test(words), "the backend's words");
    await shoot("stop-failed");
    return words;
  });
  let before = null;
  await check("G3", "with the box's own thread working, Stop asks from the row, its menu, the page and the notice's retry", async () => {
    before = await workingThread();
    const said = [];
    await threadsTab();
    await page.locator("[data-resource-row]", { hasText: A.name }).first().getByRole("button", { name: "Stop", exact: true }).click();
    said.push(await expectAsks("row"));
    await dialog().getByRole("button", { name: "Cancel" }).click();
    await openBoxMenu(page, A.name);
    await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
    said.push(await expectAsks("menu"));
    await dialog().getByRole("button", { name: "Cancel" }).click();
    await goPage(A);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    said.push(await expectAsks("page"));
    await shoot("in-use");
    await dialog().getByRole("button", { name: "Cancel" }).click();
    expect((await view(A)).state === "ready", "still ready after each Cancel");
    await page.getByRole("button", { name: "Stop again" }).click();
    said.push(await expectAsks("notice"));
    await dialog().getByRole("button", { name: "Stop anyway" }).click();
    await stateIs(A, "stopped");
    return said.join("; ");
  });
  await check("G3", "Stop it anyway stopped it; Start from the page", async () => {
    await page.locator("text=Stopped").first().waitFor();
    const words = await page.locator("h1 + p").textContent();
    await shoot("stopped");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await stateIs(A, "ready");
    await page.locator("h1 + p").getByText("Ready", { exact: true }).waitFor();
    return `stopped: "${words}"; then started`;
  });
  if (before !== null) await agentResult("box_run", before, 240_000).catch(() => null);
  await check("G3", "an idle thread's box stops at once, by you, and starts again", async () => {
    await waitFor(async () => (await rpc("boxPage", { box: A.id })).thread?.running === false, "the thread idle", 240_000);
    await goPage(A);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await stateIs(A, "stopped");
    expect(!(await dialog().count()), "no question");
    const header = page.locator("h1 + p");
    await waitFor(async () => /Stopped\s*· .*by you/.test(await header.textContent()), "Stopped by you");
    const words = await header.textContent();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await stateIs(A, "ready");
    await page.getByText(/^Last started today at .+, by you: ready in /).waitFor();
    return `"${words}", then "${await page.getByText(/^Last started /).textContent()}"`;
  });
  await check("G3", "a machine of yours stops at once with no thread on it, as today", async () => {
    await goPage(M, "from-settings");
    await shoot("machine");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await stateIs(M, "stopped");
    expect(!(await dialog().count()), "no question");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await stateIs(M, "ready");
    return "stopped and started";
  });
}

if (section("start")) {
  await settle();
  line("## A start that fails");
  await check("G6", "a start that fails says so, with what bb-box then saw, and Start again starts it", async () => {
    await goPage(F);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await stateIs(F, "stopped");
    flag("start-fails");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const notice = page.getByRole("alert", { name: /^Start failed / });
    await notice.waitFor({ timeout: 60_000 });
    const words = await notice.textContent();
    expect(/cgroup is frozen/.test(words), "the backend's words");
    expect(/(It is stopped \(checked .+\)\.|bb-box could not confirm its state\.)/.test(words), words);
    expect(!/still stopped/.test(words), "never claims still stopped without an observation");
    await shoot("start-failed");
    await notice.getByRole("button", { name: "Start again" }).click();
    await stateIs(F, "ready");
    return words;
  });
}

if (section("release")) {
  await settle();
  line("## Release from the page, one that does not finish, and the link after");
  await check("release", "a release that does not finish says so on the page and the row, with Release again", async () => {
    await goPage(B);
    flag("rm-fails");
    await openBoxMenu(page, B.name);
    await page.getByRole("menuitem", { name: "Release…" }).click();
    await dialog().getByRole("button", { name: "Release" }).click();
    const notice = page.getByRole("alert", { name: /^Release did not finish / });
    await notice.waitFor({ timeout: 60_000 });
    const words = await notice.textContent();
    expect(/device or resource busy/.test(words), "the backend's words");
    expect(/bb-box keeps its record until a release is confirmed/.test(words), words);
    await shoot("release-unfinished");
    await threadsTab();
    const row = page.locator("[data-resource-row]", { hasText: B.name }).first();
    await row.getByText("Release did not finish").waitFor();
    const items = await openBoxMenu(page, B.name);
    expect(items.at(-1) === "Release again…", `row menu ${items.join(", ")}`);
    await page.keyboard.press("Escape");
    return `${words} | row menu: ${items.join(", ")}`;
  });
  await check("release", "Release again releases it, and the page says so, by you", async () => {
    await goPage(B);
    await page.getByRole("alert", { name: /^Release did not finish / }).getByRole("button", { name: "Release again…" }).click();
    await dialog().getByText(`Release ${B.name} again?`).waitFor();
    await dialog().getByRole("button", { name: "Release" }).click();
    await page.getByText(`${B.name} was released`).waitFor({ timeout: 60_000 });
    await shoot("released");
    return await page.getByText(/^Released /).textContent();
  });
  await check("release", "the released box's link after a reload and after a restart of bb-box", async () => {
    await page.reload();
    await page.getByText(`${B.name} was released`).waitFor();
    bb(["plugin", "reload", "bb-box"]);
    await waitFor(async () => (await rpc("allBoxes")) !== null, "bb-box back");
    await page.goto(pageUrl(B));
    await page.getByText(`${B.name} was released`).waitFor({ timeout: 30_000 });
    return await page.getByText(/^Released /).textContent();
  });
}

if (section("reach")) {
  await settle();
  line("## G20: a box that does not answer");
  await check("G20", "the page and the menus of a box that does not answer offer no Stop, Resize or New thread, each saying why", async () => {
    const container = containerOf(D.id);
    expect(container, "its container");
    docker(["pause", container]);
    try {
      bbMay(["box", "run", D.name, "true", "--thread", thread, "--timeout-seconds", "15"]);
      await waitFor(async () => (await view(D)).reach?.is === "not-answering", "not answering", 60_000);
      await goPage(D);
      await page.locator("h1 + p").getByText("Not answering", { exact: true }).waitFor();
      const notice = page.getByRole("status", { name: `${D.name} does not answer` });
      const words = await notice.textContent();
      expect(/bb-box checks again in \d/.test(words), words);
      await shoot("not-answering");
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      expect(await stop.isDisabled(), "Stop disabled");
      const why = await stop.locator("..").getAttribute("title");
      expect(why === `${D.name} does not answer`, `Stop says ${why}`);
      const pageItems = await openBoxMenu(page, D.name);
      expect(pageItems.some((item) => item.startsWith("New thread on this box…") && item.endsWith(`${D.name} does not answer (disabled)`)), `page menu ${pageItems.join(", ")}`);
      expect(pageItems.some((item) => item.startsWith("Resize…") && item.endsWith("(disabled)")), `page menu ${pageItems.join(", ")}`);
      await page.keyboard.press("Escape");
      await threadsTab();
      const rowItems = await openBoxMenu(page, D.name);
      expect(rowItems.some((item) => item === `Stop${D.name} does not answer (disabled)`), `row menu ${rowItems.join(", ")}`);
      await page.keyboard.press("Escape");
      expect(!(await page.locator("[data-resource-row]", { hasText: D.name }).first().getByRole("button", { name: "Stop", exact: true }).count()), "no quick Stop");
      return `notice: ${words} | page menu: ${pageItems.join(", ")} | row menu: ${rowItems.join(", ")}`;
    } finally {
      docker(["unpause", container]);
    }
  });
  await check("G20", "Check now finds it answers again", async () => {
    await goPage(D);
    const notice = page.getByRole("status", { name: `${D.name} does not answer` });
    if (await notice.count()) await notice.getByRole("button", { name: "Check now" }).click();
    await waitFor(async () => (await view(D)).reach?.is === "answers", "answers", 60_000);
    await page.locator("h1 + p").getByText("Ready", { exact: true }).waitFor();
    return "Ready";
  });
}

function editConfig(change) {
  const db = new DatabaseSync(join(home, "bbdata", "bb.db"), { timeout: 10_000 });
  try {
    const read = (key) => db.prepare("SELECT value FROM plugin_kv WHERE plugin_id = 'bb-box' AND key = ?").get(key)?.value ?? null;
    const write = (key, value) => db.prepare("UPDATE plugin_kv SET value = ?, updated_at = ? WHERE plugin_id = 'bb-box' AND key = ?").run(value, Date.now(), key);
    const kept = { document: read("config/document"), saved: read("config/saved") };
    const next = change(kept);
    if (next.document !== null) write("config/document", next.document);
    if (next.saved !== null) write("config/saved", next.saved);
    return kept;
  } finally {
    db.close();
  }
}

async function withBbBoxOff(task) {
  bb(["plugin", "disable", "bb-box"]);
  try {
    return task();
  } finally {
    bb(["plugin", "enable", "bb-box"]);
    await waitFor(async () => Array.isArray(await rpc("allBoxes")), "bb-box back", 60_000);
  }
}

if (section("removed")) {
  await settle();
  line("## G20: a backend removed from settings, Forget, and the link after");
  const keptFile = join(home, "live-results", `${label}-config.json`);
  let kept = null;
  await check("G20", "a box whose backend is not in settings: the notice, and no Stop, Start, Resize or New thread, each saying why", async () => {
    kept = await withBbBoxOff(() =>
      editConfig(({ document, saved }) => {
        const doc = JSON.parse(document);
        const record = JSON.parse(saved);
        const without = (backends) => backends.filter((backend) => backend.type !== "docker");
        return { document: JSON.stringify({ ...doc, backends: without(doc.backends) }), saved: JSON.stringify({ ...record, document: { ...record.document, backends: without(record.document.backends) } }) };
      }),
    );
    writeFileSync(keptFile, JSON.stringify(kept));
    await waitFor(async () => (await view(F)).reach?.is === "not-in-settings", "not in settings", 60_000);
    await goPage(F);
    await page.locator("h1 + p").getByText("Not checked", { exact: true }).waitFor();
    const notice = page.getByRole("status", { name: "Its backend is not in settings" });
    const words = await notice.textContent();
    expect((await notice.getByRole("link", { name: "Open BB Box settings" }).getAttribute("href")) === "/settings/plugins/bb-box", "Open BB Box settings");
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    expect(await stop.isDisabled(), "Stop disabled");
    expect((await stop.locator("..").getAttribute("title")) === "Its backend is not in settings", "Stop says why");
    const facts = await page.getByRole("region", { name: "Facts" }).textContent();
    expect(facts.includes("Backend not in settings"), "Runs on is muted, and says so");
    await shoot("not-in-settings");
    const pageItems = await openBoxMenu(page, F.name);
    for (const item of ["New thread on this box…", "Resize…"]) expect(pageItems.includes(`${item}Its backend is not in settings (disabled)`), `page menu ${pageItems.join(", ")}`);
    expect(pageItems.at(-1) === "Forget…", `page menu ${pageItems.join(", ")}`);
    await page.keyboard.press("Escape");
    await threadsTab();
    const rowItems = await openBoxMenu(page, F.name);
    for (const item of ["Stop", "Resize…"]) expect(rowItems.includes(`${item}Its backend is not in settings (disabled)`), `row menu ${rowItems.join(", ")}`);
    expect(rowItems.at(-1) === "Forget…", `row menu ${rowItems.join(", ")}`);
    await page.keyboard.press("Escape");
    return `notice: ${words} | page menu: ${pageItems.join(", ")} | row menu: ${rowItems.join(", ")}`;
  });
  await check("G5 words", "Forget from the page says forgotten, never released, and the box still runs", async () => {
    const container = containerOf(F.id);
    await goPage(F);
    await page.getByRole("status", { name: "Its backend is not in settings" }).getByRole("button", { name: "Forget…" }).click();
    await dialog().getByText(`Forget ${F.name}?`).waitFor();
    const asked = await dialog().textContent();
    await dialog().getByRole("button", { name: "Forget", exact: true }).click();
    await page.getByText(`${F.name} was forgotten`).waitFor({ timeout: 30_000 });
    const words = await page.getByText(/^bb-box removed its record/).textContent();
    expect(!/released/i.test(words), "never released");
    await shoot("forgotten");
    const running = docker(["inspect", "--format", "{{.State.Running}}", container]);
    expect(running === "true", "its container still runs");
    return `asked: ${asked.replace(/Cancel.*$/, "")} | page: ${words} | container running: ${running}`;
  });
  await check("G5 words", "the forgotten box's link after a reload and after a restart of bb-box", async () => {
    await page.reload();
    await page.getByText(`${F.name} was forgotten`).waitFor();
    bb(["plugin", "reload", "bb-box"]);
    await waitFor(async () => Array.isArray(await rpc("allBoxes")), "bb-box back");
    await page.goto(pageUrl(F));
    await page.getByText(`${F.name} was forgotten`).waitFor({ timeout: 30_000 });
    return await page.getByText(/^bb-box removed its record/).textContent();
  });
  if (kept) {
    await withBbBoxOff(() => editConfig(() => kept));
    await waitFor(async () => (await view(A)).reach?.is === "answers", "the backend back", 60_000).catch(() => null);
    const container = containerOf(F.id);
    if (container) docker(["rm", "-f", container]);
    line(`- restored the configuration; removed ${F.name}'s container by hand`);
  }
}

const passed = results.filter((result) => result.ok).length;
line("");
line(`${passed} of ${results.length} checks passed.`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
