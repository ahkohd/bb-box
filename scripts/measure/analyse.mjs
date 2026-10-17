// Sums up raw-<label>.json from drive.mjs (060): per phase, frames a second
// and the gaps between them, kbit/s through BB's server; the drag's lag
// behind the pointer per frame and its torn frames, whose rows disagree on
// the block's edge; key-to-screen; the SSIM of the fixed, coloured and
// moving text, still and halfway through the drag; and, given the box's CPU
// log (epoch seconds, busy and total ticks, cores, as cpu.sh writes it),
// the box's CPU in cores over each phase.
// usage: [CPU=<cpu.log>] node analyse.mjs <label>...
import { readFileSync } from "node:fs";
const pct = (xs, p) => (xs.length ? Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]) : null);
for (const label of process.argv.slice(2)) {
  const R = JSON.parse(readFileSync(`raw-${label}.json`, "utf8"));
  const within = (rows, [a, b]) => rows.filter((r) => r[0] >= a && r[0] <= b);
  const out = { label, kind: R.kind, size: R.size, scale: R.scale, ssim: R.ssim, ssimDrag: R.ssimDrag };
  const cpu = process.env.CPU ? readFileSync(process.env.CPU, "utf8").trim().split(/\r?\n/).map((l) => l.split(" ").map(Number)) : null;
  const epoch = (p) => (R.clock[0] + (p - R.clock[1])) / 1000;
  for (const [name, span] of Object.entries(R.phases)) {
    const frames = within(R.log, span), secs = (span[1] - span[0]) / 1000;
    const gaps = frames.slice(1).map((f, i) => f[0] - frames[i][0]);
    const o = { fps: Math.round((frames.length / secs) * 10) / 10, gapP50: pct(gaps, 50), gapP95: pct(gaps, 95), gapMax: pct(gaps, 100), kbit: Math.round((within(R.bytes, span).reduce((n, b) => n + b[1], 0) * 8) / secs / 1e3) };
    if (cpu) {
      const rows = cpu.filter((r) => r[0] >= epoch(span[0]) && r[0] <= epoch(span[1]));
      // Interval by interval, skipping any where the counters jump the
      // wrong way, as lxcfs's /proc/stat in a container now and then does.
      let busy = 0, total = 0;
      for (let i = 1; i < rows.length; i++) {
        const db = rows[i][1] - rows[i - 1][1], dt = rows[i][2] - rows[i - 1][2];
        if (db >= 0 && dt > 0 && db <= dt) { busy += db; total += dt; }
      }
      if (total) o.boxCores = Math.round((busy / total) * rows[0][3] * 100) / 100;
    }
    if (name === "drag") {
      const shown = frames.filter((f) => f[1] >= 0);
      // Where the block was before the drag: the last frame before it, which may be long before, as a server that sends
      // nothing while the screen is still does; else where the scene puts it.
      const edge0 = R.log.filter((f) => f[0] < span[0] && f[1] >= 0).at(-1)?.[1] ?? Math.round(100 * R.scale);
      const moves = within(R.moves, span);
      const reach = Math.max(...moves.map((m) => m[1]));
      const offset = !shown.length ? 0 : Math.max(...shown.map((f) => f[1])) - edge0 - reach;
      const tol = Math.max(2, Math.round(4 * R.scale));
      const lags = [];
      for (const [t, e] of shown) {
        const m = moves.filter((mv) => mv[0] <= t && Math.abs(edge0 + mv[1] + offset - e) <= tol).at(-1);
        if (m && t - m[0] < 3000) lags.push(t - m[0]);
      }
      // A torn frame: the block's edge differs down its height more than in the drag's typical frame, as part of the
      // frame is from before a move. A Mac draws a moving window with its rows a step apart in every frame, on the
      // screen itself, which is no stream's tearing.
      const usual = pct(shown.map((f) => f[2]), 50) ?? 0;
      const torn = shown.filter((f) => f[2] > usual + tol).length;
      Object.assign(o, { lagP50: pct(lags, 50), lagP95: pct(lags, 95), lagMax: pct(lags, 100), lagSamples: lags.length, torn, tornShare: shown.length ? Math.round((torn / shown.length) * 1000) / 10 : null });
    }
    if (name === "scroll" || name === "keys") {
      const lat = []; let missed = 0;
      for (const t of R.presses.filter((p) => p >= span[0] && p <= span[1])) {
        const v0 = R.log.filter((f) => f[0] < t).at(-1)?.[3];
        const hit = R.log.find((f) => f[0] >= t && v0 !== undefined && Math.abs(f[3] - v0) > 100);
        if (hit && hit[0] - t < 3000) lat.push(hit[0] - t); else missed++;
      }
      Object.assign(o, { keyP50: pct(lat, 50), keyP95: pct(lat, 95), keyMissed: missed });
    }
    out[name] = o;
  }
  console.log(JSON.stringify(out));
}
