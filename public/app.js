const params = new URLSearchParams(location.search);
let token = params.get("token") || localStorage.getItem("companionToken") || "";

if (token) {
  localStorage.setItem("companionToken", token);
}

const state = {
  hostOnline: false,
  codexOnline: false,
  activeThreadId: localStorage.getItem("activeThreadId") || null,
  lastSeq: Number(localStorage.getItem("lastSeq") || 0),
  events: [],
  threads: new Map(),
  historyThreads: new Map(),
  historyNextCursor: null,
  projects: [],
  selectedProjectCwd: localStorage.getItem("selectedProjectCwd") || "",
  approvals: new Map(),
  source: null,
  threadSyncing: false,
  projectSyncing: false,
  lastProjectSyncAt: 0,
  lastSyncErrorAt: 0
};

const activeThreadSyncMs = 5000;
const projectThreadsSyncMs = 15000;

const visibleTimelineTypes = new Set([
  "user.message",
  "assistant.delta",
  "command.output",
  "diff.updated",
  "plan.updated",
  "file.change",
  "reasoning"
]);

const els = {
  statusLine: document.querySelector("#statusLine"),
  refreshButton: document.querySelector("#refreshButton"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  timeline: document.querySelector("#timeline"),
  approvals: document.querySelector("#approvals"),
  projects: document.querySelector("#projects"),
  historyThreads: document.querySelector("#historyThreads"),
  approvalBadge: document.querySelector("#approvalBadge"),
  tabs: document.querySelectorAll(".tab"),
  views: {
    timeline: document.querySelector("#timelineView"),
    projects: document.querySelector("#projectsView"),
    history: document.querySelector("#historyView"),
    approvals: document.querySelector("#approvalsView"),
  }
};

if (!token) {
  token = prompt("输入 MOBILE_COMPANION_TOKEN") || "";
  localStorage.setItem("companionToken", token);
}

els.refreshButton.addEventListener("click", () => bootstrap());
els.sendButton.addEventListener("click", sendMessage);
els.messageInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    sendMessage();
  }
});

for (const tab of els.tabs) {
  tab.addEventListener("click", () => {
    for (const item of els.tabs) item.classList.remove("active");
    for (const view of Object.values(els.views)) view.classList.remove("active");
    tab.classList.add("active");
    els.views[tab.dataset.view].classList.add("active");
  });
}

await bootstrap();
connectEvents();
startAutoSync();

async function bootstrap() {
  let data;
  try {
    data = await api("/api/bootstrap");
  } catch (error) {
    renderStatus(`初始化失败：${error.message}`);
    return;
  }

  state.hostOnline = Boolean(data.hostOnline);
  state.events = data.recentEvents || [];
  state.threads = new Map((data.threads || []).map((thread) => [thread.threadId, thread]));
  state.approvals = new Map((data.approvals || []).map((approval) => [approval.approvalId, approval]));
  if (state.activeThreadId && !state.selectedProjectCwd) {
    state.activeThreadId = null;
    localStorage.removeItem("activeThreadId");
  }

  for (const event of state.events) {
    applyEvent(event, { skipPush: true });
  }

  renderAll();
  refreshProjects();
  syncVisibleData({ force: true });
}

function connectEvents() {
  if (state.source) {
    state.source.close();
  }

  const url = new URL("/events", location.origin);
  url.searchParams.set("token", token);
  url.searchParams.set("lastSeq", String(state.lastSeq));

  state.source = new EventSource(url);
  state.source.addEventListener("hello", () => {
    renderStatus("事件流已连接");
  });
  state.source.addEventListener("companion", (event) => {
    const payload = JSON.parse(event.data);
    applyEvent(payload);
    renderAll();
  });
  state.source.onerror = () => {
    renderStatus("事件流断开，浏览器会自动重连");
  };
}

