import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { agent, boxes, expect, heading, historyLength, home, makeReport, pathOf, pause, rpc, settingsUrl, skipSetup, waitFor } from "./live-lib.mjs";

const label = process.argv[2] ?? "run";
const only = new Set((process.env.LIVE_ONLY ?? "").split(",").filter(Boolean));
const thread = process.env.LIVE_THREAD;
const names = JSON.parse(process.env.LIVE_BOXES);
const { line, check } = makeReport(label);
const section = (name) => !only.size || only.has(name);

async function idOf(name) {
  const all = await rpc("allBoxes");
  const entry = all.find((each) => each.box.name === name);
  if (!entry) throw new Error(`no box ${name}`);
  return entry.box.id;
}

const subjects = [];
if (names.A) subjects.push({ name: names.A, id: await idOf(names.A), screen: "desktop", word: "Desktop", open: "Open desktop" });
if (names.D) subjects.push({ name: names.D, id: await idOf(names.D), screen: "device", word: "Emulator", open: "Open emulator" });
line(`Boxes: ${subjects.map((box) => `${box.name} (${box.id}), ${box.screen}`).join("; ")}; thread ${thread}.`);
line("");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
      await pause(1200);
      await page.screenshot({ path: join(shotsDir, `${name}-${width}-${theme}.png`) });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 1000 });
}

const listPath = "/plugins/bb-box/desktop";
const boxPath = (box, ...rest) => ["/plugins/bb-box/desktop/box", box.id, ...rest].join("/");
const atPath = (path) => waitFor(async () => pathOf(page) === path, `the path ${path} (at ${pathOf(page)})`, 20_000).then(() => true);
const atList = () => waitFor(async () => pathOf(page).startsWith(listPath) && !pathOf(page).includes("/box/"), `the list (at ${pathOf(page)})`, 20_000);
const switchTo = (word) => page.locator(`[data-view-switch]`, { hasText: word }).first();
const row = (box) => page.locator("[data-resource-row]", { hasText: box.name }).first();
const backButton = (words) => page.getByRole("button", { name: words, exact: true }).or(page.getByRole("link", { name: words, exact: true })).first();

async function threadsTab() {
  await page.goto(`${boxes}/threads`);
  await row(subjects[0]).waitFor();
}

async function goPage(box, ...rest) {
  await page.goto([boxes, "box", box.id, ...rest].join("/"));
  await heading(page);
}

async function switchThereAndBack(box, origins) {
  const before = await historyLength(page);
  await switchTo("Terminal").click();
  await atPath(boxPath(box, "terminal", ...origins));
  await switchTo(box.word).click();
  await atPath(boxPath(box, box.screen, ...origins));
  expect((await historyLength(page)) === before, `a switch pushed: history ${before} became ${await historyLength(page)}`);
}

