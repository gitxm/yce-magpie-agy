# yce-magpie-agy

Turn the local Antigravity CLI (`agy`) into a model provider inside Magpie. Once
it is set up, clients such as OpenCode and Claude Code can reach the Gemini,
Claude and GPT-OSS models in your subscription through Magpie, and every request
is actually carried out by an `agy` process.

**[中文 → README.md](README.md)** · Provenance, licensing and migration notes:
[NOTICE.md](NOTICE.md)

## What it is

The plugin runs as a Magpie provider. A client sends an Anthropic Messages
request; the plugin turns it into Agent Client Protocol (ACP) messages, hands
them to a local `agy acp` process, and converts the output back into a streamed
response.

- The work is done by the real agy CLI over the ACP channel it ships with. The
  plugin does not impersonate the IDE and does not call Google's internal
  endpoints directly.
- Tools that belong to the client, such as file reads, writes and shell commands,
  are exposed to the model over MCP. The client runs them and the results flow
  back into the same agy conversation, so the model sees ordinary native tool
  calls.
- Account standing is outside the plugin's control. If Google changes its usage
  policies, the plugin cannot promise your account will not be restricted.

## Features

- **Every model in the subscription**: switch between Gemini, Claude and GPT-OSS
  models mid-conversation without losing history. Thinking levels can be changed
  the same way.
- **Streaming with thought summaries**: summaries come back as `thinking` blocks.
  On new Magpie builds turn them off on the Providers page; on older hosts set
  `AGY_BRIDGE_THINKING=0`.
- **Image input**: inline base64 PNG, JPEG, GIF and WebP. This needs agy 1.5.0 or
  newer, because the ACP server has to advertise image support.
- **Tool calls**: parallel and consecutive calls both work. A tool that runs past
  150 seconds first gets a "still running" placeholder; once the real result
  arrives, the same turn continues, and the client executes each call exactly once.
- **Session resume**: each finished turn is recorded. After a Magpie or plugin
  restart, the session continues through `session/resume` as long as the history
  and instruction hashes still match. The state file stores session IDs and
  hashes, never message text.
- **Isolation**: your global MCP configuration is never read. Every agy process
  runs with a temporary agent, and every permission request agy raises (shell,
  file edits, browser) is refused. Real actions happen on the client side.
- **Sign in with Google inside Magpie**: click `Sign in with Google` on the
  Providers page. If `agy` is already signed in, nothing opens; otherwise `agy acp --login`
  prints the Google OAuth link and takes the authorization code (or callback URL)
  right in Magpie, so headless servers and Docker work too (aligned with official
  `agy-cli` 0.1.1).
- **Usage visibility**: Magpie shows the agy subscription usage windows. They are
  informational only; running out of quota does not block requests automatically.
- **Multi-account auto-switching**: when the current agy account runs out of
  quota, the plugin stops its own agy processes and switches the local CLI to
  the next captured account. Off by default; enable it on the Providers page.
  One account at a time — see "Multi-account auto-switching" below.

## Requirements

- The Antigravity CLI (`agy`) with the `acp` subcommand. Text and tool calls have
  been verified on 1.4.12 and 1.5.0 (the ACP handshake rejects versions older than
  1.4.12); signing in from Magpie (`agy acp --login`) and image input need 1.5.0.
- A Magpie build with OpenCode-style provider plugin support. Usage reporting was
  verified on Magpie 0.1.1599.
- agy versions older than 1.1.11 are refused for usage queries, because those
  builds can treat `/usage` as an ordinary model prompt.

## Install

Straight from GitHub:

```sh
magpie plugin add github:gitxm/yce-magpie-agy
```

Once the plugin is listed in the community marketplace, you can install it with:

```sh
magpie plugin add @magpie-community/yce-magpie-agy
```

From a local clone:

```sh
git clone https://github.com/gitxm/yce-magpie-agy
magpie plugin add ./yce-magpie-agy
```

After installing, run `agy` once in a terminal to complete the Google sign-in.

## Usage

