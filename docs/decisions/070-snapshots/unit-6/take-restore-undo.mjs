import { boxesUrl, browser, focused, inBox, line, machineId, pause, shoot, snapshotsOf, tabTo, waitFor } from "./live-lib.mjs";

const [name, label = name, memory = ""] = process.argv.slice(2);
const id = await machineId(name);
const { launched, page } = await browser();
const card = page.locator("[data-snapshots-card]");
const state = () => inBox(name, "cat ~/state.txt");

line(`\n## ${label}: take, restore and undo from the page, keyboard only (${new Date().toISOString()})`);
inBox(name, "echo one > ~/state.txt");
await page.goto(`${boxesUrl}/box/${id}`);
await page.locator("h1[data-page-heading]").waitFor({ timeout: 20_000 });
const factsAtFirst = await page.getByRole("region", { name: "Facts" }).boundingBox();
const cardAtFirst = await card.boundingBox();
await pause(5000);
const factsLater = await page.getByRole("region", { name: "Facts" }).boundingBox();
const cardLater = await card.boundingBox();
const shifts = await page.evaluate(() => window.__shifts);
line(`- Card on the first frame with the heading: ${cardAtFirst ? `yes, at y ${Math.round(cardAtFirst.y)}, height ${Math.round(cardAtFirst.height)}; 5 s later at y ${Math.round(cardLater.y)}, height ${Math.round(cardLater.height)}` : "no"}. Facts at y ${Math.round(factsAtFirst.y)}, 5 s later y ${Math.round(factsLater.y)}. Layout shifts after load: ${shifts.length ? shifts.map((shift) => `${shift.value.toFixed(4)} at ${Math.round(shift.at)} ms`).join(", ") : "none"}.`);

async function take(snapshot, note, viaMenu) {
  const takeWhy = (await snapshotsOf(id)).takeWhy;
  if (takeWhy) line(`- The card refuses a take now: ${takeWhy}`);
  let presses;
  if (viaMenu) {
    presses = await tabTo(page, (now) => now === `button ${name} actions`);
    await page.keyboard.press("Enter");
    await page.getByRole("menu").waitFor();
    await pause(300);
    for (let step = 0; step < 20 && !(await focused(page)).includes("Take snapshot…"); step++) {
      await page.keyboard.press("ArrowDown");
      await pause(200);
    }
    await page.keyboard.press("Enter");
  } else {
    presses = await tabTo(page, (now) => now === "button Take snapshot");
    await page.keyboard.press("Enter");
  }
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  const first = await focused(page);
  await page.keyboard.type(snapshot);
  await page.keyboard.press("Tab");
  await page.keyboard.type(note);
  if (memory) {
    await tabTo(page, (now) => now.startsWith("input"), 4);
    await page.keyboard.press("Space");
  }
  await dialog.getByText(/of \d+ for/).waitFor({ timeout: 20_000 });
  const words = (await dialog.getByText(/of \d+ for/).textContent()).trim();
  await tabTo(page, (now) => now === "button Take snapshot", 10);
  const began = Date.now();
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "detached", timeout: 60_000 });
  const back = await focused(page);
  const row = await waitFor(async () => (await snapshotsOf(id)).records.find((each) => each.name === snapshot && each.state === "ready"), `snapshot ${snapshot} ready`, 120_000);
  line(`- Took "${snapshot}"${viaMenu ? " from the header's menu" : " from the card"}: reached in ${presses} Tab presses; first focus "${first}"; the dialog said "${words}"; ready ${((Date.now() - began) / 1000).toFixed(1)} s after Enter, ${row.holds}, ${row.size ? `${(row.size.bytes / 1e9).toFixed(2)} GB (${row.size.means})` : "size unknown"}, picture ${row.picture}; focus back on "${back}".`);
  return row;
}

await take("one", "the first state", false);
inBox(name, "echo two > ~/state.txt");
await take("two", "the second state", true);
await page.locator("[data-snapshot-row] img").first().waitFor({ timeout: 10_000 }).catch(() => null);
await pause(800);
const picture = page.getByRole("button", { name: new RegExp(`^Show ${name}'s screen around`) }).first();
if (await picture.count()) {
  await picture.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").waitFor({ timeout: 5000 }).catch(() => null);
  await pause(800);
  const size = await page.locator("figure img").evaluate((img) => `${img.naturalWidth}x${img.naturalHeight}`).catch(() => "none");
  line(`- The picture opened from the keyboard at its full size: ${size}.`);
  await page.keyboard.press("Escape");
}

inBox(name, "echo three > ~/state.txt");
async function restore(button, expect) {
  const presses = await tabTo(page, (now) => now === `button ${button}`);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await dialog.getByText(/goes back to|cannot|refus/).first().waitFor({ timeout: 30_000 });
  const first = await focused(page);
  const text = (await dialog.textContent()).replace(/\s+/g, " ");
  await tabTo(page, (now) => now.startsWith(`button Restore ${name}`), 6);
  const began = Date.now();
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "detached", timeout: 60_000 });
  let shotRestoring = false;
  const done = await waitFor(async () => {
    const view = await snapshotsOf(id);
    if (view.restoring && !shotRestoring && expect === "one") {
      shotRestoring = true;
      await shoot(page, `restoring-${label}`, [[1440, 1000]], ["dark"]);
    }
    return !view.restoring && view.restored && Date.now() - began > 500 && view.restored.at >= began - 5000 ? view : null;
  }, "the restore to end", 300_000);
  await page.getByText(/^Restored at/).waitFor({ timeout: 30_000 });
  const announced = await page.locator("[data-snapshot-announcer]").textContent();
  line(`- Restore by "${button}": reached in ${presses} Tab presses, first focus "${first}"; the dialog said: "${text.slice(0, 400)}". Restored in ${((Date.now() - began) / 1000).toFixed(1)} s to the notice; ~/state.txt then said "${state()}"; the polite region said "${announced}"; the undo "${done.restored.undo?.name}".`);
  return done;
}

const first = await restore(`Restore ${name} to one`, "one");
const undoPresses = await tabTo(page, (now) => now === "button Undo…");
line(`- Undo… reached in ${undoPresses} Tab presses.`);
await page.keyboard.press("Enter");
const dialog = page.getByRole("alertdialog");
await dialog.getByText(/goes back to/).waitFor({ timeout: 30_000 });
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
line(`- Escape closed the undo's dialog; focus "${await focused(page)}".`);
await page.keyboard.press("Enter");
await dialog.getByText(/goes back to/).waitFor({ timeout: 30_000 });
await tabTo(page, (now) => now.startsWith(`button Restore ${name}`), 6);
const began = Date.now();
await page.keyboard.press("Enter");
await waitFor(async () => {
  const view = await snapshotsOf(id);
  return !view.restoring && view.restored && view.restored.operation !== first.restored.operation ? view : null;
}, "the undo to end", 300_000);
line(`- Undid it with "${first.restored.undo?.name}": ${((Date.now() - began) / 1000).toFixed(1)} s; ~/state.txt then said "${state()}".`);
await launched.close();
