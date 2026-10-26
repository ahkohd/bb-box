import argparse
import asyncio
import json
import logging
import os
import signal
import subprocess
import tempfile
import time

from idb.common.types import AccessibilityInfoOptions, HIDDirection, HIDKey, HIDPress, TCPAddress
from idb.grpc.client import Client

BUNDLE = "com.example.slimprobe"
COMMAND_KEY = 227
V_KEY = 25
SIMCTL = subprocess.run(["xcrun", "-f", "simctl"], capture_output=True, text=True, check=True).stdout.strip()


def simctl(*args, input_text=None, check=True):
    started = time.monotonic()
    done = subprocess.run([SIMCTL, *args], capture_output=True, text=True, input=input_text,
                          env={**os.environ, "LANG": "en_US.UTF-8"})
    if check and done.returncode != 0:
        raise RuntimeError(f"simctl {' '.join(args)}: {done.stderr.strip()}")
    return done.stdout.strip(), round((time.monotonic() - started) * 1000)


class Device:
    def __init__(self, client, udid):
        self.client = client
        self.udid = udid

    async def elements(self):
        raw = await self.client.accessibility_info(None, AccessibilityInfoOptions(nested=False))
        return json.loads(raw.json)

    async def screen(self):
        return (await self.elements())[0]["frame"]

    async def find(self, text, exact=False, key="AXLabel"):
        for element in await self.elements():
            value = str(element.get(key) or "")
            if (value == text) if exact else (text in value):
                return element
        return None

    async def wait_for(self, text, seconds=8.0, exact=False, key="AXLabel"):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            found = await self.find(text, exact, key)
            if found:
                return found
            await asyncio.sleep(0.3)
        return None

    async def tap_element(self, element):
        frame = element["frame"]
        await self.client.tap(x=frame["x"] + frame["width"] / 2, y=frame["y"] + frame["height"] / 2)

    async def tap_label(self, text, seconds=8.0):
        element = await self.wait_for(text, seconds, exact=True)
        if element:
            await self.tap_element(element)
        return bool(element)

    async def tap_id(self, identifier, seconds=8.0):
        element = await self.wait_for(identifier, seconds, exact=True, key="AXUniqueId")
        if element:
            await self.tap_element(element)
        return bool(element)

    async def press_paste(self):
        async def events():
            for code, direction in ((COMMAND_KEY, HIDDirection.DOWN), (V_KEY, HIDDirection.DOWN),
                                    (V_KEY, HIDDirection.UP), (COMMAND_KEY, HIDDirection.UP)):
                yield HIDPress(action=HIDKey(keycode=code), direction=direction)
        await self.client.hid(events())

    async def label_containing(self, prefix):
        for element in await self.elements():
            label = str(element.get("AXLabel") or "")
            if label.startswith(prefix):
                return label
        return None

    async def launch_probe(self):
        simctl("terminate", self.udid, BUNDLE, check=False)
        _, ms = simctl("launch", self.udid, BUNDLE)
        await self.wait_for("taps:", 15)
        return ms


async def answer_alerts(device, seconds=3.0):
    answered = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        tapped = False
        for choice in ("Allow While Using App", "Allow Paste", "Allow", "Continue"):
            element = await device.find(choice, exact=True)
            if element:
                await device.tap_element(element)
                answered.append(choice)
                tapped = True
                await asyncio.sleep(0.8)
                break
        if not tapped:
            await asyncio.sleep(0.3)
    return answered


async def check(results, name, run):
    started = time.monotonic()
    try:
        ok, evidence = await run()
    except Exception as error:
        ok, evidence = False, f"error: {error}"
    results.append({"need": name, "ok": ok, "evidence": evidence, "ms": round((time.monotonic() - started) * 1000)})
    print(("PASS " if ok else "FAIL ") + name + ": " + str(evidence), flush=True)


