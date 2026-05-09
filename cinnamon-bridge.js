// cinnamon-workout 連携
//
// cinnamon-workout の Firestore (couples/<COUPLE_ID>) を購読し、
// 今日の達成率を計算して Daily Habits の対象セルへ反映する。
//
// データ構造（cinnamon-workout 側）:
//   couples/<COUPLE_ID>: {
//     targets: { squat: 10, plank: 15, ... },        // 1日の目標
//     byDay: {
//       "YYYY-MM-DD": {
//         squat: 5, situp: 20, plank: 20, ...        // その日の実績
//       }
//     }
//   }
//
// 達成率 = （目標達成した種目数 / 目標が設定されている種目数）
// → 0/20/40/60/80/100 に丸めて Daily Habits セルへ反映
// 手動で上回る値が入っている場合はダウングレードしない。

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getFirestore,
  doc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const cinnamonConfig = {
  apiKey: "AIzaSyBHXH8S-IUSUpTZ102XF4M6my3Lr4FDD_0",
  authDomain: "cinnamon-workout.firebaseapp.com",
  projectId: "cinnamon-workout",
  storageBucket: "cinnamon-workout.firebasestorage.app",
  messagingSenderId: "587980763699",
  appId: "1:587980763699:web:ca9f711928b463a9d8a946",
};

const COUPLE_ID = "masakasakasama-cinnamoroll-couple-2026";

// Daily Habits 側で対象とする習慣の名前キーワード（部分一致・大文字小文字無視）
const WORKOUT_HABIT_KEYWORDS = ["ワークアウト", "workout", "筋トレ"];

let started = false;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function calcProgress(byDayToday, targets) {
  if (!byDayToday || !targets) return 0;
  let met = 0;
  let total = 0;
  for (const type of Object.keys(targets)) {
    const target = Number(targets[type]) || 0;
    if (target <= 0) continue;
    total++;
    const actual = Number(byDayToday[type]) || 0;
    if (actual >= target) met++;
  }
  if (total === 0) return 0;
  // 0/20/40/60/80/100 の6段階に丸める
  return Math.round((met / total) * 5) * 20;
}

/**
 * @param {(nameKeywords: string[], progressByDate: Record<string, number>) => void} onProgress
 * @param {(status: {kind: "ok"|"sync"|"err"|"none", text: string}) => void} [onStatus]
 */
export function startCinnamonBridge(onProgress, onStatus) {
  const setStatus = (kind, text) => onStatus && onStatus({ kind, text });
  if (started) return;
  if (!cinnamonConfig.apiKey || !cinnamonConfig.projectId) {
    setStatus("none", "シナモン未設定");
    return;
  }
  started = true;
  setStatus("sync", "シナモン接続中…");
  console.log("[cinnamon-bridge] starting...");

  try {
    const app =
      getApps().find((a) => a.name === "cinnamon-bridge") ||
      initializeApp(cinnamonConfig, "cinnamon-bridge");
    const db = getFirestore(app);
    const docRef = doc(db, "couples", COUPLE_ID);

    onSnapshot(
      docRef,
      (snap) => {
        if (!snap.exists()) {
          setStatus("err", "シナモン: ドキュメント無し");
          console.warn("[cinnamon-bridge] doc not found");
          return;
        }
        const data = snap.data();
        const targets = data.targets;
        const byDay = data.byDay || {};
        const progressByDate = {};
        for (const dateKey of Object.keys(byDay)) {
          progressByDate[dateKey] = calcProgress(byDay[dateKey], targets);
        }
        const dates = Object.keys(progressByDate).sort();
        console.log("[cinnamon-bridge] received progress:", progressByDate);
        onProgress(WORKOUT_HABIT_KEYWORDS, progressByDate);
        const last = dates[dates.length - 1];
        if (last) {
          setStatus("ok", `シナモン: ${dates.length}日分反映 (最新 ${last.slice(5)} ${progressByDate[last]}%)`);
        } else {
          setStatus("ok", "シナモン: データなし");
        }
      },
      (err) => {
        console.warn("[cinnamon-bridge] snapshot err:", err);
        setStatus("err", "シナモン: " + (err.code || err.message || "エラー"));
      }
    );
  } catch (err) {
    console.warn("[cinnamon-bridge] setup err:", err);
    setStatus("err", "シナモン: 初期化失敗 " + (err.message || err));
  }
}
