import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { PluginCliError, cliCommand, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { GPU_PARTS, type DoctorReport, type GpuPart } from "../backends/types.ts";
import { withoutSecretVersions, type ConfigDocument, type Problem } from "../core/document.ts";
import { digestOf } from "../core/saves.ts";
import { PRESETS, type Preset } from "../core/sizes.ts";
import type { ConfigState, Configuration, DriverView, FieldView } from "./configuration.ts";
import {
  OPTIONS,
  addBackend,
  addHost,
  backendIdOf,
  driverOf,
  findBackend,
  kindSizeWords,
  optionCurrent,
  optionNamed,
  optionsOf,
  pairOf,
  parseDotenv,
  projectIdsOf,
  removeBackend,
  removeHost,
  setBackend,
  setHost,
  setKind,
  setOptions,
  type BackendEdit,
  type Change,
  type Edited,
  type FieldEdits,
  type HostEdit,
  type KindEdit,
  type ProjectChoice,
} from "./config-edits.ts";
import { doctorText, problemsText } from "./views.ts";
import { PRODUCT } from "../brand.ts";

const MOST_TRIES = 3;
const SAVED_WITH_FAILED_CHECK = 2;

const jsonOption = { json: { type: "boolean", description: "Print JSON." } } as const;

const saveOptions = {
  ...jsonOption,
  check: { type: "boolean", description: "Save nothing: say what would change and what is wrong with it, and for a backend run its checks with the change, as the settings page's Check does." },
  revision: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, placeholder: "n", description: "Save only while the configuration is at this revision, which bb box config show gives, and refuse otherwise. Left out, the change is made on the latest revision, trying up to 3 times." },
  operation: { type: "string", description: "An ID for this save. The same command again with the same ID, as after an answer that never came, is saved once and answers with the first save's receipt, kept 24 hours. A new ID is made when left out." },
} as const;

const secretOptions = {
  secret: { type: "string", repeatable: true, placeholder: "field=VARIABLE", description: "A secret field and the variable in the dotenv file that holds its value, such as token=HCLOUD_TOKEN. Repeat for each. The value is read from --secrets-file or --secrets-stdin, never from the command line." },
  "secrets-file": { type: "string", placeholder: "path", description: "A dotenv file, as bb secret request --write-env writes, read on the machine BB's server runs on; a relative path is from where you run bb." },
  secrets: {
    type: "string",
    stdin: true,
    placeholder: "line",
    description:
      "Only as --secrets-stdin, which reads one line: a VARIABLE=value line, as grep '^HCLOUD_TOKEN=' secrets.env | bb box backend add hetzner --secret token=HCLOUD_TOKEN --secrets-stdin, or a whole dotenv file in base64, as base64 < secrets.env | tr -d '\\n' | bb box ... --secrets-stdin, for several secrets at once. Works from any machine.",
  },
} as const;

const fieldOptions = {
  field: { type: "string", repeatable: true, placeholder: "key=value", description: "Set a field, such as host=unix:///var/run/docker.sock. Repeat for each. key= with nothing after it saves an empty value, which for an image or template field turns its kind off here. Not for secrets." },
  "field-file": { type: "string", repeatable: true, placeholder: "key=path", description: "Set a field to a file's text, for a field of several lines, such as known-hosts. Read on the machine BB's server runs on." },
  unset: { type: "string", repeatable: true, placeholder: "key", description: "Leave a field unset, so it takes its default." },
  "add-line": { type: "string", repeatable: true, placeholder: "key=line", description: "Add a line to a field of lines, such as machines=\"build-1 192.0.2.21 linux\". A line already there is not added again." },
  "remove-line": { type: "string", repeatable: true, placeholder: "key=text", description: "Remove the lines of a field that are the text or start with it and a space, such as machines=build-1." },
  "secret-file": { type: "string", repeatable: true, placeholder: "field=path", description: "Set a secret field to a whole file's text, such as ssh-private-key=key.pem. Read on the machine BB's server runs on." },
  "clear-secret": { type: "string", repeatable: true, placeholder: "field", description: "Clear a secret field." },
} as const;

const switchOptions = {
  on: { type: "boolean", description: "Turn it on." },
  off: { type: "boolean", description: "Turn it off: it makes no new boxes, and its boxes keep working." },
} as const;

function out(text: string, exitCode = 0): PluginCliResult {
  return { exitCode, stdout: `${text}\n` };
}

function json(value: unknown, exitCode = 0): PluginCliResult {
  return { exitCode, stdout: `${JSON.stringify(value, null, 2)}\n` };
}

async function readText(path: string, ctx: PluginCliContext): Promise<string> {
  const file = isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new PluginCliError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      code: "invalid_input",
      hint: "The file is read on the machine BB's server runs on. From another machine, pipe a secret in with --secrets-stdin.",
    });
  }
}