async def run_all(args):
    udid = args.udid
    results = []

    async def wait_in_log(needle, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if needle in open(args.http_log).read():
                return True
            await asyncio.sleep(0.4)
        return False

    address = TCPAddress(host="localhost", port=args.companion_port)
    async with Client.build(address=address, logger=logging.getLogger("needs")) as client:
        device = Device(client, udid)

        async def install_and_launch():
            simctl("uninstall", udid, BUNDLE, check=False)
            _, install_ms = simctl("install", udid, args.app)
            launch_ms = await device.launch_probe()
            answered = await answer_alerts(device)
            shown = await device.wait_for("taps: 0", 10)
            return bool(shown), f"install {install_ms} ms, launch {launch_ms} ms, alerts answered {answered}"

        async def tree():
            elements = await device.elements()
            return any(str(e.get("AXLabel") or "").startswith("taps:") for e in elements), f"{len(elements)} elements"

        async def hid_tap():
            await device.tap_label("Tap me")
            shown = await device.wait_for("taps: 1", 5)
            return bool(shown), "tap counted" if shown else await device.label_containing("taps:")

        async def typing():
            await device.launch_probe()
            await device.tap_id("input")
            await answer_alerts(device, 1.5)
            await client.text("Hello idb 123")
            shown = await device.wait_for("typed: Hello idb 123", 5, exact=True)
            return bool(shown), await device.label_containing("typed:")

        async def privacy():
            simctl("privacy", udid, "grant", "contacts", BUNDLE)
            simctl("privacy", udid, "grant", "photos", BUNDLE)
            await device.launch_probe()
            await device.tap_label("Refresh access")
            await asyncio.sleep(1)
            label = await device.label_containing("contacts:")
            return bool(label and label.startswith("contacts: 3 photos: 3")), label

        async def location():
            simctl("privacy", udid, "grant", "location", BUNDLE)
            simctl("location", udid, "set", "51.5007,-0.1246")
            await device.launch_probe()
            shown = await device.wait_for("location: 51.5007,-0.1246", 15)
            return bool(shown), shown["AXLabel"] if shown else await device.label_containing("location:")

        async def push():
            payload = {"aps": {"alert": {"title": "probe-push", "body": "from simctl"}}}
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
                json.dump(payload, handle)
            _, ms = simctl("push", udid, BUNDLE, handle.name)
            shown = await device.wait_for("push: probe-push", 10)
            return bool(shown), f"simctl push {ms} ms; " + (shown["AXLabel"] if shown else str(await device.label_containing("push:")))

        async def paste_round_trip():
            text = "probe paste é 😀"
            simctl("pbcopy", udid, input_text=text)
            back, _ = simctl("pbpaste", udid)
            return back == text, f"pbpaste gave {back!r}"

        async def paste_from_suggestion():
            text = "suggested é"
            await device.launch_probe()
            simctl("pbcopy", udid, input_text=text)
            await device.tap_id("input")
            await answer_alerts(device, 1.5)
            q_key = await device.wait_for("Q", 5, exact=True)
            if not q_key:
                return False, "no keyboard"
            screen = await device.screen()
            await client.tap(x=screen["width"] / 2, y=q_key["frame"]["y"] - 36)
            shown = await device.wait_for(f"typed: {text}", 5, exact=True)
            return bool(shown), f"{await device.label_containing('typed:')!r}"

        async def appearance():
            simctl("ui", udid, "appearance", "dark")
            dark, _ = simctl("ui", udid, "appearance")
            simctl("io", udid, "screenshot", os.path.join(args.out, "dark.png"))
            simctl("ui", udid, "appearance", "light")
            light, _ = simctl("ui", udid, "appearance")
            return dark == "dark" and light == "light", f"read back {dark}, {light}; dark.png"

        async def content_size():
            simctl("ui", udid, "content_size", "extra-extra-large")
            large, _ = simctl("ui", udid, "content_size")
            simctl("ui", udid, "content_size", "large")
            normal, _ = simctl("ui", udid, "content_size")
            return large == "extra-extra-large" and normal == "large", f"read back {large}, {normal}"

        async def status_bar():
            simctl("status_bar", udid, "override", "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100")
            listed, _ = simctl("status_bar", udid, "list")
            simctl("io", udid, "screenshot", os.path.join(args.out, "status-bar.png"))
            return "9:41" in listed, f"list shows 9:41: {'9:41' in listed}; status-bar.png"

        async def screenshot():
            path = os.path.join(args.out, "screenshot.png")
            _, ms = simctl("io", udid, "screenshot", path)
            started = time.monotonic()
            shot = await client.screenshot()
            idb_ms = round((time.monotonic() - started) * 1000)
            size = len(shot.data) if hasattr(shot, "data") else len(shot)
            return os.path.getsize(path) > 10000 and size > 10000, f"simctl {ms} ms {os.path.getsize(path)} bytes; idb {idb_ms} ms {size} bytes"

        async def record_video():
            path = os.path.join(args.out, "record.mp4")
            recorder = subprocess.Popen([SIMCTL, "io", udid, "recordVideo", "--codec=h264", "--force", path],
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            started = time.monotonic()
            while time.monotonic() - started < 10:
                line = recorder.stdout.readline()
                if "Recording started" in line or not line:
                    break
            await device.tap_label("Tap me")
            await asyncio.sleep(2)
            recorder.send_signal(signal.SIGINT)
            recorder.wait(20)
            size = os.path.getsize(path) if os.path.exists(path) else 0
            return size > 1000, f"{size} bytes"

        async def safari_page_and_paste():
            text = "safari paste é"
            simctl("pbcopy", udid, input_text=text)
            _, ms = simctl("openurl", udid, "http://127.0.0.1:8765/needs-page.html")
            ran = await wait_in_log("GET /ran-js", 15)
            await asyncio.sleep(1)
            screen = await device.screen()
            await client.tap(x=screen["width"] / 2, y=200)
            await answer_alerts(device, 1.5)
            await device.press_paste()
            by_command_v = await wait_in_log("GET /typed?safari%20paste", 3)
            q_key = await device.wait_for("Q", 5, exact=True)
            if q_key and not by_command_v:
                await client.tap(x=screen["width"] / 2, y=q_key["frame"]["y"] - 36)
            pasted = await wait_in_log("GET /typed?safari%20paste", 6)
            simctl("io", udid, "screenshot", os.path.join(args.out, "safari.png"))
            return ran and pasted, f"openurl {ms} ms; page script ran: {ran}; HID Cmd+V pasted: {by_command_v}; pasted into the page: {pasted}"

        await check(results, "install and launch", install_and_launch)
        await check(results, "accessibility tree", tree)
        await check(results, "HID tap", hid_tap)
        await check(results, "typing as keys", typing)
        await check(results, "privacy grants", privacy)
        await check(results, "location", location)
        await check(results, "push", push)
        await check(results, "pbcopy and pbpaste", paste_round_trip)
        await check(results, "paste from the keyboard's suggestion", paste_from_suggestion)
        await check(results, "appearance", appearance)
        await check(results, "content size", content_size)
        await check(results, "status bar", status_bar)
        await check(results, "screenshot", screenshot)
        await check(results, "recordVideo", record_video)
        await check(results, "Safari: open URL, page script, paste into the page", safari_page_and_paste)

    with open(os.path.join(args.out, "needs.json"), "w") as handle:
        json.dump(results, handle, indent=1)
    passed = sum(1 for r in results if r["ok"])
    print(f"{passed}/{len(results)} passed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--udid", required=True)
    parser.add_argument("--app", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--http-log", required=True)
    parser.add_argument("--companion-port", type=int, default=10882)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    asyncio.run(run_all(args))


if __name__ == "__main__":
    main()
