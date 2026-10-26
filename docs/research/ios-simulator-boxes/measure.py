"""Measure one way of streaming an iOS Simulator's screen.

Run with the Python of a venv that has fb-idb and psutil, on the Mac that
runs the simulator, with idb_companion serving it on --companion-port.

  python measure.py idb    --udid U --out DIR
  python measure.py window --udid U --out DIR --stream-pid-name window-stream -- ./window-stream "iPhone" X,Y,W,H
  python measure.py axe    --udid U --out DIR -- axe stream-video --udid U --format mjpeg --fps 30

The simulator must show page.html (served on the Mac) in Safari. The
script times the first frame, counts frames while the page is still,
taps it N times (each tap turns the page black or white) and times the
first changed frame after each, then loads page.html?busy and counts
frames while it animates. Taps go through idb_companion's HID stream,
held open for the whole run, as a person's viewer would hold it.
"""

import argparse
import asyncio
import hashlib
import json
import logging
import os
import statistics
import subprocess
import sys
import time

import psutil
from idb.common.types import (
    HIDDirection,
    HIDPress,
    HIDTouch,
    Point,
    TCPAddress,
    VideoFormat,
)
from idb.grpc.client import Client


class Frames:
    def __init__(self, kind):
        self.kind = kind
        self.buffer = b""
        self.frames = []

    def feed(self, chunk, now):
        self.buffer += chunk
        if self.kind == "h264":
            self._split_h264(now)
        else:
            self._split_jpeg(now)

    def _split_h264(self, now):
        data = self.buffer
        starts = []
        index = data.find(b"\x00\x00\x01")
        while index != -1:
            starts.append(index)
            index = data.find(b"\x00\x00\x01", index + 3)
        if len(starts) < 2:
            return
        last = starts[-1]
        for begin, end in zip(starts, starts[1:]):
            nal_type = data[begin + 3] & 0x1F
            size = end - begin
            if nal_type in (1, 5):
                self.frames.append({"t": now, "size": size, "key": nal_type == 5})
            elif self.frames and nal_type == 0:
                self.frames[-1]["size"] += size
        self.buffer = data[last:]

    def _split_jpeg(self, now):
        while True:
            header = self.buffer.find(b"Content-Length: ")
            if header == -1:
                return
            line_end = self.buffer.find(b"\r\n\r\n", header)
            if line_end == -1:
                return
            length = int(self.buffer[header + 16 : self.buffer.find(b"\r\n", header)])
            body_start = line_end + 4
            if len(self.buffer) < body_start + length:
                return
            image = self.buffer[body_start : body_start + length]
            digest = hashlib.sha1(image).hexdigest()[:12]
            self.frames.append({"t": now, "size": len(image), "hash": digest})
            self.buffer = self.buffer[body_start + length :]


def changed_after(frames, since, kind, idle_sizes):
    previous = None
    for frame in frames:
        if frame["t"] < since:
            previous = frame
            continue
        if kind == "h264":
            threshold = max(4 * statistics.median(idle_sizes) if idle_sizes else 0, 2000)
            if frame["size"] > threshold:
                return frame
        elif previous is None or frame["hash"] != previous["hash"]:
            return frame
        previous = frame
    return None


def stats(values):
    if not values:
        return None
    ordered = sorted(values)
    return {
        "n": len(values),
        "median": round(statistics.median(ordered), 1),
        "p95": round(ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))], 1),
        "min": round(ordered[0], 1),
        "max": round(ordered[-1], 1),
    }


class Usage:
    def __init__(self, names, pids):
        self.names = names
        self.pids = set(pids)

    def processes(self):
        found = []
        for process in psutil.process_iter(["name", "cmdline"]):
            try:
                line = " ".join(process.info["cmdline"] or [])
                if process.pid in self.pids or any(name in line for name in self.names):
                    found.append(process)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return found

    def snapshot(self):
        total = 0.0
        rss = 0
        for process in self.processes():
            try:
                times = process.cpu_times()
                total += times.user + times.system
                rss += process.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return time.monotonic(), total, rss

    @staticmethod
    def between(first, second):
        seconds = second[0] - first[0]
        return {
            "cpu_percent_of_one_core": round(100 * (second[1] - first[1]) / seconds, 1),
            "rss_mib": round(second[2] / 2**20, 1),
        }


def open_url(udid, url):
    subprocess.run(["xcrun", "simctl", "openurl", udid, url], check=True)


