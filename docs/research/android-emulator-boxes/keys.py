import json
import os
import statistics
import subprocess
import sys
import threading
import time

import grpc
import numpy as np

sys.path.insert(0, os.path.expanduser("~/proto"))
import emulator_controller_pb2 as pb
import emulator_controller_pb2_grpc as pbg

SERIAL = "emulator-5554"
stub = pbg.EmulatorControllerStub(grpc.insecure_channel("127.0.0.1:8554", options=[("grpc.max_receive_message_length", 64 * 1024 * 1024)]))
latest = {"stamp": 0.0, "image": None}
changed = threading.Condition()
FIELD = (150, 150, 900, 300)


def watch():
    for image in stub.streamScreenshot(pb.ImageFormat(format=pb.ImageFormat.RGB888)):
        frame = np.frombuffer(image.image, dtype=np.uint8).reshape(image.format.height, image.format.width, 3)
        with changed:
            latest["stamp"], latest["image"] = time.monotonic(), frame
            changed.notify_all()


def wait_change(before, start, timeout=3.0):
    x0, y0, x1, y1 = FIELD
    with changed:
        while time.monotonic() < start + timeout:
            image = latest["image"]
            if latest["stamp"] > start:
                diff = np.abs(image[y0:y1, x0:x1].astype(np.int16) - before[y0:y1, x0:x1].astype(np.int16)).max(axis=2)
                if (diff > 48).sum() > 20:
                    return 1000 * (latest["stamp"] - start)
            changed.wait(0.05)
    return None


def shell(*command):
    subprocess.run(["adb", "-s", SERIAL, "shell", *command], capture_output=True)


def grpc_key(letter):
    for kind in (pb.KeyboardEvent.keydown, pb.KeyboardEvent.keyup):
        stub.sendKey(pb.KeyboardEvent(eventType=kind, key=letter))


def grpc_paste(letter):
    stub.setClipboard(pb.ClipData(text=letter))
    for kind in (pb.KeyboardEvent.keydown, pb.KeyboardEvent.keyup):
        stub.sendKey(pb.KeyboardEvent(eventType=kind, key="Paste"))


METHODS = {
    "gRPC sendKey keydown and keyup": grpc_key,
    "adb input keyevent": lambda letter: shell("input", "keyevent", f"KEYCODE_{letter.upper()}"),
    "adb input text": lambda letter: shell("input", "text", letter),
    "gRPC setClipboard, adb keyevent PASTE": lambda letter: (stub.setClipboard(pb.ClipData(text=letter)), shell("input", "keyevent", "KEYCODE_PASTE")),
}


def main():
    threading.Thread(target=watch, daemon=True).start()
    while latest["image"] is None:
        time.sleep(0.05)
    report = {}
    for name, send in METHODS.items():
        results = []
        for index in range(10):
            if index % 5 == 0:
                shell("input", "keyevent", "KEYCODE_MOVE_END")
                for _ in range(6):
                    shell("input", "keyevent", "KEYCODE_DEL")
                time.sleep(0.8)
            before = latest["image"]
            start = time.monotonic()
            send("abcdefghij"[index])
            results.append(wait_change(before, start))
            time.sleep(0.6)
        found = [r for r in results if r is not None]
        report[name] = {"n": len(found), "median": round(statistics.median(found), 1) if found else None, "max": round(max(found), 1) if found else None}
        print(name, json.dumps(report[name]), flush=True)
    os._exit(0)


main()
