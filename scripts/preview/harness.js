// A preview of bb-box's built panels outside BB: the built bundle, BB's
// theme and a fake of the plugin SDK's app runtime with fixtures. Serve the
// repository root and open scripts/preview/index.html#<scene>[&light].
// scripts/preview/shoot.sh renders every scene with headless Chrome.

const REACT = "19.2.0";
const deps = `deps=react@${REACT},react-dom@${REACT}`;
const [React, ReactDOMClient, ReactDOM, jsxRuntime, radixAlertDialog, radixDropdownMenu, radixPopover, radixTooltip, radixSelect, clsx, tailwindMerge, cva] = await Promise.all([
  import(`https://esm.sh/react@${REACT}`),
  import(`https://esm.sh/react-dom@${REACT}/client?${deps}`),
  import(`https://esm.sh/react-dom@${REACT}?${deps}`),
  import(`https://esm.sh/react@${REACT}/jsx-runtime`),
  import(`https://esm.sh/@radix-ui/react-alert-dialog@1.1.19?${deps}`),
  import(`https://esm.sh/@radix-ui/react-dropdown-menu@2.1.20?${deps}`),
  import(`https://esm.sh/@radix-ui/react-popover@1.1.19?${deps}`),
  import(`https://esm.sh/@radix-ui/react-tooltip@1.2.12?${deps}`),
  import(`https://esm.sh/@radix-ui/react-select@2.3.3?${deps}`),
  import("https://esm.sh/clsx@2.1.1"),
  import("https://esm.sh/tailwind-merge@3.4.0"),
  import("https://esm.sh/class-variance-authority@0.7.1"),
]);
// BB's toaster: the host gives plugins sonner's toast, and mounts one Toaster for the app (AppToaster).
const sonner = await import(`https://esm.sh/sonner@1.7.4?${deps}`);
const h = React.createElement;

// BB's theme: its token blocks apply as they are, and its Tailwind @theme
// blocks become :root rules so the utilities' var(--color-*) resolve.
const THEME_URL = "https://raw.githubusercontent.com/get-bb/bb/desktop-v0.44.0/apps/web/src/components/ui/theme.css";
const themeCss = await fetch(THEME_URL).then((response) => response.text());
// Tailwind's preflight, which BB's app carries and a plugin bundle does not.
const PREFLIGHT_URL = "https://unpkg.com/tailwindcss@4.1.13/preflight.css";
document.getElementById("bb-base").textContent = `@layer base {\n${await fetch(PREFLIGHT_URL).then((response) => response.text())}\n}`;
document.getElementById("bb-theme").textContent = themeCss.replace(/@theme(?:\s+inline)?\s*\{/g, ":root {");

const ICONS = {
  Plus: '<path d="M12 5v14M5 12h14"/>',
  MoreHorizontal: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  Loading: '<path d="M12 3a9 9 0 1 1-6.4 2.6"/>',
  Check: '<path d="m5 12 5 5L20 7"/>',
  Play: '<path d="M7 5v14l11-7z"/>',
  Square: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  Copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  ExternalLink: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/>',
  ArrowReloadHorizontal: '<path d="M4 12a8 8 0 0 1 14-5l2 2M20 4v5h-5M20 12a8 8 0 0 1-14 5l-2-2M4 20v-5h5"/>',
  Trash2: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  Settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  CircleCheck: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  AlertTriangle: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17h.01"/>',
  X: '<path d="M6 6l12 12M18 6 6 18"/>',
  Search: '<path d="M17 17l4 4"/><circle cx="11" cy="11" r="8"/>',
  FilterHorizontal: '<path d="M4 5h6M13 5h7M4 12h12M19 12h1M4 19h3M10 19h10M10 2v6M16 9v6M7 16v6"/>',
  ArrowUpDown: '<path d="M7 4v16M17 19V4M10 7S7.8 4 7 4 4 7 4 7M20 17s-2.2 3-3 3-3-3-3-3"/>',
  ArrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  ArrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  MessageSquarePlus: '<path d="M21 12a9 9 0 0 1-13.5 7.8L3 21l1.2-4.5A9 9 0 1 1 21 12z"/><path d="M15.5 12h-7M12 8.5v7"/>',
  Minus: '<path d="M6 12h12"/>',
  Info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  ArrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  ArrowUpRight: '<path d="M7 17 17 7M8 7h9v9"/>',
  ArrowTurnBackward: '<path d="M20 17v-3a4 4 0 0 0-4-4H5M9 6l-4 4 4 4"/>',
  ChevronDown: '<path d="m6 9 6 6 6-6"/>',
  ChevronRight: '<path d="m9 6 6 6-6 6"/>',
  ChevronUp: '<path d="m6 15 6-6 6 6"/>',
  Zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  Terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
};
// The plugin's own glyphs, as package.json declares them: stroked in BB's style, or filled (the provider marks from Simple Icons).
const assets = {};
for (const name of ["monitor", "server", "terminal", "icon", "laptop", "plug", "proxmox", "docker"]) {
  const svg = await fetch(`/assets/${name}.svg`).then((response) => response.text());
  assets[name] = { body: svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, ""), filled: /<svg[^>]*fill="currentColor"/.test(svg) };
}
function Icon({ name, className, fallback = "Zap", ...rest }) {
  const own = typeof name === "string" && name.startsWith("bb-box/") ? assets[name.slice("bb-box/".length)] : null;
  const body = own?.body ?? ICONS[name] ?? ICONS[fallback] ?? ICONS.Zap;
  return h("svg", {
    ...rest,
    "data-icon-root": "",
    className: `${className ?? ""}`,
    viewBox: "0 0 24 24",
    fill: own?.filled ? "currentColor" : "none",
    stroke: own?.filled ? "none" : "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    dangerouslySetInnerHTML: { __html: body },
  });
}

