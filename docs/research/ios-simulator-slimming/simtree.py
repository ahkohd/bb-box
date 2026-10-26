#!/usr/bin/env python3
import argparse
import ctypes
import json
import subprocess
import sys
import time

RUSAGE_INFO_V2 = 2


class RusageInfoV2(ctypes.Structure):
    _fields_ = [
        ("uuid", ctypes.c_uint8 * 16),
        ("user_time", ctypes.c_uint64),
        ("system_time", ctypes.c_uint64),
        ("pkg_idle_wkups", ctypes.c_uint64),
        ("interrupt_wkups", ctypes.c_uint64),
        ("pageins", ctypes.c_uint64),
        ("wired_size", ctypes.c_uint64),
        ("resident_size", ctypes.c_uint64),
        ("phys_footprint", ctypes.c_uint64),
        ("proc_start_abstime", ctypes.c_uint64),
        ("proc_exit_abstime", ctypes.c_uint64),
        ("child_user_time", ctypes.c_uint64),
        ("child_system_time", ctypes.c_uint64),
        ("child_pkg_idle_wkups", ctypes.c_uint64),
        ("child_interrupt_wkups", ctypes.c_uint64),
        ("child_pageins", ctypes.c_uint64),
        ("child_elapsed_abstime", ctypes.c_uint64),
        ("diskio_bytesread", ctypes.c_uint64),
        ("diskio_byteswritten", ctypes.c_uint64),
    ]


class MachTimebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
libc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
timebase = MachTimebase()
libc.mach_timebase_info(ctypes.byref(timebase))


def ticks_to_seconds(ticks):
    return ticks * timebase.numer / timebase.denom / 1e9


def all_processes():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,comm="], capture_output=True, text=True, check=True).stdout
    table = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            table[int(parts[0])] = (int(parts[1]), parts[2])
    return table


def launchd_sim_pid(udid):
    out = subprocess.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        pid, _, args = line.strip().partition(" ")
        if args.startswith("launchd_sim") and udid in args:
            return int(pid)
    return None


def device_tree(udid):
    root = launchd_sim_pid(udid)
    if root is None:
        return None, {}
    table = all_processes()
    children = {}
    for pid, (ppid, _) in table.items():
        children.setdefault(ppid, []).append(pid)
    members = {}
    stack = [root]
    while stack:
        pid = stack.pop()
        if pid in table:
            members[pid] = table[pid][1]
        stack.extend(children.get(pid, []))
    return root, members


def usage(pid):
    info = RusageInfoV2()
    if libc.proc_pid_rusage(pid, RUSAGE_INFO_V2, ctypes.byref(info)) != 0:
        return None
    return {
        "footprint": info.phys_footprint,
        "cpu": ticks_to_seconds(info.user_time + info.system_time),
    }


def snapshot(udid):
    root, members = device_tree(udid)
    processes = []
    for pid, path in members.items():
        measured = usage(pid)
        if measured:
            processes.append({"pid": pid, "name": path.rsplit("/", 1)[-1], **measured})
    return {
        "time": time.time(),
        "launchd_sim": root,
        "processes": len(processes),
        "footprint_mib": round(sum(p["footprint"] for p in processes) / 2**20, 1),
        "cpu_seconds": round(sum(p["cpu"] for p in processes), 2),
        "detail": sorted(processes, key=lambda p: -p["footprint"]),
    }


def idle_cpu(udid, seconds):
    first = snapshot(udid)
    time.sleep(seconds)
    last = snapshot(udid)
    before = {p["pid"]: p["cpu"] for p in first["detail"]}
    spent = 0.0
    per_process = []
    for p in last["detail"]:
        delta = p["cpu"] - before.get(p["pid"], 0.0)
        spent += delta
        per_process.append({"name": p["name"], "cpu": round(delta, 3)})
    per_process.sort(key=lambda p: -p["cpu"])
    return {
        "seconds": seconds,
        "cpu_seconds": round(spent, 2),
        "cores": round(spent / seconds, 4),
        "processes_start": first["processes"],
        "processes_end": last["processes"],
        "footprint_mib_end": last["footprint_mib"],
        "busiest": per_process[:15],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("udid")
    parser.add_argument("--idle", type=int, default=0)
    parser.add_argument("--detail", type=int, default=0)
    args = parser.parse_args()
    if args.idle:
        result = idle_cpu(args.udid, args.idle)
    else:
        result = snapshot(args.udid)
        result["detail"] = result["detail"][: args.detail]
    json.dump(result, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
