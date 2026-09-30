#!/usr/bin/env python3
"""Both tools against GTK apps: Mousepad, Thunar and xfce4-terminal.

Usage: gtk_bench.py <cua-driver path>
"""
import json, re, subprocess, sys, time
sys.argv = [sys.argv[0], sys.argv[1]]
src = open("/usr/local/bin/cua_bench2.py").read()
exec(src.split("c = Client()")[0].replace('DRIVER, MODE = sys.argv[1], sys.argv[2]', 'DRIVER, MODE = sys.argv[1], "background"'))


def acli(pid, *args):
    s = time.monotonic()
    p = subprocess.run(["acli-patched", "--platform", "linux", "--pid", str(pid), "--timeout", "3000", *args],
                       capture_output=True, text=True)
    out = p.stdout + p.stderr
    return {"ms": round((time.monotonic() - s) * 1000), "rc": p.returncode, "bytes": len(out),
            "lines": out.count("\n"), "head": out[:160].replace("\n", " | ")}


c = Client()
text = c.rpc("tools/call", {"name": "list_windows", "arguments": {}})["result"]["content"][0]["text"]
wins = {}
for title in ("Mousepad", "agent - Thunar", "Terminal - agent"):
    m = re.search(r'window_id=(\d+) pid=(\d+) "([^"]*' + re.escape(title) + '[^"]*)"', text)
    if m:
        wins[title] = {"pid": int(m.group(2)), "window_id": int(m.group(1))}
log({"step": "windows"}, wins=wins)

for title, W in wins.items():
    r, sc, _ = c.call("get_window_state", {**W, "include_screenshot": False}, f"cua-tree-{title}")
    log(r, elements=sc.get("element_count"), markdown_chars=len(sc.get("tree_markdown", "")),
        structured_chars=len(json.dumps(sc.get("elements", []))))
    for fmt in (["--format", "llm"], ["--format", "llm", "--interactive"]):
        log({"step": f"acli-tree-{title} {' '.join(fmt)}", **acli(W["pid"], *fmt)})

# Mousepad: set_value and typing into the text view.
M = wins.get("Mousepad")
if M:
    r, sc, _ = c.call("get_window_state", {**M, "include_screenshot": False}, "mp")
    tv = next(e for e in sc["elements"] if e.get("role") in ("text", "document text", "text view", "document"))
    log({"step": "mousepad-text-element"}, el={k: tv.get(k) for k in ("role", "label", "actions", "element_index")})
    r, _, _ = c.call("set_value", {**M, "element_token": tv["element_token"], "value": "set by cua"}, "cua-set_value-mousepad")
    log(r)
    for mode in ("background", "foreground"):
        r, _, _ = c.call("type_text", {**M, "element_token": tv["element_token"], "text": f" typed-{mode}", "delivery_mode": mode}, f"cua-type-{mode}-mousepad")
        log(r, mouse=mouse())
    r, sc, _ = c.call("get_window_state", {**M, "include_screenshot": False}, "mp2")
    tv = next(e for e in sc["elements"] if e.get("role") in ("text", "document text", "text view", "document"))
    log({"step": "mousepad-after"}, value=tv.get("value"), label=tv.get("label"))
    log({"step": "acli-type-mousepad", **acli(M["pid"], "--type", "TextArea", "set by acli")})
    log({"step": "acli-query-mousepad", **acli(M["pid"], "--query", "TextArea")})

# Thunar: click a toolbar button in background mode, and with accessibility-cli.
T = wins.get("agent - Thunar")
if T:
    r, sc, _ = c.call("get_window_state", {**T, "include_screenshot": False}, "th")
    btns = [e for e in sc["elements"] if e.get("role") == "push button"]
    log({"step": "thunar-buttons"}, buttons=[(b.get("label"), b.get("actions")) for b in btns][:12])
    home = next((b for b in btns if b.get("label") in ("Home", "Go to the home folder")), None)
    up = next((b for b in btns if b.get("label") in ("Up", "Parent", "Open the parent folder")), None)
    if up:
        r, _, _ = c.call("click", {**T, "element_token": up["element_token"]}, "cua-thunar-up")
        log(r, mouse=mouse())
        time.sleep(0.5)
        text2 = c.rpc("tools/call", {"name": "list_windows", "arguments": {}})["result"]["content"][0]["text"]
        log({"step": "thunar-title-after-up"}, titles=re.findall(r'"([^"]*Thunar)"', text2))
    log({"step": "acli-thunar-back", **acli(T["pid"], "--click", 'Button[title="Back"]')})
    log({"step": "acli-thunar-list", **acli(T["pid"], "--list-windows")})

# Terminal: type a command in background and foreground mode.
X = wins.get("Terminal - agent")
if X:
    for mode in ("background", "foreground"):
        r, _, _ = c.call("type_text", {**X, "text": f"echo cua-{mode} > /tmp/cua-{mode}.txt\n", "delivery_mode": mode}, f"cua-term-{mode}")
        log(r, mouse=mouse())
    time.sleep(0.5)
    log({"step": "terminal-files"}, files=subprocess.run("ls /tmp/cua-*.txt 2>&1", shell=True, capture_output=True, text=True).stdout.split())
c.close()