// A fake terminal socket for the terminal scenes: it opens, prints what the
// scene says, echoes what is typed, and ends when the scene says so.
class FakeTerminalSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.binaryType = "blob";
    // noVNC checks a channel for these before it assigns them, so the desktop scenes need them here too (they rendered nothing without).
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    this.protocol = "";
    const terminal = scene?.terminal ?? {};
    // A video stream (056) can fail on its own, as when a box has no Selkies, while VNC connects.
    const fail = url.includes("stream=selkies") ? terminal.videoFail : terminal.fail;
    setTimeout(() => {
      if (fail) {
        this.readyState = 3;
        this.onclose?.({ code: 1011, reason: fail });
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
      // A video desktop that shows: Selkies' mode, then a key frame, which the fake decoder below turns into the scene's picture.
      if (url.includes("stream=selkies") && terminal.video) {
        this.onmessage?.({ data: "MODE websockets" });
        const frame = new Uint8Array(20);
        frame[0] = 4;
        frame[1] = 0x11;
        frame[3] = 1;
        this.onmessage?.({ data: frame.buffer });
        return;
      }
      const text = terminal.output ?? "";
      this.onmessage?.({ data: new TextEncoder().encode(text).buffer });
      if (terminal.end) {
        setTimeout(() => {
          this.readyState = 3;
          this.onclose?.({ code: 1000, reason: terminal.end });
        }, 150);
      }
    }, 100);
  }
  send(data) {
    if (typeof data === "string") return;
    this.onmessage?.({ data: new Uint8Array(data).buffer });
  }
  close() {
    this.readyState = 3;
  }
}
window.WebSocket = FakeTerminalSocket;

// A decoder for the video scenes: each chunk is a 1280x800 picture of a desktop, so the viewer connects as with a box's video.
class FakeVideoDecoder {
  static async isConfigSupported(config) {
    return { supported: true, config };
  }
  constructor(init) {
    this.output = init.output;
    this.state = "unconfigured";
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk) {
    const picture = document.createElement("canvas");
    picture.width = 1280;
    picture.height = 800;
    const g = picture.getContext("2d");
    g.fillStyle = "#1e2a3a";
    g.fillRect(0, 0, 1280, 800);
    g.fillStyle = "#2b2b2b";
    g.fillRect(0, 0, 1280, 28);
    g.fillStyle = "#f4f4f4";
    g.fillRect(140, 90, 1000, 620);
    g.fillStyle = "#dfe6ef";
    g.fillRect(140, 90, 1000, 40);
    Object.assign(picture, { displayWidth: 1280, displayHeight: 800, timestamp: chunk.timestamp, close() {} });
    this.output(picture);
  }
  close() {
    this.state = "closed";
  }
}
window.VideoDecoder = FakeVideoDecoder;

