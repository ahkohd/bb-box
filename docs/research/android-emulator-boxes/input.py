import json
import os
import re
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
channel = grpc.insecure_channel("127.0.0.1:8554", options=[("grpc.max_receive_message_length", 64 * 1024 * 1024)])
stub = pbg.EmulatorControllerStub(channel)
latest = {"stamp": 0.0, "image": None}
changed = threading.Condition()


def watch():
    for image in stub.streamScreenshot(pb.ImageFormat(format=pb.ImageFormat.RGB888)):
        frame = np.frombuffer(image.image, dtype=np.uint8).reshape(image.format.height, image.format.width, 3)
        with changed:
            latest["stamp"], latest["image"] = time.monotonic(), frame
            changed.notify_all()


def shell(command):
    return subprocess.run(["adb", "-s", SERIAL, "shell", command], capture_output=True, text=True).stdout


def wait_change(before, box, start, timeout=3.0):
    x0, y0, x1, y1 = box
    deadline = start + timeout
    with changed:
        while time.monotonic() < deadline:
            image = latest["image"]
            if latest["stamp"] > start and image.shape == before.shape:
                diff = np.abs(image[y0:y1, x0:x1].astype(np.int16) - before[y0:y1, x0:x1].astype(np.int16)).max(axis=2)
                if (diff > 48).sum() > 20:
                    return 1000 * (latest["stamp"] - start)
            changed.wait(0.05)
    return None


def summary(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    ordered = sorted(values)
    return {"n": len(values), "median": round(statistics.median(values), 1), "p95": round(ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))], 1), "max": round(max(values), 1)}


def touch(points, pressed):
    stub.sendTouch(pb.TouchEvent(touches=[pb.Touch(x=x, y=y, identifier=i, pressure=1 if pressed else 0) for i, (x, y) in enumerate(points)]))


def adb_motion(x, y, pressed):
    subprocess.run(["adb", "-s", SERIAL, "shell", "input", "motionevent", "DOWN" if pressed else "UP", str(x), str(y)], capture_output=True)


def tap_latency(inject, release, taps=12):
    results = []
    for index in range(taps):
        x, y = [(270, 900), (810, 900), (270, 1500), (810, 1500)][index % 4]
        before = latest["image"]
        start = time.monotonic()
        inject(x, y)
        results.append(wait_change(before, (x - 30, y - 30, x + 30, y + 30), start))
        time.sleep(0.05)
        release(x, y)
        time.sleep(0.5)
    return summary(results)


def field_text():
    shell("uiautomator dump /sdcard/u.xml >/dev/null")
    xml = shell("cat /sdcard/u.xml")
    return [t for t in re.findall(r'text="([^"]*)"', xml) if t][:3]


def open_search():
    shell("am start -W -n com.android.settings/.homepage.SettingsHomepageActivity >/dev/null")
    time.sleep(1.5)
    shell("input tap 540 665")
    time.sleep(1.5)


def key_latency(send, label, region, count=8):
    results = []
    for _ in range(count):
        before = latest["image"]
        start = time.monotonic()
        send()
        results.append(wait_change(before, region, start))
        time.sleep(0.4)
    return {"method": label, "key_to_pixels_ms": summary(results)}


def main():
    stub.setPhysicalModel(pb.PhysicalModelValue(target=pb.PhysicalModelValue.ROTATION, value=pb.ParameterValue(data=[0, 0, 0])))
    threading.Thread(target=watch, daemon=True).start()
    while latest["image"] is None:
        time.sleep(0.05)
    report = {}
    shell("settings put system pointer_location 1")
    shell("input keyevent KEYCODE_HOME")
    time.sleep(1)
    report["tap_grpc"] = tap_latency(lambda x, y: touch([(x, y)], True), lambda x, y: touch([(x, y)], False))
    report["tap_adb_motionevent"] = tap_latency(lambda x, y: adb_motion(x, y, True), lambda x, y: adb_motion(x, y, False))

    touch([(300, 1000), (780, 1600)], True)
    time.sleep(0.6)
    report["multitouch_two_fingers_grpc"] = re.findall(r"P: ?\d+ ?/ ?\d+", shell("uiautomator dump /sdcard/u.xml >/dev/null; cat /sdcard/u.xml")) or "see frame"
    from PIL import Image
    Image.fromarray(latest["image"]).save(os.path.expanduser("~/multitouch.png"))
    touch([(300, 1000), (780, 1600)], False)
    shell("settings put system pointer_location 0")

    open_search()
    region = (0, 0, 1080, 400)
    typing = []
    typing.append(key_latency(lambda: stub.sendKey(pb.KeyboardEvent(text="a")), "gRPC sendKey text, one letter", region))
    typing.append(key_latency(lambda: shell("input text b"), "adb input text, one letter", region))
    typing.append(key_latency(lambda: shell("input keyevent KEYCODE_C"), "adb input keyevent", region))
    report["typing_latency"] = typing
    shell("input keyevent --longpress KEYCODE_DEL")
    for _ in range(30):
        shell("input keyevent KEYCODE_DEL")

    samples = {"accented": "héllo ñandú", "cjk": "日本語 中文", "emoji": "🙂👍🏽", "rtl": "مرحبا"}
    typed = {}
    for name, text in samples.items():
        stub.sendKey(pb.KeyboardEvent(text=text))
        time.sleep(1.2)
        typed[f"gRPC text {name}"] = field_text()
        shell("input keyevent KEYCODE_MOVE_END")
        for _ in range(len(text) + 4):
            shell("input keyevent KEYCODE_DEL")
    subprocess.run(["adb", "-s", SERIAL, "shell", "input", "text", "'héllo'"], capture_output=True)
    time.sleep(1)
    typed["adb input text accented"] = field_text()
    for _ in range(10):
        shell("input keyevent KEYCODE_DEL")
    stub.setClipboard(pb.ClipData(text="日本語 🙂 مرحبا"))
    shell("input keyevent KEYCODE_PASTE")
    time.sleep(1)
    typed["gRPC setClipboard then KEYCODE_PASTE"] = field_text()
    report["typing_text"] = typed

    start = time.monotonic()
    shell("uiautomator dump /sdcard/u.xml >/dev/null")
    report["uiautomator_dump_ms"] = round(1000 * (time.monotonic() - start))
    report["uiautomator_dump_bytes"] = len(shell("cat /sdcard/u.xml"))
    print(json.dumps(report, ensure_ascii=False, indent=1), flush=True)
    os._exit(0)


main()
