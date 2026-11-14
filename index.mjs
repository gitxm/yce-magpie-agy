import { agyCandidates, spawnAgy, windowsMcpShim, windowsNcBuild, windowsTreeKill } from "./platform.mjs"
import { spawn, spawnSync } from "node:child_process"
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs"
import { createRequire } from "node:module"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createUsageReader, exhaustedWindows, maskedAccountReport } from "./usage.mjs"
import { backgroundBlocked, cannotSignIn, forgetStoredSignIn, isDead, storedSignIn, storedSignInNow } from "./signin.mjs"
import { sanitizePatternFields } from "./re2-pattern.mjs"
import { startLogin } from "./login.mjs"
import { ensureGeminiArrayItems } from "./array-items.mjs"
import { expandToolSchema } from "./tool-schema.mjs"
import { hint, outgoing as cloakOutgoing, turnsAway } from "./cloak.mjs"
import { accountKey, defaultVaultDir, discoverAccounts, captureCurrent, acquireSwitchLock,
  emailFromTokenPayload, foreignAgyProcesses, tokenFileOf, writeActiveAccount } from "./accounts.mjs"

const PROVIDER_ID = "yce-magpie-agy"
// Client tools reach the session through a private `nc` placed first on agy's
// PATH: agy dials `--ide-mcp-port` by running `nc 127.0.0.1 <port>`. That is
// how agy works, not a documented interface, and it was checked on 1.4.12 and
// 1.5.0. An older agy is refused with a clear message; a version agy doesn't
// report is not known to be older, so the session goes ahead.
export const MIN_AGY_VERSION = "1.4.12"
export function agyTooOld(version) {
  const parse = value => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? "").trim())
    return match ? match.slice(1).map(Number) : null
  }
  const have = parse(version)
  if (!have) return null
  const need = parse(MIN_AGY_VERSION)
  for (let i = 0; i < 3; i++) {
    if (have[i] > need[i]) return null
    if (have[i] < need[i]) return `agy ${version} is older than ${MIN_AGY_VERSION}, the oldest version this plugin was checked on. Update agy.`
  }
  return null
}
const AGENT_NAME = "magpie-bridge"
const DEFAULT_BRIDGE_APP_DATA_DIR = "magpie-agy-bridge"
const LEGACY_AGY_APP_DATA_DIR = "antigravity-cli"
const MCP_SERVER_PATH = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))

// agy acp --app-data-dir requires a relative name under ~/.gemini. Magpie's
// local session scanner hardcodes ~/.gemini/antigravity-cli, so isolating
// bridge sessions keeps gateway requests from being counted a second time.
function bridgeAppDataDirName(env = process.env) {
  const raw = typeof env.AGY_BRIDGE_APP_DATA_DIR === "string" ? env.AGY_BRIDGE_APP_DATA_DIR.trim() : ""
  if (!raw) return DEFAULT_BRIDGE_APP_DATA_DIR
  if (/^(?:0|false|off)$/i.test(raw) || raw === LEGACY_AGY_APP_DATA_DIR) return ""
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return DEFAULT_BRIDGE_APP_DATA_DIR
  const segments = raw.split(/[\\/]+/)
  if (segments.some(part => !part || part === "." || part === "..")) return DEFAULT_BRIDGE_APP_DATA_DIR
  return segments.join("/")
}

function bridgeConversationsDir(appDataDir = bridgeAppDataDirName(), home = os.homedir()) {
  return path.join(home, ".gemini", appDataDir || LEGACY_AGY_APP_DATA_DIR, "conversations")
}

function readTokenSnapshot(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return null
    const raw = fs.readFileSync(file, "utf8")
    let payload = null
    try { payload = JSON.parse(raw) } catch {}
    return {
      raw,
      mtimeMs: stat.mtimeMs,
      atime: stat.atime,
      mtime: stat.mtime,
      payload,
      email: emailFromTokenPayload(payload),
    }
  } catch {
    return null
  }
}

function writeSyncedTokenFile(destFile, raw, sourceSnap) {
  const dir = path.dirname(destFile)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = path.join(dir, `.${path.basename(destFile)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
  fs.writeFileSync(temp, raw, { mode: 0o600 })
  try { fs.chmodSync(temp, 0o600) } catch {}
  try {
    fs.renameSync(temp, destFile)
  } catch (error) {
    try { fs.unlinkSync(temp) } catch {}
    throw error
  }
  if (sourceSnap) {
    try { fs.utimesSync(destFile, sourceSnap.atime, sourceSnap.mtime) } catch {}
  }
}

// Keep ~/.gemini/<appDataDir>/antigravity-oauth-token aligned with the active
// CLI token file on Linux/WSL and multi-account setups, while preserving token
// refreshes written by agy acp for the same account.
function syncBridgeTokenFile(appDataDir = bridgeAppDataDirName(), home = os.homedir()) {
  if (!appDataDir) return
  const mainFile = tokenFileOf(home)
  const bridgeFile = path.join(home, ".gemini", appDataDir, "antigravity-oauth-token")
  const mainSnap = readTokenSnapshot(mainFile)
  if (!mainSnap) {
    try { fs.unlinkSync(bridgeFile) } catch {}
    return
  }
  const bridgeSnap = readTokenSnapshot(bridgeFile)
  if (bridgeSnap && bridgeSnap.raw === mainSnap.raw) return
  const sameAccount = Boolean(
    mainSnap.email && bridgeSnap?.email &&
    mainSnap.email.toLowerCase() === bridgeSnap.email.toLowerCase() &&
    bridgeSnap.payload?.token && typeof bridgeSnap.payload.token === "object",
  )
  try {
    if (sameAccount && bridgeSnap.mtimeMs > mainSnap.mtimeMs + 1) {
      writeSyncedTokenFile(mainFile, bridgeSnap.raw, bridgeSnap)
    } else {
      writeSyncedTokenFile(bridgeFile, mainSnap.raw, mainSnap)
    }
  } catch {}
}
// agy exposes tools from the --ide-mcp-port server as direct functions with this prefix.
const IDE_TOOL_PREFIX = "mcp_ide-tools_"
// agy 1.3.5+: a tools/list entry with this _meta key is never deferred.
const ALWAYS_LOAD = "antigravity/alwaysLoad"
// Read at call time so a host (or a test) can size the pool without a reload.
// Priority: plugin Options entry (packageConfig) > environment variable > default.
function maxProcs() {
  return packageConfig.maxProcs ?? positiveTimeout(process.env.AGY_BRIDGE_MAX_PROCS, 16)
}
function idleMs() {
  return packageConfig.idleMs ?? positiveTimeout(process.env.AGY_BRIDGE_IDLE_MS, 10 * 60 * 1000)
}
// A tool turn whose client detached this long ago yields its process under pool pressure.
function detachedEvictMs() {
  return positiveTimeout(process.env.AGY_BRIDGE_DETACHED_EVICT_MS, 30_000)
}
const MAX_PARKED = 32
const DEFAULT_PROC_START_TIMEOUT_MS = 60_000
const TURN_TIMEOUT_MS = positiveTimeout(process.env.AGY_BRIDGE_TURN_TIMEOUT_MS, 5 * 60 * 1000)
const TOOL_RESULT_TIMEOUT_MS = positiveTimeout(process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS, 30 * 60 * 1000)
function resumeTtlMs() {
  return packageConfig.resumeTtlMs ?? positiveTimeout(process.env.AGY_BRIDGE_RESUME_TTL_MS, 6 * 60 * 60 * 1000)
}
// agy fails an ide-tools MCP call after a fixed three minutes. Answer before
// that with a "still running" note; an identical repeat call waits for the
// original result instead of reaching the client again.
function ideCallDeadline() {
  return positiveTimeout(process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS, 150_000)
}
const CANCEL_SETTLE_MS = 15_000
const MAX_MCP_COMMIT_WAIT_MS = 60_000
function mcpCommitWaitMs() {
  const raw = process.env.AGY_BRIDGE_MCP_COMMIT_WAIT_MS
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(Math.floor(parsed), MAX_MCP_COMMIT_WAIT_MS)
  }
  return 5_000
}
const RECLAIM_STOP_TIMEOUT_MS = 10_000
// Repeated unmatched tool results against the same turn that made no progress:
// attempts below the limit stay 409 (a live turn may still be waiting), the
// limit-th attempt must end in a replay or a terminal 400, never another 409.
const NO_PROGRESS_REPEAT_LIMIT = 3
const NO_PROGRESS_REPEAT_WINDOW_MS = 10 * 60 * 1000
const NO_PROGRESS_REPEAT_MAX_ENTRIES = 256
const POOL_PRESSURE_NOTE = "agy bridge: this tool call was closed to free an agy process for another conversation; stop this turn"
const ACCOUNT_SWITCH_NOTE = "agy bridge: this tool call was closed because the plugin switched agy accounts; stop this turn"
const ACCOUNT_SWITCH_TIMEOUT_MS = 120_000
const WSL_ACCOUNT_NOTE = "插件运行在 WSL：本机 agy 启动包装每次都会按 Windows 侧账号覆盖 WSL 账号；请在 Windows 宿主上开启自动切号"
const SUPERSEDED_NOTE = "agy bridge: this tool call was superseded because the client conversation continued without it; stop this turn"
const SELF_POLL_IDLE_TIMEOUT_MS = positiveTimeout(process.env.AGY_BRIDGE_SELF_POLL_IDLE_TIMEOUT_MS, 20 * 60 * 1000)
const SELF_POLL_LIMIT = positiveTimeout(process.env.AGY_BRIDGE_SELF_POLL_LIMIT, 8)
// A conflict retrying can never fix: SDKs that honour this header (Anthropic
// SDK) stop their automatic retries instead of resending it.
const NO_RETRY_HEADERS = { "x-should-retry": "false" }
const SELF_POLL_NOTE = "agy bridge: gave up waiting for this tool: the client never returned a result for it; stop this turn"
const TOOL_LIST_WAIT_MS = 5_000
const STDERR_TAIL = 32 * 1024
const CONTROL_LINE_LIMIT = 16 * 1024 * 1024
const ACP_LINE_LIMIT = 64 * 1024 * 1024
const LOG_TAIL_BYTES = 256 * 1024
const NPM_ANTHROPIC = "@ai-sdk/anthropic"
const PING_INTERVAL_MS = 15_000
// agy reports an upstream failure or in-band retry warning as an ordinary
// message chunk ("\n⚠ <message>\n") followed by end_turn on terminal failure.
// agy 1.5.x words the retry warning as "API error (attempt N): <error>"; older
// builds as "Encountered retryable error from model provider: ...". Both are
// dropped, never shown to the client as model text.
const AGENT_RETRY_BODY_PREFIXES = ["Encountered retryable error from model provider", "API error (attempt "]
const isAgentRetryLine = (line) => AGENT_RETRY_BODY_PREFIXES.some((prefix) => line.startsWith(prefix))
const AGENT_TERMINAL_ERROR_PREFIXES = [
  "Agent execution terminated due to error.",
  "Our servers are experiencing high traffic right now, please try again in a minute.",
  "You have exhausted your quota on this model.",
  "Your AI credits balance is too low to continue.",
  "Authentication expired. Please log back in.",
  "There was a network issue connecting to the server, please try again.",
  "The model API is currently overloaded and may experience intermittent errors.",
  "The model encountered an internal error.",
  "The model is currently unreachable.",
  "Model produced invalid output.",
  "The model produced an invalid tool call.",
  "Mid-stream error",
]
const AGENT_ALL_BANNER_PREFIXES = [...AGENT_RETRY_BODY_PREFIXES, ...AGENT_TERMINAL_ERROR_PREFIXES]
const AGENT_BANNER_HOLD_LIMIT = 16 * 1024

// Antigravity refuses a request whose system prompt reads as the Claude Agent
// SDK's (Claude Code subagents, `claude -p`, Claude Desktop), Codex's GPT-5
// prompt, Hermes Agent's old persona or oh-my-pi's RFC 2119 line with a fake
// `429 RESOURCE_EXHAUSTED` (cloak.mjs). The built-in list and the two-zero-width
// -space break-up live in cloak.mjs; this file adds whatever an installed
// @magpie-community/middleware-antigravity-cloak exports (plus its extraWords in
// Magpie's plugins.json), plugin Options extraWords and
// AGY_BRIDGE_EXTRA_CLOAK_WORDS. Only system-level text sent to agy is changed;
// conversation identities, hashes and user content are not.
const SIBLING_CLOAK_MIDDLEWARE = fileURLToPath(
  new URL("../middleware-antigravity-cloak/antigravity-cloak.middleware.js", import.meta.url),
)

let cachedMiddlewareKey = null
let cachedMiddlewareWords = []

function validCloakWord(word) {
  return typeof word === "string" && word.trim().length > 1
}

function readInstalledCloakWords() {
  const out = []
  const add = (word) => {
    if (validCloakWord(word) && !out.includes(word)) out.push(word)
  }
  const home = os.homedir()
  const candidates = [
    process.env.AGY_BRIDGE_CLOAK_MIDDLEWARE_PATH,
    SIBLING_CLOAK_MIDDLEWARE,
    path.join(home, ".config", "magpie", "plugins", "node_modules", "@magpie-community", "middleware-antigravity-cloak", "antigravity-cloak.middleware.js"),
  ].filter(Boolean)
  let foundFile = null
  for (const file of candidates) {
    try {
      const source = fs.readFileSync(file, "utf8")
      foundFile = file
      const match = /export\s+const\s+words\s*=\s*(\[[\s\S]*?\])/.exec(source)
      if (!match) continue
      const parsed = JSON.parse(match[1])
      if (Array.isArray(parsed)) for (const word of parsed) add(word)
      break
    } catch {}
  }
  const pluginConfigCandidates = [
    foundFile ? path.resolve(path.dirname(foundFile), "..", "..", "..", "..", "plugins.json") : null,
    path.join(home, ".config", "magpie", "plugins.json"),
  ].filter(Boolean)
  for (const configFile of pluginConfigCandidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"))
      if (!Array.isArray(parsed?.plugins)) continue
      for (const entry of parsed.plugins) {
        if (typeof entry?.spec === "string" && entry.spec.includes("middleware-antigravity-cloak") &&
            Array.isArray(entry.options?.extraWords)) {
          for (const word of entry.options.extraWords) add(word)
        }
      }
      break
    } catch {}
  }
  return out
}

function envExtraCloakWords() {
  const raw = process.env.AGY_BRIDGE_EXTRA_CLOAK_WORDS
  if (typeof raw !== "string" || !raw.trim()) return []
  const trimmed = raw.trim()
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.filter(validCloakWord)
    } catch {}
  }
  return trimmed.split(/[\r\n,]+/).map((word) => word.trim()).filter(validCloakWord)
}

function cloakPromptText(text) {
  if (typeof text !== "string" || !text) return text
  const enabled = hostOption("prompt_cloak", "AGY_BRIDGE_PROMPT_CLOAK", true)
  return cloakOutgoing(text, { enabled, extraLines: extraCloakLines() })
}

function extraCloakLines() {
  const middlewareKey = `${process.env.AGY_BRIDGE_CLOAK_MIDDLEWARE_PATH || ""}\n${os.homedir()}`
  if (cachedMiddlewareKey !== middlewareKey) {
    cachedMiddlewareKey = middlewareKey
    cachedMiddlewareWords = readInstalledCloakWords()
  }
  const merged = []
  for (const word of [
    ...cachedMiddlewareWords,
    ...(packageConfig.extraWords || []),
    ...envExtraCloakWords(),
  ]) {
    if (validCloakWord(word) && !merged.includes(word)) merged.push(word)
  }
  return merged
}

const outgoing = cloakPromptText

const FALLBACK_MODELS = [
  { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)", effort: "high" },
  { id: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)", effort: "medium" },
  { id: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)", effort: "low" },
  { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", effort: "high" },
  { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", effort: "medium" },
  { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", effort: "low" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", effort: "high" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", effort: "medium" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", effort: "low" },
  { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", effort: "high" },
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)", effort: "medium" },
  { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)", effort: "low" },
  { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", effort: "high" },
  { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", effort: "medium" },
  { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", effort: "low" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", effort: "medium" },
]

const pool = new Map()
const parked = new Map()
const allProcs = new Set()
const sessions = new Map()
const toolCalls = new Map()
let cachedAgyPath
let cachedAgySearchKey
let controlServer
let controlServerPromise
let shimDir
// Only a shim dir this process made is removed at exit; the shared Windows nc.exe dir stays.
let shimDirOwned = false
let shimDirPromise

function positiveTimeout(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function configuredTimeout(name, fallback) {
  return Object.hasOwn(process.env, name)
    ? positiveTimeout(process.env[name], fallback)
    : fallback
}

// Plugin Options (the JSON editor on Magpie's plugin page) arrive as the second
// entry argument. Values are validated once at init: an invalid value fails the
// plugin load with the key name instead of silently falling back; unknown keys
// are ignored with a bridge event. Null and "" count as unset, so the matching
// environment variable (and then the default) applies.
const PACKAGE_OPTION_KEYS = new Set(["agyPath", "maxProcs", "accounts", "idleMs", "resumeTtlMs", "extraWords"])

function emptyPackageConfig() {
  return { agyPath: null, maxProcs: null, accounts: [], idleMs: null, resumeTtlMs: null, extraWords: [] }
}

let hostInput = null
let packageConfig = emptyPackageConfig()

// Providers-page switches (auth.options below) are read through the host on
// every call, so flipping one takes effect on the next request. Hosts without
// input.magpie.option (older Magpie, tests) fall back to the legacy
// environment variable and then the default; a null envName means the switch
// has no legacy variable and stays off on old hosts.
function hostOption(key, envName, fallback) {
  const value = hostInput?.magpie?.option?.(PROVIDER_ID, key)
  if (typeof value === "boolean") return value
  if (envName && Object.hasOwn(process.env, envName)) return process.env[envName] !== "0"
  return fallback
}

export function autoSwitchEnabled() {
  return hostOption("auto_switch", null, false) && !isWslHost()
}

function isWslHost() {
  if (process.platform !== "linux") return false
  if (Object.hasOwn(process.env, "WSL_DISTRO_NAME")) return true
  try { return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8")) } catch { return false }
}

function invalidOptionError(key, expected) {
  return new Error(`agy bridge: invalid plugin option "${key}": ${expected}`)
}

function validatePackageOptions(options) {
  const config = emptyPackageConfig()
  if (options === undefined || options === null) return config
  if (typeof options !== "object" || Array.isArray(options)) {
    throw invalidOptionError("options", "expected an object")
  }
  const unknown = []
  for (const [key, value] of Object.entries(options)) {
    if (!PACKAGE_OPTION_KEYS.has(key)) {
      unknown.push(key)
      continue
    }
    if (value === null || value === "") continue
    if (key === "agyPath") {
      if (typeof value !== "string") throw invalidOptionError(key, "expected a string path to the agy executable")
      config.agyPath = value
    } else if (key === "maxProcs") {
      if (!Number.isInteger(value) || value < 1 || value > 64) throw invalidOptionError(key, "expected an integer between 1 and 64")
      config.maxProcs = value
    } else if (key === "idleMs" || key === "resumeTtlMs") {
      if (!Number.isInteger(value) || value <= 0) throw invalidOptionError(key, "expected a positive integer number of milliseconds")
      config[key] = value
    } else if (key === "accounts") {
      if (!Array.isArray(value)) throw invalidOptionError(key, "expected an array of account emails")
      const accounts = []
      for (const account of value) {
        if (typeof account !== "string" || !account.includes("@") || /\s/.test(account)) {
          throw invalidOptionError(key, `expected emails containing "@" without whitespace, got ${JSON.stringify(account)}`)
        }
        if (!accounts.includes(account)) accounts.push(account)
      }
      config.accounts = accounts
    } else if (key === "extraWords") {
      if (!Array.isArray(value)) throw invalidOptionError(key, "expected an array of strings (at least 2 characters each)")
      const words = []
      for (const word of value) {
        if (!validCloakWord(word)) {
          throw invalidOptionError(key, `expected strings of at least 2 characters, got ${JSON.stringify(word)}`)
        }
        if (!words.includes(word)) words.push(word)
      }
      config.extraWords = words
    }
  }
  if (unknown.length) logBridgeEvent(null, null, "plugin_options", "ignored_unknown_keys", {}, { keys: unknown.join(",") })
  return config
}

function applyPluginConfig(input, options) {
  hostInput = input ?? null
  packageConfig = validatePackageOptions(options)
  cachedMiddlewareKey = null
}

function findAgy() {
  // Re-search whenever an input of the search changes (plugin agyPath option,
  // AGY_PATH, PATH/Path, LOCALAPPDATA, home): a cached path from an old
  // environment may be gone.
  const home = os.homedir()
  const env = process.env
  const searchKey = JSON.stringify([packageConfig.agyPath, env.AGY_PATH, env.PATH, env.Path, env.LOCALAPPDATA, home])
  if (cachedAgyPath && cachedAgySearchKey === searchKey) return cachedAgyPath
  cachedAgyPath = null
  cachedAgySearchKey = searchKey
  const candidates = agyCandidates(
    packageConfig.agyPath ? { ...env, AGY_PATH: packageConfig.agyPath } : env, home)
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      cachedAgyPath = candidate
      return candidate
    } catch {}
  }
  return null
}

function execOnce(file, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      const launch = file === "taskkill" ? spawn : spawnAgy
      const { unrefTimer: _unrefTimer, ...spawnOpts } = opts
      child = launch(file, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...spawnOpts,
        windowsHide: true,
      })
    } catch (err) {
      resolve({ err, stdout: "", stderr: "", code: null, timedOut: false })
      return
    }
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGKILL") } catch {}
      // A grandchild can hold the pipes open after the kill; never wait for close.
      resolve({ err: null, stdout, stderr, code: null, timedOut })
    }, opts.timeoutMs ?? 30_000)
    // Background work (the model catalog refresh) must never hold Node's exit.
    // A caller that awaits the result keeps the deadline referenced.
    if (opts.unrefTimer) timer.unref?.()
    try {
      child.stdout.on("data", (data) => { stdout += data })
      child.stderr.on("data", (data) => { stderr += data })
      child.on("error", (err) => {
        clearTimeout(timer)
        resolve({ err, stdout, stderr, code: null, timedOut })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ err: null, stdout, stderr, code, timedOut })
      })
    } catch (err) {
      clearTimeout(timer)
      try { child.kill("SIGKILL") } catch {}
      resolve({ err, stdout, stderr, code: null, timedOut })
    }
  })
}

async function listAgyModels(agyPath) {
  // a listing nobody asked for doesn't run an agy that would start its own
  // Google sign-in (signin.mjs); the catalog it has stays
  if (await backgroundBlocked()) return null
  const { err, stdout, code, timedOut } = await execOnce(agyPath, ["models"], { timeoutMs: 15_000, unrefTimer: true })
  // null, not FALLBACK_MODELS: a failed listing must not overwrite a dynamic catalog.
  if (err || timedOut || code !== 0) return null
  return parseAgyModels(stdout)
}

// parseAgyModels reads `agy models` output: one "<id>  <name>" per line.
function parseAgyModels(stdout) {
  const out = []
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const match = /^(\S+)\s+(.+)$/.exec(line)
    if (!match) continue
    const id = match[1]
    const name = match[2].trim()
    const effort = /-(high|medium|low|minimal|xhigh|max)$/i.exec(id)?.[1]?.toLowerCase()
    out.push({ id, name, effort })
  }
  return out.length ? out : null
}

// probeSignedIn is whether agy lists the signed-in account's models: an
// exit code alone can't say so, so a listing without one model in it is
// not signed in either. The listing it read is the catalog's, and what agy
// acp offers is asked at once (#1064): `agy models` and the session each
// take seconds on a real agy, and the host lists models right after.
const OFFERED_SIGNIN_WAIT_MS = 3_000

const PROBE_AUTH_TALK = /accounts\.google\.com|not (?:logged|signed) in|unauthenticated|authentication (?:required|expired)|login required|please (?:log|sign) in|sign in again|invalid_grant/i
const PROBE_NETWORK_TALK = /\b(?:eof|timeout|timed out|deadline exceeded|no such host|connection (?:refused|reset)|network|proxy|tls|ssl|certificate|dial tcp)\b/i

async function probeSignedIn(agy) {
  // User-initiated sign-in probe: skip `agy models` only when no usable local
  // credential exists (`cannotSignIn`), never on a stale background `isDead`
  // mark that a working `agy models` run can clear.
  const stored = await storedSignIn({ fresh: true })
  const missing = cannotSignIn(stored)
  if (missing) return { ok: false, why: missing, stored, authFailed: true, networkFailed: false }
  const probe = await execOnce(agy, ["models"], { timeoutMs: 15_000 })
  const listed = !probe.err && !probe.timedOut && probe.code === 0 &&
    probe.stdout.split("\n").some(line => /^\S+\s+\S/.test(line.trim()))
  if (listed) {
    forgetStoredSignIn({ dead: true })
    const list = parseAgyModels(probe.stdout)
    if (list) {
      useAgyPath(agy)
      storeListedCatalog(agy, list, Date.now())
    }
    return { ok: true, stored }
  }
  const output = `${probe.stderr || ""}\n${probe.stdout || ""}\n${probe.err?.message || ""}`
  const authFailed = PROBE_AUTH_TALK.test(output)
  const networkFailed = !authFailed && (probe.timedOut || PROBE_NETWORK_TALK.test(output))
  const why = probe.timedOut
    ? "`agy models` timed out after 15s"
    : `\`agy models\` says: ${(probe.stderr || probe.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1) || probe.err?.message || `exit ${probe.code}`}`
  return { ok: false, why, stored, authFailed, networkFailed }
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000
const MODEL_CATALOG_FAST_WAIT_MS = 500
const MODEL_CATALOG_RETRY_MS = 5_000
let modelCatalogRefreshPromise = null
let cachedModelCatalog = fallbackModelCatalog()
// A caller lists models (provider.models), so a listing that lands asks agy
// acp what it offers right away, not on the next models() call (#1064).
let wantOfferedProbe = false

// Any additional model a live ACP session offers (via configOptions or
// models.availableModels) that `agy models` did not list is merged into the
// catalog as well.
let acpOfferedModels = null
let acpOfferedKey = ""

function offeredModelsOf(configOptions, models) {
  const out = []
  const option = configSelect(Array.isArray(configOptions) ? configOptions : [], "model")
  for (const value of selectValues(option?.options)) out.push({ id: value.value, name: value.name })
  for (const model of Array.isArray(models?.availableModels) ? models.availableModels : []) {
    const id = model?.modelId ?? model?.id
    if (typeof id === "string" && id) out.push({ id, name: model.name })
  }
  return out
}

function noteOfferedModels(configOptions, models) {
  const offered = offeredModelsOf(configOptions, models)
  if (!offered.length) return
  const names = new Map(offered.map(model => [model.id, typeof model.name === "string" && model.name ? model.name : model.id]))
  const key = [...names.keys()].sort().join("\n")
  if (key === acpOfferedKey) return
  acpOfferedModels = names
  acpOfferedKey = key
  if (cachedModelCatalog?.agyPath) saveCatalog(cachedModelCatalog.agyPath, { offered: [...names].map(([id, name]) => ({ id, name })) })
}

// A model the session offers that `agy models` did not list is served as is.
function withOffered(list) {
  if (!acpOfferedModels) return list
  const covered = new Set(list.flatMap(model => [model.id, modelFamilyId(model)]))
  return [...list, ...[...acpOfferedModels].filter(([id]) => !covered.has(id)).map(([id, name]) => ({
    id,
    name,
    effort: /-(high|medium|low|minimal|xhigh|max)$/i.exec(id)?.[1]?.toLowerCase(),
  }))]
}

let offeredProbePromise = null

function forgetOffered() {
  acpOfferedModels = null
  acpOfferedKey = ""
  offeredProbePromise = null
}

function catalogOf(entry) {
  if (entry.offeredKey !== acpOfferedKey || !entry.catalog) {
    entry.catalog = buildModelCatalog(withOffered(entry.list))
    entry.offeredKey = acpOfferedKey
  }
  return entry.catalog
}

function modelFamilyId(model) {
  if (!model.effort) return ""
  return model.id.slice(0, -(model.effort.length + 1))
}

function buildModelCatalog(list) {
  const rawIds = new Set(list.map(model => model.id))
  const families = new Map()
  for (const model of list) {
    const id = modelFamilyId(model)
    if (!id) continue
    if (!families.has(id)) families.set(id, [])
    families.get(id).push(model)
  }
  for (const [id, variants] of families) {
    const efforts = new Set(variants.map(model => model.effort))
    if (variants.length < 2 || efforts.size !== variants.length || rawIds.has(id)) {
      families.delete(id)
    }
  }

  const models = []
  const routes = new Map()
  const added = new Set()
  for (const model of list) {
    const id = modelFamilyId(model)
    const family = families.get(id)
    if (!family) {
      models.push(model)
      continue
    }
    if (added.has(id)) continue
    added.add(id)
    const sorted = [...family].sort((a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort))
    const efforts = sorted.map(variant => variant.effort)
    const byEffort = new Map(sorted.map(variant => [variant.effort, variant.id]))
    const defaultEffort = byEffort.has("high") ? "high" : efforts[efforts.length - 1]
    const defaultModel = sorted.find(variant => variant.effort === defaultEffort)
    const baseName = defaultModel.name.replace(/\s+\((?:minimal|low|medium|high|xhigh|max)\)$/i, "").trim()
    models.push({
      id,
      name: baseName && baseName !== defaultModel.id ? baseName : id,
      variants: efforts,
    })
    routes.set(id, { byEffort, efforts, defaultEffort })
  }
  // agy publishes only medium for this family, so the generic multi-variant
  // grouping above cannot supply its verified bare-name alias.
  if (rawIds.has("gpt-oss-120b-medium") && !rawIds.has("gpt-oss-120b") && !routes.has("gpt-oss-120b")) {
    models.push({ id: "gpt-oss-120b", name: "GPT-OSS 120B" })
    routes.set("gpt-oss-120b", {
      byEffort: new Map([["medium", "gpt-oss-120b-medium"]]),
      efforts: ["medium"],
      defaultEffort: "medium",
    })
  }
  return { models, routes, rawIds }
}

function fallbackModelCatalog(agyPath = null) {
  return { agyPath, list: FALLBACK_MODELS, catalog: null, offeredKey: null, isFallback: true, fetchedAt: 0, lastAttemptAt: null }
}

// The last list `agy models` gave, kept beside sessions.json per agy
// executable (#1086): after a restart the host lists it at once, instead of
// the Gemini-only fallback until agy answers again. It is served as stale
// (fetchedAt 0), so the first models() call still asks agy.
const SAVED_CATALOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

function modelCatalogFile() {
  return path.join(path.dirname(sessionStateFile()), "models.json")
}

function validModelRow(row) {
  return row && typeof row.id === "string" && /^\S+$/.test(row.id) && typeof row.name === "string" &&
    (row.effort === undefined || EFFORT_ORDER.includes(row.effort))
}

function readSavedCatalog(agyPath) {
  if (!agyPath) return null
  try {
    const data = JSON.parse(fs.readFileSync(modelCatalogFile(), "utf8"))
    const entry = data?.version === 1 && data.byAgy && Object.hasOwn(data.byAgy, agyPath) ? data.byAgy[agyPath] : null
    if (!entry || !Number.isFinite(entry.at) || Date.now() - entry.at > SAVED_CATALOG_MAX_AGE_MS) return null
    // A half-written or hand-edited file means "unknown": the fallback serves.
    if (!Array.isArray(entry.list) || !entry.list.length || !entry.list.every(validModelRow)) return null
    const offered = Array.isArray(entry.offered) && entry.offered.length &&
      entry.offered.every(row => validModelRow(row) && row.effort === undefined)
      ? entry.offered
      : null
    return { list: entry.list.map(savedRow), offered: offered && offered.map(({ id, name }) => ({ id, name })) }
  } catch {
    return null
  }
}

function savedRow({ id, name, effort }) {
  return effort ? { id, name, effort } : { id, name }
}

// saveCatalog merges what changed (the listing, or what agy acp offers) into
// the agy's entry.
function saveCatalog(agyPath, change) {
  if (!agyPath) return
  const file = modelCatalogFile()
  try {
    withStateLock(file, () => {
      let byAgy = {}
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"))
        if (data?.version === 1 && data.byAgy && typeof data.byAgy === "object") byAgy = data.byAgy
      } catch {}
      const entry = { ...(byAgy[agyPath] || {}), at: Date.now() }
      if (change.list) entry.list = change.list.map(savedRow)
      if (change.offered) entry.offered = change.offered
      if (!Array.isArray(entry.list)) return
      byAgy[agyPath] = entry
      const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ version: 1, byAgy }) + "\n", { mode: 0o600 })
      fs.renameSync(temp, file)
    })
  } catch {}
}

function startingModelCatalog(agyPath) {
  const saved = readSavedCatalog(agyPath)
  if (!saved) return fallbackModelCatalog(agyPath)
  // What agy acp offered last time, until a session of this run says.
  if (saved.offered && !acpOfferedModels) {
    acpOfferedModels = new Map(saved.offered.map(({ id, name }) => [id, name]))
    acpOfferedKey = [...acpOfferedModels.keys()].sort().join("\n")
  }
  return { agyPath, list: saved.list, catalog: null, offeredKey: null, isFallback: false, fetchedAt: 0, lastAttemptAt: null }
}

// useAgyPath starts over when the executable changes: an old executable's
// dynamic additions and offer must not route to, or list for, a new one.
function useAgyPath(agyPath) {
  if (cachedModelCatalog.agyPath === agyPath) return
  // The first agy this process finds is not a change of one.
  if (cachedModelCatalog.agyPath !== null) forgetOffered()
  cachedModelCatalog = startingModelCatalog(agyPath)
  modelCatalogRefreshPromise = null
}

function storeListedCatalog(agyPath, list, lastAttemptAt) {
  saveCatalog(agyPath, { list })
  cachedModelCatalog = {
    agyPath,
    list,
    catalog: null,
    offeredKey: null,
    isFallback: false,
    fetchedAt: Date.now(),
    lastAttemptAt,
  }
}

// catalogWarming is the background work that can still change what models()
// lists (the listing, then the session probe it starts), or null when there
// is none. Hosts that read the list once (OpenCode 2.x's adapter) read it
// again when this ends.
function catalogWarming() {
  if (!modelCatalogRefreshPromise && !offeredProbePromise) return null
  return (async () => {
    if (modelCatalogRefreshPromise) await modelCatalogRefreshPromise.catch(() => {})
    if (offeredProbePromise) await offeredProbePromise.catch(() => {})
    return true
  })()
}