function applyEvent(event, options = {}) {
  if (!event || !event.seq) return;

  state.lastSeq = Math.max(state.lastSeq, event.seq);
  localStorage.setItem("lastSeq", String(state.lastSeq));

  if (!options.skipPush && !state.events.some((item) => item.seq === event.seq)) {
    state.events.push(event);
  }

  if (state.events.length > 250) {
    state.events.splice(0, state.events.length - 250);
  }

  if (event.threadId) {
    const existing = state.threads.get(event.threadId) || {
      threadId: event.threadId,
      title: event.title || "Codex thread",
      createdAt: event.at
    };
    existing.updatedAt = event.at;
    if (event.title) existing.title = event.title;
    if (event.status) existing.status = event.status;
    state.threads.set(event.threadId, existing);
  }

  if (event.type === "thread.upserted" && event.thread?.threadId) {
    state.threads.set(event.thread.threadId, event.thread);
    if (
      state.selectedProjectCwd
      && event.thread.cwd === state.selectedProjectCwd
      && !state.activeThreadId
    ) {
      state.activeThreadId = event.thread.threadId;
      localStorage.setItem("activeThreadId", state.activeThreadId);
    }
  }

  if (event.type === "approval.requested") {
    state.approvals.set(event.approvalId, {
      ...event,
      status: "pending"
    });
  }

  if (event.type === "approval.answered") {
    const approval = state.approvals.get(event.approvalId);
    if (approval) {
      approval.status = "answered";
      approval.decision = event.decision;
    }
  }

  if (event.type === "host.status") {
    state.hostOnline = Boolean(event.hostOnline);
  }

  if (event.type === "codex.status") {
    state.codexOnline = Boolean(event.codexOnline);
  }

  if (event.type === "turn.completed" && event.threadId === state.activeThreadId) {
    syncActiveThread({ force: true });
  }

  if (event.type === "thread.upserted" && state.selectedProjectCwd) {
    syncSelectedProjectThreads();
  }
}

async function sendMessage() {
  const text = els.messageInput.value.trim();
  if (!text) return;

  els.sendButton.disabled = true;
  try {
    await api("/api/message", {
      method: "POST",
      body: {
        text,
        threadId: state.activeThreadId,
        cwd: state.selectedProjectCwd || null
      }
    });
    els.messageInput.value = "";
    renderStatus("消息已发送");
  } catch (error) {
    renderStatus(`发送失败：${error.message}`);
  } finally {
    els.sendButton.disabled = false;
  }
}

async function refreshProjects() {
  try {
    const data = await api("/api/projects");
    state.projects = data.projects || [];
    renderProjects();
  } catch (error) {
    renderStatus(`项目加载失败：${error.message}`);
  }
}

async function loadProjectThreads(cwd) {
  state.selectedProjectCwd = cwd;
  localStorage.setItem("selectedProjectCwd", cwd);
  state.activeThreadId = null;
  localStorage.removeItem("activeThreadId");
  state.events = state.events.filter((event) => !event.threadId || threadBelongsToProject(event.threadId, cwd));
  switchView("history");
  els.historyThreads.innerHTML = `<div class="empty-state">加载历史中</div>`;

  try {
    const url = new URL("/api/history/threads", location.origin);
    if (cwd) url.searchParams.set("cwd", cwd);
    const data = await api(`${url.pathname}${url.search}`);
    state.historyThreads = new Map((data.threads || []).map((thread) => [thread.threadId, thread]));
    state.historyNextCursor = data.nextCursor || null;
    renderProjects();
    renderHistoryThreads();
  } catch (error) {
    renderStatus(`历史加载失败：${error.message}`);
  }
}

async function loadMoreHistoryThreads() {
  if (!state.historyNextCursor) return;

  try {
    const url = new URL("/api/history/threads", location.origin);
    if (state.selectedProjectCwd) url.searchParams.set("cwd", state.selectedProjectCwd);
    url.searchParams.set("cursor", state.historyNextCursor);
    const data = await api(`${url.pathname}${url.search}`);
    for (const thread of data.threads || []) {
      state.historyThreads.set(thread.threadId, thread);
    }
    state.historyNextCursor = data.nextCursor || null;
    renderHistoryThreads();
  } catch (error) {
    renderStatus(`加载更多失败：${error.message}`);
  }
}

async function openHistoryThread(threadId) {
  try {
    renderStatus("读取历史线程中");
    const data = await fetchHistoryThread(threadId);
    mergeHistoryThread(data, threadId);

    switchView("timeline");
    renderAll();
    renderStatus("历史线程已打开");
  } catch (error) {
    renderStatus(`线程读取失败：${error.message}`);
  }
}

function startAutoSync() {
  setInterval(() => {
    syncVisibleData();
  }, activeThreadSyncMs);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncVisibleData({ force: true });
  });

  window.addEventListener("focus", () => {
    syncVisibleData({ force: true });
  });
}

async function syncVisibleData(options = {}) {
  if (document.hidden && !options.force) return;
  if (!state.selectedProjectCwd) return;

  if (state.activeThreadId) {
    await syncActiveThread(options);
  }

  const now = Date.now();
  if (options.force || now - state.lastProjectSyncAt >= projectThreadsSyncMs) {
    await syncSelectedProjectThreads();
  }
}

