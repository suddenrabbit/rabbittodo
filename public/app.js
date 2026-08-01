const COLORS = ["violet", "mint", "orange", "blue", "rose"];
const COLOR_NAMES = { violet: "葡萄紫", mint: "薄荷绿", orange: "日落橙", blue: "海盐蓝", rose: "莓果粉" };
const APP_VERSION = "v20260802.000951";
const EXPECTED_SERVICE_WORKER_VERSION = "rabbittodo-v55";
const SERVICE_WORKER_CHECK_INTERVAL = 10 * 60 * 1_000;
const SERVICE_WORKER_RETRY_INTERVAL = 5 * 60 * 1_000;
const SERVICE_WORKER_CHECK_KEY = "rabbittodo-sw-last-check";
const TOUCH_DRAG_HOLD_MS = 350;
const LOCAL_STORE_NAME = "rabbittodo-local-v1";
const LOCAL_STORE_KEY = "active-account";
const SYNC_RETRY_DELAYS = [5_000, 30_000, 120_000, 600_000];
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const ENCRYPTION_PREFIX = "rtenc:v1:";
const ENCRYPTION_SALT = "RabbitToDo task content v1";
const ENCRYPTION_ITERATIONS = 120_000;
const USERNAME_PATTERN = /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_]{1,9}$/u;
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
let serviceWorkerVersionProbeScheduled = false;
let foregroundSyncPromise = null;
let lastSessionLeaseAt = 0;
let localStorePromise = null;
let localProfile = null;
let outboxSyncPromise = null;
let outboxRetryTimer = 0;
let outboxRetryAttempt = 0;
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
let encryptionKeyIdentity = "";
let encryptionKeyPromise = null;
localStorage.removeItem("todo-identity");

const state = {
  identity: "", username: "", encryptionSeed: "", authMode: "login", authPromptOpen: true, authSubmitting: false, authDirty: false,
  authError: "", authUsername: "", authPassword: "", authConfirm: "", authResetCode: "", identityDraft: "",
  passwordDialog: false, tasks: [], view: "todo", tag: "全部", color: "全部", filtersOpen: wasLandscapeViewport, editor: null, datePicker: null, draftTags: [], tagInput: "",
  updateReady: false, updateApplying: false,
};

updateViewportClasses();
window.addEventListener("resize", updateViewportClasses);

function openLocalStore() {
  if (localStorePromise) return localStorePromise;
  localStorePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_STORE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地数据不可用"));
  });
  return localStorePromise;
}

async function localRead() {
  const db = await openLocalStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction("state", "readonly").objectStore("state").get(LOCAL_STORE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("读取本地数据失败"));
  });
}

async function localWrite(value) {
  const db = await openLocalStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction("state", "readwrite").objectStore("state").put(value, LOCAL_STORE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("保存本地数据失败"));
  });
}

async function localClear() {
  const db = await openLocalStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction("state", "readwrite").objectStore("state").delete(LOCAL_STORE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("清除本地数据失败"));
  });
}

function currentLocalSnapshot() {
  return {
    username: state.username,
    encryptionSeed: state.encryptionSeed,
    tasks: state.tasks,
    outbox: localProfile?.outbox || [],
    aliases: [...taskIdAliases.entries()],
    nextTemporaryTaskId,
    savedAt: Date.now(),
  };
}

async function persistLocalSnapshot() {
  if (!state.username || !state.encryptionSeed) return;
  localProfile = currentLocalSnapshot();
  await localWrite(localProfile);
}

async function restoreLocalSnapshot() {
  try {
    const profile = await localRead();
    if (!profile?.username || !/^u_[A-Za-z0-9_-]{43}$/.test(String(profile.encryptionSeed || ""))) return false;
    localProfile = profile;
    state.identity = "authenticated";
    state.username = profile.username;
    state.encryptionSeed = profile.encryptionSeed;
    state.authUsername = profile.username;
    state.authPromptOpen = false;
    state.tasks = Array.isArray(profile.tasks) ? profile.tasks : [];
    nextTemporaryTaskId = Number(profile.nextTemporaryTaskId) || -1;
    taskIdAliases.clear();
    (Array.isArray(profile.aliases) ? profile.aliases : []).forEach(([from, to]) => taskIdAliases.set(Number(from), Number(to)));
    markQueuedTasksUnsynced();
    encryptionKeyIdentity = "";
    encryptionKeyPromise = null;
    render();
    return true;
  } catch {
    return false;
  }
}

function serviceWorkerVersionNumber(value) {
  return Number(String(value || "").match(/^rabbittodo-v(\d+)$/)?.[1] || 0);
}

function handleServiceWorkerVersion(version) {
  if (serviceWorkerVersionNumber(version) < serviceWorkerVersionNumber(EXPECTED_SERVICE_WORKER_VERSION)) return;
  if (serviceWorkerRegistration?.waiting) {
    state.updateReady = true;
    render();
  }
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
      if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
        state.updateReady = true;
        render();
      }
    });
  });
}

function checkForServiceWorkerUpdate({ force = false } = {}) {
  if (!serviceWorkerRegistration || document.visibilityState === "hidden") return Promise.resolve();
  const now = Date.now();
  const lastCheck = Number(sessionStorage.getItem(SERVICE_WORKER_CHECK_KEY) || 0);
  if (serviceWorkerUpdatePromise) return serviceWorkerUpdatePromise;
  if (!force && now - lastCheck < SERVICE_WORKER_CHECK_INTERVAL) {
    probeServiceWorkerVersion();
    return Promise.resolve();
  }
  sessionStorage.setItem(SERVICE_WORKER_CHECK_KEY, String(now));
  serviceWorkerUpdatePromise = serviceWorkerRegistration.update()
    .then((registration) => {
      if (registration.waiting) {
        state.updateReady = true;
        render();
      }
      probeServiceWorkerVersion();
    })
    .catch(() => scheduleServiceWorkerRetry())
    .finally(() => { serviceWorkerUpdatePromise = null; });
  return serviceWorkerUpdatePromise;
}