// Magpie gives models() about two seconds, while `agy models` can take longer.
// Serve the last catalog (static until the first success), refresh it in the
// background at most once at a time, and wait for that refresh only briefly.
async function loadModelCatalog(agyPath) {
  useAgyPath(agyPath)
  const current = cachedModelCatalog
  if (!agyPath) return catalogOf(current)
  const now = Date.now()
  if (!current.isFallback && now - current.fetchedAt < MODEL_CATALOG_TTL_MS) return catalogOf(current)
  if (!modelCatalogRefreshPromise &&
      (current.lastAttemptAt === null || now - current.lastAttemptAt >= MODEL_CATALOG_RETRY_MS)) {
    current.lastAttemptAt = now
    const refresh = listAgyModels(agyPath).then((list) => {
      if (list?.length && cachedModelCatalog === current) {
        storeListedCatalog(agyPath, list, current.lastAttemptAt)
      }
    }).catch(() => {
      // Keep the last successful catalog, including dynamic-only models.
    }).finally(() => {
      if (modelCatalogRefreshPromise === refresh) modelCatalogRefreshPromise = null
    })
    modelCatalogRefreshPromise = refresh
  }
  if (modelCatalogRefreshPromise) {
    let timer
    try {
      await Promise.race([
        modelCatalogRefreshPromise,
        new Promise((resolve) => { timer = setTimeout(resolve, MODEL_CATALOG_FAST_WAIT_MS) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  return catalogOf(cachedModelCatalog)
}

function modelLimits(id) {
  const family = id.replace(/\[1m\]$/i, "").replace(/-(?:minimal|low|medium|high|xhigh|max)$/i, "")
  if (/^(?:gemini-4-argon|gemini-3\.8-flash)$/i.test(family)) return { context: 1048576, output: 65536 }
  // Gemini 4 Carbon (Ultra plans): the numbers Antigravity's own model list gives it
  if (/^gemini-4-carbon$/i.test(family)) return { context: 1048576, output: 262144 }
  if (/^claude-(?:opus|sonnet)-5-5$/i.test(family)) return { context: 1000000, output: 64000 }
  if (/^gpt-oss-120b$/i.test(family)) return { context: 131072, output: 32768 }
  return undefined
}

function maxInputTokens(model, rawModel = "") {
  if (Object.hasOwn(process.env, "AGY_BRIDGE_MAX_INPUT_TOKENS")) {
    const raw = Number(process.env.AGY_BRIDGE_MAX_INPUT_TOKENS)
    if (raw === 0) return 0
    if (Number.isFinite(raw) && raw > 0) return Math.round(raw)
  }
  const limits = modelLimits(model) || modelLimits(rawModel)
  if (limits) return Math.max(1, limits.context - Math.min(limits.output, 65536))
  if (/\[1m\]$/i.test(rawModel)) return 936_000
  return 0
}

// Anthropic wire format without `error.code`, so Claude Code's reactive
// compaction recognizer matches `prompt is too long: <actual> tokens > <limit> maximum`.
function promptTooLongResponse(actualTokens, limitTokens) {
  return jsonError(400, `prompt is too long: ${actualTokens} tokens > ${limitTokens} maximum`, undefined, { noRetry: true })
}

function normalizeEffort(value) {
  const direct = String(value || "").trim().toLowerCase()
  if (direct === "ultra") return "max"
  return EFFORT_ORDER.includes(direct) ? direct : ""
}

function requestedEffort(body) {
  const thinking = body.thinking?.type
  if (thinking === "disabled") return ""
  const generic = [body.reasoning_effort, body.reasoningEffort, body.reasoning?.effort,
    body.generationConfig?.thinkingConfig?.thinkingLevel].map(normalizeEffort).find(Boolean)
  if (generic) return generic
  if (thinking !== "enabled" && thinking !== "adaptive") return ""
  const direct = normalizeEffort(body.output_config?.effort)
  if (direct) return direct
  const budget = Number(body.thinking?.budget_tokens)
  if (!Number.isFinite(budget) || budget <= 0) return ""
  if (budget <= 4096) return "low"
  if (budget <= 12000) return "medium"
  if (budget <= 24000) return "high"
  return "xhigh"
}

function closestEffort(effort, efforts) {
  const target = EFFORT_ORDER.indexOf(effort)
  let best = efforts[0]
  for (const candidate of efforts.slice(1)) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - target)
    const bestDistance = Math.abs(EFFORT_ORDER.indexOf(best) - target)
    if (distance < bestDistance || distance === bestDistance && EFFORT_ORDER.indexOf(candidate) > EFFORT_ORDER.indexOf(best)) {
      best = candidate
    }
  }
  return best
}

function resolveCatalogAlias(catalog, model) {
  if (!model || catalog.routes.has(model) || catalog.rawIds?.has(model)) {
    return { id: model, inlineEffort: "" }
  }
  const undated = model.replace(/-\d{8}$/, "")
  if (catalog.routes.has(undated) || catalog.rawIds?.has(undated)) {
    return { id: undated, inlineEffort: "" }
  }
  const effortMatch = /^(.*)-(minimal|low|medium|high|xhigh|max)$/i.exec(undated)
  const base = effortMatch ? effortMatch[1] : undated
  const inlineEffort = effortMatch ? effortMatch[2].toLowerCase() : ""
  if (catalog.routes.has(base) || catalog.rawIds?.has(base)) {
    return { id: base, inlineEffort }
  }
  const routeKeys = [...catalog.routes.keys()]
  if (/^(?:gemini-[0-9.]+-flash(?:-lite)?|claude-(?:[0-9.-]+-)?haiku(?:-[0-9.-]+)?)$/i.test(base)) {
    const flashFamily = routeKeys.find((id) => /flash/i.test(id)) ||
      catalog.models.find((item) => /flash/i.test(item.id))?.id
    if (flashFamily) return { id: flashFamily, inlineEffort }
    const fallbackGemini = routeKeys.find((id) => /^gemini-/i.test(id))
    if (fallbackGemini) return { id: fallbackGemini, inlineEffort: inlineEffort || "low" }
  }
  if (/^gemini-[0-9.]+-(?:pro|ultra)(?:-[a-z0-9.]+)?$/i.test(base)) {
    const proFamily = (catalog.routes.has("gemini-4-argon") ? "gemini-4-argon" : null) ||
      routeKeys.find((id) => /^gemini-/i.test(id) && !/flash/i.test(id)) ||
      catalog.models.find((item) => /^gemini-/i.test(item.id) && !/flash/i.test(item.id))?.id
    if (proFamily) return { id: proFamily, inlineEffort }
  }
  if (/^claude-(?:[0-9.-]+-)?sonnet(?:-[0-9.-]+)?$/i.test(base)) {
    const sonnet = routeKeys.find((id) => /^claude-.*sonnet/i.test(id)) ||
      catalog.models.find((item) => /^claude-.*sonnet/i.test(item.id))?.id
    if (sonnet) return { id: sonnet, inlineEffort }
  }
  if (/^claude-(?:[0-9.-]+-)?opus(?:-[0-9.-]+)?(?:-thinking)?$/i.test(base)) {
    const opus = routeKeys.find((id) => /^claude-.*opus/i.test(id)) ||
      catalog.models.find((item) => /^claude-.*opus/i.test(item.id))?.id
    if (opus) return { id: opus, inlineEffort }
  }
  return { id: model, inlineEffort: "" }
}

function resolveAgyModel(catalog, model, body) {
  const { id: resolvedId, inlineEffort } = resolveCatalogAlias(catalog, model)
  const family = catalog.routes.get(resolvedId)
  if (!family) return resolvedId
  const requested = requestedEffort(body) || inlineEffort
  const effort = requested ? closestEffort(requested, family.efforts) : family.defaultEffort
  return family.byEffort.get(effort)
}

function selectValues(options) {
  return (Array.isArray(options) ? options : []).flatMap(option =>
    Array.isArray(option?.options) ? selectValues(option.options)
      : typeof option?.value === "string" ? [option] : [])
}

function configSelect(options, category) {
  return options.find(option => option?.type === "select" && option.category === category)
    || options.find(option => option?.type === "select" && option.id === category)
}

function configModelSelection(options, model, selection) {
  const config = configSelect(options, "model")
  if (!config) return null
  const values = selectValues(config.options)
  const requested = selection?.model || model
  const target = values.find(option => option.value === requested)
    || values.filter(option => model.startsWith(option.value + "-") &&
      EFFORT_ORDER.includes(model.slice(option.value.length + 1)))
      .sort((a, b) => b.value.length - a.value.length)[0]
  if (!target) return null
  const suffix = model.startsWith(target.value + "-") ? model.slice(target.value.length + 1) : ""
  return {
    config,
    value: target.value,
    // Explicit legacy IDs keep their level; grouped model requests can use
    // levels advertised by ACP even if `agy models` lacks those suffixes.
    effort: requested === target.value ? selection?.effort || suffix : suffix,
  }
}

class BusyError extends Error {
  constructor(message) {
    super(message)
    this.statusCode = 503
  }
}

class ConflictError extends Error {
  constructor(message, code) {
    super(message)
    this.statusCode = 400
    this.code = code
    this.noRetry = true
  }
}

class UnsupportedContent extends Error {
  constructor(what) {
    super(`agy bridge: ${what} is not supported`)
    this.statusCode = 400
  }
}

// An upstream failure inside a healthy agy session. The process keeps its
// conversation, so a client retry continues without replaying history.
class AgentTurnError extends Error {
  constructor(message, kind = "api_error", quotaKind = null) {
    super(message)
    this.kind = kind
    this.keepProcess = true
    this.quotaKind = quotaKind
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// agy connects to --ide-mcp-port by running `nc host port`. A private `nc`
// earlier in agy's PATH runs the bridge's stdio MCP server instead, so the
// connection is authenticated by the per-process token in its environment.
async function ensureShimDir() {
  // Another host's sweep can take a shared dir that sat unused for a week.
  if (shimDir && !shimDirOwned && !await isFileWithBytes(path.join(shimDir, "nc.exe"))) {
    shimDir = undefined
    shimDirPromise = null
  }
  if (shimDirPromise) return shimDirPromise
  shimDirPromise = (async () => {
    if (process.platform === "win32") {
      const shared = await windowsNcDir().catch(() => null)
      if (shared) {
        shimDir = shared
        return shared
      }
    }
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magpie-agy-bridge-bin-"))
    if (process.platform === "win32") {
      await fs.promises.writeFile(path.join(dir, "nc.cmd"),
        windowsMcpShim(process.execPath, MCP_SERVER_PATH))
    } else {
      await fs.promises.writeFile(path.join(dir, "nc"),
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(MCP_SERVER_PATH)}\n`, { mode: 0o700 })
    }
    shimDir = dir
    shimDirOwned = true
    return dir
  })()
  shimDirPromise.catch(() => { shimDirPromise = null })
  return shimDirPromise
}

// Windows: a dir holding only nc.exe, a GUI-subsystem build of mcp-server.mjs
// (see windowsNcBuild). It is named for the runtime and the server's source, so
// every session and every later host reuses it. One no host has started for a
// week is swept. null when the runtime can't build it.
const WINDOWS_NC_PREFIX = "magpie-agy-bridge-nc-"
const WINDOWS_NC_BUILD_PREFIX = "magpie-agy-bridge-ncbuild-"
const WINDOWS_NC_BUILD_TIMEOUT_MS = 120_000
// Each nc dir names the runtime that built it, so a build for a newer
// mcp-server.mjs drops the same runtime's older ones at once: each holds a
// whole Bun runtime (~115MB), and a week of plugin updates piles them up
// (#1097). Another runtime's dirs (another install) keep the week.
const WINDOWS_NC_RUNTIME_FILE = "runtime"

function asciiPath(value) {
  return /^[\x20-\x7e]*$/.test(String(value || ""))
}

async function isFileWithBytes(file) {
  try {
    const stat = await fs.promises.stat(file)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

async function windowsNcDir() {
  if (!windowsNcBuild(process.execPath, MCP_SERVER_PATH, "nc.exe")) return null
  const tmp = os.tmpdir()
  const source = await fs.promises.readFile(MCP_SERVER_PATH)
  const runtimeKey = createHash("sha256").update(String(process.execPath)).update("\0")
    .update(String(process.versions?.bun || "")).digest("hex").slice(0, 16)
  const key = createHash("sha256").update(String(process.execPath)).update("\0")
    .update(String(process.versions?.bun || "")).update("\0").update(source).digest("hex").slice(0, 16)
  const dir = path.join(tmp, WINDOWS_NC_PREFIX + key)
  const exe = path.join(dir, "nc.exe")
  if (await isFileWithBytes(exe)) {
    const now = new Date()
    await fs.promises.utimes(exe, now, now).catch(() => {})
    return dir
  }
  const build = await fs.promises.mkdtemp(path.join(tmp, WINDOWS_NC_BUILD_PREFIX))
  let copy = null
  let copyBase = null
  try {
    let runtime = process.execPath
    if (!asciiPath(runtime)) {
      // Bun's compile reads its own path one byte to one UTF-16 unit, so a
      // runtime under a non-ASCII folder (a Chinese user name) fails with
      // "failed to copy bun executable into temporary file: ENOENT" (#1097).
      // A copy of it in an ASCII-only folder builds the same nc.exe.
      const base = [tmp, process.env.PUBLIC, process.env.ProgramData]
        .find(dir => dir && asciiPath(dir))
      if (!base) return null
      copyBase = base
      copy = base === tmp ? build : await fs.promises.mkdtemp(path.join(base, WINDOWS_NC_BUILD_PREFIX))
      runtime = path.join(copy, path.win32.basename(process.execPath))
      await fs.promises.copyFile(process.execPath, runtime)
    }
    const spec = windowsNcBuild(runtime, MCP_SERVER_PATH, path.join(build, "nc.exe"))
    const { err, code, timedOut } = await execOnce(spec.file, spec.args, { cwd: build, timeoutMs: WINDOWS_NC_BUILD_TIMEOUT_MS })
    if (err || timedOut || code !== 0 || !await isFileWithBytes(path.join(build, "nc.exe"))) return null
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(path.join(dir, WINDOWS_NC_RUNTIME_FILE), runtimeKey).catch(() => {})
    try {
      await fs.promises.rename(path.join(build, "nc.exe"), exe)
    } catch (error) {
      // Another host built it at the same time; theirs is as good.
      if (!await isFileWithBytes(exe)) throw error
    }
  } finally {
    fs.promises.rm(build, { recursive: true, force: true }).catch(() => {})
    if (copy && copy !== build) fs.promises.rm(copy, { recursive: true, force: true }).catch(() => {})
  }
  sweepWindowsNcDirs(tmp, path.basename(dir), runtimeKey).catch(() => {})
  if (copyBase && copyBase !== tmp) sweepWindowsNcDirs(copyBase, path.basename(dir), runtimeKey).catch(() => {})
  return dir
}

// A build no host has started for a week (an older runtime or server), one
// this runtime built for an older server, or a build dir a killed host left
// half done. An nc.exe still running is locked, so its dir stays until a
// later sweep.
async function sweepWindowsNcDirs(tmp, keep, runtimeKey = "") {
  const now = Date.now()
  for (const name of await fs.promises.readdir(tmp)) {
    const shared = name.startsWith(WINDOWS_NC_PREFIX) && /^[0-9a-f]{16}$/.test(name.slice(WINDOWS_NC_PREFIX.length))
    const build = name.startsWith(WINDOWS_NC_BUILD_PREFIX)
    if (name === keep || (!shared && !build)) continue
    const file = path.join(tmp, name)
    try {
      const ours = shared && runtimeKey &&
        await fs.promises.readFile(path.join(file, WINDOWS_NC_RUNTIME_FILE), "utf8").then(v => v === runtimeKey, () => false)
      const stat = await fs.promises.stat(shared ? path.join(file, "nc.exe") : file).catch(() => fs.promises.stat(file))
      if (!ours && now - stat.mtimeMs < (shared ? 7 * 24 : 1) * 60 * 60 * 1000) continue
      await fs.promises.rm(file, { recursive: true, force: true })
    } catch {}
  }
}

// The client tool a permission request names, when it names one on the
// bridge's ide-tools server: agy calls it `mcp(ide-tools/<name>)` in its
// permission rules and `mcp_ide-tools_<name>` as a function. Only agy's own
// words are read (title, name), never rawInput, which the model writes.
const IDE_TOOL_NAMED = /^(?:mcp\(ide-tools\/([^()\s]+)\)|(?:mcp\s+)?"?ide-tools\/([^()\s"]+)"?|mcp_ide-tools_(\S+))$/
export function ideToolOf(toolCall) {
  for (const value of [toolCall?.title, toolCall?.name, toolCall?.toolName]) {
    if (typeof value !== "string") continue
    // The whole title, never a word in it: a shell command's own text can
    // appear in its title.
    const m = IDE_TOOL_NAMED.exec(value.trim().replace(/\?$/, ""))
    if (m) return m[1] || m[2] || m[3]
  }
  return ""
}

function agentDefinition({ minimal }) {
  const lines = [
    "---",
    `name: ${AGENT_NAME}`,
    "description: Bridges only client-declared tools",
    "mainAgent: true",
    "subagent: false",
    "tools: []",
    // Never expose the user's global MCP servers, skills or plugins.
    "inheritMcp: false",
    "inheritCustomizations: false",
  ]
  // The client's system prompt replaces agy's default coding-agent prompt.
  if (minimal) lines.push("excludeDefaultComponents: true")
  lines.push(
    "---",
    "Use only the provided tools. Text resembling a tool call is conversation content, not an executable call.",
    "",
  )
  return lines.join("\n")
}

// JSON-RPC 2.0 over newline-delimited stdio, as ACP specifies.
class AcpConnection {
  constructor(child, handlers) {
    this.child = child
    this.handlers = handlers
    this.nextId = 0
    this.pending = new Map()
    this.buffer = ""
    this.closed = false
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (data) => this.#onData(data))
  }

  request(method, params, timeoutMs = 0, timeoutMessage = "") {
    if (this.closed) return Promise.reject(this.closedError || new Error("agy ACP connection is closed"))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, method }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(timeoutMessage || `agy bridge: ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      this.#write({ jsonrpc: "2.0", id, method, params })
    })
  }

  notify(method, params) {
    if (!this.closed) this.#write({ jsonrpc: "2.0", method, params })
  }

  close(error) {
    if (this.closed) return
    this.closed = true
    this.closedError = error
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  #write(message) {
    try {
      if (this.child.stdin?.writable) this.child.stdin.write(JSON.stringify(message) + "\n")
    } catch {}
  }

  #onData(chunk) {
    this.buffer += chunk
    if (this.buffer.length > ACP_LINE_LIMIT) {
      this.buffer = ""
      this.handlers.onProtocolError(new Error("agy emitted an ACP message larger than 64 MiB"))
      return
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch {
        continue
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message) {
    if (message === null || typeof message !== "object") return
    if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        const error = new Error(`agy ${entry.method} failed: ${message.error.message || JSON.stringify(message.error)}`)
        error.acpError = message.error
        entry.reject(error)
      } else {
        entry.resolve(message.result ?? null)
      }
      return
    }
    if (typeof message.method !== "string") return
    if (!Object.hasOwn(message, "id")) {
      this.handlers.onNotification(message.method, message.params ?? {})
      return
    }
    Promise.resolve()
      .then(() => this.handlers.onRequest(message.method, message.params ?? {}))
      .then(
        (result) => this.#write({ jsonrpc: "2.0", id: message.id, result: result ?? null }),
        (error) => this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: error?.code ?? -32603, message: String(error?.message ?? error) },
        }),
      )
  }
}

class Turn {
  constructor(proc, messages) {
    this.proc = proc
    this.turnId = "turn_" + randomBytes(6).toString("hex")
    this.lastProgressAt = Date.now()
    this.clientProgressAt = this.lastProgressAt
    this.deadlineAt = null
    this.baseHistory = trailingMessages({ messages }).history.map((message) => ({ ...message }))
    this.events = []
    this.waiters = []
    this.calls = []
    this.awaitCalls = []
    this.lateWaiters = []
    this.attached = false
    this.done = false
    this.finalized = false
    this.cancelRequested = false
    this.steering = false
    this.promptInFlight = false
    this.activeAcpToolCalls = new Set()
    this.acpToolWaiters = []
    this.cancelledMcpSockets = new Set()
    this.agentError = false
    this.agentErrorMessage = ""
    this.heldText = ""
    this.heldTerminal = null
    this.emittedAnyText = false
    this.droppingRetryLine = false
    this.timer = null
    this.cleanupTimer = null
    this.logOffset = 0
    // One session/prompt can cover several HTTP responses (tool round-trips,
    // late tool results) while ACP reports a single accumulated usage for all
    // of them. These fields let each HTTP response settle its own share.
    this.stepInputEstimates = []
    this.responseSteps = []
    this.currentResponse = null
    this.pendingPromptStep = null
    this.promptCount = 0
    this.hasLatePrompt = false
    this.toolResponseCount = 0
    this.emittedOutputTokens = 0
    // Keep upstream objects untouched: response-window estimates are not a
    // separate, exact cost ledger for the accumulated ACP prompt usage.
    this.rawAcpUsages = []
    this.rawUsage = null
    // Set by Proc.startTurn: the agy model and its calibration family.
    this.model = ""
    this.family = "default"
    this.accountedPrompts = new Set()
    this.sawGenerationOutput = false
    let settle
    this.settled = new Promise((resolve) => { settle = resolve })
    this.settle = settle
  }

  registerResponse(body) {
    if (this.currentResponse) {
      this.currentResponse.body = null
      this.currentResponse.contentSnapshot = null
    }
    const estimate = this.proc.estimatePromptTokens(body)
    const pending = this.pendingPromptStep
    const step = {
      body,
      inputEstimate: estimate,
      estimateIndex: pending?.estimateIndex ?? this.stepInputEstimates.length,
      promptNumbers: pending?.promptNumbers || [],
      settled: false,
    }
    if (pending) {
      // A late prompt may start before the client attaches its next response.
      // That HTTP request describes the same model step, not another one.
      this.stepInputEstimates[step.estimateIndex] = Math.max(estimate, this.stepInputEstimates[step.estimateIndex])
      this.pendingPromptStep = null
    } else {
      this.stepInputEstimates.push(estimate)
    }
    this.responseSteps.push(step)
    this.currentResponse = step
    return step
  }

  beginPrompt(parts, lateCalls) {
    const number = ++this.promptCount
    const step = this.currentResponse
    if (number > 1) {
      this.hasLatePrompt = true
      const body = step?.body || { messages: this.baseHistory }
      const history = this.proc.expectedMessages || body.messages || this.baseHistory
      const content = step?.contentSnapshot?.() || []
      const results = extractToolResults(body)
      const alreadyInHistory = lateCalls?.length && lateCalls.every((call) =>
        results.some((block) => block.tool_use_id === call.id))
      const estimate = this.proc.estimatePromptTokens({
        ...body,
        messages: [
          ...history,
          ...(content.length ? [{ role: "assistant", content }] : []),
          ...(alreadyInHistory ? [] : [{ role: "user", content: parts }]),
        ],
      })
      if (step && !step.settled && !step.promptNumbers.length) {
        // This late prompt continues the newly registered HTTP step. Replace
        // its denominator entry rather than counting that model step twice.
        this.stepInputEstimates[step.estimateIndex] = estimate
      } else {
        const index = this.stepInputEstimates.push(estimate) - 1
        if (step && !step.settled) step.estimateIndex = index
        else this.pendingPromptStep = { estimateIndex: index, promptNumbers: [number] }
      }
    }
    if (step && !step.settled) step.promptNumbers.push(number)
    return number
  }

  recordPromptUsage(number, usage) {
    if (!this.accountedPrompts.has(number)) {
      this.accountedPrompts.add(number)
      this.rawAcpUsages.push(usage)
      this.rawUsage = addUsage(this.rawUsage, usage)
    }
    return this.rawUsage
  }

  recordResponseUsage(step, usage, final, calibrate = final) {
    if (step.settled) return
    step.settled = true
    step.usage = usage
    this.emittedOutputTokens = tokenCount(this.emittedOutputTokens + usage.output_tokens)
    if (!final) this.toolResponseCount++
    // Calibration is per model family (see calibrationFamily) and learns only
    // from measured upstream numbers (ACP result.usage or per-step gen_metadata).
    // An incremental ACP context_floor teaches nothing, whereas SQLite gen_metadata
    // under a clipped 112 KiB prompt still measures the real upstream cacheRatio
    // (while leaving tokenizer `scale` untouched).
    const hasGenRaw = Boolean(step.genRaw)
    if (!calibrate || (!final && !hasGenRaw) || (step.usageKind === "context_floor" && !hasGenRaw)) return
    const family = this.family || calibrationFamily(this.model)
    const previous = this.proc.calibration.get(family) || { scale: 1, cacheRatio: 0, at: 0 }
    const next = { ...previous }
    let changed = false
    const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    const estimate = this.stepInputEstimates[step.estimateIndex] || step.inputEstimate
    // Only a single-generation measurement (exact or gen_metadata) measures the
    // tokenizer; an accumulated ACP result.usage would drag the scale to its clamp.
    if ((step.usageKind === "exact" || step.usageKind === "gen_metadata") &&
      total > 0 && estimate > 0 && total >= 0.5 * estimate) {
      next.scale = Math.max(0.5, Math.min(1.5, total / estimate))
      changed = true
    }
    const raw = step.genRaw || this.rawUsage
    const input = tokenCount(raw?.inputTokens)
    const read = tokenCount(raw?.cachedReadTokens)
    const write = tokenCount(raw?.cachedWriteTokens)
    if (input + read > 0) {
      next.cacheRatio = Math.max(0, Math.min(1, read / (input + read + write)))
      changed = true
    }
    if (changed) this.proc.calibration.set(family, { ...next, at: Date.now() })
  }

  attach() {
    if (this.finalized) throw new BusyError("agy bridge: this response has already completed")
    if (this.attached) throw new BusyError("agy bridge: this conversation already has an active response")
    this.attached = true
    this.touchClient()
  }

  detach() {
    const wasAttached = this.attached
    this.attached = false
    if (wasAttached) this.touchClient()
  }

  touchClient() {
    this.clientProgressAt = Date.now()
    if (this.timer && !this.done && !this.finalized && this.hasPendingMcp()) this.rearm()
  }

  push(event) {
    if (this.finalized) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(event)
    else this.events.push(event)
  }

  // With a timeout or signal, resolves null when either fires first; the
  // waiter is removed again so a bounded wait never leaks into later pushes.
  next(timeoutMs = 0, signal) {
    if (this.events.length) return Promise.resolve(this.events.shift())
    if (this.finalized) return Promise.reject(new Error("agy bridge: response is closed"))
    if (signal?.aborted) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      let timer = null
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", expire)
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
      }
      const waiter = {
        resolve: (event) => { cleanup(); resolve(event) },
        reject: (error) => { cleanup(); reject(error) },
      }
      const expire = () => waiter.resolve(null)
      this.waiters.push(waiter)
      if (timeoutMs > 0) timer = setTimeout(expire, timeoutMs)
      signal?.addEventListener("abort", expire, { once: true })
    })
  }

  // Filters agy's in-band retry banners and withholds terminal error banners
  // until the prompt ends: agy's own error marker ends the prompt, whereas a
  // banner followed by normal text or a tool call was quoted by the model (#1052).
  pushText(chunk) {
    if (this.done || this.agentError || !chunk) return
    if (this.droppingRetryLine) {
      const nl = chunk.indexOf("\n")
      if (nl < 0) return
      this.droppingRetryLine = false
      chunk = chunk.slice(nl + 1)
      if (!chunk) return
    }
    let text = this.heldText + chunk
    this.heldText = ""
    const emitRaw = (part) => {
      if (!part) return
      this.emittedAnyText = true
      this.push({ type: "text", text: part })
    }
    const emit = (part) => {
      if (!part) return
      if (this.heldTerminal) {
        if (!/\S/.test(part)) {
          this.heldTerminal.raw += part
          return
        }
        const quoted = this.heldTerminal.raw
        this.heldTerminal = null
        emitRaw(quoted + part)
        return
      }
      emitRaw(part)
    }
    while (text) {
      let idx = -1
      let header = ""
      if (!this.emittedAnyText && !this.heldTerminal && text.startsWith("⚠ ")) {
        idx = 0
        header = "⚠ "
      } else {
        idx = text.indexOf("\n⚠ ")
        if (idx >= 0) header = "\n⚠ "
      }
      if (idx < 0) break
      if (idx > 0) emit(text.slice(0, idx))
      const rest = text.slice(idx)
      const body = rest.slice(header.length)
      const lineEnd = body.indexOf("\n")
      const line = lineEnd >= 0 ? body.slice(0, lineEnd) : body
      const isRetry = isAgentRetryLine(line)
      const isTerminal = !isRetry && AGENT_TERMINAL_ERROR_PREFIXES.some((prefix) => line.startsWith(prefix))
      const isPartial = lineEnd < 0 && !isRetry && !isTerminal &&
        AGENT_ALL_BANNER_PREFIXES.some((prefix) => prefix.startsWith(body))
      if (lineEnd < 0 && (isRetry || isTerminal || isPartial)) {
        if (rest.length < AGENT_BANNER_HOLD_LIMIT) {
          this.heldText = rest
          return
        }
        if (isRetry) {
          this.droppingRetryLine = true
          return
        }
        if (isTerminal) {
          if (this.heldTerminal) emitRaw(this.heldTerminal.raw)
          this.heldTerminal = { raw: rest, message: body.slice(0, 1000).trim() }
          return
        }
      }
      if (isRetry) {
        text = lineEnd >= 0 ? body.slice(lineEnd + 1) : ""
        continue
      }
      if (isTerminal) {
        if (this.heldTerminal) emitRaw(this.heldTerminal.raw)
        const consumed = lineEnd >= 0 ? header + line + "\n" : header + line
        this.heldTerminal = { raw: consumed, message: line.slice(0, 1000).trim() }
        text = lineEnd >= 0 ? body.slice(lineEnd + 1) : ""
        continue
      }
      emit(header)
      text = body
    }
    if (!text) return
    if (!this.emittedAnyText && !this.heldTerminal && text === "⚠") {
      this.heldText = text
      return
    }
    for (const prefix of ["\n⚠", "\n"]) {
      if (text.endsWith(prefix)) {
        emit(text.slice(0, -prefix.length))
        this.heldText = prefix
        return
      }
    }
    emit(text)
  }

  // Called when session/prompt finishes: a terminal banner still held at EOF
  // with no normal text after it was agy's own error banner.
  endText() {
    this.droppingRetryLine = false
    if (this.heldText && !this.agentError) {
      const rest = this.heldText
      this.heldText = ""
      const header = !this.emittedAnyText && !this.heldTerminal && rest.startsWith("⚠ ")
        ? "⚠ "
        : rest.startsWith("\n⚠ ") ? "\n⚠ " : ""
      if (header) {
        const body = rest.slice(header.length)
        if (!isAgentRetryLine(body)) {
          if (AGENT_TERMINAL_ERROR_PREFIXES.some((prefix) => body.startsWith(prefix))) {
            if (this.heldTerminal) {
              this.emittedAnyText = true
              this.push({ type: "text", text: this.heldTerminal.raw })
            }
            this.heldTerminal = { raw: rest, message: body.slice(0, 1000).trim() }
          } else {
            if (this.heldTerminal && /\S/.test(rest)) {
              this.emittedAnyText = true
              this.push({ type: "text", text: this.heldTerminal.raw + rest })
              this.heldTerminal = null
            } else if (this.heldTerminal) {
              this.heldTerminal.raw += rest
            } else {
              this.emittedAnyText = true
              this.push({ type: "text", text: rest })
            }
          }
        }
      } else if (this.heldTerminal) {
        if (/\S/.test(rest)) {
          this.emittedAnyText = true
          this.push({ type: "text", text: this.heldTerminal.raw + rest })
          this.heldTerminal = null
        } else {
          this.heldTerminal.raw += rest
        }
      } else {
        this.emittedAnyText = true
        this.push({ type: "text", text: rest })
      }
    } else {
      this.heldText = ""
    }
    if (this.heldTerminal && !this.agentError) {
      this.agentError = true
      this.agentErrorMessage = this.heldTerminal.message
      this.heldTerminal = null
    }
  }

  // Called before an MCP tool call: the turn is continuing, so any withheld
  // terminal banner was quoted by the model rather than ending the turn.
  flushText() {
    this.droppingRetryLine = false
    if (this.agentError) {
      this.heldText = ""
      this.heldTerminal = null
      return
    }
    if (this.heldTerminal) {
      this.emittedAnyText = true
      this.push({ type: "text", text: this.heldTerminal.raw })
      this.heldTerminal = null
    }
    if (!this.heldText) return
    const rest = this.heldText
    this.heldText = ""
    const header = !this.emittedAnyText && rest.startsWith("⚠ ")
      ? "⚠ "
      : rest.startsWith("\n⚠ ") ? "\n⚠ " : ""
    if (header && isAgentRetryLine(rest.slice(header.length))) return
    this.emittedAnyText = true
    this.push({ type: "text", text: rest })
  }

  complete(result) {
    if (this.done) return
    this.done = true
    clearTimeout(this.timer)
    this.notifyAcpTools()
    this.push({ type: "result", result })
  }

  fail(error) {
    if (this.done || this.finalized) return
    this.done = true
    clearTimeout(this.timer)
    this.notifyAcpTools()
    for (const waiter of this.lateWaiters.splice(0)) waiter.reject(error)
    this.push({ type: "error", error })
    clearTimeout(this.cleanupTimer)
    this.cleanupTimer = setTimeout(() => {
      this.proc.abandonTurn(this)
    }, idleMs())
    this.cleanupTimer.unref()
  }

  noteAcpToolUpdate(update) {
    const type = update?.sessionUpdate
    const id = update?.toolCallId
    if (!id) return
    if (type === "tool_call") {
      if (!update.status || update.status === "in_progress" || update.status === "pending") {
        this.activeAcpToolCalls.add(id)
      } else {
        this.activeAcpToolCalls.delete(id)
      }
      this.notifyAcpTools()
      return
    }
    if (type === "tool_call_update" && update.status &&
      update.status !== "in_progress" && update.status !== "pending") {
      this.activeAcpToolCalls.delete(id)
      this.notifyAcpTools()
    }
  }

  notifyAcpTools() {
    for (const check of [...this.acpToolWaiters]) check()
  }

  // Waits until agy finishes recording the MCP responses for `pendingIds`
  // (emits tool_call_update, moves on to generation, or closes the turn) so a
  // follow-up session/cancel does not abort an in-flight MCP tool execution.
  waitAcpToolsCommitted(pendingIds, timeoutMs) {
    const remaining = () => {
      if (this.done || this.finalized || this.sawGenerationOutput) return false
      for (const id of pendingIds) {
        if (this.activeAcpToolCalls.has(id)) return true
      }
      return false
    }
    if (!remaining()) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const idx = this.acpToolWaiters.indexOf(check)
        if (idx >= 0) this.acpToolWaiters.splice(idx, 1)
        resolve(ok)
      }
      const check = () => {
        if (!remaining()) finish(true)
      }
      const timer = setTimeout(() => finish(!remaining()), timeoutMs)
      timer.unref?.()
      this.acpToolWaiters.push(check)
    })
  }

  // True while the client still owes a result, including calls agy stopped waiting for.
  hasPendingMcp() {
    return this.calls.some((call) => (call.mcpSeen && !call.mcpResponded) || (call.deferred && !call.result))
  }

  waitLate() {
    if (!this.calls.some((call) => call.deferred && !call.result)) return Promise.resolve()
    return new Promise((resolve, reject) => this.lateWaiters.push({ resolve, reject }))
  }

  notifyLate() {
    if (this.calls.some((call) => call.deferred && !call.result)) return
    for (const waiter of this.lateWaiters.splice(0)) waiter.resolve()
  }

  // Inactivity timeout: agy output, or the client's tool result while one is pending.
  arm() {
    this.lastProgressAt = Date.now()
    this.rearm()
  }

  // Internal agy traffic cannot extend a detached client's tool wait window.
  rearm() {
    clearTimeout(this.timer)
    if (this.done || this.finalized) return
    const waitingForTools = this.hasPendingMcp()
    const timeout = waitingForTools ? TOOL_RESULT_TIMEOUT_MS : TURN_TIMEOUT_MS
    const now = Date.now()
    this.deadlineAt = (waitingForTools && !this.attached ? this.clientProgressAt : now) + timeout
    this.timer = setTimeout(() => {
      const what = waitingForTools ? "waiting for a client tool result" : "reading agy output"
      this.proc.timeoutTurn(this, new Error(
        `agy bridge: timed out ${what} after ${timeout}ms; stderr tail: ${this.proc.stderrTail.trim() || "(empty)"}`,
      ))
    }, Math.max(0, this.deadlineAt - now))
    this.timer.unref?.()
  }
}

