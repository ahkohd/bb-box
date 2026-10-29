import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseDump, parseServerTree, type AndroidScreen } from "./android-tree.ts";
import { DriverError } from "./driver.ts";

export const TREE_SERVER_DEX = fileURLToPath(new URL("./tree-server.dex", import.meta.url));
export const TREE_SERVER_CLASS = "TreeServer";
export const TREE_SERVER_LINGER_MS = 30_000;
export const TREE_HELLO_MS = 5_000;
export const TREE_ANSWER_MS = 5_000;
export const TREE_SERVER_RETRY_MS = 30_000;
export const DUMP_MS = 15_000;
export const APPS_KEPT_MS = 60_000;
const DEVICE_DIR = "/data/local/tmp";
const DEX_PREFIX = "bb-box-tree-";

export interface TreeChannel {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (words: string) => void): void;
  close(): void;
}

export interface LauncherApp {
  readonly pkg: string;
  readonly activity: string;
  readonly label: string | null;
  readonly system: boolean;
}

export interface TreeRead {
  readonly screen: AndroidScreen;
  readonly ms: number;
}

export interface AndroidTreeOptions {
  readonly adbRun: (args: readonly string[], options: { readonly timeoutMs?: number }) => Promise<{ readonly code: number; readonly output: string }>;
  readonly shell: (command: string, options: { readonly timeoutMs?: number }) => Promise<string>;
  readonly spawnServer: (command: string) => TreeChannel;
  readonly log: (line: string) => void;
  readonly dex?: string;
  readonly now?: () => number;
  readonly onlyDump?: boolean;
}

