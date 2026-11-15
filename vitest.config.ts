import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const src = (file: string) => fileURLToPath(new URL(`./src/${file}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: "@overturo/mcp-authorize/server", replacement: src("server.ts") },
      { find: "@overturo/mcp-authorize/legacy", replacement: src("legacy.ts") },
      { find: "@overturo/mcp-authorize", replacement: src("index.ts") },
    ],
  },
  test: {
    environment: "node",
    globals: true,
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
})
