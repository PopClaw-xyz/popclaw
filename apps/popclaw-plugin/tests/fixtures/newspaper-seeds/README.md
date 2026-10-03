# 历史种子 fixture — 逐字，别手改

这两份 `.md` 是从 git 历史里**逐字**取出的旧版报纸模板（模板字面量求值后的真实字符串），
用来验证 `SHIPPED_SEEDS` 指纹表认得出自家发过的种子（见 `tests/unit/newspaper/newspaper-files.test.ts`）。
改动其中任何一个字节（包括「顺手」补个换行、格式化一下表格）都会让 sha256 变掉、测试变红。

| 文件 | 出处 | sha256 |
|---|---|---|
| `zh-content-86eb70ef.md` | `DEFAULT_CONTENT` @ `86eb70ef`（2026-07-30 切片 E，印章机制上线前——host-c冻住的就是这一版） | `3cba10a8…` |
| `en-content-37bfad65.md` | `DEFAULT_CONTENT_EN` @ `37bfad65`（2026-07-30，英文 codex 首发 v5） | `e5e09636…` |

- `zh-layout-v9.md` — 退休前最后一版 `layout.md` 的种子（TEMPLATE_VERSION v9，commit f0fef7e9）。
  v0.2 把版面搬进代码后 `layout.md` 不再被读，这份留着只为一件事：认出「盘上那份是我们自己种的」，
  从而不去打扰主人（`retiredLayoutRules`）。逐字取自 git，别手改。
