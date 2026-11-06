# NOTICE：来源与变更清单

`magpie-agy` 是 Antigravity 桥接插件 `@magpie-community/opencode-antigravity-bridge` 的独立维护分支，
以 MIT 协议继续发布。上游版权声明原样保留在 [LICENSE](LICENSE)，本仓新增部分版权归 gitxm。

注意：npm 包名是 `magpie-agy`，但 Magpie 里的 **provider ID 仍是 `antigravity-bridge`**，
路由组、亲和性与登录态直接沿用，不需要重新登录。

## 1. 来源基线

| 基线 | 版本指纹 | 说明 |
|---|---|---|
| 上游主干 | `DylanLIiii/opencode-antigravity-bridge@7e13b127a62e8eaa41d8de2d3eedd8afe1cfd4eb` | 上游 main 的 HEAD |
| PR #8 基线（代码底稿） | `gitxm/opencode-antigravity-bridge@acb8d84c5136d18889d7d4b91f119117b57abb74` | 分支 `fix/windows-bg-updater-popup`，父提交为上游 `7e13b12`；带 `platform.mjs`、Windows 无弹窗修复、多步用量结算 |
| 本机补丁源（`index.mjs`） | `index.mjs.patched`，md5 `38aa8d42f3e76a2536d11be63b5807a5` | 基于上游 `212179f` 的本机在跑补丁版 |
| 本机补丁源（`usage.mjs`） | `usage.mjs.patched`，md5 `df212a2c934ffd4a38d7f3ef95271c5d` | 基于上游 `7e13b12` 的本机在跑补丁版 |

合并原则：代码以 PR #8（`acb8d84`）为底；本机补丁里 `acb8d84` 没有的修复按下面 A1–A16、U1–U6 逐项并入；
两边都有且 `acb8d84` 写得更新的部分（多步用量结算、`requestedEffort`、`withStateLock`、`lineageVerdict`、
`matchToolResults`、`inspectToolTurn` 等）保留 `acb8d84` 的写法，不搬补丁版。

## 2. `index.mjs` 并入的 16 项修复（A1–A16）

