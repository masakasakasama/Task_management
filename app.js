// タスクマネジメントアプリ
// - localStorage に常時自動保存（オフライン用キャッシュ）
// - Firestore で全端末リアルタイム同期
// - タスク + Daily 習慣の2機能

import { startSync, stopSync, isSyncActive } from "./sync.js";

const STORAGE_KEY = "fuwatto_tasks_v1";
const VIEW_KEY = "fuwatto_view_v1";
const PCT_CYCLE = [0, 20, 40, 60, 80, 100];

const state = {
  tasks: /** @type {Task[]} */ ([]),
  habits: /** @type {Habit[]} */ ([]),
  filter: { search: "", status: "all", priority: "all" },
  sort: "deadline",
  editingId: null,
  editingHabitId: null,
  view: "tasks",
};

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} details
 * @property {string} deadline
 * @property {"low"|"mid"|"high"} priority
 * @property {"todo"|"doing"|"done"} status
 * @property {string[]} tags
 * @property {number} createdAt
 * @property {number} updatedAt
 *
 * @typedef {Object} Habit
 * @property {string} id
 * @property {string} name
 * @property {string} emoji
 * @property {Object<string, number>} entries  YYYY-MM-DD -> percent
 * @property {Object<string, number>} entryUpdatedAt  YYYY-MM-DD -> timestamp
 * @property {number} createdAt
 * @property {number} updatedAt
 */

// ---------- ストレージ ----------

function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tasks: [], habits: [] };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { tasks: parsed, habits: [] };
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      habits: Array.isArray(parsed.habits) ? parsed.habits : [],
    };
  } catch {
    return { tasks: [], habits: [] };
  }
}

function saveAll(showStatus = true) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ tasks: state.tasks, habits: state.habits })
  );
  if (showStatus) setSyncStatus("ok", isSyncActive() ? "保存・同期済み" : "この端末に保存済み");
  if (isSyncActive()) {
    setSyncStatus("sync", "同期中…");
    window.dispatchEvent(new CustomEvent("fuwatto:push"));
  }
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

function normalizeHabit(h) {
  return {
    id: h.id || ("h-" + uid()),
    name: h.name || "",
    emoji: h.emoji || "⭐",
    entries: typeof h.entries === "object" && h.entries ? h.entries : {},
    entryUpdatedAt:
      typeof h.entryUpdatedAt === "object" && h.entryUpdatedAt ? h.entryUpdatedAt : {},
    createdAt: typeof h.createdAt === "number" ? h.createdAt : Date.now(),
    updatedAt: typeof h.updatedAt === "number" ? h.updatedAt : Date.now(),
  };
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function todayKey() {
  return dateKey(new Date());
}

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function currentMonthDays() {
  const tk = todayKey();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const days = [];
  for (let d = 1; d <= lastDay; d++) {
    const date = new Date(year, month, d);
    days.push({
      key: dateKey(date),
      day: d,
      weekday: WEEKDAYS[date.getDay()],
      isToday: dateKey(date) === tk,
    });
  }
  return days;
}

function cyclePct(current) {
  const i = PCT_CYCLE.indexOf(current ?? 0);
  return PCT_CYCLE[(i + 1) % PCT_CYCLE.length];
}

// ---------- タスク描画 ----------

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

// ---------- タスク CRUD ----------

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
  saveAll();
  return t;
}

function updateTask(id, patch) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch, { updatedAt: Date.now() });
  saveAll();
  render();
}

function deleteTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`「${t.title || "(タイトルなし)"}」を削除しますか？`)) return;
  state.tasks = state.tasks.filter((x) => x.id !== id);
  saveAll();
  render();
  toast("削除しました");
}

function duplicateTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const copy = { ...t, id: uid(), title: t.title + "（コピー）", createdAt: Date.now(), updatedAt: Date.now() };
  state.tasks.push(copy);
  saveAll();
  render();
  toast("複製しました");
}

// ---------- タスク編集モーダル ----------

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
    saveAll(false);
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
      saveAll();
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

// ---------- 習慣 描画 ----------

