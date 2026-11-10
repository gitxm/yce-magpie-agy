# yce-magpie-agy

把本机的 Antigravity CLI（`agy`）接成 Magpie 里的一个模型 provider。装好以后，
OpenCode、Claude Code 等客户端经由 Magpie 调用你订阅里的 Gemini、Claude 和
GPT-OSS 模型，请求实际由 `agy` 进程完成。

**[English → README.en.md](README.en.md)** ｜ 来源、版权与迁移说明见 [NOTICE.md](NOTICE.md)

## 这是什么

插件以 Magpie provider 的形式运行。客户端发来 Anthropic Messages 格式的请求，插件把它
翻译成 ACP（Agent Client Protocol）消息，交给本机的 `agy acp` 进程处理，再把输出翻译回
流式响应。

- 底层是真正的 agy CLI，走它自带的 ACP 通道。插件不伪造 IDE 身份，也不直接请求 Google
  的内部接口。
- 客户端自己的工具（读写文件、执行命令等）通过 MCP 暴露给模型。工具由客户端执行，结果
  回传到同一轮 agy 对话里，模型看到的是原生工具调用。
- 账号风险不由插件决定。Google 的使用政策变化时，插件无法替你保证账号不受限制。

## 功能

- **订阅内的模型都能用**：Gemini、Claude、GPT-OSS 等模型在会话中切换，历史保留；思考
  等级也可以在会话中切换。
- **流式输出与思考摘要**：思考摘要以 `thinking` 块返回，新版 Magpie 在 Providers 页关闭，旧宿主用 `AGY_BRIDGE_THINKING=0` 关闭。
- **图片输入**：支持内联 base64 的 PNG、JPEG、GIF、WebP。需要 agy 1.5.0 或更新版本，
  因为图片能力要由 ACP 服务端声明。
- **工具调用**：支持并行和连续调用。运行超过 150 秒的工具会先收到 "still running" 的
  占位响应，真正的结果送达后继续同一轮对话，每个调用只在客户端执行一次。
- **会话续接**：每轮结束后记录会话。重启 Magpie 或插件后，只要历史和指令的哈希一致，
  就用 `session/resume` 接上上下文。状态文件只存会话 ID 与哈希，不存消息原文。
- **隔离运行**：不读取你的全局 MCP 配置。每个 agy 进程使用临时 agent。agy 发起的权限
  请求（shell、写文件、浏览器等）一律拒绝，真正的操作都在客户端侧完成。
- **Magpie 内直接登录 Google 账号**：在 Magpie 的 Providers 页点击 `Sign in with Google`，
  本机已登录时直接通过；未登录时由 `agy acp --login` 给出 Google 授权链接并在页面内回填授权码，
  在服务器或 Docker 里跑 Magpie 也无需远程桌面（对齐官方 agy-cli 0.1.1）。
- **额度查看**：在 Magpie 里查看 agy 订阅的用量窗口，仅作展示，额度耗尽时不会自动拦截请求。
- **Claude Code 子代理可用**：Antigravity 对 Claude Agent SDK 身份的系统提示词（Claude Code
  子代理、`claude -p`、Claude Desktop）回假 429，插件默认在发给 agy 的系统级文本里绕开，
  见下文「Claude Code 子代理与假 429」。
- **助手预填**：以纯文本 assistant 消息结尾的请求（SillyTavern 预填、「继续写」、bot 框架）
  不再 400 拒绝，预填留在本轮并渲染为续写提示，会话跨轮保持对齐（移植自官方
  agy-cli 0.1.3）。
- **多账号自动切号**：当前 agy 账号额度用尽时，插件自动停掉自有 agy 进程，把本机 agy 切到
  下一个已采集备份的账号继续服务。默认关闭，在 Providers 页开启；同一时间只用一个账号，
  详见下文「多账号自动切号」。

## 环境要求

- Antigravity CLI（`agy`），带 `acp` 子命令。文本与工具调用已在 1.4.12 和 1.5.0 上验证（握手时拒绝低于 1.4.12 的版本）；
  从 Magpie 页面直接发起 Google 登录（`agy acp --login`）与图片输入需要 1.5.0。
- 支持 OpenCode 风格 provider 插件的 Magpie。额度查询已在 Magpie 0.1.1599 上验证。
- agy 版本低于 1.1.11 时，额度查询会被拒绝，以免旧版本把 `/usage` 当成模型提示词。

## 安装

直接从 GitHub 安装：

