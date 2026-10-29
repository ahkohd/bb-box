import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const sdkStandIn = fileURLToPath(new URL("./src/sdk-stand-in.tsx", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: [
      { find: "@get-bb/plugin-sdk/app", replacement: sdkStandIn },
      { find: /^@\//, replacement: repository },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: { fs: { allow: [repository] } },
});
