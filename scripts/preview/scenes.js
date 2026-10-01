// The scenes the preview renders: fixtures for each slot and state.

export const THREAD = "thr_preview";
const DESKTOP_PATH = "/api/v1/plugins/bb-box/http/desktop";
const now = Date.now();

function box(overrides = {}) {
  return {
    id: "box_1",
    name: "calm-otter",
    kind: "linux",
    kindLabel: "Linux",
    backendLabel: "Proxmox LXC on pve",
    nature: "virtual",
    role: "box",
    state: "ready",
    error: null,
    createdAt: now - 12 * 60_000,
    readyAt: now - 12 * 60_000 + 2200,
    os: "linux",
    arch: "x86_64",
    gpu: false,
    requires: [],
    extras: ["docker"],
    desktop: false,
    display: null,
    control: null,
    computerUse: false,
    address: "10.200.0.12",
    facts: [{ label: "Template", value: "9100" }],
    timings: { clone: 750, start: 1000, ssh: 450, total: 2200, enrol: 5300 },
    enrol: { state: "enrolled", hostId: "host_1", error: null },
    canStopStart: true,
    size: "2 cores, 4 GiB memory",
    ...overrides,
  };
}

const desktop = box({
  id: "box_2",
  name: "bold-heron",
  kind: "linux-desktop",
  kindLabel: "Linux desktop",
  desktop: true,
  gpu: true,
  display: { protocol: "rfb", resizable: true },
  control: { owner: "agent", holder: null },
  computerUse: true,
  address: "10.200.0.14",
  size: "4 cores, 8 GiB memory, 32 GiB disk",
  facts: [
    { label: "GPU", value: "GPU-0a1b2c3d" },
    { label: "Display mode", value: "gpu" },
    { label: "Template", value: "9101" },
  ],
});
const starting = box({ id: "box_3", name: "quiet-fern", state: "acquiring", createdAt: now - 1400, address: null, facts: [], timings: {}, enrol: { state: "off", hostId: null, error: null } });
const stopped = box({ id: "box_4", name: "wild-cove", kind: "linux-docker", kindLabel: "Linux with Docker", state: "stopped", size: "8 cores, 16 GiB memory, 64 GiB disk" });
const failed = box({
  id: "box_5",
  name: "brisk-elm",
  kind: "linux-desktop",
  kindLabel: "Linux desktop",
  desktop: true,
  gpu: true,
  state: "failed",
  error: "No GPU is left: GPU-0a1b has 3 desktops and GPU-7c2d fell back to the CPU. Try a Linux desktop (no GPU).",
  address: null,
  facts: [],
  timings: {},
  enrol: { state: "off", hostId: null, error: null },
});
const gone = box({ id: "box_6", name: "soft-reed", state: "gone", enrol: { state: "off", hostId: null, error: null } });
const refused = box({ id: "box_7", name: "quiet-fern", error: "Stopping the box failed: the host did not answer.", enrol: { state: "failed", hostId: null, error: "BB did not answer within 10 s." } });

function size(cores, memoryGiB, diskGiB = null) {
  return { cores, memoryGiB, diskGiB, words: `${cores} cores, ${memoryGiB} GiB memory${diskGiB === null ? "" : `, ${diskGiB} GiB disk`}` };
}

function kind(id, label, description, cores, desktop, gpu) {
  return {
    id,
    label,
    description,
    size: size(cores, cores * 2).words,
    presets: [
      { name: "small", ...size(cores, cores * 2) },
      { name: "medium", ...size(cores * 2, cores * 4) },
      { name: "large", ...size(cores * 4, cores * 8) },
    ],
    defaultPreset: "small",
    largest: size(cores * 8, cores * 16, 256),
    gpu,
    desktop,
    backends: ["Proxmox LXC on pve"],
  };
}

export const KINDS = [
  kind("linux", "Linux", "A Linux box for builds, servers, Docker and the agent's own work.", 2, false, false),
  kind("linux-desktop", "Linux desktop", "A Linux desktop on the host's GPU, for computer use, browsers and app development.", 4, true, true),
  kind("linux-desktop-cpu", "Linux desktop (no GPU)", "A Linux desktop drawn by the CPU. Graphics are slower; nothing else changes.", 4, true, false),
];

