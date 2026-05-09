// ふわっとタスク管理アプリ
// - localStorage に常時自動保存
// - 直近30世代の履歴を保持（自動バックアップ第1層）
// - JSON ダウンロードによる手動 / 週次自動バックアップ（第2層）
// - Firebase Firestore を設定すれば PC ⇄ スマホ間で自動同期（第3層）

import { startSync, stopSync, isSyncActive } from "./sync.js";

const STORAGE_KEY = "fuwatto_tasks_v1";
const HISTORY_KEY = "fuwatto_history_v1";
const SETTINGS_KEY = "fuwatto_settings_v1";
const LAST_BACKUP_KEY = "fuwatto_last_backup_v1";
const HISTORY_LIMIT = 30;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const state = {
  tasks: /** @type {Task[]} */ ([]),
  filter: { search: "", status: "all", priority: "all" },
  sort: "deadline",
  editingId: null,
  remoteSubscribed: false,
};

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} details
 * @property {string} deadline  ISO string or ""
 * @property {"low"|"mid"|"high"} priority
 * @property {"todo"|"doing"|"done"} status
 * @property {string[]} tags
 * @property {number} createdAt
 * @property {number} updatedAt
 */

// ---------- ストレージ ----------

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTasks(showStatus = true) {
  const json = JSON.stringify(state.tasks);
  localStorage.setItem(STORAGE_KEY, json);
  pushHistory(json);
  if (showStatus) setSyncStatus("ok", isSyncActive() ? "保存・同期済み" : "この端末に保存済み");
  if (isSyncActive()) {
    setSyncStatus("sync", "同期中…");
    window.dispatchEvent(new CustomEvent("fuwatto:push", { detail: state.tasks }));
  }
}

function pushHistory(json) {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    list.push({ at: Date.now(), data: json });
    while (list.length > HISTORY_LIMIT) list.shift();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // 履歴は壊れていても本データには影響させない
  }
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ---------- ユーティリティ ----------

const uid = () =>
  Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

function setSyncStatus(kind, text) {
  const dot = $("#syncDot");
  const t = $("#syncText");
  dot.className = "dot " + kind;
  t.textContent = text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function fmtDeadline(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  let cls = "";
  if (diff < 0) cls = "over";
  else if (diff < oneDay * 2) cls = "soon";
  const label = d.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  return { label, cls };
}

function priorityLabel(p) {
  return { high: "優先度: 高", mid: "優先度: 中", low: "優先度: 低" }[p] || "優先度: 中";
}

function priorityRank(p) {
  return { high: 0, mid: 1, low: 2 }[p] ?? 1;
}

// ---------- 描画 ----------

function render() {
  const cols = {
    todo: $("#col-todo"),
    doing: $("#col-doing"),
    done: $("#col-done"),
  };
  Object.values(cols).forEach((c) => (c.innerHTML = ""));
  const counts = { todo: 0, doing: 0, done: 0 };

  const filtered = filterAndSort(state.tasks);
  for (const task of filtered) {
    cols[task.status].appendChild(renderCard(task));
    counts[task.status]++;
  }
  $("#count-todo").textContent = counts.todo;
  $("#count-doing").textContent = counts.doing;
  $("#count-done").textContent = counts.done;
}

function filterAndSort(tasks) {
  const { search, status, priority } = state.filter;
  const q = search.trim().toLowerCase();
  let list = tasks.filter((t) => {
    if (status !== "all" && t.status !== status) return false;
    if (priority !== "all" && t.priority !== priority) return false;
    if (q) {
      const blob = (t.title + " " + t.details + " " + (t.tags || []).join(" ")).toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  const sortBy = state.sort;
  list.sort((a, b) => {
    if (sortBy === "deadline") {
      const av = a.deadline ? new Date(a.deadline).getTime() : Infinity;
      const bv = b.deadline ? new Date(b.deadline).getTime() : Infinity;
      if (av !== bv) return av - bv;
      return priorityRank(a.priority) - priorityRank(b.priority);
    }
    if (sortBy === "priority") {
      const r = priorityRank(a.priority) - priorityRank(b.priority);
      if (r !== 0) return r;
      const av = a.deadline ? new Date(a.deadline).getTime() : Infinity;
      const bv = b.deadline ? new Date(b.deadline).getTime() : Infinity;
      return av - bv;
    }
    if (sortBy === "created") return b.createdAt - a.createdAt;
    if (sortBy === "updated") return b.updatedAt - a.updatedAt;
    return 0;
  });
  return list;
}

function renderCard(task) {
  const el = document.createElement("article");
  el.className = "card";
  el.draggable = true;
  el.dataset.id = task.id;
  el.tabIndex = 0;

  const dl = fmtDeadline(task.deadline);
  const tagsHtml = (task.tags || [])
    .filter(Boolean)
    .map((t) => `<span class="chip tag">#${escapeHtml(t)}</span>`)
    .join("");

  el.innerHTML = `
    <div class="quick">
      <button title="編集" data-action="edit">✎</button>
      <button title="複製" data-action="duplicate">⎘</button>
      <button title="削除" data-action="delete">🗑</button>
    </div>
    <h3 class="title">${escapeHtml(task.title || "(タイトルなし)")}</h3>
    ${task.details ? `<p class="details">${escapeHtml(task.details)}</p>` : ""}
    <div class="meta">
      <span class="chip priority ${task.priority}">${priorityLabel(task.priority)}</span>
      ${dl ? `<span class="chip deadline ${dl.cls}">⏰ ${escapeHtml(dl.label)}</span>` : ""}
      ${tagsHtml}
    </div>
  `;

  el.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (btn) {
      const a = btn.dataset.action;
      if (a === "edit") openEditor(task.id);
      if (a === "delete") deleteTask(task.id);
      if (a === "duplicate") duplicateTask(task.id);
      e.stopPropagation();
      return;
    }
    openEditor(task.id);
  });

  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openEditor(task.id);
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteTask(task.id);
    }
  });

  el.addEventListener("dragstart", (e) => {
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", task.id);
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));

  return el;
}

