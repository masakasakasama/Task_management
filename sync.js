// Firestore による全端末同期
// - Firebase 設定と SPACE_ID をハードコード
// - 同じURLを開いた端末はすべて同じドキュメントを読み書き
// - 認証なし、トークンなし、入力欄なし
// - セキュリティ: Firestore ルールで「24文字以上のドキュメントID」のみ許可

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
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

// 24文字以上必須・公開だが推測困難な長さ・運用者が把握できる命名
const COLLECTION = "spaces";
const SPACE_ID = "masakasakasama-task-management-2026-private-space";

let app = null;
let db = null;
let docRef = null;
let unsub = null;
let pushTimer = null;
let active = false;
let lastRemoteHash = "";

let getTasksRef = null;
let onRemoteRef = null;
let onStatusRef = null;

export function isSyncActive() {
  return active;
}

export async function startSync({ getTasks, onRemote, onStatus }) {
  stopSync();
  getTasksRef = getTasks;
  onRemoteRef = onRemote;
  onStatusRef = onStatus;

  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  docRef = doc(db, COLLECTION, SPACE_ID);

  onStatus("sync", "同期接続中…");

  const snap = await getDoc(docRef);
  if (snap.exists()) {
    const data = snap.data();
    const remoteTasks = Array.isArray(data.tasks) ? data.tasks : [];
    const merged = mergeTasks(getTasks(), remoteTasks);
    lastRemoteHash = hash(merged);
    onRemote(merged);
    if (hash(merged) !== hash(remoteTasks)) {
      await setDoc(docRef, { tasks: merged, updatedAt: Date.now() }, { merge: true });
    }
  } else {
    const initial = getTasks();
    await setDoc(docRef, { tasks: initial, updatedAt: Date.now() });
    lastRemoteHash = hash(initial);
  }

  unsub = onSnapshot(
    docRef,
    (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      const remoteTasks = Array.isArray(data.tasks) ? data.tasks : [];
      const h = hash(remoteTasks);
      if (h === lastRemoteHash) return;
      lastRemoteHash = h;
      onRemoteRef(remoteTasks);
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
      const tasks = getTasksRef();
      const h = hash(tasks);
      if (h === lastRemoteHash) return;
      onStatusRef("sync", "同期中…");
      lastRemoteHash = h;
      await setDoc(docRef, { tasks, updatedAt: Date.now() }, { merge: true });
      onStatusRef("ok", "同期済み");
    } catch (err) {
      onStatusRef("err", "送信エラー: " + (err.code || err.message));
    }
  }, 500);
}

function mergeTasks(localList, remoteList) {
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

function hash(obj) {
  try {
    const sorted = (obj || []).slice().sort((a, b) => (a.id > b.id ? 1 : -1));
    const s = JSON.stringify(sorted);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return String(h);
  } catch {
    return String(Math.random());
  }
}
