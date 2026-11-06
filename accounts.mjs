// 账号仓库模块（计划工作项 4）：账号发现、令牌备份、切号锁、外部 agy 在途检测、原子写入。
// 纯模块：不 import index.mjs、不碰进程池，所有路径经参数注入，可独立单测。
// 邮箱解析与 configs 仓 scripts/agy_sync_wsl_account.py 的 _email_from_id_token/_valid_email 同口径。

import { spawn, execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

const TOKEN_FILE = path.join(".gemini", "antigravity-cli", "antigravity-oauth-token")
const ACCOUNTS_FILE = path.join(".gemini", "google_accounts.json")
const HARNESS_DIR = ".better-harness"
const LOCK_FILE = "agy-switch.lock"
const LOCK_DIR = "agy-switch.lock.d"
const STALE_LOCK_MS = 120_000
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000
const LOCK_RELEASE_KILL_MS = 1_000

export function tokenFileOf(home) {
  return path.join(home, TOKEN_FILE)
}

export function accountsFileOf(home) {
  return path.join(home, ACCOUNTS_FILE)
}

// 与 index.mjs 的 sessionStateFile() 同口径的默认路径推导（那边未导出，这里自带一份）。
export function sessionStateFileOf({ home = os.homedir(), env = process.env } = {}) {
  if (env.AGY_BRIDGE_STATE_FILE) return env.AGY_BRIDGE_STATE_FILE
  const base = env.XDG_STATE_HOME || path.join(home, ".local", "state")
  return path.join(base, "magpie-agy-bridge", "sessions.json")
}

// 令牌备份仓库：与会话停车文件同根的 accounts/ 目录。
export function defaultVaultDir({ home = os.homedir(), env = process.env } = {}) {
  return path.join(path.dirname(sessionStateFileOf({ home, env })), "accounts")
}

export function accountKey(email) {
  return createHash("sha256").update(String(email).toLowerCase()).digest("hex").slice(0, 16)
}

export function vaultFileOf(vaultDir, email) {
  return path.join(vaultDir, `${accountKey(email)}.json`)
}

// —— 邮箱解析（口径同 agy_sync_wsl_account.py）——

function looksLikeEmail(value) {
  return typeof value === "string" && value.length > 0 && value.includes("@") && !/\s/.test(value)
}

function jwtEmail(token) {
  if (typeof token !== "string" || (token.match(/\./g) || []).length !== 2) return null
  const body = token.split(".")[1]
  if (!body) return null
  let claims
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null
  return typeof claims.email === "string" && claims.email ? claims.email : null
}

// 先读顶层 id_token_email，没有再读 token.id_token_email，最后解 id_token（顶层或 token 下）JWT。
export function emailFromTokenPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const nested = payload.token && typeof payload.token === "object" && !Array.isArray(payload.token) ? payload.token : {}
  if (looksLikeEmail(payload.id_token_email)) return payload.id_token_email
  if (looksLikeEmail(nested.id_token_email)) return nested.id_token_email
  const fromJwt = jwtEmail(payload.id_token) ?? jwtEmail(nested.id_token)
  return looksLikeEmail(fromJwt) ? fromJwt : null
}

function readTokenPayload(file) {
  try {
    const payload = JSON.parse(fs.readFileSync(file, "utf8"))
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null
  } catch {
    return null
  }
}

// —— 账号发现 ——

// 返回 { current, active, mismatch, vaultDir, candidates }。
// current＝令牌文件解出的邮箱（与 google_accounts.json 的 active 不一致时以它为准）；
// mismatch 只报告不自动修；candidates 每项含 { email, current, captured, switchable, status }，
// status 为 "ok"（当前号或仓库有备份，可切/在用）或 "uncaptured"（未登记，需首次登录）。
export function discoverAccounts({ home = os.homedir(), configured, vaultDir } = {}) {
  const vault = vaultDir || defaultVaultDir({ home })
  const current = emailFromTokenPayload(readTokenPayload(tokenFileOf(home)))
  let active = null
  let old = []
  try {
    const raw = JSON.parse(fs.readFileSync(accountsFileOf(home), "utf8"))
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if (looksLikeEmail(raw.active)) active = raw.active
      if (Array.isArray(raw.old)) old = raw.old.filter(looksLikeEmail)
    }
  } catch {}
  const mismatch = Boolean(current && active && current.toLowerCase() !== active.toLowerCase())
  const list = Array.isArray(configured) && configured.length > 0
    ? configured.filter(looksLikeEmail)
    : [active, ...old].filter(Boolean)
  const seen = new Set()
  const candidates = []
  for (const email of list) {
    const low = email.toLowerCase()
    if (seen.has(low)) continue
    seen.add(low)
    const isCurrent = current != null && low === current.toLowerCase()
    const captured = fs.existsSync(vaultFileOf(vault, email))
    candidates.push({
      email,
      current: isCurrent,
      captured,
      switchable: isCurrent || captured,
      status: isCurrent || captured ? "ok" : "uncaptured",
    })
  }
  return { current, active, mismatch, vaultDir: vault, candidates }
}

