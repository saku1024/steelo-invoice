# Test Fixtures

## NotoSansJP-Regular.ttf (Phase 3 F10 PDF bench 用)

`pdf-generator.bench.ts` で日本語 PDF 生成の速度を測るのに必要。
このディレクトリには **コミットしない** (5MB ある、CI で動的取得する)。

### 取得方法

```sh
curl -L -o apps/worker/tests/fixtures/NotoSansJP-Regular.ttf \
  https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/Japanese/NotoSansJP-Regular.otf
```

または Google Fonts CDN から:

```sh
curl -L -o apps/worker/tests/fixtures/NotoSansJP-Regular.ttf \
  "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400&display=swap"
# ...(実際は CSS から TTF URL を抽出する手順が必要)
```

bench は fixture が無ければ自動 skip される (`describe.skipIf`)。

### 本番環境

R2 bucket `STEELO_FILES` の `fonts/NotoSansJP-Regular.ttf` キーに置く
(deployment.md 参照)。
