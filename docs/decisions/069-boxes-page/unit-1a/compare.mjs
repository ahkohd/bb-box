import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

const [beforeDir, afterDir] = process.argv.slice(2);
const files = readdirSync(beforeDir).filter((file) => file.endsWith(".png") && !file.startsWith("failure"));
let differing = 0;
for (const file of files) {
  let after;
  try {
    after = PNG.sync.read(readFileSync(join(afterDir, file)));
  } catch {
    console.log(`${file}: missing after`);
    differing += 1;
    continue;
  }
  const before = PNG.sync.read(readFileSync(join(beforeDir, file)));
  if (before.width !== after.width || before.height !== after.height) {
    console.log(`${file}: size ${before.width}x${before.height} against ${after.width}x${after.height}`);
    differing += 1;
    continue;
  }
  let pixels = 0;
  const box = { left: Infinity, top: Infinity, right: -1, bottom: -1 };
  for (let index = 0; index < before.data.length; index += 4) {
    if (before.data[index] !== after.data[index] || before.data[index + 1] !== after.data[index + 1] || before.data[index + 2] !== after.data[index + 2]) {
      pixels += 1;
      const x = (index / 4) % before.width;
      const y = Math.floor(index / 4 / before.width);
      box.left = Math.min(box.left, x);
      box.top = Math.min(box.top, y);
      box.right = Math.max(box.right, x);
      box.bottom = Math.max(box.bottom, y);
    }
  }
  if (pixels) differing += 1;
  console.log(`${file}: ${pixels} of ${before.width * before.height} pixels differ${pixels ? `, within x ${box.left} to ${box.right}, y ${box.top} to ${box.bottom}` : ""}`);
}
console.log(`${files.length} screenshots, ${differing} differ`);