async function applyServiceWorkerUpdate() {
  if (!state.updateReady || state.updateApplying || !serviceWorkerRegistration?.waiting) return;
  state.updateApplying = true;
  render();
  try { await persistLocalSnapshot(); } catch {}
  serviceWorkerRegistration.waiting.postMessage({ type: "RABBITTODO_APPLY_UPDATE" });
}

function reloadForServiceWorkerUpdate() {
  if (!state.updateApplying || isReloadingForServiceWorker) return;
  isReloadingForServiceWorker = true;
  window.location.reload();
}

function synchronizeForeground() {
  // 首次加载要等 register() 完成；否则 pageshow 会抢先同步数据。
  if ("serviceWorker" in navigator && !serviceWorkerRegistration) return Promise.resolve();
  if (foregroundSyncPromise) return foregroundSyncPromise;
  foregroundSyncPromise = (async () => {
    // Update checks must happen before remote sync, but never delay local rendering.
    await checkForServiceWorkerUpdate({ force: true });
    if (!state.updateApplying && await refreshSessionLease()) await flushOutboxAndLoad();
  })().finally(() => { foregroundSyncPromise = null; });
  return foregroundSyncPromise;
}

async function refreshSessionLease() {
  if (!state.identity || Date.now() - lastSessionLeaseAt < 7 * 86400_000) return true;
  try {
    const response = await api("/api/auth/session");
    if (!response.account?.encryptionSeed || response.account.username !== state.username) throw new Error("会话不匹配");
    state.encryptionSeed = response.account.encryptionSeed;
    lastSessionLeaseAt = Date.now();
    await persistLocalSnapshot();
    return true;
  } catch (error) {
    handleAuthenticationError(error);
    return false;
  }
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
const isEncryptedText = (value) => String(value || "").startsWith(ENCRYPTION_PREFIX);

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encryptionKeyFor(seed = state.encryptionSeed) {
  if (!seed || !window.crypto?.subtle) {
    throw new Error("当前浏览器无法启用任务内容加密");
  }
  if (encryptionKeyIdentity === seed && encryptionKeyPromise) return encryptionKeyPromise;
  encryptionKeyIdentity = seed;
  encryptionKeyPromise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(seed),
    "PBKDF2",
    false,
    ["deriveKey"],
  ).then((keyMaterial) => crypto.subtle.deriveKey({
    name: "PBKDF2",
    salt: new TextEncoder().encode(ENCRYPTION_SALT),
    iterations: ENCRYPTION_ITERATIONS,
    hash: "SHA-256",
  }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
  return encryptionKeyPromise;
}

async function encryptText(value, identity = state.encryptionSeed) {
  const plaintext = String(value || "");
  if (!plaintext || isEncryptedText(plaintext)) return plaintext;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKeyFor(identity),
    new TextEncoder().encode(plaintext),
  ));
  const packed = new Uint8Array(iv.length + encrypted.length);
  packed.set(iv);
  packed.set(encrypted, iv.length);
  return `${ENCRYPTION_PREFIX}${bytesToBase64(packed)}`;
}

async function decryptText(value, identity = state.encryptionSeed) {
  const stored = String(value || "");
  if (!isEncryptedText(stored)) return stored;
  try {
    const packed = base64ToBytes(stored.slice(ENCRYPTION_PREFIX.length));
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: packed.slice(0, 12) },
      await encryptionKeyFor(identity),
      packed.slice(12),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("暂时无法读取任务内容，请重新登录后再试");
  }
}

async function encryptTaskContent(task, identity = state.encryptionSeed) {
  const [title, details] = await Promise.all([
    encryptText(task.title, identity),
    encryptText(task.details || "", identity),
  ]);
  return { ...task, title, details };
}

async function decryptTaskContent(task, identity = state.encryptionSeed) {
  const contentEncrypted = isEncryptedText(task.title) && (!task.details || isEncryptedText(task.details));
  const [title, details] = await Promise.all([
    decryptText(task.title, identity),
    decryptText(task.details || "", identity),
  ]);
  return { ...task, title, details, _contentEncrypted: contentEncrypted };
}

async function decryptApiPayload(payload) {
  if (Array.isArray(payload.tasks)) payload.tasks = await Promise.all(payload.tasks.map((task) => decryptTaskContent(task)));
  if (payload.task) payload.task = await decryptTaskContent(payload.task);
  return payload;
}
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
  const { decrypt = true, timeoutMs = 0, ...fetchOptions } = options;
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
  let response;
  try {
    response = await fetch(path, {
      ...fetchOptions,
      signal: controller?.signal || fetchOptions.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "操作未完成");
    error.status = response.status;
    error.code = payload.code || "";
    throw error;
  }
  return decrypt ? decryptApiPayload(payload) : payload;
}

async function enterAccount(account) {
  const seed = String(account.encryptionSeed || "");
  if (!/^u_[A-Za-z0-9_-]{43}$/.test(seed)) throw new Error("账号身份信息无效，请重新登录");
  const keepOfflineData = localProfile?.username === account.username && localProfile?.encryptionSeed === seed;
  state.identity = "authenticated";
  state.username = account.username;
  state.encryptionSeed = seed;
  encryptionKeyIdentity = "";
  encryptionKeyPromise = null;
  state.authPromptOpen = false;
  state.authSubmitting = false;
  state.authDirty = false;
  state.authError = "";
  state.authUsername = account.username;
  state.authPassword = "";
  state.authConfirm = "";
  state.authResetCode = "";
  state.tasks = keepOfflineData && Array.isArray(localProfile?.tasks) ? localProfile.tasks : [];
  state.view = "todo";
  if (!keepOfflineData) {
    taskIdAliases.clear();
    nextTemporaryTaskId = -1;
  }
  localProfile = { ...currentLocalSnapshot(), outbox: keepOfflineData ? (localProfile?.outbox || []) : [] };
  await persistLocalSnapshot();
  if (serviceWorkerRegistration) await synchronizeForeground(); else await flushOutboxAndLoad();
}

