# 司法試験論文式 → Scrapbox 変換（ブラウザ版）

Mac / iPhone / iPad / Windows の任意のブラウザから動かせる静的 Web アプリ版です。

## 構成

```
web/
├── index.html       UI 本体
├── style.css        スタイル
├── app.js           変換ロジック（PDF.js を使用）
├── worker/
│   └── worker.js    Cloudflare Worker（moj.go.jp 中継プロキシ）
└── README.md        このファイル
```

- **フロント**: 静的 HTML/CSS/JS。GitHub Pages 等にそのまま置けます
- **バックエンド**: なし。法務省サイトの取得だけ Cloudflare Worker が肩代わり
- **PDF パース**: ブラウザ内で PDF.js が処理（CDN から自動ロード）

## セットアップ（所要 15 分）

### ① Cloudflare Worker をデプロイ（5 分）

1. <https://dash.cloudflare.com/> にアクセス（無料アカウント作成）
2. 左メニュー **Workers & Pages** → **Create application** → **Create Worker**
3. 名前を決める（例: `moj-proxy`）→ **Deploy**
4. デプロイ後、画面右上 **Edit code** をクリック
5. 表示されたエディタの中身を全部消し、`worker/worker.js` の中身を貼り付け
6. **Deploy** を押す
7. 画面上部に表示される URL（例: `https://moj-proxy.あなたの名前.workers.dev`）を控える

無料枠は 1 日 10 万リクエストまでなので、個人利用なら使い切れません。

### ② app.js に Worker の URL を設定（1 分）

`web/app.js` 冒頭の `WORKER_URL` を控えた URL に書き換えます。

```js
const WORKER_URL = "https://moj-proxy.あなたの名前.workers.dev";
```

### ③ GitHub にプッシュ（5 分）

```bash
cd web
git init
git add .
git commit -m "Initial commit"
gh repo create barexam-scrapbox-web --public --source=. --push
```

`gh` が無ければ、GitHub のサイトでリポジトリを作って手動 push。

### ④ GitHub Pages を有効化（3 分）

1. リポジトリの **Settings** → **Pages**
2. **Source** で **Deploy from a branch** を選択
3. **Branch** で `main` / `(root)` を選び **Save**
4. 1〜2 分待つと `https://あなたのユーザー名.github.io/barexam-scrapbox-web/` で公開

## 使い方

公開された URL を開けば、

- 年度・科目・種類を選ぶ
- **変換実行** をクリック
- 結果がそのまま画面に出る／**結果をコピー**／**.txt 保存**

iPhone Safari でも同じ操作で動作します。

## ローカルでテストする

Worker を URL に設定した後、`web/` ディレクトリで簡易サーバを立ち上げて確認できます。

```bash
cd web
python3 -m http.server 8000
# ブラウザで http://localhost:8000/ を開く
```

> `file://` で開くと ES Modules や fetch がブロックされるため、必ずローカルサーバ越しに開いてください。

## トラブルシュート

| 症状 | 対処 |
|---|---|
| `Cloudflare Worker の URL が未設定です` と出る | `app.js` の `WORKER_URL` を編集 |
| `HTTP 403` で取得失敗 | Worker の `ALLOWED_PREFIX` が `https://www.moj.go.jp/` のままか確認 |
| `Failed to load module` | GitHub Pages では同一オリジン配信なので、URL のパスがあっているか確認 |
| `Failed to fetch` | Worker URL の打ち間違い、または Worker のデプロイが完了していない |
| PDF パースが失敗 | 法務省側のレイアウトが想定外。元の Python 版で対応した上で `app.js` の `parseParagraphs` を同期更新 |

## ライセンス・出典

- 取得対象は法務省ウェブサイト公表の論文式試験問題・出題の趣旨・採点実感
- 変換ロジックは元 Python 版（`../bar_exam_to_scrapbox.py`）と同等
