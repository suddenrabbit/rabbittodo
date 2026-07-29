const COLORS = ["violet", "mint", "orange", "blue", "rose"];
const COLOR_NAMES = { violet: "葡萄紫", mint: "薄荷绿", orange: "日落橙", blue: "海盐蓝", rose: "莓果粉" };
const app = document.querySelector("#app");
const preventPageZoom = (event) => {
  if (event.type.startsWith("gesture") || event.touches?.length > 1) event.preventDefault();
};
document.addEventListener("gesturestart", preventPageZoom, { passive: false });
document.addEventListener("gesturechange", preventPageZoom, { passive: false });
document.addEventListener("touchmove", preventPageZoom, { passive: false });
let pointerDrag = null;
let suppressCardClickUntil = 0;
let taskSyncPromise = null;
let lastTaskSyncAt = 0;
let mutationChain = Promise.resolve();
let pendingMutations = 0;
let nextTemporaryTaskId = -1;
const taskIdAliases = new Map();

const state = {
  identity: localStorage.getItem("todo-identity") || "",
  tasks: [], view: "today", tag: "全部", color: "全部", status: "all", filtersOpen: false, editor: null, draftTags: [], tagInput: "", dragId: null,
};

const today = () => new Date().toISOString().slice(0, 10);
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const dateLabel = (date) => date === today() ? "今天" : date ? date.slice(5).replace("-", "月") + "日" : "未安排";
const isOverdue = (task) => !task.completed && task.due_date && task.due_date < today();
const oldCompleted = (task) => task.completed && task.completed_at && task.completed_at.slice(0, 10) !== today();

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Identity-Code": state.identity, ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "操作未完成");
  return payload;
}

// Keep the interface responsive while preserving the order of database writes.
// A failed write reloads the authoritative server state instead of silently losing work.
function saveInBackground(operation) {
  pendingMutations += 1;
  const run = async () => {
    try {
      await operation();
    } catch (error) {
      alert(`${error.message}，已恢复服务器中的最新数据。`);
      await loadTasks({ quiet: true });
    } finally {
      pendingMutations -= 1;
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
      if (!quiet) alert(error.message);
    } finally {
      taskSyncPromise = null;
    }
    render();
  })();
  return taskSyncPromise;
}

function refreshActiveTasks(force = false) {
  if (!state.identity || state.editor || pointerDrag || pendingMutations || document.visibilityState === "hidden") return;
  // pageshow、focus 与 visibilitychange 往往会连续触发；前台恢复只保留一次读取。
  const interval = force ? 1_500 : 30_000;
  if (Date.now() - lastTaskSyncAt > interval) loadTasks({ quiet: true });
}

function filteredTasks() {
  let tasks = state.tasks;
  if (state.view === "today") tasks = tasks.filter((task) => !oldCompleted(task) && (!task.due_date || task.due_date <= today() || task.completed));
  if (state.status === "open") tasks = tasks.filter((task) => !task.completed);
  if (state.status === "done") tasks = tasks.filter((task) => task.completed);
  return tasks.filter((task) => (state.tag === "全部" || task.tags.includes(state.tag)) && (state.color === "全部" || task.color === state.color));
}

function taskCard(task, { sortable = !task.completed } = {}) {
  const overdue = isOverdue(task);
  const status = task.status || "none";
  const statusBadge = !task.completed && status !== "none"
    ? `<span class="status-badge ${status}">${status === "in_progress" ? "进行中" : "暂停"}</span>`
    : "";
  return `<article class="task-card color-${task.color} ${task.completed ? "is-completed" : ""} ${overdue ? "is-overdue" : ""}" data-task-id="${task.id}">
    ${sortable ? `<button class="drag-handle" data-action="drag" data-id="${task.id}" aria-label="拖动排序">⠿</button>` : '<span class="drag-spacer" aria-hidden="true"></span>'}
    <button class="check-button" data-action="toggle" data-id="${task.id}" aria-label="切换完成状态">${task.completed ? "✓" : ""}</button>
    <div class="task-body"><h3>${escapeHtml(task.title)}</h3><div class="task-meta">
      ${task.details ? `<p class="task-details">${escapeHtml(task.details)}</p>` : ""}${overdue ? '<span class="overdue-badge">超期</span>' : ""}${statusBadge}<span class="due"><i class="due-icon">◷</i>${dateLabel(task.due_date)}</span>
      ${task.tags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join("")}
    </div></div><i class="task-color-dot"></i>
  </article>`;
}