async function syncActiveThread(options = {}) {
  if (!state.activeThreadId || state.threadSyncing) return;

  state.threadSyncing = true;
  try {
    const data = await fetchHistoryThread(state.activeThreadId);
    const changed = mergeHistoryThread(data, state.activeThreadId);
    if (changed) {
      renderAll();
      renderStatus("已同步最新消息");
    }
  } catch (error) {
    reportSyncError("消息同步", error);
  } finally {
    state.threadSyncing = false;
  }
}

async function syncSelectedProjectThreads() {
  if (!state.selectedProjectCwd || state.projectSyncing) return;

  state.projectSyncing = true;
  try {
    const url = new URL("/api/history/threads", location.origin);
    url.searchParams.set("cwd", state.selectedProjectCwd);
    const data = await api(`${url.pathname}${url.search}`);
    const incomingThreads = data.threads || [];
    const hadLoadedMore = state.historyThreads.size > incomingThreads.length;
    state.historyThreads = new Map(state.historyThreads);
    for (const thread of incomingThreads) {
      state.historyThreads.set(thread.threadId, thread);
    }
    if (!hadLoadedMore) {
      state.historyNextCursor = data.nextCursor || null;
    }
    state.lastProjectSyncAt = Date.now();
    renderProjects();
    renderHistoryThreads();
  } catch (error) {
    reportSyncError("历史同步", error);
  } finally {
    state.projectSyncing = false;
  }
}

async function fetchHistoryThread(threadId) {
  const url = new URL("/api/history/thread", location.origin);
  url.searchParams.set("threadId", threadId);
  return api(`${url.pathname}${url.search}`);
}

function mergeHistoryThread(data, fallbackThreadId) {
  const threadId = data.thread?.threadId || fallbackThreadId;
  if (!threadId) return false;

  if (data.thread?.threadId) {
    state.threads.set(data.thread.threadId, data.thread);
    state.activeThreadId = data.thread.threadId;
    localStorage.setItem("activeThreadId", state.activeThreadId);
  }

  const historyEvents = data.events || [];
  const completedTurnIds = new Set(
    historyEvents
      .filter((event) => event.type === "turn.completed" && event.turnId)
      .map((event) => event.turnId)
  );
  const historyKeys = new Set(historyEvents.map(historyConflictKey).filter(Boolean));
  const before = threadEventsFingerprint(state.events.filter((event) => event.threadId === threadId));

  state.events = [
    ...state.events.filter((event) => {
      if (event.threadId !== threadId) return true;
      if (!event.seq) return false;
      if (event.turnId && completedTurnIds.has(event.turnId)) return false;
      const key = historyConflictKey(event);
      return !key || !historyKeys.has(key);
    }),
    ...historyEvents
  ];

  const after = threadEventsFingerprint(state.events.filter((event) => event.threadId === threadId));
  return before !== after;
}

async function answerApproval(approvalId, decision) {
  try {
    await api("/api/approval", {
      method: "POST",
      body: { approvalId, decision }
    });
    renderStatus("授权已提交");
  } catch (error) {
    renderStatus(`授权失败：${error.message}`);
  }
}

function renderAll() {
  renderStatus();
  renderTimeline();
  renderApprovals();
  renderProjects();
  renderHistoryThreads();
}

function renderStatus(extra = "") {
  const host = state.hostOnline ? "Host 在线" : "Host 离线";
  const codex = state.codexOnline ? "Codex 在线" : "Codex 未连接";
  els.statusLine.textContent = [host, codex, extra].filter(Boolean).join(" · ");
}

function renderTimeline() {
  if (!state.selectedProjectCwd) {
    els.timeline.innerHTML = `<div class="empty-state">先选择一个项目</div>`;
    return;
  }

  if (!state.activeThreadId) {
    els.timeline.innerHTML = `<div class="empty-state">选择历史对话，或直接输入创建该项目的新对话</div>`;
    return;
  }

  const currentEvents = state.events.filter((event) => (
    event.threadId === state.activeThreadId
    && visibleTimelineTypes.has(event.type)
  )).sort(compareEvents);

  if (!currentEvents.length) {
    els.timeline.innerHTML = `<div class="empty-state">还没有消息</div>`;
    return;
  }

  const currentEntries = buildTimelineEntries(currentEvents).slice(-120).reverse();
  els.timeline.innerHTML = currentEntries.map(renderEvent).join("");
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  });
}

