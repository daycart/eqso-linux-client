import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "fs";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/main.mjs",
  sourcemap: true,
  external: ["ffmpeg-static"],
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});

// Copiar el helper Python de PTT serial junto al .mjs
mkdirSync("dist", { recursive: true });
copyFileSync("src/ptt-helper.py", "dist/ptt-helper.py");

console.log("relay-daemon build OK");
