const ask = "Get a Linux desktop box and open getbb.app on it.";

export default {
  url: process.env.DEMO_BB_URL ?? "http://localhost:4999/",
  viewport: { width: 1280, height: 800 },
  scale: 2,

  async run({ page, click, glideTo, type, press, pause, mark, wait, poster }) {
    const button = (name, options = {}) => page.getByRole("button", { name, ...options });
    const agentDone = page.getByText(/is open on/).first();

    await click(page.getByRole("textbox", { name: "Ask anything." }));
    await pause(300);
    mark("type");
    await type(ask, { delayMs: 42 });
    await pause(500);
    await press("Enter");
    mark("sent");
    await wait(agentDone.waitFor({ timeout: 240000 }), { speedUp: 3, keepStartMs: 600, keepEndMs: 400 });
    mark("agent done");
    const desktopBox = /is open on (\S+?)'s desktop/.exec(await agentDone.textContent())[1];
    await pause(1200);

    await click(button("Show right panel (Ctrl + J)"));
    await pause(700);
    mark("panel");
    await click(button("Open new tab (Ctrl + T)"));
    await pause(500);
    await click(button("Box", { exact: true }));
    await pause(1500);
    mark("box panel");
    await click(button("Open desktop").first());
    mark("desktop");
    await pause(2500);
    await click(button("Maximize pane"));
    mark("maximized");
    await pause(1500);

    await click(button("Machine status"));
    await pause(900);
    await click(page.locator("[data-bb-box-monitor-header]").getByRole("button", { name: "Machine", exact: true }));
    await pause(500);
    await click(page.getByRole("listbox", { name: "Machines" }).locator("[data-machine-index]").filter({ hasText: desktopBox }).first());
    mark("monitor");
    poster({ afterMs: 2500 });
    await pause(4000);
    await click(button("Hide machine status"));
    await pause(600);
    await click(button("Restore split"));
    await pause(900);

    await click(button("Box", { exact: true }));
    await pause(900);
    mark("new box");
    await click(button("New box"));
    await pause(1600);
    await click(button("Create box"));
    mark("created");
    await button("Open terminal").nth(1).waitFor({ timeout: 120000 });
    await page.getByText(/Ready in/).nth(1).waitFor({ timeout: 120000 });
    mark("server ready");
    await pause(1500);
    await click(button("Open terminal").nth(1));
    await page.getByText("Connected").first().waitFor({ timeout: 60000 });
    await pause(1500);
    await click(page.locator(".xterm").last());
    mark("terminal");
    await type("uname -sm && nproc", { delayMs: 70 });
    await pause(300);
    await press("Enter");
    await pause(1500);

    const rowMenus = button(/^[a-z]+-[a-z]+ actions$/);
    await click(button("Box", { exact: true }));
    await pause(300);
    const serverMenu = rowMenus.nth(1);
    const serverBox = (await serverMenu.getAttribute("aria-label")).replace(/ actions$/, "");
    await click(serverMenu);
    await pause(250);
    await click(page.getByRole("menuitem", { name: "Details" }));
    mark("box page");
    await page.getByText(/^Read at /).first().waitFor({ timeout: 30000 });
    await pause(1500);

    const snapshots = page.getByRole("region", { name: "Snapshots" });
    const dialog = page.getByRole("alertdialog");
    await page.mouse.wheel(0, 700);
    await pause(400);
    mark("snapshot");
    await click(snapshots.getByRole("button", { name: "Take snapshot" }));
    await pause(300);
    await type("before", { delayMs: 45 });
    await pause(250);
    await click(dialog.getByRole("button", { name: "Take snapshot" }));
    await snapshots.getByText("before", { exact: true }).first().waitFor({ timeout: 60000 });
    await pause(700);

    mark("break");
    await click(button("Go back", { exact: true }));
    await pause(250);
    await click(button(`Terminal: ${serverBox}`, { exact: true }));
    await pause(200);
    await click(page.locator(".xterm").last());
    await type("sudo rm /usr/bin/git && git status", { delayMs: 35 });
    await press("Enter");
    await pause(1200);
    await type("exit", { delayMs: 45 });
    await press("Enter");
    await pause(400);
    await click(button("Go forward", { exact: true }));
    await pause(300);

    mark("restore");
    const row = snapshots.getByText("before", { exact: true }).first();
    await row.scrollIntoViewIfNeeded();
    const over = await glideTo(row);
    await page.mouse.move(over.x, over.y);
    await pause(150);
    await click(snapshots.getByRole("button", { name: /^Restore .* to before$/ }));
    await dialog.getByRole("checkbox").first().waitFor({ timeout: 30000 });
    await pause(1300);
    await click(dialog.getByRole("button", { name: `Restore ${serverBox}`, exact: true }));
    await wait(button("Undo…").first().waitFor({ timeout: 180000 }), { speedUp: 6, keepStartMs: 800, keepEndMs: 300 });
    mark("restored");
    await page.mouse.wheel(0, -2000);
    await pause(2000);
  },
};
