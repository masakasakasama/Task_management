# タスクマネジメント

PCでもスマホでも、同じURLでアクセスして使えるタスク管理アプリです。

## 公開URL（ブックマークしておくのはここ）

GitHub Pages を有効にすると、以下の **常に同じURL** で最新版にアクセスできます。

```
https://<あなたのGitHubユーザー名>.github.io/<リポジトリ名>/
```

例: ユーザー名 `masakasakasama` / リポジトリ名 `task_management` の場合は

> `https://masakasakasama.github.io/task_management/`

このURLは変わりません。PC・スマホのブラウザでブックマーク or ホーム画面に追加してください。

## 初回セットアップ（1回だけ）

1. GitHub のリポジトリページ → **Settings** → **Pages** を開く
2. **Source** を「**GitHub Actions**」に切り替えて保存
3. このブランチが push されると自動で公開されます。Actions の `Deploy to GitHub Pages` が緑になったら準備完了

> 公開URLは Settings → Pages の上部にも表示されます。

## 機能

- **タイトル / 詳細 / 期限 / 優先度（高・中・低）/ ステータス（未着手・進行中・完了）/ タグ** が登録できます
- **自動保存**: 入力するそばからローカルに保存。下書きも消えません
- **自動同期**: Firebase 設定を入れれば PC ⇄ スマホでリアルタイム同期
- **3層バックアップ**:
  1. 直近30世代の自動履歴（ブラウザ内）
  2. 「⬇ バックアップ」ボタンで JSON ダウンロード（Google Drive 等に保存推奨）
  3. 設定で **週次自動 JSON ダウンロード** をオンにできる
- **オフライン対応**: PWA としてホーム画面に追加すれば、電波が弱くても使えます
- **検索 / 並び替え**: 期限・優先度・更新日などで並び替え、検索ボックスはタイトル/詳細/タグを横断
- **ドラッグ&ドロップ**でステータス変更、`N` キーで新規、`/` キーで検索

## 使い方の小ワザ

- カードをクリック → 即編集モーダル
- カードをドラッグ → 「未着手 / 進行中 / 完了」の列にドロップで状態変更
- 編集中の入力は0.6秒ごとに自動保存（明示的な「保存」ボタンを押し忘れても大丈夫）
- スマホは画面に合わせて1列レイアウトに自動切替

## PC・スマホ間のリアルタイム同期（設定不要）

このアプリは **同じURLを開いた全ての端末で自動的に同期** されます。
ログイン・トークン・QR読み取り、いずれも不要です。

仕組み:
- 一意な `SPACE_ID`（24文字以上）を `sync.js` にハードコード
- すべての端末が同じ Firestore ドキュメント (`spaces/<SPACE_ID>`) を読み書き
- Firestore のセキュリティルールで「ID 24文字以上」のみ許可しているため、URLを知らない第三者は到達できません

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

## バックアップ運用（おすすめ）

- 普段は自動保存に任せる
- 設定で **週次自動バックアップをON** にしておく
- ダウンロードされた `fuwatto-backup-*.json` を Google Drive / OneDrive / iCloud など、自分の同期フォルダに保存
- 端末を変えたとき・データを移したいときは「⬆ 復元」から JSON を読み込めば統合されます（id 衝突は更新日時が新しい方を優先）

## ファイル構成

```
index.html              画面
styles.css              可愛いパステルデザイン
app.js                  アプリ本体（保存・編集・履歴・バックアップ）
sync.js                 Firebase Firestore 同期（任意）
manifest.webmanifest    PWA 設定
sw.js                   オフライン対応（Service Worker）
icon.svg                アイコン
.github/workflows/pages.yml  GitHub Pages 自動デプロイ
```

ビルドは不要です。HTML/CSS/JS だけで動きます。
