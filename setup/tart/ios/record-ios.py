import json
import sys


def fields(line, key):
    return line[len(key) + 1:].rstrip("\n").split("\t")


def ios_record(base, build_lines, build_id, built, pins, size_gib):
    runtime = slim = encoders = None
    devices = []
    for line in build_lines:
        if line.startswith("runtime="):
            os_version, os_build, xcode, companion, _ = fields(line, "runtime")
            runtime = {"platform": "ios", "os": os_version, "build": os_build, "xcode": xcode, "companion": companion}
        elif line.startswith("slim="):
            name, labels, sha256 = fields(line, "slim")
            slim = {"list": name, "labels": int(labels), "sha256": sha256}
        elif line.startswith("encoders="):
            hardware, software = fields(line, "encoders")[:2]
            encoders = {"hardware": {"yes": True, "no": False}.get(hardware), "software": software or None}
        elif line.startswith("device="):
            model, native = fields(line, "device")[:2]
            devices.append({"model": model, "native": native})
    if not runtime or not devices:
        sys.exit("record-ios: the build printed no runtime or no devices")
    tools = dict(base.get("tools", {}))
    tools["idb_companion"] = runtime["companion"]
    if encoders and encoders["software"]:
        tools["bb-box-h264"] = encoders["software"]
    return {
        "contract": base["contract"],
        "image": "standard",
        "kind": "ios",
        "arch": base.get("arch", "arm64"),
        "build": build_id,
        "built": built,
        "base": base["build"],
        "os": base.get("os"),
        "aptSnapshot": None,
        "pins": pins,
        "bbApp": base.get("bbApp"),
        "tools": tools,
        "nvidia": None,
        "layer": None,
        "sizeGiB": size_gib,
        "devices": [{**device, "runtime": runtime, **({"slim": slim} if slim else {})} for device in devices],
        **({"encoders": encoders} if encoders else {}),
    }


def main():
    base_path, build_output, build_id, built, pins = sys.argv[1:6]
    size_gib = float(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6] else None
    with open(base_path) as base_file, open(build_output) as lines:
        record = ios_record(json.load(base_file), lines.readlines(), build_id, built, pins, size_gib)
    print(json.dumps(record, separators=(",", ":")))


if __name__ == "__main__":
    main()
