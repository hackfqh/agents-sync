const params = new URLSearchParams(location.search);
const urlToken = params.get("token") || "";
const storedSessionToken = localStorage.getItem("companionSessionToken") || "";
const storedSessionExpiresAt = Number(localStorage.getItem("companionSessionExpiresAt") || 0);
let token = storedSessionExpiresAt > Date.now()
  ? storedSessionToken
  : urlToken || localStorage.getItem("companionToken") || "";

if (storedSessionToken && storedSessionExpiresAt <= Date.now()) {
  localStorage.removeItem("companionSessionToken");
  localStorage.removeItem("companionSessionExpiresAt");
}

if (urlToken) {
  localStorage.setItem("companionToken", urlToken);
}

const initialAgent = normalizeAgent(localStorage.getItem("selectedAgent"));

const state = {
  selectedAgent: initialAgent,
  agents: [
    { id: "codex", name: "Codex" },
    { id: "claude", name: "Claude" }
  ],
  hostOnline: false,
  codexOnline: false,
  activeThreadId: localStorage.getItem(agentStorageKey("activeThreadId", initialAgent)) || null,
  lastSeq: Number(localStorage.getItem("lastSeq") || 0),
  events: [],
  threads: new Map(),
  threadMeta: new Map(),
  historyThreads: new Map(),
  historyNextCursor: null,
  projects: [],
  selectedProjectCwd: localStorage.getItem(agentStorageKey("selectedProjectCwd", initialAgent)) || "",
  approvals: new Map(),
  sessions: [],
  projectSettings: loadProjectSettings(),
  searchQuery: localStorage.getItem("searchQuery") || "",
  globalSearchQuery: localStorage.getItem("globalSearchQuery") || "",
  globalSearchAgent: localStorage.getItem("globalSearchAgent") || "all",
  globalSearchResults: [],
  globalSearchLoading: false,
  globalSearchTimer: null,
  globalSearchSeq: 0,
  notificationsEnabled: false,
  debug: null,
  source: null,
  threadSyncing: false,
  projectSyncing: false,
  debugSyncing: false,
  sessionsSyncing: false,
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
  agentSelect: document.querySelector("#agentSelect"),
  notifyButton: document.querySelector("#notifyButton"),
  refreshButton: document.querySelector("#refreshButton"),
  searchInput: document.querySelector("#searchInput"),
  clearSearchButton: document.querySelector("#clearSearchButton"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  broadcastButton: document.querySelector("#broadcastButton"),
  newThreadButton: document.querySelector("#newThreadButton"),
  starThreadButton: document.querySelector("#starThreadButton"),
  renameThreadButton: document.querySelector("#renameThreadButton"),
  pinThreadButton: document.querySelector("#pinThreadButton"),
  archiveThreadButton: document.querySelector("#archiveThreadButton"),
  exportThreadButton: document.querySelector("#exportThreadButton"),
  timeline: document.querySelector("#timeline"),
  approvals: document.querySelector("#approvals"),
  projects: document.querySelector("#projects"),
  historyThreads: document.querySelector("#historyThreads"),
  globalSearchInput: document.querySelector("#globalSearchInput"),
  globalSearchAgent: document.querySelector("#globalSearchAgent"),
  runGlobalSearchButton: document.querySelector("#runGlobalSearchButton"),
  searchResults: document.querySelector("#searchResults"),
  debug: document.querySelector("#debug"),
  settings: document.querySelector("#settings"),
  approvalBadge: document.querySelector("#approvalBadge"),
  tabs: document.querySelectorAll(".tab"),
  views: {
    timeline: document.querySelector("#timelineView"),
    projects: document.querySelector("#projectsView"),
    history: document.querySelector("#historyView"),
    search: document.querySelector("#searchView"),
    approvals: document.querySelector("#approvalsView"),
    settings: document.querySelector("#settingsView"),
    debug: document.querySelector("#debugView"),
  }
};

if (!token) {
  token = prompt("输入 MOBILE_COMPANION_TOKEN") || "";
  localStorage.setItem("companionToken", token);
}

await ensureSession();
registerServiceWorker();
syncNotificationState();

els.refreshButton.addEventListener("click", () => bootstrap());
els.notifyButton.addEventListener("click", requestNotifications);
els.searchInput.value = state.searchQuery;
els.searchInput.addEventListener("input", () => {
  state.searchQuery = els.searchInput.value.trim();
  localStorage.setItem("searchQuery", state.searchQuery);
  renderAll();
});
els.clearSearchButton.addEventListener("click", () => {
  state.searchQuery = "";
  els.searchInput.value = "";
  localStorage.removeItem("searchQuery");
  renderAll();
});
els.agentSelect.value = state.selectedAgent;
els.agentSelect.addEventListener("change", () => switchAgent(els.agentSelect.value));
els.sendButton.addEventListener("click", sendMessage);
els.broadcastButton.addEventListener("click", broadcastMessage);
els.newThreadButton.addEventListener("click", startNewThread);
els.starThreadButton.addEventListener("click", toggleStarCurrentThread);
els.renameThreadButton.addEventListener("click", renameCurrentThread);
els.pinThreadButton.addEventListener("click", togglePinCurrentThread);
els.archiveThreadButton.addEventListener("click", archiveCurrentThread);
els.exportThreadButton.addEventListener("click", exportCurrentThread);
els.globalSearchInput.value = state.globalSearchQuery;
els.globalSearchAgent.value = state.globalSearchAgent;
els.globalSearchInput.addEventListener("input", scheduleGlobalSearch);
els.globalSearchAgent.addEventListener("change", () => {
  state.globalSearchAgent = els.globalSearchAgent.value;
  localStorage.setItem("globalSearchAgent", state.globalSearchAgent);
  runGlobalSearch({ force: true });
});
els.runGlobalSearchButton.addEventListener("click", () => runGlobalSearch({ force: true }));
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
    if (tab.dataset.view === "search") {
      runGlobalSearch({ force: true });
    }
    if (tab.dataset.view === "settings") {
      refreshSessions();
    }
    if (tab.dataset.view === "debug") {
      refreshDebug();
    }
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
  state.agents = data.agents || state.agents;
  renderAgentOptions();
  state.events = data.recentEvents || [];
  state.threadMeta = new Map((data.threadMeta || []).map((meta) => [threadKey(meta.agent, meta.threadId), meta]));
  state.threads = new Map((data.threads || []).map((thread) => [threadKey(thread.agent, thread.threadId), applyThreadMeta(thread)]));
  state.approvals = new Map((data.approvals || []).map((approval) => [approval.approvalId, approval]));
  if (state.activeThreadId && !state.selectedProjectCwd) {
    state.activeThreadId = null;
    localStorage.removeItem(agentStorageKey("activeThreadId"));
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

function renderAgentOptions() {
  els.agentSelect.innerHTML = state.agents.map((agent) => (
    `<option value="${escapeAttr(agent.id)}">${escapeHtml(agent.name || agent.id)}</option>`
  )).join("");
  els.agentSelect.value = state.selectedAgent;
}

function switchAgent(agent) {
  const nextAgent = normalizeAgent(agent);
  if (nextAgent === state.selectedAgent) return;

  state.selectedAgent = nextAgent;
  localStorage.setItem("selectedAgent", state.selectedAgent);
  state.selectedProjectCwd = localStorage.getItem(agentStorageKey("selectedProjectCwd", nextAgent)) || "";
  state.activeThreadId = localStorage.getItem(agentStorageKey("activeThreadId", nextAgent)) || null;
  state.historyThreads = new Map();
  state.historyNextCursor = null;
  els.agentSelect.value = state.selectedAgent;
  switchView("projects");
  renderAll();
  refreshProjects();
  syncVisibleData({ force: true });
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
    const existing = state.threads.get(threadKey(event.agent, event.threadId)) || {
      agent: eventAgent(event),
      threadId: event.threadId,
      title: event.title || "Codex thread",
      createdAt: event.at
    };
    existing.updatedAt = event.at;
    if (event.title) existing.title = event.title;
    if (event.status) existing.status = event.status;
    state.threads.set(threadKey(event.agent, event.threadId), applyThreadMeta(existing));
  }

  if (event.type === "thread.upserted" && event.thread?.threadId) {
    state.threads.set(threadKey(event.thread.agent, event.thread.threadId), applyThreadMeta(event.thread));
    if (
      normalizeAgent(event.thread.agent) === state.selectedAgent
      && state.selectedProjectCwd
      && event.thread.cwd === state.selectedProjectCwd
      && !state.activeThreadId
    ) {
      state.activeThreadId = event.thread.threadId;
      localStorage.setItem(agentStorageKey("activeThreadId"), state.activeThreadId);
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

  if (event.type === "thread.metadata.updated" && event.meta?.threadId) {
    state.threadMeta.set(threadKey(event.meta.agent, event.meta.threadId), event.meta);
    applyThreadMetaToCollections(event.meta.agent, event.meta.threadId);
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

  if (!options.skipPush) {
    maybeNotify(event);
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
        agent: state.selectedAgent,
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

async function broadcastMessage() {
  const text = els.messageInput.value.trim();
  if (!text) return;

  els.broadcastButton.disabled = true;
  try {
    const agents = state.agents.map((agent) => agent.id);
    const data = await api("/api/message/broadcast", {
      method: "POST",
      body: {
        agents,
        text,
        cwd: state.selectedProjectCwd || null
      }
    });
    const okCount = (data.results || []).filter((item) => item.ok).length;
    els.messageInput.value = "";
    renderStatus(`已发送到 ${okCount}/${agents.length} 个 Agent`);
  } catch (error) {
    renderStatus(`双发失败：${error.message}`);
  } finally {
    els.broadcastButton.disabled = false;
  }
}

function startNewThread() {
  state.activeThreadId = null;
  localStorage.removeItem(agentStorageKey("activeThreadId"));
  switchView("timeline");
  renderAll();
  renderStatus("已切换到新对话");
  els.messageInput.focus();
}

async function refreshProjects() {
  try {
    const data = await api(`/api/projects?agent=${encodeURIComponent(state.selectedAgent)}`);
    state.projects = data.projects || [];
    renderProjects();
  } catch (error) {
    renderStatus(`项目加载失败：${error.message}`);
  }
}

async function loadProjectThreads(cwd) {
  state.selectedProjectCwd = cwd;
  localStorage.setItem(agentStorageKey("selectedProjectCwd"), cwd);
  state.activeThreadId = null;
  localStorage.removeItem(agentStorageKey("activeThreadId"));
  state.events = state.events.filter((event) => !event.threadId || eventAgent(event) !== state.selectedAgent || threadBelongsToProject(event.threadId, cwd));
  switchView("history");
  els.historyThreads.innerHTML = `<div class="empty-state">加载历史中</div>`;

  try {
    const url = new URL("/api/history/threads", location.origin);
    url.searchParams.set("agent", state.selectedAgent);
    if (cwd) url.searchParams.set("cwd", cwd);
    const data = await api(`${url.pathname}${url.search}`);
    state.historyThreads = new Map((data.threads || []).map((thread) => [threadKey(thread.agent, thread.threadId), applyThreadMeta(thread)]));
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
    url.searchParams.set("agent", state.selectedAgent);
    if (state.selectedProjectCwd) url.searchParams.set("cwd", state.selectedProjectCwd);
    url.searchParams.set("cursor", state.historyNextCursor);
    const data = await api(`${url.pathname}${url.search}`);
    for (const thread of data.threads || []) {
      state.historyThreads.set(threadKey(thread.agent, thread.threadId), applyThreadMeta(thread));
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
    if (isViewActive("debug")) refreshDebug();
  }, activeThreadSyncMs);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncVisibleData({ force: true });
  });

  window.addEventListener("focus", () => {
    syncVisibleData({ force: true });
  });
}

async function ensureSession() {
  if (!token || token.startsWith("sess_")) {
    stripTokenFromUrl();
    return;
  }

  try {
    const data = await api("/api/session", { method: "POST" });
    if (data.token) {
      token = data.token;
      localStorage.setItem("companionSessionToken", token);
      localStorage.setItem("companionSessionExpiresAt", String(data.expiresAt || 0));
      stripTokenFromUrl();
    }
  } catch {
    // Keep the shared token fallback so existing local workflows continue to work.
  }
}

function stripTokenFromUrl() {
  if (!urlToken) return;
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete("token");
  history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function syncNotificationState() {
  state.notificationsEnabled = typeof Notification !== "undefined" && Notification.permission === "granted";
  updateNotifyButton();
}

async function requestNotifications() {
  if (typeof Notification === "undefined") {
    renderStatus("当前浏览器不支持通知");
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    state.notificationsEnabled = permission === "granted";
    updateNotifyButton();
    renderStatus(state.notificationsEnabled ? "通知已开启" : "通知未开启");
  } catch (error) {
    renderStatus(`通知开启失败：${error.message}`);
  }
}

function updateNotifyButton() {
  if (!els.notifyButton) return;
  const available = typeof Notification !== "undefined";
  els.notifyButton.disabled = !available;
  els.notifyButton.textContent = state.notificationsEnabled ? "已通知" : "通知";
}

function maybeNotify(event) {
  if (!state.notificationsEnabled) return;
  if (!event) return;

  if (event.type === "approval.requested") {
    showNotification(`${agentName(event.agent)} 需要授权`, event.title || event.reason || event.cwd || "有新的授权请求");
    return;
  }

  if (event.type === "turn.completed") {
    if (!document.hidden) return;
    const thread = state.threads.get(threadKey(event.agent, event.threadId));
    showNotification(`${agentName(event.agent)} 回复完成`, thread?.title || event.threadId || "当前对话已有新消息");
  }
}

function showNotification(title, body) {
  const options = {
    body: String(body || "").slice(0, 180),
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: `companion:${title}:${body || ""}`.slice(0, 96)
  };

  if (navigator.serviceWorker?.ready) {
    navigator.serviceWorker.ready
      .then((registration) => registration.showNotification(title, options))
      .catch(() => new Notification(title, options));
    return;
  }

  new Notification(title, options);
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
    url.searchParams.set("agent", state.selectedAgent);
    url.searchParams.set("cwd", state.selectedProjectCwd);
    const data = await api(`${url.pathname}${url.search}`);
    const incomingThreads = data.threads || [];
    const hadLoadedMore = state.historyThreads.size > incomingThreads.length;
    state.historyThreads = new Map(state.historyThreads);
    for (const thread of incomingThreads) {
      state.historyThreads.set(threadKey(thread.agent, thread.threadId), applyThreadMeta(thread));
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

async function refreshDebug() {
  if (state.debugSyncing) return;

  state.debugSyncing = true;
  try {
    state.debug = await api("/api/debug");
    renderDebug();
  } catch (error) {
    state.debug = { error: error.message };
    renderDebug();
  } finally {
    state.debugSyncing = false;
  }
}

async function fetchHistoryThread(threadId) {
  const url = new URL("/api/history/thread", location.origin);
  url.searchParams.set("agent", state.selectedAgent);
  url.searchParams.set("threadId", threadId);
  return api(`${url.pathname}${url.search}`);
}

function mergeHistoryThread(data, fallbackThreadId) {
  const threadId = data.thread?.threadId || fallbackThreadId;
  if (!threadId) return false;

  if (data.thread?.threadId) {
    state.threads.set(threadKey(data.thread.agent, data.thread.threadId), applyThreadMeta(data.thread));
    state.activeThreadId = data.thread.threadId;
    localStorage.setItem(agentStorageKey("activeThreadId"), state.activeThreadId);
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
  updateNotifyButton();
  renderThreadActions();
  renderTimeline();
  renderApprovals();
  renderProjects();
  renderHistoryThreads();
  renderSearchResults();
  renderSettings();
  renderDebug();
}

function renderStatus(extra = "") {
  const host = state.hostOnline ? "Host 在线" : "Host 离线";
  const codex = state.codexOnline ? "Codex 在线" : "Codex 未连接";
  els.statusLine.textContent = [host, codex, extra].filter(Boolean).join(" · ");
}

function renderThreadActions() {
  const thread = currentThread();
  const hasThread = Boolean(thread);
  for (const button of [
    els.starThreadButton,
    els.renameThreadButton,
    els.pinThreadButton,
    els.archiveThreadButton,
    els.exportThreadButton
  ]) {
    button.disabled = !hasThread;
  }
  els.starThreadButton.textContent = thread?.starred ? "★" : "☆";
  els.starThreadButton.title = thread?.starred ? "取消收藏" : "收藏";
  els.pinThreadButton.textContent = thread?.pinned ? "取消置顶" : "置顶";
  els.archiveThreadButton.textContent = thread?.archived ? "取消归档" : "归档";
}

async function toggleStarCurrentThread() {
  const thread = currentThread();
  if (!thread) return;
  await saveThreadMeta(thread, { starred: !thread.starred });
}

async function renameCurrentThread() {
  const thread = currentThread();
  if (!thread) return;
  const title = prompt("输入新的对话名称", thread.title || "");
  if (title === null) return;
  await saveThreadMeta(thread, { title });
}

async function togglePinCurrentThread() {
  const thread = currentThread();
  if (!thread) return;
  await saveThreadMeta(thread, { pinned: !thread.pinned });
}

async function archiveCurrentThread() {
  const thread = currentThread();
  if (!thread) return;
  await saveThreadMeta(thread, { archived: !thread.archived });
  if (!thread.archived) {
    state.activeThreadId = null;
    localStorage.removeItem(agentStorageKey("activeThreadId"));
    switchView("history");
  }
}

async function saveThreadMeta(thread, patch) {
  try {
    const data = await api("/api/thread-meta", {
      method: "POST",
      body: {
        agent: thread.agent || state.selectedAgent,
        threadId: thread.threadId,
        ...patch
      }
    });
    if (data.meta) {
      state.threadMeta.set(threadKey(data.meta.agent, data.meta.threadId), data.meta);
      applyThreadMetaToCollections(data.meta.agent, data.meta.threadId);
    }
    renderAll();
    renderStatus("会话已更新");
  } catch (error) {
    renderStatus(`会话更新失败：${error.message}`);
  }
}

function exportCurrentThread() {
  const thread = currentThread();
  if (!thread) return;
  const entries = buildTimelineEntries(
    state.events
      .filter((event) => eventAgent(event) === state.selectedAgent && event.threadId === thread.threadId && visibleTimelineTypes.has(event.type))
      .sort(compareEvents)
  );
  const content = [
    `# ${thread.title || "Conversation"}`,
    "",
    `Agent: ${agentName(thread.agent)}`,
    `Thread: ${thread.threadId}`,
    thread.cwd ? `Project: ${thread.cwd}` : "",
    "",
    ...entries.map((event) => `## ${labelForEvent(event)} ${formatTime(event.at)}\n\n${eventCopyText(event)}`)
  ].filter(Boolean).join("\n");
  downloadText(`${safeFilename(thread.title || thread.threadId)}.md`, content, "text/markdown");
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
    eventAgent(event) === state.selectedAgent
    && event.threadId === state.activeThreadId
    && visibleTimelineTypes.has(event.type)
  )).sort(compareEvents);

  if (!currentEvents.length) {
    els.timeline.innerHTML = `<div class="empty-state">还没有消息</div>`;
    return;
  }

  const currentEntries = buildTimelineEntries(currentEvents)
    .filter((event) => matchesSearch(eventSearchText(event)))
    .slice(-120)
    .reverse();
  if (!currentEntries.length) {
    els.timeline.innerHTML = `<div class="empty-state">${state.searchQuery ? "没有匹配的消息" : "还没有消息"}</div>`;
    return;
  }

  els.timeline.innerHTML = currentEntries.map((event, index) => renderEvent(event, index)).join("");
  bindCopyButtons(currentEntries);
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

function renderEvent(event, index = 0) {
  const title = labelForEvent(event);
  const body = eventBody(event);

  return `
    <article class="event">
      <div class="event-header">
        <div class="event-type">${escapeHtml(title)}</div>
        <time class="event-time">${formatTime(event.at)}</time>
      </div>
      ${body || `<div class="event-body empty">无内容</div>`}
      <div class="event-tools">
        <button class="copy-button" data-copy-index="${index}">复制</button>
      </div>
    </article>
  `;
}

function eventBody(event) {
  if (event.type === "assistant.delta" || event.type === "user.message") {
    return `<div class="event-body markdown-body">${renderMarkdown(event.text || "")}</div>`;
  }

  if (event.type === "command.output") {
    return `<pre>${escapeHtml(event.output || event.text || stringify(event.raw))}</pre>`;
  }

  if (event.type === "diff.updated") {
    return renderDiff(event.diff || stringify(event.raw));
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

function renderMarkdown(text) {
  const blocks = [];
  const lines = String(text || "").split(/\r?\n/);
  let paragraph = [];
  let list = [];
  let code = [];
  let inCode = false;
  let codeLang = "";

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push(`<ul>${list.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushCode = () => {
    blocks.push(`<pre><code${codeLang ? ` data-lang="${escapeAttr(codeLang)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
    code = [];
    codeLang = "";
  };

  for (const line of lines) {
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
        codeLang = fence[1] || "";
      }
      continue;
    }

    if (inCode) {
      code.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (inCode) flushCode();
  flushParagraph();
  flushList();
  return blocks.join("");
}

function renderInlineMarkdown(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderDiff(text) {
  const lines = String(text || "").split(/\r?\n/);
  return `
    <div class="diff">
      ${lines.map((line) => {
        const cls = line.startsWith("+") && !line.startsWith("+++") ? "added"
          : line.startsWith("-") && !line.startsWith("---") ? "removed"
          : line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ") ? "meta"
          : "";
        return `<span class="diff-line ${cls}">${escapeHtml(line || " ")}</span>`;
      }).join("")}
    </div>
  `;
}

function bindCopyButtons(entries) {
  for (const button of els.timeline.querySelectorAll("[data-copy-index]")) {
    button.addEventListener("click", async () => {
      const entry = entries[Number(button.dataset.copyIndex)];
      const text = eventCopyText(entry);
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "已复制";
        setTimeout(() => {
          button.textContent = "复制";
        }, 1200);
      } catch {
        renderStatus("复制失败");
      }
    });
  }
}

function eventCopyText(event) {
  if (!event) return "";
  return event.text
    || event.output
    || event.diff
    || stringify(event.plan || event.raw || event);
}

function renderApprovals() {
  const pending = Array.from(state.approvals.values()).filter((item) => item.status === "pending" && normalizeAgent(item.agent) === state.selectedAgent);
  els.approvalBadge.textContent = String(pending.length);

  if (!pending.length) {
    els.approvals.innerHTML = `<div class="empty-state">没有待处理授权</div>`;
    return;
  }

  els.approvals.innerHTML = pending.map((approval) => {
    const risk = approvalRisk(approval);
    return `
      <article class="approval">
        <div class="approval-title">
          <span>${escapeHtml(approval.title || "需要授权")}</span>
          <span class="approval-kind">${escapeHtml(approval.kind || "approval")}</span>
        </div>
        <div class="approval-title">
          <span class="approval-risk ${risk.level}">${escapeHtml(risk.label)}</span>
        </div>
        <div class="approval-body">
          ${approval.command ? `<pre>${escapeHtml(approval.command)}</pre>` : ""}
          ${approval.cwd ? `<p>cwd: ${escapeHtml(approval.cwd)}</p>` : ""}
          ${approval.reason ? `<p>${escapeHtml(approval.reason)}</p>` : ""}
          ${approval.diff ? renderDiff(approval.diff) : ""}
        </div>
        <div class="approval-actions">
          <button data-approval="${approval.approvalId}" data-risk="${risk.level}" data-decision="accept">同意一次</button>
          <button data-approval="${approval.approvalId}" data-risk="${risk.level}" data-decision="acceptForSession">本会话同意</button>
          <button class="secondary" data-approval="${approval.approvalId}" data-decision="cancel">取消</button>
          <button class="danger" data-approval="${approval.approvalId}" data-decision="decline">拒绝</button>
        </div>
      </article>
    `;
  }).join("");

  for (const button of els.approvals.querySelectorAll("button[data-approval]")) {
    button.addEventListener("click", async () => {
      if (button.dataset.risk === "high" && button.dataset.decision?.startsWith("accept")) {
        const ok = confirm("这是高风险操作，确认同意执行吗？");
        if (!ok) return;
      }
      button.disabled = true;
      await answerApproval(button.dataset.approval, button.dataset.decision);
    });
  }
}

function approvalRisk(approval) {
  const text = [
    approval.command,
    approval.reason,
    approval.diff,
    approval.title
  ].join(" ").toLowerCase();

  if (/(rm\s+-rf|sudo|chmod\s+777|chown|mkfs|dd\s+if=|diskutil|format|删除|清空|wipe)/.test(text)) {
    return { level: "high", label: "高风险" };
  }
  if (/(npm\s+install|curl|wget|pip\s+install|brew\s+install|写入|修改|delete|remove|network|网络)/.test(text)) {
    return { level: "medium", label: "中风险" };
  }
  return { level: "low", label: "低风险" };
}

function renderProjects() {
  const projects = state.projects.filter((project) => matchesSearch([
    project.name,
    project.cwd,
    project.latestPreview,
    project.count
  ].join(" ")));

  if (!projects.length) {
    els.projects.innerHTML = `<div class="empty-state">${state.searchQuery ? "没有匹配的项目" : "还没有项目历史"}</div>`;
    return;
  }

  els.projects.innerHTML = projects.map((project) => `
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
  const threads = Array.from(state.historyThreads.values())
    .filter((thread) => matchesSearch([
      thread.title,
      thread.preview,
      thread.cwd,
      thread.threadId
    ].join(" ")))
    .sort(compareThreads);

  if (!state.selectedProjectCwd) {
    els.historyThreads.innerHTML = `<div class="empty-state">先选择一个项目</div>`;
    return;
  }

  if (!threads.length) {
    els.historyThreads.innerHTML = `<div class="empty-state">${state.searchQuery ? "没有匹配的历史对话" : "这个项目还没有历史对话"}</div>`;
    return;
  }

  els.historyThreads.innerHTML = `${threads.map((thread) => `
    <button class="thread ${thread.threadId === state.activeThreadId ? "active-thread" : ""}" data-thread="${thread.threadId}">
      <div class="thread-header">
        <span class="thread-title">${thread.starred ? "★ " : ""}${escapeHtml(thread.title || "Codex thread")}</span>
        <span class="thread-meta">${thread.pinned ? "置顶 · " : ""}${thread.archived ? "归档 · " : ""}${formatTime(thread.updatedAt)}</span>
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

async function refreshSessions() {
  if (state.sessionsSyncing) return;
  state.sessionsSyncing = true;
  try {
    const data = await api("/api/sessions");
    state.sessions = data.sessions || [];
    renderSettings();
  } catch (error) {
    renderStatus(`设备列表加载失败：${error.message}`);
  } finally {
    state.sessionsSyncing = false;
  }
}

function scheduleGlobalSearch() {
  state.globalSearchQuery = els.globalSearchInput.value.trim();
  localStorage.setItem("globalSearchQuery", state.globalSearchQuery);
  if (state.globalSearchTimer) {
    clearTimeout(state.globalSearchTimer);
  }
  state.globalSearchTimer = setTimeout(() => {
    runGlobalSearch({ force: true });
  }, 250);
}

async function runGlobalSearch(options = {}) {
  const query = state.globalSearchQuery.trim();
  const agent = normalizeSearchAgent(state.globalSearchAgent);
  if (!options.force && !query && state.globalSearchResults.length) {
    renderSearchResults();
    return;
  }

  const currentSeq = ++state.globalSearchSeq;
  state.globalSearchLoading = true;
  renderSearchResults();

  try {
    const url = new URL("/api/search", location.origin);
    url.searchParams.set("q", query);
    url.searchParams.set("agent", agent);
    url.searchParams.set("limit", "80");
    const data = await api(`${url.pathname}${url.search}`);
    if (currentSeq !== state.globalSearchSeq) return;
    state.globalSearchResults = data.results || [];
  } catch (error) {
    if (currentSeq === state.globalSearchSeq) {
      state.globalSearchResults = [];
      renderStatus(`搜索失败：${error.message}`);
    }
  } finally {
    if (currentSeq === state.globalSearchSeq) {
      state.globalSearchLoading = false;
      renderSearchResults();
    }
  }
}

function renderSearchResults() {
  if (!els.searchResults) return;

  if (state.globalSearchLoading) {
    els.searchResults.innerHTML = `<div class="empty-state">搜索中…</div>`;
    return;
  }

  if (!state.globalSearchResults.length) {
    els.searchResults.innerHTML = `<div class="empty-state">${state.globalSearchQuery ? "没有匹配的结果" : "输入关键词开始全局搜索"}</div>`;
    return;
  }

  els.searchResults.innerHTML = state.globalSearchResults.map((result) => renderSearchResult(result)).join("");
  for (const button of els.searchResults.querySelectorAll("[data-open-search-result]")) {
    button.addEventListener("click", () => openSearchResult({
      agent: button.dataset.agent,
      threadId: button.dataset.threadId,
      cwd: button.dataset.cwd || ""
    }));
  }
  for (const button of els.searchResults.querySelectorAll("[data-search-star]")) {
    button.addEventListener("click", async () => {
      const nextStarred = button.dataset.starred !== "true";
      await saveThreadMeta({
        agent: button.dataset.agent,
        threadId: button.dataset.threadId
      }, { starred: nextStarred });
      await runGlobalSearch({ force: true });
    });
  }
}

function renderSearchResult(result) {
  const snippets = Array.isArray(result.snippets) ? result.snippets : [];
  return `
    <article class="search-result">
      <div class="thread-header">
        <div>
          <div class="thread-title">
            <span>${escapeHtml(result.title || result.threadId || "Thread")}</span>
            ${result.starred ? `<span class="approval-risk medium">收藏</span>` : ""}
            ${result.pinned ? `<span class="approval-risk low">置顶</span>` : ""}
            ${result.archived ? `<span class="approval-risk low">归档</span>` : ""}
          </div>
          <div class="search-result-meta">
            <span>${escapeHtml(agentName(result.agent))}</span>
            ${result.cwd ? `<span>${escapeHtml(result.cwd)}</span>` : ""}
            <span>${formatTime(result.updatedAt)}</span>
          </div>
        </div>
        <button class="search-star" data-search-star="1" data-agent="${escapeAttr(result.agent)}" data-thread-id="${escapeAttr(result.threadId)}" data-starred="${result.starred ? "true" : "false"}">${result.starred ? "★" : "☆"}</button>
      </div>
      ${result.preview ? `<div class="thread-body">${escapeHtml(result.preview)}</div>` : ""}
      ${snippets.length ? `<div class="search-snippets">${snippets.map((snippet) => `
        <div class="search-snippet">
          <time>${escapeHtml(formatTime(snippet.at))} · ${escapeHtml(labelForEvent({ type: snippet.type }))}</time>
          <div>${escapeHtml(snippet.text)}</div>
        </div>
      `).join("")}</div>` : ""}
      <div class="settings-actions result-actions">
        <button class="secondary-button" data-open-search-result="1" data-agent="${escapeAttr(result.agent)}" data-thread-id="${escapeAttr(result.threadId)}" data-cwd="${escapeAttr(result.cwd || "")}">打开对话</button>
      </div>
    </article>
  `;
}

async function openSearchResult(result) {
  try {
    const targetAgent = normalizeAgent(result.agent);
    if (targetAgent !== state.selectedAgent) {
      switchAgent(targetAgent);
    }
    state.selectedProjectCwd = result.cwd || "";
    localStorage.setItem(agentStorageKey("selectedProjectCwd", targetAgent), state.selectedProjectCwd);
    await loadProjectThreads(result.cwd || "");
    await openHistoryThread(result.threadId);
    switchView("timeline");
    renderAll();
  } catch (error) {
    renderStatus(`打开搜索结果失败：${error.message}`);
  }
}

function normalizeSearchAgent(agent) {
  return agent === "all" ? "all" : normalizeAgent(agent || state.selectedAgent);
}

function renderSettings() {
  if (!els.settings) return;
  const setting = projectSetting();
  const projectBlock = state.selectedProjectCwd
    ? `
      <section class="settings-card">
        <h2>项目设置</h2>
        <div class="settings-row">
          <span>${escapeHtml(state.selectedProjectCwd)}</span>
        </div>
        <div class="settings-row">
          <span>默认 Agent</span>
          <select id="projectDefaultAgent" class="agent-select">
            ${state.agents.map((agent) => `
              <option value="${escapeAttr(agent.id)}" ${normalizeAgent(setting.defaultAgent || state.selectedAgent) === agent.id ? "selected" : ""}>${escapeHtml(agent.name || agent.id)}</option>
            `).join("")}
          </select>
        </div>
      </section>
    `
    : `
      <section class="settings-card">
        <h2>项目设置</h2>
        <div class="empty-state">先选择一个项目</div>
      </section>
    `;

  const sessionBlock = `
    <section class="settings-card">
      <h2>设备会话</h2>
      ${state.sessions.length ? state.sessions.map((session) => `
        <div class="settings-row">
          <span>
            ${escapeHtml(session.current ? "当前设备" : deviceLabel(session))}
            <br>
            最近访问：${escapeHtml(formatTime(session.lastSeenAt))}
          </span>
          <div class="settings-actions">
            <button class="secondary-button" data-revoke-session="${escapeAttr(session.id)}" ${session.current ? "disabled" : ""}>撤销</button>
          </div>
        </div>
      `).join("") : `<div class="empty-state">暂无设备会话</div>`}
    </section>
  `;

  const backupBlock = `
    <section class="settings-card">
      <h2>备份</h2>
      <div class="settings-row">
        <span>导出 Relay 缓存、线程元数据、授权记录和设备摘要</span>
        <div class="settings-actions">
          <button id="exportBackupButton" class="secondary-button">导出全部数据</button>
        </div>
      </div>
    </section>
  `;

  els.settings.innerHTML = `${projectBlock}${sessionBlock}${backupBlock}`;

  const projectDefaultAgent = document.querySelector("#projectDefaultAgent");
  if (projectDefaultAgent) {
    projectDefaultAgent.addEventListener("change", () => {
      updateProjectSetting(state.selectedProjectCwd, {
        defaultAgent: normalizeAgent(projectDefaultAgent.value)
      });
      renderStatus("项目默认 Agent 已保存");
    });
  }

  for (const button of els.settings.querySelectorAll("[data-revoke-session]")) {
    button.addEventListener("click", async () => {
      await revokeSession(button.dataset.revokeSession);
    });
  }

  const exportBackupButton = document.querySelector("#exportBackupButton");
  if (exportBackupButton) {
    exportBackupButton.addEventListener("click", exportBackup);
  }
}

async function exportBackup() {
  try {
    const data = await api("/api/export");
    downloadText(
      `codex-mobile-companion-backup-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`,
      JSON.stringify(data, null, 2),
      "application/json"
    );
    renderStatus("备份已导出");
  } catch (error) {
    renderStatus(`备份导出失败：${error.message}`);
  }
}

async function revokeSession(sessionId) {
  if (!sessionId) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    state.sessions = state.sessions.filter((session) => session.id !== sessionId);
    renderSettings();
    renderStatus("设备会话已撤销");
  } catch (error) {
    renderStatus(`撤销失败：${error.message}`);
  }
}

function deviceLabel(session) {
  const agent = String(session.userAgent || "").split(" ").slice(0, 3).join(" ");
  return agent || session.remoteAddress || "未知设备";
}

function renderDebug() {
  if (!els.debug) return;

  if (!state.debug) {
    els.debug.innerHTML = `<div class="empty-state">打开调试页后会自动加载状态</div>`;
    return;
  }

  if (state.debug.error) {
    els.debug.innerHTML = `<div class="empty-state">调试信息加载失败：${escapeHtml(state.debug.error)}</div>`;
    return;
  }

  const host = state.debug.host || {};
  const relay = state.debug.relay || {};
  const persistence = state.debug.persistence || {};

  els.debug.innerHTML = `
    <div class="debug-grid">
      ${renderDebugCard("Host", [
        ["状态", host.online ? "在线" : "离线"],
        ["最近心跳", formatTime(host.lastSeenAt)],
        ["待回复请求", host.pendingRequests],
        ["命令队列", host.queuedCommands],
        ["长轮询", host.openPolls]
      ])}
      ${renderDebugCard("Relay", [
        ["事件序号", relay.nextSeq],
        ["命令序号", relay.nextCommandSeq],
        ["事件缓存", relay.events],
        ["线程缓存", relay.threads],
        ["会话元数据", relay.threadMeta],
        ["SSE 连接", relay.sseClients],
        ["浏览器会话", relay.sessions]
      ])}
      ${renderDebugCard("授权", [
        ["授权记录", relay.approvals],
        ["待处理", relay.pendingApprovals]
      ])}
      ${renderDebugCard("持久化", [
        ["数据文件", persistence.dataFile],
        ["加载时间", formatTime(persistence.loadedAt)],
        ["保存时间", formatTime(persistence.lastSavedAt)],
        ["保存错误", persistence.lastSaveError || "无"]
      ])}
    </div>
  `;
}

function renderDebugCard(title, rows) {
  return `
    <section class="debug-card">
      <h2>${escapeHtml(title)}</h2>
      ${rows.map(([label, value]) => `
        <div class="debug-row">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value ?? "")}</strong>
        </div>
      `).join("")}
    </section>
  `;
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

function compareThreads(left, right) {
  return Number(Boolean(right.starred)) - Number(Boolean(left.starred))
    || Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
    || Number(Boolean(left.archived)) - Number(Boolean(right.archived))
    || (right.updatedAt || 0) - (left.updatedAt || 0);
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

async function api(path, options = {}, retrySession = true) {
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
  if (response.status === 401 && retrySession && token.startsWith("sess_") && localStorage.getItem("companionToken")) {
    localStorage.removeItem("companionSessionToken");
    localStorage.removeItem("companionSessionExpiresAt");
    token = localStorage.getItem("companionToken") || "";
    await ensureSession();
    return api(path, options, false);
  }
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
  const thread = state.threads.get(threadKey(state.selectedAgent, threadId))
    || state.historyThreads.get(threadKey(state.selectedAgent, threadId));
  return thread?.cwd === cwd;
}

function currentThread() {
  if (!state.activeThreadId) return null;
  return state.threads.get(threadKey(state.selectedAgent, state.activeThreadId))
    || state.historyThreads.get(threadKey(state.selectedAgent, state.activeThreadId))
    || null;
}

function applyThreadMeta(thread) {
  if (!thread?.threadId) return thread;
  const meta = state.threadMeta.get(threadKey(thread.agent, thread.threadId));
  if (!meta) return thread;
  return {
    ...thread,
    title: meta.title || thread.title,
    pinned: Boolean(meta.pinned),
    archived: Boolean(meta.archived),
    metaUpdatedAt: meta.updatedAt
  };
}

function applyThreadMetaToCollections(agent, threadId) {
  const key = threadKey(agent, threadId);
  const thread = state.threads.get(key);
  if (thread) state.threads.set(key, applyThreadMeta(thread));
  const historyThread = state.historyThreads.get(key);
  if (historyThread) state.historyThreads.set(key, applyThreadMeta(historyThread));
}

function loadProjectSettings() {
  try {
    return JSON.parse(localStorage.getItem("projectSettings") || "{}");
  } catch {
    return {};
  }
}

function saveProjectSettings() {
  localStorage.setItem("projectSettings", JSON.stringify(state.projectSettings));
}

function projectSetting(cwd = state.selectedProjectCwd) {
  if (!cwd) return {};
  return state.projectSettings[cwd] || {};
}

function updateProjectSetting(cwd, patch) {
  if (!cwd) return;
  state.projectSettings[cwd] = {
    ...(state.projectSettings[cwd] || {}),
    ...patch
  };
  saveProjectSettings();
}

function downloadText(filename, content, type) {
  const blob = new Blob([content], { type: `${type}; charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(value) {
  return String(value || "conversation")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "conversation";
}

function matchesSearch(text) {
  const query = state.searchQuery.trim().toLowerCase();
  if (!query) return true;
  return String(text || "").toLowerCase().includes(query);
}

function eventSearchText(event) {
  return [
    labelForEvent(event),
    event.text,
    event.output,
    event.diff,
    stringify(event.plan || ""),
    stringify(event.raw || "")
  ].join(" ");
}

function isViewActive(name) {
  return els.views[name]?.classList.contains("active");
}

function agentName(agent) {
  return state.agents.find((item) => item.id === normalizeAgent(agent))?.name || normalizeAgent(agent);
}

function agentStorageKey(key, agent) {
  return `${normalizeAgent(agent || localStorage.getItem("selectedAgent") || "codex")}:${key}`;
}

function normalizeAgent(agent) {
  return agent === "claude" ? "claude" : "codex";
}

function eventAgent(event) {
  return normalizeAgent(event?.agent);
}

function threadKey(agent, threadId) {
  return `${normalizeAgent(agent)}:${threadId}`;
}
