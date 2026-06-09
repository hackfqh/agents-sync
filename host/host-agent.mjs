import { randomUUID } from "node:crypto";

const relayBaseUrl = normalizeRelayBase(process.env.RELAY_URL || "http://localhost:8787");
const codexWsUrl = withCodexAuthToken(process.env.CODEX_WS_URL || "ws://localhost:7331");
const sharedToken = process.env.MOBILE_COMPANION_TOKEN || "dev-token";
const workdir = process.env.WORKDIR || process.cwd();

let codex = null;
let codexReady = false;
let codexRequestId = 1;
let relayCommandSeq = 0;
let activeThreadId = null;
let activeTurnId = null;

const pendingCodexRequests = new Map();
const pendingApprovals = new Map();
const activeTurnsByThread = new Map();
const resumedThreads = new Set();

if (typeof WebSocket !== "function") {
  throw new Error("Node.js 22+ is required because this host agent uses the built-in WebSocket client.");
}

pollRelayCommands();
connectCodex();

function connectCodex() {
  codex = new WebSocket(codexWsUrl);

  codex.addEventListener("open", async () => {
    console.log("Codex app-server connected");
    codexReady = false;
    try {
      await codexRequest("initialize", {
        clientInfo: {
          name: "codex-mobile-companion",
          title: "Codex Mobile Companion",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      });
      sendCodexNotification("initialized", {});
      codexReady = true;
      fireAndForget(sendRelayEvent({
        type: "codex.status",
        codexOnline: true,
        message: "Codex app-server connected"
      }));
    } catch (error) {
      fireAndForget(sendRelayEvent({
        type: "codex.status",
        codexOnline: false,
        message: `Codex initialize failed: ${error.message}`
      }));
    }
  });

  codex.addEventListener("message", async (event) => {
    let message;
    try {
      message = JSON.parse(await readSocketData(event.data));
    } catch {
      return;
    }
    handleCodexMessage(message);
  });

  codex.addEventListener("close", () => {
    codexReady = false;
    console.log("Codex app-server disconnected; reconnecting in 2s");
    fireAndForget(sendRelayEvent({
      type: "codex.status",
      codexOnline: false,
      message: "Codex app-server disconnected"
    }));
    setTimeout(connectCodex, 2000);
  });

  codex.addEventListener("error", () => {
    console.error("Codex app-server error");
  });
}

async function pollRelayCommands() {
  while (true) {
    try {
      const url = new URL("/host/commands", relayBaseUrl);
      url.searchParams.set("lastSeq", String(relayCommandSeq));
      const data = await relayFetch(url, { method: "GET" });

      if (Array.isArray(data.commands)) {
        for (const command of data.commands) {
          relayCommandSeq = Math.max(relayCommandSeq, command.seq || 0);
          await handleRelayRequest(command);
        }
      }
    } catch (error) {
      console.error("Relay poll error:", error.message || error);
      await sleep(2000);
    }
  }
}

async function handleRelayRequest(message) {
  if (!message.id || !message.type) return;

  try {
    if (message.type === "user.message") {
      const result = await startOrContinueTurn(message.payload || {});
      await replyToRelay(message.id, { ok: true, result });
      return;
    }

    if (message.type === "approval.answer") {
      const result = answerApproval(message.payload || {});
      await replyToRelay(message.id, { ok: true, result });
      return;
    }

    if (message.type === "history.projects") {
      const result = await listHistoryProjects(message.payload || {});
      await replyToRelay(message.id, { ok: true, result });
      return;
    }

    if (message.type === "history.threads") {
      const result = await listHistoryThreads(message.payload || {});
      await replyToRelay(message.id, { ok: true, result });
      return;
    }

    if (message.type === "history.thread.read") {
      const result = await readHistoryThread(message.payload || {});
      await replyToRelay(message.id, { ok: true, result });
      return;
    }

    await replyToRelay(message.id, {
      ok: false,
      error: `Unsupported host request: ${message.type}`
    });
  } catch (error) {
    await replyToRelay(message.id, {
      ok: false,
      error: error.message || String(error)
    });
  }
}

async function startOrContinueTurn(payload) {
  ensureCodexReady();

  const text = payload.text.trim();
  let threadId = payload.threadId || activeThreadId;
  const selectedCwd = payload.cwd || workdir;

  if (!threadId) {
    const threadResponse = await codexRequest("thread/start", {
      cwd: selectedCwd,
      approvalsReviewer: "user"
    });
    const thread = threadResponse.thread || threadResponse;
    threadId = extractThreadId(threadResponse);
    activeThreadId = threadId;

    await sendThreadUpsert({
      threadId,
      title: firstLine(text),
      status: thread.status || "running",
      cwd: thread.cwd,
      preview: thread.preview
    });
  }

  activeThreadId = threadId;
  await ensureThreadResumed(threadId);

  const input = [{ type: "text", text }];
  const activeTurnForThread = activeTurnsByThread.get(threadId);
  const method = activeTurnForThread ? "turn/steer" : "turn/start";
  const params = activeTurnForThread
    ? {
        threadId,
        expectedTurnId: activeTurnForThread,
        input,
        clientUserMessageId: randomUUID()
      }
    : {
        threadId,
        input,
        cwd: selectedCwd,
        clientUserMessageId: randomUUID()
      };

  const result = await codexRequest(method, params);
  const turnId = extractTurnId(result) || activeTurnForThread;
  if (turnId) {
    activeTurnId = turnId;
    activeTurnsByThread.set(threadId, turnId);
  }

  await sendRelayEvent({
    type: "user.message",
    threadId,
    turnId,
    text
  });

  return { threadId, turnId };
}

function answerApproval(payload) {
  const pending = pendingApprovals.get(payload.approvalId);
  if (!pending) {
    throw new Error("approval not found in host agent");
  }

  pendingApprovals.delete(payload.approvalId);

  const result = mapDecision(payload.decision);
  codex.send(JSON.stringify({
    jsonrpc: "2.0",
    id: pending.requestId,
    result
  }));

  return {
    approvalId: payload.approvalId,
    decision: payload.decision
  };
}

async function listHistoryProjects(payload) {
  ensureCodexReady();

  const projectMap = new Map();
  let cursor = payload.cursor || null;
  let nextCursor = null;
  let page = 0;
  const maxPages = payload.maxPages || 20;

  do {
    const response = await codexRequest("thread/list", {
      archived: false,
      cursor,
      limit: payload.limit || 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      useStateDbOnly: payload.useStateDbOnly ?? true
    });

    for (const thread of response.data || []) {
      const normalized = normalizeThread(thread);
      const cwd = normalized.cwd || "(unknown)";
      const project = projectMap.get(cwd) || {
        cwd,
        name: projectName(cwd),
        count: 0,
        latestAt: 0,
        latestPreview: ""
      };

      project.count += 1;
      if ((normalized.updatedAt || 0) > project.latestAt) {
        project.latestAt = normalized.updatedAt || 0;
        project.latestPreview = normalized.title || normalized.preview || "";
      }
      projectMap.set(cwd, project);
    }

    nextCursor = response.nextCursor || null;
    cursor = nextCursor;
    page += 1;
  } while (cursor && page < maxPages);

  return {
    projects: Array.from(projectMap.values()).sort((a, b) => b.latestAt - a.latestAt),
    nextCursor
  };
}

async function listHistoryThreads(payload) {
  ensureCodexReady();

  const params = {
    archived: false,
    cursor: payload.cursor || null,
    limit: payload.limit || 50,
    sortKey: "updated_at",
    sortDirection: "desc",
    useStateDbOnly: payload.useStateDbOnly ?? true
  };

  if (payload.cwd) {
    params.cwd = payload.cwd;
  }

  const response = await codexRequest("thread/list", params);
  return {
    threads: (response.data || []).map((thread) => normalizeThread(thread)),
    nextCursor: response.nextCursor || null,
    backwardsCursor: response.backwardsCursor || null
  };
}

async function readHistoryThread(payload) {
  ensureCodexReady();

  if (!payload.threadId) {
    throw new Error("threadId is required");
  }

  const response = await codexRequest("thread/read", {
    threadId: payload.threadId,
    includeTurns: true
  });

  const thread = normalizeThread(response.thread || response, payload.threadId);
  const turns = response.thread?.turns || response.turns || [];
  const events = [];

  for (const turn of turns) {
    const turnId = turn.id;
    events.push({
      type: turn.status === "completed" ? "turn.completed" : "turn.started",
      threadId: thread.threadId,
      turnId,
      status: turn.status,
      at: secondsToMs(turn.startedAt || turn.completedAt || thread.updatedAt)
    });

    let items = Array.isArray(turn.items) ? turn.items : [];
    if (!items.length || turn.itemsView === "summary" || turn.itemsView === "notLoaded") {
      items = await listTurnItems(thread.threadId, turnId);
    }

    for (const item of items) {
      events.push(...threadItemToEvents(item, thread.threadId, turnId, turn));
    }
  }

  return {
    thread,
    events: events.sort((a, b) => (a.at || 0) - (b.at || 0))
  };
}

async function ensureThreadResumed(threadId) {
  if (!threadId || resumedThreads.has(threadId)) return;

  const response = await codexRequest("thread/resume", {
    threadId,
    excludeTurns: true,
    approvalsReviewer: "user"
  });

  const thread = normalizeThread(response.thread || response, threadId);
  resumedThreads.add(thread.threadId || threadId);
  await sendThreadUpsert(thread);
}

async function listTurnItems(threadId, turnId) {
  const items = [];
  let cursor = null;
  do {
    const response = await codexRequest("thread/turns/items/list", {
      threadId,
      turnId,
      cursor,
      limit: 200,
      sortDirection: "asc"
    });
    items.push(...(response.data || []));
    cursor = response.nextCursor || null;
  } while (cursor);
  return items;
}

function handleCodexMessage(message) {
  if (message.id && (message.result !== undefined || message.error !== undefined)) {
    const pending = pendingCodexRequests.get(message.id);
    if (pending) {
      pendingCodexRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
    return;
  }

  if (message.method) {
    if (isApprovalRequest(message.method)) {
      handleApprovalRequest(message);
      return;
    }

    const event = normalizeCodexEvent(message.method, message.params || {});
    if (message.method === "thread/started" && event.threadId) {
      fireAndForget(sendThreadUpsert(normalizeThread(message.params.thread || {}, event.threadId)));
    }
    if (message.method === "turn/started" && event.threadId && event.turnId) {
      activeTurnsByThread.set(event.threadId, event.turnId);
      activeTurnId = event.turnId;
    }
    if (message.method === "turn/completed" && event.threadId) {
      activeTurnsByThread.delete(event.threadId);
      if (activeTurnId === event.turnId) activeTurnId = null;
    }
    fireAndForget(sendRelayEvent(event));
  }
}

function handleApprovalRequest(message) {
  const params = message.params || {};
  const approvalId = pick(params, ["approvalId", "approval_id"]) || params.itemId || randomUUID();
  const threadId = extractThreadId(params) || activeThreadId;
  const turnId = extractTurnId(params) || activeTurnId;

  pendingApprovals.set(approvalId, {
    requestId: message.id,
    method: message.method,
    params
  });

  sendRelay({
    type: "approval.request",
    approval: {
      approvalId,
      threadId,
      turnId,
      kind: approvalKind(message.method),
      title: approvalTitle(message.method, params),
      command: pick(params, ["command", "cmd"]),
      cwd: pick(params, ["cwd", "workdir"]),
      reason: pick(params, ["reason", "explanation", "message"]),
      diff: pick(params, ["diff", "patch"]),
      raw: params,
      createdAt: Date.now()
    }
  });
}

function normalizeCodexEvent(method, params) {
  const threadId = extractThreadId(params) || activeThreadId;
  const turnId = extractTurnId(params) || activeTurnId;
  const itemId = pick(params, ["itemId", "item_id", "id"]);

  if (threadId) activeThreadId = threadId;
  if (turnId) activeTurnId = turnId;

  const base = {
    type: mapEventType(method, params),
    method,
    threadId,
    turnId,
    itemId,
    raw: params
  };

  const text = pick(params, ["text", "delta", "message", "content"]);
  if (typeof text === "string") base.text = text;

  const output = pick(params, ["output", "stdout", "stderr", "chunk", "delta"]);
  if (typeof output === "string") base.output = output;

  const diff = pick(params, ["diff", "patch"]);
  if (typeof diff === "string") base.diff = diff;

  const plan = pick(params, ["plan", "steps"]);
  if (plan) base.plan = plan;

  const status = pick(params, ["status", "state"]);
  if (status) base.status = status;
  if (params.turn?.status) base.status = params.turn.status;
  if (params.thread?.status) base.status = params.thread.status;

  if (params.thread) {
    base.title = params.thread.name || params.thread.preview;
  }

  if (base.type === "turn.completed") {
    base.status = "completed";
  }

  return base;
}

function mapEventType(method, params) {
  const lower = method.toLowerCase();

  if (method === "thread/started") {
    return "thread.created";
  }
  if (method === "turn/started") {
    return "turn.started";
  }
  if (method === "turn/completed") {
    return "turn.completed";
  }
  if (method === "turn/diff/updated") {
    return "diff.updated";
  }
  if (method === "turn/plan/updated") {
    return "plan.updated";
  }
  if (method === "item/agentMessage/delta") {
    return "assistant.delta";
  }
  if (method === "item/commandExecution/outputDelta") {
    return "command.output";
  }

  if (lower.includes("agentmessage") || lower.includes("message/delta") || lower.includes("assistant")) {
    return "assistant.delta";
  }
  if (lower.includes("commandexecution") || lower.includes("command") || lower.includes("exec")) {
    return "command.output";
  }
  if (lower.includes("diff")) {
    return "diff.updated";
  }
  if (lower.includes("plan")) {
    return "plan.updated";
  }
  if (lower.includes("turn") && (lower.includes("completed") || lower.includes("complete"))) {
    return "turn.completed";
  }
  if (lower.includes("turn") && lower.includes("started")) {
    return "turn.started";
  }
  if (lower.includes("thread")) {
    return "thread.updated";
  }

  const type = pick(params, ["type", "eventType", "event_type"]);
  return typeof type === "string" ? type : "codex.event";
}

function isApprovalRequest(method) {
  const lower = method.toLowerCase();
  return lower.includes("requestapproval") || lower.includes("approval/request") || lower.includes("approval");
}

function approvalKind(method) {
  const lower = method.toLowerCase();
  if (lower.includes("file")) return "file";
  if (lower.includes("command") || lower.includes("exec")) return "command";
  return "approval";
}

function approvalTitle(method, params) {
  const explicit = pick(params, ["title", "label"]);
  if (explicit) return explicit;
  if (approvalKind(method) === "file") return "文件变更需要授权";
  if (approvalKind(method) === "command") return "命令执行需要授权";
  return "Codex 需要授权";
}

function mapDecision(decision) {
  if (decision === "acceptForSession") {
    return { decision: "acceptForSession" };
  }
  if (decision === "accept") {
    return { decision: "accept" };
  }
  if (decision === "decline") {
    return { decision: "decline" };
  }
  return { decision: "cancel" };
}

function codexRequest(method, params) {
  ensureCodexConnected();

  const id = codexRequestId++;
  const message = {
    jsonrpc: "2.0",
    id,
    method,
    params
  };

  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCodexRequests.delete(id);
      reject(new Error(`Codex request timed out: ${method}`));
    }, 90_000);
    pendingCodexRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });

  codex.send(JSON.stringify(message));
  return promise;
}

