# Testing Standards — Smart Archiver

`test/` 套件的标准。每条标准都配有自动化检查，不是口头约定。架构术语遵循 codebase-design；领域术语见 `CONTEXT.md`。

## 标准 1 — 测试只 import 生产实现，测试侧只允许 oracle

一个行为只有一个实现（locality）。测试里复制生产逻辑 = 生产坏掉而测试照样绿（已漂移实例：`sanitizeCliPath` 缺 `@`、`fixArchiveEncoding` 是 stub、`buildTree` 缺 `hasMore`）。

- 断言一律 import src/ 生产模块（core 层全部 vscode-free，无需 mock）。
- 唯一测试侧实现是 **oracle**：raw 7zz WASM CLI 构造/校验归档字节（`test/helpers.ts`），独立于生产编解码逻辑。
- 发现复制即删除并改为 import。

**检查**：人工评审 + 标准 5 的 seam manifest。

## 标准 2 — 环境分层必须走 `test/gates.ts`

环境决策集中一处、可移植、CI 可见（无静默跳过）。

- 系统 7z / bundled 7zz / rar5 binding / rar5 CLI / rar5 WASM / 系统 zstd / snappy WASM / out 构建一律 `gate("<tier>")` + `itIf` 门控。
- 禁止自定义 `itOrSkip` / `fs.existsSync(机器路径)` / `os.homedir()`；机器路径仅允许 env 覆盖兜底（`SA_RAR_CLI` / `SA_UNRAR_CLI` / `SA_RAR5_DEV_PROJECT`）。
- 跳过情况写入 `test-results/gates.json`，teardown 打印 GATE REPORT；CI 中"tier 被检查但 0 可用"视为告警。

**检查**：`grep -rn "itOrSkip\|os.homedir" test/` 仅允许 `test/gates.ts` 的 `rar5CliPaths()` 等已登记兜底。

## 标准 3 — 断言必须验证可观察结果

`exit === 0`、`size > 0`、`expect(true).toBe(true)` 在深模块上等于没测。

- 内容验证走 `test/verify.ts`：`verifyArchiveContents(buf, expected)` / `verifyArchiveWith7zz(filePath, expected)`。
- 失败路径也要断言行为（如加密归档无密码必须拒绝），不能只断言"不抛错"。

**检查**：`grep -rn "expect(true)\|toBeGreaterThan(0)" test/` 人工评审。

## 标准 4 — vscode 只通过测试替身的接口访问

替身是 vscode seam 的深 adapter——接口收窄到测试真正跨越的访问器。

- `__setConfig(section, key, value)` 配置；`__dialogs()` / `__quickPicks()` / `__inputBoxes()` 驱动对话框。
- 禁止运行时改写 `vscode.window.xxx`；`setupRunner.ts` 每测试前 `__resetVscodeMock()`（零状态泄漏，是 `fileParallelism` 的前提）。

**检查**：`grep -rn "vscode.window as any\|(vscode as any)" test/` 应为空。

## 标准 5 — 每个生产模块必须登记在 seam manifest

"全面覆盖"必须机器可检查。

- `test/seam-manifest.ts`：`SEAM_COVERED`（模块 → 测试文件）+ `SEAM_GAPS`（模块 → 缺口理由）。
- `test/seam-coverage.test.ts` 守卫：新模块未登记、登记漂移、gap 理由缺失/过期 → 失败。

**检查**：guard 元测试随 `npm test` 自动运行。

## 标准 6 — 临时目录只经 `test/tmp.ts` 创建

创建与清理同模块；注册表写入 `test-results/tmp-dirs.json`，teardown 全量清扫（跨进程、含崩溃残留）。禁止 `fs.mkdtempSync`。

**检查**：`grep -rn "mkdtempSync" test/` 应为空。

---

## 现状（2026-08-17）

- 71 测试文件 / 794 通过 / 21 跳过（GATE REPORT：system7z 3/3、bundled7zz 9/9、rar5Binding 8/8、rar5Wasm 2/2、snappyWasm 2/2；systemZstd / rar5Cli / outBuild 本机不可用会告警）；lint + src typecheck 干净。
- `npm run check` 不含 test 侧 `tsc`（HEAD 有 98 个既有类型错误）——建议后续纳入。
- 已知缺口见 seam manifest 的 `SEAM_GAPS`（主要集中 webview 自定义编辑器层与若干 utils）。
