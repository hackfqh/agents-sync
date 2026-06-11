#!/usr/bin/env node
import fs from "node:fs";

const argv = process.argv.slice(2);
const command = argv[0];

if (!command || command === "start") {
  await import("./scripts/start.mjs");
} else if (command === "-h" || command === "--help" || command === "help") {
  printHelp();
} else if (command === "-v" || command === "--version" || command === "version") {
  printVersion();
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp() {
  console.log(`Codex Mobile Companion

Usage:
  codex-mobile-companion
  codex-mobile-companion start
  codex-mobile-companion help

The command starts Relay, Codex App Server, and the Host Agent from the
current working directory.
`);
}

function printVersion() {
  const packageJson = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  console.log(packageJson.version || "0.1.0");
}
