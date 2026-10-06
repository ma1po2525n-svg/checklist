# Notion クイックメモ

スマホのホーム画面から1タップで開き、すぐ入力 → Notion DB に追加する PWA。

```
スマホ(index.html, PWA) --POST--> Cloudflare Worker --Notion API--> Notion DB
```
トークンは Worker の Secret にだけ置きます(HTML側には入れません)。

## セットアップ

### 1. Notion
1. https://www.notion.so/profile/integrations で内部インテグレーションを作成し、シークレットを控える
2. メモ用DBを開き「…」→ 接続 → 作成したインテグレーションを追加
3. DBのURLから Database ID を控える(`notion.so/<workspace>/<DATABASE_ID>?v=...`)
4. タイトル列の名前を確認(英語UIは `Name`、日本語UIは `名前` など)

### 2. Worker をデプロイ
```sh
cd quick-memo/worker
npx wrangler login
npx wrangler secret put NOTION_TOKEN   # 手順1のシークレット
npx wrangler secret put DATABASE_ID
npx wrangler secret put APP_SECRET     # 自分で決める長いパスコード
npx wrangler deploy                    # 表示された https://…workers.dev をメモ
```
タイトル列が `Name` 以外なら `wrangler.toml` の `[vars]` に `TITLE_PROP = "名前"` を設定。
タグを使うなら複数選択列を作り `TAG_PROP = "Tags"` を設定。

### 3. アプリをホスティング
`quick-memo/` をHTTPSで公開する(GitHub Pages / Cloudflare Pages / Netlify など)。

### 4. スマホに追加
- iPhone: Safari で開く → 共有 → 「ホーム画面に追加」
- Android: Chrome で開く → メニュー → 「ホーム画面に追加」

初回に Worker URL と APP_SECRET を入力(端末内に保存)。

## 使い方
- 1行目 = タイトル、2行目以降 = 本文。タグは任意。
- オフライン時は端末内に溜めて、オンライン復帰/再オープン時に自動送信。
- `index.html?text=...` で起動すると本文が入った状態で開く(ショートカット連携用)。
