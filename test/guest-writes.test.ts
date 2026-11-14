import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { COMPOUND_WRITES, GUEST_WRITES } from "../src/backends/proxmox-lxc/owned.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const LXC = "src/backends/proxmox-lxc";
const GATEWAY = `${LXC}/owned.ts`;
const SHARED_WRITERS = ["src/backends/proxmox/forks.ts"];
const SCANNED = [...readdirSync(join(ROOT, LXC)).filter((name) => name.endsWith(".ts")).map((name) => `${LXC}/${name}`), ...SHARED_WRITERS];
const ROUTED = new Set([...GUEST_WRITES, "read", "writeOn"]);

interface Site {
  readonly file: string;
  readonly line: number;
  readonly within: string;
  readonly call: string;
}

function program(): { readonly checker: ts.TypeChecker; readonly sources: ts.SourceFile[] } {
  const made = ts.createProgram(
    SCANNED.map((file) => join(ROOT, file)),
    { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, types: ["node"] },
  );
  return { checker: made.getTypeChecker(), sources: SCANNED.map((file) => made.getSourceFile(join(ROOT, file))!) };
}

function relative(source: ts.SourceFile): string {
  return source.fileName.slice(ROOT.length);
}

function within(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if ((ts.isMethodDeclaration(at) || ts.isFunctionDeclaration(at) || ts.isGetAccessorDeclaration(at)) && at.name) return at.name.getText();
  }
  return "(top level)";
}

function declaredIn(checker: ts.TypeChecker, name: ts.Node): ts.Declaration | undefined {
  const symbol = checker.getSymbolAtLocation(name);
  const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return resolved?.declarations?.[0];
}

function classOf(declaration: ts.Declaration | undefined): string | null {
  const owner = declaration?.parent;
  return owner && (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) && owner.name ? `${relative(owner.getSourceFile())}#${owner.name.text}` : null;
}

function calls(source: ts.SourceFile, visit: (call: ts.CallExpression, member: ts.PropertyAccessExpression) => void): void {
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) visit(node, node.expression);
    ts.forEachChild(node, walk);
  };
  walk(source);
}

function sites(): { readonly direct: Site[]; readonly routed: Site[]; readonly passedRaw: Site[] } {
  const { checker, sources } = program();
  const direct: Site[] = [];
  const routed: Site[] = [];
  const passedRaw: Site[] = [];
  for (const source of sources) {
    const file = relative(source);
    calls(source, (call, member) => {
      const name = member.name.text;
      const site = { file, line: source.getLineAndCharacterOfPosition(call.getStart()).line + 1, within: within(call), call: call.getText().split("\n")[0]!.slice(0, 120) };
      const owner = classOf(declaredIn(checker, member.name));
      if (owner === "src/backends/proxmox/api.ts#Proxmox" && GUEST_WRITES.includes(name)) direct.push(site);
      if ((owner === `${GATEWAY}#OwnedGuests` || owner === "src/backends/proxmox/forks.ts#ForkWrites") && ROUTED.has(name)) routed.push(site);
    });
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        node.arguments.forEach((argument, at) => {
          const parameter = signature?.parameters[at];
          const wanted = parameter && checker.typeToString(checker.getTypeOfSymbolAtLocation(parameter, node));
          const given = checker.typeToString(checker.getTypeAtLocation(argument));
          if (wanted === "ForkWrites" && given === "Proxmox" && file.startsWith(LXC)) passedRaw.push({ file, line: source.getLineAndCharacterOfPosition(argument.getStart()).line + 1, within: within(node), call: node.getText().split("\n")[0]!.slice(0, 120) });
        });
      }
      if (ts.isPropertyAssignment(node) && node.name.getText() === "writes" && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && file.startsWith(LXC) && !node.initializer.getText().includes("this.#writesFor(")) {
        passedRaw.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, within: within(node), call: node.getText().slice(0, 120) });
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return { direct, routed, passedRaw };
}