const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)]);

function switchOf(options: { on?: boolean; off?: boolean }): boolean | undefined {
  if (options.on && options.off) throw new PluginCliError("Give --on or --off, not both.", { code: "invalid_input" });
  return options.on ? true : options.off ? false : undefined;
}

interface SecretInput {
  readonly secret?: unknown;
  readonly "secret-file"?: unknown;
  readonly "secrets-file"?: string;
  readonly secrets?: string;
}

const DOTENV_LINE = /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function stdinSecrets(line: string): Map<string, string> {
  const text = line.trim();
  if (DOTENV_LINE.test(text)) return parseDotenv(text);
  const decoded = BASE64.test(text) ? Buffer.from(text, "base64").toString("utf8") : "";
  const env = parseDotenv(decoded);
  if (!env.size) {
    throw new PluginCliError("The line on stdin is neither a VARIABLE=value line nor a dotenv file in base64.", {
      code: "invalid_input",
      hint: "Pipe one line: grep '^NAME=' secrets.env | bb box ... --secrets-stdin, or base64 < secrets.env | tr -d '\\n' | bb box ... --secrets-stdin.",
    });
  }
  return env;
}

async function secretValues(options: SecretInput, ctx: PluginCliContext): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  const pairs = listOf(options.secret).map((text) => pairOf(text, "--secret"));
  if (pairs.length) {
    if (options["secrets-file"] !== undefined && options.secrets !== undefined) throw new PluginCliError("Give --secrets-file or --secrets-stdin, not both.", { code: "invalid_input" });
    const source = options["secrets-file"] !== undefined ? `the file ${options["secrets-file"]}` : options.secrets !== undefined ? "the line on stdin" : null;
    if (!source) {
      throw new PluginCliError("--secret names a variable; give the dotenv file that holds it with --secrets-file, or pipe its line in with --secrets-stdin.", {
        code: "missing_required",
        hint: "bb secret request HCLOUD_TOKEN --write-env secrets.env asks the person for it, then: bb box backend add hetzner --secret token=HCLOUD_TOKEN --secrets-file secrets.env",
      });
    }
    const env = options["secrets-file"] !== undefined ? parseDotenv(await readText(options["secrets-file"], ctx)) : stdinSecrets(String(options.secrets));
    for (const [field, variable] of pairs) {
      const value = env.get(variable);
      if (value === undefined) throw new PluginCliError(`${variable} is not in ${source}.`, { code: "invalid_input", hint: `The variable names in it are ${[...env.keys()].join(", ") || "none"}.` });
      values.set(field, value);
    }
  } else if (options["secrets-file"] !== undefined || options.secrets !== undefined) {
    throw new PluginCliError("Name the secret fields to take from it with --secret <field>=<VARIABLE>.", { code: "missing_required" });
  }
  for (const text of listOf(options["secret-file"])) {
    const [field, path] = pairOf(text, "--secret-file");
    values.set(field, (await readText(path, ctx)).replace(/\r\n/g, "\n").replace(/\n+$/, "\n"));
  }
  return values;
}

function secretDigests(values: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...values].map(([key, value]) => [key, digestOf(value)]));
}

interface FieldInput extends SecretInput {
  readonly field?: unknown;
  readonly "field-file"?: unknown;
  readonly unset?: unknown;
  readonly "add-line"?: unknown;
  readonly "remove-line"?: unknown;
  readonly "clear-secret"?: unknown;
}

async function fieldEdits(options: FieldInput, ctx: PluginCliContext): Promise<{ edits: FieldEdits; submission: unknown }> {
  const fileFields: [string, string][] = [];
  for (const text of listOf(options["field-file"])) {
    const [key, path] = pairOf(text, "--field-file");
    fileFields.push([key, await readText(path, ctx)]);
  }
  const secrets = await secretValues(options, ctx);
  const edits: FieldEdits = {
    set: listOf(options.field).map((text) => pairOf(text, "--field")),
    setFromFile: fileFields,
    unset: listOf(options.unset),
    addLines: listOf(options["add-line"]).map((text) => pairOf(text, "--add-line")),
    removeLines: listOf(options["remove-line"]).map((text) => pairOf(text, "--remove-line")),
    secrets,
    clearSecrets: listOf(options["clear-secret"]),
  };
  return { edits, submission: { ...edits, setFromFile: fileFields.map(([key, text]) => [key, digestOf(text)]), secrets: secretDigests(secrets) } };
}

interface Save {
  readonly command: string;
  readonly submission: unknown;
  readonly build: (document: ConfigDocument, state: ConfigState) => Edited;
  readonly backend?: (document: ConfigDocument) => string | null;
  readonly options: { readonly json?: boolean; readonly check?: boolean; readonly revision?: number; readonly operation?: string; readonly "no-doctor"?: boolean };
  readonly next?: (document: ConfigDocument) => string | null;
}

