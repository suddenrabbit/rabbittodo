const COLORS = new Set(["violet", "mint", "orange", "blue", "rose"]);
const STATUSES = new Set(["none", "in_progress", "paused"]);
const IDENTITY_STATUSES = new Set(["pending", "enabled", "disabled"]);
const DEFAULT_ADMIN_PASSWORD = "zhoumeng1987";
const ENCRYPTION_PREFIX = "rtenc:v1:";
const ENCRYPTED_VALUE_PATTERN = /^rtenc:v1:[A-Za-z0-9+/]+={0,2}$/;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function taskFromRow(row) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags || "[]"); } catch { tags = []; }
  return { ...row, completed: Boolean(row.completed), pinned: Boolean(row.pinned), tags, details: row.details || "", status: row.status || "none" };
}

function identityFrom(request) {
  const code = String(request.headers.get("X-Identity-Code") || "");
  return /^\d{6}$/.test(code) ? code : null;
}

async function bodyFrom(request) {
  const raw = await request.text();
  if (raw.length > 1_000_000) throw new Error("请求内容过大");
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error("请求格式无效"); }
}

function sanitizeTaskText(value, { field, plainLimit, encryptedLimit, required = false }) {
  const raw = String(value || "").trim();
  if (!raw) {
    if (required) throw new Error(`请填写${field}`);
    return "";
  }
  if (raw.startsWith(ENCRYPTION_PREFIX)) {
    if (!ENCRYPTED_VALUE_PATTERN.test(raw) || raw.length > encryptedLimit) throw new Error(`${field}密文无效`);
    return raw;
  }
  return raw.slice(0, plainLimit);
}

function sanitizeTask(input) {
  const title = sanitizeTaskText(input.title, { field: "事项名称", plainLimit: 200, encryptedLimit: 4_096, required: true });
  const color = COLORS.has(input.color) ? input.color : "violet";
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((tag) => String(tag).trim().replace(/^#/, "")).filter(Boolean))].slice(0, 12)
    : [];
  const details = sanitizeTaskText(input.details, { field: "任务详情", plainLimit: 2_000, encryptedLimit: 16_000 });
  const status = STATUSES.has(input.status) ? input.status : "none";
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate || "")) ? input.dueDate : null;
  const pinned = Boolean(input.pinned);
  return { title, color, tags, details, status, dueDate, pinned };
}

function sanitizeEncryptedTaskContent(input) {
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error("事项编号无效");
  const title = sanitizeTaskText(input.title, { field: "事项名称", plainLimit: 0, encryptedLimit: 4_096, required: true });
  const details = sanitizeTaskText(input.details, { field: "任务详情", plainLimit: 0, encryptedLimit: 16_000 });
  if (!title.startsWith(ENCRYPTION_PREFIX) || (details && !details.startsWith(ENCRYPTION_PREFIX))) throw new Error("任务密文无效");
  return { id, title, details };
}

