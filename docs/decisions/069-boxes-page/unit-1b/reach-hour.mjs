import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME;
const base = "http://127.0.0.1:7801";
const [name, thread, container, minutes] = process.argv.slice(2);
const out = join(home, "g7.log");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (record) => appendFileSync(out, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`);
const bb = (args) => {
  try {
    return execFileSync(join(home, "bbc"), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return `exit ${error.status}: ${error.stderr ?? ""}${error.stdout ?? ""}`;
  }
};
async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return (await response.json()).result;
}
const reach = async () => (await rpc("allBoxes")).find((entry) => entry.box.name === name)?.box.reach;
const dockerLines = () => readFileSync(join(home, "docker-calls.log"), "utf8").split("\n").filter(Boolean);
const serverLog = () => readFileSync(join(home, "bbdata", "logs", "server.1.log"), "utf8").split("\n").filter((line) => line.includes("Reach check") && line.includes(`box ${name} `));

writeFileSync(out, "");
const dockerStart = dockerLines().length;
const logStart = serverLog().length;
const t0 = Date.now();
execFileSync("/usr/bin/docker", ["pause", container]);
note({ step: "paused", container });
note({ step: "command", answer: bb(["box", "run", name, "true", "--thread", thread]).trim().slice(0, 300) });
note({ step: "reach", reach: await reach() });
let monitorOff = false;
while (Date.now() - t0 < Number(minutes) * 60_000) {
  await pause(20_000);
  if (!monitorOff && Date.now() - t0 > (Number(minutes) / 2) * 60_000) {
    note({ step: "monitor off", answer: bb(["box", "option", "set", "monitor.enabled=false"]).trim().slice(0, 200) });
    monitorOff = true;
  }
  note({ step: "reach", reach: await reach() });
}
const calls = dockerLines().slice(dockerStart).filter((line) => line.includes(container));
note({ step: "hour done", reachLines: serverLog().slice(logStart).map((line) => JSON.parse(line).msg), dockerCallsForBox: calls.map((line) => line.split(" ").slice(0, 3).join(" ")) });
const dockerBeforeCheck = dockerLines().length;
note({ step: "check now", result: (await rpc("refresh", { threadId: thread, box: name }))?.box?.reach });
note({ step: "check now calls", calls: dockerLines().slice(dockerBeforeCheck).filter((line) => line.includes(container)).map((line) => line.split(" ").slice(0, 3).join(" ")) });
const dockerBeforeSecond = dockerLines().length;
note({ step: "check now again", result: (await rpc("refresh", { threadId: thread, box: name }))?.box?.reach });
note({ step: "second check calls", calls: dockerLines().slice(dockerBeforeSecond).filter((line) => line.includes(container)).map((line) => line.split(" ").slice(0, 3).join(" ")) });
execFileSync("/usr/bin/docker", ["unpause", container]);
note({ step: "unpaused" });
note({ step: "check now after unpause", result: (await rpc("refresh", { threadId: thread, box: name }))?.box?.reach });
note({ step: "monitor on", answer: bb(["box", "option", "set", "monitor.enabled=true"]).trim().slice(0, 200) });
note({ step: "done" });