```sh
magpie plugin add github:gitxm/yce-magpie-agy
```

插件进入社区市场后，改用：

```sh
magpie plugin add @magpie-community/yce-magpie-agy
```

从本地源码安装：

```sh
git clone https://github.com/gitxm/yce-magpie-agy
magpie plugin add ./yce-magpie-agy
```

安装完成后，先在终端运行一次 `agy` 完成 Google 登录。

## 使用

1. 在 Magpie 的 Providers 页找到 `yce-magpie-agy` 并点击 **Sign in with Google**。插件先用
   `agy models` 检查是否已登录：若本机 agy 已登录则直接完成；若未登录则启动 `agy acp --login`，
   在页面里打开 Google 登录链接并粘贴授权码（或跳转后的完整 URL）即可完成登录。Google 凭据始终
   由 agy 自己保管，插件默认不读取、不保存；只有开启「多账号自动切号」后，插件才会读取并备份令牌文件（见下文）。
2. 模型名写成 `yce-magpie-agy/<模型>`。agy 对同一模型不同思考等级给出的多个模型 ID，
   在这里会合并成一个模型的多个变体，请求时再映射回对应的 agy ID。
3. 在客户端里选用这个模型即可。

## 并发

- 插件自己的进程池上限由 `AGY_BRIDGE_MAX_PROCS` 决定，默认 16 个 agy 进程。
- Magpie 的 Providers 页有单独的 Concurrency 设置，可填 0–1000，0 表示不限制。
  你在页面里改的值会覆盖 `package.json` 里 `magpie.maxConcurrency` 的默认声明（16）。
- 进程池已满、又找不到可以淘汰的进程时，插件返回 HTTP 503。建议两处数值保持一致：
  Providers 页的并发数超过进程池上限，多出来的请求就会得到 503。

## 平台

- **macOS、Linux**：支持。
- **原生 Windows**：支持 `.exe`、`.cmd`、`.bat` 的查找与启动，后台更新检查不弹控制台窗口，
  并支持 `magpie quota`。目前只有命令构造的单元测试，尚未在 Windows 实机完成端到端验证。

### Windows 原生人工复现步骤（多账号自动切号）

以下五步用于人工验证自动切号在 Windows 原生宿主上的行为，**尚未执行**，Windows 原生未端到端验证：

1. 在 Magpie Providers 页打开 Auto-switch 开关（令牌备份只在该开关开启后进行），两个
   Google 账号各自在终端跑一次 `agy` 完成登录；每次登录后在 Magpie 发一条请求，让插件
   采集该账号的令牌备份。
2. 插件 Options 填 `{"accounts":["A","B"]}`（A、B 换成两个账号邮箱；留空则按 active+old
   自动发现），重启宿主。
3. 用账号 A 把某个模型组的额度耗尽（或等真实耗尽）：确认请求仍回 HTTP 429，随后
   `%USERPROFILE%\.gemini\google_accounts.json` 的 `active` 变为 B，
   `magpie quota yce-magpie-agy --json` 的窗口名前缀变成 B 的掩码。
4. 另开一个终端跑着 `agy` 再触发切号：确认插件不切号，并在 quota 的 error 里报「在途」。
5. WSL 里跑一次 `agy --version`：确认启动包装器把 WSL 侧账号同步成 B。

## 额度

```sh
magpie quota yce-magpie-agy --json
magpie quota refresh yce-magpie-agy --json
```

