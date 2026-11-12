import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SECRET_MASK, fieldSecrecy, focusVerdict, focusedFieldScript, maskSecret, parseFocusedProbe, readSecretFile, removeSecretFile, withValueHidden, withoutTrailingNewline, type FocusedProbe, type RunInBox } from "../src/core/secret-file.ts";
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

test("the field with the focus is the target only with its name and frame, and is typed into only when it reports itself a password field", () => {
  const frame = { x: 95, y: 206, width: 178, height: 22 };
  const password = { role: "Edit", label: "Password", frame };
  const probe = (changes: Partial<FocusedProbe>): FocusedProbe => ({ trusted: true, role: "Edit", name: "Password", secure: true, frame, ...changes });
  assert.equal(focusVerdict(probe({}), password), "secure");
  assert.equal(focusVerdict(probe({ frame: { ...frame, x: 98 } }), password), "secure", "within a few pixels");
  assert.equal(focusVerdict(probe({ secure: false }), password), "plain");
  assert.equal(focusVerdict(probe({ role: "text", secure: false }), { ...password, role: "password text" }), "plain", "a field that turned into plain text as it got the focus");
  assert.equal(focusVerdict(probe({ role: "Document" }), password), "elsewhere");
  assert.equal(focusVerdict(probe({ name: "Search" }), password), "elsewhere");
  assert.equal(focusVerdict(probe({ frame: { ...frame, y: 300 } }), password), "elsewhere", "another field of the same name");
  assert.equal(focusVerdict(probe({ frame: null }), password), "secure", "where the platform gives no frame, the name and role decide");
  assert.equal(focusVerdict(probe({ identifier: "secure" }), { ...password, identifier: "plain" }), "elsewhere", "an overlay of the same name, role and frame, told apart by its automation ID");
  assert.equal(focusVerdict(probe({ identifier: "password" }), { ...password, identifier: "password" }), "secure");
  assert.equal(focusVerdict(probe({ frame: null, samePlace: false }), { ...password, role: "AXTextField" }), "elsewhere", "on macOS the focused element is not the one at the field's place");
  assert.equal(focusVerdict(probe({ role: "AXTextField", frame: null, samePlace: true }), { ...password, role: "AXTextField" }), "secure");
  assert.equal(focusVerdict(probe({ role: null }), password), "elsewhere", "nothing has the focus");
  assert.equal(focusVerdict(probe({ trusted: false }), password), "unknown", "an answer without the Accessibility grant is not trusted, whatever it says");
  assert.equal(focusVerdict(null, password), "unknown");
  assert.deepEqual(parseFocusedProbe('noise\n{"trusted":true,"role":"Edit","name":"Password","secure":true,"frame":[95,206,178,22],"identifier":"password"}\n'), { trusted: true, role: "Edit", name: "Password", secure: true, frame, identifier: "password", samePlace: null });
  assert.equal(parseFocusedProbe("not json"), null);
  assert.equal(focusedFieldScript("macos", 3621)!.includes("AXUIElementCreateApplication(3621), \"AXFocusedUIElement\""), true);
  assert.match(focusedFieldScript("macos", 3621, { x: 204, y: 308 })!, /AXUIElementCopyElementAtPosition\(\$\.AXUIElementCreateSystemWide\(\), 204, 308, at\) === 0 && \$\.CFEqual\(focused/);
  assert.match(focusedFieldScript("windows", 0)!, /AutomationElement\]::FocusedElement[\s\S]*IsPassword/);
  assert.match(focusedFieldScript("linux", 1418)!, /python3 - 1418[\s\S]*GetState[\s\S]*password text/);
});

test("a value in a tree line is hidden whatever it holds", () => {
  assert.equal(withValueHidden('- [e15] AXTextField "Password" = "••••" [actions=[press]]'), '- [e15] AXTextField "Password" = "(hidden)" [actions=[press]]');
  assert.equal(withValueHidden('- [e20] Edit "Password" [value="a\\"b c" id=password actions=[set_value,text]]'), '- [e20] Edit "Password" [value="(hidden)" id=password actions=[set_value,text]]');
  assert.equal(withValueHidden('- [e26] password text "Password" [actions=[activate]]'), '- [e26] password text "Password" [actions=[activate]]');
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