class Proc {
  constructor(agyPath, convKey, opts) {
    this.agyPath = agyPath
    this.convKey = convKey
    this.model = opts.model
    this.selection = opts.selection
    this.tools = opts.tools
    // Key order of a client's tool schemas is not a catalog change.
    this.toolsSignature = stableJSON(opts.tools)
    this.workDir = opts.workDir
    this.instructions = opts.instructions || ""
    this.instructionsPlacement = opts.instructionsPlacement || instructionsPlacement(opts.model)
    this.userId = opts.userId || ""
    this.openingText = openingTextOf(opts.messages?.[0])
    this.openingImages = openingImagesOf(opts.messages?.[0])
    this.resumeFrom = opts.resume || null
    // Tokenizer scales survive a replacement process; cache ratios do not,
    // because a new upstream session starts cold.
    this.inheritedCalibration = opts.inheritCalibration || null
    this.token = randomUUID()
    this.sessionId = null
    this.lastGenIdx = -1
    this.currentModel = null
    this.agentVersion = null
    this.supportsImages = false
    // Per model family: { scale, cacheRatio, at }. The scale is learned from
    // exact single-model-call responses and sizes the local input estimate;
    // the cache ratio comes from measured ACP read/input/write counts.
    this.calibration = new Map()
    // How many input tokens the first prompt left out when it was clipped to
    // the 112 KiB replay budget, so later estimates are not inflated.
    this.omittedHistoryTokens = 0
    this.configOptions = []
    this.configMethodUnsupported = false
    this.currentSelectionKey = null
    this.instructionsInSession = false
    this.resumed = false
    this.child = null
    this.conn = null
    this.workspace = null
    this.logPath = null
    this.lastUsed = Date.now()
    this.dead = false
    this.deadError = null
    this.retiring = false
    this.stopping = false
    this.stopPromise = null
    this.stderrTail = ""
    this.hasSentFirstTurn = false
    this.historyInvalid = false
    this.unsentPrompt = null
    this.turn = null
    this.expectedMessages = null
    this.minimalAgent = null
    this.appDataDir = null
    this.conversationsDir = null
    this.account = currentAccountKey()
    this.accountGeneration = accountGeneration
    this.toolsVersion = 1
    this.listedVersion = 0
    this.listWaiters = []
    this.watchers = new Set()
    this.deniedPermissions = 0
    allProcs.add(this)
  }

  async start() {
    await ensureControlServer()
    const bin = await ensureShimDir()
    sessions.set(this.token, this)
    this.workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magpie-agy-bridge-"))
    // The switch shapes agent.md, so it is read at process start and applies
    // to newly started processes only.
    this.minimalAgent = hostOption("minimal_agent", "AGY_BRIDGE_MINIMAL_AGENT", true)
    this.appDataDir = bridgeAppDataDirName()
    this.conversationsDir = bridgeConversationsDir(this.appDataDir)
    if (this.appDataDir) syncBridgeTokenFile(this.appDataDir)
    const agentDir = path.join(this.workspace, ".agents", "agents", AGENT_NAME)
    await fs.promises.mkdir(agentDir, { recursive: true })
    await fs.promises.writeFile(path.join(agentDir, "agent.md"), agentDefinition({ minimal: this.minimalAgent }), { mode: 0o600 })
    this.logPath = path.join(this.workspace, "agy-acp.log")

    const args = [
      "acp",
      ...(this.appDataDir ? ["--app-data-dir", this.appDataDir] : []),
      "--agent", AGENT_NAME,
      "--log-file", this.logPath,
      "--ide-mcp-port", String(controlServer.address().port),
    ]
    if (this.workDir) args.push("--add-dir", this.workDir)
    try {
      const childEnv = { ...process.env }
      const inheritedPath = process.env.PATH || childEnv.Path || ""
      for (const key of Object.keys(childEnv)) {
        if (/^path$/i.test(key) && key !== "PATH") delete childEnv[key]
      }
      this.child = spawnAgy(this.agyPath, args, {
        cwd: this.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...childEnv,
          PATH: bin + path.delimiter + inheritedPath,
          AGY_BRIDGE_CONTROL_PORT: String(controlServer.address().port),
          AGY_BRIDGE_TOKEN: this.token,
          AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        },
      })
    } catch (error) {
      this.#markDead(error)
      throw error
    }
    this.child.on("error", (error) => this.#markDead(error))
    this.child.on("close", (code, signal) => {
      if (!this.dead) {
        const detail = this.stderrTail.trim()
        this.#markDead(new Error(`agy exited (code=${code} signal=${signal})${detail ? ": " + detail.slice(-1000) : ""}`))
      }
    })
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (data) => {
      this.stderrTail = (this.stderrTail + data).slice(-STDERR_TAIL)
    })
    this.child.stdin.on("error", () => {})
    this.conn = new AcpConnection(this.child, {
      onNotification: (method, params) => this.#onNotification(method, params),
      onRequest: (method, params) => this.#onRequest(method, params),
      onProtocolError: (error) => this.fail(error),
    })

    const timeoutMs = configuredTimeout("AGY_BRIDGE_START_TIMEOUT_MS", DEFAULT_PROC_START_TIMEOUT_MS)
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        `agy bridge: timed out starting agy acp after ${timeoutMs}ms; stderr tail: ${this.stderrTail.trim() || "(empty)"}`,
      )), timeoutMs)
    })
    try {
      await Promise.race([this.#handshake(), timeout])
      if (this.appDataDir) syncBridgeTokenFile(this.appDataDir)
      if (autoSwitchEnabled()) captureCurrent({ home: os.homedir(), vaultDir: defaultVaultDir() })
    } catch (error) {
      if (this.dead && this.deadError && error !== this.deadError && !/timed out starting/.test(error.message)) {
        throw new Error(`agy failed before the ACP session started: ${this.deadError.message}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async #handshake() {
    const init = await this.conn.request("initialize", {
      protocolVersion: 1,
      // agy offers non-Gemini models only to allowlisted ACP clients.
      clientInfo: { name: "zed", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    this.agentVersion = init?.agentInfo?.version ?? null
    const tooOld = agyTooOld(this.agentVersion)
    if (tooOld) throw new Error(tooOld)
    const capabilities = init?.agentCapabilities ?? {}
    this.supportsImages = capabilities.promptCapabilities?.image === true ||
      capabilities.prompt_capabilities?.image === true
    const appendable = capabilities._meta?.antigravity?.systemPrompt?.append === true
    const resumable = !!(capabilities.sessionCapabilities?.resume ?? capabilities.session_capabilities?.resume)
    // Only Gemini sessions take the client system prompt as a session-level
    // append; other families get it inline in the first prompt (instructionsPlacement).
    const placement = this.instructionsPlacement
    this.instructionsInSession = appendable && !!this.instructions && placement === "session"
    const appendMeta = this.instructionsInSession
      ? { _meta: { antigravity: { systemPrompt: { append: outgoing(this.instructions) } } } }
      : {}

    let session = null
    if (this.resumeFrom && resumable) {
      // An inline session already carries its instructions in its history.
      const resumeInSession = this.instructionsInSession && this.resumeFrom.instructionsInSession !== false
      try {
        session = await this.conn.request("session/resume", {
          sessionId: this.resumeFrom.sessionId,
          cwd: this.workspace,
          mcpServers: [],
          ...(resumeInSession ? appendMeta : {}),
        })
        if (!session || typeof session !== "object") throw new Error("empty session/resume result")
        this.sessionId = this.resumeFrom.sessionId
        this.resumed = true
        this.hasSentFirstTurn = true
        this.instructionsInSession = resumeInSession
        this.expectedMessages = this.resumeFrom.expectedMessages.map((message) => ({ ...message }))
        consumeParked(this.resumeFrom.key, this.resumeFrom.sessionId)
        restoreCalibration(this, this.resumeFrom.calibration, true)
        syncGenCursor(this)
      } catch (error) {
        session = null
        const reason = resumeFailureReason(error, this)
        // Only a session agy says is gone is dropped; a timeout, a crash or any
        // other transient failure keeps the record for a later attempt.
        if (reason === "session_gone") consumeParked(this.resumeFrom.key, this.resumeFrom.sessionId)
        logBridgeEvent(this, null, "resume_failed", reason, { convKey: this.convKey })
      }
    }
    if (!this.resumed) {
      this.instructionsInSession = appendable && !!this.instructions && placement === "session"
      session = await this.conn.request("session/new", {
        cwd: this.workspace, mcpServers: [], ...(this.instructionsInSession ? appendMeta : {}),
      })
      if (!session?.sessionId) throw new Error("agy session/new returned no sessionId")
      this.sessionId = session.sessionId
      restoreCalibration(this, this.inheritedCalibration || this.resumeFrom?.calibration, false)
    }
    this.resumeFrom = null
    this.inheritedCalibration = null
    // A resumed session reports the account default; always apply the selection.
    this.currentModel = session?.models?.currentModelId ?? null
    this.configOptions = Array.isArray(session?.configOptions) ? session.configOptions : []
    noteOfferedModels(this.configOptions, session?.models)
    if (this.model) await this.#setModel(this.model, this.selection, this.resumed)
    if (this.tools.length) await this.#waitForToolList(this.toolsVersion)
  }

  async #setConfig(config, value) {
    const result = await this.conn.request("session/set_config_option", {
      sessionId: this.sessionId, configId: config.id, value,
    })
    if (!Array.isArray(result?.configOptions)) throw new Error("agy returned no configOptions after setting a session option")
    this.configOptions = result.configOptions
    const updated = this.configOptions.find(option => option.id === config.id)
    if (updated?.currentValue !== value) throw new Error(`agy did not apply session option ${config.id}`)
  }

  async #setModel(model, selection, force = false) {
    const selectionKey = stableJSON({ model, selection })
    if (!force && this.currentSelectionKey === selectionKey) return
    try {
      let configured = false
      const target = this.configMethodUnsupported ? null : configModelSelection(this.configOptions, model, selection)
      if (target) {
        try {
          if (force || target.config.currentValue !== target.value) await this.#setConfig(target.config, target.value)
          // A model change can replace the thinking options and their values.
          const thought = configSelect(this.configOptions, "thought_level")
          const levels = selectValues(thought?.options).map(option => option.value).filter(value => EFFORT_ORDER.includes(value))
          if (target.effort && levels.length) {
            const level = closestEffort(target.effort, levels)
            if (force || thought.currentValue !== level) await this.#setConfig(thought, level)
            configured = true
          } else {
            // A standalone model is fully selected by its advertised value.
            // A separate legacy level still needs the old model-ID route.
            configured = !target.effort || target.value === model
          }
        } catch (error) {
          if (error.acpError?.code !== -32601) throw error
          this.configMethodUnsupported = true
        }
      }
      if (!configured && (force || model !== this.currentModel || target)) {
        await this.conn.request("session/set_model", { sessionId: this.sessionId, modelId: model }, 30_000)
      }
    } catch (error) {
      const wrapped = new Error(`agy bridge: model ${model} is unavailable to this agy account: ${error.message}`)
      wrapped.statusCode = 400
      throw wrapped
    }
    this.currentModel = model
    this.currentSelectionKey = selectionKey
  }

  #waitForToolList(version) {
    if (this.listedVersion >= version || this.dead) return Promise.resolve()
    return new Promise((resolve) => {
      const waiter = { version, resolve, timer: null }
      waiter.timer = setTimeout(() => {
        this.listWaiters = this.listWaiters.filter((item) => item !== waiter)
        resolve()
      }, TOOL_LIST_WAIT_MS)
      this.listWaiters.push(waiter)
    })
  }

  listTools() {
    this.listedVersion = Math.max(this.listedVersion, this.toolsVersion)
    for (const waiter of this.listWaiters.filter((item) => item.version <= this.listedVersion)) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    this.listWaiters = this.listWaiters.filter((item) => item.version > this.listedVersion)
    // agy loads an MCP tool on demand, out of the model's function list, unless
    // the server marks it always loaded; tools with larger schemas were left out
    // and the model could not reach them (#989). Every client-declared tool is
    // one the client means the model to see.
    return this.tools.map((tool) => ({ ...tool, _meta: { ...tool._meta, [ALWAYS_LOAD]: true } }))
  }

  addWatcher(socket) {
    this.watchers.add(socket)
    socket.once("close", () => this.watchers.delete(socket))
  }

  // Whether the client now declares a tool agy has not listed. agy checks a
  // call against the tools it listed before the prompt began, so a tool added
  // mid-turn (ToolSearch) stays unknown until the next session/prompt (#942).
  toolsGrew(tools) {
    const known = new Set(this.tools.map((tool) => tool.name))
    return tools.some((tool) => !known.has(tool.name))
  }

  // Swap the client tool catalog in place; agy re-lists on tools/list_changed.
  async updateTools(tools) {
    // Same catalog up to key order: keep the original objects so agy's next
    // tools/list returns the same bytes and no tools_changed is announced.
    const signature = stableJSON(tools)
    if (signature === this.toolsSignature) return
    this.tools = tools
    this.toolsSignature = signature
    await this.#announceTools()
  }

  async #announceTools() {
    const version = ++this.toolsVersion
    if (!this.watchers.size) return
    for (const socket of this.watchers) {
      try { socket.write(JSON.stringify({ event: "tools_changed" }) + "\n") } catch {}
    }
    await this.#waitForToolList(version)
  }

  #onRequest(method, params) {
    if (params?.sessionId && params.sessionId !== this.sessionId) {
      throw Object.assign(new Error("unknown session"), { code: -32602 })
    }
    if (method === "session/request_permission") {
      // A client tool reaches agy through the bridge's own ide-tools MCP
      // server and runs in the client, under the client's own permissions.
      // Newer agy asks before an MCP call too (plugins #1082), so a request
      // that names ide-tools and a tool the client declared is allowed once.
      // Anything that would run inside agy itself (shell, file edits,
      // questions, browser) is denied.
      const tool = ideToolOf(params?.toolCall)
      if (tool && this.tools.some((t) => t.name === tool)) {
        const allow = (params?.options || []).find((option) => option?.kind === "allow_once")
        if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } }
      }
      this.deniedPermissions++
      const reject = (params?.options || []).find((option) => option?.kind === "reject_once")
        || (params?.options || []).find((option) => option?.kind === "reject_always")
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } }
    }
    throw Object.assign(new Error(`agy bridge does not serve ${method}`), { code: -32601 })
  }

  #onNotification(method, params) {
    if (method !== "session/update" || params?.sessionId !== this.sessionId) return
    if (params.update?.sessionUpdate === "config_option_update" && Array.isArray(params.update.configOptions)) {
      this.configOptions = params.update.configOptions
      noteOfferedModels(this.configOptions, null)
      this.currentSelectionKey = null
      return
    }
    const turn = this.turn
    if (!turn || turn.done || turn.finalized) return
    const update = params.update ?? {}
    turn.arm()
    turn.noteAcpToolUpdate(update)
    if (turn.cancelRequested) return
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = update.content?.type === "text" ? update.content.text : ""
      if (text) {
        turn.sawGenerationOutput = true
        if (turn.steering) {
          turn.notifyAcpTools()
          return
        }
        turn.pushText(text)
      }
    } else if (update.sessionUpdate === "agent_thought_chunk") {
      const text = update.content?.type === "text" ? update.content.text : ""
      if (text) {
        turn.sawGenerationOutput = true
        if (turn.steering) {
          turn.notifyAcpTools()
          return
        }
        turn.push({ type: "thinking", text })
      }
    }
  }

  estimatePromptTokens(body) {
    return Math.max(1, estimateInputTokens(body) - this.omittedHistoryTokens)
  }

  startTurn(content, messages, model, selection) {
    if (this.dead) throw this.deadError
    if (this.retiring) throw new BusyError("agy bridge: this conversation's process is being retired")
    if (this.turn) throw new BusyError("agy bridge: this conversation still has an unfinished response")
    if (content.some(block => block.type === "image") && !this.supportsImages) {
      throw new UnsupportedContent("image input with this agy ACP server; update to an image-capable agy version")
    }
    syncGenCursor(this)
    const turn = new Turn(this, messages)
    // Settlement and calibration of this turn belong to the model it runs on.
    turn.model = model || this.currentModel || this.model || ""
    turn.family = calibrationFamily(turn.model)
    this.turn = turn
    this.expectedMessages = messages.map((message) => ({ ...message }))
    this.historyInvalid = false
    this.lastUsed = Date.now()
    this.#runTurn(turn, content, model, selection).catch(() => {})
    return turn
  }

  matchesHistory(messages) {
    if (this.historyInvalid) return false
    if (this.expectedMessages == null) return !this.turn && !this.hasSentFirstTurn
    if (historyKey(this.expectedMessages) === historyKey(messages)) return true
    // Clients such as Claude Code canonicalize tool_use.input when they
    // persist history (e.g. filling default replace_all: false). The live
    // session still has the model-issued arguments. historyKey already
    // ordinalizes tool ids, so this loose path (reached only after an exact
    // historyKey miss) requires the raw tool_use id+name sequence to line
    // up before ignoring input values. An exact match can still succeed if
    // only ids changed and inputs did not.
    return sameToolUseIdentities(this.expectedMessages, messages) &&
      historyKey(stripToolUseInputs(this.expectedMessages)) ===
        historyKey(stripToolUseInputs(messages))
  }

  // Clients such as Claude Code normalize tool_use inputs when recording an
  // assistant message (e.g. filling default replace_all: false on Edit or
  // stripping a redundant cd prefix on Bash). When the pending turn's exact
  // CSPRNG toolu_ IDs and tool names match, allow canonicalized tool_use.input
  // without tearing down the live ACP session.
  matchesPendingTurnHistory(turn, history) {
    if (this.matchesHistory(history)) return true
    if (this.historyInvalid || !turn || this.turn !== turn || !Array.isArray(this.expectedMessages)) return false
    let split = history.length
    while (split > 0 && history[split - 1].role === "assistant") split--
    let expectedSplit = this.expectedMessages.length
    while (expectedSplit > 0 && this.expectedMessages[expectedSplit - 1].role === "assistant") expectedSplit--
    if (historyKey(this.expectedMessages.slice(0, expectedSplit)) !== historyKey(history.slice(0, split))) return false
    const actualAssistant = history.slice(split)
    const expectedAssistant = this.expectedMessages.slice(expectedSplit)
    const actualCalls = lastAssistantCalls(actualAssistant)
    const expectedCalls = lastAssistantCalls(expectedAssistant)
    if (!actualCalls.length || actualCalls.length !== expectedCalls.length) return false
    if (actualCalls.some((call, index) =>
      !call.id || call.id !== expectedCalls[index].id || call.name !== expectedCalls[index].name)) {
      return false
    }
    return historyKey(stripToolUseInputs(expectedAssistant)) === historyKey(stripToolUseInputs(actualAssistant))
  }

  // Answers the pending calls with the results the client sent, waits for agy
  // to commit those MCP responses before cancelling what it would do next, and
  // leaves the session at `history`, ready for the steer's prompt. False when
  // anything is off; the caller then replays in a new session, as before.
  async steerInSession(turn, results, history) {
    if (this.dead || this.stopping || this.retiring || this.turn !== turn || turn.steering || turn.done ||
      turn.finalized || !Array.isArray(history)) return false
    // An image in a result is replayed in the prompt, as before.
    if (results.some((item) => item.result.content.some((part) => part.type !== "text"))) return false
    const deliveringLiveMcp = results.some(({ call }) =>
      (!call.deferred && !call.mcpResponded && call.ready && !turn.done) ||
      (call.deferred && !call.result && turn.awaitCalls.some((waiter) => waiter.target === call)))
    // ACP toolCallIds come from agy's session/update notifications and are
    // distinct from the bridge's toolu_ IDs, so snapshot all in-flight ACP IDs.
    const pendingAcpIds = deliveringLiveMcp ? new Set(turn.activeAcpToolCalls) : new Set()
    turn.steering = true
    try {
      this.continueWith(results)
    } catch {
      turn.steering = false
      return false
    }
    if (pendingAcpIds.size && !(await turn.waitAcpToolsCommitted(pendingAcpIds, mcpCommitWaitMs()))) {
      return false
    }
    if (this.dead || this.stopping || this.retiring) return false
    if (!turn.done && !turn.finalized && !this.cancelTurn(turn, [])) return false
    await Promise.race([turn.settled, new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_MS))])
    if (turn.done && !turn.finalized) this.finalizeTurn(turn)
    if (!turn.finalized || this.dead || this.stopping || this.historyInvalid || this.turn) return false
    this.expectedMessages = history.map((message) => ({ ...message }))
    return true
  }

  recordToolResults(turn, messages) {
    if (this.turn === turn) this.expectedMessages = messages.map((message) => ({ ...message }))
  }

  recordAssistantResponse(turn, content) {
    if (this.turn === turn && this.expectedMessages) {
      this.expectedMessages.push({ role: "assistant", content })
    }
  }

  async #runTurn(turn, content, model, selection) {
    try {
      turn.arm()
      if (model) await this.#setModel(model, selection)
      // Content a cancelled turn never delivered still belongs to the session.
      let promptParts = mergePromptParts(this.unsentPrompt, toPromptParts(content))
      this.unsentPrompt = null
      let usage = null
      let lateCalls = null
      for (;;) {
        turn.logOffset = await fileSize(this.logPath)
        // A cancel that arrived before the prompt would be ignored by agy.
        if (turn.cancelRequested) {
          if (this.hasSentFirstTurn) this.unsentPrompt = promptParts
          else this.expectedMessages = null
          turn.complete({ stopReason: "cancelled" })
          return
        }
        turn.arm()
        unpark(this.convKey, this.account)
        const promptNumber = turn.beginPrompt(promptParts, lateCalls)
        turn.promptInFlight = true
        let promptSent = false
        let result
        try {
          promptSent = true
          result = await this.conn.request("session/prompt", {
            sessionId: this.sessionId,
            prompt: promptParts.length ? promptParts : [{ type: "text", text: "" }],
          })
        } catch (error) {
          if (promptSent && turn.cancelRequested && !this.dead) this.hasSentFirstTurn = true
          throw error
        } finally {
          turn.promptInFlight = false
        }
        usage = turn.recordPromptUsage(promptNumber, result?.usage)
        if (turn.cancelRequested) {
          this.hasSentFirstTurn = true
          turn.complete({ stopReason: "cancelled" })
          return
        }
        turn.endText()
        if (turn.agentError) {
          throw await this.#agentError(turn)
        }
        if (result?.stopReason === "refusal") {
          const detail = await lastAgentError(this.logPath, turn.logOffset)
          if (detail) throw this.#formatAgentError(detail)
        }
        this.hasSentFirstTurn = true
        // agy ended the turn without waiting for a long-running client tool:
        // deliver its real result in a follow-up prompt of the same response.
        const late = turn.calls.filter((call) => call.deferred && !call.lateDelivered)
        if (!late.length) {
          if (isDead(storedSignInNow())) forgetStoredSignIn({ dead: true })
          turn.complete({ ...(result ?? {}), usage })
          return
        }
        turn.arm()
        await turn.waitLate()
        for (const call of late) call.lateDelivered = true
        promptParts = renderLateResultParts(late, this.supportsImages)
        lateCalls = late
      }
    } catch (error) {
      if (turn.cancelRequested && !this.dead) {
        if (!this.hasSentFirstTurn) this.expectedMessages = null
        turn.complete({ stopReason: "cancelled" })
        return
      }
      if (error instanceof AgentTurnError && !this.dead && !turn.calls.length) {
        // agy kept the session; a retry of the same request continues in it.
        this.expectedMessages = this.hasSentFirstTurn ? turn.baseHistory : null
        turn.fail(error)
        return
      }
      turn.fail(error)
      dropFromPool(this)
      await this.stop().catch(() => {})
    } finally {
      clearTimeout(turn.timer)
      this.lastUsed = Date.now()
      turn.settle()
      if (turn.cancelRequested) this.finalizeTurn(turn)
    }
  }

  async #agentError(turn) {
    const detail = await lastAgentError(this.logPath, turn.logOffset)
    return this.#formatAgentError(detail, turn.agentErrorMessage)
  }

  #formatAgentError(detail, markerMessage = "") {
    const summary = detail || markerMessage || ""
    const combined = [detail, markerMessage].filter(Boolean).join("\n")
    // The system prompt turned away, not a quota (cloak.mjs): a 400 the next
    // member of a group is asked after, and the client doesn't retry. It says
    // what Antigravity answered (a 429).
    if (/code 429\b/i.test(combined) && /resource has been exhausted/i.test(combined) &&
      turnsAway(this.instructions, extraCloakLines())) {
      return new AgentTurnError(
        `agy bridge: Antigravity answered 429 to this system prompt: ${summary} — ${hint(this.instructions)}`,
        "invalid_request_error",
      )
    }
    if (/QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED|RATE_LIMIT_EXCEEDED|code 429\b|exhausted your quota|experiencing high traffic|currently overloaded/i.test(combined)) {
      return new AgentTurnError(
        `agy bridge: Antigravity quota or rate limit reached${summary ? ": " + summary : ""}`,
        "rate_limit_error",
        /MODEL_CAPACITY_EXHAUSTED|experiencing high traffic|currently overloaded/i.test(combined) ? "capacity" :
          /\b(?:QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED)\b|exhausted your quota/i.test(combined) ? "account" : null,
      )
    }
    const error = new AgentTurnError(`agy bridge: agy stopped the turn because of an error${summary ? ": " + summary : ""}`)
    error.authenticationFailed = /\bUNAUTHENTICATED\b|\binvalid_grant\b|refresh token (?:has )?(?:expired|revoked)|login required|authentication expired/i.test(combined)
    return error
  }

  // Cancel a turn the client stopped reading. The session stays usable; the
  // partial answer the client saw becomes part of the expected history.
  cancelTurn(turn, partialContent) {
    if (turn.cancelRequested || turn.done || turn.finalized) return false
    if (turn.hasPendingMcp() || this.dead) return false
    turn.cancelRequested = true
    turn.detach()
    if (this.expectedMessages && partialContent.length) {
      this.expectedMessages.push({ role: "assistant", content: partialContent })
    }
    this.conn.notify("session/cancel", { sessionId: this.sessionId })
    const timer = setTimeout(() => {
      if (!turn.finalized) {
        dropFromPool(this)
        this.stop().catch(() => {})
      }
    }, CANCEL_SETTLE_MS)
    timer.unref?.()
    turn.settled.then(() => clearTimeout(timer))
    return true
  }

  timeoutTurn(turn, error) {
    if (this.turn !== turn || turn.done) return
    turn.fail(error)
    dropFromPool(this)
    this.stop().catch(() => {})
  }

  acceptMcpCall(message, socket) {
    const turn = this.turn
    if (!turn || turn.done || turn.finalized) {
      throw new Error("agy bridge: no active turn for MCP call")
    }
    if (turn.cancelRequested || turn.steering) {
      // Hold any trailing sibling MCP call quiet while session/cancel is on its
      // way so agy aborts it via cancellation instead of advancing to a new step.
      turn.cancelledMcpSockets.add(socket)
      socket.once("close", () => turn.cancelledMcpSockets.delete(socket))
      return null
    }
    if (!turn.promptInFlight) {
      throw new Error("agy bridge: no prompt in flight for MCP call")
    }
    const name = message.name
    const args = message.arguments ?? {}
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("agy bridge: invalid tool arguments")
    if (!this.tools.some((tool) => tool.name === name)) throw new Error(`agy bridge: undeclared tool ${name}`)
    const signature = stableJSON(args)
    const running = turn.calls.find((call) => call.deferred && !call.lateDelivered &&
      call.name === name && stableJSON(call.arguments) === signature)
    if (running) return this.#acceptWait(turn, running, socket)
    const call = {
      id: "toolu_" + randomUUID().replace(/-/g, "").slice(0, 24),
      name,
      arguments: args,
      mcpSeen: true,
      mcpResponded: false,
      ready: true,
      socket,
      result: null,
      resultDigest: null,
      deferred: false,
      lateDelivered: false,
      deadline: null,
      stillRunning: 0,
      clientSeen: false,
    }
    turn.flushText()
    turn.calls.push(call)
    toolCalls.set(call.id, { proc: this, turn, call })
    socket.once("close", () => {
      if (!call.mcpResponded && !this.stopping) {
        turn.fail(new Error(`agy bridge: MCP helper disconnected during ${name}`))
        dropFromPool(this)
        this.stop().catch(() => {})
      }
    })
    call.deadline = setTimeout(() => { this.#deferCall(turn, call).catch(() => {}) }, ideCallDeadline())
    call.deadline.unref?.()
    turn.push({ type: "tool", call })
    turn.arm()
    return call
  }

  // Answer agy before its MCP deadline; the real result follows on a repeat call.
  async #deferCall(turn, call) {
    if (call.mcpResponded || call.result || turn.done || turn.finalized) return
    call.deferred = true
    call.stillRunning++
    this.#respondMcp(call, { result: { content: [{ type: "text", text: stillRunningText(call) }], isError: false } })
  }

  #selfPollCapped(turn, target) {
    return !turn.attached && !turn.calls.some((call) => call.clientSeen) && (
      Date.now() - turn.clientProgressAt >= SELF_POLL_IDLE_TIMEOUT_MS || target.stillRunning >= SELF_POLL_LIMIT
    )
  }

  #capSelfPoll(turn, target, reply) {
    reply({ content: [{ type: "text", text: SELF_POLL_NOTE }], isError: true })
    logBridgeEvent(this, turn, "reclaim", "self_poll_cap", {}, { self_poll_repeats: target.stillRunning })
    reclaimStaleTurn(this, turn, SELF_POLL_NOTE).catch(() => {})
  }

  // A repeat waits for the original result, without renewing the client clock.
  #acceptWait(turn, target, socket) {
    const reply = (result) => {
      try { socket.end(JSON.stringify({ result }) + "\n") } catch {}
    }
    if (target.result) {
      target.lateDelivered = true
      reply(target.result)
      return null
    }
    if (this.#selfPollCapped(turn, target)) {
      this.#capSelfPoll(turn, target, reply)
      return null
    }
    const waiter = { socket, target, reply, timer: null }
    waiter.timer = setTimeout(() => {
      turn.awaitCalls = turn.awaitCalls.filter((item) => item !== waiter)
      target.stillRunning++
      reply({ content: [{ type: "text", text: stillRunningText(target) }], isError: false })
    }, ideCallDeadline())
    waiter.timer.unref?.()
    turn.awaitCalls.push(waiter)
    socket.once("close", () => {
      clearTimeout(waiter.timer)
      turn.awaitCalls = turn.awaitCalls.filter((item) => item !== waiter)
    })
    return null
  }

  #deliverLate(turn, call) {
    const waiters = turn.awaitCalls.filter((item) => item.target === call)
    if (waiters.length) {
      turn.awaitCalls = turn.awaitCalls.filter((item) => item.target !== call)
      call.lateDelivered = true
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reply(call.result)
      }
    }
    turn.notifyLate()
  }

  validateResults(results) {
    const unique = new Map()
    for (const item of results) {
      const id = item.block.tool_use_id
      const serialized = JSON.stringify(item.result)
      const resultDigest = digest(serialized)
      const previous = unique.get(id)
      const existingDigest = item.call.resultDigest ?? (item.call.result ? digest(JSON.stringify(item.call.result)) : null)
      if ((previous && previous.resultDigest !== resultDigest) ||
        (existingDigest && existingDigest !== resultDigest)) {
        const error = new Error(`agy bridge: conflicting duplicate result for ${id}`)
        error.statusCode = 409
        throw error
      }
      if (!previous) unique.set(id, { ...item, resultDigest })
    }
    return unique
  }

  continueWith(results) {
    const turn = this.turn
    if (!turn || turn.finalized) throw new BusyError("agy bridge: no response is waiting for these tool results")
    turn.touchClient()
    for (const { call, result, resultDigest } of this.validateResults(results).values()) {
      clearTimeout(call.deadline)
      if (call.deferred) {
        if (!call.result) {
          call.result = result
          call.resultDigest = resultDigest
          this.#deliverLate(turn, call)
        }
        continue
      }
      if (call.mcpResponded || !call.ready || turn.done) continue
      call.resultDigest = resultDigest
      this.#respondMcp(call, { result })
    }
    turn.arm()
    this.lastUsed = Date.now()
  }

  #respondMcp(call, payload) {
    if (call.mcpResponded) return
    call.mcpResponded = true
    const socket = call.socket
    call.socket = null
    if (socket?.writable) socket.end(JSON.stringify(payload) + "\n")
    else socket?.destroy()
  }

  finalizeTurn(turn) {
    if (turn.finalized) return
    turn.finalized = true
    turn.notifyAcpTools()
    for (const socket of turn.cancelledMcpSockets) {
      try { socket.destroy() } catch {}
    }
    turn.cancelledMcpSockets.clear()
    turn.steering = false
    turn.detach()
    clearTimeout(turn.timer)
    for (const waiter of turn.waiters.splice(0)) {
      waiter.reject(new Error("agy bridge: response closed"))
    }
    clearTimeout(turn.cleanupTimer)
    for (const waiter of turn.awaitCalls.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reply({ content: [{ type: "text", text: turn.closeNote || "agy bridge: response closed" }], isError: true })
    }
    for (const call of turn.calls) {
      clearTimeout(call.deadline)
      if (call.id && toolCalls.get(call.id)?.call === call) toolCalls.delete(call.id)
      if (call.mcpSeen && !call.mcpResponded) {
        this.historyInvalid = true
        this.#respondMcp(call, turn.closeNote
          ? { result: { content: [{ type: "text", text: turn.closeNote }], isError: true } }
          : { error: { code: -32603, message: "agy bridge: response closed before the tool result arrived" } })
      }
      call.result = null
      call.socket = null
    }
    for (const step of turn.responseSteps) {
      step.body = null
      step.contentSnapshot = null
    }
    turn.currentResponse = null
    if (this.turn === turn) {
      this.turn = null
      if (!this.stopping && !this.retiring) park(this)
    }
  }

  abandonTurn(turn) {
    this.finalizeTurn(turn)
  }

  fail(error) {
    this.turn?.fail(error)
    dropFromPool(this)
    return this.stop()
  }

  #markDead(error) {
    if (this.dead) return
    this.dead = true
    this.deadError = error
    this.conn?.close(error)
    for (const waiter of this.listWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    if (this.turn && !this.turn.done && !this.stopping) this.turn.fail(error)
  }

  canPark() {
    return !!this.sessionId && this.hasSentFirstTurn && !this.historyInvalid && !this.turn &&
      !this.dead && Array.isArray(this.expectedMessages)
  }

  stop() {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.#stop()
    return this.stopPromise
  }

  async #stop() {
    this.stopping = true
    this.turn?.fail(new Error("stopped"))
    this.#markDead(new Error("stopped"))
    sessions.delete(this.token)
    if (this.turn) {
      for (const call of this.turn.calls) {
        if (call.mcpSeen && !call.mcpResponded) {
          this.#respondMcp(call, { error: { code: -32603, message: "agy bridge: process stopped" } })
        }
      }
    }
    for (const socket of this.watchers) socket.destroy()
    this.watchers.clear()
    const child = this.child
    if (child) {
      try { child.stdin?.end() } catch {}
      const alive = () => child.exitCode === null && child.signalCode === null
      if (alive()) {
        const closed = once(child, "close").catch(() => {})
        if (process.platform === "win32" && child.pid) {
          await execOnce("taskkill", ["/T", "/F", "/PID", String(child.pid)], { timeoutMs: 5_000 })
          // taskkill can report exit before descendant pipes release the cwd.
          await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))])
        } else {
          try { child.kill("SIGTERM") } catch {}
          await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))])
        }
        if (alive()) {
          try { child.kill("SIGKILL") } catch {}
          await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000))])
        }
      }
    }
    this.child = null
    if (this.workspace) {
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await fs.promises.rm(this.workspace, { recursive: true, force: true })
          break
        } catch (error) {
          if (attempt === 7 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) break
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
        }
      }
    }
    allProcs.delete(this)
  }
}

function stillRunningText(call) {
  return `${call.name} is still running in the client; no result yet. To keep waiting, call ${call.name} ` +
    "again with exactly the same arguments. That waits for this run and does not start it twice."
}

function resultText(result) {
  return (result?.content || []).map((part) => part?.type === "text" ? part.text : "[image returned by tool]").join("\n\n")
}

function renderLateResults(calls) {
  const parts = ["Client tool calls that were still running have finished. Their real results:"]
  for (const call of calls) {
    parts.push(`[tool result for ${call.name} call_id=${call.id}${call.result?.isError ? " (error)" : ""}]\n${resultText(call.result)}\n[end of tool result]`)
  }
  return parts.join("\n\n")
}

function renderLateResultParts(calls, includeImages = false) {
  const out = [{ type: "text", text: renderLateResults(calls) }]
  if (includeImages) {
    for (const call of calls) {
      for (const part of call.result?.content || []) {
        if (part?.type === "image" && part.data) {
          out.push({ type: "image", data: part.data, mimeType: part.mimeType || "image/png" })
        }
      }
    }
  }
  return out
}

function toPromptParts(content) {
  if (!content) return []
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }]
  const out = []
  for (const part of content) {
    if (!part) continue
    if (part.type === "text") {
      if (!part.text) continue
      if (out.at(-1)?.type === "text") out.at(-1).text += part.text
      else out.push({ type: "text", text: part.text })
    } else if (part.type === "image" && part.data) {
      out.push({ type: "image", data: part.data, mimeType: part.mimeType || "image/png" })
    }
  }
  return out
}

function mergePromptParts(first, second) {
  const a = toPromptParts(first)
  const b = toPromptParts(second)
  if (!a.length) return b
  if (!b.length) return a
  return toPromptParts([...a, { type: "text", text: "\n\n" }, ...b])
}

function promptHasImage(parts) {
  return Array.isArray(parts) && parts.some((part) => part?.type === "image")
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== "object") return total
  const out = { ...(total || {}) }
  for (const [key, value] of Object.entries(usage)) {
    if (Number.isFinite(Number(value))) out[key] = tokenCount(tokenCount(out[key]) + tokenCount(value))
  }
  return out
}

async function fileSize(file) {
  try { return (await fs.promises.stat(file)).size } catch { return 0 }
}

// agy writes the real upstream error only to its log; read what this turn added.
async function lastAgentError(file, offset) {
  let text = ""
  try {
    const handle = await fs.promises.open(file, "r")
    try {
      const size = (await handle.stat()).size
      const start = Math.max(offset || 0, size - LOG_TAIL_BYTES)
      const buffer = Buffer.alloc(Math.max(0, size - start))
      await handle.read(buffer, 0, buffer.length, start)
      text = buffer.toString("utf8")
    } finally {
      await handle.close()
    }
  } catch {
    return ""
  }
  let found = ""
  for (const line of text.split("\n")) {
    const match = /\] (?:agent executor error|failed to construct executor): (.+)$/.exec(line)
    if (match) found = match[1]
  }
  if (!found) return ""
  const cut = found.lastIndexOf("generating and executing: ")
  if (cut >= 0) found = found.slice(cut + "generating and executing: ".length)
  return found.trim().slice(0, 1000)
}

function dropFromPool(proc) {
  if (pool.get(proc.convKey) === proc) pool.delete(proc.convKey)
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

// Resumable sessions survive a plugin or Magpie restart: agy keeps the
// conversation on disk, and this file maps a conversation to its agy session.
// It stores only hashes of the history and instructions, never message text.
function sessionStateFile() {
  if (process.env.AGY_BRIDGE_STATE_FILE) return process.env.AGY_BRIDGE_STATE_FILE
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(base, "magpie-agy-bridge", "sessions.json")
}

let parkedLoaded = false
let accountSwitchOccurred = false
const unparked = new Set()

function parkedKey(entry) {
  return entry.account ? `${entry.account}:${entry.key}` : entry.key
}

function readStateFile() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionStateFile(), "utf8"))
    if (data?.version === 1 && data.accountSwitchOccurred === true) accountSwitchOccurred = true
    return data?.version === 1 && Array.isArray(data.entries) ? data.entries : []
  } catch {
    return []
  }
}

function validEntry(entry) {
  return entry && typeof entry.key === "string" && typeof entry.sessionId === "string" &&
    typeof entry.historyHash === "string" && typeof entry.instructionsHash === "string" &&
    Number.isFinite(entry.at) && Date.now() - entry.at <= resumeTtlMs()
}

function loadParked() {
  if (parkedLoaded) return
  parkedLoaded = true
  for (const entry of readStateFile().filter(validEntry).sort((a, b) => a.at - b.at)) {
    if (!parked.has(parkedKey(entry))) parked.set(parkedKey(entry), entry)
  }
}

// Hold a short-lived lockfile around read-merge-rename so concurrent bridge
// processes do not overwrite each other's parked session updates.
function withStateLock(file, fn) {
  const lock = `${file}.lock`
  let fd = null
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const waitBuf = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        fd = fs.openSync(lock, "wx", 0o600)
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }))
        break
      } catch (error) {
        if (error?.code !== "EEXIST") break
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 5_000) {
            const owner = JSON.parse(fs.readFileSync(lock, "utf8"))
            if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0) } catch (error) {
                if (error.code === "ESRCH") fs.unlinkSync(lock)
              }
            }
          }
        } catch {}
        Atomics.wait(waitBuf, 0, 0, 5)
      }
    }
    if (fd === null) return
    return fn()
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch {}
      try { fs.unlinkSync(lock) } catch {}
    }
  }
}

// Caller holds the state lock.
function writeParkedLocked(file, legacyAccount = null) {
  const merged = new Map()
  for (const entry of readStateFile().filter(validEntry)) merged.set(parkedKey(entry), entry)
  for (const key of unparked) merged.delete(key)
  for (const [key, entry] of parked) {
    if ((merged.get(key)?.at ?? 0) <= entry.at) merged.set(key, entry)
  }
  const entries = [...merged.values()].sort((a, b) => a.at - b.at).slice(-MAX_PARKED)
    .map(entry => legacyAccount && !entry.account ? { ...entry, account: legacyAccount } : entry)
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ version: 1,
    ...((accountSwitchOccurred || legacyAccount) ? { accountSwitchOccurred: true } : {}), entries }) + "\n", { mode: 0o600 })
  fs.renameSync(temp, file)
  unparked.clear()
  if (legacyAccount) {
    accountSwitchOccurred = true
    parked.clear()
    for (const entry of entries) parked.set(parkedKey(entry), entry)
  }
  return true
}

// Merge with the file so concurrent bridge processes do not erase each other.
function saveParked({ legacyAccount = null } = {}) {
  const file = sessionStateFile()
  try {
    return withStateLock(file, () => writeParkedLocked(file, legacyAccount))
  } catch { return false }
}

function unpark(convKey, account = currentAccountKey()) {
  loadParked()
  const keys = new Set([account ? `${account}:${convKey}` : convKey])
  if (!accountSwitchOccurred) keys.add(convKey)
  if (![...keys].some(key => parked.has(key)) && !readStateFile().some(entry => keys.has(parkedKey(entry)))) return
  for (const key of keys) {
    parked.delete(key)
    unparked.add(key)
  }
  saveParked()
}

// Remember a session so a later request, or a restarted bridge, resumes it
// instead of replaying history. Called after every completed turn and on retire.
function park(proc) {
  if (!proc.canPark()) return
  loadParked()
  const entry = {
    key: proc.convKey,
    sessionId: proc.sessionId,
    historyHash: digest(historyKey(proc.expectedMessages)),
    historyHashSansInputs: digest(historyKey(stripToolUseInputs(proc.expectedMessages))),
    toolUseIdentitiesHash: digest(toolUseIdentitiesKey(proc.expectedMessages) ?? ""),
    instructionsHash: digest(instructionsIdentity(proc.instructions)),
    workDir: proc.workDir,
    appDataDir: proc.appDataDir ?? "",
    at: Date.now(),
    ...(proc.account ? { account: proc.account } : {}),
    // Optional (still version 1): how the session holds its instructions and
    // the per-family calibration numbers. Never any text.
    instructionsInSession: !!proc.instructionsInSession,
    calibration: serializeCalibration(proc.calibration),
  }
  const key = parkedKey(entry)
  parked.delete(key)
  unparked.delete(key)
  parked.set(key, entry)
  while (parked.size > MAX_PARKED) parked.delete(parked.keys().next().value)
  saveParked()
}

function serializeCalibration(calibration) {
  const out = {}
  for (const [family, value] of calibration || []) {
    const scale = Number(value?.scale)
    const cacheRatio = Number(value?.cacheRatio)
    if (Number.isFinite(scale) && Number.isFinite(cacheRatio)) out[family] = { scale, cacheRatio }
  }
  return out
}

// Fills a fresh process's calibration from a parked record or a replaced
// process. A resumed session keeps its warm cache ratio; a new session only
// keeps the tokenizer scale and starts its cache ratio at 0.
function restoreCalibration(proc, source, withCacheRatio) {
  const entries = source instanceof Map ? [...source] : Object.entries(source && typeof source === "object" ? source : {})
  for (const [family, value] of entries) {
    if (typeof family !== "string" || !family) continue
    const scale = Number(value?.scale)
    const cacheRatio = Number(value?.cacheRatio)
    proc.calibration.set(family, {
      scale: Number.isFinite(scale) ? Math.max(0.5, Math.min(1.5, scale)) : 1,
      cacheRatio: withCacheRatio && Number.isFinite(cacheRatio) ? Math.max(0, Math.min(1, cacheRatio)) : 0,
      at: Date.now(),
    })
  }
}

// How a parked record holds its instructions. Records written before the field
// existed were appended whenever there were instructions (agy supported it).
function parkedInstructionsInSession(entry) {
  if (typeof entry.instructionsInSession === "boolean") return entry.instructionsInSession
  return !!entry.instructionsHash && entry.instructionsHash !== digest("")
}

// Read-only check of a parked session for this request: never deletes or
// rewrites the record. A mismatch keeps it (TTL expiry drops it later); only a
// successful resume, or agy saying the session is gone, consumes it.
function peekParked(convKey, opts) {
  loadParked()
  const account = currentAccountKey()
  const entry = parked.get(account ? `${account}:${convKey}` : convKey) ||
    (!accountSwitchOccurred ? parked.get(convKey) : null)
  if (!entry) return null
  if (entry.account ? entry.account !== account : accountSwitchOccurred) return null
  if (typeof entry.appDataDir === "string" && entry.appDataDir !== bridgeAppDataDirName()) return null
  if (Date.now() - entry.at > resumeTtlMs() || (entry.workDir ?? null) !== (opts.workDir ?? null) ||
    entry.instructionsHash !== digest(instructionsIdentity(opts.instructions))) return null
  // Sans-inputs resume accepts a client that canonicalized tool_use.input, but
  // only when the raw tool_use id/name sequence still lines up.
  const incoming = digest(historyKey(opts.history))
  if (entry.historyHash !== incoming) {
    const incomingSans = digest(historyKey(stripToolUseInputs(opts.history)))
    const incomingIds = toolUseIdentitiesKey(opts.history)
    const idsOk = incomingIds != null && entry.toolUseIdentitiesHash === digest(incomingIds)
    const sansOk = entry.historyHashSansInputs === incomingSans || entry.historyHash === incomingSans
    if (!idsOk || !sansOk) return null
  }
  const inSession = parkedInstructionsInSession(entry)
  // A session holding appended instructions cannot serve an inline-placement
  // model (its system prompt would apply on top of the inline copy).
  if (inSession && instructionsPlacement(opts.model) === "inline") return null
  return {
    key: parkedKey(entry),
    sessionId: entry.sessionId,
    expectedMessages: opts.history,
    instructionsInSession: inSession,
    calibration: entry.calibration && typeof entry.calibration === "object" ? entry.calibration : null,
  }
}

// Atomically drops a parked record, but only while it still names this
// session: a concurrent bridge may already have parked a newer one there.
function consumeParked(key, sessionId) {
  if (!key) return false
  loadParked()
  const file = sessionStateFile()
  try {
    return withStateLock(file, () => {
      const inMemory = parked.get(key)
      const onDisk = readStateFile().find(entry => entry && parkedKey(entry) === key)
      if (inMemory && inMemory.sessionId === sessionId) parked.delete(key)
      if (!onDisk || onDisk.sessionId === sessionId) unparked.add(key)
      else if (inMemory && inMemory.sessionId !== sessionId) return false
      return writeParkedLocked(file)
    }) ?? false
  } catch { return false }
}

// session/resume failure classes. Only "session_gone" consumes the record:
//   session_gone  ACP error -32002 (resource not found) or a message such as
//                 "session not found|expired|invalid|does not exist|unknown|missing",
//                 "no such session", "invalid session", "unknown session"
//   timeout       the request or agy start timed out
//   process_dead  agy exited or its ACP connection closed
//   transient     anything else (kept for a later attempt)
const SESSION_GONE_RE = /session\b.*(not\s+found|expired|invalid|does\s+not\s+exist|unknown|missing)|no\s+such\s+session|invalid\s+session|unknown\s+session/i
const SESSION_GONE_CODES = new Set([-32002])

function resumeFailureReason(error, proc) {
  const acp = error?.acpError
  if (acp && (SESSION_GONE_CODES.has(acp.code) || SESSION_GONE_RE.test(String(acp.message ?? "")))) return "session_gone"
  const message = String(error?.message ?? error ?? "")
  if (proc?.dead || /connection is closed|agy exited/i.test(message)) return "process_dead"
  if (/timed out|timeout/i.test(message)) return "timeout"
  // The wrapped message starts with "agy session/resume failed:", so only agy's
  // own error text is matched against SESSION_GONE_RE above.
  return "transient"
}

async function retire(key, proc) {
  proc.retiring = true
  park(proc)
  if (pool.get(key) === proc) pool.delete(key)
  await proc.stop().catch(() => {})
}

async function evictIdle() {
  const now = Date.now()
  const cutoff = now - idleMs()
  const victims = []
  const stale = []
  for (const [key, proc] of pool) {
    if (proc.retiring) continue
    if (proc.dead || (!proc.turn && proc.lastUsed < cutoff)) victims.push([key, proc])
    else if (proc.turn) {
      // A turn that can never make progress again must not hold a pool slot.
      const verdict = staleTurnVerdict(proc, proc.turn, now)
      if (verdict.stale) stale.push({ proc, turn: proc.turn, reason: verdict.reason })
    }
  }
  for (const [key, proc] of victims) await retire(key, proc)
  for (const { proc, turn, reason } of stale) {
    if (proc.turn !== turn || proc.retiring) continue
    logBridgeEvent(proc, turn, "reclaim", reason, {}, { trigger: "evict_idle" })
    await reclaimStaleTurn(proc, turn)
  }
}

// Two levels: the least recently used process without a turn first; when every
// process holds a turn, the oldest tool turn whose client detached long ago (or
// whose deadline passed). Its conversation replays from history on its next
// complete tool round, so the pool never starves on abandoned tool waits.
async function evictLRU() {
  let oldest = null
  for (const [key, proc] of pool) {
    if (proc.turn || proc.retiring) continue
    if (!oldest || proc.lastUsed < oldest.proc.lastUsed) oldest = { key, proc }
  }
  if (oldest) {
    await retire(oldest.key, oldest.proc)
    return true
  }
  const now = Date.now()
  const bound = detachedEvictMs()
  let victim = null
  for (const proc of pool.values()) {
    const turn = proc.turn
    if (proc.retiring || !turn || turn.attached || turn.cancelRequested || turn.steering) continue
    const since = turn.clientProgressAt ?? turn.lastProgressAt
    if (!staleTurnVerdict(proc, turn, now).stale && now - since < bound) continue
    if (!victim || since < victim.since) victim = { proc, turn, since }
  }
  if (!victim) return false
  logBridgeEvent(victim.proc, victim.turn, "evicted", "pool_pressure_detached", {}, { detached_evict_ms: bound })
  await reclaimStaleTurn(victim.proc, victim.turn, POOL_PRESSURE_NOTE)
  return true
}

setInterval(() => { evictIdle().catch(() => {}) }, 60_000).unref()

// A single writer for the global agy identity. Requests admitted before the
// gate closes may finish preparing their turn; later requests wait outside it.
let switching = null
let accountGeneration = 0
let activeAccount = null
let preparingRequests = 0
let accountSwitchStatus = ""
let blockedModelFamily = null
const usageReaders = new Set()

function accountState() {
  const state = discoverAccounts({ home: os.homedir(), configured: packageConfig.accounts, vaultDir: defaultVaultDir() })
  activeAccount = state.current ? accountKey(state.current) : null
  return state
}

function currentAccountKey() {
  if (autoSwitchEnabled()) accountState()
  return activeAccount
}

async function waitForAccountSwitch() {
  const deadline = Date.now() + ACCOUNT_SWITCH_TIMEOUT_MS
  while (switching) {
    let timer
    try {
      await Promise.race([switching, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new BusyError("agy bridge: timed out waiting for the account switch")),
          Math.max(1, deadline - Date.now()))
      })])
    } finally { clearTimeout(timer) }
  }
}

function maskedAccount(email) {
  const [local, domain = ""] = String(email).split("@")
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${domain.includes(".") ? domain.slice(domain.lastIndexOf(".")) : ""}`
}

function usageFamilies(window) {
  const name = String(window.name || "").split(" · ")[0].toLowerCase().replace(/\s+models$/, "")
  if (/claude.*gpt|gpt.*claude/.test(name)) return ["claude", "gpt"]
  return [name.replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "")].filter(Boolean)
}

function readCooldowns() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(defaultVaultDir(), "cooldown.json"), "utf8"))
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

function cooldownUntil(table, account, family) {
  const values = Object.entries(table[account] || {})
    .filter(([group, until]) => (family === group || family.startsWith(`${group}-`)) && Number.isFinite(until))
    .map(([, until]) => until)
  return Math.max(0, ...values)
}

function recordCooldowns(account, windows, family) {
  const file = path.join(defaultVaultDir(), "cooldown.json")
  return withStateLock(file, () => {
    const table = readCooldowns()
    const now = Date.now()
    const groups = { ...(table[account] || {}) }
    for (const window of windows) {
      const reset = Date.parse(window.resetsAt)
      const until = Number.isFinite(reset) && reset > now ? reset : now + 60 * 60 * 1000
      for (const group of usageFamilies(window)) groups[group] = Math.max(groups[group] || 0, until)
    }
    table[account] = groups
    if (family && cooldownUntil(table, account, family) <= now) groups[family] = now + 60 * 60 * 1000
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temp, JSON.stringify(table) + "\n", { mode: 0o600 })
      fs.renameSync(temp, file)
    } finally { try { fs.unlinkSync(temp) } catch {} }
    return table
  })
}

