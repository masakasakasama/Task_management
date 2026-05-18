// タスクマネジメントアプリ
// - localStorage に常時自動保存（オフライン用キャッシュ）
// - Firestore で全端末リアルタイム同期
// - タスク + Daily 習慣の2機能

import { startSync, stopSync, isSyncActive, spaceIdFor, startUsersSync, pushUsers } from "./sync.js";
import { startCinnamonBridge } from "./cinnamon-bridge.js";
import { startRepsBridge } from "./reps-bridge.js";

const APP_VERSION = "v29";
const STORAGE_KEY_BASE = "fuwatto_tasks_v1";
const HISTORY_KEY_BASE = "fuwatto_history_v1";
const HISTORY_LIMIT = 30;
const VIEW_KEY = "fuwatto_view_v1";
const USERS_KEY = "fuwatto_users_v1";
const CURRENT_USER_KEY = "fuwatto_current_user_v1";
const PCT_CYCLE = [0, 20, 40, 60, 80, 100];

const DEFAULT_USERS = [
  { id: "u1", name: "レベッカ", emoji: "🌹" },
  { id: "u2", name: "ユーザー2", emoji: "👤" },
];

function loadUsers() {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length >= 2) return parsed;
    }
  } catch {}
  return DEFAULT_USERS.slice();
}

function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function getCurrentUserId() {
  return localStorage.getItem(CURRENT_USER_KEY) || "u1";
}

function setCurrentUserIdLS(id) {
  localStorage.setItem(CURRENT_USER_KEY, id);
}

function storageKeyFor(userId) {
  // u1 は既存データを温存するためサフィックス無し
  return userId === "u1" ? STORAGE_KEY_BASE : `${STORAGE_KEY_BASE}__${userId}`;
}

function historyKeyFor(userId) {
  return `${HISTORY_KEY_BASE}__${userId}`;
}

// localStorageに直近HISTORY_LIMIT世代のスナップショットを保持
function pushLocalHistory(userId, snapshot) {
  try {
    const key = historyKeyFor(userId);
    const list = JSON.parse(localStorage.getItem(key) || "[]");
    // 直前と全く同じ内容なら追加しない（無駄を減らす）
    const lastJson = list.length ? JSON.stringify(list[list.length - 1].data) : "";
    const newJson = JSON.stringify(snapshot);
    if (lastJson === newJson) return;
    list.push({ at: Date.now(), data: snapshot });
    while (list.length > HISTORY_LIMIT) list.shift();
    localStorage.setItem(key, JSON.stringify(list));
  } catch (e) {
    // 履歴が壊れても本体データは無事
    console.warn("[history] push failed:", e);
  }
}

const state = {
  users: loadUsers(),
  currentUserId: getCurrentUserId(),
  tasks: /** @type {Task[]} */ ([]),
  habits: /** @type {Habit[]} */ ([]),
  filter: { search: "", pf: "all" },
  editingId: null,
  editingHabitId: null,
  view: "tasks",
  habitYear: new Date().getFullYear(),
  habitMonth: new Date().getMonth(),
  tombstones: { tasks: {}, habits: {} },
};

function currentUser() {
  return state.users.find((u) => u.id === state.currentUserId) || state.users[0];
}

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

function emptyTombstones() {
  return { tasks: {}, habits: {} };
}

function loadAll(userId = state.currentUserId) {
  try {
    const raw = localStorage.getItem(storageKeyFor(userId));
    if (!raw) return { tasks: [], habits: [], tombstones: emptyTombstones() };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { tasks: parsed, habits: [], tombstones: emptyTombstones() };
    const tb = parsed.tombstones && typeof parsed.tombstones === "object" ? parsed.tombstones : {};
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      habits: Array.isArray(parsed.habits) ? parsed.habits : [],
      tombstones: {
        tasks: tb.tasks && typeof tb.tasks === "object" ? tb.tasks : {},
        habits: tb.habits && typeof tb.habits === "object" ? tb.habits : {},
      },
    };
  } catch {
    return { tasks: [], habits: [], tombstones: emptyTombstones() };
  }
}

function saveAll(showStatus = true) {
  const snapshot = {
    tasks: state.tasks,
    habits: state.habits,
    tombstones: state.tombstones || emptyTombstones(),
  };
  try {
    localStorage.setItem(storageKeyFor(state.currentUserId), JSON.stringify(snapshot));
    pushLocalHistory(state.currentUserId, { tasks: state.tasks, habits: state.habits });
  } catch (e) {
    console.warn("[saveAll] localStorage failed:", e);
  }
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
    recurrence: ["none", "daily", "weekdays", "weekly", "monthly"].includes(t.recurrence)
      ? t.recurrence
      : "none",
    subtasks: Array.isArray(t.subtasks)
      ? t.subtasks
          .filter((s) => s && typeof s.text === "string")
          .map((s) => ({ id: s.id || uid(), text: s.text, done: !!s.done }))
      : [],
    createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : Date.now(),
  };
}

function calcSubProgress(task) {
  if (!task.subtasks || task.subtasks.length === 0) return null;
  const done = task.subtasks.filter((s) => s.done).length;
  return { done, total: task.subtasks.length, pct: Math.round((done / task.subtasks.length) * 100) };
}

function calculateStreak(habit) {
  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tk = todayKey();
  let i = 0;
  if ((habit.entries || {})[tk] > 0) {
    streak = 1;
    i = 1;
  } else {
    i = 1;
  }
  while (true) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = dateKey(d);
    const v = (habit.entries || {})[key] || 0;
    if (v > 0) streak++;
    else break;
    i++;
  }
  return streak;
}

function calculateBestStreak(habit) {
  const dates = Object.keys(habit.entries || {})
    .filter((k) => (habit.entries[k] || 0) > 0)
    .sort();
  let best = 0, cur = 0, prev = null;
  for (const k of dates) {
    const d = new Date(k + "T00:00:00");
    if (prev) {
      const diff = Math.round((d - prev) / 86400000);
      cur = diff === 1 ? cur + 1 : 1;
    } else cur = 1;
    if (cur > best) best = cur;
    prev = d;
  }
  return best;
}

function monthCompletionRate(habit, year, month) {
  const now = new Date();
  const isCurrent = year === now.getFullYear() && month === now.getMonth();
  const lastDay = isCurrent ? now.getDate() : new Date(year, month + 1, 0).getDate();
  let done = 0;
  for (let d = 1; d <= lastDay; d++) {
    const key = dateKey(new Date(year, month, d));
    if ((habit.entries || {})[key] > 0) done++;
  }
  return { done, total: lastDay, pct: lastDay ? Math.round((done / lastDay) * 100) : 0 };
}

function renderStats() {
  const sv = $("#statsView");
  if (!sv || sv.hidden) return;

  const now = new Date();
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const dow = startOfToday.getDay();
  const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - dow);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  let doneWeek = 0, doneMonth = 0, overdue = 0, doing = 0, open = 0;
  for (const t of state.tasks) {
    if (t.status === "done") {
      const u = new Date(t.updatedAt || 0);
      if (u >= startOfWeek) doneWeek++;
      if (u >= startOfMonth) doneMonth++;
    } else {
      if (t.status === "doing") doing++; else open++;
      if (t.deadline && new Date(t.deadline) < startOfToday) overdue++;
    }
  }

  const card = (label, val, cls = "") =>
    `<div class="stat-card ${cls}"><div class="sv">${val}</div><div class="sl">${label}</div></div>`;
  $("#statsTasks").innerHTML =
    card("今週 完了", doneWeek) +
    card("今月 完了", doneMonth) +
    card("未完", open + doing) +
    card("期限切れ", overdue, overdue > 0 ? "danger" : "");

  const wrap = $("#statsHabits");
  wrap.innerHTML = "";
  $("#statsHabitsEmpty").hidden = state.habits.length > 0;
  for (const h of state.habits) {
    const r = monthCompletionRate(h, now.getFullYear(), now.getMonth());
    const cur = calculateStreak(h);
    const best = calculateBestStreak(h);
    const row = document.createElement("div");
    row.className = "stat-habit";
    row.innerHTML = `
      <div class="sh-head">
        <span>${escapeHtml(h.emoji || "⭐")} ${escapeHtml(h.name)}</span>
        <span class="sh-pct">${r.pct}%</span>
      </div>
      <div class="sh-bar"><div style="width:${r.pct}%"></div></div>
      <div class="sh-meta">${r.done}/${r.total}日 ・ 🔥連続 ${cur} ・ 最長 ${best}</div>
    `;
    wrap.appendChild(row);
  }

  const totalHabits = state.habits.length;
  const avgPct = totalHabits
    ? Math.round(
        state.habits.reduce(
          (a, h) => a + monthCompletionRate(h, now.getFullYear(), now.getMonth()).pct,
          0
        ) / totalHabits
      )
    : 0;
  $("#statsSummary").textContent =
    `今月の習慣平均達成率 ${avgPct}% ・ 今週タスク完了 ${doneWeek}件`;
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