// —— 令牌备份仓库 ——

function atomicWrite(file, content, mode) {
  const dir = path.dirname(file)
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
  fs.writeFileSync(temp, content, { mode })
  try {
    fs.chmodSync(temp, mode)
  } catch {}
  try {
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.unlinkSync(temp)
    } catch {}
    throw error
  }
}

// 把 home 下当前令牌文件按邮箱存进仓库（覆盖旧备份，令牌刷新后备份随之更新）。
export function captureCurrent({ home = os.homedir(), vaultDir, now = new Date().toISOString() } = {}) {
  const vault = vaultDir || defaultVaultDir({ home })
  const payload = readTokenPayload(tokenFileOf(home))
  if (!payload) return { ok: false, reason: "token file missing or unreadable" }
  const email = emailFromTokenPayload(payload)
  if (!email) return { ok: false, reason: "no email in token file" }
  try {
    fs.mkdirSync(vault, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(vault, 0o700)
    } catch {}
  } catch (error) {
    return { ok: false, reason: `vault dir: ${error.message}` }
  }
  const file = vaultFileOf(vault, email)
  const body = `${JSON.stringify({ version: 1, email, capturedAt: now, token: payload }, null, 2)}\n`
  try {
    atomicWrite(file, body, 0o600)
  } catch (error) {
    return { ok: false, reason: `write: ${error.message}` }
  }
  return { ok: true, email, file }
}

// —— 切号锁 ——

// 拿不到时返回 { ok: false, reason: "busy" | ... }，不等待。
// POSIX：与外部设施 agy-quota.py 共用 ~/.better-harness/agy-switch.lock（flock 非阻塞独占）。
// Windows 原生：~/.better-harness/agy-switch.lock.d 目录锁（owner.json，超过 2 分钟且 owner 进程已死才回收）。
export async function acquireSwitchLock({ home = os.homedir(), platform = process.platform } = {}) {
  const harnessDir = path.join(home, HARNESS_DIR)
  try {
    fs.mkdirSync(harnessDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `harness dir: ${error.message}` }
  }
  if (platform === "win32") return acquireDirLock(path.join(harnessDir, LOCK_DIR))
  const lockFile = path.join(harnessDir, LOCK_FILE)
  const tools = platform === "darwin" ? [perlLock, flockLock] : [flockLock, perlLock]
  for (const tool of tools) {
    const attempt = await tool(lockFile)
    if (attempt.ok) return { ok: true, release: attempt.release }
    if (attempt.spawnError && (attempt.spawnError.code === "ENOENT" || attempt.spawnError.code === "ENOTFOUND")) continue
    return { ok: false, reason: attempt.reason ?? "lock unavailable" }
  }
  return { ok: false, reason: "no flock tool available (flock/perl missing)" }
}

// 起一个持锁子进程：拿到锁后打印 locked 并阻塞在 stdin 上，release() 关 stdin 放锁。
function lockTool(command, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    } catch (error) {
      resolve({ ok: false, spawnError: error })
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ ok: false, reason: "lock acquire timeout" })
    }, LOCK_ACQUIRE_TIMEOUT_MS)
    timer.unref?.()
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    child.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("locked")) {
        let released = false
        finish({
          ok: true,
          release: () => {
            if (released) return Promise.resolve()
            released = true
            return new Promise((resolveRelease) => {
              child.on("close", () => resolveRelease())
              try {
                child.stdin?.end()
              } catch {}
              const killTimer = setTimeout(() => {
                try {
                  child.kill()
                } catch {}
                resolveRelease()
              }, LOCK_RELEASE_KILL_MS)
              killTimer.unref?.()
            })
          },
        })
      }
    })
    child.on("error", (error) => finish({ ok: false, spawnError: error }))
    child.on("close", (code) => finish({ ok: false, reason: code === 1 ? "busy" : `lock command exited with code ${code}` }))
  })
}

function flockLock(lockFile) {
  return lockTool("flock", ["-n", lockFile, "-c", "echo locked; read _"])
}