function unavailableAccounts(state, table, family) {
  if (state.candidates.some(candidate => !candidate.current && candidate.captured &&
    cooldownUntil(table, accountKey(candidate.email), family) <= Date.now())) return ""
  const known = state.candidates.filter(candidate => candidate.switchable)
  const times = known.map(candidate => cooldownUntil(table, accountKey(candidate.email), family))
  return times.length && times.every(until => until > Date.now())
    ? `所有账号额度用尽，最早恢复时间 ${new Date(Math.min(...times)).toISOString()}`
    : "没有可切换的已采集账号"
}

function switchEvent(reason, status, extra = {}) {
  accountSwitchStatus = status
  logBridgeEvent(null, null, "account_switch", reason, {}, { status, ...extra })
}

async function drainForAccountSwitch() {
  const deadline = Date.now() + ACCOUNT_SWITCH_TIMEOUT_MS
  // Cancel owned usage children before checking for external work. The waiting
  // reader retries only after the gate opens, so no old identity can escape.
  await Promise.all([...usageReaders].map(reader => reader.invalidate()))
  for (;;) {
    if (!preparingRequests) {
      const stops = []
      for (const proc of allProcs) {
        if (proc.retiring || proc.stopping) continue
        if (!proc.turn) stops.push(retire(proc.convKey, proc))
        else if (!proc.turn.attached && proc.turn.hasPendingMcp()) {
          stops.push(reclaimStaleTurn(proc, proc.turn, ACCOUNT_SWITCH_NOTE))
        }
      }
      await Promise.all(stops)
      if (!allProcs.size && !modelCatalogRefreshPromise) return true
    }
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function switchAccount(target, { reason, sourceAccount }) {
  if (!await drainForAccountSwitch()) {
    switchEvent(reason, "排空超过 120 秒，本次切号已放弃")
    return
  }
  const lock = await acquireSwitchLock({ home: os.homedir() })
  if (!lock.ok) {
    switchEvent(reason, lock.reason === "busy" ? "另一切号进行中" : "切号锁不可用")
    return
  }
  try {
    const inflight = await foreignAgyProcesses({ ownPids: [] })
    if (!inflight.ok || inflight.foreign.length) {
      switchEvent(reason, "在途：存在外部 agy 或无法核实进程状态")
      return
    }
    if (!autoSwitchEnabled()) return
    const state = accountState()
    if (activeAccount !== sourceAccount) {
      switchEvent(reason, "当前账号已被外部更改，本次切号已放弃")
      return
    }
    syncBridgeTokenFile()
    const captured = captureCurrent({ home: os.homedir(), vaultDir: defaultVaultDir() })
    if (!captured.ok || !saveParked({ legacyAccount: sourceAccount })) {
      switchEvent(reason, "账号备份或会话标记保存失败，本次切号已放弃")
      return
    }
    const result = writeActiveAccount({ home: os.homedir(), email: target, vaultDir: defaultVaultDir() })
    if (!result.ok) {
      switchEvent(reason, result.restored === false ? "切号失败且原账号还原失败" : "切号失败，原账号已保留")
      return
    }
    syncBridgeTokenFile()
    forgetStoredSignIn({ dead: true })
    activeAccount = accountKey(target)
    accountGeneration++
    acpOfferedModels = null
    acpOfferedKey = ""
    cachedModelCatalog = fallbackModelCatalog()
    modelCatalogRefreshPromise = null
    blockedModelFamily = null
    accountSwitchStatus = ""
    return { from: maskedAccount(state.current), to: maskedAccount(target) }
  } finally { await lock.release() }
}

function scheduleAccountSwitch({ reason, modelFamily, generation = accountGeneration }) {
  if (!autoSwitchEnabled() || generation !== accountGeneration) return Promise.resolve()
  if (switching) return switching
  let changed = null
  const operation = Promise.resolve().then(async () => {
    const state = accountState()
    if (!state.current) return switchEvent(reason, "无法识别当前 agy 账号")
    const sourceAccount = activeAccount
    const table = recordCooldowns(sourceAccount, [], modelFamily)
    if (!table) return switchEvent(reason, "冷却记录保存失败，本次切号已放弃")
    const index = state.candidates.findIndex(candidate => candidate.current)
    const rotated = [...state.candidates.slice(index + 1), ...state.candidates.slice(0, index + 1)]
    const target = rotated.find(candidate => !candidate.current && candidate.captured &&
      cooldownUntil(table, accountKey(candidate.email), modelFamily) <= Date.now())
    if (!target) {
      blockedModelFamily = modelFamily
      return switchEvent(reason, unavailableAccounts(state, table, modelFamily))
    }
    changed = await switchAccount(target.email, { reason, sourceAccount })
  }).catch(() => switchEvent(reason, "切号失败，本次切号已放弃"))
    .finally(() => {
      if (switching === operation) switching = null
      if (changed) switchEvent(reason, "", changed)
    })
  switching = operation
  return operation
}

function afterAgentErrorResponse(proc, turn, error) {
  if ((error?.quotaKind !== "account" && !error?.authenticationFailed) || !autoSwitchEnabled()) return
  // Yield past stream closure and non-streaming error conversion. Never replay
  // this request: the client receives its original 429/error event exactly once.
  turn.settled.then(() => {
    setTimeout(() => {
      if (!autoSwitchEnabled() || proc.accountGeneration !== accountGeneration) return
      const modelFamily = String(proc.currentModel || proc.model).replace(/-(?:minimal|low|medium|high|xhigh|max)$/i, "")
      if (error.authenticationFailed) {
        try {
          if (proc.account) recordCooldowns(proc.account, [], modelFamily)
          switchEvent("authentication_error", "当前 agy 账号需重新登录；已冷却 1 小时")
        } catch { switchEvent("authentication_error", "当前 agy 账号需重新登录；冷却记录保存失败") }
      } else {
        scheduleAccountSwitch({ reason: "quota_error", modelFamily, generation: proc.accountGeneration })
      }
    }, 0)
  })
}

async function readAccountUsage(reader) {
  const report = await reader()
  if (!hostOption("auto_switch", null, false)) return report
  if (isWslHost()) return { ...report, error: WSL_ACCOUNT_NOTE }
  const state = accountState()
  // Cooldown families are read from the raw pool names; the account badge is
  // display-only and is applied only after that bookkeeping.
  const windows = exhaustedWindows(report)
  const shown = maskedAccountReport(report, state.current)
  if (state.current && windows.length) {
    try {
      if (!recordCooldowns(activeAccount, windows)) return { ...shown, error: "冷却记录保存失败" }
    } catch { return { ...shown, error: "冷却记录保存失败" } }
  }
  const notes = []
  if (state.mismatch) notes.push("两处账号文件不一致，已按令牌文件账号计")
  let status = accountSwitchStatus
  if (blockedModelFamily) status = unavailableAccounts(state, readCooldowns(), blockedModelFamily)
  if (status) notes.push(status)
  return notes.length ? { ...shown, error: [report.error, ...notes].filter(Boolean).join("; ") } : shown
}

const acquireLocks = new Map()

async function withAcquireLock(key, fn) {
  const previous = acquireLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  acquireLocks.set(key, current)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (acquireLocks.get(key) === current) acquireLocks.delete(key)
  }
}

async function withAcquireLocks(keys, fn) {
  const unique = [...new Set(keys.filter(Boolean))].sort()
  const run = (index) => {
    if (index >= unique.length) return fn()
    return withAcquireLock(unique[index], () => run(index + 1))
  }
  return run(0)
}

async function acquireProc(agyPath, convKey, opts, isFreshConversation, forceNew = false) {
  while (!opts.accountAdmission?.active && switching) await waitForAccountSwitch()
  // Discover a live continued session's current key, lock it together with
  // the new key (sorted, to avoid deadlock), then pick again inside those
  // locks. A process is re-keyed only when its current key is already held.
  let extra = null
  for (let attempt = 0; ; attempt++) {
    const keys = extra && extra !== convKey ? [convKey, extra] : [convKey]
    const outcome = await withAcquireLocks(keys, async () => {
      const locked = new Set(keys)
      if (isFreshConversation && !forceNew && !pool.get(convKey)) {
        const candidate = findLiveContinuedProc(opts)
        const needed = candidate?.convKey
        if (needed && !locked.has(needed) && attempt < 2) return { retry: needed }
      }
      while (!opts.accountAdmission?.active && switching) await waitForAccountSwitch()
      return { value: await acquireProcLocked(agyPath, convKey, opts, isFreshConversation, forceNew, locked) }
    })
    if (outcome.retry) {
      extra = outcome.retry
      continue
    }
    return outcome.value
  }
}

// Caller holds the conversation lock; recovery must not acquire it recursively.
async function acquireProcLocked(agyPath, convKey, opts, isFreshConversation, forceNew = false, lockedKeys = new Set([convKey])) {
  await evictIdle()
  let existing = pool.get(convKey)
  if (existing?.turn?.cancelRequested) {
    await Promise.race([existing.turn.settled, new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_MS))])
  }
  if (existing && !existing.dead && existing.turn && !existing.retiring &&
    staleTurnVerdict(existing, existing.turn).stale) {
    // The held turn can never progress again: free the conversation for this request.
    const orphan = existing.turn
    logBridgeEvent(existing, orphan, "reclaim", staleTurnVerdict(existing, orphan).reason, opts)
    await reclaimStaleTurn(existing, orphan)
    existing = null
  }
  if (existing && !existing.dead && existing.turn) {
    const lineage = lineageVerdict(existing, existing.turn, opts)
    if (lineage === "fork") {
      const orphan = existing.turn
      logBridgeEvent(existing, orphan, "superseded", "lineage_fork", opts, { superseded_turn_id: orphan.turnId })
      await reclaimStaleTurn(existing, orphan, SUPERSEDED_NOTE)
      existing = null
    } else if (lineage === "conflict") {
      throw new ConflictError("agy bridge: this request carries the pending tool call but no matching result. Stop resending it; send the tool result or continue from the last self-consistent message.", "tool_state_conflict")
    }
  }
  let inheritCalibration = null
  // A flattened, growing first message changes conversationKey, so the live
  // session is under the previous key. Reuse it when the new opening continues
  // the whole previous opening (not just a shared prefix).
  if (!existing && !forceNew && isFreshConversation) {
    const candidate = findLiveContinuedProc(opts)
    if (candidate && lockedKeys.has(candidate.convKey)) existing = rekeyProc(candidate, convKey)
  }
  let why = "no_live"
  if (existing) {
    if (!existing.dead && existing.turn) {
      throw new BusyError("agy bridge: this conversation still has an unfinished response")
    }
    inheritCalibration = existing.calibration
    let matchedHistory = opts.history
    if (!forceNew && !existing.dead && !existing.retiring && existing.unsentPrompt &&
      Array.isArray(opts.messages) && Array.isArray(existing.expectedMessages)) {
      const k = existing.expectedMessages.length
      if (k > matchedHistory.length && k <= opts.messages.length &&
        existing.matchesHistory(opts.messages.slice(0, k))) {
        matchedHistory = opts.messages.slice(0, k)
      }
    }
    const continuedFresh = isFreshConversation && existing.hasSentFirstTurn &&
      isContinuedOpening(existing, Array.isArray(opts.messages) ? opts.messages[0] : null)
    const compatible = !forceNew && !existing.dead && !existing.retiring &&
      existing.workDir === opts.workDir && sameInstructions(existing.instructions, opts.instructions) &&
      (!autoSwitchEnabled() || existing.account === currentAccountKey()) &&
      existing.minimalAgent === hostOption("minimal_agent", "AGY_BRIDGE_MINIMAL_AGENT", true) &&
      (existing.appDataDir ?? "") === bridgeAppDataDirName() &&
      (existing.matchesHistory(matchedHistory) || continuedFresh)
    // A session holding Gemini's session-level system append cannot serve an
    // inline-placement model: rebuild it inline, parking the old session so a
    // switch back can resume it. The reverse (inline -> Gemini) keeps the
    // session and never appends a second copy of the instructions.
    const modeSwitch = existing.instructionsInSession && instructionsPlacement(opts.model) === "inline"
    if (compatible && (!(isFreshConversation && existing.hasSentFirstTurn) || continuedFresh)) {
      if (continuedFresh) {
        const first = Array.isArray(opts.messages) ? opts.messages[0] : null
        // Snapshot the unsent tail before openingText advances to this turn.
        existing.pendingFlattenedTurn = flattenedContinuationMessage(existing, first)
        existing.openingText = openingTextOf(first) || existing.openingText
        existing.openingImages = openingImagesOf(first)
      }
      if (modeSwitch) {
        logBridgeEvent(existing, null, "rebuild", "instructions_mode_switch", opts)
        await retire(convKey, existing)
      } else {
        await existing.updateTools(opts.tools)
        return { proc: existing, history: matchedHistory }
      }
    } else {
      why = forceNew ? "forced" : existing.dead ? "dead" : existing.retiring ? "retiring" :
        existing.workDir !== opts.workDir ? "work_dir" :
        !sameInstructions(existing.instructions, opts.instructions) ? "instructions" :
        !(existing.matchesHistory(matchedHistory) || continuedFresh) ? "history" : "fresh_after_first"
      existing.retiring = true
      dropFromPool(existing)
      await existing.stop().catch(() => {})
    }
  }
  while (allProcs.size >= maxProcs()) {
    if (!(await evictLRU())) {
      throw new BusyError(`agy bridge: ${maxProcs()} agy processes are running and all have unfinished responses`)
    }
  }
  const resume = forceNew || isFreshConversation ? null : peekParked(convKey, opts)
  const proc = new Proc(agyPath, convKey, {
    ...opts, resume, instructionsPlacement: instructionsPlacement(opts.model), inheritCalibration,
  })
  try {
    await proc.start()
  } catch (error) {
    await proc.stop().catch(() => {})
    throw error
  }
  pool.set(convKey, proc)
  // Why this request got a new agy session, so a cache that never hits can be
  // traced to the check that failed (#1058). Counts only, never content.
  logSessionEvent(proc, why, {
    fresh: !!isFreshConversation, resumed: !!proc.resumed,
    parked: !!resume, history: Array.isArray(opts.history) ? opts.history.length : null,
  })
  return { proc, history: opts.history }
}

// Bounded, content-free events: never log prompts, arguments, results or tool IDs.
const HOST_EPOCH = randomBytes(4).toString("hex")
const EVENT_WINDOW_MS = 60_000
const EVENT_MAX_PER_WINDOW = 30
let eventWindowStart = 0
let eventWindowCount = 0
// Rows dropped by the rate limit; reported on the next row that gets through.
let eventSuppressed = 0

function pendingCallCount(turn) {
  return turn.calls.filter((call) => (call.mcpSeen && !call.mcpResponded) || (call.deferred && !call.result)).length
}

// Per-request facts for the event rows (layout, non-streaming), keyed by req_id; bounded.
const requestMeta = new Map()
const REQUEST_META_MAX = 256

function rememberRequestMeta(reqId, meta) {
  requestMeta.set(reqId, meta)
  while (requestMeta.size > REQUEST_META_MAX) requestMeta.delete(requestMeta.keys().next().value)
}

function logBridgeEvent(proc, turn, action, reason, meta = {}, extra = {}) {
  if (process.env.AGY_BRIDGE_EVENTS === "0") return
  const now = Date.now()
  if (now - eventWindowStart >= EVENT_WINDOW_MS) { eventWindowStart = now; eventWindowCount = 0 }
  if (eventWindowCount >= EVENT_MAX_PER_WINDOW) {
    eventSuppressed++
    return
  }
  eventWindowCount++
  const info = (meta?.reqId && requestMeta.get(meta.reqId)) || meta || {}
  const convKey = proc?.convKey ?? meta?.convKey
  const row = {
    event: "agy_bridge_tool_state", host_epoch: HOST_EPOCH, ts: now,
    req_id: meta?.reqId ?? null,
    conv: convKey ? digest(convKey).slice(0, 12) : null, turn_id: turn?.turnId ?? null,
    action, reason, attached: !!turn?.attached, done: !!turn?.done, dead: !!(proc?.dead || proc?.stopping),
    pending: turn ? pendingCallCount(turn) : 0,
    idle_ms: turn ? Math.max(0, now - turn.lastProgressAt) : null,
    client_idle_ms: turn ? Math.max(0, now - (turn.clientProgressAt ?? turn.lastProgressAt)) : null,
    self_poll_repeats: turn ? turn.calls.reduce((max, call) => Math.max(max, call.stillRunning || 0), 0) : 0,
    ...(info.layout ? { layout: info.layout, nonstream: info.nonstream } : {}), ...extra,
  }
  if (eventSuppressed) {
    row.suppressed = eventSuppressed
    eventSuppressed = 0
  }
  try { process.stderr.write("[agy-bridge] " + JSON.stringify(row) + "\n") } catch {}
}

// One row per new agy session, on a budget of its own so it never crowds out
// the tool-state rows above.
let sessionWindowStart = 0
let sessionWindowCount = 0

function logSessionEvent(proc, reason, extra) {
  if (process.env.AGY_BRIDGE_EVENTS === "0") return
  const now = Date.now()
  if (now - sessionWindowStart >= EVENT_WINDOW_MS) { sessionWindowStart = now; sessionWindowCount = 0 }
  if (sessionWindowCount++ >= EVENT_MAX_PER_WINDOW) return
  const row = { event: "agy_bridge_session", host_epoch: HOST_EPOCH, ts: now,
    conv: proc?.convKey ? digest(proc.convKey).slice(0, 12) : null, action: "session_new", reason, ...extra }
  try { process.stderr.write("[agy-bridge] " + JSON.stringify(row) + "\n") } catch {}
}

