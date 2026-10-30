const base = process.env.LIVE_BB ?? "http://127.0.0.1:7801";

async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

const ADDED = [
  ["b", "Docker on build-1", "bbbox/linux:1"],
  ["c", "Docker on build-2", "bbbox/linux:1"],
  ["d", "Docker on build-3", "bbbox/linux:1"],
  ["e", "Docker on build-4", "bbbox/linux:1"],
  ["f", "Docker on test-1", "bb-live/due:1"],
  ["g", "Docker on test-2", "bb-live/fails:1"],
];

const state = await rpc("config.get");
const document = structuredClone(state.document);
document.backends = document.backends.filter((backend) => !ADDED.some(([each]) => backend.id === `docker:${each}`));
for (const [each, label, image] of ADDED) {
  document.backends.push({ id: `docker:${each}`, type: "docker", enabled: true, label, fields: { host: `unix:///run/bb-docker-${each}.sock`, "linux-image": image, "reserve-memory-mib": 512 } });
}
const result = await rpc("config.apply", { draft: document, revision: state.revision });
if (!result.ok) throw new Error(JSON.stringify(result));
console.log(`backends: ${result.state.document.backends.map((backend) => backend.id).join(", ")}`);