function buildTimelineEntries(events) {
  const entries = [];

  for (const event of events) {
    if (event.type === "diff.updated") {
      const previous = findLastMergeable(entries, event, "diff");
      if (previous) {
        previous.diff = event.diff;
        previous.raw = event.raw;
        previous.at = event.at;
        continue;
      }
    }

    if (event.type === "plan.updated") {
      const previous = findLastMergeable(entries, event, "plan");
      if (previous) {
        previous.plan = event.plan;
        previous.raw = event.raw;
        previous.at = event.at;
        continue;
      }
    }

    if (event.type === "assistant.delta") {
      const previous = findLastMergeable(entries, event, "assistant");
      if (previous) {
        previous.text = `${previous.text || ""}${event.text || ""}`;
        previous.at = event.at;
        continue;
      }
    }

    if (event.type === "command.output") {
      const previous = findLastMergeable(entries, event, "command");
      if (previous) {
        previous.output = `${previous.output || previous.text || ""}${event.output || event.text || ""}`;
        previous.text = "";
        previous.at = event.at;
        continue;
      }
    }

    entries.push({ ...event });
  }

  return entries;
}

function findLastMergeable(entries, event, family) {
  const itemKey = event.itemId || `${event.threadId || ""}:${event.turnId || ""}:${family}`;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    const candidateKey = candidate.itemId || `${candidate.threadId || ""}:${candidate.turnId || ""}:${family}`;
    if (candidate.type !== event.type) continue;
    if (candidateKey === itemKey) return candidate;
    if (candidate.threadId !== event.threadId || candidate.turnId !== event.turnId) break;
  }
  return null;
}

function renderEvent(event) {
  const title = labelForEvent(event);
  const body = eventBody(event);

  return `
    <article class="event">
      <div class="event-header">
        <div class="event-type">${escapeHtml(title)}</div>
        <time class="event-time">${formatTime(event.at)}</time>
      </div>
      ${body || `<div class="event-body empty">无内容</div>`}
    </article>
  `;
}

function eventBody(event) {
  if (event.type === "assistant.delta" || event.type === "user.message") {
    return `<div class="event-body">${escapeHtml(event.text || "")}</div>`;
  }

  if (event.type === "command.output") {
    return `<pre>${escapeHtml(event.output || event.text || stringify(event.raw))}</pre>`;
  }

  if (event.type === "diff.updated") {
    return `<pre>${escapeHtml(event.diff || stringify(event.raw))}</pre>`;
  }

  if (event.type === "plan.updated") {
    return `<pre>${escapeHtml(stringify(event.plan || event.raw))}</pre>`;
  }

  if (event.type === "approval.requested") {
    return `<div class="event-body">${escapeHtml(event.title || "需要授权")}</div>`;
  }

  if (event.text) {
    return `<div class="event-body">${escapeHtml(event.text)}</div>`;
  }

  return `<pre>${escapeHtml(stringify(event.raw || event))}</pre>`;
}

function renderApprovals() {
  const pending = Array.from(state.approvals.values()).filter((item) => item.status === "pending");
  els.approvalBadge.textContent = String(pending.length);

  if (!pending.length) {
    els.approvals.innerHTML = `<div class="empty-state">没有待处理授权</div>`;
    return;
  }

  els.approvals.innerHTML = pending.map((approval) => `
    <article class="approval">
      <div class="approval-title">
        <span>${escapeHtml(approval.title || "需要授权")}</span>
        <span class="approval-kind">${escapeHtml(approval.kind || "approval")}</span>
      </div>
      <div class="approval-body">
        ${approval.command ? `<pre>${escapeHtml(approval.command)}</pre>` : ""}
        ${approval.cwd ? `<p>cwd: ${escapeHtml(approval.cwd)}</p>` : ""}
        ${approval.reason ? `<p>${escapeHtml(approval.reason)}</p>` : ""}
        ${approval.diff ? `<pre>${escapeHtml(approval.diff)}</pre>` : ""}
      </div>
      <div class="approval-actions">
        <button data-approval="${approval.approvalId}" data-decision="accept">同意一次</button>
        <button data-approval="${approval.approvalId}" data-decision="acceptForSession">本会话同意</button>
        <button class="secondary" data-approval="${approval.approvalId}" data-decision="cancel">取消</button>
        <button class="danger" data-approval="${approval.approvalId}" data-decision="decline">拒绝</button>
      </div>
    </article>
  `).join("");

  for (const button of els.approvals.querySelectorAll("button[data-approval]")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      await answerApproval(button.dataset.approval, button.dataset.decision);
    });
  }
}