// $| = 1 让 locked 立刻冲出去，否则会卡在 <STDIN> 前的缓冲里。
const PERL_LOCK_SCRIPT = 'open F,">>",$ARGV[0] or exit 2; $|=1; flock(F,LOCK_EX|LOCK_NB) or exit 1; print "locked\\n"; <STDIN>;'

function perlLock(lockFile) {
  return lockTool("perl", ["-MFcntl=:flock", "-e", PERL_LOCK_SCRIPT, lockFile])
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== "ESRCH"
  }
}

function acquireDirLock(lockDir) {
  const tryMkdir = () => {
    try {
      fs.mkdirSync(lockDir)
      return true
    } catch (error) {
      if (error?.code === "EEXIST") return false
      throw error
    }
  }
  let created = false
  try {
    created = tryMkdir()
    if (!created) {
      // 已被占用：只在「超过 2 分钟且 owner 进程已不存在」时回收（口径同 withStateLock 的陈旧回收）。
      let owner = null
      try {
        owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"))
      } catch {}
      const reclaimable = owner && typeof owner === "object" &&
        Number.isFinite(owner.at) && Date.now() - owner.at >= STALE_LOCK_MS &&
        (!owner.host || owner.host === os.hostname()) && !pidAlive(owner.pid)
      if (!reclaimable) return { ok: false, reason: "busy" }
      try {
        fs.rmSync(lockDir, { recursive: true, force: true })
        created = tryMkdir()
      } catch {}
      if (!created) return { ok: false, reason: "busy" }
    }
    fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })}\n`)
  } catch (error) {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true })
    } catch {}
    return { ok: false, reason: `dir lock: ${error.message}` }
  }
  let released = false
  return {
    ok: true,
    release: () => {
      if (released) return
      released = true
      try {
        fs.rmSync(lockDir, { recursive: true, force: true })
      } catch {}
    },
  }
}

// —— 外部 agy 在途检测 ——

function isAgyArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false
  return [argv[0], argv[1]].some((value) => typeof value === "string" && /^agy(\.exe)?$/i.test(path.basename(value.trim())))
}

function scanLinux() {
  const entries = fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))
  const parentOf = new Map()
  const procs = []
  for (const entry of entries) {
    const pid = Number(entry)
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8")
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      const ppid = Number(rest[1])
      if (Number.isInteger(ppid)) parentOf.set(pid, ppid)
    } catch {}
    try {
      const argv = fs.readFileSync(`/proc/${entry}/cmdline`).toString().split("\0").filter(Boolean)
      if (isAgyArgv(argv)) procs.push({ pid, ppid: parentOf.get(pid) ?? null, argv })
    } catch {}
  }
  return { procs, parentOf }
}

async function scanMac() {
  const { stdout } = await execFileP("ps", ["-axo", "pid=,ppid=,command="], { windowsHide: true })
  const parentOf = new Map()
  const procs = []
  for (const line of stdout.split("\n")) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 3) continue
    const pid = Number(columns[0])
    const ppid = Number(columns[1])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    parentOf.set(pid, ppid)
    const argv = columns.slice(2)
    if (isAgyArgv(argv)) procs.push({ pid, ppid, argv })
  }
  return { procs, parentOf }
}

async function scanWindows() {
  const { stdout } = await execFileP("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='agy.exe'\" | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
  ], { windowsHide: true })
  const text = stdout.trim()
  const parentOf = new Map()
  const procs = []
  if (!text) return { procs, parentOf }
  const parsed = JSON.parse(text)
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    const pid = Number(row?.ProcessId)
    const ppid = Number(row?.ParentProcessId)
    if (!Number.isInteger(pid)) continue
    if (Number.isInteger(ppid)) parentOf.set(pid, ppid)
    procs.push({ pid, ppid: Number.isInteger(ppid) ? ppid : null, argv: null })
  }
  return { procs, parentOf }
}

// 列出本机所有非本插件的 agy 进程。ownPids 是插件自有 agy 子进程（含其后代一并视为自有）。
// 检测本身失败＝「核不了」＝ { ok: false, reason }（安全默认：调用方不切号）。
export async function foreignAgyProcesses({ ownPids = [], platform = process.platform } = {}) {
  const own = new Set(ownPids.map(Number).filter(Number.isInteger))
  let scan
  try {
    if (platform === "win32") scan = await scanWindows()
    else if (platform === "darwin") scan = await scanMac()
    else if (platform === "linux") scan = scanLinux()
    else return { ok: false, reason: `unsupported platform: ${platform}` }
  } catch (error) {
    return { ok: false, reason: `detection failed: ${error.message}` }
  }
  const { procs, parentOf } = scan
  const foreign = []
  for (const proc of procs) {
    const visited = new Set()
    let cursor = proc.pid
    let isOwn = false
    while (cursor != null && !visited.has(cursor)) {
      if (own.has(cursor)) {
        isOwn = true
        break
      }
      visited.add(cursor)
      cursor = parentOf.has(cursor) ? parentOf.get(cursor) : null
    }
    if (!isOwn) foreign.push({ pid: proc.pid, ppid: proc.ppid })
  }
  return { ok: true, total: procs.length, foreign }
}

// —— 原子写入 ——

function readRaw(file) {
  try {
    const raw = fs.readFileSync(file, "utf8")
    let mode = null
    try {
      mode = fs.statSync(file).mode & 0o777
    } catch {}
    return { raw, mode }
  } catch {
    return { raw: null, mode: null }
  }
}

function restoreRaw(file, before) {
  try {
    if (before.raw != null) {
      fs.writeFileSync(file, before.raw)
      if (before.mode != null) {
        try {
          fs.chmodSync(file, before.mode)
        } catch {}
      }
      return true
    }
    try {
      fs.unlinkSync(file)
    } catch (error) {
      if (error?.code !== "ENOENT") return false
    }
    return true
  } catch {
    return false
  }
}

// 把仓库备份写回令牌文件，再改 google_accounts.json（旧 active 进 old、新 active 出 old）。
// 全程同目录临时文件 + rename；写完回读两份文件，邮箱都等于目标才算成功；
// 任一步失败用切换前读到的原内容还原，返回 { ok: false, reason, restored }。
export function writeActiveAccount({ home = os.homedir(), email, vaultDir } = {}) {
  if (!looksLikeEmail(email)) return { ok: false, reason: "invalid email" }
  const vault = vaultDir || defaultVaultDir({ home })
  const backup = readTokenPayload(vaultFileOf(vault, email))
  if (!backup || backup.version !== 1 || !backup.token || typeof backup.token !== "object") {
    return { ok: false, reason: "no vault backup for account" }
  }
  const tokenFile = tokenFileOf(home)
  const accountsFile = accountsFileOf(home)
  const beforeToken = readRaw(tokenFile)
  const beforeAccounts = readRaw(accountsFile)
  let oldActive = null
  let oldList = []
  let parsedAccounts = null
  if (beforeAccounts.raw != null) {
    try {
      parsedAccounts = JSON.parse(beforeAccounts.raw)
    } catch {}
  }
  if (parsedAccounts && typeof parsedAccounts === "object" && !Array.isArray(parsedAccounts)) {
    if (looksLikeEmail(parsedAccounts.active)) oldActive = parsedAccounts.active
    if (Array.isArray(parsedAccounts.old)) {
      oldList = parsedAccounts.old.filter((value) => typeof value === "string" && value.toLowerCase() !== email.toLowerCase())
    }
  }
  const target = email.toLowerCase()
  if (oldActive && oldActive.toLowerCase() !== target && !oldList.some((value) => value.toLowerCase() === oldActive.toLowerCase())) {
    oldList.push(oldActive)
  }
  const newAccounts = `${JSON.stringify({ active: email, old: oldList }, null, 2)}\n`
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
    atomicWrite(tokenFile, `${JSON.stringify(backup.token, null, 2)}\n`, 0o600)
    fs.mkdirSync(path.dirname(accountsFile), { recursive: true })
    atomicWrite(accountsFile, newAccounts, beforeAccounts.mode ?? 0o644)
  } catch (error) {
    const restored = restoreRaw(tokenFile, beforeToken) && restoreRaw(accountsFile, beforeAccounts)
    return { ok: false, reason: `write failed: ${error.message}`, restored }
  }
  const verifyToken = emailFromTokenPayload(readTokenPayload(tokenFile))
  let verifyActive = null
  try {
    const raw = JSON.parse(fs.readFileSync(accountsFile, "utf8"))
    if (typeof raw?.active === "string") verifyActive = raw.active
  } catch {}
  if ((verifyToken ?? "").toLowerCase() !== target || (verifyActive ?? "").toLowerCase() !== target) {
    const restored = restoreRaw(tokenFile, beforeToken) && restoreRaw(accountsFile, beforeAccounts)
    return { ok: false, reason: "read-back verification failed", restored }
  }
  return { ok: true, email, previous: oldActive }
}
