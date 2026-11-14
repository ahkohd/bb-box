import "./check-test-machine.mjs";
import { expect, test } from "vitest";
import type { ConfigDocument } from "../src/core/document.ts";
import type { ConfigState } from "../src/plugin/contract.ts";
import { hashOf, viewFromHash } from "../src/app/settings-route.ts";
import { backendHealth, kindAvailability, statusItems, statusLine } from "../src/app/settings-status.ts";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function state(backends: { id: string; enabled?: boolean; checkedAgo?: number | null; ok?: boolean; misconfigured?: boolean; kinds?: string[]; changedAfterCheck?: boolean }[], kinds: Record<string, { enabled: boolean }> = {}): ConfigState {
  const document: ConfigDocument = { schema: 1, revision: 7, backends: backends.map((backend) => ({ id: backend.id, type: "fake", enabled: backend.enabled ?? true, fields: {} })), kinds, general: {} };
  const size = { cores: 2, memoryMiB: 4096, diskGiB: null };
  return {
    document,
    revision: 7,
    defaults: {
      general: { boxesPerThread: 0, enrol: true, defaultKind: "linux", video: true, nightlyImages: false, testDevice: false, encoderLedger: true, iosEncoder: "auto" },
      monitor: { enabled: true, refreshIntervalSeconds: 5, backgroundMonitoring: false, pressureNotifications: true, boxHistory: true },
      kinds: { linux: { enabled: true, presets: { small: size, medium: size, large: size }, default: "small", largest: size }, android: { enabled: true, presets: { small: size, medium: size, large: size }, default: "small", largest: size } },
    },
    kinds: [
      { id: "linux", label: "Linux", description: "", gpu: false, desktop: false, os: "linux", arch: "x86_64", features: [], device: null, docker: true, drivers: ["fake"], spares: { ready: 0, making: 0 } },
      { id: "android", label: "Android emulator", description: "", gpu: false, desktop: true, os: "linux", arch: "x86_64", features: [], device: "android", docker: false, drivers: ["other"], spares: { ready: 0, making: 0 } },
    ],
    drivers: [],
    backends: backends.map((backend) => ({
      id: backend.id,
      type: "fake",
      label: `Fake ${backend.id}`,
      form: "LXC",
      state: backend.misconfigured ? "misconfigured" : (backend.enabled ?? true) ? "active" : "off",
      problems: backend.misconfigured ? [{ path: `backends.${backend.id}.token`, message: "Set the API token." }] : [],
      boxes: 0,
      kinds: backend.kinds ?? ["linux"],
      doctor:
        backend.checkedAgo === null || backend.checkedAgo === undefined
          ? null
          : { at: NOW - backend.checkedAgo, revision: 5, report: { ok: backend.ok ?? true, summary: "Fake 1.0", checks: backend.ok === false ? [{ id: "proxmox.api" as const, name: "SSH", status: "fail" as const, detail: "No answer over SSH.", fix: "Check the host is on." }] : [], notes: [] } },
      warmShort: [],
      changed: backend.changedAfterCheck ? 6 : 5,
    })),
    problems: [],
    migrated: null,
    receipts: [],
    setupDone: null,
  };
}

test("the hash names each view, and anything else is the overview", () => {
  for (const view of [{ page: "backend", id: "docker:pc-1" }, { page: "kind", id: "linux-desktop" }, { page: "option", id: "monitor" }, { page: "add" }, { page: "setup", type: "tart" }] as const) {
    expect(viewFromHash(hashOf(view))).toEqual(view);
  }
  expect(hashOf({ page: "backend", id: "docker:pc-1" })).toBe("#backend/docker%3Apc-1");
  expect(viewFromHash("")).toEqual({ page: "overview" });
  expect(viewFromHash("#backend/")).toEqual({ page: "overview" });
  expect(viewFromHash("#bogus/x")).toEqual({ page: "overview" });
  expect(viewFromHash("#kind/%E0%A4")).toEqual({ page: "kind", id: "%E0%A4" });
});