if (section("g8")) {
  line("## Switch, then back, from every origin of G8");
  for (const box of subjects) {
    line("");
    line(`### ${box.name}, ${box.screen}`);
    await check("G8", `${box.name}: a row's quick ${box.word}, Terminal, ${box.word}, then back goes back in history to the list`, async () => {
      await threadsTab();
      const before = await historyLength(page);
      await row(box).getByRole("button", { name: box.open }).click();
      await atPath(boxPath(box, box.screen, "from-list"));
      await switchThereAndBack(box, ["from-list"]);
      await backButton("Back to boxes").click();
      await atList();
      expect((await historyLength(page)) === before + 1, "the way back went back in history");
      return `${box.screen}/from-list, terminal/from-list, ${box.screen}/from-list, then ${pathOf(page)}; history ${before + 1}`;
    });
    await check("G8", `${box.name}: a row's quick ${box.word} and Terminal, then the browser's Back goes to the list, as the switch replaced its entry`, async () => {
      await threadsTab();
      await row(box).getByRole("button", { name: box.open }).click();
      await atPath(boxPath(box, box.screen, "from-list"));
      await switchTo("Terminal").click();
      await atPath(boxPath(box, "terminal", "from-list"));
      await page.goBack();
      await atList();
      return pathOf(page);
    });
    await check("G8", `${box.name}: a row's quick ${box.word}, Terminal, a reload, then back: the list it names, replacing`, async () => {
      await threadsTab();
      await row(box).getByRole("button", { name: box.open }).click();
      await switchTo("Terminal").click();
      await atPath(boxPath(box, "terminal", "from-list"));
      await page.reload();
      const before = await historyLength(page);
      await backButton("Back to boxes").click();
      await atList();
      expect((await historyLength(page)) === before, "a replace");
      return pathOf(page);
    });
    await check("G8", `${box.name}: the page, ${box.word}, Terminal, ${box.word}, then back goes back in history to the page`, async () => {
      await goPage(box);
      const before = await historyLength(page);
      await page.getByRole("link", { name: box.word, exact: true }).click();
      await atPath(boxPath(box, box.screen, "from-box"));
      await switchThereAndBack(box, ["from-box"]);
      await backButton(`Back to ${box.name}`).click();
      await atPath(boxPath(box));
      expect((await historyLength(page)) === before + 1, "the way back went back in history");
      return `back at ${pathOf(page)}`;
    });
    const settingsChain = async (reload) => {
      await page.goto(settingsUrl);
      await page.waitForTimeout(800);
      await goPage(box, "from-settings");
      await page.getByRole("link", { name: box.word, exact: true }).click();
      await atPath(boxPath(box, box.screen, "from-box", "from-settings"));
      await switchThereAndBack(box, ["from-box", "from-settings"]);
      if (reload) await page.reload();
      await backButton(`Back to ${box.name}`).click();
      await atPath(boxPath(box, "from-settings"));
      await page.getByRole("navigation", { name: "Where you are" }).getByRole("link", { name: "Back to BB Box settings" }).click();
      await atPath("/settings/plugins/bb-box");
    };
    await check("G8", `${box.name}: settings, the page, ${box.word}, Terminal, ${box.word}, then back: the page, then settings`, async () => {
      await settingsChain(false);
      return "the page, then settings";
    });
    await check("G8", `${box.name}: the same with a reload after the switch`, async () => {
      await settingsChain(true);
      return "the page, then settings";
    });
    await check("G8", `${box.name}: a view opened from settings by its link, Terminal, ${box.word}: its back is still the link to BB Box settings`, async () => {
      await page.goto([boxes, "box", box.id, box.screen, "from-settings"].join("/"));
      await switchThereAndBack(box, ["from-settings"]);
      const back = page.getByRole("link", { name: "Back to BB Box settings", exact: true });
      expect((await back.getAttribute("href")) === "/settings/plugins/bb-box", "the settings link");
      await back.click();
      await atPath("/settings/plugins/bb-box");
      return "settings";
    });
    await check("G8", `${box.name}: a view by URL with no origin, Terminal, ${box.word}, then back replaces with the page`, async () => {
      await page.goto([boxes, "box", box.id, box.screen].join("/"));
      await switchThereAndBack(box, []);
      const before = await historyLength(page);
      await backButton(`Back to ${box.name}`).click();
      await atPath(boxPath(box));
      expect((await historyLength(page)) === before, "a replace");
      return pathOf(page);
    });
  }
}

async function barStatus() {
  return page.evaluate(() => {
    const bar = document.querySelector("[data-view-switch]")?.closest("div");
    const dot = bar ? [...bar.querySelectorAll("span[aria-hidden]")].find((span) => span.className.includes("h-[1.375em]")) : null;
    return dot?.nextElementSibling?.textContent?.trim() ?? "";
  });
}

const SHOWING = /^(The agent has control\.|You have control\.|Another viewer has control\.)$/;

