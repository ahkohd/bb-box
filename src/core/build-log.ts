import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEPT_PER_NAME = 5;
const STEP = /^#\d+ \[([^\]]+ \d+\/\d+)\]/;
const BUILDKIT_OUTPUT = /^#\d+ /;

export function buildLogDir(): string {
  return join(tmpdir(), "bb-box-build-logs");
}

export class BuildLog {
  readonly path: string;
  readonly #steps = new Set<string>();

  constructor(name: string, startedAt: number, dir = buildLogDir()) {
    const base = name.replace(/[^A-Za-z0-9._-]+/g, "-");
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${base}-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.log`);
    appendFileSync(this.path, "");
    const older = readdirSync(dir).filter((file) => file.startsWith(`${base}-2`) && file.endsWith(".log")).sort();
    for (const file of older.slice(0, Math.max(0, older.length - KEPT_PER_NAME))) rmSync(join(dir, file), { force: true });
  }

  write(line: string): string | null {
    const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
    if (!clean.trim()) return null;
    appendFileSync(this.path, `${clean}\n`);
    const step = STEP.exec(clean);
    if (step) {
      if (this.#steps.has(step[1]!)) return null;
      this.#steps.add(step[1]!);
      return clean.slice(0, 300);
    }
    return BUILDKIT_OUTPUT.test(clean) ? null : clean.slice(0, 300);
  }
}