function renderHabits() {
  const grid = $("#habitsGrid");
  grid.innerHTML = "";
  const monthLabel = $("#habitsMonth");
  const now = new Date();
  monthLabel.textContent = `${now.getFullYear()}年 ${now.getMonth() + 1}月 のDaily Habit`;

  if (state.habits.length === 0) {
    $("#habitsEmpty").hidden = false;
    grid.parentElement.style.display = "none";
    return;
  }
  $("#habitsEmpty").hidden = true;
  grid.parentElement.style.display = "";

  const days = currentMonthDays();

  // ヘッダー行
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "corner";
  corner.textContent = "DAY";
  trh.appendChild(corner);
  for (const h of state.habits) {
    const th = document.createElement("th");
    th.className = "habit-head";
    th.dataset.id = h.id;
    const label = document.createElement("button");
    label.type = "button";
    label.className = "habit-label";
    label.dataset.id = h.id;
    label.setAttribute("aria-label", `${h.name} を編集`);
    label.innerHTML = `
      <span class="emoji">${escapeHtml(h.emoji || "⭐")}</span>
      <span class="name">${escapeHtml(h.name || "(名称未設定)")}</span>
    `;
    th.appendChild(label);
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  grid.appendChild(thead);

  // ボディ
  const tbody = document.createElement("tbody");
  for (const d of days) {
    const tr = document.createElement("tr");
    if (d.isToday) tr.classList.add("today");
    const dayCell = document.createElement("th");
    dayCell.className = "day-col";
    dayCell.scope = "row";
    dayCell.innerHTML = `<span class="day-num">${d.day}</span><span class="day-wd">${d.weekday}</span>`;
    tr.appendChild(dayCell);
    for (const h of state.habits) {
      const td = document.createElement("td");
      td.className = "cell-wrap";
      const pct = (h.entries && h.entries[d.key]) || 0;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cell";
      btn.dataset.pct = pct;
      btn.dataset.habit = h.id;
      btn.dataset.date = d.key;
      btn.setAttribute("aria-label", `${d.day}日 ${h.name}: ${pct}%`);
      btn.textContent = pct === 100 ? "✓" : pct ? pct : "";
      td.appendChild(btn);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  grid.appendChild(tbody);

  // 委譲式クリックハンドラ
  grid.onclick = (e) => {
    const cell = e.target.closest(".cell");
    if (cell) {
      onHabitCellClick(cell.dataset.habit, cell.dataset.date, cell);
      return;
    }
    const editBtn = e.target.closest(".habit-label");
    if (editBtn) {
      openHabitEditor(editBtn.dataset.id);
    }
  };

  // 今日の行が見えるようにスクロール
  requestAnimationFrame(() => {
    const todayRow = grid.querySelector("tr.today");
    if (todayRow) {
      const wrap = grid.parentElement;
      const offset = todayRow.offsetTop - wrap.clientHeight / 2 + todayRow.offsetHeight / 2;
      wrap.scrollTop = Math.max(0, offset);
    }
  });
}

// 進捗ピッカー
const pctPicker = $("#pctPicker");
let pickingHabitId = null;
let pickingDateKey = null;
let pickingCell = null;

function onHabitCellClick(habitId, dateKey, cell) {
  pickingHabitId = habitId;
  pickingDateKey = dateKey;
  pickingCell = cell;
  const h = state.habits.find((x) => x.id === habitId);
  const day = dateKey.slice(8);
  const habitName = h ? `${h.emoji || ""} ${h.name}` : "";
  $("#pctPickerTitle").textContent = `${day}日  ${habitName}`;
  pctPicker.showModal();
}

pctPicker.addEventListener("click", (e) => {
  // 背景クリックで閉じる
  if (e.target === pctPicker) {
    pctPicker.close();
    return;
  }
  const opt = e.target.closest(".pct-opt");
  if (!opt) return;
  const pct = Number(opt.dataset.pct);
  setHabitEntry(pickingHabitId, pickingDateKey, pct, pickingCell);
  pctPicker.close();
});

function setHabitEntry(habitId, dateKey, pct, cell) {
  const h = state.habits.find((x) => x.id === habitId);
  if (!h) return;
  h.entries = h.entries || {};
  h.entryUpdatedAt = h.entryUpdatedAt || {};
  if (pct === 0) {
    delete h.entries[dateKey];
  } else {
    h.entries[dateKey] = pct;
  }
  h.entryUpdatedAt[dateKey] = Date.now();
  h.updatedAt = Date.now();
  if (cell) {
    cell.dataset.pct = pct;
    cell.textContent = pct === 100 ? "✓" : pct ? pct : "";
    cell.classList.add("just-tapped");
    setTimeout(() => cell.classList.remove("just-tapped"), 250);
  }
  saveAll(false);
}

// ---------- 習慣 編集モーダル ----------

const habitEditor = $("#habitEditor");
const habitEditorForm = $("#habitEditorForm");

function openHabitEditor(id) {
  state.editingHabitId = id || null;
  if (id) {
    const h = state.habits.find((x) => x.id === id);
    if (!h) return;
    $("#habitEditorTitle").textContent = "習慣を編集";
    $("#h-emoji").value = h.emoji || "";
    $("#h-name").value = h.name || "";
    $("#deleteHabitBtn").style.display = "";
  } else {
    $("#habitEditorTitle").textContent = "新しい習慣";
    $("#h-emoji").value = "⭐";
    $("#h-name").value = "";
    $("#deleteHabitBtn").style.display = "none";
  }
  habitEditor.showModal();
  setTimeout(() => $("#h-name").focus(), 30);
}

function closeHabitEditor() {
  if (habitEditor.open) habitEditor.close();
  state.editingHabitId = null;
}

habitEditorForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#h-name").value.trim();
  const emoji = $("#h-emoji").value.trim() || "⭐";
  if (!name) return;
  const now = Date.now();
  if (state.editingHabitId) {
    const h = state.habits.find((x) => x.id === state.editingHabitId);
    if (h) {
      h.name = name;
      h.emoji = emoji;
      h.updatedAt = now;
    }
  } else {
    state.habits.push({
      id: "h-" + uid(),
      name,
      emoji,
      entries: {},
      entryUpdatedAt: {},
      createdAt: now,
      updatedAt: now,
    });
  }
  saveAll();
  renderHabits();
  closeHabitEditor();
  toast("保存しました ♡");
});

$("#cancelHabitBtn").addEventListener("click", closeHabitEditor);
$("#closeHabitEditor").addEventListener("click", closeHabitEditor);
$("#deleteHabitBtn").addEventListener("click", () => {
  if (!state.editingHabitId) return;
  const h = state.habits.find((x) => x.id === state.editingHabitId);
  if (!h) return;
  if (!confirm(`「${h.name}」を削除しますか？\n（過去の記録もすべて消えます）`)) return;
  state.habits = state.habits.filter((x) => x.id !== state.editingHabitId);
  saveAll();
  renderHabits();
  closeHabitEditor();
  toast("削除しました");
});

// ---------- タブ切替 ----------

function setView(view) {
  state.view = view;
  $("#tasksView").hidden = view !== "tasks";
  $("#habitsView").hidden = view !== "habits";
  $$("#tabs .tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view)
  );
  $("#addBtn").textContent = view === "habits" ? "＋ 新しい習慣" : "＋ 新しいタスク";
  localStorage.setItem(VIEW_KEY, view);
  if (view === "habits") renderHabits();
}

$$("#tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.view));
});