function openAuth(mode = "login") {
  if (state.authMode !== mode) {
    state.authPassword = "";
    state.authConfirm = "";
    state.authResetCode = "";
  }
  state.authMode = mode;
  state.authPromptOpen = true;
  state.authSubmitting = false;
  state.authDirty = false;
  state.authError = "";
  render();
}

function authSubmitLabel(mode = state.authMode) {
  return mode === "register" ? "创建账号" : mode === "reset" ? "设置新密码" : "登录";
}

function setAuthSubmitting(submitting) {
  state.authSubmitting = submitting;
  const panel = document.querySelector("#auth-panel");
  if (!panel) return;
  panel.classList.toggle("is-submitting", submitting);
  panel.querySelectorAll("input, button").forEach((control) => { control.disabled = submitting; });
  const submitButton = panel.querySelector('[data-action="submit-auth"]');
  if (submitButton) submitButton.textContent = submitting ? "处理中…" : authSubmitLabel();
}

function showAuthError(message, focusSelector = "#auth-password") {
  state.authSubmitting = false;
  state.authError = message || "操作未完成，请重试";
  const panel = document.querySelector("#auth-panel");
  if (!panel) {
    render();
    requestAnimationFrame(() => document.querySelector(focusSelector)?.focus());
    return;
  }
  let errorMessage = panel.querySelector(".auth-error");
  if (!errorMessage) {
    errorMessage = document.createElement("p");
    errorMessage.className = "auth-error";
    errorMessage.setAttribute("role", "alert");
    panel.querySelector('[data-action="submit-auth"]')?.before(errorMessage);
  }
  errorMessage.textContent = state.authError;
  setAuthSubmitting(false);
  requestAnimationFrame(() => document.querySelector(focusSelector)?.focus());
}

function continueAsRegistration() {
  state.authMode = "register";
  state.authConfirm = "";
  const panel = document.querySelector("#auth-panel");
  if (!panel) return render();
  panel.querySelector("h2").textContent = "创建 RabbitToDo 账号";
  panel.querySelector(":scope > span").textContent = "创建账号后，你可以在不同设备上继续管理待办。";
  const passwordInput = panel.querySelector("#auth-password");
  passwordInput.setAttribute("autocomplete", "new-password");
  const confirmInput = document.createElement("input");
  confirmInput.id = "auth-confirm";
  confirmInput.type = "password";
  confirmInput.autocomplete = "new-password";
  confirmInput.minLength = 8;
  confirmInput.maxLength = 256;
  confirmInput.placeholder = "再次输入密码";
  confirmInput.required = true;
  passwordInput.after(confirmInput);
  panel.querySelector(".auth-links").innerHTML = '<button type="button" data-action="auth-login">返回登录</button>';
  showAuthError("这是一个新用户名，请再次输入密码完成注册", "#auth-confirm");
}

async function submitAuthentication() {
  if (state.authSubmitting) return;
  const mode = state.authMode;
  const username = document.querySelector("#auth-username").value.normalize("NFKC").trim();
  const password = document.querySelector("#auth-password").value;
  const confirmPassword = document.querySelector("#auth-confirm")?.value || "";
  const resetCode = document.querySelector("#auth-reset-code")?.value || "";
  state.authUsername = username;
  state.authPassword = password;
  state.authConfirm = confirmPassword;
  state.authResetCode = resetCode;
  state.authError = "";
  if (!USERNAME_PATTERN.test(username)) {
    showAuthError("用户名为 2-10 个字符，须以中文或英文开头", "#auth-username");
    return;
  }
  if (password.length < 8 || password.length > 256) {
    showAuthError(password.length < 8 ? "密码至少 8 位" : "密码不能超过 256 位", "#auth-password");
    return;
  }
  if (mode === "reset" && !resetCode.trim()) {
    showAuthError("请输入重置码", "#auth-reset-code");
    return;
  }
  if ((mode === "register" || mode === "reset") && password !== confirmPassword) {
    showAuthError("两次输入的密码不一致", "#auth-confirm");
    return;
  }
  setAuthSubmitting(true);
  try {
    let response;
    if (mode === "login") {
      try {
        response = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      } catch (error) {
        if (error.code !== "registration_required") throw error;
        continueAsRegistration();
        return;
      }
    } else if (mode === "reset") {
      response = await api("/api/auth/reset", { method: "POST", body: JSON.stringify({ username, resetCode, newPassword: password }) });
    } else {
      response = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password }) });
    }
    await enterAccount(response.account);
  } catch (error) {
    if (mode === "login") {
      state.authPassword = "";
      const passwordInput = document.querySelector("#auth-password");
      if (passwordInput) passwordInput.value = "";
    }
    showAuthError(error.message, "#auth-password");
  }
}

function handleAuthenticationError(error) {
  if (error.status !== 401 && error.status !== 403) return false;
  state.authUsername = state.username || state.authUsername;
  state.identity = ""; state.username = ""; state.encryptionSeed = ""; state.tasks = [];
  state.authPassword = ""; state.authConfirm = ""; state.authResetCode = "";
  openAuth("login");
  state.authError = error.status === 403 ? "账号已禁用" : "登录状态已失效，请重新登录";
  render();
  return true;
}

function mutationId() {
  return crypto.randomUUID ? crypto.randomUUID().replaceAll("-", "") : `${Date.now()}${Math.random().toString(36).slice(2)}`;
}

function outbox() {
  return localProfile?.outbox || [];
}

function isTransportFailure(error) {
  return !Number(error?.status);
}

function markQueuedTasksUnsynced() {
  outbox().forEach((entry) => markMutationUnsynced(entry, true));
}

function removeOutboxEntry(entryId) {
  if (!localProfile) return;
  localProfile.outbox = outbox().filter((entry) => entry.id !== entryId);
}