// Per-conversation counter of consecutive unmatched tool-result requests that
// hit the same turn while its lastProgressAt did not move. A different turn,
// any progress, a window timeout or a reclaim restarts it from zero.
const noProgressRepeats = new Map()

function noteNoProgressRepeat(convKey, turn, now = Date.now()) {
  let entry = noProgressRepeats.get(convKey)
  if (!entry || entry.turnId !== turn.turnId || entry.progressAt !== turn.lastProgressAt ||
    now - entry.firstAt > NO_PROGRESS_REPEAT_WINDOW_MS) {
    entry = { turnId: turn.turnId, progressAt: turn.lastProgressAt, firstAt: now, attempts: 0 }
  }
  entry.attempts++
  noProgressRepeats.delete(convKey)
  noProgressRepeats.set(convKey, entry)
  while (noProgressRepeats.size > NO_PROGRESS_REPEAT_MAX_ENTRIES) {
    noProgressRepeats.delete(noProgressRepeats.keys().next().value)
  }
  return entry.attempts
}

function staleTurnVerdict(proc, turn, now = Date.now()) {
  if (!turn || turn.cancelRequested) return { stale: false, reason: "cancelling" }
  if (turn.attached) return { stale: false, reason: "attached" }
  if (turn.steering) return { stale: false, reason: "steering" }
  if (turn.finalized) return { stale: true, reason: "finalized" }
  if (proc.dead || proc.stopping) return { stale: true, reason: "dead" }
  if (turn.done) return { stale: true, reason: "done" }
  if (turn.deadlineAt != null && now >= turn.deadlineAt) return { stale: true, reason: "expired" }
  return { stale: false, reason: pendingCallCount(turn) ? "pending_tool" : "running" }
}

// A pending tool turn only owns its own line of history, not a sibling request
// that continues its base without carrying any of the emitted tool calls.
function lineageVerdict(proc, turn, opts) {
  if (!turn || turn.attached || turn.cancelRequested || turn.steering || turn.done || turn.finalized) return null
  if (proc.dead || proc.stopping || proc.retiring || !turn.hasPendingMcp()) return null
  const history = opts.history
  const base = turn.baseHistory
  if (!Array.isArray(history) || !Array.isArray(base)) return null
  const ids = new Set(turn.calls.map((call) => call.id))
  const carried = (opts.messages || []).some((message) => Array.isArray(message?.content) &&
    message.content.some((block) => block?.type === "tool_use" && ids.has(block.id)))
  if (history.length < base.length || historyKey(history.slice(0, base.length)) !== historyKey(base)) {
    // The client no longer continues this turn's base: it was shortened or its
    // prefix was rewritten (a compaction summary). A plain new request has left
    // the detached tool wait behind; one carrying its tool_use is still a conflict.
    if (carried) return "conflict"
    return opts.hasToolResults ? null : "fork"
  }
  const expected = proc.expectedMessages
  const recorded = Array.isArray(expected) && expected.length > base.length &&
    history.length >= expected.length &&
    historyKey(history.slice(0, expected.length)) === historyKey(expected)
  // A renamed call with edited arguments still belongs to the old response.
  // Keep upstream's 409 and its live owner intact rather than replaying it as
  // a sibling conversation just because its inputs no longer compare equal.
  const withoutInputs = (messages) => messages.map((message) => ({ ...message,
    content: Array.isArray(message.content) ? message.content.map((block) =>
      block?.type === "tool_use" ? { ...block, input: {} } : block) : message.content,
  }))
  if (!carried && !recorded && Array.isArray(expected) && expected.length > base.length &&
    history.length === expected.length &&
    historyKey(withoutInputs(history)) === historyKey(withoutInputs(expected))) return null
  return carried || recorded ? "conflict" : "fork"
}

function replayHistoryProblem(body, resultBlocks) {
  const calls = lastAssistantCalls(trailingMessages(body).history)
  if (!calls.length) return "no_tool_use"
  const ids = new Set()
  for (const call of calls) {
    if (typeof call.id !== "string" || !call.id || ids.has(call.id)) return "bad_tool_use_id"
    ids.add(call.id)
    if (typeof call.name !== "string" || !call.name) return "bad_tool_use_name"
    const input = call.input ?? {}
    if (!input || typeof input !== "object" || Array.isArray(input)) return "bad_tool_use_input"
  }
  const answered = new Set()
  for (const block of resultBlocks) {
    if (!ids.has(block.tool_use_id) || answered.has(block.tool_use_id)) return "unmatched_tool_result"
    answered.add(block.tool_use_id)
  }
  return answered.size === ids.size ? null : "missing_tool_result"
}

async function reclaimStaleTurn(proc, turn, note = "agy bridge: stale tool turn closed") {
  noProgressRepeats.delete(proc.convKey)
  turn.closeNote = note
  proc.retiring = true
  proc.historyInvalid = true
  dropFromPool(proc)
  unpark(proc.convKey, proc.account)
  turn.fail(new Error(note))
  proc.abandonTurn(turn)
  let timer
  try {
    await Promise.race([proc.stop().catch(() => {}), new Promise((resolve) => {
      timer = setTimeout(resolve, RECLAIM_STOP_TIMEOUT_MS)
      timer.unref?.()
    })])
  } finally { clearTimeout(timer) }
}

// Recheck under the same lock and start at most one replacement turn.
// Kinds: active (409), conflict/incomplete (400), replayed, fallthrough.
// `ctx.attempts` set means the no-progress repeat limit was reached: a quiet
// turn is then reclaimed even if it is not provably stale (never an attached one).
async function recoverStaleTurn(ctx) {
  return withAcquireLock(ctx.convKey, async () => {
    const current = pool.get(ctx.convKey)
    const held = current?.turn
    const forced = ctx.attempts != null
    const extra = forced ? { attempts: ctx.attempts } : {}
    const turnId = ctx.turn?.turnId ?? null
    if (!current || !held) {
      if (!forced) return { kind: "fallthrough" }
      // Another request already disposed of this turn: this duplicate must not start a second one.
      logBridgeEvent(current, ctx.turn, "recover_refused", "turn_gone", ctx.acquireOpts, extra)
      return { kind: "conflict", turnId }
    }
    if (current !== ctx.proc || held !== ctx.turn) {
      // Another request replaced the turn while this one waited: never cancel it.
      logBridgeEvent(current, held, "recover_refused", "turn_replaced", ctx.acquireOpts, extra)
      return { kind: "conflict", turnId }
    }
    if (held.cancelRequested) return { kind: "fallthrough" }
    const verdict = staleTurnVerdict(current, held)
    // Lineage supersession belongs to acquisition of a new prompt. Unmatched
    // results alone reclaim an unexpired owner only at the repeat limit.
    if (!verdict.stale && (!forced || verdict.reason === "attached" || verdict.reason === "steering")) {
      logBridgeEvent(current, held, "reject_active", verdict.reason, ctx.acquireOpts, extra)
      return { kind: "active" }
    }
    const reason = verdict.stale ? verdict.reason : "no_progress_repeat"
    logBridgeEvent(current, held, "reclaim", reason, ctx.acquireOpts, extra)
    await reclaimStaleTurn(current, held)
    const problem = replayHistoryProblem(ctx.body, ctx.resultBlocks)
    if (problem) {
      logBridgeEvent(current, held, "replay_refused", problem, ctx.acquireOpts, extra)
      return { kind: "incomplete", turnId }
    }
    const { proc, history } = await acquireProcLocked(ctx.agy, ctx.convKey, ctx.acquireOpts, ctx.isFresh, true)
    const turn = await ctx.begin(proc, history)
    logBridgeEvent(proc, turn, "replay_started", reason, ctx.acquireOpts, { ...extra, replaced_turn_id: held.turnId })
    return { kind: "replayed", proc, turn }
  })
}

function stableJSON(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)
}

function parseUserImage(block) {
  if (block?.type !== "image") return null
  const mediaType = String(block.source?.media_type || "").toLowerCase()
  return imageContent({ ...block, source: { ...block.source, media_type: mediaType === "image/jpg" ? "image/jpeg" : mediaType } })
}

function parseUserDocumentText(block) {
  if (block?.type !== "document") return ""
  const title = typeof block.title === "string" && block.title.trim() ? block.title.trim() : ""
  const src = block.source
  let text = null
  if (src?.type === "text" && typeof src.data === "string") {
    text = src.data
  } else if (src?.type === "content") {
    if (typeof src.content === "string") {
      text = src.content
    } else if (Array.isArray(src.content) && src.content.every((part) => part?.type === "text" && typeof part.text === "string")) {
      text = src.content.map((part) => part.text).join("\n")
    }
  }
  if (text === null) {
    throw new UnsupportedContent("a binary or URL document block in a user message (agy's ACP prompt accepts text and images only)")
  }
  return title ? `[document: ${title}]\n${text}\n[end of document]` : text
}

function parseSearchResultText(block) {
  if (block?.type !== "search_result") return ""
  const header = [block.title, block.source].filter((item) => typeof item === "string" && item.trim()).join(" — ")
  const body = Array.isArray(block.content)
    ? block.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n")
    : typeof block.content === "string" ? block.content : ""
  return header ? `[search result: ${header}]\n${body}\n[end of search result]` : body
}

const SERVER_TOOL_RESULT_BLOCK_TYPES = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "mcp_tool_result",
  "advisor_tool_result",
])

const ASSISTANT_ALLOWED_BLOCK_TYPES = new Set([
  "text",
  "tool_use",
  "thinking",
  "redacted_thinking",
  "server_tool_use",
  "mcp_tool_use",
  "container_upload",
  ...SERVER_TOOL_RESULT_BLOCK_TYPES,
])

function renderServerAssistantBlock(block) {
  if (!block || typeof block !== "object") return ""
  if (block.type === "server_tool_use" || block.type === "mcp_tool_use") {
    return `[server tool call ${block.name || block.type} id=${block.id || ""} args=${JSON.stringify(block.input ?? {})}]`
  }
  if (block.type === "container_upload") {
    return block.file_id ? `[container upload ${block.file_id}]` : ""
  }
  if (SERVER_TOOL_RESULT_BLOCK_TYPES.has(block.type)) {
    return `[${block.type}${block.tool_use_id ? " id=" + block.tool_use_id : ""}] ${JSON.stringify(block.content ?? "")}`
  }
  return ""
}

const MAGPIE_PLACEHOLDER_NOTICE = "Values written like {{NAME_ab12cd34}} are placeholders for real values. Use them exactly as written, in replies and in tool calls alike: they are filled in with the real values before anything runs. Don't ask to verify them, and don't replace them with examples."
const MAGPIE_PLACEHOLDER_NOTICE_RE = /(?:^|\n\n)Values written like \{\{NAME_ab12cd34\}\} are placeholders for real values\. Use them exactly as written, in replies and in tool calls alike: they are filled in with the real values before anything runs\. Don't ask to verify them, and don't replace them with examples\.(?=\s|$)/g

function stripMagpiePlaceholderNotice(text) {
  if (typeof text !== "string" || !text.includes("{{NAME_ab12cd34}}")) return text
  return text.replace(MAGPIE_PLACEHOLDER_NOTICE_RE, "")
}

// Clear tool_use.input values so a later history comparison can ignore
// client-canonicalized arguments after raw tool_use ids and names match.
function stripToolUseInputs(messages) {
  if (!Array.isArray(messages)) return messages
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) => block?.type === "tool_use"
        ? { type: "tool_use", id: block.id, name: block.name, input: {} }
        : block)
      : message.content,
  }))
}

function toolUseIdentitiesKey(messages) {
  if (!Array.isArray(messages)) return null
  const rows = []
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (block?.type !== "tool_use") continue
      if (!block.id) return null
      rows.push({ id: block.id, name: block.name || "" })
    }
  }
  return stableJSON(rows)
}

function sameToolUseIdentities(left, right) {
  const a = toolUseIdentitiesKey(left)
  const b = toolUseIdentitiesKey(right)
  return a != null && a === b
}

// Compare conversation content, not transport metadata or client-assigned IDs.
// Keep argument values, result contents and internal whitespace significant.

// Agent-injected Claude Code billing headers. Only whole header lines (and
// a line that is just the rotating cch token) are removed, so user text that
// happens to mention "cch=…" or the header name is left alone.
function stripBillingHeader(text) {
  let s = String(text ?? "")
  s = s.replace(/^[ \t]*x-anthropic-billing-header:[^\n]*\n?/gmi, "")
  s = s.replace(/^[ \t]*cch=[0-9a-fA-F]+;?[ \t]*\n?/gmi, "")
  return s
}

const ISO_DATE = String.raw`20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?`
const LOCALE_DATE = String.raw`(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?`
const CLOCK_VALUE = String.raw`(?:${ISO_DATE}|${LOCALE_DATE}|\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?)`
const AGENT_CLOCK_LINE_RE = new RegExp(
  String.raw`^(?:#{1,6}\s*)?(?:(?:(?:current\s+)?(?:date|time|datetime|today|now)|today(?:'s)?\s+date|(?:the\s+)?current\s+(?:date|time|datetime))\s*[:：]\s*${CLOCK_VALUE}|(?:(?:the\s+)?current\s+(?:date|time|datetime)|today(?:'s)?\s+date)\s+is\s+${CLOCK_VALUE})\s*\.?$`,
  "i",
)

function isAgentClockLine(line) {
  return AGENT_CLOCK_LINE_RE.test(String(line ?? "").trim())
}

function stripAgentClockLines(text) {
  const s = String(text ?? "")
  if (!s) return s
  return s.split(/(\n)/).map((part) => (part === "\n" || !isAgentClockLine(part) ? part : "")).join("")
}

// System prompt and session instructions: billing headers plus known agent
// clock lines. User text is never passed through this helper.
function stripVolatileSystem(text) {
  return stripAgentClockLines(stripBillingHeader(text))
}

function instructionsIdentity(text) {
  return compactIdentity(stripVolatileSystem(text))
}

// Message text used for conversation/history identity: billing header lines,
// and clock lines only inside <system-reminder> blocks (Claude Code injects
// these on later turns too, so a mid-chat clock change must not rewrite the
// history). Ordinary user/assistant text is left alone, including lines that
// start with "Today:" or contain a date.
// Walk closed <system-reminder>…</system-reminder> blocks with indexOf so an
// unclosed opener does not rescan the rest of the string from every match
// (the previous /[\s\S]*?/ regex was quadratic in the number of open tags).
// Length-preserving ASCII fold. s.toLowerCase() maps İ (U+0130) to two
// code units ("i" + combining dot), which would shift later indexes.
function asciiLower(s) {
  return String(s ?? "").replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32))
}

function replaceClosedSystemReminders(text, replacer) {
  const s = String(text ?? "")
  if (!s) return s
  const open = "<system-reminder"
  const close = "</system-reminder>"
  const lower = asciiLower(s)
  let out = ""
  let i = 0
  while (i < s.length) {
    const start = lower.indexOf(open, i)
    if (start === -1) {
      out += s.slice(i)
      break
    }
    const afterName = start + open.length
    if (afterName < s.length && /[A-Za-z0-9_]/.test(s[afterName])) {
      out += s.slice(i, afterName)
      i = afterName
      continue
    }
    const gt = s.indexOf(">", afterName)
    if (gt === -1) {
      out += s.slice(i)
      break
    }
    const closeAt = lower.indexOf(close, gt + 1)
    if (closeAt === -1) {
      // No closer after this tag means none exists later either; keep the rest
      // verbatim so later openers do not rescan the same suffix.
      out += s.slice(i)
      break
    }
    const end = closeAt + close.length
    out += s.slice(i, start) + replacer(s.slice(start, end))
    i = end
  }
  return out
}

function stripVolatileOpening(text) {
  return replaceClosedSystemReminders(stripBillingHeader(text), (block) => stripAgentClockLines(block))
}

function openingTextOf(message) {
  if (!message) return ""
  return compactIdentity(stripVolatileOpening(contentText(message.content)))
}

function openingImagesOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block?.type !== "image") continue
    try {
      const image = parseUserImage(block)
      if (image) out.push(`${image.mimeType}:${digest(image.data)}`)
    } catch {
      const source = block.source || {}
      out.push(`invalid:${source.media_type || ""}:${digest(String(source.data || ""))}`)
    }
  }
  return out
}

function sameOpeningImagePrefix(prev, cur) {
  if (!Array.isArray(prev) || !Array.isArray(cur) || prev.length > cur.length) return false
  return prev.every((id, index) => id === cur[index])
}

// Non-text, non-image blocks on an opening (documents, search results, etc.).
function openingExtrasOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (!block || typeof block === "string" || block.type === "text" || block.type === "image") continue
    out.push(digest(stableJSON(block)))
  }
  return out
}

function sameOpeningExtraPrefix(prev, cur) {
  return sameOpeningImagePrefix(prev, cur)
}

// Advance through `text` while ignoring whitespace until `compactPrefix` is
// consumed. Returns the index of the first non-space after the prefix, and
// whether a newline (a turn boundary) sits between the prefix and the rest.
function consumeCompactPrefix(text, compactPrefix) {
  let i = 0
  let k = 0
  let lastWasNewline = true
  while (i < text.length && k < compactPrefix.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      if (ch === "\n" || ch === "\r") lastWasNewline = true
      i++
      continue
    }
    if (ch !== compactPrefix[k]) return null
    k++
    i++
    lastWasNewline = false
  }
  if (k < compactPrefix.length) return null
  let sawNewline = lastWasNewline
  let j = i
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j++
  if (j < text.length && (text[j] === "\n" || text[j] === "\r")) {
    sawNewline = true
    while (j < text.length && /\s/.test(text[j])) j++
  }
  return { remainderIndex: j, boundary: sawNewline }
}

function subsequentTranscriptOf(proc) {
  const messages = proc?.expectedMessages
  if (!Array.isArray(messages) || messages.length < 2) return ""
  const parts = []
  for (const message of messages.slice(1)) {
    if (!message) continue
    if (message.role === "assistant") {
      const text = assistantTextOf(message)
      if (typeof text === "string" && text.trim()) {
        parts.push(text)
        continue
      }
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const block of blocks) {
        if (!block) continue
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text)
        else if (block.type === "tool_use") parts.push(`${block.name || ""}:${stableJSON(block.input ?? {})}`)
      }
      continue
    }
    const text = contentText(message.content)
    if (text.trim()) parts.push(text)
  }
  return compactIdentity(parts.join("\n"))
}

const FLAT_ROLE_LABEL_RE = /^(?:assistant|user|system|human|model)\s*:\s*/i

// Leftover text after an optional role label and the subsequent transcript,
// or null if the remainder does not start with that transcript. The reply
// must end on a line boundary (or the end of the string) so a longer
// independent line that only starts with the reply is rejected, including
// replies of 12 characters or more — length is not a substitute for a
// turn boundary.
function leftoverAfterSubsequent(remainder, subsequentCompact) {
  if (!subsequentCompact) return null
  let text = remainder
  if (FLAT_ROLE_LABEL_RE.test(text)) text = text.replace(FLAT_ROLE_LABEL_RE, "")
  if (!compactIdentity(text).startsWith(subsequentCompact)) return null
  const consumed = consumeCompactPrefix(text, subsequentCompact)
  if (!consumed) return null
  if (!consumed.boundary && consumed.remainderIndex < text.length) return null
  return text.slice(consumed.remainderIndex)
}

function remainderHasSubsequent(remainder, subsequentCompact) {
  return leftoverAfterSubsequent(remainder, subsequentCompact) != null
}

// The unsent tail of a flattened, growing first message: everything after
// the previous opening and the live session's subsequent transcript (usually
// the last assistant reply). Images and extra blocks already sent with the
// previous opening are dropped; any new images, documents or search results
// are kept. If the previous extras are not a prefix of the new ones, reuse
// is refused rather than dropping content.
function flattenedContinuationMessage(proc, firstMessage) {
  const prev = proc?.openingText || ""
  const cur = openingTextOf(firstMessage)
  if (!prev || !cur || cur === prev) return null
  // The new opening must continue the whole previous opening, not just a
  // shared prefix. A shared 8 KiB head with a different tail is a different chat.
  if (!(cur.startsWith(prev) && cur.length > prev.length + 4)) return null
  const prevOpening = Array.isArray(proc.expectedMessages) ? proc.expectedMessages[0] : null
  const prevImages = proc.openingImages || openingImagesOf(prevOpening)
  const curImages = openingImagesOf(firstMessage)
  if (!sameOpeningImagePrefix(prevImages, curImages)) return null
  const prevExtras = openingExtrasOf(prevOpening)
  const curExtras = openingExtrasOf(firstMessage)
  if (!sameOpeningExtraPrefix(prevExtras, curExtras)) return null
  // "Review README" must not attach "Review README and tests". Flattened
  // history appends later turns after a newline, and those turns are still
  // sitting on the live process, so require both a turn boundary and the
  // subsequent transcript (the assistant reply, not just a longer prompt).
  const curRaw = stripVolatileOpening(contentText(firstMessage?.content))
  const consumed = consumeCompactPrefix(curRaw, prev)
  if (!consumed?.boundary) return null
  const subsequent = subsequentTranscriptOf(proc)
  if (!subsequent) return null
  const leftover = leftoverAfterSubsequent(curRaw.slice(consumed.remainderIndex), subsequent)
  if (leftover == null) return null
  const newText = leftover.replace(/^\s+/, "")
  const keptBlocks = []
  if (Array.isArray(firstMessage?.content)) {
    let skippedImages = 0
    let skippedExtras = 0
    const skipImg = prevImages?.length || 0
    const skipEx = prevExtras?.length || 0
    for (const block of firstMessage.content) {
      if (!block || typeof block === "string" || block.type === "text") continue
      if (block.type === "image") {
        if (skippedImages < skipImg) {
          skippedImages++
          continue
        }
        keptBlocks.push(block)
        continue
      }
      if (skippedExtras < skipEx) {
        skippedExtras++
        continue
      }
      keptBlocks.push(block)
    }
  }
  if (!newText && !keptBlocks.length) return null
  if (!keptBlocks.length) return { role: "user", content: newText }
  const content = []
  if (newText) content.push({ type: "text", text: newText })
  content.push(...keptBlocks)
  return { role: "user", content }
}

function isContinuedOpening(proc, firstMessage) {
  return flattenedContinuationMessage(proc, firstMessage) != null
}

function findLiveContinuedProc(opts) {
  const first = Array.isArray(opts?.messages) ? opts.messages[0] : null
  if (!first) return null
  const userId = opts.userId || ""
  let best = null
  let bestLen = -1
  let tied = false
  for (const proc of pool.values()) {
    if (proc.dead || proc.retiring || proc.turn) continue
    if ((proc.userId || "") !== userId) continue
    if (proc.workDir !== opts.workDir) continue
    if (!sameInstructions(proc.instructions, opts.instructions)) continue
    if (!proc.hasSentFirstTurn) continue
    if (!isContinuedOpening(proc, first)) continue
    const len = (proc.openingText || "").length
    if (!best || len > bestLen) {
      best = proc
      bestLen = len
      tied = false
    } else if (len === bestLen) {
      tied = true
    }
  }
  return tied ? null : best
}

function rekeyProc(proc, newKey) {
  if (!proc || proc.convKey === newKey) return proc
  const oldKey = proc.convKey
  dropFromPool(proc)
  unpark(oldKey)
  proc.convKey = newKey
  pool.set(newKey, proc)
  return proc
}


function historyKey(messages) {
  const rows = []
  const ids = new Map()
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content ?? "" }]
    for (const block of blocks) {
      if (!block) continue
      if (block.type === "thinking" || block.type === "redacted_thinking" ||
        block.type === "tool_addition" || block.type === "tool_removal") continue
      let value
      if (typeof block === "string" || block.type === "text") {
        value = { type: "text", text: stripVolatileOpening(stripMagpiePlaceholderNotice(typeof block === "string" ? block : block.text || "")) }
      } else if (block.type === "document") {
        value = { type: "text", text: parseUserDocumentText(block) }
      } else if (block.type === "search_result") {
        value = { type: "text", text: parseSearchResultText(block) }
      } else if (block.type === "image") {
        const image = parseUserImage(block)
        value = { type: "image", mimeType: image.mimeType, sha256: digest(image.data) }
      } else if (block.type === "tool_use") {
        const ordinal = ids.size + 1
        ids.set(block.id, ordinal)
        value = { type: "tool_use", id: ordinal, name: block.name, input: block.input ?? {} }
      } else if (block.type === "tool_result") {
        value = { type: "tool_result", id: ids.get(block.tool_use_id) ?? block.tool_use_id, ...toolResult(block) }
      } else if (block.type === "server_tool_use" || block.type === "mcp_tool_use" ||
        block.type === "container_upload" || SERVER_TOOL_RESULT_BLOCK_TYPES.has(block.type)) {
        value = { type: block.type, name: block.name || "", content: renderServerAssistantBlock(block) }
      } else {
        value = block
      }
      let row = rows.at(-1)
      if (!row || row.role !== message.role) {
        row = { role: message.role, content: [] }
        rows.push(row)
      }
      const last = row.content.at(-1)
      if (last?.type === "text" && value.type === "text") last.text += value.text
      else row.content.push(value)
    }
  }
  for (const row of rows) {
    row.content = row.content.filter(block => block.type !== "text" || (block.text = block.text.trim()) !== "")
  }
  return stableJSON(rows.filter(row => row.content.length))
}

// Assistant-prefill support (ported from magpie-community/plugins agy-cli
// 0.1.3, #904): a trailing text-only assistant message is a client-side
// prefill (chat/roleplay frontends, "continue"/"impersonate" flows, bot
// frameworks). Keep the run in the tail so the session ledger
// (expectedMessages, client bytes) stays aligned with the client's own
// history across turns, and render it as a continuation carrier instead of
// the system-reminder treatment. AGY_BRIDGE_PREFILL=0 restores the stock
// reject; AGY_BRIDGE_PREFILL_CARRIER_NOTE overrides the carrier's note line.
const prefillTailEnabled = () => process.env.AGY_BRIDGE_PREFILL !== "0"
const prefillCarrierNote = () => process.env.AGY_BRIDGE_PREFILL_CARRIER_NOTE
  || "(system note: the fragment below is part of your own unfinished reply; continue exactly from where it stops, and do not repeat it.)"

// Concatenated text of an assistant message, or null when the message carries
// anything other than plain text blocks. An empty string means "no content".
function assistantTextOf(message) {
  if (!message || message.role !== "assistant") return null
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return null
  let text = ""
  for (const block of message.content) {
    if (!block || block.type !== "text" || typeof block.text !== "string") return null
    text += block.text
  }
  return text
}

// History/tail positions for a request that ends with an assistant prefill
// run: runStart = first message of the trailing text-only assistant run,
// boundary = history split point (after the last assistant message before the
// run, the session ledger's newest entry). Returns null when the request does
// not end with a text-only assistant run. Known limits: a request combining a
// live tool_result with a prefill tail is rejected in validateBody; a run with
// no user message before it puts the whole run in the tail, so that one turn
// degrades to a fresh session (safe, self-healing).
function prefillRun(messages) {
  const last = messages.at(-1)
  if (!last || last.role !== "assistant") return null
  if (assistantTextOf(last) === null) return null
  let runStart = messages.length
  while (runStart > 0 && messages[runStart - 1]?.role === "assistant" && assistantTextOf(messages[runStart - 1]) !== null) runStart--
  let boundary = runStart
  while (boundary > 0 && messages[boundary - 1]?.role !== "assistant") boundary--
  return { runStart, boundary }
}

function renderPrefillCarrierParts(message) {
  const body = (assistantTextOf(message) || "").trim()
  if (!body) return []
  return [{ type: "text", text: `${prefillCarrierNote()}\n${body}` }]
}

function trailingMessages(body) {
  body = canonicalBody(body)
  const run = prefillTailEnabled() ? prefillRun(body.messages) : null
  if (run) {
    return { history: body.messages.slice(0, run.boundary), messages: body.messages.slice(run.boundary) }
  }
  let start = body.messages.length
  while (start > 0 && body.messages[start - 1].role !== "assistant") start--
  return { history: body.messages.slice(0, start), messages: body.messages.slice(start) }
}

function lastAssistantCalls(messages) {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === "assistant") start--
  return messages.slice(start).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === "tool_use") : [])
}

function matchToolResults(body, blocks) {
  const direct = blocks.map(block => ({ block, match: toolCalls.get(block.tool_use_id) }))
  if (direct.every(item => item.match)) return direct
  const { history } = trailingMessages(body)
  const calls = lastAssistantCalls(history)
  const byID = new Map(calls.map((call, index) => [call.id, index]))
  if (!calls.length || byID.size !== calls.length || calls.some(call => !call.id) ||
    blocks.some(block => !byID.has(block.tool_use_id))) return direct
  let found = null
  for (const proc of allProcs) {
    if (!proc.turn || proc.turn.finalized || !proc.matchesHistory(history)) continue
    const shown = lastAssistantCalls(proc.expectedMessages)
    if (shown.length !== calls.length || shown.some((call, index) =>
      call.name !== calls[index].name || stableJSON(call.input ?? {}) !== stableJSON(calls[index].input ?? {}))) continue
    const mapped = blocks.map(block => ({ block, match: toolCalls.get(shown[byID.get(block.tool_use_id)].id) }))
    if (mapped.some((item, index) => direct[index].match && item.match !== direct[index].match)) continue
    if (mapped.some(item => !item.match) || !mapped.some(item => !item.match.call.mcpResponded || (item.match.call.deferred && !item.match.call.result))) continue
    if (found) throw new BusyError("agy bridge: renamed tool IDs match more than one pending conversation")
    found = mapped
  }
  return found || direct
}

function systemText(body) {
  if (!body.system) return ""
  return typeof body.system === "string" ? body.system : body.system.map((block) => block.text || "").join("\n")
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((block) => (typeof block === "string" ? block : block?.type === "text" ? block.text || "" : "")).join("")
}

// Streaming clients may inline the opening system prompt, then hoist it into
// `system` on a non-streaming retry. Trailing system notifications remain turn
// content, as in the existing protocol; only the opening prefix is lifted. (A
// wider rule that also lifted system messages before the first assistant would
// change a conversation's key between its first and second turn.)
function canonicalBody(body) {
  const messages = body?.messages
  if (!Array.isArray(messages)) return body
  let count = 0
  while (count < messages.length && messages[count]?.role === "system") count++
  if (!count || count === messages.length) return body
  const parts = [systemText(body), ...messages.slice(0, count).map((message) => contentText(message.content))]
  return { ...body, system: parts.filter((text) => text.trim()).join("\n\n"), messages: messages.slice(count) }
}

// inline: the opening system text arrived as messages; hoisted: in the system field.
function requestLayout(body) {
  return canonicalBody(body) !== body ? "inline" : "hoisted"
}

const lastLayouts = new Map()
const LAST_LAYOUT_MAX = 256

// Remember the previous layout per conversation; returns it when it flipped.
function noteLayout(convKey, layout) {
  const previous = lastLayouts.get(convKey)
  lastLayouts.delete(convKey)
  lastLayouts.set(convKey, layout)
  while (lastLayouts.size > LAST_LAYOUT_MAX) lastLayouts.delete(lastLayouts.keys().next().value)
  return previous && previous !== layout ? previous : null
}

function compactIdentity(text) {
  return String(text ?? "").replace(/\s+/g, "")
}

function sameInstructions(a, b) {
  return instructionsIdentity(a) === instructionsIdentity(b)
}

// The model is not part of the key: agy switches models inside a live session.
function conversationKey(rawBody) {
  const body = canonicalBody(rawBody)
  const system = historyKey([{ role: "system", content: compactIdentity(stripVolatileSystem(systemText(body))) }])
  const first = body.messages?.[0]
  // Hash the whole stripped first message, including non-text blocks such as
  // images. A shared 8 KiB text prefix must not put two chats in one session.
  // Later assistant/user turns are not part of this hash, so attaching history
  // does not change the key. Agent billing headers and opening reminder clocks
  // are stripped; user text is not.
  const firstText = first ? historyKey([first]) : ""
  const discriminator = body.metadata?.user_id || ""
  const source = discriminator + "\n" + system + "\n===\n" + firstText
  return createHash("sha256").update(source).digest("hex")
}
function appendSchemaHint(node, hint) {
  if (!hint) return
  if (typeof node.description === "string" && node.description.trim()) {
    if (!node.description.includes(hint)) node.description = `${node.description} (${hint})`
  } else {
    node.description = hint
  }
}


// Sanitize JSON Schema constructs that agy's ACP -> Google Code Assist translator
// converts into invalid Schema protos (e.g. union types leaving stale array/object
// keywords, or non-string/empty enum entries producing `enum[0]: cannot be empty`).
function sanitizeInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema
  const out = { ...schema }

  if (Array.isArray(out.type)) {
    const types = out.type.filter((item) => typeof item === "string")
    const nullable = types.includes("null")
    const nonNull = types.filter((item) => item !== "null")
    if (nonNull.length > 1) {
      let chosen = nonNull[0]
      if (nonNull.includes("array") && out.items !== undefined) chosen = "array"
      else if (nonNull.includes("object") && (out.properties !== undefined || out.additionalProperties !== undefined)) {
        chosen = "object"
      }
      out.type = nullable ? [chosen, "null"] : chosen
      appendSchemaHint(out, `Accepts types: ${types.join(" | ")}`)
    } else if (nonNull.length === 1) {
      out.type = nullable ? [nonNull[0], "null"] : nonNull[0]
    }
  }

  const resolvedType = typeof out.type === "string"
    ? out.type
    : Array.isArray(out.type)
      ? out.type.find((item) => item !== "null") || null
      : null

  if (resolvedType && resolvedType !== "array") {
    delete out.items
    delete out.prefixItems
    delete out.minItems
    delete out.maxItems
    delete out.uniqueItems
    delete out.contains
  }
  if (resolvedType && resolvedType !== "object") {
    delete out.properties
    delete out.patternProperties
    delete out.required
    delete out.minProperties
    delete out.maxProperties
    delete out.dependentRequired
  }

  if (Array.isArray(out.enum)) {
    const invalidEnum = out.enum.length === 0 ||
      (resolvedType && resolvedType !== "string") ||
      out.enum.some((item) => typeof item !== "string" || item.length === 0)
    if (invalidEnum) {
      if (out.enum.length) {
        appendSchemaHint(out, `Allowed values: ${out.enum.map((item) => JSON.stringify(item)).join(", ")}`)
      }
      delete out.enum
    }
  }

  if (out.const !== undefined && (typeof out.const !== "string" || out.const.length === 0 || (resolvedType && resolvedType !== "string"))) {
    appendSchemaHint(out, `Must equal: ${JSON.stringify(out.const)}`)
    delete out.const
  }

  if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, sanitizeInputSchema(value)]),
    )
    if (Array.isArray(out.required)) {
      const filtered = out.required.filter((key) => typeof key === "string" && Object.hasOwn(out.properties, key))
      if (filtered.length) out.required = filtered
      else delete out.required
    }
  }
  if (out.patternProperties && typeof out.patternProperties === "object" && !Array.isArray(out.patternProperties)) {
    out.patternProperties = Object.fromEntries(
      Object.entries(out.patternProperties).map(([key, value]) => [key, sanitizeInputSchema(value)]),
    )
  }
  if (out.additionalProperties && typeof out.additionalProperties === "object" && !Array.isArray(out.additionalProperties)) {
    out.additionalProperties = sanitizeInputSchema(out.additionalProperties)
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item) => sanitizeInputSchema(item))
  } else if (out.items && typeof out.items === "object") {
    out.items = sanitizeInputSchema(out.items)
  }
  if (Array.isArray(out.prefixItems)) {
    out.prefixItems = out.prefixItems.map((item) => sanitizeInputSchema(item))
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map((item) => sanitizeInputSchema(item))
  }
  if (out.not && typeof out.not === "object" && !Array.isArray(out.not)) {
    out.not = sanitizeInputSchema(out.not)
  }
  for (const defsKey of ["$defs", "definitions"]) {
    if (out[defsKey] && typeof out[defsKey] === "object" && !Array.isArray(out[defsKey])) {
      out[defsKey] = Object.fromEntries(
        Object.entries(out[defsKey]).map(([key, value]) => [key, sanitizeInputSchema(value)]),
      )
    }
  }
  for (const key of ["propertyNames", "contains", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"]) {
    if (out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = sanitizeInputSchema(out[key])
    }
  }
  if (out.dependentSchemas && typeof out.dependentSchemas === "object" && !Array.isArray(out.dependentSchemas)) {
    out.dependentSchemas = Object.fromEntries(
      Object.entries(out.dependentSchemas).map(([key, value]) => [key, sanitizeInputSchema(value)]),
    )
  }
  // agy (Go/RE2) will reject the whole toolbox if any pattern is only valid as
  // ECMA-262. Translate or drop those patterns here; tool-call arguments in
  // the response are plain JSON and do not need a reverse transform.
  sanitizePatternFields(out)
  return out
}

