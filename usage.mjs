import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { agySpawnSpec } from "./platform.mjs"
import { cannotSignIn, isDead, noteDead, readStoredSignIn, storedSignIn } from "./signin.mjs"

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 18_000 // Magpie bounds an auth.usage call to 20 seconds.
const MAX_OUTPUT_BYTES = 1024 * 1024
const CLEANUP_ATTEMPTS = 8

class UsageError extends Error {
  constructor(message, { kind = "", output = "" } = {}) {
    super(message)
    this.kind = kind
    this.output = output
  }
}

const SIGN_IN_TALK = /accounts\.google\.com|oauth|sign[ -]?in|log[ -]?in|authenticat|browser/i

const text = value => typeof value === "string" ? value.trim() : ""
const field = (value, camel, snake) => value?.[camel] ?? value?.[snake]

function commandFailure(output) {
  if (/not (?:logged|signed) in|unauthenticated|authentication required|login required|please (?:log|sign) in|sign in again/i.test(output)) {
    return new UsageError("agy usage needs authentication. Run `agy` in a terminal to sign in again.", { kind: "auth" })
  }
  const eligibility = /eligibility check failed|not eligible|unsupported (?:country|region)|does not support google tos/i.test(output)
  const network = /\b(?:eof|timeout|timed out|deadline exceeded|no such host|connection (?:refused|reset)|network|proxy|tls|ssl|certificate)\b/i.test(output)
  if (network) return new UsageError(`agy usage ${eligibility ? "eligibility check " : ""}failed on a network request. Check network or proxy settings.`)
  if (eligibility) return new UsageError("agy reports that this account is not eligible for Antigravity.")
  return new UsageError("agy could not read usage. Run `agy` in a terminal to check its status.")
}

function resetTime(value) {
  if (value == null || value === "" || typeof value === "boolean") return undefined
  const raw = String(value)
  let ms
  if (/^\d+(?:\.\d+)?$/.test(raw)) ms = Number(raw) * (Number(raw) < 1e11 ? 1000 : 1)
  else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) ms = Date.parse(raw)
  if (!Number.isFinite(ms) || ms <= 0 || ms > 253402300799999) return undefined
  return new Date(ms).toISOString()
}

function cadence(bucket, id, name) {
  // An explicit, unfamiliar window must not be overridden by an older ID/label.
  const value = text(bucket.window) || `${id} ${name}`
  if (/^(?:5h|five[_ -]?hours?|five_hour|session)$/i.test(value) || !text(bucket.window) && /(?:5h|five[ _-]hour|session)/i.test(value)) {
    return { name: "5 hours", span: 5 * 60 * 60 }
  }
  if (/^(?:weekly|week|7d|seven[_ -]?days?)$/i.test(value) || !text(bucket.window) && /(?:weekly|week|7d)/i.test(value)) {
    return { name: "7 days", span: 7 * 24 * 60 * 60 }
  }
  return { name: name || id }
}

// agy's command report is not its token-usage object or a model-availability list.
// Unknown quota is not evidence of exhaustion or a full allowance.
export function parseUsageReport(value) {
  let report
  try { report = typeof value === "string" ? JSON.parse(value) : value } catch {
    throw new UsageError("agy returned an invalid usage report.")
  }
  if (report?.status !== "SUCCESS" || report?.command?.name !== "usage") {
    throw commandFailure(`${text(report?.error)} ${text(report?.response)}`)
  }
  const groups = report.command.data?.groups
  const windows = []
  for (const group of Array.isArray(groups) ? groups : []) {
    const pool = (text(field(group, "displayName", "display_name")) || text(group?.name) || "Quota")
      .replace(/\s+models$/i, "").replace(/\s+and\s+/gi, " & ")
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const id = text(field(bucket, "bucketId", "bucket_id")) || text(bucket?.id)
      if (!id || bucket?.disabled === true) continue
      const label = text(field(bucket, "displayName", "display_name")) || text(bucket?.name)
      const period = cadence(bucket, id, label)
      const remaining = bucket.remaining
      const fraction = field(bucket, "remainingFraction", "remaining_fraction")
        ?? field(remaining, "remainingFraction", "remaining_fraction")
        ?? (remaining?.case === "remainingFraction" ? remaining.value : undefined)
      const known = typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
      const resetsAt = resetTime(field(bucket, "resetTime", "reset_time"))
      windows.push({
        name: `${pool} · ${period.name}`,
        // This feature displays quota only; it must not change model routing.
        aside: true,
        ...(known ? { used: Math.round((1 - fraction) * 1e8) / 1e6 } : { display: "Limits not available" }),
        ...(period.span ? { span: period.span } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      })
    }
  }
  if (!windows.some(w => w.used !== undefined)) {
    throw new UsageError("Limits not available: agy returned no enabled, measured quota buckets.")
  }
  // /usage has no verified account or plan identity. Do not borrow one elsewhere.
  return { windows }
}