function sendCodexNotification(method, params) {
  ensureCodexConnected();
  codex.send(JSON.stringify({
    jsonrpc: "2.0",
    method,
    params
  }));
}

function ensureCodexConnected() {
  if (!codex || codex.readyState !== codex.OPEN) {
    throw new Error("Codex app-server is offline");
  }
}

function ensureCodexReady() {
  ensureCodexConnected();
  if (!codexReady) {
    throw new Error("Codex app-server is not initialized yet");
  }
}

function sendThreadUpsert(thread) {
  return sendRelay({
    type: "thread.upsert",
    thread
  });
}

function sendRelayEvent(event) {
  return sendRelay({
    type: "event",
    event
  });
}

function sendRelay(message) {
  return relayFetch(new URL("/host/messages", relayBaseUrl), {
    method: "POST",
    body: message
  });
}

function replyToRelay(replyTo, payload) {
  return sendRelay({
    replyTo,
    ...payload
  });
}

async function relayFetch(url, options = {}) {
  const headers = {
    Authorization: `Bearer ${sharedToken}`,
    ...(options.headers || {})
  };

  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Relay HTTP ${response.status}`);
  }
  return payload;
}

function normalizeRelayBase(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  if (parsed.pathname === "/host") parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function withCodexAuthToken(url) {
  const parsed = new URL(url);
  const token = process.env.CODEX_WS_AUTH_TOKEN;
  if (token && !parsed.searchParams.has("token")) {
    parsed.searchParams.set("token", token);
  }
  return parsed.toString();
}

async function readSocketData(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fireAndForget(promise) {
  promise.catch((error) => {
    console.error("Relay send error:", error.message || error);
  });
}

function pick(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) {
      return object[key];
    }
  }
  return undefined;
}

function extractThreadId(value) {
  return pick(value, ["threadId", "thread_id"])
    || value?.thread?.id
    || value?.thread?.threadId
    || value?.id;
}

function extractTurnId(value) {
  return pick(value, ["turnId", "turn_id"])
    || value?.turn?.id
    || value?.turn?.turnId;
}

function normalizeThread(thread, fallbackThreadId) {
  return {
    threadId: fallbackThreadId || thread.id || thread.threadId,
    title: thread.name || thread.preview || "Codex thread",
    status: thread.status,
    cwd: thread.cwd,
    preview: thread.preview,
    createdAt: thread.createdAt ? thread.createdAt * 1000 : undefined,
    updatedAt: thread.updatedAt ? thread.updatedAt * 1000 : undefined
  };
}

function threadItemToEvents(item, threadId, turnId, turn) {
  const at = secondsToMs(turn.startedAt || turn.completedAt);
  const itemId = item.id;

  if (item.type === "userMessage") {
    return [{
      type: "user.message",
      threadId,
      turnId,
      itemId,
      text: userInputToText(item.content),
      at
    }];
  }

  if (item.type === "agentMessage") {
    return [{
      type: "assistant.delta",
      threadId,
      turnId,
      itemId,
      text: item.text || "",
      at
    }];
  }

  if (item.type === "commandExecution") {
    return [{
      type: "command.output",
      threadId,
      turnId,
      itemId,
      output: [
        item.command ? `$ ${item.command}` : "",
        item.cwd ? `cwd: ${item.cwd}` : "",
        item.aggregatedOutput || ""
      ].filter(Boolean).join("\n"),
      status: item.status,
      raw: item,
      at
    }];
  }

  if (item.type === "fileChange") {
    return [{
      type: "file.change",
      threadId,
      turnId,
      itemId,
      text: summarizeFileChanges(item.changes || []),
      status: item.status,
      raw: item,
      at
    }];
  }

  if (item.type === "webSearch") {
    return [{
      type: "web.search",
      threadId,
      turnId,
      itemId,
      text: summarizeWebSearch(item),
      raw: item,
      at
    }];
  }

  if (item.type === "toolCall") {
    return [{
      type: "tool.call",
      threadId,
      turnId,
      itemId,
      text: `${item.tool || item.name || "tool"} ${item.status || ""}`.trim(),
      raw: item,
      at
    }];
  }

  if (item.type === "plan") {
    return [{
      type: "plan.updated",
      threadId,
      turnId,
      itemId,
      plan: item.text || "",
      raw: item,
      at
    }];
  }

  if (item.type === "reasoning") {
    return [{
      type: "reasoning",
      threadId,
      turnId,
      itemId,
      text: [...(item.summary || []), ...(item.content || [])].join("\n"),
      raw: item,
      at
    }];
  }

  return [{
    type: `item.${item.type || "unknown"}`,
    threadId,
    turnId,
    itemId,
    raw: item,
    at
  }];
}

function userInputToText(content) {
  return (content || []).map((item) => {
    if (item.type === "text") return item.text || "";
    if (item.type === "image") return `[image] ${item.url || ""}`;
    return JSON.stringify(item);
  }).filter(Boolean).join("\n");
}

function summarizeFileChanges(changes) {
  if (!changes.length) return "文件变更";
  return changes.map((change) => {
    const path = change.path || change.add?.path || change.delete?.path || change.update?.path || "(unknown)";
    const kind = typeof change.kind === "string"
      ? change.kind
      : change.kind?.type || Object.keys(change.kind || {})[0] || Object.keys(change)[0] || "change";
    return `${kind}: ${path}`;
  }).join("\n");
}

function summarizeWebSearch(item) {
  if (item.action?.type === "openPage") return `打开网页：${item.action.url || item.query || ""}`;
  if (item.action?.type === "findInPage") return `页内查找：${item.action.pattern || item.query || ""}`;
  if (item.action?.type === "search") return `网页搜索：${item.action.query || item.query || ""}`;
  return item.query ? `网页：${item.query}` : "网页工具";
}

function projectName(cwd) {
  if (!cwd || cwd === "(unknown)") return "Unknown project";
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
}

function secondsToMs(value) {
  if (!value) return Date.now();
  return value > 10_000_000_000 ? value : value * 1000;
}

function firstLine(text) {
  const line = text.split(/\r?\n/, 1)[0].trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line || "Codex thread";
}
