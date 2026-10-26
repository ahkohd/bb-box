import argparse
import json
import os
import subprocess
import sys
import time

import grpc

sys.path.insert(0, os.path.expanduser("~/proto"))
import emulator_controller_pb2 as pb
import emulator_controller_pb2_grpc as pbg
from google.protobuf import empty_pb2


def shell(serial, command):
    return subprocess.run(["adb", "-s", serial, "shell", command], capture_output=True, text=True).stdout.strip()


def console(serial, command):
    return subprocess.run(["adb", "-s", serial, "emu", *command.split()], capture_output=True, text=True).stdout.strip()


def timed(name, action, check, results):
    start = time.monotonic()
    try:
        action()
        took = round(1000 * (time.monotonic() - start))
        time.sleep(0.8)
        seen = check()
    except Exception as error:
        took, seen = None, f"error: {error}"
    results.append({"control": name, "ms": took, "seen": seen})
    print(json.dumps(results[-1]), flush=True)


def foreground(serial):
    lines = shell(serial, "dumpsys activity activities | grep -m1 topResumedActivity")
    return lines.split()[-2] if lines else ""


def rotation(serial):
    return shell(serial, "dumpsys window | grep -m1 -o 'mDisplayRotation=ROTATION_[0-9]*'") + " " + shell(serial, "wm size | tail -1")