test("071 unit 5, go review: every guest write in the Proxmox LXC backend, and in the fork module it uses, goes through the one ownership check; none calls Proxmox's writes directly", () => {
  const { direct, routed, passedRaw } = sites();
  const outside = direct.filter((site) => site.file !== GATEWAY);
  assert.deepEqual(outside.map((site) => `${site.file}:${site.line} ${site.within}: ${site.call}`), [], "a write that bypasses the ownership check");
  assert.deepEqual(passedRaw.map((site) => `${site.file}:${site.line} ${site.within}: ${site.call}`), [], "Proxmox's client handed where the fork module writes");
  const compound = direct.filter((site) => COMPOUND_WRITES.some((name) => site.call.includes(`.${name}(`)));
  assert.deepEqual(compound.map((site) => `${site.file}:${site.line} ${site.within}: ${site.call}`), [], "Proxmox's compound writes, which stop, clear protection or read and write again inside, are called nowhere, the gateway included");
  const primitives = [...new Set(direct.filter((site) => site.file === GATEWAY).map((site) => /\.(\w+)\(/.exec(site.call.replace(/^.*this\.#api/, ""))?.[1]))].sort();
  assert.deepEqual(primitives, GUEST_WRITES.filter((name) => !COMPOUND_WRITES.includes(name) && name !== "hibernate").sort(), "the gateway makes each write with Proxmox's single-step calls");
  assert.ok(routed.length >= 40, `${routed.length} routed writes`);
});

test("071 unit 5, go review: the write table in 071-results.md lists every function that writes a guest through the check", () => {
  const { routed } = sites();
  const results = readFileSync(join(ROOT, "docs/decisions/071-results.md"), "utf8");
  const table = /### Every write to a guest\n([\s\S]*?)\n### /.exec(results)?.[1] ?? "";
  assert.ok(table.includes("| --- |"), "the table is there");
  const writers = [...new Set(routed.filter((site) => site.file !== GATEWAY).map((site) => `${site.file.split("/").at(-1)} ${site.within}`))].sort();
  const missing = writers.filter((writer) => !table.includes(`\`${writer.split(" ")[1]}\``));
  assert.deepEqual(missing, [], `the table names each writer: ${writers.join(", ")}`);
});

test("071 unit 5, go review: the helper writes a container only in change_guest, and only from a with_guest callback that holds the guest's config lock and finds it the same guest", () => {
  const helper = readFileSync(join(ROOT, "setup/proxmox-lxc/host/bb-box-gpu"), "utf8").split("\n");
  const subOf = (at: number) => {
    for (let line = at; line >= 0; line--) {
      const match = /^sub (\w+)/.exec(helper[line]!);
      if (match) return match[1]!;
    }
    return null;
  };
  const writes = helper.flatMap((line, at) => (/PVE::LXC::Config->write_config\(/.test(line) ? [at] : []));
  assert.deepEqual(writes.map(subOf), ["change_guest"], "the only container write");
  const changes = helper.flatMap((line, at) => (/\bchange_guest\(\$ctx/.test(line) ? [at] : []));
  assert.ok(changes.length >= 3, `${changes.length} calls of change_guest`);
  for (const at of changes) {
    let opened = -1;
    for (let line = at; line >= 0 && !/^sub /.test(helper[line]!); line--) {
      if (/with_guest\(\$ctx, \$vmid, sub \{/.test(helper[line]!)) {
        opened = line;
        break;
      }
    }
    assert.ok(opened >= 0, `change_guest at line ${at + 1}, in ${subOf(at)}, is inside a with_guest callback`);
    assert.ok(helper.slice(opened, at).some((line) => /same_guest\(/.test(line)), `the callback at line ${opened + 1} checks it is the same guest before it writes`);
  }
  const lock = helper.slice(helper.findIndex((line) => /^sub with_guest/.test(line)), helper.findIndex((line) => /^sub change_guest/.test(line))).join("\n");
  assert.match(lock, /lock_config_full\(\$vmid/);
  const qemu = helper.flatMap((line, at) => (/PVE::QemuConfig->write_config\(/.test(line) ? [subOf(at)] : []));
  assert.deepEqual(qemu, ["write_report"], "its only other write is its own report VM's notes");
});
