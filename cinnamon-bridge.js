// cinnamon-workout 連携モジュール
//
// 別アプリ「cinnamon-workout」の Firestore を読み取り、
// 当日にワークアウトが完了していたら、指定の習慣セルを 100% にする。
//
// 使い方:
//   1) 下の cinnamonConfig に cinnamon-workout の Firebase 設定を貼る
//   2) WORKOUT_HABIT_NAME に、Daily Habits 側の対象習慣の名前を記入
//   3) workoutDoneToday() の中身を、cinnamon-workout のデータ構造に合わせて実装
//      （ワークアウト完了を判定するクエリ）
//
// 設定が未入力（apiKey が空）の場合は何もしない。

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getFirestore,
  collection,
  query,
  where,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

// ↓ ここに cinnamon-workout の Firebase 設定を貼る（apiKey 等）
const cinnamonConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

// Daily Habits 側で「ワークアウト」習慣を識別する名前（部分一致）
const WORKOUT_HABIT_NAME_KEYWORDS = ["ワークアウト", "workout", "筋トレ"];

let started = false;

/**
 * @param {(habitNameKeywords: string[], dateKey: string) => void} onWorkoutDone
 *   今日ワークアウト完了が検知されたら呼ぶコールバック
 */
export function startCinnamonBridge(onWorkoutDone) {
  if (started) return;
  if (!cinnamonConfig.apiKey || !cinnamonConfig.projectId) return; // 未設定
  started = true;

  // 既存のFirebaseアプリと衝突しないように別名で初期化
  const existing = getApps().find((a) => a.name === "cinnamon-bridge");
  const app = existing || initializeApp(cinnamonConfig, "cinnamon-bridge");
  const db = getFirestore(app);

  // ↓↓↓ ここから先は cinnamon-workout のデータ構造に合わせて要調整 ↓↓↓
  // 例として「workouts コレクションに、completedAt がドキュメントに入っている」前提で書いてあります。
  // 実際の構造が違う場合（例: spaces/<id>/sessions/<id> など）、ここを書き換えてください。
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    const q = query(
      collection(db, "workouts"),
      where("completedAt", ">=", today.toISOString()),
      where("completedAt", "<", tomorrow.toISOString())
    );
    onSnapshot(
      q,
      (snap) => {
        if (!snap.empty) {
          onWorkoutDone(WORKOUT_HABIT_NAME_KEYWORDS, todayKey);
        }
      },
      (err) => console.warn("[cinnamon-bridge] snapshot err:", err)
    );
  } catch (err) {
    console.warn("[cinnamon-bridge] setup err:", err);
  }
}