// ---------- 追加ボタン・ショートカット ----------

$("#addBtn").addEventListener("click", () => {
  if (state.view === "habits") openHabitEditor(null);
  else openEditor(null);
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "n" || e.key === "N") {
    e.preventDefault();
    if (state.view === "habits") openHabitEditor(null);
    else openEditor(null);
  } else if (e.key === "/") {
    if (state.view !== "tasks") return;
    e.preventDefault();
    $("#searchInput").focus();
  }
});

// ---------- 同期 ----------

async function reconnectSync() {
  stopSync();
  try {
    setSyncStatus("sync", "同期接続中…");
    await startSync({
      getState: () => ({ tasks: state.tasks, habits: state.habits }),
      onRemote: ({ tasks, habits }) => {
        state.tasks = (tasks || []).map(normalizeTask);
        state.habits = (habits || []).map(normalizeHabit);
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ tasks: state.tasks, habits: state.habits })
        );
        render();
        renderHabits();
        setSyncStatus("ok", "同期済み");
      },
      onStatus: (kind, msg) => setSyncStatus(kind, msg),
    });
  } catch (err) {
    console.error(err);
    setSyncStatus("err", "オフライン（ローカル保存は継続）");
  }
}

// ---------- 起動 ----------

function init() {
  const saved = loadAll();
  state.tasks = saved.tasks.map(normalizeTask);
  state.habits = saved.habits.map(normalizeHabit);
  const savedView = localStorage.getItem(VIEW_KEY);
  setView(savedView === "habits" ? "habits" : "tasks");
  render();
  renderHabits();
  setSyncStatus("sync", "同期接続中…");
  reconnectSync();
  if ("serviceWorker" in navigator) {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              installing.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
      })
      .catch(() => {});
  }
}

window.addEventListener("beforeunload", () => saveAll(false));
init();
