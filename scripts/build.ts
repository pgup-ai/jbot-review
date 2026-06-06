import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/workflow/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/workflow/index.js",
  external: ["@actions/core", "@actions/github"],
});

await esbuild.build({
  entryPoints: ["src/app/server.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/app/server.js",
  external: [],
});

console.log("Build complete.");
