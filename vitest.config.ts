// vitest runs only the panel's tests, which need a DOM and JSX. The rest run
// under node --test. "@/" is the vendored components' alias, as in tsconfig,
// and so is noVNC's core, whose package exports only its RFB class.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@novnc\/novnc\/core\/(.*)$/, replacement: `${fileURLToPath(new URL("./node_modules/@novnc/novnc/core/", import.meta.url))}$1` },
      { find: "@", replacement: fileURLToPath(new URL(".", import.meta.url)) },
    ],
  },
  test: { include: ["test/**/*.test.tsx"], environment: "jsdom", hookTimeout: 30_000 },
});