function monthDays(year, month) {
  const tk = todayKey();
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

function currentMonthDays() {
  const now = new Date();
  return monthDays(now.getFullYear(), now.getMonth());
}

function cyclePct(current) {
  const i = PCT_CYCLE.indexOf(current ?? 0);
  return PCT_CYCLE[(i + 1) % PCT_CYCLE.length];
}

// ---------- タスク描画 ----------

function render() {
  const container = $("#taskSections");
  container.innerHTML = "";

  const filtered = filterTasks(state.tasks);
  const groups = groupTasksByDate(filtered);

  const sectionDefs = [
    { key: "overdue", label: "⚠️ 期限切れ", className: "overdue" },
    { key: "doing", label: "⚡ 進行中", className: "doing" },
    { key: "today", label: "🌅 今日", className: "today" },
    { key: "tomorrow", label: "📆 明日" },
    { key: "thisWeek", label: "📅 今週中" },
    { key: "nextWeek", label: "🗓️ 来週" },
    { key: "later", label: "🌙 それ以降" },
    { key: "noDeadline", label: "🌫️ 期限なし" },
    { key: "done", label: "✓ 完了", className: "done", collapsedDefault: true },
  ];

  let total = 0;
  for (const def of sectionDefs) {
    const list = groups[def.key] || [];
    if (list.length === 0) continue;
    total += list.length;
    container.appendChild(renderTaskSection(def, list));
  }

  $("#tasksEmpty").hidden = total > 0;
}

function filterTasks(tasks) {
  const { search, pf } = state.filter;
  const q = (search || "").trim().toLowerCase();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  return tasks.filter((t) => {
    if (q) {
      const blob = (t.title + " " + t.details + " " + (t.tags || []).join(" ")).toLowerCase();
      if (!blob.includes(q)) return false;
    }
    switch (pf) {
      case "overdue":
        if (t.status === "done") return false;
        if (!t.deadline) return false;
        return new Date(t.deadline) < startOfToday;
      case "today": {
        if (t.status === "done") return false;
        if (!t.deadline) return false;
        const dl = new Date(t.deadline);
        return dl >= startOfToday && dl < startOfTomorrow;
      }
      case "doing":
        return t.status === "doing";
      case "high":
        return t.priority === "high" && t.status !== "done";
      case "all":
      default:
        return true;
    }
  });
}

function groupTasksByDate(tasks) {
  const groups = {
    overdue: [],
    doing: [],
    today: [],
    tomorrow: [],
    thisWeek: [],
    nextWeek: [],
    later: [],
    noDeadline: [],
    done: [],
  };

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const startOfDayAfterTomorrow = new Date(startOfTomorrow);
  startOfDayAfterTomorrow.setDate(startOfDayAfterTomorrow.getDate() + 1);
  // 今週末 (今週土曜の23:59) - 日曜始まりの週
  const dayOfWeek = startOfToday.getDay();
  const daysToSat = (6 - dayOfWeek + 7) % 7;
  const endOfThisWeek = new Date(startOfToday);
  endOfThisWeek.setDate(endOfThisWeek.getDate() + daysToSat);
  endOfThisWeek.setHours(23, 59, 59, 999);
  const endOfNextWeek = new Date(endOfThisWeek);
  endOfNextWeek.setDate(endOfNextWeek.getDate() + 7);

  for (const t of tasks) {
    if (t.status === "done") {
      groups.done.push(t);
      continue;
    }
    if (t.status === "doing") {
      groups.doing.push(t);
      continue;
    }
    if (!t.deadline) {
      groups.noDeadline.push(t);
      continue;
    }
    const dl = new Date(t.deadline);
    if (dl < startOfToday) groups.overdue.push(t);
    else if (dl < startOfTomorrow) groups.today.push(t);
    else if (dl < startOfDayAfterTomorrow) groups.tomorrow.push(t);
    else if (dl <= endOfThisWeek) groups.thisWeek.push(t);
    else if (dl <= endOfNextWeek) groups.nextWeek.push(t);
    else groups.later.push(t);
  }

  // 各セクション内で 優先度 → 期限の順に整列
  const cmp = (a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const av = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const bv = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    if (av !== bv) return av - bv;
    return b.updatedAt - a.updatedAt;
  };
  for (const k of Object.keys(groups)) groups[k].sort(cmp);
  // 完了は更新が新しい順
  groups.done.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
}

function renderTaskSection(def, tasks) {
  const sec = document.createElement("section");
  sec.className = "task-section" + (def.className ? " " + def.className : "");
  if (def.collapsedDefault) sec.classList.add("collapsed");
  sec.dataset.sec = def.key;

  const head = document.createElement("button");
  head.type = "button";
  head.className = "section-head";
  head.innerHTML = `
    <span class="section-toggle">▾</span>
    <span class="section-label">${def.label}</span>
    <span class="section-count">${tasks.length}</span>
  `;
  head.addEventListener("click", () => sec.classList.toggle("collapsed"));

  const list = document.createElement("div");
  list.className = "section-list";
  for (const t of tasks) list.appendChild(renderTaskRow(t));

  sec.appendChild(head);
  sec.appendChild(list);
  return sec;
}

function renderTaskRow(task) {
  const row = document.createElement("article");
  row.className = "task-row";
  if (task.status === "done") row.classList.add("done");
  if (task.status === "doing") row.classList.add("doing");
  if (task.priority === "high" && task.status !== "done") row.classList.add("high");
  row.dataset.id = task.id;
  row.tabIndex = 0;

  const dl = fmtDeadline(task.deadline);
  const sub = calcSubProgress(task);
  const tags = (task.tags || []).filter(Boolean);

  const prioMark =
    task.priority === "high"
      ? `<span class="row-prio high" title="優先度: 高">🔥</span>`
      : task.priority === "low"
      ? `<span class="row-prio low" title="優先度: 低">·</span>`
      : "";

  row.innerHTML = `
    <button type="button" class="row-check" aria-label="完了切替">${task.status === "done" ? "✓" : ""}</button>
    <div class="row-body">
      <div class="row-title-line">
        ${prioMark}
        <span class="row-title">${escapeHtml(task.title || "(タイトルなし)")}</span>
      </div>
      ${task.details ? `<div class="row-details">${escapeHtml(task.details).split("\n")[0]}</div>` : ""}
      <div class="row-meta">
        ${dl ? `<span class="row-chip dl ${dl.cls}">⏰ ${escapeHtml(dl.label)}</span>` : ""}
        ${task.recurrence && task.recurrence !== "none" ? `<span class="row-chip rec">🔁 ${({daily:"毎日",weekdays:"平日",weekly:"毎週",monthly:"毎月"})[task.recurrence] || "繰返"}</span>` : ""}
        ${sub ? `<span class="row-chip sub">☑ ${sub.done}/${sub.total}</span>` : ""}
        ${tags.map((t) => `<span class="row-chip tag">#${escapeHtml(t)}</span>`).join("")}
      </div>
      ${sub ? `<div class="row-progress"><div style="width:${sub.pct}%"></div></div>` : ""}
    </div>
    <button type="button" class="row-more" aria-label="編集">⋯</button>
  `;

  row.querySelector(".row-check").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTaskDone(task.id);
  });
  row.querySelector(".row-more").addEventListener("click", (e) => {
    e.stopPropagation();
    openEditor(task.id);
  });
  row.addEventListener("click", () => openEditor(task.id));
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      openEditor(task.id);
    }
  });

  return row;
}

function nextRecurrenceISO(baseISO, rec) {
  const d = baseISO ? new Date(baseISO) : new Date();
  if (isNaN(d.getTime())) return "";
  if (rec === "daily") d.setDate(d.getDate() + 1);
  else if (rec === "weekly") d.setDate(d.getDate() + 7);
  else if (rec === "monthly") d.setMonth(d.getMonth() + 1);
  else if (rec === "weekdays") {
    do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  } else return "";
  return d.toISOString();
}

// 完了した繰り返しタスクから次回分を生成
function spawnRecurrenceIfNeeded(task) {
  if (!task || task.recurrence === "none" || !task.recurrence) return;
  const next = nextRecurrenceISO(task.deadline, task.recurrence);
  if (!next) return;
  const now = Date.now();
  state.tasks.push({
    id: uid(),
    title: task.title,
    details: task.details,
    deadline: next,
    priority: task.priority,
    status: "todo",
    tags: [...(task.tags || [])],
    recurrence: task.recurrence,
    subtasks: (task.subtasks || []).map((s) => ({ id: uid(), text: s.text, done: false })),
    createdAt: now,
    updatedAt: now,
  });
}

function toggleTaskDone(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const wasDone = t.status === "done";
  t.status = wasDone ? "todo" : "done";
  t.updatedAt = Date.now();
  if (!wasDone && t.status === "done") spawnRecurrenceIfNeeded(t);
  saveAll();
  render();
  renderToday();
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
  state.tombstones = state.tombstones || emptyTombstones();
  state.tombstones.tasks[id] = Date.now(); // 削除を全端末へ確実に伝播
  saveAll();
  render();
  renderToday();
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
  $("#f-recurrence").value = task.recurrence || "none";
  $("#f-tags").value = (task.tags || []).join(", ");
  renderSubtasksInEditor(task);
  editor.showModal();
  setTimeout(() => $("#f-title").focus(), 30);
}

function renderSubtasksInEditor(task) {
  const list = $("#subtaskList");
  list.innerHTML = "";
  for (const sub of task.subtasks || []) {
    list.appendChild(renderSubtaskItem(task.id, sub));
  }
}

function renderSubtaskItem(taskId, sub) {
  const li = document.createElement("li");
  li.className = sub.done ? "done" : "";
  li.dataset.subId = sub.id;
  li.innerHTML = `
    <button type="button" class="check" aria-label="完了切替">${sub.done ? "✓" : ""}</button>
    <span class="text" contenteditable="true" spellcheck="false"></span>
    <button type="button" class="del" aria-label="削除">✕</button>
  `;
  li.querySelector(".text").textContent = sub.text;
  li.querySelector(".check").addEventListener("click", () => {
    const t = state.tasks.find((x) => x.id === taskId);
    if (!t) return;
    const s = t.subtasks.find((x) => x.id === sub.id);
    if (!s) return;
    s.done = !s.done;
    li.className = s.done ? "done" : "";
    li.querySelector(".check").textContent = s.done ? "✓" : "";
    t.updatedAt = Date.now();
    saveAll(false);
  });
  li.querySelector(".del").addEventListener("click", () => {
    const t = state.tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.subtasks = t.subtasks.filter((x) => x.id !== sub.id);
    t.updatedAt = Date.now();
    li.remove();
    saveAll(false);
  });
  li.querySelector(".text").addEventListener("blur", (e) => {
    const t = state.tasks.find((x) => x.id === taskId);
    if (!t) return;
    const s = t.subtasks.find((x) => x.id === sub.id);
    if (!s) return;
    const newText = e.target.textContent.trim();
    if (newText === s.text) return;
    if (!newText) {
      // 空にしたら削除
      t.subtasks = t.subtasks.filter((x) => x.id !== sub.id);
      li.remove();
    } else {
      s.text = newText;
    }
    t.updatedAt = Date.now();
    saveAll(false);
  });
  li.querySelector(".text").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.blur();
      $("#newSubtaskInput").focus();
    }
  });
  return li;
}

$("#newSubtaskInput").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const text = e.target.value.trim();
  if (!text || !state.editingId) return;
  const t = state.tasks.find((x) => x.id === state.editingId);
  if (!t) return;
  const sub = { id: uid(), text, done: false };
  t.subtasks = t.subtasks || [];
  t.subtasks.push(sub);
  t.updatedAt = Date.now();
  $("#subtaskList").appendChild(renderSubtaskItem(t.id, sub));
  e.target.value = "";
  saveAll(false);
});

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
  const prev = state.tasks.find((x) => x.id === state.editingId);
  const wasDone = prev && prev.status === "done";
  const patch = {
    title: $("#f-title").value.trim(),
    details: $("#f-details").value,
    deadline: $("#f-deadline").value ? new Date($("#f-deadline").value).toISOString() : "",
    priority: $("#f-priority").value,
    status: $("#f-status").value,
    recurrence: $("#f-recurrence").value,
    tags,
  };
  updateTask(state.editingId, patch);
  // 完了に切り替わった繰り返しタスクは次回分を生成
  if (!wasDone && patch.status === "done") {
    const t = state.tasks.find((x) => x.id === state.editingId);
    if (t) { spawnRecurrenceIfNeeded(t); saveAll(); render(); renderToday(); }
  }
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
      recurrence: $("#f-recurrence").value,
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

// ---------- フィルタ・検索 ----------

$("#searchInput").addEventListener("input", (e) => {
  state.filter.search = e.target.value;
  render();
});

$$("#filterPills .pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    state.filter.pf = pill.dataset.pf;
    $$("#filterPills .pill").forEach((p) =>
      p.classList.toggle("active", p === pill)
    );
    render();
  });
});

// ---------- 習慣 描画 ----------

function renderHabits() {
  const grid = $("#habitsGrid");
  grid.innerHTML = "";
  const monthLabel = $("#habitsMonth");
  monthLabel.textContent = `${state.habitYear}年 ${state.habitMonth + 1}月`;
  // 今月以外なら「今月へ」ボタンを表示
  const now = new Date();
  const isCurrentMonth =
    state.habitYear === now.getFullYear() && state.habitMonth === now.getMonth();
  $("#thisMonthBtn").hidden = isCurrentMonth;

  if (state.habits.length === 0) {
    $("#habitsEmpty").hidden = false;
    grid.parentElement.style.display = "none";
    return;
  }
  $("#habitsEmpty").hidden = true;
  grid.parentElement.style.display = "";

  const days = monthDays(state.habitYear, state.habitMonth);

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
    const isDefaultEmoji = !h.emoji || h.emoji === "⭐";
    label.className = "habit-label" + (isDefaultEmoji ? " default-emoji" : "");
    label.dataset.id = h.id;
    label.setAttribute("aria-label", `${h.name} を編集`);
    const streak = calculateStreak(h);
    const streakHtml = streak > 0
      ? `<span class="streak ${streak >= 7 ? "hot" : ""}">🔥${streak}</span>`
      : "";
    label.innerHTML = `
      <span class="emoji">${escapeHtml(h.emoji || "⭐")}</span>
      <span class="name">${escapeHtml(h.name || "(名称未設定)")}</span>
      ${streakHtml}
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

// ---------- 今日ビュー ----------

function renderToday() {
  const today = new Date();
  const tk = todayKey();
  const dateLabel = today.toLocaleDateString("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  $("#todayDate").textContent = dateLabel;

  // 今日のタスク: 期限が今日以前 + 未完 / または status=doing
  const startOfTomorrow = new Date(today);
  startOfTomorrow.setHours(0, 0, 0, 0);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const todayTasks = state.tasks.filter((t) => {
    if (t.status === "done") return false;
    if (t.status === "doing") return true;
    if (!t.deadline) return false;
    const d = new Date(t.deadline);
    return d.getTime() < startOfTomorrow.getTime();
  });
  todayTasks.sort((a, b) => {
    const av = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const bv = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    if (av !== bv) return av - bv;
    return priorityRank(a.priority) - priorityRank(b.priority);
  });

  $("#todayTaskCount").textContent = todayTasks.length;
  const taskList = $("#todayTaskList");
  taskList.innerHTML = "";
  $("#todayTaskEmpty").hidden = todayTasks.length > 0;
  for (const t of todayTasks) {
    const row = document.createElement("div");
    row.className = "today-task-row" + (t.status === "done" ? " done" : "");
    const dl = fmtDeadline(t.deadline);
    const sub = calcSubProgress(t);
    const subHtml = sub ? ` ☑${sub.done}/${sub.total}` : "";
    row.innerHTML = `
      <button type="button" class="check" aria-label="完了切替">${t.status === "done" ? "✓" : ""}</button>
      <div style="flex:1;min-width:0">
        <div class="title">${escapeHtml(t.title || "(タイトルなし)")}</div>
        <div class="meta-line">
          <span class="chip priority ${t.priority}">${priorityLabel(t.priority).replace("優先度: ","")}</span>
          ${dl ? `<span class="chip deadline ${dl.cls}">⏰ ${escapeHtml(dl.label)}</span>` : ""}
          ${subHtml ? `<span>${subHtml}</span>` : ""}
        </div>
      </div>
    `;
    row.querySelector(".check").addEventListener("click", (e) => {
      e.stopPropagation();
      const tt = state.tasks.find((x) => x.id === t.id);
      if (!tt) return;
      tt.status = tt.status === "done" ? "todo" : "done";
      tt.updatedAt = Date.now();
      saveAll();
      renderToday();
      render();
    });
    row.addEventListener("click", () => openEditor(t.id));
    taskList.appendChild(row);
  }

  // 今日の習慣
  const habitList = $("#todayHabitList");
  habitList.innerHTML = "";
  const totalHabits = state.habits.length;
  const doneToday = state.habits.filter((h) => ((h.entries || {})[tk] || 0) > 0).length;
  $("#todayHabitCount").textContent = totalHabits === 0 ? "0" : `${doneToday}/${totalHabits}`;
  $("#todayHabitEmpty").hidden = totalHabits > 0;

  for (const h of state.habits) {
    const pct = (h.entries || {})[tk] || 0;
    const streak = calculateStreak(h);
    const streakHtml = streak > 0
      ? `<span class="streak ${streak >= 7 ? "hot" : ""}">🔥 ${streak}日</span>`
      : "";
    const row = document.createElement("div");
    row.className = "today-habit-row";
    row.innerHTML = `
      <div class="habit-name">
        <span>${escapeHtml(h.emoji || "⭐")}</span>
        <span>${escapeHtml(h.name)}</span>
        ${streakHtml}
      </div>
      <button type="button" class="big-cell" data-pct="${pct}">${pct === 100 ? "✓" : pct ? pct : "—"}</button>
    `;
    row.querySelector(".big-cell").addEventListener("click", () => {
      onHabitCellClick(h.id, tk, row.querySelector(".big-cell"));
    });
    habitList.appendChild(row);
  }

  // 今日サマリ
  const taskDoneToday = state.tasks.filter(
    (t) => t.status === "done" && t.updatedAt && new Date(t.updatedAt).toDateString() === today.toDateString()
  ).length;
  $("#todaySummary").textContent =
    `タスク ${todayTasks.length}件 残り ・ 今日完了 ${taskDoneToday}件 ・ 習慣 ${doneToday}/${totalHabits}`;
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

// 名前 → オススメ絵文字 の辞書（部分一致・大文字小文字無視）
// 具体的な語を上、汎用語を下に並べる（先勝ち）
const EMOJI_SUGGESTIONS = [
  // === スポーツ ===
  { keys: ["ゴルフ", "golf"], emoji: "⛳" },
  { keys: ["テニス", "tennis"], emoji: "🎾" },
  { keys: ["野球", "baseball"], emoji: "⚾" },
  { keys: ["サッカー", "soccer", "フットボール", "football"], emoji: "⚽" },
  { keys: ["バスケ", "basketball"], emoji: "🏀" },
  { keys: ["バレー", "volleyball"], emoji: "🏐" },
  { keys: ["卓球", "ping pong", "table tennis"], emoji: "🏓" },
  { keys: ["バドミントン", "badminton"], emoji: "🏸" },
  { keys: ["ボクシング", "boxing", "格闘"], emoji: "🥊" },
  { keys: ["水泳", "swim", "スイム", "プール"], emoji: "🏊" },
  { keys: ["スキー", "ski", "スノボ", "snowboard"], emoji: "⛷️" },
  { keys: ["スケート", "skate"], emoji: "⛸️" },
  { keys: ["登山", "ハイキング", "hike", "hiking", "mountain climbing"], emoji: "🧗" },
  { keys: ["ダンス", "dance", "踊"], emoji: "💃" },
  { keys: ["釣り", "fishing"], emoji: "🎣" },
  // === 筋トレ・ワークアウト ===
  { keys: ["ワークアウト", "workout", "筋トレ", "training", "exercise", "エクササイズ"], emoji: "💪" },
  { keys: ["ランニング", "running", "ジョギング", "jog", "走", "マラソン", "marathon"], emoji: "🏃" },
  { keys: ["ウォーキング", "walk", "散歩", "歩"], emoji: "🚶" },
  { keys: ["ヨガ", "yoga"], emoji: "🧘" },
  { keys: ["ストレッチ", "stretch", "柔軟"], emoji: "🤸" },
  { keys: ["腹筋", "situp", "abs", "クランチ", "crunch"], emoji: "🤸" },
  { keys: ["背筋"], emoji: "🦴" },
  { keys: ["スクワット", "squat"], emoji: "🦵" },
  { keys: ["腕立て", "pushup", "push-up", "push up"], emoji: "💪" },
  { keys: ["プランク", "plank"], emoji: "🪵" },
  { keys: ["バーピー", "burpee"], emoji: "🔥" },
  { keys: ["デッドリフト", "deadlift", "ベンチプレス", "bench press"], emoji: "🏋️" },
  { keys: ["有酸素", "aerobic", "cardio"], emoji: "🫀" },
  { keys: ["自転車", "bike", "cycle", "サイクリング", "サイクル", "ロードバイク"], emoji: "🚴" },
  { keys: ["階段", "stairs"], emoji: "🪜" },
  { keys: ["歩数", "steps", "万歩"], emoji: "👟" },
  { keys: ["体重", "weight", "weigh", "計量", "計測", "体組成"], emoji: "⚖️" },
  { keys: ["姿勢", "posture"], emoji: "🧍" },
  { keys: ["縄跳び", "jump rope"], emoji: "🪢" },
  // === 健康・ヘルス ===
  { keys: ["睡眠", "sleep", "早寝", "寝る", "ベッド"], emoji: "😴" },
  { keys: ["昼寝", "nap", "仮眠"], emoji: "💤" },
  { keys: ["早起き", "起床", "起きる"], emoji: "🌅" },
  { keys: ["朝", "morning"], emoji: "🌅" },
  { keys: ["夜", "night", "evening"], emoji: "🌙" },
  { keys: ["瞑想", "meditat", "mindful", "マインドフル"], emoji: "🧘" },
  { keys: ["呼吸", "breath"], emoji: "🌬️" },
  { keys: ["薬", "medicine", "サプリ", "supplement", "ビタミン", "vitamin"], emoji: "💊" },
  { keys: ["歯磨き", "歯", "tooth", "brush"], emoji: "🦷" },
  { keys: ["フロス", "floss", "デンタル"], emoji: "🦷" },
  { keys: ["スキンケア", "skincare", "化粧水", "美容液"], emoji: "🧴" },
  { keys: ["化粧", "makeup", "メイク"], emoji: "💄" },
  { keys: ["香水", "perfume"], emoji: "🌸" },
  { keys: ["髪", "hair", "ヘアケア"], emoji: "💇" },
  { keys: ["入浴", "風呂", "bath"], emoji: "🛁" },
  { keys: ["シャワー", "shower"], emoji: "🚿" },
  { keys: ["サウナ", "sauna"], emoji: "🧖" },
  { keys: ["日焼け止め", "sunscreen"], emoji: "🌞" },
  { keys: ["体温", "temperature"], emoji: "🌡️" },
  { keys: ["血圧", "pressure"], emoji: "🩺" },
  { keys: ["便", "排便"], emoji: "🚽" },
  // === 食事・栄養 ===
  { keys: ["タンパク", "たんぱく", "蛋白", "プロテイン", "protein"], emoji: "🥩" },
  { keys: ["肉", "meat", "ステーキ", "steak", "ビーフ", "beef"], emoji: "🥩" },
  { keys: ["鶏", "chicken", "チキン"], emoji: "🍗" },
  { keys: ["豚", "pork"], emoji: "🐖" },
  { keys: ["魚", "fish", "サーモン", "salmon", "刺身", "マグロ"], emoji: "🐟" },
  { keys: ["卵", "tamago", "たまご", "egg"], emoji: "🥚" },
  { keys: ["牛乳", "ミルク", "milk"], emoji: "🥛" },
  { keys: ["ヨーグルト", "yogurt", "yoghurt"], emoji: "🥣" },
  { keys: ["チーズ", "cheese"], emoji: "🧀" },
  { keys: ["バター", "butter"], emoji: "🧈" },
  { keys: ["豆", "bean", "豆腐", "tofu", "納豆", "natto"], emoji: "🫘" },
  { keys: ["米", "ご飯", "ごはん", "rice"], emoji: "🍚" },
  { keys: ["パン", "bread", "トースト", "toast", "ベーグル", "bagel"], emoji: "🍞" },
  { keys: ["麺", "noodle", "ラーメン", "ramen", "うどん", "そば", "パスタ", "pasta"], emoji: "🍜" },
  { keys: ["カレー", "curry"], emoji: "🍛" },
  { keys: ["寿司", "sushi"], emoji: "🍣" },
  { keys: ["弁当", "bento"], emoji: "🍱" },
  { keys: ["ピザ", "pizza"], emoji: "🍕" },
  { keys: ["ハンバーガー", "burger"], emoji: "🍔" },
  { keys: ["サンドイッチ", "sandwich"], emoji: "🥪" },
  { keys: ["スープ", "soup", "鍋", "hot pot"], emoji: "🍲" },
  { keys: ["野菜", "vegetable", "サラダ", "salad", "veggies"], emoji: "🥗" },
  { keys: ["果物", "fruit", "リンゴ", "apple"], emoji: "🍎" },
  { keys: ["バナナ", "banana"], emoji: "🍌" },
  { keys: ["イチゴ", "苺", "strawberry"], emoji: "🍓" },
  { keys: ["みかん", "オレンジ", "orange"], emoji: "🍊" },
  { keys: ["ぶどう", "葡萄", "grape"], emoji: "🍇" },
  { keys: ["スイカ", "watermelon"], emoji: "🍉" },
  { keys: ["ナッツ", "アーモンド", "nut", "almond"], emoji: "🥜" },
  { keys: ["カロリー", "calorie", "kcal"], emoji: "🔥" },
  { keys: ["お菓子", "sweet", "間食", "snack", "おやつ"], emoji: "🍪" },
  { keys: ["ケーキ", "cake"], emoji: "🍰" },
  { keys: ["チョコ", "chocolate"], emoji: "🍫" },
  { keys: ["アイス", "ice cream", "アイスクリーム"], emoji: "🍦" },
  { keys: ["砂糖", "sugar"], emoji: "🍬" },
  { keys: ["塩", "salt"], emoji: "🧂" },
  // === 飲み物 ===
  { keys: ["コーヒー", "coffee"], emoji: "☕" },
  { keys: ["お茶", "tea", "緑茶", "紅茶", "ほうじ茶"], emoji: "🍵" },
  { keys: ["水", "water", "drink", "飲む", "飲水", "hydrate", "水分"], emoji: "💧" },
  { keys: ["ジュース", "juice"], emoji: "🧃" },
  { keys: ["スムージー", "smoothie"], emoji: "🥤" },
  { keys: ["ビール", "beer"], emoji: "🍺" },
  { keys: ["ワイン", "wine"], emoji: "🍷" },
  { keys: ["お酒", "alcohol", "酒", "drinking"], emoji: "🍶" },
  { keys: ["禁酒", "no drink", "no alcohol", "断酒"], emoji: "🚫" },
  { keys: ["禁煙", "no smoke", "stop smoking"], emoji: "🚭" },
  { keys: ["タバコ", "smoke"], emoji: "🚬" },
  // === 学習 ===
  { keys: ["読書", "book", "本", "reading", "read"], emoji: "📚" },
  { keys: ["小説", "novel"], emoji: "📖" },
  { keys: ["漫画", "manga", "コミック", "comic"], emoji: "📕" },
  { keys: ["勉強", "study", "学習", "学ぶ"], emoji: "📖" },
  { keys: ["単語", "vocabulary", "vocab", "vokabeln"], emoji: "📖" },
  { keys: ["文法", "grammar"], emoji: "📖" },
  { keys: ["英語", "english"], emoji: "🇬🇧" },
  { keys: ["日本語", "japanese"], emoji: "🇯🇵" },
  { keys: ["ドイツ語", "german", "deutsch"], emoji: "🇩🇪" },
  { keys: ["フランス語", "french", "français"], emoji: "🇫🇷" },
  { keys: ["スペイン語", "spanish", "español"], emoji: "🇪🇸" },
  { keys: ["イタリア語", "italian"], emoji: "🇮🇹" },
  { keys: ["中国語", "chinese", "mandarin"], emoji: "🇨🇳" },
  { keys: ["韓国語", "korean", "ハングル"], emoji: "🇰🇷" },
  { keys: ["ロシア語", "russian"], emoji: "🇷🇺" },
  { keys: ["数学", "math"], emoji: "🔢" },
  { keys: ["物理", "physics"], emoji: "⚛️" },
  { keys: ["化学", "chemistry"], emoji: "🧪" },
  { keys: ["生物", "biology"], emoji: "🧬" },
  { keys: ["歴史", "history"], emoji: "📜" },
  { keys: ["地理", "geography"], emoji: "🌍" },
  { keys: ["漢字", "kanji"], emoji: "🈁" },
  { keys: ["プログラミング", "coding", "プログラム", "programming"], emoji: "💻" },
  { keys: ["コード", "code", "アルゴリズム", "algorithm"], emoji: "💻" },
  { keys: ["AI", "ML", "機械学習"], emoji: "🤖" },
  { keys: ["試験", "exam", "テスト", "test", "受験"], emoji: "📝" },
  { keys: ["宿題", "homework"], emoji: "📝" },
  { keys: ["講義", "lecture", "授業"], emoji: "🎓" },
  { keys: ["資格", "certification", "qualification"], emoji: "🎓" },
  { keys: ["卒業", "graduate"], emoji: "🎓" },
  // === 創作 ===
  { keys: ["音楽", "music"], emoji: "🎵" },
  { keys: ["歌", "sing", "ボーカル", "vocal", "カラオケ", "karaoke"], emoji: "🎤" },
  { keys: ["ピアノ", "piano"], emoji: "🎹" },
  { keys: ["ギター", "guitar"], emoji: "🎸" },
  { keys: ["ドラム", "drum"], emoji: "🥁" },
  { keys: ["バイオリン", "violin"], emoji: "🎻" },
  { keys: ["作曲", "compose"], emoji: "🎼" },
  { keys: ["絵", "draw", "drawing", "art", "アート", "イラスト", "illustration"], emoji: "🎨" },
  { keys: ["塗り絵", "color"], emoji: "🖍️" },
  { keys: ["写真", "photo", "カメラ", "camera"], emoji: "📷" },
  { keys: ["映画", "movie", "シネマ", "cinema"], emoji: "🎬" },
  { keys: ["動画", "video", "youtube", "ユーチューブ"], emoji: "🎥" },
  { keys: ["アニメ", "anime"], emoji: "📺" },
  { keys: ["ドラマ", "drama"], emoji: "🎭" },
  { keys: ["ライティング", "writing", "書く", "blog", "ブログ", "ライター"], emoji: "✍️" },
  { keys: ["メモ", "note"], emoji: "📝" },
  { keys: ["日記", "journal", "ジャーナル", "diary"], emoji: "📔" },
  { keys: ["詩", "poem", "ポエム"], emoji: "📜" },
  { keys: ["手紙", "letter"], emoji: "💌" },
  { keys: ["編み物", "knit", "編む"], emoji: "🧶" },
  { keys: ["裁縫", "sewing", "縫"], emoji: "🧵" },
  // === 仕事・タスク ===
  { keys: ["仕事", "work", "業務", "ビジネス", "business"], emoji: "💼" },
  { keys: ["メール", "email", "mail", "Eメール"], emoji: "📧" },
  { keys: ["会議", "meeting", "ミーティング"], emoji: "🤝" },
  { keys: ["電話", "call", "phone", "TEL"], emoji: "📞" },
  { keys: ["資料", "document", "書類"], emoji: "📄" },
  { keys: ["レポート", "report", "報告書"], emoji: "📊" },
  { keys: ["プレゼン", "presentation", "プレゼンテーション"], emoji: "📊" },
  { keys: ["営業", "sales"], emoji: "💼" },
  { keys: ["マーケティング", "marketing"], emoji: "📈" },
  { keys: ["会計", "経理", "accounting"], emoji: "🧾" },
  { keys: ["出勤", "通勤", "commute"], emoji: "🚆" },
  { keys: ["リモート", "remote"], emoji: "🏠" },
  { keys: ["休憩", "break"], emoji: "☕" },
  { keys: ["振り返り", "reflection", "retrospective", "リフレクション"], emoji: "🪞" },
  { keys: ["目標", "goal", "目的"], emoji: "🎯" },
  { keys: ["計画", "plan", "プラン"], emoji: "📋" },
  { keys: ["スケジュール", "schedule", "calendar", "カレンダー"], emoji: "📅" },
  { keys: ["ニュース", "news"], emoji: "📰" },
  { keys: ["読み合わせ", "review", "レビュー"], emoji: "👀" },
  { keys: ["達成", "achieve", "完了"], emoji: "🏆" },
  // === 家事 ===
  { keys: ["掃除", "clean", "そうじ"], emoji: "🧹" },
  { keys: ["洗濯", "laundry"], emoji: "🧺" },
  { keys: ["料理", "cook", "クッキング", "cooking", "自炊"], emoji: "🍳" },
  { keys: ["食器", "dish", "皿洗い"], emoji: "🍽️" },
  { keys: ["ゴミ", "trash", "ごみ", "garbage"], emoji: "🗑️" },
  { keys: ["買い物", "shop", "shopping", "買物"], emoji: "🛒" },
  { keys: ["整理", "整頓", "organize"], emoji: "📦" },
  { keys: ["DIY", "修理", "repair"], emoji: "🔨" },
  { keys: ["家事"], emoji: "🧹" },
  // === お金 ===
  { keys: ["お金", "money"], emoji: "💰" },
  { keys: ["貯金", "saving", "節約", "貯蓄"], emoji: "🐖" },
  { keys: ["家計簿", "budget", "家計"], emoji: "📊" },
  { keys: ["投資", "invest", "investment"], emoji: "📈" },
  { keys: ["株", "stock", "株式"], emoji: "📈" },
  { keys: ["副業", "side job", "副収入"], emoji: "💼" },
  { keys: ["支払い", "payment", "支払"], emoji: "💳" },
  { keys: ["クレジット", "credit"], emoji: "💳" },
  // === 趣味・娯楽 ===
  { keys: ["旅行", "travel", "trip", "旅"], emoji: "✈️" },
  { keys: ["飛行機", "flight", "plane"], emoji: "✈️" },
  { keys: ["新幹線", "shinkansen"], emoji: "🚄" },
  { keys: ["電車", "train"], emoji: "🚆" },
  { keys: ["車", "car", "ドライブ", "drive"], emoji: "🚗" },
  { keys: ["バイク", "motorcycle"], emoji: "🏍️" },
  { keys: ["ゲーム", "game", "ゲーミング"], emoji: "🎮" },
  { keys: ["ボードゲーム", "board game"], emoji: "🎲" },
  { keys: ["パズル", "puzzle"], emoji: "🧩" },
  { keys: ["ペット", "犬", "dog", "わんこ"], emoji: "🐶" },
  { keys: ["猫", "cat", "ねこ"], emoji: "🐱" },
  { keys: ["うさぎ", "rabbit", "ウサギ"], emoji: "🐰" },
  { keys: ["鳥", "bird"], emoji: "🐦" },
  { keys: ["花", "flower", "ガーデニング", "garden", "植物", "plant"], emoji: "🌸" },
  { keys: ["キャンプ", "camp", "アウトドア", "outdoor"], emoji: "🏕️" },
  { keys: ["海", "beach", "sea", "ocean"], emoji: "🌊" },
  { keys: ["山", "mountain"], emoji: "🏔️" },
  { keys: ["温泉", "hot spring", "spa"], emoji: "♨️" },
  // === 人間関係 ===
  { keys: ["友達", "friend", "友人"], emoji: "👯" },
  { keys: ["家族", "family", "ファミリー"], emoji: "👪" },
  { keys: ["恋人", "partner", "パートナー", "彼氏", "彼女", "boyfriend", "girlfriend"], emoji: "💑" },
  { keys: ["子供", "kid", "child", "育児"], emoji: "👶" },
  { keys: ["親", "parent", "親孝行"], emoji: "👨‍👩‍👧" },
  { keys: ["デート", "date", "ロマンス", "romance"], emoji: "💕" },
  { keys: ["パーティ", "party"], emoji: "🎉" },
  { keys: ["お祝い", "celebrate", "誕生日", "birthday"], emoji: "🎂" },
  // === メンタル ===
  { keys: ["感謝", "gratitude", "ありがとう", "thanks"], emoji: "🙏" },
  { keys: ["祈り", "pray", "prayer"], emoji: "🙏" },
  { keys: ["内省", "reflect"], emoji: "🪞" },
  { keys: ["ストレス", "stress"], emoji: "😤" },
  { keys: ["リラックス", "relax", "癒し"], emoji: "🧖" },
  { keys: ["気分", "mood"], emoji: "😊" },
  // === 時間・タイマー ===
  { keys: ["時間", "time"], emoji: "⏰" },
  { keys: ["アラーム", "alarm"], emoji: "⏰" },
  { keys: ["タイマー", "timer"], emoji: "⏱️" },
  { keys: ["ポモドーロ", "pomodoro"], emoji: "🍅" },
  // === デジタル ===
  { keys: ["SNS", "ソーシャル", "social"], emoji: "📱" },
  { keys: ["スマホ", "phone", "携帯"], emoji: "📱" },
  { keys: ["パソコン", "PC", "computer"], emoji: "💻" },
  { keys: ["ネット", "internet", "オンライン", "online"], emoji: "🌐" },
  { keys: ["インスタ", "instagram"], emoji: "📸" },
  { keys: ["ツイッター", "twitter", " x"], emoji: "🐦" },
  // === その他 / 汎用 ===
  { keys: ["食事", "meal", "breakfast", "lunch", "dinner", "朝食", "昼食", "夕食"], emoji: "🍽️" },
  { keys: ["飲", "drink"], emoji: "🥤" },
  { keys: ["話", "話す", "talk"], emoji: "💬" },
  { keys: ["聞", "listen"], emoji: "🎧" },
  { keys: ["見", "watch"], emoji: "👀" },
  { keys: ["考", "think", "thought"], emoji: "💭" },
  { keys: ["書", "write"], emoji: "✍️" },
];

function suggestEmoji(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const s of EMOJI_SUGGESTIONS) {
    for (const k of s.keys) {
      if (n.includes(k.toLowerCase())) return s.emoji;
    }
  }
  return null;
}

let _userTouchedEmoji = false;

function setEmojiSuggested(isSuggested) {
  $("#h-emoji").classList.toggle("is-suggested", isSuggested);
  $("#emojiSuggestionHint").classList.toggle("show", isSuggested);
}

function openHabitEditor(id) {
  state.editingHabitId = id || null;
  _userTouchedEmoji = false;
  if (id) {
    const h = state.habits.find((x) => x.id === id);
    if (!h) return;
    $("#habitEditorTitle").textContent = "習慣を編集";
    $("#h-emoji").value = h.emoji || "";
    $("#h-name").value = h.name || "";
    $("#deleteHabitBtn").style.display = "";
    _userTouchedEmoji = true; // 既存編集時は手動扱い（自動上書きしない）
    setEmojiSuggested(false);
  } else {
    $("#habitEditorTitle").textContent = "新しい習慣";
    $("#h-emoji").value = "";
    $("#h-name").value = "";
    $("#deleteHabitBtn").style.display = "none";
    setEmojiSuggested(false);
  }
  habitEditor.showModal();
  setTimeout(() => $("#h-name").focus(), 30);
}

// 絵文字をユーザーが手動編集したらフラグを立てる
$("#h-emoji").addEventListener("input", () => {
  _userTouchedEmoji = true;
  setEmojiSuggested(false);
});

// 名前変更時に未編集ならオススメ絵文字を入れる
$("#h-name").addEventListener("input", () => {
  if (_userTouchedEmoji) return;
  const suggested = suggestEmoji($("#h-name").value);
  if (suggested) {
    $("#h-emoji").value = suggested;
    setEmojiSuggested(true);
  } else if ($("#h-emoji").classList.contains("is-suggested")) {
    // 直前にオススメで埋めていたが、新しい名前に合うものがない → クリア
    $("#h-emoji").value = "";
    setEmojiSuggested(false);
  }
});

function closeHabitEditor() {
  if (habitEditor.open) habitEditor.close();
  state.editingHabitId = null;
}

habitEditorForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#h-name").value.trim();
  // 絵文字: ユーザーが入力したならそれ、空ならオススメ、なければ空文字
  let emoji = $("#h-emoji").value.trim();
  if (!emoji) emoji = suggestEmoji(name) || "";
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
  const delId = state.editingHabitId;
  state.habits = state.habits.filter((x) => x.id !== delId);
  state.tombstones = state.tombstones || emptyTombstones();
  state.tombstones.habits[delId] = Date.now(); // 削除を全端末へ確実に伝播
  saveAll();
  renderHabits();
  renderToday();
  closeHabitEditor();
  toast("削除しました");
});

// ---------- タブ切替 ----------

function setView(view) {
  if (!["today", "tasks", "habits", "stats"].includes(view)) view = "today";
  state.view = view;
  $("#todayView").hidden = view !== "today";
  $("#tasksView").hidden = view !== "tasks";
  $("#habitsView").hidden = view !== "habits";
  $("#statsView").hidden = view !== "stats";
  $$("#tabs .tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view)
  );
  $("#addBtn").style.display = view === "stats" ? "none" : "";
  $("#addBtn").textContent = view === "habits" ? "＋ 新しい習慣" : "＋ 新しいタスク";
  localStorage.setItem(VIEW_KEY, view);
  if (view === "today") renderToday();
  if (view === "habits") renderHabits();
  if (view === "stats") renderStats();
}

$$("#tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.view));
});

