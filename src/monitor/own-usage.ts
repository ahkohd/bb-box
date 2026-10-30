export const PS_COLUMNS = "pid=,ppid=,time=,rss=,lstart=";

export const NATIVE_MARK = "@native";

export type CounterMode = "with-children" | "self-only";

export interface OwnProcess {
  readonly pid: number;
  readonly started: string;
  readonly ppid: number | null;
  readonly selfSeconds: number;
  readonly childSeconds: number;
  readonly memoryBytes: number;
}

export interface OwnReading {
  readonly mode: CounterMode;
  readonly rows: readonly OwnProcess[];
}

export interface OwnUsage {
  readonly cpuCores: number | null;
  readonly memoryBytes: number;
  readonly processes: number;
}

export function psOwnArgs(uid: number): string[] {
  return ["-U", String(uid), "-o", PS_COLUMNS];
}

export function psOwnCommand(): string {
  return `LC_ALL=C ps -U "$(id -u)" -o ${PS_COLUMNS}`;
}

export const RUSAGE_V2_BYTES = 160;

const CANARY_BYTES = 64;

const CANARY = 165;

export const MAC_OWN_READER = [
  "import ctypes, os",
  'c = ctypes.CDLL("/usr/lib/libSystem.B.dylib")',
  'class T(ctypes.Structure): _fields_ = [("n", ctypes.c_uint32), ("d", ctypes.c_uint32)]',
  'F = "user system idle intr pageins wired resident footprint start exit cuser csystem cidle cintr cpageins celapsed dread dwrite".split()',
  `class R(ctypes.Structure): _fields_ = [("u", ctypes.c_uint8 * 16)] + [(f, ctypes.c_uint64) for f in F] + [("g", ctypes.c_uint8 * ${CANARY_BYTES})]`,
  `if ctypes.sizeof(R) != ${RUSAGE_V2_BYTES + CANARY_BYTES} or R.g.offset != ${RUSAGE_V2_BYTES}: raise SystemExit(3)`,
  "t = T(); c.mach_timebase_info(ctypes.byref(t)); k = t.n / t.d / 1e9; uid = os.getuid()",
  "n = c.proc_listpids(4, uid, None, 0) // 4 + 64; p = (ctypes.c_int * n)(); got = c.proc_listpids(4, uid, p, ctypes.sizeof(p)) // 4",
  `out = ["${NATIVE_MARK}"]`,
  "for pid in p[:got]:",
  `  r = R(); ctypes.memset(ctypes.addressof(r) + ${RUSAGE_V2_BYTES}, ${CANARY}, ${CANARY_BYTES}); b = (ctypes.c_uint32 * 34)()`,
  "  if pid <= 0 or c.proc_pid_rusage(pid, 2, ctypes.byref(r)) != 0: continue",
  `  if bytes(r.g) != bytes([${CANARY}]) * ${CANARY_BYTES}: raise SystemExit(4)`,
  "  q = b[4] if c.proc_pidinfo(pid, 3, 0, b, ctypes.sizeof(b)) > 0 else -1",
  '  out.append("%d %d %.3f %.3f %d %d" % (pid, q, (r.user + r.system) * k, (r.cuser + r.csystem) * k, r.footprint // 1024, r.start))',
  'print("\\n".join(out))',
].join("\n");

export const MAC_PYTHON = "/usr/bin/python3";

export const DEVELOPER_TOOLS_CHECK = "xcode-select -p >/dev/null 2>&1";

export function macOwnCommand(): string {
  return `{ ${DEVELOPER_TOOLS_CHECK} && ${MAC_PYTHON} -c '${MAC_OWN_READER}' 2>/dev/null; } || ${psOwnCommand()}`;
}

export type Run = (file: string, args: readonly string[]) => Promise<string>;

const TOOLS_LOOKED_AGAIN_MS = 10 * 60_000;

export function developerToolsLook(run: Run, now: () => number = Date.now): () => Promise<boolean> {
  let known: { readonly there: boolean; readonly at: number } | null = null;
  return async () => {
    if (known && now() - known.at < TOOLS_LOOKED_AGAIN_MS) return known.there;
    const there = await run("xcode-select", ["-p"]).then(() => true, () => false);
    known = { there, at: now() };
    return there;
  };
}

export async function readMacOwn(run: Run, uid: number, toolsThere: () => Promise<boolean>): Promise<string> {
  if (await toolsThere()) {
    try {
      return await run(MAC_PYTHON, ["-c", MAC_OWN_READER]);
    } catch {
      return run("ps", psOwnArgs(uid));
    }
  }
  return run("ps", psOwnArgs(uid));
}

export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return null;
  const [days, hours, minutes, seconds] = [match[1], match[2], match[3], match[4]].map((part) => Number(part ?? 0)) as [number, number, number, number];
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

function nativeRow(fields: readonly string[]): OwnProcess | null {
  if (fields.length !== 6) return null;
  const [pid, ppid, self, children, kib] = fields.slice(0, 5).map(Number) as [number, number, number, number, number];
  const started = fields[5]!;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ![self, children, kib].every(Number.isFinite) || !/^\d+$/.test(started)) return null;
  return { pid, started, ppid: ppid > 0 ? ppid : null, selfSeconds: self, childSeconds: children, memoryBytes: kib * 1024 };
}