function queuedCreateFor(localId) {
  return outbox().find((entry) => entry.kind === "create" && Number(entry.payload.localId) === Number(localId));
}

// A task that has not received a server id is allowed to move temporarily in
// the current view, but must not create a durable reorder record. Once its
// create request succeeds, normal new-task ordering places it at the tail.
function isPendingCreate(task) {
  return Boolean(task && (Number(task.id) < 0 || queuedCreateFor(task.id)));
}

async function enqueueTaskMutation(kind, payload = {}, entry = null) {
  if (!localProfile) localProfile = currentLocalSnapshot();
  localProfile.outbox = [...outbox(), entry || { id: mutationId(), kind, payload, createdAt: Date.now() }];
  await persistLocalSnapshot();
  scheduleOutboxSync(0);
}

function markMutationUnsynced(entry, unsynced) {
  if (entry.kind !== "create" && entry.kind !== "update") return;
  const task = state.tasks.find((item) => item.id === Number(entry.payload.localId));
  if (task) task._unsynced = unsynced;
}

async function publishTaskMutation(kind, payload = {}) {
  // A previously failed write must never prevent a new real request. For an
  // unsynced temporary task, update and retry its original idempotent create.
  const pendingCreate = kind === "update" && Number(payload.localId) < 0 ? queuedCreateFor(payload.localId) : null;
  const entry = pendingCreate || { id: mutationId(), kind, payload, createdAt: Date.now() };
  if (pendingCreate) entry.payload.task = payload.task;
  pendingMutations += 1;
  try {
    const sent = await sendOutboxEntry(entry, { timeoutMs: 8_000 });
    if (sent) {
      removeOutboxEntry(entry.id);
      if (kind === "update") {
        localProfile.outbox = outbox().filter((item) => item.kind !== "update" || Number(item.payload.localId) !== Number(payload.localId));
      }
      markMutationUnsynced(entry, false);
      outboxRetryAttempt = 0;
      await persistLocalSnapshot();
      render();
      return true;
    }
  } catch (error) {
    if (handleAuthenticationError(error)) throw error;
    if (!isTransportFailure(error)) throw error;
  } finally {
    pendingMutations -= 1;
  }
  markMutationUnsynced(entry, true);
  if (pendingCreate) {
    await persistLocalSnapshot();
    scheduleOutboxSync(0);
  } else {
    await enqueueTaskMutation(kind, payload, entry);
  }
  render();
  return false;
}

function scheduleOutboxSync(delay = 0) {
  if (outboxRetryTimer) clearTimeout(outboxRetryTimer);
  outboxRetryTimer = setTimeout(() => {
    outboxRetryTimer = 0;
    flushOutboxAndLoad();
  }, delay);
}

async function sendOutboxEntry(entry, { timeoutMs = 0 } = {}) {
  const requestOptions = timeoutMs ? { timeoutMs } : {};
  const localId = Number(entry.payload.localId);
  const resolvedId = resolvedTaskId(localId);
  if (entry.kind !== "create" && (!resolvedId || resolvedId < 0)) return false;
  if (entry.kind === "create") {
    const response = await api("/api/tasks", { method: "POST", body: JSON.stringify(entry.payload.task), headers: { "X-RabbitTodo-Mutation": entry.id }, ...requestOptions });
    applyServerTask(response.task, localId, false);
    return true;
  }
  if (entry.kind === "update") {
    const response = await api(`/api/tasks/${resolvedId}`, { method: "PUT", body: JSON.stringify(entry.payload.task), ...requestOptions });
    applyServerTask(response.task, localId, false);
    return true;
  }
  if (entry.kind === "toggle") {
    const response = await api(`/api/tasks/${resolvedId}`, { method: "PATCH", body: JSON.stringify({ completed: entry.payload.completed }), ...requestOptions });
    applyServerTask(response.task, localId, false);
    return true;
  }
  if (entry.kind === "delete") {
    await api(`/api/tasks/${resolvedId}`, { method: "DELETE", ...requestOptions });
    return true;
  }
  if (entry.kind === "reorder") {
    const ids = entry.payload.ids.map((id) => resolvedTaskId(id));
    const pinnedIds = entry.payload.pinnedIds.map((id) => resolvedTaskId(id));
    if (ids.some((id) => id < 0) || pinnedIds.some((id) => id < 0)) return false;
    await api("/api/tasks/reorder", { method: "POST", body: JSON.stringify({ ...entry.payload, ids, pinnedIds }), ...requestOptions });
    return true;
  }
  throw new Error("本地同步操作无效");
}

function canSendOutboxEntry(entry) {
  const localId = Number(entry.payload.localId);
  if (entry.kind === "create") return true;
  if (entry.kind === "reorder") {
    const ids = Array.isArray(entry.payload.ids) ? entry.payload.ids : [];
    const pinnedIds = Array.isArray(entry.payload.pinnedIds) ? entry.payload.pinnedIds : [];
    return ids.length > 0 && [...ids, ...pinnedIds].every((id) => resolvedTaskId(id) > 0);
  }
  return resolvedTaskId(localId) > 0;
}

async function flushOutbox() {
  if (outboxSyncPromise || !state.identity || state.updateApplying || !outbox().length) return outboxSyncPromise;
  outboxSyncPromise = (async () => {
    pendingMutations += 1;
    try {
      while (outbox().length && !state.updateApplying) {
        // Historic queues can contain an old reorder/update that still refers
        // to a temporary id. It must not prevent later idempotent creates from
        // being repaired automatically once the connection is available.
        const entry = outbox().find(canSendOutboxEntry);
        if (!entry) {
          scheduleOutboxSync(SYNC_RETRY_DELAYS[Math.min(outboxRetryAttempt++, SYNC_RETRY_DELAYS.length - 1)]);
          return;
        }
        const sent = await sendOutboxEntry(entry, { timeoutMs: 8_000 });
        if (!sent) {
          scheduleOutboxSync(SYNC_RETRY_DELAYS[Math.min(outboxRetryAttempt++, SYNC_RETRY_DELAYS.length - 1)]);
          return;
        }
        removeOutboxEntry(entry.id);
        markMutationUnsynced(entry, false);
        outboxRetryAttempt = 0;
        await persistLocalSnapshot();
      }
    } catch (error) {
      if (handleAuthenticationError(error)) return;
      if (isTransportFailure(error)) {
        const delay = SYNC_RETRY_DELAYS[Math.min(outboxRetryAttempt++, SYNC_RETRY_DELAYS.length - 1)];
        scheduleOutboxSync(delay);
      }
    } finally {
      pendingMutations -= 1;
      outboxSyncPromise = null;
      render();
    }
  })();
  return outboxSyncPromise;
}

