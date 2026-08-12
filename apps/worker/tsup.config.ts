import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: [/^@slopproof\//],
  outExtension: () => ({ js: ".cjs" }),
});
