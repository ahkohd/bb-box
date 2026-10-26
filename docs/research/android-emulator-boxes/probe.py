import argparse
import fractions
import json
import os
import socket
import statistics
import struct
import subprocess
import sys
import threading
import time

import av
import grpc
import numpy as np
import psutil

sys.path.insert(0, os.path.expanduser("~/proto"))
import emulator_controller_pb2 as pb
import emulator_controller_pb2_grpc as pbg
from google.protobuf import empty_pb2

SCRCPY_VERSION = "5.0.1"
SCRCPY_PORT = 27183


def now():
    return time.monotonic()


class Frames:
    def __init__(self):
        self.lock = threading.Condition()
        self.items = []
        self.first_at = None
        self.started_at = now()
        self.closed = False

    def push(self, image):
        stamp = now()
        with self.lock:
            if self.first_at is None:
                self.first_at = stamp
            self.items.append((stamp, image))
            if len(self.items) > 600:
                del self.items[:300]
            self.lock.notify_all()

    def latest(self):
        with self.lock:
            return self.items[-1] if self.items else (None, None)

    def count_between(self, start, end):
        with self.lock:
            return sum(1 for stamp, _ in self.items if start <= stamp < end)

    def wait_after(self, after, timeout):
        deadline = now() + timeout
        with self.lock:
            while True:
                fresh = [item for item in self.items if item[0] > after]
                if fresh:
                    return fresh
                left = deadline - now()
                if left <= 0:
                    return []
                self.lock.wait(left)


class FrameCounter:
    def __init__(self):
        self.stamps = []
        self.lock = threading.Lock()

    def add(self):
        with self.lock:
            self.stamps.append(now())

    def between(self, start, end):
        with self.lock:
            return [s for s in self.stamps if start <= s < end]


def decode_h264(read_chunk, frames, counter):
    codec = av.CodecContext.create("h264", "r")
    codec.flags |= av.codec.context.Flags.low_delay
    while not frames.closed:
        chunk = read_chunk()
        if not chunk:
            break
        for packet in codec.parse(chunk):
            for decoded in codec.decode(packet):
                counter.add()
                frames.push(decoded.to_ndarray(format="rgb24"))


def start_grpc_source(args, frames, counter):
    channel = grpc.insecure_channel(f"127.0.0.1:{args.grpc}", options=[("grpc.max_receive_message_length", 64 * 1024 * 1024)])
    stub = pbg.EmulatorControllerStub(channel)
    fmt = pb.ImageFormat(format=pb.ImageFormat.RGB888, width=args.width or 0)

    def run():
        for image in stub.streamScreenshot(fmt):
            counter.add()
            width, height = image.format.width, image.format.height
            frames.push(np.frombuffer(image.image, dtype=np.uint8).reshape(height, width, 3))
            if frames.closed:
                break

    threading.Thread(target=run, daemon=True).start()
    return []


def adb(args, *command, **kwargs):
    return subprocess.run(["adb", "-s", args.serial, *command], check=True, capture_output=True, text=True, **kwargs).stdout


def start_scrcpy_source(args, frames, counter):
    adb(args, "push", os.path.expanduser(f"~/scrcpy-server-v{SCRCPY_VERSION}"), "/data/local/tmp/scrcpy-server.jar")
    scid = "%08x" % (int(time.time()) & 0x7FFFFFFF)
    adb(args, "forward", f"tcp:{SCRCPY_PORT}", f"localabstract:scrcpy_{scid}")
    options = [
        f"scid={scid}", "tunnel_forward=true", "audio=false", "control=true", "cleanup=false",
        "send_device_meta=false", "send_frame_meta=true", "send_stream_meta=false", "send_dummy_byte=true", "video_codec=h264", f"max_size={args.width * 20 // 9 if args.width else 0}",
        f"video_bit_rate={args.bitrate}", "max_fps=60", "log_level=info",
    ]
    if args.encoder:
        options.append(f"video_encoder={args.encoder}")
    server = subprocess.Popen(
        ["adb", "-s", args.serial, "shell", "CLASSPATH=/data/local/tmp/scrcpy-server.jar", "app_process", "/",
         "com.genymobile.scrcpy.Server", SCRCPY_VERSION, *options],
        stdout=open(os.path.expanduser("~/scrcpy-server.log"), "w"), stderr=subprocess.STDOUT)
    video = None
    for _ in range(200):
        try:
            video = socket.create_connection(("127.0.0.1", SCRCPY_PORT))
            if video.recv(1):
                break
            video.close()
        except OSError:
            pass
        time.sleep(0.05)
    control = socket.create_connection(("127.0.0.1", SCRCPY_PORT))
    video.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    control.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    args.scrcpy_control = control
    threading.Thread(target=decode_scrcpy_packets, args=(video, frames, counter), daemon=True).start()
    return [server]


