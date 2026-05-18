// Firestore による全端末同期
// - Firebase 設定と SPACE_ID をハードコード
// - 同じURLを開いた端末はすべて同じドキュメントを読み書き
// - tasks と habits の両方を1ドキュメントで管理
// - 認証なし、トークンなし、入力欄なし
// - セキュリティ: Firestore ルールで「24文字以上のドキュメントID」のみ許可

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getFirestore,
  doc,
  onSnapshot,
  setDoc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAvxleNWQEtIP1I7WimhI5-X-6oVtcAw0I",
  authDomain: "task-management-5c55f.firebaseapp.com",
  projectId: "task-management-5c55f",
  storageBucket: "task-management-5c55f.firebasestorage.app",
  messagingSenderId: "748379281870",
  appId: "1:748379281870:web:83040bb9fbab9fe34bf39f",
};

const COLLECTION = "spaces";
const BASE_SPACE_ID = "masakasakasama-task-management-2026-private-space";

export function spaceIdFor(userId) {
  // 既存データを温存するため u1 はサフィックス無し
  return userId === "u1" ? BASE_SPACE_ID : `${BASE_SPACE_ID}-${userId}`;
}

const USERS_META_ID = `${BASE_SPACE_ID}-users-meta`;
let usersUnsub = null;

function ensureApp() {
  return getApps().find((a) => a.name === "[DEFAULT]") || initializeApp(firebaseConfig);
}

/** ユーザー一覧（名前・絵文字）を全端末同期する */
export async function startUsersSync({ getUsers, onRemote, onStatus }) {
  stopUsersSync();
  try {
    const a = ensureApp();
    const d = getFirestore(a);
    const ref = doc(d, COLLECTION, USERS_META_ID);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data.users) && data.users.length > 0) onRemote(data.users);
    } else {
      // 初期化: ローカル既定値を書き込む
      await setDoc(ref, { users: getUsers(), updatedAt: Date.now() });
    }
    usersUnsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (Array.isArray(data.users) && data.users.length > 0) onRemote(data.users);
      },
      (err) => onStatus && onStatus("err", "ユーザー同期エラー: " + (err.code || err.message))
    );
  } catch (err) {
    onStatus && onStatus("err", "ユーザー同期初期化失敗: " + err.message);
  }
}

export function stopUsersSync() {
  if (usersUnsub) {
    try { usersUnsub(); } catch {}
    usersUnsub = null;
  }
}

/** ユーザー一覧をFirestoreへ送信 */
export async function pushUsers(users) {
  const a = ensureApp();
  const d = getFirestore(a);
  const ref = doc(d, COLLECTION, USERS_META_ID);
  await setDoc(ref, { users, updatedAt: Date.now() }, { merge: true });
}

let app = null;
let db = null;
let docRef = null;
let unsub = null;
let pushTimer = null;
let active = false;
let lastRemoteHash = "";

let getStateRef = null;
let onRemoteRef = null;
let onStatusRef = null;

export function isSyncActive() {
  return active;
}

const RESET_KEY_PREFIX = "fuwatto_last_reset_";
let resetKey = null;

function maybeHardReset(data) {
  // remote の resetAt が localStorage の最終 resetAt より新しければ、
  // マージせずに remote の状態をローカルに強制反映する（削除を伝搬させるための機構）
  const remoteResetAt = Number(data.resetAt || 0);
  if (remoteResetAt <= 0) return null;
  const lastSeen = Number(localStorage.getItem(resetKey) || 0);
  if (remoteResetAt <= lastSeen) return null;
  localStorage.setItem(resetKey, String(remoteResetAt));
  return {
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    habits: Array.isArray(data.habits) ? data.habits : [],
    tombstones: data.tombstones || { tasks: {}, habits: {} },
  };
}

function readRemote(data) {
  return {
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    habits: Array.isArray(data.habits) ? data.habits : [],
    tombstones: data.tombstones || { tasks: {}, habits: {} },
  };
}