function taskIdFrom(pathname) {
  const match = pathname.match(/^\/api\/tasks\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function ensureIdentity(db, code) {
  await db.prepare("INSERT OR IGNORE INTO identities (code, status) VALUES (?, 'pending')").bind(code).run();
  return db.prepare("SELECT code, status, created_at, reviewed_at FROM identities WHERE code = ?").bind(code).first();
}

function adminAuthorized(request, env) {
  const supplied = String(request.headers.get("X-Admin-Password") || "");
  return supplied && supplied === String(env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD);
}

function identityBlocked(status) {
  const pending = status === "pending";
  return json({
    error: pending ? "请等待管理员审核确认" : "该身份码已禁用或审核未通过",
    identityStatus: pending ? "pending" : "disabled",
  }, 403);
}

async function taskById(db, id, identity) {
  const row = await db.prepare("SELECT * FROM tasks WHERE id = ? AND identity_code = ?").bind(id, identity).first();
  return taskFromRow(row);
}

async function api(request, env, url) {
  const { pathname } = url;

  if (request.method === "POST" && pathname === "/api/admin/login") {
    return adminAuthorized(request, env) ? json({ ok: true }) : json({ error: "管理员密码错误" }, 401);
  }

  if (pathname.startsWith("/api/admin/")) {
    if (!adminAuthorized(request, env)) return json({ error: "管理员身份验证失败" }, 401);

    if (request.method === "GET" && pathname === "/api/admin/identities") {
      const { results } = await env.DB.prepare(
        "SELECT identities.code, identities.status, identities.created_at, identities.reviewed_at, COUNT(tasks.id) AS task_count FROM identities LEFT JOIN tasks ON tasks.identity_code = identities.code GROUP BY identities.code ORDER BY CASE identities.status WHEN 'pending' THEN 0 WHEN 'enabled' THEN 1 ELSE 2 END, identities.created_at DESC",
      ).all();
      return json({ identities: results.map((row) => ({ ...row, task_count: Number(row.task_count || 0) })) });
    }

    const match = pathname.match(/^\/api\/admin\/identities\/(\d{6})$/);
    if (request.method === "PATCH" && match) {
      const { status } = await bodyFrom(request);
      if (!IDENTITY_STATUSES.has(status) || status === "pending") return json({ error: "身份码状态无效" }, 400);
      const result = await env.DB.prepare(
        "UPDATE identities SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE code = ?",
      ).bind(status, match[1]).run();
      if (!result.meta.changes) return json({ error: "身份码不存在" }, 404);
      const identity = await env.DB.prepare(
        "SELECT code, status, created_at, reviewed_at FROM identities WHERE code = ?",
      ).bind(match[1]).first();
      return json({ identity });
    }

    return json({ error: "未找到管理接口" }, 404);
  }

  if (request.method === "POST" && pathname === "/api/identity") {
    const { code } = await bodyFrom(request);
    if (!/^\d{6}$/.test(String(code || ""))) return json({ error: "请输入 6 位身份码" }, 400);
    const identity = await ensureIdentity(env.DB, String(code));
    return json({ code: identity.code, status: identity.status }, identity.status === "pending" ? 202 : 200);
  }

  const identity = identityFrom(request);
  if (!identity) return json({ error: "请先输入 6 位身份码" }, 401);
  const identityRecord = await env.DB.prepare("SELECT status FROM identities WHERE code = ?").bind(identity).first();
  if (!identityRecord) return identityBlocked("pending");
  if (identityRecord.status !== "enabled") return identityBlocked(identityRecord.status);

  if (request.method === "GET" && pathname === "/api/tasks") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM tasks WHERE identity_code = ? ORDER BY id DESC",
    ).bind(identity).all();
    return json({ tasks: results.map(taskFromRow) });
  }

  if (request.method === "POST" && pathname === "/api/tasks") {
    const task = sanitizeTask(await bodyFrom(request));
    const inserted = await env.DB.prepare(
      "INSERT INTO tasks (identity_code, title, color, tags, details, status, due_date, pinned, pinned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END)",
    ).bind(identity, task.title, task.color, JSON.stringify(task.tags), task.details, task.status, task.dueDate, task.pinned ? 1 : 0, task.pinned ? 1 : 0).run();
    const created = await taskById(env.DB, Number(inserted.meta.last_row_id), identity);
    return json({ task: created }, 201);
  }

  if (request.method === "POST" && pathname === "/api/tasks/encrypt") {
    const { tasks } = await bodyFrom(request);
    if (!Array.isArray(tasks) || !tasks.length || tasks.length > 50) return json({ error: "任务密文数据无效" }, 400);
    const encryptedTasks = tasks.map(sanitizeEncryptedTaskContent);
    if (new Set(encryptedTasks.map((task) => task.id)).size !== encryptedTasks.length) return json({ error: "事项编号重复" }, 400);
    await env.DB.batch(encryptedTasks.map((task) => env.DB.prepare(
      "UPDATE tasks SET title = ?, details = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?",
    ).bind(task.title, task.details, task.id, identity)));
    return json({ ok: true });
  }

  if (request.method === "POST" && pathname === "/api/tasks/reorder") {
    const { ids, pinnedIds, completed } = await bodyFrom(request);
    if (!Array.isArray(ids)) return json({ error: "排序数据无效" }, 400);

    const normalizedIds = ids.map(Number);
    const hasPageOrder = typeof completed === "boolean" && Array.isArray(pinnedIds);
    if (hasPageOrder) {
      const { results: ownedRows } = await env.DB.prepare(
        "SELECT id FROM tasks WHERE identity_code = ? AND completed = ?",
      ).bind(identity, completed ? 1 : 0).all();
      const owned = ownedRows.map((row) => Number(row.id));
      const normalizedPinnedIds = pinnedIds.map(Number);
      const uniqueIds = new Set(normalizedIds);
      const uniquePinnedIds = new Set(normalizedPinnedIds);
      if (
        normalizedIds.length !== owned.length
        || uniqueIds.size !== normalizedIds.length
        || normalizedIds.some((taskId) => !owned.includes(taskId))
        || uniquePinnedIds.size !== normalizedPinnedIds.length
        || normalizedPinnedIds.some((taskId) => !uniqueIds.has(taskId))
      ) {
        return json({ error: "排序数据不完整" }, 400);
      }
      await env.DB.batch(normalizedIds.map((taskId, index) => {
        const pinned = uniquePinnedIds.has(taskId) ? 1 : 0;
        return env.DB.prepare(
          "UPDATE tasks SET manual_position = ?, pinned = ?, pinned_at = CASE WHEN ? = 0 THEN NULL WHEN pinned = 0 OR pinned_at IS NULL THEN CURRENT_TIMESTAMP ELSE pinned_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ? AND completed = ?",
        ).bind(index + 1, pinned, pinned, taskId, identity, completed ? 1 : 0);
      }));
      return json({ ok: true });
    }

    // Keep compatibility with clients that still send the legacy whole-list order.
    const { results: ownedRows } = await env.DB.prepare(
      "SELECT id FROM tasks WHERE identity_code = ?",
    ).bind(identity).all();
    const owned = ownedRows.map((row) => Number(row.id));
    if (normalizedIds.length !== owned.length || normalizedIds.some((id) => !owned.includes(id))) {
      return json({ error: "排序数据不完整" }, 400);
    }
    await env.DB.batch(normalizedIds.map((id, index) => env.DB.prepare(
      "UPDATE tasks SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?",
    ).bind(index + 1, id, identity)));
    return json({ ok: true });
  }

  const id = taskIdFrom(pathname);
  if (id && request.method === "PUT") {
    const task = sanitizeTask(await bodyFrom(request));
    const result = await env.DB.prepare(
      "UPDATE tasks SET title = ?, color = ?, tags = ?, details = ?, status = ?, due_date = ?, pinned = ?, pinned_at = CASE WHEN ? = 0 THEN NULL WHEN pinned_at IS NULL THEN CURRENT_TIMESTAMP ELSE pinned_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?",
    ).bind(task.title, task.color, JSON.stringify(task.tags), task.details, task.status, task.dueDate, task.pinned ? 1 : 0, task.pinned ? 1 : 0, id, identity).run();
    if (!result.meta.changes) return json({ error: "事项不存在" }, 404);
    return json({ task: await taskById(env.DB, id, identity) });
  }

  if (id && request.method === "PATCH") {
    const { completed, status } = await bodyFrom(request);
    let result;
    if (typeof completed === "boolean") {
      result = await env.DB.prepare(
        "UPDATE tasks SET completed = ?, completed_at = ?, status = CASE WHEN ? THEN 'none' ELSE status END, manual_position = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?",
      ).bind(completed ? 1 : 0, completed ? new Date().toISOString() : null, completed ? 1 : 0, id, identity).run();
    } else if (STATUSES.has(status)) {
      result = await env.DB.prepare(
        "UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?",
      ).bind(status, id, identity).run();
    } else {
      return json({ error: "任务状态无效" }, 400);
    }
    if (!result.meta.changes) return json({ error: "事项不存在" }, 404);
    return json({ task: await taskById(env.DB, id, identity) });
  }

  if (id && request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM tasks WHERE id = ? AND identity_code = ?").bind(id, identity).run();
    return result.meta.changes ? json({ ok: true }) : json({ error: "事项不存在" }, 404);
  }

  return json({ error: "未找到接口" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      if (url.pathname === "/console") return Response.redirect(`${url.origin}/console/`, 308);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: error instanceof Error ? error.message : "服务器暂时不可用" }, 500);
    }
  },
};
