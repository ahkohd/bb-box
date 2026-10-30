import assert from "node:assert/strict";
import { test } from "node:test";
import { boxPage, boxView, otherView, pageOfView, routeOf, subPathOf, viewFromPage, wayBack, type BoxesRoute } from "../src/app/box-route.ts";
import { actorWords, ago, dayAndClock, endedWords, failedNotice, headline, hostOf, observedWords, reachNotice, settingsNotice, span, unreachableWhy } from "../src/app/box-words.ts";
import type { BoxView } from "../src/plugin/views.ts";

const BOX = "bxamberfox2q7k";

test("each path of 069 section 1 reads as its route and back, innermost origin first", () => {
  const cases: [string, BoxesRoute][] = [
    ["", { page: "list", tab: null }],
    ["threads", { page: "list", tab: "threads" }],
    ["machines", { page: "list", tab: "machines" }],
    [`box/${BOX}`, boxPage(BOX)],
    [`box/${BOX}/from-list`, boxPage(BOX, ["from-list"])],
    [`box/${BOX}/from-settings`, boxPage(BOX, ["from-settings"])],
    [`box/${BOX}/desktop`, boxView(BOX, "desktop")],
    [`box/${BOX}/device/from-list`, boxView(BOX, "device", ["from-list"])],
    [`box/${BOX}/terminal/from-box`, boxView(BOX, "terminal", ["from-box"])],
    [`box/${BOX}/desktop/from-box/from-settings`, boxView(BOX, "desktop", ["from-box", "from-settings"])],
    [`box/${BOX}/desktop/from-box/from-list`, boxView(BOX, "desktop", ["from-box", "from-list"])],
  ];
  for (const [path, route] of cases) {
    assert.deepEqual(routeOf(path), route, path);
    assert.equal(subPathOf(route), path, path);
  }
});

test("old paths keep working, with and without from-settings", () => {
  assert.deepEqual(routeOf(`thr_1/${BOX}`), { page: "view", boxId: BOX, view: "desktop", origins: [], threadId: "thr_1" });
  assert.deepEqual(routeOf(`thr_1/${BOX}/device`), { page: "view", boxId: BOX, view: "device", origins: [], threadId: "thr_1" });
  assert.deepEqual(routeOf(`operator/${BOX}/terminal/from-settings`), { page: "view", boxId: BOX, view: "terminal", origins: ["from-settings"], threadId: "operator" });
  assert.deepEqual(routeOf(`operator/${BOX}/from-settings`), { page: "view", boxId: BOX, view: "desktop", origins: ["from-settings"], threadId: "operator" });
  for (const path of [`thr_1/${BOX}`, `thr_1/${BOX}/device`, `operator/${BOX}/terminal/from-settings`]) assert.equal(subPathOf(routeOf(path)), path);
  assert.equal(subPathOf(otherView(routeOf(`thr_1/${BOX}/device`) as never, "desktop")), `thr_1/${BOX}`, "a switch keeps the old form");
});

test("a path that is not one of them opens the list", () => {
  for (const path of [`box/${BOX}/from-box`, `box/${BOX}/upside`, `box/${BOX}/desktop/from-list/from-box/from-settings`, `thr_1/${BOX}/elsewhere`, "box/%E0%A4%A"]) assert.deepEqual(routeOf(path), { page: "list", tab: null }, path);
});

test("the way back goes where the entry was opened from: the list, the page with its own origin, or settings (G8)", () => {
  assert.deepEqual(wayBack(boxPage(BOX)), { to: "list" });
  assert.deepEqual(wayBack(boxPage(BOX, ["from-list"])), { to: "list" });
  assert.deepEqual(wayBack(boxPage(BOX, ["from-settings"])), { to: "settings" });
  assert.deepEqual(wayBack(boxView(BOX, "device", ["from-list"])), { to: "list" });
  assert.deepEqual(wayBack(boxView(BOX, "desktop")), { to: "box", route: boxPage(BOX) }, "with no origin, a view's parent is the box's page");
  const fromSettings = viewFromPage(boxPage(BOX, ["from-settings"]), "desktop");
  assert.equal(subPathOf(fromSettings), `box/${BOX}/desktop/from-box/from-settings`);
  assert.deepEqual(wayBack(fromSettings), { to: "box", route: boxPage(BOX, ["from-settings"]) }, "back to the page, and from there to settings");
  assert.deepEqual(wayBack(pageOfView(fromSettings)), { to: "settings" });
  assert.deepEqual(wayBack(routeOf(`operator/${BOX}/terminal/from-settings`) as never), { to: "settings" });
  assert.deepEqual(wayBack(routeOf(`thr_1/${BOX}`) as never), { to: "box", route: boxPage(BOX) });
  const switched = otherView(fromSettings, "terminal");
  assert.equal(subPathOf(switched), `box/${BOX}/terminal/from-box/from-settings`, "a switch keeps its origins");
  assert.deepEqual(pageOfView(boxView(BOX, "desktop", ["from-list"])), boxPage(BOX, ["from-list"]), "the name in the bar opens the page, keeping the list as its way back");
});

