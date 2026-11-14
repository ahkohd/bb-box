import "./check-test-machine.mjs";
// This install's ID (018): made once, kept in plugin storage, and checked
// before an operator sets it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTALL_ID_KEY, isInstallId, loadInstallId, newInstallId, storeInstallId } from "../src/core/install.ts";
import { MemoryStorage } from "./helpers.ts";

test("an install makes its ID once and keeps it", async () => {
  const kv = new MemoryStorage();
  const id = await loadInstallId(kv);
  assert.match(id, /^[a-z0-9]{10}$/);
  assert.equal(await kv.get(INSTALL_ID_KEY), id);
  assert.equal(await loadInstallId(kv), id);
  assert.notEqual(newInstallId(), newInstallId());
});

test("a stored value that is not an ID is replaced", async () => {
  const kv = new MemoryStorage();
  await kv.set(INSTALL_ID_KEY, { id: "k3v9q2m7xa" });
  const id = await loadInstallId(kv);
  assert.ok(isInstallId(id));
  assert.equal(await kv.get(INSTALL_ID_KEY), id);
});

test("an install ID is lowercase letters, digits and hyphens, at most 32, so any provider takes it as a tag or label", async () => {
  for (const id of ["k3v9q2m7xa", "smoke", "conformance-other", "a", "0".repeat(32)]) assert.equal(isInstallId(id), true, id);
  for (const id of ["", "-a", "Smoke", "a_b", "a.b", "a b", "0".repeat(33), 7]) assert.equal(isInstallId(id), false, String(id));
  const kv = new MemoryStorage();
  await assert.rejects(storeInstallId(kv, "Not_An_ID"), /"Not_An_ID" is not an install ID: use lowercase letters, digits and hyphens/);
  assert.equal(await kv.get(INSTALL_ID_KEY), undefined);
  await storeInstallId(kv, "old-install");
  assert.equal(await loadInstallId(kv), "old-install");
});
