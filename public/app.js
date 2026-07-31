const COLORS = ["violet", "mint", "orange", "blue", "rose"];
const COLOR_NAMES = { violet: "葡萄紫", mint: "薄荷绿", orange: "日落橙", blue: "海盐蓝", rose: "莓果粉" };
const APP_VERSION = "v20260731.200410";
const EXPECTED_SERVICE_WORKER_VERSION = "rabbittodo-v32";
const SERVICE_WORKER_CHECK_INTERVAL = 10 * 60 * 1_000;
const SERVICE_WORKER_RETRY_INTERVAL = 5 * 60 * 1_000;
const SERVICE_WORKER_CHECK_KEY = "rabbittodo-sw-last-check";
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const app = document.querySelector("#app");
const isIPad = /iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
document.documentElement.classList.toggle("is-ipad", isIPad);
document.documentElement.classList.toggle("is-touch-device", navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches);
const isLandscapeViewport = () => window.innerWidth > window.innerHeight;
let wasLandscapeViewport = isLandscapeViewport();
const updateViewportClasses = () => {
  const isLandscape = isLandscapeViewport();
  document.documentElement.classList.toggle("is-compact-landscape", isLandscape);
  if (isLandscape && !wasLandscapeViewport) {
    state.filtersOpen = true;
    render();
  }
  wasLandscapeViewport = isLandscape;
};
let isReloadingForServiceWorker = false;
let serviceWorkerRegistration = null;
let serviceWorkerUpdatePromise = null;
let serviceWorkerReloadPending = false;
let serviceWorkerVersionProbeScheduled = false;
const preventPageZoom = (event) => {
  if (event.type.startsWith("gesture") || event.touches?.length > 1) event.preventDefault();
};
document.addEventListener("gesturestart", preventPageZoom, { passive: false });
document.addEventListener("gesturechange", preventPageZoom, { passive: false });
document.addEventListener("touchmove", preventPageZoom, { passive: false });
let taskSyncPromise = null;
let lastTaskSyncAt = 0;
let mutationChain = Promise.resolve();
let pendingMutations = 0;
let nextTemporaryTaskId = -1;
const taskIdAliases = new Map();
let persistentAvatar = null;
let persistentProfileIcon = null;
let persistentIdentitySymbol = null;
let pointerDrag = null;
let suppressCardClickUntil = 0;
let dragAutoScrollFrame = 0;
let dragAutoScrollSpeed = 0;
const savedIdentity = localStorage.getItem("todo-identity") || "";

const state = {
  identity: savedIdentity, identityDraft: sessionStorage.getItem("todo-identity-draft") || "",
  identityStatus: "", identityPromptOpen: !savedIdentity, identitySubmitting: false, tasks: [], view: "todo", tag: "全部", color: "全部", filtersOpen: wasLandscapeViewport, editor: null, datePicker: null, draftTags: [], tagInput: "",
};

updateViewportClasses();
window.addEventListener("resize", updateViewportClasses);

function serviceWorkerVersionNumber(value) {
  return Number(String(value || "").match(/^rabbittodo-v(\d+)$/)?.[1] || 0);
}

function handleServiceWorkerVersion(version) {
  if (serviceWorkerVersionNumber(version) <= serviceWorkerVersionNumber(EXPECTED_SERVICE_WORKER_VERSION)) return;
  serviceWorkerReloadPending = true;
  reloadForServiceWorkerUpdate();
}

function probeServiceWorkerVersion() {
  if (serviceWorkerVersionProbeScheduled || !navigator.serviceWorker?.controller) return;
  serviceWorkerVersionProbeScheduled = true;
  setTimeout(() => {
    serviceWorkerVersionProbeScheduled = false;
    navigator.serviceWorker.controller?.postMessage({ type: "RABBITTODO_GET_VERSION" });
  }, 80);
}

function scheduleServiceWorkerRetry() {
  const retryFrom = Date.now() - SERVICE_WORKER_CHECK_INTERVAL + SERVICE_WORKER_RETRY_INTERVAL;
  sessionStorage.setItem(SERVICE_WORKER_CHECK_KEY, String(retryFrom));
}

function watchServiceWorkerInstallation(registration) {
  registration.addEventListener("updatefound", () => {
    const installingWorker = registration.installing;
    installingWorker?.addEventListener("statechange", () => {
      if (installingWorker.state === "redundant") scheduleServiceWorkerRetry();
    });
  });
}

function checkForServiceWorkerUpdate() {
  if (!serviceWorkerRegistration || document.visibilityState === "hidden" || !navigator.onLine) return;
  const now = Date.now();
  const lastCheck = Number(sessionStorage.getItem(SERVICE_WORKER_CHECK_KEY) || 0);
  if (serviceWorkerUpdatePromise || now - lastCheck < SERVICE_WORKER_CHECK_INTERVAL) {
    probeServiceWorkerVersion();
    return;
  }
  sessionStorage.setItem(SERVICE_WORKER_CHECK_KEY, String(now));
  serviceWorkerUpdatePromise = serviceWorkerRegistration.update()
    .then(() => probeServiceWorkerVersion())
    .catch(() => scheduleServiceWorkerRetry())
    .finally(() => { serviceWorkerUpdatePromise = null; });
}

function reloadForServiceWorkerUpdate() {
  if (!serviceWorkerReloadPending || isReloadingForServiceWorker || !state.identity || state.identityPromptOpen || state.editor || pendingMutations) return;
  isReloadingForServiceWorker = true;
  window.location.reload();
}

function dateInShanghai(value = new Date()) {
  const normalizedValue = typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(normalizedValue)).filter(({ type }) => type !== "literal").map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const today = () => dateInShanghai();
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const dateLabel = (date) => {
  if (!date) return "未安排";
  if (date === today()) return "今天";
  const [year, month, day] = date.split("-");
  return year === today().slice(0, 4) ? `${month}月${day}日` : `${year}年${month}月${day}日`;
};
const isOverdue = (task) => !task.completed && task.due_date && task.due_date < today();