interface Outcome {
  readonly saved: boolean;
  readonly checked?: true;
  readonly revision: number;
  readonly operation: string | null;
  readonly replayed?: true;
  readonly receipt?: { readonly operation: string; readonly revision: number; readonly at: number };
  readonly changes: readonly Change[];
  readonly problems: readonly Problem[];
  readonly doctor: { readonly backend: string; readonly report: DoctorReport } | null;
}

function changesText(changes: readonly Change[]): string {
  return changes.map((change) => `  ${change.path}: ${change.words}`).join("\n");
}

function doctorWords(doctor: Outcome["doctor"], state: ConfigState): string {
  if (!doctor) return "";
  const label = state.backends.find((backend) => backend.id === doctor.backend)?.label ?? doctor.backend;
  return doctorText({ ok: doctor.report.ok, sections: [{ title: `${label} (${doctor.backend})`, report: doctor.report }] });
}

function refusal(outcome: Outcome, words: string, options: Save["options"]): PluginCliResult {
  if (options.json) return json({ ...outcome, refused: words }, 1);
  return { exitCode: 1, stderr: `${words}\n${outcome.problems.length ? `${problemsText(outcome.problems)}\n` : ""}` };
}

async function backendDoctor(configuration: Configuration, document: ConfigDocument, id: string | null, signal?: AbortSignal): Promise<Outcome["doctor"]> {
  if (!id) return null;
  const { doctor } = await configuration.check(document, id, signal);
  return doctor ? { backend: id, report: doctor } : null;
}

async function save(configuration: Configuration, request: Save, signal?: AbortSignal): Promise<PluginCliResult> {
  const { options } = request;
  const operation = options.check ? null : (options.operation ?? `cli-${randomUUID()}`);
  for (let attempt = 1; attempt <= MOST_TRIES; attempt += 1) {
    const state = await configuration.state();
    const base = withoutSecretVersions(state.document);
    const earlier = operation ? state.receipts.find((receipt) => receipt.operation === operation) : undefined;
    const built = earlier ? { document: base, changes: [] } : request.build(base, state);
    const tested = request.backend?.(built.document) ?? null;
    if (options.check) {
      const checked = await configuration.check(built.document, tested ?? undefined, signal);
      const outcome: Outcome = { saved: false, checked: true, revision: state.revision, operation: null, changes: built.changes, problems: checked.problems, doctor: tested && checked.doctor ? { backend: tested, report: checked.doctor } : null };
      const ok = !checked.problems.length && (outcome.doctor?.report.ok ?? true);
      if (options.json) return json(outcome, ok ? 0 : 1);
      const lines = [
        `Checked against revision ${state.revision}; nothing was saved.`,
        built.changes.length ? `It would change:\n${changesText(built.changes)}` : "It would change nothing.",
        checked.problems.length ? `Problems:\n${problemsText(checked.problems)}` : "No problems.",
        doctorWords(outcome.doctor, state),
      ].filter(Boolean);
      return out(lines.join("\n"), ok ? 0 : 1);
    }
    if (!built.changes.length && !earlier) {
      const outcome: Outcome = { saved: false, revision: state.revision, operation: null, changes: [], problems: [], doctor: null };
      return options.json ? json(outcome) : out(`Nothing to change: the configuration already has that, at revision ${state.revision}.`);
    }
    const result = await configuration.apply(built.document, options.revision ?? state.revision, { id: operation!, submission: { command: request.command, request: request.submission } });
    if (result.ok) {
      const saved = withoutSecretVersions(result.state.document);
      const id = request.backend?.(saved) ?? null;
      const on = id !== null && saved.backends.some((backend) => backend.id === id && backend.enabled);
      const doctor = on && !options["no-doctor"] && !result.replayed ? await backendDoctor(configuration, configuration.exported(), id, signal) : null;
      const revision = result.receipt?.revision ?? result.state.revision;
      const outcome: Outcome = { saved: true, revision, operation, ...(result.replayed ? { replayed: true as const } : {}), ...(result.receipt ? { receipt: result.receipt } : {}), changes: result.replayed ? [] : built.changes, problems: result.problems, doctor };
      const exitCode = doctor && !doctor.report.ok ? SAVED_WITH_FAILED_CHECK : 0;
      if (options.json) return json(outcome, exitCode);
      const after = await configuration.state();
      const lines = result.replayed
        ? [`Operation ${operation} was saved already, at revision ${revision}: nothing more changed.`]
        : [
            `Saved revision ${revision}, operation ${operation}.`,
            changesText(built.changes),
            result.problems.length ? `Saved with these problems, in backends that are off:\n${problemsText(result.problems)}` : "",
            id && !on ? `${id} is off, so it was not checked. bb box backend set ${id} --on turns it on.` : "",
            doctorWords(doctor, after),
            doctor && !doctor.report.ok ? `Its checks failed: fix what they say, then bb box backend set ${id} --check checks again without saving.` : "",
            request.next?.(saved) ?? "",
          ];
      return out(lines.filter(Boolean).join("\n"), exitCode);
    }
    if (result.reason === "revision") {
      if (options.revision !== undefined) {
        return refusal(
          { saved: false, revision: result.state.revision, operation, changes: built.changes, problems: [], doctor: null },
          `Nothing was saved: the configuration changed since revision ${options.revision}, and is at revision ${result.state.revision}. Look again with bb box config show, then run the command with --revision ${result.state.revision}, or without --revision.`,
          options,
        );
      }
      continue;
    }
    const reused = result.problems.find((problem) => problem.path === "operation");
    return refusal({ saved: false, revision: state.revision, operation, changes: built.changes, problems: reused ? [] : result.problems, doctor: null }, reused ? reused.message : "Nothing was saved. Fix these first:", options);
  }
  return { exitCode: 1, stderr: `The configuration kept changing, ${MOST_TRIES} times while this saved; nothing was saved. Run the command again.\n` };
}