async function flushOutboxAndLoad() {
  await flushOutbox();
  if (!state.updateApplying) await loadTasks({ quiet: true });
}

// Legacy plaintext re-encryption remains best-effort and does not enter the task outbox.
function saveInBackground(operation) {
  mutationChain = mutationChain.then(operation, operation).catch(() => {});
  return mutationChain;
}

function resolvedTaskId(id) {
  return taskIdAliases.get(Number(id)) || Number(id);
}

function applyServerTask(task, localId = task.id, shouldRender = false) {
  if (Number(localId) < 0) taskIdAliases.set(Number(localId), task.id);
  const index = state.tasks.findIndex((item) => item.id === Number(localId) || item.id === task.id);
  if (index >= 0) state.tasks[index] = { ...state.tasks[index], ...task, _unsynced: false };
  if (shouldRender) render();
}

function mergeRemoteTasks(remoteTasks) {
  const localTasks = new Map(state.tasks.map((task) => [Number(task.id), task]));
  const merged = new Map(remoteTasks.map((task) => [Number(task.id), task]));
  outbox().forEach((entry) => {
    const localId = Number(entry.payload.localId);
    const task = localTasks.get(localId);
    if (entry.kind === "delete") {
      merged.delete(resolvedTaskId(localId));
      return;
    }
    if (!task || !["create", "update", "toggle"].includes(entry.kind)) return;
    merged.set(localId, { ...task, _unsynced: true });
  });
  outbox().filter((entry) => entry.kind === "reorder").forEach((entry) => {
    entry.payload.ids.forEach((id) => {
      const localId = Number(id);
      const localTask = localTasks.get(localId);
      const remoteTask = merged.get(resolvedTaskId(localId));
      if (!localTask || !remoteTask) return;
      merged.set(remoteTask.id, {
        ...remoteTask,
        manual_position: localTask.manual_position,
        pinned: localTask.pinned,
        pinned_at: localTask.pinned_at,
      });
    });
  });
  return [...merged.values()];
}

function migrateLegacyTaskContent(tasks) {
  if (!tasks.length) return;
  tasks.forEach((task) => { task._contentEncrypted = true; });
  saveInBackground(async () => {
    const encryptedTasks = await Promise.all(tasks.map(async (task) => {
      const encrypted = await encryptTaskContent(task);
      return { id: resolvedTaskId(task.id), title: encrypted.title, details: encrypted.details };
    }));
    for (let offset = 0; offset < encryptedTasks.length; offset += 50) {
      await api("/api/tasks/encrypt", {
        method: "POST",
        body: JSON.stringify({ tasks: encryptedTasks.slice(offset, offset + 50) }),
      });
    }
  });
}

async function loadTasks({ quiet = false } = {}) {
  if (!state.identity) return render();
  if (taskSyncPromise) return taskSyncPromise;
  taskSyncPromise = (async () => {
    try {
      state.tasks = mergeRemoteTasks((await api("/api/tasks")).tasks);
      migrateLegacyTaskContent(state.tasks.filter((task) => task.id > 0 && !task._contentEncrypted));
      lastTaskSyncAt = Date.now();
      await persistLocalSnapshot();
    } catch (error) {
      if (!handleAuthenticationError(error) && !quiet && !isReloadingForServiceWorker) alert(error.message);
    } finally {
      taskSyncPromise = null;
    }
    render();
  })();
  return taskSyncPromise;
}

