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
- **全端末リアルタイム同期**: Googleログイン（たつや・レベッカの2アカウントのみ）後、全端末で Firestore 経由で自動同期
- **オフライン対応**: PWA としてホーム画面に追加可能、電波が弱くても使える
- **検索 / 並び替え**: 期限・優先度・更新日などで並び替え、検索はタイトル/詳細/タグ横断
- **ドラッグ&ドロップ**でステータス変更、`N` キーで新規、`/` キーで検索

## 同期の仕組み

- 許可された2つの Google アカウントでログインすると同期開始（`coupleauth.js`）
- すべての端末が同じ Firestore ドキュメント (`spaces/<SPACE_ID>`) を読み書き
- アクセス制御は `firestore.rules`（2アカウント以外は読み書き不可）。Firebase Console の Firestore → ルール に貼り付けて公開する
- Firebase Console の Authentication で Google ログインを有効にし、承認済みドメインに `masakasakasama.github.io` を追加する

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