function normalizeTools(body) {
  if (!Array.isArray(body.tools) || !body.tools.length) return []
  const choice = body.tool_choice
  if (choice === "none" || choice?.type === "none") return []
  const selected = choice?.type === "tool" ? choice.name : null
  const seen = new Set()
  const tools = []
  for (const tool of body.tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name) {
      throw new UnsupportedContent("a tool without a valid name")
    }
    if (seen.has(tool.name)) throw new UnsupportedContent(`duplicate tool ${tool.name}`)
    seen.add(tool.name)
    if (selected && tool.name !== selected) continue
    const rawSchema = tool.input_schema ?? { type: "object", properties: {} }
    if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) {
      throw new UnsupportedContent(`an invalid schema for tool ${tool.name}`)
    }
    const inputSchema = ensureGeminiArrayItems(sanitizeInputSchema(expandToolSchema(rawSchema)))
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema,
    })
  }
  if (selected && !tools.length) throw new UnsupportedContent(`tool_choice names undeclared tool ${selected}`)
  return tools
}

function blockText(block) {
  if (typeof block === "string") return block
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new UnsupportedContent("a non-object content block")
  }
  if (block.type === "text") return typeof block.text === "string" ? block.text : ""
  if (block.type === "tool_addition" || block.type === "tool_removal") return ""
  if (block.type === "tool_reference" && typeof block.tool_name === "string") {
    return `Loaded tool: ${block.tool_name}`
  }
  if (block.type === "document") return parseUserDocumentText(block)
  if (block.type === "search_result") return parseSearchResultText(block)
  if (block.type === "image") {
    parseUserImage(block)
    return "[image]"
  }
  if (block.type === "tool_result") {
    const inner = Array.isArray(block.content)
      ? block.content.map((part) => {
        if (part?.type === "image") return "[image returned by tool]"
        return blockText(part)
      }).join("")
      : String(block.content ?? "")
    return `[tool result${block.tool_use_id ? " id=" + block.tool_use_id : ""}]\n${inner}\n[end of tool result]`
  }
  if (block.type === "tool_use") throw new UnsupportedContent("a tool_use block in a user message")
  throw new UnsupportedContent(`a content block of type ${JSON.stringify(block.type)}`)
}

function messageText(message) {
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) return message.content.map(blockText).join("")
  return String(message.content ?? "")
}

function imageContent(block) {
  const source = block.source
  if (source?.type !== "base64") {
    throw new UnsupportedContent("an image source other than base64; provide inline image data instead of a URL")
  }
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.media_type)) {
    throw new UnsupportedContent("an image media type other than PNG, JPEG, GIF or WebP")
  }
  if (typeof source.data !== "string" || !source.data ||
    source.data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(source.data.replace(/={1,2}$/, ""))) {
    throw new UnsupportedContent("invalid base64 image data")
  }
  return { type: "image", data: source.data, mimeType: source.media_type }
}

// Keep text adjacent to its images, including when an old conversation has to
// be replayed. Never interpolate image bytes into the text seen by the model.
function appendPrompt(out, content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content
  for (const block of blocks) {
    const last = out.at(-1)
    if (last?.type === "text" && block.type === "text") last.text += block.text
    else out.push({ ...block })
  }
}

function renderAssistantTurn(message) {
  const parts = []
  const blocks = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: String(message.content ?? "") }]
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text || "")
    else if (block.type === "tool_use") {
      parts.push(`[tool call ${block.name} id=${block.id || ""} args=${JSON.stringify(block.input ?? {})}]`)
    } else {
      const rendered = renderServerAssistantBlock(block)
      if (rendered) parts.push(rendered)
    }
  }
  return parts.join("\n")
}

function outputFormatReminder(body) {
  const format = body?.output_config?.format || body?.response_format
  if (!format || typeof format !== "object") return []
  if (format.type === "json_schema") {
    const schema = format.schema ?? format.json_schema?.schema
    if (schema && typeof schema === "object") {
      return [{
        type: "text",
        text: `<system-reminder>\nStructured output requirement: Respond ONLY with a single valid JSON value (no Markdown code fences, no backticks, and no explanatory prose before or after) conforming strictly to this JSON Schema:\n${JSON.stringify(schema)}\n</system-reminder>`,
      }]
    }
  }
  if (format.type === "json_object") {
    return [{
      type: "text",
      text: "<system-reminder>\nStructured output requirement: Respond ONLY with a single valid JSON object (no Markdown code fences, no backticks, and no explanatory prose before or after).\n</system-reminder>",
    }]
  }
  return []
}

function workDirNote(callerWorkDir) {
  return `The caller's working directory is ${JSON.stringify(callerWorkDir)}. The environment the caller describes (working directory, platform, OS, shell, git status) is where every tool runs. The bridge's temporary workspace only holds its agent configuration; use the caller's environment for tool paths and commands.`
}

// Session-level instructions: the client's system prompt plus where tools run.
function sessionInstructions(body, callerWorkDir) {
  const parts = []
  const system = systemText(canonicalBody(body))
  if (system.trim()) parts.push(system)
  if (callerWorkDir) parts.push(workDirNote(callerWorkDir))
  return parts.join("\n\n")
}

const QUEUED_PROMPT_PREFIX_RE = /^(?:The user sent (?:a new message while you were working|the following message)|The [^\r\n]+ plugin sent a message while you were working):\n([\s\S]*)$/
const QUEUED_PROMPT_SUFFIX_RE = /\n\n(?:This is how Claude Code surfaces (?:messages the user sends|prompts [^\r\n]+ submits) mid-turn[\s\S]*|IMPORTANT: After completing your current task, you MUST address the user's message above\. Do not ignore it\.|Please address this message and continue with your tasks\.)\s*$/

function extractQueuedPrompt(raw) {
  if (typeof raw !== "string") return null
  const cleanedRaw = stripMagpiePlaceholderNotice(raw)
  const hadPlaceholder = cleanedRaw !== raw
  let trimmed = cleanedRaw.trim()
  const reminder = /^<system-reminder(?:\s[^>]*)?>([\s\S]*)<\/system-reminder(?:\s[^>]*)?>$/.exec(trimmed)
  if (reminder) trimmed = reminder[1].trim()
  const match = QUEUED_PROMPT_PREFIX_RE.exec(trimmed)
  if (!match) return null
  const unwrapped = match[1].replace(QUEUED_PROMPT_SUFFIX_RE, "").trim()
  if (!hadPlaceholder) return unwrapped
  const placeholderTag = `<system-reminder>\n${MAGPIE_PLACEHOLDER_NOTICE}\n</system-reminder>`
  return unwrapped ? `${unwrapped}\n\n${placeholderTag}` : placeholderTag
}

function renderTurnMessage(message) {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      const queued = extractQueuedPrompt(message.content)
      return queued !== null ? queued : message.content
    }
    if (Array.isArray(message.content)) {
      const out = []
      let afterToolResult = false
      for (const block of message.content) {
        if (block?.type === "tool_result") {
          out.push(blockText(block))
          afterToolResult = true
          continue
        }
        const raw = blockText(block)
        const queued = block?.type === "text" ? extractQueuedPrompt(raw) : null
        const rendered = queued !== null ? queued : raw
        if (rendered && afterToolResult && !rendered.startsWith("\n")) {
          out.push("\n\n" + rendered)
        } else {
          out.push(rendered)
        }
        if (rendered) afterToolResult = false
      }
      return out.join("")
    }
    return messageText(message)
  }
  const blocks = Array.isArray(message.content) ? message.content : [message.content]
  const reminders = []
  const queuedParts = []
  for (const block of blocks) {
    const raw = blockText(block)
    const trimmed = raw.trim()
    if (!trimmed) continue
    const queued = extractQueuedPrompt(trimmed)
    if (queued !== null) {
      if (queued) queuedParts.push(queued)
    } else {
      reminders.push(raw)
    }
  }
  const out = []
  const joinedReminders = reminders.join("").trim()
  if (joinedReminders) {
    // System/developer notices are system-level text: cloaked like the system prompt.
    const notice = cloakPromptText(joinedReminders)
    out.push(/^<system-reminder(?:\s[^>]*)?>[\s\S]*<\/system-reminder(?:\s[^>]*)?>$/.test(notice)
      ? notice
      : `<system-reminder>\n${notice}\n</system-reminder>`)
  }
  out.push(...queuedParts)
  return out.join("\n\n")
}

function renderTurnMessageParts(message) {
  if (message.role !== "user" || !Array.isArray(message.content)) {
    let text = renderTurnMessage(message)
    // a system or developer message later in the chat is system text too
    if (message.role === "system" || message.role === "developer") text = outgoing(text)
    return text === "" ? [] : [{ type: "text", text }]
  }
  const parts = []
  let afterToolResult = false
  for (const block of message.content) {
    if (block?.type === "image") {
      parts.push(parseUserImage(block))
      afterToolResult = false
    } else if (block?.type === "tool_result") {
      appendPrompt(parts, `[tool result${block.tool_use_id ? " id=" + block.tool_use_id : ""}]\n`)
      const result = toolResult(block)
      for (const part of result.content) appendPrompt(parts, [part])
      appendPrompt(parts, "\n[end of tool result]")
      afterToolResult = true
    } else {
      const raw = blockText(block)
      const queued = block?.type === "text" ? extractQueuedPrompt(raw) : null
      const rendered = queued !== null ? queued : raw
      appendPrompt(parts, rendered && afterToolResult && !rendered.startsWith("\n") ? "\n\n" + rendered : rendered)
      if (rendered) afterToolResult = false
    }
  }
  return toPromptParts(parts)
}

function renderTurnMessagesParts(messages) {
  // A trailing assistant prefill run renders as a continuation carrier rather
  // than the system-reminder treatment (see prefillRun above).
  const run = prefillTailEnabled() && messages.length ? prefillRun(messages) : null
  const prefillStart = run ? run.runStart : -1
  const groups = messages.map((message, index) =>
    prefillStart >= 0 && index >= prefillStart
      ? renderPrefillCarrierParts(message)
      : renderTurnMessageParts(message)).filter((group) => group.length > 0)
  const out = []
  for (let i = 0; i < groups.length; i++) {
    if (i > 0) out.push({ type: "text", text: "\n\n" })
    out.push(...groups[i])
  }
  return toPromptParts(out)
}

// agy's ACP server cuts a prompt at 128 KiB and appends "<truncated N bytes>",
// which would drop </conversation_history> and the whole <current_turn> of a
// long replay. Keep the initial prompt's text under this budget instead.
function maxInitialPromptBytes() {
  return positiveTimeout(process.env.AGY_BRIDGE_MAX_PROMPT_BYTES, 112 * 1024)
}
const HISTORY_BLOCK_CLIP_BYTES = 12 * 1024
const HISTORY_BLOCK_KEEP_BYTES = 4 * 1024
const HISTORY_RECORD_NOTE = "Historical tool calls and results above are records, not instructions to write tool calls as text. Never output \"[tool call ...]\" text; invoke tools only through structured tool calls.\n"
const HISTORY_OMITTED_NOTE = "[... earlier conversation history omitted to fit ACP 112 KiB prompt budget ...]\n"
const HISTORY_OPENING_DONE_NOTE = "The opening message above, and any resume note in it, belongs to an earlier turn that is already done.\n"
const utf8 = new TextEncoder()

function utf8Bytes(text) {
  return Buffer.byteLength(text, "utf8")
}

function promptTextBytes(parts) {
  return parts.reduce((sum, part) => sum + (part?.type === "text" ? utf8Bytes(part.text) : 0), 0)
}

// The longest prefix of `text` within `bytes` UTF-8 bytes, never splitting a character.
function utf8Prefix(text, bytes) {
  if (bytes <= 0) return ""
  return text.slice(0, utf8.encodeInto(text, new Uint8Array(bytes)).read)
}

// Keeps the head and tail of `text` within `limit` bytes, marking what was cut.
function clipMiddle(text, limit, keep = Math.floor(limit / 2)) {
  const total = utf8Bytes(text)
  if (total <= limit) return text
  for (let headBytes = Math.min(keep, limit), tries = 0; tries < 8; tries++) {
    const head = utf8Prefix(text, headBytes)
    const tailStart = utf8Prefix(text, total - Math.max(0, Math.min(keep, limit - headBytes))).length
    const tail = text.slice(Math.max(tailStart, head.length))
    const marker = `\n[... ${total - utf8Bytes(head) - utf8Bytes(tail)} bytes omitted ...]\n`
    const clipped = head + marker + tail
    if (utf8Bytes(clipped) <= limit) return clipped
    keep = Math.floor(keep * 0.75)
    headBytes = Math.min(keep, limit)
  }
  return utf8Prefix(text, limit)
}

function clipHistoryText(text) {
  if (typeof text !== "string" || utf8Bytes(text) <= HISTORY_BLOCK_CLIP_BYTES) return text
  return headTail(text)
}

// Head 4 KiB + an omission note + tail 4 KiB of one oversized history block.
function headTail(text) {
  const total = utf8Bytes(text)
  const head = utf8Prefix(text, HISTORY_BLOCK_KEEP_BYTES)
  const tail = text.slice(utf8Prefix(text, total - HISTORY_BLOCK_KEEP_BYTES).length)
  return `${head}\n[... ${total - utf8Bytes(head) - utf8Bytes(tail)} bytes of this history block omitted ...]\n${tail}`
}

// A copy of a history message whose oversized text blocks, tool results and
// tool-call arguments keep only their head and tail. The original is untouched.
function clipHistoryMessage(message) {
  if (typeof message.content === "string") return { ...message, content: clipHistoryText(message.content) }
  if (!Array.isArray(message.content)) return message
  return {
    ...message,
    content: message.content.map((block) => {
      if (block?.type === "text" && typeof block.text === "string") return { ...block, text: clipHistoryText(block.text) }
      if (block?.type === "tool_result") {
        if (typeof block.content === "string") return { ...block, content: clipHistoryText(block.content) }
        if (Array.isArray(block.content)) {
          return { ...block, content: block.content.map((part) => part?.type === "text" && typeof part.text === "string"
            ? { ...part, text: clipHistoryText(part.text) } : part) }
        }
      }
      if (block?.type === "tool_use") {
        const args = JSON.stringify(block.input ?? {})
        if (utf8Bytes(args) > HISTORY_BLOCK_CLIP_BYTES) return { ...block, input: { truncated_arguments: headTail(args) } }
      }
      return block
    }),
  }
}

function renderHistoryEntry(message) {
  const out = []
  if (message.role === "assistant") {
    appendPrompt(out, `Assistant: ${renderAssistantTurn(message)}\n`)
  } else {
    const queued = message.role !== "user" && extractQueuedPrompt(messageText(message).trim()) !== null
    appendPrompt(out, message.role === "user" || queued ? "Human: " : `${message.role}: `)
    appendPrompt(out, renderTurnMessageParts(message))
    appendPrompt(out, "\n")
  }
  return out
}

// Shrinks the largest text parts (head and tail kept) until the text fits `limit`.
function clipPartsToBytes(parts, limit) {
  const out = parts.map((part) => ({ ...part }))
  for (let guard = 0; guard < 64; guard++) {
    const excess = promptTextBytes(out) - limit
    if (excess <= 0) break
    let largest = null
    for (const part of out) {
      if (part.type === "text" && (!largest || utf8Bytes(part.text) > utf8Bytes(largest.text))) largest = part
    }
    if (!largest) break
    const size = utf8Bytes(largest.text)
    largest.text = clipMiddle(largest.text, Math.max(0, size - excess))
  }
  return out
}

// Claude Code's and DeepSeek Harness's own user-role notes: reminders, context
// notices, local command output, interrupt markers, clock and runtime-context
// snapshots, repeat-tool warnings and mode switches. A user message of these
// alone is not a prompt from the user (#1055).
const LOCAL_COMMAND_RE = /<(local-command-caveat|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g
const DSH_TIME_CONTEXT_RE = /(?:^|\r?\n)Time sampled while preparing turn \d+, step \d+: [^\r\n]+(?:\r?\nBrowser time zone for this request: [^\r\n]+)?(?:\r?\nElapsed since the preceding (?:model-visible message|step context): [^\r\n]+)?/g
const DSH_REPEAT_TOOL_RE = /(?:^|\r?\n)(?:You are repeating the exact same tool call with identical arguments\. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call\.|Repeated tool call detected:\r?\n- tool: [^\r\n]+\r?\n- consecutive_calls: \d+\r?\n- arguments: [^\r\n]+\r?\nThe repeated calls are not making progress\. Do not call this tool with these exact arguments again\. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered\.)/g
const DSH_PLAN_MODE_RE = /(?:^|\r?\n)The user switched this session (?:to plan|back to the default) mode\.(?=\r?\n|$)/g
// DeepSeek Harness sends a runtime-context snapshot as its own user message;
// a gateway that merges user messages into one string could lose text after it.
const DSH_RUNTIME_SNAPSHOT_RE = /^Current runtime context(?:\. This snapshot supersedes earlier runtime-context snapshots\.(?:\r?\n[\s\S]*)?|: none\. Earlier runtime-context snapshots no longer apply\.)$/

function isMetaOnlyUserText(text) {
  const rest = stripMagpiePlaceholderNotice(text)
    .replace(SYSTEM_REMINDER_RE, "")
    .replace(CONTEXT_NOTICE_RE, "")
    .replace(LOCAL_COMMAND_RE, "")
    .replace(DSH_TIME_CONTEXT_RE, "")
    .replace(DSH_REPEAT_TOOL_RE, "")
    .replace(DSH_PLAN_MODE_RE, "")
    .replace(/\[Request interrupted by user(?: for tool use)?\]/g, "")
    .replace(/\[(?:SYSTEM NOTIFICATION|MESSAGE FROM NON-USER SOURCE) - NOT USER INPUT\]/g, "")
    .trim()
  return !rest || DSH_RUNTIME_SNAPSHOT_RE.test(rest)
}

function isToolResultMessage(message) {
  return Array.isArray(message?.content) && message.content.some((block) => block?.type === "tool_result")
}

// A user message with no tool result and something the user wrote or attached.
function isUserTask(message) {
  if (message?.role !== "user") return false
  if (typeof message.content === "string") return !isMetaOnlyUserText(message.content)
  if (!Array.isArray(message.content) || isToolResultMessage(message)) return false
  if (message.content.some((block) => block?.type === "image")) return true
  return message.content.some((block) => !isMetaOnlyUserText(blockText(block)))
}

// Index right after the last completed assistant reply (an assistant run with
// no tool_use), or 0 when the conversation is still in its first turn.
function lastCompletedTurnEnd(history) {
  for (let end = history.length; end > 0;) {
    if (history[end - 1].role !== "assistant") {
      end--
      continue
    }
    let start = end - 1
    while (start > 0 && history[start - 1].role === "assistant") start--
    const hasToolUse = history.slice(start, end).some((message) =>
      Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_use"))
    if (!hasToolUse) return end
    end = start
  }
  return 0
}

// Bounds of the non-assistant, non-tool_result run around `index` when at
// least one message in it is a user task; null when the run is meta-only.
function userTurnRun(history, index) {
  if (index < 0 || index >= history.length) return null
  let start = index
  while (start > 0 && history[start - 1].role !== "assistant" && !isToolResultMessage(history[start - 1])) start--
  let end = index + 1
  while (end < history.length && history[end].role !== "assistant" && !isToolResultMessage(history[end])) end++
  const all = []
  const tasks = []
  const rest = []
  for (let i = start; i < end; i++) {
    if (i === 0) continue
    all.push(i)
    if (isUserTask(history[i])) tasks.push(i)
    else rest.push(i)
  }
  const hasTask = tasks.length > 0 || (start === 0 && end > 0 && isUserTask(history[0]))
  return hasTask ? { all, tasks, rest } : null
}

// The user-turn run that opened the active tool loop, if any.
function loopOpeningRun(history, loopStart) {
  for (let i = loopStart; i < history.length; i++) {
    if (history[i].role === "assistant" || isToolResultMessage(history[i])) break
    if (isUserTask(history[i])) return userTurnRun(history, i)
  }
  return null
}

// The latest user-turn run at or after `loopStart`, never reaching back into
// an earlier completed turn.
function latestLoopTaskRun(history, loopStart) {
  for (let i = history.length - 1; i >= loopStart; i--) {
    if (isUserTask(history[i])) return userTurnRun(history, i)
  }
  return null
}

// Byte size of `indices` (sorted, unique) plus an omission note for each gap.
function keptSliceBytes(indices, totalLength, entries, noteBytes) {
  let bytes = 0
  let next = 0
  for (const i of indices) {
    if (i > next) bytes += noteBytes
    bytes += entries[i].bytes
    next = i + 1
  }
  if (next < totalLength) bytes += noteBytes
  return bytes
}

// `reserveBytes` is text the caller appends after </current_turn>.
function renderInitialPromptParts(body, callerWorkDir, instructionsInSession, reserveBytes = 0) {
  const { history, messages: current } = trailingMessages(body)
  const budget = Math.max(0, maxInitialPromptBytes() - reserveBytes)
  const head = []
  if (!instructionsInSession) {
    const system = cloakPromptText(systemText(body))
    if (system.trim()) appendPrompt(head, `<external_system_instructions>\n${system}\n</external_system_instructions>\n`)
    if (callerWorkDir) appendPrompt(head, `\n${workDirNote(callerWorkDir)}\n\n`)
  }
  const currentParts = renderTurnMessagesParts(current)
  // A fresh conversation needs no wrapper; it would only add tokens.
  if (!head.length && !history.length) return clipPartsToBytes(currentParts, budget)
  const historyOpen = history.length ? "<conversation_history>\n" : ""
  const historyClose = history.length ? HISTORY_RECORD_NOTE + "</conversation_history>\n\n" : ""
  const turnOpen = "<current_turn>\n"
  const turnClose = "\n</current_turn>"
  const frame = utf8Bytes(historyOpen + historyClose + turnOpen + turnClose)
  // Mandatory segments first: instructions, the frame and the current turn.
  // An oversized current turn keeps its head and tail; instructions shrink
  // only when they alone would not leave the current turn any room.
  let headParts = head
  let turn = currentParts
  if (promptTextBytes(headParts) + frame + promptTextBytes(turn) > budget) {
    const forTurn = Math.max(0, budget - frame - promptTextBytes(headParts))
    turn = clipPartsToBytes(turn, Math.max(forTurn, Math.min(promptTextBytes(turn), Math.floor((budget - frame) / 2))))
    headParts = clipPartsToBytes(headParts, Math.max(0, budget - frame - promptTextBytes(turn)))
  }
  let room = budget - frame - promptTextBytes(headParts) - promptTextBytes(turn)
  const render = (message) => {
    const parts = renderHistoryEntry(message)
    return { parts, bytes: promptTextBytes(parts) }
  }
  const overRoom = (list) => list.reduce((sum, entry) => sum + entry.bytes, 0) > room
  // A replay that fits is sent whole; only one that does not has its big
  // blocks clipped first (#1055).
  let entries = history.map(render)
  if (overRoom(entries)) entries = history.map((message) => render(clipHistoryMessage(message)))
  let kept = entries
  let showOpeningDone = false
  if (overRoom(entries)) {
    const noteBytes = utf8Bytes(HISTORY_OMITTED_NOTE)
    const inToolLoop = current.some(isToolResultMessage)
    const loopStart = inToolLoop ? lastCompletedTurnEnd(history) : history.length
    const openingDoneBytes = utf8Bytes(HISTORY_OPENING_DONE_NOTE)
    let reservedOpeningDone = false
    if (room < noteBytes) {
      kept = []
    } else {
      if (inToolLoop && loopStart > 0 && room >= noteBytes + openingDoneBytes) {
        reservedOpeningDone = true
        room -= openingDoneBytes
      }
      // Keep the opening anchor message and the newest messages that still fit;
      // the early middle of the conversation gives way to omission notes.
      let keep = []
      if (entries.length && keptSliceBytes([0], entries.length, entries, noteBytes) <= room) {
        keep.push(0)
      }
      // Mid tool loop, the user's prompt run that started it says what the loop is
      // for (plus any later user steer run): keep it after the anchor, with a note
      // for each gap (#1053, #1055).
      if (inToolLoop) {
        const runs = [loopOpeningRun(history, loopStart), latestLoopTaskRun(history, loopStart)].filter(Boolean)
        const whole = [...new Set([...keep, ...runs.flatMap((run) => run.all)])].sort((a, b) => a - b)
        if (whole.length > keep.length && keptSliceBytes(whole, entries.length, entries, noteBytes) <= room) {
          keep = whole
        } else {
          const order = [...new Set([...runs.flatMap((run) => run.tasks), ...runs.flatMap((run) => run.rest)])]
          for (const idx of order) {
            if (keep.includes(idx)) continue
            const nextKeep = [...keep, idx].sort((a, b) => a - b)
            if (keptSliceBytes(nextKeep, entries.length, entries, noteBytes) <= room) keep = nextKeep
          }
        }
      }
      let left = room - keptSliceBytes(keep, entries.length, entries, noteBytes)
      const tail = []
      const floor = keep.length ? keep.at(-1) : -1
      for (let i = entries.length - 1; i > floor; i--) {
        const cost = entries[i].bytes - (i === floor + 1 ? noteBytes : 0)
        if (cost > left) break
        left -= cost
        tail.unshift(i)
      }
      const keptIndices = [...keep, ...tail]
      kept = []
      let next = 0
      for (const i of keptIndices) {
        if (i > next) kept.push(null)
        kept.push(entries[i])
        next = i + 1
      }
      if (next < entries.length) kept.push(null)
      showOpeningDone = reservedOpeningDone && keep.includes(0) && kept.includes(null) &&
        keptIndices.some((i) => i >= loopStart && isUserTask(history[i]))
    }
  }
  const out = []
  appendPrompt(out, headParts)
  if (history.length) {
    appendPrompt(out, historyOpen)
    for (const entry of kept) appendPrompt(out, entry ? entry.parts : HISTORY_OMITTED_NOTE)
    if (showOpeningDone) appendPrompt(out, HISTORY_OPENING_DONE_NOTE)
    appendPrompt(out, historyClose)
  }
  appendPrompt(out, turnOpen)
  appendPrompt(out, turn)
  appendPrompt(out, turnClose)
  return promptTextBytes(out) <= budget ? out : clipPartsToBytes(out, budget)
}

function renderContinuedTurnParts(messages) {
  return renderTurnMessagesParts(messages)
}

function validateBody(body) {
  if (!Array.isArray(body?.messages) || !body.messages.length) {
    throw new UnsupportedContent("a request without messages")
  }
  const trailing = trailingMessages(body)
  const lastRole = body.messages.at(-1)?.role
  // A text-only assistant tail is a client-side prefill (see prefillRun).
  const prefillTail = prefillTailEnabled() && lastRole === "assistant" && assistantTextOf(body.messages.at(-1)) !== null
  const validTailRole = lastRole === "user" || lastRole === "system" || lastRole === "developer" || prefillTail
  if (prefillTail && extractToolResults(body).length) {
    throw new UnsupportedContent("a request combining a live tool_result with an assistant prefill tail")
  }
  if (!validTailRole || (!extractToolResults(body).length &&
    !trailing.messages.some((message) => message.role === "user") && !trailing.history.length)) {
    throw new UnsupportedContent(prefillTail
      ? "a request whose only messages are assistant prefill turns (no user turn to continue from)"
      : "a request whose last message is not from the user or a tool-result notification")
  }
  if (body.system && typeof body.system !== "string") {
    if (!Array.isArray(body.system) || body.system.some((block) => block?.type !== "text")) {
      throw new UnsupportedContent("a non-text system prompt")
    }
  }
  for (const message of body.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (ASSISTANT_ALLOWED_BLOCK_TYPES.has(block?.type)) continue
        throw new UnsupportedContent(`an assistant content block of type ${JSON.stringify(block?.type)}`)
      }
    } else if (message.role === "system" || message.role === "developer") {
      if (typeof message.content !== "string") {
        if (!Array.isArray(message.content)) throw new UnsupportedContent("a non-text system/developer message")
        for (const block of message.content) {
          if (block?.type === "text" && typeof block.text === "string") continue
          if (block?.type === "tool_addition" || block?.type === "tool_removal") continue
          if (block && typeof block.type === "string" && block.type !== "text") {
            throw new UnsupportedContent(`a non-text system/developer content block of type ${JSON.stringify(block.type)}`)
          }
          throw new UnsupportedContent("a non-text system/developer message")
        }
      }
    } else if (message.role === "user") {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "tool_result") toolResult(block)
          else if (block?.type === "image") parseUserImage(block)
          else if (block?.type === "text" || typeof block === "string") continue
          else if (block?.type === "document") parseUserDocumentText(block)
          else if (block?.type === "search_result") parseSearchResultText(block)
          else blockText(block)
        }
      } else if (typeof message.content !== "string") {
        messageText(message)
      }
    }
  }
}

function toolResult(block) {
  if (!block || typeof block.tool_use_id !== "string" || !block.tool_use_id) {
    throw new UnsupportedContent("a tool_result without tool_use_id")
  }
  let content
  if (typeof block.content === "string") {
    content = [{ type: "text", text: block.content }]
  } else if (Array.isArray(block.content)) {
    content = block.content.map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text }
      if (part?.type === "tool_reference" && typeof part.tool_name === "string") {
        return { type: "text", text: `Loaded tool: ${part.tool_name}` }
      }
      if (part?.type === "document") return { type: "text", text: parseUserDocumentText(part) }
      if (part?.type === "search_result") return { type: "text", text: parseSearchResultText(part) }
      if (part?.type === "image" && part.source?.type === "base64" && part.source.data) {
        return {
          type: "image",
          data: part.source.data,
          mimeType: part.source.media_type || "application/octet-stream",
        }
      }
      throw new UnsupportedContent("this tool_result content")
    })
  } else if (block.content == null) {
    content = [{ type: "text", text: "" }]
  } else {
    throw new UnsupportedContent("non-text tool_result content")
  }
  return { content, isError: block.is_error === true }
}

function extractToolResults(body) {
  return trailingMessages(body).messages.flatMap(message => message.role === "user" && Array.isArray(message.content)
    ? message.content.filter(block => block?.type === "tool_result") : [])
}

function isSkillResult(item) {
  if (item.call?.name === "Skill") return true
  const first = item.result?.content?.[0]
  return first?.type === "text" &&
    /^(?:Launching skill|Loaded skill instructions \(read-only\)): /.test(first.text || "")
}

function appendResultPart(results, index, part) {
  if (index < 0 || index >= results.length) {
    throw new UnsupportedContent("text beside a live tool_result; no matching tool companion")
  }
  const target = index
  const targetCall = results[target]?.call
  return results.map((item, i) => (targetCall ? item.call !== targetCall : i !== target) ? item : {
    ...item,
    result: {
      ...item.result,
      content: [...item.result.content, part],
    },
  })
}

function appendResultText(results, index, text) {
  return appendResultPart(results, index, { type: "text", text })
}

function isInterruptedToolTurn(body) {
  let seenResult = false
  for (const message of trailingMessages(body).messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content]
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        seenResult = true
        continue
      }
      if (block?.type === "image") {
        if (!seenResult) return false
        continue
      }
      const text = stripMagpiePlaceholderNotice(blockText(block))
      if (!seenResult && message.role === "user" && text.trim()) return false
      if (seenResult && message.role === "user" &&
        /^\[Request interrupted by user(?:\s+for tool use)?\]\s*$/.test(text)) {
        return true
      }
    }
  }
  return false
}

const NOTICE_TAG_NAMES = "system-update|teammate-message|agent-message|cross-session-message|coordinator-relay|channel|ide_opened_file|ide_selection|mcp-resource|mcp-resource-update|mcp-polling-update|post-tool-use-hook|user-prompt-submit-hook"
const CONTEXT_NOTICE_RE = new RegExp(
  `<(${NOTICE_TAG_NAMES})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>|(?:\\[(?:SYSTEM NOTIFICATION|MESSAGE FROM NON-USER SOURCE) - NOT USER INPUT\\][^<]*)?<task-notification>[\\s\\S]*?<\\/task-notification>`,
  "g",
)
const SYSTEM_REMINDER_RE = /<system-reminder(?:\s[^>]*)?>([\s\S]*?)<\/system-reminder(?:\s[^>]*)?>/g
const PROTOCOL_NOTICE_START_RE = new RegExp(
  `^(?:<(?:${NOTICE_TAG_NAMES}|task-notification|system-reminder)\\b|\\[(?:SYSTEM NOTIFICATION|MESSAGE FROM NON-USER SOURCE) - NOT USER INPUT\\])`,
)
const UNCLOSED_NOTICE_RE = new RegExp(
  `<\\/?(?:${NOTICE_TAG_NAMES}|task-notification|system-reminder)\\b`,
)