function refreshActiveTasks(force = false) {
  if (!state.identity || state.authPromptOpen || state.editor || pointerDrag || pendingMutations || serviceWorkerUpdatePromise || foregroundSyncPromise || state.updateApplying || document.visibilityState === "hidden") return;
  // pageshow、focus 与 visibilitychange 往往会连续触发；前台恢复只保留一次读取。
  const interval = force ? 1_500 : 30_000;
  if (Date.now() - lastTaskSyncAt > interval) flushOutboxAndLoad();
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

function compareTodoTasks(left, right) {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
  const manualOrder = compareManualPosition(left, right);
  if (manualOrder) return manualOrder;
  const createdOrder = timestampValue(left.created_at) - timestampValue(right.created_at);
  if (createdOrder) return createdOrder;
  return Number(left.id) - Number(right.id);
}

function compareCompletedTasks(left, right) {
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
  const syncBadge = task._unsynced ? '<span class="sync-badge">未同步</span>' : "";
  return `<article class="task-card color-${task.color} ${task.completed ? "is-completed" : "is-draggable"} ${overdue ? "is-overdue" : ""} ${showPinned ? "is-pinned" : ""}" data-task-id="${task.id}">
    <button class="check-button" data-action="toggle" data-id="${task.id}" aria-label="切换完成状态">${task.completed ? "✓" : ""}</button>
    <div class="task-body"><h3>${escapeHtml(task.title)}</h3><div class="task-meta">
      ${task.details ? `<p class="task-details">${escapeHtml(task.details)}</p>` : ""}${completionDate}${distanceBadge}${statusBadge}${due}${syncBadge}
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
  if (!state.authPromptOpen) return "";
  const submitting = state.authSubmitting;
  const mode = state.authMode;
  const isRegister = mode === "register";
  const isReset = mode === "reset";
  const title = isRegister ? "创建 RabbitToDo 账号" : isReset ? "重新设置密码" : "欢迎回来";
  const hint = isRegister ? "创建账号后，你可以在不同设备上继续管理待办。" : isReset ? "输入重置码并设置新密码，即可重新登录。" : "登录后，继续安排今天要做的事。";
  const disabled = submitting ? "disabled" : "";
  const reset = isReset ? `<input id="auth-reset-code" value="${escapeHtml(state.authResetCode)}" autocomplete="one-time-code" maxlength="64" placeholder="重置码" required ${disabled} />` : "";
  const confirm = isRegister || isReset ? `<input id="auth-confirm" value="${escapeHtml(state.authConfirm)}" type="password" autocomplete="new-password" minlength="8" maxlength="256" placeholder="再次输入密码" required ${disabled} />` : "";
  const usernameInput = `<input id="auth-username" value="${escapeHtml(state.authUsername)}" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="2" maxlength="10" placeholder="用户名（2–10 位）" required ${disabled} />`;
  const passwordInput = `<input id="auth-password" value="${escapeHtml(state.authPassword)}" type="password" autocomplete="${isRegister || isReset ? "new-password" : "current-password"}" minlength="8" maxlength="256" placeholder="密码（至少 8 位）" required ${disabled} />`;
  const fields = isReset ? `${usernameInput}${reset}${passwordInput}${confirm}` : `${usernameInput}${passwordInput}${confirm}`;
  const errorMessage = state.authError ? `<p class="auth-error" role="alert">${escapeHtml(state.authError)}</p>` : "";
  const submitLabel = authSubmitLabel(mode);
  return `<div class="identity-gate"><section class="identity-card ${submitting ? "is-submitting" : ""}" id="auth-panel"><div class="identity-symbol"><img src="/rabbittodo-icon.png" alt="RabbitToDo 兔子图标" /></div><p>RabbitToDo</p><h2>${title}</h2><span>${hint}</span>${fields}${errorMessage}<button class="save-button identity-submit-button" type="button" data-action="submit-auth" ${submitting ? "disabled" : ""}>${submitting ? "处理中…" : submitLabel}</button><div class="auth-links">${mode !== "login" ? '<button type="button" data-action="auth-login">返回登录</button>' : '<button type="button" data-action="auth-register">创建新账号</button>'}${mode === "login" ? '<button type="button" data-action="auth-reset">使用重置码</button>' : ""}</div></section></div>`;
}

function updatePrompt() {
  if (!state.updateReady && !state.updateApplying) return "";
  const applying = state.updateApplying;
  return `<div class="update-gate"><section class="update-card"><div class="identity-symbol"><img src="/rabbittodo-icon.png" alt="RabbitToDo" /></div><h2>检测到新版本</h2><span>更新后将使用最新功能。当前离线修改已安全保存在本机。</span><button class="save-button" type="button" data-action="apply-update" ${applying ? "disabled" : ""}>${applying ? "更新中…" : "立即更新"}</button></section></div>`;
}

function pageHeader(heading) {
  return `<header class="topbar"><div><p class="eyebrow"><b class="brand-inline">RabbitToDo</b>　${new Intl.DateTimeFormat("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, month: "long", day: "numeric", weekday: "short" }).format(new Date())}</p><h1>${heading}</h1></div><button class="avatar" data-action="profile" aria-label="查看我的"><i class="avatar-icon"><img src="/rabbittodo-icon.png" alt="" /></i><span>Hi, ${escapeHtml(state.username || "我的")}</span></button></header>`;
}

function profilePage() {
  const passwordForm = state.passwordDialog ? '<form id="change-password-form" class="account-form"><input id="current-password" type="password" placeholder="当前密码" required /><input id="new-password" type="password" placeholder="新密码（至少 8 位）" required /><input id="new-password-confirm" type="password" placeholder="再次输入新密码" required /><button class="save-button" type="submit">更新密码</button></form>' : "";
  return `<section class="profile-page">${pageHeader("我的")}<section class="profile-card"><div class="profile-icon"><img src="/rabbittodo-icon.png" alt="RabbitToDo" /></div><p>当前账号</p><strong class="username-display">${escapeHtml(state.username)}</strong><span>登录同一账号，换一台设备也能继续管理待办。</span>${passwordForm}<div class="profile-actions"><button data-action="change-password">${state.passwordDialog ? "取消修改" : "修改密码"}</button><button data-action="logout">退出登录</button></div></section><p class="version-label">版本 ${APP_VERSION}</p></section>`;
}

function taskScrollContainer() {
  const taskScroller = app.querySelector(".workspace-tasks");
  if (taskScroller && getComputedStyle(taskScroller).overflowY !== "visible") return taskScroller;
  return app.querySelector(".content-scroll");
}

function captureTaskScroll() {
  const workspace = app.querySelector(".workspace");
  if (!workspace
    || workspace.dataset.view !== state.view
    || workspace.dataset.tag !== state.tag
    || workspace.dataset.color !== state.color) return null;
  const scroller = taskScrollContainer();
  if (!scroller) return null;
  const snapshot = { scrollTop: scroller.scrollTop, taskId: null, anchorOffset: 0 };
  if (snapshot.scrollTop <= 1) return snapshot;
  const scrollerRect = scroller.getBoundingClientRect();
  const anchor = [...workspace.querySelectorAll(".task-card")]
    .find((card) => card.getBoundingClientRect().bottom > scrollerRect.top + 1);
  if (anchor) {
    snapshot.taskId = Number(anchor.dataset.taskId);
    snapshot.anchorOffset = anchor.getBoundingClientRect().top - scrollerRect.top;
  }
  return snapshot;
}

function restoreTaskScroll(snapshot) {
  if (!snapshot) return;
  const scroller = taskScrollContainer();
  if (!scroller) return;
  scroller.scrollTop = snapshot.scrollTop;
  if (snapshot.taskId === null) return;
  const anchor = app.querySelector(`.task-card[data-task-id="${snapshot.taskId}"]`);
  if (!anchor) return;
  const offset = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += offset - snapshot.anchorOffset;
}

function render() {
  const scrollSnapshot = captureTaskScroll();
  persistentAvatar = app.querySelector(".avatar") || persistentAvatar;
  persistentProfileIcon = app.querySelector(".profile-icon") || persistentProfileIcon;
  persistentIdentitySymbol = app.querySelector(".identity-symbol") || persistentIdentitySymbol;
  const tasks = filteredTasks();
  const taskContent = taskLists(tasks);
  const heading = { todo: "待办", done: "已办", profile: "我的" }[state.view];
  const overviewContent = `${pageHeader(heading)}${filters()}`;
  const pageContent = state.view === "profile"
    ? profilePage()
    : `<section class="workspace workspace-${state.view}" data-view="${state.view}" data-tag="${escapeHtml(state.tag)}" data-color="${escapeHtml(state.color)}"><aside class="workspace-overview">${overviewContent}</aside><main class="workspace-tasks">${taskContent}<p class="task-encryption-note"><i>🔒</i>待办事项内容均已加密存储</p></main></section>`;
  app.innerHTML = `<section class="phone"><div class="content-scroll ${state.view === "profile" ? "content-scroll-profile" : "content-scroll-tasks"}">${pageContent}</div>
    ${state.view !== "profile" ? '<button class="add-button" data-action="add" aria-label="添加事项">+</button>' : ""}<nav class="tabbar tabbar-two"><button data-action="view" data-view="todo" class="${state.view === "todo" ? "active" : ""}"><span>☐</span>待办</button><button data-action="view" data-view="done" class="${state.view === "done" ? "active" : ""}"><span>✓</span>已办</button></nav></section>${editor()}${datePicker()}${identityGate()}${updatePrompt()}`;
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
  restoreTaskScroll(scrollSnapshot);
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
  const scroller = taskScrollContainer();
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

function clearPointerDragHold(drag = pointerDrag) {
  if (!drag?.holdTimer) return;
  clearTimeout(drag.holdTimer);
  drag.holdTimer = 0;
}

function startPointerDrag(event) {
  if (!pointerDrag || pointerDrag.started) return;
  clearPointerDragHold();
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
  if (state.view !== "todo") return;
  const isPendingId = (id) => isPendingCreate(state.tasks.find((task) => Number(task.id) === Number(id)));
  const layout = visibleDragLayout();
  const pinnedIds = layout.pinned.filter((id) => !isPendingId(id));
  const regularIds = layout.regular.filter((id) => !isPendingId(id));
  const visibleIds = [...pinnedIds, ...regularIds];
  if (!visibleIds.length) return;

  const baseline = pageTasksInDisplayOrder().filter((task) => !isPendingCreate(task));
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
    ids: merged.map((task) => task.id),
    pinnedIds: merged.filter((task) => task.pinned).map((task) => task.id),
    completed: state.view === "done",
  };
  render();
  // enqueueTaskMutation captures the already-updated task order and the queue
  // in one IndexedDB snapshot, so an in-flight remote read cannot observe a
  // reordered local list without also seeing its protection entry.
  enqueueTaskMutation("reorder", payload).catch((error) => alert(error.message));
}

function finishPointerDrag(cancelled = false) {
  if (!pointerDrag) return;
  const drag = pointerDrag;
  clearPointerDragHold(drag);
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
    else if (changed && !isPendingCreate(state.tasks.find((task) => Number(task.id) === Number(drag.card.dataset.taskId)))) persistDraggedOrder();
  }
}

app.addEventListener("pointerdown", (event) => {
  if (state.view !== "todo" || event.button !== 0 || pendingMutations || state.editor) return;
  if (event.target.closest("button, input, textarea, select, label, a, [data-action]")) return;
  const card = event.target.closest(".task-card.is-draggable");
  if (!card) return;
  const drag = pointerDrag = {
    pointerId: event.pointerId,
    card,
    startX: event.clientX,
    startY: event.clientY,
    pointerType: event.pointerType,
    initialLayout: visibleDragLayout(),
    started: false,
    ghost: null,
  };
  if (event.pointerType === "mouse") {
    card.setPointerCapture?.(event.pointerId);
  } else {
    drag.holdTimer = setTimeout(() => {
      if (pointerDrag !== drag || drag.started) return;
      card.setPointerCapture?.(drag.pointerId);
      startPointerDrag({ clientX: drag.startX, clientY: drag.startY });
    }, TOUCH_DRAG_HOLD_MS);
  }
});

window.addEventListener("pointermove", (event) => {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
  const distance = Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY);
  if (!pointerDrag.started && pointerDrag.pointerType !== "mouse") {
    if (distance >= 8) {
      clearPointerDragHold();
      pointerDrag = null;
    }
    return;
  }
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
    if (action === "submit-auth") return submitAuthentication();
    if (action === "apply-update") return applyServiceWorkerUpdate();
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
    if (action === "auth-login") return openAuth("login");
    if (action === "auth-register") return openAuth("register");
    if (action === "auth-reset") return openAuth("reset");
    if (action === "change-password") { state.passwordDialog = !state.passwordDialog; return render(); }
    if (action === "logout") {
      try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
      state.authUsername = state.username;
      await localClear().catch(() => {});
      localProfile = null; taskIdAliases.clear(); nextTemporaryTaskId = -1;
      state.identity = ""; state.username = ""; state.encryptionSeed = ""; state.tasks = []; state.view = "todo"; state.authMode = "login"; state.authPromptOpen = true; state.authDirty = false; state.authError = ""; state.authPassword = ""; state.authConfirm = ""; state.authResetCode = ""; state.passwordDialog = false; encryptionKeyIdentity = ""; encryptionKeyPromise = null; return render();
    }
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
      await persistLocalSnapshot();
      enqueueTaskMutation("toggle", { localId: id, completed }).catch((error) => alert(error.message));
      return;
    }
    if (action === "delete-task") {
      if (!confirm("删除这项待办？")) return;
      const id = Number(state.editor.id);
      state.tasks = state.tasks.filter((task) => task.id !== id);
      state.editor = null;
      render();
      await persistLocalSnapshot();
      enqueueTaskMutation("delete", { localId: id }).catch((error) => alert(error.message));
      return;
    }
    return;
  }
  const card = event.target.closest("[data-task-id]");
  if (card) openEditor(state.tasks.find((task) => task.id === Number(card.dataset.taskId)));
});