def start_screenrecord_source(args, frames, counter):
    size = [f"--size={args.width}x{args.width * 20 // 9}"] if args.width else []
    process = subprocess.Popen(
        ["adb", "-s", args.serial, "exec-out", "screenrecord", "--output-format=h264", f"--bit-rate={args.bitrate}", *size, "-"],
        stdout=subprocess.PIPE, bufsize=0)
    threading.Thread(target=decode_h264, args=(lambda: os.read(process.stdout.fileno(), 65536), frames, counter), daemon=True).start()
    return [process]


def emulator_window_geometry():
    window = subprocess.run(["xdotool", "search", "--name", "Android Emulator"], capture_output=True, text=True).stdout.split()
    if not window:
        raise SystemExit("no emulator window")
    info = subprocess.run(["xwininfo", "-id", window[0]], capture_output=True, text=True).stdout
    values = {line.split(":")[0].strip(): line.split(":")[1].strip() for line in info.splitlines() if ":" in line}
    return int(values["Absolute upper-left X"]), int(values["Absolute upper-left Y"]), int(values["Width"]), int(values["Height"])


def start_x11_source(args, frames, counter):
    x, y, width, height = emulator_window_geometry()
    width -= width % 2
    height -= height % 2
    process = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-f", "x11grab", "-framerate", "60", "-video_size", f"{width}x{height}",
         "-i", f"{os.environ.get('DISPLAY', ':99')}+{x},{y}", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
         "-pix_fmt", "yuv420p", "-b:v", str(args.bitrate), "-f", "h264", "-"],
        stdout=subprocess.PIPE, bufsize=0)
    threading.Thread(target=decode_h264, args=(lambda: os.read(process.stdout.fileno(), 65536), frames, counter), daemon=True).start()
    args.window = (x, y, width, height)
    return [process]


def start_grpc_h264_source(args, frames, counter):
    channel = grpc.insecure_channel(f"127.0.0.1:{args.grpc}", options=[("grpc.max_receive_message_length", 64 * 1024 * 1024)])
    stub = pbg.EmulatorControllerStub(channel)
    width = args.width or args.device_width
    height = width * args.device_height // args.device_width
    encoder = av.CodecContext.create("libx264", "w")
    encoder.width, encoder.height, encoder.pix_fmt = width, height, "yuv420p"
    encoder.bit_rate = args.bitrate
    encoder.time_base = fractions.Fraction(1, 1000)
    encoder.options = {"preset": "ultrafast", "tune": "zerolatency"}
    decoder = av.CodecContext.create("h264", "r")
    args.encode_ms = []

    def run():
        started = now()
        for image in stub.streamScreenshot(pb.ImageFormat(format=pb.ImageFormat.RGB888, width=width, height=height)):
            if image.format.width != width or image.format.height != height:
                continue
            begin = now()
            frame = av.VideoFrame.from_ndarray(np.frombuffer(image.image, dtype=np.uint8).reshape(height, width, 3), format="rgb24").reformat(format="yuv420p")
            frame.pts = int(1000 * (begin - started))
            packets = encoder.encode(frame)
            args.encode_ms.append(1000 * (now() - begin))
            for packet in packets:
                for decoded in decoder.decode(packet):
                    counter.add()
                    frames.push(decoded.to_ndarray(format="rgb24"))
            if frames.closed:
                break

    threading.Thread(target=run, daemon=True).start()
    return []


def read_exact(sock, size):
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise EOFError
        data += chunk
    return data


def decode_scrcpy_packets(sock, frames, counter):
    decoder = av.CodecContext.create("h264", "r")
    config = b""
    while not frames.closed:
        header = read_exact(sock, 12)
        if header[0] & 0x80:
            continue
        flags_pts, size = struct.unpack(">QI", header)
        payload = read_exact(sock, size)
        if flags_pts & (1 << 62):
            config = payload
            continue
        for decoded in decoder.decode(av.Packet(config + payload)):
            counter.add()
            frames.push(decoded.to_ndarray(format="rgb24"))
        config = b""


