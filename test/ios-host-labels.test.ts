import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { NAMESPACE_FIELDS } from "../src/backends/namespace/config.ts";
import { SSH_POOL_FIELDS } from "../src/backends/ssh-pool/config.ts";
import { TART_FIELDS } from "../src/backends/tart/config.ts";

const SHARED = [
  "Slots per shared iOS host",
  "Ready slots kept on a shared iOS host",
  "Slots a shared iOS host resets at once",
  "Disk a shared iOS host keeps free (GiB)",
];

test("Tart, the SSH host pool and Namespace use the same shared iOS host labels", () => {
  for (const fields of [TART_FIELDS, SSH_POOL_FIELDS, NAMESPACE_FIELDS]) {
    const labels = Object.values(fields).map((field) => field.label);
    for (const label of SHARED) assert.ok(labels.includes(label), `${label} missing from ${labels.join(", ")}`);
  }
});
