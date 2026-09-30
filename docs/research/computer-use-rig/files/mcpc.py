#!/usr/bin/env python3
"""Minimal MCP stdio client for timing cua-driver calls.

Usage: mcpc.py <cua-driver path> <script.json | -> [outdir]
The script is a JSON list of [tool, args] pairs, or {"sleep": seconds}.
Prints one JSON line per call with timing and sizes, and saves every result
to outdir/NN-tool.json (images are written as separate files).
"""
import base64, json, os, subprocess, sys, time

driver, script_path = sys.argv[1], sys.argv[2]
outdir = sys.argv[3] if len(sys.argv) > 3 else "/tmp/mcp-out"
os.makedirs(outdir, exist_ok=True)
script = json.load(sys.stdin if script_path == "-" else open(script_path))

t0 = time.monotonic()
p = subprocess.Popen([driver, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, bufsize=1)
seq = 0


def rpc(method, params=None, notify=False):
    global seq
    msg = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    if not notify:
        seq += 1
        msg["id"] = seq
    p.stdin.write(json.dumps(msg) + "\n")
    p.stdin.flush()
    if notify:
        return None
    while True:
        line = p.stdout.readline()
        if not line:
            raise SystemExit("driver closed stdout")
        m = json.loads(line)
        if m.get("id") == seq:
            return m


rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "bb-box-rig", "version": "0"}})
rpc("notifications/initialized", notify=True)
print(json.dumps({"event": "ready", "ms": round((time.monotonic() - t0) * 1000)}), flush=True)

for i, step in enumerate(script):
    if isinstance(step, dict) and "sleep" in step:
        time.sleep(step["sleep"])
        continue
    name, args = step
    s = time.monotonic()
    m = rpc("tools/call", {"name": name, "arguments": args})
    ms = round((time.monotonic() - s) * 1000)
    res = m.get("result") or {}
    text_len, images, texts = 0, [], []
    for c in res.get("content", []):
        if c.get("type") == "text":
            text_len += len(c["text"])
            texts.append(c["text"])
        elif c.get("type") == "image":
            raw = base64.b64decode(c["data"])
            path = f"{outdir}/{i:02d}-{name}.{c.get('mimeType', 'image/png').split('/')[1]}"
            open(path, "wb").write(raw)
            images.append({"path": path, "bytes": len(raw), "mime": c.get("mimeType")})
            c["data"] = f"<{len(raw)} bytes>"
    json.dump(m, open(f"{outdir}/{i:02d}-{name}.json", "w"), indent=1)
    summary = {"i": i, "tool": name, "ms": ms, "error": res.get("isError", False) or ("error" in m),
               "text_chars": text_len, "images": images,
               "head": (texts[0][:160] if texts else json.dumps(m.get("error"))[:160])}
    if "structuredContent" in res:
        summary["structured_chars"] = len(json.dumps(res["structuredContent"]))
    print(json.dumps(summary), flush=True)

p.stdin.close()
p.wait(timeout=10)
