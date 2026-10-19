// Loaded into each test file's process (npm test): once the file's tests are
// done, a process that does not end within a while, kept alive by a child
// process, a server or a timer a test left behind, says what keeps it and
// fails, rather than holding the whole run until CI's limit (twice on
// 19 October 2026). Its own timer is unref'd, so a process that ends as it
// should never sees it.

import { after } from "node:test";

/** How long a test file's process may run on after its last test. */
const EXIT_WAIT_MS = 60_000;

after(() => {
  setTimeout(() => {
    const handles = (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles().map((handle) => {
      const each = handle as { constructor?: { name?: string }; pid?: number; spawnargs?: string[]; address?: () => unknown };
      const what = [each.constructor?.name ?? "handle"];
      if (each.pid) what.push(`pid ${each.pid}: ${(each.spawnargs ?? []).join(" ").slice(-400)}`);
      if (typeof each.address === "function") what.push(JSON.stringify(each.address()));
      return what.join(" ");
    });
    process.stderr.write(
      `This test file's process still runs ${EXIT_WAIT_MS / 1000} s after its last test: ${JSON.stringify(process.getActiveResourcesInfo())}\n` +
        handles.map((line) => `  ${line}\n`).join(""),
    );
    process.exit(1);
  }, EXIT_WAIT_MS).unref();
});
