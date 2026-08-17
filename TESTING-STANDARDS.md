# Testing Standards — Smart Archiver

本文件是 test/ 套件的标准。标准从本项目利益出发设计：**测试必须能暴露生产缺陷，覆盖必须可验证**。每条标准都配有自动化检查，不是口头约定。

词汇约定：架构术语（module / interface / depth / seam / adapter / leverage / locality）遵循 codebase-design；领域术语见 `CONTEXT.md`。

---

## 标准 1 — 测试导入生产实现，测试侧只允许 oracle

**原则**：一个行为只有一个实现（locality）。测试套件里出现生产逻辑的副本，等于让生产可以坏掉而测试照样绿（镜像已漂移过的实例：`sanitizeCliPath` 缺 `@` 前缀、`fixArchiveEncoding` 是 stub、`buildTree` 缺 `hasMore`）。

- 断言一律 `import` 生产模块（src/ 下的核心层全部 vscode-free，无需 mock）。
- 唯一允许的测试侧实现是 **oracle**：用 raw 7zz WASM CLI 构造归档字节（`test/helpers.ts`）。oracle 必须独立于生产的编解码逻辑，否则 round-trip 是自证循环。
- 新增测试文件不得复制生产函数；发现复制即删除并改为 import。

**检查**：人工评审 + 下述标准 5 的 seam manifest（覆盖关系的漂移由 guard 元测试捕捉）。

## 标准 2 — 环境分层必须走 `test/gates.ts`

**原则**：环境决策集中一处（locality），可移植（无机器路径），CI 可见（无静默跳过）。

- 系统 7z、bundled 7zz、rar5 binding、rar5 CLI、rar5 WASM、系统 zstd、snappy WASM、out 构建产物 —— 一律通过 `gate("<tier>")` 探测，用 `itIf("<tier>", ...)` 门控。
- 禁止自定义 `itOrSkip` / `fs.existsSync(机器路径)` / `os.homedir()/桌面/...`。机器路径只允许作为 env 覆盖（`SA_RAR_CLI` / `SA_UNRAR_CLI` / `SA_RAR5_DEV_PROJECT`）的兜底。
- 每次运行的跳过情况写入 `test-results/gates.json`，teardown 打印 GATE REPORT；CI 应把"某 tier 被检查但 0 可用"视为告警。

**检查**：`grep -rn "itOrSkip\|os.homedir" test/` 只允许命中以下已登记的 env 兜底（`SA_RAR_CLI` / `SA_UNRAR_CLI` / `SA_RAR5_DEV_PROJECT` / `SA_OFFICIAL_UNRAR`）：`test/gates.ts` 的 `rar5CliPaths()`、`test/install-rar5-platforms.test.ts`、`test/rar5-wasm.test.ts`；其余命中即违规。gates.json 人工/CI 巡检。

## 标准 3 — 断言必须验证可观察结果

**原则**：每次变更操作之后必须有可观察的结果断言。`exit === 0`、`size > 0`、`expect(true).toBe(true)`、`>= 1` 这类断言在深模块上等于没测。

- 归档内容验证走 `test/verify.ts`：`verifyArchiveContents(buf, expected)`（WASM oracle 提取 + 逐条目内容相等）、`verifyArchiveWith7zz(filePath, expected)`（RAR5 等走 bundled 7zz，调用方负责 gate）。
- 失败路径也要断言行为（如加密归档无密码必须拒绝），不能只断言"不抛错"。
- 已有反例（已修复）：worker 协议 round-trip 只查 `size > 0`；rar5 只查魔数；tar LongLink 只查 `statSync().size > 1024`。

**检查**：`grep -rn "expect(true)\|toBeGreaterThan(0)" test/` 人工评审；新测试评审时以 verify.ts 为默认工具。

## 标准 4 — vscode 只通过测试替身的接口访问

**原则**：替身是 vscode seam 的深 adapter——接口收窄到测试真正跨越的访问器（键控配置、对话框记录、可脚本化控件），实现吸收其余行为。

- 配置读取用 `__setConfig(section, key, value)`；对话框用 `__dialogs()` 断言；向导用 `__quickPicks()` / `__inputBoxes()` 驱动（`accept()`）。
- 禁止在测试里运行时改写 `vscode.window.xxx = ...`（已消灭的旧模式）。
- `setupRunner.ts` 在每个测试前调用 `__resetVscodeMock()` —— 测试之间零状态泄漏，是未来开启 `fileParallelism` 的前提。

**检查**：`grep -rn "vscode.window as any\|(vscode as any)" test/` 应为空；mock 的新增表面必须同时补 `__resetVscodeMock` 重置。

## 标准 5 — 每个生产模块必须登记在 seam manifest 中

**原则**："全面覆盖"必须机器可检查，而不是人肉审计结论。

- `test/seam-manifest.ts`：`SEAM_COVERED`（模块 → 导入它的测试文件）+ `SEAM_GAPS`（模块 → 缺口理由）。
- `test/seam-coverage.test.ts` 守卫：新 src 模块未登记 → 失败；登记的测试文件不再导入该模块（漂移）→ 失败；gap 理由缺失或 gap 过期 → 失败。
- 新增测试让某 gap 模块被覆盖时，把模块从 `SEAM_GAPS` 移到 `SEAM_COVERED`（guard 会强制）。

**检查**：guard 元测试随 `npm test` 自动运行。

## 标准 6 — 临时目录只经 `test/tmp.ts` 创建

**原则**：创建与清理同模块（locality），清理无需维护前缀清单（旧清单已漂移漏扫）。

- 一律 `tmpDir("<前缀>")`；注册表写入 `test-results/tmp-dirs.json`；globalSetup teardown 全量清扫（跨进程、含崩溃残留）。
- 禁止 `fs.mkdtempSync`（`grep` 可查）。

**检查**：`grep -rn "mkdtempSync" test/` 应为空。

---

## 现状（2026-08-17 更新；首次落地为 2026-08-07：42 文件 / 565 通过 / 2 跳过）

- 71 个测试文件 / 794 通过 / 21 跳过（GATE REPORT：system7z 3/3、bundled7zz 9/9、rar5Binding 8/8、rar5Wasm 2/2、snappyWasm 2/2 可用；systemZstd、rar5Cli、outBuild 在 CI/本机不可用会告警）；lint + src typecheck 干净。
- `npm run check` 不含 `tsc -p test/tsconfig.json`（test 侧类型检查在 HEAD 上有 98 个既有错误，多于 2026-08-07 时的 48 个，多为隐式 any 与 mock 类型缺位）——建议作为后续补齐项纳入 check。
- 已知剩余缺口（seam manifest 的 SEAM_GAPS 有完整清单，主要集中 webview 自定义编辑器层与若干 utils）。