// The fake runtime: the slots the bundle reads, and enough of the SDK.
let scene = null;
const slots = { threadPanelActions: [], navPanels: [], settingsSections: [] };
const rpcClient = { call: async (method, input) => structuredClone(await scene.rpc[method](input)) };
const pluginSdkApp = {
  definePluginApp(setup) {
    setup({
      // Any slot the app registers that the preview has no scene for is taken and ignored.
      slots: new Proxy(
        {
          threadPanelAction: (registration) => slots.threadPanelActions.push(registration),
          navPanel: (registration) => slots.navPanels.push(registration),
          settingsSection: (registration) => slots.settingsSections.push(registration),
        },
        { get: (known, name) => known[name] ?? (() => {}) },
      ),
      experimental_icons: { register() {} },
    });
    return slots;
  },
  experimental_Icon: Icon,
  experimental_usePluginId: () => "bb-box",
  // One client for every render, as BB's own useRpc gives: a new one each render re-ran every effect that depends on it, as the
  // desktop tab's claim of its session, which reconnected at once whenever its connection ended.
  useRpc: () => rpcClient,
  useRealtime() {},
  useRealtimeConnectionState: () => "connected",
  useBbNavigate: () => ({ openThreadPanel: log("openThreadPanel"), openUrl: log("openUrl"), toThread: log("toThread"), toPluginPanel: log("toPluginPanel"), toCompose: log("toCompose") }),
  useSdk: () => ({ threads: { get: async ({ threadId }) => ({ title: scene.threads?.[threadId] ?? threadId }) } }),
  UrlLink: ({ href, children, ...rest }) => h("a", { href, ...rest }, children),
  useSettings: () => ({ values: {}, isLoading: false }),
  useBbContext: () => ({ projectId: null, threadId: null }),
};
function log(method) {
  return (...args) => {
    console.log(method, ...args);
    return true;
  };
}
globalThis.__bbPluginRuntime = {
  react: React,
  reactDom: ReactDOM,
  reactDomClient: ReactDOMClient,
  jsxRuntime,
  pluginSdkApp,
  radixAlertDialog,
  radixDropdownMenu,
  radixPopover,
  radixTooltip,
  radixSelect,
  clsx,
  tailwindMerge,
  classVarianceAuthority: cva,
  sonner,
};

await import("/dist/app.js");
const { scenes, THREAD } = await import("./scenes.js");

const [name = "panel-list", theme = "dark"] = location.hash.slice(1).split("&");
scene = scenes[name];
if (!scene) throw new Error(`No scene ${name}. Scenes: ${Object.keys(scenes).join(", ")}`);
document.documentElement.classList.toggle("dark", theme !== "light");
document.documentElement.classList.toggle("light", theme === "light");

const frame = document.getElementById("frame");
const chrome = document.getElementById("chrome");
const root = document.getElementById("root");
window.__scene = scene;
// Every scene starts from empty browser storage: the screenshots share one Chrome profile, and the New box form remembers its last choice there.
try {
  window.localStorage.clear();
} catch {}
frame.style.width = `${scene.width ?? 560}px`;
if (scene.height) frame.style.height = `${scene.height}px`;
frame.style.display = "flex";
frame.style.flexDirection = "column";
root.style.flex = "1";
root.style.minHeight = "0";
chrome.innerHTML = scene.chrome ?? "";
if (!scene.chrome && !(scene.slot === "boxes-page")) chrome.remove();

// The cross-thread Boxes page is slot "boxes-page"; the per-thread Box panel is
// the thread-panel action whose id is "boxes" (BOXES_ACTION), so a "boxes" scene
// falls through to it. Keeping them apart stops the page from eating panel scenes.
const slot =
  scene.slot === "settings"
    ? slots.settingsSections[0]
    : scene.slot === "boxes-page"
      ? slots.navPanels[0]
      : slots.threadPanelActions.find((action) => action.id === scene.slot);
root.className = slot.layout === "flush" ? "flush" : scene.slot === "boxes-page" ? "" : "padded";
// BB's title bar over a nav page, as PluginPanelHeader draws it: the icon and title on the left, the panel's
// headerContent on the right, then BB's own buttons (two dim placeholders here).
if (scene.slot === "boxes-page") {
  chrome.className = "titlebar";
  chrome.innerHTML = `<span class="title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M3.8 7.2 12 11.8l8.2-4.6M12 11.8v9.5"/></svg>${slot.title}</span><span class="spacer"></span><span class="header-content" data-bb-plugin="bb-box"></span><span class="bb-button">×</span><span class="bb-button">▢</span>`;
  if (slot.headerContent) ReactDOMClient.createRoot(chrome.querySelector(".header-content")).render(h(slot.headerContent, { subPath: scene.props?.subPath ?? "" }));
}
// BB's Toaster, as AppToaster mounts it: at the bottom right, in BB's theme. Inside the frame, which holds fixed elements, so a
// toast shows where BB's would over a panel on the right of its window.
if (scene.toaster) {
  frame.style.transform = "translateZ(0)";
  const toaster = document.createElement("div");
  frame.appendChild(toaster);
  ReactDOMClient.createRoot(toaster).render(h(sonner.Toaster, { theme: theme === "light" ? "light" : "dark", position: "bottom-right" }));
}
const reactRoot = ReactDOMClient.createRoot(root);
reactRoot.render(h(slot.component, scene.props ?? { threadId: THREAD, params: null }));
await new Promise((resolve) => setTimeout(resolve, 300));
try {
  if (scene.after) await scene.after(root);
} catch (error) {
  document.documentElement.dataset.error = String(error);
  throw error;
}
await new Promise((resolve) => setTimeout(resolve, 400));
document.documentElement.dataset.ready = "1";