| 编号 | 摘要 |
|---|---|
| A1 | 模型目录缓存：TTL 5 分钟，首次最多等 500ms 否则先返回旧目录，后台单飞刷新，失败时保留上次成功的目录，启动先垫 `FALLBACK_MODELS`；`provider.models()` 不再每次强制跑 `agy models`（修超过 Magpie 2 秒超时的偶发 404） |
| A2 | `listAgyModels` 在报错、超时、退出码非 0 或输出为空时返回 `null`，不再用兜底列表覆盖动态目录 |
| A3 | `execOnce` 一超时立刻 resolve（带 `timedOut`），孙进程占着管道也不会挂住；模型目录后台刷新路径启用计时器 `unref()`，前台调用保持 refed |
| A4 | 给 `gpt-oss-120b` 补一个指向 medium 的裸名别名 |
| A5 | `modelLimits(id)`：`provider.models()` 输出各型号 `limit`（上下文/输出上限），与 `capabilities` 同时保留 |
| A6 | `findAgy` 缓存键包含 `AGY_PATH`、`PATH`/`Path`、`LOCALAPPDATA`、home 目录，环境变了就重新找 |
| A7 | 无进展重复上限：同一无进展回合连续收到对不上号的工具结果，前两次回 409，第 3 次强制回收并重放，重放不了回终止性 400（带 `attempts`、`turn_id`、`x-should-retry: false`）；`recoverStaleTurn` 区分 active/conflict/incomplete/replayed/fallthrough |
| A8 | `jsonError(status, message, code, { extra, headers, noRetry })` 支持 `extra` 并入 error 对象，A7 的 `attempts`/`turn_id` 依赖它 |
| A9 | 工具调用 30ms 合批：相邻事件循环里到达的 MCP 调用并进同一次响应，`Turn.next` 带等待者清理，按 `emittedIds` 去重，文本和结束事件的边界不被合进同批 |
| A10 | `canonicalBody` 沿用上游 `acb8d84` 只提取开头连续 `role=system` 的规则（保证 Claude Code 尾随 `system` 通知不触发第 2 轮重建会话），仅并入 `contentText`、`requestLayout` 与 `noteLayout` 布局追踪 |
| A11 | 诊断事件限流（60s 窗口最多 30 条，带 `suppressed` 计数），请求级 `req_id`，冲突事件输出 `idle_ms`/`pending`，过期判定原因细分为 finalized/dead/done/running，`layout_flip` 仅在 `AGY_BRIDGE_EVENTS=verbose` 时输出 |
| A12 | `Turn.rawAcpUsages`：每个已记账 prompt 原样保存 ACP 返回的 usage 对象 |
| A13 | `addUsage` 用 `tokenCount` 把累加结果限制为非负整数 |
| A14 | `reclaimStaleTurn` 同时清掉该会话的无进展重复计数 |
| A15 | 防 503 进程池饿死：默认并发上限改为 8（`AGY_BRIDGE_MAX_PROCS`，`magpie.maxConcurrency` 同为 8）；`evictLRU` 两级淘汰，第二级淘汰客户端已断开且超过 30s（`AGY_BRIDGE_DETACHED_EVICT_MS`）的挂起工具回合，后续补交合法 `tool_result` 会在新进程上重放；`acquireProcLocked` 命中同会话旧回合时先判过期并回收；历史压缩后变短的普通新请求判 `fork` 回收旧回合，不再报 `this conversation still has an unfinished response` |
| A16 | 长历史重放预算：`renderInitialPromptParts` 默认限制在 112 KiB（`AGY_BRIDGE_MAX_PROMPT_BYTES`）内，先为必保段（system 说明、`</conversation_history>` 闭合标签及禁止输出 `[tool call ...]` 声明、完整 `<current_turn>`）预留预算，历史按头尾保留、超长 `[tool result]` 首尾保留中间省略，保证不被 agy 的 128 KiB 尾部截断切掉 |

## 3. `usage.mjs` 并入的 6 项修复（U1–U6）

| 编号 | 摘要 |
|---|---|
| U1 | 去掉 win32 直接抛错 `agy bridge usage queries currently require macOS or Linux.` 的限制，并接入 `agySpawnSpec` 兼容 `.cmd`/`.bat`，Windows 上 `magpie quota` 可用 |
| U2 | `spawn` 仅在非 Windows 上 `detached`，Windows 上一律 `windowsHide: true` |
| U3 | Windows 进程树清理：先执行 `taskkill /T /F /PID` 清进程树、仅在 `taskkill` 失败或超时兜底时补 `SIGKILL`（避免提前杀父 PID 导致 `taskkill` 漏杀子树）；父进程正常退出后延迟 30ms 清进程树；`finish()` 仅在出错或子进程仍在运行时清理 |
| U4 | Windows 上拦截浏览器：写入 `open.cmd`（内容 `@exit /b 1`），`BROWSER` 指向它 |
| U5 | PATH 大小写去重：删除非大写的 `Path` 键，继承 `env.PATH`，没有时回落到 `env.Path` |
| U6 | 临时目录删除失败（`EBUSY`/`EPERM`/`ENOTEMPTY`）时先等待在途 `taskkill` 释放目录句柄，再最多重试 4 次、每次递增 50ms |

## 4. 包与文档层改动

- 包名 `magpie-agy`，版本 `0.2.0`，`repository`/`homepage` 指向 `https://github.com/gitxm/magpie-agy`。
- `package.json` 的 `magpie.maxConcurrency` 升为 8，`scripts.test` 加入新增的目录、用量结算、重复/合批测试。
- `README.md`、`README.en.md`、`HANDOFF.md` 更新包名、安装命令（`magpie plugin add github:gitxm/magpie-agy`）、进程池与平台说明。
- 本文件与 `LICENSE`（保留上游版权行并追加 `Copyright (c) 2026 gitxm`）一并随包发布。
