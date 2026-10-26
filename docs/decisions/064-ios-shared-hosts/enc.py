import subprocess, sys, threading, time, json, argparse
p = argparse.ArgumentParser()
p.add_argument("--n", type=int, required=True)
p.add_argument("--seconds", type=float, default=30)
p.add_argument("--size", default="1206x2622")
p.add_argument("--paced", action="store_true")
p.add_argument("--label", default="enc")
p.add_argument("--start-at", type=float, default=0)
p.add_argument("--stagger", type=float, default=0)
a = p.parse_args()
clip = f"/tmp/clip-{a.size}.yuv"
if a.start_at:
    time.sleep(max(0, a.start_at - time.time()))
counts = [[] for _ in range(a.n)]
procs = []
def reader(i, proc):
    for line in proc.stdout:
        if line.startswith("frame="):
            counts[i].append((time.time(), int(line.split("=")[1])))
t0 = time.time()
for i in range(a.n):
    args = ["ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error", "-stream_loop", "-1", "-f", "rawvideo", "-pix_fmt", "nv12", "-s", a.size, "-framerate", "60"]
    if a.paced:
        args += ["-readrate", "1"]
    args += ["-i", clip, "-c:v", "h264_videotoolbox", "-allow_sw", "0", "-b:v", "8M", "-progress", "pipe:1", "-stats_period", "0.5", "-f", "null", "-"]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, text=True)
    procs.append(proc)
    threading.Thread(target=reader, args=(i, proc), daemon=True).start()
    if a.stagger:
        time.sleep(a.stagger)
time.sleep(a.seconds)
for proc in procs:
    proc.terminate()
lo, hi = t0 + a.stagger * a.n + 4, time.time() - 1
fps = []
for c in counts:
    inside = [x for x in c if lo <= x[0] <= hi]
    fps.append(round((inside[-1][1] - inside[0][1]) / (inside[-1][0] - inside[0][0]), 1) if len(inside) > 1 else None)
total = round(sum(f for f in fps if f), 1)
print(json.dumps({"label": a.label, "at": time.strftime("%H:%M:%S"), "n": a.n, "size": a.size, "paced": a.paced, "fps": fps, "total": total}))
