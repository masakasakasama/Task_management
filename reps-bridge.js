// REPS (俺筋トレ, masakasakasama/Fitness) 連携
//
// REPS は Firebase ではなく GitHub に data.json を持つアプリ。
// raw.githubusercontent.com から data.json をポーリングで取得し、
// sessions 配列の日付ごとに「ワークアウト完了 = 100%」として
// Daily Habits の対象セルへ反映する。
//
// データ構造（REPS data.json）:
//   {
//     sessions: [
//       { id, date: "YYYY-MM-DD", exercises: [{ name, sets:[{weight,reps,rpe}] }] },
//       ...
//     ],
//     exercises: [...], weights: [...], profile: {...}, updatedAt: <number>
//   }

const REPS_URL = "https://raw.githubusercontent.com/masakasakasama/Fitness/master/data.json";
const POLL_MS = 60_000; // 1分ごとに最新を確認
const WORKOUT_HABIT_KEYWORDS = ["ワークアウト", "workout", "筋トレ"];

let started = false;
let pollTimer = null;
let lastEtag = null;
let lastBody = null;

/**
 * @param {(nameKeywords: string[], progressByDate: Record<string, number>) => void} onProgress
 * @param {(status: {kind: "ok"|"sync"|"err"|"none", text: string}) => void} [onStatus]
 */
export function startRepsBridge(onProgress, onStatus) {
  if (started) return;
  started = true;

  const setStatus = (kind, text) => onStatus && onStatus({ kind, text });
  setStatus("sync", "REPS接続中…");

  const fetchOnce = async () => {
    try {
      const headers = { Accept: "application/json" };
      if (lastEtag) headers["If-None-Match"] = lastEtag;
      const res = await fetch(REPS_URL, { headers, cache: "no-cache" });
      if (res.status === 304) return; // 変化なし
      if (!res.ok) {
        setStatus("err", `REPS取得失敗: HTTP ${res.status}`);
        return;
      }
      const etag = res.headers.get("ETag");
      if (etag) lastEtag = etag;

      const text = await res.text();
      if (text === lastBody) return; // 同じ内容
      lastBody = text;

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        setStatus("err", "REPS: JSONパース失敗");
        return;
      }

      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      const progressByDate = {};
      for (const s of sessions) {
        if (!s || !s.date) continue;
        const exCount = Array.isArray(s.exercises) ? s.exercises.length : 0;
        if (exCount > 0) {
          // セッションがあれば100% (種目1つでも実施=完了扱い)
          progressByDate[s.date] = 100;
        }
      }
      onProgress(WORKOUT_HABIT_KEYWORDS, progressByDate);
      const dates = Object.keys(progressByDate).sort();
      const last = dates[dates.length - 1];
      if (last) {
        setStatus("ok", `REPS: ${dates.length}日分反映 (最新 ${last.slice(5)})`);
      } else {
        setStatus("ok", "REPS: セッションなし");
      }
    } catch (err) {
      setStatus("err", "REPS取得エラー: " + (err.message || err));
    }
  };

  // 初回 + 定期ポーリング
  fetchOnce();
  pollTimer = setInterval(fetchOnce, POLL_MS);
}

export function stopRepsBridge() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  started = false;
  lastEtag = null;
  lastBody = null;
}
