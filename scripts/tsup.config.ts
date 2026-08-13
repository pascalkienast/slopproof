import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["scripts/migrate-db.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "scripts/dist",
  sourcemap: false,
  clean: true,
  splitting: false,
  noExternal: [/.*/],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  outExtension: () => ({ js: ".mjs" }),
});