1. Open Magpie's Providers page, find `yce-magpie-agy`, and click **Sign in with Google**.
   The plugin first checks `agy models`: if `agy` is already signed in, it succeeds
   immediately; if not, it runs `agy acp --login`, opens Google's sign-in link, and
   accepts the authorization code (or full callback URL) in Magpie. Google credentials
   stay with agy; the plugin does not read or store them unless multi-account
   auto-switching is enabled (see below).
2. Refer to models as `yce-magpie-agy/<model>`. When agy lists separate model IDs
   for different thinking levels, they are grouped here as variants of one model,
   and each request is mapped back to the matching agy ID.
3. Pick the model in your client as usual.

## Concurrency

- The plugin's own pool is capped by `AGY_BRIDGE_MAX_PROCS`, which defaults to 16
  agy processes.
- Magpie's Providers page has its own Concurrency field that accepts 0 to 1000,
  where 0 means no limit. A value set there overrides the default of 16 that the
  plugin declares in `magpie.maxConcurrency`.
- When the pool is full and no process can be evicted, the plugin answers with
  HTTP 503. Keep the two numbers aligned: if the Providers page allows more
  concurrent requests than the pool holds, the extra ones will get 503.

## Platforms

- **macOS and Linux**: supported.
- **Native Windows**: supported for `.exe`, `.cmd` and `.bat` lookup and launch,
  silent background update checks, and `magpie quota`. So far only the command
  construction has unit tests; end-to-end runs on real Windows hardware are still
  pending.

### Manual reproduction steps on native Windows (multi-account auto-switching)

These five steps verify auto-switching on a native Windows host. They have **not
been run yet**; native Windows is not verified end-to-end:

1. Turn on the Auto-switch switch on Magpie's Providers page (token capture only
   happens while the switch is on), then sign in once from a terminal with each
   of the two Google accounts by running `agy`; after each sign-in send one
   request through Magpie so the plugin captures that account's token backup.
2. Fill the plugin Options with `{"accounts":["A","B"]}` (replace A and B with
   the two emails; leaving it empty falls back to active+old discovery) and
   restart the host.
3. Exhaust a model group's quota on account A (or wait for a real exhaustion):
   the request still answers HTTP 429, afterwards
   `%USERPROFILE%\.gemini\google_accounts.json` shows `active` = B, and
   `magpie quota yce-magpie-agy --json` prefixes its window names with B's
   masked address.
4. Keep an `agy` running in another terminal and trigger a switch: the plugin
   must not switch, and quota's error field reports "in flight".
5. Run `agy --version` once inside WSL: the launcher wrapper synchronizes the
   WSL side to account B.

## Usage quota

```sh
magpie quota yce-magpie-agy --json
magpie quota refresh yce-magpie-agy --json
```

The numbers come from agy's own `/usage` report for whichever account is signed
in to the CLI, broken down by model group. With auto-switching off the plugin
neither reads nor writes Google tokens and never presents itself as another
account; with auto-switching on it reads the token file to back it up and to
show the current account's mask in the quota view (see "Multi-account
auto-switching"). A window with no
measurable data shows "Limits not available" rather than a fake 0% or 100%.

## Environment variables