// Forward complete protocol-generated context notices, Claude Code hook outputs,
// and tool-companion blocks without turning arbitrary inline user instructions
// into MCP function_response text. Mid-turn queued_command prompts and follow-up
// user instructions after a rejected/stopped tool call set userSteered so the
// bridge replays them via session/prompt.
function inspectToolTurn(results, body) {
  let out = results
  let userSteered = false
  const notices = []
  let seenResult = false
  let resultIndex = -1
  const stoppedByHookOrUser = out.some((item) => item.result?.isError &&
    /^(?:The user doesn't want to proceed with this tool use\.|User rejected tool use\b|Operation stopped by hook\b|Execution stopped by hook\b|Blocked by PreToolUse hook\b|Hook PreToolUse:\S+ denied\b|API Error: Request was aborted\.|\[Request interrupted by user\b)/.test(resultText(item.result).trim()))
  const userInterruption = /(?:The user sent (?:a new message while you were working|the following message)|The [^\r\n]+ plugin sent a message while you were working):/
  const nonUserSourceNotice = /^\[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT\]\s*\n/
  const skillCompanion = /^\s*(?:Base directory for this skill:|ARGUMENTS:|Skill arguments:) /
  const imageCompanion = /^\[Image(?: source)?: [^\r\n]+\]$/
  const toolLoadedCompanion = /^Tools? loaded\.(?:\n\[id:[^\]\n]+\])*$/
  const loopNotice = /^\[\d+ prior \/loop wakeups? found nothing actionable; loop is healthy\.\]$/
  const tokenNoise = /^(?:<total_tokens>[^<]*<\/total_tokens>|Token usage: \S+; \S+ remaining|USD budget: \$\S+; \$\S+ remaining|Output tokens \u2014 turn: [^\r\n]+)$/
  const hookBoilerplateNoise = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook success:\s*(?:Success)?\s*$/
  const hookOutput = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook (?:additional context|success|blocking error(?: from command)?|stopped continuation|feedback):/
  const hookStoppedContinuation = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook stopped continuation:/
  const claudeMetaFeedback = /^(?:(?:Stop|SubagentStop|TeammateIdle|TaskCreated|TaskCompleted|PermissionRequest|PermissionDenied|PreCompact|PostCompact|Elicitation|ElicitationResult|ConfigChange|CwdChanged|FileChanged|WorktreeCreate|WorktreeRemove|InstructionsLoaded) hook feedback:\n[\s\S]+|UserPromptSubmit operation blocked by hook:\n[\s\S]+|The PermissionDenied hook indicated you may retry this tool call\.|The turn did not end: a tool call in your last message asked to end it, but another call in that message failed\.[\s\S]*|Your response above was stopped by a safety classifier \u2014 this is not a tool or API error\.[\s\S]*|The previous response failed to produce a valid tool call\. Please retry the tool call now\.|Your tool call was malformed and could not be parsed\. Please retry\.|Output token limit hit[\s\S]*|Your response (?:was cut off|above was cut off)[\s\S]*|\[Your previous response (?:had no visible output|reached the output limit)[\s\S]*\]|\[structured-output-enforce\][\s\S]*|\[projects-reply-gate\][\s\S]*|Linked in your reply but not sent:[\s\S]*|Goal check-in: \u00ab[\s\S]*)$/
  const isNoise = (value) => !value || tokenNoise.test(value) || hookBoilerplateNoise.test(value)
  for (const message of trailingMessages(body).messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content]
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        seenResult = true
        resultIndex = out.findIndex(item => item.block?.tool_use_id === block.tool_use_id)
        continue
      }
      if (block?.type === "image") {
        if (!seenResult) {
          // Same replay path as ordinary text before a live tool_result.
          // Keep the image on the request body so the new prompt can carry it;
          // never splice it into an MCP function response that has no result yet.
          userSteered = true
          continue
        }
        out = appendResultPart(out, resultIndex, parseUserImage(block))
        continue
      }
      const rawText = blockText(block)
      if (!seenResult && message.role === "user" && rawText.trim()) {
        // A user can steer a pending tool turn from either side of a tool_result.
        // Replay the instruction as a user prompt, never as an MCP tool response.
        userSteered = true
      }
      const text = stripMagpiePlaceholderNotice(rawText)
      if (text !== rawText && !notices.includes(MAGPIE_PLACEHOLDER_NOTICE)) {
        notices.push(MAGPIE_PLACEHOLDER_NOTICE)
      }
      const trimmed = text.trim()
      if (!trimmed) continue
      const preceding = out[resultIndex]
      const skillIndex = preceding && isSkillResult(preceding) ? resultIndex : -1
      const imageIndex = preceding?.result?.content?.some(part => part?.type === "image") ? resultIndex : -1
      const toolSearchIndex = preceding?.call?.name === "ToolSearch" ? resultIndex : -1
      if (message.role === "user" && skillCompanion.test(text)) {
        out = appendResultText(out, skillIndex, text)
        continue
      }
      if (message.role === "user") {
        if (extractQueuedPrompt(trimmed) !== null) {
          userSteered = true
          continue
        }
        if (nonUserSourceNotice.test(trimmed) && !/<task-notification\b/.test(trimmed)) {
          const check = trimmed.replace(CONTEXT_NOTICE_RE, "").replace(SYSTEM_REMINDER_RE, "")
          if (UNCLOSED_NOTICE_RE.test(check)) {
            throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
          }
          notices.push(trimmed)
          continue
        }
        if (imageCompanion.test(trimmed)) {
          out = appendResultText(out, imageIndex, trimmed)
          continue
        }
        if (toolLoadedCompanion.test(trimmed)) {
          out = appendResultText(out, toolSearchIndex, trimmed)
          continue
        }
        if (loopNotice.test(trimmed)) {
          notices.push(trimmed)
          continue
        }
        if (skillIndex >= 0 && /^#{1,6}\s+[^\r\n]*\b(?:skill|instructions)\b/i.test(trimmed) &&
          !isNoise(trimmed) && !PROTOCOL_NOTICE_START_RE.test(trimmed) &&
          !userInterruption.test(trimmed) && !hookOutput.test(trimmed) && !claudeMetaFeedback.test(trimmed)) {
          out = appendResultText(out, skillIndex, text)
          continue
        }
      }
      notices.push(...Array.from(text.matchAll(CONTEXT_NOTICE_RE), (match) => match[0]))
      const withoutNotices = text.replace(CONTEXT_NOTICE_RE, "")
      for (const match of withoutNotices.matchAll(SYSTEM_REMINDER_RE)) {
        const inner = match[1].trim()
        if (extractQueuedPrompt(inner) !== null || userInterruption.test(inner)) {
          userSteered = true
          continue
        }
        if (!isNoise(inner)) notices.push(inner)
      }
      const rest = withoutNotices.replace(SYSTEM_REMINDER_RE, "").trim()
      if (UNCLOSED_NOTICE_RE.test(rest)) {
        // Text that merely names a notice tag it does not close (a developer
        // message that quotes <system-reminder>, a user typing one, a hook's
        // context) is routed by who wrote it, never refused and never dropped.
        // A notice that opens and is cut short is still turned away.
        const wrapped = /^<system-reminder(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/system-reminder>$/.exec(trimmed)
        if (!wrapped && PROTOCOL_NOTICE_START_RE.test(rest)) {
          // a protocol notice that starts and is cut short: not a mention
          throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
        }
        if (wrapped || message.role === "system" || message.role === "developer") {
          // the gateway's wrapper for a developer message, or a system one
          const inner = wrapped ? wrapped[1] : rest
          if (extractQueuedPrompt(inner) !== null || userInterruption.test(inner)) userSteered = true
          else if (!isNoise(inner)) notices.push(outgoing(inner))
        } else if (message.role === "user") {
          userSteered = true
        } else if (!isNoise(rest)) {
          notices.push(outgoing(rest))
        }
        continue
      }
      if (message.role === "system" || message.role === "developer") {
        if (extractQueuedPrompt(rest) !== null || userInterruption.test(rest)) {
          userSteered = true
        } else if (!isNoise(rest)) {
          notices.push(outgoing(rest))
        }
      } else if (!isNoise(rest)) {
        if ((hookOutput.test(rest) || claudeMetaFeedback.test(rest)) && !userInterruption.test(rest)) {
          notices.push(rest)
        } else if (message.role === "user" || userSteered || stoppedByHookOrUser ||
          notices.some((item) => hookStoppedContinuation.test(item))) {
          userSteered = true
        } else {
          // text from neither the user nor the system (an assistant message
          // that landed after the result): the model is told it, as a notice
          notices.push(outgoing(rest))
        }
      }
    }
  }
  const finalResults = notices.length
    ? appendResultText(out, out.length - 1, `<system-reminder>\n${notices.join("\n\n")}\n</system-reminder>`)
    : out
  return { results: finalResults, userSteered }
}

function withContextNotices(results, body) {
  return inspectToolTurn(results, body).results
}

// When a previous tool-result HTTP request failed or was aborted before producing
// an assistant message, and the user subsequently enters a new standalone user
// message after the tool_result message, replay in a fresh session instead of
// wedging the conversation with HTTP 400.
function canReplayFollowUpAfterResults(body, rawResults) {
  const { history, messages } = trailingMessages(body)
  let lastResultIndex = -1
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === "user" && Array.isArray(message.content) &&
      message.content.some((block) => block?.type === "tool_result")) {
      lastResultIndex = i
    }
  }
  if (lastResultIndex < 0 || lastResultIndex >= messages.length - 1) return false
  const tail = messages.slice(lastResultIndex + 1)
  if (!tail.some((message) => message.role === "user")) return false
  try {
    withContextNotices(rawResults, { ...body, messages: [...history, ...messages.slice(0, lastResultIndex + 1)] })
  } catch {
    return false
  }
  for (const message of tail) {
    const rest = messageText(message).replace(CONTEXT_NOTICE_RE, "").replace(SYSTEM_REMINDER_RE, "")
    if (UNCLOSED_NOTICE_RE.test(rest)) return false
  }
  return true
}

function namedWorkDirectory(body, init) {
  const raw = new Headers(init.headers || {}).get("x-magpie-work-dir")
  if (raw) {
    try { return decodeURIComponent(raw) } catch { return raw }
  }
  const firstAssistant = body.messages.findIndex((message) => message.role === "assistant")
  const opening = firstAssistant < 0 ? body.messages : body.messages.slice(0, firstAssistant)
  const texts = []
  for (const message of [{ role: "system", content: body.system }, ...opening]) {
    if (typeof message.content === "string") texts.push(message.content)
    else if (Array.isArray(message.content)) {
      for (const block of message.content) if (block?.type === "text") texts.push(block.text || "")
    }
  }
  let directory = null
  const pattern = /(?:Primary working directory|^\s*(?:-\s*)?Working directory|Current working directory): *([^\r\n]+)$|<cwd>([^<\r\n]+)<\/cwd>/gm
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] || match[2]).trim().replace(/^[`'"]+|[`'"]+$/g, "")
      if (value) directory = value
    }
  }
  return directory
}

function workDirectory(directory) {
  if (!directory) return null
  let candidate = directory
  if (process.platform === "win32" && candidate.startsWith("/")) {
    const wsl = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(candidate)
    if (!wsl) return null
    candidate = `${wsl[1].toUpperCase()}:\\${(wsl[2] || "").replace(/\//g, "\\")}`
  }
  if (!path.isAbsolute(candidate)) return null
  try {
    if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate)
  } catch {}
  return null
}

function ensureControlServer() {
  if (controlServerPromise) return controlServerPromise
  controlServerPromise = new Promise((resolve, reject) => {
    const server = net.createServer((socket) => handleControlConnection(socket))
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      controlServer = server
      server.unref()
      resolve(server.address().port)
    })
  })
  return controlServerPromise
}

function tokenMatches(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false
  const a = createHash("sha256").update(left).digest()
  const b = createHash("sha256").update(right).digest()
  return timingSafeEqual(a, b)
}

function handleControlConnection(socket) {
  socket.setEncoding("utf8")
  let buffer = ""
  let handled = false
  socket.on("data", (data) => {
    if (handled) return
    buffer += data
    if (buffer.length > CONTROL_LINE_LIMIT) {
      socket.destroy()
      return
    }
    const newline = buffer.indexOf("\n")
    if (newline < 0) return
    handled = true
    let message
    try { message = JSON.parse(buffer.slice(0, newline)) } catch {
      socket.end(JSON.stringify({ error: { code: -32700, message: "invalid control JSON" } }) + "\n")
      return
    }
    const proc = sessions.get(message?.token)
    if (!proc || !tokenMatches(message.token, proc.token)) {
      socket.end(JSON.stringify({ error: { code: -32603, message: "invalid or expired bridge session" } }) + "\n")
      return
    }
    try {
      if (message.kind === "list") {
        socket.end(JSON.stringify({ result: { tools: proc.listTools() } }) + "\n")
        return
      }
      if (message.kind === "watch") {
        proc.addWatcher(socket)
        return
      }
      if (message.kind === "call") {
        proc.acceptMcpCall(message, socket)
        return
      }
      socket.end(JSON.stringify({ error: { code: -32601, message: "unknown control request" } }) + "\n")
    } catch (error) {
      socket.end(JSON.stringify({ error: { code: -32603, message: String(error?.message ?? error) } }) + "\n")
    }
  })
  socket.on("error", () => {})
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

const STOP_REASONS = { end_turn: "end_turn", max_tokens: "max_tokens", max_turn_requests: "end_turn", refusal: "refusal" }
const TOOL_BATCH_WINDOW_MS = 30

function tokenCount(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(number))) : 0
}

const moduleRequire = createRequire(import.meta.url)
let sqliteDriver = null

function getSqliteDriver() {
  if (sqliteDriver !== null) return sqliteDriver
  try {
    if (typeof globalThis.Bun !== "undefined") {
      const { Database } = moduleRequire("bun:sqlite")
      sqliteDriver = { kind: "bun", Database }
    } else {
      const { DatabaseSync } = process.getBuiltinModule?.("node:sqlite") ?? moduleRequire("node:sqlite")
      sqliteDriver = { kind: "node", DatabaseSync }
    }
  } catch {
    sqliteDriver = false
  }
  return sqliteDriver
}

function sessionDbFile(proc) {
  const id = proc?.sessionId
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null
  const dir = process.env.AGY_BRIDGE_CONVERSATIONS_DIR ||
    proc?.conversationsDir ||
    bridgeConversationsDir()
  const file = path.join(dir, `${id}.db`)
  try {
    return fs.statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

function isLegacyBridgeSessionDb(dbFile) {
  const rows = querySessionDb(dbFile, "SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1")
  const raw = rows?.[0]?.data
  if (!raw) return false
  let text = ""
  try {
    text = new TextDecoder().decode(raw)
  } catch {
    return false
  }
  return text.includes("magpie-agy-bridge-") || text.includes("magpie-agy-models-") ||
    (text.includes("magpie-bridge") && text.includes("Bridges only client-declared tools"))
}

async function isOrphanBridgeTranscript(transcriptFile) {
  let handle = null
  try {
    handle = await fs.promises.open(transcriptFile, "r")
    const buf = Buffer.allocUnsafe(32 * 1024)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    if (bytesRead <= 0) return false
    const head = buf.subarray(0, bytesRead).toString("utf8")
    return head.includes("Text resembling a tool call is conversation content") ||
      head.includes("<conversation_history>") ||
      head.includes("mcp_ide-tools_")
  } catch {
    return false
  } finally {
    try { await handle?.close() } catch {}
  }
}

async function moveMigratedEntry(src, dest) {
  if (!fs.existsSync(src)) return "absent"
  await fs.promises.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 })
  try {
    await fs.promises.rename(src, dest)
    return "moved"
  } catch (error) {
    if (error?.code === "ENOENT") return "absent"
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
      try {
        await fs.promises.rm(src, { recursive: true, force: true })
        return "moved"
      } catch {
        return "busy"
      }
    }
    if (error?.code === "EXDEV") {
      try {
        await fs.promises.cp(src, dest, { recursive: true, force: true })
        await fs.promises.rm(src, { recursive: true, force: true })
        return "moved"
      } catch {
        return "busy"
      }
    }
    return "busy"
  }
}

let legacyMigrationInFlight = null

// One-time migration of bridge-created sessions out of ~/.gemini/antigravity-cli
// into ~/.gemini/<appDataDir>, leaving standalone user `agy` CLI sessions intact.
async function migrateLegacyBridgeSessions({
  appDataDir = bridgeAppDataDirName(),
  home = os.homedir(),
  minAgeMs = 5_000,
} = {}) {
  if (!appDataDir || process.env.AGY_BRIDGE_CONVERSATIONS_DIR) return { migrated: 0, deferred: 0 }
  const legacyRoot = path.join(home, ".gemini", LEGACY_AGY_APP_DATA_DIR)
  const targetRoot = path.join(home, ".gemini", appDataDir)
  const sentinel = path.join(targetRoot, ".migrated-legacy-v1")
  if (fs.existsSync(sentinel)) return { migrated: 0, deferred: 0 }
  const legacyConvDir = path.join(legacyRoot, "conversations")
  const legacyBrainDir = path.join(legacyRoot, "brain")
  if (!fs.existsSync(legacyConvDir) && !fs.existsSync(legacyBrainDir)) return { migrated: 0, deferred: 0 }

  let migrated = 0
  let deferred = 0
  let scanned = 0
  const yieldIfNeeded = async () => {
    if (++scanned % 12 === 0) await new Promise((resolve) => setImmediate(resolve))
  }

  if (fs.existsSync(legacyConvDir)) {
    const names = await fs.promises.readdir(legacyConvDir).catch(() => [])
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]{1,128}\.db$/.test(name)) continue
      await yieldIfNeeded()
      const sid = name.slice(0, -3)
      const dbFile = path.join(legacyConvDir, name)
      const stat = await fs.promises.stat(dbFile).catch(() => null)
      if (!stat?.isFile() || !isLegacyBridgeSessionDb(dbFile)) continue
      if (minAgeMs > 0 && globalThis.Date.now() - stat.mtimeMs < minAgeMs) {
        deferred++
        continue
      }
      const moves = await Promise.all([
        moveMigratedEntry(dbFile, path.join(targetRoot, "conversations", name)),
        moveMigratedEntry(`${dbFile}-wal`, path.join(targetRoot, "conversations", `${name}-wal`)),
        moveMigratedEntry(`${dbFile}-shm`, path.join(targetRoot, "conversations", `${name}-shm`)),
        moveMigratedEntry(`${dbFile}-journal`, path.join(targetRoot, "conversations", `${name}-journal`)),
        moveMigratedEntry(path.join(legacyBrainDir, sid), path.join(targetRoot, "brain", sid)),
        moveMigratedEntry(path.join(legacyRoot, "annotations", `${sid}.pb`), path.join(targetRoot, "annotations", `${sid}.pb`)),
        moveMigratedEntry(path.join(legacyRoot, "annotations", sid), path.join(targetRoot, "annotations", sid)),
      ])
      if (moves.includes("busy")) deferred++
      else if (moves.includes("moved")) migrated++
    }
  }

  if (fs.existsSync(legacyBrainDir)) {
    const sids = await fs.promises.readdir(legacyBrainDir).catch(() => [])
    for (const sid of sids) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) continue
      if (fs.existsSync(path.join(legacyConvDir, `${sid}.db`))) continue
      await yieldIfNeeded()
      const transcriptFile = path.join(legacyBrainDir, sid, ".system_generated", "logs", "transcript.jsonl")
      const stat = await fs.promises.stat(transcriptFile).catch(() => null)
      if (!stat?.isFile() || !(await isOrphanBridgeTranscript(transcriptFile))) continue
      if (minAgeMs > 0 && globalThis.Date.now() - stat.mtimeMs < minAgeMs) {
        deferred++
        continue
      }
      const moves = await Promise.all([
        moveMigratedEntry(path.join(legacyBrainDir, sid), path.join(targetRoot, "brain", sid)),
        moveMigratedEntry(path.join(legacyRoot, "annotations", `${sid}.pb`), path.join(targetRoot, "annotations", `${sid}.pb`)),
        moveMigratedEntry(path.join(legacyRoot, "annotations", sid), path.join(targetRoot, "annotations", sid)),
      ])
      if (moves.includes("busy")) deferred++
      else if (moves.includes("moved")) migrated++
    }
  }

  if (deferred === 0) {
    try {
      await fs.promises.mkdir(targetRoot, { recursive: true, mode: 0o700 })
      await fs.promises.writeFile(
        sentinel,
        `${JSON.stringify({ version: 1, migrated, at: globalThis.Date.now() })}\n`,
        { mode: 0o600 },
      )
    } catch {}
  }
  return { migrated, deferred }
}

function scheduleLegacyBridgeMigration() {
  if (legacyMigrationInFlight || process.env.AGY_BRIDGE_CONVERSATIONS_DIR || process.env.AGY_BRIDGE_STATE_FILE) return
  const appDataDir = bridgeAppDataDirName()
  if (!appDataDir) return
  const home = os.homedir()
  const sentinel = path.join(home, ".gemini", appDataDir, ".migrated-legacy-v1")
  if (fs.existsSync(sentinel)) return
  const legacyRoot = path.join(home, ".gemini", LEGACY_AGY_APP_DATA_DIR)
  if (!fs.existsSync(path.join(legacyRoot, "conversations")) && !fs.existsSync(path.join(legacyRoot, "brain"))) return
  setImmediate(() => {
    if (legacyMigrationInFlight) return
    const run = migrateLegacyBridgeSessions({ appDataDir, home }).catch(() => {}).finally(() => {
      if (legacyMigrationInFlight === run) legacyMigrationInFlight = null
    })
    legacyMigrationInFlight = run
  })
}

function querySessionDb(file, sql, ...params) {
  const driver = getSqliteDriver()
  if (!driver) return null
  if (driver.kind === "bun") {
    let db = null
    let stmt = null
    try {
      db = new driver.Database(file, { readonly: true })
      stmt = db.prepare(sql)
      return stmt.all(...params)
    } catch {
      return null
    } finally {
      try { stmt?.finalize?.() } catch {}
      try { db?.close?.(false) } catch {}
    }
  }
  let db = null
  try {
    db = new driver.DatabaseSync(file, { readOnly: true, timeout: 50 })
    return db.prepare(sql).all(...params)
  } catch {
    return null
  } finally {
    try { db?.close?.() } catch {}
  }
}

function readProtoVarint(bytes, offset, end) {
  let value = 0n
  let shift = 0n
  let pos = offset
  while (pos < end && shift < 70n) {
    const byte = bytes[pos++]
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: pos }
    shift += 7n
  }
  return null
}

function protoTokenCount(big) {
  if (big <= 0n || big >= (1n << 62n)) return 0
  return big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big)
}

// Decodes exa.codeium_common_pb.ModelUsageStats (field 1.4 in agy's SQLite
// gen_metadata blob): f2=input_tokens, f3=output_tokens, f4=cache_write_tokens,
// f5=cache_read_tokens, f9=thinking_output_tokens, f10=response_output_tokens.
function parseModelUsageStats(bytes, start, end) {
  let inputTokens = 0
  let reportedOutput = 0
  let cachedWriteTokens = 0
  let cachedReadTokens = 0
  let thoughtTokens = 0
  let responseTokens = 0
  let pos = start
  while (pos < end) {
    const tag = readProtoVarint(bytes, pos, end)
    if (!tag) return null
    pos = tag.next
    const field = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (wire === 0) {
      const val = readProtoVarint(bytes, pos, end)
      if (!val) return null
      pos = val.next
      if (field === 2) inputTokens = protoTokenCount(val.value)
      else if (field === 3) reportedOutput = protoTokenCount(val.value)
      else if (field === 4) cachedWriteTokens = protoTokenCount(val.value)
      else if (field === 5) cachedReadTokens = protoTokenCount(val.value)
      else if (field === 9) thoughtTokens = protoTokenCount(val.value)
      else if (field === 10) responseTokens = protoTokenCount(val.value)
    } else if (wire === 1) {
      pos += 8
      if (pos > end) return null
    } else if (wire === 2) {
      const len = readProtoVarint(bytes, pos, end)
      if (!len) return null
      pos = len.next + protoTokenCount(len.value)
      if (pos > end) return null
    } else if (wire === 5) {
      pos += 4
      if (pos > end) return null
    } else {
      return null
    }
  }
  const outputTokens = Math.max(reportedOutput, thoughtTokens + responseTokens)
  if (inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens <= 0) return null
  return {
    inputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    outputTokens,
    thoughtTokens,
    totalTokens: inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens,
  }
}

function parseGenMetadataUsage(blob) {
  if (!(blob instanceof Uint8Array) || !blob.length) return null
  let found = null
  const scanMessage = (start, end, targetField, onSubmessage) => {
    let pos = start
    while (pos < end) {
      const tag = readProtoVarint(blob, pos, end)
      if (!tag) return
      pos = tag.next
      const field = Number(tag.value >> 3n)
      const wire = Number(tag.value & 7n)
      if (wire === 0) {
        const val = readProtoVarint(blob, pos, end)
        if (!val) return
        pos = val.next
      } else if (wire === 1) {
        pos += 8
      } else if (wire === 2) {
        const len = readProtoVarint(blob, pos, end)
        if (!len) return
        const subStart = len.next
        const subEnd = subStart + protoTokenCount(len.value)
        if (subEnd > end) return
        if (field === targetField) onSubmessage(subStart, subEnd)
        pos = subEnd
      } else if (wire === 5) {
        pos += 4
      } else {
        return
      }
    }
  }
  scanMessage(0, blob.length, 1, (outerStart, outerEnd) => {
    scanMessage(outerStart, outerEnd, 4, (statsStart, statsEnd) => {
      const stats = parseModelUsageStats(blob, statsStart, statsEnd)
      if (stats) found = stats
    })
  })
  return found
}

function syncGenCursor(proc) {
  const file = sessionDbFile(proc)
  if (!file) return
  const rows = querySessionDb(file, "SELECT MAX(idx) AS maxIdx FROM gen_metadata")
  const rawMax = rows?.[0]?.maxIdx
  if (rawMax === null || rawMax === undefined) return
  const maxIdx = Number(rawMax)
  if (Number.isInteger(maxIdx) && maxIdx > proc.lastGenIdx) proc.lastGenIdx = maxIdx
}

// agy writes per-generation ModelUsageStats into conversations/<sessionId>.db
// before invoking each MCP tool call, while ACP omits intermediate usage until
// session/prompt returns. Advance the per-session cursor and return the latest
// valid generation added since the previous response step.
function consumeStepGenUsage(proc, turn) {
  const file = sessionDbFile(proc)
  if (!file) return null
  const rows = querySessionDb(file, "SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC", proc.lastGenIdx)
  if (!Array.isArray(rows) || !rows.length) return null
  let lastRaw = null
  for (const row of rows) {
    const rawIdx = row?.idx
    if (rawIdx !== null && rawIdx !== undefined) {
      const idx = Number(rawIdx)
      if (Number.isInteger(idx) && idx > proc.lastGenIdx) proc.lastGenIdx = idx
    }
    const parsed = parseGenMetadataUsage(row?.data)
    if (parsed) lastRaw = parsed
  }
  if (!lastRaw) return null
  const translated = translateUsage(lastRaw, proc, turn)
  return translated ? { raw: lastRaw, translated } : null
}

// ACP usage accumulates the internal model calls of one session/prompt, in
// agy's exclusive ledger (same for every model family): inputTokens (I) is
// uncached input only and excludes cachedReadTokens (R) and cachedWriteTokens
// (W); outputTokens (O) already includes thoughtTokens (T); and
// totalTokens = I + R + W + O. The three input buckets map one-to-one.
// A report off this contract keeps the same mapping and is logged (numbers only).
function translateUsage(usage, proc = null, turn = null) {
  if (!usage || typeof usage !== "object") return null
  const input = tokenCount(usage.inputTokens)
  const cacheRead = tokenCount(usage.cachedReadTokens)
  const cacheWrite = tokenCount(usage.cachedWriteTokens)
  const reportedOutput = tokenCount(usage.outputTokens)
  const thinking = tokenCount(usage.thoughtTokens)
  const output = Math.max(reportedOutput, thinking)
  const hasTotal = usage.totalTokens !== undefined && usage.totalTokens !== null
  const expectedTotal = input + cacheRead + cacheWrite + reportedOutput
  const totalDelta = hasTotal ? tokenCount(usage.totalTokens) - expectedTotal : 0
  if (totalDelta !== 0 || thinking > reportedOutput) {
    logBridgeEvent(proc, turn, "usage", "acp_contract_mismatch", { convKey: proc?.convKey }, {
      acp_input: input, acp_cache_read: cacheRead, acp_cache_write: cacheWrite,
      acp_output: reportedOutput, acp_thought: thinking,
      acp_total: hasTotal ? tokenCount(usage.totalTokens) : null, total_delta: totalDelta,
      thought_over_output: Math.max(0, thinking - reportedOutput),
    })
  }
  const thinkingShown = Math.min(thinking, output)
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    ...(thinkingShown > 0 ? { output_tokens_details: { thinking_tokens: thinkingShown } } : {}),
  }
}

// Calibration family of an agy model id: the id without its effort suffix.
// claude-sonnet-5-5-low -> claude-sonnet-5-5, gemini-4-argon-high -> gemini-4-argon.
function calibrationFamily(model) {
  const id = String(model ?? "").trim().split("/").pop().toLowerCase()
  const pattern = new RegExp(`-(?:${EFFORT_ORDER.join("|")})$`)
  return id.replace(pattern, "") || "default"
}

// Where a session keeps the client system prompt. Gemini benefits from agy's
// session-level append; Claude, GPT-OSS and unknown families get it inline in
// the first prompt, which keeps their upstream prompt cache stable. An empty
// model resolves as the default family (gemini-4-argon).
function instructionsPlacement(model) {
  const id = String(model ?? "").trim().split("/").pop() || "gemini-4-argon"
  return /^gemini-/i.test(id) ? "session" : "inline"
}

function responseOutputEstimate(content) {
  let output = 0
  let thinking = 0
  for (const block of content) {
    if (block.type === "thinking") {
      const tokens = estimateTextTokens(block.thinking)
      thinking += tokens
      output += tokens
    } else if (block.type === "text") {
      output += estimateTextTokens(block.text)
    } else if (block.type === "tool_use") {
      output += estimateTextTokens(JSON.stringify(block))
    }
  }
  return { output: tokenCount(output), thinking: tokenCount(thinking) }
}

function calibrationOf(proc, family) {
  return proc?.calibration instanceof Map ? proc.calibration.get(family || "default") : null
}

function inputTokenScaleOf(proc, family) {
  const scale = calibrationOf(proc, family)?.scale
  return Number.isFinite(scale) ? Math.max(0.5, Math.min(1.5, scale)) : 1
}

function cacheRatioOf(proc, family) {
  const ratio = calibrationOf(proc, family)?.cacheRatio
  return Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
}

// Splits `total` input tokens over the three buckets in proportion to
// (input, read, write): read and write are rounded, and uncached input takes
// the remainder so the three buckets always sum to exactly `total`.
function splitInputUsage(total, input, read, write) {
  const whole = input + read + write
  const cacheRead = whole > 0 ? Math.min(total, tokenCount(total * read / whole)) : 0
  const cacheWrite = whole > 0 ? Math.min(total - cacheRead, tokenCount(total * write / whole)) : 0
  return { input_tokens: total - cacheRead - cacheWrite, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite }
}

// Input-side usage fields derived from a request-body estimate (the same basis
// the intermediate tool steps use), split by the family's last cache ratio.
function estimatedInputUsage(proc, estimate, family) {
  const total = Math.max(1, tokenCount(estimate * inputTokenScaleOf(proc, family)))
  const read = Math.min(total, tokenCount(total * cacheRatioOf(proc, family)))
  return { input_tokens: total - read, cache_read_input_tokens: read, cache_creation_input_tokens: 0 }
}

// Usage for one HTTP response. ACP reports one accumulated total for a whole
// session/prompt, which may span several HTTP responses (tool round-trips and
// late tool results). Reporting that total on the last response makes clients
// bill the earlier steps again, so each response settles on its own:
//   - a lone model call keeps the exact ACP numbers (translateUsage);
//   - tool-step responses get a non-zero estimate scaled by what earlier
//     responses taught us about this model family's tokenizer and cache ratio;
//   - the final response gets the accumulated ACP input (I + R + W) times this
//     step's share of the estimated input, never above 1.5x its own estimate,
//     split over the three buckets in the measured proportions;
//   - an incremental ACP result.usage (a fraction of the window) is lifted to
//     the estimate basis so the reported window never collapses, keeping the
//     measured read/write proportions (usageKind "context_floor").
function responseUsage(proc, turn, step, content, result) {
  if (step.settled) return step.usage
  const final = result !== undefined
  const cancelled = result?.stopReason === "cancelled"
  const translated = final ? translateUsage(result?.usage, proc, turn) : null
  const single = final && !cancelled && !turn.calls.length &&
    !turn.toolResponseCount && !turn.hasLatePrompt && turn.promptCount <= 1 && turn.responseSteps.length === 1
  step.usageKind = single && translated ? "exact" : "bounded_step_estimate"

  const family = turn.family || calibrationFamily(turn.model)
  const estimate = turn.stepInputEstimates[step.estimateIndex] || step.inputEstimate
  const scale = inputTokenScaleOf(proc, family)
  const window = Math.max(1, tokenCount(estimate * scale))
  // ACP result.usage can be incremental (a fraction of the window) instead of
  // cumulative. A final input total below half of the scaled estimate is not a
  // context size: report the estimate basis so the window never collapses.
  const floor = estimate > 0 ? tokenCount(0.5 * estimate * scale) : 0
  const measured = translated
    ? [translated.input_tokens, translated.cache_read_input_tokens, translated.cache_creation_input_tokens]
    : [0, 0, 0]
  const measuredTotal = measured[0] + measured[1] + measured[2]
  const lifted = (buckets = measured, total = measuredTotal) => {
    step.usageKind = "context_floor"
    return total > 0 ? splitInputUsage(window, ...buckets) : estimatedInputUsage(proc, estimate, family)
  }
  if (single && translated) {
    if (!(floor > 0 && measuredTotal < floor)) return translated
    return { ...translated, ...lifted() }
  }

  const gen = !single && !cancelled ? consumeStepGenUsage(proc, turn) : null
  const genMeasured = gen
    ? [gen.translated.input_tokens, gen.translated.cache_read_input_tokens, gen.translated.cache_creation_input_tokens]
    : [0, 0, 0]
  const genTotal = genMeasured[0] + genMeasured[1] + genMeasured[2]

  let inputUsage
  if (genTotal > 0) {
    step.genRaw = gen.raw
    if (floor > 0 && genTotal < floor) {
      inputUsage = lifted(genMeasured, genTotal)
    } else {
      step.usageKind = "gen_metadata"
      inputUsage = {
        input_tokens: genMeasured[0],
        cache_read_input_tokens: genMeasured[1],
        cache_creation_input_tokens: genMeasured[2],
      }
    }
  } else if (!final || measuredTotal === 0) {
    // No measured numbers for this step: the scaled estimate split by the
    // family's cache ratio; nothing is known about cache writes.
    inputUsage = estimatedInputUsage(proc, estimate, family)
  } else {
    const sum = turn.stepInputEstimates.reduce((total, value) => total + value, 0)
    const weight = estimate / Math.max(estimate, sum)
    const stepTotal = Math.min(tokenCount(measuredTotal * weight), tokenCount(1.5 * estimate))
    inputUsage = floor > 0 && stepTotal < floor ? lifted() : splitInputUsage(stepTotal, ...measured)
  }
  const emitted = responseOutputEstimate(content)
  const genOutput = gen ? gen.translated.output_tokens : 0
  const genThinking = gen ? tokenCount(gen.translated.output_tokens_details?.thinking_tokens) : 0
  const output = gen
    ? Math.max(final ? 0 : 1, emitted.output, genOutput)
    : final
      ? Math.max(emitted.output, tokenCount((translated?.output_tokens || 0) - turn.emittedOutputTokens))
      : Math.max(1, emitted.output)
  const thinking = Math.min(output, Math.max(emitted.thinking, genThinking))
  return {
    ...inputUsage,
    output_tokens: output,
    ...(thinking > 0 ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
  }
}

// agy's ACP stream carries thought summaries without the model's own signature.
// Clients keep and replay a thinking block only with a signature, so the bridge
// issues one: an HMAC over the session and text under a per-process key. It is
// not an Anthropic signature; agy keeps its own context and needs none back.
const THINKING_KEY = randomBytes(32)
const THINKING_SIGNATURE_PREFIX = "agyb1."

function thinkingSignature(sessionId, thinking) {
  return THINKING_SIGNATURE_PREFIX +
    createHmac("sha256", THINKING_KEY).update(String(sessionId) + "\n" + thinking).digest("base64url")
}

function makeAnthropicStream(proc, turn, body, msgId, signal, step = turn.registerResponse(body), initialEvent = null) {
  const encoder = new TextEncoder()
  const responseContent = []
  const forwardThinking = hostOption("thinking_summary", "AGY_BRIDGE_THINKING", true) && body.thinking?.type !== "disabled"
  let blockIndex = 0
  let open = null
  let pingTimer = null
  let finished = false
  let abortHandler = null
  // What this response has produced so far, for sizing a late prompt's input.
  step.contentSnapshot = () => [
    ...responseContent,
    ...(open ? [open.type === "text"
      ? { type: "text", text: open.text }
      : { type: "thinking", thinking: open.text }] : []),
  ]

  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)))
      const closeBlock = () => {
        if (!open) return
        if (open.type === "text") {
          responseContent.push({ type: "text", text: open.text })
        } else {
          const signature = thinkingSignature(proc.sessionId, open.text)
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "signature_delta", signature },
          })
          responseContent.push({ type: "thinking", thinking: open.text, signature })
        }
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
        open = null
      }
      const emitDelta = (type, text) => {
        if (!text) return
        if (open?.type !== type) {
          closeBlock()
          send("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
          })
          open = { type, text: "" }
        }
        open.text += text
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: type === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text },
        })
      }
      const emitToolUse = (call) => {
        closeBlock()
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          // Schema sanitization is outbound only: tool_use carries id, name, and
          // JSON arguments, never the parameter schema, so nothing is rewritten here.
          content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        })
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) },
        })
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
        responseContent.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })
      }
      const detach = () => {
        finished = true
        turn.detach()
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = null
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler)
        abortHandler = null
      }
      const stopMessage = (stopReason, usage, final = false, calibrate = final || Boolean(step.genRaw)) => {
        // The final, absolute usage of this response: always all four fields
        // (a missing one is 0), never an increment over message_start.
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: usageSnapshot(usage),
        })
        turn.recordResponseUsage(step, usage, final, calibrate)
        send("message_stop", { type: "message_stop" })
      }
      const partial = () => {
        const content = [...responseContent]
        if (open?.type === "text" && open.text) content.push({ type: "text", text: open.text })
        return content.filter((block) => block.type !== "thinking")
      }
      const abort = () => {
        if (finished) return
        detach()
        if (!proc.cancelTurn(turn, partial())) {
          dropFromPool(proc)
          proc.abandonTurn(turn)
          proc.stop().catch(() => {})
        }
        try { controller.error(signal?.reason || new Error("request aborted")) } catch {}
      }
      abortHandler = abort
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }

      try {
        send("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            // Neutral on purpose: hosts that merge "a positive value replaces"
            // (Magpie 0.1.3150) would otherwise keep an opening estimate over a
            // real final 0. The settled numbers come in message_delta.
            usage: { ...ZERO_USAGE },
          },
        })
        pingTimer = setInterval(() => {
          try { send("ping", { type: "ping" }) } catch {}
        }, PING_INTERVAL_MS)

        let pendingEvent = initialEvent
        for (;;) {
          const event = pendingEvent ?? await turn.next()
          pendingEvent = null
          if (finished) return
          if (event.type === "text") {
            emitDelta("text", event.text)
            continue
          }
          if (event.type === "thinking") {
            if (forwardThinking) emitDelta("thinking", event.text)
            continue
          }
          if (event.type === "tool") {
            emitToolUse(event.call)
            // Calls agy issued together leave in the same response. Separate MCP
            // sockets can arrive in adjacent event-loop turns, so wait a bounded
            // window for the whole batch (never a debounce that restarts per call).
            const emittedIds = new Set([event.call.id])
            const batchDeadline = performance.now() + TOOL_BATCH_WINDOW_MS
            for (;;) {
              const remaining = batchDeadline - performance.now()
              if (!turn.events.length && (remaining <= 0 || turn.done || turn.cancelRequested || turn.finalized)) break
              const next = turn.events.length ? turn.events.shift() : await turn.next(remaining, signal)
              if (finished) return
              if (!next) break
              if (next.type !== "tool") {
                // Preserve the boundary for the next HTTP response. Text,
                // completion and errors must never be pulled across a batch.
                turn.events.unshift(next)
                break
              }
              if (!emittedIds.has(next.call.id)) {
                emittedIds.add(next.call.id)
                emitToolUse(next.call)
              }
              if (performance.now() >= batchDeadline) break
            }
            stopMessage("tool_use", responseUsage(proc, turn, step, responseContent))
            proc.recordAssistantResponse(turn, responseContent)
            detach()
            controller.close()
            return
          }
          if (event.type === "result") {
            closeBlock()
            turn.rawUsage = event.result.usage ?? turn.rawUsage
            const usage = responseUsage(proc, turn, step, responseContent, event.result)
            stopMessage(STOP_REASONS[event.result.stopReason] || "end_turn", usage, true, event.result.stopReason !== "cancelled")
            proc.recordAssistantResponse(turn, responseContent)
            proc.finalizeTurn(turn)
            detach()
            controller.close()
            return
          }
          if (event.type === "error") {
            closeBlock()
            send("error", {
              type: "error",
              error: { type: event.error?.kind || "api_error", message: String(event.error?.message ?? event.error) },
            })
            if (!event.error?.keepProcess) {
              dropFromPool(proc)
              await proc.stop().catch(() => {})
            }
            if (finished) return
            proc.finalizeTurn(turn)
            detach()
            controller.close()
            afterAgentErrorResponse(proc, turn, event.error)
            return
          }
        }
      } catch (error) {
        if (finished) return
        turn.fail(error)
        dropFromPool(proc)
        await proc.stop().catch(() => {})
        if (finished) return
        try {
          closeBlock()
          send("error", {
            type: "error",
            error: { type: "api_error", message: String(error?.message ?? error) },
          })
          proc.finalizeTurn(turn)
          detach()
          controller.close()
        } catch {
          proc.finalizeTurn(turn)
          detach()
          try { controller.error(error) } catch {}
        }
      }
    },
    async cancel() {
      if (finished) return
      abortHandler?.()
    },
  })
}

