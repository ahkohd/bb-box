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
    const terminal = scene?.terminal ?? {};
    setTimeout(() => {
      if (terminal.fail) {
        this.readyState = 3;
        this.onclose?.({ code: 1011, reason: terminal.fail });
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
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

// The fake runtime: the slots the bundle reads, and enough of the SDK.
let scene = null;
const slots = { threadPanelActions: [], navPanels: [], settingsSections: [] };
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
  useRpc: () => ({ call: async (method, input) => structuredClone(await scene.rpc[method](input)) }),
  useRealtime() {},
  useRealtimeConnectionState: () => "connected",
  useBbNavigate: () => ({ openThreadPanel: log("openThreadPanel"), openUrl: log("openUrl"), toThread: log("toThread"), toPluginPanel: log("toPluginPanel") }),
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
frame.style.width = `${scene.width ?? 560}px`;
if (scene.height) frame.style.height = `${scene.height}px`;
frame.style.display = "flex";
frame.style.flexDirection = "column";
root.style.flex = "1";
root.style.minHeight = "0";
chrome.innerHTML = scene.chrome ?? "";
if (!scene.chrome) chrome.remove();

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
