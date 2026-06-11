import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const relayBaseUrl = normalizeRelayBase(process.env.RELAY_URL || "http://localhost:8787");
const codexWsUrl = withCodexAuthToken(process.env.CODEX_WS_URL || "ws://localhost:7331");
const sharedToken = process.env.MOBILE_COMPANION_TOKEN || "dev-token";
const workdir = process.env.WORKDIR || process.cwd();
const codexAgent = "codex";
const claudeAgent = "claude";

let codex = null;
let codexReady = false;
let codexRequestId = 1;
let relayCommandSeq = 0;
let activeThreadId = null;
let activeTurnId = null;
let claudeSdkPromise = null;

const pendingCodexRequests = new Map();
const pendingApprovals = new Map();
const activeTurnsByThread = new Map();
const activeClaudeTurns = new Map();
const resumedThreads = new Set();
const agentAdapters = {
  [codexAgent]: {
    startTurn: startOrContinueTurn,
    listProjects: listHistoryProjects,
    listThreads: listHistoryThreads,
    readThread: readHistoryThread
  },
  [claudeAgent]: {
    startTurn: startOrContinueClaudeTurn,
    listProjects: listClaudeProjects,
    listThreads: listClaudeThreads,
    readThread: readClaudeThread
  }
};

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
    const payload = message.payload || {};
    const adapter = agentAdapterFor(payload.agent);

    if (message.type === "user.message") {
      const result = await adapter.startTurn(payload);
      await replyToRelay(message.id, { ok: true, result });
      return;
    }

    if (message.type === "approval.answer") {
      const result = answerApproval(payload);
      await replyToRelay(message.id, { ok: true, result });
      return;
    }

    if (message.type === "history.projects") {
      const result = await adapter.listProjects(payload);
      await replyToRelay(message.id, { ok: true, result });
      return;
    }

    if (message.type === "history.threads") {
      const result = await adapter.listThreads(payload);
      await replyToRelay(message.id, { ok: true, result });
      return;
    }

    if (message.type === "history.thread.read") {
      const result = await adapter.readThread(payload);
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
      agent: codexAgent,
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
    agent: codexAgent,
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

  if (pending.agent === claudeAgent) {
    pending.resolve(mapClaudeApprovalDecision(payload.decision, pending.toolUseID));
    return {
      approvalId: payload.approvalId,
      decision: payload.decision
    };
  }

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

async function startOrContinueClaudeTurn(payload) {
  const text = payload.text.trim();
  const selectedCwd = payload.cwd || workdir;
  const sessionId = payload.threadId || randomUUID();
  const turnId = randomUUID();
  const isResume = Boolean(payload.threadId);

  activeClaudeTurns.set(sessionId, turnId);

  await sendThreadUpsert({
    agent: claudeAgent,
    threadId: sessionId,
    title: firstLine(text),
    status: "running",
    cwd: selectedCwd,
    preview: firstLine(text)
  });

  await sendRelayEvent({
    agent: claudeAgent,
    type: "user.message",
    threadId: sessionId,
    turnId,
    itemId: `user-${turnId}`,
    text
  });

  fireAndForget(runClaudeTurn({
    text,
    cwd: selectedCwd,
    sessionId,
    turnId,
    isResume
  }));

  return { threadId: sessionId, turnId };
}

async function runClaudeTurn({ text, cwd, sessionId, turnId, isResume }) {
  let completed = false;
  let failed = false;

  try {
    const { query } = await loadClaudeSdk();
    const claudeExecutable = resolveClaudeCodeExecutable();
    const options = {
      cwd,
      permissionMode: process.env.CLAUDE_PERMISSION_MODE || "default",
      systemPrompt: {
        type: "preset",
        preset: "claude_code"
      },
      tools: {
        type: "preset",
        preset: "claude_code"
      },
      settingSources: ["user", "project", "local"],
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "codex-mobile-companion"
      },
      canUseTool: createClaudeApprovalHandler({ sessionId, turnId, cwd })
    };

    if (claudeExecutable) {
      options.pathToClaudeCodeExecutable = claudeExecutable;
    }

    if (isResume) {
      options.resume = sessionId;
    } else {
      options.sessionId = sessionId;
    }

    for await (const message of query({ prompt: text, options })) {
      if (await handleClaudeSdkMessage(message, { sessionId, turnId, cwd })) {
        completed = true;
      }
    }
  } catch (error) {
    failed = true;
    await sendRelayEvent({
      agent: claudeAgent,
      type: "assistant.delta",
      threadId: sessionId,
      turnId,
      itemId: `error-${turnId}`,
      text: `Claude 运行失败：${formatClaudeError(error)}`
    });
  } finally {
    activeClaudeTurns.delete(sessionId);
    if (!completed) {
      await sendRelayEvent({
        agent: claudeAgent,
        type: "turn.completed",
        threadId: sessionId,
        turnId,
        status: failed ? "error" : "completed"
      });
    }
    await sendThreadUpsert({
      agent: claudeAgent,
      threadId: sessionId,
      status: failed ? "error" : "completed",
      cwd
    });
  }
}

