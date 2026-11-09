import assert from "node:assert/strict";
import { test } from "node:test";
import type { GpuMarking } from "../src/backends/types.ts";
import { markingText } from "../src/plugin/gpu-cli.ts";
import type { FetchResponse } from "../src/backends/proxmox/api.ts";
import { Bridge, desktop, request } from "./gpu-helper/bridge.ts";
import { CARD_A, CARD_B, INSTALL, REPORT_VMID, cardLines, marker } from "./gpu-helper/node.ts";

const A = CARD_A.uuid;
const B = CARD_B.uuid;
function one(marking: GpuMarking, vmid: number) {
  const found = marking.guests.find((guest) => guest.vmid === vmid);
  assert.ok(found, `CT ${vmid} is named: ${JSON.stringify(marking.guests.map((guest) => guest.vmid))}`);
  return found;
}
const puts = (bridge: Bridge) => bridge.tagWrites().filter((write) => write.method === "PUT");
const migration = async (bridge: Bridge) => {
  const found = (await bridge.backend().doctor()).checks.find((check) => check.id === "proxmox.gpu-migration");
  return [found?.status, found?.detail, found?.fix];
};

function answered(json: unknown): FetchResponse {
  const text = JSON.stringify({ data: json });
  return { ok: true, status: 200, statusText: "OK", text: async () => text };
}

test("after --undo, mark asks again above the helper's last answered generation, for the card the lines name now, and counts it granted only from the helper's own answer (Opus 1, Astra 2); since unit 5 the undo clears the claim, so the helper never holds card A for it", async () => {
  const bridge = new Bridge();
  bridge.guest(7200, desktop("bx7200", "moved", CARD_A));
  bridge.helper();
  const backend = bridge.backend();
  assert.equal(one(await backend.markGpus(request()), 7200).marker, marker("shared", CARD_A, 1));
  await backend.markGpus(request({ undo: true }));
  bridge.guest(7200, desktop("bx7200", "moved", CARD_B));
  bridge.helper();
  assert.ok(bridge.node.reportLines().includes(`ledger 7200 box ${INSTALL}/bx7200 answered g2 claim none`), "the undo cleared the claim on card A");
  assert.deepEqual(bridge.node.reportLines().filter((line) => line.startsWith("would ")), [], "so the helper would not put card A's lines back");
  const again = one(await backend.markGpus(request()), 7200);
  assert.deepEqual([again.outcome, again.marker, again.answer], ["marked", marker("shared", CARD_B, 3), "granted"]);
  const report = bridge.node.reportLines();
  assert.ok(report.includes(`claim 7200 g3 granted shared ${B}`), report.join("\n"));
  assert.ok(report.includes(`ledger 7200 box ${INSTALL}/bx7200 answered g3 claim g3 shared ${B} granted`));
  assert.deepEqual(report.filter((line) => line.startsWith("would ")), [], "with the claim on card B, the helper would write nothing");
  assert.deepEqual(bridge.node.guestWrites(), []);
});

test("a marker refused, then granted at g2, taken off and asked again, goes to g3, never behind the helper's ledger (Opus 1)", async () => {
  const bridge = new Bridge();
  bridge.guest(7210, desktop("bx7210", "was-locked", CARD_A, { lock: "snapshot", marker: marker("shared", CARD_A, 1) }));
  bridge.helper();
  bridge.guest(7210, desktop("bx7210", "was-locked", CARD_A, { marker: marker("shared", CARD_A, 1) }));
  const backend = bridge.backend();
  assert.deepEqual([one(await backend.markGpus(request()), 7210).marker, one(await backend.markGpus(request()), 7210).outcome], [marker("shared", CARD_A, 2), "already"]);
  await backend.markGpus(request({ undo: true }));
  const again = one(await backend.markGpus(request()), 7210);
  assert.deepEqual([again.outcome, again.marker, again.answer, again.why], ["marked", marker("shared", CARD_A, 4), "granted", "The helper answered up to g3 for it before, so it is asked with g4."]);
  assert.ok(bridge.node.reportLines().includes(`claim 7210 g4 granted shared ${A}`));
});

