import { spawnSync } from "node:child_process";
import fs from "node:fs";

const files = [
  "cli.mjs",
  "server/relay.mjs",
  "host/host-agent.mjs",
  "scripts/start.mjs",
  "scripts/terminal-qr.mjs",
  "scripts/smoke.mjs",
  "public/app.js",
  "public/sw.js"
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

for (const file of ["package.json", "public/manifest.json"]) {
  JSON.parse(fs.readFileSync(file, "utf8"));
}

console.log("Syntax and manifest checks passed.");
