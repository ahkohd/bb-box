import json, subprocess, sys
take = sys.argv[1]
data = json.load(open(f"{take}/frames.json"))
frames, events = data["frames"], {e["label"]: e["at"] for e in data["events"]}
fast = (events["sent"] + 0.6, events["agent done"] - 0.4, 3.0)
lines, clock, times = [], 0.0, []
for i, frame in enumerate(frames):
    end = frames[i + 1]["at"] if i + 1 < len(frames) else frame["at"] + 1.5
    span = max(end - frame["at"], 0.001)
    if fast[0] <= frame["at"] < fast[1]:
        span /= fast[2]
    times.append((frame["name"], clock))
    clock += span
    lines.append(f"file 'frames/{frame['name']}'\nduration {span:.4f}")
lines.append(f"file 'frames/{frames[-1]['name']}'")
open(f"{take}/list.txt", "w").write("\n".join(lines) + "\n")
poster_at = events["maximized"] + 3.0
poster = min(frames, key=lambda f: abs(f["at"] - poster_at))["name"]
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{take}/frames/{poster}", "-vf", "scale=1920:1200:flags=lanczos", "-q:v", "3", f"{take}/demo-poster.jpg"], check=True)
print(json.dumps({"length": round(clock, 2), "poster": poster}))
