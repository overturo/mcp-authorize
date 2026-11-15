import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts", "src/legacy.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  outDir: "dist",
  target: "node20",
  external: ["@modelcontextprotocol/server", "@modelcontextprotocol/sdk", "@overturo/sdk"],
})
