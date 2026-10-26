#!/usr/bin/env python3
import json
import sys


def label_by_pid(launchctl_list_path):
    labels = {}
    for line in open(launchctl_list_path):
        parts = line.rstrip("\n").split("\t")
        if len(parts) == 3 and parts[0].isdigit():
            labels[int(parts[0])] = parts[2]
    return labels


def main():
    run = sys.argv[1]
    settled = json.load(open(f"{run}/settled.json"))
    labels = label_by_pid(f"{run}/launchctl-list.txt")
    rows = []
    for process in settled["detail"]:
        rows.append({
            "label": labels.get(process["pid"], ""),
            "name": process["name"],
            "footprint_mib": round(process["footprint"] / 2**20, 1),
            "cpu_seconds": round(process["cpu"], 2),
        })
    labelled = sum(r["footprint_mib"] for r in rows if r["label"])
    unlabelled = sum(r["footprint_mib"] for r in rows if not r["label"])
    json.dump({
        "processes": len(rows),
        "labelled_mib": round(labelled, 1),
        "unlabelled_mib": round(unlabelled, 1),
        "rows": rows,
    }, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
