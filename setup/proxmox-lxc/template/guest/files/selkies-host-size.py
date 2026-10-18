# bb-box: patches Selkies 2.0.0 so that, capturing a host compositor
# (--wayland-host-display), it streams Sway's output at Sway's size and never
# resizes it (060). Unpatched, it reads the size from its own compositor's
# screen, which starts at 1024x768, and sizes the host to match: each viewer
# that connected set Sway to 1024x768, undoing bb-box's own sizing (021,
# 048). pixelflux lists only its own outputs, so the size comes from Sway.
# A lone viewer's capture, as the first on a fresh box or after every viewer
# left, starts at Sway's size too: it started at the session's 1024x768, or
# at the size an earlier controller left, and pixelflux sized Sway to that.
#
# usage: python3 selkies-host-size.py <selkies/websockets_mode.py>
# Fails, changing nothing, when Selkies' code is not as expected. Each part
# is applied once, so a Selkies patched by an earlier version gets the rest.
import sys

MARK = "_bb_box_host_output_size"
VIEWER_MARK = "_bb_box_viewer_host_size"
path = sys.argv[1]
source = open(path).read()
host = MARK not in source
viewer = VIEWER_MARK not in source
if not host and not viewer:
    sys.exit(0)

GEOMETRY = """        if IS_WAYLAND:
            module = self._wayland_control_module()
            if module is None:
                return None
            try:
                geom = await asyncio.to_thread(
                    module.get_realized_geometry, wayland_output_id('primary'))"""
FLAG = "IS_WAYLAND = bool(settings.wayland[0])"
VIEWER = """        if 'primary' in self.capture_instances:
            return True
        layout = getattr(self, 'display_layouts', {}).get('primary')
        if layout:
            w, h, x, y = layout['w'], layout['h'], layout['x'], layout['y']
        else:"""
anchors = ([GEOMETRY, FLAG] if host else []) + ([VIEWER] if viewer else [])
for anchor in anchors:
    if source.count(anchor) != 1:
        sys.exit(f"selkies-host-size: {path} does not have the code this patch expects: {anchor.splitlines()[0].strip()}")

if viewer:
    source = source.replace(VIEWER, """        if 'primary' in self.capture_instances:
            return True
        layout = getattr(self, 'display_layouts', {}).get('primary')
        # bb-box: capturing a host compositor, a viewer's capture starts at
        # Sway's size, which a viewer never changes: the session's 1024x768,
        # or a layout an earlier controller left, would size Sway to it
        # (selkies-host-size.py).
        _bb_box_viewer_host_size = None
        if IS_WAYLAND and (getattr(self.cli_args, 'wayland_host_display', '') or '').strip():
            _bb_box_viewer_host_size = await asyncio.to_thread(_bb_box_host_output_size)
        if _bb_box_viewer_host_size is not None:
            w, h = _bb_box_viewer_host_size
            x = y = 0
            if hasattr(self, 'display_layouts'):
                self.display_layouts['primary'] = {'w': w, 'h': h, 'x': x, 'y': y}
        elif layout:
            w, h, x, y = layout['w'], layout['h'], layout['x'], layout['y']
        else:""")
if not host:
    open(path, "w").write(source)
    sys.exit(0)

source = source.replace(GEOMETRY, """        if IS_WAYLAND and (getattr(self.cli_args, 'wayland_host_display', '') or '').strip():
            # bb-box: capturing a host compositor, the desktop is the host's
            # output, whose size Sway keeps (selkies-host-size.py).
            size = await asyncio.to_thread(_bb_box_host_output_size)
            if size is not None:
                return size
""" + GEOMETRY)
source = source.replace(FLAG, FLAG + '''


def _bb_box_host_output_size():
    """bb-box: the host compositor's active output's size in pixels, from Sway."""
    import json, subprocess
    try:
        out = subprocess.run(["swaymsg", "-r", "-t", "get_outputs"], capture_output=True, timeout=5, check=True).stdout
        for output in json.loads(out):
            mode = output.get("current_mode") or {}
            if output.get("active") and mode.get("width") and mode.get("height"):
                return int(mode["width"]), int(mode["height"])
    except Exception:
        return None
    return None''')
open(path, "w").write(source)