export function fieldLine(field: FieldView, value: unknown, replaced?: unknown): string {
  const secret = (field as { secret?: boolean }).secret === true;
  const options = (field as { options?: readonly string[] }).options;
  const kinds = [field.type === "select" ? `one of ${options?.join(", ")}` : field.type, secret ? "secret" : null, field.offWhenEmpty ? "empty turns its kind off" : null].filter(Boolean).join(", ");
  const lead = (field.description ?? "").split(/(?<=[.!?])\s/)[0] ?? "";
  const current = value === undefined && replaced !== undefined && field.replaces ? `unset, so ${JSON.stringify(replaced)} from ${field.replaces}, which it replaces` : value === undefined ? (field.default === undefined || field.default === "" ? "unset" : `unset, so ${JSON.stringify(field.default)}`) : typeof value === "object" && value !== null && "set" in value ? ((value as { set: boolean }).set ? "set" : "not set") : typeof value === "string" && value.includes("\n") ? `${value.split("\n").filter((line) => line.trim()).length} lines` : JSON.stringify(value);
  const inherits = field.inherits ? ` Empty, with the rest of ${field.inherits.set.join(", ")}, it takes ${field.inherits.label}'s.` : "";
  return `  ${field.key} (${kinds}) [${field.group}]: ${field.label}. ${lead}${inherits} Now: ${current}.`;
}

function backendLine(state: ConfigState, id: string): string {
  const backend = state.backends.find((candidate) => candidate.id === id)!;
  const stored = state.document.backends.find((candidate) => candidate.id === id)!;
  const words = { active: "ready", off: "off", misconfigured: "needs setting up" }[backend.state];
  const doctor = backend.doctor;
  const check = !doctor
    ? "not checked yet"
    : `last checked ${new Date(doctor.at).toISOString()}${doctor.revision !== null ? ` at revision ${doctor.revision}` : ""}: ${doctor.report.ok ? "passed" : "failed"}${doctor.revision !== null && backend.changed > doctor.revision ? ", and changed since" : ""}`;
  const lines = [
    `${id} (${backend.label}${backend.form ? `, ${backend.form}` : ""}): ${stored.enabled ? "on" : "off"}, ${words}${backend.kinds.length ? `, offers ${backend.kinds.join(", ")}` : ""}${backend.boxes ? `, ${backend.boxes} ${backend.boxes === 1 ? "box" : "boxes"}` : ""}; ${check}.`,
  ];
  const warm = Object.entries(stored.warm ?? {});
  if (warm.length) lines.push(`  warm: ${warm.map(([kind, count]) => `${count} ${kind}`).join(", ")}`);
  for (const host of stored.hosts ?? []) lines.push(`  host ${host.name}: ${host.enabled ? "on" : "off"}`);
  for (const problem of backend.problems) lines.push(`  problem at ${problem.path}: ${problem.message}`);
  return lines.join("\n");
}

function driverView(state: ConfigState, type: string): DriverView {
  driverOf(state.drivers, type);
  return state.drivers.find((driver) => driver.type === type)!;
}

function backendOptions() {
  return { ...saveOptions, ...fieldOptions, ...secretOptions, ...switchOptions, label: { type: "string", description: "Its name in the settings and in box_list, such as Docker on build-1. Empty gives back the type's name." }, warm: { type: "string", repeatable: true, placeholder: "kind=count", description: "Ready boxes of a kind to keep waiting here, such as linux=1; 0 keeps none." }, projects: { type: "string", placeholder: "names", description: "The BB projects it is kept for, by name or ID, separated by commas. Only their threads see it and get boxes, spares and forks from it, before the shared backends. Empty serves every project, as by default." }, "no-doctor": { type: "boolean", description: "Do not run the backend's checks after saving." } } as const;
}