export function adbShellChannel(adb: string, serial: string, command: string): TreeChannel {
  const child = spawn(adb, ["-s", serial, "shell", "-T", command], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
  });
  child.stdin.on("error", () => undefined);
  return {
    send: (line) => void child.stdin.write(`${line}\n`),
    onLine: (listener) => void lines.on("line", listener),
    onExit: (listener) => {
      child.once("error", (error) => listener(error.message));
      child.once("exit", (code, signal) => listener(`it ended with ${signal ?? `exit code ${code}`}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`));
    },
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

class ServerConnection {
  readonly #channel: TreeChannel;
  readonly #waiting: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  #ended: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(channel: TreeChannel) {
    this.#channel = channel;
    channel.onLine((line) => this.#waiting.shift()?.resolve(line));
    channel.onExit((words) => {
      this.#ended = words;
      for (const waiting of this.#waiting.splice(0)) waiting.reject(new DriverError("failed", `bb-box's tree server stopped: ${words}`));
    });
  }

  get ended(): string | null {
    return this.#ended;
  }

  #next(timeoutMs: number, what: string): Promise<string> {
    if (this.#ended) return Promise.reject(new DriverError("failed", `bb-box's tree server stopped: ${this.#ended}`));
    return new Promise((resolve, reject) => {
      const waiting = {
        resolve: (line: string) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const at = this.#waiting.indexOf(waiting);
        if (at >= 0) this.#waiting.splice(at, 1);
        reject(new DriverError("failed", `bb-box's tree server did not answer ${what} within ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      this.#waiting.push(waiting);
    });
  }

  hello(timeoutMs: number): Promise<string> {
    return this.#next(timeoutMs, "its start");
  }

  ask(request: string, timeoutMs: number): Promise<string> {
    const run = this.#queue.then(() => {
      const answer = this.#next(timeoutMs, `a ${request} request`);
      this.#channel.send(request);
      return answer;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.#channel.close();
  }
}

function launcherActivities(printed: string): readonly LauncherApp[] {
  const apps: LauncherApp[] = [];
  for (const match of printed.matchAll(/^\s*([\w.]+)\/([\w.$]+)\s*$/gm)) {
    const activity = match[2]!.startsWith(".") ? `${match[1]}${match[2]}` : match[2]!;
    if (!apps.some((each) => each.pkg === match[1])) apps.push({ pkg: match[1]!, activity, label: null, system: false });
  }
  return apps;
}

function serverApps(line: string): readonly LauncherApp[] {
  const answer = JSON.parse(line) as { ok?: unknown; apps?: unknown; words?: unknown };
  if (answer.ok !== true || !Array.isArray(answer.apps)) throw new DriverError("failed", `bb-box's tree server could not list the apps: ${typeof answer.words === "string" ? answer.words : line.slice(0, 120)}`);
  const apps: LauncherApp[] = [];
  for (const raw of answer.apps as Record<string, unknown>[]) {
    if (typeof raw.pkg !== "string" || typeof raw.activity !== "string" || apps.some((each) => each.pkg === raw.pkg)) continue;
    apps.push({ pkg: raw.pkg, activity: raw.activity, label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null, system: raw.system === true });
  }
  return apps;
}

class GivingWay extends DriverError {
  constructor(words: string) {
    super("held-elsewhere", words);
    this.name = "GivingWay";
  }
}

export function instrumentationWords(): string {
  return "An instrumentation test is running on the device. Android lets one client at a time read the screen's elements, and a read as the test starts can crash it, so bb-box leaves them to the test until it ends. computer_screenshot works meanwhile.";
}

export function heldElsewhereWords(): string {
  return "Something else on the device holds Android's UiAutomation, which reads the screen's elements: an instrumentation test, or a tool such as uiautomator. bb-box reads the elements again once it ends; computer_screenshot works meanwhile.";
}

export class AndroidTreeSource {
  readonly #options: AndroidTreeOptions;
  readonly #now: () => number;
  #connection: ServerConnection | null = null;
  #starting: Promise<ServerConnection> | null = null;
  #brokenUntil = 0;
  #givingWay = false;
  #remoteDex: string | null = null;
  #apps: { readonly at: number; readonly list: readonly LauncherApp[] } | null = null;
  #lastVia: "server" | "dump" | null = null;

  constructor(options: AndroidTreeOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
  }

  get lastVia(): "server" | "dump" | null {
    return this.#lastVia;
  }

  async read(): Promise<TreeRead> {
    const began = this.#now();
    const fromServer = await this.#fromServer();
    if (fromServer) {
      this.#via("server", "");
      return { screen: fromServer, ms: this.#now() - began };
    }
    const screen = await this.#dump();
    return { screen, ms: this.#now() - began };
  }

  #via(via: "server" | "dump", why: string): void {
    if (this.#lastVia !== via) this.#options.log(via === "server" ? "tree: read by bb-box's tree server" : `tree: read by uiautomator dump, ${why}`);
    this.#lastVia = via;
  }

  async #fromServer(): Promise<AndroidScreen | null> {
    if (this.#options.onlyDump) {
      this.#via("dump", "as asked");
      return null;
    }
    if (this.#now() < this.#brokenUntil) return null;
    try {
      const connection = await this.#server();
      const answer = parseServerTree(await connection.ask("tree", TREE_ANSWER_MS));
      if (answer.ok) {
        if (this.#givingWay) this.#options.log("tree: nothing else holds UiAutomation now, so bb-box's tree server reads again");
        this.#givingWay = false;
        return answer.screen;
      }
      if (answer.code === "instrumentation" || answer.code === "held-elsewhere") {
        if (!this.#givingWay) this.#options.log(`tree: the tree server gives way (${answer.code}): ${answer.words}`);
        this.#givingWay = true;
        throw new GivingWay(answer.code === "instrumentation" ? instrumentationWords() : heldElsewhereWords());
      }
      throw new DriverError("failed", answer.words);
    } catch (error) {
      if (error instanceof GivingWay) throw error;
      const words = error instanceof Error ? error.message : String(error);
      this.#options.log(`tree: bb-box's tree server failed, so uiautomator dump reads for the next ${TREE_SERVER_RETRY_MS / 1000} s: ${words}`);
      this.#brokenUntil = this.#now() + TREE_SERVER_RETRY_MS;
      this.#drop();
      this.#via("dump", "as the tree server failed");
      return null;
    }
  }

  async #dump(): Promise<AndroidScreen> {
    const ran = await this.#options.adbRun(["exec-out", "uiautomator", "dump", "/dev/tty"], { timeoutMs: DUMP_MS });
    if (!ran.output.includes("<hierarchy")) {
      if (/already registered|Killed/i.test(ran.output)) throw new DriverError("held-elsewhere", heldElsewhereWords());
      throw new DriverError("failed", `uiautomator dump gave no tree: ${ran.output.split("\n").slice(-2).join(" ").slice(0, 200) || `it ended with ${ran.code}`}`);
    }
    return parseDump(ran.output);
  }

  async #dexOnDevice(): Promise<string> {
    if (this.#remoteDex) {
      const present = (await this.#options.shell(`[ -f ${this.#remoteDex} ] && echo present || echo missing`, { timeoutMs: TREE_HELLO_MS })).trim();
      if (present === "present") return this.#remoteDex;
    }
    const dex = this.#options.dex ?? TREE_SERVER_DEX;
    const digest = createHash("sha256").update(await readFile(dex)).digest("hex").slice(0, 16);
    const remote = `${DEVICE_DIR}/${DEX_PREFIX}${digest}.dex`;
    const present = (await this.#options.shell(`[ -f ${remote} ] && echo present || { rm -f ${DEVICE_DIR}/${DEX_PREFIX}*.dex; echo missing; }`, { timeoutMs: TREE_HELLO_MS })).trim();
    if (present !== "present") {
      const pushed = await this.#options.adbRun(["push", dex, remote], { timeoutMs: DUMP_MS });
      if (pushed.code !== 0) throw new DriverError("failed", `adb could not copy the tree server to the device: ${pushed.output.split("\n").slice(-2).join(" ")}`);
    }
    this.#remoteDex = remote;
    return remote;
  }

  #server(): Promise<ServerConnection> {
    if (this.#connection && !this.#connection.ended) return Promise.resolve(this.#connection);
    this.#starting ??= (async () => {
      try {
        const remote = await this.#dexOnDevice();
        const began = this.#now();
        const connection = new ServerConnection(this.#options.spawnServer(`CLASSPATH=${remote} exec app_process / ${TREE_SERVER_CLASS} ${TREE_SERVER_LINGER_MS}`));
        const hello = await connection.hello(TREE_HELLO_MS).catch((error: unknown) => {
          connection.close();
          throw error;
        });
        if (!/"hello"/.test(hello)) {
          connection.close();
          throw new DriverError("failed", `bb-box's tree server started with something other than its hello: ${hello.slice(0, 120)}`);
        }
        this.#options.log(`tree: bb-box's tree server started in ${Math.round(this.#now() - began)} ms`);
        this.#connection = connection;
        return connection;
      } finally {
        this.#starting = null;
      }
    })();
    return this.#starting;
  }

  #drop(): void {
    this.#connection?.close();
    this.#connection = null;
  }

  async apps(): Promise<readonly LauncherApp[]> {
    if (this.#apps && this.#now() - this.#apps.at < APPS_KEPT_MS) return this.#apps.list;
    let list: readonly LauncherApp[] | null = null;
    if (!this.#options.onlyDump && this.#now() >= this.#brokenUntil) {
      try {
        list = serverApps(await (await this.#server()).ask("apps", TREE_ANSWER_MS));
      } catch (error) {
        this.#options.log(`apps: the tree server did not list them, so they go by package: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    list ??= launcherActivities(await this.#options.shell("cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER", { timeoutMs: DUMP_MS }));
    this.#apps = { at: this.#now(), list };
    return list;
  }

  async pasteIntoFocusedField(): Promise<boolean> {
    if (this.#options.onlyDump || this.#now() < this.#brokenUntil) return false;
    try {
      const line = await (await this.#server()).ask("paste", TREE_ANSWER_MS);
      const answer = JSON.parse(line) as { ok?: unknown; pasted?: unknown; words?: unknown };
      if (answer.ok !== true) this.#options.log(`paste: the tree server did not paste, so the Paste key goes: ${typeof answer.words === "string" ? answer.words : line.slice(0, 120)}`);
      return answer.ok === true && answer.pasted === true;
    } catch (error) {
      this.#options.log(`paste: the tree server did not answer, so the Paste key goes: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  labelOf(pkg: string): string | null {
    return this.#apps?.list.find((each) => each.pkg === pkg)?.label ?? null;
  }

  forgetApps(): void {
    this.#apps = null;
  }

  close(): void {
    this.#drop();
  }
}

export function appFor(apps: readonly LauncherApp[], wanted: string): LauncherApp | null {
  const asked = wanted.trim().toLowerCase();
  return (
    apps.find((each) => each.pkg.toLowerCase() === asked) ??
    apps.find((each) => each.label?.toLowerCase() === asked) ??
    apps.find((each) => each.pkg.split(".").at(-1)?.toLowerCase() === asked) ??
    null
  );
}
