---
name: release-bump
description: 发版版本升级。当用户要求"发版 / bump version / 发布新版本 / 打 tag"时使用。检查自上次 tag 以来的版本变动等级（major/minor/patch）是否合适，用 npm version 命令执行 bump，撰写符合仓库惯例的 commit message 与 tag 注释（含 feat/fix/重构等发版变动摘要）。
---

# Release / Version Bump

本仓库发版流程的规范。目标：版本号、commit message、tag 三者一致且可审查。

## 前提检查

1. 先看最近一次 tag 与 HEAD 之间的提交：
   ```bash
   git tag --sort=-version:refname | Select-Object -First 1   # 上次版本
   git log <last-tag>..HEAD --oneline                           # 本次发版提交清单
   ```
2. 工作区必须干净（`git status`）。
3. 若上次 tag 尚未发布（只打了 tag、未发版），且本次只有非用户可见变更（docs/chore/style/test/依赖 pin），**不需要 bump**——重打 tag 即可（`git tag -f -a` + `git push --force origin <tag>`）。

## 版本等级判定（semver）

按 `git log <last-tag>..HEAD --oneline` 的提交类型分组：

| 出现 | 等级 | 命令 |
|------|------|------|
| `feat:`（新用户功能）| **minor** | `npm version minor -m "..."` |
| 仅 `fix:`/`refactor:`/`chore:`/`docs:`/`test:`/`deps:` 等 | **patch** | `npm version patch -m "..."` |
| 破坏性变更（接口/行为不兼容、移除平台支持等）| **major** | `npm version major -m "..."` |

- 无法归类或不确定时，向用户确认后再执行。
- 上次 bump 是 minor 的，本次修复类变更 → patch；连续多个版本仅修复 → 仍 patch。
- 移除平台/功能支持算 major 或需用户确认（取决于是否公开承诺过支持）。

## 执行 bump

```powershell
$msg = @"
Bump to X.Y.Z: <一句话概括亮点，逗号分隔>

- <用户可见功能 feat>
- <修复 fix>
- <重构/工程变更>
"@
npm version <major|minor|patch> -m $msg
```

- `npm version` 会同时：更新 `package.json`/`package-lock.json`、创建 commit（message 用 `-m`）、创建 annotated tag（前缀 `v`）。
- message 中的 `X.Y.Z` 必须是实际版本号（`-m` 中可用 `%s` 占位，npm 会替换成版本号）。
- 不添加 `preversion`/`postversion` 脚本；本仓库无此脚本，勿自行引入。

## commit message 规范（仿照历史格式）

历史参考（`git log --grep="Bump to"`）：

```
Bump to 1.29.0: rar5 0.3.2 direct modify, RR-aware ratio, slimmer package

- append/delete RAR members without rebuild (rar5 0.3.2 binding)
- encrypted (file/header) archive modify
- recovery-record-aware compression ratio (buffered 1ms walk)
- never package WASI debug wasm; .vscodeignore slimmed to 101 files
```

规则：
- 第一行：`Bump to X.Y.Z: <2-4 个核心亮点，逗号分隔>`。
- 空一行后按功能块列 bullet（本仓库风格是普通 `- `，不是 conventional commits 的 `feat:` 前缀）。
- 每条 bullet 说"什么变了对用户/维护者意味着什么"，附关键实现载体（模块名/版本号/文件名）比纯标题更好。
- 覆盖：feat、fix、重构、依赖升级、文档/CI 变更——即 `git log <last-tag>..HEAD` 的全部内容，按重要性排序。
- 若本次有 tag 重打（`-f`），在 bullet 末尾追加该次补充的变更。

## 验证与推送

1. `npm version` 成功后检查：`git log -1 --format="%B"` 内容完整；`git tag -n1 <vX.Y.Z>` 注释正确。
2. 推送：
   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```
3. 若为**重打 tag**（覆盖旧 tag）：`git tag -f -a vX.Y.Z -m "<message>"` 后 `git push --force origin vX.Y.Z`。
4. 发版前建议跑 `npm run check`（format+lint+typecheck）与 `npm run package:cross` 生成 vsix，确认 CI 打 tag 能产出完整产物。

## 注意事项（本仓库历史教训）

- 用户级 `.npmrc` 中的 `allow-scripts` 会导致 `npm ci` 失败（EALLOWSCRIPTS），与发版无关但与打包流程强相关；若 `package:cross` 报此错，检查 `C:\Users\<user>\.npmrc`。
- CI 的 format check 会失败如果 oxfmt 未过——bump 前先 `npm run format:check`，失败则 `npx oxfmt --write <file>` 并并入 bump commit（可 reset --soft 后 amend）。
- `npm version` 生成的 tag 是 annotated；历史 v1.29.0 是 lightweight——以 annotated 为准，勿纠结。
- 不要提交 node_modules、vendor、.cache、*.vsix 到仓库。