function renderProjects() {
  if (!state.projects.length) {
    els.projects.innerHTML = `<div class="empty-state">还没有项目历史</div>`;
    return;
  }

  els.projects.innerHTML = state.projects.map((project) => `
    <button class="project ${project.cwd === state.selectedProjectCwd ? "active-project" : ""}" data-project="${escapeAttr(project.cwd)}">
      <div class="thread-header">
        <span class="thread-title">${escapeHtml(project.name || "Project")}</span>
        <span class="thread-meta">${project.count || 0} 条</span>
      </div>
      <div class="thread-body">${escapeHtml(project.latestPreview || "")}</div>
      <div class="project-path">${escapeHtml(project.cwd || "")}</div>
    </button>
  `).join("");

  for (const item of els.projects.querySelectorAll("[data-project]")) {
    item.addEventListener("click", () => {
      loadProjectThreads(item.dataset.project);
    });
  }
}

function renderHistoryThreads() {
  const threads = Array.from(state.historyThreads.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (!state.selectedProjectCwd) {
    els.historyThreads.innerHTML = `<div class="empty-state">先选择一个项目</div>`;
    return;
  }

  if (!threads.length) {
    els.historyThreads.innerHTML = `<div class="empty-state">这个项目还没有历史对话</div>`;
    return;
  }

  els.historyThreads.innerHTML = `${threads.map((thread) => `
    <button class="thread ${thread.threadId === state.activeThreadId ? "active-thread" : ""}" data-thread="${thread.threadId}">
      <div class="thread-header">
        <span class="thread-title">${escapeHtml(thread.title || "Codex thread")}</span>
        <span class="thread-meta">${formatTime(thread.updatedAt)}</span>
      </div>
      <div class="thread-body">${escapeHtml(thread.preview || thread.threadId || "")}</div>
      ${thread.cwd ? `<div class="project-path">${escapeHtml(thread.cwd)}</div>` : ""}
    </button>
  `).join("")}${state.historyNextCursor ? `<button class="load-more" id="loadMoreHistory">加载更多</button>` : ""}`;

  for (const item of els.historyThreads.querySelectorAll("[data-thread]")) {
    item.addEventListener("click", () => {
      openHistoryThread(item.dataset.thread);
    });
  }

  const loadMore = document.querySelector("#loadMoreHistory");
  if (loadMore) {
    loadMore.addEventListener("click", loadMoreHistoryThreads);
  }
}

function labelForEvent(event) {
  const labels = {
    "assistant.delta": "Codex",
    "user.message": "你",
    "command.output": "命令输出",
    "diff.updated": "Diff",
    "plan.updated": "计划",
    "turn.completed": "完成",
    "turn.started": "开始",
    "file.change": "文件变更",
    "reasoning": "推理",
    "web.search": "网页工具",
    "tool.call": "工具调用",
    "approval.requested": "需要授权",
    "approval.answered": "授权已处理",
    "host.status": "Host",
    "codex.status": "Codex 状态",
    "host.ready": "Host"
  };
  return labels[event.type] || event.type || "事件";
}

function switchView(name) {
  for (const item of els.tabs) item.classList.remove("active");
  for (const view of Object.values(els.views)) view.classList.remove("active");

  const tab = Array.from(els.tabs).find((item) => item.dataset.view === name);
  if (tab) tab.classList.add("active");
  if (els.views[name]) els.views[name].classList.add("active");
}

function reportSyncError(prefix, error) {
  const now = Date.now();
  if (now - state.lastSyncErrorAt < 15000) return;
  state.lastSyncErrorAt = now;
  renderStatus(`${prefix}失败：${error.message}`);
}

function compareEvents(left, right) {
  return (left.at || 0) - (right.at || 0)
    || String(left.turnId || "").localeCompare(String(right.turnId || ""))
    || String(left.itemId || "").localeCompare(String(right.itemId || ""));
}

function historyConflictKey(event) {
  if (!event.threadId) return "";
  if (event.itemId) {
    return `${event.type}:${event.threadId}:${event.turnId || ""}:${event.itemId}`;
  }
  if (event.turnId && (event.type === "turn.started" || event.type === "turn.completed")) {
    return `${event.type}:${event.threadId}:${event.turnId}`;
  }
  return "";
}

function threadEventsFingerprint(events) {
  return events
    .slice()
    .sort(compareEvents)
    .map((event) => [
      event.type,
      event.threadId || "",
      event.turnId || "",
      event.itemId || "",
      event.status || "",
      event.text || "",
      event.output || "",
      event.diff || "",
      stringify(event.plan || "")
    ].join("\u001f"))
    .join("\u001e");
}

async function api(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${token}`
  };

  let body;
  if (options.body) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "request failed");
  }
  return payload;
}

function stringify(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function formatTime(time) {
  if (!time) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(time));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function threadBelongsToProject(threadId, cwd) {
  if (!threadId || !cwd) return false;
  const thread = state.threads.get(threadId) || state.historyThreads.get(threadId);
  return thread?.cwd === cwd;
}
