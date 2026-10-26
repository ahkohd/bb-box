#!/usr/bin/env python3
import argparse
import glob
import json
import os
import statistics
import subprocess


def shades(path, x, y):
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-fps_mode", "passthrough", "-vf", f"crop=16:16:{x - 8}:{y - 8},scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return list(out)


def percentile(values, share):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, -(-int(share * len(ordered) * 1000) // 1000) - 1))]


def device(raw, name, x, y):
    times = json.load(open(os.path.join(raw, f"{name}.times.json")))
    frames = times["frames"]
    scale = times.get("scale", 1)
    shade = shades(os.path.join(raw, f"{name}.h264"), max(8, round(x * scale)), max(8, round(y * scale)))
    if len(shade) != len(frames):
        return {"name": name, "error": f"{len(shade)} decoded frames against {len(frames)} received"}
    delays = []
    missed = 0
    for sent in times["taps"]:
        before = [index for index, at in enumerate(frames) if at < sent]
        if not before:
            missed += 1
            continue
        base = shade[before[-1]]
        found = next((index for index in range(before[-1] + 1, len(frames)) if abs(shade[index] - base) > 80 and frames[index] - sent < 3000), None)
        if found is None:
            missed += 1
        else:
            delays.append(frames[found] - sent)
    if not delays:
        return {"name": name, "taps": len(times["taps"]), "missed": missed}
    return {
        "name": name,
        "taps": len(times["taps"]),
        "missed": missed,
        "medianMs": round(statistics.median(delays)),
        "p95Ms": round(percentile(delays, 0.95)),
        "worstMs": round(max(delays)),
        "delaysMs": [round(d) for d in delays],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("raw")
    parser.add_argument("--x", type=int, default=60)
    parser.add_argument("--y", type=int, default=1700)
    args = parser.parse_args()
    results = [device(args.raw, os.path.basename(path)[: -len(".times.json")], args.x, args.y) for path in sorted(glob.glob(os.path.join(args.raw, "*.times.json")))]
    json.dump(results, open(os.path.join(args.raw, "taps.json"), "w"), indent=1)
    every = [d for r in results for d in r.get("delaysMs", [])]
    for r in results:
        if "medianMs" in r:
            print(f"{r['name']}: tap to frame median {r['medianMs']} ms, p95 {r['p95Ms']} ms, worst {r['worstMs']} ms, missed {r['missed']} of {r['taps']}")
        else:
            print(f"{r['name']}: {r.get('error', 'no taps seen')}, missed {r.get('missed')}")
    if every:
        print(f"all: {len(every)} taps, median {round(statistics.median(every))} ms, p95 {round(percentile(every, 0.95))} ms, worst {round(max(every))} ms, missed {sum(r.get('missed', 0) for r in results)}")


if __name__ == "__main__":
    main()
