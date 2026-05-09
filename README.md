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

## PC・スマホ間のリアルタイム同期（GitHub トークンだけでOK）

GitHub のアカウントを既にお持ちなので、追加サービスへのサインアップは不要です。
個人用アクセストークンを1つ作って貼るだけで、PC・スマホ・タブレットすべて同期されます。

1. https://github.com/settings/tokens?type=beta を開く（**Fine-grained tokens**）
2. **Generate new token**
   - Token name: 何でもOK（例: `fuwatto-task`）
   - Expiration: 任意（推奨: 90日 〜 1年）
   - Resource owner: 自分のアカウント
   - Repository access: **Public Repositories (read-only)** で十分（このトークンはリポジトリ操作には使いません）
   - **Account permissions** → **Gists** を **Read and write** に設定（ここだけ重要）
3. 生成された `github_pat_…` をコピー
4. アプリ右上の ⚙ ボタン → **GitHub Personal Access Token** に貼り付けて「保存して反映」
5. 初回は自動で **非公開 Gist** が作成されます。これがクラウド側の保管庫になります
6. 他の端末を追加するときは、トークンを再入力する必要はありません。⚙ → **「📱 別の端末を繋ぐ」** で QRコードが表示されるので、新しい端末のカメラでそれを読み取って表示されたリンクを開くだけで、自動で同期が始まります。
   - QRが使えない端末でも、表示される「リンクをコピー」を押して送れば、そのURLを開くだけで設定完了
   - リンクには同期トークンが入っているので、SNS等への投稿は避けてください

仕組み: タスク一覧を private gist の `tasks.json` に保存しています。Gist は GitHub アカウントだけが閲覧でき、個人用なので外部に漏れません。トークンはこの端末のブラウザ（localStorage）にだけ保存されます。約12秒間隔のポーリング + 変更時即時 PATCH でほぼリアルタイムに同期します。

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