function warmOf(value: unknown): [string, number][] {
  return listOf(value).map((text) => {
    const [kind, count] = pairOf(text, "--warm");
    const number = Number(count);
    if (!Number.isInteger(number) || number < 0) throw new PluginCliError(`Give --warm as <kind>=<count>, a whole number, not "${text}".`, { code: "invalid_input" });
    return [kind, number];
  });
}

function sizeOf(text: string | undefined, name: string, base: boolean): number | null | undefined {
  if (text === undefined) return undefined;
  if (base && text.trim() === "base") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new PluginCliError(`Give ${name} as a number above 0${base ? ', or "base" for the image\'s own disk' : ""}, not "${text}".`, { code: "invalid_input" });
  return value;
}

function firstBoxWords(document: ConfigDocument, id: string): string | null {
  const backend = document.backends.find((candidate) => candidate.id === id);
  if (!backend?.enabled) return null;
  return `Next: bb box kinds lists what is on offer. To prove it, acquire a first box there: bb box acquire <kind> --on ${id}, then bb box release <box>.`;
}

async function projectsOf(value: unknown, projects: () => Promise<readonly ProjectChoice[]>): Promise<string[] | undefined> {
  if (value === undefined) return undefined;
  const text = String(value);
  return text.trim() ? projectIdsOf(text, await projects()) : [];
}

