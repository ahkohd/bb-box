#!/usr/bin/env python3
import glob
import json
import os
import sys

out = sys.argv[1]
events = [line.rstrip("\n").split("\t") for line in open(os.path.join(out, "events.tsv")) if line.strip()]
devices = {}
for path in sorted(glob.glob(os.path.join(out, "raw", "*.times.json"))):
    data = json.load(open(path))
    zero = data["epochAtZero"]
    devices[os.path.basename(path)[: -len(".times.json")]] = [zero + at for at in data["frames"]]


def window(frames, start, end):
    inside = [at for at in frames if start <= at <= end]
    gaps = [b - a for a, b in zip(inside, inside[1:])]
    seconds = max(0.001, (end - start) / 1000)
    return len(inside) / seconds, max(gaps) if gaps else None


report = []
first = min(int(e[1]) for e in events)
for name, frames in devices.items():
    fps, worst = window(frames, first - 15000, first - 1000)
    report.append({"device": name, "event": "baseline, 14 s before the first event", "fps": round(fps, 1), "worstGapMs": round(worst) if worst else None})
for event, start, end in events:
    start, end = int(start), int(end)
    for name, frames in devices.items():
        fps, worst = window(frames, start, end + 2000)
        report.append({"device": name, "event": event, "eventMs": end - start, "fps": round(fps, 1), "worstGapMs": round(worst) if worst else None})
json.dump(report, open(os.path.join(out, "events.json"), "w"), indent=1)
current = None
for row in report:
    if row["event"] != current:
        current = row["event"]
        print(f"{current}" + (f" ({row['eventMs']} ms)" if "eventMs" in row else ""))
    print(f"  {row['device']}: {row['fps']} fps, worst gap {row['worstGapMs']} ms")
