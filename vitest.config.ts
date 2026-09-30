// vitest runs only the panel's tests, which need a DOM and JSX. The rest run
// under node --test.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.tsx"], environment: "jsdom" },
});