test("a standing marker counts as granted only when the helper's ledger holds that generation, part and card; otherwise it is asked again (Opus 1, Astra 2)", async () => {
  const bridge = new Bridge();
  bridge.guest(7220, desktop("bx7220", "crossed", CARD_A, { running: true }));
  bridge.helper();
  const backend = bridge.backend();
  await backend.markGpus(request());
  bridge.guest(7220, desktop("bx7220", "crossed", CARD_B, { running: true, marker: marker("shared", CARD_B, 1) }));
  bridge.helper();
  assert.ok(bridge.node.reportLines().includes(`ledger 7220 box ${INSTALL}/bx7220 answered g1 claim g1 shared ${A} granted`));
  assert.deepEqual(await migration(bridge), [
    "fail",
    `The GPU helper does not hold the claim the marker asks for: CT 7220 (crossed), whose marker is ${marker("shared", CARD_B, 1)} while the helper's ledger holds g1 granted shared ${A}.`,
    "Run bb box gpu mark, which asks again with the next generation.",
  ], "the doctor does not take a managed holder line for the marker's grant");
  const again = one(await backend.markGpus(request()), 7220);
  assert.deepEqual([again.outcome, again.marker, again.answer, again.why], [
    "marked",
    marker("shared", CARD_B, 2),
    "granted",
    `The helper's ledger holds g1 granted shared ${A} for it, not ${marker("shared", CARD_B, 1)}, so it is asked again.`,
  ]);
  assert.equal((await migration(bridge))[0], "ok");
});

test("what makes a guest one bb box gpu mark leaves is read again from the config it reads just before it writes, and on each reread after a change (Opus 2, Astra 1)", async () => {
  const turns: [string, (config: Record<string, string>) => void, string][] = [
    ["a template", (config) => (config.template = "1"), "It is a template now, and templates are never marked."],
    ["a held copy", (config) => (config.tags = `${config.tags};held-copy`), "It is a held copy of a snapshot now, which holds no card."],
    ["an earlier guest", (config) => (config.tags = `${config.tags};earlier-guest`), "It is an earlier guest now, kept after a restore, which holds no card."],
    ["a warm guest being retired", (config) => (config.tags = `${config.tags};retired`), "BB Box is making or removing it now: an image box, or a warm guest being filled or retired."],
    ["another install's", (config) => (config.tags = config.tags!.replace(`install.${INSTALL}`, "install.zz99")), `Its tags no longer name install ${INSTALL}, so it is not this install's.`],
  ];
  for (const [what, turn, words] of turns) {
    for (const when of ["read", "reread"] as const) {
      const bridge = new Bridge();
      bridge.guest(7230, desktop("bx7230", "turning", CARD_A));
      bridge.helper();
      let reads = 0;
      let failedPut = false;
      bridge.proxmox.intercept = (call) => {
        const config = bridge.proxmox.guests.get(7230)!.config;
        if (call.method === "GET" && call.path.endsWith("/7230/config") && ++reads === (when === "read" ? 1 : 2)) turn(config);
        if (when === "reread" && call.method === "PUT" && call.path.endsWith("/7230/config") && !failedPut) {
          failedPut = true;
          config.memory = "4096";
        }
        return undefined;
      };
      const marking = await bridge.backend().markGpus(request());
      assert.deepEqual([one(marking, 7230).outcome, one(marking, 7230).why], ["refused", words], `${what}, at the ${when}`);
      assert.ok(!bridge.tags(7230).some((tag) => tag.startsWith("gpu.")), `${what}, at the ${when}: no marker`);
    }
  }
});

test("--undo reads ownership again from the config it reads, and leaves a guest that is no longer this install's (Astra 1)", async () => {
  const bridge = new Bridge();
  bridge.guest(7240, desktop("bx7240", "handed-on", CARD_A));
  bridge.helper();
  const backend = bridge.backend();
  await backend.markGpus(request());
  bridge.proxmox.intercept = (call) => {
    const config = bridge.proxmox.guests.get(7240)!.config;
    if (call.method === "GET" && call.path.endsWith("/7240/config")) {
      config.tags = config.tags!.replace(`install.${INSTALL}`, "install.zz99");
      config.description = config.description!.replace(`install ${INSTALL}`, "install zz99");
    }
    return undefined;
  };
  const undone = one(await backend.markGpus(request({ undo: true })), 7240);
  assert.deepEqual([undone.outcome, undone.why], ["refused", `Its tags no longer name install ${INSTALL}, so it is not this install's.`]);
  assert.ok(bridge.tags(7240).includes(marker("shared", CARD_A, 1)), "another install's marker stays");
});