const BACKENDS = [
  { type: "proxmox-lxc", label: "Proxmox LXC", nature: "virtual", state: "active", problems: [], setup: { guide: "setup/proxmox-lxc/README.md", scripts: ["setup/proxmox-lxc/host/setup-host.sh", "setup/proxmox-lxc/host/setup-network.sh", "setup/proxmox-lxc/host/setup-token.sh", "setup/proxmox-lxc/template/build.sh"] } },
  { type: "docker", label: "Docker", nature: "virtual", state: "misconfigured", problems: ["Set the Docker host.", "Set the image for Linux boxes."], setup: { guide: "setup/docker/README.md", scripts: ["setup/docker/build.sh"] } },
  { type: "ssh-pool", label: "SSH host pool", nature: "real", state: "off", problems: [], setup: { guide: "setup/ssh-pool/README.md", scripts: [] } },
];

const DOCTOR = {
  ok: false,
  sections: [
    {
      title: "Proxmox LXC",
      report: {
        ok: false,
        summary: "Proxmox VE 9.2 on pve",
        checks: [
          { id: "proxmox.api", name: "Proxmox API", status: "ok", detail: "Proxmox VE 9.2 on pve.", fix: null },
          { id: "proxmox.token", name: "Token rights", status: "ok", detail: "VM.Allocate, VM.Clone, VM.Config.*, VM.PowerMgmt on /pool/bbbox.", fix: null },
          { id: "template.9101", name: "Template 9101", status: "fail", detail: "has no build tag, so warm boxes cannot be checked against it.", fix: "Run build.sh desktop again; it tags the template." },
          { id: "memory", name: "Memory", status: "warn", detail: "pve has 6 GiB free; 4 GiB is kept back, so one Linux box fits.", fix: "Release a box, or lower the memory kept free." },
          { id: "ssh", name: "SSH into a box", status: "skipped", detail: "skipped, since a template check failed.", fix: null },
        ],
        notes: ["Install this public key in the templates:\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB0Zk3Y7XkG0rvmP2tq1u8jq2QwKxH1tO6V6bFm5wQ4a bb-box"],
      },
    },
    { title: "Docker", report: { ok: false, summary: "Its settings need fixing.", checks: [{ id: "settings.0", name: "Settings", status: "fail", detail: "Set the Docker host.", fix: "Fix it in bb-box's settings." }], notes: [] } },
  ],
};

function rpc(boxes, options = {}) {
  const find = (ref) => boxes.find((candidate) => candidate.id === ref) ?? null;
  return {
    state: () => ({ boxes, kinds: options.kinds ?? KINDS, backends: BACKENDS, desktopPath: DESKTOP_PATH }),
    desktop: ({ box: ref }) => ({ box: find(ref), desktopPath: DESKTOP_PATH }),
    desktops: () => boxes.filter((candidate) => candidate.desktop).map((candidate) => ({ threadId: THREAD, box: candidate })),
    acquire: () => ({ box: null, error: options.refuse ?? null }),
    release: ({ box: ref }) => ({ box: find(ref), error: null }),
    stop: ({ box: ref }) => ({ box: find(ref), error: null }),
    start: ({ box: ref }) => ({ box: find(ref), error: null }),
    refresh: ({ box: ref }) => ({ box: find(ref), error: null }),
    takeControl: ({ box: ref }) => ({ box: find(ref), error: null }),
    handBack: ({ box: ref }) => ({ box: find(ref), error: null }),
    backends: () => BACKENDS,
    doctor: () => DOCTOR,
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const click = (root, role, name) => {
  const element = [...root.querySelectorAll(`[role="${role}"], button, a`)].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent.trim()) === name && (role === "*" || candidate.getAttribute("role") === role || candidate.tagName.toLowerCase() === role));
  if (!element) throw new Error(`No ${role} "${name}"`);
  element.click();
  return element;
};
const openMenu = (root, name) => {
  const trigger = [...root.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === name);
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
};

