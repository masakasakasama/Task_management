// Firebase Firestore による多端末同期モジュール
// - 設定は ESM CDN から動的 import するため、ビルド不要
// - 単一ドキュメント（collection: fuwatto, doc: <space>）にタスク配列を保存
// - リモート変更は onSnapshot で受け取りローカルへ反映
// - ローカル変更は debounce してリモートへ反映
// - updatedAt が新しい方を優先するマージ戦略でほぼ常時同期

let unsub = null;
let firestoreApi = null;
let db = null;
let docRef = null;
let pushTimer = null;
let active = false;
let lastRemoteHash = "";

export function isSyncActive() {
  return active;
}

export async function startSync({ config, space, getTasks, onRemote, onStatus }) {
  // 動的 import（オフラインでは失敗するがローカル保存は継続）
  const appMod = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js");
  const fsMod = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
  firestoreApi = fsMod;

  const app = appMod.initializeApp(config, "fuwatto-" + space);
  db = fsMod.getFirestore(app);
  docRef = fsMod.doc(db, "fuwatto", space);

  // 初回読み込み
  const snap = await fsMod.getDoc(docRef);
  if (snap.exists()) {
    const data = snap.data();
    const remoteTasks = Array.isArray(data.tasks) ? data.tasks : [];
    const merged = mergeTasks(getTasks(), remoteTasks);
    lastRemoteHash = hash(merged);
    onRemote(merged);
    // 統合結果を書き戻し
    await fsMod.setDoc(docRef, { tasks: merged, updatedAt: Date.now() }, { merge: true });
  } else {
    await fsMod.setDoc(docRef, { tasks: getTasks(), updatedAt: Date.now() });
    lastRemoteHash = hash(getTasks());
  }

  // リモート購読
  unsub = fsMod.onSnapshot(
    docRef,
    (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      const remoteTasks = Array.isArray(data.tasks) ? data.tasks : [];
      const h = hash(remoteTasks);
      if (h === lastRemoteHash) return; // 自分が書いた変更
      lastRemoteHash = h;
      onRemote(remoteTasks);
    },
    (err) => {
      onStatus("err", "同期エラー: " + err.code);
    }
  );

  // ローカル変更を購読
  window.addEventListener("fuwatto:push", schedulePush);
  active = true;
  onStatus("ok", "同期済み");

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try {
        const tasks = getTasks();
        const h = hash(tasks);
        if (h === lastRemoteHash) return;
        lastRemoteHash = h;
        onStatus("sync", "同期中…");
        await fsMod.setDoc(docRef, { tasks, updatedAt: Date.now() }, { merge: true });
        onStatus("ok", "同期済み");
      } catch (err) {
        onStatus("err", "送信エラー: " + (err.code || err.message));
      }
    }, 500);
  }
}

export function stopSync() {
  if (unsub) {
    try { unsub(); } catch {}
    unsub = null;
  }
  window.removeEventListener("fuwatto:push", () => {});
  clearTimeout(pushTimer);
  active = false;
  db = null;
  docRef = null;
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
  // 軽量ハッシュ（順序非依存にするため id でソートしてから JSON 化）
  try {
    const sorted = (obj || []).slice().sort((a, b) => (a.id > b.id ? 1 : -1));
    const s = JSON.stringify(sorted);
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return String(h);
  } catch {
    return String(Math.random());
  }
}