test("two guests that name one box are both left, and a copy the helper refused is not asked again while its source stands (Astra 3)", async () => {
  const bridge = new Bridge();
  bridge.guest(7250, desktop("bx7250", "twin", CARD_A, { running: true }));
  bridge.guest(7251, desktop("bx7250", "twin", CARD_A));
  bridge.guest(7252, desktop("bx7252", "source", CARD_B, { running: true, marker: marker("shared", CARD_B, 1) }));
  bridge.guest(7253, desktop("bx7252", "source", CARD_B, { marker: marker("shared", CARD_B, 1) }));
  bridge.helper();
  assert.ok(bridge.node.reportLines().includes(`claim 7253 g1 refused copy ${B} 7252`));
  const marking = await bridge.backend().markGpus(request());
  assert.deepEqual(
    [7250, 7251, 7252, 7253].map((vmid) => [vmid, one(marking, vmid).outcome, one(marking, vmid).why]),
    [
      [7250, "refused", "CT 7251 names box bx7250 as well, and the helper takes all but one for copies. Not marked until one guest names the box."],
      [7251, "refused", "CT 7250 names box bx7250 as well, and the helper takes all but one for copies. Not marked until one guest names the box."],
      [7252, "refused", "CT 7253 names box bx7252 as well, and the helper takes all but one for copies. Not marked until one guest names the box."],
      [7253, "refused", "CT 7252 names box bx7252 as well, and the helper takes all but one for copies. Not marked until one guest names the box."],
    ],
  );
  assert.deepEqual(puts(bridge), [], "nothing written, and the refused copy not asked again with g2");
});

test("a shared request on a card another guest holds whole is left before anything is written (Astra 3)", async () => {
  const bridge = new Bridge();
  bridge.guest(7260, desktop("bx7260", "long-job", CARD_A, { running: true }));
  bridge.helper();
  const backend = bridge.backend();
  assert.equal(one(await backend.markGpus(request({ parts: [["bx7260", "whole"]] })), 7260).marker, marker("whole", CARD_A, 1));
  bridge.guest(7261, desktop("bx7261", "late", CARD_A));
  bridge.helper();
  const writes = puts(bridge).length;
  const late = one(await backend.markGpus(request({ parts: [["bx7260", "whole"]] })), 7261);
  assert.deepEqual([late.outcome, late.why], ["refused", "CT 7260 holds card 0 whole, so the helper would refuse it."]);
  assert.equal(puts(bridge).length, writes);
});

test("a device line given twice is not the helper's set, which it compares as a whole sorted list (Astra 5)", async () => {
  const bridge = new Bridge();
  bridge.guest(7270, desktop("bx7270", "doubled", CARD_A, { lines: [...cardLines(CARD_A, "desktop"), "/dev/nvidiactl,mode=0666"] }));
  bridge.helper();
  const marking = one(await bridge.backend().markGpus(request()), 7270);
  assert.deepEqual([marking.outcome, marking.why], ["refused", "Its device lines are not the ones the helper gives a desktop on card 0: it has /dev/nvidiactl,mode=0666 besides. Marked, the helper would rewrite them once writes are on."]);
  assert.deepEqual(puts(bridge), []);
});

test("GPU lines that wait in a guest's pending changes are named by mark, which leaves the guest, and by the doctor (Opus 4)", async () => {
  const bridge = new Bridge();
  const lines = cardLines(CARD_A, "desktop");
  bridge.guest(
    7280,
    desktop("bx7280", "pending-only", CARD_A, { lines: [], pending: Object.fromEntries(lines.map((line, at) => [`dev${at}`, line])) }),
    lines.map((line, at) => ({ key: `dev${at}`, pending: line })),
  );
  bridge.helper();
  const marking = one(await bridge.backend().markGpus(request()), 7280);
  assert.equal(marking.outcome, "refused");
  assert.match(marking.why!, /^It has GPU device lines waiting for its next start \(dev0: \/dev\/nvidia1,mode=0666, .* and dev6: \/dev\/dri\/card2,mode=0666\), which the helper refuses to act beside\./);
  assert.deepEqual(puts(bridge), []);
  const check = await migration(bridge);
  assert.equal(check[0], "fail");
  assert.match(String(check[1]), /This guest of this install has GPU device lines and no marker: CT 7280 \(pending-only\)\./);
});

