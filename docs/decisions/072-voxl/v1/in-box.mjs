import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";

const { BOX, CONTAINER, LIVE_THREAD } = process.env;
const SESSION = "DISPLAY=:99 XAUTHORITY=/run/bb-box/Xauthority XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus";
const bbc = join(process.env.HOME, "bbc");

function argv(script, asRoot, timeoutSeconds) {
  if (CONTAINER) return ["docker", ["exec", ...(asRoot ? [] : ["-u", "box"]), CONTAINER, "sh", "-c", `export ${SESSION}; ${script}`]];
  return [bbc, ["box", "run", BOX, `export ${SESSION}; ${script}`, "--thread", LIVE_THREAD, "--timeout-seconds", String(timeoutSeconds)]];
}

export function inBox(script, { timeoutSeconds = 120 } = {}) {
  const [command, args] = argv(script, false, timeoutSeconds);
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function inBoxLater(script, timeoutSeconds) {
  const [command, args] = argv(script, false, timeoutSeconds);
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
  let text = "";
  child.stdout.on("data", (chunk) => (text += chunk));
  return new Promise((resolve) => child.on("close", () => resolve(text)));
}
