// "New box": a plus that opens a popover with one form of sections that
// narrow each other (System, Architecture, Type, Provider, Resources, and
// Name for a machine) and one button. The size is a preset, or a custom one
// within the kind's largest (028). It remembers the last kind and size in
// the browser, keyed by plugin ID.

import { experimental_Icon as Icon, experimental_usePluginId, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Contract, DesktopOnDemandView } from "../plugin/contract.ts";
import type { MachineAccessProblem } from "../plugin/setup-offer.ts";
import type { ImageOptionView, KindView, OfferRoom, OfferView, ProviderProfile, SizeView } from "../plugin/views.ts";
import type { SlotKind } from "../core/device-host.ts";
import { ProviderInfo, type Loaded } from "./provider-profile.tsx";
import { message } from "./common.tsx";
import { LargestLine, type AskedParts } from "./largest-line.tsx";
import { withoutRaiseLargest } from "../core/largest-words.ts";
import { DESKTOP_BUILD_WORDS, estimate, JoinHelp } from "./first-run.tsx";
import type { GpuPart, GpuRoom, GuestOs, Windowing } from "../backends/types.ts";
import { gpuWhenNotAsked } from "../core/gpu.ts";
import { GPU_LINE_CLASS, GPU_MENU_LABELS, gpuFormLine, gpuMenuParts, gpuMenuShows, gpuRowReason, type GpuFormOffer } from "./gpu-choice.ts";
import { archAvailable, ARCHS, choiceOf, displayChoices, FORM_FILTERS, formFilterOf, FormSection, gpuChoices, gpuFullNote, kindFor, MenuSelect, nearest, useEscapeCloses, offersShown, OptionCard, ProviderRow, runsOnOptions, RUNS_ON_WORDS, systemsOf, TYPE_GLYPHS, typeAvailable, type Choice, type FormFilter, type RunsOn } from "./box-form.tsx";

export const ROOMS_CHECK_MS = 300;

/**
 * What "Ask an agent to make one" puts in a new thread's composer (049): the
 * skill's flow for a project's image, for the person to send.
 */

export const IMAGE_REQUEST =
  "Make a box image for this project with bb-box: draft .bb/box-setup.sh and .bb/box-check.sh with box_image_draft from the project's files, " +
  "try them with box_image_try until every check passes, commit them, then register them with box_image_set.";

/** What the acquire RPC takes: a preset, or the parts of a custom size. Nothing for the kind's default. */
export interface SizeRequest {
  readonly preset?: string;
  readonly cores?: number;
  readonly memoryGiB?: number;
  readonly diskGiB?: number;
  readonly gpu?: GpuPart;
}

type Choice2 = string;

type Placement = "shared" | "own";

const PLACEMENTS: readonly { readonly id: Placement; readonly title: string; readonly words: Readonly<Record<SlotKind, string>> }[] = [
  {
    id: "shared",
    title: "Shared",
    words: {
      ios: "Ready in seconds. No sudo or Homebrew installs. Other iOS boxes on the host share its cores and ports, and see its processes.",
      macos: "Ready in seconds, for commands, builds and the iOS Simulator. No sudo, Homebrew installs, desktop or app windows. Other boxes on the host share its cores and ports, and see its processes.",
    },
  },
  {
    id: "own",
    title: "A VM of its own",
    words: {
      ios: "sudo, Homebrew, its own cores, ports and desktop. Takes one of the Mac's two VMs, so it can wait for one.",
      macos: "sudo, Homebrew, its own cores and ports. Takes one of the Mac's two VMs, so it can wait for one.",
    },
  },
];
const CUSTOM: Choice2 = "custom";

interface Fields {
  readonly cores: string;
  readonly memoryGiB: string;
  readonly diskGiB: string;
}

interface Remembered {
  readonly kind?: string;
  readonly size?: Choice2;
  /** The custom fields a person edited, by kind. */
  readonly custom?: Readonly<Record<string, Fields>>;
  /** The GPU the person last chose, by kind. Absent until they choose. */
  readonly gpu?: Readonly<Record<string, GpuPart>>;
}

function remembered(key: string): Remembered {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? "{}") as Remembered;
  } catch {
    return {};
  }
}

function remember(key: string, value: Remembered): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be off. Then the form starts from the kind's default each time.
  }
}

/** "2 cores · 4 GiB memory · base disk". */
export function sizeLine(size: SizeView): string {
  return [`${size.cores} ${size.cores === 1 ? "core" : "cores"}`, `${size.memoryGiB} GiB memory`, size.diskGiB === null ? "base disk" : `${size.diskGiB} GiB disk`].join(" · ");
}

const PRESET_LABELS: Readonly<Record<string, string>> = { small: "Small", medium: "Medium", large: "Large" };