额度数据来自 agy 自己的 `/usage` 报告，显示的是当前 agy 登录账号的订阅窗口，按模型组
分别列出。自动切号关闭时插件不读写 Google 令牌，也不会替你伪装成其他账号；开启自动切号后，
插件会读取令牌文件来做备份与显示当前账号掩码（见「多账号自动切号」）。没有可测量数据的窗口
会显示 "Limits not available"，而不是 0% 或 100%。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `AGY_PATH` | 按 PATH 查找 | 指定 agy 可执行文件 |
| `AGY_BRIDGE_MAX_PROCS` | 16 | agy 进程池上限 |
| `AGY_BRIDGE_THINKING` | 开启 | 设为 `0` 关闭思考摘要；新版 Magpie 以 Providers 页开关为准，旧宿主才读该环境变量 |
| `AGY_BRIDGE_MINIMAL_AGENT` | 开启 | 设为 `0` 保留 agy 默认提示组件，每次模型调用多约 2,600 个输入 token；新版 Magpie 以 Providers 页开关为准，旧宿主才读该环境变量 |
| `AGY_BRIDGE_IDLE_MS` | 600000 | 进程空闲多久后回收（会话仍可续接） |
| `AGY_BRIDGE_RESUME_TTL_MS` | 21600000 | 回收后的会话可续接的时长（6 小时） |
| `AGY_BRIDGE_STATE_FILE` | `$XDG_STATE_HOME/magpie-agy-bridge/sessions.json` | 会话状态文件路径 |
| `AGY_BRIDGE_IDE_CALL_DEADLINE_MS` | 150000 | 工具运行超过该时间仍未结束时，先返回 "still running" |
| `AGY_BRIDGE_START_TIMEOUT_MS` / `_TURN_TIMEOUT_MS` / `_TOOL_TIMEOUT_MS` | 60 秒 / 5 分钟 / 30 分钟 | 进程启动、agy 无输出、等待客户端工具结果的超时 |
| `AGY_BRIDGE_DETACHED_EVICT_MS` | 30000 | 客户端已断开的挂起工具回合，最多占用进程池槽位这么久 |
| `AGY_BRIDGE_MAX_PROMPT_BYTES` | 114688（112 KiB） | 重放历史提示词的字节预算 |
| `AGY_BRIDGE_USAGE_TIMEOUT_MS` | 15000 | 额度查询的总时间预算，最高 18000 |
| `AGY_BRIDGE_MCP_TRACE` | 未设置 | 把 MCP 通道流量写入指定文件，仅用于排查 |
| `AGY_BRIDGE_PROMPT_CLOAK` | 开启 | 设为 `0` 关闭假 429 绕过，系统提示词原样发给 agy；新版 Magpie 以 Providers 页开关为准 |
| `AGY_BRIDGE_PREFILL` | 开启 | 设为 `0` 恢复对 assistant 预填尾巴的 400 拒绝 |
| `AGY_BRIDGE_PREFILL_CARRIER_NOTE` | 英文提示行 | 预填片段渲染时的提示行文本（发给模型） |

## 插件选项

新版 Magpie 提供两个配置入口，生效方式不同：

- **Providers 页开关**（即时生效）：在 Magpie 的 Providers 页对本提供商可切换四个布尔开关，宿主每次调用现读，改动立即对后续请求生效，无需重启：

  | 开关 | 默认 | 作用 |
  |---|---|---|
  | `thinking_summary` | 开 | 转发 agy 思考摘要。关闭后响应不再携带 `thinking` 块，等价于旧版设置 `AGY_BRIDGE_THINKING=0` |
  | `minimal_agent` | 开 | 以最小隔离 agent 运行 agy。关闭后保留 agy 默认提示组件，每次模型调用多约 2,600 个输入 token；只对新启动的 agy 进程生效，开关变化后下一次请求会按既有不兼容路径换新进程 |
  | `prompt_cloak` | 开 | 绕过 Antigravity 对 Claude Agent SDK 等身份句的假 429，见下文「Claude Code 子代理与假 429」。关闭后系统提示词原样发送，等价于 `AGY_BRIDGE_PROMPT_CLOAK=0` |
  | `auto_switch` | 关 | 当前 agy 账号额度用尽时，自动切到下一个已采集账号：停掉插件自有 agy 进程、改写 `~/.gemini` 下的账号文件、换号后继续服务。同一时间只用一个账号；完整行为、前提与限制见下文「多账号自动切号」 |

  旧宿主（没有 Providers 页开关的 Magpie）不读这些开关，仍按上表环境变量与默认值工作。

- **插件 Options JSON**（改完需重启宿主）：在 Magpie 的「插件 → 已安装 → Options」里编辑 JSON，保存后作为插件入口第二参数传入，重启宿主后生效：

  ```json
  {
    "agyPath": "",
    "maxProcs": 16,
    "accounts": [],
    "idleMs": 600000,
    "resumeTtlMs": 21600000
  }
  ```

  - `agyPath`：agy 可执行文件绝对路径；优先级 `agyPath` > `AGY_PATH` > 按 PATH 查找。
  - `maxProcs`：进程池上限，1-64 的整数；建议与 Providers 页该提供商的 Concurrency 保持一致，否则多出的请求会排队或 503；优先级高于 `AGY_BRIDGE_MAX_PROCS`。
  - `accounts`：参与自动切号的账号邮箱数组，按顺序轮转；留空时按 `~/.gemini/google_accounts.json` 的 active+old 自动发现。数组里没有令牌备份的账号会被跳过（见「多账号自动切号」）。
  - `idleMs` / `resumeTtlMs`：进程空闲回收、停车会话可续接的时长（毫秒）；优先级高于 `AGY_BRIDGE_IDLE_MS` / `AGY_BRIDGE_RESUME_TTL_MS`。
  - 各键优先级一律是 JSON > 对应环境变量 > 默认值；非法值会让插件加载直接失败并写明键名，空串与 `null` 视为未设置。
  - 命令行同样可写：`magpie plugin options yce-magpie-agy '{"maxProcs":8}'`，`magpie plugin options yce-magpie-agy off` 清除。

