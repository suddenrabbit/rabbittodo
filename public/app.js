const COLORS = ["violet", "mint", "orange", "blue", "rose"];
const COLOR_NAMES = { violet: "葡萄紫", mint: "薄荷绿", orange: "日落橙", blue: "海盐蓝", rose: "莓果粉" };
const normalizeThemeColor = (value) => COLORS.includes(String(value || "")) ? String(value) : "violet";
const SORT_MODES = ["manual", "auto"];
const normalizeTaskSortMode = (value) => SORT_MODES.includes(String(value || "")) ? String(value) : "manual";
const APP_VERSION = "v20260824.200106";
const EXPECTED_SERVICE_WORKER_VERSION = "rabbittodo-v115";
const SERVICE_WORKER_CHECK_INTERVAL = 10 * 60 * 1_000;
const SERVICE_WORKER_RETRY_INTERVAL = 5 * 60 * 1_000;
const SERVICE_WORKER_UPDATE_TIMEOUT = 5_000;
const SYNC_REQUEST_TIMEOUT = 8_000;
const SERVICE_WORKER_CHECK_KEY = "rabbittodo-sw-last-check";
const TOUCH_DRAG_HOLD_MS = 350;
const LOCAL_STORE_NAME = "rabbittodo-local-v1";
const LOCAL_STORE_KEY = "active-account";
const SYNC_RETRY_DELAYS = [5_000, 30_000, 120_000, 600_000];
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const ENCRYPTION_PREFIX_V2 = "rtenc:v2:";
const ENCRYPTION_SALT_V2 = "RabbitToDo task content v2";
const ENCRYPTION_INFO_V2 = "task-content";
const USERNAME_PATTERN = /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_]{1,9}$/u;
const app = document.querySelector("#app");
const isIPad = /iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isIOSDevice = /iPhone|iPad|iPod/.test(navigator.userAgent) || isIPad;
const isIOSStandalone = isIOSDevice && navigator.standalone === true;
document.documentElement.classList.toggle("is-ipad", isIPad);
document.documentElement.classList.toggle("is-ios-standalone", isIOSStandalone);
document.documentElement.classList.toggle("is-ios-browser", isIOSDevice && !isIOSStandalone);
document.documentElement.classList.toggle("is-touch-device", navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches);
const isLandscapeViewport = () => window.innerWidth > window.innerHeight;
let wasLandscapeViewport = isLandscapeViewport();
let tabbarAlignmentFrame = 0;
const scheduleTabbarAlignment = () => {
  cancelAnimationFrame(tabbarAlignmentFrame);
  tabbarAlignmentFrame = requestAnimationFrame(() => {
    const tabbar = app.querySelector(".tabbar-compact");
    if (!tabbar) return;
    tabbar.style.removeProperty("--tabbar-center-x");
    if (!isLandscapeViewport() || state.view === "profile") return;
    const phone = app.querySelector(".phone");
    const taskPane = app.querySelector(".workspace-tasks");
    if (!phone || !taskPane) return;
    const phoneRect = phone.getBoundingClientRect();
    const taskPaneRect = taskPane.getBoundingClientRect();
    tabbar.style.setProperty("--tabbar-center-x", `${taskPaneRect.left - phoneRect.left + taskPaneRect.width / 2}px`);
  });
};
const updateViewportClasses = () => {
  const isLandscape = isLandscapeViewport();
  document.documentElement.classList.toggle("is-compact-landscape", isLandscape);
  if (isLandscape && !wasLandscapeViewport) {
    state.filtersOpen = true;
    render();
  } else if (!isLandscape && wasLandscapeViewport) {
    state.filtersOpen = false;
    render();
  } else {
    scheduleTabbarAlignment();
  }
  wasLandscapeViewport = isLandscape;
};
let isReloadingForServiceWorker = false;
let serviceWorkerRegistration = null;
let serviceWorkerUpdatePromise = null;
let serviceWorkerUpdateRetryTimer = 0;
let serviceWorkerVersionProbeScheduled = false;
let foregroundSyncPromise = null;
let foregroundSyncEpoch = 0;
let foregroundSyncPromiseEpoch = 0;
let lastSessionLeaseAt = 0;
let localStorePromise = null;
let localProfile = null;
let outboxSyncPromise = null;
let outboxRetryTimer = 0;
let outboxRetryAttempt = 0;
let syncNoticeTimer = 0;
const preventPageZoom = (event) => {
  if (event.type.startsWith("gesture") || event.touches?.length > 1) event.preventDefault();
};
document.addEventListener("gesturestart", preventPageZoom, { passive: false });
document.addEventListener("gesturechange", preventPageZoom, { passive: false });
let taskSyncPromise = null;
let lastTaskSyncAt = 0;
let pendingMutations = 0;
let taskStateRevision = 0;
let nextTemporaryTaskId = -1;
const taskIdAliases = new Map();
let persistentAvatar = null;
let persistentProfileIcon = null;
let persistentIdentitySymbol = null;
let pointerDrag = null;
let suppressCardClickUntil = 0;
let dragAutoScrollFrame = 0;
let dragAutoScrollSpeed = 0;
let encryptionKeyV2Identity = "";
let encryptionKeyV2Promise = null;
localStorage.removeItem("todo-identity");

