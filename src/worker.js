const COLORS = new Set(["violet", "mint", "orange", "blue", "rose"]);
const STATUSES = new Set(["none", "in_progress", "paused"]);

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

function sanitizeTask(input) {
  const title = String(input.title || "").trim().slice(0, 200);
  const color = COLORS.has(input.color) ? input.color : "violet";
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((tag) => String(tag).trim().replace(/^#/, "")).filter(Boolean))].slice(0, 12)
    : [];
  const details = String(input.details || "").trim().slice(0, 2_000);
  const status = STATUSES.has(input.status) ? input.status : "none";
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate || "")) ? input.dueDate : null;
  const pinned = Boolean(input.pinned);
  if (!title) throw new Error("请填写事项名称");
  return { title, color, tags, details, status, dueDate, pinned };
}

function taskIdFrom(pathname) {
  const match = pathname.match(/^\/api\/tasks\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function ensureIdentity(db, code) {
  await db.prepare("INSERT OR IGNORE INTO identities (code) VALUES (?)").bind(code).run();
}

async function taskById(db, id, identity) {
  const row = await db.prepare("SELECT * FROM tasks WHERE id = ? AND identity_code = ?").bind(id, identity).first();
  return taskFromRow(row);
}

async function api(request, env, url) {
  const { pathname } = url;

  if (request.method === "POST" && pathname === "/api/identity") {
    const { code } = await bodyFrom(request);
    if (!/^\d{6}$/.test(String(code || ""))) return json({ error: "请输入 6 位身份码" }, 400);
    await ensureIdentity(env.DB, code);
    return json({ code });
  }

  const identity = identityFrom(request);
  if (!identity) return json({ error: "请先输入 6 位身份码" }, 401);
  await ensureIdentity(env.DB, identity);

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

  // Keep the endpoint temporarily for clients that have not refreshed yet.
  // The current interface no longer exposes manual ordering and ignores position.
  if (request.method === "POST" && pathname === "/api/tasks/reorder") {
    const { ids } = await bodyFrom(request);
    if (!Array.isArray(ids)) return json({ error: "排序数据无效" }, 400);
    const { results: ownedRows } = await env.DB.prepare(
      "SELECT id FROM tasks WHERE identity_code = ?",
    ).bind(identity).all();
    const owned = ownedRows.map((row) => Number(row.id));
    const normalizedIds = ids.map(Number);
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
        "UPDATE tasks SET completed = ?, completed_at = ?, status = CASE WHEN ? THEN 'none' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?",
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
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: error instanceof Error ? error.message : "服务器暂时不可用" }, 500);
    }
  },
};