// 月ナビ
function shiftHabitMonth(delta) {
  const d = new Date(state.habitYear, state.habitMonth + delta, 1);
  state.habitYear = d.getFullYear();
  state.habitMonth = d.getMonth();
  renderHabits();
}
$("#prevMonthBtn").addEventListener("click", () => shiftHabitMonth(-1));
$("#nextMonthBtn").addEventListener("click", () => shiftHabitMonth(1));
$("#thisMonthBtn").addEventListener("click", () => {
  const now = new Date();
  state.habitYear = now.getFullYear();
  state.habitMonth = now.getMonth();
  renderHabits();
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
      spaceId: spaceIdFor(state.currentUserId),
      getState: () => ({
        tasks: state.tasks,
        habits: state.habits,
        tombstones: state.tombstones || emptyTombstones(),
      }),
      onRemote: ({ tasks, habits, tombstones }) => {
        state.tasks = (tasks || []).map(normalizeTask);
        state.habits = (habits || []).map(normalizeHabit);
        if (tombstones && typeof tombstones === "object") {
          state.tombstones = {
            tasks: tombstones.tasks || {},
            habits: tombstones.habits || {},
          };
        }
        try {
          localStorage.setItem(
            storageKeyFor(state.currentUserId),
            JSON.stringify({
              tasks: state.tasks,
              habits: state.habits,
              tombstones: state.tombstones,
            })
          );
        } catch (e) {
          console.warn("[onRemote] localStorage failed:", e);
        }
        render();
        renderHabits();
        renderToday();
        renderStats();
        setSyncStatus("ok", "同期済み");
      },
      onStatus: (kind, msg) => setSyncStatus(kind, msg),
    });
  } catch (err) {
    console.error(err);
    setSyncStatus("err", "オフライン（ローカル保存は継続）");
  }
}

