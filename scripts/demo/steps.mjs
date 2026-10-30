const ask = "Get a Linux desktop box and open getbb.app on it.";

export default {
  url: process.env.DEMO_BB_URL ?? "http://localhost:4999/",
  viewport: { width: 1280, height: 800 },
  scale: 2,

  async run({ page, click, type, press, pause, mark, wait, poster }) {
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
    await pause(3000);
  },
};