if (section("live")) {
  line("");
  line("## Each view works after a switch");
  for (const box of subjects) {
    await check("live", `${box.name}: ${box.word} shows, Terminal connects after the switch, and ${box.word} shows again after the switch back`, async () => {
      await page.goto([boxes, "box", box.id, box.screen, "from-list"].join("/"));
      const first = await waitFor(async () => SHOWING.test(await barStatus()) && (await barStatus()), `${box.word} showing`, 60_000);
      const switched = Date.now();
      await switchTo("Terminal").click();
      await atPath(boxPath(box, "terminal", "from-list"));
      await waitFor(async () => (await barStatus()) === "Connected", "the terminal connected", 30_000);
      const terminalMs = Date.now() - switched;
      const mark = `switched-${Date.now()}`;
      await page.locator("[data-testid=terminal-screen]").click();
      await page.keyboard.type(`touch /tmp/${mark}`);
      await page.keyboard.press("Enter");
      await waitFor(async () => (await agent(thread, "box_run", { box: box.name, command: `ls /tmp/${mark}` })).includes(`/tmp/${mark}`), "the typed command's file in the box", 30_000);
      const back = Date.now();
      await switchTo(box.word).click();
      await atPath(boxPath(box, box.screen, "from-list"));
      const again = await waitFor(async () => SHOWING.test(await barStatus()) && (await barStatus()), `${box.word} showing again`, 60_000);
      const backMs = Date.now() - back;
      return `${box.word}: "${first}"; Terminal connected ${terminalMs} ms after the click and ran a typed command; ${box.word} "${again}" ${backMs} ms after the click back`;
    });
  }
}

function clock(iso) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
}

async function barReading() {
  const link = page.locator("[data-bar-numbers] a[data-read-at]");
  await link.waitFor({ timeout: 30_000 });
  return { cpu: await link.getAttribute("data-cpu"), memory: await link.getAttribute("data-memory"), at: await link.getAttribute("data-read-at"), link };
}

async function pageReading() {
  const activity = page.getByRole("region", { name: "Activity" });
  await activity.waitFor();
  const status = (await activity.locator("h2 + span").innerText()).trim();
  const tile = async (name) => (await activity.locator(`section[aria-label="${name}"] .text-xl`).first().innerText()).trim();
  return { status, cpu: `${await tile("CPU")}%`, memory: `${await tile("Memory")}%` };
}

if (section("numbers")) {
  line("");
  line("## The bar's numbers against the page's");
  for (const box of subjects) {
    await agent(thread, "box_run", { box: box.name, command: "nohup timeout 600 sh -c 'yes > /dev/null' > /dev/null 2>&1 & nohup timeout 600 sh -c 'yes > /dev/null' > /dev/null 2>&1 & echo loaded" });
    for (const view of [box.screen, "terminal"]) {
      await check("numbers", `${box.name}: the ${view} view's bar against the page, under load, the same reading`, async () => {
        const pairs = [];
        for (let attempt = 0; pairs.length < 3 && attempt < 12; attempt += 1) {
          await page.goto([boxes, "box", box.id, view, "from-list"].join("/"));
          await pause(6000);
          const bar = await barReading();
          await bar.link.click();
          await atPath(boxPath(box, "from-list"));
          const shown = await pageReading();
          if (shown.status !== `Read at ${clock(bar.at)}`) continue;
          pairs.push(`${clock(bar.at)}: bar CPU ${bar.cpu}, memory ${bar.memory}; page CPU ${shown.cpu}, memory ${shown.memory}`);
          expect(bar.cpu === shown.cpu && bar.memory === shown.memory, `differ: ${pairs.at(-1)}`);
        }
        expect(pairs.length === 3, `only ${pairs.length} readings shared a time`);
        return pairs.join("; ");
      });
    }
    await check("numbers", `${box.name}: the numbers show above 640 px and not below`, async () => {
      await page.goto([boxes, "box", box.id, "terminal", "from-list"].join("/"));
      await barReading();
      await page.setViewportSize({ width: 641, height: 900 });
      await pause(300);
      const wide = await page.locator("[data-bar-numbers]").isVisible();
      await page.setViewportSize({ width: 639, height: 900 });
      await pause(300);
      const narrow = await page.locator("[data-bar-numbers]").isVisible();
      await page.setViewportSize({ width: 1440, height: 1000 });
      expect(wide && !narrow, `641 px ${wide}, 639 px ${narrow}`);
      return "641 px shown, 639 px hidden";
    });
  }
}