// ---------- CRUD ----------

function newTask(partial = {}) {
  const now = Date.now();
  /** @type {Task} */
  const t = {
    id: uid(),
    title: "",
    details: "",
    deadline: "",
    priority: "mid",
    status: "todo",
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
  state.tasks.push(t);
  saveTasks();
  return t;
}

function updateTask(id, patch) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch, { updatedAt: Date.now() });
  saveTasks();
  render();
}

function deleteTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`「${t.title || "(タイトルなし)"}」を削除しますか？`)) return;
  state.tasks = state.tasks.filter((x) => x.id !== id);
  saveTasks();
  render();
  toast("削除しました");
}

function duplicateTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const copy = { ...t, id: uid(), title: t.title + "（コピー）", createdAt: Date.now(), updatedAt: Date.now() };
  state.tasks.push(copy);
  saveTasks();
  render();
  toast("複製しました");
}

// ---------- 編集モーダル ----------

const editor = $("#editor");
const editorForm = $("#editorForm");

function openEditor(id) {
  let task;
  if (id) {
    task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    state.editingId = id;
    $("#editorTitle").textContent = "タスクを編集";
    $("#deleteBtn").style.display = "";
  } else {
    task = newTask({});
    state.editingId = task.id;
    $("#editorTitle").textContent = "新しいタスク";
    $("#deleteBtn").style.display = "none";
  }
  $("#f-title").value = task.title;
  $("#f-details").value = task.details;
  $("#f-deadline").value = task.deadline ? toLocalInput(task.deadline) : "";
  $("#f-priority").value = task.priority;
  $("#f-status").value = task.status;
  $("#f-tags").value = (task.tags || []).join(", ");
  editor.showModal();
  setTimeout(() => $("#f-title").focus(), 30);
}

function closeEditor() {
  if (editor.open) editor.close();
  state.editingId = null;
}

