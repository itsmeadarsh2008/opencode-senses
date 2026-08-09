import { mkdir, cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");
const runtime = resolve(root, "python", "runtime.py");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Bundle the plugin for the OpenCode plugin runtime (Bun-compatible).
await Bun.build({
  entrypoints: [resolve(root, "src/plugin.ts")],
  outdir: dist,
  target: "bun",
  format: "esm",
  define: {
    "process.env.SENSES_VERSION": JSON.stringify("0.1.0"),
  },
});

// Ship the Python runtime alongside so the plugin can find it without the repo.
const pyDist = resolve(dist, "python");
await mkdir(pyDist, { recursive: true });
await cp(runtime, resolve(pyDist, "runtime.py"));

console.log("built dist/plugin.js + dist/python/runtime.py");