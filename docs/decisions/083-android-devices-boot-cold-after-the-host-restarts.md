# Android devices boot cold after the host restarts

Status: accepted
Date: 10 November 2026

Checks and screenshots are in [the results](083-results.md).

## Context

A whole-VM snapshot can hold newer Android disk data than the emulator's
quick-boot save. Loading that save after a restore can replace the restored
data. The unsaved marker protects a running model, but does not establish
which host boot last started another model.

## Decision

Record the Linux boot ID for each model when BB Box starts it. If the ID
is missing or differs from the current host boot, start the emulator cold.
Keep the existing unsaved marker check. The device server still starts the
selected device through its normal startup path.

This extends decision 063's Android boot choice. Later switches within one
host boot can still load quick-boot saves after a clean emulator stop.

## Consequences

Restores and undos start each model from its disk data. First starts after
other host restarts and in fresh boxes also boot cold, so they take longer.
Linux and Windows QEMU paths do not change.
