// The build's patch to Selkies 2.0.0 for a Wayland image (060), run with
// python3 against a file with the code it expects from Selkies'
// websockets_mode.py, cut down to the parts it changes and runnable.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const PATCH = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/files/selkies-host-size.py", import.meta.url));

/** Selkies' code as the patch expects it, where it changes it, with what a run of it needs. */
const SELKIES = `import asyncio


class settings:
    wayland = [True]


def wayland_output_id(name):
    return name


IS_WAYLAND = bool(settings.wayland[0])


class Server:
    async def _current_primary_geometry(self):
        if IS_WAYLAND:
            module = self._wayland_control_module()
            if module is None:
                return None
            try:
                geom = await asyncio.to_thread(
                    module.get_realized_geometry, wayland_output_id('primary'))
            except Exception:
                return None
            return geom[0], geom[1]

    async def _ensure_viewer_capture(self) -> bool:
        if 'primary' in self.capture_instances:
            return True
        layout = getattr(self, 'display_layouts', {}).get('primary')
        if layout:
            w, h, x, y = layout['w'], layout['h'], layout['x'], layout['y']
        else:
            w, h = self.app.display_width, self.app.display_height
            x = y = 0
        return w, h, x, y
`;

/** Runs a patched file's viewer capture and geometry read, with Sway's output at 1920x1080, as `swaymsg` on PATH says. */
const RUN = `import asyncio, importlib.util, sys, types
spec = importlib.util.spec_from_file_location("ws", sys.argv[1])
ws = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ws)
server = ws.Server()
server.cli_args = types.SimpleNamespace(wayland_host_display=sys.argv[2])
server.capture_instances = {}
server.display_layouts = {"primary": {"w": 1840, "h": 800, "x": 0, "y": 0}} if sys.argv[3] == "layout" else {}
server.app = types.SimpleNamespace(display_width=1024, display_height=768)
module = types.SimpleNamespace(get_realized_geometry=lambda output: (1024, 768, 1.0))
server._wayland_control_module = lambda: module
print(asyncio.run(server._ensure_viewer_capture()), asyncio.run(server._current_primary_geometry()), server.display_layouts.get("primary"))
`;

const python = spawnSync("python3", ["--version"]).status === 0;

function patched(dir: string, source: string): { status: number | null; stderr: string; text: string } {
  const file = join(dir, "websockets_mode.py");
  writeFileSync(file, source);
  const run = spawnSync("python3", [PATCH, file], { encoding: "utf8" });
  return { status: run.status, stderr: run.stderr, text: readFileSync(file, "utf8") };
}

test("a patched Selkies captures Sway at Sway's size for a lone viewer, as for a controller, not its own 1024x768 or an earlier layout; once only, and not code it does not know (060)", { skip: !python }, () => {
  const dir = tempDir("selkies-host-size");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "swaymsg"), `#!/bin/sh\necho '[{"name": "HEADLESS-1", "active": true, "current_mode": {"width": 1920, "height": 1080}}]'\n`);
  chmodSync(join(bin, "swaymsg"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  writeFileSync(join(dir, "run.py"), RUN);
  const run = (file: string, host: string, layout: "layout" | "none") => spawnSync("python3", [join(dir, "run.py"), file, host, layout], { encoding: "utf8", env }).stdout.trim();

  const whole = patched(dir, SELKIES);
  assert.equal(whole.status, 0, whole.stderr);
  const file = join(dir, "websockets_mode.py");
  // A viewer's capture starts at Sway's size, whatever layout an earlier controller left; so does a controller's.
  assert.equal(run(file, "wayland-1", "layout"), "(1920, 1080, 0, 0) (1920, 1080) {'w': 1920, 'h': 1080, 'x': 0, 'y': 0}");
  assert.equal(run(file, "wayland-1", "none"), "(1920, 1080, 0, 0) (1920, 1080) {'w': 1920, 'h': 1080, 'x': 0, 'y': 0}");
  // Selkies' own compositor, with no host to capture, is as it was.
  assert.equal(run(file, "", "layout"), "(1840, 800, 0, 0) (1024, 768) {'w': 1840, 'h': 800, 'x': 0, 'y': 0}");
  assert.equal(run(file, "", "none"), "(1024, 768, 0, 0) (1024, 768) None");

  // Patched again, it is unchanged.
  assert.equal(spawnSync("python3", [PATCH, file]).status, 0);
  assert.equal(readFileSync(file, "utf8"), whole.text);

  // A Selkies patched before the viewer's part gets that part alone.
  const start = whole.text.indexOf("        # bb-box: capturing a host compositor, a viewer's");
  const end = whole.text.indexOf("        elif layout:");
  const earlier = whole.text.slice(0, start) + "        if layout:" + whole.text.slice(end + "        elif layout:".length);
  assert.ok(earlier.includes("_bb_box_host_output_size") && !earlier.includes("_bb_box_viewer_host_size"));
  assert.equal(patched(dir, earlier).text, whole.text);

  // Code it does not expect fails the build and is left as it was.
  const other = SELKIES.replace("        if layout:\n", "        if layout and True:\n");
  const refused = patched(dir, other);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /does not have the code this patch expects: if 'primary' in self.capture_instances:/);
  assert.equal(refused.text, other);
});