function toLocalInput(iso) {
  // datetime-local 用に "YYYY-MM-DDTHH:mm" へ
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

editorForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!state.editingId) return;
  const tags = $("#f-tags").value.split(",").map((s) => s.trim()).filter(Boolean);
  const patch = {
    title: $("#f-title").value.trim(),
    details: $("#f-details").value,
    deadline: $("#f-deadline").value ? new Date($("#f-deadline").value).toISOString() : "",
    priority: $("#f-priority").value,
    status: $("#f-status").value,
    tags,
  };
  updateTask(state.editingId, patch);
  toast("保存しました ♡");
  closeEditor();
});

// 入力中も自動保存（debounce）
let autoSaveTimer = null;
function scheduleAutoSave() {
  if (!state.editingId) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    if (!state.editingId) return;
    const tags = $("#f-tags").value.split(",").map((s) => s.trim()).filter(Boolean);
    const patch = {
      title: $("#f-title").value.trim(),
      details: $("#f-details").value,
      deadline: $("#f-deadline").value ? new Date($("#f-deadline").value).toISOString() : "",
      priority: $("#f-priority").value,
      status: $("#f-status").value,
      tags,
    };
    const t = state.tasks.find((x) => x.id === state.editingId);
    if (!t) return;
    Object.assign(t, patch, { updatedAt: Date.now() });
    saveTasks(false);
    setSyncStatus(isSyncActive() ? "sync" : "ok", "下書き自動保存");
  }, 600);
}
["input", "change"].forEach((ev) => editorForm.addEventListener(ev, scheduleAutoSave));

$("#cancelBtn").addEventListener("click", closeEditor);
$("#closeEditor").addEventListener("click", closeEditor);
$("#deleteBtn").addEventListener("click", () => {
  if (state.editingId) {
    const id = state.editingId;
    closeEditor();
    deleteTask(id);
  }
});

// ---------- ドラッグ&ドロップでステータス変更 ----------

$$(".column").forEach((col) => {
  col.addEventListener("dragover", (e) => {
    e.preventDefault();
    col.classList.add("drag-over");
    e.dataTransfer.dropEffect = "move";
  });
  col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
  col.addEventListener("drop", (e) => {
    e.preventDefault();
    col.classList.remove("drag-over");
    const id = e.dataTransfer.getData("text/plain");
    const newStatus = col.dataset.status;
    const t = state.tasks.find((x) => x.id === id);
    if (t && t.status !== newStatus) {
      t.status = newStatus;
      t.updatedAt = Date.now();
      saveTasks();
      render();
    }
  });
});

// ---------- フィルタ・検索 ----------

$("#searchInput").addEventListener("input", (e) => {
  state.filter.search = e.target.value;
  render();
});
$("#filterStatus").addEventListener("change", (e) => {
  state.filter.status = e.target.value;
  render();
});
$("#filterPriority").addEventListener("change", (e) => {
  state.filter.priority = e.target.value;
  render();
});
$("#sortBy").addEventListener("change", (e) => {
  state.sort = e.target.value;
  render();
});

// ---------- 追加ボタン・ショートカット ----------

$("#addBtn").addEventListener("click", () => openEditor(null));

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "n" || e.key === "N") {
    e.preventDefault();
    openEditor(null);
  } else if (e.key === "/") {
    e.preventDefault();
    $("#searchInput").focus();
  }
});

// ---------- バックアップ・復元 ----------

