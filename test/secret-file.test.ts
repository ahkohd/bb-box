import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SECRET_MASK, fieldSecrecy, maskSecret, parseSecureProbe, readSecretFile, removeSecretFile, secureFieldScript, secureVerdict, withoutTrailingNewline, type RunInBox } from "../src/core/secret-file.ts";
import { tempDir } from "./helpers.ts";

const SECRET = "Vq7#mZ2!pL9$wR4xT8kN";

const runIn = (cwd: string): RunInBox => async (script, options) => {
  const done = spawnSync("sh", ["-c", script], { encoding: "utf8", timeout: options.timeoutMs, cwd });
  const stdout = done.stdout ?? "";
  return { exitCode: done.status, stdout: stdout.slice(0, options.maxOutputBytes), stderr: done.stderr ?? "", timedOut: false, truncated: stdout.length > options.maxOutputBytes, durationMs: 1 };
};

const runHere = runIn(process.cwd());

test("a field's role says whether it hides what is typed: password fields do, text fields and documents show it, and macOS's and Windows' plain text fields may be either", () => {
  for (const role of ["password text", "AXSecureTextField", "secure text field"]) assert.equal(fieldSecrecy("linux", role), "hides", role);
  for (const role of ["text", "entry", "text field", "document web", "terminal", "combo box"]) assert.equal(fieldSecrecy("linux", role), "shows", role);
  for (const role of ["AXSearchField", "AXTextArea", "AXComboBox", "AXWebArea", "text field"]) assert.equal(fieldSecrecy("macos", role), "shows", role);
  assert.equal(fieldSecrecy("macos", "AXTextField"), "unknown", "Chrome on macOS gives a password input this role, as Cua reads it");
  assert.equal(fieldSecrecy("windows", "Edit"), "unknown");
  assert.equal(fieldSecrecy("windows", "Document"), "shows");
  assert.equal(fieldSecrecy("windows", "PasswordBox"), "hides");
  assert.equal(fieldSecrecy("linux", "group"), "unknown");
});

test("on macOS and Windows a field is confirmed secure only when the element at its point is it, by role and name, and the platform says it hides its text", () => {
  const password = { role: "AXTextField", label: "Password" };
  assert.equal(secureVerdict({ trusted: true, role: "AXTextField", name: "Password", secure: true }, password), "secure");
  assert.equal(secureVerdict({ trusted: true, role: "AXTextField", name: "Password", secure: false }, password), "plain");
  assert.equal(secureVerdict({ trusted: true, role: "AXTextField", name: "Search", secure: true }, password), "unknown", "another element at its point");
  assert.equal(secureVerdict({ trusted: true, role: "AXButton", name: "Password", secure: true }, password), "unknown");
  assert.equal(secureVerdict({ trusted: false, role: null, name: null, secure: false }, password), "unknown", "no Accessibility grant");
  assert.equal(secureVerdict({ trusted: false, role: "AXTextField", name: "Password", secure: true }, password), "unknown", "an answer without the grant is not trusted, whatever it says");
  assert.equal(secureVerdict(null, password), "unknown");
  assert.equal(secureVerdict({ trusted: true, role: "Edit", name: " Password ", secure: true }, { role: "Edit", label: "Password" }), "secure");
  assert.deepEqual(parseSecureProbe('noise\n{"trusted":true,"role":"Edit","name":"Password","secure":true}\n'), { trusted: true, role: "Edit", name: "Password", secure: true });
  assert.equal(parseSecureProbe("not json"), null);
  assert.equal(secureFieldScript("linux", { x: 1, y: 2 }), null, "AT-SPI's role says it on Linux");
  assert.match(secureFieldScript("macos", { x: 169, y: 268 })!, /AXUIElementCopyElementAtPosition\(\$\.AXUIElementCreateSystemWide\(\), 169, 268, found\)[\s\S]*AXSubrole/);
  assert.match(secureFieldScript("windows", { x: 184, y: 217 })!, /FromPoint\(\[System\.Windows\.Point\]::new\(184, 217\)\)[\s\S]*IsPassword/);
});

test("one line break at a file's end is left out, as op read > file adds one", () => {
  assert.equal(withoutTrailingNewline(`${SECRET}\n`), SECRET);
  assert.equal(withoutTrailingNewline(`${SECRET}\r\n`), SECRET);
  assert.equal(withoutTrailingNewline(`${SECRET}\n\n`), `${SECRET}\n`);
  assert.equal(withoutTrailingNewline(SECRET), SECRET);
});

test("the mask replaces a secret wherever it appears, also as JSON writes it", () => {
  const quoted = 'p"a\\ss';
  assert.equal(maskSecret(`value="${SECRET}" and ${SECRET}`, SECRET), `value="${SECRET_MASK}" and ${SECRET_MASK}`);
  assert.equal(maskSecret(`value=${JSON.stringify(quoted)}`, quoted), `value="${SECRET_MASK}"`);
  assert.equal(maskSecret("nothing here", SECRET), "nothing here");
});

test("a secret's file is read in the box, refused when missing, not a file, unreadable, empty or over 4 KiB, and deleted on request", async () => {
  const dir = tempDir("secret-file");
  const read = (name: string) => readSecretFile(runHere, "linux", join(dir, name));
  writeFileSync(join(dir, "pw"), `${SECRET}\n`);
  writeFileSync(join(dir, "crlf"), `${SECRET}\r\n`);
  writeFileSync(join(dir, "most"), "a".repeat(4096));
  writeFileSync(join(dir, "large"), "a".repeat(5 * 1024));
  writeFileSync(join(dir, "empty"), "");
  writeFileSync(join(dir, "newline"), "\n");
  mkdirSync(join(dir, "folder"));
  writeFileSync(join(dir, "locked"), SECRET);
  chmodSync(join(dir, "locked"), 0o000);

  assert.deepEqual(await read("pw"), { ok: true, secret: SECRET });
  assert.deepEqual(await read("crlf"), { ok: true, secret: SECRET });
  assert.deepEqual(await read("most"), { ok: true, secret: "a".repeat(4096) });
  const refusals = await Promise.all(["missing", "folder", "empty", "newline", "large", ...(process.getuid?.() === 0 ? [] : ["locked"])].map(read));
  assert.deepEqual(
    refusals.map((refusal) => (refusal.ok ? "read" : refusal.reason.replace(`${dir}/`, ""))),
    [
      "missing does not exist in the box. BB Box typed nothing.",
      "folder is not a regular file, such as a folder. BB Box typed nothing.",
      "empty is empty. BB Box typed nothing.",
      "newline holds only a line break. BB Box typed nothing.",
      "large is larger than 4 KiB, the most BB Box types from a file. BB Box typed nothing.",
      ...(process.getuid?.() === 0 ? [] : ["The box user cannot read locked. BB Box typed nothing."]),
    ],
  );

  assert.equal(await removeSecretFile(runHere, "linux", join(dir, "pw")), true);
  assert.equal(existsSync(join(dir, "pw")), false);

  writeFileSync(join(dir, "-dash"), SECRET);
  assert.deepEqual(await readSecretFile(runIn(dir), "linux", "-dash"), { ok: true, secret: SECRET }, "a name that starts with a dash is a file, not an option");
  assert.equal(await removeSecretFile(runIn(dir), "linux", "-dash"), true);
});
