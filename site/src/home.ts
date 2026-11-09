import { getEntry } from "astro:content";
import boxPanel from "../../docs/media/box-panel.png";
import boxPanelLight from "../../docs/media/box-panel-light.png";
import desktopBox from "../../docs/media/desktop-box.png";
import desktopBoxLight from "../../docs/media/desktop-box-light.png";
import monitor from "../../docs/media/monitor.png";
import monitorLight from "../../docs/media/monitor-light.png";
import newBoxForm from "../../docs/media/new-box-form.png";
import newBoxFormLight from "../../docs/media/new-box-form-light.png";
import recordingStep from "../../docs/media/recording-step.png";
import terminalBox from "../../docs/media/terminal-box.png";
import terminalBoxLight from "../../docs/media/terminal-box-light.png";
import { absoluteAddress, markdownPath } from "./llms.ts";
import { firstListIn, listUnder, plainText, tableUnder, type ListItem } from "./rendered.ts";
import { pageUrl, readPages, repository, repositoryRef } from "./repo.ts";
import { installCommand, quickStartOnGitHub, setupPrompt } from "./setup-prompt.ts";
import { startingPoints, trustNote } from "./starting-points.ts";

export const tagline = "Computers for BB threads: Linux, Windows, macOS, iOS and Android, virtual or real: desktops, terminals or simulators, shared by you and your agent.";
export const headline = "Computers for BB threads";
export const subline = "Linux, Windows, macOS, iOS and Android, virtual or real: desktops, terminals or simulators, shared by you and your agent.";
export const demoDescription =
  "A person asks a BB thread's agent for a Linux desktop box, and the agent opens getbb.app in its browser. The person opens the desktop, glances at the box's CPU and memory in the Monitor, then makes a server box and runs a command in its terminal. On the server box's page, the person takes a snapshot, breaks the box from its terminal, and restores the snapshot with an undo.";

export type ImageSource = typeof boxPanel;

export interface Shot {
  dark: ImageSource;
  light: ImageSource;
  alt: string;
  focus: { x: number; y: number; zoom: number };
}

export const shots = {
  boxPanel: { dark: boxPanel, light: boxPanelLight, alt: "A thread's Box panel with two Linux boxes, each ready in under 2 seconds.", focus: { x: 100, y: 8, zoom: 1.3 } },
  desktop: { dark: desktopBox, light: desktopBoxLight, alt: "A Linux desktop box open in a thread's Desktop tab while the agent has control.", focus: { x: 70, y: 40, zoom: 1.15 } },
  newBox: { dark: newBoxForm, light: newBoxFormLight, alt: "The new box form: system, architecture, type, size and the provider the box goes to.", focus: { x: 92, y: 60, zoom: 1.5 } },
  monitor: { dark: monitor, light: monitorLight, alt: "The Monitor in BB's sidebar, with a box's CPU at 100 percent and its memory at 52 percent.", focus: { x: 0, y: 100, zoom: 2 } },
  terminal: { dark: terminalBox, light: terminalBoxLight, alt: "A box's terminal in a thread, after uname and nproc.", focus: { x: 40, y: 0, zoom: 1.6 } },
  recording: { dark: recordingStep, light: recordingStep, alt: "A step of an agent's recording, captioned with what it did and what happened.", focus: { x: 50, y: 50, zoom: 1 } },
} satisfies Record<string, Shot>;

const shotForReason: Record<string, Shot> = {
  "Each thread gets its own computers": shots.boxPanel,
  "Shared desktops": shots.desktop,
  "Any provider": shots.newBox,
  "Every machine at a glance": shots.monitor,
  "Recordings that show the work": shots.recording,
};

export interface Feature extends ListItem {
  shot?: Shot;
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
  boxes: string;
  where: string;
  snapshots: string;
  takesSnapshots: boolean;
  runs: Record<PlatformName, boolean>;
  desktops: boolean;
}

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function backendOf(cells: string[]): Backend {
  const link = /<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(cells[0]!);
  const boxes = plainText(cells[1] ?? "");
  const snapshots = plainText(cells[3] ?? "");
  return {
    name: plainText(link?.[2] ?? cells[0]!),
    href: link?.[1] ?? "",
    boxes,
    where: sentenceCase(plainText(cells[2] ?? "")),
    snapshots,
    takesSnapshots: !/^none\b/i.test(snapshots),
    runs: Object.fromEntries(platformNames.map((platform) => [platform, platformPatterns[platform].test(boxes)])) as Record<PlatformName, boolean>,
    desktops: /desktop/i.test(boxes),
  };
}

export interface HomeData {
  features: Feature[];
  backends: Backend[];
  requirements: ListItem[];
  prompt: string;
  command: string;
  trustNote: string;
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
    features: listUnder(html, "why-bb-box").map((reason) => ({ ...reason, shot: shotForReason[reason.title] })),
    backends: tableUnder(html, "backends-and-boxes").map(backendOf),
    requirements: firstListIn(quickStartEntry?.rendered?.html ?? ""),
    prompt: setupPrompt(pages, quickStartMarkdown),
    command,
    trustNote,
    links: startingPoints.map((way) => ({ title: way.title, words: way.words, href: pageUrl(base, way.id) })),
    quickStart: pageUrl(base, "start/quick-start"),
    repository,
    licence: fileUrl("LICENSE"),
    thirdParty: fileUrl("THIRD-PARTY.md"),
  };
}