app.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.closest("#auth-panel")) {
    event.preventDefault();
    submitAuthentication();
    return;
  }
  if (event.target.id !== "tag-input") return;
  if (event.key === "Enter") { event.preventDefault(); commitTag(); }
  if (event.key === "Backspace" && !event.target.value && state.draftTags.length) { state.draftTags.pop(); render(); document.querySelector("#tag-input")?.focus(); }
});
app.addEventListener("input", (event) => {
  if (event.target.id?.startsWith("auth-")) {
    state.authDirty = true;
    state.authError = "";
    event.target.closest("#auth-panel")?.querySelector(".auth-error")?.remove();
    if (event.target.id === "auth-username") state.authUsername = event.target.value;
    if (event.target.id === "auth-password") state.authPassword = event.target.value;
    if (event.target.id === "auth-confirm") state.authConfirm = event.target.value;
    if (event.target.id === "auth-reset-code") state.authResetCode = event.target.value;
    if (event.target.id === "auth-identity") state.identityDraft = event.target.value;
  }
  if (event.target.id === "tag-input") state.tagInput = event.target.value;
  if (event.target.id === "task-title" && state.editor) state.editor.title = event.target.value;
  if (event.target.id === "task-details" && state.editor) state.editor.details = event.target.value;
});
app.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (event.target.id === "change-password-form") {
      const currentPassword = document.querySelector("#current-password").value;
      const newPassword = document.querySelector("#new-password").value;
      if (newPassword !== document.querySelector("#new-password-confirm").value) throw new Error("两次输入的新密码不一致");
      const response = await api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      state.passwordDialog = false;
      await enterAccount(response.account);
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
        const previousTask = localTask ? { ...localTask, tags: [...localTask.tags] } : null;
        if (localTask) {
          const pinnedAt = payload.pinned ? (localTask.pinned ? localTask.pinned_at : new Date().toISOString()) : null;
          Object.assign(localTask, { title, details, color: payload.color, status: payload.status, tags, due_date: dueDate, pinned: payload.pinned, pinned_at: pinnedAt });
        }
        state.editor = null;
        render();
        const encryptedPayload = await encryptTaskContent(payload);
        try {
          await publishTaskMutation("update", { localId: editingId, task: encryptedPayload });
        } catch (error) {
          if (previousTask && state.identity) {
            const index = state.tasks.findIndex((task) => task.id === editingId);
            if (index >= 0) state.tasks[index] = previousTask;
            render();
          }
          throw error;
        }
      } else {
        const temporaryId = nextTemporaryTaskId--;
        const pinnedAt = payload.pinned ? new Date().toISOString() : null;
        state.tasks.unshift({
          id: temporaryId, title, details, color: payload.color, tags,
          due_date: dueDate, completed: false, completed_at: null, status: payload.status, pinned: payload.pinned, pinned_at: pinnedAt,
          manual_position: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        state.editor = null;
        state.view = "todo";
        render();
        const encryptedPayload = await encryptTaskContent(payload);
        try {
          await publishTaskMutation("create", { localId: temporaryId, task: encryptedPayload });
        } catch (error) {
          if (state.identity) {
            state.tasks = state.tasks.filter((task) => task.id !== temporaryId);
            render();
          }
          throw error;
        }
      }
      return;
    }
  } catch (error) { alert(error.message); }
});

