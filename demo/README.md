# 動作説明動画

ローカル配信したこのアプリを実際にブラウザで操作した画面収録に、日本語キャプションと
疑似カーソルを重ねた動画（1280×800 / H.264 / 約3分20秒）を作るための一式。

完成品の `shihoshike-demo.mp4` と、README に貼る抜粋 `demo.gif` はここに置く。
収録の生データ（`raw/`）と中間ファイル（`out/`）は `.gitignore` で除外する。
このディレクトリは `_config.yml` の `exclude` で GitHub Pages の配信対象から
外してあるので、公開ページからは配信されない。

## 収録内容

| #   | 章                 | 内容                                                  |
| --- | ------------------ | ----------------------------------------------------- |
| 1   | トップ画面         | アプリの位置づけ、更新情報の自動更新                  |
| 2   | 使い方・FAQ        | ヘルプダイアログ                                      |
| 3   | 年度・科目・種類   | 3つのプルダウン／セグメント（科目の系統色分けを含む） |
| 4   | テキストに変換     | 出力形式（ノーマル／Scrapbox記法）と変換の流れ        |
| 5   | そのまま保存       | 個別 / 一式 / LLM の3形式と説明文                     |
| 6   | 予備試験           | 試験の切替で年度・科目・種類が入れ替わること          |
| 7   | 全文検索           | 憲法×「表現の自由」で検索 → カードから選択欄へ反映    |
| 8   | 短答ダウンローダー | 姉妹ページ（`tantou.html`）の紹介                     |

「変換実行」「保存実行」の実行結果は収録していない。収録環境から
`moj.go.jp` および中継 Worker へ到達できないため。ネットワークが通る環境で
収録し直せば、そのまま実行部分も追加できる（下記スクリプトのシーン4・5に
クリックと待機を足すだけ）。

## 収録スクリプト

- `record.mjs` … Playwright でシーンを順に実行し、webm を書き出す
- `overlay.js` … キャプション・疑似カーソル・タイトルカードのオーバーレイ。
  `addInitScript` で注入するだけで、アプリ本体のコードには一切触れない

### 手順

```sh
# 1. 静的配信（リポジトリのルートで）
python3 -m http.server 8099 --bind 127.0.0.1

# 2. 収録（別シェル）
npm i -D playwright @fontsource/noto-sans-jp @fontsource/zen-kaku-gothic-new
node demo/record.mjs          # demo/raw/*.webm が出力される

# 3. mp4 へ変換
ffmpeg -i demo/raw/*.webm -vf "fps=25" -c:v libx264 -preset veryslow \
  -tune stillimage -crf 25 -pix_fmt yuv420p -movflags +faststart \
  demo/shihoshike-demo.mp4

# 4. README 用の抜粋 GIF（全文検索のくだり 25秒）
ffmpeg -ss 144 -t 25 -i demo/shihoshike-demo.mp4 \
  -vf "fps=8,scale=800:-2:flags=lanczos,split[x][y];[x]palettegen=max_colors=96:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 demo/demo.gif
```

Google Fonts へ到達できない環境向けに、`record.mjs` は
`fonts.googleapis.com` / `fonts.gstatic.com` へのリクエストを
`@fontsource` の同一書体（npm 由来）で差し替える。到達できる環境なら
この差し替えは外してよい。