const NOW = new Date(2026, 9, 29, 18, 58).getTime();

function view(overrides: Partial<BoxView> = {}): BoxView {
  return {
    id: BOX,
    name: "amber-fox",
    kind: "linux",
    kindLabel: "Linux",
    backendLabel: "Proxmox LXC on pve-1",
    nature: "virtual",
    form: "LXC",
    shared: false,
    role: "box",
    size: "4 cores, 8 GiB memory, 32 GiB disk",
    state: "ready",
    error: null,
    stopped: null,
    createdAt: NOW - 3 * 3_600_000,
    readyAt: NOW - 3 * 3_600_000 + 3_600,
    os: "linux",
    arch: "x86_64",
    gpu: false,
    requires: [],
    extras: [],
    docker: true,
    desktop: false,
    display: null,
    control: null,
    computerUse: false,
    terminal: true,
    address: "10.20.0.31",
    facts: [],
    timings: { total: 3_600 },
    enrol: { state: "enrolled", hostId: "host_1", error: null },
    enrols: true,
    canStopStart: true,
    log: null,
    reach: { is: "answers", lastAnswered: null },
    ...overrides,
  };
}

test("durations and times are words, then numbers (section 11)", () => {
  assert.equal(span(40_000), "40 s");
  assert.equal(span(12 * 60_000), "12 min");
  assert.equal(span(134 * 60_000), "2 h 14 min");
  assert.equal(span((3 * 24 + 4) * 3_600_000), "3 d 4 h");
  assert.equal(ago(NOW - 10_000, NOW), "just now");
  assert.match(dayAndClock(NOW - 60_000, NOW), /^today at /);
  assert.match(dayAndClock(NOW - 24 * 3_600_000, NOW), /^yesterday at /);
  assert.equal(hostOf("Proxmox LXC on pve-1"), "pve-1");
  assert.equal(hostOf("SSH host pool"), null);
});

test("who did it, only as the box log has it", () => {
  assert.equal(actorWords({ is: "person" }, {}), "by you");
  assert.equal(actorWords({ is: "agent", threadId: "thr_1" }, { thr_1: "Fix the sign-in flow" }), "by the agent in Fix the sign-in flow");
  assert.equal(actorWords({ is: "command" }, {}), "by a bb box command");
  assert.equal(actorWords({ is: "bb-box", why: "its thread ended" }, {}), "by bb-box: its thread ended");
  assert.equal(actorWords({ is: "outside" }, {}), "outside bb-box");
  assert.equal(actorWords({ is: "unknown" }, {}), null);
  assert.equal(actorWords(null, {}), null);
});

test("the header says each state of section 7 in words, from the last start and the log, leaving out what it does not know", () => {
  const started = { askedAt: NOW - 46 * 60_000 - 2_000, readyAt: NOW - 46 * 60_000, failedAt: null, by: { is: "person" } as const, first: false };
  assert.deepEqual(headline(view({ log: { lastStart: started, lastStop: null, lastFailed: null } }), NOW, {}), { tone: "ok", words: "Ready", detail: ["up 46 min"] });
  assert.deepEqual(headline(view(), NOW, {}).detail, ["up 2 h 59 min"], "with no start in the log, from when it was ready");
  assert.deepEqual(headline(view({ state: "starting", log: { lastStart: { ...started, askedAt: NOW - 2_000, readyAt: null }, lastStop: null, lastFailed: null } }), NOW, {}), { tone: "busy", words: "Starting", detail: ["for 2 s"] });
  const stop = { at: NOW - (3 * 60 + 5) * 60_000, by: { is: "person" } as const, asked: true };
  const stopped = headline(view({ state: "stopped", log: { lastStart: null, lastStop: stop, lastFailed: null } }), NOW, {});
  assert.equal(stopped.words, "Stopped");
  assert.match(stopped.detail[0]!, /^3 h 5 min ago, today at .+, by you$/);
  assert.deepEqual(headline(view({ state: "stopped" }), NOW, {}), { tone: "off", words: "Stopped", detail: [] }, "no time or actor it does not know");
  assert.match(headline(view({ state: "stopped", log: { lastStart: null, lastStop: { ...stop, by: { is: "outside" }, asked: false }, lastFailed: null } }), NOW, {}).detail[0]!, /, outside bb-box$/);
  assert.deepEqual(headline(view({ state: "gone" }), NOW, {}), { tone: "bad", words: "Gone", detail: ["deleted outside bb-box"] });
  assert.deepEqual(headline(view({ state: "releasing" }), NOW, {}), { tone: "busy", words: "Releasing…", detail: [] });
  assert.deepEqual(headline(view({ enrol: { state: "failed", hostId: null, error: "No account" } }), NOW, {}).detail, ["up 2 h 59 min", "Could not join BB"]);
});

