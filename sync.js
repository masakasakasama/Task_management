// GitHub Gist による同期モジュール
// - 個人用アクセストークン (PAT) を1つ入れるだけで動く
// - 初回起動時に Private Gist を自動作成し、以後はそこを読み書き
// - 他端末で同じ PAT を入れれば、description マーカーで自動発見
// - ローカル変更は debounce して PATCH、リモート変更は polling で取得しマージ
// - updatedAt が新しい方を優先する safe マージ

const GIST_DESCRIPTION = "fuwatto-task-data (do not edit manually)";
const FILENAME = "tasks.json";
const POLL_MS = 12000; // 12秒。GitHub API のレートリミットに優しい

let active = false;
let pollTimer = null;
let pushTimer = null;
let lastEtag = null;
let lastRemoteHash = "";
let currentToken = null;
let currentGistId = null;
let getTasksRef = null;
let onRemoteRef = null;
let onStatusRef = null;

export function isSyncActive() {
  return active;
}

export async function startSync({ token, gistId, getTasks, onRemote, onStatus, onGistIdChange }) {
  stopSync();
  if (!token) throw new Error("GitHub トークンが未設定です");

  currentToken = token;
  getTasksRef = getTasks;
  onRemoteRef = onRemote;
  onStatusRef = onStatus;

  onStatus("sync", "同期接続中…");

  // Gist の決定: 渡されたID → 自動発見 → 自動作成
  if (gistId) {
    currentGistId = gistId;
  } else {
    currentGistId = await findExistingGist(token);
  }

  if (!currentGistId) {
    currentGistId = await createGist(token, getTasks());
    onGistIdChange?.(currentGistId);
    lastRemoteHash = hash(getTasks());
    onStatus("ok", "同期済み（新規Gistを作成）");
  } else {
    onGistIdChange?.(currentGistId);
    // 初回読み込み + マージ
    const remote = await readGist(token, currentGistId);
    if (remote) {
      const merged = mergeTasks(getTasks(), remote.tasks);
      lastRemoteHash = hash(merged);
      onRemote(merged);
      // 統合をリモートに書き戻し
      await writeGist(token, currentGistId, merged);
      onStatus("ok", "同期済み");
    } else {
      // 中身が空の Gist だった場合はローカルを書き込む
      await writeGist(token, currentGistId, getTasks());
      lastRemoteHash = hash(getTasks());
      onStatus("ok", "同期済み");
    }
  }

  active = true;
  window.addEventListener("fuwatto:push", schedulePush);
  startPolling();
}

export function stopSync() {
  active = false;
  if (pollTimer) clearInterval(pollTimer);
  if (pushTimer) clearTimeout(pushTimer);
  pollTimer = null;
  pushTimer = null;
  lastEtag = null;
  lastRemoteHash = "";
  currentToken = null;
  currentGistId = null;
  window.removeEventListener("fuwatto:push", schedulePush);
}

// ---------- 内部 ----------

function schedulePush() {
  if (!active) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const tasks = getTasksRef();
      const h = hash(tasks);
      if (h === lastRemoteHash) return;
      onStatusRef("sync", "同期中…");
      await writeGist(currentToken, currentGistId, tasks);
      lastRemoteHash = h;
      onStatusRef("ok", "同期済み");
    } catch (err) {
      onStatusRef("err", "送信エラー: " + (err.message || err));
    }
  }, 700);
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!active) return;
    try {
      const remote = await readGist(currentToken, currentGistId, lastEtag);
      if (!remote) return; // 304 = 変更なし
      const h = hash(remote.tasks);
      if (h === lastRemoteHash) return; // 自分が書いた変更
      const merged = mergeTasks(getTasksRef(), remote.tasks);
      lastRemoteHash = hash(merged);
      onRemoteRef(merged);
      // マージで自分の変更も含まれた場合は書き戻し
      if (hash(merged) !== h) {
        await writeGist(currentToken, currentGistId, merged);
      }
    } catch (err) {
      console.warn("polling error", err);
    }
  }, POLL_MS);
}

async function findExistingGist(token) {
  const res = await fetch("https://api.github.com/gists?per_page=100", {
    headers: ghHeaders(token),
  });
  if (!res.ok) throw new Error("Gist 一覧の取得に失敗: " + res.status);
  const list = await res.json();
  const found = list.find((g) => g.description === GIST_DESCRIPTION);
  return found?.id || null;
}

async function createGist(token, tasks) {
  const body = {
    description: GIST_DESCRIPTION,
    public: false,
    files: {
      [FILENAME]: { content: JSON.stringify({ tasks, version: 1 }, null, 2) },
    },
  };
  const res = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Gist 作成失敗: " + res.status + " " + text);
  }
  const data = await res.json();
  return data.id;
}

async function readGist(token, id, etag) {
  const headers = ghHeaders(token);
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch("https://api.github.com/gists/" + id, { headers });
  if (res.status === 304) return null;
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("Gist が見つかりません（削除されたか権限不足）");
    }
    throw new Error("Gist 読み込み失敗: " + res.status);
  }
  lastEtag = res.headers.get("ETag");
  const data = await res.json();
  const file = data.files?.[FILENAME];
  if (!file) return { tasks: [] };
  let content = file.content;
  // truncated な場合は raw_url から取得
  if (file.truncated && file.raw_url) {
    const r2 = await fetch(file.raw_url);
    content = await r2.text();
  }
  try {
    const parsed = JSON.parse(content || "{}");
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

async function writeGist(token, id, tasks) {
  const body = {
    files: {
      [FILENAME]: { content: JSON.stringify({ tasks, version: 1 }, null, 2) },
    },
  };
  const res = await fetch("https://api.github.com/gists/" + id, {
    method: "PATCH",
    headers: ghHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Gist 更新失敗: " + res.status + " " + text);
  }
  lastEtag = res.headers.get("ETag");
}

function ghHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
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