async function focused() {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return "(page)";
    return (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName).trim().replace(/\s+/g, " ").slice(0, 50);
  });
}

async function tabTo(name, most = 60) {
  const walked = [];
  for (let index = 0; index < most; index += 1) {
    await page.keyboard.press("Tab");
    const at = await focused();
    walked.push(at);
    if (at === name) return walked;
  }
  throw new Error(`Tab never reached ${name}: ${walked.join(" | ")}`);
}

if (section("keyboard")) {
  line("");
  line("## Keyboard only");
  for (const box of subjects) {
    await check("keyboard", `${box.name}: from the row's quick ${box.word} by Enter, Tab through the bar, Enter on Terminal, then on ${box.word}, then on the way back`, async () => {
      await threadsTab();
      await row(box).getByRole("button", { name: box.open }).focus();
      await page.keyboard.press("Enter");
      await atPath(boxPath(box, box.screen, "from-list"));
      await barReading();
      const opened = await focused();
      const toTerminal = await tabTo("Terminal");
      const before = [];
      for (let index = 0; index < 6 && before.at(-1) !== "Back to boxes"; index += 1) {
        await page.keyboard.press("Shift+Tab");
        before.push(await focused());
      }
      const order = [...before.reverse()];
      await tabTo("Terminal", 10);
      const more = ["Terminal"];
      for (let index = 0; index < 3; index += 1) {
        await page.keyboard.press("Tab");
        more.push(await focused());
      }
      for (let index = 0; index < 3; index += 1) await page.keyboard.press("Shift+Tab");
      expect((await focused()) === "Terminal", `Shift-Tab came back to ${await focused()}`);
      await page.keyboard.press("Enter");
      await atPath(boxPath(box, "terminal", "from-list"));
      await barReading();
      await pause(500);
      const switched = await focused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      const trapped = await focused();
      await page.keyboard.press("Control+Shift+ArrowUp");
      const left = await focused();
      expect(left === box.word, `Ctrl+Shift+Up went to "${left}"`);
      await page.keyboard.press("Enter");
      await atPath(boxPath(box, box.screen, "from-list"));
      await barReading();
      const switchedBack = await focused();
      await tabTo("Back to boxes", 80);
      await page.keyboard.press("Enter");
      await atList();
      return [
        `opened with focus on "${opened}", ${toTerminal.length} Tabs to Terminal`,
        `the bar in Tab order: ${[...order, ...more].join(" | ")}`,
        `after Enter on Terminal focus on "${switched}"; Tab and Shift-Tab there stay on "${trapped}", as the shell takes them; Ctrl+Shift+Up moved focus to "${left}"`,
        `after Enter on ${box.word} focus on "${switchedBack}"; Enter on Back to boxes reached the list`,
      ].join("; ");
    });
  }
}

async function inTheBox(box, command) {
  return agent(thread, "box_run", { box: box.name, command });
}