async function switchUser(newUserId) {
  if (newUserId === state.currentUserId) return;
  state.currentUserId = newUserId;
  setCurrentUserIdLS(newUserId);
  // 新ユーザーのローカルキャッシュを読み込み
  const saved = loadAll(newUserId);
  state.tasks = saved.tasks.map(normalizeTask);
  state.habits = saved.habits.map(normalizeHabit);
  state.tombstones = saved.tombstones || emptyTombstones();
  // UI即時反映 + メニューの ✓ 位置を更新
  updateUserUI();
  renderUserMenu();
  render();
  renderHabits();
  renderToday();
  // 連携バッジ: u1ならシナモン、u2ならREPS、それ以外は非表示
  const badge = $("#cinnamonStatus");
  if (badge) {
    if (newUserId === "u1") {
      badge.dataset.kind = "sync";
      badge.textContent = "🥗 シナモン同期中…";
    } else if (newUserId === "u2") {
      badge.dataset.kind = "sync";
      badge.textContent = "💪 REPS同期中…";
    } else {
      badge.dataset.kind = "none";
      badge.textContent = "";
    }
  }
  // 新Firestoreドキュメントへ再接続
  await reconnectSync();
}

function updateUserUI() {
  const u = currentUser();
  $("#userEmoji").textContent = u.emoji || "👤";
  $("#userName").textContent = u.name;
}

