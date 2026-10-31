import { bb, boxesUrl, browser, focused, generic, inBox, line, machineId, pause, rpc, shots, snapshotsOf, tabTo, waitFor } from "./live-lib.mjs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function askedWords(boxId) {
  const db = new DatabaseSync(join(process.env.HOME, "bbdata", "plugins", "bb-box", "box-log.db"), { readOnly: true });
  try {
    return db.prepare("SELECT words FROM box_events WHERE box = ? AND kind = 'restore-asked' ORDER BY seq DESC LIMIT 1").get(boxId)?.words ?? "none";
  } finally {
    db.close();
  }
}

const [name, project] = process.argv.slice(2);
const id = await machineId(name);
line(`\n## Guarded restore of ${name} (${new Date().toISOString()})`);

const spawn = (title, prompt) => {
  const thread = JSON.parse(bb(["thread", "spawn", "--project", project, "--machine", name, "--environment", "/home/box/proj", "--provider", "acp-idle", "--prompt", prompt, "--json"])).id;
  bb(["thread", "update", thread, "--title", title]);
  return thread;
};
const working = spawn("Fix the sign-in flow", "hold this turn");
const idle = spawn("Write the API guide", "end at once");
await pause(8000);

const { launched, context, page } = await browser();
const terminal = await context.newPage();
await terminal.goto(`${boxesUrl}/box/${id}`);
await terminal.getByRole("link", { name: "Terminal" }).click();
await terminal.locator(".xterm").waitFor({ timeout: 30_000 });
await pause(3000);
const desktop = await context.newPage();
await desktop.goto(`${boxesUrl}/box/${id}`);
await desktop.getByRole("link", { name: "Desktop" }).click();
await desktop.getByRole("button", { name: /Take control/ }).first().click({ timeout: 30_000 });
await pause(3000);

await page.bringToFront();
await page.goto(`${boxesUrl}/box/${id}`);
await page.locator("[data-snapshots-card]").waitFor();
await pause(1500);
await tabTo(page, (now) => now === `button Restore ${name} to one`);
await page.keyboard.press("Enter");
const dialog = page.getByRole("alertdialog");
await dialog.getByRole("listitem").first().waitFor({ timeout: 30_000 });
const named = await dialog.getByRole("listitem").allTextContents();
const restoreButtons = await dialog.getByRole("button", { name: /^Restore/ }).count();
line(`- With both threads on it, the dialog refused, first focus "${await focused(page)}", no Restore button (${restoreButtons}), and named: ${named.map((each) => `"${each}"`).join("; ")}.`);
for (const theme of ["dark", "light"]) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await pause(300);
  await generic(page);
  await page.screenshot({ path: join(shots, `guarded-refused-1440-${theme}.png`) });
}
await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
await page.keyboard.press("Escape");

bb(["thread", "archive", working]);
bb(["thread", "archive", idle]);
await pause(5000);
await tabTo(page, (now) => now === `button Restore ${name} to one`);
await page.keyboard.press("Enter");
await dialog.getByText("Also goes:").waitFor({ timeout: 30_000 });
const also = await dialog.getByRole("listitem").allTextContents();
const anyway = await dialog.getByRole("button", { name: /^Restore/ }).textContent();
await generic(page);
await page.screenshot({ path: join(shots, `guarded-anyway-1440-dark.png`) });
line(`- With the threads archived, the dialog listed under Also goes: ${also.map((each) => `"${each}"`).join("; ")}; its button "${anyway}".`);
inBox(name, "echo guarded > ~/state.txt; sync");
await tabTo(page, (now) => now.startsWith(`button Restore ${name}`), 6);
const began = Date.now();
await page.keyboard.press("Enter");
await waitFor(async () => {
  const view = await snapshotsOf(id);
  return !view.restoring && view.restored && view.restored.at >= began - 5000 ? view : null;
}, "the restore to end", 300_000);
const control = JSON.stringify((await rpc("machines.list")).machines.find((entry) => entry.box.id === id).box.control ?? null);
line(`- Restored anyway in ${((Date.now() - began) / 1000).toFixed(1)} s; ~/state.txt "${inBox(name, "cat ~/state.txt")}"; the box log's restore-asked: "${askedWords(id)}"; desktop control then: ${control}.`);
await launched.close();