| Name | Default value | What it does |
|---|---|---|
| `AGY_PATH` | PATH lookup | Path to the agy executable |
| `AGY_BRIDGE_MAX_PROCS` | 16 | Maximum number of agy processes in the pool |
| `AGY_BRIDGE_THINKING` | on | Set to `0` to stop forwarding thought summaries; on new Magpie builds the Providers page switch takes precedence, only older hosts read this variable |
| `AGY_BRIDGE_MINIMAL_AGENT` | on | Set to `0` to keep agy's default prompt components (about 2,600 more input tokens per model call); on new Magpie builds the Providers page switch takes precedence, only older hosts read this variable |
| `AGY_BRIDGE_IDLE_MS` | 600000 | How long a process may sit idle before it is reclaimed; the session can still resume |
| `AGY_BRIDGE_RESUME_TTL_MS` | 21600000 | How long a reclaimed session stays resumable (6 hours) |
| `AGY_BRIDGE_STATE_FILE` | `$XDG_STATE_HOME/magpie-agy-bridge/sessions.json` | Where resumable session records are kept |
| `AGY_BRIDGE_IDE_CALL_DEADLINE_MS` | 150000 | After this long, a still-running client tool gets a "still running" reply |
| `AGY_BRIDGE_START_TIMEOUT_MS` / `_TURN_TIMEOUT_MS` / `_TOOL_TIMEOUT_MS` | 60 s / 5 min / 30 min | Limits for process startup, agy silence, and waiting on a client tool result |
| `AGY_BRIDGE_DETACHED_EVICT_MS` | 30000 | How long a suspended tool turn whose client disconnected may keep its pool slot |
| `AGY_BRIDGE_MAX_PROMPT_BYTES` | 114688 (112 KiB) | Byte budget for the replayed history prompt |
| `AGY_BRIDGE_USAGE_TIMEOUT_MS` | 15000 | Total time budget for a usage query, capped at 18000 |
| `AGY_BRIDGE_MCP_TRACE` | unset | Writes MCP channel traffic to the given file; for debugging only |
| `AGY_BRIDGE_PROMPT_CLOAK` | on | `0` sends the system prompt to agy as written (no fake-429 workaround); new Magpie uses the Providers-page switch |
| `AGY_BRIDGE_EXTRA_CLOAK_WORDS` | unset | Extra system-prompt words to break with a zero-width space (comma-separated or JSON array) |
| `AGY_BRIDGE_PREFILL` | on | `0` brings back the 400 for a request ending in an assistant prefill |
| `AGY_BRIDGE_PREFILL_CARRIER_NOTE` | English note | The note line sent to the model before a prefill fragment |

## Claude Code subagents and the fake 429

Antigravity answers a system prompt containing `You are a Claude agent, built on
Anthropic's Claude Agent SDK` (Claude Code subagents, `claude -p`, Claude
Desktop), `x-anthropic-billing-header`, Codex's GPT-5 identity lines or Hermes
Agent's old persona with `429 RESOURCE_EXHAUSTED`, however much quota is left;
agy retries it with backoff and the client hangs without a single tool call.
The interactive Claude Code main session uses a different identity, which is
why the main session can run Bash while subagents and `claude -p` cannot
(verified on agy 1.5.1, 2026-11-10).

By default the bridge puts a zero-width space (U+200B) after the first letter
of those words in the system-level text it sends to agy (session append, inline
`external_system_instructions`, `system`/`developer` messages). The word list is
the one magpie's antigravity-cloak middleware uses; that middleware acts only on
magpie's built-in Antigravity accounts, not on this provider. Conversation keys,
resume hashes and user content are unchanged. This changes what Google is sent
and may be against its terms: turn off `prompt_cloak` on the Providers page (old
hosts: `AGY_BRIDGE_PROMPT_CLOAK=0`) to send prompts as written.

agy 1.5.x words its retry notice as `⚠ API error (attempt N): …`; the bridge
filters it like the older `Encountered retryable error` banner instead of
showing it as model text.

## Plugin options

New Magpie builds offer two configuration entry points that take effect
differently:

- **Providers-page switches** (immediate): four boolean switches for this
  provider on Magpie's Providers page; the host re-reads them on every call,
  so a flip applies to the next request without restarting:

  | Switch | Default | What it does |
  |---|---|---|
  | `thinking_summary` | on | Forward agy thought summaries. Off: responses carry no `thinking` blocks, same as `AGY_BRIDGE_THINKING=0` |
  | `minimal_agent` | on | Run agy with a minimal isolated agent. Off keeps agy's default prompt components, costing about 2,600 more input tokens per model call; applies to newly started agy processes, and the next request swaps an incompatible process through the existing retire path |
  | `prompt_cloak` | on | Get past Antigravity's fake 429 for Claude Agent SDK and similar identity lines; see "Claude Code subagents and the fake 429". Off: same as `AGY_BRIDGE_PROMPT_CLOAK=0` |
  | `auto_switch` | off | When the current agy account runs out of quota, switch to the next captured account: stop the plugin's own agy processes, rewrite the account files under `~/.gemini`, and keep serving. One account at a time; see "Multi-account auto-switching" below for the full behavior, prerequisites and limits |

  Older hosts without these switches keep using the environment variables
  above and the defaults.

