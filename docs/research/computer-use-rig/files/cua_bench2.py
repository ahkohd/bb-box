#!/usr/bin/env python3
"""Second cua-driver bench: fresh snapshots, token lifetime, pixel clicks.

Usage: cua_bench2.py <cua-driver path> <background|foreground>
Assumes Chrome shows http://127.0.0.1:8000/ freshly loaded and Thunar is open.
"""
import base64, io, json, os, re, subprocess, sys, time
from PIL import Image

DRIVER, MODE = sys.argv[1], sys.argv[2]
OUT = "/tmp/cua-bench2"
os.makedirs(OUT, exist_ok=True)
D = {"delivery_mode": MODE}


class Client:
    def __init__(self):
        self.p = subprocess.Popen([DRIVER, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.seq = 0
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "rig", "version": "0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def rpc(self, method, params):
        self.seq += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        while True:
            m = json.loads(self.p.stdout.readline())
            if m.get("id") == self.seq:
                return m

    def call(self, name, args, label):
        s = time.monotonic()
        m = self.rpc("tools/call", {"name": name, "arguments": args})
        ms = round((time.monotonic() - s) * 1000)
        res = m.get("result") or {}
        text = "".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        img = None
        for c in res.get("content", []):
            if c.get("type") == "image":
                img = Image.open(io.BytesIO(base64.b64decode(c["data"]))).convert("RGB")
                img.save(f"{OUT}/{label}.png")
        err = bool(res.get("isError")) or "error" in m
        return {"step": label, "ms": ms, "error": err, "head": text[:200].replace("\n", " | ")}, \
            res.get("structuredContent") or {}, img

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True).stdout


def mouse():
    d = dict(l.split("=") for l in sh("xdotool", "getmouselocation", "--shell").split())
    return int(d["X"]), int(d["Y"])


def log(r, **kw):
    r.update(kw)
    print(json.dumps(r), flush=True)


def find(els, label, role=None):
    for e in els:
        if e.get("label") == label and (role is None or e.get("role") == role):
            return e
    raise KeyError(label)


def text_of(els, prefix):
    return [e.get("label") or e.get("value") for e in els if (e.get("label") or e.get("value") or "").startswith(prefix)]


c = Client()
_, _, _ = c.call("list_windows", {}, "list")
text = c.rpc("tools/call", {"name": "list_windows", "arguments": {}})["result"]["content"][0]["text"]
m = re.search(r'window_id=(\d+) pid=(\d+) "Rig app - Google Chrome"', text)
W = {"pid": int(m.group(2)), "window_id": int(m.group(1))}
t = re.search(r'window_id=(\d+) pid=(\d+) "agent - Thunar"', text)
T = {"pid": int(t.group(2)), "window_id": int(t.group(1))} if t else None


def snap(label, shot=False, **kw):
    r, sc, img = c.call("get_window_state", {**W, "include_screenshot": shot, **kw}, label)
    return r, sc, img


sh("xdotool", "mousemove", "1700", "300")

# 1. One snapshot, several actions on its tokens with no new snapshot between.
r, s1, _ = snap("snap1")
log(r, snapshot=s1.get("snapshot_id"))
m0 = mouse()
r, _, _ = c.call("click", {**W, "element_token": find(s1["elements"], "Full name", "entry")["element_token"], **D}, "click-name")
log(r, mouse_before=m0, mouse_after=mouse())
r, _, _ = c.call("type_text", {**W, "text": "Ada Lovelace", **D}, "type-name")
log(r, mouse_after=mouse())
r, _, _ = c.call("click", {**W, "element_token": find(s1["elements"], "Pro")["element_token"], **D}, "click-radio-same-snapshot")
log(r, mouse_after=mouse())
r, _, _ = c.call("click", {**W, "element_token": find(s1["elements"], "Email", "entry")["element_token"], **D}, "click-email-same-snapshot")
log(r)
r, _, _ = c.call("type_text", {**W, "text": "ada@example.org", **D}, "type-email")
log(r)

# 2. Does a desktop capture or another window's snapshot invalidate s1 tokens?
r, _, _ = c.call("get_desktop_state", {"max_image_dimension": 1280}, "desktop-shot")
log(r)
r, _, _ = c.call("click", {**W, "element_token": find(s1["elements"], "Send me news")["element_token"], **D}, "click-check-after-desktop-shot")
log(r)
if T:
    r, _, _ = c.call("get_window_state", {**T, "include_screenshot": False}, "thunar-snap")
    log(r)
    r, _, _ = c.call("click", {**W, "element_token": find(s1["elements"], "Done: Task 2")["element_token"], **D}, "click-task2-after-other-window-snap")
    log(r)

# 3. Notes, keys, submit on a fresh snapshot.
r, s2, _ = snap("snap2")
r, _, _ = c.call("click", {**W, "element_token": find(s2["elements"], "Notes", "entry")["element_token"], **D}, "click-notes")
log(r)
r, _, _ = c.call("type_text", {**W, "text": "line one", **D}, "type-notes")
log(r)
r, _, _ = c.call("hotkey", {**W, "keys": ["ctrl", "a"], **D}, "hotkey-ctrl-a")
log(r)
r, _, _ = c.call("type_text", {**W, "text": "replaced", **D}, "type-replace")
log(r)
r, _, _ = c.call("click", {**W, "element_token": find(s2["elements"], "Create account")["element_token"], **D}, "click-submit")
log(r, mouse_after=mouse())
time.sleep(0.3)
r, s3, _ = snap("snap3")
f = {e.get("label"): e.get("value") for e in s3["elements"] if e.get("role") == "entry"}
log(r, name=f.get("Full name"), email=f.get("Email"), notes=f.get("Notes"), status=text_of(s3["elements"], "Saved")[:1],
    done=text_of(s3["elements"], "1 done") + text_of(s3["elements"], "0 done"))

# 4. Stale token after a DOM change: delete Task 1 via s3, then use s3's token for Task 3.
r, _, _ = c.call("click", {**W, "element_token": find(s3["elements"], "Delete Task 1")["element_token"], **D}, "delete1")
log(r)
r, _, _ = c.call("click", {**W, "element_token": find(s3["elements"], "Delete Task 3")["element_token"], **D}, "delete3-after-dom-change")
log(r)
r, s4, _ = snap("snap4", query="Delete Task")
log(r, first=[e.get("label") for e in s4.get("elements", []) if (e.get("label") or "").startswith("Delete Task")][:3])

# 5. Scroll the page with pixels, then click canvas targets found in the screenshot.
r, s5, img = snap("shot-before-scroll", shot=True)
scale = s5.get("frame_scale") or 1
wb = s5["window_bounds"]
r, _, _ = c.call("scroll", {**W, "x": 600, "y": 500, "direction": "down", "amount": 15, "by": "line", **D}, "scroll-pixels")
log(r, mouse_after=mouse())
time.sleep(0.5)
r, s6, img = snap("shot-after-scroll", shot=True)
canvas = next(e for e in s6["elements"] if e.get("role") == "canvas")
log(r, canvas_frame=canvas["frame"], scale=s6.get("frame_scale"), shot=img.size if img else None)
# Blue target squares (#0066cc) in screenshot pixels.
px = img.load()
blue = [(x, y) for y in range(0, img.size[1], 2) for x in range(0, img.size[0], 2)
        if abs(px[x, y][0] - 0) < 30 and abs(px[x, y][1] - 0x66) < 30 and abs(px[x, y][2] - 0xcc) < 30]
clusters = []
for x, y in blue:
    for cl in clusters:
        if abs(cl[0] - x) < 30 and abs(cl[1] - y) < 30:
            cl[2].append((x, y)); break
    else:
        clusters.append([x, y, [(x, y)]])
targets = sorted((round(sum(p[0] for p in cl[2]) / len(cl[2])), round(sum(p[1] for p in cl[2]) / len(cl[2])))
                 for cl in clusters if len(cl[2]) > 20)
log({"step": "targets-in-screenshot"}, targets=targets)
for i, (x, y) in enumerate(targets[:3]):
    snap(f"shot-before-click{i}", shot=True)
    m0 = mouse()
    r, _, _ = c.call("click", {**W, "x": x, "y": y, **D}, f"click-target{i}")
    time.sleep(0.2)
    _, sq, _ = snap(f"last{i}", query="Last click")
    log(r, target_px=(x, y), mouse_before=m0, mouse_after=mouse(), last=text_of(sq.get("elements", []), "Last click")[:1])
# The same target using the canvas element frame (canvas px 100,100).
fx, fy = canvas["frame"]["x"] + 1 + 100, canvas["frame"]["y"] + 1 + 100
snap("shot-before-frame-click", shot=True)
r, _, _ = c.call("click", {**W, "x": fx, "y": fy, **D}, "click-by-frame")
time.sleep(0.2)
_, sq, _ = snap("last-frame", query="Last click")
log(r, target_px=(fx, fy), last=text_of(sq.get("elements", []), "Last click")[:1])
c.close()
log({"step": "done"}, mouse_final=mouse())
