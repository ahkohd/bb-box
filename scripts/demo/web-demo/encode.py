import argparse
import json
import os
import subprocess
import sys


def parse_arguments():
    parser = argparse.ArgumentParser(description="Encode a recorded take into a web video, an animated WebP and a poster.")
    parser.add_argument("take", help="the take directory record.mjs wrote")
    parser.add_argument("--out", help="output directory, the take's out/ by default")
    parser.add_argument("--name", default="demo", help="base name of the files, such as demo or demo-light")
    parser.add_argument("--width", type=int, default=1920, help="video width; the height keeps the take's shape")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--crf", type=int, default=12)
    parser.add_argument("--hold", type=float, default=1.5, help="seconds the last frame is held")
    parser.add_argument("--webp", action=argparse.BooleanOptionalAction, default=True, help="also make an animated WebP")
    parser.add_argument("--webp-width", type=int, default=960)
    parser.add_argument("--webp-fps", type=int, default=10)
    parser.add_argument("--webp-quality", type=int, default=70, help="first quality tried; it steps down until the file fits --max-mb")
    parser.add_argument("--max-mb", type=float, default=5.0)
    parser.add_argument("--poster", default="poster", help="the name given to demo.poster() in the steps file")
    return parser.parse_args()


def even(number):
    return int(round(number / 2)) * 2


def speed_at(moment, speed_ups):
    for window in speed_ups:
        if window["from"] <= moment < window["to"]:
            return window["times"]
    return 1


def write_frame_list(take_dir, take, hold):
    frames = take["frames"]
    if not frames:
        sys.exit(f"{take_dir} has no frames.")
    lines = []
    played = 0.0
    for index, frame in enumerate(frames):
        until = frames[index + 1]["at"] if index + 1 < len(frames) else frame["at"] + hold
        span = max(until - frame["at"], 0.001) / speed_at(frame["at"], take["speedUps"])
        played += span
        lines.append(f"file 'frames/{frame['name']}'\nduration {span:.4f}")
    lines.append(f"file 'frames/{frames[-1]['name']}'")
    list_path = os.path.join(take_dir, "frames.txt")
    with open(list_path, "w") as handle:
        handle.write("\n".join(lines) + "\n")
    return list_path, played


def ffmpeg(*arguments):
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", *arguments], check=True)


def megabytes(path):
    return os.path.getsize(path) / 1_000_000


def encode_video(list_path, path, width, height, fps, crf):
    ffmpeg(
        "-f", "concat", "-safe", "0", "-i", list_path,
        "-vf", f"fps={fps},scale={width}:{height}:flags=lanczos,format=yuv420p",
        "-c:v", "libx264", "-crf", str(crf), "-preset", "slow", "-tune", "animation",
        "-movflags", "+faststart", "-an", path,
    )


def encode_webp_within_budget(list_path, path, width, height, fps, first_quality, max_mb):
    quality = first_quality
    while True:
        ffmpeg(
            "-f", "concat", "-safe", "0", "-i", list_path,
            "-vf", f"fps={fps},scale={width}:{height}:flags=lanczos",
            "-c:v", "libwebp", "-lossless", "0", "-q:v", str(quality), "-compression_level", "6",
            "-loop", "0", "-an", path,
        )
        if megabytes(path) <= max_mb or quality <= 40:
            return quality
        quality -= 5


def poster_frame(take, poster_name):
    frames = take["frames"]
    wanted = next((poster["at"] for poster in take["posters"] if poster["name"] == poster_name), None)
    if wanted is None:
        return frames[len(frames) // 2]["name"]
    return min(frames, key=lambda frame: abs(frame["at"] - wanted))["name"]


def main():
    arguments = parse_arguments()
    take_dir = arguments.take
    with open(os.path.join(take_dir, "take.json")) as handle:
        take = json.load(handle)
    out_dir = arguments.out or os.path.join(take_dir, "out")
    os.makedirs(out_dir, exist_ok=True)
    shape = take["viewport"]["height"] / take["viewport"]["width"]
    height = even(arguments.width * shape)
    webp_height = even(arguments.webp_width * shape)

    list_path, length = write_frame_list(take_dir, take, arguments.hold)
    video = os.path.join(out_dir, f"{arguments.name}.mp4")
    encode_video(list_path, video, arguments.width, height, arguments.fps, arguments.crf)

    poster_name = poster_frame(take, arguments.poster)
    poster = os.path.join(out_dir, f"{arguments.name}-poster.jpg")
    ffmpeg("-i", os.path.join(take_dir, "frames", poster_name), "-vf", f"scale={arguments.width}:{height}:flags=lanczos", "-q:v", "3", poster)

    summary = {
        "theme": take["theme"],
        "length": round(length, 2),
        "frames": len(take["frames"]),
        "video": {"path": video, "size": f"{arguments.width}x{height}", "mb": round(megabytes(video), 2)},
        "poster": {"path": poster, "frame": poster_name},
    }
    if arguments.webp:
        webp = os.path.join(out_dir, f"{arguments.name}.webp")
        quality = encode_webp_within_budget(list_path, webp, arguments.webp_width, webp_height, arguments.webp_fps, arguments.webp_quality, arguments.max_mb)
        summary["webp"] = {"path": webp, "size": f"{arguments.webp_width}x{webp_height}", "quality": quality, "mb": round(megabytes(webp), 2)}
    over_budget = [name for name in ("video", "webp") if name in summary and summary[name]["mb"] > arguments.max_mb]
    summary["over_budget"] = over_budget
    print(json.dumps(summary, indent=1))
    sys.exit(1 if over_budget else 0)


main()