async def run(args, command):
    frames = Frames("jpeg" if args.source == "axe" else "h264")
    address = TCPAddress(host="localhost", port=args.companion_port)
    logger = logging.getLogger("measure")
    taps = asyncio.Queue()

    async def hid_events():
        while True:
            event = await taps.get()
            if event is None:
                return
            yield event

    open_url(args.udid, args.page)
    await asyncio.sleep(3)

    async with Client.build(address=address, logger=logger) as client:
        hid_task = asyncio.create_task(client.hid(hid_events()))
        process = None
        started = time.monotonic()
        stream_pids = []

        if args.source == "idb":
            async def pump_idb():
                async for chunk in client.stream_video(
                    output_file=None,
                    fps=None,
                    format=VideoFormat.H264,
                    compression_quality=args.quality,
                    scale_factor=1,
                ):
                    frames.feed(chunk, time.monotonic())

            stream_task = asyncio.create_task(pump_idb())
            usage = Usage(["idb_companion"], [])
        else:
            process = await asyncio.create_subprocess_exec(
                *command, stdout=asyncio.subprocess.PIPE, stderr=open(os.path.join(args.out, "stream.err"), "wb")
            )
            stream_pids.append(process.pid)

            async def pump_process():
                while True:
                    chunk = await process.stdout.read(65536)
                    if not chunk:
                        return
                    frames.feed(chunk, time.monotonic())

            stream_task = asyncio.create_task(pump_process())
            usage = Usage([args.stream_pid_name] if args.stream_pid_name else [], stream_pids)

        while not frames.frames and time.monotonic() - started < 20:
            await asyncio.sleep(0.005)
        first_frame_ms = (frames.frames[0]["t"] - started) * 1000 if frames.frames else None
        await asyncio.sleep(2)

        idle_from = time.monotonic()
        idle_usage = usage.snapshot()
        await asyncio.sleep(args.idle)
        idle_usage = Usage.between(idle_usage, usage.snapshot())
        idle_frames = [f for f in frames.frames if f["t"] >= idle_from]
        idle_sizes = [f["size"] for f in idle_frames] or [f["size"] for f in frames.frames[-5:]]

        delays = []
        x, y = args.tap
        for _ in range(args.taps):
            await asyncio.sleep(args.tap_gap)
            sent = time.monotonic()
            await taps.put(HIDPress(action=HIDTouch(point=Point(x=x, y=y)), direction=HIDDirection.DOWN))
            await taps.put(HIDPress(action=HIDTouch(point=Point(x=x, y=y)), direction=HIDDirection.UP))
            await asyncio.sleep(args.tap_gap)
            frame = changed_after(frames.frames, sent, frames.kind, idle_sizes)
            delays.append((frame["t"] - sent) * 1000 if frame else None)

        open_url(args.udid, args.page + "?busy")
        await asyncio.sleep(3)
        busy_from = time.monotonic()
        busy_usage = usage.snapshot()
        await asyncio.sleep(args.busy)
        busy_until = time.monotonic()
        busy_usage = Usage.between(busy_usage, usage.snapshot())
        busy_frames = [f for f in frames.frames if busy_from <= f["t"] < busy_until]
        gaps = [(b["t"] - a["t"]) * 1000 for a, b in zip(busy_frames, busy_frames[1:])]
        busy_bytes = sum(f["size"] for f in busy_frames)

        open_url(args.udid, args.page)
        await taps.put(None)
        await asyncio.wait_for(hid_task, 5)
        stream_task.cancel()
        if process:
            process.terminate()
            await process.wait()

    measured = [d for d in delays if d is not None]
    result = {
        "source": args.source,
        "first_frame_ms": round(first_frame_ms, 1) if first_frame_ms else None,
        "idle": {
            "seconds": args.idle,
            "frames": len(idle_frames),
            "fps": round(len(idle_frames) / args.idle, 2),
            **idle_usage,
        },
        "tap_to_frame_ms": stats(measured),
        "taps_missed": len(delays) - len(measured),
        "busy": {
            "seconds": args.busy,
            "frames": len(busy_frames),
            "fps": round(len(busy_frames) / args.busy, 1),
            "gap_ms": stats(gaps),
            "kbit_per_s": round(8 * busy_bytes / args.busy / 1000),
            **busy_usage,
        },
    }
    with open(os.path.join(args.out, "frames.json"), "w") as handle:
        json.dump({"frames": frames.frames, "started": started, "delays": delays}, handle)
    with open(os.path.join(args.out, "result.json"), "w") as handle:
        json.dump(result, handle, indent=2)
    print(json.dumps(result, indent=2))


def main():
    argv = sys.argv[1:]
    command = []
    if "--" in argv:
        split = argv.index("--")
        argv, command = argv[:split], argv[split + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("source", choices=["idb", "window", "axe"])
    parser.add_argument("--udid", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--page", default="http://127.0.0.1:8765/page.html")
    parser.add_argument("--companion-port", type=int, default=10882)
    parser.add_argument("--quality", type=float, default=0.2)
    parser.add_argument("--tap", type=float, nargs=2, default=[200, 500])
    parser.add_argument("--taps", type=int, default=20)
    parser.add_argument("--tap-gap", type=float, default=0.6)
    parser.add_argument("--idle", type=float, default=10)
    parser.add_argument("--busy", type=float, default=10)
    parser.add_argument("--stream-pid-name", default="")
    args = parser.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    asyncio.run(run(args, command))


if __name__ == "__main__":
    main()