function downloadBackup(reason = "manual") {
  const payload = {
    app: "fuwatto-task",
    version: 1,
    exportedAt: new Date().toISOString(),
    reason,
    tasks: state.tasks,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  a.href = url;
  a.download = `fuwatto-backup-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()));
  toast("バックアップを保存しました ♡");
}

$("#backupBtn").addEventListener("click", () => downloadBackup("manual"));

$("#restoreBtn").addEventListener("click", () => $("#restoreFile").click());
$("#restoreFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    const incoming = Array.isArray(obj) ? obj : obj.tasks;
    if (!Array.isArray(incoming)) throw new Error("形式が不正です");
    if (!confirm(`復元方法: 「OK」で現在のデータと統合 / 「キャンセル」で中止\n\n読み込むタスク数: ${incoming.length}`)) {
      e.target.value = "";
      return;
    }
    // 既存と統合（id衝突は updatedAt が新しい方を採用）
    const map = new Map(state.tasks.map((t) => [t.id, t]));
    for (const t of incoming) {
      if (!t || !t.id) continue;
      const existing = map.get(t.id);
      if (!existing || (t.updatedAt || 0) >= (existing.updatedAt || 0)) {
        map.set(t.id, normalizeTask(t));
      }
    }
    state.tasks = Array.from(map.values());
    saveTasks();
    render();
    toast(`復元しました（${state.tasks.length}件）`);
  } catch (err) {
    alert("読み込みに失敗しました: " + err.message);
  } finally {
    e.target.value = "";
  }
});

function normalizeTask(t) {
  return {
    id: t.id || uid(),
    title: t.title || "",
    details: t.details || "",
    deadline: t.deadline || "",
    priority: ["low", "mid", "high"].includes(t.priority) ? t.priority : "mid",
    status: ["todo", "doing", "done"].includes(t.status) ? t.status : "todo",
    tags: Array.isArray(t.tags) ? t.tags.filter(Boolean) : [],
    createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : Date.now(),
  };
}

// 週次自動バックアップ
function maybeWeeklyBackup() {
  const settings = loadSettings();
  if (!settings.autoBackup) return;
  const last = Number(localStorage.getItem(LAST_BACKUP_KEY) || 0);
  if (Date.now() - last < WEEK_MS) return;
  if (state.tasks.length === 0) return;
  downloadBackup("weekly-auto");
}

// ---------- 設定モーダル ----------

const settingsDialog = $("#settings");
$("#settingsBtn").addEventListener("click", () => {
  const s = loadSettings();
  $("#firebaseConfig").value = s.firebaseConfig ? JSON.stringify(s.firebaseConfig, null, 2) : "";
  $("#firebaseSpace").value = s.space || "";
  $("#autoBackup").checked = !!s.autoBackup;
  settingsDialog.showModal();
});
$("#closeSettings").addEventListener("click", () => settingsDialog.close());

$("#saveSettingsBtn").addEventListener("click", async () => {
  const s = loadSettings();
  const raw = $("#firebaseConfig").value.trim();
  let firebaseConfig = null;
  if (raw) {
    try {
      firebaseConfig = JSON.parse(raw);
    } catch {
      alert("Firebase 設定のJSONが正しくありません。");
      return;
    }
  }
  s.firebaseConfig = firebaseConfig;
  s.space = $("#firebaseSpace").value.trim();
  s.autoBackup = $("#autoBackup").checked;
  saveSettings(s);
  settingsDialog.close();
  toast("設定を保存しました");
  await reconnectSync();
});

$("#clearLocalBtn").addEventListener("click", () => {
  if (!confirm("この端末のタスクデータと履歴をすべて削除します。\n（復元用に直前にバックアップを保存することをおすすめします）")) return;
  downloadBackup("before-clear");
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(HISTORY_KEY);
  state.tasks = [];
  render();
  settingsDialog.close();
  toast("ローカルデータを消去しました");
});

// ---------- 同期 ----------

async function reconnectSync() {
  stopSync();
  const s = loadSettings();
  if (!s.firebaseConfig || !s.space) {
    setSyncStatus("warn", "ローカル保存のみ（同期未設定）");
    return;
  }
  try {
    setSyncStatus("sync", "同期接続中…");
    await startSync({
      config: s.firebaseConfig,
      space: s.space,
      getTasks: () => state.tasks,
      onRemote: (tasks) => {
        state.tasks = tasks.map(normalizeTask);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
        render();
        setSyncStatus("ok", "同期済み");
      },
      onStatus: (kind, msg) => setSyncStatus(kind, msg),
    });
  } catch (err) {
    console.error(err);
    setSyncStatus("err", "同期エラー（ローカル保存は継続）");
    toast("同期に失敗しました: " + (err.message || err));
  }
}

// ---------- 起動 ----------

function init() {
  state.tasks = loadTasks().map(normalizeTask);
  render();
  setSyncStatus("ok", "この端末に保存済み");
  reconnectSync();
  maybeWeeklyBackup();
  // PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

window.addEventListener("beforeunload", () => saveTasks(false));
init();