SOURCES = {
    "grpc-h264": start_grpc_h264_source,
    "grpc": start_grpc_source,
    "scrcpy": start_scrcpy_source,
    "screenrecord": start_screenrecord_source,
    "x11": start_x11_source,
}


class Injector:
    def __init__(self, args, frames):
        self.args = args
        self.frames = frames
        self.stub = pbg.EmulatorControllerStub(grpc.insecure_channel(f"127.0.0.1:{args.grpc}"))

    def down(self, x, y):
        getattr(self, f"{self.args.input}_touch")(x, y, True)

    def up(self, x, y):
        getattr(self, f"{self.args.input}_touch")(x, y, False)

    def grpc_touch(self, x, y, pressed):
        self.stub.sendTouch(pb.TouchEvent(touches=[pb.Touch(x=x, y=y, identifier=0, pressure=1 if pressed else 0)]))

    def scrcpy_touch(self, x, y, pressed):
        action = 0 if pressed else 1
        _, image = self.frames.latest()
        height, width = image.shape[:2]
        scale = width / self.args.device_width
        message = struct.pack(">BBqiiHHHII", 2, action, -2, int(x * scale), int(y * scale), width, height, 0xFFFF if pressed else 0, 0, 0)
        self.args.scrcpy_control.sendall(message)

    def adb_touch(self, x, y, pressed):
        subprocess.Popen(["adb", "-s", self.args.serial, "shell", "input", "motionevent", "DOWN" if pressed else "UP", str(x), str(y)])

    def grpc_key(self, text):
        self.stub.sendKey(pb.KeyboardEvent(text=text))


def region_changed(before, after, box):
    x0, y0, x1, y1 = box
    a = before[y0:y1, x0:x1].astype(np.int16)
    b = after[y0:y1, x0:x1].astype(np.int16)
    return int((np.abs(a - b).max(axis=2) > 48).sum())


def scale_box(frame, device_x, device_y, args, half=30):
    height, width = frame.shape[:2]
    content_x = device_x * width / args.device_width
    content_y = device_y * height / args.device_height
    return (max(0, int(content_x - half)), max(0, int(content_y - half)), min(width, int(content_x + half)), min(height, int(content_y + half)))


def cpu_of(pids, seconds):
    processes = []
    for pid in pids:
        try:
            process = psutil.Process(pid)
            processes.append(process)
            processes.extend(process.children(recursive=True))
        except psutil.NoSuchProcess:
            pass
    before = {p.pid: sum(p.cpu_times()[:2]) for p in processes if p.is_running()}
    time.sleep(seconds)
    total = 0.0
    for p in processes:
        try:
            total += sum(p.cpu_times()[:2]) - before.get(p.pid, 0)
        except psutil.NoSuchProcess:
            pass
    return 100 * total / seconds


def percentile(values, share):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(share * len(ordered)))]


def summary(values):
    if not values:
        return None
    return {"n": len(values), "median": round(statistics.median(values), 1), "p95": round(percentile(values, 0.95), 1),
            "min": round(min(values), 1), "max": round(max(values), 1)}


def measure_latency(args, frames, injector):
    points = [(270, 900), (810, 900), (270, 1500), (810, 1500)]
    latencies = []
    misses = 0
    for index in range(args.taps):
        x, y = points[index % len(points)]
        _, before = frames.latest()
        start = now()
        injector.down(x, y)
        changed_at = None
        while now() - start < 2.0 and changed_at is None:
            for stamp, image in frames.wait_after(start, 2.0):
                if image.shape == before.shape and region_changed(before, image, scale_box(image, x, y, args)) > args.threshold:
                    changed_at = stamp
                    break
            start_seen = frames.latest()[0]
            if changed_at is None:
                frames.wait_after(start_seen, 0.05)
        if changed_at is None:
            misses += 1
        else:
            latencies.append(1000 * (changed_at - start))
        time.sleep(0.05)
        injector.up(x, y)
        time.sleep(args.gap)
    return latencies, misses