def display_size(serial):
    return shell(serial, "wm size | tail -1") + " " + shell(serial, "dumpsys device_state | grep -m1 'mCommittedState'")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default="emulator-5554")
    parser.add_argument("--grpc", type=int, default=8554)
    parser.add_argument("--set", default="phone", choices=["phone", "fold", "resizable"])
    args = parser.parse_args()
    serial = args.serial
    stub = pbg.EmulatorControllerStub(grpc.insecure_channel(f"127.0.0.1:{args.grpc}", options=[("grpc.max_receive_message_length", 64 * 1024 * 1024)]))
    results = []

    if args.set == "phone":
        shell(serial, "am start -a android.settings.SETTINGS")
        time.sleep(1.5)
        timed("home: adb keyevent", lambda: shell(serial, "input keyevent KEYCODE_HOME"), lambda: foreground(serial), results)
        shell(serial, "am start -a android.settings.SETTINGS")
        time.sleep(1.5)
        timed("home: gRPC sendKey GoHome", lambda: [stub.sendKey(pb.KeyboardEvent(eventType=kind, key="GoHome")) for kind in (pb.KeyboardEvent.keydown, pb.KeyboardEvent.keyup)], lambda: foreground(serial), results)
        shell(serial, "am start -a android.settings.SETTINGS")
        time.sleep(1.5)
        timed("back: gRPC sendKey GoBack", lambda: [stub.sendKey(pb.KeyboardEvent(eventType=kind, key="GoBack")) for kind in (pb.KeyboardEvent.keydown, pb.KeyboardEvent.keyup)], lambda: foreground(serial), results)
        timed("recents: adb keyevent APP_SWITCH", lambda: shell(serial, "input keyevent KEYCODE_APP_SWITCH"), lambda: foreground(serial), results)
        shell(serial, "input keyevent KEYCODE_HOME")
        timed("rotate: console rotate", lambda: console(serial, "rotate"), lambda: rotation(serial), results)
        timed("rotate: console rotate (back)", lambda: [console(serial, "rotate") for _ in range(3)], lambda: rotation(serial), results)
        timed("rotate: settings user_rotation 1", lambda: shell(serial, "settings put system accelerometer_rotation 0; settings put system user_rotation 1"), lambda: rotation(serial), results)
        timed("rotate: settings user_rotation 0", lambda: shell(serial, "settings put system user_rotation 0; settings put system accelerometer_rotation 1"), lambda: rotation(serial), results)
        timed("rotate: gRPC setPhysicalModel ROTATION z=-90", lambda: stub.setPhysicalModel(pb.PhysicalModelValue(target=pb.PhysicalModelValue.ROTATION, value=pb.ParameterValue(data=[0, 0, -90]))), lambda: rotation(serial), results)
        timed("rotate: gRPC setPhysicalModel ROTATION z=0", lambda: stub.setPhysicalModel(pb.PhysicalModelValue(target=pb.PhysicalModelValue.ROTATION, value=pb.ParameterValue(data=[0, 0, 0]))), lambda: rotation(serial), results)
        timed("dark mode on: cmd uimode", lambda: shell(serial, "cmd uimode night yes"), lambda: shell(serial, "cmd uimode night"), results)
        timed("dark mode off: cmd uimode", lambda: shell(serial, "cmd uimode night no"), lambda: shell(serial, "cmd uimode night"), results)
        timed("font scale 1.3: settings", lambda: shell(serial, "settings put system font_scale 1.3"), lambda: shell(serial, "settings get system font_scale"), results)
        shell(serial, "settings put system font_scale 1.0")
        timed("display size: wm density 480", lambda: shell(serial, "wm density 480"), lambda: shell(serial, "wm density"), results)
        shell(serial, "wm density reset")
        timed("location: console geo fix", lambda: console(serial, "geo fix -0.1276 51.5072"), lambda: str(stub.getGps(empty_pb2.Empty())).replace("\n", " "), results)
        timed("location: gRPC setGps", lambda: stub.setGps(pb.GpsState(passiveUpdate=False, latitude=48.8566, longitude=2.3522, altitude=35, speed=0, bearing=0, satellites=8)), lambda: shell(serial, "dumpsys location | grep -m1 -i 'last location'"), results)
        timed("battery 15%, unplugged: console power", lambda: (console(serial, "power capacity 15"), console(serial, "power ac off"), console(serial, "power status discharging")), lambda: shell(serial, "dumpsys battery | grep -E 'level|AC powered|status'").replace("\n", " "), results)
        timed("battery 80%, charging: gRPC setBattery", lambda: stub.setBattery(pb.BatteryState(hasBattery=True, isPresent=True, charger=pb.BatteryState.AC, chargeLevel=80, health=pb.BatteryState.GOOD, status=pb.BatteryState.CHARGING)), lambda: shell(serial, "dumpsys battery | grep -E 'level|AC powered|status'").replace("\n", " "), results)
        timed("airplane mode on: cmd connectivity", lambda: shell(serial, "cmd connectivity airplane-mode enable"), lambda: shell(serial, "cmd connectivity airplane-mode"), results)
        timed("airplane mode off: cmd connectivity", lambda: shell(serial, "cmd connectivity airplane-mode disable"), lambda: shell(serial, "cmd connectivity airplane-mode"), results)
        timed("wifi off: svc wifi", lambda: shell(serial, "svc wifi disable"), lambda: shell(serial, "cmd wifi status | head -1"), results)
        timed("wifi on: svc wifi", lambda: shell(serial, "svc wifi enable"), lambda: shell(serial, "cmd wifi status | head -1"), results)
        timed("mobile data off: svc data", lambda: shell(serial, "svc data disable"), lambda: shell(serial, "settings get global mobile_data"), results)
        shell(serial, "svc data enable")
        timed("network speed edge: console network speed", lambda: console(serial, "network speed edge"), lambda: console(serial, "network status").replace("\n", " "), results)
        timed("network delay umts: console network delay", lambda: console(serial, "network delay umts"), lambda: console(serial, "network status").replace("\n", " "), results)
        console(serial, "network speed full")
        console(serial, "network delay none")
        timed("screenshot: adb exec-out screencap -p", lambda: open("/tmp/s-adb.png", "wb").write(subprocess.run(["adb", "-s", serial, "exec-out", "screencap", "-p"], capture_output=True).stdout), lambda: os.path.getsize("/tmp/s-adb.png"), results)
        timed("screenshot: gRPC getScreenshot PNG", lambda: open("/tmp/s-grpc.png", "wb").write(stub.getScreenshot(pb.ImageFormat(format=pb.ImageFormat.PNG)).image), lambda: os.path.getsize("/tmp/s-grpc.png"), results)
        timed("screenshot: gRPC getScreenshot RGB888", lambda: stub.getScreenshot(pb.ImageFormat(format=pb.ImageFormat.RGB888)), lambda: "raw", results)
        timed("clipboard: gRPC setClipboard", lambda: stub.setClipboard(pb.ClipData(text="héllo 世界 🙂")), lambda: stub.getClipboard(empty_pb2.Empty()).text, results)
        timed("volume up: gRPC sendKey AudioVolumeUp", lambda: [stub.sendKey(pb.KeyboardEvent(eventType=kind, key="AudioVolumeUp")) for kind in (pb.KeyboardEvent.keydown, pb.KeyboardEvent.keyup)], lambda: shell(serial, "cmd media_session volume --stream 3 --get | tail -1"), results)
        timed("power button: adb keyevent POWER", lambda: shell(serial, "input keyevent KEYCODE_POWER"), lambda: shell(serial, "dumpsys power | grep -m1 mWakefulness="), results)
        shell(serial, "input keyevent KEYCODE_WAKEUP")
        timed("brightness: gRPC setBrightness", lambda: stub.setBrightness(pb.BrightnessValue(target=pb.BrightnessValue.LCD, value=40)), lambda: str(stub.getBrightness(pb.BrightnessValue(target=pb.BrightnessValue.LCD))).replace("\n", " "), results)
        timed("status: gRPC getStatus", lambda: stub.getStatus(empty_pb2.Empty()), lambda: "ok", results)

    if args.set == "fold":
        for name, value in [("closed", 1), ("half opened", 2), ("opened", 3), ("tent", 5), ("flipped", 4)]:
            timed(f"posture {name}: gRPC setPosture", lambda value=value: stub.setPosture(pb.Posture(value=value)), lambda: display_size(serial), results)
        timed("fold: console fold", lambda: console(serial, "fold"), lambda: display_size(serial), results)
        timed("unfold: console unfold", lambda: console(serial, "unfold"), lambda: display_size(serial), results)
        timed("posture via hinge angle 90: console sensor set hinge-angle0", lambda: console(serial, "sensor set hinge-angle0 90"), lambda: display_size(serial), results)
        timed("posture via hinge angle 180", lambda: console(serial, "sensor set hinge-angle0 180"), lambda: display_size(serial), results)
        timed("display configurations: gRPC", lambda: None, lambda: str(stub.getDisplayConfigurations(empty_pb2.Empty())).replace("\n", " ")[:300], results)

    if args.set == "resizable":
        for name, value in [("foldable", pb.FOLDABLE), ("tablet", pb.TABLET), ("desktop", pb.DESKTOP), ("phone", pb.PHONE)]:
            timed(f"profile {name}: gRPC setDisplayMode", lambda value=value: stub.setDisplayMode(pb.DisplayMode(value=value)), lambda: shell(serial, "wm size | tail -1; wm density | tail -1").replace("\n", " "), results)

    with open(os.path.expanduser(f"~/controls-{args.set}.json"), "w") as out:
        json.dump(results, out, indent=1)


if __name__ == "__main__":
    main()
