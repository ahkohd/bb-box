#!/usr/bin/env python3
"""Benchmark cua-driver against the rig page in Chrome.

Usage: cua_bench.py <cua-driver path> [extra-json-args-for-actions]
Assumes Chrome shows http://127.0.0.1:8000/ freshly loaded.
"""
import base64, io, json, os, re, subprocess, sys, time
from PIL import Image

DRIVER = sys.argv[1]
EXTRA = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
OUT = "/tmp/cua-bench"
os.makedirs(OUT, exist_ok=True)


class Client:
    def __init__(self):
        t = time.monotonic()
        self.p = subprocess.Popen([DRIVER, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.seq = 0
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "rig", "version": "0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()
        self.start_ms = round((time.monotonic() - t) * 1000)

    def rpc(self, method, params):
        self.seq += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        while True:
            m = json.loads(self.p.stdout.readline())
            if m.get("id") == self.seq:
                return m

    def call(self, name, args, label=None):
        s = time.monotonic()
        m = self.rpc("tools/call", {"name": name, "arguments": args})
        ms = round((time.monotonic() - s) * 1000)
        res = m.get("result") or {}
        text = "".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        imgs = []
        for c in res.get("content", []):
            if c.get("type") == "image":
                raw = base64.b64decode(c["data"])
                im = Image.open(io.BytesIO(raw))
                path = f"{OUT}/{label or name}-{self.seq}.{im.format.lower()}"
                open(path, "wb").write(raw)
                imgs.append({"bytes": len(raw), "size": im.size, "fmt": im.format, "path": path})
        err = bool(res.get("isError")) or "error" in m
        r = {"tool": label or name, "ms": ms, "error": err, "text_chars": len(text), "images": imgs,
             "head": text[:220].replace("\n", " | ") if text else json.dumps(m.get("error"))[:220]}
        return r, res.get("structuredContent") or {}, text

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)


def mouse():
    o = subprocess.run(["xdotool", "getmouselocation", "--shell"], capture_output=True, text=True).stdout
    d = dict(l.split("=") for l in o.split())
    return int(d["X"]), int(d["Y"])


def log(r, **kw):
    r.update(kw)
    print(json.dumps(r), flush=True)


def find(els, label, role=None):
    for e in els:
        if e.get("label") == label and (role is None or e.get("role") == role):
            return e
    raise KeyError(label)


subprocess.run(["xdotool", "mousemove", "1700", "300"])
c = Client()
log({"tool": "initialize", "ms": c.start_ms})
r, sc, text = c.call("list_windows", {})
m = re.search(r'window_id=(\d+) pid=(\d+) "Rig app - Google Chrome"', text)
wid, pid = int(m.group(1)), int(m.group(2))
log(r, window_id=wid, pid=pid)
W = {"pid": pid, "window_id": wid}

# Tree only, three times.
for i in range(3):
    r, sc, text = c.call("get_window_state", {**W, "include_screenshot": False}, f"tree{i}")
    log(r, elements=sc.get("element_count"), structured_chars=len(json.dumps(sc)),
        markdown_chars=len(sc.get("tree_markdown", "")), snapshot=sc.get("snapshot_id"))
els1 = sc["elements"]
snap1 = sc["snapshot_id"]
json.dump(sc, open(f"{OUT}/tree.json", "w"))

# Tree with window screenshot.
r, sc, text = c.call("get_window_state", W, "tree+shot")
log(r, frame_scale=sc.get("frame_scale"), window_bounds=sc.get("window_bounds"),
    shot=(sc.get("screenshot_width"), sc.get("screenshot_height")))

# Desktop screenshots.
r, sc, _ = c.call("get_desktop_state", {}, "desktop")
log(r, meta={k: v for k, v in sc.items() if k not in ("elements",)} if sc else None)
r, sc, _ = c.call("get_desktop_state", {"max_image_dimension": 1280}, "desktop1280")
log(r, meta={k: v for k, v in sc.items() if k not in ("elements",)} if sc else None)

# Form: click the name field and type.
m0 = mouse()
name = find(els1, "Full name", "entry")
r, _, _ = c.call("click", {**W, "element_token": name["element_token"], **EXTRA}, "click-name")
log(r, mouse_before=m0, mouse_after=mouse())
r, _, _ = c.call("type_text", {**W, "text": "Ada Lovelace", **EXTRA}, "type-name")
log(r, mouse_after=mouse())
email = find(els1, "Email", "entry")
r, _, _ = c.call("set_value", {**W, "element_token": email["element_token"], "value": "ada@example.org"}, "set_value-email")
log(r)
r, _, _ = c.call("click", {**W, "element_token": find(els1, "Pro")["element_token"], **EXTRA}, "click-radio")
log(r, mouse_after=mouse())
r, _, _ = c.call("click", {**W, "element_token": find(els1, "Send me news")["element_token"], **EXTRA}, "click-check")
log(r, mouse_after=mouse())
notes = find(els1, "Notes", "entry")
r, _, _ = c.call("click", {**W, "element_token": notes["element_token"], **EXTRA}, "click-notes")
log(r)
r, _, _ = c.call("type_text", {**W, "text": "line one", **EXTRA}, "type-notes")
log(r)
r, _, _ = c.call("hotkey", {**W, "keys": ["ctrl", "a"], **EXTRA}, "hotkey-ctrl-a")
log(r)
r, _, _ = c.call("type_text", {**W, "text": "replaced", **EXTRA}, "type-replace")
log(r)
r, _, _ = c.call("click", {**W, "element_token": find(els1, "Create account")["element_token"], **EXTRA}, "click-submit")
log(r, mouse_after=mouse())
time.sleep(0.3)
r, sc, _ = c.call("get_window_state", {**W, "include_screenshot": False, "query": "Saved"}, "query-status")
status = [e.get("label") or e.get("value") for e in sc.get("elements", []) if "Saved" in json.dumps(e)]
log(r, status=status[:3], returned=sc.get("returned_element_count"))
r, sc, _ = c.call("get_window_state", {**W, "include_screenshot": False}, "tree-after-form")
fields = {e.get("label"): e.get("value") for e in sc["elements"] if e.get("role") in ("entry", "text", "check box", "radio button")}
log(r, fields={k: fields.get(k) for k in ("Full name", "Email", "Notes")}, snapshot=sc.get("snapshot_id"))
els2 = sc["elements"]

# Tokens: stale snapshot and DOM change.
r, _, _ = c.call("click", {**W, "element_token": find(els1, "Delete Task 1")["element_token"], **EXTRA}, "click-delete1-stale-token")
log(r, note="token from snapshot 1 after a newer snapshot")
r, _, _ = c.call("click", {**W, "element_token": find(els1, "Delete Task 3")["element_token"], **EXTRA}, "click-delete3-after-dom-change")
log(r, note="token from snapshot 1 after Task 1 was deleted")
r, sc, _ = c.call("get_window_state", {**W, "include_screenshot": False, "query": "Delete Task"}, "query-deletes")
left = [e.get("label") for e in sc.get("elements", []) if (e.get("label") or "").startswith("Delete Task")][:4]
log(r, remaining_first=left)
r, _, _ = c.call("click", {**W, "element_index": find(els1, "Delete Task 5")["element_index"], "snapshot_id": snap1, **EXTRA}, "click-index-old-snapshot")
log(r)

# Scroll the task list, then the page.
lst = find(els2, "Task list")
r, _, _ = c.call("scroll", {**W, "element_token": lst["element_token"], "direction": "down", "amount": 5, **EXTRA}, "scroll-list")
log(r, mouse_after=mouse())
r, _, _ = c.call("scroll", {**W, "direction": "down", "amount": 10, "by": "line", **EXTRA}, "scroll-page")
log(r, mouse_after=mouse())
time.sleep(0.3)

# Canvas: find it, click the target square at canvas (100,100) by pixels.
r, sc, _ = c.call("get_window_state", W, "tree+shot-2")
els3 = sc.get("elements", [])
canv = [e for e in els3 if e.get("role") in ("canvas", "image") or "canvas" in (e.get("role") or "")]
log(r, canvas=canv[:2], frame_scale=sc.get("frame_scale"), shot=(sc.get("screenshot_width"), sc.get("screenshot_height")),
    window_bounds=sc.get("window_bounds"))
if canv:
    f = canv[0]["frame"]
    x, y = f["x"] + 100, f["y"] + 100
    r, _, _ = c.call("click", {**W, "x": x, "y": y, **EXTRA}, "click-canvas-window-frame")
    log(r, target=(x, y), mouse_after=mouse())
    time.sleep(0.2)
    r, sc, _ = c.call("get_window_state", {**W, "include_screenshot": False, "query": "Last click"}, "query-last-click")
    log(r, last=[e.get("label") for e in sc.get("elements", []) if "click" in (e.get("label") or "")][:2])

# Launch a URL.
r, _, _ = c.call("launch_app", {"name": "google-chrome", "urls": ["http://127.0.0.1:8000/?launched"]}, "launch-url")
log(r)
c.close()

# A new driver process cannot use the old tokens.
c2 = Client()
r, _, _ = c2.call("click", {**W, "element_token": find(els2, "Delete Task 10")["element_token"], **EXTRA}, "click-token-new-process")
log(r, note="token from the first driver process")
c2.close()
log({"tool": "done", "mouse_final": mouse()})