test("the doctor fails, naming it, a guest whose lines name a node no card in the helper's report has, which the helper's holder lines leave out (Astra 4)", async () => {
  const bridge = new Bridge();
  bridge.guest(7290, desktop("bx7290", "odd-node", CARD_A, { lines: ["/dev/nvidia7,mode=0666", "/dev/nvidiactl,mode=0666"] }));
  bridge.helper();
  assert.ok(!bridge.node.reportLines().some((line) => line.startsWith("holder ") && line.includes(" 7290 ")));
  assert.deepEqual(await migration(bridge), [
    "fail",
    "The device lines of CT 7290 (odd-node), /dev/nvidia7 name nodes no card in the GPU helper's report has. This guest of this install has GPU device lines and no marker: CT 7290 (odd-node).",
    "Put those lines right by hand, as root on the host; the helper never writes them. Run bb box gpu mark: it marks each with the card its lines name, or says why it cannot.",
  ]);
});

test("the doctor never passes a report that leaves lines out, or one with no ledger lines, and mark refuses to run on either (Astra 4)", async () => {
  const bridge = new Bridge();
  bridge.guest(7300, desktop("bx7300", "fine", CARD_A));
  bridge.helper();
  await bridge.backend().markGpus(request());
  assert.equal((await migration(bridge))[0], "ok");
  const notes = bridge.proxmox.guests.get(REPORT_VMID)!.config.description!;
  bridge.proxmox.guests.get(REPORT_VMID)!.config.description = `${notes}\n    omitted 3 would lines`;
  assert.deepEqual((await migration(bridge)).slice(0, 2), ["fail", "VM 9190's report leaves lines out (3 would lines), so BB Box cannot show every guest is marked and the helper would write nothing."]);
  bridge.proxmox.guests.get(REPORT_VMID)!.config.description = notes.split("\n").filter((line) => !/^\s*ledger /.test(line)).join("\n");
  assert.deepEqual((await migration(bridge)).slice(0, 2), ["fail", "VM 9190's report has no ledger lines, which bb-box-gpu 0.2.0 and later write, so BB Box cannot show the helper granted each marker as it stands."]);
  bridge.guest(7301, desktop("bx7301", "new", CARD_B));
  const refused = await bridge.backend().markGpus(request());
  assert.equal(refused.refused?.detail, "bb-box-gpu 0.4.3 on pve does not report its ledger, which bb box gpu mark needs to ask above each guest's last answered generation and to read each grant.");
  assert.ok(!bridge.tags(7301).some((tag) => tag.startsWith("gpu.")));
});

test("mark writes no tags without the digest Proxmox gives with the config (Astra 1)", async () => {
  const bridge = new Bridge();
  bridge.guest(7310, desktop("bx7310", "undigested", CARD_A));
  bridge.helper();
  bridge.proxmox.intercept = (call) => {
    if (call.method !== "GET" || !call.path.endsWith("/7310/config")) return undefined;
    return answered({ ...bridge.proxmox.guests.get(7310)!.config });
  };
  const marking = one(await bridge.backend().markGpus(request()), 7310);
  assert.deepEqual([marking.outcome, marking.why], ["refused", "Proxmox gave no digest with its config, so BB Box does not write its tags."]);
  assert.deepEqual(puts(bridge), []);
});

test("--undo says plainly that it clears the helper's claims and leaves the device lines (Opus 1, 071 unit 5)", () => {
  const undone: GpuMarking = { backend: "proxmox-lxc", label: "Proxmox LXC on pve", node: "pve", check: false, undo: true, refused: null, withoutCards: 0, guests: [{ vmid: 7001, name: "amber-fox", running: true, card: null, marker: marker("shared", CARD_A, 1), outcome: "unmarked", why: null, answer: "released", answerWhy: null }] };
  assert.match(markingText([undone]), /cleared the claim of 1 guest\. Each claim is cleared by the GPU helper first, through a gpu\.release marker, which then comes off: the guest keeps its device lines, and the helper no longer writes them\./);
  assert.match(markingText([undone]), /CT 7001 amber-fox, running: took off gpu\.shared\.[0-9a-f-]+\.g1\. The GPU helper cleared its claim; its device lines stay as they are\./);
  assert.match(markingText([{ ...undone, check: true, guests: [{ ...undone.guests[0]!, outcome: "would-unmark", answer: null }] }]), /would clear the claim of 1 guest; changes nothing \(--check\)\./);
});