## Claude Code 子代理与假 429

Antigravity 看到下面这些系统提示词片段时，不管额度还剩多少都回
`429 RESOURCE_EXHAUSTED: Resource has been exhausted`，agy 收到后按退避一直重试，客户端
表现为卡住、一个工具都调不起来：

- `You are a Claude agent, built on Anthropic's Claude Agent SDK`：Claude Code 的子代理
  （Agent 工具）、`claude -p` 非交互模式、Claude Desktop 都用这句；
- `x-anthropic-billing-header`（Claude Code 的计费行）、Codex 给 GPT-5 的身份句、
  Hermes Agent 旧版默认人设。

Claude Code 交互主会话用的是另一句身份，所以「主会话能跑 Bash，子代理和 `claude -p` 卡死」
就是这个原因。2026-11-10 在本机 agy 1.5.1 上实测：同一请求去掉这句即正常调用 Bash，
保留则一直 429。

插件默认在**发给 agy 的系统级文本**（会话级 append、内联的 `external_system_instructions`、
`role: system/developer` 消息）里，给这几句的首字母后插一个零宽空格（U+200B），模型读到的
意思不变。词表与 magpie 的 antigravity-cloak 中间件相同——那个中间件只作用于 magpie 自带的
Antigravity 账号，管不到本插件。会话标识、续接哈希与用户正文都不改。

这会改动发给 Google 的内容，可能违反 Antigravity 条款。不想要就在 Providers 页关掉
`prompt_cloak`（旧宿主设 `AGY_BRIDGE_PROMPT_CLOAK=0`）。

另外，agy 1.5.x 把重试提示改成了 `⚠ API error (attempt N): …`，插件同样把它过滤掉，
不会再当成模型回复显示在客户端里。

## 多账号自动切号

开启后，当前 agy 账号额度用尽时，插件会自动停掉自己的 agy 进程、把本机 agy 切到下一个可用
账号再继续服务。同一时间只用一个账号，不做多账号并行。

**前提**

1. Providers 页打开 Auto-switch 开关（默认关闭；旧宿主没有该开关，自动切号恒为关）。
2. 每个账号首次使用前，在终端跑一次 `agy` 用该账号完成登录，随后在 Magpie 发一条请求——
   插件在下一次启动 agy 进程时把该账号的令牌备份下来。仓库里没有备份的账号不会被切到。
3. 插件 Options 的 `accounts` 留空时，按 `~/.gemini/google_accounts.json` 的 active+old
   自动发现候选账号；填了就按给定顺序轮转。

**触发条件**

- 只认账号额度用尽的报错（`QUOTA_EXHAUSTED` / `RESOURCE_EXHAUSTED`）；
  `MODEL_CAPACITY_EXHAUSTED`（服务端整体容量不足，换号无用）和普通 429 不触发切号。
- 额度窗口用量达到 98% 只记冷却（到期时间取窗口的重置时间，取不到记 1 小时），不会主动
  切号，也不把仍能跑其他模型组的账号切走。
- 令牌过期或被吊销（认证失败）同样不切号：当前账号冷却 1 小时，额度页提示需重新登录。
- 触发切号的那次请求仍按原样回 HTTP 429，插件不自动重发（流可能已输出过内容或工具调用，
  重发会重复副作用），由客户端重试。

**切号过程**

1. 停掉插件自己的全部 agy 进程：空闲进程直接回收；正在输出的对话最多等 120 秒自然结束；
   正在等客户端工具结果的对话立即收回，客户端会收到一条说明文字，下一请求按历史重放。
2. 与外部切号设施（如 `agy-quota.py`）共用同一把锁 `~/.better-harness/agy-switch.lock`
   （Windows 原生为 `%USERPROFILE%\.better-harness\agy-switch.lock.d` 目录锁）；锁被占用
   即「另一切号进行中」，本次不切。