const state = {
  identity: "", username: "", encryptionSeed: "", authMode: "login", authPromptOpen: true, authSubmitting: false, authDirty: false,
  authError: "", authUsername: "", authPassword: "", authConfirm: "", authResetCode: "", identityDraft: "",
  passwordDialog: false, themeColor: "violet", themeSaving: false, themeError: "", taskSortMode: "manual", sortModeSaving: false, sortModeError: "", tasks: [], view: "todo", tag: "全部", color: "全部", filtersOpen: wasLandscapeViewport, editor: null, datePicker: null, reminderPicker: null, pushStatus: null, dueReminders: [], draftTags: [], tagInput: "",
  updateApplying: false,
  syncStatus: "idle", syncError: "", syncCount: 0,
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
    themeColor: normalizeThemeColor(state.themeColor),
    taskSortMode: normalizeTaskSortMode(state.taskSortMode),
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
    state.themeColor = normalizeThemeColor(profile.themeColor);
    state.taskSortMode = normalizeTaskSortMode(profile.taskSortMode);
    state.authUsername = profile.username;
    state.authPromptOpen = false;
    state.tasks = Array.isArray(profile.tasks) ? profile.tasks : [];
    nextTemporaryTaskId = Number(profile.nextTemporaryTaskId) || -1;
    taskIdAliases.clear();
    (Array.isArray(profile.aliases) ? profile.aliases : []).forEach(([from, to]) => taskIdAliases.set(Number(from), Number(to)));
    markQueuedTasksUnsynced();
    encryptionKeyV2Identity = "";
    encryptionKeyV2Promise = null;
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
  if (serviceWorkerRegistration?.waiting) applyServiceWorkerUpdate();
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

function timeoutError(message) {
  const error = new Error(message);
  error.code = "timeout";
  return error;
}

function withTimeout(promise, timeoutMs, message) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function watchServiceWorkerInstallation(registration) {
  registration.addEventListener("updatefound", () => {
    const installingWorker = registration.installing;
    installingWorker?.addEventListener("statechange", () => {
      if (installingWorker.state === "redundant") scheduleServiceWorkerRetry();
      if (installingWorker.state === "installed" && navigator.serviceWorker.controller) applyServiceWorkerUpdate();
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
  const updateAttempt = serviceWorkerRegistration.update()
    .then((registration) => {
      if (registration.waiting) applyServiceWorkerUpdate();
      probeServiceWorkerVersion();
    })
    .catch((error) => {
      scheduleServiceWorkerRetry();
      throw error;
    });
  serviceWorkerUpdatePromise = withTimeout(updateAttempt, SERVICE_WORKER_UPDATE_TIMEOUT, "应用更新检查超时")
    .catch(() => scheduleServiceWorkerRetry())
    .finally(() => { serviceWorkerUpdatePromise = null; });
  return serviceWorkerUpdatePromise;
}

async function applyServiceWorkerUpdate() {
  if (state.updateApplying || !serviceWorkerRegistration?.waiting) return;
  // 自动更新：编辑、拖拽、登录弹窗或进行中的同步未结束时推迟到安全时机，避免刷新打断。
  if (state.editor || pointerDrag || state.authPromptOpen || pendingMutations) {
    if (!serviceWorkerUpdateRetryTimer) {
      serviceWorkerUpdateRetryTimer = setTimeout(() => {
        serviceWorkerUpdateRetryTimer = 0;
        applyServiceWorkerUpdate();
      }, 15_000);
    }
    return;
  }
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
  if (foregroundSyncPromise) {
    if (foregroundSyncPromiseEpoch === foregroundSyncEpoch) return foregroundSyncPromise;
    const activeSync = foregroundSyncPromise;
    return activeSync.then(() => synchronizeForeground());
  }
  const epoch = ++foregroundSyncEpoch;
  foregroundSyncPromiseEpoch = epoch;
  foregroundSyncPromise = (async () => {
    // 更新检查必须先开始并在有限时间内结束，不能永久阻塞远端同步。
    await checkForServiceWorkerUpdate({ force: true });
    if (epoch !== foregroundSyncEpoch || state.updateApplying) return;
    if (await refreshSessionLease({ epoch })) await flushOutboxAndLoad(epoch);
  })().finally(() => {
    foregroundSyncPromise = null;
    foregroundSyncPromiseEpoch = 0;
  });
  return foregroundSyncPromise;
}

async function refreshSessionLease({ epoch = foregroundSyncEpoch } = {}) {
  if (!state.identity || Date.now() - lastSessionLeaseAt < 7 * 86400_000) return true;
  const expectedUsername = state.username;
  try {
    const response = await api("/api/auth/session", { decrypt: false, timeoutMs: SYNC_REQUEST_TIMEOUT });
    if (epoch !== foregroundSyncEpoch || state.username !== expectedUsername) return false;
    if (!response.account?.encryptionSeed || response.account.username !== state.username) throw new Error("会话不匹配");
    state.encryptionSeed = response.account.encryptionSeed;
    state.themeColor = normalizeThemeColor(response.account.themeColor);
    state.taskSortMode = normalizeTaskSortMode(response.account.taskSortMode);
    lastSessionLeaseAt = Date.now();
    await persistLocalSnapshot();
    return true;
  } catch (error) {
    if (!handleAuthenticationError(error)) {
      setSyncStatus("failed", `会话检查失败：${error.message || "网络不可用"}`);
      render();
      scheduleOutboxSync(SYNC_RETRY_DELAYS[Math.min(outboxRetryAttempt++, SYNC_RETRY_DELAYS.length - 1)]);
    }
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
const isV2EncryptedText = (value) => {
  const text = String(value || "");
  return /^rtenc:v2:[A-Za-z0-9+/]+={0,2}$/.test(text);
};

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

function identitySeedBytes(seed = state.encryptionSeed) {
  return urlBase64ToUint8Array(String(seed || "").replace(/^u_/, ""));
}

function encryptionKeyForV2(seed = state.encryptionSeed) {
  if (!seed || !window.crypto?.subtle) {
    throw new Error("当前浏览器无法启用任务内容加密");
  }
  if (encryptionKeyV2Identity === seed && encryptionKeyV2Promise) return encryptionKeyV2Promise;
  encryptionKeyV2Identity = seed;
  encryptionKeyV2Promise = crypto.subtle.importKey(
    "raw",
    identitySeedBytes(seed),
    "HKDF",
    false,
    ["deriveKey"],
  ).then((keyMaterial) => crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt: new TextEncoder().encode(ENCRYPTION_SALT_V2),
    info: new TextEncoder().encode(ENCRYPTION_INFO_V2),
  }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
  return encryptionKeyV2Promise;
}

async function encryptText(value, identity = state.encryptionSeed) {
  const plaintext = String(value || "");
  if (!plaintext) return "";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKeyForV2(identity),
    new TextEncoder().encode(plaintext),
  ));
  const packed = new Uint8Array(iv.length + encrypted.length);
  packed.set(iv);
  packed.set(encrypted, iv.length);
  return `${ENCRYPTION_PREFIX_V2}${bytesToBase64(packed)}`;
}

async function decryptText(value, identity = state.encryptionSeed) {
  const stored = String(value || "");
  if (!stored) return "";
  if (!isV2EncryptedText(stored)) throw new Error("任务内容格式无效，请重新登录后再试");
  try {
    const packed = base64ToBytes(stored.slice(ENCRYPTION_PREFIX_V2.length));
    if (packed.length < 29) throw new Error("invalid ciphertext");
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: packed.slice(0, 12) },
      await encryptionKeyForV2(identity),
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
  const [title, details] = await Promise.all([
    decryptText(task.title, identity),
    decryptText(task.details || "", identity),
  ]);
  return { ...task, title, details };
}

async function decryptApiPayload(payload) {
  if (Array.isArray(payload.tasks)) payload.tasks = await Promise.all(payload.tasks.map((task) => decryptTaskContent(task)));
  if (payload.task) payload.task = await decryptTaskContent(payload.task);
  return payload;
}
const dateLabel = (date) => {
  if (!date) return "未安排";
  if (date === today()) return "今天";
  const [year, month, day] = date.split("-").map(Number);
  return year === Number(today().slice(0, 4)) ? `${month}月${day}日` : `${year}年${month}月${day}日`;
};
const reminderLabel = (reminder) => {
  if (!reminder?.remindAt) return "";
  const ms = Date.parse(reminder.remindAt);
  if (Number.isNaN(ms)) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: SHANGHAI_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms)).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const datePart = localDate === today() ? "今天" : (year === Number(today().slice(0, 4)) ? `${month}月${day}日` : `${year}年${month}月${day}日`);
  const freqText = { none: "", daily: "·每天", weekly: "·每周", monthly: "·每月" }[reminder.repeatRule?.freq] || "";
  return `${datePart} ${hour}:${parts.minute}${freqText}`;
};
const isOverdue = (task) => !task.completed && task.due_date && task.due_date < today();

function dueDistanceBadge(task) {
  if (task.completed || !task.due_date) return "";
  const millisecondsPerDay = 24 * 60 * 60 * 1_000;
  const distance = Math.round((Date.parse(`${task.due_date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / millisecondsPerDay);
  if (distance < 0) return `<span class="due-distance-badge is-overdue">逾期 ${Math.abs(distance)} 天</span>`;
  if (distance === 0) return '<span class="due-distance-badge is-today">今天到期</span>';
  if (distance <= 14) return `<span class="due-distance-badge is-upcoming">剩余 ${distance} 天</span>`;
  return "";
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

function reminderPicker() {
  if (!state.reminderPicker) return "";
  const picker = state.reminderPicker;
  const monthKey = picker.month;
  const [year, month] = monthKey.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const selected = picker.date || "";
  const dates = Array.from({ length: firstWeekday + daysInMonth }, (_, index) => {
    if (index < firstWeekday) return '<span class="calendar-day is-empty" aria-hidden="true"></span>';
    const day = index - firstWeekday + 1;
    const date = `${monthKey}-${String(day).padStart(2, "0")}`;
    const classes = ["calendar-day", date === selected ? "is-selected" : "", date === today() ? "is-today" : ""].filter(Boolean).join(" ");
    return `<button type="button" class="${classes}" data-action="pick-reminder-date" data-date="${date}">${day}</button>`;
  }).join("");
  const hour = String(picker.hour).padStart(2, "0");
  const minute = String(picker.minute).padStart(2, "0");
  const freqs = [["none", "不重复"], ["daily", "每天"], ["weekly", "每周"], ["monthly", "每月"]];
  const freqButtons = freqs.map(([value, label]) => `<button type="button" class="reminder-freq ${picker.freq === value ? "selected" : ""}" data-action="pick-reminder-freq" data-freq="${value}">${label}</button>`).join("");
  return `<div class="date-picker-backdrop"><section class="date-picker-sheet reminder-sheet" role="dialog" aria-modal="true" aria-label="设置提醒时间"><div class="sheet-grabber"></div><div class="date-picker-head"><button type="button" data-action="close-reminder-picker">取消</button><strong>提醒</strong><button type="button" data-action="clear-reminder">不设置</button></div><div class="calendar-nav"><button type="button" data-action="previous-reminder-month" aria-label="上个月">‹</button><span>${year}年${month}月</span><button type="button" data-action="next-reminder-month" aria-label="下个月">›</button></div><div class="calendar-weekdays"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div><div class="calendar-grid">${dates}</div><div class="reminder-time-row"><span>时间</span><div class="reminder-time-inputs"><input type="number" class="reminder-hour" min="0" max="23" value="${hour}" aria-label="小时" /><span>:</span><input type="number" class="reminder-minute" min="0" max="59" value="${minute}" aria-label="分钟" /></div></div><div class="reminder-freq-row"><span>重复</span><div class="reminder-freq-options">${freqButtons}</div></div><div class="reminder-confirm-row"><button type="button" class="save-button" data-action="confirm-reminder">确定</button></div></section></div>`;
}

async function api(path, options = {}) {
  const { decrypt = true, timeoutMs = 0, ...fetchOptions } = options;
  const controller = timeoutMs ? new AbortController() : null;
  const operation = (async () => {
    const response = await fetch(path, {
      ...fetchOptions,
      signal: controller?.signal || fetchOptions.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || "操作未完成");
      error.status = response.status;
      error.code = payload.code || "";
      throw error;
    }
    return decrypt ? decryptApiPayload(payload) : payload;
  })();
  if (!timeoutMs) return operation;
  try {
    return await withTimeout(operation, timeoutMs, "网络请求超时，请稍后重试");
  } finally {
    controller.abort();
  }
}

let lastReminderCheckAt = 0;

function urlBase64ToUint8Array(base64url) {
  const str = String(base64url || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fetchVapidPublicKey() {
  try {
    const response = await fetch("/api/push/vapid");
    if (!response.ok) return null;
    const data = await response.json();
    return data.publicKey || null;
  } catch { return null; }
}

// 统一从 PushSubscription 读取 p256dh/auth：优先用标准 getKey()，兼容 toJSON().keys 与非标准 keys 属性。
function pushSubscriptionKeys(subscription) {
  const arrayBufferToBase64Url = (buffer) => {
    if (!buffer || !buffer.byteLength) return "";
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  };
  const json = typeof subscription?.toJSON === "function" ? subscription.toJSON() : null;
  const legacy = json?.keys || subscription?.keys || {};
  const p256dh = legacy.p256dh || (typeof subscription?.getKey === "function" ? arrayBufferToBase64Url(subscription.getKey("p256dh")) : "");
  const auth = legacy.auth || (typeof subscription?.getKey === "function" ? arrayBufferToBase64Url(subscription.getKey("auth")) : "");
  return { p256dh, auth };
}

// 已授权时静默订阅 Web Push（不请求权限；Safari 等浏览器要求 requestPermission 在用户手势中调用）。
// onlyIfMissing 用于提醒设置等补充检查：本机已有有效订阅时直接返回，不重复向服务器注册。
async function subscribeIfPermitted({ onlyIfMissing = false } = {}) {
  if (!serviceWorkerRegistration || !("PushManager" in window)) return false;
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  try {
    let subscription = await serviceWorkerRegistration.pushManager.getSubscription();
    // 旧订阅可能缺少 p256dh/auth（例如由旧版本或旧 VAPID 密钥创建），缺少密钥时服务端无法推送，直接退订重建。
    if (subscription) {
      const existingKeys = pushSubscriptionKeys(subscription);
      if (!existingKeys.p256dh || !existingKeys.auth) {
        await subscription.unsubscribe().catch(() => {});
        subscription = null;
      }
    }
    if (subscription && onlyIfMissing) return true;
    const publicKey = await fetchVapidPublicKey();
    if (!publicKey) return false;
    if (!subscription) subscription = await serviceWorkerRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    const keys = pushSubscriptionKeys(subscription);
    if (!subscription.endpoint || !keys.p256dh || !keys.auth) return false;
    await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: navigator.userAgent }), decrypt: false, timeoutMs: 8000 });
    return true;
  } catch (error) {
    console.error("subscribeIfPermitted", error);
    return false;
  }
}

// 用户手势触发：请求通知权限并订阅。Safari 要求 requestPermission 在点击等手势中调用，否则静默拒绝。
async function requestNotificationPermission() {
  if (!("Notification" in window)) { alert("当前设备不支持通知"); return; }
  if (Notification.permission === "granted") {
    const subscribed = await subscribeIfPermitted();
    if (!subscribed) alert("推送订阅注册失败，请稍后在浏览器设置中确认通知已允许，再点击重试");
    return;
  }
  if (Notification.permission === "denied") { alert("通知已被禁用，请在浏览器设置中手动开启后刷新页面"); return; }
  try {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      const subscribed = await subscribeIfPermitted();
      if (!subscribed) alert("推送订阅注册失败，请稍后在浏览器设置中确认通知已允许，再点击重试");
      render();
    }
    else if (permission === "denied") alert("通知权限被拒绝，请在浏览器设置中手动开启");
  } catch (error) { console.error("requestNotificationPermission", error); }
}

// 设置提醒时间时顺带检查通知状态：未开启则在用户手势中请求权限并静默注册推送，不打断提醒设置。
async function ensureNotificationsEnabled() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") { await subscribeIfPermitted({ onlyIfMissing: true }); return; }
  if (Notification.permission === "denied") return;
  try {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      await subscribeIfPermitted();
      refreshPushStatus();
    }
  } catch (error) { console.error("ensureNotificationsEnabled", error); }
}

// 登出时取消本机订阅并通知服务器删除记录。
async function removePushSubscription() {
  if (!serviceWorkerRegistration || !("PushManager" in window)) return;
  try {
    const subscription = await serviceWorkerRegistration.pushManager.getSubscription();
    if (subscription) {
      await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }), decrypt: false, timeoutMs: 5000 }).catch(() => {});
      await subscription.unsubscribe();
    }
  } catch (error) {
    console.error("removePushSubscription", error);
  }
}

let pushStatusRequest = null;
// 真实上报：查询服务端是否已有本账号的推送订阅，并反馈 VAPID 配置状态。
async function refreshPushStatus() {
  if (!state.identity) { state.pushStatus = null; return null; }
  if (!pushStatusRequest) {
    pushStatusRequest = api("/api/push/status", { decrypt: false, timeoutMs: 5000 })
      .then((data) => { state.pushStatus = data; if (state.view === "profile") render(); return data; })
      .catch(() => { state.pushStatus = null; return null; })
      .finally(() => { pushStatusRequest = null; });
  }
  return pushStatusRequest;
}

function notificationStatusText() {
  if (!("Notification" in window)) return { label: "当前设备不支持通知", level: "unsupported", button: "" };
  const permission = Notification.permission;
  const server = state.pushStatus;
  if (permission === "denied") return { label: "通知已被禁用", level: "denied", button: "通知已禁用，如何开启？" };
  if (permission !== "granted") return { label: "通知未开启", level: "off", button: "开启通知" };
  if (server && server.vapidConfigured === false) return { label: "服务端未配置推送密钥", level: "error", button: "" };
  if (server && server.subscribed) return { label: "通知已开启", level: "on", button: "", test: true, deviceCount: server.endpoints || 1 };
  if (!server) return { label: "通知已开启", level: "on", button: "" };
  return { label: "通知已开启，但订阅未注册", level: "error", button: "重新开启推送" };
}

// 从 User-Agent 提取简明的设备描述（用于“我的”页设备浮窗）。
function deviceLabel(userAgent) {
  const ua = String(userAgent || "");
  const browser = ua.includes("Edg/") ? "Edge" : ua.includes("Firefox/") ? "Firefox" : ua.includes("Chrome/") ? "Chrome" : ua.includes("Safari/") ? "Safari" : "浏览器";
  const os = ua.includes("iPhone") ? "iPhone" : ua.includes("iPad") ? "iPad" : ua.includes("Mac OS X") ? "macOS" : ua.includes("Android") ? "Android" : ua.includes("Windows") ? "Windows" : "";
  const headless = ua.includes("Headless") ? "（无头）" : "";
  return `${browser} · ${os}${headless}`;
}

// weekly/monthly 是否应在今天触发：按上海时区比较星期/日期。
function reminderDueToday(remindAtMs, freq) {
  if (freq === "none" || freq === "daily") return true;
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: SHANGHAI_TIME_ZONE, weekday: "short", day: "2-digit" });
  const fmt = (ts) => Object.fromEntries(dtf.formatToParts(new Date(ts)).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  const remind = fmt(remindAtMs);
  const now = fmt(Date.now());
  if (freq === "weekly") return remind.weekday === now.weekday;
  if (freq === "monthly") return remind.day === now.day;
  return false;
}

// 前台定时检查到期提醒（覆盖页面打开场景；后台推送由 Worker Cron 负责）。
// none 用 remindAt 作 key 只提醒一次；重复频次用当天日期作 key 每天最多一次；weekly/monthly 严格按星期/日期匹配。
// 到期提醒始终显示应用内横幅（不依赖系统通知权限）；已授权时再额外弹出系统通知。
function checkDueReminders() {
  if (!state.identity || state.authPromptOpen || state.updateApplying) return;
  const now = Date.now();
  if (now - lastReminderCheckAt < 25_000) return;
  lastReminderCheckAt = now;
  const canNotify = ("Notification" in window) && Notification.permission === "granted";
  const todayKey = today();
  const nowParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: SHANGHAI_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(now)).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  const nowMin = Number(nowParts.hour === "24" ? 0 : nowParts.hour) * 60 + Number(nowParts.minute);
  let added = false;
  for (const task of state.tasks) {
    // enabled 仅表示后端是否已处理该提醒，不影响本设备未收到过提醒时的本地横幅；
    // 每个设备用 fireKey（localStorage）防重，已提醒过的不会重复弹出。
    if (task.completed || !task.reminder?.remindAt) continue;
    const ms = Date.parse(task.reminder.remindAt);
    if (Number.isNaN(ms)) continue;
    const freq = task.reminder.repeatRule?.freq || "none";
    if (freq === "none" && ms > now) continue;
    if ((freq === "weekly" || freq === "monthly") && !reminderDueToday(ms, freq)) continue;
    const remindParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: SHANGHAI_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms)).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
    const remindMin = Number(remindParts.hour === "24" ? 0 : remindParts.hour) * 60 + Number(remindParts.minute);
    if (nowMin < remindMin) continue;
    const fireKey = `rabbittodo-fired-${task.id}-${freq === "none" ? task.reminder.remindAt : todayKey}`;
    if (localStorage.getItem(`rabbittodo-reminder-dismissed-${fireKey}`)) continue;
    if (!state.dueReminders.some((item) => item.key === fireKey)) {
      state.dueReminders.push({ key: fireKey, taskId: task.id, title: task.title, remindAt: task.reminder.remindAt, freq });
      added = true;
    }
    if (canNotify && !localStorage.getItem(fireKey)) {
      try {
        new Notification("RabbitToDo 提醒", { body: task.title || "你有一条待办提醒", tag: fireKey, icon: "/rabbittodo-icon.png" });
        localStorage.setItem(fireKey, "1");
      } catch (error) { console.error("notification error", error); }
    }
  }
  if (added) render();
}

function dueReminderBanner() {
  state.dueReminders = state.dueReminders.filter((item) => {
    const task = state.tasks.find((candidate) => candidate.id === item.taskId);
    return Boolean(task && !task.completed && task.reminder);
  });
  if (!state.dueReminders.length) return "";
  return `<div class="due-reminder-bar" role="status">${state.dueReminders.map((item) => `<div class="due-reminder-item"><span>🔔 ${escapeHtml(item.title)}</span><button type="button" data-action="dismiss-reminder" data-key="${escapeHtml(item.key)}">知道了</button></div>`).join("")}</div>`;
}

async function enterAccount(account) {
  const seed = String(account.encryptionSeed || "");
  if (!/^u_[A-Za-z0-9_-]{43}$/.test(seed)) throw new Error("账号身份信息无效，请重新登录");
  foregroundSyncEpoch += 1;
  taskStateRevision += 1;
  const keepOfflineData = localProfile?.username === account.username && localProfile?.encryptionSeed === seed;
  state.identity = "authenticated";
  state.username = account.username;
  state.encryptionSeed = seed;
  state.themeColor = normalizeThemeColor(account.themeColor);
  state.themeSaving = false;
  state.themeError = "";
  state.taskSortMode = normalizeTaskSortMode(account.taskSortMode);
  state.sortModeSaving = false;
  state.sortModeError = "";
  encryptionKeyV2Identity = "";
  encryptionKeyV2Promise = null;
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
  state.dueReminders = [];
  if (!keepOfflineData) {
    taskIdAliases.clear();
    nextTemporaryTaskId = -1;
  }
  localProfile = { ...currentLocalSnapshot(), outbox: keepOfflineData ? (localProfile?.outbox || []) : [] };
  await persistLocalSnapshot();
  if (serviceWorkerRegistration) await synchronizeForeground(); else await flushOutboxAndLoad();
  await subscribeIfPermitted();
  await refreshPushStatus();
}

async function updateThemeColor(nextTheme) {
  const next = normalizeThemeColor(nextTheme);
  if (state.themeSaving || next === state.themeColor) return;
  const previous = state.themeColor;
  state.themeColor = next;
  state.themeSaving = true;
  state.themeError = "";
  render();
  try {
    const response = await api("/api/auth/preferences", { method: "PATCH", body: JSON.stringify({ themeColor: next }), decrypt: false });
    state.themeColor = normalizeThemeColor(response.account?.themeColor);
    state.themeSaving = false;
    await persistLocalSnapshot();
    render();
  } catch (error) {
    if (handleAuthenticationError(error)) return;
    state.themeColor = previous;
    state.themeSaving = false;
    state.themeError = error.message || "主题颜色保存失败，请重试";
    await persistLocalSnapshot().catch(() => {});
    render();
  }
}

async function updateTaskSortMode(nextMode) {
  const next = normalizeTaskSortMode(nextMode);
  if (state.sortModeSaving || next === state.taskSortMode) return;
  const previous = state.taskSortMode;
  state.taskSortMode = next;
  state.sortModeSaving = true;
  state.sortModeError = "";
  render();
  try {
    const response = await api("/api/auth/preferences", { method: "PATCH", body: JSON.stringify({ taskSortMode: next }), decrypt: false });
    state.taskSortMode = normalizeTaskSortMode(response.account?.taskSortMode);
    state.sortModeSaving = false;
    await persistLocalSnapshot();
    render();
  } catch (error) {
    if (handleAuthenticationError(error)) return;
    state.taskSortMode = previous;
    state.sortModeSaving = false;
    state.sortModeError = error.message || "排序方式保存失败，请重试";
    await persistLocalSnapshot().catch(() => {});
    render();
  }
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
  foregroundSyncEpoch += 1;
  taskStateRevision += 1;
  state.authUsername = state.username || state.authUsername;
  state.identity = ""; state.username = ""; state.encryptionSeed = ""; state.themeColor = "violet"; state.themeSaving = false; state.themeError = ""; state.taskSortMode = "manual"; state.sortModeSaving = false; state.sortModeError = ""; state.tasks = [];
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

function queuedTaskCount() {
  const taskIds = new Set();
  outbox().forEach((entry) => {
    if (["create", "update", "toggle", "delete"].includes(entry.kind)) {
      const id = Number(entry.payload.localId);
      if (Number.isFinite(id)) taskIds.add(id);
      return;
    }
    if (entry.kind === "reorder") {
      (Array.isArray(entry.payload.ids) ? entry.payload.ids : []).forEach((id) => {
        const taskId = Number(id);
        if (Number.isFinite(taskId)) taskIds.add(taskId);
      });
    }
  });
  return taskIds.size;
}

function setSyncStatus(status, error = "") {
  state.syncStatus = status;
  state.syncError = error;
  if (status === "syncing") state.syncCount = queuedTaskCount();
  else if (status === "failed") state.syncCount = queuedTaskCount();
  else if (status === "idle") state.syncCount = 0;
  if (syncNoticeTimer) clearTimeout(syncNoticeTimer);
  if (status === "success") {
    syncNoticeTimer = setTimeout(() => {
      syncNoticeTimer = 0;
      if (!outbox().length) {
        state.syncStatus = "idle";
        render();
      }
    }, 1_800);
  }
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
  setSyncStatus("idle");
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

function taskPayloadFromLocalSnapshot(task) {
  const reminder = task.reminder?.remindAt
    ? { reminderAt: task.reminder.remindAt, repeatRule: task.reminder.repeatRule, tz: task.reminder.tz }
    : { reminderAt: null };
  return {
    title: task.title,
    details: task.details || "",
    color: task.color,
    tags: Array.isArray(task.tags) ? task.tags : [],
    status: task.status || "none",
    dueDate: task.due_date || null,
    pinned: Boolean(task.pinned),
    ...reminder,
  };
}

function isStrictV2TaskPayload(task) {
  return Boolean(task && isV2EncryptedText(task.title) && (!task.details || isV2EncryptedText(task.details)));
}

async function encryptedPayloadForOutboxEntry(entry) {
  const localId = Number(entry.payload.localId);
  const resolvedId = resolvedTaskId(localId);
  const localTask = state.tasks.find((task) => Number(task.id) === localId || Number(task.id) === resolvedId);
  if (localTask) return encryptTaskContent(taskPayloadFromLocalSnapshot(localTask));
  if (isStrictV2TaskPayload(entry.payload.task)) return entry.payload.task;
  throw new Error("本地待同步事项内容无法恢复，请重新编辑后再试");
}

async function sendOutboxEntry(entry, { timeoutMs = 0 } = {}) {
  const requestOptions = timeoutMs ? { timeoutMs } : {};
  const localId = Number(entry.payload.localId);
  const resolvedId = resolvedTaskId(localId);
  // Reorder entries describe a complete list and deliberately have no localId.
  // Treating them as a single-task mutation made every queued sort return false
  // here, leaving it at the head of the outbox forever.
  if (entry.kind !== "create" && entry.kind !== "reorder" && (!resolvedId || resolvedId < 0)) return false;
  if (entry.kind === "create") {
    const task = await encryptedPayloadForOutboxEntry(entry);
    const response = await api("/api/tasks", { method: "POST", body: JSON.stringify(task), headers: { "X-RabbitTodo-Mutation": entry.id }, ...requestOptions });
    applyServerTask(response.task, localId, false);
    return true;
  }
  if (entry.kind === "update") {
    const task = await encryptedPayloadForOutboxEntry(entry);
    const response = await api(`/api/tasks/${resolvedId}`, { method: "PUT", body: JSON.stringify(task), ...requestOptions });
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
    const remoteTasks = (await api("/api/tasks", requestOptions)).tasks;
    const completed = Boolean(entry.payload.completed);
    const visibleRemoteTasks = remoteTasks.filter((task) => Boolean(task.completed) === completed);
    const remoteById = new Map(visibleRemoteTasks.map((task) => [Number(task.id), task]));
    const requestedPins = new Set((entry.payload.pinnedIds || []).map((id) => resolvedTaskId(id)));
    const requestedIds = [...new Set(entry.payload.ids.map((id) => resolvedTaskId(id)))]
      .filter((id) => remoteById.has(id));
    const requestedSet = new Set(requestedIds);
    const requestedTasks = requestedIds.map((id) => remoteById.get(id));
    const missingTasks = visibleRemoteTasks.filter((task) => !requestedSet.has(Number(task.id)));
    const orderedTasks = [
      ...requestedTasks.filter((task) => requestedPins.has(Number(task.id))),
      ...missingTasks.filter((task) => task.pinned),
      ...requestedTasks.filter((task) => !requestedPins.has(Number(task.id))),
      ...missingTasks.filter((task) => !task.pinned),
    ];
    const ids = orderedTasks.map((task) => Number(task.id));
    const pinnedIds = orderedTasks.filter((task) => requestedSet.has(Number(task.id)) ? requestedPins.has(Number(task.id)) : task.pinned).map((task) => Number(task.id));
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
    // sendOutboxEntry refreshes this list from the server and ignores stale
    // temporary ids, so an old local drag cannot block unrelated mutations.
    return ids.length > 0;
  }
  return resolvedTaskId(localId) > 0;
}

async function flushOutbox() {
  if (outboxSyncPromise || !state.identity || state.updateApplying || !outbox().length) return outboxSyncPromise;
  outboxSyncPromise = (async () => {
    pendingMutations += 1;
    setSyncStatus("syncing");
    render();
    try {
      while (outbox().length && !state.updateApplying) {
        // Historic queues can contain an old reorder/update that still refers
        // to a temporary id. It must not prevent later idempotent creates from
        // being repaired automatically once the connection is available.
        const entry = outbox().find(canSendOutboxEntry);
        if (!entry) {
          setSyncStatus("failed", "等待中的新建事项尚未获得服务器编号");
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
      setSyncStatus("success");
    } catch (error) {
      if (handleAuthenticationError(error)) return;
      if (isTransportFailure(error)) {
        const delay = SYNC_RETRY_DELAYS[Math.min(outboxRetryAttempt++, SYNC_RETRY_DELAYS.length - 1)];
        scheduleOutboxSync(delay);
      }
      setSyncStatus("failed", error.message || "同步失败");
    } finally {
      pendingMutations -= 1;
      outboxSyncPromise = null;
      render();
    }
  })();
  return outboxSyncPromise;
}

async function flushOutboxAndLoad(syncEpoch = foregroundSyncEpoch) {
  await flushOutbox();
  if (!state.updateApplying) await loadTasks({ quiet: true, syncEpoch });
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


async function loadTasks({ quiet = false, syncEpoch = foregroundSyncEpoch } = {}) {
  if (!state.identity) return render();
  if (taskSyncPromise) return taskSyncPromise;
  const expectedSeed = state.encryptionSeed;
  const expectedRevision = taskStateRevision;
  const syncPromise = (async () => {
    let applied = false;
    try {
      const remoteTasks = (await api("/api/tasks", { timeoutMs: SYNC_REQUEST_TIMEOUT })).tasks;
      if (syncEpoch !== foregroundSyncEpoch || expectedSeed !== state.encryptionSeed || expectedRevision !== taskStateRevision) {
        scheduleOutboxSync(500);
        return false;
      }
      state.tasks = mergeRemoteTasks(remoteTasks);
      lastTaskSyncAt = Date.now();
      await persistLocalSnapshot();
      if (!outbox().length && ["syncing", "failed"].includes(state.syncStatus)) setSyncStatus("success");
      applied = true;
    } catch (error) {
      if (!handleAuthenticationError(error)) {
        setSyncStatus("failed", `读取任务失败：${error.message || "网络不可用"}`);
        if (!quiet && !isReloadingForServiceWorker) alert(error.message);
      }
    } finally {
      if (taskSyncPromise === syncPromise) taskSyncPromise = null;
    }
    render();
    return applied;
  })();
  taskSyncPromise = syncPromise;
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
  if (state.taskSortMode === "auto") return compareAutomaticTodoTasks(left, right);
  if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
  const manualOrder = compareManualPosition(left, right);
  if (manualOrder) return manualOrder;
  const createdOrder = timestampValue(left.created_at) - timestampValue(right.created_at);
  if (createdOrder) return createdOrder;
  return Number(left.id) - Number(right.id);
}

function compareAutomaticTodoTasks(left, right) {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
  if (left.pinned && right.pinned) {
    const pinnedOrder = timestampValue(right.pinned_at) - timestampValue(left.pinned_at);
    if (pinnedOrder) return pinnedOrder;
    return Number(right.id) - Number(left.id);
  }

  const leftHasDueDate = Boolean(left.due_date);
  const rightHasDueDate = Boolean(right.due_date);
  if (leftHasDueDate !== rightHasDueDate) return leftHasDueDate ? -1 : 1;
  const statusRank = { in_progress: 0, none: 1, paused: 2 };
  if (leftHasDueDate && rightHasDueDate) {
    const dueOrder = String(left.due_date).localeCompare(String(right.due_date));
    if (dueOrder) return dueOrder;
  }
  const statusOrder = (statusRank[left.status || "none"] ?? 1) - (statusRank[right.status || "none"] ?? 1);
  if (statusOrder) return statusOrder;
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
  const draggable = !task.completed && state.taskSortMode === "manual";
  const status = task.status || "none";
  const statusBadge = !task.completed && status !== "none"
    ? `<span class="status-badge ${status}">${status === "in_progress" ? "进行中" : "暂停"}</span>`
    : "";
  const distanceBadge = dueDistanceBadge(task);
  const completionDate = completedDate(task);
  // 计划完成日期只在两种情况下展示：已完成任务，或距今超过 14 天的远期任务；
  // 14 天内（含今天）与超期任务只显示对应徽标，避免信息重复。
  const due = task.due_date && (task.completed || !distanceBadge) ? `<span class="due"><i class="due-icon">📅</i><span class="due-label">${dateLabel(task.due_date)}</span></span>` : "";
  const reminderBadge = task.reminder ? `<span class="reminder-badge"><i class="reminder-icon">🔔</i>${reminderLabel(task.reminder)}</span>` : "";
  const syncBadge = task._unsynced ? '<span class="sync-badge">未同步</span>' : "";
  return `<article class="task-card color-${task.color} ${task.completed ? "is-completed" : ""} ${draggable ? "is-draggable" : ""} ${overdue ? "is-overdue" : ""} ${showPinned ? "is-pinned" : ""}" data-task-id="${task.id}">
    <button class="check-button" data-action="toggle" data-id="${task.id}" aria-label="切换完成状态">${task.completed ? "✓" : ""}</button>
    <div class="task-body"><h3>${escapeHtml(task.title)}</h3><div class="task-meta">
      ${task.details ? `<p class="task-details">${escapeHtml(task.details)}</p>` : ""}${completionDate}${distanceBadge}${statusBadge}${due}${reminderBadge}${syncBadge}
      ${task.tags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join("")}
    </div></div><i class="task-color-dot ${showPinned ? "is-star" : ""}" ${showPinned ? 'aria-label="已置顶"' : ""}>${showPinned ? "★" : ""}</i>
  </article>`;
}

function taskLists(tasks) {
  const pageTasks = state.tasks.filter((task) => state.view === "done" ? task.completed : !task.completed);
  const hasPinnedZone = state.view === "todo" && pageTasks.some((task) => task.pinned);
  const manualSorting = state.view === "todo" && state.taskSortMode === "manual";
  const emptyMessage = state.view === "done" ? "还没有已完成的事项。" : "这里还没有待办事项，点击 + 添加第一项吧。";
  const regularTasks = state.view === "done" ? tasks : tasks.filter((task) => !task.pinned);
  const regularTitle = state.view === "done" ? "已完成事项" : "待办事项";
  const regularIcon = state.view === "done" ? "✓" : "☐";
  const regularZone = (hasPinnedClass = "") => `<section class="regular-zone ${hasPinnedClass}">
    <header class="task-zone-title regular-zone-title"><span><i>${regularIcon}</i>${regularTitle}</span><b>${regularTasks.length}</b></header>
    <section class="task-list regular-task-list" data-task-zone="regular">${regularTasks.map((task) => taskCard(task)).join("") || `<p class="${hasPinnedZone && manualSorting ? "drop-hint" : "empty-state"}">${hasPinnedZone && manualSorting ? "拖到这里取消置顶" : emptyMessage}</p>`}</section>
  </section>`;
  if (!hasPinnedZone) {
    const temporaryPinnedZone = manualSorting && tasks.length
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
    <section class="task-list pinned-task-list" data-task-zone="pinned">${pinnedTasks.map((task) => taskCard(task)).join("") || `<p class="${manualSorting ? "drop-hint" : "empty-state"}">${manualSorting ? "拖到这里置顶" : emptyMessage}</p>`}</section>
  </section>
  ${regularZone("has-pinned-zone")}`;
}

function syncNotice() {
  const count = queuedTaskCount();
  if (!count && !["success", "failed"].includes(state.syncStatus)) return "";
  const prefix = count || state.syncCount ? `${count || state.syncCount} 条事项` : "";
  if (state.syncStatus === "syncing") return `<p class="sync-notice is-syncing" role="status">${prefix}同步中…</p>`;
  if (state.syncStatus === "success") return `<p class="sync-notice is-success" role="status">${prefix}同步成功</p>`;
  if (state.syncStatus === "failed") return `<button class="sync-notice is-failed" type="button" data-action="sync-now">${prefix}${escapeHtml(state.syncError || "同步失败")}，点击重试</button>`;
  return `<button class="sync-notice" type="button" data-action="sync-now">${prefix}尚未同步，点击立即同步，或等待系统自动同步。</button>`;
}

function filters() {
  const tags = ["全部", ...[...new Set(state.tasks.flatMap((task) => task.tags))].sort((a, b) => a.localeCompare(b, "zh-CN"))];
  const summary = [state.tag, state.color === "全部" ? "" : COLOR_NAMES[state.color]].filter((item) => item && item !== "全部").join(" · ") || `全部${state.view === "done" ? "已办" : "待办"}`;
  const automaticSorting = state.taskSortMode === "auto";
  const sortControl = state.view === "todo" ? `<div class="sort-mode-switch"><span>自动排序</span><button class="sort-mode-toggle ${automaticSorting ? "is-auto" : ""}" data-action="toggle-sort-mode" type="button" role="switch" aria-label="自动排序" aria-checked="${automaticSorting}" ${state.sortModeSaving ? "disabled" : ""}><i></i></button></div>` : "";
  const sortError = state.view === "todo" && state.sortModeError ? `<p class="sort-mode-status is-error" role="alert">${escapeHtml(state.sortModeError)}</p>` : "";
  return `<section class="filter-panel ${state.filtersOpen ? "is-open" : ""}"><button class="filter-toggle" data-action="toggle-filters" aria-expanded="${state.filtersOpen}"><span class="filter-toggle-title">筛选</span><span class="filter-toggle-summary">${summary}</span><i>⌄</i></button>${state.filtersOpen ? `<div class="filter-panel-content"><div class="filter-group"><div class="filter-group-header"><p>按标签</p>${sortControl}</div>${sortError}<div class="filters">${tags.map((tag) => `<button data-action="tag-filter" data-tag="${escapeHtml(tag)}" class="${state.tag === tag ? "filter-active" : ""}">${escapeHtml(tag)}</button>`).join("")}</div></div>
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
    ? `<button type="button" class="due-date-value" data-action="open-date-picker"><i>📅</i>${dateLabel(task.due_date)}</button><button type="button" class="clear-date-button" data-action="clear-due-date">清除</button>`
    : '<button type="button" class="set-date-button" data-action="open-date-picker">设置日期</button>';
  const reminderControl = task.reminder
    ? `<button type="button" class="due-date-value" data-action="open-reminder-picker"><i>🔔</i>${reminderLabel(task.reminder)}</button><button type="button" class="clear-date-button" data-action="clear-reminder-editor">清除</button>`
    : '<button type="button" class="set-date-button" data-action="open-reminder-picker">设置提醒</button>';
  return `<div class="modal-backdrop"><form class="composer" id="task-form"><div class="sheet-grabber"></div><div class="composer-head"><h2>${task.id ? "编辑事项" : "新建事项"}</h2><button type="button" data-action="close-editor">取消</button></div>
    <input id="task-title" value="${escapeHtml(task.title)}" placeholder="想完成什么？" autofocus required maxlength="200" />
    <textarea id="task-details" placeholder="补充任务详情（可选）" maxlength="2000">${escapeHtml(task.details || "")}</textarea>
    <div class="composer-row"><span>颜色标签</span><div class="color-options">${COLORS.map((color) => `<button type="button" class="color-picker ${color} ${task.color === color ? "selected" : ""}" data-action="pick-color" data-color="${color}">${task.color === color ? "✓" : ""}</button>`).join("")}</div></div>
    ${task.completed ? "" : statusEditor(task)}${pinEditor(task)}${tagsEditor()}<div class="composer-row due-date-row"><span>计划完成</span><div class="due-date-control">${dueDateControl}</div></div><div class="composer-row due-date-row"><span>提醒</span><div class="due-date-control">${reminderControl}</div></div>
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

function pageHeader(heading, brand = "RabbitToDo") {
  return `<header class="topbar"><div><p class="eyebrow"><b class="brand-inline">${brand}</b>　${new Intl.DateTimeFormat("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, month: "long", day: "numeric", weekday: "short" }).format(new Date())}</p><h1>${heading}</h1></div><button class="avatar" data-action="profile" aria-label="查看我的"><i class="avatar-icon"><img src="/rabbittodo-avatar.png" alt="" /></i><span>Hi, ${escapeHtml(state.username || "我的")}</span></button></header>`;
}

function profilePage() {
  const passwordForm = state.passwordDialog ? '<form id="change-password-form" class="account-form"><input id="current-password" type="password" placeholder="当前密码" required /><input id="new-password" type="password" placeholder="新密码（至少 8 位）" required /><input id="new-password-confirm" type="password" placeholder="再次输入新密码" required /><button class="save-button" type="submit">更新密码</button></form>' : "";
  const notif = notificationStatusText();
  const notifBtn = !("Notification" in window) || !notif.button ? "" : `<button type="button" class="save-button notification-toggle" data-action="${notif.test ? "send-test-push" : "enable-notifications"}">${notif.button}</button>`;
  const notifLink = notif.test ? `<a href="#" class="notification-test-link" data-action="send-test-push">发送测试通知</a>` : "";
  const devices = state.pushStatus?.devices || [];
  const deviceLink = notif.test ? `<a href="#" class="notification-devices" data-action="toggle-devices">${notif.deviceCount} 台设备</a>` : "";
  const devicePanel = state.pushDevicesOpen && devices.length ? `<div class="device-popover">${devices.map((device) => `<div class="device-item"><span class="device-name">${escapeHtml(deviceLabel(device.userAgent))}</span><span class="device-meta">注册于 ${escapeHtml(String(device.createdAt || "").slice(0, 10))}</span><button type="button" data-action="remove-device" data-endpoint="${escapeHtml(device.endpoint)}">移除</button></div>`).join("")}</div>` : "";
  const themeOptions = COLORS.map((color) => `<button type="button" class="theme-option theme-${color} ${state.themeColor === color ? "is-selected" : ""}" data-action="pick-theme" data-theme="${color}" aria-label="${COLOR_NAMES[color]}" aria-pressed="${state.themeColor === color}" ${state.themeSaving ? "disabled" : ""}><i></i><span>${COLOR_NAMES[color]}</span></button>`).join("");
  const themeStatus = state.themeSaving ? '<p class="theme-status" role="status">正在保存主题…</p>' : state.themeError ? `<p class="theme-status is-error" role="alert">${escapeHtml(state.themeError)}</p>` : '<p class="theme-status">新建事项会默认使用所选主题色</p>';
  return `<section class="profile-page">${pageHeader("我的")}<section class="profile-card"><div class="profile-icon"><img src="/rabbittodo-avatar.png" alt="RabbitToDo" /></div><p>当前账号</p><strong class="username-display">${escapeHtml(state.username)}</strong><span>登录同一账号，换一台设备也能继续管理待办。</span><section class="theme-settings" aria-labelledby="theme-settings-title"><h2 id="theme-settings-title">主题颜色</h2><div class="theme-options">${themeOptions}</div>${themeStatus}</section>${passwordForm}<p class="notification-status">🔔 ${notif.label}（${deviceLink}）${notifLink}</p>${devicePanel}${notifBtn}<div class="profile-actions"><button data-action="change-password">${state.passwordDialog ? "取消修改" : "修改密码"}</button><button data-action="logout">退出登录</button></div></section><p class="version-label">版本 ${APP_VERSION}</p></section>`;
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
  document.documentElement.dataset.theme = state.identity && !state.authPromptOpen ? normalizeThemeColor(state.themeColor) : "violet";
  persistentAvatar = app.querySelector(".avatar") || persistentAvatar;
  persistentProfileIcon = app.querySelector(".profile-icon") || persistentProfileIcon;
  persistentIdentitySymbol = app.querySelector(".identity-symbol") || persistentIdentitySymbol;
  const tasks = filteredTasks();
  const taskContent = taskLists(tasks);
  const heading = { todo: "待办", done: "已办", profile: "我的" }[state.view];
  const overviewContent = `${pageHeader(heading, state.view === "done" ? "RabbitDone" : "RabbitToDo")}${filters()}`;
  const pageContent = state.view === "profile"
    ? profilePage()
    : `<section class="workspace workspace-${state.view}" data-view="${state.view}" data-tag="${escapeHtml(state.tag)}" data-color="${escapeHtml(state.color)}"><aside class="workspace-overview">${overviewContent}</aside><main class="workspace-tasks">${syncNotice()}${dueReminderBanner()}${taskContent}<p class="task-encryption-note"><i>🔒</i>待办事项内容均已加密存储</p></main></section>`;
  const tabbarHasAddButton = state.view !== "profile";
  const todoIsActive = state.view === "todo";
  const doneIsActive = state.view === "done";
  app.innerHTML = `<section class="phone"><div class="content-scroll ${state.view === "profile" ? "content-scroll-profile" : "content-scroll-tasks"}">${pageContent}</div>
    <nav class="tabbar tabbar-compact ${tabbarHasAddButton ? "tabbar-has-add" : ""}" aria-label="主导航"><button data-action="view" data-view="todo" class="${todoIsActive ? "active" : ""}" ${todoIsActive ? 'aria-current="page"' : ""}><span aria-hidden="true">☐</span>待办</button>${tabbarHasAddButton ? '<button class="add-button" data-action="add" aria-label="添加事项"><span class="add-button-icon" aria-hidden="true">+</span></button>' : ""}<button data-action="view" data-view="done" class="${doneIsActive ? "active" : ""}" ${doneIsActive ? 'aria-current="page"' : ""}><span aria-hidden="true">✓</span>已办</button></nav></section>${editor()}${datePicker()}${reminderPicker()}${identityGate()}`;
  const nextAvatar = app.querySelector(".avatar");
  if (persistentAvatar && nextAvatar && persistentAvatar !== nextAvatar) {
    persistentAvatar.querySelector("span").textContent = nextAvatar.querySelector("span").textContent;
    persistentAvatar.querySelector("img").src = nextAvatar.querySelector("img").src;
    nextAvatar.replaceWith(persistentAvatar);
  } else if (nextAvatar) persistentAvatar = nextAvatar;
  const nextProfileIcon = app.querySelector(".profile-icon");
  if (persistentProfileIcon && nextProfileIcon && persistentProfileIcon !== nextProfileIcon) {
    persistentProfileIcon.querySelector("img").src = nextProfileIcon.querySelector("img").src;
    nextProfileIcon.replaceWith(persistentProfileIcon);
  }
  else if (nextProfileIcon) persistentProfileIcon = nextProfileIcon;
  const nextIdentitySymbol = app.querySelector(".identity-symbol");
  if (persistentIdentitySymbol && nextIdentitySymbol && persistentIdentitySymbol !== nextIdentitySymbol) nextIdentitySymbol.replaceWith(persistentIdentitySymbol);
  else if (nextIdentitySymbol) persistentIdentitySymbol = nextIdentitySymbol;
  restoreTaskScroll(scrollSnapshot);
  scheduleTabbarAlignment();
}

function openEditor(task = { title: "", details: "", color: state.themeColor, status: "none", tags: [], due_date: "", pinned: false, pinned_at: null, reminder: null }) { state.editor = { ...task, status: task.status || "none", pinned: Boolean(task.pinned), reminder: task.reminder || null }; state.datePicker = null; state.reminderPicker = null; state.draftTags = [...task.tags]; state.tagInput = ""; render(); }
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
  if (!pointerDrag || pointerDrag.started || state.taskSortMode !== "manual") return;
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
  if (state.view !== "todo" || state.taskSortMode !== "manual") return;
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
  taskStateRevision += 1;
  render();
  // A normal drag is an immediate write. Only a real transport failure leaves
  // this order in the outbox and shows the pending-sync notice.
  publishTaskMutation("reorder", payload).catch((error) => alert(error.message));
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
  if (state.view !== "todo" || state.taskSortMode !== "manual" || event.button !== 0 || pendingMutations || state.editor) return;
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
    if (action === "sync-now") {
      setSyncStatus("syncing");
      render();
      return flushOutboxAndLoad();
    }
    if (action === "add") return openEditor();
    if (action === "close-editor") {
      state.editor = null;
      state.datePicker = null;
      state.reminderPicker = null;
      render();
      reloadForServiceWorkerUpdate();
      return;
    }
    if (action === "view") { state.view = button.dataset.view; return render(); }
    if (action === "profile") { state.view = "profile"; refreshPushStatus(); return render(); }
    if (action === "auth-login") return openAuth("login");
    if (action === "auth-register") return openAuth("register");
    if (action === "auth-reset") return openAuth("reset");
    if (action === "change-password") { state.passwordDialog = !state.passwordDialog; return render(); }
    if (action === "pick-theme") return updateThemeColor(button.dataset.theme);
    if (action === "logout") {
      await removePushSubscription();
      try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
      state.authUsername = state.username;
      await localClear().catch(() => {});
      foregroundSyncEpoch += 1;
      taskStateRevision += 1;
      localProfile = null; taskIdAliases.clear(); nextTemporaryTaskId = -1;
      state.identity = ""; state.username = ""; state.encryptionSeed = ""; state.themeColor = "violet"; state.themeSaving = false; state.themeError = ""; state.taskSortMode = "manual"; state.sortModeSaving = false; state.sortModeError = ""; state.tasks = []; state.view = "todo"; state.authMode = "login"; state.authPromptOpen = true; state.authDirty = false; state.authError = ""; state.authPassword = ""; state.authConfirm = ""; state.authResetCode = ""; state.passwordDialog = false; state.pushStatus = null; state.dueReminders = []; encryptionKeyV2Identity = ""; encryptionKeyV2Promise = null; return render();
    }
    if (action === "enable-notifications") { await requestNotificationPermission(); await refreshPushStatus(); return render(); }
    if (action === "send-test-push") {
      try {
        const result = await api("/api/push/test", { method: "POST", body: "{}", decrypt: false, timeoutMs: 20000 });
        console.log("推送测试详情:", result.details);
        alert(`已向 ${result.endpoints} 台设备发送测试通知：成功 ${result.sent}，失败 ${result.failed}（详见控制台）`);
      } catch (error) { alert(`测试推送失败：${error.message}`); }
      await refreshPushStatus();
      return render();
    }
    if (action === "toggle-devices") { state.pushDevicesOpen = !state.pushDevicesOpen; return render(); }
    if (action === "remove-device") {
      const endpoint = String(button.dataset.endpoint || "");
      if (!endpoint) return;
      try { await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }), decrypt: false, timeoutMs: 5000 }); } catch {}
      await refreshPushStatus();
      return render();
    }
    if (action === "dismiss-reminder") {
      const key = String(button.dataset.key || "");
      if (key) localStorage.setItem(`rabbittodo-reminder-dismissed-${key}`, "1");
      state.dueReminders = state.dueReminders.filter((item) => item.key !== key);
      return render();
    }
    if (action === "toggle-filters") { state.filtersOpen = !state.filtersOpen; return render(); }
    if (action === "toggle-sort-mode") return updateTaskSortMode(state.taskSortMode === "manual" ? "auto" : "manual");
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
    if (action === "open-reminder-picker") {
      const r = state.editor.reminder;
      if (r && r.remindAt) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: SHANGHAI_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(r.remindAt)).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
        state.reminderPicker = { month: `${parts.year}-${parts.month}`, date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour === "24" ? 0 : parts.hour), minute: Number(parts.minute), freq: r.repeatRule?.freq || "none" };
    } else {
      const t = today();
      const nowParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: SHANGHAI_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
      state.reminderPicker = { month: t.slice(0, 7), date: t, hour: Number(nowParts.hour === "24" ? 0 : nowParts.hour), minute: Number(nowParts.minute), freq: "none" };
    }
      return render();
    }
    if (action === "close-reminder-picker") { state.reminderPicker = null; return render(); }
    if (action === "previous-reminder-month") { state.reminderPicker.month = shiftMonth(state.reminderPicker.month, -1); return render(); }
    if (action === "next-reminder-month") { state.reminderPicker.month = shiftMonth(state.reminderPicker.month, 1); return render(); }
    if (action === "pick-reminder-date") { state.reminderPicker.date = button.dataset.date; return render(); }
    if (action === "pick-reminder-freq") { state.reminderPicker.freq = button.dataset.freq; return render(); }
    if (action === "clear-reminder") { state.editor.reminder = null; state.reminderPicker = null; return render(); }
    if (action === "clear-reminder-editor") { state.editor.reminder = null; return render(); }
    if (action === "confirm-reminder") {
      const p = state.reminderPicker;
      if (!p.date) return;
      const localStr = `${p.date}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:00`;
      const utcIso = new Date(`${localStr}+08:00`).toISOString();
      state.editor.reminder = { remindAt: utcIso, tz: SHANGHAI_TIME_ZONE, repeatRule: { freq: p.freq }, enabled: true };
      state.reminderPicker = null;
      ensureNotificationsEnabled();
      return render();
    }
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
      taskStateRevision += 1;
      render();
      await persistLocalSnapshot();
      publishTaskMutation("toggle", { localId: id, completed }).catch((error) => alert(error.message));
      return;
    }
    if (action === "delete-task") {
      if (!confirm("删除这项待办？")) return;
      const id = Number(state.editor.id);
      state.tasks = state.tasks.filter((task) => task.id !== id);
      state.editor = null;
      taskStateRevision += 1;
      render();
      await persistLocalSnapshot();
      publishTaskMutation("delete", { localId: id }).catch((error) => alert(error.message));
      return;
    }
    return;
  }
  const card = event.target.closest("[data-task-id]");
  if (card) openEditor(state.tasks.find((task) => task.id === Number(card.dataset.taskId)));
});