const boxesChrome = `<span class="pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M3.8 7.2 12 11.8l8.2-4.6M12 11.8v9.5"/></svg>Boxes</span><span>+</span>`;
const desktopChrome = (name) => `<span>Boxes</span><span class="pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M3.8 7.2 12 11.8l8.2-4.6M12 11.8v9.5"/></svg>${name}</span><span>+</span>`;

export const scenes = {
  "panel-empty": { slot: "boxes", chrome: boxesChrome, rpc: rpc([]) },
  "panel-nobackend": { slot: "boxes", chrome: boxesChrome, rpc: rpc([], { kinds: [] }) },
  "panel-list": { slot: "boxes", chrome: boxesChrome, rpc: rpc([starting, desktop, stopped]) },
  "panel-list-open": {
    slot: "boxes",
    chrome: boxesChrome,
    rpc: rpc([starting, desktop, stopped]),
    after: (root) => click(root, "button", "bold-heron: details"),
  },
  "panel-problems": { slot: "boxes", chrome: boxesChrome, rpc: rpc([failed, gone, refused]) },
  "panel-chooser": {
    slot: "boxes",
    chrome: boxesChrome,
    height: 520,
    rpc: rpc([]),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
    },
  },
  "panel-chooser-custom": {
    slot: "boxes",
    chrome: boxesChrome,
    height: 560,
    rpc: rpc([]),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
      click(document.body, "radio", "Linux desktopA Linux desktop on the host's GPU, for computer use, browsers and app development.");
      click(document.body, "radio", "Custom");
      await wait(300);
    },
  },
  "panel-refused": {
    slot: "boxes",
    chrome: boxesChrome,
    height: 560,
    rpc: rpc([], { refuse: "pve has 10 GiB of memory free. A Linux desktop box needs 8 GiB and 4 GiB is kept free. Release a box you no longer need, or pick another kind." }),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
      click(document.body, "radio", "Linux desktopA Linux desktop on the host's GPU, for computer use, browsers and app development.");
      click(document.body, "radio", "Large");
      click(document.body, "button", "Make box");
      await wait(300);
    },
  },
  "panel-menu": {
    slot: "boxes",
    chrome: boxesChrome,
    height: 420,
    rpc: rpc([starting, desktop, stopped]),
    after: async (root) => {
      openMenu(root, "bold-heron actions");
      await wait(300);
    },
  },
  "panel-release": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 788,
    height: 460,
    rpc: rpc([starting, desktop, stopped]),
    after: async (root) => {
      openMenu(root, "bold-heron actions");
      await wait(300);
      click(document.body, "menuitem", "Release…");
      await wait(400);
    },
  },
  "desktop-connecting": { slot: "desktop", chrome: desktopChrome("bold-heron"), width: 720, height: 480, props: { threadId: THREAD, params: { box: "box_2" } }, rpc: rpc([desktop]) },
  "desktop-stopped": { slot: "desktop", chrome: desktopChrome("bold-heron"), width: 720, height: 480, props: { threadId: THREAD, params: { box: "box_2" } }, rpc: rpc([{ ...desktop, state: "stopped" }]) },
  "desktop-released": { slot: "desktop", chrome: desktopChrome("bold-heron"), width: 720, height: 480, props: { threadId: THREAD, params: { box: "box_2" } }, rpc: rpc([]) },
  "desktop-chooser": { slot: "desktop", chrome: desktopChrome("Desktop"), width: 560, props: { threadId: THREAD, params: null }, rpc: rpc([desktop, { ...desktop, id: "box_8", name: "wild-cove", kindLabel: "Linux desktop (no GPU)", state: "stopped" }]) },
  "desktops-page": { slot: "desktops", width: 900, props: { subPath: "" }, rpc: rpc([desktop, { ...desktop, id: "box_8", name: "wild-cove", kindLabel: "Linux desktop (no GPU)", state: "stopped" }]), threads: { [THREAD]: "bb-box: UI/UX design and panel" } },
  "settings": { slot: "settings", width: 860, props: {}, rpc: rpc([]) },
  "settings-checked": {
    slot: "settings",
    width: 860,
    props: {},
    rpc: rpc([]),
    after: async (root) => {
      click(root, "button", "Check the backends");
      await wait(400);
    },
  },
};
