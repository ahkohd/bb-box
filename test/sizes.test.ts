import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseSize,
  defaultSize,
  describePresets,
  describeSize,
  fits,
  kindSizes,
  LINUX_LEAST_MEMORY_GIB,
  parseSizeChanges,
  presetSizes,
  withEarlierSizes,
} from "../src/core/sizes.ts";
import { KIND_INFO } from "../src/backends/kinds.ts";

const GiB = 1024;

test("each kind ships three presets, small by default, and a largest size twice large with a 256 GiB disk", () => {
  const linux = kindSizes("linux");
  assert.deepEqual(linux.presets, {
    small: { cores: 2, memoryMiB: 4 * GiB, diskGiB: null },
    medium: { cores: 4, memoryMiB: 8 * GiB, diskGiB: null },
    large: { cores: 8, memoryMiB: 16 * GiB, diskGiB: null },
  });
  assert.equal(linux.default, "small");
  assert.deepEqual(linux.largest, { cores: 16, memoryMiB: 32 * GiB, diskGiB: 256 });
  assert.deepEqual(kindSizes("linux-docker"), linux);
  assert.deepEqual(kindSizes("linux-headless"), linux, "an earlier ID gives the kind's sizes");
  const desktop = kindSizes("linux-desktop");
  assert.deepEqual(defaultSize(desktop), { cores: 4, memoryMiB: 8 * GiB, diskGiB: null });
  assert.deepEqual(desktop.largest, { cores: 32, memoryMiB: 64 * GiB, diskGiB: 256 });
  assert.deepEqual(kindSizes("linux-desktop-cpu"), desktop);
  const macos = kindSizes("macos");
  assert.deepEqual(macos.presets, {
    small: { cores: 4, memoryMiB: 8 * GiB, diskGiB: null },
    medium: { cores: 6, memoryMiB: 16 * GiB, diskGiB: null },
    large: { cores: 8, memoryMiB: 32 * GiB, diskGiB: null },
  });
  assert.deepEqual(macos.largest, { cores: 16, memoryMiB: 64 * GiB, diskGiB: 256 });
  assert.deepEqual(kindSizes("macos-desktop"), macos);
  assert.deepEqual(kindSizes("windows-desktop"), desktop);
  assert.deepEqual(kindSizes("solaris"), linux, "a kind bb-box has no sizes for takes linux's");
});

test("the box-sizes setting changes a kind's presets, default and largest", () => {
  const { changes, problems } = parseSizeChanges(
    JSON.stringify({ linux: { default: "medium", medium: { diskGiB: 40 }, largest: { cores: 24 } }, "linux-desktop": { small: { memoryMiB: 12 * GiB } } }),
  );
  assert.deepEqual(problems, []);
  const linux = kindSizes("linux", changes);
  assert.equal(linux.default, "medium");
  assert.deepEqual(defaultSize(linux), { cores: 4, memoryMiB: 8 * GiB, diskGiB: 40 });
  assert.deepEqual(linux.largest, { cores: 24, memoryMiB: 32 * GiB, diskGiB: 256 });
  assert.deepEqual(kindSizes("linux-desktop", changes).presets.small, { cores: 4, memoryMiB: 12 * GiB, diskGiB: null });
  assert.deepEqual(kindSizes("linux-docker", changes), linux, "an alias takes its kind's sizes (041)");
  assert.deepEqual(kindSizes("linux-desktop-cpu", changes), kindSizes("linux-desktop-cpu"), "each kind has its own entry");
  assert.deepEqual(parseSizeChanges(""), { changes: {}, problems: [] });
  assert.deepEqual(parseSizeChanges(undefined), { changes: {}, problems: [] });
});

test("an earlier kind ID in box-sizes counts only when the current ID has no entry", () => {
  const earlier = parseSizeChanges({ "linux-headless": { default: "large" } });
  assert.equal(kindSizes("linux", earlier.changes).default, "large");
  const both = parseSizeChanges({ linux: { default: "medium" }, "linux-headless": { default: "large" } });
  assert.equal(kindSizes("linux", both.changes).default, "medium");
});

