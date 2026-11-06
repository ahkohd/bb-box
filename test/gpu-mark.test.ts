import assert from "node:assert/strict";
import { test } from "node:test";
import { answerTo, deviceSetOf, judgeGpuMigration, linesFor, parseHelperLines, parseMarker, planMark, planUnmark, rawGpuLines, withGpuTagsOf, type GuestLook, type MarkContext } from "../src/backends/proxmox-lxc/gpu-marking.ts";
import { parseTags } from "../src/backends/proxmox/api.ts";
import type { GpuMarkGuest, GpuMarking } from "../src/backends/types.ts";
import { gpuCommands, guestLine, markingFailed, markingText } from "../src/plugin/gpu-cli.ts";
import type { BbBox } from "../src/plugin/setup.ts";
import { Bridge, desktop, request, today } from "./gpu-helper/bridge.ts";
import { CARD_A, CARD_B, INSTALL, REPORT_VMID, boxLabels, cardLines, marker } from "./gpu-helper/node.ts";

const A = CARD_A.uuid;
const B = CARD_B.uuid;
const byVmid = (marking: GpuMarking) => new Map(marking.guests.map((guest) => [guest.vmid, guest]));

function nothingButTags(before: Map<number, Record<string, string>>, after: Map<number, Record<string, string>>): void {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [vmid, config] of before) {
    const { tags: _before, ...rest } = config;
    const { tags: _after, ...now } = after.get(vmid)!;
    assert.deepEqual(now, rest, `CT ${vmid}: only its tags may change`);
  }
}


