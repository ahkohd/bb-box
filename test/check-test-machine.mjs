import { refusalForThisMachine } from "./preflight.mjs";

const refusal = refusalForThisMachine();

if (refusal !== null) {
  if (process.env.VITEST) throw new Error(refusal);
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}