def busy_loop(args):
    return subprocess.Popen(["adb", "-s", args.serial, "shell",
                             "while true; do input swipe 540 1900 540 500 120; input swipe 540 500 540 1900 120; done"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", choices=SOURCES)
    parser.add_argument("--input", default="grpc", choices=["grpc", "scrcpy", "adb"])
    parser.add_argument("--serial", default="emulator-5554")
    parser.add_argument("--grpc", type=int, default=8554)
    parser.add_argument("--width", type=int, default=0)
    parser.add_argument("--bitrate", type=int, default=8_000_000)
    parser.add_argument("--encoder", default="")
    parser.add_argument("--device-width", type=int, default=1080)
    parser.add_argument("--device-height", type=int, default=2400)
    parser.add_argument("--taps", type=int, default=20)
    parser.add_argument("--gap", type=float, default=0.6)
    parser.add_argument("--threshold", type=int, default=20)
    parser.add_argument("--window-seconds", type=float, default=10.0)
    parser.add_argument("--label", default="")
    parser.add_argument("--save-frame", default="")
    args = parser.parse_args()

    emulator_pid = int(open(os.path.expanduser("~/emulator-phone.pid")).read()) if not os.environ.get("EMULATOR_PID") else int(os.environ["EMULATOR_PID"])
    frames = Frames()
    counter = FrameCounter()
    opened_at = now()
    helpers = SOURCES[args.source](args, frames, counter)
    frames.wait_after(0, 15)
    first_frame_ms = 1000 * (frames.first_at - opened_at) if frames.first_at else None
    time.sleep(1.5)

    helper_pids = [p.pid for p in helpers]
    idle_start = now()
    emulator_idle_cpu = cpu_of([emulator_pid], args.window_seconds)
    idle_fps = len(counter.between(idle_start, now())) / (now() - idle_start)

    busy = busy_loop(args)
    time.sleep(1)
    busy_start = now()
    results = {}

    def measure_helper():
        results["helper_busy_cpu"] = cpu_of(helper_pids, args.window_seconds)

    def measure_viewer():
        process = psutil.Process()
        before = sum(process.cpu_times()[:2])
        time.sleep(args.window_seconds)
        results["viewer_busy_cpu"] = 100 * (sum(process.cpu_times()[:2]) - before) / args.window_seconds

    viewer_thread = threading.Thread(target=measure_viewer)
    viewer_thread.start()

    helper_thread = threading.Thread(target=measure_helper)
    helper_thread.start()
    emulator_busy_cpu = cpu_of([emulator_pid], args.window_seconds)
    helper_thread.join()
    viewer_thread.join()
    busy_stamps = counter.between(busy_start, now())
    busy_fps = len(busy_stamps) / (now() - busy_start)
    gaps = [1000 * (b - a) for a, b in zip(busy_stamps, busy_stamps[1:])]
    busy.terminate()
    subprocess.run(["adb", "-s", args.serial, "shell", "pkill", "-f", "input swipe"], capture_output=True)
    subprocess.run(["adb", "-s", args.serial, "shell", "input", "keyevent", "KEYCODE_HOME"], capture_output=True)
    time.sleep(2)

    stamp, image = frames.latest()
    if args.save_frame and image is not None:
        from PIL import Image
        Image.fromarray(image).save(args.save_frame)

    injector = Injector(args, frames)
    latencies, misses = measure_latency(args, frames, injector)

    report = {
        "label": args.label or f"{args.source}/{args.input}",
        "source": args.source,
        "input": args.input,
        "frame": list(image.shape[:2][::-1]) if image is not None else None,
        "first_frame_ms": round(first_frame_ms, 1) if first_frame_ms else None,
        "idle_fps": round(idle_fps, 1),
        "busy_fps": round(busy_fps, 1),
        "busy_gap_ms": summary(gaps),
        "emulator_cpu_idle_pct": round(emulator_idle_cpu),
        "emulator_cpu_busy_pct": round(emulator_busy_cpu),
        "helper_cpu_busy_pct": round(results["helper_busy_cpu"]),
        "viewer_decode_cpu_busy_pct": round(results["viewer_busy_cpu"]),
        "tap_to_pixels_ms": summary(latencies),
        "misses": misses,
    }
    if getattr(args, "encode_ms", None):
        report["encode_ms_per_frame"] = summary(args.encode_ms)
    print(json.dumps(report), flush=True)
    frames.closed = True
    for helper in helpers:
        helper.terminate()
    os._exit(0)


if __name__ == "__main__":
    main()