test("bb box gpu mark marks each of this install's guests whose lines name a card, running or stopped, warm guests too, with the card its lines give; the real helper, in a dry run, grants each and would write nothing; only tags change (071 unit 4)", async () => {
  const bridge = new Bridge();
  today(bridge);
  bridge.helper();
  const backend = bridge.backend();
  const before = bridge.configs();
  const nodeBefore = new Map([7001, 7002, 7003, 7004].map((vmid) => [vmid, bridge.node.text(vmid)]));

  const marking = await backend.markGpus(request());
  assert.equal(marking.refused, null);
  const guests = byVmid(marking);
  assert.deepEqual([...guests.keys()], [7001, 7002, 7003, 7004], "only this install's guests that hold a card, in its pool, and none bb-box makes and removes itself");
  assert.deepEqual(
    [...guests.values()].map((guest) => [guest.vmid, guest.outcome, guest.marker, guest.card, guest.running, guest.answer]),
    [
      [7001, "marked", marker("shared", CARD_A, 1), "card 0", true, "granted"],
      [7002, "marked", marker("shared", CARD_B, 1), "card 1", false, "granted"],
      [7003, "marked", marker("shared", CARD_A, 1), "card 0", true, "granted"],
      [7004, "marked", marker("shared", CARD_B, 1), "card 1", true, "granted"],
    ],
  );
  assert.equal(marking.withoutCards, 2, "the server and the CPU desktop with no card's lines need no marker");
  assert.deepEqual(bridge.tags(7001), [...boxLabels("bx7001", "amber-fox", "linux-desktop").tags, marker("shared", CARD_A, 1)], "every tag it had stays, the marker last");
  assert.deepEqual(bridge.tags(7004), ["bb-box", `install.${INSTALL}`, "warm", "template.9001", "bb-box-starting", marker("shared", CARD_B, 1)]);
  for (const vmid of [7005, 7006, 9001, 7010, 7011, 7012, 7013, 7014, 7015]) assert.deepEqual(bridge.configs().get(vmid), before.get(vmid), `CT ${vmid} is left as it was`);
  nothingButTags(before, bridge.configs());

  const writes = bridge.tagWrites();
  assert.deepEqual(writes.map((write) => [write.method, write.path, Object.keys(write).filter((key) => !["method", "path"].includes(key)).sort().join(" ")]), [7001, 7002, 7003, 7004].map((vmid) => ["PUT", `/nodes/pve/lxc/${vmid}/config`, "digest tags"]), "only a tags write per guest, made on its config's digest: no start, stop, resize or device change");
  assert.equal(bridge.proxmox.guests.get(7001)!.status, "running", "a running box is marked as it runs");

  for (const [vmid, text] of nodeBefore) {
    assert.equal(bridge.node.text(vmid).replace(/^tags: .*$/m, ""), text.replace(/^tags: .*$/m, ""), `CT ${vmid}'s device lines and everything but its tags are as they were on the node`);
  }
  assert.deepEqual(bridge.node.guestWrites(), [], "the helper wrote no guest");
  const report = parseHelperLines(bridge.node.report());
  assert.deepEqual(report.would, [], "in its dry run the helper would write no guest");
  assert.deepEqual(
    report.holders.filter((holder) => [7001, 7002, 7003, 7004].includes(holder.vmid)).map((holder) => [holder.vmid, holder.managed]),
    [
      [7001, true],
      [7003, true],
      [7002, true],
      [7004, true],
    ],
  );

  const again = await backend.markGpus(request());
  assert.deepEqual(again.guests.map((guest) => [guest.vmid, guest.outcome, guest.answer]), [7001, 7002, 7003, 7004].map((vmid) => [vmid, "already", "granted"]));
  assert.equal(bridge.tagWrites().length, writes.length, "a second run writes nothing");

  const text = markingText([marking]);
  assert.match(text, /^Proxmox LXC on pve: marked 4 guests\.\n/);
  assert.match(text, new RegExp(`\\n  CT 7001 amber-fox, running, card 0: marked gpu\\.shared\\.${A}\\.g1\\. The GPU helper granted it\\.\\n`));
  assert.match(text, /\n2 other guests of this install have no card's device lines and need no marker\.$/);
  assert.equal(markingFailed([marking]), false);
});

test("--check says what it would mark, and changes nothing", async () => {
  const bridge = new Bridge();
  today(bridge);
  bridge.helper();
  const before = bridge.configs();
  const checked = await bridge.backend().markGpus(request({ check: true }));
  assert.deepEqual(checked.guests.map((guest) => [guest.vmid, guest.outcome, guest.marker, guest.answer]), [
    [7001, "would-mark", marker("shared", CARD_A, 1), null],
    [7002, "would-mark", marker("shared", CARD_B, 1), null],
    [7003, "would-mark", marker("shared", CARD_A, 1), null],
    [7004, "would-mark", marker("shared", CARD_B, 1), null],
  ]);
  assert.deepEqual(bridge.configs(), before);
  assert.deepEqual(bridge.tagWrites(), []);
  assert.equal(bridge.helperRuns, 1, "it waits for no answer");
  assert.match(markingText([checked]), /^Proxmox LXC on pve: would mark 4 guests; changes nothing \(--check\)\./);
});

test("bb box gpu mark refuses, naming why and changing nothing, a guest whose lines the helper would rewrite or refuse: an unknown card, two cards, lines that are not the card's set, a lock, a device change waiting, a privileged container, another install's description, another marker, a record that says no GPU, and a whole card another guest holds", async () => {
  const bridge = new Bridge();
  const card0Desktop = cardLines(CARD_A, "desktop");
  bridge.guest(7020, desktop("bx7020", "unknown-card", CARD_A, { lines: ["/dev/nvidia7,mode=0666", "/dev/nvidiactl,mode=0666"] }));
  bridge.guest(7021, desktop("bx7021", "two-cards", CARD_A, { lines: [...card0Desktop, "/dev/nvidia0,mode=0666"] }));
  bridge.guest(7022, desktop("bx7022", "no-modeset", CARD_A, { lines: card0Desktop.filter((line) => !line.includes("modeset")) }));
  bridge.guest(7023, { box: "bx7023", name: "server-desktop-lines", kind: "linux", lines: card0Desktop });
  bridge.guest(7024, desktop("bx7024", "locked", CARD_A, { lock: "backup" }));
  bridge.guest(7025, desktop("bx7025", "pending", CARD_A), [{ key: "dev7", pending: "/dev/net/tun" }]);
  bridge.guest(7026, desktop("bx7026", "privileged", CARD_A, { unprivileged: false }));
  bridge.guest(7027, { ...desktop("bx7027", "mislabelled"), description: "bb-box mislabelled\ninstall zz99\nbox bx7027\nkind linux-desktop" });
  bridge.guest(7028, desktop("bx7028", "other-marker", CARD_A, { marker: marker("shared", CARD_B, 1) }));
  bridge.guest(7029, desktop("bx7029", "none-marker", CARD_A, { marker: marker("none", null, 1) }));
  bridge.guest(7030, desktop("bx7030", "record-none", CARD_A));
  bridge.guest(7031, desktop("bx7031", "wants-whole", CARD_A));
  bridge.guest(7032, desktop("bx7032", "malformed", CARD_A, { marker: `gpu.shared.GPU-${A}.g1` }));
  bridge.guest(7033, { box: "bx7033", name: "stray-marker", kind: "linux", marker: marker("shared", CARD_A, 1) });
  bridge.helper();
  const before = bridge.configs();
  const marking = await bridge.backend().markGpus(request({ parts: [["bx7030", "none"], ["bx7031", "whole"]] }));
  const why = new Map(marking.guests.map((guest) => [guest.vmid, [guest.outcome, guest.why]]));
  assert.deepEqual(Object.fromEntries(why), {
    7020: ["refused", "Its device lines name /dev/nvidia7, which no card in the GPU helper's report has."],
    7021: ["refused", "Its device lines name card 0 and card 1; a guest holds one card at most."],
    7022: ["refused", "Its device lines are not the ones the helper gives a desktop on card 0: it lacks /dev/nvidia-modeset,mode=0666. Marked, the helper would rewrite them once writes are on."],
    7023: ["refused", "Its device lines are not the ones the helper gives a server on card 0: it has /dev/dri/card2,mode=0666, /dev/dri/renderD129,mode=0666 and /dev/nvidia-modeset,mode=0666 besides. Marked, the helper would rewrite them once writes are on."],
    7024: ["refused", "It is locked (backup). Run bb box gpu mark again once the lock is gone."],
    7025: ["refused", "It has a device change waiting for its next start, which the helper refuses to act beside. Run bb box gpu mark again after it restarts."],
    7026: ["refused", "It is a privileged container, which the helper never writes."],
    7027: ["refused", `Its description does not name install ${INSTALL}, so it is not this install's to the helper.`],
    7028: ["refused", `It already has the tag ${marker("shared", CARD_B, 1)}, not the marker its lines give, gpu.shared.${A}; bb box gpu mark leaves a marker it did not write.`],
    7029: ["refused", `It already has the tag gpu.none.g1, not the marker its lines give, gpu.shared.${A}; bb box gpu mark leaves a marker it did not write.`],
    7030: ["refused", "Its box's record says no GPU, but its device lines name card 0: say which it should have before it is marked."],
    7031: ["refused", "Its box's record says a whole card, but card 0 is also held by CT 7021, CT 7022, CT 7023, CT 7024, CT 7025, CT 7026, CT 7027, CT 7028, CT 7029, CT 7030 and CT 7032, so the helper would refuse it."],
    7032: ["refused", `It already has the tag gpu.shared.GPU-${A}.g1, not the marker its lines give, gpu.shared.${A}; bb box gpu mark leaves a marker it did not write.`],
    7033: ["refused", `It has the tag ${marker("shared", CARD_A, 1)} and no card's device lines; bb box gpu mark leaves a marker it did not write.`],
  });
  assert.deepEqual(bridge.configs(), before, "no guest changed");
  assert.deepEqual(bridge.tagWrites(), []);
  assert.equal(markingFailed([marking]), true);
  assert.match(guestLine(marking.guests.find((guest) => guest.vmid === 7024)!), /^  CT 7024 locked, stopped: not marked\. It is locked \(backup\)\./);
  assert.match(guestLine(marking.guests.find((guest) => guest.vmid === 7028)!), new RegExp(`^  CT 7028 other-marker, stopped, card 0: left with ${marker("shared", CARD_B, 1).replace(/\./g, "\\.")}\\.`));
});

test("a box whose record says a whole card, alone on it, is marked whole, and the helper grants it whole", async () => {
  const bridge = new Bridge();
  bridge.guest(7040, desktop("bx7040", "long-job", CARD_B, { running: true }));
  bridge.guest(7041, desktop("bx7041", "sharer", CARD_A));
  bridge.helper();
  const marking = await bridge.backend().markGpus(request({ parts: [["bx7040", "whole"], ["bx7041", "shared"]] }));
  assert.deepEqual(marking.guests.map((guest) => [guest.vmid, guest.marker, guest.answer]), [
    [7040, marker("whole", CARD_B, 1), "granted"],
    [7041, marker("shared", CARD_A, 1), "granted"],
  ]);
  assert.ok(bridge.node.reportLines().includes(`holder ${B} 7040 whole running install ${INSTALL} managed`));
  assert.deepEqual(bridge.node.guestWrites(), []);
});

test("--undo clears each claim through the helper, then takes the shared and whole markers off, and only those, keeping every other tag; --check says so first; a second undo changes nothing (071 unit 5)", async () => {
  const bridge = new Bridge();
  today(bridge);
  bridge.guest(7050, { box: "bx7050", name: "none-marked", kind: "linux", marker: marker("none", null, 1) });
  bridge.guest(7051, desktop("bx7051", "malformed", CARD_A, { marker: "gpu.shared.nonsense.g1" }));
  bridge.helper();
  const backend = bridge.backend();
  const before = bridge.configs();
  await backend.markGpus(request());
  const marked = bridge.configs();
  const checked = await backend.markGpus(request({ undo: true, check: true }));
  assert.deepEqual(checked.guests.map((guest) => [guest.vmid, guest.outcome]), [
    [7001, "would-unmark"],
    [7002, "would-unmark"],
    [7003, "would-unmark"],
    [7004, "would-unmark"],
    [7050, "kept"],
    [7051, "kept"],
  ]);
  assert.deepEqual(bridge.configs(), marked, "--check changes nothing");
  const undone = await backend.markGpus(request({ undo: true }));
  assert.deepEqual(undone.guests.map((guest) => [guest.vmid, guest.outcome, guest.marker, guest.answer]), [
    [7001, "unmarked", marker("shared", CARD_A, 1), "released"],
    [7002, "unmarked", marker("shared", CARD_B, 1), "released"],
    [7003, "unmarked", marker("shared", CARD_A, 1), "released"],
    [7004, "unmarked", marker("shared", CARD_B, 1), "released"],
    [7050, "kept", "gpu.none.g1", null],
    [7051, "kept", "gpu.shared.nonsense.g1", null],
  ]);
  assert.equal(markingFailed([undone]), false);
  for (const vmid of [7001, 7002, 7003, 7004]) assert.deepEqual(bridge.tags(vmid), parseTags(before.get(vmid)!.tags), `CT ${vmid}'s tags are as before marking`);
  assert.deepEqual(bridge.configs(), new Map([...before].map(([vmid, config]) => [vmid, config])), "every guest is as it was before marking");
  const report = bridge.node.reportLines();
  for (const vmid of [7001, 7002, 7003, 7004]) {
    assert.ok(report.includes(`claim ${vmid} g2 released`), report.join("\n"));
    assert.ok(report.some((line) => line.startsWith(`ledger ${vmid} `) && line.endsWith(" answered g2 claim none")), `CT ${vmid}'s claim is cleared`);
  }
  assert.ok(report.includes(`holder ${A} 7001 shared running install ${INSTALL} unmanaged`), "it holds its card by its lines, unmanaged, as before marking");
  assert.match(markingText([undone]), /^Proxmox LXC on pve: cleared the claim of 4 guests\. Each claim is cleared by the GPU helper first, through a gpu\.release marker, which then comes off: the guest keeps its device lines, and the helper no longer writes them\. A box bb-box makes from now on is marked as it is made; these guests stay unmarked until bb box gpu mark marks them again\.\n/);
  assert.doesNotMatch(markingText([undone]), /starts later is marked/, "Opus 9: a start does not mark a box again");
  const writes = bridge.tagWrites().length;
  const again = await backend.markGpus(request({ undo: true }));
  assert.deepEqual(again.guests.map((guest) => guest.outcome), ["kept", "kept"]);
  assert.equal(markingFailed([again]), false, "a gpu tag it does not write is kept, which is no failure");
  assert.equal(bridge.tagWrites().length, writes);
  bridge.helper();
  assert.deepEqual(parseHelperLines(bridge.node.report()).would, [], "with the claims cleared, the helper would write nothing");
  assert.deepEqual(bridge.node.guestWrites(), []);
});

test("a marker the helper refused is asked again with the next generation once the cause is gone", async () => {
  const bridge = new Bridge();
  bridge.guest(7060, desktop("bx7060", "was-locked", CARD_A, { lock: "snapshot", marker: marker("shared", CARD_A, 1) }));
  bridge.helper();
  assert.ok(bridge.node.reportLines().includes(`claim 7060 g1 refused locked ${A} snapshot`));
  bridge.guest(7060, desktop("bx7060", "was-locked", CARD_A, { marker: marker("shared", CARD_A, 1) }));
  const marking = await bridge.backend().markGpus(request());
  assert.deepEqual(marking.guests.map((guest) => [guest.outcome, guest.marker, guest.why, guest.answer]), [["marked", marker("shared", CARD_A, 2), `The helper refused ${marker("shared", CARD_A, 1)} as it was locked (snapshot); that is no longer so, so it is asked again.`, "granted"]]);
  assert.ok(!bridge.tags(7060).includes(marker("shared", CARD_A, 1)));
});

test("bb box gpu mark waits up to 10 s for the helper's answers, and says when it had none", async () => {
  const bridge = new Bridge();
  bridge.guest(7070, desktop("bx7070", "quiet", CARD_A));
  bridge.helper();
  bridge.answering = false;
  const marking = await bridge.backend().markGpus(request());
  assert.deepEqual(marking.guests.map((guest) => [guest.outcome, guest.answer]), [["marked", "unanswered"]]);
  assert.match(guestLine(marking.guests[0]!), /The GPU helper had not answered within 10 s: run bb box doctor in a minute\.$/);
  assert.equal(markingFailed([marking]), true);
});

test("a guest's config changed between the read and the write is read again; one that keeps changing is left, with words", async () => {
  const bridge = new Bridge();
  bridge.guest(7080, desktop("bx7080", "busy", CARD_A));
  bridge.guest(7081, desktop("bx7081", "busier", CARD_B));
  bridge.helper();
  let edits = 0;
  bridge.proxmox.intercept = (call) => {
    if (call.method === "PUT" && call.path.endsWith("/7080/config") && edits === 0) {
      edits++;
      bridge.proxmox.guests.get(7080)!.config.memory = "4096";
    }
    if (call.method === "PUT" && call.path.endsWith("/7081/config")) bridge.proxmox.guests.get(7081)!.config.memory = String(1000 + ++edits);
    return undefined;
  };
  const marking = await bridge.backend().markGpus(request());
  assert.deepEqual(marking.guests.map((guest) => [guest.vmid, guest.outcome, guest.why]), [
    [7080, "marked", null],
    [7081, "refused", "Its config kept changing while bb-box wrote its tags. Run bb box gpu mark again."],
  ]);
  assert.equal(bridge.proxmox.guests.get(7080)!.config.memory, "4096", "the other change stands");
  assert.ok(bridge.tags(7080).includes(marker("shared", CARD_A, 1)));
  assert.ok(!bridge.tags(7081).some((tag) => tag.startsWith("gpu.")));
});

test("bb box gpu mark refuses the whole run, changing nothing, with no helper, a report 3 minutes old, a pool the helper does not serve, or no card listed", async () => {
  const fresh = new Bridge();
  fresh.guest(7090, desktop("bx7090", "waiting", CARD_A));
  const outcomes: [string, GpuMarking][] = [];
  outcomes.push(["no helper", await fresh.backend().markGpus(request())]);
  fresh.helper();
  const notes = fresh.proxmox.guests.get(REPORT_VMID)!.config.description!;
  const at = Number(/^\s*at (\d+)$/m.exec(notes)![1]);
  fresh.proxmox.guests.get(REPORT_VMID)!.config.description = notes.replace(/^(\s*)at \d+$/m, `$1at ${at - 180}`);
  outcomes.push(["old", await fresh.backend().markGpus(request())]);
  fresh.proxmox.guests.get(REPORT_VMID)!.config.description = notes.replace(/^(\s*)serves .*$/m, "$1serves team");
  outcomes.push(["not served", await fresh.backend().markGpus(request())]);
  fresh.proxmox.guests.get(REPORT_VMID)!.config.description = notes.replace(/^\s*card .*$/gm, "");
  outcomes.push(["no cards", await fresh.backend().markGpus(request())]);
  fresh.proxmox.guests.delete(REPORT_VMID);
  outcomes.push(["no report VM", await fresh.backend().markGpus(request())]);
  assert.deepEqual(
    outcomes.map(([name, marking]) => [name, marking.refused?.detail, marking.refused?.fix, marking.guests.length]),
    [
      ["no helper", "pve has no GPU helper: VM 9190's report has no helper line, and only the helper, bb-box-gpu, answers a marker.", "Run host/setup-gpu.sh from the setup guide as root on pve.", 0],
      ["old", "The GPU helper on pve last reported 3 minutes ago, in VM 9190.", "Run systemctl status bb-box-gpu as root on pve, and check the host's clock.", 0],
      ["not served", "bb-box-gpu 0.4.3 on pve serves pool team, not this install's pool bbbox.", "Run host/setup-gpu.sh --pool bbbox as root on pve.", 0],
      ["no cards", "The GPU helper on pve lists no card in VM 9190's report, so bb-box cannot tell which card a guest's lines name.", "Run systemctl status bb-box-gpu and nvidia-smi as root on pve.", 0],
      ["no report VM", "The token can read no VM named bb-box-gpu-memory on pve, so bb-box cannot read the GPU helper's report.", "Run host/setup-gpu-report.sh, then host/setup-gpu.sh, from the setup guide as root on pve.", 0],
    ],
  );
  assert.deepEqual(fresh.tagWrites(), []);
  assert.match(markingText([outcomes[0]![1]]), /^Proxmox LXC on pve: marked no guest\. pve has no GPU helper: /);
  assert.equal(markingFailed([outcomes[0]![1]]), true);
});

test("the doctor's proxmox.gpu-migration: none without a helper; skipped when the helper's check fails; fails naming unmarked guests with lines; passes once they are marked and the helper would write nothing", async () => {
  const check = async (bridge: Bridge) => (await bridge.backend().doctor()).checks.find((each) => each.id === "proxmox.gpu-migration");
  const bridge = new Bridge();
  today(bridge);
  assert.equal(await check(bridge), undefined, "no report: no check");
  bridge.helper();
  const before = await check(bridge);
  assert.deepEqual([before?.status, before?.detail, before?.fix], [
    "fail",
    "These 4 guests of this install have GPU device lines and no marker: CT 7001 (amber-fox), CT 7002 (lone-pine), CT 7003 (calm-reef) and CT 7004 (bb-box-warm).",
    "Run bb box gpu mark: it marks each with the card its lines name, or says why it cannot.",
  ]);
  await bridge.backend().markGpus(request());
  const after = await check(bridge);
  assert.deepEqual([after?.status, after?.detail, after?.fix], ["ok", "Each of the 4 guests of this install with GPU device lines is marked, the GPU helper on pve granted each marker as it stands, and it would write no guest.", null]);
  const notes = bridge.proxmox.guests.get(REPORT_VMID)!.config.description!;
  bridge.proxmox.guests.get(REPORT_VMID)!.config.description = notes.replace(/^(\s*)at (\d+)$/m, (_line, space, at) => `${space}at ${Number(at) - 200}`);
  assert.equal((await check(bridge))?.status, "skipped", "skipped while the helper's own check fails");
});

test("proxmox.gpu-migration fails on a write the helper would make or a refusal of this install's guests, and warns on another pool's write or a marker not answered yet", async () => {
  const check = async (bridge: Bridge) => {
    const found = (await bridge.backend().doctor()).checks.find((each) => each.id === "proxmox.gpu-migration");
    return [found?.status, found?.detail, found?.fix];
  };
  const would = new Bridge();
  would.guest(7110, desktop("bx7110", "crossed", CARD_A, { marker: marker("shared", CARD_B, 1) }));
  would.guest(7111, desktop("bx7111", "locked", CARD_A, { lock: "backup", marker: marker("shared", CARD_A, 1), running: true }));
  would.helper();
  assert.deepEqual(await check(would), [
    "fail",
    `The GPU helper on pve would write this guest once writes are on: CT 7110 (crossed), lines ${B} desktop for request g1. The GPU helper refused the marker of CT 7111 (locked), as it was locked (backup).`,
    "Find why with journalctl -u bb-box-gpu on pve: each write it would make must be explained before writes come on (071). Put right what it was refused for, then run bb box gpu mark, which asks again.",
  ]);

  const other = new Bridge();
  other.guest(7120, desktop("bx7120", "fine", CARD_A, { marker: marker("shared", CARD_A, 1) }));
  other.guest(7121, { ...boxLabels("bx7121", "theirs", "linux-desktop", "zz99"), lines: cardLines(CARD_A, "desktop"), marker: marker("shared", CARD_B, 1), pool: "team" });
  other.node.setHelperConfig(["bbbox", "team"], "off");
  other.helper();
  other.guest(7122, desktop("bx7122", "just-marked", CARD_B, { marker: marker("shared", CARD_B, 1) }));
  assert.deepEqual(await check(other), [
    "warn",
    "The GPU helper has not answered the marker of CT 7122 (just-marked) yet. It would write CT 7121, which is not a guest of this install's pool.",
    "Run bb box doctor again in a minute: the helper answers within seconds.",
  ]);

  const empty = new Bridge();
  empty.guest(7130, { box: "bx7130", name: "server", kind: "linux" });
  empty.helper();
  assert.deepEqual(await check(empty), ["ok", "No guest of this install has GPU device lines, and the GPU helper on pve would write no guest.", null]);
});

test("the marking rules on their own: the marker's grammar, a guest's device set, the card's lines, raw lines, an undo, and the helper's answers", () => {
  assert.deepEqual(parseMarker(`gpu.whole.${A}.g12`), { part: "whole", card: A, generation: 12 });
  for (const bad of [`gpu.shared.GPU-${A}.g1`, `gpu.shared.${A}.g0`, `gpu.shared.${A}.g01`, "gpu.none", `gpu.half.${A}.g1`, `GPU.none.g1`]) assert.equal(parseMarker(bad), null, bad);
  assert.equal(deviceSetOf(["kind.linux-desktop"], ""), "desktop");
  assert.equal(deviceSetOf([], `bb-box warm desktop\ninstall ${INSTALL}`), "desktop");
  assert.equal(deviceSetOf([], `bb-box image box: build\ninstall ${INSTALL}`), "server");
  assert.equal(deviceSetOf(["kind.linux"], "bb-box x\nkind linux-desktop"), "server", "the kind tag wins, as the helper reads it");
  const cards = parseHelperLines(`    card ${A} pci 0000:21:00.0 minor 1 drm card2 renderD129\n    card ${B} pci 0000:d1:00.0 minor - drm - -\n    gpu GPU-${A} 00000000:21:00.0 0 1 2`).cards;
  assert.deepEqual(linesFor(cards[0]!, "desktop"), cardLines(CARD_A, "desktop"));
  assert.equal(linesFor(cards[1]!, "server"), null);
  assert.equal(cards[0]!.index, 0);
  assert.deepEqual(rawGpuLines({ lxc: [["lxc.cgroup2.devices.allow", "c 195:1 rwm"], ["lxc.mount.entry", "/dev/nvidiactl dev/nvidiactl none bind,optional,create=file"], ["lxc.cgroup2.devices.allow", "c 10:200 rwm"], ["lxc.apparmor.profile", "unconfined"]] }), [
    "lxc.cgroup2.devices.allow: c 195:1 rwm",
    "lxc.mount.entry: /dev/nvidiactl dev/nvidiactl none bind,optional,create=file",
  ]);
  const eligibility = { installId: INSTALL, madeAndRemovedByBbBox: () => false };
  const context: MarkContext = { ...eligibility, cards, holders: [], ledger: new Map(), answers: [], boxNamedBy: new Map() };
  const look = (config: Record<string, unknown>, pending: GuestLook["pending"] = []): GuestLook => ({ vmid: 1, config: { description: `bb-box x\ninstall ${INSTALL}\nkind linux-desktop`, tags: `bb-box;install.${INSTALL}`, unprivileged: "1", ...config }, pending });
  assert.deepEqual(planMark({ look: look({ lxc: [["lxc.cgroup2.devices.allow", "c 195:1 rwm"]] }), recordedPart: null }, context), { is: "refused", why: "It has raw lines for GPU devices (lxc.cgroup2.devices.allow: c 195:1 rwm), which the helper does not manage.", card: null });
  assert.deepEqual(planUnmark(look({ tags: `bb-box;install.${INSTALL};gpu.shared.${A}.g3`, lock: "backup" }), eligibility, new Map()), { is: "refused", why: "It is locked (backup). Run bb box gpu mark --undo again once the lock is gone.", card: null });
  const claimed = new Map([[1, { vmid: 1, box: null, answered: 4, claim: { generation: 4, part: "shared" as const, card: A, answer: "granted" as const } }]]);
  assert.deepEqual(planUnmark(look({ tags: `bb-box;install.${INSTALL};gpu.shared.${A}.g3` }), eligibility, claimed), { is: "release", marker: { part: "release", card: null, generation: 5 }, replaces: `gpu.shared.${A}.g3`, asked: false });
  assert.deepEqual(planUnmark(look({}), eligibility, claimed), { is: "release", marker: { part: "release", card: null, generation: 5 }, replaces: null, asked: false }, "a claim with no marker, as unit 4's undo left it, is cleared too");
  assert.deepEqual(planUnmark(look({ tags: `bb-box;install.${INSTALL};gpu.release.g5` }), eligibility, claimed), { is: "release", marker: { part: "release", card: null, generation: 5 }, replaces: null, asked: true });
  const released = new Map([[1, { vmid: 1, box: null, answered: 5, claim: null }]]);
  assert.deepEqual(planUnmark(look({ tags: `bb-box;install.${INSTALL};gpu.release.g5` }), eligibility, released), { is: "unmark", marker: "gpu.release.g5" });
  assert.deepEqual(planUnmark(look({}), eligibility, released), { is: "unmarked" });
  assert.deepEqual(parseMarker("gpu.release.g5"), { part: "release", card: null, generation: 5 });
  assert.equal(parseMarker(`gpu.release.${A}.g5`), null);
  assert.deepEqual(parseHelperLines("    claim 9 g5 released").answers, [{ vmid: 9, generation: 5, is: "released" }]);
  assert.deepEqual(withGpuTagsOf(["bb-box", "warm", marker("shared", CARD_B, 1)], ["bb-box", "box.bx1"]), ["bb-box", "box.bx1", marker("shared", CARD_B, 1)]);
  const lines = parseHelperLines([
    `    claim 5 g1 granted shared ${A}`,
    `    claim 6 g2 refused running ${A}`,
    `    would 7 lines ${A} desktop for request g1`,
    `    holder ${A} 8 shared stopped install ${INSTALL} managed`,
    "    ledger entries 2",
    `    ledger 9 box ${INSTALL}/bx9 answered g3 claim g3 shared ${A} granted`,
    `    ledger 10 box - answered g2 claim none`,
    "    omitted 2 holder lines, 1 answers",
  ].join("\n"));
  const ask = (vmid: number, generation: number, fromLedger = false) => answerTo(lines, vmid, { part: "shared", card: A, generation }, fromLedger);
  assert.deepEqual([ask(5, 1), ask(6, 2), ask(7, 1), ask(8, 1), ask(9, 3), ask(9, 3, true), ask(10, 2, true)], [
    { is: "granted" },
    { is: "refused", why: "its device lines would have to change while it runs" },
    { is: "would", why: `the helper would write its device lines: lines ${A} desktop for request g1` },
    { is: "unanswered" },
    { is: "unanswered" },
    { is: "granted" },
    { is: "unanswered" },
  ], "a managed holder line is never a grant; a just-written marker counts only the helper's claim answer, and a standing one its ledger's claim as asked");
  assert.deepEqual([lines.ledgerReported, lines.ledger.get(10)], [true, { vmid: 10, box: null, answered: 2, claim: null }]);
  assert.deepEqual(lines.omitted, ["2 holder lines, 1 answers"]);
  assert.deepEqual(parseHelperLines("    omitted the rest, as the report was too long").omitted, ["the rest, as the report was too long"]);
  const verdict = judgeGpuMigration(lines, [], { ...eligibility, node: "pve", vmid: REPORT_VMID });
  assert.deepEqual([verdict.status, verdict.detail], ["fail", "VM 9190's report leaves lines out (2 holder lines, 1 answers), so bb-box cannot show every guest is marked and the helper would write nothing."], "an incomplete report never passes (Astra 4)");
  const desktopLines = cardLines(CARD_A, "desktop");
  const duplicated = (more: string[]) => Object.fromEntries([...desktopLines, ...more].map((line, at) => [`dev${at}`, line]));
  assert.deepEqual(planMark({ look: look(duplicated(["/dev/nvidiactl,mode=0666"])), recordedPart: null }, context), {
    is: "refused",
    why: "Its device lines are not the ones the helper gives a desktop on card 0: it has /dev/nvidiactl,mode=0666 besides. Marked, the helper would rewrite them once writes are on.",
    card: cards[0],
  }, "a device line twice is not the helper's set, which it compares as a whole sorted list (Astra 5)");
});

test("bb box gpu mark from the CLI: the text, --json, and exit 1 when a guest is left or the helper did not grant", async () => {
  const guest = (more: Partial<GpuMarkGuest>): GpuMarkGuest => ({ vmid: 7001, name: "amber-fox", running: true, card: "card 0", marker: marker("shared", CARD_A, 1), outcome: "marked", why: null, answer: "granted", answerWhy: null, ...more });
  const marking = (guests: GpuMarkGuest[]): GpuMarking => ({ backend: "proxmox-lxc", label: "Proxmox LXC on pve", node: "pve", check: false, undo: false, refused: null, guests, withoutCards: 1 });
  let asked: unknown = null;
  const answers = [marking([guest({})]), marking([guest({ answer: "would", answerWhy: "the helper would write its device lines: lines none for request g1" })])];
  const app = { gpuMark: async (options: unknown) => ((asked = options), [answers.shift()!]) } as unknown as BbBox;
  const command = gpuCommands(app)["gpu mark"] as unknown as { run: (input: { positionals: object; options: Record<string, unknown> }, ctx: object) => Promise<{ exitCode: number; stdout?: string }> };
  const ok = await command.run({ positionals: {}, options: { on: "proxmox-lxc" } }, {});
  assert.deepEqual(asked, { check: false, undo: false, on: "proxmox-lxc" });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, `Proxmox LXC on pve: marked 1 guest.\n  CT 7001 amber-fox, running, card 0: marked ${marker("shared", CARD_A, 1)}. The GPU helper granted it.\n1 other guest of this install has no card's device lines and needs no marker.\n`);
  const would = await command.run({ positionals: {}, options: { json: true, check: true, undo: true } }, {});
  assert.deepEqual(asked, { check: true, undo: true });
  assert.equal(would.exitCode, 1);
  assert.equal(JSON.parse(would.stdout!)[0].guests[0].answer, "would");
});
