const COLORS = new Set(["violet", "mint", "orange", "blue", "rose"]);
const STATUSES = new Set(["none", "in_progress", "paused"]);
const USERNAME_PATTERN = /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_]{1,9}$/u;
const ENCRYPTION_PREFIX = "rtenc:v1:";
const ENCRYPTED_VALUE_PATTERN = /^rtenc:v1:[A-Za-z0-9+/]+={0,2}$/;
const PASSWORD_ITERATIONS = 210_000;
const PASSWORD_VERSION = "pbkdf2-sha256-v1";
const SESSION_DAYS = 30;
const RESET_MINUTES = 15;
const DEFAULT_ADMIN_SALT = "RabbitToDo admin fallback v1";
const DEFAULT_ADMIN_HASH = "HG4xZtIsF6fVSt7cDhso9PvCsMlomht3m6Knv1WIerU=";
const authFailures = new Map();

const encoder = new TextEncoder();
function json(data, status = 200, headers = {}) { return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } }); }
function b64(bytes) { let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(binary); }
function unb64(value) { const binary = atob(value); return Uint8Array.from(binary, (c) => c.charCodeAt(0)); }
function randomB64(size = 32) { return b64(crypto.getRandomValues(new Uint8Array(size))); }
async function sha256(value) { return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }
async function pbkdf2(value, salt, iterations = PASSWORD_ITERATIONS) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(value), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations }, material, 256));
}
async function passwordRecord(password) { const salt = randomB64(16); return { salt, hash: b64(await pbkdf2(password, salt)), params: JSON.stringify({ version: PASSWORD_VERSION, iterations: PASSWORD_ITERATIONS }) }; }
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let result = 0; for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i); return result === 0; }
async function passwordMatches(password, row) { return timingSafeEqual(await b64(await pbkdf2(password, row.password_salt, JSON.parse(row.password_params || "{}").iterations || PASSWORD_ITERATIONS)), String(row.password_hash || "")); }
function cookieValue(request, name) { return request.headers.get("Cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] || ""; }
function cookieSecurity(request) { return new URL(request.url).protocol === "https:" ? "; Secure" : ""; }
function sessionCookie(token, request, maxAge = SESSION_DAYS * 86400) { return `rabbittodo_session=${token}; Path=/; HttpOnly; SameSite=Strict${cookieSecurity(request)}; Max-Age=${maxAge}`; }
function clearSessionCookie(request) { return `rabbittodo_session=; Path=/; HttpOnly; SameSite=Strict${cookieSecurity(request)}; Max-Age=0`; }
function expiry(days = SESSION_DAYS) { return new Date(Date.now() + days * 86400_000).toISOString(); }
async function bodyFrom(request) { const raw = await request.text(); if (raw.length > 1_000_000) throw new Error("请求内容过大"); try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error("请求格式无效"); } }
function normalizeUsername(value) { return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US"); }
function validUsername(value) { return USERNAME_PATTERN.test(String(value || "").normalize("NFKC").trim()); }
function validPassword(value) { return typeof value === "string" && value.length >= 8 && value.length <= 256; }
function failureKey(request, username) { return `${request.headers.get("CF-Connecting-IP") || "local"}:${normalizeUsername(username)}`; }
function isRateLimited(key) { const entry = authFailures.get(key); return entry && entry.until > Date.now(); }
function recordFailure(key) {
  const previous = authFailures.get(key) || { count: 0 };
  const count = previous.count + 1;
  const delay = count < 5 ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(count - 5, 6));
  authFailures.set(key, { count, until: Date.now() + delay });
}
function clearFailure(key) { authFailures.delete(key); }
function publicAccount(row) { return { username: row.username, vaultSalt: row.vault_salt, passwordWrappedSeed: row.password_wrapped_seed }; }
function taskFromRow(row) { if (!row) return null; const { identity_code, ...task } = row; let tags = []; try { tags = JSON.parse(task.tags || "[]"); } catch {} return { ...task, completed: Boolean(task.completed), pinned: Boolean(task.pinned), tags, details: task.details || "", status: task.status || "none" }; }
function sanitizeTaskText(value, { field, plainLimit, encryptedLimit, required = false }) { const raw = String(value || "").trim(); if (!raw) { if (required) throw new Error(`请填写${field}`); return ""; } if (raw.startsWith(ENCRYPTION_PREFIX)) { if (!ENCRYPTED_VALUE_PATTERN.test(raw) || raw.length > encryptedLimit) throw new Error(`${field}密文无效`); return raw; } return raw.slice(0, plainLimit); }
function sanitizeTask(input) { const title = sanitizeTaskText(input.title, { field: "事项名称", plainLimit: 200, encryptedLimit: 4096, required: true }); const color = COLORS.has(input.color) ? input.color : "violet"; const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map((tag) => String(tag).trim().replace(/^#/, "")).filter(Boolean))].slice(0, 12) : []; const details = sanitizeTaskText(input.details, { field: "任务详情", plainLimit: 2000, encryptedLimit: 16000 }); const status = STATUSES.has(input.status) ? input.status : "none"; const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate || "")) ? input.dueDate : null; return { title, color, tags, details, status, dueDate, pinned: Boolean(input.pinned) }; }
function sanitizeEncryptedTaskContent(input) { const id = Number(input.id); if (!Number.isInteger(id) || id <= 0) throw new Error("事项编号无效"); const title = sanitizeTaskText(input.title, { field: "事项名称", plainLimit: 0, encryptedLimit: 4096, required: true }); const details = sanitizeTaskText(input.details, { field: "任务详情", plainLimit: 0, encryptedLimit: 16000 }); if (!title.startsWith(ENCRYPTION_PREFIX) || (details && !details.startsWith(ENCRYPTION_PREFIX))) throw new Error("任务密文无效"); return { id, title, details }; }
function taskIdFrom(pathname) { return Number(pathname.match(/^\/api\/tasks\/(\d+)$/)?.[1] || 0) || null; }
async function taskById(db, id, identity) { return taskFromRow(await db.prepare("SELECT * FROM tasks WHERE id = ? AND identity_code = ?").bind(id, identity).first()); }

function masterKey(env) { const configured = String(env.SERVER_MASTER_KEY || ""); if (configured.length >= 32) return configured; throw new Error("SERVER_MASTER_KEY 未配置或长度不足 32 位"); }
async function masterCryptoKey(env) { return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode(masterKey(env))), "AES-GCM", false, ["encrypt", "decrypt"]); }
async function serverWrapSeed(seed, env) { const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await masterCryptoKey(env), encoder.encode(seed))); const packed = new Uint8Array(iv.length + encrypted.length); packed.set(iv); packed.set(encrypted, iv.length); return b64(packed); }
async function serverUnwrapSeed(wrapped, env) { const packed = unb64(wrapped); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, await masterCryptoKey(env), packed.slice(12))); }
async function wrappedSeedMatches(wrapped, password, salt, expectedSeed) {
  try { return timingSafeEqual(await vaultUnwrap(wrapped, password, salt), expectedSeed); } catch { return false; }
}
async function issueSession(db, identityCode) { const token = randomB64(32); await db.prepare("INSERT INTO sessions (token_hash, identity_code, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), identityCode, expiry()).run(); return token; }
async function accountFromSession(request, db) { const token = cookieValue(request, "rabbittodo_session"); if (!token) return null; const row = await db.prepare("SELECT identities.* FROM sessions JOIN identities ON identities.code = sessions.identity_code WHERE sessions.token_hash = ? AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP").bind(await sha256(token)).first(); return row?.status === "enabled" && row.username ? row : null; }
async function revokeSessions(db, code) { await db.prepare("DELETE FROM sessions WHERE identity_code = ?").bind(code).run(); }
async function adminAuthorized(request, env) { const supplied = String(request.headers.get("X-Admin-Password") || ""); if (!supplied) return false; if (env.ADMIN_PASSWORD) return timingSafeEqual(supplied, String(env.ADMIN_PASSWORD)); const hash = b64(await pbkdf2(supplied, DEFAULT_ADMIN_SALT, 120000)); return timingSafeEqual(hash, DEFAULT_ADMIN_HASH); }

async function authApi(request, env, url) {
  const db = env.DB; const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/auth/session") { const account = await accountFromSession(request, db); return account ? json({ account: publicAccount(account) }) : json({ error: "请登录" }, 401); }
  if (request.method === "POST" && pathname === "/api/auth/register") {
    const { username, password, vaultSalt, passwordWrappedSeed, encryptionSeed } = await bodyFrom(request); const display = String(username || "").normalize("NFKC").trim(); const normalized = normalizeUsername(display);
    if (!validUsername(display)) return json({ error: "用户名为 2-10 个字符，须以中文或英文开头" }, 400);
    if (!validPassword(password)) return json({ error: "密码至少 8 位" }, 400);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(String(encryptionSeed || "")) || String(encryptionSeed).length < 24 || String(encryptionSeed).length > 256) return json({ error: "账号安全信息校验失败，请重试" }, 400);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(String(vaultSalt || "")) || !String(passwordWrappedSeed || "").startsWith("rtvault:v1:") || !await wrappedSeedMatches(passwordWrappedSeed, password, vaultSalt, encryptionSeed)) return json({ error: "账号安全信息校验失败，请重试" }, 400);
    const existing = await db.prepare("SELECT code FROM identities WHERE username_normalized = ?").bind(normalized).first(); if (existing) return json({ error: "用户名已存在，请直接登录" }, 409);
    let code; for (let attempts = 0; attempts < 10; attempts += 1) { code = `u_${randomB64(16).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`; if (!await db.prepare("SELECT code FROM identities WHERE code = ?").bind(code).first()) break; code = null; }
    if (!code) return json({ error: "创建账号失败，请重试" }, 503);
    const record = await passwordRecord(password); const serverWrapped = await serverWrapSeed(encryptionSeed, env);
    try {
      await db.prepare("INSERT INTO identities (code, status, username, username_normalized, password_hash, password_salt, vault_salt, password_params, password_wrapped_seed, server_wrapped_seed, upgraded_at) VALUES (?, 'enabled', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").bind(code, display, normalized, record.hash, record.salt, vaultSalt, record.params, passwordWrappedSeed, serverWrapped).run();
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: identities.username_normalized")) return json({ error: "用户名已存在，请直接登录" }, 409);
      throw error;
    }
    const token = await issueSession(db, code); const account = await db.prepare("SELECT * FROM identities WHERE code = ?").bind(code).first(); return json({ account: publicAccount(account) }, 201, { "Set-Cookie": sessionCookie(token, request) });
  }
  if (request.method === "POST" && pathname === "/api/auth/login") {
    const { username, password } = await bodyFrom(request); const key = failureKey(request, username); if (isRateLimited(key)) return json({ error: "尝试过于频繁，请稍后再试" }, 429); const account = await db.prepare("SELECT * FROM identities WHERE username_normalized = ?").bind(normalizeUsername(username)).first();
    if (!account) return json({ error: "这是一个新用户名，请再次输入密码完成注册", code: "registration_required" }, 404);
    if (!await passwordMatches(String(password || ""), account)) { recordFailure(key); return json({ error: "密码不正确" }, 401); }
    if (account.status !== "enabled") return json({ error: "账号已禁用" }, 403);
    clearFailure(key); const token = await issueSession(db, account.code); return json({ account: publicAccount(account) }, 200, { "Set-Cookie": sessionCookie(token, request) });
  }
  if (request.method === "POST" && pathname === "/api/auth/logout") { const token = cookieValue(request, "rabbittodo_session"); if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run(); return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(request) }); }
  if (request.method === "POST" && pathname === "/api/auth/upgrade") {
    const { identityCode, username, password, vaultSalt, passwordWrappedSeed, encryptionSeed } = await bodyFrom(request); const display = String(username || "").normalize("NFKC").trim(); const normalized = normalizeUsername(display);
    if (!/^\d{6}$/.test(String(identityCode || ""))) return json({ error: "请输入 6 位旧身份码" }, 400);
    const legacy = await db.prepare("SELECT * FROM identities WHERE code = ?").bind(identityCode).first(); if (!legacy) return json({ error: "没有找到这个身份码，请检查后重试" }, 404); if (legacy.username) return json({ error: "这个账号已经设置过用户名，请直接登录" }, 409); if (legacy.status === "disabled") return json({ error: "账号已禁用" }, 403);
    if (!validUsername(display)) return json({ error: "用户名为 2-10 个字符，须以中文或英文开头" }, 400);
    if (!validPassword(password)) return json({ error: "密码至少 8 位" }, 400);
    if (await db.prepare("SELECT code FROM identities WHERE username_normalized = ?").bind(normalized).first()) return json({ error: "用户名已存在" }, 409);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(String(vaultSalt || "")) || !String(passwordWrappedSeed || "").startsWith("rtvault:v1:") || String(encryptionSeed) !== String(identityCode) || !await wrappedSeedMatches(passwordWrappedSeed, password, vaultSalt, encryptionSeed)) return json({ error: "账号信息校验失败，请刷新页面后重试" }, 400);
    const record = await passwordRecord(password); const serverWrapped = await serverWrapSeed(encryptionSeed, env); let upgraded;
    try {
      upgraded = await db.prepare("UPDATE identities SET status = 'enabled', username = ?, username_normalized = ?, password_hash = ?, password_salt = ?, vault_salt = ?, password_params = ?, password_wrapped_seed = ?, server_wrapped_seed = ?, upgraded_at = CURRENT_TIMESTAMP WHERE code = ? AND username IS NULL").bind(display, normalized, record.hash, record.salt, vaultSalt, record.params, passwordWrappedSeed, serverWrapped, identityCode).run();
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: identities.username_normalized")) return json({ error: "用户名已存在" }, 409);
      throw error;
    }
    if (!upgraded.meta.changes) return json({ error: "这个账号已经设置过用户名，请直接登录" }, 409);
    const token = await issueSession(db, identityCode); const account = await db.prepare("SELECT * FROM identities WHERE code = ?").bind(identityCode).first(); return json({ account: publicAccount(account) }, 200, { "Set-Cookie": sessionCookie(token, request) });
  }
  if (request.method === "POST" && pathname === "/api/auth/password") {
    const account = await accountFromSession(request, db); if (!account) return json({ error: "请登录" }, 401); const { currentPassword, newPassword, vaultSalt, passwordWrappedSeed } = await bodyFrom(request);
    if (!await passwordMatches(String(currentPassword || ""), account)) return json({ error: "当前密码错误" }, 401); if (!validPassword(newPassword) || !/^[A-Za-z0-9+/]+={0,2}$/.test(String(vaultSalt || "")) || !String(passwordWrappedSeed || "").startsWith("rtvault:v1:") || !await wrappedSeedMatches(passwordWrappedSeed, newPassword, vaultSalt, await serverUnwrapSeed(account.server_wrapped_seed, env))) return json({ error: "新密码设置失败，请重试" }, 400);
    const record = await passwordRecord(newPassword); await db.prepare("UPDATE identities SET password_hash = ?, password_salt = ?, vault_salt = ?, password_params = ?, password_wrapped_seed = ? WHERE code = ?").bind(record.hash, record.salt, vaultSalt, record.params, passwordWrappedSeed, account.code).run(); await revokeSessions(db, account.code); const token = await issueSession(db, account.code); const next = await db.prepare("SELECT * FROM identities WHERE code = ?").bind(account.code).first(); return json({ account: publicAccount(next) }, 200, { "Set-Cookie": sessionCookie(token, request) });
  }
  if (request.method === "POST" && pathname === "/api/auth/reset") {
    const { username, resetCode, newPassword } = await bodyFrom(request); const key = failureKey(request, username); if (isRateLimited(key)) return json({ error: "尝试过于频繁，请稍后再试" }, 429); const account = await db.prepare("SELECT * FROM identities WHERE username_normalized = ?").bind(normalizeUsername(username)).first(); if (!account || !validPassword(newPassword)) { recordFailure(key); return json({ error: "请检查用户名和新密码" }, 400); }
    if (account.status !== "enabled") return json({ error: "账号已禁用" }, 403);
    const resetCodeHash = await sha256(String(resetCode || ""));
    const seed = await serverUnwrapSeed(account.server_wrapped_seed, env); const record = await passwordRecord(newPassword); const vaultSalt = randomB64(16); const wrapped = await vaultWrap(seed, newPassword, vaultSalt);
    const claimed = await db.prepare("UPDATE password_reset_codes SET used_at = CURRENT_TIMESTAMP WHERE code_hash = ? AND identity_code = ? AND used_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP").bind(resetCodeHash, account.code).run();
    if (!claimed.meta.changes) { recordFailure(key); return json({ error: "重置码无效或已过期" }, 400); }
    await db.batch([db.prepare("UPDATE identities SET password_hash = ?, password_salt = ?, vault_salt = ?, password_params = ?, password_wrapped_seed = ? WHERE code = ?").bind(record.hash, record.salt, vaultSalt, record.params, wrapped, account.code), db.prepare("DELETE FROM sessions WHERE identity_code = ?").bind(account.code)]);
    clearFailure(key); const token = await issueSession(db, account.code); const next = await db.prepare("SELECT * FROM identities WHERE code = ?").bind(account.code).first(); return json({ account: publicAccount(next) }, 200, { "Set-Cookie": sessionCookie(token, request) });
  }
  return null;
}
async function vaultWrap(seed, password, salt) { const key = await crypto.subtle.importKey("raw", await pbkdf2(password, salt), "AES-GCM", false, ["encrypt"]); const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(seed))); const packed = new Uint8Array(iv.length + encrypted.length); packed.set(iv); packed.set(encrypted, iv.length); return `rtvault:v1:${b64(packed)}`; }
async function vaultUnwrap(wrapped, password, salt) {
  if (!String(wrapped || "").startsWith("rtvault:v1:")) throw new Error("保险箱格式无效");
  const packed = unb64(String(wrapped).slice("rtvault:v1:".length));
  if (packed.length < 29) throw new Error("保险箱内容无效");
  const key = await crypto.subtle.importKey("raw", await pbkdf2(password, salt), "AES-GCM", false, ["decrypt"]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, key, packed.slice(12)));
}

