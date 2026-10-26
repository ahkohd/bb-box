"""Drive a simulator through idb_companion as a person's viewer or an agent would.

Run with the Python of a venv that has fb-idb, on the Mac that runs the
simulator, with idb_companion serving it on port 10882.

  python input.py drag              drag up the middle of the screen, as a scroll
  python input.py long X Y          hold a touch at X,Y (points) for 1.2 s
  python input.py paste             press Cmd+V, after `simctl pbcopy`
  python input.py agent             time screenshots and accessibility reads

Every gesture goes through one HID stream held open, as a viewer would
hold it. A touch that moves is a run of touch-down events at new points.
"""

import asyncio
import logging
import statistics
import sys
import time

from idb.common.types import HIDDirection, HIDKey, HIDPress, HIDTouch, Point, TCPAddress
from idb.grpc.client import Client

COMMAND = 227
KEY_V = 25


def touch(x, y, direction):
    return HIDPress(action=HIDTouch(point=Point(x=x, y=y)), direction=direction)


def key(code, direction):
    return HIDPress(action=HIDKey(keycode=code), direction=direction)


async def with_hid(client, gesture):
    queue = asyncio.Queue()

    async def events():
        while True:
            event = await queue.get()
            if event is None:
                return
            yield event

    sending = asyncio.create_task(client.hid(events()))
    await gesture(queue)
    await queue.put(None)
    await sending


async def drag(queue):
    y = 700
    await queue.put(touch(200, y, HIDDirection.DOWN))
    while y > 250:
        await asyncio.sleep(1 / 60)
        y -= 8
        await queue.put(touch(200, y, HIDDirection.DOWN))
    await asyncio.sleep(0.1)
    await queue.put(touch(200, y, HIDDirection.UP))


def long_press(x, y):
    async def gesture(queue):
        await queue.put(touch(x, y, HIDDirection.DOWN))
        await asyncio.sleep(1.2)
        await queue.put(touch(x, y, HIDDirection.UP))

    return gesture


async def paste(queue):
    for event in (
        key(COMMAND, HIDDirection.DOWN),
        key(KEY_V, HIDDirection.DOWN),
        key(KEY_V, HIDDirection.UP),
        key(COMMAND, HIDDirection.UP),
    ):
        await queue.put(event)


async def agent(client):
    calls = (
        ("screenshot", lambda: client.screenshot()),
        ("describe_all", lambda: client.accessibility_info(point=None, nested=False)),
    )
    for name, call in calls:
        times = []
        for _ in range(8):
            started = time.monotonic()
            await call()
            times.append((time.monotonic() - started) * 1000)
        print(name, "median_ms", round(statistics.median(times)), "min", round(min(times)), "max", round(max(times)))


async def main(argv):
    address = TCPAddress(host="localhost", port=10882)
    async with Client.build(address=address, logger=logging.getLogger("input")) as client:
        if argv[0] == "drag":
            await with_hid(client, drag)
        elif argv[0] == "long":
            await with_hid(client, long_press(float(argv[1]), float(argv[2])))
        elif argv[0] == "paste":
            await with_hid(client, paste)
        elif argv[0] == "agent":
            await agent(client)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
