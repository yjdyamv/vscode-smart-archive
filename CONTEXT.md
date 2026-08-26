# Context — Smart Archiver 领域词汇表

项目的领域语言与架构语言。架构术语由 codebase-design 定义，这里只记录领域与测试套件专用名词；评审、测试、新代码应使用这些词，不另造同义词。

## 领域术语

- **归档 (archive)** — 被本扩展压缩/解压的任何文件（7z、zip、tar、wim、rar5 及包装格式）。
- **格式 (format)** — 归档格式元数据条目（`FORMAT_TABLE`：label、exts、canCreate、supportsEncryption、category）；`.tar.gz`、`.tar.zst` 等复合扩展是独立格式。
- **包装格式 (wrapped format)** — 先 tar 打包再压缩的格式（tar.gz、tar.zst、tar.lz4、tar.br、tar.sz）。
- **分卷 (split volume)** — `.7z.001` 与 `.r00` 系列（解析见 `getSplitVolumeBase`）。
- **恢复记录 (recovery record)** — RAR5 内联 rr% 与分卷恢复卷两种机制，wizard 按是否分卷二选一。
- **引擎 (engine)** — 压缩/解压后端：system7z（child process）、worker（WASM 7zz core）、rar5（native/WASI binding）、rarRebuild；`selectEngine` 是唯一选型决策点。
- **op** — worker 协议操作名（compress/decompress/list/isEncrypted/unwrap/extract/modify…）；`dispatchOp` 是 op → core 唯一映射。
- **core** — vscode-free 执行层（`*-core.ts`、codecs、js7z-factory）；host 分发器与 worker 都经 `dispatchOp` 进入。
- **runner** — host 侧执行通道：`InProcessRunner`（测试用）与 `WorkerThreadRunner`（真实线程）；`setArchiveRunner` 是注入 seam。
- **Tier**（测试套件）— 环境分层（system7z / bundled7zz / rar5Binding / rar5Cli / rar5Wasm / systemZstd / snappyWasm / outBuild），见 `test/gates.ts`。
- **Oracle**（测试套件）— 测试侧唯一允许的实现：raw 7zz WASM CLI 构造/校验归档字节，独立于生产编解码。
- **Seam manifest**（测试套件）— 生产模块 ↔ 测试文件登记表（`test/seam-manifest.ts`），guard 元测试强制一致。
- **目录树缓存 (listing cache)** — 包装格式归档的扁平条目列表磁盘缓存（`listingCache.ts`）：按归档路径哈希键控，stat 快检 + sha256 回退；内容校验是唯一真源，修改无需主动失效。

## 架构语言（codebase-design 词表）

- **module** — 有 interface 与 implementation 的任何东西；深模块：js7z-factory（单导出）、system7z（20 导出守 1993 行）、modify-core、runner；浅模块：select-engine、engine-config、dispatch。
- **seam** — 可注入行为的位置；真实 seam：`runArchiveOp`/`ArchiveRunner`、`WorkerPort`、`dispatchOp`、`setArchiveRunner`、vscode 替身。
- **adapter** — 满足 seam 接口的具体物；vscode 测试替身是"一个 seam、两个 adapter"正例。
- **locality / leverage** — 深模块的维护/调用收益；镜像层曾破坏 locality，标准 1 禁止。