async function adminApi(request, env, pathname) {
  if (!await adminAuthorized(request, env)) return json({ error: "管理员身份验证失败" }, 401); const db = env.DB;
  if (request.method === "GET" && pathname === "/api/admin/users") { const { results } = await db.prepare("SELECT identities.code, identities.username, identities.status, identities.created_at, identities.upgraded_at, COUNT(tasks.id) AS task_count FROM identities LEFT JOIN tasks ON tasks.identity_code = identities.code GROUP BY identities.code ORDER BY identities.created_at DESC").all(); return json({ users: results.map((row) => ({ ...row, task_count: Number(row.task_count || 0), legacy: !row.username })) }); }
  const match = pathname.match(/^\/api\/admin\/users\/([^/]+)(?:\/(reset))?$/); if (match && request.method === "PATCH" && !match[2]) { const { status } = await bodyFrom(request); if (!new Set(["enabled", "disabled"]).has(status)) return json({ error: "账号状态无效" }, 400); const result = await db.prepare("UPDATE identities SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE code = ?").bind(status, match[1]).run(); if (!result.meta.changes) return json({ error: "用户不存在" }, 404); if (status === "disabled") await revokeSessions(db, match[1]); return json({ ok: true }); }
  if (match && match[2] && request.method === "POST") { const user = await db.prepare("SELECT username FROM identities WHERE code = ?").bind(match[1]).first(); if (!user?.username) return json({ error: "旧身份码尚未升级，无法重置密码" }, 400); await db.prepare("DELETE FROM password_reset_codes WHERE identity_code = ?").bind(match[1]).run(); const code = randomB64(24).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); await db.prepare("INSERT INTO password_reset_codes (code_hash, identity_code, expires_at) VALUES (?, ?, ?)").bind(await sha256(code), match[1], new Date(Date.now() + RESET_MINUTES * 60_000).toISOString()).run(); await revokeSessions(db, match[1]); return json({ resetCode: code, expiresInMinutes: RESET_MINUTES }); }
  return json({ error: "未找到管理接口" }, 404);
}