function psRow(fields: readonly string[]): OwnProcess | null {
  if (fields.length < 5) return null;
  const [pid, ppid] = [Number(fields[0]), Number(fields[1])];
  const self = parseCpuTime(fields[2]!);
  const kib = Number(fields[3]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || self === null || !Number.isFinite(kib)) return null;
  return { pid, started: fields.slice(4).join(" "), ppid: ppid > 0 ? ppid : null, selfSeconds: self, childSeconds: 0, memoryBytes: kib * 1024 };
}

export function parseOwnReading(source: string): OwnReading {
  const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
  const native = lines[0] === NATIVE_MARK;
  const rows = (native ? lines.slice(1) : lines).flatMap((line) => {
    const row = (native ? nativeRow : psRow)(line.split(/\s+/));
    return row ? [row] : [];
  });
  return { mode: native ? "with-children" : "self-only", rows };
}

const keyOf = (row: Pick<OwnProcess, "pid" | "started">) => `${row.pid}@${row.started}`;

interface Seen {
  readonly row: OwnProcess;
  readonly ppid: number | null;
  readonly uncounted: number;
}

interface Owed {
  readonly seconds: number;
  readonly readings: number;
}

interface Taken {
  readonly at: number;
  readonly mode: CounterMode;
  readonly byKey: ReadonlyMap<string, Seen>;
  readonly owed: ReadonlyMap<string, Owed>;
}

const OWED_FOR_READINGS = 2;

function waiter(ppid: number | null, before: ReadonlyMap<string, Seen>, beforeByPid: ReadonlyMap<number, string>, now: ReadonlyMap<string, Seen>): string | null {
  const passed = new Set<string>();
  let parent = ppid;
  while (parent !== null) {
    const key = beforeByPid.get(parent);
    if (!key || passed.has(key)) return null;
    if (now.has(key)) return key;
    passed.add(key);
    parent = before.get(key)?.ppid ?? null;
  }
  return null;
}

export function createOwnUsage() {
  let previous: Taken | null = null;
  return {
    take(reading: OwnReading, at: number): OwnUsage {
      const memoryBytes = reading.rows.reduce((sum, row) => sum + row.memoryBytes, 0);
      const was = previous && previous.mode === reading.mode && at > previous.at ? previous : null;
      const withChildren = reading.mode === "with-children";
      const now = new Map<string, Seen>();
      let work = 0;
      const childGrowth = new Map<string, number>();
      for (const row of reading.rows) {
        const key = keyOf(row);
        const known = was?.byKey.get(key);
        const ppid = row.ppid ?? known?.ppid ?? null;
        if (!known && ppid === null && withChildren) {
          now.set(key, { row, ppid, uncounted: row.selfSeconds + row.childSeconds });
          continue;
        }
        now.set(key, { row, ppid, uncounted: known?.uncounted ?? 0 });
        work += Math.max(0, row.selfSeconds - (known?.row.selfSeconds ?? 0));
        if (withChildren) childGrowth.set(key, Math.max(0, row.childSeconds - (known?.row.childSeconds ?? 0)));
      }
      if (!was) {
        previous = { at, mode: reading.mode, byKey: now, owed: new Map() };
        return { cpuCores: null, memoryBytes, processes: reading.rows.length };
      }
      const owed = new Map<string, Owed>();
      if (withChildren) {
        const beforeByPid = new Map([...was.byKey].map(([key, seen]) => [seen.row.pid, key]));
        const owe = (key: string | null, seconds: number, readings: number) => {
          if (key === null || seconds <= 0 || readings >= OWED_FOR_READINGS) return;
          const held = owed.get(key);
          owed.set(key, { seconds: (held?.seconds ?? 0) + seconds, readings: Math.max(held?.readings ?? 0, readings) });
        };
        for (const [key, debt] of was.owed) owe(now.has(key) ? key : waiter(was.byKey.get(key)?.ppid ?? null, was.byKey, beforeByPid, now), debt.seconds, debt.readings + 1);
        for (const [key, gone] of was.byKey) {
          if (!now.has(key)) owe(waiter(gone.ppid, was.byKey, beforeByPid, now), gone.row.selfSeconds + gone.row.childSeconds - gone.uncounted, 0);
        }
        for (const [key, debt] of owed) {
          const growth = childGrowth.get(key) ?? 0;
          const settled = Math.min(debt.seconds, growth);
          childGrowth.set(key, growth - settled);
          if (debt.seconds > settled) owed.set(key, { ...debt, seconds: debt.seconds - settled });
          else owed.delete(key);
        }
        for (const growth of childGrowth.values()) work += growth;
      }
      previous = { at, mode: reading.mode, byKey: now, owed };
      return { cpuCores: work / ((at - was.at) / 1000), memoryBytes, processes: reading.rows.length };
    },
    reset() {
      previous = null;
    },
  };
}

export type OwnUsageMeter = ReturnType<typeof createOwnUsage>;