export async function startSync({ spaceId, getState, onRemote, onStatus }) {
  stopSync();
  getStateRef = getState;
  onRemoteRef = onRemote;
  onStatusRef = onStatus;

  // 既存の default app を再利用（switchUser での再初期化を許容）
  app = getApps().find((a) => a.name === "[DEFAULT]") || initializeApp(firebaseConfig);
  db = getFirestore(app);
  docRef = doc(db, COLLECTION, spaceId || BASE_SPACE_ID);
  resetKey = RESET_KEY_PREFIX + (spaceId || BASE_SPACE_ID);

  onStatus("sync", "同期接続中…");

  const snap = await getDoc(docRef);
  if (snap.exists()) {
    const data = snap.data();

    // resetAt が新しければ、マージせず remote をローカルへ強制反映
    const hard = maybeHardReset(data);
    if (hard) {
      lastRemoteHash = hash(hard);
      onRemote(hard);
      // 購読開始
      unsub = onSnapshot(
        docRef,
        (snap2) => {
          if (!snap2.exists()) return;
          const data2 = snap2.data();
          const hard2 = maybeHardReset(data2);
          if (hard2) {
            const h = hash(hard2);
            if (h === lastRemoteHash) return;
            lastRemoteHash = h;
            onRemoteRef(hard2);
            return;
          }
          const remote2 = readRemote(data2);
          const local2 = getStateRef ? getStateRef() : { tasks: [], habits: [], tombstones: {} };
          const merged2 = mergeState(local2, remote2);
          const h = hash(merged2);
          if (h === lastRemoteHash) return;
          lastRemoteHash = h;
          onRemoteRef(merged2);
        },
        (err) => onStatusRef("err", "同期エラー: " + (err.code || err.message))
      );
      active = true;
      window.addEventListener("fuwatto:push", schedulePush);
      onStatus("ok", "同期済み");
      return;
    }

    const remote = readRemote(data);
    const local = getState();
    const merged = mergeState(local, remote);
    lastRemoteHash = hash(merged);
    onRemote(merged);
    if (hash(merged) !== hash(remote)) {
      await setDoc(docRef, { ...merged, updatedAt: Date.now() }, { merge: true });
    }
  } else {
    const initial = getState();
    await setDoc(docRef, { ...initial, updatedAt: Date.now() });
    lastRemoteHash = hash(initial);
  }

  unsub = onSnapshot(
    docRef,
    (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      // resetAt が新しければ強制リプレース
      const hard = maybeHardReset(data);
      if (hard) {
        const h = hash(hard);
        if (h === lastRemoteHash) return;
        lastRemoteHash = h;
        onRemoteRef(hard);
        return;
      }
      const remote = readRemote(data);
      // リモート変更にローカルのtombstoneを適用してから反映（削除の取りこぼし防止）
      const local = getStateRef ? getStateRef() : { tasks: [], habits: [], tombstones: {} };
      const merged = mergeState(local, remote);
      const h = hash(merged);
      if (h === lastRemoteHash) return;
      lastRemoteHash = h;
      onRemoteRef(merged);
    },
    (err) => {
      onStatusRef("err", "同期エラー: " + (err.code || err.message));
    }
  );

  active = true;
  window.addEventListener("fuwatto:push", schedulePush);
  onStatus("ok", "同期済み");
}

export function stopSync() {
  if (unsub) {
    try { unsub(); } catch {}
    unsub = null;
  }
  clearTimeout(pushTimer);
  pushTimer = null;
  active = false;
  window.removeEventListener("fuwatto:push", schedulePush);
  app = null;
  db = null;
  docRef = null;
  lastRemoteHash = "";
}

function schedulePush() {
  if (!active) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const s = getStateRef();
      const h = hash(s);
      if (h === lastRemoteHash) return;
      onStatusRef("sync", "同期中…");
      lastRemoteHash = h;
      await setDoc(docRef, { ...s, updatedAt: Date.now() }, { merge: true });
      onStatusRef("ok", "同期済み");
    } catch (err) {
      onStatusRef("err", "送信エラー: " + (err.code || err.message));
    }
  }, 500);
}

function gcTombstones(tomb) {
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90日で掃除
  const out = {};
  for (const k in tomb || {}) {
    if (typeof tomb[k] === "number" && tomb[k] >= cutoff) out[k] = tomb[k];
  }
  return out;
}