3. 检测到插件之外的 agy 进程正在运行、或无法核实进程状态时，本次不切。
4. 改写 `~/.gemini` 下的账号文件（`google_accounts.json` 与 OAuth 令牌文件）：先备份当前
   号，原子写入并回读校验，任一步失败自动还原为切换前的内容。
5. 切号后旧账号名下的停车会话不再续接，走新会话＋历史重放；切回原账号且在续接时限内则
   恢复。模型目录按新账号重新发现。日志只记邮箱掩码与原因，不写令牌。

所有候选账号都在冷却时不切号，额度页报「所有账号额度用尽，最早恢复时间 …」。

**WSL 宿主不生效**：插件运行在 WSL 里时自动切号不生效，也不创建备份仓库——本机 agy 启动
包装器每次启动都会按 Windows 侧账号覆盖 WSL 账号，WSL 内切号会被立即冲掉。请在 Windows
宿主上开启；Windows 宿主切号后，WSL 侧由包装器在下次启动时自动同步。

**令牌备份与清理**：备份放在插件自己的状态目录 `$XDG_STATE_HOME/magpie-agy-bridge/accounts/`
（默认 `~/.local/state/…`，Windows 原生在 `%USERPROFILE%` 下同结构），目录权限 0700、文件
0600，每个账号一个按邮箱哈希命名的 JSON，冷却表 `cooldown.json` 也在该目录。开关开启时，
额度窗口名会加上当前账号的掩码前缀（如 `a***@g***.com · Gemini · Weekly`）。关闭 Providers
页的 Auto-switch 即恢复旧行为（不再读账号文件）；彻底清理就删除整个 `accounts/` 目录。

**注意**：Windows 宿主上的插件锁与 WSL 里的 `agy-quota.py --switch` 互相看不见，开了自动
切号就别同时用 `agy-quota.py --switch`。

以上行为全部由假 agy＋临时 HOME 的自动化测试覆盖（115 tests / 338 checks）；Windows 原生
端到端未验证，人工复现步骤见「平台」。

## 常见排查

- **找不到 agy**：设置 `AGY_PATH` 指向可执行文件，或确认 `agy` 在 PATH 里。
- **Sign in 失败或 agy 报登录相关错误**：在终端运行一次 `agy`，重新完成 Google 登录。
- **HTTP 503**：进程池满。提高 `AGY_BRIDGE_MAX_PROCS` 和 Providers 页的 Concurrency，
  或者减少同时进行的会话。
- **额度显示 "Limits not available" 或报版本错误**：该窗口没有可测量的数据；版本错误则
  把 agy 升级到 1.1.11 以上。
- **图片请求返回 HTTP 400**：当前 agy 没有声明图片能力（需要 1.5.0 以上）。另外只接受
  内联 base64，URL 图片和 PDF 等二进制文档都会被拒绝。
- **回复里出现 "Agent execution terminated due to error."**：这是 agy 的错误标记。插件会
  从 agy 的日志中取出真实原因，并以错误结束本轮，不会当作正常回复输出。
- **HTTP 409，提示工具结果与历史对不上**：通常是客户端在对话中途改写了历史或工具 ID。
  能确定对应关系时插件会重建会话；无法确定时直接拒绝，不做猜测。
- **Claude Code 子代理或 `claude -p` 一直卡住、工具调不起来，agy 日志里反复
  `RESOURCE_EXHAUSTED (code 429)`**：多半是假 429，确认 Providers 页 `prompt_cloak` 开着，
  见「Claude Code 子代理与假 429」。
- **想关掉思考摘要**：新版 Magpie 在 Providers 页关闭（旧宿主仍可用 `AGY_BRIDGE_THINKING=0`），或者在请求里带上
  `thinking: { "type": "disabled" }`。

## 开发

```sh
node --check index.mjs
node --check mcp-server.mjs
node --check usage.mjs
npm test
npm pack --dry-run
```

`npm test` 用假的 agy 进程跑完整的 ACP 与 MCP 链路，不消耗额度。真实 CLI 的集成检查需要
显式开启，并会消耗少量订阅额度：

```sh
AGY_BRIDGE_INTEGRATION=1 npm run test:integration
```

## License

MIT。版权声明见 [LICENSE](LICENSE)，上游来源与逐项变更见 [NOTICE.md](NOTICE.md)。