async function typeLine(text) {
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function openTerminal(box) {
  await page.goto([boxes, "box", box.id, "terminal", "from-list"].join("/"));
  await waitFor(async () => (await barStatus()) === "Connected", "the terminal connected", 30_000);
  await page.locator("[data-testid=terminal-screen]").click();
  await page.keyboard.press("Control+c");
  await pause(300);
  await typeLine("stty sane; clear");
  await pause(800);
}

if (section("terminal-keys")) {
  line("");
  line("## The terminal's keys");
  for (const box of subjects) {
    await check("terminal-keys", `${box.name}: Ctrl+Shift+Up moves focus to the bar and sends the shell nothing; Tab, Shift+Tab, arrows with Ctrl or Shift, and Escape reach it`, async () => {
      await openTerminal(box);
      const mark = `keys-${Date.now()}`;
      await typeLine(`stty raw -echo; timeout 15 cat > /tmp/${mark}; stty sane`);
      await pause(1500);
      for (const key of ["Tab", "Shift+Tab", "ArrowUp", "Control+ArrowUp", "Shift+ArrowUp", "Escape"]) await page.keyboard.press(key);
      await page.keyboard.type("x");
      await page.keyboard.press("Control+Shift+ArrowUp");
      const landed = await focused();
      const onSwitch = await page.evaluate(() => document.activeElement?.hasAttribute("data-view-switch") ?? false);
      await page.locator("[data-testid=terminal-screen]").click();
      await page.keyboard.type("y");
      await pause(17_000);
      const bytes = await inTheBox(box, `od -An -c /tmp/${mark} | tr -s ' ' | tr -d '\\n'`);
      const got = /stdout: \| (.*?) \|/.exec(bytes)?.[1]?.trim() ?? bytes;
      expect(onSwitch, `focus went to "${landed}"`);
      expect(got.includes("x   y") || /x\s+y/.test(got), `x and y are not side by side: ${got}`);
      expect(!got.includes("6   A") && !/;\s*6\s*A/.test(got), `Ctrl+Shift+Up reached the shell: ${got}`);
      return `focus on "${landed}"; the shell read: ${got}`;
    });
    await check("terminal-keys", `${box.name}: vim, less and tmux still get their keys`, async () => {
      await openTerminal(box);
      const mark = `apps-${Date.now()}`;
      await typeLine(`vim -u NONE -N /tmp/${mark}-vim`);
      await pause(1500);
      await page.keyboard.type("ihello from vim");
      for (const key of ["Escape", "Control+ArrowUp", "Shift+ArrowUp"]) {
        await page.keyboard.press(key);
        await pause(1200);
      }
      await typeLine(":wq");
      await pause(1000);
      await typeLine(`seq 1000 | less`);
      await pause(1000);
      await page.keyboard.press("Shift+G");
      await page.keyboard.press("Tab");
      await page.keyboard.type("s");
      await pause(300);
      await typeLine(`/tmp/${mark}-less`);
      await pause(500);
      await page.keyboard.type("q");
      await pause(500);
      await typeLine(`tmux -L ${mark} new -s keys`);
      await pause(1500);
      await page.keyboard.press("Control+b");
      await page.keyboard.type("c");
      await pause(800);
      await typeLine(`tmux -L ${mark} list-windows | wc -l > /tmp/${mark}-tmux; tmux -L ${mark} kill-server`);
      await pause(1500);
      const said = await inTheBox(box, `cat /tmp/${mark}-vim; echo; wc -l < /tmp/${mark}-less; cat /tmp/${mark}-tmux`);
      const out = /stdout: \| (.*?) \|  \|/.exec(said)?.[1] ?? said;
      expect(out.includes("hello from vim"), `vim: ${out}`);
      expect(/\|\s*1000\s*\|/.test(said), `less saved: ${out}`);
      expect(/\|\s*2\s*\|/.test(said), `tmux windows: ${out}`);
      return `vim wrote "hello from vim" after Escape, Ctrl+Up and Shift+Up; less took G, Tab and s and saved 1000 lines; tmux took Ctrl+B c and had 2 windows (${out})`;
    });
  }
}

if (section("shots")) {
  line("");
  line("## Screenshots");
  for (const box of subjects) {
    await check("shots", `${box.name}: its views' bars`, async () => {
      for (const view of [box.screen, "terminal"]) {
        if (view === "terminal") await openTerminal(box);
        else await page.goto([boxes, "box", box.id, view, "from-list"].join("/"));
        await barReading();
        await pause(3000);
        await shoot(`${box.screen === "device" ? "android" : "desktop"}-${view}`);
      }
      return shotsDir ?? "screenshots off";
    });
  }
}

await browser.close();