function mergeTombstones(a, b) {
  const out = {};
  for (const k in a || {}) out[k] = a[k];
  for (const k in b || {}) out[k] = Math.max(out[k] || 0, b[k]);
  return gcTombstones(out);
}

function applyTombstones(list, tomb) {
  if (!tomb) return list || [];
  return (list || []).filter((item) => {
    if (!item || !item.id) return false;
    const td = tomb[item.id];
    if (td == null) return true;
    // 削除時刻より後に更新されていれば「復活」として残す
    return (item.updatedAt || 0) > td;
  });
}

function mergeState(local, remote) {
  const lt = local.tombstones || {};
  const rt = remote.tombstones || {};
  const tasksTomb = mergeTombstones(lt.tasks, rt.tasks);
  const habitsTomb = mergeTombstones(lt.habits, rt.habits);
  const tasks = applyTombstones(mergeById(local.tasks, remote.tasks), tasksTomb);
  const habits = applyTombstones(mergeHabits(local.habits, remote.habits), habitsTomb);
  return {
    tasks,
    habits,
    tombstones: { tasks: tasksTomb, habits: habitsTomb },
  };
}

function mergeById(localList, remoteList) {
  const map = new Map();
  for (const t of localList || []) if (t && t.id) map.set(t.id, t);
  for (const t of remoteList || []) {
    if (!t || !t.id) continue;
    const existing = map.get(t.id);
    if (!existing) map.set(t.id, t);
    else if ((t.updatedAt || 0) >= (existing.updatedAt || 0)) map.set(t.id, t);
  }
  return Array.from(map.values());
}

// 習慣は entries(日付ごとの値) を per-day マージする
function mergeHabits(localList, remoteList) {
  const map = new Map();
  for (const h of localList || []) if (h && h.id) map.set(h.id, h);
  for (const r of remoteList || []) {
    if (!r || !r.id) continue;
    const local = map.get(r.id);
    if (!local) {
      map.set(r.id, r);
      continue;
    }
    const newerMeta = (r.updatedAt || 0) > (local.updatedAt || 0) ? r : local;
    const allDates = new Set([
      ...Object.keys(local.entries || {}),
      ...Object.keys(r.entries || {}),
    ]);
    const finalEntries = {};
    const finalEntryUpdated = {};
    for (const d of allDates) {
      const lt = (local.entryUpdatedAt && local.entryUpdatedAt[d]) || 0;
      const rt = (r.entryUpdatedAt && r.entryUpdatedAt[d]) || 0;
      if (rt >= lt) {
        if (r.entries && d in r.entries) finalEntries[d] = r.entries[d];
        finalEntryUpdated[d] = rt;
      } else {
        if (local.entries && d in local.entries) finalEntries[d] = local.entries[d];
        finalEntryUpdated[d] = lt;
      }
    }
    map.set(r.id, {
      id: r.id,
      name: newerMeta.name,
      emoji: newerMeta.emoji,
      createdAt: Math.min(local.createdAt || Infinity, r.createdAt || Infinity),
      updatedAt: newerMeta.updatedAt,
      entries: finalEntries,
      entryUpdatedAt: finalEntryUpdated,
    });
  }
  return Array.from(map.values());
}

function stableTomb(tomb) {
  // キー順を固定して端末間でhashがブレないようにする（同期ピンポン防止）
  const out = {};
  const t = (tomb && tomb.tasks) || {};
  const h = (tomb && tomb.habits) || {};
  out.tasks = {};
  for (const k of Object.keys(t).sort()) out.tasks[k] = t[k];
  out.habits = {};
  for (const k of Object.keys(h).sort()) out.habits[k] = h[k];
  return out;
}

function hash(obj) {
  try {
    const t = (obj.tasks || []).slice().sort((a, b) => (a.id > b.id ? 1 : -1));
    const h = (obj.habits || []).slice().sort((a, b) => (a.id > b.id ? 1 : -1));
    const tb = stableTomb(obj.tombstones);
    const s = JSON.stringify({ t, h, tb });
    let x = 0;
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
    return String(x);
  } catch {
    return String(Math.random());
  }
}