async function taskApi(request, env, url, account) {
  const db = env.DB, identity = account.code, { pathname } = url;
  if (request.method === "GET" && pathname === "/api/tasks") { const { results } = await db.prepare("SELECT * FROM tasks WHERE identity_code = ? ORDER BY id DESC").bind(identity).all(); return json({ tasks: results.map(taskFromRow) }); }
  if (request.method === "POST" && pathname === "/api/tasks") { const task = sanitizeTask(await bodyFrom(request)); const result = await db.prepare("INSERT INTO tasks (identity_code, title, color, tags, details, status, due_date, pinned, pinned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END)").bind(identity, task.title, task.color, JSON.stringify(task.tags), task.details, task.status, task.dueDate, task.pinned ? 1 : 0, task.pinned ? 1 : 0).run(); return json({ task: await taskById(db, Number(result.meta.last_row_id), identity) }, 201); }
  if (request.method === "POST" && pathname === "/api/tasks/encrypt") {
    const { tasks } = await bodyFrom(request);
    if (!Array.isArray(tasks) || !tasks.length || tasks.length > 50) return json({ error: "任务密文数据无效" }, 400);
    const encrypted = tasks.map(sanitizeEncryptedTaskContent);
    const ids = encrypted.map((task) => task.id);
    if (new Set(ids).size !== ids.length) return json({ error: "任务密文数据重复" }, 400);
    await db.batch(encrypted.map((task) => db.prepare("UPDATE tasks SET title = ?, details = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?").bind(task.title, task.details, task.id, identity)));
    return json({ ok: true });
  }
  if (request.method === "POST" && pathname === "/api/tasks/reorder") {
    const { ids, pinnedIds, completed } = await bodyFrom(request);
    if (!Array.isArray(ids)) return json({ error: "排序数据无效" }, 400);
    const normalized = ids.map(Number);
    const { results } = await db.prepare("SELECT id FROM tasks WHERE identity_code = ?" + (typeof completed === "boolean" ? " AND completed = ?" : "")).bind(identity, ...(typeof completed === "boolean" ? [completed ? 1 : 0] : [])).all();
    const owned = results.map((row) => Number(row.id));
    if (normalized.length !== owned.length || new Set(normalized).size !== normalized.length || normalized.some((id) => !owned.includes(id))) return json({ error: "排序数据不完整" }, 400);
    if (typeof completed === "boolean" && Array.isArray(pinnedIds)) {
      const normalizedPins = pinnedIds.map(Number);
      if (new Set(normalizedPins).size !== normalizedPins.length || normalizedPins.some((id) => !normalized.includes(id))) return json({ error: "置顶排序数据无效" }, 400);
      const pins = new Set(normalizedPins);
      await db.batch(normalized.map((id, index) => db.prepare("UPDATE tasks SET manual_position = ?, pinned = ?, pinned_at = CASE WHEN ? = 0 THEN NULL WHEN pinned = 0 OR pinned_at IS NULL THEN CURRENT_TIMESTAMP ELSE pinned_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ? AND completed = ?").bind(index + 1, pins.has(id) ? 1 : 0, pins.has(id) ? 1 : 0, id, identity, completed ? 1 : 0)));
    } else {
      await db.batch(normalized.map((id, index) => db.prepare("UPDATE tasks SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?").bind(index + 1, id, identity)));
    }
    return json({ ok: true });
  }
  const id = taskIdFrom(pathname); if (!id) return json({ error: "未找到接口" }, 404);
  if (request.method === "PUT") { const task = sanitizeTask(await bodyFrom(request)); const result = await db.prepare("UPDATE tasks SET title = ?, color = ?, tags = ?, details = ?, status = ?, due_date = ?, pinned = ?, pinned_at = CASE WHEN ? = 0 THEN NULL WHEN pinned_at IS NULL THEN CURRENT_TIMESTAMP ELSE pinned_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?").bind(task.title, task.color, JSON.stringify(task.tags), task.details, task.status, task.dueDate, task.pinned ? 1 : 0, task.pinned ? 1 : 0, id, identity).run(); return result.meta.changes ? json({ task: await taskById(db, id, identity) }) : json({ error: "事项不存在" }, 404); }
  if (request.method === "PATCH") { const { completed, status } = await bodyFrom(request); let result; if (typeof completed === "boolean") result = await db.prepare("UPDATE tasks SET completed = ?, completed_at = ?, status = CASE WHEN ? THEN 'none' ELSE status END, manual_position = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?").bind(completed ? 1 : 0, completed ? new Date().toISOString() : null, completed ? 1 : 0, id, identity).run(); else if (STATUSES.has(status)) result = await db.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?").bind(status, id, identity).run(); else return json({ error: "任务状态无效" }, 400); return result.meta.changes ? json({ task: await taskById(db, id, identity) }) : json({ error: "事项不存在" }, 404); }
  if (request.method === "DELETE") { const result = await db.prepare("DELETE FROM tasks WHERE id = ? AND identity_code = ?").bind(id, identity).run(); return result.meta.changes ? json({ ok: true }) : json({ error: "事项不存在" }, 404); }
  return json({ error: "未找到接口" }, 404);
}

async function api(request, env, url) {
  const { pathname } = url;
  if (request.method === "POST" && pathname === "/api/admin/login") return await adminAuthorized(request, env) ? json({ ok: true }) : json({ error: "管理员密码错误" }, 401);
  if (pathname.startsWith("/api/admin/")) return adminApi(request, env, pathname);
  if (pathname.startsWith("/api/auth/")) { const response = await authApi(request, env, url); if (response) return response; }
  const account = await accountFromSession(request, env.DB); if (!account) return json({ error: "请登录" }, 401, { "Set-Cookie": clearSessionCookie(request) }); if (account.status !== "enabled") return json({ error: "账号已禁用" }, 403);
  return taskApi(request, env, url, account);
}

export default { async fetch(request, env) { const url = new URL(request.url); try { if (url.pathname.startsWith("/api/")) return await api(request, env, url); if (url.pathname === "/console") return Response.redirect(`${url.origin}/console/`, 308); return env.ASSETS.fetch(request); } catch (error) { console.error(error); return json({ error: error instanceof Error ? error.message : "服务器暂时不可用" }, 500); } } };