- **Plugin Options JSON** (restart required): edit the JSON in Magpie's
  "Plugins → Installed → Options"; it is passed to the plugin entry as the
  second argument and takes effect after the host restarts:

  ```json
  {
    "agyPath": "",
    "maxProcs": 16,
    "accounts": [],
    "idleMs": 600000,
    "resumeTtlMs": 21600000,
    "extraWords": []
  }
  ```

  - `agyPath`: absolute path to the agy executable; priority is `agyPath` >
    `AGY_PATH` > PATH lookup.
  - `maxProcs`: pool limit, an integer between 1 and 64; keep it equal to the
    provider's Concurrency on the Providers page, otherwise extra requests
    queue or 503; overrides `AGY_BRIDGE_MAX_PROCS`.
  - `accounts`: emails that take part in auto-switching, rotated in order; empty
    falls back to active+old discovery from `~/.gemini/google_accounts.json`.
    Accounts without a captured token backup are skipped (see "Multi-account
    auto-switching").
  - `idleMs` / `resumeTtlMs`: idle reclaim and parked-session resume windows
    in milliseconds; override `AGY_BRIDGE_IDLE_MS` / `AGY_BRIDGE_RESUME_TTL_MS`.
  - `extraWords`: extra system-prompt words to break with a zero-width space
    (strings of at least 2 characters), merged automatically with any words
    exported by an installed `@magpie-community/middleware-antigravity-cloak`
    and `AGY_BRIDGE_EXTRA_CLOAK_WORDS`.
  - Priority for every key is JSON > matching environment variable > default;
    an invalid value fails the plugin load naming the key, and empty strings
    and `null` count as unset.
  - The CLI works too: `magpie plugin options yce-magpie-agy '{"maxProcs":8}'`,
    and `magpie plugin options yce-magpie-agy off` clears it.

## Multi-account auto-switching

When enabled, the plugin stops its own agy processes as soon as the current agy
account runs out of quota, switches the local CLI to the next usable account,
and keeps serving. One account is used at a time; there is no parallel use.

**Prerequisites**

1. Turn on the Auto-switch switch on the Providers page (off by default; hosts
   without these switches never auto-switch).
2. For each account, sign in once by running `agy` in a terminal, then send one
   request through Magpie: on the next agy process start the plugin captures a
   token backup for that account. Accounts without a backup are never switched
   to.
3. If the plugin Options `accounts` array is empty, candidates are discovered
   from the active+old lists in `~/.gemini/google_accounts.json`; if it is set,
   accounts rotate in the given order.

**What triggers a switch**

- Only account-quota errors (`QUOTA_EXHAUSTED` / `RESOURCE_EXHAUSTED`) trigger a
  switch. `MODEL_CAPACITY_EXHAUSTED` (the server side is out of capacity; another
  account will not help) and plain 429s do not.
- A usage window at 98% or more only records a cooldown (until the window resets,
  or one hour when the reset time is unknown); it never switches on its own, and
  an account that can still serve other model groups is not switched away.
- Expired or revoked tokens (authentication failures) do not switch either: the
  current account is cooled down for an hour and the quota view asks for a new
  sign-in.
- The request that triggered the switch still answers HTTP 429 as before; the
  plugin never replays it itself (the stream may already have produced output or
  tool calls), the client retries.

**The switch itself**

1. Every agy process the plugin owns is stopped: idle ones are retired, a turn
   that is still streaming may finish naturally within 120 seconds, and a turn
   waiting on a client tool result is reclaimed immediately — the client receives
   a short explanation and replays from history on its next request.
2. The switch takes the same lock as external switchers such as `agy-quota.py`,
   `~/.better-harness/agy-switch.lock` (on native Windows, a
   `%USERPROFILE%\.better-harness\agy-switch.lock.d` directory lock); if the lock
   is held, another switch is in progress and this one is skipped.
3. If any agy process outside the plugin is running, or process state cannot be
   verified, the switch is skipped.
4. The account files under `~/.gemini` (`google_accounts.json` and the OAuth
   token file) are rewritten: the current account is backed up first, writes are
   atomic and read back, and any failure restores the previous content.
5. Parked sessions belonging to the old account are no longer resumed; they start
   a new session and replay history (switching back inside the resume window
   restores them). The model catalog is rediscovered for the new account. Logs
   carry masked emails and the reason only, never tokens.

When every candidate account is in cooldown, no switch happens and the quota
view reports the earliest recovery time.

**WSL hosts**: auto-switching does nothing inside WSL and no backup vault is
created — the local agy launcher wrapper overwrites the WSL account with the
Windows-side one on every launch, so a switch inside WSL would be undone
immediately. Enable it on the Windows host instead; after a switch there, the
wrapper synchronizes the WSL side on the next launch.

**Backups and cleanup**: token backups live in the plugin's own state directory
`$XDG_STATE_HOME/magpie-agy-bridge/accounts/` (`~/.local/state/…` by default;
the same layout under `%USERPROFILE%` on native Windows), directory mode 0700
and file mode 0600, one JSON per account named by a hash of the email; the
`cooldown.json` table lives there too. While the switch is on, quota window
names carry the current account's masked address (for example
`a***@g***.com · Gemini · Weekly`). Turning Auto-switch off restores the old
behavior (account files are no longer read); deleting the `accounts/` directory
removes every trace.