/** A whole number of at least 1, or null for an empty field; undefined when the text is not one. */
function whole(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

function askedParts(fields: Fields): AskedParts {
  const asked = (text: string) => whole(text) ?? undefined;
  return { cores: asked(fields.cores), memoryGiB: asked(fields.memoryGiB), diskGiB: asked(fields.diskGiB) };
}

/** Custom starts from a preset: its cores and memory, and its disk when it has one of its own. */
function fieldsOf(preset: SizeView): Fields {
  return { cores: String(preset.cores), memoryGiB: String(preset.memoryGiB), diskGiB: preset.diskGiB === null ? "" : String(preset.diskGiB) };
}

/** The custom size's fields as the RPC takes them, or null when a field is not a whole number. */
export function customSize(fields: Fields): SizeRequest | null {
  const cores = whole(fields.cores);
  const memoryGiB = whole(fields.memoryGiB);
  const diskGiB = whole(fields.diskGiB);
  if (cores === undefined || memoryGiB === undefined || diskGiB === undefined) return null;
  return { ...(cores !== null ? { cores } : {}), ...(memoryGiB !== null ? { memoryGiB } : {}), ...(diskGiB !== null ? { diskGiB } : {}) };
}

/** A machine's name (036): a hostname label of up to 32 characters, unique among your machines, which the server checks. */
export const MACHINE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export interface DesktopOnDemand {
  readonly kinds: readonly { readonly kind: KindView; readonly took: number | null }[];
  readonly machine: string;
  readonly build: (kind: string, size?: SizeRequest, name?: string) => Promise<string | null>;
}

export function useDesktopOnDemand(view: DesktopOnDemandView | null | undefined, threadId: string, refresh: () => Promise<unknown>): DesktopOnDemand | null {
  const rpc = useRpc<Contract>();
  if (!view) return null;
  return {
    kinds: view.kinds,
    machine: view.name,
    build: async (kind, size, name) => {
      try {
        const { result } = await rpc.call("setup.desktop", { threadId, hostId: view.hostId, kind: kind as "linux-desktop-cpu" | "linux-desktop-wayland-cpu", ...(size ? { size } : {}), ...(name ? { name } : {}) });
        await refresh();
        if (result.ok) return null;
        return result.reason === "problems" ? result.problems.map((item) => item.message).join(" ") : "Someone else saved BB Box's settings at the same moment. Try again.";
      } catch (caught) {
        return message(caught);
      }
    },
  };
}

export function useDesktopProblemShownOnce(desktopProblem: { readonly message: string; readonly at: number } | null | undefined, show: (message: string) => void): void {
  const shown = useRef<number | null>(null);
  useEffect(() => {
    if (!desktopProblem || shown.current === desktopProblem.at) return;
    shown.current = desktopProblem.at;
    show(desktopProblem.message);
  }, [desktopProblem]);
}

function formOffer(offer: OfferView, room: GpuRoom | null, unread: boolean, failed = false): GpuFormOffer {
  return {
    host: offer.hosts[0] || offer.label,
    label: offer.label,
    gpuParts: offer.gpuParts,
    gpuRoom: unread ? null : room,
    unread,
    failed,
    reachesEveryCard: !!offer.cardReach,
    canAddGpu: offer.resizing?.gpu ? offer.resizing.gpu.add !== "no" : true,
  };
}

/** Why a typed name will not do, or null when it will; an empty name lets bb-box pick one. */
export function nameProblem(name: string): string | null {
  if (!name) return null;
  if (!MACHINE_NAME.test(name)) return "Lowercase letters, digits and hyphens, starting with a letter, up to 32 characters.";
  if (name.endsWith("-")) return "A name cannot end with a hyphen.";
  return null;
}

export function NewBox({
  kinds: offeredKinds,
  make,
  onDemand,
  access = null,
  machine = false,
  primary = false,
  profile,
  rooms,
  cards,
  askForImage,
  images = [],
}: {
  kinds: readonly KindView[];
  /** Makes a box; resolves with the refusal to show, or null when the box was made. A machine's name goes with it (036), and its image (049). */
  make: (kind: string, size?: SizeRequest, name?: string, on?: string | string[], image?: string, device?: string, placement?: "dedicated" | "shared") => Promise<string | null>;
  /** The projects' images a box can choose (049), this project's marked mine; the choice shows where one covers the chosen kind. */
  images?: readonly ImageOptionView[];
  /** "Add machine": a labelled button, and a Name field, for one of your machines (036). */
  machine?: boolean;
  /** With `machine`, the Boxes page's "New box", in the style of Automations' New button, rather than "Add machine" (the operator, 8 October 2026). */
  primary?: boolean;
  /** A provider's profile for the (i) on its row, asked when the popover opens. Without it, rows have no (i). */
  profile?: (backend: string) => Promise<ProviderProfile>;
  rooms?: (kind: string, size?: SizeRequest) => Promise<readonly OfferRoom[]>;
  /** A fresh reading of the kind's cards. While it is out, the GPU line says it is reading. */
  cards?: (kind: string) => Promise<readonly { readonly backend: string; readonly room: GpuRoom | null }[]>;
  /** Asks an agent to make the project a box image (049), when it has none. */
  askForImage?: () => void;
  /**
   * A desktop whose image is not built yet (the setup plan's PR 4): the form offers it, saying it builds first, and
   * Create asks `build`, which resolves with the refusal to show, or null once the build has started.
   */
  onDemand?: DesktopOnDemand | null;
  access?: MachineAccessProblem | null;
}) {
  const toBuild = (onDemand?.kinds ?? []).filter((entry) => !offeredKinds.some((offered) => offered.id === entry.kind.id));
  const kinds = toBuild.length ? [...offeredKinds, ...toBuild.map((entry) => entry.kind)] : offeredKinds;
  const pluginId = experimental_usePluginId();
  const [open, setOpen] = useState(false);
  useEscapeCloses(open, setOpen);
  const [last] = useState(() => remembered(`${pluginId}:${machine ? "new-machine" : "new-box"}`));
  const [name, setName] = useState("");
  // The steps that pick the kind (the operator's redesign of 1 October 2026): the OS, the architecture, a desktop or not, a GPU.
  const [wanted, setWanted] = useState<Choice>(() => {
    const remembered = kinds.find((kind) => kind.id === last.kind);
    return remembered ? choiceOf(remembered) : { os: "linux", arch: "x86_64", desktop: false, gpu: false, windowing: "x11" };
  });
  const [choice, setChoice] = useState<Choice2 | null>(last.size ?? null);
  /** The image chosen by hand (049): a name or "standard"; null until then, so the form starts on the project's image each time. */
  const [image, setImage] = useState<string | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  /** The preset last chosen, which Custom starts from. */
  const [viewed, setViewed] = useState<string | null>(last.size && last.size !== CUSTOM ? last.size : null);
  // Custom fields belong to a kind: edited ones are kept per kind, and a
  // kind without edits starts from its own preset in view.
  const [edited, setEdited] = useState<Readonly<Record<string, Fields>>>(() => (last.custom && typeof last.custom === "object" ? last.custom : {}));
  const [gpuByKind, setGpuByKind] = useState<Readonly<Record<string, GpuPart>>>(() => (last.gpu && typeof last.gpu === "object" ? last.gpu : {}));
  const [cardRooms, setCardRooms] = useState<ReadonlyMap<string, GpuRoom | null> | null>(null);
  const [cardsFailed, setCardsFailed] = useState(false);
  const [cardTry, setCardTry] = useState(0);
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The Provider step's filters: what the boxes are, and the machine they run on. */
  const [filter, setFilter] = useState<FormFilter>("all");
  const [runsOn, setRunsOn] = useState<RunsOn>("any");
  /** Where the box goes (044): a provider's backend ID, or null for the first with room. Not remembered; another kind resets it. */
  const [on, setOn] = useState<string | null>(null);
  const sizeOptions = useRef<(HTMLButtonElement | null)[]>([]);
  const providerOptions = useRef<(HTMLButtonElement | null)[]>([]);
  const placementOptions = useRef<(HTMLButtonElement | null)[]>([]);
  // Every listed provider's profile, fetched in the background once the form has painted, all at once, and kept for the form's life, so the (i) opens filled (the operator's note of 2 October 2026). Nothing is fetched while the form is closed.
  const [profiles, setProfiles] = useState<ReadonlyMap<string, Loaded>>(() => new Map());
  const profilesNow = useRef(profiles);
  profilesNow.current = profiles;
  const inFlight = useRef(new Set<string>());
  const loadProfile = useCallback(
    (backend: string) => {
      if (!profile || inFlight.current.has(backend) || profilesNow.current.get(backend)?.profile) return;
      inFlight.current.add(backend);
      setProfiles((current) => new Map(current).set(backend, { profile: null, error: null, loading: true }));
      profile(backend)
        .then(
          (found) => setProfiles((current) => new Map(current).set(backend, { profile: found, error: null, loading: false })),
          (error: unknown) => setProfiles((current) => new Map(current).set(backend, { profile: null, error: message(error), loading: false })),
        )
        .finally(() => inFlight.current.delete(backend));
    },
    [profile],
  );
  const [roomsByKind, setRoomsByKind] = useState<ReadonlyMap<string, ReadonlyMap<string, string>>>(() => new Map());
  const listed = kinds.flatMap((kind) => kind.offers.map((offer) => offer.backend)).join("\n");
  useEffect(() => {
    if (!open) {
      setProfiles(new Map());
      return;
    }
    const after = setTimeout(() => {
      for (const backend of new Set(listed.split("\n").filter(Boolean))) loadProfile(backend);
    }, 0);
    return () => clearTimeout(after);
  }, [open, listed, loadProfile]);

  // Every step shows what exists; a choice snaps to the nearest that does.
  const picked = nearest(kinds, wanted);
  const kind = kindFor(kinds, picked);
  const kindId = kind?.id ?? null;
  const buildingFirst = toBuild.find((entry) => entry.kind.id === kind?.id) ?? null;
  const buildsFirst = buildingFirst !== null;
  const desktopsAllToBuild = toBuild.filter((entry) => entry.kind.os === picked.os && entry.kind.arch === picked.arch);
  const desktopBuildsFirst = desktopsAllToBuild.length > 0 && !offeredKinds.some((offered) => offered.os === picked.os && offered.arch === picked.arch && offered.desktop);
  // The images covering the chosen kind (049): the choice shows only where there is one. The state lists this project's first.
  const covering = kind ? images.filter((candidate) => candidate.kinds.includes(kind.id)) : [];
  const imageChoice = covering.length > 0;
  const imageOptions = [
    ...covering.filter((candidate) => candidate.mine).map((candidate) => ({ value: candidate.name, label: candidate.name })),
    { value: "standard", label: "Standard" },
    ...covering.filter((candidate) => !candidate.mine).map((candidate) => ({ value: candidate.name, label: `${candidate.name} · ${candidate.projects.map((project) => project.name).join(", ")}` })),
  ];
  /** What the form says about the image: the hand's choice while it covers the kind, else this project's image, else Standard; nothing when there is no choice. */
  const chosenImage = imageChoice ? (image && imageOptions.some((option) => option.value === image) ? image : (covering.find((candidate) => candidate.mine)?.name ?? "standard")) : undefined;
  const systems = systemsOf(kinds);
  const devices = kind?.devices?.models ?? [];
  const placementChoice = !machine && kind?.placement ? kind.placement : null;
  const placements = placementChoice ? PLACEMENTS.filter((option) => option.id !== "shared" || placementChoice.shared) : [];
  const placementByDefault: Placement = placementChoice?.shared && placementChoice.sizeNeedsDedicated ? "shared" : "own";
  const chosenPlacement: Placement | null = placementChoice ? (placements.some((option) => option.id === placement) ? placement! : placementByDefault) : null;
  const sharedChosen = chosenPlacement === "shared";
  const ownAsksDedicated = placementChoice?.kind === "ios";
  const placementAsked = chosenPlacement === "shared" ? ("shared" as const) : chosenPlacement === "own" && ownAsksDedicated ? ("dedicated" as const) : undefined;
  const chosenDevice = devices.length ? (device && devices.includes(device) ? device : devices[0]) : undefined;
  const systemOf = (system: { readonly os: string; readonly device?: string }) => system.device ?? system.os;
  const pickedSystem = picked.device ?? picked.os;
  const gpus = gpuChoices(kinds, picked.os, picked.arch, picked.windowing);
  /** A desktop whose system has a GPU desktop and a CPU one: the GPU is a choice. */
  const gpuChoice = picked.desktop && gpus.none && gpus.gpu;
  const displays = displayChoices(kinds, picked.os, picked.arch);
  /** A desktop whose system has both an X11 desktop and a Wayland one: the windowing is a choice (048). */
  const displayChoice = picked.desktop && displays.x11 && displays.wayland;
  const offers = kind?.offers ?? [];
  const runsOnChoices = runsOnOptions(offers);
  const effectiveRunsOn: RunsOn = runsOnChoices.includes(runsOn as GuestOs) ? runsOn : "any";
  const roomsHere = kind ? roomsByKind.get(kind.id) : undefined;
  const blockedWhy = (offer: OfferView) => roomsHere?.get(offer.backend) ?? null;
  const filtered = offersShown(offers, filter, effectiveRunsOn);
  const shown = [...filtered.filter((offer) => blockedWhy(offer) === null), ...filtered.filter((offer) => blockedWhy(offer) !== null)];
  const cardParts = (offer: OfferView) => offer.gpuParts?.some((part) => part !== "none") ?? false;
  const asForm = (offer: OfferView): GpuFormOffer => {
    if (cards !== undefined && cardRooms === null && !cardsFailed) return formOffer(offer, null, true);
    if (cardsFailed && offer.gpuRoom === null && cardParts(offer)) return formOffer(offer, null, false, true);
    if (cardRooms) return formOffer(offer, cardRooms.get(offer.backend) ?? null, false);
    return formOffer(offer, offer.gpuRoom, cards === undefined && offer.gpuRoom === null && cardParts(offer));
  };
  const cardMenu = gpuMenuShows(kind, shown.map((offer) => formOffer(offer, offer.gpuRoom, false)));
  const cpuSibling = !!kind?.gpu && kinds.some((candidate) => candidate.id !== kind.id && candidate.desktop && !candidate.gpu && candidate.os === kind.os && candidate.arch === kind.arch && candidate.windowing === kind.windowing);
  const menuParts = gpuMenuParts(shown.map(asForm), cpuSibling);
  const gpuDefault = kind ? gpuWhenNotAsked(kind.id) : "none";
  const rememberedGpu = kind ? gpuByKind[kind.id] : undefined;
  const chosenGpu: GpuPart = rememberedGpu && menuParts.includes(rememberedGpu) ? rememberedGpu : menuParts.includes(gpuDefault) ? gpuDefault : (menuParts[0] ?? "none");
  const readCards = useRef(cards);
  readCards.current = cards;
  useEffect(() => {
    const read = readCards.current;
    if (!open || !cardMenu || !read || !kindId) {
      if (!open) {
        setCardRooms(null);
        setCardsFailed(false);
      }
      return;
    }
    let stale = false;
    setCardRooms(null);
    setCardsFailed(false);
    read(kindId).then(
      (rows) => {
        if (!stale) setCardRooms(new Map(rows.map((row) => [row.backend, row.room])));
      },
      () => {
        if (!stale) setCardsFailed(true);
      },
    );
    return () => {
      stale = true;
    };
  }, [open, cardMenu, kindId, cards !== undefined, cardTry]);
  const takers = shown.filter((offer) => blockedWhy(offer) === null);
  // One offer is no choice: its row stands alone, checked, and nothing goes as `on` (044's first with room is that one).
  const choiceless = offers.length <= 1;
  const onOffer = choiceless ? (shown[0] ?? null) : (takers.find((offer) => offer.backend === on) ?? null);
  const gpuPreview = onOffer ? [onOffer] : filtered.filter((offer) => blockedWhy(offer) === null);
  const presets = kind?.presets ?? [];
  const choices: Choice2[] = [...presets.map((preset) => preset.name), CUSTOM];
  const size: Choice2 = choice && choices.includes(choice) ? choice : (kind?.defaultPreset ?? CUSTOM);
  const preset = presets.find((candidate) => candidate.name === size) ?? null;
  // The preset Custom starts from: the one chosen last, else the kind's default.
  const inView = preset ?? presets.find((candidate) => candidate.name === viewed) ?? presets.find((candidate) => candidate.name === kind?.defaultPreset) ?? null;
  const fields: Fields = (kind && edited[kind.id]) ?? (inView ? fieldsOf(inView) : { cores: "", memoryGiB: "", diskGiB: "" });
  const custom = size === CUSTOM ? customSize(fields) : null;
  const roomSize: SizeRequest | null | undefined = size === CUSTOM ? (custom ?? undefined) : size === kind?.defaultPreset ? null : { preset: size };
  const roomKey = roomSize === undefined ? null : JSON.stringify(roomSize);
  useEffect(() => {
    if (!open) {
      setRoomsByKind(new Map());
      return;
    }
    if (!rooms || !kindId || roomKey === null || (kind?.offers.length ?? 0) < 2) return;
    let stale = false;
    const asked = JSON.parse(roomKey) as SizeRequest | null;
    const timer = setTimeout(() => {
      rooms(kindId, asked ?? undefined).then(
        (answers) => {
          if (stale) return;
          const blocked = new Map(answers.filter((answer) => !answer.available).map((answer) => [answer.backend, answer.reason ?? "Cannot take a box now"] as const));
          setRoomsByKind((current) => new Map(current).set(kindId, blocked));
        },
        () => undefined,
      );
    }, ROOMS_CHECK_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, kindId, roomKey, rooms]);
  const sizeIndex = choices.indexOf(size);
  // Whether the box would claim a spare on a provider (032, #440): one of the chosen project's image, else one of the kind's,
  // at the kind's default size. Your machines claim none.
  const imageSpares = chosenImage && chosenImage !== "standard" ? (covering.find((candidate) => candidate.name === chosenImage)?.spares ?? []) : null;
  const readyOn = (offer: OfferView) =>
    !machine && !!kind && size === kind.defaultPreset && (imageSpares ? imageSpares.some((spare) => spare.kind === kind.id && spare.backend === offer.backend && spare.ready > 0) : offer.ready > 0);
  const forGpu = (offer: OfferView): GpuFormOffer => ({ ...asForm(offer), spare: !!kind && readyOn(offer) && chosenGpu === gpuWhenNotAsked(kind.id) });
  const gpuLine = cardMenu ? gpuFormLine(gpuPreview.map(forGpu), chosenGpu, Date.now()) : null;
  // With 1 GPU chosen, why no GPU would take the box (#603); a ready spare holds its GPU already.
  const placing = onOffer ? [onOffer] : shown;
  const gpuFull = gpuChoice && picked.gpu && !placing.some(readyOn) ? gpuFullNote(placing, Date.now()) : null;
  const cardReach = [...new Set(placing.flatMap((offer) => (offer.cardReach ? [offer.cardReach] : [])))].join(" ");

  useEffect(() => {
    if (open) return;
    // The provider choice and its filters are not remembered (044): the next box starts from the first with room.
    setProblem(null);
    setOn(null);
    setFilter("all");
    setRunsOn("any");
  }, [open]);

  const pick = (change: Partial<Choice>) => {
    setWanted((current) => nearest(kinds, { ...current, ...change }));
    setOn(null);
    setProblem(null);
  };
  const chooseSize = (next: Choice2, focus = false) => {
    setChoice(next);
    if (next !== CUSTOM) setViewed(next);
    setProblem(null);
    if (focus) sizeOptions.current[choices.indexOf(next)]?.focus();
  };
  const edit = (name: keyof Fields, value: string) => {
    if (!kind) return;
    setEdited((current) => ({ ...current, [kind.id]: { ...fields, [name]: value } }));
    setProblem(null);
  };
  const arrows = (event: KeyboardEvent<HTMLElement>, count: number, index: number, pick: (position: number) => void) => {
    if (!count) return;
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    pick((index + step + count) % count);
  };
  const typedName = name.trim();
  const nameWrong = machine ? nameProblem(typedName) : null;
  // "First with room" with every provider shown names none; with the filters hiding some, it names the shown ones, as a list when there are several, so the box never lands outside the filter (044).
  const sendOn: string | string[] | undefined = choiceless
    ? undefined
    : onOffer
      ? onOffer.backend
      : shown.length && shown.length < offers.length
        ? shown.length === 1
          ? shown[0]!.backend
          : shown.map((offer) => offer.backend)
        : undefined;
  /** Filters that leave no provider: nothing to create. */
  const noMatch = !choiceless && !shown.length;
  const submit = async () => {
    if (!kind || making || noMatch || (size === CUSTOM && !custom) || nameWrong) return;
    setMaking(true);
    try {
      const request: SizeRequest | undefined = size === CUSTOM ? (custom ?? undefined) : size === kind.defaultPreset ? undefined : { preset: size };
      const sized = sharedChosen ? undefined : cardMenu && chosenGpu !== gpuDefault ? { ...(request ?? {}), gpu: chosenGpu } : request;
      const refused = buildsFirst
        ? await onDemand!.build(kind.id, sized, machine && typedName ? typedName : undefined)
        : await make(kind.id, sized, machine && typedName ? typedName : undefined, sendOn, chosenImage, chosenDevice, placementAsked);
      setProblem(refused === null ? null : withoutRaiseLargest(refused));
      if (!refused) {
        remember(`${pluginId}:${machine ? "new-machine" : "new-box"}`, { kind: kind.id, size, ...(Object.keys(gpuByKind).length ? { gpu: gpuByKind } : {}), ...(Object.keys(edited).length ? { custom: edited } : {}) });
        setName("");
        setOpen(false);
      }
    } finally {
      setMaking(false);
    }
  };

  const largest = kind?.largest ?? null;
  const field = (name: "cores" | "memoryGiB" | "diskGiB", label: string, limit: number | null) => (
    <label className="flex min-w-0 flex-col gap-1 text-xs leading-snug text-subtle-foreground">
      <span>{label}</span>
      <Input
        inputMode="numeric"
        className="h-7 px-2 text-xs"
        value={fields[name]}
        placeholder={name === "diskGiB" ? "base" : ""}
        aria-invalid={whole(fields[name]) === undefined || undefined}
        onChange={(event) => edit(name, event.target.value)}
      />
      {limit !== null ? <span>up to {limit}</span> : null}
    </label>
  );
  // The provider choice: "First with room" when there is one to make, then the rows the filters leave.
  const providerValues: (string | null)[] = [...(choiceless || !shown.length ? [] : [null]), ...takers.map((offer) => offer.backend)];
  const providerIndex = Math.max(0, providerValues.indexOf(onOffer?.backend ?? null));
  const kindOptions = FORM_FILTERS.map((option) => ({ value: option.id, label: option.label, disabled: option.id !== "all" && !offers.some((offer) => formFilterOf(offer) === option.id) }));
  const runsOnChoiceList = [{ value: "any", label: "Any machine" }, ...runsOnChoices.map((os) => ({ value: os, label: RUNS_ON_WORDS[os] }))];
  // The footer says what stands in the way: a refusal, or filters that leave no provider.
  const standing =
    problem ??
    (noMatch
      ? "No provider matches these filters."
      : buildingFirst
        ? `BB Box builds the ${buildingFirst.kind.windowing === "wayland" ? "Wayland desktop image" : "desktop image"} on ${onDemand!.machine} first, ${estimate(buildingFirst.took, DESKTOP_BUILD_WORDS)}, then makes the box.`
        : null);
  const rowClass = (selected: boolean) =>
    cn(
      "flex w-full flex-col items-start rounded-md border px-3 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
      selected ? "border-transparent bg-state-active" : "border-input hover:bg-state-hover",
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {machine && primary ? (
        <PopoverTrigger asChild>
          <Button type="button" size="sm" disabled={!kinds.length}>
            <Icon name="Plus" aria-hidden />
            New box
          </Button>
        </PopoverTrigger>
      ) : machine ? (
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-7" disabled={!kinds.length}>
            <Icon name="Plus" aria-hidden />
            Add machine
          </Button>
        </PopoverTrigger>
      ) : (
        <TooltipProvider delayDuration={250}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label="New box" disabled={!kinds.length}>
                  <Icon name="Plus" className="size-4" aria-hidden />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>New box</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {/* The form may be taller than the window: it takes the height the popover has and scrolls inside, so a short window scrolls the form rather than losing its bottom. */}
      <PopoverContent align="end" className="max-h-[var(--radix-popover-content-available-height)] w-80 overflow-y-auto p-4 sm:w-[560px] sm:p-5" mobileTitle={machine && !primary ? "Add machine" : "New box"}>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FormSection title="System" description={machine ? "Of the kinds whose boxes join BB." : undefined}>
            <div
              role="radiogroup"
              aria-label="System"
              className="flex flex-wrap gap-2"
              onKeyDown={(event) => arrows(event, systems.length, systems.findIndex((system) => systemOf(system) === pickedSystem), (position) => pick({ os: systems[position]!.os, device: systems[position]!.device }))}
            >
              {systems.map((system) => (
                <OptionCard key={systemOf(system)} title={system.label} words={system.words} selected={systemOf(system) === pickedSystem} onClick={() => pick({ os: system.os, device: system.device })} />
              ))}
            </div>
            {placementChoice && chosenPlacement ? (
              <div className="space-y-1">
                <p id="new-box-placement" className="text-xs text-muted-foreground">
                  Machine
                </p>
                <div
                  role="radiogroup"
                  aria-labelledby="new-box-placement"
                  className="space-y-2"
                  onKeyDown={(event) =>
                    arrows(event, placements.length, placements.findIndex((option) => option.id === chosenPlacement), (position) => {
                      setPlacement(placements[position]!.id);
                      placementOptions.current[PLACEMENTS.indexOf(placements[position]!)]?.focus();
                    })
                  }
                >
                  {PLACEMENTS.map((option, index) => {
                    const available = option.id !== "shared" || placementChoice.shared;
                    const selected = option.id === chosenPlacement;
                    return (
                      <button
                        key={option.id}
                        ref={(element) => {
                          placementOptions.current[index] = element;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-disabled={!available || undefined}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => {
                          if (available) setPlacement(option.id);
                        }}
                        className={cn(rowClass(selected), !available && "cursor-default opacity-50 hover:bg-transparent")}
                      >
                        <span className="block text-xs text-foreground">{option.title}</span>
                        <span className="mt-0.5 block text-2xs leading-snug text-muted-foreground">{available ? option.words[placementChoice.kind] : `${placementChoice.why ?? "Not available"}.`}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {devices.length ? (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Device</p>
                <MenuSelect label="Device" value={chosenDevice ?? devices[0]!} options={devices.map((model) => ({ value: model, label: model }))} onChange={setDevice} />
              </div>
            ) : null}
          </FormSection>
          {picked.device ? null : (
            <>
              <FormSection title="Architecture">
                <div role="radiogroup" aria-label="Architecture" className="flex flex-wrap gap-2" onKeyDown={(event) => arrows(event, ARCHS.length, ARCHS.findIndex((arch) => arch.id === picked.arch), (position) => pick({ arch: ARCHS[position]!.id }))}>
                  {ARCHS.map((arch) => (
                    <OptionCard key={arch.id} title={arch.label} words={arch.words} selected={arch.id === picked.arch} available={archAvailable(kinds, picked.os, arch.id)} onClick={() => pick({ arch: arch.id })} />
                  ))}
                </div>
              </FormSection>
              <FormSection title="Type">
                <div role="radiogroup" aria-label="Type" className="flex flex-wrap gap-2" onKeyDown={(event) => arrows(event, 2, picked.desktop ? 1 : 0, (position) => pick({ desktop: position === 1 }))}>
                  <OptionCard title="Server" words="Terminal" glyph={TYPE_GLYPHS.server} selected={!picked.desktop} available={typeAvailable(kinds, picked.os, picked.arch, false)} onClick={() => pick({ desktop: false })} />
                  <OptionCard title="Desktop" words={desktopBuildsFirst ? `Builds first, ${estimate(desktopsAllToBuild[0]!.took, DESKTOP_BUILD_WORDS)}` : "Screen · Terminal · Computer use"} glyph={TYPE_GLYPHS.desktop} selected={picked.desktop} available={typeAvailable(kinds, picked.os, picked.arch, true)} onClick={() => pick({ desktop: true })} />
                </div>
                {displayChoice ? (
                  // The windowing is a detail of a desktop, as a GPU is of its resources (the operator's notes of 3 October 2026): a dim sub-label under
                  // the cards, then the menu, with plain names and no description. Shown only when a system has both; X11 by default, so today's boxes are unchanged (048).
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Display</p>
                    <MenuSelect
                      label="Display"
                      value={picked.windowing}
                      options={[
                        { value: "x11", label: "X11" },
                        { value: "wayland", label: "Wayland" },
                      ]}
                      onChange={(value) => pick({ windowing: value as Windowing })}
                    />
                  </div>
                ) : null}
                {imageChoice ? (
                  // The image is a detail of the box's kind (049), in the Display choice's shape: a dim sub-label under the cards, then one menu,
                  // this project's image first and chosen at first, then Standard, then other projects' images; plain names, no description.
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Image</p>
                    <MenuSelect label="Image" value={chosenImage ?? "standard"} options={imageOptions} onChange={setImage} />
                  </div>
                ) : null}
              </FormSection>
            </>
          )}
          {kind && !sharedChosen ? (
            <FormSection title="Resources" description={`Configure the box's cores, memory${cardMenu || gpuChoice ? ", disk and GPU" : " and disk"}: pick a size, or Custom to set your own.`}>
              <div role="radiogroup" aria-label="Size" className="flex flex-wrap gap-2" onKeyDown={(event) => arrows(event, choices.length, sizeIndex, (position) => chooseSize(choices[position]!, true))}>
                {choices.map((candidate, position) => {
                  const own = presets.find((item) => item.name === candidate) ?? null;
                  return (
                    <OptionCard
                      key={candidate}
                      optionRef={(element) => {
                        sizeOptions.current[position] = element;
                      }}
                      title={PRESET_LABELS[candidate] ?? (candidate === CUSTOM ? "Custom" : candidate)}
                      words={own ? `${own.cores} cores · ${own.memoryGiB} GiB` : largest ? `up to ${largest.cores} cores` : null}
                      selected={candidate === size}
                      onClick={() => chooseSize(candidate)}
                    />
                  );
                })}
              </div>
              {!preset ? (
                <div className="grid grid-cols-3 gap-3">
                  {field("cores", "Cores", largest?.cores ?? null)}
                  {field("memoryGiB", "Memory, GiB", largest?.memoryGiB ?? null)}
                  {field("diskGiB", "Disk, GiB", largest?.diskGiB ?? null)}
                </div>
              ) : null}
              {!preset && largest ? <LargestLine kind={kind.id} largest={largest} asked={askedParts(fields)} onFollow={() => setOpen(false)} /> : null}
              {cardMenu ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">GPU</p>
                  <MenuSelect
                    label="GPU"
                    value={chosenGpu}
                    options={menuParts.map((part) => ({ value: part, label: GPU_MENU_LABELS[part] }))}
                    onChange={(value) => {
                      if (!kind) return;
                      const part = value as GpuPart;
                      if (part === "none" && cpuSibling) {
                        pick({ gpu: false });
                        return;
                      }
                      const next = { ...gpuByKind, [kind.id]: part };
                      setGpuByKind(next);
                      remember(`${pluginId}:${machine ? "new-machine" : "new-box"}`, { kind: kind.id, size, gpu: next, ...(Object.keys(edited).length ? { custom: edited } : {}) });
                      setProblem(null);
                    }}
                  />
                  <p data-gpu-line data-gpu-state={gpuLine?.state} aria-live="polite" className={cn(GPU_LINE_CLASS, gpuLine?.state === "refused" || gpuLine?.state === "failed" ? "text-warning-text" : "text-muted-foreground")}>
                    {gpuLine?.words}
                  </p>
                  {gpuLine?.state === "failed" ? (
                    <button type="button" className="text-xs text-foreground underline underline-offset-2" onClick={() => setCardTry((tryAgain) => tryAgain + 1)}>
                      Retry
                    </button>
                  ) : null}
                </div>
              ) : gpuChoice ? (
                // A GPU is a resource: a dim sub-label of its own line under the presets, then the menu (the operator's note of 2 October 2026).
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">GPU</p>
                  <MenuSelect
                    label="GPU"
                    value={picked.gpu ? "1" : "0"}
                    options={[
                      { value: "0", label: "None" },
                      { value: "1", label: "1 GPU" },
                    ]}
                    onChange={(value) => pick({ gpu: value === "1" })}
                  />
                  {gpuFull ? <p className="text-xs text-muted-foreground">{gpuFull}</p> : null}
                </div>
              ) : null}
              {cardReach ? <p className="text-xs text-muted-foreground">{cardReach}</p> : null}
            </FormSection>
          ) : null}
          <FormSection title="Provider" description="Where the box goes: the first with room for it, in this order, unless you choose one.">
            {/* The filters: a row of their own under the description, at the left, "Filter" at the menus' text size, wrapping on a narrow pane (the operator's notes of 2 October 2026). */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2" role="group" aria-label="Filter">
              <span className="text-xs text-muted-foreground">Filter</span>
              <MenuSelect
                label="Kind"
                labelInside
                value={filter}
                options={kindOptions}
                onChange={(value) => {
                  setFilter(value as FormFilter);
                  setOn(null);
                }}
              />
              {filter !== "physical" ? (
                <MenuSelect
                  label="Runs on"
                  labelInside
                  value={effectiveRunsOn}
                  options={runsOnChoiceList}
                  onChange={(value) => {
                    setRunsOn(value as RunsOn);
                    setOn(null);
                  }}
                />
              ) : null}
            </div>
            <div role="radiogroup" aria-label="Provider" className="space-y-2" onKeyDown={(event) => arrows(event, providerValues.length, providerIndex, (position) => { setOn(providerValues[position] ?? null); providerOptions.current[position]?.focus(); })}>
              {!choiceless && shown.length ? (
                <button
                  ref={(element) => {
                    providerOptions.current[0] = element;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={onOffer === null}
                  tabIndex={onOffer === null ? 0 : -1}
                  onClick={() => setOn(null)}
                  className={rowClass(onOffer === null)}
                >
                  <span className="block text-xs text-foreground">First with room</span>
                  <span className="mt-0.5 block text-2xs text-muted-foreground">{takers.length === 0 ? "None below can take it now" : takers.length === 1 ? "The one below" : `Any of the ${takers.length} below, in order`}</span>
                </button>
              ) : null}
              {shown.map((offer, index) => (
                <ProviderRow
                  key={offer.backend}
                  offer={offer}
                  among={offers}
                  ready={readyOn(offer)}
                  selected={onOffer?.backend === offer.backend}
                  unavailable={(cardMenu ? gpuRowReason(forGpu(offer), chosenGpu) : null) ?? blockedWhy(offer)}
                  onClick={() => setOn(offer.backend)}
                  optionRef={(element) => {
                    providerOptions.current[index + (choiceless ? 0 : 1)] = element;
                  }}
                  info={profile ? <ProviderInfo offer={offer} among={offers} loaded={profiles.get(offer.backend)} load={() => loadProfile(offer.backend)} /> : undefined}
                />
              ))}
            </div>
          </FormSection>
          {machine ? (
            <FormSection title="Name">
              <Input
                id="new-machine-name"
                aria-label="Name"
                aria-describedby="new-machine-name-hint"
                placeholder="Optional: bb-box picks a name like calm-tundra"
                className="h-7 px-2 text-xs"
                value={name}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={nameWrong !== null || undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setProblem(null);
                }}
              />
              <span id="new-machine-name-hint" className="sr-only">
                Optional. If left empty, bb-box picks a name.
              </span>
              {nameWrong ? (
                <p role="alert" className="text-2xs leading-snug text-destructive-text">
                  {nameWrong}
                </p>
              ) : null}
            </FormSection>
          ) : null}
          {access ? (
            <p role="note" className="border-t border-border pt-4 text-xs leading-snug text-warning-text">
              Boxes will not join BB yet. <JoinHelp words={access.message} />
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3 pt-1">
            {standing ? (
              <p role={problem ? "alert" : undefined} className={cn("min-w-0 text-xs leading-snug", problem ? "text-destructive-text" : "text-muted-foreground")}>
                {standing}
              </p>
            ) : askForImage && wanted.os === "linux" ? (
              // A project without a box image (049): one dim link in the footer's free slot, in as few words as the form's other
              // optional bits (the operator's note of 3 October 2026); the standing text takes the slot when there is one.
              <button
                type="button"
                className="min-w-0 truncate text-left text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => {
                  setOpen(false);
                  askForImage();
                }}
              >
                Make a box image for this project
              </button>
            ) : (
              <span />
            )}
            <Button type="submit" size="sm" className="shrink-0 font-normal" disabled={!kind || making || noMatch || (size === CUSTOM && !custom) || nameWrong !== null || gpuLine?.blocked === true}>
              {making ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
              {machine && !primary ? (buildsFirst ? "Build and add" : "Add machine") : buildsFirst ? "Build and create" : "Create box"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