test("a release that did not finish says so, never a spinner without end", () => {
  const failed = { operation: "release" as const, at: NOW - 60_000, words: "Proxmox refused: the container is locked by a backup.", observed: { state: "running" as const, at: NOW - 60_000, from: "Proxmox LXC on pve-1" }, parts: [] };
  const box = view({ state: "releasing", log: { lastStart: null, lastStop: null, lastFailed: failed } });
  assert.deepEqual(headline(box, NOW, {}), { tone: "bad", words: "Release did not finish", detail: ["1 min ago"] });
  assert.deepEqual(failedNotice(box, NOW), { operation: "release", title: "Release did not finish 1 min ago", words: failed.words, then: "The box may still run on pve-1; bb-box keeps its record until a release is confirmed." });
  assert.equal(failedNotice({ ...box, log: { lastStart: null, lastStop: null, lastFailed: { ...failed, words: "docker container rm failed: device or resource busy" } } }, NOW)!.words, "docker container rm failed: device or resource busy.", "the backend's words end as a sentence");
  assert.equal(failedNotice(view({ log: { lastStart: null, lastStop: null, lastFailed: failed } }), NOW), null, "not once the box is no longer releasing");
});

test("a failed operation's words come from what bb-box then observed, with when; a resize names what changed (G6, words)", () => {
  const at = NOW - 2 * 60_000;
  const stop = { operation: "stop" as const, at, words: "Timed out waiting for the container to stop.", observed: { state: "running" as const, at, from: "Docker on devpc" }, parts: [] };
  const notice = failedNotice(view({ log: { lastStart: null, lastStop: null, lastFailed: stop } }), NOW)!;
  assert.equal(notice.title, "Stop failed 2 min ago");
  assert.match(notice.then, /^It is still running \(checked .+\)\.$/);
  const start = { ...stop, operation: "start" as const, observed: { state: "unknown" as const, at, from: "Proxmox QEMU on pve-1" } };
  assert.equal(failedNotice(view({ state: "stopped", log: { lastStart: null, lastStop: null, lastFailed: start } }), NOW)!.then, "bb-box could not confirm its state.", "a VM that never answers SSH is not called still stopped");
  assert.equal(observedWords(null), "bb-box could not confirm its state.");
  const resize = { ...stop, operation: "resize" as const, observed: null, parts: ["memory" as const] };
  assert.equal(failedNotice(view({ log: { lastStart: null, lastStop: null, lastFailed: resize } }), NOW)!.then, "Its memory changed before it failed.");
});

test("a backend not in settings and a host that does not answer say so, and why Stop, Start, Resize and New thread are off (G20)", () => {
  const removed = view({ reach: { is: "not-in-settings", backend: "Proxmox LXC on pve-old", lastAnswered: NOW - 2 * 24 * 3_600_000 } });
  assert.deepEqual(headline(removed, NOW, {}), { tone: "warn", words: "Not checked", detail: ["last seen ready 2 d ago"] });
  assert.equal(unreachableWhy(removed), "Its backend is not in settings");
  assert.match(settingsNotice(removed)!, /^Proxmox LXC on pve-old was removed from bb-box's settings, so bb-box cannot check, stop or release amber-fox, which may still be running on pve-1\./);
  const silent = view({ reach: { is: "not-answering", since: NOW - 12 * 60_000, lastAnswered: NOW - 12 * 60_000, nextCheckAt: NOW + 4 * 60_000, checking: false, attempts: 2, error: "It did not answer a command.", host: "pve-3" } });
  assert.deepEqual(headline(silent, NOW, {}), { tone: "warn", words: "Not answering", detail: ["last seen ready 12 min ago"] });
  assert.equal(unreachableWhy(silent), "amber-fox does not answer");
  const notice = reachNotice(silent, NOW)!;
  assert.equal(notice.title, "amber-fox does not answer");
  assert.match(notice.words, /^It did not answer a command\. Since .+, bb-box cannot read, stop or start it on pve-3\. bb-box checks again in 4 min\.$/);
  assert.equal(unreachableWhy(view()), null);
});

test("a released box and a forgotten one say which, with when and who, and a forgotten one never says released (G5's words)", () => {
  const released = endedWords({ box: BOX, thread: "thr_1", name: "amber-fox", how: "released", at: NOW - 5 * 60_000, by: { is: "person" }, backend: "Proxmox LXC on pve-1", state: "ready" }, NOW, {});
  assert.equal(released.title, "amber-fox was released");
  assert.match(released.words, /^Released 5 min ago, today at .+, by you\. bb-box remembers a released box for 24 hours\.$/);
  const forgotten = endedWords({ box: BOX, thread: "thr_1", name: "maple-row", how: "forgotten", at: NOW - 60_000, by: { is: "command" }, backend: "Proxmox LXC on pve-old", state: "ready" }, NOW, {});
  assert.equal(forgotten.title, "maple-row was forgotten");
  assert.match(forgotten.words, /^bb-box removed its record\. Its box was not deleted and may still run on pve-old\. Forgotten 1 min ago, today at .+, by a bb box command\.$/);
  assert.doesNotMatch(forgotten.words + forgotten.title, /released/i);
});