**Note**: the plugin's lock on a Windows host and `agy-quota.py --switch` inside
WSL cannot see each other; do not run both at the same time while auto-switching
is on.

All of the above is covered by automated tests against a fake agy with a
temporary HOME (115 tests / 338 checks). Native Windows has not been verified
end-to-end; the manual steps live under "Platforms".

## Troubleshooting

- **agy cannot be found**: set `AGY_PATH` to the executable, or make sure `agy`
  is on PATH.
- **Sign in fails, or agy reports a login problem**: run `agy` in a terminal and
  finish the Google sign-in again.
- **HTTP 503**: the pool is full. Raise `AGY_BRIDGE_MAX_PROCS` and the Providers
  page Concurrency, or reduce the number of simultaneous sessions.
- **Usage shows "Limits not available" or a version error**: that window has no
  measurable data. For a version error, upgrade agy to 1.1.11 or later.
- **Image requests return HTTP 400**: the running agy does not advertise image
  support (1.5.0 or later is needed). Only inline base64 is accepted; image URLs
  and binary documents such as PDFs are rejected.
- **A reply contains "Agent execution terminated due to error."**: that is agy's
  in-band error marker. The plugin reads the real cause from agy's log and ends
  the turn with an error instead of passing the marker through as text.
- **HTTP 409 saying tool results do not match the history**: usually the client
  rewrote the history or tool IDs mid-conversation. When the plugin can work out
  the correct match it rebuilds the session; when it cannot, it refuses rather
  than guessing.
- **Turning thought summaries off**: on new Magpie builds use the Providers page
  switch (older hosts: `AGY_BRIDGE_THINKING=0`), or send
  `thinking: { "type": "disabled" }` with the request.

## Development

```sh
node --check index.mjs
node --check mcp-server.mjs
node --check usage.mjs
npm test
npm pack --dry-run
```

`npm test` runs the full ACP and MCP path against a fake agy process, so it uses
no quota. The integration check against the real CLI is opt-in and uses a small
amount of subscription quota:

```sh
AGY_BRIDGE_INTEGRATION=1 npm run test:integration
```

## License

MIT. Copyright notices live in [LICENSE](LICENSE); upstream provenance and the
list of changes are in [NOTICE.md](NOTICE.md).
