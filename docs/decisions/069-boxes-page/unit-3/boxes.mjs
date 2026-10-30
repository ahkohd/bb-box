import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME;
const thread = process.env.RUN_THREAD;
const list = JSON.parse(execFileSync(join(home, "bbc"), ["box", "list", "--thread", thread, "--json"], { encoding: "utf8" }));
const containers = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}} {{.Labels}}"], { encoding: "utf8" }).trim().split("\n");
const boxes = list.map((box) => ({
  id: box.id,
  name: box.name,
  backend: box.form === "Docker" || box.backendLabel.startsWith("Docker") ? "docker" : box.form === "LXC" ? "lxc" : "vm",
  enrolled: box.enrol.state === "enrolled",
  address: box.address,
  container: containers.find((line) => line.includes(box.id))?.split(" ")[0] ?? null,
  role: null,
}));
const pick = (test) => boxes.find((box) => box.role === null && test(box));
const assign = (role, test) => {
  const box = pick(test);
  if (box) box.role = role;
};
assign("stopped", (box) => box.backend === "docker" && !box.enrolled);
assign("loaded", (box) => box.backend === "docker" && box.enrolled);
assign("cut", (box) => box.backend === "lxc" && !box.enrolled);
assign("quiet-lxc-machine", (box) => box.backend === "lxc" && box.enrolled);
assign("quiet-lxc-routed", (box) => box.backend === "lxc" && !box.enrolled);
assign("page", (box) => box.backend === "vm");
assign("page", (box) => box.backend === "docker" && box.enrolled);
assign("page", (box) => box.backend === "docker" && !box.enrolled);
assign("page", (box) => box.backend === "lxc" && box.enrolled);
assign("page", (box) => box.backend === "lxc" && !box.enrolled);
writeFileSync(join(home, "run", "boxes.json"), JSON.stringify(boxes, null, 2));
writeFileSync(join(home, "run", "plan.json"), JSON.stringify({ thread }, null, 2));
const count = (test) => boxes.filter(test).length;
console.log(`${boxes.length} boxes: ${count((box) => box.backend === "docker")} Docker, ${count((box) => box.backend === "lxc")} LXC, ${count((box) => box.backend === "vm")} VM; ${count((box) => box.enrolled)} BB machines, ${count((box) => !box.enrolled)} read through their route`);
for (const box of boxes) console.log(`${box.name} ${box.id} ${box.backend} ${box.enrolled ? "machine" : "route"} ${box.address} ${box.container ?? ""} ${box.role ?? ""}`);