async function listClaudeProjects(payload) {
  const { listSessions } = await loadClaudeSdk();
  const sessions = await listSessions({
    limit: payload.limit || 100
  });
  const projectMap = new Map();

  for (const session of sessions || []) {
    const normalized = normalizeClaudeSession(session);
    const cwd = normalized.cwd || workdir;
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

  if (!projectMap.has(workdir)) {
    projectMap.set(workdir, {
      cwd: workdir,
      name: projectName(workdir),
      count: 0,
      latestAt: 0,
      latestPreview: "新建 Claude 会话"
    });
  }

  return {
    projects: Array.from(projectMap.values()).sort((a, b) => b.latestAt - a.latestAt),
    nextCursor: null
  };
}

async function listClaudeThreads(payload) {
  const { listSessions } = await loadClaudeSdk();
  const sessions = await listSessions({
    dir: payload.cwd || undefined,
    limit: payload.limit || 50
  });

  return {
    threads: (sessions || []).map((session) => normalizeClaudeSession(session, payload.cwd)),
    nextCursor: null,
    backwardsCursor: null
  };
}

async function readClaudeThread(payload) {
  if (!payload.threadId) {
    throw new Error("threadId is required");
  }

  const { getSessionInfo, getSessionMessages } = await loadClaudeSdk();
  const [sessionInfo, messages] = await Promise.all([
    getSessionInfo(payload.threadId, {
      dir: payload.cwd || undefined
    }).catch(() => null),
    getSessionMessages(payload.threadId, {
      dir: payload.cwd || undefined,
      limit: payload.limit || 200
    })
  ]);

  const thread = normalizeClaudeSession(
    sessionInfo || { sessionId: payload.threadId, cwd: payload.cwd || workdir },
    payload.cwd || workdir
  );
  const events = [];

  for (const [index, message] of (messages || []).entries()) {
    events.push(...claudeSessionMessageToEvents(message, thread.threadId, index));
  }

  return {
    thread,
    events: events.sort((a, b) => (a.at || 0) - (b.at || 0))
  };
}

async function handleClaudeSdkMessage(message, context) {
  const sessionId = message.session_id || message.sessionId || context.sessionId;
  const turnId = message.uuid || message.id || context.turnId;
  const at = Date.now();

  if (message.type === "system" && message.subtype === "init") {
    await sendThreadUpsert({
      agent: claudeAgent,
      threadId: sessionId,
      status: "running",
      cwd: message.cwd || context.cwd,
      title: "Claude session",
      preview: message.model ? `model: ${message.model}` : undefined
    });
    return false;
  }

  if (message.type === "assistant") {
    const text = messageContentToText(message.message?.content);
    if (text) {
      await sendRelayEvent({
        agent: claudeAgent,
        type: "assistant.delta",
        threadId: sessionId,
        turnId,
        itemId: message.uuid || randomUUID(),
        text,
        raw: message,
        at
      });
    }
    for (const event of claudeToolUseEvents(message, sessionId, turnId, at)) {
      await sendRelayEvent(event);
    }
    return false;
  }

  if (message.type === "local_command_output") {
    await sendRelayEvent({
      agent: claudeAgent,
      type: "command.output",
      threadId: sessionId,
      turnId,
      itemId: message.uuid || randomUUID(),
      output: message.output || stringifyClaude(message),
      raw: message,
      at
    });
    return false;
  }

  if (message.type === "result") {
    const status = message.subtype === "error" ? "error" : "completed";
    await sendRelayEvent({
      agent: claudeAgent,
      type: "turn.completed",
      threadId: sessionId,
      turnId,
      status,
      raw: message,
      at
    });
    await sendThreadUpsert({
      agent: claudeAgent,
      threadId: sessionId,
      status,
      cwd: context.cwd,
      preview: message.result || undefined
    });
    return true;
  }

  return false;
}

function createClaudeApprovalHandler({ sessionId, turnId, cwd }) {
  return async function canUseTool(toolName, input, options = {}) {
    const approvalId = `claude-${options.toolUseID || randomUUID()}`;
    const title = `Claude 请求使用 ${toolName}`;
    const command = toolName === "Bash"
      ? input?.command || input?.cmd
      : undefined;

    await sendRelay({
      type: "approval.request",
      approval: {
        agent: claudeAgent,
        approvalId,
        threadId: sessionId,
        turnId,
        kind: toolName || "tool",
        title,
        command,
        cwd: input?.cwd || cwd,
        reason: options?.permissionContext || options?.description,
        raw: { toolName, input, options },
        createdAt: Date.now()
      }
    });

    return new Promise((resolve, reject) => {
      pendingApprovals.set(approvalId, {
        agent: claudeAgent,
        resolve,
        reject,
        toolUseID: options.toolUseID
      });

      options.signal?.addEventListener("abort", () => {
        pendingApprovals.delete(approvalId);
        reject(new Error("Claude tool approval was aborted"));
      }, { once: true });
    });
  };
}

function mapClaudeApprovalDecision(decision, toolUseID) {
  if (decision === "accept" || decision === "acceptForSession") {
    return {
      behavior: "allow",
      toolUseID
    };
  }

  return {
    behavior: "deny",
    toolUseID,
    message: decision === "cancel" ? "User cancelled from mobile companion" : "User declined from mobile companion"
  };
}

async function loadClaudeSdk() {
  if (!claudeSdkPromise) {
    claudeSdkPromise = import("@anthropic-ai/claude-agent-sdk").catch((error) => {
      claudeSdkPromise = null;
      throw new Error(`Claude Agent SDK is not installed or failed to load: ${error.message}`);
    });
  }
  return claudeSdkPromise;
}

function resolveClaudeCodeExecutable() {
  const explicit = process.env.CLAUDE_CODE_EXECUTABLE
    || process.env.CLAUDE_CODE_COMMAND
    || process.env.CLAUDE_EXECUTABLE;
  if (explicit) {
    return resolveExecutableCandidate(explicit);
  }

  return findExecutableOnPath(process.platform === "win32" ? "claude.exe" : "claude")
    || findExecutableOnPath("claude")
    || commonClaudeExecutablePaths().find(isExecutableFile)
    || null;
}

function resolveExecutableCandidate(candidate) {
  if (candidate.includes("/") || candidate.includes("\\") || path.isAbsolute(candidate)) {
    return isExecutableFile(candidate) ? candidate : candidate;
  }
  return findExecutableOnPath(candidate) || candidate;
}

function findExecutableOnPath(command) {
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  const commands = path.extname(command)
    ? [command]
    : extensions.map((extension) => `${command}${extension.toLowerCase()}`);

  for (const entry of pathEntries) {
    for (const name of commands) {
      const candidate = path.join(entry, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function commonClaudeExecutablePaths() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(localAppData, "Programs", "Claude", "claude.exe"),
      path.join(home, ".local", "bin", "claude.exe")
    ];
  }

  return [
    path.join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude"
  ];
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function formatClaudeError(error) {
  const message = error?.message || String(error);
  if (message.includes("Native CLI binary") || message.includes("pathToClaudeCodeExecutable")) {
    return `${message}\n\n已自动尝试从 PATH 查找 claude 命令。仍失败时，请执行 npm install --include=optional，或设置 CLAUDE_CODE_EXECUTABLE=/path/to/claude。`;
  }
  return message;
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
      agent: codexAgent,
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
    agent: codexAgent,
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
    thread: {
      ...thread,
      agent: thread.agent || codexAgent
    }
  });
}

function sendRelayEvent(event) {
  return sendRelay({
    type: "event",
    event: {
      ...event,
      agent: event.agent || codexAgent
    }
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
    agent: codexAgent,
    threadId: fallbackThreadId || thread.id || thread.threadId,
    title: thread.name || thread.preview || "Codex thread",
    status: thread.status,
    cwd: thread.cwd,
    preview: thread.preview,
    createdAt: thread.createdAt ? thread.createdAt * 1000 : undefined,
    updatedAt: thread.updatedAt ? thread.updatedAt * 1000 : undefined
  };
}

function normalizeClaudeSession(session, fallbackCwd = workdir) {
  const threadId = session.sessionId || session.session_id || session.id;
  const title = session.summary
    || session.customTitle
    || session.title
    || session.firstPrompt
    || "Claude session";
  const updatedAt = toMs(session.lastModified || session.updatedAt || session.updated_at || session.modifiedAt);
  const createdAt = toMs(session.createdAt || session.created_at);

  return {
    agent: claudeAgent,
    threadId,
    title,
    status: session.status,
    cwd: session.cwd || session.dir || fallbackCwd,
    preview: session.preview || session.firstPrompt || title,
    createdAt,
    updatedAt: updatedAt || createdAt || Date.now()
  };
}

function claudeSessionMessageToEvents(message, threadId, index) {
  const sessionId = message.session_id || message.sessionId || threadId;
  const turnId = message.uuid || message.id || `${sessionId}-${index}`;
  const at = messageTime(message) || Date.now() + index;

  if (message.type === "user") {
    const text = messageContentToText(message.message?.content || message.content);
    return text ? [{
      agent: claudeAgent,
      type: "user.message",
      threadId: sessionId,
      turnId,
      itemId: message.uuid || turnId,
      text,
      raw: message,
      at
    }] : [];
  }

  if (message.type === "assistant") {
    const events = [];
    const text = messageContentToText(message.message?.content || message.content);
    if (text) {
      events.push({
        agent: claudeAgent,
        type: "assistant.delta",
        threadId: sessionId,
        turnId,
        itemId: message.uuid || turnId,
        text,
        raw: message,
        at
      });
    }
    events.push(...claudeToolUseEvents(message, sessionId, turnId, at));
    return events;
  }

  if (message.type === "result") {
    return [{
      agent: claudeAgent,
      type: "turn.completed",
      threadId: sessionId,
      turnId,
      status: message.subtype === "error" ? "error" : "completed",
      raw: message,
      at
    }];
  }

  return [];
}

function claudeToolUseEvents(message, threadId, turnId, at) {
  const content = message.message?.content || message.content || [];
  if (!Array.isArray(content)) return [];

  return content
    .filter((block) => block?.type === "tool_use")
    .map((block) => ({
      agent: claudeAgent,
      type: "tool.call",
      threadId,
      turnId,
      itemId: block.id || `${turnId}-${block.name}`,
      text: `${block.name || "tool"} ${block.input ? stringifyClaude(block.input) : ""}`.trim(),
      raw: block,
      at
    }));
}

function messageContentToText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyClaude(content);

  return content.map((block) => {
    if (!block) return "";
    if (typeof block === "string") return block;
    if (block.type === "text") return block.text || "";
    if (block.type === "tool_result") return messageContentToText(block.content);
    if (block.type === "image") return "[image]";
    if (block.type === "tool_use") return "";
    return stringifyClaude(block);
  }).filter(Boolean).join("\n");
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

function normalizeAgent(agent) {
  return agent === claudeAgent ? claudeAgent : codexAgent;
}

function agentAdapterFor(agent) {
  return agentAdapters[normalizeAgent(agent)] || agentAdapters[codexAgent];
}

function messageTime(message) {
  return toMs(message.timestamp || message.createdAt || message.created_at || message.time);
}

function toMs(value) {
  if (!value) return undefined;
  if (typeof value === "number") return secondsToMs(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function secondsToMs(value) {
  if (!value) return Date.now();
  return value > 10_000_000_000 ? value : value * 1000;
}

function stringifyClaude(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstLine(text) {
  const line = text.split(/\r?\n/, 1)[0].trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line || "Codex thread";
}
