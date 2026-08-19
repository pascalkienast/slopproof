import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "react",
    },
  },
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/.next/**"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
