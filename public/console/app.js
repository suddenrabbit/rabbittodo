const app = document.querySelector("#console-app");
const STATUS_LABELS = { all: "全部", enabled: "已启用", disabled: "已禁用" };
const state = {
  password: sessionStorage.getItem("rabbittodo-admin-password") || "",
  identities: [], resetCode: "",
  filter: "all",
  loading: false,
  error: "",
};

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const dateTimeLabel = (value) => {
  if (!value) return "—";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(normalized));
};

async function adminApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Admin-Password": state.password, ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      sessionStorage.removeItem("rabbittodo-admin-password");
      state.password = "";
    }
    throw new Error(payload.error || "操作未完成");
  }
  return payload;
}

function loginPage() {
  return `<section class="login-shell"><form class="login-card" id="admin-login"><div class="brand-icon"><img src="/rabbittodo-icon.png" alt="RabbitToDo" /></div><p>RabbitToDo</p><h1>用户管理</h1><span>请输入管理员密码进入控制台</span><input id="admin-password" type="password" autocomplete="current-password" placeholder="管理员密码" required autofocus /><button class="primary-button" type="submit">进入后台</button><div class="login-error">${escapeHtml(state.error)}</div></form></section>`;
}

function actionButtons(user) {
  const status = user.status === "enabled" ? `<button class="action-button action-disable" data-action="set-status" data-code="${encodeURIComponent(user.code)}" data-status="disabled">禁用</button>` : `<button class="action-button action-enable" data-action="set-status" data-code="${encodeURIComponent(user.code)}" data-status="enabled">重新启用</button>`;
  return `<div class="action-group">${status}<button class="action-button" data-action="reset" data-code="${encodeURIComponent(user.code)}">重置密码</button></div>`;
}

function consolePage() {
  const counts = Object.fromEntries(["enabled", "disabled"].map((status) => [status, state.identities.filter((item) => item.status === status).length]));
  const identities = state.filter === "all" ? state.identities : state.identities.filter((item) => item.status === state.filter);
  const rows = identities.map((user) => `<tr><td><span class="identity-code">${escapeHtml(user.username)}</span></td><td><span class="status-badge status-${user.status}">${STATUS_LABELS[user.status]}</span></td><td><span class="muted">${dateTimeLabel(user.created_at)}</span></td><td>${user.task_count}</td><td>${actionButtons(user)}</td></tr>`).join("");
  const reset = state.resetCode ? `<div class="reset-code">一次性重置码（仅显示一次）：<strong>${escapeHtml(state.resetCode)}</strong></div>` : "";
  return `<section class="console-shell"><header class="console-header"><div class="console-brand"><div class="brand-icon"><img src="/rabbittodo-icon.png" alt="" /></div><div><p>RabbitToDo Console</p><h1>用户管理</h1></div></div><button class="logout-button" data-action="logout">退出登录</button></header><section class="summary-grid"><div class="summary-card"><span>全部用户</span><strong>${state.identities.length}</strong></div><div class="summary-card"><span>已启用</span><strong>${counts.enabled}</strong></div><div class="summary-card"><span>已禁用</span><strong>${counts.disabled}</strong></div></section>${reset}<div class="toolbar"><div class="filters">${Object.entries(STATUS_LABELS).map(([status, label]) => `<button data-action="filter" data-filter="${status}" class="${state.filter === status ? "is-active" : ""}">${label}</button>`).join("")}</div><button class="refresh-button" data-action="refresh">${state.loading ? "刷新中…" : "刷新"}</button></div><div class="identity-table-wrap">${rows ? `<table class="identity-table"><thead><tr><th>用户名</th><th>状态</th><th>创建时间</th><th>任务数</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty-state">当前筛选下没有用户</div>'}</div></section>`;
}

function render() {
  app.innerHTML = state.password ? consolePage() : loginPage();
}

async function loadIdentities() {
  state.loading = true;
  render();
  try {
    state.identities = (await adminApi("/api/admin/users")).users;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

app.addEventListener("submit", async (event) => {
  if (event.target.id !== "admin-login") return;
  event.preventDefault();
  state.password = document.querySelector("#admin-password").value;
  state.error = "";
  try {
    await adminApi("/api/admin/login", { method: "POST", body: "{}" });
    sessionStorage.setItem("rabbittodo-admin-password", state.password);
    await loadIdentities();
  } catch (error) {
    state.error = error.message;
    render();
  }
});

app.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "logout") {
    sessionStorage.removeItem("rabbittodo-admin-password");
    state.password = "";
    state.identities = [];
    state.error = "";
    return render();
  }
  if (action === "filter") { state.filter = button.dataset.filter; return render(); }
  if (action === "refresh") return loadIdentities();
  if (action === "set-status") {
    button.disabled = true;
    try {
      const response = await adminApi(`/api/admin/users/${button.dataset.code}`, {
        method: "PATCH",
        body: JSON.stringify({ status: button.dataset.status }),
      });
      await loadIdentities();
      render();
    } catch (error) {
      alert(error.message);
      render();
    }
  }
  if (action === "reset") {
    if (!confirm("生成一次性重置码并撤销该用户全部登录会话？")) return;
    try { const response = await adminApi(`/api/admin/users/${button.dataset.code}/reset`, { method: "POST", body: "{}" }); state.resetCode = response.resetCode; render(); } catch (error) { alert(error.message); }
  }
});

render();
if (state.password) loadIdentities();
