# タスクマネジメント

PCでもスマホでも、同じURLでアクセスして使えるタスク管理アプリです。

## 公開URL（ブックマークしておくのはここ）

```
https://masakasakasama.github.io/Task_management/
```

PC・スマホのブラウザでブックマーク or ホーム画面に追加してください。

## 機能

- **タイトル / 詳細 / 期限 / 優先度（高・中・低）/ ステータス（未着手・進行中・完了）/ タグ**
- **自動保存**: 入力するそばからローカル & クラウドへ保存
- **全端末リアルタイム同期**: 同じURLを開いた端末すべてで Firestore 経由で自動同期（ログイン・トークン不要）
- **オフライン対応**: PWA としてホーム画面に追加可能、電波が弱くても使える
- **検索 / 並び替え**: 期限・優先度・更新日などで並び替え、検索はタイトル/詳細/タグ横断
- **ドラッグ&ドロップ**でステータス変更、`N` キーで新規、`/` キーで検索

## 同期の仕組み

- 一意な `SPACE_ID`（50文字）を `sync.js` にハードコード
- すべての端末が同じ Firestore ドキュメント (`spaces/<SPACE_ID>`) を読み書き
- Firestore のセキュリティルールで「ID 24文字以上」のみ許可

### Firestore セキュリティルール

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /spaces/{spaceId} {
      allow read, write: if spaceId.size() >= 24;
    }
  }
}
```

## ファイル構成

```
index.html              画面
styles.css              デザイン
app.js                  アプリ本体
sync.js                 Firestore 同期
manifest.webmanifest    PWA 設定
sw.js                   オフライン対応（Service Worker）
icon.svg                アイコン
.github/workflows/pages.yml  GitHub Pages 自動デプロイ
```

ビルドは不要です。HTML/CSS/JS だけで動きます。