function progress() {
  const todayTasks = state.tasks.filter((task) => !oldCompleted(task) && (!task.due_date || task.due_date <= today() || task.completed));
  const done = todayTasks.filter((task) => task.completed).length;
  const percent = todayTasks.length ? Math.round(done / todayTasks.length * 100) : 0;
  const allDone = state.tasks.filter((task) => task.completed).length;
  return `<section class="progress-card"><div class="progress-copy"><span>今日事项</span><strong>${done}<small> / ${todayTasks.length}</small></strong><p>已完成</p></div>
    <div class="progress-ring" style="--progress:${percent}%"><div><b>${percent}</b><span>%</span></div></div><div class="total-count">总事项 <b>${allDone}</b> / ${state.tasks.length}</div></section>`;
}

function filters() {
  const tags = ["全部", ...[...new Set(state.tasks.flatMap((task) => task.tags))].sort((a, b) => a.localeCompare(b, "zh-CN"))];
  const statusLabel = { all: "全部", open: "未完成", done: "已完成" }[state.status];
  const summary = [statusLabel, state.tag, state.color === "全部" ? "" : COLOR_NAMES[state.color]].filter((item) => item && item !== "全部").join(" · ") || "全部事项";
  return `<section class="filter-panel ${state.filtersOpen ? "is-open" : ""}"><button class="filter-toggle" data-action="toggle-filters" aria-expanded="${state.filtersOpen}"><span class="filter-toggle-title">筛选</span><span class="filter-toggle-summary">${summary}</span><i>⌄</i></button>${state.filtersOpen ? `<div class="filter-panel-content"><div class="filter-group"><p>完成状态</p><div class="filters">${[["all", "全部"], ["open", "未完成"], ["done", "已完成"]].map(([value, label]) => `<button data-action="status-filter" data-status="${value}" class="${state.status === value ? "filter-active" : ""}">${label}</button>`).join("")}</div></div>
  <div class="filter-group"><p>按标签</p><div class="filters">${tags.map((tag) => `<button data-action="tag-filter" data-tag="${escapeHtml(tag)}" class="${state.tag === tag ? "filter-active" : ""}">${escapeHtml(tag)}</button>`).join("")}</div></div>
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

function editor() {
  if (!state.editor) return "";
  const task = state.editor;
  return `<div class="modal-backdrop"><form class="composer" id="task-form"><div class="sheet-grabber"></div><div class="composer-head"><h2>${task.id ? "编辑事项" : "新建事项"}</h2><button type="button" data-action="close-editor">取消</button></div>
    <input id="task-title" value="${escapeHtml(task.title)}" placeholder="想完成什么？" autofocus required maxlength="200" />
    <textarea id="task-details" placeholder="补充任务详情（可选）" maxlength="2000">${escapeHtml(task.details || "")}</textarea>
    <div class="composer-row"><span>颜色标签</span><div class="color-options">${COLORS.map((color) => `<button type="button" class="color-picker ${color} ${task.color === color ? "selected" : ""}" data-action="pick-color" data-color="${color}">${task.color === color ? "✓" : ""}</button>`).join("")}</div></div>
    ${task.completed ? "" : statusEditor(task)}${tagsEditor()}<label class="composer-row"><span>计划完成</span><input id="task-date" type="date" value="${task.due_date || ""}" /></label>
    ${task.id ? '<button type="button" class="delete-button" data-action="delete-task">删除事项</button>' : ""}<button class="save-button" type="submit">${task.id ? "保存修改" : "添加事项"}</button>
  </form></div>`;
}

function identityGate() {
  if (state.identity) return "";
  return `<div class="identity-gate"><form class="identity-card" id="identity-form"><div class="identity-symbol"><img src="/rabbittodo-icon.png" alt="RabbitToDo 兔子图标" /></div><p>RabbitToDo</p><h2>今天，慢一点也没关系</h2><span>输入 6 位身份码，在本设备隔离你的待办数据。</span><input id="identity-code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="6 位身份码" required /><button class="save-button" type="submit">开始记录</button></form></div>`;
}

function render() {
  const retainedAvatar = app.querySelector(".avatar");
  const tasks = filteredTasks();
  const openTasks = tasks.filter((task) => !task.completed);
  const completedTasks = tasks.filter((task) => task.completed).sort((left, right) => String(right.completed_at || "").localeCompare(String(left.completed_at || "")));
  const emptyMessage = completedTasks.length && state.status === "all" ? "所有事项均已完成，做得好。" : "这里还没有事项，点击 + 添加第一项吧。";
  const openList = openTasks.length || !completedTasks.length || state.status === "all" ? `<section class="task-list">${openTasks.map((task) => taskCard(task)).join("") || `<p class="empty-state">${emptyMessage}</p>`}</section>` : "";
  const taskContent = `${openList}${completedTasks.length ? `<section class="completed-section"><div class="completed-section-title"><span>已完成</span><b>${completedTasks.length}</b></div><section class="task-list completed-task-list">${completedTasks.map((task) => taskCard(task, { sortable: false })).join("")}</section></section>` : ""}${state.view === "today" && state.tasks.some(oldCompleted) ? '<p class="archive-note">较早完成的事项已自动隐藏</p>' : ""}`;
  const heading = { today: "今天", all: "全部事项", profile: "我的" }[state.view];
  app.innerHTML = `<section class="phone"><div class="content-scroll"><header class="topbar"><div><p class="eyebrow"><b class="brand-inline">RabbitToDo</b>　${new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</p><h1>${heading}</h1></div><button class="avatar" data-action="profile" aria-label="查看我的身份码"><i class="avatar-icon"><img src="/rabbittodo-icon.png" alt="" /></i><span>${state.identity || "······"}</span></button></header>
    ${state.view === "today" ? progress() : ""}${state.view === "all" ? `<section class="all-summary"><span>所有事项</span><strong>${state.tasks.length}</strong><p>已完成 ${state.tasks.filter((task) => task.completed).length} 项</p></section>` : ""}${["today", "all"].includes(state.view) ? filters() : ""}
    ${state.view === "profile" ? `<section class="profile-card"><div class="profile-icon"><img src="/rabbittodo-icon.png" alt="RabbitToDo" /></div><p>我的身份码</p><strong>${state.identity.slice(0, 3)} ${state.identity.slice(3)}</strong><span>此代码仅用于隔离你的待办数据。</span><button data-action="switch-identity">切换身份码</button></section>` : taskContent}</div>
    ${state.view !== "profile" ? '<button class="add-button" data-action="add" aria-label="添加事项">+</button>' : ""}<nav class="tabbar tabbar-two"><button data-action="view" data-view="today" class="${state.view === "today" ? "active" : ""}"><span>◷</span>今日</button><button data-action="view" data-view="all" class="${state.view === "all" ? "active" : ""}"><span>☷</span>全部</button></nav></section>${editor()}${identityGate()}`;
  const nextAvatar = app.querySelector(".avatar");
  if (retainedAvatar && nextAvatar) {
    retainedAvatar.querySelector("span").textContent = nextAvatar.querySelector("span").textContent;
    nextAvatar.replaceWith(retainedAvatar);
  }
}

function openEditor(task = { title: "", details: "", color: "violet", status: "none", tags: [], due_date: today() }) { state.editor = { ...task, status: task.status || "none" }; state.draftTags = [...task.tags]; state.tagInput = ""; render(); }
function commitTag() { const tag = state.tagInput.trim().replace(/^#/, ""); if (tag && !state.draftTags.includes(tag)) state.draftTags.push(tag); state.tagInput = ""; render(); document.querySelector("#tag-input")?.focus(); }

app.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (button) {
    const action = button.dataset.action;
    if (action === "add") return openEditor();
    if (action === "close-editor") { state.editor = null; return render(); }
    if (action === "view") { state.view = button.dataset.view; return render(); }
    if (action === "profile") { state.view = "profile"; return render(); }
    if (action === "toggle-filters") { state.filtersOpen = !state.filtersOpen; return render(); }
    if (action === "status-filter") { state.status = button.dataset.status; return render(); }
    if (action === "tag-filter") { state.tag = button.dataset.tag; return render(); }
    if (action === "color-filter") { state.color = button.dataset.color; return render(); }
    if (action === "pick-color") { state.editor.color = button.dataset.color; return render(); }
    if (action === "pick-task-status") { state.editor.status = button.dataset.status; return render(); }
    if (action === "remove-tag") { state.draftTags = state.draftTags.filter((tag) => tag !== button.dataset.tag); return render(); }
    if (action === "switch-identity") { localStorage.removeItem("todo-identity"); state.identity = ""; state.view = "today"; return render(); }
    if (action === "toggle") {
      const id = Number(button.dataset.id);
      const task = state.tasks.find((item) => item.id === id);
      if (!task) return;
      const completed = !task.completed;
      task.completed = completed;
      task.completed_at = completed ? new Date().toISOString() : null;
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
  if (Date.now() < suppressCardClickUntil) return;
  if (card) openEditor(state.tasks.find((task) => task.id === Number(card.dataset.taskId)));
});

app.addEventListener("keydown", (event) => {
  if (event.target.id !== "tag-input") return;
  if (event.key === "Enter") { event.preventDefault(); commitTag(); }
  if (event.key === "Backspace" && !event.target.value && state.draftTags.length) { state.draftTags.pop(); render(); document.querySelector("#tag-input")?.focus(); }
});
app.addEventListener("input", (event) => {
  if (event.target.id === "tag-input") state.tagInput = event.target.value;
  if (event.target.id === "task-title" && state.editor) state.editor.title = event.target.value;
  if (event.target.id === "task-details" && state.editor) state.editor.details = event.target.value;
  if (event.target.id === "task-date" && state.editor) state.editor.due_date = event.target.value;
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (event.target.id === "identity-form") {
      const code = document.querySelector("#identity-code").value;
      await api("/api/identity", { method: "POST", body: JSON.stringify({ code }) }); localStorage.setItem("todo-identity", code); state.identity = code; return loadTasks();
    }
    if (event.target.id === "task-form") {
      const title = document.querySelector("#task-title").value;
      const details = document.querySelector("#task-details").value;
      const dueDate = document.querySelector("#task-date").value || null;
      const tag = state.tagInput.trim().replace(/^#/, "");
      const tags = tag && !state.draftTags.includes(tag) ? [...state.draftTags, tag] : state.draftTags;
      const payload = { title, details, color: state.editor.color, status: state.editor.status || "none", tags, dueDate };
      const editingId = Number(state.editor.id || 0);
      if (editingId) {
        const localTask = state.tasks.find((task) => task.id === editingId);
        if (localTask) Object.assign(localTask, { title, details, color: payload.color, status: payload.status, tags, due_date: dueDate });
        state.editor = null;
        render();
        saveInBackground(async () => {
          const response = await api(`/api/tasks/${resolvedTaskId(editingId)}`, { method: "PUT", body: JSON.stringify(payload) });
          applyServerTask(response.task, editingId);
        });
      } else {
        const temporaryId = nextTemporaryTaskId--;
        const position = state.tasks.reduce((min, task) => Math.min(min, Number(task.position) || 0), 0) - 1;
        state.tasks.unshift({
          id: temporaryId, identity_code: state.identity, title, details, color: payload.color, tags,
          due_date: dueDate, completed: false, completed_at: null, status: payload.status, position,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        state.editor = null;
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

app.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest(".drag-handle");
  if (!handle || event.button !== 0) return;
  const card = handle.closest("[data-task-id]");
  const list = card?.closest(".task-list");
  if (!card || !list) return;
  event.preventDefault();
  const bounds = card.getBoundingClientRect();
  pointerDrag = {
    id: Number(card.dataset.taskId), card, list, handle, pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY,
    bounds, offsetY: event.clientY - bounds.top, didMove: false, ghost: null,
  };
  state.dragId = pointerDrag.id;
  handle.setPointerCapture?.(event.pointerId);
});

function startFloatingDrag(drag) {
  drag.didMove = true;
  drag.card.classList.add("is-drag-placeholder");
  const ghost = drag.card.cloneNode(true);
  ghost.classList.remove("is-drag-placeholder");
  ghost.classList.add("task-drag-ghost");
  ghost.style.left = `${drag.bounds.left}px`;
  ghost.style.top = `${drag.bounds.top}px`;
  ghost.style.width = `${drag.bounds.width}px`;
  ghost.style.height = `${drag.bounds.height}px`;
  document.body.append(ghost);
  drag.ghost = ghost;
  document.body.classList.add("is-task-dragging");
}

function moveFloatingCard(drag, event) {
  const y = event.clientY - drag.offsetY - drag.bounds.top;
  const x = (event.clientX - drag.startX) * 0.08;
  drag.ghost.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.015)`;
}

function animateTaskReorder(list, card, move) {
  const before = new Map([...list.querySelectorAll("[data-task-id]")].filter((item) => item !== card).map((item) => [item, item.getBoundingClientRect()]));
  move();
  for (const [item, first] of before) {
    const last = item.getBoundingClientRect();
    const delta = first.top - last.top;
    if (Math.abs(delta) > 1) item.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: 190, easing: "cubic-bezier(.2,.75,.25,1)" });
  }
}

function reorderAtPointer(drag, clientY) {
  const cards = [...drag.list.querySelectorAll("[data-task-id]")];
  const others = cards.filter((item) => item !== drag.card);
  const next = others.find((item) => clientY < item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2);
  if (next === drag.card.nextElementSibling || (!next && drag.card === cards[cards.length - 1])) return;
  animateTaskReorder(drag.list, drag.card, () => {
    if (next) drag.list.insertBefore(drag.card, next);
    else {
      const lastOther = others[others.length - 1];
      drag.list.insertBefore(drag.card, lastOther?.nextElementSibling || null);
    }
  });
}

app.addEventListener("pointermove", (event) => {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
  const movedEnough = Math.abs(event.clientX - pointerDrag.startX) > 4 || Math.abs(event.clientY - pointerDrag.startY) > 4;
  if (!movedEnough) return;
  event.preventDefault();
  if (!pointerDrag.didMove) startFloatingDrag(pointerDrag);
  pointerDrag.lastX = event.clientX;
  pointerDrag.lastY = event.clientY;
  moveFloatingCard(pointerDrag, event);
  reorderAtPointer(pointerDrag, event.clientY);
});

function finishPointerDrag(event) {
  if (!pointerDrag || (event && event.pointerId !== pointerDrag.pointerId)) return;
  const drag = pointerDrag;
  pointerDrag = null;
  state.dragId = null;
  drag.card.classList.remove("is-drag-placeholder");
  drag.ghost?.remove();
  document.body.classList.remove("is-task-dragging");
  drag.handle.releasePointerCapture?.(drag.pointerId);
  if (event?.type === "pointercancel") {
    if (drag.didMove) render();
    return;
  }
  if (!drag.didMove) return;
  suppressCardClickUntil = Date.now() + 260;
  const visibleIds = [...drag.list.querySelectorAll("[data-task-id]")].map((card) => Number(card.dataset.taskId));
  const visibleSet = new Set(visibleIds);
  let visibleIndex = 0;
  const ids = state.tasks.map((task) => visibleSet.has(task.id) ? visibleIds[visibleIndex++] : task.id);
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  state.tasks = ids.map((id) => tasksById.get(id)).filter(Boolean);
  saveInBackground(() => api("/api/tasks/reorder", {
    method: "POST",
    body: JSON.stringify({ ids: state.tasks.map((task) => resolvedTaskId(task.id)) }),
  }));
}

app.addEventListener("pointerup", finishPointerDrag);
app.addEventListener("pointercancel", finishPointerDrag);

// Installed PWAs are often resumed from a frozen page instead of reloaded.
// Refresh on every foreground return and poll gently while the app stays open.
window.addEventListener("pageshow", () => refreshActiveTasks(true));
window.addEventListener("focus", () => refreshActiveTasks(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshActiveTasks(true);
});
setInterval(() => refreshActiveTasks(), 30_000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (sessionStorage.getItem("rabbittodo-sw-reloaded")) return;
    sessionStorage.setItem("rabbittodo-sw-reloaded", "1");
    window.location.reload();
  });
  navigator.serviceWorker.register("/sw.js").then((registration) => registration.update());
}
loadTasks();