// 点击设备浮窗以外区域时收起浮窗。
document.addEventListener("click", (event) => {
  if (state.pushDevicesOpen && !event.target.closest(".device-popover, .notification-devices")) {
    state.pushDevicesOpen = false;
    render();
  }
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
  if (event.target.classList?.contains("reminder-hour")) { if (state.reminderPicker) state.reminderPicker.hour = Math.max(0, Math.min(23, Number(event.target.value) || 0)); return; }
  if (event.target.classList?.contains("reminder-minute")) { if (state.reminderPicker) state.reminderPicker.minute = Math.max(0, Math.min(59, Number(event.target.value) || 0)); return; }
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
      const reminder = state.editor.reminder;
      const reminderFields = reminder ? { reminderAt: reminder.remindAt, repeatRule: reminder.repeatRule, tz: reminder.tz } : { reminderAt: null };
      const payload = { title, details, color: state.editor.color, status: state.editor.status || "none", tags, dueDate, pinned: Boolean(state.editor.pinned), ...reminderFields };
      const editingId = Number(state.editor.id || 0);
      if (editingId) {
        const localTask = state.tasks.find((task) => task.id === editingId);
        const previousTask = localTask ? { ...localTask, tags: [...localTask.tags] } : null;
        if (localTask) {
          const pinnedAt = payload.pinned ? (localTask.pinned ? localTask.pinned_at : new Date().toISOString()) : null;
          Object.assign(localTask, { title, details, color: payload.color, status: payload.status, tags, due_date: dueDate, pinned: payload.pinned, pinned_at: pinnedAt, reminder: state.editor.reminder || null });
        }
        state.editor = null;
        taskStateRevision += 1;
        render();
        const encryptedPayload = await encryptTaskContent(payload);
        try {
          await publishTaskMutation("update", { localId: editingId, task: encryptedPayload });
        } catch (error) {
          if (previousTask && state.identity) {
            const index = state.tasks.findIndex((task) => task.id === editingId);
            if (index >= 0) state.tasks[index] = previousTask;
            taskStateRevision += 1;
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
          manual_position: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), reminder: state.editor.reminder || null,
        });
        state.editor = null;
        state.view = "todo";
        taskStateRevision += 1;
        render();
        const encryptedPayload = await encryptTaskContent(payload);
        try {
          await publishTaskMutation("create", { localId: temporaryId, task: encryptedPayload });
        } catch (error) {
          if (state.identity) {
            state.tasks = state.tasks.filter((task) => task.id !== temporaryId);
            taskStateRevision += 1;
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
  checkDueReminders();
});
window.addEventListener("online", () => {
  outboxRetryAttempt = 0;
  scheduleOutboxSync(500);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { synchronizeForeground(); checkDueReminders(); }
});
setInterval(() => {
  refreshActiveTasks();
  checkDueReminders();
  if (state.identity && !state.authPromptOpen && !state.updateApplying && document.visibilityState !== "hidden" && outbox().length) flushOutboxAndLoad();
}, 30_000);

async function restoreSession() {
  const rememberedUsername = state.username || localProfile?.username || "";
  if (!rememberedUsername) return render();
  try {
    const response = await api("/api/auth/session", { decrypt: false, timeoutMs: SYNC_REQUEST_TIMEOUT });
    if (!response.account || response.account.username !== rememberedUsername) throw new Error("会话不匹配");
    state.identity = "authenticated"; state.username = response.account.username; state.encryptionSeed = response.account.encryptionSeed || state.encryptionSeed; state.themeColor = normalizeThemeColor(response.account.themeColor); state.taskSortMode = normalizeTaskSortMode(response.account.taskSortMode); state.authPromptOpen = false;
    encryptionKeyV2Identity = ""; encryptionKeyV2Promise = null;
    lastSessionLeaseAt = Date.now();
    await persistLocalSnapshot();
    if (serviceWorkerRegistration) await synchronizeForeground(); else await flushOutboxAndLoad();
    await subscribeIfPermitted();
    await refreshPushStatus();
  } catch (error) {
    if (error.status === 401 || error.status === 403) handleAuthenticationError(error);
    else {
      setSyncStatus("failed", `会话恢复失败：${error.message || "网络不可用"}`);
      render();
      scheduleOutboxSync(SYNC_RETRY_DELAYS[Math.min(outboxRetryAttempt++, SYNC_RETRY_DELAYS.length - 1)]);
    }
  }
}

async function bootstrapAfterServiceWorker() {
  await synchronizeForeground();
  if (!state.identity) return render();
  await subscribeIfPermitted();
  await refreshPushStatus();
}

let serviceWorkerBootstrapStarted = false;

function adoptServiceWorkerRegistration(registration) {
  if (serviceWorkerBootstrapStarted) return;
  serviceWorkerBootstrapStarted = true;
  serviceWorkerRegistration = registration;
  watchServiceWorkerInstallation(registration);
  bootstrapAfterServiceWorker();
}

async function bootstrap() {
  const restored = await restoreLocalSnapshot();
  if (!restored) render();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "RABBITTODO_SW_VERSION") handleServiceWorkerVersion(event.data.version);
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (state.updateApplying) reloadForServiceWorkerUpdate();
      else probeServiceWorkerVersion();
    });
    const registrationAttempt = navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    registrationAttempt.then(adoptServiceWorkerRegistration).catch(() => {});
    withTimeout(registrationAttempt, SERVICE_WORKER_UPDATE_TIMEOUT, "Service Worker 注册超时").catch(() => restoreSession());
  } else {
    restoreSession();
  }
}

bootstrap();
