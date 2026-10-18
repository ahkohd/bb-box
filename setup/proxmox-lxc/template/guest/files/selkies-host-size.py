# bb-box: patches Selkies 2.0.0 so that, capturing a host compositor
# (--wayland-host-display), it streams Sway's output at Sway's size and never
# resizes it (060). Unpatched, it reads the size from its own compositor's
# screen, which starts at 1024x768, and sizes the host to match: each viewer
# that connected set Sway to 1024x768, undoing bb-box's own sizing (021,
# 048). pixelflux lists only its own outputs, so the size comes from Sway.
#
# usage: python3 selkies-host-size.py <selkies/websockets_mode.py>
# Fails, changing nothing, when Selkies' code is not as expected.
import sys

MARK = "_bb_box_host_output_size"
path = sys.argv[1]
source = open(path).read()
if MARK in source:
    sys.exit(0)

GEOMETRY = """        if IS_WAYLAND:
            module = self._wayland_control_module()
            if module is None:
                return None
            try:
                geom = await asyncio.to_thread(
                    module.get_realized_geometry, wayland_output_id('primary'))"""
FLAG = "IS_WAYLAND = bool(settings.wayland[0])"
for anchor in (GEOMETRY, FLAG):
    if source.count(anchor) != 1:
        sys.exit(f"selkies-host-size: {path} does not have the code this patch expects: {anchor.splitlines()[0].strip()}")

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
