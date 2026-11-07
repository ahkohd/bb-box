import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { inBox } from "./in-box.mjs";

const base = process.env.LIVE_BASE ?? "http://127.0.0.1:7801";
const { BOX } = process.env;
const results = join(process.env.HOME, "live-results");
const shots = join(results, "shots");
mkdirSync(shots, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const placeWindow = (klass) =>
  until(`the ${klass} window, placed`, () => {
    try {
      return inBox(`id=$(xdotool search --onlyvisible --class ${klass} | tail -n 1); [ -n "$id" ] && xdotool windowactivate --sync $id && xdotool windowmove $id 200 150 && xdotool windowsize $id 900 600 && echo $id`);
    } catch {
      return null;
    }
  }, 20_000);
const checks = [];
async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    checks.push({ name, ok: true, detail, ms: Date.now() - started });
    console.log(`ok   ${name}: ${detail}`);
  } catch (error) {
    checks.push({ name, ok: false, detail: String(error?.message ?? error), ms: Date.now() - started });
    console.log(`FAIL ${name}: ${error?.message ?? error}`);
  }
}
async function until(what, test, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(200);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const sockets = [];
page.on("websocket", (socket) => sockets.push(socket.url()));
await page.goto(base);
if (await page.getByText("Skip setup").waitFor({ timeout: 6000 }).then(() => true, () => false)) await page.getByText("Skip setup").click();
await page.goto(`${base}/plugins/bb-box/desktop/${process.env.LIVE_THREAD}/${BOX}`);
const canvas = page.getByTestId("desktop-screen").locator("canvas").first();
const screenSize = () => inBox("xdpyinfo | awk '/dimensions/ {print $2; exit}'");
const canvasSize = () => canvas.evaluate((element) => `${element.width}x${element.height}`);
const pagePoint = async (x, y) => {
  const box = await canvas.boundingBox();
  const [width, height] = (await canvasSize()).split("x").map(Number);
  const scale = Math.min(box.width / width, box.height / height);
  return { x: box.x + (box.width - width * scale) / 2 + x * scale, y: box.y + (box.height - height * scale) / 2 + y * scale };
};
const desktopStream = () => sockets.filter((url) => url.includes("/desktop?")).map((url) => new URL(url).searchParams.get("stream")).at(-1) ?? "rfb";

await check("the viewer opens the box through voxl, as its backend chose", async () => {
  await page.getByText("The agent has control.").waitFor();
  await until("a video frame", async () => (await canvasSize()) !== "300x150");
  const stream = desktopStream();
  if (stream !== "voxl") throw new Error(`the viewer's stream is ${stream}`);
  return `stream=${stream}, picture ${await canvasSize()}, box screen ${screenSize()}`;
});

await check("Stream with voxl is in the Display menu, ticked", async () => {
  await page.getByRole("button", { name: "Desktop actions" }).click();
  await page.getByRole("menuitem", { name: "Display" }).click();
  const item = page.getByRole("menuitemcheckbox", { name: "Stream with voxl" });
  const checked = await item.getAttribute("aria-checked");
  await page.screenshot({ path: join(shots, "display-menu-1440-light.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  if (checked !== "true") throw new Error(`aria-checked=${checked}`);
  return "ticked";
});

inBox("rm -f /tmp/voxl-typed.txt; (setsid xterm -fa Monospace -fs 12 -e sh -c 'cat > /tmp/voxl-typed.txt' </dev/null >/dev/null 2>&1 &)");
await pause(1500);
await placeWindow("xterm");

await check("taking control gives this viewer the desktop", async () => {
  await page.getByRole("button", { name: "Take control" }).click();
  await page.getByText(/You have control/).waitFor();
  return "You have control";
});

await check("a click and typing reach the box: the pointer lands where it was clicked, and the keys reach the app under it", async () => {
  const point = await pagePoint(600, 450);
  await page.mouse.click(point.x, point.y);
  await pause(400);
  const at = inBox("xdotool getmouselocation --shell | head -n 2 | tr '\\n' ' '").trim();
  if (at !== "X=600 Y=450") throw new Error(`the box's pointer is at ${at}`);
  await page.keyboard.type("voxl types this, through BB", { delay: 25 });
  await page.keyboard.press("Enter");
  const saved = await until("the typed line in the file", () => {
    const read = inBox("cat /tmp/voxl-typed.txt 2>/dev/null || true");
    return read.includes("voxl types this, through BB") ? read : null;
  }, 10_000);
  await page.keyboard.press("Control+d");
  return `pointer at ${at}; saved ${JSON.stringify(saved.trim())}`;
});

await check("the box's clipboard reaches this computer's", async () => {
  inBox("printf 'copied in the box' | xclip -selection clipboard");
  const text = await until("the browser's clipboard", async () => {
    const read = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    return read === "copied in the box" ? read : null;
  });
  return JSON.stringify(text);
});

await check("this computer's clipboard reaches the box, and is pasted where the cursor is", async () => {
  inBox("pkill -9 -x mousepad; gsettings set org.xfce.mousepad.preferences.file session-restore never 2>/dev/null; (setsid mousepad </dev/null >/dev/null 2>&1 &)");
  await pause(2000);
  await placeWindow("mousepad");
  const point = await pagePoint(600, 450);
  await page.mouse.click(point.x, point.y);
  await pause(300);
  await page.keyboard.type("before ", { delay: 25 });
  await page.evaluate(() => navigator.clipboard.writeText("pasted from the browser"));
  await page.getByRole("button", { name: "Desktop actions" }).click();
  await page.getByRole("menuitem", { name: "Paste from this computer" }).click();
  const clipboard = await until("the box's clipboard", () => {
    const read = inBox("xclip -o -selection clipboard 2>/dev/null || true");
    return read === "pasted from the browser" ? read : null;
  });
  await pause(800);
  const back = await pagePoint(700, 300);
  await page.mouse.click(back.x, back.y);
  await pause(300);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  const buffer = await until("Mousepad's text, copied in the box", () => {
    const read = inBox("xclip -o -selection clipboard 2>/dev/null || true");
    return read === "before pasted from the browser" ? read : null;
  });
  inBox("pkill -9 -x mousepad; true");
  return `box clipboard ${JSON.stringify(clipboard)}; Mousepad's text, selected and copied in the box: ${JSON.stringify(buffer)}`;
});

await check("resizing the viewer resizes the box's screen, and voxl's picture follows", async () => {
  const before = { screen: screenSize(), picture: await canvasSize() };
  await page.setViewportSize({ width: 1180, height: 820 });
  const after = await until("a new screen size", () => {
    const now = screenSize();
    return now !== before.screen ? now : null;
  }, 20_000);
  const picture = await until("the picture at the new size", async () => ((await canvasSize()) === after ? after : null), 20_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const back = await until("the screen back at the larger pane", () => {
    const now = screenSize();
    return now !== after ? now : null;
  }, 20_000);
  return `screen ${before.screen} -> ${after}, picture ${before.picture} -> ${picture}; back to ${back}`;
});

await check("the wheel scrolls in the box", async () => {
  inBox("(setsid xterm -fa Monospace -fs 12 -sl 2000 -e sh -c 'seq 1 2000; sleep 600' </dev/null >/dev/null 2>&1 &)");
  await pause(1500);
  await placeWindow("xterm");
  await pause(800);
  const shot = () => inBox("scrot -o -a 210,230,880,500 /tmp/voxl-crop.png && md5sum /tmp/voxl-crop.png | cut -c1-12");
  const before = shot();
  const over = await pagePoint(600, 450);
  await page.mouse.move(over.x, over.y);
  for (let notch = 0; notch < 6; notch++) {
    await page.mouse.wheel(0, 100);
    await pause(60);
  }
  await pause(800);
  const after = shot();
  if (before === after) throw new Error("the window's text did not move");
  return `the text area's pixels changed (${before} -> ${after})`;
});

await check("handing back gives the agent control, and the viewer keeps watching through voxl", async () => {
  await page.getByRole("button", { name: "Hand back to the agent" }).first().click();
  await page.getByText("The agent has control.").waitFor();
  return `stream=${desktopStream()}`;
});

writeFileSync(join(results, "live-check.json"), JSON.stringify(checks, null, 2));
await browser.close();
console.log(checks.every((each) => each.ok) ? "all passed" : `${checks.filter((each) => !each.ok).length} failed`);