function dueDistanceBadge(task) {
  if (task.completed || !task.due_date) return "";
  const millisecondsPerDay = 24 * 60 * 60 * 1_000;
  const distance = Math.round((Date.parse(`${task.due_date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / millisecondsPerDay);
  if (distance < 0) return `<span class="due-distance-badge is-overdue">超期 ${Math.abs(distance)} 天</span>`;
  if (distance === 0) return '<span class="due-distance-badge is-today">今天到期</span>';
  return `<span class="due-distance-badge is-upcoming">还剩 ${distance} 天</span>`;
}

function completedDate(task) {
  if (!task.completed || !task.completed_at) return "";
  return `<span class="completed-date"><i>✓</i>${dateLabel(dateInShanghai(task.completed_at))}完成</span>`;
}

function addDays(date, amount) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function shiftMonth(monthKey, amount) {
  const [year, month] = monthKey.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function datePicker() {
  if (!state.datePicker) return "";
  const monthKey = state.datePicker.month;
  const [year, month] = monthKey.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const selected = state.editor?.due_date || "";
  const dates = Array.from({ length: firstWeekday + daysInMonth }, (_, index) => {
    if (index < firstWeekday) return '<span class="calendar-day is-empty" aria-hidden="true"></span>';
    const day = index - firstWeekday + 1;
    const date = `${monthKey}-${String(day).padStart(2, "0")}`;
    const classes = ["calendar-day", date === selected ? "is-selected" : "", date === today() ? "is-today" : ""].filter(Boolean).join(" ");
    return `<button type="button" class="${classes}" data-action="pick-date" data-date="${date}">${day}</button>`;
  }).join("");
  return `<div class="date-picker-backdrop"><section class="date-picker-sheet" role="dialog" aria-modal="true" aria-label="选择计划完成日期"><div class="sheet-grabber"></div><div class="date-picker-head"><button type="button" data-action="close-date-picker">取消</button><strong>${year}年${month}月</strong><button type="button" data-action="clear-picker-date">不设置</button></div><div class="calendar-nav"><button type="button" data-action="previous-calendar-month" aria-label="上个月">‹</button><span>${year}年${month}月</span><button type="button" data-action="next-calendar-month" aria-label="下个月">›</button></div><div class="calendar-weekdays"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div><div class="calendar-grid">${dates}</div><div class="calendar-shortcuts"><button type="button" data-action="pick-date" data-date="${today()}">今天</button><button type="button" data-action="pick-date" data-date="${addDays(today(), 1)}">明天</button></div></section></div>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Identity-Code": state.identity, ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "操作未完成");
    error.status = response.status;
    error.identityStatus = payload.identityStatus || "";
    throw error;
  }
  return payload;
}

function showIdentityStatus(code, status, { blockCurrent = false } = {}) {
  if (blockCurrent) {
    localStorage.removeItem("todo-identity");
    state.identity = "";
    state.tasks = [];
  }
  state.identityDraft = code;
  state.identityStatus = status;
  state.identitySubmitting = false;
  state.identityPromptOpen = true;
  state.editor = null;
  state.datePicker = null;
  sessionStorage.setItem("todo-identity-draft", code);
  render();
}

function resetIdentityCandidate() {
  sessionStorage.removeItem("todo-identity-draft");
  state.identityDraft = "";
  state.identityStatus = "";
  state.identitySubmitting = false;
  render();
}

function closeIdentityPrompt() {
  if (!state.identity) return;
  sessionStorage.removeItem("todo-identity-draft");
  state.identityDraft = "";
  state.identityStatus = "";
  state.identitySubmitting = false;
  state.identityPromptOpen = false;
  render();
  reloadForServiceWorkerUpdate();
}

function openIdentityPrompt() {
  sessionStorage.removeItem("todo-identity-draft");
  state.identityDraft = "";
  state.identityStatus = "";
  state.identitySubmitting = false;
  state.identityPromptOpen = true;
  render();
}

function handleIdentityAccessError(error) {
  if (!error.identityStatus) return false;
  showIdentityStatus(state.identity || state.identityDraft, error.identityStatus, { blockCurrent: true });
  return true;
}

async function verifyIdentity(code) {
  const result = await api("/api/identity", { method: "POST", body: JSON.stringify({ code }) });
  if (result.status !== "enabled") {
    showIdentityStatus(code, result.status);
    return;
  }
  localStorage.setItem("todo-identity", code);
  sessionStorage.removeItem("todo-identity-draft");
  state.identityDraft = "";
  state.identityStatus = "";
  state.identity = code;
  state.identityPromptOpen = false;
  state.tasks = [];
  state.view = "todo";
  await loadTasks();
  reloadForServiceWorkerUpdate();
}

// Keep the interface responsive while preserving the order of database writes.
// A failed write reloads the authoritative server state instead of silently losing work.
function saveInBackground(operation) {
  pendingMutations += 1;
  const run = async () => {
    try {
      await operation();
    } catch (error) {
      if (handleIdentityAccessError(error)) return;
      alert(`${error.message}，已恢复服务器中的最新数据。`);
      await loadTasks({ quiet: true });
    } finally {
      pendingMutations -= 1;
      reloadForServiceWorkerUpdate();
    }
  };
  mutationChain = mutationChain.then(run, run);
  return mutationChain;
}

function resolvedTaskId(id) {
  return taskIdAliases.get(Number(id)) || Number(id);
}

function applyServerTask(task, localId = task.id, shouldRender = false) {
  if (Number(localId) < 0) taskIdAliases.set(Number(localId), task.id);
  const index = state.tasks.findIndex((item) => item.id === Number(localId) || item.id === task.id);
  if (index >= 0) state.tasks[index] = { ...state.tasks[index], ...task };
  if (shouldRender) render();
}

async function loadTasks({ quiet = false } = {}) {
  if (!state.identity) return render();
  if (taskSyncPromise) return taskSyncPromise;
  taskSyncPromise = (async () => {
    try {
      state.tasks = (await api("/api/tasks")).tasks;
      lastTaskSyncAt = Date.now();
    } catch (error) {
      if (!handleIdentityAccessError(error) && !quiet && !isReloadingForServiceWorker) alert(error.message);
    } finally {
      taskSyncPromise = null;
    }
    render();
  })();
  return taskSyncPromise;
}

function refreshActiveTasks(force = false) {
  if (!state.identity || state.identityPromptOpen || state.editor || pointerDrag || pendingMutations || document.visibilityState === "hidden") return;
  // pageshow、focus 与 visibilitychange 往往会连续触发；前台恢复只保留一次读取。
  const interval = force ? 1_500 : 30_000;
  if (Date.now() - lastTaskSyncAt > interval) loadTasks({ quiet: true });
}

function filteredTasks() {
  const tasks = state.tasks.filter((task) => state.view === "done" ? task.completed : !task.completed);
  return tasks
    .filter((task) => (state.tag === "全部" || task.tags.includes(state.tag)) && (state.color === "全部" || task.color === state.color))
    .sort(state.view === "done" ? compareCompletedTasks : compareTodoTasks);
}

function timestampValue(value) {
  if (!value) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return Date.parse(normalized) || 0;
}

function hasManualPosition(task) {
  return task.manual_position !== null
    && task.manual_position !== undefined
    && Number.isFinite(Number(task.manual_position));
}

function compareManualPosition(left, right) {
  const leftManual = hasManualPosition(left);
  const rightManual = hasManualPosition(right);
  if (leftManual !== rightManual) return leftManual ? -1 : 1;
  if (leftManual && rightManual) {
    const manualOrder = Number(left.manual_position) - Number(right.manual_position);
    if (manualOrder) return manualOrder;
  }
  return 0;
}

function comparePinnedAndManual(left, right) {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
  return compareManualPosition(left, right);
}

function compareTodoTasks(left, right) {
  const pinnedAndManualOrder = comparePinnedAndManual(left, right);
  if (pinnedAndManualOrder) return pinnedAndManualOrder;
  if (left.pinned && right.pinned) {
    const pinnedOrder = timestampValue(right.pinned_at) - timestampValue(left.pinned_at);
    if (pinnedOrder) return pinnedOrder;
  }
  if (Boolean(left.due_date) !== Boolean(right.due_date)) return left.due_date ? -1 : 1;
  if (left.due_date && right.due_date) {
    const dateOrder = left.due_date.localeCompare(right.due_date);
    if (dateOrder) return dateOrder;
  }
  const statusRank = { in_progress: 0, none: 1, paused: 2 };
  const statusOrder = (statusRank[left.status || "none"] ?? 1) - (statusRank[right.status || "none"] ?? 1);
  if (statusOrder) return statusOrder;
  const createdOrder = timestampValue(right.created_at) - timestampValue(left.created_at);
  if (createdOrder) return createdOrder;
  return Number(right.id) - Number(left.id);
}

function compareCompletedTasks(left, right) {
  const manualOrder = compareManualPosition(left, right);
  if (manualOrder) return manualOrder;
  const completedOrder = timestampValue(right.completed_at) - timestampValue(left.completed_at);
  if (completedOrder) return completedOrder;
  return Number(right.id) - Number(left.id);
}

function taskCard(task) {
  const overdue = isOverdue(task);
  const showPinned = task.pinned && !task.completed;
  const status = task.status || "none";
  const statusBadge = !task.completed && status !== "none"
    ? `<span class="status-badge ${status}">${status === "in_progress" ? "进行中" : "暂停"}</span>`
    : "";
  const distanceBadge = dueDistanceBadge(task);
  const completionDate = completedDate(task);
  const due = task.due_date ? `<span class="due"><i class="due-icon">◷</i><span class="due-label">${dateLabel(task.due_date)}</span></span>` : "";
  return `<article class="task-card color-${task.color} ${task.completed ? "is-completed" : ""} ${overdue ? "is-overdue" : ""} ${showPinned ? "is-pinned" : ""}" data-task-id="${task.id}">
    <button class="drag-handle" data-action="drag" data-id="${task.id}" aria-label="拖动调整顺序">⠿</button>
    <button class="check-button" data-action="toggle" data-id="${task.id}" aria-label="切换完成状态">${task.completed ? "✓" : ""}</button>
    <div class="task-body"><h3>${escapeHtml(task.title)}</h3><div class="task-meta">
      ${task.details ? `<p class="task-details">${escapeHtml(task.details)}</p>` : ""}${completionDate}${distanceBadge}${statusBadge}${due}
      ${task.tags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join("")}
    </div></div><i class="task-color-dot ${showPinned ? "is-star" : ""}" ${showPinned ? 'aria-label="已置顶"' : ""}>${showPinned ? "★" : ""}</i>
  </article>`;
}

function taskLists(tasks) {
  const pageTasks = state.tasks.filter((task) => state.view === "done" ? task.completed : !task.completed);
  const hasPinnedZone = state.view === "todo" && pageTasks.some((task) => task.pinned);
  const emptyMessage = state.view === "done" ? "还没有已完成的事项。" : "这里还没有待办事项，点击 + 添加第一项吧。";
  const regularTasks = state.view === "done" ? tasks : tasks.filter((task) => !task.pinned);
  const regularTitle = state.view === "done" ? "已完成事项" : "待办事项";
  const regularIcon = state.view === "done" ? "✓" : "☐";
  const regularZone = (hasPinnedClass = "") => `<section class="regular-zone ${hasPinnedClass}">
    <header class="task-zone-title regular-zone-title"><span><i>${regularIcon}</i>${regularTitle}</span><b>${regularTasks.length}</b></header>
    <section class="task-list regular-task-list" data-task-zone="regular">${regularTasks.map((task) => taskCard(task)).join("") || `<p class="${hasPinnedZone ? "drop-hint" : "empty-state"}">${hasPinnedZone ? "拖到这里取消置顶" : emptyMessage}</p>`}</section>
  </section>`;
  if (!hasPinnedZone) {
    const temporaryPinnedZone = state.view === "todo" && tasks.length
      ? `<section class="pinned-zone is-empty-pinned-zone" data-pinned-zone aria-hidden="true">
        <section class="task-list pinned-task-list" data-task-zone="pinned"></section>
        <div class="temporary-pin-divider"><span>★ 置顶</span></div>
      </section>`
      : "";
    return `${temporaryPinnedZone}${regularZone()}`;
  }

  const pinnedTasks = tasks.filter((task) => task.pinned);
  return `<section class="pinned-zone" data-pinned-zone>
    <header class="task-zone-title pinned-zone-title"><span><i>★</i>置顶事项</span><b>${pinnedTasks.length}</b></header>
    <section class="task-list pinned-task-list" data-task-zone="pinned">${pinnedTasks.map((task) => taskCard(task)).join("") || '<p class="drop-hint">拖到这里置顶</p>'}</section>
  </section>
  ${regularZone("has-pinned-zone")}`;
}

function filters() {
  const tags = ["全部", ...[...new Set(state.tasks.flatMap((task) => task.tags))].sort((a, b) => a.localeCompare(b, "zh-CN"))];
  const summary = [state.tag, state.color === "全部" ? "" : COLOR_NAMES[state.color]].filter((item) => item && item !== "全部").join(" · ") || `全部${state.view === "done" ? "已办" : "待办"}`;
  return `<section class="filter-panel ${state.filtersOpen ? "is-open" : ""}"><button class="filter-toggle" data-action="toggle-filters" aria-expanded="${state.filtersOpen}"><span class="filter-toggle-title">筛选</span><span class="filter-toggle-summary">${summary}</span><i>⌄</i></button>${state.filtersOpen ? `<div class="filter-panel-content"><div class="filter-group"><p>按标签</p><div class="filters">${tags.map((tag) => `<button data-action="tag-filter" data-tag="${escapeHtml(tag)}" class="${state.tag === tag ? "filter-active" : ""}">${escapeHtml(tag)}</button>`).join("")}</div></div>
  <div class="filter-group"><p>按颜色</p><div class="color-filters"><button data-action="color-filter" data-color="全部" class="${state.color === "全部" ? "filter-active" : ""}">全部</button>${COLORS.map((color) => `<button data-action="color-filter" data-color="${color}" class="color-filter ${color} ${state.color === color ? "filter-active" : ""}"><i></i>${COLOR_NAMES[color]}</button>`).join("")}</div></div>
  <p class="filter-result">找到 ${filteredTasks().length} 项符合条件的事项</p></div>` : ""}</section>`;
}

function tagsEditor() {
  return `<div class="composer-row tag-editor"><span>标签</span><div class="tag-input-wrap">${state.draftTags.map((tag) => `<button type="button" class="draft-tag" data-action="remove-tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} <i>×</i></button>`).join("")}<input id="tag-input" value="${escapeHtml(state.tagInput)}" placeholder="${state.draftTags.length ? "继续输入" : "输入后按回车"}" aria-label="输入标签后按回车确认" /></div></div>`;
}

function statusEditor(task) {
  const status = task.status || "none";
  const options = [
    ["none", "默认"],
    ["in_progress", "▶ 进行中"],
    ["paused", "Ⅱ 暂停"],
  ];
  return `<div class="composer-row status-editor"><span>任务状态</span><div class="status-options">${options.map(([value, label]) => `<button type="button" class="status-option status-${value} ${status === value ? "selected" : ""}" data-action="pick-task-status" data-status="${value}">${label}</button>`).join("")}</div></div>`;
}

function pinEditor(task) {
  return `<div class="composer-row pin-editor"><span><b>置顶任务</b><small>也可在列表中拖入或拖出置顶区</small></span><button type="button" class="pin-toggle ${task.pinned ? "is-active" : ""}" data-action="toggle-pin" aria-pressed="${Boolean(task.pinned)}"><i>${task.pinned ? "★" : "☆"}</i>${task.pinned ? "已置顶" : "置顶"}</button></div>`;
}

function editor() {
  if (!state.editor) return "";
  const task = state.editor;
  const dueDateControl = task.due_date
    ? `<button type="button" class="due-date-value" data-action="open-date-picker"><i>◷</i>${dateLabel(task.due_date)}</button><button type="button" class="clear-date-button" data-action="clear-due-date">清除</button>`
    : '<button type="button" class="set-date-button" data-action="open-date-picker">设置日期</button>';
  return `<div class="modal-backdrop"><form class="composer" id="task-form"><div class="sheet-grabber"></div><div class="composer-head"><h2>${task.id ? "编辑事项" : "新建事项"}</h2><button type="button" data-action="close-editor">取消</button></div>
    <input id="task-title" value="${escapeHtml(task.title)}" placeholder="想完成什么？" autofocus required maxlength="200" />
    <textarea id="task-details" placeholder="补充任务详情（可选）" maxlength="2000">${escapeHtml(task.details || "")}</textarea>
    <div class="composer-row"><span>颜色标签</span><div class="color-options">${COLORS.map((color) => `<button type="button" class="color-picker ${color} ${task.color === color ? "selected" : ""}" data-action="pick-color" data-color="${color}">${task.color === color ? "✓" : ""}</button>`).join("")}</div></div>
    ${task.completed ? "" : statusEditor(task)}${pinEditor(task)}${tagsEditor()}<div class="composer-row due-date-row"><span>计划完成</span><div class="due-date-control">${dueDateControl}</div></div>
    ${task.id ? '<button type="button" class="delete-button" data-action="delete-task">删除事项</button>' : ""}<button class="save-button" type="submit">${task.id ? "保存修改" : "添加事项"}</button>
  </form></div>`;
}

function identityGate() {
  if (!state.identityPromptOpen) return "";
  const submitting = state.identitySubmitting;
  const closeButton = state.identity ? `<button class="identity-close-button" type="button" data-action="close-identity" aria-label="关闭身份码窗口" ${submitting ? "disabled" : ""}>×</button>` : "";
  if (state.identityStatus) {
    const pending = state.identityStatus === "pending";
    return `<div class="identity-gate"><section class="identity-card identity-status-card">${closeButton}<div class="identity-symbol"><img src="/rabbittodo-icon.png" alt="RabbitToDo 兔子图标" /></div><p>RabbitToDo</p><h2>${pending ? "请等待管理员审核确认" : "该身份码暂不可用"}</h2><strong class="identity-code-preview">${escapeHtml(state.identityDraft)}</strong><span>${pending ? "审核通过后即可使用。你可以稍后重新检查状态。" : "该身份码已禁用或审核未通过，请联系管理员。"}</span><button class="save-button" type="button" data-action="recheck-identity">重新检查状态</button><button class="identity-secondary-button" type="button" data-action="reset-identity">更换身份码</button></section></div>`;
  }
  return `<div class="identity-gate"><form class="identity-card ${submitting ? "is-submitting" : ""}" id="identity-form">${closeButton}<div class="identity-symbol"><img src="/rabbittodo-icon.png" alt="RabbitToDo 兔子图标" /></div><p>RabbitToDo</p><h2>今天，慢一点也没关系</h2><span>输入 6 位身份码，在本设备隔离你的待办数据。</span><input id="identity-code" value="${escapeHtml(state.identityDraft)}" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="6 位身份码" required ${submitting ? "disabled" : ""} /><button class="save-button identity-submit-button" type="submit" aria-busy="${submitting}" ${submitting ? "disabled" : ""}>${submitting ? '<i class="identity-submit-spinner"></i><span>正在进入</span>' : "开始记录"}</button></form></div>`;
}

function pageHeader(heading) {
  return `<header class="topbar"><div><p class="eyebrow"><b class="brand-inline">RabbitToDo</b>　${new Intl.DateTimeFormat("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, month: "long", day: "numeric", weekday: "short" }).format(new Date())}</p><h1>${heading}</h1></div><button class="avatar" data-action="profile" aria-label="查看我的身份码"><i class="avatar-icon"><img src="/rabbittodo-icon.png" alt="" /></i><span>${state.identity || "······"}</span></button></header>`;
}

function profilePage() {
  return `<section class="profile-page">${pageHeader("我的")}<section class="profile-card"><div class="profile-icon"><img src="/rabbittodo-icon.png" alt="RabbitToDo" /></div><p>我的身份码</p><strong>${state.identity.slice(0, 3)} ${state.identity.slice(3)}</strong><span>此代码仅用于隔离你的待办数据。</span><button data-action="switch-identity">切换身份码</button></section><p class="version-label">版本 ${APP_VERSION}</p></section>`;
}

function render() {
  persistentAvatar = app.querySelector(".avatar") || persistentAvatar;
  persistentProfileIcon = app.querySelector(".profile-icon") || persistentProfileIcon;
  persistentIdentitySymbol = app.querySelector(".identity-symbol") || persistentIdentitySymbol;
  const tasks = filteredTasks();
  const taskContent = taskLists(tasks);
  const heading = { todo: "待办", done: "已办", profile: "我的" }[state.view];
  const overviewContent = `${pageHeader(heading)}${filters()}`;
  const pageContent = state.view === "profile"
    ? profilePage()
    : `<section class="workspace workspace-${state.view}"><aside class="workspace-overview">${overviewContent}</aside><main class="workspace-tasks">${taskContent}</main></section>`;
  app.innerHTML = `<section class="phone"><div class="content-scroll">${pageContent}</div>
    ${state.view !== "profile" ? '<button class="add-button" data-action="add" aria-label="添加事项">+</button>' : ""}<nav class="tabbar tabbar-two"><button data-action="view" data-view="todo" class="${state.view === "todo" ? "active" : ""}"><span>☐</span>待办</button><button data-action="view" data-view="done" class="${state.view === "done" ? "active" : ""}"><span>✓</span>已办</button></nav></section>${editor()}${datePicker()}${identityGate()}`;
  const nextAvatar = app.querySelector(".avatar");
  if (persistentAvatar && nextAvatar && persistentAvatar !== nextAvatar) {
    persistentAvatar.querySelector("span").textContent = nextAvatar.querySelector("span").textContent;
    nextAvatar.replaceWith(persistentAvatar);
  } else if (nextAvatar) persistentAvatar = nextAvatar;
  const nextProfileIcon = app.querySelector(".profile-icon");
  if (persistentProfileIcon && nextProfileIcon && persistentProfileIcon !== nextProfileIcon) nextProfileIcon.replaceWith(persistentProfileIcon);
  else if (nextProfileIcon) persistentProfileIcon = nextProfileIcon;
  const nextIdentitySymbol = app.querySelector(".identity-symbol");
  if (persistentIdentitySymbol && nextIdentitySymbol && persistentIdentitySymbol !== nextIdentitySymbol) nextIdentitySymbol.replaceWith(persistentIdentitySymbol);
  else if (nextIdentitySymbol) persistentIdentitySymbol = nextIdentitySymbol;
}

function openEditor(task = { title: "", details: "", color: "violet", status: "none", tags: [], due_date: "", pinned: false, pinned_at: null }) { state.editor = { ...task, status: task.status || "none", pinned: Boolean(task.pinned) }; state.datePicker = null; state.draftTags = [...task.tags]; state.tagInput = ""; render(); }
function commitTag() { const tag = state.tagInput.trim().replace(/^#/, ""); if (tag && !state.draftTags.includes(tag)) state.draftTags.push(tag); state.tagInput = ""; render(); document.querySelector("#tag-input")?.focus(); }

function dragTargetList(pointerY) {
  const pinnedList = app.querySelector('[data-task-zone="pinned"]');
  const regularList = app.querySelector('[data-task-zone="regular"]');
  if (!pinnedList) return regularList;
  if (!regularList) return pinnedList;
  const pinnedZone = pinnedList.closest(".pinned-zone");
  const pinnedRect = pinnedZone.getBoundingClientRect();
  const regularRect = regularList.getBoundingClientRect();
  if (pinnedZone.classList.contains("is-empty-pinned-zone")) {
    const dividerRect = pinnedZone.querySelector(".temporary-pin-divider").getBoundingClientRect();
    return pointerY < dividerRect.top + dividerRect.height / 2 ? pinnedList : regularList;
  }
  const boundary = (pinnedRect.bottom + regularRect.top) / 2;
  return pointerY < boundary ? pinnedList : regularList;
}

function animateTaskReflow(previousRects) {
  app.querySelectorAll(".task-card:not(.is-drag-placeholder)").forEach((card) => {
    const previous = previousRects.get(card);
    if (!previous) return;
    const next = card.getBoundingClientRect();
    const deltaX = previous.left - next.left;
    const deltaY = previous.top - next.top;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
    card.animate(
      [{ transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
      { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  });
}

function reorderDraggedCard(pointerY) {
  if (!pointerDrag?.started) return;
  const targetList = dragTargetList(pointerY);
  if (!targetList) return;
  const previousRects = new Map(
    [...app.querySelectorAll(".task-card:not(.is-drag-placeholder)")].map((card) => [card, card.getBoundingClientRect()]),
  );
  const candidates = [...targetList.querySelectorAll(".task-card:not(.is-drag-placeholder)")];
  const beforeCard = candidates.find((card) => pointerY < card.getBoundingClientRect().top + card.offsetHeight / 2);
  if (beforeCard) targetList.insertBefore(pointerDrag.card, beforeCard);
  else targetList.append(pointerDrag.card);
  app.querySelectorAll("[data-task-zone]").forEach((list) => list.classList.toggle("is-drop-target", list === targetList));
  animateTaskReflow(previousRects);
}

function updateDragGhost(pointerX, pointerY) {
  if (!pointerDrag?.ghost) return;
  pointerDrag.ghost.style.transform = `translate3d(${pointerX - pointerDrag.offsetX}px, ${pointerY - pointerDrag.offsetY}px, 0) rotate(.35deg) scale(1.015)`;
}

function autoScrollDuringDrag(pointerY) {
  const scroller = app.querySelector(".content-scroll");
  if (!scroller) return;
  const rect = scroller.getBoundingClientRect();
  const edge = Math.min(76, rect.height * .16);
  dragAutoScrollSpeed = 0;
  if (pointerY < rect.top + edge) dragAutoScrollSpeed = -Math.ceil((rect.top + edge - pointerY) / edge * 14);
  else if (pointerY > rect.bottom - edge) dragAutoScrollSpeed = Math.ceil((pointerY - (rect.bottom - edge)) / edge * 14);
  if (dragAutoScrollSpeed && !dragAutoScrollFrame) {
    const scrollFrame = () => {
      dragAutoScrollFrame = 0;
      if (!pointerDrag?.started || !dragAutoScrollSpeed) return;
      scroller.scrollTop += dragAutoScrollSpeed;
      reorderDraggedCard(pointerDrag.lastY);
      dragAutoScrollFrame = requestAnimationFrame(scrollFrame);
    };
    dragAutoScrollFrame = requestAnimationFrame(scrollFrame);
  }
}

function startPointerDrag(event) {
  if (!pointerDrag || pointerDrag.started) return;
  const rect = pointerDrag.card.getBoundingClientRect();
  const ghost = pointerDrag.card.cloneNode(true);
  ghost.classList.add("task-drag-ghost");
  ghost.removeAttribute("data-task-id");
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.append(ghost);
  pointerDrag.started = true;
  pointerDrag.ghost = ghost;
  pointerDrag.lastY = event.clientY;
  pointerDrag.offsetX = pointerDrag.startX - rect.left;
  pointerDrag.offsetY = pointerDrag.startY - rect.top;
  pointerDrag.card.classList.add("is-drag-placeholder");
  document.body.classList.add("is-task-dragging");
  app.querySelector(".workspace-tasks")?.classList.add("is-drag-active");
  updateDragGhost(event.clientX, event.clientY);
  reorderDraggedCard(event.clientY);
}

function pageTasksInDisplayOrder() {
  const comparator = state.view === "done" ? compareCompletedTasks : compareTodoTasks;
  return state.tasks
    .filter((task) => state.view === "done" ? task.completed : !task.completed)
    .slice()
    .sort(comparator);
}

function visibleDragLayout() {
  return {
    pinned: [...app.querySelectorAll('[data-task-zone="pinned"] .task-card')].map((card) => Number(card.dataset.taskId)),
    regular: [...app.querySelectorAll('[data-task-zone="regular"] .task-card')].map((card) => Number(card.dataset.taskId)),
  };
}

function dragLayoutChanged(initial, current) {
  if (!initial) return true;
  return initial.pinned.join(",") !== current.pinned.join(",")
    || initial.regular.join(",") !== current.regular.join(",");
}

function persistDraggedOrder() {
  const { pinned: pinnedIds, regular: regularIds } = visibleDragLayout();
  const visibleIds = [...pinnedIds, ...regularIds];
  if (!visibleIds.length) return;

  const baseline = pageTasksInDisplayOrder();
  const visibleSet = new Set(visibleIds);
  const tasksById = new Map(baseline.map((task) => [Number(task.id), task]));
  let visibleIndex = 0;
  const merged = baseline.map((task) => visibleSet.has(Number(task.id))
    ? tasksById.get(visibleIds[visibleIndex++])
    : task);
  const pinnedSet = new Set(pinnedIds);
  const now = new Date().toISOString();
  merged.forEach((task, index) => {
    if (state.view === "todo" && visibleSet.has(Number(task.id))) {
      const shouldPin = pinnedSet.has(Number(task.id));
      if (shouldPin && !task.pinned) task.pinned_at = now;
      if (!shouldPin) task.pinned_at = null;
      task.pinned = shouldPin;
    }
    task.manual_position = index + 1;
  });

  const payload = {
    ids: merged.map((task) => resolvedTaskId(task.id)),
    pinnedIds: merged.filter((task) => task.pinned).map((task) => resolvedTaskId(task.id)),
    completed: state.view === "done",
  };
  render();
  saveInBackground(() => api("/api/tasks/reorder", { method: "POST", body: JSON.stringify(payload) }));
}

function finishPointerDrag(cancelled = false) {
  if (!pointerDrag) return;
  const drag = pointerDrag;
  const finalLayout = drag.started ? visibleDragLayout() : null;
  const changed = drag.started && dragLayoutChanged(drag.initialLayout, finalLayout);
  pointerDrag = null;
  dragAutoScrollSpeed = 0;
  if (dragAutoScrollFrame) cancelAnimationFrame(dragAutoScrollFrame);
  dragAutoScrollFrame = 0;
  if (drag.started) {
    suppressCardClickUntil = Date.now() + 300;
    drag.ghost?.remove();
    drag.card.classList.remove("is-drag-placeholder");
    document.body.classList.remove("is-task-dragging");
    app.querySelector(".workspace-tasks")?.classList.remove("is-drag-active");
    app.querySelectorAll("[data-task-zone]").forEach((list) => list.classList.remove("is-drop-target"));
    if (cancelled) render();
    else if (changed) persistDraggedOrder();
  }
}

app.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest('[data-action="drag"]');
  if (!handle || event.button !== 0 || pendingMutations || state.editor) return;
  const card = handle.closest(".task-card");
  if (!card || Number(card.dataset.taskId) < 0) return;
  pointerDrag = {
    pointerId: event.pointerId,
    card,
    handle,
    startX: event.clientX,
    startY: event.clientY,
    initialLayout: visibleDragLayout(),
    started: false,
    ghost: null,
  };
  handle.setPointerCapture?.(event.pointerId);
});

window.addEventListener("pointermove", (event) => {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
  const distance = Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY);
  if (!pointerDrag.started && distance < 4) return;
  event.preventDefault();
  startPointerDrag(event);
  pointerDrag.lastY = event.clientY;
  updateDragGhost(event.clientX, event.clientY);
  autoScrollDuringDrag(event.clientY);
  reorderDraggedCard(event.clientY);
}, { passive: false });

window.addEventListener("pointerup", (event) => {
  if (pointerDrag && event.pointerId === pointerDrag.pointerId) finishPointerDrag(false);
});
window.addEventListener("pointercancel", (event) => {
  if (pointerDrag && event.pointerId === pointerDrag.pointerId) finishPointerDrag(true);
});

app.addEventListener("click", async (event) => {
  if (Date.now() < suppressCardClickUntil) return;
  const button = event.target.closest("[data-action]");
  if (button) {
    const action = button.dataset.action;
    if (action === "add") return openEditor();
    if (action === "close-editor") {
      state.editor = null;
      state.datePicker = null;
      render();
      reloadForServiceWorkerUpdate();
      return;
    }
    if (action === "view") { state.view = button.dataset.view; return render(); }
    if (action === "profile") { state.view = "profile"; return render(); }
    if (action === "toggle-filters") { state.filtersOpen = !state.filtersOpen; return render(); }
    if (action === "tag-filter") { state.tag = button.dataset.tag; return render(); }
    if (action === "color-filter") { state.color = button.dataset.color; return render(); }
    if (action === "pick-color") { state.editor.color = button.dataset.color; return render(); }
    if (action === "pick-task-status") { state.editor.status = button.dataset.status; return render(); }
    if (action === "toggle-pin") { state.editor.pinned = !state.editor.pinned; return render(); }
    if (action === "open-date-picker") { state.datePicker = { month: (state.editor.due_date || today()).slice(0, 7) }; return render(); }
    if (action === "close-date-picker") { state.datePicker = null; return render(); }
    if (action === "previous-calendar-month") { state.datePicker.month = shiftMonth(state.datePicker.month, -1); return render(); }
    if (action === "next-calendar-month") { state.datePicker.month = shiftMonth(state.datePicker.month, 1); return render(); }
    if (action === "pick-date") { state.editor.due_date = button.dataset.date; state.datePicker = null; return render(); }
    if (action === "clear-picker-date" || action === "clear-due-date") { state.editor.due_date = ""; state.datePicker = null; return render(); }
    if (action === "remove-tag") { state.draftTags = state.draftTags.filter((tag) => tag !== button.dataset.tag); return render(); }
    if (action === "switch-identity") return openIdentityPrompt();
    if (action === "reset-identity") return resetIdentityCandidate();
    if (action === "close-identity") return closeIdentityPrompt();
    if (action === "recheck-identity") {
      try { await verifyIdentity(state.identityDraft); } catch (error) { alert(error.message); }
      return;
    }
    if (action === "toggle") {
      const id = Number(button.dataset.id);
      const task = state.tasks.find((item) => item.id === id);
      if (!task) return;
      const completed = !task.completed;
      task.completed = completed;
      task.completed_at = completed ? new Date().toISOString() : null;
      task.manual_position = null;
      if (completed) task.status = "none";
      render();
      saveInBackground(async () => {
        const response = await api(`/api/tasks/${resolvedTaskId(id)}`, { method: "PATCH", body: JSON.stringify({ completed }) });
        applyServerTask(response.task, id);
      });
      return;
    }
    if (action === "delete-task") {
      if (!confirm("删除这项待办？")) return;
      const id = Number(state.editor.id);
      state.tasks = state.tasks.filter((task) => task.id !== id);
      state.editor = null;
      render();
      saveInBackground(() => api(`/api/tasks/${resolvedTaskId(id)}`, { method: "DELETE" }));
      return;
    }
    return;
  }
  const card = event.target.closest("[data-task-id]");
  if (card) openEditor(state.tasks.find((task) => task.id === Number(card.dataset.taskId)));
});

app.addEventListener("keydown", (event) => {
  if (event.target.id !== "tag-input") return;
  if (event.key === "Enter") { event.preventDefault(); commitTag(); }
  if (event.key === "Backspace" && !event.target.value && state.draftTags.length) { state.draftTags.pop(); render(); document.querySelector("#tag-input")?.focus(); }
});
app.addEventListener("input", (event) => {
  if (event.target.id === "identity-code") {
    state.identityDraft = event.target.value;
    sessionStorage.setItem("todo-identity-draft", state.identityDraft);
  }
  if (event.target.id === "tag-input") state.tagInput = event.target.value;
  if (event.target.id === "task-title" && state.editor) state.editor.title = event.target.value;
  if (event.target.id === "task-details" && state.editor) state.editor.details = event.target.value;
});
app.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (event.target.id === "identity-form") {
      if (state.identitySubmitting) return;
      const code = document.querySelector("#identity-code").value;
      state.identityDraft = code;
      state.identitySubmitting = true;
      render();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      try {
        await verifyIdentity(code);
      } finally {
        if (state.identitySubmitting) {
          state.identitySubmitting = false;
          if (state.identityPromptOpen) render();
        }
      }
      return;
    }
    if (event.target.id === "task-form") {
      const title = document.querySelector("#task-title").value;
      const details = document.querySelector("#task-details").value;
      const dueDate = state.editor.due_date || null;
      const tag = state.tagInput.trim().replace(/^#/, "");
      const tags = tag && !state.draftTags.includes(tag) ? [...state.draftTags, tag] : state.draftTags;
      const payload = { title, details, color: state.editor.color, status: state.editor.status || "none", tags, dueDate, pinned: Boolean(state.editor.pinned) };
      const editingId = Number(state.editor.id || 0);
      if (editingId) {
        const localTask = state.tasks.find((task) => task.id === editingId);
        if (localTask) {
          const pinnedAt = payload.pinned ? (localTask.pinned ? localTask.pinned_at : new Date().toISOString()) : null;
          Object.assign(localTask, { title, details, color: payload.color, status: payload.status, tags, due_date: dueDate, pinned: payload.pinned, pinned_at: pinnedAt });
        }
        state.editor = null;
        render();
        saveInBackground(async () => {
          const response = await api(`/api/tasks/${resolvedTaskId(editingId)}`, { method: "PUT", body: JSON.stringify(payload) });
          applyServerTask(response.task, editingId);
        });
      } else {
        const temporaryId = nextTemporaryTaskId--;
        const pinnedAt = payload.pinned ? new Date().toISOString() : null;
        state.tasks.unshift({
          id: temporaryId, identity_code: state.identity, title, details, color: payload.color, tags,
          due_date: dueDate, completed: false, completed_at: null, status: payload.status, pinned: payload.pinned, pinned_at: pinnedAt,
          manual_position: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        state.editor = null;
        state.view = "todo";
        render();
        saveInBackground(async () => {
          const response = await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
          applyServerTask(response.task, temporaryId, true);
        });
      }
      return;
    }
  } catch (error) { alert(error.message); }
});

// Installed PWAs are often resumed from a frozen page instead of reloaded.
// Refresh on every foreground return and poll gently while the app stays open.
window.addEventListener("pageshow", () => {
  refreshActiveTasks(true);
  checkForServiceWorkerUpdate();
});
window.addEventListener("focus", () => {
  refreshActiveTasks(true);
  checkForServiceWorkerUpdate();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshActiveTasks(true);
    checkForServiceWorkerUpdate();
  }
});
setInterval(() => refreshActiveTasks(), 30_000);

if ("serviceWorker" in navigator) {
  // 旧版本使用 sessionStorage 防重载；移除遗留标记，让之后的每次版本升级都能正常生效。
  sessionStorage.removeItem("rabbittodo-sw-reloaded");
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "RABBITTODO_SW_VERSION") handleServiceWorkerVersion(event.data.version);
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => probeServiceWorkerVersion());
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((registration) => {
    serviceWorkerRegistration = registration;
    watchServiceWorkerInstallation(registration);
    checkForServiceWorkerUpdate();
    probeServiceWorkerVersion();
  }).catch(() => undefined);
}
// 首次进入与 Service Worker 切换期间的同步均为后台行为，不弹出瞬时网络中断提示。
loadTasks({ quiet: true });
