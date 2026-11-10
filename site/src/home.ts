import { getEntry } from "astro:content";
import { absoluteAddress, markdownPath } from "./llms.ts";
import { firstListIn, listUnder, plainText, tableUnder, type ListItem } from "./rendered.ts";
import { pageUrl, readPages, repository, repositoryRef } from "./repo.ts";
import { installCommand, quickStartOnGitHub, setupPrompt } from "./setup-prompt.ts";
import { startingPoints } from "./starting-points.ts";

export const tagline = "Computers for BB threads: Linux, Windows, macOS, iOS and Android, virtual or real: desktops, terminals or simulators, shared by you and your agent.";
export const headlineWords = ["Computers", "Devices", "Simulators", "Emulators", "Macs", "Sandboxes", "VMs", "Desktops"];
export const headlineRest = "for BB threads";
export const headline = `${headlineWords[0]} ${headlineRest}`;
export const subline = "Linux, Windows, macOS, iOS and Android, virtual or real: desktops, terminals or simulators, shared by you and your agent.";
export const demoDescription =
  "A person asks a BB thread's agent for a Linux desktop box, and the agent opens getbb.app in its browser. The person opens the desktop, glances at the box's CPU and memory in the Monitor, then makes a server box and runs a command in its terminal. On the server box's page, the person takes a snapshot, breaks the box from its terminal, and restores the snapshot with an undo.";

export type FeaturePiece = "boxPanel" | "newBox" | "desktop" | "recording" | "monitor";

const pieceForReason: Record<string, FeaturePiece> = {
  "Each thread gets its own computers": "boxPanel",
  "Shared desktops": "desktop",
  "Any provider": "newBox",
  "Every machine at a glance": "monitor",
  "Recordings that show the work": "recording",
};

export interface Feature extends ListItem {
  piece?: FeaturePiece;
}

export const platformNames = ["Linux", "Windows", "macOS", "iOS", "Android"] as const;
export type PlatformName = (typeof platformNames)[number];

export const platformLines: Record<PlatformName, string> = {
  Linux: "Servers and desktops, X11 or Wayland, on x86_64 or arm64, with a GPU where the host has one.",
  Windows: "Windows 11 desktops, on Proxmox or on a Mac with Apple silicon.",
  macOS: "macOS on a Mac with Apple silicon, with or without a desktop.",
  iOS: "An iPhone or iPad in the iOS Simulator.",
  Android: "A phone, foldable or tablet in its emulator.",
};

const platformPatterns: Record<PlatformName, RegExp> = {
  Linux: /\bLinux\b/,
  Windows: /\bWindows\b/,
  macOS: /\bmacOS\b/,
  iOS: /\biOS\b/,
  Android: /\bAndroid\b/,
};

export interface Backend {
  name: string;
  href: string;
  where: string;
  takesSnapshots: boolean;
  runs: Record<PlatformName, boolean>;
}

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function backendOf(cells: string[]): Backend {
  const link = /<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(cells[0]!);
  const boxes = plainText(cells[1] ?? "");
  const snapshots = plainText(cells[3] ?? "");
  return {
    name: plainText(link?.[2] ?? cells[0]!),
    href: link?.[1] ?? "",
    where: sentenceCase(plainText(cells[2] ?? "")),
    takesSnapshots: !/^none\b/i.test(snapshots),
    runs: Object.fromEntries(platformNames.map((platform) => [platform, platformPatterns[platform].test(boxes)])) as Record<PlatformName, boolean>,
  };
}

export interface HomeData {
  features: Feature[];
  backends: Backend[];
  requirements: ListItem[];
  prompt: string;
  command: string;
  links: { title: string; words: string; href: string }[];
  quickStart: string;
  repository: string;
  licence: string;
  thirdParty: string;
}

export async function homeData(base: string, site: URL | undefined): Promise<HomeData> {
  const pages = readPages();
  const introduction = await getEntry("docs", "start");
  const quickStartEntry = await getEntry("docs", "start/quick-start");
  const html = introduction?.rendered?.html ?? "";
  const command = installCommand(pages);
  const quickStartMarkdown = site ? absoluteAddress(markdownPath(base, "start/quick-start"), { base, site: site.href }) : quickStartOnGitHub(command);
  const fileUrl = (path: string) => `${repository}/blob/${repositoryRef}/${path}`;
  return {
    features: listUnder(html, "why-bb-box").map((reason) => ({ ...reason, piece: pieceForReason[reason.title] })),
    backends: tableUnder(html, "backends-and-boxes").map(backendOf),
    requirements: firstListIn(quickStartEntry?.rendered?.html ?? ""),
    prompt: setupPrompt(pages, quickStartMarkdown),
    command,
    links: startingPoints.map((way) => ({ title: way.title, words: way.words, href: pageUrl(base, way.id) })),
    quickStart: pageUrl(base, "start/quick-start"),
    repository,
    licence: fileUrl("LICENSE"),
    thirdParty: fileUrl("THIRD-PARTY.md"),
  };
}
