// Copies xterm.js's stylesheet into src/app/xterm-css.ts. Run after upgrading @xterm/xterm.
import { readFileSync, writeFileSync } from "node:fs";
const css = readFileSync("node_modules/@xterm/xterm/css/xterm.css", "utf8");
const { version } = JSON.parse(readFileSync("node_modules/@xterm/xterm/package.json", "utf8"));
writeFileSync(
  "src/app/xterm-css.ts",
  `// xterm.js's own stylesheet (@xterm/xterm ${version}, css/xterm.css), as a string:\n// the plugin build has no CSS entry to import it from, so the terminal tab\n// puts it in the page once. Its selectors all start with .xterm, so it touches\n// nothing else. Regenerate with scripts/vendor-xterm-css.mjs after an upgrade.\n\nexport const XTERM_CSS = ${JSON.stringify(css)};\n`,
);
