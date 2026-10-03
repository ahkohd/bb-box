// bb-box-feature (049): a Dev Container feature from a registry or a tarball, its options and defaults, and its containerEnv.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const SCRIPT = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/bb-box-feature.sh", import.meta.url));
const servers: Server[] = [];
after(() => servers.forEach((server) => server.close()));

/** A feature's files as a tar: its devcontainer-feature.json, and an install.sh that writes what it was given. */
function featureTar(dir: string, spec: object, prefix = ""): Buffer {
  const root = join(dir, "src");
  mkdirSync(join(root, prefix), { recursive: true });
  writeFileSync(join(root, prefix, "devcontainer-feature.json"), JSON.stringify(spec));
  writeFileSync(
    join(root, prefix, "install.sh"),
    '#!/bin/sh\nset -e\nenv | grep -E "^(GREETING|LOUD|NAME_WITH_DASHES|_REMOTE_USER|_CONTAINER_USER_HOME)=" | sort > "$FEATURE_OUT"\n',
    { mode: 0o755 },
  );
  const tar = spawnSync("tar", ["-C", root, "-cf", "-", "."]);
  assert.equal(tar.status, 0, tar.stderr.toString());
  return tar.stdout;
}

const SPEC = {
  id: "hello",
  options: { greeting: { type: "string", default: "hi" }, loud: { type: "boolean", default: false }, "name-with-dashes": { type: "string" } },
  containerEnv: { PATH: "/opt/hello/bin:${PATH}", HELLO_HOME: "/opt/hello", HELLO_CACHE: "${HOME}/.cache/hello" },
  privileged: true,
};

/** A registry that wants an anonymous token, as ghcr.io does, serving one feature; and the same feature as a tarball. */
async function registry(tar: Buffer): Promise<{ host: string; asked: string[] }> {
  const digest = `sha256:${createHash("sha256").update(tar).digest("hex")}`;
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`);
    const url = new URL(request.url!, "http://localhost");
    const authorised = request.headers.authorization === "Bearer anon-token";
    if (url.pathname === "/v2/") {
      response.writeHead(401, { "www-authenticate": `Bearer realm="http://${request.headers.host}/token",service="test-registry"` }).end();
    } else if (url.pathname === "/token") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: url.searchParams.get("scope") === "repository:acme/features/hello:pull" ? "anon-token" : "wrong" }));
    } else if (url.pathname === "/v2/acme/features/hello/manifests/1" && authorised) {
      const manifest = { schemaVersion: 2, layers: [{ mediaType: "application/vnd.devcontainers.layer.v1+tar", digest, size: tar.length }] };
      response.writeHead(200, { "content-type": "application/vnd.oci.image.manifest.v1+json" }).end(JSON.stringify(manifest));
    } else if (url.pathname === `/v2/acme/features/hello/blobs/${digest}` && authorised) {
      response.writeHead(200).end(tar);
    } else if (url.pathname === "/hello.tar") {
      response.writeHead(200).end(tar);
    } else {
      response.writeHead(404).end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { host: `127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

/** Runs the script without blocking, as the registry answers in this process. */
function script(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function run(dir: string, args: string[]) {
  const environment = join(dir, "environment");
  const out = join(dir, "out");
  const result = await script(args, { ...process.env, BB_BOX_FEATURE_SCHEME: "http", BB_BOX_FEATURE_ENVIRONMENT: environment, BB_BOX_FEATURE_ANY_USER: "1", FEATURE_OUT: out });
  return { ...result, environment, out };
}

test("bb-box-feature installs a feature from a registry: an anonymous token, its layer, its options with their defaults, and its containerEnv (049)", async () => {
  const dir = tempDir("feature");
  const { host, asked } = await registry(featureTar(dir, SPEC));
  writeFileSync(join(dir, "environment"), 'PATH="/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin"\nLANG=C.UTF-8\n');
  const ran = await run(dir, [`${host}/acme/features/hello:1`, "loud=true", "name-with-dashes=x y"]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^bb-box-feature: installing hello from 127\.0\.0\.1:\d+\/acme\/features\/hello:1\nbb-box-feature: installed hello\n$/);
  const given = readFileSync(ran.out, "utf8").trim().split("\n");
  assert.deepEqual(
    given.filter((line) => !line.startsWith("_")),
    ["GREETING=hi", "LOUD=true", "NAME_WITH_DASHES=x y"],
    "options upper-cased, with -> _, and the defaults for those not given",
  );
  assert.ok(given.some((line) => /^_REMOTE_USER=./.test(line)) && given.some((line) => /^_CONTAINER_USER_HOME=\//.test(line)), given.join("\n"));
  assert.deepEqual(readFileSync(ran.environment, "utf8").split("\n"), ['PATH="/opt/hello/bin:/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin"', "LANG=C.UTF-8", 'HELLO_HOME="/opt/hello"', ""]);
  assert.match(ran.stderr, /left out HELLO_CACHE=\$\{HOME\}\/\.cache\/hello, which refers to another variable/);
  assert.match(ran.stderr, /hello asks for privileged, which a box's image cannot give/);
  assert.deepEqual(asked.slice(0, 2), ["GET /v2/", "GET /token?service=test-registry&scope=repository:acme/features/hello:pull"]);

  // Again: PATH has the directory once.
  assert.equal((await run(dir, [`${host}/acme/features/hello:1`])).status, 0);
  assert.equal(readFileSync(ran.environment, "utf8").split("\n")[0], 'PATH="/opt/hello/bin:/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin"');
});

test("bb-box-feature takes a tarball's URL, with the feature in a directory of its own, and says what it cannot do (049)", async () => {
  const dir = tempDir("feature-tar");
  const { host } = await registry(featureTar(dir, { id: "hello", options: { greeting: { default: "hello there" } } }, "hello"));
  const ran = await run(dir, [`http://${host}/hello.tar`]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(readFileSync(ran.out, "utf8").includes("GREETING=hello there"));

  const local = await run(dir, ["./.devcontainer/my-feature"]);
  assert.notEqual(local.status, 0);
  assert.match(local.stderr, /is a feature in the project's repository, which a build cannot read/);
  assert.match((await run(dir, [`${host}/acme/features/missing:1`])).stderr, /has no feature acme\/features\/missing:1/);
  assert.match((await run(dir, [`${host}/acme/features/hello:1`, "loud"])).stderr, /an option is <name>=<value>, not loud/);
  const asUser = await script([`${host}/acme/features/hello:1`], { ...process.env, BB_BOX_FEATURE_ANY_USER: "" });
  if (process.getuid?.() !== 0) assert.match(asUser.stderr, /run it as root: sudo bb-box-feature/);
});
