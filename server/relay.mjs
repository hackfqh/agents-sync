import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const sharedToken = process.env.MOBILE_COMPANION_TOKEN || "dev-token";

let nextSeq = 1;
let nextCommandSeq = 1;
let hostOnline = false;
let lastHostSeen = 0;

const events = [];
const threads = new Map();
const approvals = new Map();
const sseClients = new Set();
const pendingHostRequests = new Map();
const hostCommands = [];
const hostPolls = new Set();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"]
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/host/")) {
      await handleHost(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname === "/events") {
      handleSse(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(port, host, () => {
  console.log(`Codex Mobile Companion relay listening on http://${host}:${port}`);
  console.log(`Use token: ${sharedToken}`);
});

setInterval(() => {
  if (hostOnline && Date.now() - lastHostSeen > 45_000) {
    hostOnline = false;
    appendEvent({
      type: "host.status",
      hostOnline: false,
      message: "Host agent timed out"
    });
  }
}, 10_000);

async function handleHost(req, res, url) {
  if (!isAuthorized(req, url)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  markHostSeen();

  if (req.method === "GET" && url.pathname === "/host/commands") {
    handleHostCommands(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/host/messages") {
    const body = await readJson(req);
    const messages = Array.isArray(body) ? body : body.messages ? body.messages : [body];
    for (const message of messages) {
      handleHostMessage(message);
    }
    sendJson(res, 202, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function handleHostCommands(req, res, url) {
  const lastSeq = Number(url.searchParams.get("lastSeq") || 0);
  const commands = hostCommands.filter((command) => command.seq > lastSeq);

  if (commands.length) {
    sendJson(res, 200, {
      commands,
      serverCommandSeq: nextCommandSeq - 1
    });
    return;
  }

  const poll = {
    req,
    res,
    lastSeq,
    timer: setTimeout(() => {
      hostPolls.delete(poll);
      sendJson(res, 200, {
        commands: [],
        serverCommandSeq: nextCommandSeq - 1
      });
    }, 25_000)
  };

  hostPolls.add(poll);
  req.on("close", () => {
    clearTimeout(poll.timer);
    hostPolls.delete(poll);
  });
}

async function handleApi(req, res, url) {
  if (!isAuthorized(req, url)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      hostOnline,
      nextSeq,
      threads: Array.from(threads.values()).sort((a, b) => b.updatedAt - a.updatedAt),
      approvals: Array.from(approvals.values()).filter((item) => item.status === "pending"),
      recentEvents: events.slice(-200)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/message") {
    const body = await readJson(req);
    if (!body.text || typeof body.text !== "string") {
      sendJson(res, 400, { error: "text is required" });
      return;
    }

    const request = await sendHostRequest("user.message", {
      threadId: body.threadId || null,
      cwd: body.cwd || null,
      text: body.text
    });

    if (request.ok === false) {
      sendJson(res, 502, { error: request.error || "host request failed" });
      return;
    }

    sendJson(res, 202, request);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/approval") {
    const body = await readJson(req);
    if (!body.approvalId || !body.decision) {
      sendJson(res, 400, { error: "approvalId and decision are required" });
      return;
    }

    const approval = approvals.get(body.approvalId);
    if (!approval) {
      sendJson(res, 404, { error: "approval not found" });
      return;
    }

    const request = await sendHostRequest("approval.answer", {
      approvalId: body.approvalId,
      decision: body.decision
    });

    if (request.ok === false) {
      sendJson(res, 502, { error: request.error || "host request failed" });
      return;
    }

    approval.status = "answered";
    approval.decision = body.decision;
    approval.answeredAt = Date.now();

    appendEvent({
      type: "approval.answered",
      approvalId: body.approvalId,
      threadId: approval.threadId,
      turnId: approval.turnId,
      decision: body.decision
    });

    sendJson(res, 202, request);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    const request = await sendHostRequest("history.projects", {
      limit: Number(url.searchParams.get("limit") || 100),
      maxPages: Number(url.searchParams.get("maxPages") || 20)
    });

    sendHostResponse(res, request);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/history/threads") {
    const request = await sendHostRequest("history.threads", {
      cwd: url.searchParams.get("cwd") || null,
      cursor: url.searchParams.get("cursor") || null,
      limit: Number(url.searchParams.get("limit") || 50)
    });

    sendHostResponse(res, request);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/history/thread") {
    const threadId = url.searchParams.get("threadId");
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return;
    }

    const request = await sendHostRequest("history.thread.read", {
      threadId
    });

    sendHostResponse(res, request);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function handleSse(req, res, url) {
  if (!isAuthorized(req, url)) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("unauthorized");
    return;
  }

  const lastSeq = Number(url.searchParams.get("lastSeq") || 0);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });

  const client = { res };
  sseClients.add(client);

  res.write(`event: hello\n`);
  res.write(`data: ${JSON.stringify({ hostOnline, nextSeq })}\n\n`);

  for (const event of events) {
    if (event.seq > lastSeq) {
      writeSse(res, event);
    }
  }

  const heartbeat = setInterval(() => {
    res.write(`event: ping\n`);
    res.write(`data: ${JSON.stringify({ now: Date.now() })}\n\n`);
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  if (!stat.isFile()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes.get(ext) || "application/octet-stream"
  });
  fs.createReadStream(filePath).pipe(res);
}

function handleHostMessage(message) {
  if (message.replyTo) {
    const pending = pendingHostRequests.get(message.replyTo);
    if (pending) {
      pendingHostRequests.delete(message.replyTo);
      pending.resolve(message);
    }
    return;
  }

  if (message.type === "event" && message.event) {
    appendEvent(message.event);
    return;
  }

  if (message.type === "approval.request" && message.approval) {
    approvals.set(message.approval.approvalId, {
      ...message.approval,
      status: "pending",
      createdAt: message.approval.createdAt || Date.now()
    });
    appendEvent({
      type: "approval.requested",
      ...message.approval
    });
    return;
  }

  if (message.type === "thread.upsert" && message.thread) {
    upsertThread(message.thread);
    appendEvent({
      type: "thread.upserted",
      thread: message.thread
    });
    return;
  }

  appendEvent({
    type: "host.message",
    payload: message
  });
}

function appendEvent(input) {
  const event = {
    seq: nextSeq++,
    at: Date.now(),
    ...input
  };

  if (event.threadId) {
    const existing = threads.get(event.threadId) || {
      threadId: event.threadId,
      title: threadTitleFromEvent(event) || "Codex thread",
      createdAt: event.at,
      updatedAt: event.at
    };

    existing.updatedAt = event.at;
    const nextTitle = threadTitleFromEvent(event);
    if (nextTitle) existing.title = nextTitle;
    if (event.status) existing.status = event.status;
    threads.set(event.threadId, existing);
  }

  if (event.type === "thread.created" || event.type === "thread.updated") {
    upsertThread(event);
  }

  events.push(event);
  if (events.length > 5000) {
    events.splice(0, events.length - 5000);
  }

  for (const client of sseClients) {
    writeSse(client.res, event);
  }
}

function upsertThread(thread) {
  if (!thread.threadId) return;
  const existing = threads.get(thread.threadId) || {
    threadId: thread.threadId,
    createdAt: Date.now()
  };

  threads.set(thread.threadId, {
    ...existing,
    ...thread,
    updatedAt: Date.now()
  });
}

function threadTitleFromEvent(event) {
  if (event.type === "user.message" && event.text) {
    return firstLine(event.text);
  }
  if (event.type === "thread.created" || event.type === "thread.updated") {
    return event.title;
  }
  return undefined;
}

async function sendHostRequest(type, payload) {
  if (!hostOnline) {
    throw new ApiError(503, "host agent is offline");
  }

  const id = randomUUID();
  const command = {
    seq: nextCommandSeq++,
    id,
    type,
    payload,
    at: Date.now()
  };

  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingHostRequests.delete(id);
      reject(new ApiError(504, "host request timed out"));
    }, 90_000);
    pendingHostRequests.set(id, {
      resolve: (response) => {
        clearTimeout(timeout);
        resolve(response);
      },
      reject
    });
  });

  hostCommands.push(command);
  if (hostCommands.length > 500) {
    hostCommands.splice(0, hostCommands.length - 500);
  }
  flushHostPolls();

  return responsePromise;
}

function flushHostPolls() {
  for (const poll of Array.from(hostPolls)) {
    const commands = hostCommands.filter((command) => command.seq > poll.lastSeq);
    if (!commands.length) continue;

    clearTimeout(poll.timer);
    hostPolls.delete(poll);
    sendJson(poll.res, 200, {
      commands,
      serverCommandSeq: nextCommandSeq - 1
    });
  }
}

function markHostSeen() {
  lastHostSeen = Date.now();
  if (hostOnline) return;

  hostOnline = true;
  appendEvent({
    type: "host.status",
    hostOnline: true,
    message: "Host agent connected"
  });
}

function writeSse(res, event) {
  res.write(`event: companion\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isAuthorized(req, url) {
  if (!sharedToken) return true;

  const bearer = req.headers.authorization || "";
  if (bearer === `Bearer ${sharedToken}`) return true;

  const token = url.searchParams.get("token");
  return token === sharedToken;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, payload) {
  const code = payload instanceof ApiError ? payload.status : status;
  const body = payload instanceof ApiError ? { error: payload.message } : payload;
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(body));
}

function sendHostResponse(res, request) {
  if (request.ok === false) {
    sendJson(res, 502, { error: request.error || "host request failed" });
    return;
  }

  sendJson(res, 200, request.result || {});
}

function sendError(res, error) {
  if (error instanceof ApiError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  sendJson(res, 500, { error: error.message || String(error) });
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function firstLine(text) {
  const line = String(text).split(/\r?\n/, 1)[0].trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
