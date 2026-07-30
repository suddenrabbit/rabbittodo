const app = document.querySelector("#console-app");
const STATUS_LABELS = { all: "全部", pending: "待审核", enabled: "已启用", disabled: "已禁用" };
const state = {
  password: sessionStorage.getItem("rabbittodo-admin-password") || "",
  identities: [],
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
  return `<section class="login-shell"><form class="login-card" id="admin-login"><div class="brand-icon"><img src="/rabbittodo-icon.png" alt="RabbitToDo" /></div><p>RabbitToDo</p><h1>身份码管理</h1><span>请输入管理员密码进入控制台</span><input id="admin-password" type="password" autocomplete="current-password" placeholder="管理员密码" required autofocus /><button class="primary-button" type="submit">进入后台</button><div class="login-error">${escapeHtml(state.error)}</div></form></section>`;
}

function actionButtons(identity) {
  if (identity.status === "pending") return `<div class="action-group"><button class="action-button action-enable" data-action="set-status" data-code="${identity.code}" data-status="enabled">通过</button><button class="action-button action-disable" data-action="set-status" data-code="${identity.code}" data-status="disabled">拒绝</button></div>`;
  if (identity.status === "enabled") return `<div class="action-group"><button class="action-button action-disable" data-action="set-status" data-code="${identity.code}" data-status="disabled">禁用</button></div>`;
  return `<div class="action-group"><button class="action-button action-enable" data-action="set-status" data-code="${identity.code}" data-status="enabled">重新启用</button></div>`;
}

function consolePage() {
  const counts = Object.fromEntries(["pending", "enabled", "disabled"].map((status) => [status, state.identities.filter((item) => item.status === status).length]));
  const identities = state.filter === "all" ? state.identities : state.identities.filter((item) => item.status === state.filter);
  const rows = identities.map((identity) => `<tr><td><span class="identity-code">${escapeHtml(identity.code)}</span></td><td><span class="status-badge status-${identity.status}">${STATUS_LABELS[identity.status]}</span></td><td><span class="muted">${dateTimeLabel(identity.created_at)}</span></td><td>${identity.task_count}</td><td>${actionButtons(identity)}</td></tr>`).join("");
  return `<section class="console-shell"><header class="console-header"><div class="console-brand"><div class="brand-icon"><img src="/rabbittodo-icon.png" alt="" /></div><div><p>RabbitToDo Console</p><h1>身份码管理</h1></div></div><button class="logout-button" data-action="logout">退出登录</button></header><section class="summary-grid"><div class="summary-card"><span>全部身份码</span><strong>${state.identities.length}</strong></div><div class="summary-card"><span>待审核</span><strong>${counts.pending}</strong></div><div class="summary-card"><span>已启用</span><strong>${counts.enabled}</strong></div><div class="summary-card"><span>已禁用</span><strong>${counts.disabled}</strong></div></section><div class="toolbar"><div class="filters">${Object.entries(STATUS_LABELS).map(([status, label]) => `<button data-action="filter" data-filter="${status}" class="${state.filter === status ? "is-active" : ""}">${label}</button>`).join("")}</div><button class="refresh-button" data-action="refresh">${state.loading ? "刷新中…" : "刷新"}</button></div><div class="identity-table-wrap">${rows ? `<table class="identity-table"><thead><tr><th>身份码</th><th>状态</th><th>申请时间</th><th>任务数</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty-state">当前筛选下没有身份码</div>'}</div></section>`;
}

function render() {
  app.innerHTML = state.password ? consolePage() : loginPage();
}

async function loadIdentities() {
  state.loading = true;
  render();
  try {
    state.identities = (await adminApi("/api/admin/identities")).identities;
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
      const response = await adminApi(`/api/admin/identities/${button.dataset.code}`, {
        method: "PATCH",
        body: JSON.stringify({ status: button.dataset.status }),
      });
      const index = state.identities.findIndex((item) => item.code === button.dataset.code);
      if (index >= 0) state.identities[index] = { ...state.identities[index], ...response.identity };
      render();
    } catch (error) {
      alert(error.message);
      render();
    }
  }
});

render();
if (state.password) loadIdentities();