// Magpie's public `used` field is a percentage (0..100); the policy threshold
// is a fraction. Keep the display contract, including unknown quotas, intact.
export function exhaustedWindows(report, { threshold = 0.98 } = {}) {
  return (report?.windows || []).filter(window => Number.isFinite(window.used) &&
    window.used >= 0 && window.used <= 100 && window.used / 100 >= threshold)
}

// Display-only masking for the auto-switch quota view: the local part keeps
// its first letter, the domain keeps its first letter and public suffix, and
// every other character becomes `***` (`alice@googlemail.com` → `a***@g***.com`).
// A full address must never reach the host; non-addresses mask to "".
export function maskEmail(email) {
  const value = String(email ?? "")
  const at = value.indexOf("@")
  if (at <= 0 || at === value.length - 1 || /\s/.test(value)) return ""
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  const suffix = domain.slice(domain.lastIndexOf("."))
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${domain.includes(".") ? suffix : ""}`
}

// Prefix every window name with the masked current account while the host's
// auto_switch switch is on, so the quota view shows which account is serving.
// The address comes from the plugin's verified token file, never from /usage
// output. Pure display: the input report is not mutated, and cooldown
// bookkeeping keeps reading the raw pool names, not these badges.
export function maskedAccountReport(report, email) {
  const badge = maskEmail(email)
  if (!badge) return report
  return {
    ...report,
    windows: (report?.windows || []).map(window => ({ ...window, name: `${badge} · ${window.name}` })),
  }
}

function timeout(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
}

function run(file, args, { cwd, env, deadline, signal, maxOutputBytes, onTreeKill }) {
  return new Promise((resolve, reject) => {
    let child
    let settled = false
    let stopped = false
    let bytes = 0
    const stdout = []
    const stderr = []
    let timer
    let treeKillTimer
    let childExit = Promise.resolve()
    const killWindowsTree = () => {
      const killed = new Promise(resolveKill => {
        let killTimer
        let done = false
        const complete = failed => {
          if (done) return
          done = true
          clearTimeout(killTimer)
          // Do not kill the root early: taskkill still needs it to discover
          // descendants. A parent-only kill is a last resort after failure.
          if (failed) try { child.kill("SIGKILL") } catch {}
          resolveKill()
        }
        try {
          const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true })
          killer?.unref?.()
          if (typeof killer?.once !== "function") return complete(!killer)
          killer.once("error", () => complete(true))
          killer.once("close", code => complete(code !== 0))
          killTimer = setTimeout(() => {
            try { killer.kill?.() } catch {}
            complete(true)
          }, 5000)
        } catch {
          complete(true)
        }
      })
      const done = killed.then(async () => {
        let exitTimer
        try {
          await Promise.race([childExit, new Promise(resolveExit => {
            exitTimer = setTimeout(resolveExit, 2000)
          })])
        } finally { clearTimeout(exitTimer) }
      })
      onTreeKill?.(done)
    }
    const stop = (fromExit = false) => {
      if (!child?.pid || stopped) return
      if (process.platform === "win32") {
        if (fromExit && child.exitCode !== null) {
          treeKillTimer = setTimeout(() => {
            if (!settled && !stopped) {
              stopped = true
              killWindowsTree()
            }
          }, 30)
          treeKillTimer.unref?.()
          return
        }
        stopped = true
        clearTimeout(treeKillTimer)
        killWindowsTree()
        return
      }
      stopped = true
      // Only this detached child/group is ours, never an existing user agy.
      try { process.kill(-child.pid, "SIGKILL") } catch {
        try { child.kill("SIGKILL") } catch {}
      }
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(treeKillTimer)
      signal?.removeEventListener("abort", abort)
      if (process.platform !== "win32" || error || child?.exitCode === null) {
        stop() // Also stop MCP descendants if the parent exited first.
      }
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => finish(new UsageError("agy usage query was cancelled.", { kind: "cancel" }))
    if (signal?.aborted) return abort()
    if (Date.now() >= deadline) return finish(new UsageError("agy usage query timed out.", { kind: "timeout" }))
    try {
      const command = agySpawnSpec(file, args)
      child = spawn(command.file, command.args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        ...command.options,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      childExit = new Promise(resolveExit => {
        child.once("exit", resolveExit)
        child.once("close", resolveExit)
        child.once("error", resolveExit)
      })
    } catch {
      finish(new UsageError("agy usage could not start the CLI."))
      return
    }
    signal?.addEventListener("abort", abort, { once: true })
    timer = setTimeout(() => finish(new UsageError("agy usage query timed out.", {
      kind: "timeout",
      output: Buffer.concat(stderr).toString("utf8") + "\n" + Buffer.concat(stdout).toString("utf8"),
    })), Math.max(1, deadline - Date.now()))
    const collect = chunks => chunk => {
      if (settled) return
      bytes += chunk.length
      if (bytes > maxOutputBytes) return finish(new UsageError("agy usage output exceeded the size limit."))
      chunks.push(chunk)
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.on("error", () => finish(new UsageError("agy usage could not start the CLI.")))
    // exit, not close: a descendant may inherit the pipe and keep it open.
    // Drain the already-written output through close for a normal parent exit.
    child.on("exit", () => stop(true))
    child.on("close", code => finish(null, {
      code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
    }))
  })
}

function supportedVersion(output) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(output.trim())
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return major > 1 || major === 1 && (minor > 1 || minor === 1 && patch >= 11)
}

export async function fetchUsage(agy, {
  env = process.env,
  timeoutMs = env.AGY_BRIDGE_USAGE_TIMEOUT_MS,
  versionTimeoutMs = 3000,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  signal,
  tempRoot = os.tmpdir(),
} = {}) {
  if (!agy) throw new UsageError("agy CLI not found. Install it and run `agy` once to sign in.")
  const deadline = Date.now() + timeout(timeoutMs)
  const directory = await fs.mkdtemp(path.join(tempRoot, "magpie-agy-usage-"))
  let pendingTreeKill = null
  try {
    await fs.chmod(directory, 0o700)
    const agentDir = path.join(directory, ".agents", "agents", "magpie-usage")
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(path.join(agentDir, "agent.md"), [
      "---", "name: magpie-usage", "description: Read CLI usage only", "mainAgent: true", "subagent: false",
      "tools: []", "mcpServers: []", "---", "Do not run model prompts or tools.", "",
    ].join("\n"), { mode: 0o600 })
    if (process.platform === "win32") {
      await fs.writeFile(path.join(directory, "open.cmd"), "@exit /b 1\r\n")
    } else {
      for (const name of ["open", "xdg-open"]) {
        await fs.writeFile(path.join(directory, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 })
      }
    }
    const baseEnv = { ...env }
    const inheritedPath = env.PATH || baseEnv.Path || (process.platform === "win32" ? "" : "/usr/bin:/bin")
    for (const key of Object.keys(baseEnv)) {
      if (/^path$/i.test(key) && key !== "PATH") delete baseEnv[key]
    }
    const childEnv = {
      ...baseEnv,
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      PATH: directory + path.delimiter + inheritedPath,
      BROWSER: path.join(directory, process.platform === "win32" ? "open.cmd" : "open"),
    }
    const options = { cwd: directory, env: childEnv, deadline, signal, maxOutputBytes, onTreeKill: p => { pendingTreeKill = p } }
    // --version needs no sign-in, so its hang is never read as one
    const version = await run(agy, ["--version"], { ...options, deadline: Math.min(deadline, Date.now() + timeout(versionTimeoutMs)) }).catch((error) => {
      if (error?.kind === "timeout") throw new UsageError(error.message)
      throw error
    })
    if (version.code !== 0) throw commandFailure(version.stderr)
    if (!supportedVersion(version.stdout)) throw new UsageError("agy usage reports require a verified agy version 1.1.11 or later. Update the CLI.")
    const result = await run(agy, ["-p", "/usage", "--output-format", "json", "--agent", "magpie-usage", "--print-timeout", `${Math.max(1, Math.ceil((deadline - Date.now()) / 1000))}s`], options)
    if (result.code !== 0) throw commandFailure(result.stderr + "\n" + result.stdout)
    return parseUsageReport(result.stdout)
  } finally {
    // On Windows rejection precedes taskkill completion. Wait before touching
    // cwd; descendants can still hold directory handles after pipes close.
    if (pendingTreeKill) await pendingTreeKill
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
      try {
        await fs.rm(directory, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === CLEANUP_ATTEMPTS - 1 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) break
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }
  }
}

const BACKOFF_FIRST_MS = 10 * 60 * 1000
const BACKOFF_MOST_MS = 6 * 60 * 60 * 1000

function backoff(n) {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(n, 20) - 1), BACKOFF_MOST_MS)
}

const NEEDS_SIGN_IN = "Sign in again from this account's Sign in in magpie, or run `agy` in a terminal; magpie doesn't run agy for usage until then."

// No completed-result cache: sequential refreshes must see account/allowance changes.
export function createUsageReader(resolveAgy, options = {}) {
  const customSignIn = typeof options.signIn === "function"
  const {
    signIn = () => (options.env?.TEST_LOG ? Promise.resolve({ state: "unknown" }) : storedSignIn({
      read: () => readStoredSignIn({ env: options.env ?? process.env }),
    })),
    now = () => Date.now(),
    waitForGate = async () => {},
    isGateClosed = () => false,
    getGeneration = () => 0,
    ...fetchOptions
  } = options
  const pending = new Map()
  let revision = 0
  let held = null
  let saidExpired = false
  const expired = (why) => {
    saidExpired = true
    return { windows: [], error: `${why}. ${NEEDS_SIGN_IN}`, signIn: "expired" }
  }
  const read = async () => {
    for (;;) {
      await waitForGate()
      if (isGateClosed()) continue
      const generation = getGeneration()
      const started = revision
      let stored
      try { stored = await signIn() } catch { stored = { state: "unknown" } }
      if (revision !== started || getGeneration() !== generation) continue
      const why = cannotSignIn(stored)
      if (why) return expired(why)
      if (isDead(stored)) return expired("agy's sign-in no longer works")
      const trackSignIn = customSignIn || stored?.state === "present"
      const holdKey = stored?.state === "present" ? stored.fp : "unknown"
      if (trackSignIn && held && held.key === holdKey && now() < held.until) {
        return { windows: [], error: held.error, signIn: held.auth ? "expired" : "kept" }
      }
      const agy = resolveAgy()
      const key = JSON.stringify([agy, generation, started])
      if (!pending.has(key)) {
        const controller = new AbortController()
        const signal = fetchOptions.signal
          ? AbortSignal.any([controller.signal, fetchOptions.signal]) : controller.signal
        const query = fetchUsage(agy, { ...fetchOptions, signal }).finally(() => {
          if (pending.get(key)?.query === query) pending.delete(key)
        })
        pending.set(key, { query, controller })
      }
      try {
        const result = await pending.get(key).query
        if (revision !== started || getGeneration() !== generation) continue
        const status = saidExpired ? "renewed" : "kept"
        held = null
        saidExpired = false
        return { ...structuredClone(result), signIn: status }
      } catch (error) {
        if (revision !== started || getGeneration() !== generation) continue
        const message = error instanceof UsageError || error?.statusCode === 503
          ? error.message
          : "agy usage query failed. Check the CLI and temporary-directory permissions."
        if (error?.kind === "cancel" || !trackSignIn) {
          return { windows: [], error: message, signIn: "kept" }
        }
        // Google OAuth access tokens expire every hour while refresh_token stays
        // valid (`canRenew: true`). An empty-output `/usage` timeout is only an
        // auth failure when the stored token cannot renew itself or agy printed
        // a sign-in prompt before timing out.
        const unrenewableExpired = stored?.state === "present" && stored.expired && !stored.canRenew
        const auth = error?.kind === "auth" || error?.kind === "timeout" && (
          SIGN_IN_TALK.test(error.output) ||
          unrenewableExpired && !String(error.output ?? "").trim()
        )
        if (auth && stored?.state === "present") {
          noteDead(stored)
          return expired("agy's sign-in no longer works")
        }
        const n = held?.key === holdKey ? held.n + 1 : 1
        held = { key: holdKey, n, until: now() + backoff(n), error: message, auth }
        if (auth) saidExpired = true
        return { windows: [], error: message, signIn: auth ? "expired" : "kept" }
      }
    }
  }
  read.invalidate = async () => {
    revision++
    held = null
    saidExpired = false
    const old = [...pending.values()]
    for (const entry of old) entry.controller.abort()
    await Promise.allSettled(old.map(entry => entry.query))
  }
  return read
}