test("status is never more certain than the checks: ready within the hour, passed their last check after, with the range of ages", () => {
  expect(statusLine(state([{ id: "a", checkedAgo: 60_000 }, { id: "b", checkedAgo: 120_000 }]), NOW, 0)).toMatchObject({ headline: "All 2 backends ready", checkFirst: false, tone: "ok" });
  const old = statusLine(state([{ id: "a", checkedAgo: 4 * 60_000 }, { id: "b", checkedAgo: 6 * HOUR }]), NOW, 0);
  expect(old.headline).toBe("All 2 backends passed their last check");
  expect(old.details).toContain("checked between 4 min ago and 6 h ago");
  expect(old.checkFirst).toBe(true);
  expect(statusLine(state([{ id: "a", checkedAgo: 6 * HOUR }]), NOW, 0).headline).toBe("Fake a passed its last check");
  expect(statusLine(state([{ id: "a", checkedAgo: null }]), NOW, 0)).toMatchObject({ headline: "Fake a is not checked yet", checkFirst: true });
  const changed = state([{ id: "a", checkedAgo: 60_000, changedAfterCheck: true }, { id: "b", checkedAgo: 60_000 }]);
  expect(backendHealth(changed, changed.document.backends[0]!, NOW)).toMatchObject({ status: "changed", words: "Not checked since it changed" });
  expect(statusLine(changed, NOW, 0)).toMatchObject({ headline: "1 of 2 backends ready", checkFirst: true });
  expect(statusLine(changed, NOW, 0).details).toContain("1 not checked since it changed");
  expect(statusLine(state([{ id: "a", checkedAgo: 30_000 }, { id: "b", enabled: false }]), NOW, 0).details).toEqual(["1 off", "1 kind on offer", "checked just now"]);
  expect(statusLine(state([{ id: "a", enabled: false }]), NOW, 0).headline).toBe("Every backend is off");
  expect(statusItems(state([{ id: "a", enabled: false }, { id: "b", enabled: false }]), NOW)[0]).toMatchObject({ key: "all-off", title: "Every backend is off", fix: "Turn a backend on with its switch below.", open: { page: "overview" }, showSwitch: "a" });
  expect(statusItems(state([{ id: "a", enabled: false }, { id: "b", checkedAgo: 60_000 }]), NOW).some((item) => item.key === "all-off")).toBe(false);
  expect(statusLine(state([{ id: "a", checkedAgo: 60_000 }]), NOW, 3).headline).toBe("Checking 3 backends, up to 30 s each, side by side…");
});

test("a failed check, a backend with a problem and a default kind that is off are each listed with their fix", () => {
  const failing = state([{ id: "a", checkedAgo: 60_000, ok: false }, { id: "b", misconfigured: true }], { linux: { enabled: false } });
  expect(backendHealth(failing, failing.document.backends[0]!, NOW)).toMatchObject({ status: "failing", words: "Not working", detail: "No answer over SSH.", fix: "Check the host is on." });
  const items = statusItems(failing, NOW);
  expect(items.map((item) => [item.title, item.open])).toEqual([
    ["Fake a", { page: "backend", id: "a" }],
    ["Fake b", { page: "backend", id: "b" }],
    ["The default kind, Linux, is off", { page: "option", id: "boxes" }],
  ]);
  const unfinished = { ...state([{ id: "a", enabled: false }]), problems: [{ path: "backends.a.url", message: "Set the API URL." }] };
  expect(backendHealth(unfinished, unfinished.document.backends[0]!, NOW)).toMatchObject({ status: "unfinished", words: "Not finished", detail: "Set the API URL." });
});

test("a kind no backend you have makes is quiet, and one whose backends cannot make it now is not", () => {
  const healthy = state([{ id: "a", checkedAgo: 60_000 }]);
  expect([kindAvailability(healthy, "linux"), kindAvailability(healthy, "android")]).toEqual(["offered", "none"]);
  const stuck = state([{ id: "a", misconfigured: true, kinds: [] }]);
  expect(kindAvailability(stuck, "linux")).toBe("lost");
  expect(kindAvailability(state([{ id: "a" }], { linux: { enabled: false } }), "linux")).toBe("off");
});
