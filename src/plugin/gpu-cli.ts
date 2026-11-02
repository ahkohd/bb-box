import { PluginCliError, cliCommand, type PluginCliResult } from "@get-bb/plugin-sdk";
import { BoxError, describeError } from "../core/boxes.ts";
import type { GpuMarkGuest, GpuMarking } from "../backends/types.ts";
import type { BbBox } from "./setup.ts";

const ANSWER_WORDS: Readonly<Record<string, (guest: GpuMarkGuest) => string>> = {
  granted: () => "The GPU helper granted it.",
  refused: (guest) => `The GPU helper refused it, as ${guest.answerWhy}.`,
  would: (guest) => `In its dry run, ${guest.answerWhy}.`,
  unanswered: () => "The GPU helper had not answered within 10 s: run bb box doctor in a minute.",
};

function outcomeWords(guest: GpuMarkGuest): string {
  const marker = guest.marker ?? "";
  switch (guest.outcome) {
    case "marked":
      return `marked ${marker}.`;
    case "would-mark":
      return `would be marked ${marker}.`;
    case "already":
      return `already marked ${marker}.`;
    case "refused":
      return marker ? `left with ${marker}.` : "not marked.";
    case "unmarked":
      return `took off ${marker}.`;
    case "would-unmark":
      return `would have ${marker} taken off.`;
    case "kept":
      return `kept ${marker}.`;
  }
}

export function guestLine(guest: GpuMarkGuest): string {
  const where = [`CT ${guest.vmid}${guest.name ? ` ${guest.name}` : ""}`, guest.running ? "running" : "stopped", ...(guest.card ? [guest.card] : [])].join(", ");
  const answer = guest.answer ? ANSWER_WORDS[guest.answer]!(guest) : null;
  return `  ${where}: ${[outcomeWords(guest), guest.why, answer].filter(Boolean).join(" ")}`;
}

const UNDO_LEAVES =
  "This takes off tags alone: it does not clear the claims the GPU helper granted, which stay in its ledger until a later BB Box release clears claims (071 unit 5). " +
  "With writes off the helper changes nothing; with writes on it would go on giving each stopped guest the lines of the card it claimed.";

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function headline(marking: GpuMarking): string {
  const where = marking.label;
  if (marking.refused) return `${where}: ${marking.undo ? "took off no marker" : "marked no guest"}. ${marking.refused.detail}${marking.refused.fix ? ` ${marking.refused.fix}` : ""}`;
  const of = (outcome: GpuMarkGuest["outcome"]) => marking.guests.filter((guest) => guest.outcome === outcome).length;
  if (marking.undo) {
    const taken = of(marking.check ? "would-unmark" : "unmarked");
    if (marking.check) return `${where}: would take the marker off ${count(taken, "guest")}; changes nothing (--check). ${UNDO_LEAVES}`;
    return `${where}: took the marker off ${count(taken, "guest")}. ${UNDO_LEAVES}`;
  }
  const marked = of(marking.check ? "would-mark" : "marked");
  const already = of("already");
  const parts = [marking.check ? `would mark ${count(marked, "guest")}` : `marked ${count(marked, "guest")}`, ...(already ? [`${count(already, "guest")} ${already === 1 ? "was" : "were"} marked already`] : [])];
  return `${where}: ${parts.join("; ")}${marking.check ? "; changes nothing (--check)" : ""}.`;
}

export function markingText(markings: readonly GpuMarking[]): string {
  return markings
    .map((marking) => {
      const lines = [headline(marking), ...marking.guests.map(guestLine)];
      if (!marking.refused && marking.withoutCards) {
        const one = marking.withoutCards === 1;
        lines.push(
          marking.undo
            ? `${count(marking.withoutCards, "other guest")} of this install ${one ? "has" : "have"} no marker.`
            : `${count(marking.withoutCards, "other guest")} of this install ${one ? "has" : "have"} no card's device lines and ${one ? "needs" : "need"} no marker.`,
        );
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function markingFailed(markings: readonly GpuMarking[]): boolean {
  return markings.some(
    (marking) => marking.refused !== null || marking.guests.some((guest) => guest.outcome === "refused" || (guest.answer !== null && guest.answer !== "granted")),
  );
}

async function guard(action: string, task: () => Promise<PluginCliResult>): Promise<PluginCliResult> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    const code = error instanceof BoxError ? error.code : "failed";
    return { exitCode: 1, stderr: `${describeError(error, action)} (${code})\n` };
  }
}

export function gpuCommands(app: BbBox) {
  return {
    "gpu mark": cliCommand({
      summary:
        "Mark each guest of this install whose device lines name a card with the claim they give, as a tag the host's GPU helper answers (071): gpu.shared.<card's UUID>.g<N>, or gpu.whole where the box's record says a whole card, N above the last generation the helper answered for the guest. " +
        "It changes only tags: it never restarts, stops or resizes a guest, never changes its device lines, and never touches a guest that is not this install's; a running box is marked as it runs. " +
        "It leaves, and names, a guest the helper would refuse or whose lines it would rewrite, one that is locked or has another marker, and checks each again from the config it reads just before it writes. It counts a guest granted only from the helper's own answer to that marker. It waits up to 10 s for the answers, and exits 1 when it leaves a guest or the helper does not grant one. --undo takes those markers off again, and nothing else: the claims the helper granted stay in its ledger until a later release clears claims.",
      options: {
        check: { type: "boolean", description: "Only say what it would mark, or with --undo take off, and why; it changes nothing." },
        undo: { type: "boolean", description: "Take the shared and whole markers off this install's guests again. Other gpu tags stay, and so do the claims the helper granted, in its ledger." },
        on: { type: "string", description: "Only this backend, by its ID, such as proxmox-lxc. Every Proxmox LXC backend that is on by default." },
        json: { type: "boolean", description: "Print JSON." },
      },
      run: ({ options }, ctx) =>
        guard("Marking the GPU guests", async () => {
          const markings = await app.gpuMark({ check: options.check === true, undo: options.undo === true, ...(options.on ? { on: String(options.on) } : {}) }, ctx.signal);
          const exitCode = markingFailed(markings) ? 1 : 0;
          if (options.json) return { exitCode, stdout: `${JSON.stringify(markings, null, 2)}\n` };
          return { exitCode, stdout: `${markingText(markings)}\n` };
        }),
    }),
  };
}