test("a box-sizes entry with a mistake is refused, and the kind keeps the shipped sizes", () => {
  const problems = (value: unknown) => {
    const result = parseSizeChanges(value);
    assert.deepEqual(result.changes, {}, JSON.stringify(value));
    return result.problems.join(" ");
  };
  assert.match(problems("{"), /^Box sizes is not JSON: /);
  assert.match(problems("[]"), /must be a JSON object with an entry per kind/);
  assert.match(problems({ linux: 4 }), /^linux must be an object/);
  assert.match(problems({ linux: { huge: {} } }), /^linux has huge; use default, small, medium, large and largest\./);
  assert.match(problems({ linux: { default: "tiny" } }), /^linux\.default must be small, medium or large\./);
  assert.match(problems({ linux: { small: { cores: 0 } } }), /^linux\.small\.cores must be a whole number of at least 1\./);
  assert.match(problems({ linux: { small: { memoryMiB: 100 } } }), /^linux\.small\.memoryMiB must be a whole number of at least 256\./);
  assert.match(problems({ linux: { small: { diskGiB: 1.5 } } }), /^linux\.small\.diskGiB must be a whole number of at least 1, or null for the base disk\./);
  assert.match(problems({ linux: { largest: { diskGiB: null } } }), /^linux\.largest\.diskGiB must be a whole number of at least 1\./);
  assert.match(problems({ linux: { small: { gpus: 1 } } }), /^linux\.small has gpus; use cores, memoryMiB and diskGiB\./);
  assert.match(problems({ linux: { large: { cores: 32 } } }), /^linux's large preset, 32 cores, 16 GiB memory, is above its largest size, 16 cores, 32 GiB memory, 256 GiB disk\./);
  const mixed = parseSizeChanges({ linux: { default: "tiny" }, "linux-desktop": { default: "large" } });
  assert.deepEqual(mixed.changes, { "linux-desktop": { default: "large" } }, "a good entry still counts");
  assert.equal(mixed.problems.length, 1);
});

test("a size request takes parts from its preset, or else the default preset, up to the largest", () => {
  const sizes = kindSizes("linux");
  assert.deepEqual(chooseSize("linux", sizes), { ok: true, size: { cores: 2, memoryMiB: 4 * GiB, diskGiB: null } });
  assert.deepEqual(chooseSize("linux", sizes, { preset: " Large " }), { ok: true, size: { cores: 8, memoryMiB: 16 * GiB, diskGiB: null } });
  assert.deepEqual(chooseSize("linux", sizes, { memoryGiB: 6 }), { ok: true, size: { cores: 2, memoryMiB: 6 * GiB, diskGiB: null } });
  assert.deepEqual(chooseSize("linux", sizes, { preset: "medium", cores: 6, diskGiB: 64 }), { ok: true, size: { cores: 6, memoryMiB: 8 * GiB, diskGiB: 64 } });
  assert.deepEqual(chooseSize("linux", sizes, { cores: 16, memoryGiB: 32, diskGiB: 256 }), { ok: true, size: sizes.largest });

  const refused = (request: Parameters<typeof chooseSize>[2]) => {
    const choice = chooseSize("linux", sizes, request);
    assert.ok(!choice.ok, JSON.stringify(request));
    return choice.message;
  };
  assert.equal(
    refused({ preset: "huge" }),
    'There is no "huge" size for a linux box. Its presets are small (2 cores, 4 GiB memory, the default), medium (4 cores, 8 GiB memory) and large (8 cores, 16 GiB memory), and the largest is 16 cores, 32 GiB memory, 256 GiB disk.',
  );
  assert.match(refused({ cores: 0 }), /whole numbers of at least 1/);
  assert.match(refused({ memoryGiB: 1.5 }), /whole numbers of at least 1/);
  assert.match(refused({ cores: 17 }), /^A linux box can be at most 16 cores, 32 GiB memory, 256 GiB disk, not 17 cores, 4 GiB memory\. Its presets are small/);
  assert.match(refused({ diskGiB: 257 }), /not 2 cores, 4 GiB memory, 257 GiB disk/);
});

test("a custom size of a Linux kind has at least 2 GiB memory, and every preset bb-box ships has that", () => {
  assert.equal(LINUX_LEAST_MEMORY_GIB, 2);
  const linux = kindSizes("linux");
  assert.deepEqual(chooseSize("linux", linux, { memoryGiB: 2 }), { ok: true, size: { cores: 2, memoryMiB: 2 * GiB, diskGiB: null } });
  assert.deepEqual(chooseSize("linux", linux, { memoryGiB: 1 }), {
    ok: false,
    message:
      "A linux box needs at least 2 GiB memory, not 1 GiB: with less it can run out of memory as it becomes a BB machine. " +
      "Its presets are small (2 cores, 4 GiB memory, the default), medium (4 cores, 8 GiB memory) and large (8 cores, 16 GiB memory).",
  });
  for (const kind of ["linux-desktop-cpu", "linux-arm64", "linux-headless"]) {
    const choice = chooseSize(kind, kindSizes(kind), { cores: 4, memoryGiB: 1 });
    assert.ok(!choice.ok && choice.message.startsWith(`A ${kind} box needs at least 2 GiB memory, not 1 GiB`), kind);
  }
  assert.equal(chooseSize("macos", kindSizes("macos"), { memoryGiB: 1 }).ok, true, "the floor is for Linux kinds");
  assert.equal(chooseSize("windows-desktop", kindSizes("windows-desktop"), { memoryGiB: 1 }).ok, true, "the floor is for Linux kinds");

  const linuxKinds = Object.entries(KIND_INFO).filter(([, info]) => info.os === "linux").map(([id]) => id);
  assert.ok(linuxKinds.length >= 5);
  for (const kind of linuxKinds) {
    for (const preset of presetSizes(kindSizes(kind))) assert.ok(preset.memoryMiB >= LINUX_LEAST_MEMORY_GIB * GiB, `${kind}: ${describeSize(preset)}`);
  }
});

test("sizes are described in words, leaving out the base disk", () => {
  assert.equal(describeSize({ cores: 1, memoryMiB: 512, diskGiB: null }), "1 core, 512 MiB memory");
  assert.equal(describeSize({ cores: 4, memoryMiB: 1536, diskGiB: 32 }), "4 cores, 1.5 GiB memory, 32 GiB disk");
  assert.match(describePresets(kindSizes("linux-desktop")), /^small \(4 cores, 8 GiB memory, the default\), medium \(8 cores, 16 GiB memory\) and large/);
  assert.equal(fits({ cores: 2, memoryMiB: 4 * GiB, diskGiB: null }, { cores: 2, memoryMiB: 4 * GiB, diskGiB: 8 }), true, "the base disk fits");
  assert.equal(fits({ cores: 2, memoryMiB: 4 * GiB, diskGiB: 9 }, { cores: 2, memoryMiB: 4 * GiB, diskGiB: 8 }), false);
});

test("sizes saved before 028 become each kind's default preset, once, and larger presets are never smaller", () => {
  const six = { cores: 6, memoryMiB: 6 * GiB, diskGiB: 20 };
  const adopted = withEarlierSizes(undefined, { linux: six });
  assert.ok(adopted);
  const { changes, problems } = parseSizeChanges(adopted);
  assert.deepEqual(problems, []);
  const linux = kindSizes("linux", changes);
  assert.deepEqual(defaultSize(linux), six);
  assert.deepEqual(linux.presets.medium, { cores: 6, memoryMiB: 8 * GiB, diskGiB: 20 });
  assert.deepEqual(linux.presets.large, { cores: 8, memoryMiB: 16 * GiB, diskGiB: 20 });
  assert.deepEqual(linux.largest, { cores: 16, memoryMiB: 32 * GiB, diskGiB: 256 });
  assert.deepEqual(kindSizes("linux-docker", changes), linux);

  // Larger than the largest: the largest grows to it.
  const big = withEarlierSizes("", { "linux-desktop": { cores: 40, memoryMiB: 8 * GiB, diskGiB: 300 } });
  const desktop = kindSizes("linux-desktop", parseSizeChanges(big).changes);
  assert.deepEqual(desktop.largest, { cores: 40, memoryMiB: 64 * GiB, diskGiB: 300 });
  assert.deepEqual(desktop.presets.large, { cores: 40, memoryMiB: 32 * GiB, diskGiB: 300 });

  // Smaller than shipped: the default preset is that size, and the others stay.
  const small = kindSizes("linux", parseSizeChanges(withEarlierSizes("", { linux: { cores: 1, memoryMiB: 2 * GiB, diskGiB: null } })).changes);
  assert.deepEqual(defaultSize(small), { cores: 1, memoryMiB: 2 * GiB, diskGiB: null });
  assert.deepEqual(small.presets.medium, kindSizes("linux").presets.medium);

  // Nothing to change.
  assert.equal(withEarlierSizes("", {}), null);
  assert.equal(withEarlierSizes("", { linux: defaultSize(kindSizes("linux")) }), null, "the shipped default needs no entry");
  assert.equal(withEarlierSizes('{"linux":{"default":"large"}}', { linux: six }), null, "an entry the operator wrote wins");
  assert.equal(withEarlierSizes('{"linux-headless":{}}', { linux: six }), null, "under an earlier ID too");
  assert.equal(withEarlierSizes("{", { linux: six }), null, "a setting that is not JSON is left for its owner to fix");
  assert.equal(withEarlierSizes("[]", { linux: six }), null);

  // Other entries are kept.
  const kept = JSON.parse(withEarlierSizes('{"linux-desktop":{"default":"medium"}}', { linux: six })!);
  assert.deepEqual(kept["linux-desktop"], { default: "medium" });
  assert.deepEqual(kept.linux.small, { cores: 6, memoryMiB: 6 * GiB, diskGiB: 20 });
});