function renderUserMenu() {
  const menu = $("#userMenu");
  menu.innerHTML = "";
  for (const u of state.users) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "user-menu-item" + (u.id === state.currentUserId ? " active" : "");
    btn.dataset.user = u.id;
    btn.innerHTML = `
      <span class="ue">${escapeHtml(u.emoji || "👤")}</span>
      <span class="un">${escapeHtml(u.name)}</span>
      ${u.id === state.currentUserId ? '<span class="check">✓</span>' : ''}
    `;
    btn.addEventListener("click", () => {
      menu.hidden = true;
      switchUser(u.id);
    });
    menu.appendChild(btn);
  }
  // 区切り
  menu.appendChild(document.createElement("hr"));
  // 名前編集
  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "user-menu-item rename";
  renameBtn.innerHTML = "✎ ユーザー名を編集";
  renameBtn.addEventListener("click", () => {
    menu.hidden = true;
    promptRenameUsers();
  });
  menu.appendChild(renameBtn);
}

function promptRenameUsers() {
  for (const u of state.users) {
    const newName = prompt(`「${u.name}」の新しい名前を入力（キャンセルで変更なし）`, u.name);
    if (newName !== null && newName.trim()) u.name = newName.trim();
    const newEmoji = prompt(`「${u.name}」の絵文字（1文字、空欄で変更なし）`, u.emoji || "");
    if (newEmoji !== null && newEmoji.trim()) u.emoji = newEmoji.trim();
  }
  saveUsers(state.users);
  updateUserUI();
  renderUserMenu();
  // 全端末へ反映
  pushUsers(state.users).catch((err) => {
    console.warn("[users] push failed:", err);
    toast("ユーザー名の同期に失敗（ローカルには保存済み）");
  });
}

