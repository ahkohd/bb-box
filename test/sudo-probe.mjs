import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

const ANSWERS = { noPassword: "no-password", needsPassword: "needs-password", inconclusive: "inconclusive" };
const SUDO_NEEDS_A_PASSWORD = 1;
const STDOUT = 1;

const [sudo, answerWithinMs, killAfterMs] = process.argv.slice(2);
const child = spawn(sudo, ["-n", "true"], { stdio: "ignore", detached: true, env: { PATH: process.env.PATH ?? "" } });
let deadlinePassed = false;
let answered = false;

function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {}
}

function answerFromExit(code) {
  if (deadlinePassed) return ANSWERS.inconclusive;
  if (code === 0) return ANSWERS.noPassword;
  if (code === SUDO_NEEDS_A_PASSWORD) return ANSWERS.needsPassword;
  return ANSWERS.inconclusive;
}

function answer(value) {
  if (answered) return;
  answered = true;
  writeSync(STDOUT, value);
  signalGroup("SIGKILL");
  process.exit(0);
}

setTimeout(() => {
  deadlinePassed = true;
  signalGroup("SIGTERM");
}, Number(answerWithinMs));
setTimeout(() => answer(ANSWERS.inconclusive), Number(answerWithinMs) + Number(killAfterMs));
child.on("error", () => answer(ANSWERS.inconclusive));
child.on("exit", (code) => answer(answerFromExit(code)));
