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

export async function startSync({ spaceId, getState, onRemote, onStatus }) {
  stopSync();
  getStateRef = getState;
  onRemoteRef = onRemote;
  onStatusRef = onStatus;

  // 既存の default app を再利用（switchUser での再初期化を許容）
  app = getApps().find((a) => a.name === "[DEFAULT]") || initializeApp(firebaseConfig);
  db = getFirestore(app);
  docRef = doc(db, COLLECTION, spaceId || BASE_SPACE_ID);

  onStatus("sync", "同期接続中…");

  const snap = await getDoc(docRef);
  if (snap.exists()) {
    const data = snap.data();
    const remote = {
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      habits: Array.isArray(data.habits) ? data.habits : [],
    };
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
      const remote = {
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        habits: Array.isArray(data.habits) ? data.habits : [],
      };
      const h = hash(remote);
      if (h === lastRemoteHash) return;
      lastRemoteHash = h;
      onRemoteRef(remote);
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

function mergeState(local, remote) {
  return {
    tasks: mergeById(local.tasks, remote.tasks),
    habits: mergeHabits(local.habits, remote.habits),
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

function hash(obj) {
  try {
    const t = (obj.tasks || []).slice().sort((a, b) => (a.id > b.id ? 1 : -1));
    const h = (obj.habits || []).slice().sort((a, b) => (a.id > b.id ? 1 : -1));
    const s = JSON.stringify({ t, h });
    let x = 0;
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
    return String(x);
  } catch {
    return String(Math.random());
  }
}