// ---------- 起動 ----------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $("#themeBtn");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  localStorage.setItem("fuwatto_theme_v1", theme);
}

function init() {
  // テーマ初期化（保存値があればそれ、なければ常にライト）
  const savedTheme = localStorage.getItem("fuwatto_theme_v1");
  applyTheme(savedTheme || "light");
  $("#themeBtn").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  // ユーザーセレクタ
  updateUserUI();
  renderUserMenu();
  $("#userBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("#userMenu");
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", (e) => {
    const menu = $("#userMenu");
    if (!menu.hidden && !e.target.closest("#userSelector")) menu.hidden = true;
  });

  const saved = loadAll();
  state.tasks = saved.tasks.map(normalizeTask);
  state.habits = saved.habits.map(normalizeHabit);
  state.tombstones = saved.tombstones || emptyTombstones();
  const savedView = localStorage.getItem(VIEW_KEY) || "today";
  setView(savedView);
  render();
  renderHabits();
  renderToday();
  renderStats();
  // バージョンタグ
  const vt = $("#versionTag");
  if (vt) vt.textContent = APP_VERSION;

  // 起動時にもローカル履歴に現在状態を入れて、最低1世代は手元に残す（緊急時の保険・非表示）
  pushLocalHistory(state.currentUserId, { tasks: state.tasks, habits: state.habits });

  // 画面は縦固定（manifestで portrait 指定）
  try {
    if (screen.orientation && typeof screen.orientation.lock === "function") {
      screen.orientation.lock("portrait").catch(() => {});
    }
  } catch {}

  setSyncStatus("sync", "同期接続中…");
  reconnectSync();

  // ユーザー名・絵文字を全端末同期
  startUsersSync({
    getUsers: () => state.users,
    onRemote: (remoteUsers) => {
      // 同じだったらスキップ
      const cur = JSON.stringify(state.users);
      const next = JSON.stringify(remoteUsers);
      if (cur === next) return;
      state.users = remoteUsers;
      saveUsers(state.users);
      // 現在ユーザーが消えていた場合は先頭にフォールバック
      if (!state.users.find((u) => u.id === state.currentUserId)) {
        state.currentUserId = state.users[0].id;
        setCurrentUserIdLS(state.currentUserId);
      }
      updateUserUI();
      renderUserMenu();
    },
    onStatus: () => {},
  });

  // cinnamon-workout 連携: 過去〜今日の達成率をワークアウト習慣に反映
  // ※ レベッカ（u1）専用 — 達也（u2）など他ユーザーには反映しない
  startCinnamonBridge(
    (nameKeywords, progressByDate) => {
      if (state.currentUserId !== "u1") return; // u1以外は無視
      const target = state.habits.find((h) =>
        nameKeywords.some((k) => (h.name || "").toLowerCase().includes(k.toLowerCase()))
      );
      const badge = $("#cinnamonStatus");
      if (!target) {
        if (badge) {
          badge.dataset.kind = "err";
          badge.textContent = "🥗 シナモン: 「ワークアウト」習慣が見つからない";
        }
        return;
      }
      target.entries = target.entries || {};
      target.entryUpdatedAt = target.entryUpdatedAt || {};
      let changed = false;
      let newlyComplete = false;
      const tk = todayKey();
      for (const [dateKey, pct] of Object.entries(progressByDate)) {
        const current = target.entries[dateKey] || 0;
        if (pct <= current) continue;
        if (dateKey === tk && pct === 100 && current < 100) newlyComplete = true;
        target.entries[dateKey] = pct;
        target.entryUpdatedAt[dateKey] = Date.now();
        changed = true;
      }
      if (changed) {
        target.updatedAt = Date.now();
        saveAll(false);
        renderHabits();
        renderToday();
        if (newlyComplete) toast(`💪 ${target.name} 達成！🎉`);
      }
    },
    (status) => {
      const badge = $("#cinnamonStatus");
      if (!badge) return;
      // u1以外ならバッジ非表示
      if (state.currentUserId !== "u1") {
        badge.dataset.kind = "none";
        badge.textContent = "";
        return;
      }
      badge.dataset.kind = status.kind;
      badge.textContent = "🥗 " + status.text;
    }
  );

  // REPS (俺筋トレ) 連携: 過去〜今日のワークアウトを達也(u2)へ反映
  startRepsBridge(
    (nameKeywords, progressByDate) => {
      if (state.currentUserId !== "u2") return; // 達也のみ
      const target = state.habits.find((h) =>
        nameKeywords.some((k) => (h.name || "").toLowerCase().includes(k.toLowerCase()))
      );
      const badge = $("#cinnamonStatus");
      if (!target) {
        if (badge) {
          badge.dataset.kind = "err";
          badge.textContent = "💪 REPS: 「ワークアウト」習慣が見つからない";
        }
        return;
      }
      target.entries = target.entries || {};
      target.entryUpdatedAt = target.entryUpdatedAt || {};
      let changed = false;
      let newlyComplete = false;
      const tk = todayKey();
      for (const [dateKey, pct] of Object.entries(progressByDate)) {
        const current = target.entries[dateKey] || 0;
        if (pct <= current) continue;
        if (dateKey === tk && pct === 100 && current < 100) newlyComplete = true;
        target.entries[dateKey] = pct;
        target.entryUpdatedAt[dateKey] = Date.now();
        changed = true;
      }
      if (changed) {
        target.updatedAt = Date.now();
        saveAll(false);
        renderHabits();
        renderToday();
        if (newlyComplete) toast(`💪 ${target.name} 達成！🎉`);
      }
    },
    (status) => {
      const badge = $("#cinnamonStatus");
      if (!badge) return;
      if (state.currentUserId !== "u2") {
        // 達也以外のときはREPSステータスを表示しない
        return;
      }
      badge.dataset.kind = status.kind;
      badge.textContent = "💪 " + status.text;
    }
  );

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
