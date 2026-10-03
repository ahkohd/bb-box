// Drafting a project image's script from the project's files (049).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { draftImage, parseDockerfile, parseJsonc, type Draft } from "../src/core/draft.ts";

/** A draft whose script and check bash can parse. */
function drafted(files: { path: string; text: string }[]): Draft {
  const draft = draftImage(files);
  for (const [name, text] of [["script", draft.script], ["check", draft.check]] as const) {
    const parsed = spawnSync("bash", ["-n"], { input: text, encoding: "utf8" });
    assert.equal(parsed.status, 0, `the ${name} parses: ${parsed.stderr}\n${text}`);
  }
  return draft;
}
const order = (script: string, ...parts: string[]) => {
  const at = parts.map((part) => script.indexOf(part));
  assert.ok(at.every((index) => index >= 0), `all of ${parts.join(" | ")} are in:\n${script}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, `in that order:\n${script}`);
};

test("devcontainer.json: its Dockerfile, then features as standard images have them, mise or bb-box-feature, its variables, and its commands commented out (049)", () => {
  const draft = drafted([
    {
      path: ".devcontainer/devcontainer.json",
      text: `{
  // A comment, and a URL that is not one: https://example.com
  "name": "app",
  "build": { "dockerfile": "Dockerfile", "context": ".." },
  "features": {
    "ghcr.io/devcontainers/features/docker-in-docker:2": {},
    "ghcr.io/devcontainers/features/github-cli:1": {},
    "ghcr.io/devcontainers/features/node:1": { "version": "20" },
    "ghcr.io/devcontainers/features/terraform:1": { "version": "1.9", "installTFsec": true },
    "./local-feature": {},
  },
  /* Its variables. */
  "containerEnv": { "APP_ENV": "dev", "WORK": "\${containerWorkspaceFolder}/x" },
  "postCreateCommand": "npm ci",
  "remoteUser": "vscode",
}`,
    },
    { path: ".devcontainer/Dockerfile", text: "FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04\nRUN apt-get update && apt-get install -y libpq-dev\n" },
  ]);
  assert.deepEqual(draft.used, [".devcontainer/devcontainer.json", ".devcontainer/Dockerfile"]);
  order(
    draft.script,
    "# From .devcontainer/Dockerfile.",
    "apt-get update && apt-get install -y libpq-dev",
    "# ghcr.io/devcontainers/features/docker-in-docker:2: standard images have Docker",
    "# ghcr.io/devcontainers/features/github-cli:1: standard images have gh.",
    "bb-box-feature 'ghcr.io/devcontainers/features/terraform:1' 'version=1.9' 'installTFsec=true'",
    "set_env APP_ENV 'dev'",
    "~/.local/bin/mise use --global 'node@20'  # .devcontainer/devcontainer.json",
    'path_first "$BOX_HOME/.local/share/mise/shims"',
    "# npm ci",
  );
  assert.deepEqual(draft.gaps, [
    ".devcontainer/devcontainer.json: the feature ./local-feature is in the repository, which a build cannot read: copy its install.sh into the script.",
    ".devcontainer/devcontainer.json containerEnv: WORK=${containerWorkspaceFolder}/x refers to another variable or the workspace; set it in the script if the box needs it.",
    ".devcontainer/devcontainer.json: postCreateCommand is commented out: keep in the script only what needs no checkout.",
    ".devcontainer/devcontainer.json: its user, vscode, is the box user in a box.",
  ]);
  assert.ok(draft.script.includes("# To do, from the draft:\n# - .devcontainer/devcontainer.json: the feature ./local-feature"));
  assert.match(draft.check, /\nnode --version\n$/);
});

test("a Dockerfile: its last stage's RUN lines in order, ENV and ARG, USER as the box user, and what a build cannot do (049)", () => {
  const draft = drafted([
    {
      path: "Dockerfile",
      text: [
        "# syntax=docker/dockerfile:1",
        "FROM golang:1.22 AS build",
        "RUN go build ./...",
        "FROM python:3.11-slim",
        "ARG VERSION=3",
        "ARG TOKEN",
        'ENV APP_HOME=/opt/app PYTHONUNBUFFERED="1"',
        "ENV LEGACY value with spaces",
        "RUN apt-get update \\",
        "  # a comment inside",
        "  && apt-get install -y curl",
        "WORKDIR /opt/app",
        "COPY requirements.txt .",
        'RUN ["pip", "install", "uv"]',
        "USER app",
        "RUN <<EOF",
        "echo one",
        "echo two",
        "EOF",
        "USER root",
        "RUN echo back to root",
        'CMD ["python", "app.py"]',
      ].join("\n"),
    },
  ]);
  order(
    draft.script,
    "export VERSION='3'",
    "export APP_HOME='/opt/app'",
    "set_env APP_HOME '/opt/app'",
    "set_env PYTHONUNBUFFERED '1'",
    "export LEGACY='value with spaces'",
    "apt-get update \\\n  && apt-get install -y curl",
    "mkdir -p '/opt/app' && cd '/opt/app'",
    "# COPY requirements.txt .: a build has no checkout to copy from.",
    "'pip' 'install' 'uv'",
    `sudo -iu "$BOX_USER" bash -se <<'BB_BOX_AS_USER'\necho one\necho two\nBB_BOX_AS_USER`,
    "echo back to root",
    "~/.local/bin/mise use --global 'python@3.11'  # Dockerfile FROM",
  );
  assert.ok(!draft.script.includes("go build"), "only the last stage");
  assert.deepEqual(draft.gaps, [
    "Dockerfile: it has 2 stages; the draft takes the last, and what it copies from the others is left to you.",
    "Dockerfile: ARG TOKEN has no default: set it in the script.",
    "Dockerfile: COPY requirements.txt . is commented out: a build has no checkout; fetch the file, write it in the script, or leave it to the thread.",
    'Dockerfile: CMD ["python", "app.py"] is left out: a box runs no container command; start it in the thread.',
  ]);
  assert.deepEqual(
    parseDockerfile("FROM alpine\nRUN apk add curl\n").map((one) => one.keyword),
    ["FROM", "RUN"],
  );
  assert.match(draftImage([{ path: "Dockerfile", text: "FROM alpine:3.20\nRUN apk add curl\n" }]).gaps[0]!, /its base, alpine:3\.20, is not Ubuntu or Debian/);
});

test("version files: mise for the box user, what standard images have left out, and the first of two versions (049)", () => {
  const draft = drafted([
    { path: ".tool-versions", text: "nodejs 20.11.0 # pinned\ngolang 1.22.1\n" },
    { path: ".nvmrc", text: "18\n" },
    { path: ".python-version", text: "3.12\n" },
    { path: "mise.toml", text: '[tools]\njava = "21"\nrust = { version = "1.80" }\n\n[env]\nAPP = "x"\nPORT = 3000\n' },
  ]);
  order(draft.script, "set_env APP 'x'", "curl -fsSL https://mise.run | sh", "'node@20.11.0'  # .tool-versions", "'go@1.22.1'  # .tool-versions", "'java@21'  # mise.toml");
  assert.ok(!draft.script.includes("python@"), "Python 3.12 is the standard image's");
  assert.deepEqual(draft.gaps, [
    "mise.toml: [tools] rust = { version = \"1.80\" } is not a plain version; add it to the mise lines by hand.",
    "mise.toml: [env] PORT = 3000 is not a plain string.",
    ".nvmrc: node 18 as well as 20.11.0 from .tool-versions: the draft takes 20.11.0.",
  ]);
  assert.equal(draft.check, "#!/bin/bash\n# A project image's check (049): bb-box runs it as the box user after the script, and\n# on a box of the image's build. It fails when the script did not do its work.\nset -euo pipefail\nnode --version\ngo version\njava -version\n");
  const lts = drafted([{ path: ".nvmrc", text: "lts/*\n" }]);
  assert.ok(!lts.script.includes("mise use --global 'node"), "the LTS is the standard image's node");
  assert.match(lts.script, /# The standard image has what \.nvmrc asks for\./);
});

test("rust-toolchain: rustup for the box user with its channel, components and targets, cargo on the PATH (049)", () => {
  const draft = drafted([{ path: "rust-toolchain.toml", text: '[toolchain]\nchannel = "1.80.0"\ncomponents = ["clippy", "rustfmt"]\ntargets = ["wasm32-unknown-unknown"]\n' }]);
  assert.ok(draft.script.includes("curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain '1.80.0' -c 'clippy' -c 'rustfmt' -t 'wasm32-unknown-unknown'"));
  assert.ok(draft.script.includes('path_first "$BOX_HOME/.cargo/bin"'));
  assert.match(draft.check, /cargo --version\nrustc --version\n$/);
  assert.ok(drafted([{ path: "rust-toolchain", text: "nightly-2024-08-01\n" }]).script.includes("--default-toolchain 'nightly-2024-08-01'"));
});

test("Nix: installed for the box user, and the dev shell built once from copies of the flake and its lock (049)", () => {
  const flake = '{ outputs = { self, nixpkgs }: { devShells = {}; }; }\n';
  const draft = drafted([
    { path: "flake.nix", text: flake },
    { path: "flake.lock", text: '{ "nodes": {} }\n' },
  ]);
  order(draft.script, 'install -d -m 0755 -o "$BOX_USER" /nix', "--no-daemon", "cat >/opt/bb-box-image/nix/flake.nix <<'BB_BOX_FILE'", flake.trim(), "cat >/opt/bb-box-image/nix/flake.lock", '"$BOX_HOME/.nix-profile/bin/nix" develop /opt/bb-box-image/nix --command true');
  assert.deepEqual(draft.used, ["flake.nix", "flake.lock"]);
  assert.match(drafted([{ path: "flake.nix", text: flake }]).gaps[0]!, /flake\.lock was not given/);
  assert.ok(drafted([{ path: "shell.nix", text: "{ pkgs ? import <nixpkgs> {} }: pkgs.mkShell {}\n" }]).script.includes("nix-shell\" /opt/bb-box-image/nix/shell.nix --run true"));
});

test("with nothing to draft from, a template; with JSON that is not, a gap (049)", () => {
  const empty = drafted([]);
  assert.deepEqual([empty.used, empty.gaps], [[], []]);
  assert.match(empty.script, /# Nothing was found to draft from\./);
  assert.match(empty.check, /\ntrue\n$/);
  assert.match(drafted([{ path: ".devcontainer.json", text: "{ nope" }]).gaps[0]!, /^\.devcontainer\.json: it is not JSON with comments/);
  assert.deepEqual(parseJsonc('{"url": "http://x//y", /* c */ "a": [1,],}'), { url: "http://x//y", a: [1] });
});
