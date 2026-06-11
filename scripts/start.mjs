import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { renderQr } from "./terminal-qr.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = process.env.MOBILE_COMPANION_TOKEN || "dev-token";
const host = process.env.HOST || "0.0.0.0";
const port = process.env.PORT || "8787";
const codexListen = process.env.CODEX_LISTEN || "ws://127.0.0.1:7331";
const relayUrl = process.env.RELAY_URL || `http://127.0.0.1:${port}`;
const codexWsUrl = process.env.CODEX_WS_URL || codexListen;
const shouldStartCodex = process.env.CODEX_START !== "0";
const codexCommand = process.env.CODEX_COMMAND || "codex";
const shouldPrintQr = process.env.START_QR !== "0";

const children = [];
let shuttingDown = false;

start("relay", process.execPath, [path.join(scriptRoot, "server/relay.mjs")], {
  HOST: host,
  PORT: port,
  MOBILE_COMPANION_TOKEN: token
});

if (shouldStartCodex) {
  start("codex", codexCommand, ["app-server", "--listen", codexListen], {}, {
    shell: process.platform === "win32"
  });
} else {
  console.log(`Codex app-server start skipped; using ${codexWsUrl}`);
}

setTimeout(() => {
  start("host", process.execPath, [path.join(scriptRoot, "host/host-agent.mjs")], {
    RELAY_URL: relayUrl,
    CODEX_WS_URL: codexWsUrl,
    MOBILE_COMPANION_TOKEN: token
  });
}, Number(process.env.HOST_AGENT_DELAY_MS || 1200));

printUrls();

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
});

function start(label, command, args, extraEnv, options = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: Boolean(options.shell),
    windowsHide: true
  });

  children.push(child);

  child.stdout.on("data", (chunk) => writeLines(label, chunk));
  child.stderr.on("data", (chunk) => writeLines(label, chunk));

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`[${label}] exited with ${signal || code}`);
    if (label === "relay" || label === "codex") {
      shutdown(`${label} exited`);
    }
  });

  child.on("error", (error) => {
    console.error(`[${label}] ${error.message}`);
    if (label === "relay" || label === "codex") {
      shutdown(`${label} failed`);
    }
  });

  return child;
}

function writeLines(label, chunk) {
  for (const line of chunk.toString("utf8").split(/\r?\n/)) {
    if (line.trim()) {
      console.log(`[${label}] ${line}`);
    }
  }
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Stopping Codex Mobile Companion (${reason})...`);

  for (const child of children.toReversed()) {
    if (!child.killed) child.kill("SIGTERM");
  }

  setTimeout(() => {
    for (const child of children.toReversed()) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(0);
  }, 2500).unref();
}

function printUrls() {
  const localUrl = `http://localhost:${port}/?token=${encodeURIComponent(token)}`;
  const lanUrls = getLanHosts().map((address) => `http://${address}:${port}/?token=${encodeURIComponent(token)}`);
  const qrUrl = lanUrls[0] || localUrl;

  console.log("Codex Mobile Companion starting...");
  console.log(`Local: ${localUrl}`);
  for (const url of lanUrls) {
    console.log(`LAN:   ${url}`);
  }
  printQr(qrUrl);
}

function printQr(url) {
  if (!shouldPrintQr) return;

  try {
    console.log("");
    console.log("Scan on mobile:");
    console.log(renderQr(url));
    console.log(url);
  } catch (error) {
    console.log(`QR skipped: ${error.message}`);
  }
}

function getLanHosts() {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push(item.address);
      }
    }
  }
  return addresses;
}
