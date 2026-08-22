const COLORS = new Set(["violet", "mint", "orange", "blue", "rose"]);
const STATUSES = new Set(["none", "in_progress", "paused"]);
const USERNAME_PATTERN = /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_]{1,9}$/u;
const ENCRYPTION_PREFIX_V2 = "rtenc:v2:";
const ENCRYPTED_VALUE_PATTERN = /^rtenc:v2:[A-Za-z0-9+/]+={0,2}$/;
const ENCRYPTION_SALT_V2 = "RabbitToDo task content v2";
const ENCRYPTION_INFO_V2 = "task-content";
// Cloudflare Workers rejects PBKDF2 iteration counts above 100,000.
const PASSWORD_ITERATIONS = 100_000;
const PASSWORD_VERSION = "pbkdf2-sha256-v1";
const SESSION_DAYS = 180;
const RESET_MINUTES = 15;
const DEFAULT_ADMIN_SALT = "RabbitToDo admin fallback v1";
const DEFAULT_ADMIN_HASH = "CKOSDMM91UVxeB5EUIv4UPUGwJpZlYnKi5CPg4dkQjc=";
const authFailures = new Map();

const encoder = new TextEncoder();
function json(data, status = 200, headers = {}) { return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } }); }
function b64(bytes) { let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(binary); }
function randomB64(size = 32) { return b64(crypto.getRandomValues(new Uint8Array(size))); }
function randomIdentityCode() { return `u_${randomB64(32).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`; }
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
function cookieExpires(maxAge = SESSION_DAYS * 86400) { return new Date(Date.now() + maxAge * 1000).toUTCString(); }
function sessionCookie(token, request, maxAge = SESSION_DAYS * 86400) { return `rabbittodo_session=${token}; Path=/; HttpOnly; SameSite=Lax${cookieSecurity(request)}; Max-Age=${maxAge}; Expires=${cookieExpires(maxAge)}`; }
function clearSessionCookie(request) { return `rabbittodo_session=; Path=/; HttpOnly; SameSite=Lax${cookieSecurity(request)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`; }
function expiry(days = SESSION_DAYS) { return new Date(Date.now() + days * 86400_000).toISOString(); }
async function bodyFrom(request) { const raw = await request.text(); if (raw.length > 10_000_000) throw new Error("请求内容过大"); try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error("请求格式无效"); } }
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
function themeColor(value) { return COLORS.has(String(value || "")) ? String(value) : "violet"; }
function taskSortMode(value) { return value === "auto" ? "auto" : "manual"; }
function publicAccount(row, includeSeed = true) { return { username: row.username, themeColor: themeColor(row.theme_color), taskSortMode: taskSortMode(row.task_sort_mode), ...(includeSeed ? { encryptionSeed: row.code } : {}) }; }
function taskFromRow(row) { if (!row) return null; const { identity_code, reminder_at, reminder_tz, reminder_repeat_rule, reminder_enabled, ...task } = row; let tags = []; try { tags = JSON.parse(task.tags || "[]"); } catch {} return { ...task, completed: Boolean(task.completed), pinned: Boolean(task.pinned), tags, details: task.details || "", status: task.status || "none", reminder: reminderPublic({ reminder_at, reminder_tz, reminder_repeat_rule, reminder_enabled }) }; }
function validEncryptedTaskText(value) { try { return ENCRYPTED_VALUE_PATTERN.test(value) && b64urlDecode(value.slice(ENCRYPTION_PREFIX_V2.length)).length >= 29; } catch { return false; } }
function sanitizeTaskText(value, { field, encryptedLimit, required = false }) { const raw = String(value || "").trim(); if (!raw) { if (required) throw new Error(`请填写${field}`); return ""; } if (raw.length > encryptedLimit || !validEncryptedTaskText(raw)) throw new Error(`${field}必须使用 rtenc:v2 加密`); return raw; }
function sanitizeTask(input) { const title = sanitizeTaskText(input.title, { field: "事项名称", encryptedLimit: 4096, required: true }); const color = COLORS.has(input.color) ? input.color : "violet"; const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map((tag) => String(tag).trim().replace(/^#/, "")).filter(Boolean))].slice(0, 12) : []; const details = sanitizeTaskText(input.details, { field: "任务详情", encryptedLimit: 16000 }); const status = STATUSES.has(input.status) ? input.status : "none"; const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate || "")) ? input.dueDate : null; return { title, color, tags, details, status, dueDate, pinned: Boolean(input.pinned) }; }
function taskIdFrom(pathname) { return Number(pathname.match(/^\/api\/tasks\/(\d+)$/)?.[1] || 0) || null; }
async function taskById(db, id, identity) { return taskFromRow(await db.prepare("SELECT t.*, r.remind_at AS reminder_at, r.tz AS reminder_tz, r.repeat_rule AS reminder_repeat_rule, r.enabled AS reminder_enabled FROM tasks t LEFT JOIN task_reminders r ON r.task_id = t.id AND r.identity_code = t.identity_code WHERE t.id = ? AND t.identity_code = ?").bind(id, identity).first()); }

async function issueSession(db, identityCode) { const token = randomB64(32); await db.prepare("INSERT INTO sessions (token_hash, identity_code, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), identityCode, expiry()).run(); return token; }
async function accountFromSession(request, db) { const token = cookieValue(request, "rabbittodo_session"); if (!token) return null; const row = await db.prepare("SELECT identities.* FROM sessions JOIN identities ON identities.code = sessions.identity_code WHERE sessions.token_hash = ? AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP").bind(await sha256(token)).first(); return row?.status === "enabled" && row.username ? row : null; }
async function revokeSessions(db, code) { await db.prepare("DELETE FROM sessions WHERE identity_code = ?").bind(code).run(); }
async function adminAuthorized(request, env) { const supplied = String(request.headers.get("X-Admin-Password") || ""); if (!supplied) return false; if (env.ADMIN_PASSWORD) return timingSafeEqual(supplied, String(env.ADMIN_PASSWORD)); const hash = b64(await pbkdf2(supplied, DEFAULT_ADMIN_SALT)); return timingSafeEqual(hash, DEFAULT_ADMIN_HASH); }

// --- 提醒与 Web Push ---
const REMINDER_FREQUENCIES = new Set(["none", "daily", "weekly", "monthly"]);
const SUPPORTED_TIME_ZONES = new Set(["Asia/Shanghai"]);

function b64urlEncode(bytes) { return b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function b64urlDecode(value) {
  const str = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function concatBytes(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) { result.set(arr, offset); offset += arr.length; }
  return result;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt instanceof Uint8Array ? salt : encoder.encode(salt), info: info instanceof Uint8Array ? info : encoder.encode(info) }, key, length * 8));
}

async function webPushEncrypt(subscription, payload) {
  const clientPublicKey = b64urlDecode(subscription.p256dh);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const importedClientKey = await crypto.subtle.importKey("raw", clientPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: importedClientKey }, ephemeral.privateKey, 256));
  const authSecret = b64urlDecode(subscription.auth);
  const ephemeralPub = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  // RFC 8291 Web Push：IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_pub || as_pub)
  const ikm = await hkdf(authSecret, sharedSecret, concatBytes(encoder.encode("WebPush: info\0"), clientPublicKey, ephemeralPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  // RFC 8188 aes128gcm：key/nonce 的 info 只含编码名，不再拼接 ephemeral 公钥
  const key = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const plaintext = concatBytes(encoder.encode(payload), new Uint8Array([2]));
  // 与 web-push/http_ece 一致：record 只装数据与 0x02 分隔符，不做 4096 整块填充，请求体远小于 Apple 约 4KB 上限。
  const recordSize = Math.min(3994, Math.max(18, plaintext.length));
  const padded = concatBytes(plaintext, new Uint8Array(recordSize - plaintext.length));
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, padded));
  const header = new Uint8Array(16 + 4 + 1 + ephemeralPub.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = ephemeralPub.length;
  header.set(ephemeralPub, 21);
  return concatBytes(header, ciphertext);
}

async function vapidAuthorization(endpoint, env) {
  const audience = new URL(endpoint).origin;
  const header = b64urlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(encoder.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:rabbittodo@srabbitwork.site" })));
  const signingInput = `${header}.${payload}`;
  const privateKey = await crypto.subtle.importKey("pkcs8", b64urlDecode(env.VAPID_PRIVATE_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = b64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(signingInput))));
  return `vapid t=${signingInput}.${signature}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function sendWebPush(subscription, payload, env, timeoutMs) {
  if (!env?.VAPID_PRIVATE_KEY || !env?.VAPID_PUBLIC_KEY) return "unconfigured";
  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const body = await webPushEncrypt(subscription, payload);
    const authorization = await vapidAuthorization(subscription.endpoint, env);
    const response = await fetch(subscription.endpoint, { method: "POST", headers: { Authorization: authorization, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Ttl: "86400" }, body, signal: controller?.signal });
    if (response.ok || response.status === 201 || response.status === 202) return "sent";
    // 推送服务对无效/过期订阅返回 404/410，可安全清理。
    if (response.status === 404 || response.status === 410) return "gone";
    console.warn("sendWebPush failed:", response.status, response.statusText);
    return "failed";
  } catch (error) {
    if (controller?.signal.aborted) console.warn("sendWebPush timeout:", subscription.endpoint.slice(0, 60));
    else console.error("sendWebPush error", error);
    return "failed";
  } finally { if (timer) clearTimeout(timer); }
}

function sanitizeReminder(input) {
  const raw = String(input?.reminderAt || "");
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error("提醒时间无效");
  // 当前仅支持上海时区；未知时区一律回退到上海，避免 Intl 抛错导致 500。
  const tz = SUPPORTED_TIME_ZONES.has(String(input?.tz)) ? String(input.tz) : "Asia/Shanghai";
  const rule = input?.repeatRule || { freq: "none" };
  const freq = REMINDER_FREQUENCIES.has(rule?.freq) ? rule.freq : "none";
  return { remindAt: parsed.toISOString(), tz, repeatRule: { freq } };
}

// 把 tz 本地时间字符串转成 UTC ISO（用 Intl 反推偏移，兼容夏令时）。
function localToUtc(localStr, tz) {
  const [datePart, timePart] = localStr.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = (timePart || "0:0").split(":").map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const o = {};
  for (const p of dtf.formatToParts(new Date(asUtc))) o[p.type] = p.value;
  const localTs = Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), Number(o.hour === "24" ? 0 : o.hour), Number(o.minute), 0);
  return new Date(asUtc - (localTs - asUtc)).toISOString();
}

function addMonthsInTz(utcIso, tz, months) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const o = {};
  for (const p of dtf.formatToParts(new Date(utcIso))) o[p.type] = p.value;
  const year = Number(o.year);
  const month = Number(o.month) - 1;
  const day = Number(o.day);
  const hour = Number(o.hour === "24" ? 0 : o.hour);
  const minute = Number(o.minute);
  const total = year * 12 + month + months;
  return localToUtc(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, tz);
}

// 计算下一次触发时间（UTC ISO）。返回 null 表示不再触发（none 且已过）。
function computeNextFireAt(remindAt, tz, repeatRule) {
  const now = Date.now();
  const base = Date.parse(remindAt);
  if (Number.isNaN(base)) return null;
  const freq = repeatRule?.freq || "none";
  if (freq === "none") return base > now ? new Date(base).toISOString() : null;
  if (base >= now) return new Date(base).toISOString();
  const stepMs = freq === "daily" ? 86_400_000 : freq === "weekly" ? 604_800_000 : null;
  if (stepMs) {
    const steps = Math.floor((now - base) / stepMs);
    let candidate = base + steps * stepMs;
    while (candidate <= now) candidate += stepMs;
    return new Date(candidate).toISOString();
  }
  if (freq === "monthly") {
    let candidate = new Date(base).toISOString();
    let guard = 0;
    while (Date.parse(candidate) <= now && guard < 600) { candidate = addMonthsInTz(candidate, tz, 1); guard += 1; }
    return guard < 600 ? candidate : null;
  }
  return null;
}

function reminderPublic(row) {
  if (!row || !row.reminder_at) return null;
  let rule = { freq: "none" };
  try { rule = JSON.parse(row.reminder_repeat_rule || "{\"freq\":\"none\"}"); } catch {}
  return { remindAt: row.reminder_at, tz: row.reminder_tz, repeatRule: rule, enabled: Boolean(row.reminder_enabled) };
}

// 写入一条提醒（upsert），并计算 next_fire_at。
// 不重复且时间已过的提醒会立即排入下一次 Cron，触发一次后自动停用。
async function upsertReminder(db, identity, taskId, reminder) {
  const next = computeNextFireAt(reminder.remindAt, reminder.tz, reminder.repeatRule);
  const reminderId = `r_${b64(crypto.getRandomValues(new Uint8Array(16))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
  await db.prepare("DELETE FROM task_reminders WHERE identity_code = ? AND task_id = ?").bind(identity, taskId).run();
  await db.prepare("INSERT INTO task_reminders (reminder_id, identity_code, task_id, remind_at, tz, repeat_rule, next_fire_at, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").bind(reminderId, identity, taskId, reminder.remindAt, reminder.tz, JSON.stringify(reminder.repeatRule), next || new Date().toISOString()).run();
}

// 推送瞬间临时解密 rtenc:v2 标题；格式或解密异常时回退通用文案。
async function decryptTaskTitle(title, identityCode) {
  const stored = String(title || "");
  if (!stored.startsWith(ENCRYPTION_PREFIX_V2)) return null;
  try {
    const key = await hkdf(ENCRYPTION_SALT_V2, b64urlDecode(String(identityCode || "").replace(/^u_/, "")), ENCRYPTION_INFO_V2, 32);
    const packed = b64urlDecode(stored.slice(ENCRYPTION_PREFIX_V2.length));
    const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, cryptoKey, packed.slice(12));
    return new TextDecoder().decode(decrypted) || null;
  } catch {
    return null;
  }
}

async function fireDueReminders(env) {
  const db = env.DB;
  const now = new Date().toISOString();
  // 已完成任务不再推送提醒；防御性 JOIN，避免历史遗留的已完成任务提醒继续触发。
  const { results } = await db.prepare("SELECT r.*, t.title AS task_title FROM task_reminders r JOIN tasks t ON t.id = r.task_id AND t.identity_code = r.identity_code WHERE r.enabled = 1 AND r.next_fire_at <= ? AND t.completed = 0").bind(now).all();
  for (const reminder of results) {
    const { results: subs } = await db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE identity_code = ?").bind(reminder.identity_code).all();
    let rule = { freq: "none" };
    try { rule = JSON.parse(reminder.repeat_rule || "{\"freq\":\"none\"}"); } catch {}
    const taskTitle = await decryptTaskTitle(reminder.task_title, reminder.identity_code);
    const payload = taskTitle ? { title: taskTitle, body: "提醒时间到啦" } : { title: "RabbitToDo", body: "你有一条待办提醒" };
    let delivered = false;
    const gone = [];
    for (const sub of subs) {
      const outcome = await sendWebPush(sub, JSON.stringify(payload), env);
      if (outcome === "sent") delivered = true;
      else if (outcome === "gone") gone.push(sub.endpoint);
    }
    if (gone.length) {
      await db.prepare(`DELETE FROM push_subscriptions WHERE identity_code = ? AND endpoint IN (${gone.map(() => "?").join(",")})`).bind(reminder.identity_code, ...gone).run();
    }
    // 有订阅但推送失败时保留 next_fire_at，由下一次 Cron 继续重试，避免提醒丢失。
    // 无订阅（subs.length === 0）时没有可送达设备，重试只会让每条过期提醒每分钟空转、放大 D1 读取；
    // 页面打开时的提醒由前端本地横幅负责（public/app.js checkDueReminders），此处按已处理推进/停用。
    if (!delivered && subs.length > 0) continue;
    const next = computeNextFireAt(reminder.remind_at, reminder.tz, rule);
    if (next) await db.prepare("UPDATE task_reminders SET next_fire_at = ?, last_fired_at = ?, updated_at = CURRENT_TIMESTAMP WHERE reminder_id = ?").bind(next, now, reminder.reminder_id).run();
    else await db.prepare("UPDATE task_reminders SET enabled = 0, last_fired_at = ?, updated_at = CURRENT_TIMESTAMP WHERE reminder_id = ?").bind(now, reminder.reminder_id).run();
  }
}

async function authApi(request, env, url) {
  const db = env.DB; const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/auth/session") {
    const account = await accountFromSession(request, db);
    if (!account) return json({ error: "请登录" }, 401);
    const token = cookieValue(request, "rabbittodo_session");
    // A foreground launch refreshes the same device session without invalidating other devices.
    await db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(expiry(), await sha256(token)).run();
    return json({ account: publicAccount(account) }, 200, { "Set-Cookie": sessionCookie(token, request) });
  }
  if (request.method === "POST" && pathname === "/api/auth/register") {
    const { username, password } = await bodyFrom(request); const display = String(username || "").normalize("NFKC").trim(); const normalized = normalizeUsername(display);
    if (!validUsername(display)) return json({ error: "用户名为 2-10 个字符，须以中文或英文开头" }, 400);
    if (!validPassword(password)) return json({ error: "密码至少 8 位" }, 400);
    const existing = await db.prepare("SELECT code FROM identities WHERE username_normalized = ?").bind(normalized).first(); if (existing) return json({ error: "用户名已存在，请直接登录" }, 409);
    const record = await passwordRecord(password); let code = "";
    for (let attempts = 0; attempts < 10 && !code; attempts += 1) {
      const candidate = randomIdentityCode();
      try { await db.prepare("INSERT INTO identities (code, status, username, username_normalized, password_hash, password_salt, password_params) VALUES (?, 'enabled', ?, ?, ?, ?, ?)").bind(candidate, display, normalized, record.hash, record.salt, record.params).run(); code = candidate; }
      catch (error) { const message = String(error); if (message.includes("identities.username_normalized")) return json({ error: "用户名已存在，请直接登录" }, 409); if (!message.includes("identities.code")) throw error; }
    }
    if (!code) return json({ error: "创建账号失败，请重试" }, 503);
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
  if (request.method === "PATCH" && pathname === "/api/auth/preferences") {
    const account = await accountFromSession(request, db); if (!account) return json({ error: "请登录" }, 401);
    const preferences = await bodyFrom(request);
    const hasTheme = Object.prototype.hasOwnProperty.call(preferences, "themeColor");
    const hasSortMode = Object.prototype.hasOwnProperty.call(preferences, "taskSortMode");
    if (!hasTheme && !hasSortMode) return json({ error: "未提供可保存的偏好" }, 400);
    if (hasTheme && !COLORS.has(String(preferences.themeColor || ""))) return json({ error: "主题颜色无效" }, 400);
    if (hasSortMode && !["manual", "auto"].includes(String(preferences.taskSortMode || ""))) return json({ error: "排序方式无效" }, 400);
    if (hasTheme && hasSortMode) await db.prepare("UPDATE identities SET theme_color = ?, task_sort_mode = ? WHERE code = ?").bind(preferences.themeColor, preferences.taskSortMode, account.code).run();
    else if (hasTheme) await db.prepare("UPDATE identities SET theme_color = ? WHERE code = ?").bind(preferences.themeColor, account.code).run();
    else await db.prepare("UPDATE identities SET task_sort_mode = ? WHERE code = ?").bind(preferences.taskSortMode, account.code).run();
    const next = await db.prepare("SELECT * FROM identities WHERE code = ?").bind(account.code).first();
    return json({ account: publicAccount(next) });
  }
  if (request.method === "POST" && pathname === "/api/auth/password") {
    const account = await accountFromSession(request, db); if (!account) return json({ error: "请登录" }, 401); const { currentPassword, newPassword } = await bodyFrom(request);
    if (!await passwordMatches(String(currentPassword || ""), account)) return json({ error: "当前密码错误" }, 401); if (!validPassword(newPassword)) return json({ error: "新密码至少 8 位" }, 400);
    const record = await passwordRecord(newPassword); await db.prepare("UPDATE identities SET password_hash = ?, password_salt = ?, password_params = ? WHERE code = ?").bind(record.hash, record.salt, record.params, account.code).run(); await revokeSessions(db, account.code); const token = await issueSession(db, account.code); const next = await db.prepare("SELECT * FROM identities WHERE code = ?").bind(account.code).first(); return json({ account: publicAccount(next) }, 200, { "Set-Cookie": sessionCookie(token, request) });
  }
  if (request.method === "POST" && pathname === "/api/auth/reset") {
    const { username, resetCode, newPassword } = await bodyFrom(request); const key = failureKey(request, username); if (isRateLimited(key)) return json({ error: "尝试过于频繁，请稍后再试" }, 429); const account = await db.prepare("SELECT * FROM identities WHERE username_normalized = ?").bind(normalizeUsername(username)).first(); if (!account || !validPassword(newPassword)) { recordFailure(key); return json({ error: "请检查用户名和新密码" }, 400); }
    if (account.status !== "enabled") return json({ error: "账号已禁用" }, 403);
    const resetCodeHash = await sha256(String(resetCode || ""));
    const record = await passwordRecord(newPassword);
    const claimed = await db.prepare("UPDATE password_reset_codes SET used_at = CURRENT_TIMESTAMP WHERE code_hash = ? AND identity_code = ? AND used_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP").bind(resetCodeHash, account.code).run();
    if (!claimed.meta.changes) { recordFailure(key); return json({ error: "重置码无效或已过期" }, 400); }
    await db.batch([db.prepare("UPDATE identities SET password_hash = ?, password_salt = ?, password_params = ? WHERE code = ?").bind(record.hash, record.salt, record.params, account.code), db.prepare("DELETE FROM sessions WHERE identity_code = ?").bind(account.code)]);
    clearFailure(key); const token = await issueSession(db, account.code); const next = await db.prepare("SELECT * FROM identities WHERE code = ?").bind(account.code).first(); return json({ account: publicAccount(next) }, 200, { "Set-Cookie": sessionCookie(token, request) });
  }
  return null;
}

async function adminApi(request, env, pathname) {
  if (!await adminAuthorized(request, env)) return json({ error: "管理员身份验证失败" }, 401); const db = env.DB;
  if (request.method === "GET" && pathname === "/api/admin/users") { const { results } = await db.prepare("SELECT identities.code, identities.username, identities.status, identities.created_at, COUNT(tasks.id) AS task_count FROM identities LEFT JOIN tasks ON tasks.identity_code = identities.code GROUP BY identities.code ORDER BY identities.created_at DESC").all(); return json({ users: results.map((row) => ({ ...row, task_count: Number(row.task_count || 0) })) }); }
  const match = pathname.match(/^\/api\/admin\/users\/([^/]+)(?:\/(reset))?$/); if (match && request.method === "PATCH" && !match[2]) { const { status } = await bodyFrom(request); if (!new Set(["enabled", "disabled"]).has(status)) return json({ error: "账号状态无效" }, 400); const result = await db.prepare("UPDATE identities SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE code = ?").bind(status, match[1]).run(); if (!result.meta.changes) return json({ error: "用户不存在" }, 404); if (status === "disabled") await revokeSessions(db, match[1]); return json({ ok: true }); }
  if (match && match[2] && request.method === "POST") { const user = await db.prepare("SELECT code FROM identities WHERE code = ?").bind(match[1]).first(); if (!user) return json({ error: "用户不存在" }, 404); await db.prepare("DELETE FROM password_reset_codes WHERE identity_code = ?").bind(match[1]).run(); const code = randomB64(24).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); await db.prepare("INSERT INTO password_reset_codes (code_hash, identity_code, expires_at) VALUES (?, ?, ?)").bind(await sha256(code), match[1], new Date(Date.now() + RESET_MINUTES * 60_000).toISOString()).run(); await revokeSessions(db, match[1]); return json({ resetCode: code, expiresInMinutes: RESET_MINUTES }); }
  return json({ error: "未找到管理接口" }, 404);
}

async function taskApi(request, env, url, account) {
  const db = env.DB, identity = account.code, { pathname } = url;
  if (request.method === "GET" && pathname === "/api/tasks") { const { results } = await db.prepare("SELECT t.*, r.remind_at AS reminder_at, r.tz AS reminder_tz, r.repeat_rule AS reminder_repeat_rule, r.enabled AS reminder_enabled FROM tasks t LEFT JOIN task_reminders r ON r.task_id = t.id AND r.identity_code = t.identity_code WHERE t.identity_code = ? ORDER BY t.id DESC").bind(identity).all(); return json({ tasks: results.map(taskFromRow) }); }
  if (request.method === "POST" && pathname === "/api/tasks") {
    const body = await bodyFrom(request);
    const task = sanitizeTask(body);
    const reminder = body.reminderAt ? sanitizeReminder(body) : null;
    const mutationId = String(request.headers.get("X-RabbitTodo-Mutation") || "");
    if (mutationId && !/^[A-Za-z0-9_-]{16,128}$/.test(mutationId)) return json({ error: "同步操作编号无效" }, 400);
    if (mutationId) {
      const existing = await db.prepare("SELECT t.*, r.remind_at AS reminder_at, r.tz AS reminder_tz, r.repeat_rule AS reminder_repeat_rule, r.enabled AS reminder_enabled FROM tasks t LEFT JOIN task_reminders r ON r.task_id = t.id AND r.identity_code = t.identity_code WHERE t.identity_code = ? AND t.client_mutation_id = ?").bind(identity, mutationId).first();
      if (existing) return json({ task: taskFromRow(existing), replayed: true });
    }
    try {
      const result = await db.prepare("INSERT INTO tasks (identity_code, title, color, tags, details, status, due_date, pinned, pinned_at, client_mutation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, ?)").bind(identity, task.title, task.color, JSON.stringify(task.tags), task.details, task.status, task.dueDate, task.pinned ? 1 : 0, task.pinned ? 1 : 0, mutationId || null).run();
      const newId = Number(result.meta.last_row_id);
      if (reminder) {
        try { await upsertReminder(db, identity, newId, reminder); }
        catch (error) {
          // 提醒写入失败时回滚任务，避免客户端重试时拿到"无提醒"的已完成任务并覆盖本地提醒。
          await db.prepare("DELETE FROM tasks WHERE id = ? AND identity_code = ?").bind(newId, identity).run();
          throw error;
        }
      }
      return json({ task: await taskById(db, newId, identity) }, 201);
    } catch (error) {
      if (!mutationId || !String(error).includes("tasks.identity_code, tasks.client_mutation_id")) throw error;
      const existing = await db.prepare("SELECT t.*, r.remind_at AS reminder_at, r.tz AS reminder_tz, r.repeat_rule AS reminder_repeat_rule, r.enabled AS reminder_enabled FROM tasks t LEFT JOIN task_reminders r ON r.task_id = t.id AND r.identity_code = t.identity_code WHERE t.identity_code = ? AND t.client_mutation_id = ?").bind(identity, mutationId).first();
      if (!existing) throw error;
      return json({ task: taskFromRow(existing), replayed: true });
    }
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
  if (request.method === "PUT") {
    const body = await bodyFrom(request);
    const task = sanitizeTask(body);
    const result = await db.prepare("UPDATE tasks SET title = ?, color = ?, tags = ?, details = ?, status = ?, due_date = ?, pinned = ?, pinned_at = CASE WHEN ? = 0 THEN NULL WHEN pinned_at IS NULL THEN CURRENT_TIMESTAMP ELSE pinned_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?").bind(task.title, task.color, JSON.stringify(task.tags), task.details, task.status, task.dueDate, task.pinned ? 1 : 0, task.pinned ? 1 : 0, id, identity).run();
    if (!result.meta.changes) return json({ error: "事项不存在" }, 404);
    if (body.reminderAt) await upsertReminder(db, identity, id, sanitizeReminder(body));
    else if ("reminderAt" in body) await db.prepare("DELETE FROM task_reminders WHERE identity_code = ? AND task_id = ?").bind(identity, id).run();
    return json({ task: await taskById(db, id, identity) });
  }
  if (request.method === "PATCH") {
    const { completed, status } = await bodyFrom(request);
    let result;
    if (typeof completed === "boolean") {
      result = await db.prepare("UPDATE tasks SET completed = ?, completed_at = ?, status = CASE WHEN ? THEN 'none' ELSE status END, manual_position = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?").bind(completed ? 1 : 0, completed ? new Date().toISOString() : null, completed ? 1 : 0, id, identity).run();
      // 完成任务即视为已处理：删除其提醒，避免继续推送或残留无效记录。
      if (result.meta.changes && completed) await db.prepare("DELETE FROM task_reminders WHERE identity_code = ? AND task_id = ?").bind(identity, id).run();
    } else if (STATUSES.has(status)) result = await db.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_code = ?").bind(status, id, identity).run();
    else return json({ error: "任务状态无效" }, 400);
    return result.meta.changes ? json({ task: await taskById(db, id, identity) }) : json({ error: "事项不存在" }, 404);
  }
  if (request.method === "DELETE") { await db.batch([db.prepare("DELETE FROM task_reminders WHERE task_id = ? AND identity_code = ?").bind(id, identity), db.prepare("DELETE FROM tasks WHERE id = ? AND identity_code = ?").bind(id, identity)]); return json({ ok: true }); }
  return json({ error: "未找到接口" }, 404);
}

async function pushApi(request, env, url, account) {
  const db = env.DB, identity = account.code, { pathname } = url;
  if (request.method === "GET" && pathname === "/api/push/vapid") {
    return json({ publicKey: env.VAPID_PUBLIC_KEY || "" });
  }
  if (request.method === "GET" && pathname === "/api/push/status") {
    const { results } = await db.prepare("SELECT endpoint, user_agent, created_at FROM push_subscriptions WHERE identity_code = ? ORDER BY created_at DESC").bind(identity).all();
    return json({ vapidConfigured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY), subscribed: results.length > 0, endpoints: results.length, devices: results.map((row) => ({ endpoint: row.endpoint, userAgent: row.user_agent || "", createdAt: row.created_at })) });
  }
  if (request.method === "POST" && pathname === "/api/push/subscribe") {
    const { endpoint, p256dh, auth, userAgent } = await bodyFrom(request);
    if (!endpoint || !p256dh || !auth) return json({ error: "推送订阅信息不完整" }, 400);
    const subId = `s_${b64(crypto.getRandomValues(new Uint8Array(16))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
    await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
    await db.prepare("INSERT INTO push_subscriptions (subscription_id, identity_code, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?, ?)").bind(subId, identity, endpoint, p256dh, auth, userAgent || null).run();
    return json({ ok: true }, 201);
  }
  if (request.method === "POST" && pathname === "/api/push/unsubscribe") {
    const { endpoint } = await bodyFrom(request);
    if (!endpoint) return json({ error: "缺少推送订阅地址" }, 400);
    await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND identity_code = ?").bind(endpoint, identity).run();
    return json({ ok: true });
  }
  if (request.method === "POST" && pathname === "/api/push/test") {
    // 手动推送测试：向当前账号全部已注册设备立即发送一条测试通知，用于验证订阅、密钥与推送链路。
    const { results: subs } = await db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE identity_code = ?").bind(identity).all();
    if (!subs.length) return json({ error: "当前账号没有已注册的推送设备" }, 400);
    let sent = 0;
    let failed = 0;
    const details = [];
    for (const sub of subs) {
      const outcome = await sendWebPush(sub, JSON.stringify({ title: "RabbitToDo", body: "这是一条测试推送" }), env, 10000);
      details.push({ userAgent: sub.user_agent || "unknown", outcome });
      if (outcome === "sent") sent += 1;
      else {
        failed += 1;
        if (outcome === "gone") await db.prepare("DELETE FROM push_subscriptions WHERE identity_code = ? AND endpoint = ?").bind(identity, sub.endpoint).run();
      }
    }
    return json({ ok: true, sent, failed, endpoints: subs.length, details });
  }
  return json({ error: "未找到接口" }, 404);
}

async function api(request, env, url) {
  const { pathname } = url;
  if (request.method === "POST" && pathname === "/api/admin/login") return await adminAuthorized(request, env) ? json({ ok: true }) : json({ error: "管理员密码错误" }, 401);
  if (pathname.startsWith("/api/admin/")) return adminApi(request, env, pathname);
  if (pathname.startsWith("/api/auth/")) { const response = await authApi(request, env, url); if (response) return response; }
  const account = await accountFromSession(request, env.DB); if (!account) return json({ error: "请登录" }, 401, { "Set-Cookie": clearSessionCookie(request) }); if (account.status !== "enabled") return json({ error: "账号已禁用" }, 403);
  if (pathname.startsWith("/api/push/")) return pushApi(request, env, url, account);
  return taskApi(request, env, url, account);
}

export default {
  async fetch(request, env) { const url = new URL(request.url); try { if (url.pathname.startsWith("/api/")) return await api(request, env, url); if (url.pathname === "/console") return Response.redirect(`${url.origin}/console/`, 308); return env.ASSETS.fetch(request); } catch (error) { console.error(error); return json({ error: error instanceof Error ? error.message : "服务器暂时不可用" }, 500); } },
  async scheduled(event, env, ctx) { ctx.waitUntil(fireDueReminders(env)); }
};