export function configCommands(configuration: Configuration, projects: () => Promise<readonly ProjectChoice[]> = async () => []) {
  return {
    "backend list": cliCommand({
      summary: "List the configuration's backends, in the order a new box tries them: each one's switch, state, kinds, boxes and last check.",
      options: jsonOption,
      async run({ options }) {
        const state = await configuration.state();
        if (options.json) return json(state.backends.map((backend) => ({ ...backend, enabled: state.document.backends.find((candidate) => candidate.id === backend.id)?.enabled ?? false })));
        if (!state.backends.length) return out("There are no backends yet. bb box backend types lists the types, and bb box backend add <type> adds one; bb box setup docker sets up Docker on the machine that runs BB.");
        return out(state.backends.map((backend) => backendLine(state, backend.id)).join("\n"));
      },
    }),
    "backend types": cliCommand({
      summary: `List the types of backend ${PRODUCT} has: what each is for, what setting it up needs, the kinds it makes, and its setup guide and scripts in ${PRODUCT}'s repository.`,
      options: jsonOption,
      async run({ options }) {
        const state = await configuration.state();
        const types = state.drivers.map((driver) => ({ type: driver.type, label: driver.label, description: driver.description, kinds: driver.kinds, setup: driver.setup, backends: state.document.backends.filter((backend) => backend.type === driver.type).map((backend) => backend.id) }));
        if (options.json) return json(types);
        return out(
          types
            .map((type) => `${type.type}: ${type.label}. ${type.description}${type.setup.needs ? ` You need: ${type.setup.needs}` : ""} Kinds: ${type.kinds.join(", ")}. Guide: ${type.setup.guide}${type.setup.scripts.length ? `; scripts ${type.setup.scripts.join(", ")}` : ""}.${type.backends.length ? ` Added: ${type.backends.join(", ")}.` : ""}`)
            .join("\n"),
        );
      },
    }),
    "backend fields": cliCommand({
      summary: "List a backend type's fields, or a backend's with their values now: each key, what it takes, whether it is a secret, and the first line of its help. Secrets show only as set or not.",
      positionals: [{ name: "backend", description: "A type, from bb box backend types, or a backend's ID, from bb box backend list.", required: true }],
      options: jsonOption,
      async run({ positionals, options }) {
        const state = await configuration.state();
        const document = withoutSecretVersions(state.document);
        const backend = document.backends.find((candidate) => candidate.id === positionals.backend) ?? null;
        const driver = driverView(state, backend?.type ?? positionals.backend);
        if (options.json) return json({ type: driver.type, backend: backend?.id ?? null, fields: driver.fields.map((field) => ({ ...field, value: backend?.fields[field.key] })), hostFields: driver.hostFields, hosts: backend?.hosts ?? [] });
        const lines = [`${backend ? `Backend ${backend.id}, ` : ""}${driver.label} (${driver.type}). Its guide: ${driver.setup.guide}.`, "Fields:", ...driver.fields.map((field) => fieldLine(field, backend?.fields[field.key], field.replaces ? backend?.fields[field.replaces] : undefined))];
        if (driver.hostFields.length) {
          lines.push("Each host's fields, with bb box backend host add:", ...driver.hostFields.map((field) => fieldLine(field, undefined).replace(/ Now: [^\n]*$/, "")));
          for (const host of backend?.hosts ?? []) lines.push(`Host ${host.name}: ${host.enabled ? "on" : "off"}${Object.entries(host.fields).map(([key, value]) => `, ${key} ${JSON.stringify(value)}`).join("")}.`);
        }
        return out(lines.join("\n"));
      },
    }),
    "backend add": cliCommand({
      summary:
        "Add a backend, on unless --off, through the same checked save as the settings page, then run its checks. Secrets come only from a dotenv file or stdin. Exits 2 when it saved and its checks failed.",
      positionals: [{ name: "type", description: "The type, from bb box backend types, such as docker or ssh-pool.", required: true }],
      options: { ...backendOptions(), id: { type: "string", description: "Its ID, for a second backend of a type that allows several, such as docker:build-1 for another Docker host or namespace:team-b for another Namespace workspace, or just build-1 or team-b. The type by default." } },
      run: async ({ positionals, options }, ctx) => {
        const id = backendIdOf(positionals.type, options.id);
        const enabled = options.off ? false : true;
        if (options.on && options.off) throw new PluginCliError("Give --on or --off, not both.", { code: "invalid_input" });
        const { edits, submission } = await fieldEdits(options, ctx);
        const kept = await projectsOf(options.projects, projects);
        const edit: BackendEdit = { ...edits, enabled, ...(options.label !== undefined ? { label: options.label } : {}), warm: warmOf(options.warm), ...(kept !== undefined ? { projects: kept } : {}) };
        return save(
          configuration,
          {
            command: "backend add",
            submission: { type: positionals.type, id, enabled, label: options.label, warm: edit.warm, projects: kept, fields: submission },
            build: (document, state) => addBackend(document, state.drivers, positionals.type, id, edit),
            backend: () => id,
            options,
            next: (document) => firstBoxWords(document, id),
          },
          ctx.signal,
        );
      },
    }),
    "backend set": cliCommand({
      summary: "Change a backend: its fields, secrets, switch, name, warm boxes or the projects it is kept for, through the same checked save as the settings page, then run its checks. Exits 2 when it saved and its checks failed.",
      positionals: [{ name: "backend", description: "The backend's ID, from bb box backend list.", required: true }],
      options: backendOptions(),
      run: async ({ positionals, options }, ctx) => {
        const enabled = switchOf(options);
        const { edits, submission } = await fieldEdits(options, ctx);
        const kept = await projectsOf(options.projects, projects);
        const edit: BackendEdit = { ...edits, ...(enabled !== undefined ? { enabled } : {}), ...(options.label !== undefined ? { label: options.label || null } : {}), warm: warmOf(options.warm), ...(kept !== undefined ? { projects: kept } : {}) };
        let id: string | null = null;
        return save(
          configuration,
          {
            command: "backend set",
            submission: { backend: positionals.backend, enabled, label: options.label, warm: edit.warm, projects: kept, fields: submission },
            build: (document, state) => {
              id = findBackend(document, positionals.backend).id;
              return setBackend(document, state.drivers, positionals.backend, edit);
            },
            backend: () => id,
            options,
            next: (document) => (enabled === true && id ? firstBoxWords(document, id) : null),
          },
          ctx.signal,
        );
      },
    }),
    "backend remove": cliCommand({
      summary: "Remove a backend: its settings, its secrets, which cannot be got back, and its warm boxes. Refused while it has boxes, as on the settings page. Asks for --yes.",
      positionals: [{ name: "backend", description: "The backend's ID, from bb box backend list.", required: true }],
      options: { ...saveOptions, yes: { type: "boolean", description: "Remove it. Without it, the command says what would go and removes nothing." } },
      run: async ({ positionals, options }, ctx) => {
        if (!options.yes && !options.check) {
          const state = await configuration.state();
          const backend = findBackend(withoutSecretVersions(state.document), positionals.backend);
          const boxes = state.backends.find((candidate) => candidate.id === backend.id)?.boxes ?? 0;
          return {
            exitCode: 1,
            stderr: `Nothing was removed. Removing ${backend.id} deletes its settings and its secrets, which cannot be got back, and its warm boxes go; there is no undo.${boxes ? ` It has ${boxes} ${boxes === 1 ? "box" : "boxes"}, so it is refused until they are released: turn it off with bb box backend set ${backend.id} --off, and release them first.` : ""} Run it again with --yes to remove it, or turn it off instead with bb box backend set ${backend.id} --off.\n`,
          };
        }
        return save(configuration, { command: "backend remove", submission: { backend: positionals.backend }, build: (document) => removeBackend(document, positionals.backend), options }, ctx.signal);
      },
    }),
    "backend host add": cliCommand({
      summary: "Add a host to a backend whose hosts are set up alike, such as a Mac to Tart. The SSH host pool lists its machines in its machines field instead: bb box backend set ssh-pool --add-line.",
      positionals: [
        { name: "backend", description: "The backend's ID, such as tart.", required: true },
        { name: "host", description: "The host's name: lower-case letters, digits and \"-\", such as mac-1.", required: true },
      ],
      options: { ...saveOptions, field: fieldOptions.field, "field-file": fieldOptions["field-file"], unset: fieldOptions.unset, ...switchOptions, "no-doctor": { type: "boolean", description: "Do not run the backend's checks after saving." } },
      run: async ({ positionals, options }, ctx) => {
        if (options.on && options.off) throw new PluginCliError("Give --on or --off, not both.", { code: "invalid_input" });
        const { edits, submission } = await fieldEdits(options, ctx);
        const edit: HostEdit = { ...edits, enabled: !options.off };
        let id: string | null = null;
        return save(
          configuration,
          {
            command: "backend host add",
            submission: { ...positionals, enabled: edit.enabled, fields: submission },
            build: (document, state) => {
              id = findBackend(document, positionals.backend).id;
              return addHost(document, state.drivers, positionals.backend, positionals.host, edit);
            },
            backend: () => id,
            options,
          },
          ctx.signal,
        );
      },
    }),
    "backend host set": cliCommand({
      summary: "Change a backend's host: its fields, or its switch. Off, it takes no new boxes, and its boxes keep working.",
      positionals: [
        { name: "backend", description: "The backend's ID, such as tart.", required: true },
        { name: "host", description: "The host's name, from bb box backend list.", required: true },
      ],
      options: { ...saveOptions, field: fieldOptions.field, "field-file": fieldOptions["field-file"], unset: fieldOptions.unset, ...switchOptions, "no-doctor": { type: "boolean", description: "Do not run the backend's checks after saving." } },
      run: async ({ positionals, options }, ctx) => {
        const enabled = switchOf(options);
        const { edits, submission } = await fieldEdits(options, ctx);
        const edit: HostEdit = { ...edits, ...(enabled !== undefined ? { enabled } : {}) };
        let id: string | null = null;
        return save(
          configuration,
          {
            command: "backend host set",
            submission: { ...positionals, enabled, fields: submission },
            build: (document, state) => {
              id = findBackend(document, positionals.backend).id;
              return setHost(document, state.drivers, positionals.backend, positionals.host, edit);
            },
            backend: () => id,
            options,
          },
          ctx.signal,
        );
      },
    }),
    "backend host remove": cliCommand({
      summary: "Remove a host from a backend. Refused while it has boxes, as on the settings page.",
      positionals: [
        { name: "backend", description: "The backend's ID, such as tart.", required: true },
        { name: "host", description: "The host's name, from bb box backend list.", required: true },
      ],
      options: saveOptions,
      run: async ({ positionals, options }, ctx) =>
        save(configuration, { command: "backend host remove", submission: positionals, build: (document, state) => removeHost(document, state.drivers, positionals.backend, positionals.host), options }, ctx.signal),
    }),
    "kind set": cliCommand({
      summary:
        "Change a kind: whether it is offered, its presets' sizes, its default preset, its largest custom size, its spare boxes, its GPU when not asked for, or make it the default kind, through the same checked save as the settings page. Sizes and the GPU change new boxes only.",
      positionals: [{ name: "kind", description: "The kind, such as linux. bb box kinds lists those on offer.", required: true }],
      options: {
        ...saveOptions,
        ...switchOptions,
        "make-default": { type: "boolean", description: "Make it the kind a thread gets when it asks for none." },
        "default-preset": { type: "enum", values: PRESETS, description: "The preset a box gets when it asks for no size." },
        preset: { type: "enum", values: PRESETS, description: "The preset that --cores, --memory-gib and --disk-gib change. The kind's default preset by default." },
        cores: { type: "integer", min: 1, max: 1024, description: "The preset's cores." },
        "memory-gib": { type: "string", description: "The preset's memory in GiB, such as 8 or 0.5." },
        "disk-gib": { type: "string", description: 'The preset\'s disk in GiB, or "base" for the size the image comes with.' },
        "largest-cores": { type: "integer", min: 1, max: 1024, description: "The most cores a custom size may ask for." },
        "largest-memory-gib": { type: "string", description: "The most memory in GiB a custom size may ask for." },
        "largest-disk-gib": { type: "string", description: "The most disk in GiB a custom size may ask for." },
        spares: { type: "integer", min: 0, max: 100, description: "Spare boxes to keep ready, enrolled and owned by no thread; 0 keeps none." },
        gpu: { type: "enum", values: GPU_PARTS, description: "The GPU a box of the kind gets when a request leaves gpu out, and the New box form's first choice: none, shared or whole. linux and linux-desktop only." },
        reset: { type: "boolean", description: `Go back to ${PRODUCT}'s own sizes and switch for the kind first.` },
      },
      run: async ({ positionals, options }, ctx) => {
        const enabled = switchOf(options);
        const size = { cores: options.cores, memoryGiB: sizeOf(options["memory-gib"], "--memory-gib", false) ?? undefined, diskGiB: sizeOf(options["disk-gib"], "--disk-gib", true) };
        const largest = { cores: options["largest-cores"], memoryGiB: sizeOf(options["largest-memory-gib"], "--largest-memory-gib", false) ?? undefined, diskGiB: sizeOf(options["largest-disk-gib"], "--largest-disk-gib", false) ?? undefined };
        const edit: KindEdit = {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(options["make-default"] ? { makeDefault: true } : {}),
          ...(options["default-preset"] ? { defaultPreset: options["default-preset"] as Preset } : {}),
          ...(options.preset ? { preset: options.preset as Preset } : {}),
          size,
          largest,
          ...(options.spares !== undefined ? { spares: options.spares } : {}),
          ...(options.gpu ? { gpu: options.gpu as GpuPart } : {}),
          ...(options.reset ? { reset: true } : {}),
        };
        return save(
          configuration,
          {
            command: "kind set",
            submission: { kind: positionals.kind, edit },
            build: (document, state) => setKind(document, state.kinds.map((kind) => kind.id), positionals.kind, edit),
            options,
            next: (document) => `Now ${kindSizeWords(positionals.kind, document)} Boxes made before keep their size.`,
          },
          ctx.signal,
        );
      },
    }),
    "option list": cliCommand({
      summary: "List the general and Monitor options: each one's value now, its default, and what it does.",
      options: jsonOption,
      async run({ options }) {
        const document = withoutSecretVersions((await configuration.state()).document);
        const rows = optionsOf(document).map((option) => ({ name: option.name, value: optionCurrent(document, option) ?? null, default: option.default, help: option.help }));
        if (options.json) return json(rows);
        return out(rows.map((row) => `${row.name} = ${row.value === null ? `${JSON.stringify(row.default)} (the default)` : JSON.stringify(row.value)}: ${row.help}`).join("\n"));
      },
    }),
    "option get": cliCommand({
      summary: "Show one general or Monitor option: its value now, its default, and what it does.",
      positionals: [{ name: "option", description: "The option's name, such as monitor.enabled or defaultKind.", required: true }],
      options: jsonOption,
      async run({ positionals, options }) {
        const option = optionNamed(positionals.option);
        const value = optionCurrent(withoutSecretVersions((await configuration.state()).document), option);
        if (options.json) return json({ name: option.name, value: value ?? null, default: option.default, help: option.help });
        return out(`${option.name} = ${value === undefined ? `${JSON.stringify(option.default)} (the default)` : JSON.stringify(value)}: ${option.help}`);
      },
    }),
    "option set": cliCommand({
      summary:
        "Set general and Monitor options, such as monitor.enabled=false, defaultKind=linux or general.snapshots.ceilings.<backend>=7.50, a ceiling on a backend's paid snapshots, in one checked save, as the settings page saves them. bb box option list lists them.",
      positionals: [{ name: "options", description: "Each as <name>=<value>, such as monitor.enabled=false; or one name and its value as two words.", required: false, variadic: true }],
      options: { ...saveOptions, ...secretOptions },
      run: async ({ positionals, options }, ctx) => {
        const words = (positionals.options ?? []) as string[];
        const pairs = words.length === 2 && !words[0]!.includes("=") ? [[words[0]!, words[1]!] as [string, string]] : words.map((text) => pairOf(text, "an option"));
        const secrets = await secretValues(options, ctx);
        if (!pairs.length && !secrets.size) throw new PluginCliError("Give an option and its value, such as monitor.enabled=false.", { code: "missing_required", hint: "bb box option list lists the options." });
        for (const [name] of pairs) optionNamed(name);
        return save(
          configuration,
          {
            command: "option set",
            submission: { pairs, secrets: secretDigests(secrets) },
            build: (document) => setOptions(document, pairs, secrets),
            options,
            next: (document) => (pairs.some(([name]) => optionNamed(name).name === "monitor.enabled") ? `The Monitor is ${document.monitor?.enabled === false ? "off" : "on"}. BB's sidebar shows the change when BB next loads.` : null),
          },
          ctx.signal,
        );
      },
    }),
    "option unset": cliCommand({
      summary: "Give general and Monitor options back their defaults, in one checked save. general.tailnet.mode turns the tailnet off and clears its client.",
      positionals: [{ name: "options", description: "The options' names, such as monitor.refreshIntervalSeconds.", required: true, variadic: true }],
      options: saveOptions,
      run: async ({ positionals, options }, ctx) => {
        const names = (positionals.options ?? []) as string[];
        for (const name of names) optionNamed(name);
        return save(configuration, { command: "option unset", submission: { names }, build: (document) => setOptions(document, [], new Map(), names), options }, ctx.signal);
      },
    }),
  };
}
