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
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const dataFile = process.env.COMPANION_DATA_FILE
  || path.join(rootDir, ".companion-data", "relay-state.json");
const supportedAgents = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" }
];

let nextSeq = 1;
let nextCommandSeq = 1;
let hostOnline = false;
let lastHostSeen = 0;

const events = [];
const threads = new Map();
const threadMeta = new Map();
const approvals = new Map();
const browserSessions = new Map();
const sseClients = new Set();
const pendingHostRequests = new Map();
const hostCommands = [];
const hostPolls = new Set();
let saveTimer = null;
let storageLoadedAt = 0;
let lastSavedAt = 0;
let lastSaveError = "";

loadPersistedState();

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

setInterval(cleanupBrowserSessions, 60_000);

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

  if (req.method === "POST" && url.pathname === "/api/session") {
    const session = createBrowserSession(req);
    sendJson(res, 201, {
      token: session.token,
      sessionId: session.id,
      expiresAt: session.expiresAt
    });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/session") {
    const bearer = bearerToken(req);
    if (browserSessions.has(bearer)) {
      browserSessions.delete(bearer);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      hostOnline,
      nextSeq,
      agents: supportedAgents,
      threads: Array.from(threads.values()).sort((a, b) => b.updatedAt - a.updatedAt),
      threadMeta: Array.from(threadMeta.values()),
      approvals: Array.from(approvals.values()).filter((item) => item.status === "pending"),
      recentEvents: events.slice(-200)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    sendJson(res, 200, {
      sessions: listBrowserSessions(req)
    });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
    const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
    const deleted = revokeBrowserSession(sessionId);
    sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "session not found" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/debug") {
    sendJson(res, 200, debugSnapshot());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    const query = url.searchParams.get("q") || "";
    const agentParam = url.searchParams.get("agent") || "all";
    const agent = agentParam === "all" ? "all" : normalizeAgent(agentParam);
    const limit = Number(url.searchParams.get("limit") || 50);
    sendJson(res, 200, {
      query,
      agent,
      results: searchThreads({ query, agent, limit })
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/export") {
    sendJson(res, 200, exportSnapshot());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/message") {
    const body = await readJson(req);
    if (!body.text || typeof body.text !== "string") {
      sendJson(res, 400, { error: "text is required" });
      return;
    }

    const request = await sendHostRequest("user.message", {
      agent: normalizeAgent(body.agent),
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

  if (req.method === "POST" && url.pathname === "/api/message/broadcast") {
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const agents = Array.isArray(body.agents) ? body.agents.map(normalizeAgent) : [];
    const uniqueAgents = Array.from(new Set(agents));

    if (!text) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }
    if (!uniqueAgents.length) {
      sendJson(res, 400, { error: "agents are required" });
      return;
    }

    const results = [];
    for (const agent of uniqueAgents) {
      try {
        const result = await sendHostRequest("user.message", {
          agent,
          threadId: null,
          cwd: body.cwd || null,
          text
        });
        results.push({ agent, ok: result.ok !== false, result: result.result || result, error: result.error });
      } catch (error) {
        results.push({ agent, ok: false, error: error.message || String(error) });
      }
    }

    sendJson(res, 202, { results });
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
      agent: approval.agent || "codex",
      approvalId: body.approvalId,
      threadId: approval.threadId,
      turnId: approval.turnId,
      decision: body.decision
    });

    sendJson(res, 202, request);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/thread-meta") {
    const body = await readJson(req);
    const agent = normalizeAgent(body.agent);
    const threadId = body.threadId;
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return;
    }

    const meta = updateThreadMeta({
      agent,
      threadId,
      title: body.title,
      pinned: body.pinned,
      archived: body.archived,
      starred: body.starred
    });

    appendEvent({
      type: "thread.metadata.updated",
      agent,
      threadId,
      meta
    });
    sendJson(res, 200, { meta });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    const request = await sendHostRequest("history.projects", {
      agent: normalizeAgent(url.searchParams.get("agent")),
      limit: Number(url.searchParams.get("limit") || 100),
      maxPages: Number(url.searchParams.get("maxPages") || 20)
    });

    sendHostResponse(res, request);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/history/threads") {
    const request = await sendHostRequest("history.threads", {
      agent: normalizeAgent(url.searchParams.get("agent")),
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
      agent: normalizeAgent(url.searchParams.get("agent")),
      threadId,
      cwd: url.searchParams.get("cwd") || null
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
      agent: message.approval.agent || "codex",
      ...message.approval
    });
    return;
  }

  if (message.type === "thread.upsert" && message.thread) {
    upsertThread(message.thread);
    appendEvent({
      type: "thread.upserted",
      agent: message.thread.agent || "codex",
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
    agent: input.agent || "codex",
    ...input
  };

  if (event.threadId) {
    const existing = threads.get(threadKey(event.agent, event.threadId)) || {
      agent: event.agent,
      threadId: event.threadId,
      title: threadTitleFromEvent(event) || "Codex thread",
      createdAt: event.at,
      updatedAt: event.at
    };

    existing.updatedAt = event.at;
    const nextTitle = threadTitleFromEvent(event);
    if (nextTitle) existing.title = nextTitle;
    if (event.status) existing.status = event.status;
    threads.set(threadKey(event.agent, event.threadId), applyThreadMeta(existing));
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

  schedulePersistedState();
}

function upsertThread(thread) {
  if (!thread.threadId) return;
  const agent = thread.agent || "codex";
  const existing = threads.get(threadKey(agent, thread.threadId)) || {
    agent,
    threadId: thread.threadId,
    createdAt: Date.now()
  };

  threads.set(threadKey(agent, thread.threadId), applyThreadMeta({
    ...existing,
    ...thread,
    agent,
    updatedAt: Date.now()
  }));
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

function updateThreadMeta(input) {
  const key = threadMetaKey(input.agent, input.threadId);
  const existing = threadMeta.get(key) || {
    agent: normalizeAgent(input.agent),
    threadId: input.threadId,
    createdAt: Date.now()
  };

  const next = {
    ...existing,
    updatedAt: Date.now()
  };

  if (typeof input.title === "string") {
    next.title = input.title.trim().slice(0, 160);
  }
  if (typeof input.pinned === "boolean") {
    next.pinned = input.pinned;
  }
  if (typeof input.archived === "boolean") {
    next.archived = input.archived;
  }
  if (typeof input.starred === "boolean") {
    next.starred = input.starred;
  }

  threadMeta.set(key, next);
  const thread = threads.get(threadKey(input.agent, input.threadId));
  if (thread) {
    threads.set(threadKey(input.agent, input.threadId), applyThreadMeta(thread));
  }
  schedulePersistedState();
  return next;
}

function applyThreadMeta(thread) {
  if (!thread?.threadId) return thread;
  const meta = threadMeta.get(threadMetaKey(thread.agent, thread.threadId));
  if (!meta) return thread;
  return {
    ...thread,
    title: meta.title || thread.title,
    pinned: Boolean(meta.pinned),
    archived: Boolean(meta.archived),
    starred: Boolean(meta.starred),
    metaUpdatedAt: meta.updatedAt
  };
}

function searchThreads({ query, agent, limit }) {
  const needle = String(query || "").trim().toLowerCase();
  const agents = agent === "all" ? supportedAgents.map((item) => item.id) : [normalizeAgent(agent)];
  const resultMap = new Map();

  for (const thread of threads.values()) {
    const threadAgent = normalizeAgent(thread.agent);
    if (!agents.includes(threadAgent)) continue;

    const meta = threadMeta.get(threadMetaKey(threadAgent, thread.threadId));
    const textPieces = [
      thread.title,
      thread.preview,
      thread.cwd,
      thread.threadId,
      meta?.title,
      meta?.starred ? "starred" : "",
      meta?.pinned ? "pinned" : "",
      meta?.archived ? "archived" : ""
    ];

    const threadEvents = events.filter((event) => event.threadId === thread.threadId && normalizeAgent(event.agent) === threadAgent);
    const recentText = threadEvents.slice(-12).map((event) => searchTextForEvent(event)).join("\n");
    textPieces.push(recentText);

    const haystack = textPieces.filter(Boolean).join("\n").toLowerCase();
    if (needle && !haystack.includes(needle)) continue;

    const snippets = buildSearchSnippets(threadEvents, needle);
    const score = [
      Number(Boolean(meta?.starred)),
      Number(Boolean(meta?.pinned)),
      -Number(Boolean(meta?.archived)),
      thread.updatedAt || 0
    ];

    resultMap.set(threadKey(threadAgent, thread.threadId), {
      agent: threadAgent,
      threadId: thread.threadId,
      cwd: thread.cwd,
      title: meta?.title || thread.title || "Codex thread",
      preview: thread.preview || "",
      updatedAt: thread.updatedAt || 0,
      createdAt: thread.createdAt || 0,
      pinned: Boolean(meta?.pinned || thread.pinned),
      archived: Boolean(meta?.archived || thread.archived),
      starred: Boolean(meta?.starred || thread.starred),
      score,
      snippets
    });
  }

  return Array.from(resultMap.values())
    .sort((left, right) => {
      const leftScore = left.score;
      const rightScore = right.score;
      return rightScore[0] - leftScore[0]
        || rightScore[1] - leftScore[1]
        || rightScore[2] - leftScore[2]
        || rightScore[3] - leftScore[3];
    })
    .slice(0, limit)
    .map(({ score, ...item }) => item);
}

function buildSearchSnippets(threadEvents, needle) {
  if (!needle) {
    return threadEvents.slice(-3).map((event) => ({
      at: event.at,
      type: event.type,
      text: firstLine(searchTextForEvent(event))
    })).filter((item) => item.text);
  }

  const matches = [];
  for (const event of threadEvents) {
    const text = searchTextForEvent(event);
    const index = text.toLowerCase().indexOf(needle);
    if (index === -1) continue;
    const start = Math.max(0, index - 40);
    const end = Math.min(text.length, index + needle.length + 60);
    matches.push({
      at: event.at,
      type: event.type,
      text: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
    });
    if (matches.length >= 4) break;
  }
  return matches;
}

function searchTextForEvent(event) {
  return [
    event.title,
    event.text,
    event.output,
    event.diff,
    event.reason,
    event.command,
    event.cwd,
    JSON.stringify(event.plan || event.raw || "")
  ].filter(Boolean).join("\n");
}

function exportSnapshot() {
  cleanupBrowserSessions();
  return {
    ok: true,
    exportedAt: Date.now(),
    version: 1,
    nextSeq,
    nextCommandSeq,
    hostOnline,
    agents: supportedAgents,
    events,
    threads: Array.from(threads.values()),
    threadMeta: Array.from(threadMeta.values()),
    approvals: Array.from(approvals.values()),
    sessions: Array.from(browserSessions.values()).map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      userAgent: session.userAgent,
      remoteAddress: session.remoteAddress
    }))
  };
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

function createBrowserSession(req) {
  cleanupBrowserSessions();
  const id = randomUUID();
  const token = `sess_${randomUUID().replaceAll("-", "")}`;
  const now = Date.now();
  const session = {
    id,
    token,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + sessionTtlMs,
    userAgent: req.headers["user-agent"] || "",
    remoteAddress: req.socket.remoteAddress || ""
  };
  browserSessions.set(token, session);
  return session;
}

function listBrowserSessions(req) {
  cleanupBrowserSessions();
  const current = bearerToken(req);
  return Array.from(browserSessions.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((session) => ({
      id: session.id,
      current: session.token === current,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      userAgent: session.userAgent,
      remoteAddress: session.remoteAddress
    }));
}

function revokeBrowserSession(sessionId) {
  for (const [token, session] of browserSessions) {
    if (session.id === sessionId) {
      browserSessions.delete(token);
      return true;
    }
  }
  return false;
}

function cleanupBrowserSessions() {
  const now = Date.now();
  for (const [token, session] of browserSessions) {
    if (!session?.expiresAt || session.expiresAt <= now) {
      browserSessions.delete(token);
    }
  }
}

function debugSnapshot() {
  cleanupBrowserSessions();
  return {
    ok: true,
    now: Date.now(),
    host: {
      online: hostOnline,
      lastSeenAt: lastHostSeen || null,
      pendingRequests: pendingHostRequests.size,
      queuedCommands: hostCommands.length,
      openPolls: hostPolls.size
    },
    relay: {
      nextSeq,
      nextCommandSeq,
      events: events.length,
      threads: threads.size,
      threadMeta: threadMeta.size,
      approvals: approvals.size,
      pendingApprovals: Array.from(approvals.values()).filter((item) => item.status === "pending").length,
      sseClients: sseClients.size,
      sessions: browserSessions.size
    },
    persistence: {
      dataFile,
      loadedAt: storageLoadedAt || null,
      lastSavedAt: lastSavedAt || null,
      lastSaveError: lastSaveError || null
    },
    agents: supportedAgents
  };
}

function loadPersistedState() {
  let raw;
  try {
    raw = fs.readFileSync(dataFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      lastSaveError = `load failed: ${error.message}`;
    }
    return;
  }

  try {
    const snapshot = JSON.parse(raw);
    const restoredEvents = Array.isArray(snapshot.events) ? snapshot.events : [];
    events.push(...restoredEvents.slice(-5000));

    for (const thread of snapshot.threads || []) {
      if (thread?.threadId) {
        threads.set(threadKey(thread.agent, thread.threadId), thread);
      }
    }

    for (const meta of snapshot.threadMeta || []) {
      if (meta?.threadId) {
        threadMeta.set(threadMetaKey(meta.agent, meta.threadId), meta);
      }
    }

    for (const [key, thread] of threads) {
      threads.set(key, applyThreadMeta(thread));
    }

    for (const approval of snapshot.approvals || []) {
      if (approval?.approvalId) {
        approvals.set(approval.approvalId, approval);
      }
    }

    const maxEventSeq = events.reduce((max, event) => Math.max(max, Number(event.seq || 0)), 0);
    nextSeq = Math.max(Number(snapshot.nextSeq || 1), maxEventSeq + 1);
    storageLoadedAt = Date.now();
  } catch (error) {
    lastSaveError = `load failed: ${error.message}`;
  }
}

function schedulePersistedState() {
  if (!dataFile) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writePersistedState().catch((error) => {
      lastSaveError = error.message || String(error);
    });
  }, 200);
  saveTimer.unref?.();
}

async function writePersistedState() {
  const snapshot = {
    version: 1,
    savedAt: Date.now(),
    nextSeq,
    events,
    threads: Array.from(threads.values()),
    threadMeta: Array.from(threadMeta.values()),
    approvals: Array.from(approvals.values())
  };

  await fs.promises.mkdir(path.dirname(dataFile), { recursive: true });
  const tmpFile = `${dataFile}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmpFile, JSON.stringify(snapshot, null, 2), "utf8");
  await fs.promises.rename(tmpFile, dataFile);
  lastSavedAt = Date.now();
  lastSaveError = "";
}

function writeSse(res, event) {
  res.write(`event: companion\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isAuthorized(req, url) {
  if (!sharedToken) return true;

  if (isTokenAuthorized(bearerToken(req))) return true;

  const token = url.searchParams.get("token");
  return isTokenAuthorized(token);
}

function isTokenAuthorized(token) {
  if (!token) return false;
  if (token === sharedToken) return true;

  const session = browserSessions.get(token);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    browserSessions.delete(token);
    return false;
  }

  session.lastSeenAt = Date.now();
  return true;
}

function bearerToken(req) {
  const value = req.headers.authorization || "";
  if (!value.startsWith("Bearer ")) return "";
  return value.slice("Bearer ".length).trim();
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

function normalizeAgent(agent) {
  return agent === "claude" ? "claude" : "codex";
}

function threadKey(agent, threadId) {
  return `${normalizeAgent(agent)}:${threadId}`;
}

function threadMetaKey(agent, threadId) {
  return `${normalizeAgent(agent)}:${threadId}`;
}
