import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const token = `test-${Date.now()}`;
const port = String(19000 + Math.floor(Math.random() * 1000));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-smoke-"));
const dataFile = path.join(tmpDir, "relay-state.json");
const baseUrl = `http://127.0.0.1:${port}`;

let relay = null;

try {
  const cli = spawnSync(process.execPath, ["cli.mjs", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert(cli.status === 0, "cli help should exit cleanly");
  assert((cli.stdout || "").includes("Codex Mobile Companion"), "cli help should print usage");

  relay = await startRelay();
  await expectStatus("/api/bootstrap", {}, 401);

  const session = await jsonFetch("/api/session", {
    method: "POST",
    headers: authHeaders(token)
  });
  assert(session.token?.startsWith("sess_"), "session token should be returned");

  const secondSession = await jsonFetch("/api/session", {
    method: "POST",
    headers: authHeaders(token)
  });

  const bootstrap = await jsonFetch("/api/bootstrap", {
    headers: authHeaders(session.token)
  });
  assert(Array.isArray(bootstrap.agents), "bootstrap should include agents");

  const sessions = await jsonFetch("/api/sessions", {
    headers: authHeaders(session.token)
  });
  assert(sessions.sessions.length >= 2, "sessions should list browser sessions");

  await jsonFetch(`/api/sessions/${secondSession.sessionId}`, {
    method: "DELETE",
    headers: authHeaders(session.token)
  });

  await jsonFetch("/host/messages", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      type: "event",
      event: {
        agent: "codex",
        type: "user.message",
        threadId: "smoke-thread",
        text: "hello smoke"
      }
    })
  });

  await jsonFetch("/api/thread-meta", {
    method: "POST",
    headers: authHeaders(session.token),
    body: JSON.stringify({
      agent: "codex",
      threadId: "smoke-thread",
      title: "Smoke renamed",
      pinned: true,
      starred: true
    })
  });

  const search = await jsonFetch("/api/search?q=smoke&agent=all", {
    headers: authHeaders(session.token)
  });
  assert(search.results.some((item) => item.threadId === "smoke-thread"), "global search should find smoke thread");

  const exported = await jsonFetch("/api/export", {
    headers: authHeaders(session.token)
  });
  assert(exported.threadMeta.some((meta) => meta.threadId === "smoke-thread" && meta.starred), "export should include starred thread metadata");

  const debug = await jsonFetch("/api/debug", {
    headers: authHeaders(session.token)
  });
  assert(debug.relay?.events >= 1, "debug should report stored events");
  assert(debug.relay?.threadMeta >= 1, "debug should report thread metadata");

  await wait(500);
  await stopRelay(relay);
  relay = await startRelay();

  const restored = await jsonFetch("/api/bootstrap", {
    headers: authHeaders(token)
  });
  assert(restored.recentEvents.some((event) => event.threadId === "smoke-thread"), "events should survive relay restart");
  assert(restored.threadMeta.some((meta) => meta.threadId === "smoke-thread" && meta.pinned), "thread metadata should survive relay restart");

  console.log("Smoke checks passed.");
} finally {
  if (relay) await stopRelay(relay).catch(() => {});
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function startRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server/relay.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: port,
        MOBILE_COMPANION_TOKEN: token,
        COMPANION_DATA_FILE: dataFile
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("relay did not start"));
    }, 5000);

    child.stdout.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("relay listening")) {
        clearTimeout(timeout);
        resolve(child);
      }
    });

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) console.error(message);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("exit", (code) => {
      if (code && code !== 0) {
        clearTimeout(timeout);
      }
    });
  });
}

function stopRelay(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 1000).unref();
  });
}

async function expectStatus(pathname, options, status) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  assert(response.status === status, `${pathname} should return ${status}, got ${response.status}`);
}

async function jsonFetch(pathname, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `request failed with ${response.status}`);
  }
  return payload;
}

function authHeaders(value) {
  return {
    Authorization: `Bearer ${value}`
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
