import { spawnSync } from "node:child_process";

const files = [
  "server/relay.mjs",
  "host/host-agent.mjs",
  "public/app.js"
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("Syntax check passed.");