function estimateTextTokens(text) {
  if (!text) return 0
  let ascii = 0
  let nonAsciiBytes = 0
  const buf = Buffer.from(String(text), "utf8")
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] < 0x80) ascii++
    else nonAsciiBytes++
  }
  return Math.ceil(ascii / 4 + nonAsciiBytes / 3)
}

function estimateInputTokens(body) {
  let total = 0
  let images = 0
  const walk = (value) => {
    if (value == null) return
    if (typeof value === "string") {
      total += estimateTextTokens(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value === "object") {
      if (value.type === "image" && value.source?.type === "base64") {
        images++
        return
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === "cache_control" || key === "signature") continue
        walk(item)
      }
    }
  }
  walk(body.system)
  walk(body.messages)
  if (Array.isArray(body.tools) && body.tools.length) {
    // A tool-level cache_control is a client cache hint, not model input.
    const toolsWithoutHints = body.tools.map((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool
      const { cache_control: _hint, ...rest } = tool
      return rest
    })
    total += estimateTextTokens(JSON.stringify(toolsWithoutHints))
  }
  return Math.max(1, total + images * 1600)
}

const ZERO_USAGE = Object.freeze({
  input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
})

// A complete four-field usage object; output_tokens_details passes through.
function usageSnapshot(usage) {
  const snapshot = {
    input_tokens: tokenCount(usage?.input_tokens),
    cache_read_input_tokens: tokenCount(usage?.cache_read_input_tokens),
    cache_creation_input_tokens: tokenCount(usage?.cache_creation_input_tokens),
    output_tokens: tokenCount(usage?.output_tokens),
  }
  if (usage?.output_tokens_details) snapshot.output_tokens_details = { ...usage.output_tokens_details }
  return snapshot
}

function estimatePromptPartsTokens(parts) {
  let total = 0
  let images = 0
  for (const part of parts || []) {
    if (part?.type === "text" && part.text) total += estimateTextTokens(part.text)
    else if (part?.type === "image") images++
  }
  return total + images * 1600
}

async function jsonResponseFromStream(stream, fallbackModel, fallbackId, fallbackInputUsage = null) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let message = {
    id: fallbackId,
    type: "message",
    role: "assistant",
    model: fallbackModel,
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    // message_delta carries the settled usage; message_start's is not a default.
    usage: { ...ZERO_USAGE },
  }
  const blocks = new Map()
  let streamError = null
  let sawDelta = false

  const processBlock = (raw) => {
    let eventName = ""
    let dataLine = ""
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim()
      else if (line.startsWith("data:")) dataLine += line.slice(5).trim()
    }
    if (!dataLine) return
    let payload
    try { payload = JSON.parse(dataLine) } catch { return }
    if (eventName === "message_start" && payload.message) {
      const { usage: _opening, ...opening } = payload.message
      message = { ...message, ...opening, content: [] }
    } else if (eventName === "content_block_start" && payload.content_block) {
      blocks.set(payload.index, { ...payload.content_block, _json: "" })
    } else if (eventName === "content_block_delta" && payload.delta) {
      const current = blocks.get(payload.index)
      if (!current) return
      if (payload.delta.type === "text_delta") current.text = (current.text || "") + (payload.delta.text || "")
      else if (payload.delta.type === "thinking_delta") current.thinking = (current.thinking || "") + (payload.delta.thinking || "")
      else if (payload.delta.type === "signature_delta") current.signature = payload.delta.signature
      else if (payload.delta.type === "input_json_delta") current._json += payload.delta.partial_json || ""
    } else if (eventName === "content_block_stop") {
      const current = blocks.get(payload.index)
      if (!current) return
      blocks.delete(payload.index)
      if (current.type === "tool_use" && current._json) {
        try { current.input = JSON.parse(current._json) } catch {}
      }
      delete current._json
      message.content.push(current)
    } else if (eventName === "message_delta") {
      if (payload.delta?.stop_reason !== undefined) message.stop_reason = payload.delta.stop_reason
      if (payload.delta?.stop_sequence !== undefined) message.stop_sequence = payload.delta.stop_sequence
      // An absolute snapshot replaces the usage wholesale; an explicit 0 stays 0.
      if (payload.usage) message.usage = { ...ZERO_USAGE, ...payload.usage }
      sawDelta = true
    } else if (eventName === "error") {
      streamError = payload.error || { type: "api_error", message: "stream error" }
    }
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      processBlock(frame)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) processBlock(buffer)
  // Only a stream that ended without its message_delta falls back to the
  // request-body estimate.
  if (!sawDelta && fallbackInputUsage) message.usage = { ...ZERO_USAGE, ...fallbackInputUsage, output_tokens: 0 }

  if (streamError) {
    const status = streamError.type === "rate_limit_error" ? 429 : 502
    return new Response(JSON.stringify({ type: "error", error: streamError }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }
  return new Response(JSON.stringify(message), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

const ABORTED_RESPONSE = Symbol("abortedResponse")

async function openStreamResponse(proc, turn, body, msgId, signal, step) {
  const forwardThinking = hostOption("thinking_summary", "AGY_BRIDGE_THINKING", true) && body.thinking?.type !== "disabled"
  const abortBeforeHeaders = () => {
    turn.detach()
    if (!proc.cancelTurn(turn, [])) {
      dropFromPool(proc)
      proc.abandonTurn(turn)
      proc.stop().catch(() => {})
    }
    const reason = signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")
    throw { [ABORTED_RESPONSE]: true, cause: reason }
  }
  try {
    if (signal?.aborted) abortBeforeHeaders()
    for (;;) {
      const event = await turn.next(0, signal)
      if (!event) abortBeforeHeaders()
      if (event.type === "thinking" && (!forwardThinking || !event.text)) continue
      if (event.type === "text" && !event.text) continue
      if (event.type === "error") {
        if (!event.error?.keepProcess) {
          dropFromPool(proc)
          await proc.stop().catch(() => {})
        }
        proc.finalizeTurn(turn)
        turn.detach()
        afterAgentErrorResponse(proc, turn, event.error)
        const errorType = event.error?.kind || "api_error"
        const status = Number.isInteger(event.error?.statusCode)
          ? event.error.statusCode
          : errorType === "rate_limit_error" ? 429 : 502
        return new Response(JSON.stringify({
          type: "error",
          error: { type: errorType, message: String(event.error?.message ?? event.error) },
        }), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      }
      const stream = makeAnthropicStream(proc, turn, body, msgId, signal, step, event)
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      })
    }
  } catch (error) {
    if (error && typeof error === "object" && error[ABORTED_RESPONSE]) throw error
    turn.fail(error)
    dropFromPool(proc)
    await proc.stop().catch(() => {})
    proc.finalizeTurn(turn)
    turn.detach()
    return jsonError(502, String(error?.message ?? error))
  }
}

function streamResponse(proc, turn, body, signal) {
  turn.attach()
  const step = turn.registerResponse(body)
  const msgId = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24)
  if (body.stream === false) {
    const stream = makeAnthropicStream(proc, turn, body, msgId, signal, step)
    return jsonResponseFromStream(stream, body.model, msgId, estimatedInputUsage(proc, step.inputEstimate, turn.family))
  }
  return openStreamResponse(proc, turn, body, msgId, signal, step)
}

// Tool results a kept session already holds (answered to its live MCP calls
// when the user steered) are not sent again in the steer's prompt.
function withoutAnswered(messages, answered) {
  if (!answered?.size) return messages
  return messages.map((message) => message.role === "user" && Array.isArray(message.content)
    ? { ...message, content: message.content.filter((block) => !(block?.type === "tool_result" && answered.has(block.tool_use_id))) }
    : message)
}

async function beginTurn(proc, history, body, callerWorkDir, model, selection, answered) {
  const reminder = outputFormatReminder(body)
  const flattened = proc.pendingFlattenedTurn
  proc.pendingFlattenedTurn = null
  const isFirstTurn = !proc.hasSentFirstTurn
  const baseParts = !isFirstTurn
    ? renderContinuedTurnParts(flattened
      ? [flattened, ...body.messages.slice(1)]
      : withoutAnswered(body.messages.slice(history.length), answered))
    : renderInitialPromptParts(body, callerWorkDir, proc.instructionsInSession,
      reminder.length ? promptTextBytes(reminder) + 2 : 0)
  const contentParts = mergePromptParts(baseParts, reminder)
  if (promptHasImage(contentParts) && !proc.supportsImages) {
    if (isFirstTurn) {
      dropFromPool(proc)
      await proc.stop().catch(() => {})
    }
    throw new UnsupportedContent("image input with this agy ACP server; update to an image-capable agy version")
  }
  if (isFirstTurn) {
    const rawEstimate = estimateInputTokens(body)
    const sessionOverhead = (proc.instructionsInSession && body.system
      ? estimateInputTokens({ system: body.system, messages: [] })
      : 0) + (Array.isArray(body.tools) && body.tools.length ? estimateTextTokens(JSON.stringify(body.tools)) : 0)
    const sentEstimate = Math.max(1, sessionOverhead + estimatePromptPartsTokens(contentParts))
    const clipThreshold = Math.min(HISTORY_BLOCK_CLIP_BYTES, maxInitialPromptBytes())
    const promptClipped = utf8Bytes(JSON.stringify(body.messages)) > clipThreshold &&
      rawEstimate > sentEstimate + 64
    proc.omittedHistoryTokens = promptClipped ? rawEstimate - sentEstimate : 0
  }
  return proc.startTurn(contentParts, body.messages, model, selection)
}

export const AntigravityBridgePlugin = async (input, packageOptions) => {
  applyPluginConfig(input, packageOptions)
  scheduleLegacyBridgeMigration()
  const readUsage = createUsageReader(findAgy, { waitForGate: waitForAccountSwitch,
    isGateClosed: () => Boolean(switching), getGeneration: () => accountGeneration })
  usageReaders.add(readUsage)
  return {
    auth: {
      provider: PROVIDER_ID,
      single: true,
      // Providers-page boolean switches; the host re-reads them on every
      // call, so flipping one takes effect without restarting the host.
      options: [
        {
          key: "thinking_summary",
          label: "Thinking summaries",
          description: "Forward agy thought summaries as thinking blocks. Off: responses carry no thinking text (same as AGY_BRIDGE_THINKING=0).",
          default: true,
          labels: {
            zh: "转发思考摘要",
            "zh-TW": "轉發思考摘要",
          },
          descriptions: {
            zh: "开启后，把 agy 输出的思考摘要作为 thinking 块返回给客户端。关闭后回复不带思考文本（等同于设置 AGY_BRIDGE_THINKING=0），改完下一条请求立即生效。",
            "zh-TW": "開啟後，將 agy 輸出的思考摘要作為 thinking 區塊回傳給用戶端。關閉後回覆不帶思考文字（等同於設定 AGY_BRIDGE_THINKING=0），修改後下一筆請求立即生效。",
          },
        },
        {
          key: "minimal_agent",
          label: "Minimal isolated agent",
          description: "Run agy with a minimal isolated agent. Off: agy's default prompt components are kept, costing about 2,600 more input tokens on every model call. Applies to newly started agy processes.",
          default: true,
          labels: {
            zh: "精简隔离代理",
            "zh-TW": "精簡隔離代理",
          },
          descriptions: {
            zh: "开启后，用精简隔离模式启动 agy，去掉其自带的默认提示词组件。关闭后会保留默认提示词，每次模型调用大约多花 2,600 个输入 token；切换后下一次请求自动换新进程生效。",
            "zh-TW": "開啟後，以精簡隔離模式啟動 agy，去除其內建的預設提示詞組件。關閉後會保留預設提示詞，每次模型呼叫約多耗用 2,600 個輸入 token；切換後下一次請求自動換新行程生效。",
          },
        },
        {
          key: "prompt_cloak",
          label: "Get Claude Code subagents past Antigravity's fake 429",
          description: "Antigravity answers Claude Agent SDK, Codex GPT-5 and Hermes system prompts (Claude Code subagents, claude -p) with a fake 429 that agy retries forever. On: a zero-width space goes inside those words in what agy is sent. May be against Google's terms. Off: as written (AGY_BRIDGE_PROMPT_CLOAK=0).",
          default: true,
          labels: {
            zh: "绕过 Claude Code 子代理的假 429",
            "zh-TW": "繞過 Claude Code 子代理的假 429",
          },
          descriptions: {
            zh: "Antigravity 看到 Claude Agent SDK（Claude Code 子代理、claude -p）、Codex GPT-5、Hermes 旧人设的系统提示词会回假 429，agy 无限重试、工具调不起来。开启后在发给 agy 的系统文本里给这几句插入零宽空格，模型理解不变；这会改动发给 Google 的内容，可能违反其条款。关闭后原样发送（同 AGY_BRIDGE_PROMPT_CLOAK=0）。",
            "zh-TW": "Antigravity 看到 Claude Agent SDK（Claude Code 子代理、claude -p）、Codex GPT-5、Hermes 舊人設的系統提示詞會回假 429，agy 無限重試、工具呼叫不起來。開啟後在傳給 agy 的系統文字裡給這幾句插入零寬空格，模型理解不變；這會改動傳給 Google 的內容，可能違反其條款。關閉後原樣傳送（同 AGY_BRIDGE_PROMPT_CLOAK=0）。",
          },
        },
        {
          key: "auto_switch",
          label: "Auto-switch agy accounts",
          description: "When the current agy account runs out of quota, stop this plugin's agy processes and switch to the next account from plugin Options → accounts. Rewrites the agy account files under ~/.gemini; skipped while other agy work is running.",
          default: false,
          confirm: "Auto-switch rewrites ~/.gemini/google_accounts.json and the agy OAuth token file. Do not run another account switcher at the same time. Enable?",
          labels: {
            zh: "多账号自动切号",
            "zh-TW": "多帳號自動切換",
          },
          descriptions: {
            zh: "开启后，当前 agy 账号额度用尽时自动停掉本插件启动的 agy 进程，按插件 Options → accounts 顺序切到下一个已备份账号（改写 ~/.gemini 下的账号文件）；外部有其他 agy 正在运行时跳过，WSL 宿主下不生效。",
            "zh-TW": "開啟後，目前 agy 帳號額度用盡時自動停掉本外掛啟動的 agy 行程，依外掛 Options → accounts 順序切換至下一個已備份帳號（改寫 ~/.gemini 下的帳號檔案）；外部有其他 agy 正在執行時略過，WSL 宿主下不生效。",
          },
          confirms: {
            zh: "开启自动切号会改写 ~/.gemini/google_accounts.json 和 agy 的 OAuth 令牌文件。开启期间请不要同时运行其他切号工具。确定开启吗？",
            "zh-TW": "開啟自動切換會改寫 ~/.gemini/google_accounts.json 與 agy 的 OAuth 權杖檔案。開啟期間請勿同時執行其他切號工具。確定開啟嗎？",
          },
        },
      ],
      // Magpie's usage hook; OpenCode ignores this extension. agy owns auth.
      usage: async () => readAccountUsage(readUsage),
      methods: [
        {
          // agy's own Google sign-in (`agy acp --login`): magpie opens its
          // link and takes the code the page shows. agy keeps the token;
          // the plugin's account is only "agy", saved once agy says the
          // sign-in took and lists the account's models.
          type: "oauth",
          label: "Sign in with Google",
          authorize: async () => {
            const agy = findAgy()
            if (!agy) {
              return {
                type: "failed",
                error: "agy CLI not found. Install Antigravity CLI first: https://antigravity.google/docs/cli",
              }
            }
            let admitted = false
            let probe
            try {
              while (switching) await waitForAccountSwitch()
              preparingRequests++
              admitted = true
              probe = await probeSignedIn(agy)
            } catch (error) {
              return { type: "failed", error: error.message }
            } finally {
              if (admitted) preparingRequests--
            }
            // signed in to agy already (or local renewable credential hit only a
            // transient network/timeout error during `agy models`): reuse local agy
            const canReuseLocal = probe.ok || (
              probe.stored?.state === "present" &&
              probe.stored.canRenew &&
              probe.networkFailed &&
              !isDead(probe.stored)
            )
            if (canReuseLocal) {
              if (autoSwitchEnabled()) captureCurrent({ home: os.homedir(), vaultDir: defaultVaultDir() })
              return { url: "", instructions: "", method: "auto", callback: async () => ({ type: "success", key: "agy" }) }
            }
            const login = await startLogin(agy)
            if (login.error) return { type: "failed", error: login.error }
            return {
              url: login.url,
              instructions: "",
              method: "code",
              callback: async (code, opts = {}) => {
                const done = await login.finish(code, { signal: opts.signal })
                if (done.error) return { type: "failed", error: done.error }
                // agy stored a new sign-in: read it again, and let what
                // failed with the old one run again
                syncBridgeTokenFile()
                forgetStoredSignIn({ dead: true })
                // A new account: what agy offered the last one, or refused
                // before the sign-in, is asked again.
                forgetOffered()
                const probe = await probeSignedIn(agy)
                if (!probe.ok) return { type: "failed", error: `agy signed in, but ${probe.why}` }
                if (autoSwitchEnabled()) captureCurrent({ home: os.homedir(), vaultDir: defaultVaultDir() })
                return { type: "success", key: "agy" }
              },
            }
          },
        },
      ],
      loader: async () => {
        return {
          baseURL: "agy://local",
          apiKey: "agy",
          fetch: async (fetchInput, init = {}) => {
            const requestUrl = typeof fetchInput === "string"
              ? fetchInput
              : fetchInput instanceof URL
                ? fetchInput.href
                : fetchInput?.url || ""
            if (/\/count[_-]tokens(?:$|[/?#])/i.test(requestUrl)) {
              try {
                const raw = init.body != null
                  ? (typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body))
                  : (typeof fetchInput?.text === "function" ? await fetchInput.text() : "")
                const parsed = JSON.parse(raw)
                if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
                  return jsonError(400, "invalid count_tokens request")
                }
                return new Response(JSON.stringify({ input_tokens: estimateInputTokens(parsed) }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                })
              } catch (error) {
                return jsonError(400, error.message)
              }
            }

            const agy = findAgy()
            if (!agy) return jsonError(503, "agy CLI not found on this machine")
            // nothing stored to sign agy in with: agy would only start its
            // own Google sign-in, so the account is told to sign in again
            // (from the last read; a request doesn't wait for a new one)
            const notSignedIn = cannotSignIn(storedSignInNow())
            if (notSignedIn) {
              return jsonError(401, `${notSignedIn}: sign in again in magpie, or run \`agy\` in a terminal`, undefined,
                { headers: { "X-Magpie-Sign-In": "expired" } })
            }
            let body
            try {
              const raw = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)
              body = JSON.parse(raw)
              validateBody(body)
            } catch (error) {
              return jsonError(error.statusCode ?? 400, error.message)
            }

            const accountAdmission = { active: false }
            try {
              while (switching) await waitForAccountSwitch()
              accountAdmission.active = true
              preparingRequests++
              const rawModel = body.model || ""
              const requestedModel = (rawModel.includes("/") ? rawModel.split("/").pop() : rawModel).replace(/\[1m\]$/i, "")
              // One canonical form for both opening-system layouts, before anything
              // derives a key, instructions or history from the body.
              const layout = requestLayout(body)
              body = { ...canonicalBody(body), model: requestedModel }
              const model = resolveAgyModel(await loadModelCatalog(agy), requestedModel, body)
              const selection = { model: requestedModel, effort: requestedEffort(body) }
              const convKey = conversationKey(body)
              const trailing = trailingMessages(body)
              const isFresh = trailing.history.length === 0
              const resultBlocks = extractToolResults(body)
              const callerWorkDir = namedWorkDirectory(body, init)
              const workDir = workDirectory(callerWorkDir)
              const instructions = sessionInstructions(body, callerWorkDir)

              const tools = normalizeTools(body)
              for (const message of body.messages) {
                if (message.role !== "assistant" || !Array.isArray(message.content)) continue
                for (const block of message.content) {
                  if (block?.type !== "tool_use") continue
                  const entry = toolCalls.get(block.id)
                  if (!entry || entry.call.clientSeen) continue
                  entry.call.clientSeen = true
                  entry.turn.touchClient()
                }
              }
              const reqId = "req_" + randomBytes(4).toString("hex")
              rememberRequestMeta(reqId, { layout, nonstream: body.stream === false })
              // Same conversation, other layout: one key, no replacement session.
              // Routine for some clients, so reported only in verbose mode.
              if (noteLayout(convKey, layout) && process.env.AGY_BRIDGE_EVENTS === "verbose") {
                logBridgeEvent(null, null, "layout_flip", "layout_canonicalized",
                  { reqId, convKey, layout, nonstream: body.stream === false })
              }
              const acquireOpts = { model, selection, tools, workDir, instructions, history: trailing.history,
                accountAdmission,
                messages: body.messages, layout, nonstream: body.stream === false, reqId, convKey,
                hasToolResults: resultBlocks.length > 0, userId: body.metadata?.user_id || "" }
              let answeredIds = null
              const begin = (proc, history) => beginTurn(proc, history, body, callerWorkDir, model, selection, answeredIds)
              let keptSession = false
              const limitTokens = maxInputTokens(model, rawModel)
              const inputEstimate = limitTokens > 0 ? estimateInputTokens(body) : 0
              if (resultBlocks.length) {
                const matches = matchToolResults(body, resultBlocks)
                const found = matches.filter((item) => item.match)
                if (found.length) {
                  if (found.length !== matches.length) {
                    return jsonError(409, "agy bridge: some tool results do not belong to the active response")
                  }
                  const proc = found[0].match.proc
                  const turn = found[0].match.turn
                  if (found.some((item) => item.match.proc !== proc || item.match.turn !== turn)) {
                    return jsonError(409, "agy bridge: tool results from different conversations cannot be combined")
                  }
                  if (proc.turn !== turn) return jsonError(409, "agy bridge: the tool response has already completed")
                  if (turn.attached) throw new BusyError("agy bridge: this conversation already has an active response")
                  if (turn.steering) throw new BusyError("agy bridge: this conversation is already steering this tool turn")
                  noProgressRepeats.delete(convKey) // matched results are real progress
                  const rawResults = matches.map(({ block, match }) => ({
                    block,
                    call: match.call,
                    result: toolResult(block),
                  }))
                  proc.validateResults(rawResults)
                  let interrupted = isInterruptedToolTurn(body)
                  let results = rawResults
                  if (!interrupted) {
                    try {
                      const inspected = inspectToolTurn(rawResults, body)
                      results = inspected.results
                      if (inspected.userSteered) interrupted = true
                    } catch (error) {
                      if (error instanceof UnsupportedContent && canReplayFollowUpAfterResults(body, rawResults)) {
                        interrupted = true
                      } else {
                        throw error
                      }
                    }
                  }
                  if (!interrupted) proc.validateResults(results)
                  if (limitTokens > 0 && inputEstimate > limitTokens) {
                    await reclaimStaleTurn(proc, turn, "agy bridge: prompt exceeded context window")
                    return promptTooLongResponse(inputEstimate, limitTokens)
                  }
                  const directIdsMatch = matches.every((item) => item.match?.call?.id === item.block.tool_use_id)
                  const historyMatches = directIdsMatch
                    ? proc.matchesPendingTurnHistory(turn, trailingMessages(body).history)
                    : proc.matchesHistory(trailingMessages(body).history)
                  // A steer keeps the live session, so agy's prompt cache holds: the
                  // calls are answered with their real results, the step is
                  // cancelled, and the steer goes in as the next prompt.
                  if (interrupted && historyMatches && !proc.toolsGrew(tools) && proc.workDir === workDir &&
                    sameInstructions(proc.instructions, instructions) &&
                    await proc.steerInSession(turn, rawResults, trailingMessages(body).history)) {
                    keptSession = true
                    answeredIds = new Set(
                      rawResults
                        .filter((item) => !item.call.deferred || item.call.lateDelivered)
                        .map((item) => item.block.tool_use_id),
                    )
                  } else if (interrupted || !historyMatches || proc.toolsGrew(tools) ||
                    proc.workDir !== workDir || !sameInstructions(proc.instructions, instructions)) {
                    // A changed context, a tool catalog that grew, or a
                    // user-interrupted tool turn needs a new session. Replay the
                    // real results without resolving the old process's calls.
                    dropFromPool(proc)
                    proc.abandonTurn(turn)
                    await proc.stop()
                  } else {
                    if (!proc.dead && !turn.done) {
                      // A tool catalog that lost or changed tools applies to the
                      // rest of this turn; a model change applies from the next prompt.
                      await proc.updateTools(tools)
                      proc.continueWith(results)
                      proc.recordToolResults(turn, body.messages)
                    }
                    if (accountAdmission.active) {
                      preparingRequests--
                      accountAdmission.active = false
                    }
                    return streamResponse(proc, turn, body, init.signal)
                  }
                }
                const held = pool.get(convKey)
                if (held?.turn && !held.turn.cancelRequested) {
                  const verdict = staleTurnVerdict(held, held.turn)
                  let attempts
                  if (!verdict.stale) {
                    // An attached stream is live progress; only a quiet turn counts.
                    if (verdict.reason === "attached" || verdict.reason === "steering") noProgressRepeats.delete(convKey)
                    else attempts = noteNoProgressRepeat(convKey, held.turn)
                    if (attempts == null || attempts < NO_PROGRESS_REPEAT_LIMIT) {
                      logBridgeEvent(held, held.turn, "reject_active", verdict.reason, acquireOpts,
                        attempts != null ? { attempts } : {})
                      return jsonError(409, "agy bridge: no active MCP call matches these tool results")
                    }
                  }
                  // The held turn can never progress again, or the same unmatched
                  // results hit it too often without progress: reclaim it and
                  // replay this request's own tool round once, under one lock.
                  if (limitTokens > 0 && inputEstimate > limitTokens && !replayHistoryProblem(body, resultBlocks)) {
                    await reclaimStaleTurn(held, held.turn, "agy bridge: prompt exceeded context window")
                    return promptTooLongResponse(inputEstimate, limitTokens)
                  }
                  const recovery = await recoverStaleTurn({ agy, convKey, proc: held, turn: held.turn,
                    body, resultBlocks, acquireOpts, isFresh, begin, attempts })
                  if (recovery.kind === "replayed") {
                    if (accountAdmission.active) {
                      preparingRequests--
                      accountAdmission.active = false
                    }
                    return streamResponse(recovery.proc, recovery.turn, body, init.signal)
                  }
                  if (recovery.kind === "active") {
                    return jsonError(409, "agy bridge: no active MCP call matches these tool results")
                  }
                  if (recovery.kind === "conflict" || recovery.kind === "incomplete") {
                    const code = recovery.kind === "conflict" ? "tool_state_conflict" : "tool_history_incomplete"
                    const message = attempts != null
                      ? `agy bridge: ${code}: these tool results matched no live call ${attempts} times without progress, and this conversation's tool state cannot be realigned. Stop resending them; restart from the last self-consistent user message.`
                      : recovery.kind === "conflict"
                        ? "agy bridge: this turn was already replaced. Stop resending this request."
                        : "agy bridge: incomplete tool history. Stop resending it; continue from the last self-consistent message."
                    return jsonError(400, message, code, {
                      noRetry: true,
                      ...(attempts != null ? { extra: { attempts, turn_id: recovery.turnId } } : {}),
                    })
                  }
                  // fallthrough: the turn went away or is being cancelled; take the normal path.
                }
                if (replayHistoryProblem(body, resultBlocks)) {
                  throw new ConflictError("agy bridge: incomplete tool history. Stop resending it; continue from the last self-consistent message.", "tool_history_incomplete")
                }
              }
              if (limitTokens > 0 && inputEstimate > limitTokens) {
                return promptTooLongResponse(inputEstimate, limitTokens)
              }

              const { proc, history } = await acquireProc(
                agy,
                convKey,
                acquireOpts,
                isFresh,
                resultBlocks.length > 0 && !keptSession,
              )
              const turn = await begin(proc, history)
              if (accountAdmission.active) {
                preparingRequests--
                accountAdmission.active = false
              }
              return streamResponse(proc, turn, body, init.signal)
            } catch (error) {
              if (error && typeof error === "object" && error[ABORTED_RESPONSE]) throw error.cause
              return jsonError(error.statusCode ?? 502, error.message, error.code, { noRetry: error.noRetry })
            } finally {
              if (accountAdmission.active) preparingRequests--
              accountAdmission.active = false
            }
          },
        }
      },
    },
    provider: {
      id: PROVIDER_ID,
      npm: NPM_ANTHROPIC,
      // Not an OpenCode hook: the adapter in opencode2.mjs reads the list
      // once more when this background work ends.
      warming: () => catalogWarming(),
      models: async () => {
        while (switching) await waitForAccountSwitch()
        const agy = findAgy()
        // Never force a refresh here: Magpie times models() out after about two seconds.
        const catalog = await loadModelCatalog(agy)
        const out = {}
        for (const model of catalog.models) {
          const imageModel = /^(?:gemini-|claude-)/.test(model.id)
          out[model.id] = {
            id: model.id,
            name: model.name,
            npm: NPM_ANTHROPIC,
            limit: modelLimits(model.id),
            api: { id: model.id, url: "agy://local", npm: NPM_ANTHROPIC },
            capabilities: {
              ...(imageModel ? { attachment: true, input: { text: true, image: true }, output: { text: true } } : {}),
              ...(model.variants ? { reasoning: true } : {}),
            },
            ...(model.variants ? {
              reasoning: true,
              variants: Object.fromEntries(model.variants.map(effort => [effort, {}])),
            } : {}),
          }
        }
        return out
      },
    },
  }
}

// Only permanent tool-history 400s opt out of retries. Magpie header forwarding
// has not been verified; busy responses and existing 409s retain their semantics.
// `extra` merges diagnostic fields (attempts, turn_id) into the error object.
function jsonError(status, message, code, { extra, headers, noRetry = false } = {}) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: status === 400 ? "invalid_request_error" : "api_error",
        ...(code ? { code } : {}), message: String(message || "unknown error"), ...(extra ?? {}) },
    }),
    { status, headers: { "Content-Type": "application/json",
      ...(status === 400 && noRetry ? NO_RETRY_HEADERS : {}), ...(headers ?? {}) } },
  )
}

// On Windows child.kill() ends agy alone and leaves the cmd.exe and nc it
// started, so one taskkill /T ends every tree before the workspaces go.
function reapOnExit() {
  const windows = process.platform === "win32"
  const pids = []
  for (const proc of allProcs) {
    const child = proc.child
    if (!child || child.exitCode !== null || child.signalCode !== null) continue
    if (windows && child.pid) pids.push(child.pid)
    else {
      try { child.kill("SIGKILL") } catch {}
    }
  }
  const kill = windows ? windowsTreeKill(pids) : null
  if (kill) {
    try { spawnSync(kill.file, kill.args, { stdio: "ignore", windowsHide: true, timeout: 10_000 }) } catch {}
  }
  for (const proc of allProcs) {
    // A process that just ended can hold its cwd (the workspace) for a moment.
    if (proc.workspace) {
      try { fs.rmSync(proc.workspace, { recursive: true, force: true, maxRetries: windows ? 10 : 0, retryDelay: 50 }) } catch {}
    }
  }
  if (shimDir && shimDirOwned) {
    try { fs.rmSync(shimDir, { recursive: true, force: true }) } catch {}
  }
}

process.once("exit", reapOnExit)

export { sanitizeInputSchema }
export default { id: PROVIDER_ID, server: AntigravityBridgePlugin }