// Installed PWAs are often resumed from a frozen page instead of reloaded.
// Refresh on every foreground return and poll gently while the app stays open.
window.addEventListener("pageshow", () => {
  synchronizeForeground();
});
window.addEventListener("focus", () => {
  synchronizeForeground();
});
window.addEventListener("online", () => {
  outboxRetryAttempt = 0;
  scheduleOutboxSync(500);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") synchronizeForeground();
});
setInterval(() => {
  refreshActiveTasks();
  if (state.identity && !state.authPromptOpen && !state.updateApplying && document.visibilityState !== "hidden" && outbox().length) flushOutboxAndLoad();
}, 30_000);

async function restoreSession() {
  const rememberedUsername = state.username || localProfile?.username || "";
  if (!rememberedUsername) return render();
  try {
    const response = await api("/api/auth/session");
    if (!response.account || response.account.username !== rememberedUsername) throw new Error("会话不匹配");
    state.identity = "authenticated"; state.username = response.account.username; state.encryptionSeed = response.account.encryptionSeed || state.encryptionSeed; state.authPromptOpen = false;
    encryptionKeyIdentity = ""; encryptionKeyPromise = null;
    lastSessionLeaseAt = Date.now();
    await persistLocalSnapshot();
    if (serviceWorkerRegistration) await synchronizeForeground(); else await flushOutboxAndLoad();
  } catch (error) {
    if (error.status === 401 || error.status === 403) handleAuthenticationError(error);
    else if (!state.tasks.length) render();
  }
}

async function bootstrapAfterServiceWorker() {
  checkForServiceWorkerUpdate({ force: true });
  await restoreSession();
}

async function bootstrap() {
  await restoreLocalSnapshot();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "RABBITTODO_SW_VERSION") handleServiceWorkerVersion(event.data.version);
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (state.updateApplying) reloadForServiceWorkerUpdate();
      else probeServiceWorkerVersion();
    });
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((registration) => {
      serviceWorkerRegistration = registration;
      watchServiceWorkerInstallation(registration);
      bootstrapAfterServiceWorker();
    }).catch(() => restoreSession());
  } else {
    restoreSession();
  }
}

bootstrap();
