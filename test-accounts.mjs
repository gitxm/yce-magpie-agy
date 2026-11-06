// accounts.mjs 的单元测试（计划工作项 4 验收（2））。
// 全部用 os.tmpdir() 下的临时 home，绝不读写真实 ~/.gemini；不调用真实 agy、不碰真实锁文件。

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { syncBuiltinESMExports } from "node:module"
import { test } from "node:test"
import {
  accountKey,
  accountsFileOf,
  acquireSwitchLock,
  captureCurrent,
  defaultVaultDir,
  discoverAccounts,
  emailFromTokenPayload,
  foreignAgyProcesses,
  sessionStateFileOf,
  tokenFileOf,
  vaultFileOf,
  writeActiveAccount,
} from "./accounts.mjs"

const isWin = process.platform === "win32"

function tempDir(t, prefix = "agy-accounts-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return dir
}

function makeJWT(email) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "none" })}.${part({ email })}.sig`
}

function writeTokenFile(home, payload) {
  fs.mkdirSync(path.dirname(tokenFileOf(home)), { recursive: true })
  fs.writeFileSync(tokenFileOf(home), JSON.stringify(payload, null, 2))
}

function writeAccountsFile(home, active, old = []) {
  fs.mkdirSync(path.dirname(accountsFileOf(home)), { recursive: true })
  fs.writeFileSync(accountsFileOf(home), JSON.stringify({ active, old }, null, 2))
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

test("state file and vault dir follow AGY_BRIDGE_STATE_FILE > XDG_STATE_HOME > home/.local/state", () => {
  assert.equal(sessionStateFileOf({ home: "/h", env: { AGY_BRIDGE_STATE_FILE: "/x/y/sessions.json" } }), "/x/y/sessions.json")
  assert.equal(defaultVaultDir({ home: "/h", env: { AGY_BRIDGE_STATE_FILE: "/x/y/sessions.json" } }), path.join("/x/y", "accounts"))
  assert.equal(defaultVaultDir({ home: "/h", env: { XDG_STATE_HOME: "/xdg" } }), path.join("/xdg", "magpie-agy-bridge", "accounts"))
  assert.equal(defaultVaultDir({ home: "/h", env: {} }), path.join("/h", ".local", "state", "magpie-agy-bridge", "accounts"))
})

test("accountKey hashes the lowercased email into a 16-hex file stem", () => {
  assert.match(accountKey("user@example.com"), /^[0-9a-f]{16}$/)
  assert.equal(accountKey("User@Example.COM"), accountKey("user@example.com"))
  assert.equal(path.basename(vaultFileOf("/vault", "user@example.com")), `${accountKey("user@example.com")}.json`)
})

test("resolves the account email from top-level id_token_email or nested token.id_token JWT", () => {
  assert.equal(emailFromTokenPayload({ auth_method: "oauth", id_token_email: "top@example.com", token: {} }), "top@example.com")
  assert.equal(emailFromTokenPayload({ token: { id_token: makeJWT("jwt@example.com") } }), "jwt@example.com")
  assert.equal(emailFromTokenPayload({ id_token: makeJWT("toplevel@example.com") }), "toplevel@example.com")
  assert.equal(
    emailFromTokenPayload({ token: { id_token_email: "nested@example.com", id_token: makeJWT("jwt@example.com") } }),
    "nested@example.com",
  )
  assert.equal(emailFromTokenPayload({}), null)
  assert.equal(emailFromTokenPayload({ id_token_email: "not-an-email" }), null)
  assert.equal(emailFromTokenPayload({ id_token_email: "has space@example.com" }), null)
  assert.equal(emailFromTokenPayload({ id_token: "not-a-jwt" }), null)
  assert.equal(emailFromTokenPayload({ id_token: "x.###.y" }), null)
  assert.equal(emailFromTokenPayload({ token: { id_token: makeJWT("jwt@example.com").split(".")[0] + ".broken" } }), null)
})

test("candidate order: non-empty configured list wins; empty config falls back to active+old deduped", (t) => {
  const home = tempDir(t)
  const vaultDir = path.join(home, "vault")
  writeTokenFile(home, { auth_method: "oauth", id_token_email: "cur@g.com" })
  writeAccountsFile(home, "cur@g.com", ["old1@g.com", "Old1@g.com", "old2@g.com"])
  const auto = discoverAccounts({ home, configured: [], vaultDir })
  assert.equal(auto.current, "cur@g.com")
  assert.equal(auto.active, "cur@g.com")
  assert.equal(auto.mismatch, false)
  assert.deepEqual(auto.candidates.map((c) => c.email), ["cur@g.com", "old1@g.com", "old2@g.com"])
  const manual = discoverAccounts({ home, configured: ["z@g.com", "cur@g.com", "Z@g.com"], vaultDir })
  assert.deepEqual(manual.candidates.map((c) => c.email), ["z@g.com", "cur@g.com"])
  assert.equal(manual.candidates[0].switchable, false)
  assert.equal(manual.candidates[0].status, "uncaptured")
  assert.equal(manual.candidates[1].switchable, true)
})

test("token file wins over google_accounts active; mismatch is reported without rewriting files", (t) => {
  const home = tempDir(t)
  writeTokenFile(home, { auth_method: "oauth", id_token_email: "token@g.com" })
  writeAccountsFile(home, "other@g.com", [])
  const beforeToken = fs.readFileSync(tokenFileOf(home), "utf8")
  const beforeAccounts = fs.readFileSync(accountsFileOf(home), "utf8")
  const found = discoverAccounts({ home, configured: [], vaultDir: path.join(home, "vault") })
  assert.equal(found.current, "token@g.com")
  assert.equal(found.active, "other@g.com")
  assert.equal(found.mismatch, true)
  assert.equal(fs.readFileSync(tokenFileOf(home), "utf8"), beforeToken)
  assert.equal(fs.readFileSync(accountsFileOf(home), "utf8"), beforeAccounts)
})

test("captureCurrent stores a 0600 vault file in a 0700 dir; only captured accounts become switchable", (t) => {
  const home = tempDir(t)
  const vaultDir = path.join(home, "state", "accounts")
  const payload = { auth_method: "oauth", id_token_email: "one@g.com", token: { access_token: "at-1" } }
  writeTokenFile(home, payload)
  writeAccountsFile(home, "one@g.com", ["two@g.com"])
  const captured = captureCurrent({ home, vaultDir })
  assert.equal(captured.ok, true)
  assert.equal(captured.email, "one@g.com")
  assert.equal(captured.file, vaultFileOf(vaultDir, "one@g.com"))
  const stored = JSON.parse(fs.readFileSync(captured.file, "utf8"))
  assert.equal(stored.version, 1)
  assert.equal(stored.email, "one@g.com")
  assert.equal(typeof stored.capturedAt, "string")
  assert.deepEqual(stored.token, payload)
  if (!isWin) {
    assert.equal(fs.statSync(vaultDir).mode & 0o777, 0o700)
    assert.equal(fs.statSync(captured.file).mode & 0o777, 0o600)
  }
  const found = discoverAccounts({ home, configured: [], vaultDir })
  const one = found.candidates.find((c) => c.email === "one@g.com")
  const two = found.candidates.find((c) => c.email === "two@g.com")
  assert.equal(one.captured, true)
  assert.equal(one.switchable, true)
  assert.equal(one.status, "ok")
  assert.equal(two.captured, false)
  assert.equal(two.switchable, false)
  assert.equal(two.status, "uncaptured")
})

test("captureCurrent fails cleanly on a missing token file or a token without email", (t) => {
  const home = tempDir(t)
  const vaultDir = path.join(home, "vault")
  assert.equal(captureCurrent({ home, vaultDir }).ok, false)
  writeTokenFile(home, { auth_method: "oauth", token: { access_token: "x" } })
  const result = captureCurrent({ home, vaultDir })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "no email in token file")
  assert.equal(fs.existsSync(vaultDir), false)
})

test("writeActiveAccount swaps both files, demotes old active into old, drops target from old", (t) => {
  const home = tempDir(t)
  const donor = tempDir(t)
  const vaultDir = path.join(home, "state", "accounts")
  writeTokenFile(home, { auth_method: "oauth", id_token_email: "a@g.com", token: { access_token: "a-token" } })
  writeAccountsFile(home, "a@g.com", ["b@g.com", "c@g.com"])
  writeTokenFile(donor, { auth_method: "oauth", id_token_email: "b@g.com", token: { access_token: "b-token", refresh_token: "rt" } })
  assert.equal(captureCurrent({ home: donor, vaultDir }).ok, true)
  const missing = writeActiveAccount({ home, email: "nobody@g.com", vaultDir })
  assert.equal(missing.ok, false)
  assert.equal(emailFromTokenPayload(JSON.parse(fs.readFileSync(tokenFileOf(home), "utf8"))), "a@g.com")
  const result = writeActiveAccount({ home, email: "b@g.com", vaultDir })
  assert.equal(result.ok, true)
  assert.equal(result.previous, "a@g.com")
  const tokenNow = JSON.parse(fs.readFileSync(tokenFileOf(home), "utf8"))
  assert.equal(emailFromTokenPayload(tokenNow), "b@g.com")
  assert.equal(tokenNow.token.access_token, "b-token")
  const accountsNow = JSON.parse(fs.readFileSync(accountsFileOf(home), "utf8"))
  assert.equal(accountsNow.active, "b@g.com")
  assert.deepEqual(accountsNow.old, ["c@g.com", "a@g.com"])
  const found = discoverAccounts({ home, configured: [], vaultDir })
  assert.equal(found.current, "b@g.com")
  assert.equal(found.mismatch, false)
})

test("writeActiveAccount restores both originals when the second rename fails", (t) => {
  const home = tempDir(t)
  const donor = tempDir(t)
  const vaultDir = path.join(home, "state", "accounts")
  writeTokenFile(home, { auth_method: "oauth", id_token_email: "a@g.com", token: { access_token: "a-token" } })
  writeAccountsFile(home, "a@g.com", ["b@g.com"])
  writeTokenFile(donor, { auth_method: "oauth", id_token_email: "b@g.com", token: { access_token: "b-token" } })
  assert.equal(captureCurrent({ home: donor, vaultDir }).ok, true)
  const beforeToken = fs.readFileSync(tokenFileOf(home), "utf8")
  const beforeAccounts = fs.readFileSync(accountsFileOf(home), "utf8")
  const realRename = fs.renameSync
  let calls = 0
  fs.renameSync = function patchedRename(...args) {
    calls += 1
    if (calls >= 2) {
      const error = new Error("simulated rename failure")
      error.code = "EIO"
      throw error
    }
    return realRename.apply(this, args)
  }
  syncBuiltinESMExports()
  let result
  try {
    result = writeActiveAccount({ home, email: "b@g.com", vaultDir })
  } finally {
    fs.renameSync = realRename
    syncBuiltinESMExports()
  }
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes("rename failure"), result.reason)
  assert.equal(result.restored, true)
  assert.equal(fs.readFileSync(tokenFileOf(home), "utf8"), beforeToken)
  assert.equal(fs.readFileSync(accountsFileOf(home), "utf8"), beforeAccounts)
  const leftovers = [
    ...fs.readdirSync(path.dirname(tokenFileOf(home))),
    ...fs.readdirSync(path.dirname(accountsFileOf(home))),
  ].filter((name) => name.includes(".tmp"))
  assert.deepEqual(leftovers, [])
})

test("POSIX switch lock: second acquire reports busy until release, then it is acquirable again", async (t) => {
  if (isWin) return t.skip("POSIX flock lock needs a non-Windows platform")
  const probe = spawnSync("flock", ["--version"], { windowsHide: true })
  if (probe.error) return t.skip("flock unavailable")
  const home = tempDir(t)
  const first = await acquireSwitchLock({ home, platform: "linux" })
  assert.equal(first.ok, true)
  const second = await acquireSwitchLock({ home, platform: "linux" })
  assert.equal(second.ok, false)
  assert.equal(second.reason, "busy")
  await first.release()
  const third = await acquireSwitchLock({ home, platform: "linux" })
  assert.equal(third.ok, true)
  await third.release()
  const fourth = await acquireSwitchLock({ home, platform: "linux" })
  assert.equal(fourth.ok, true)
  await fourth.release()
})

test("POSIX switch lock is excluded by a python3 fcntl holder (agy-quota.py interop)", async (t) => {
  if (isWin) return t.skip("POSIX flock interop needs a non-Windows platform")
  const probe = spawnSync("python3", ["-c", "print(1)"], { windowsHide: true })
  if (probe.error) return t.skip("python3 unavailable")
  const home = tempDir(t)
  const lockFile = path.join(home, ".better-harness", "agy-switch.lock")
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  const holder = spawn("python3", [
    "-c",
    `import fcntl, time\nf = open(${JSON.stringify(lockFile)}, "a+")\nfcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)\nprint("held", flush=True)\ntime.sleep(120)`,
  ], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true })
  t.after(() => {
    try {
      holder.kill()
    } catch {}
  })
  const held = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000)
    holder.stdout.on("data", (chunk) => {
      if (String(chunk).includes("held")) {
        clearTimeout(timer)
        resolve(true)
      }
    })
    holder.on("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  assert.equal(held, true, "python3 holder did not take the lock")
  const blocked = await acquireSwitchLock({ home, platform: "linux" })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, "busy")
  holder.kill()
  await new Promise((resolve) => holder.on("close", resolve))
  const after = await acquireSwitchLock({ home, platform: "linux" })
  assert.equal(after.ok, true)
  await after.release()
})

test("win32 directory lock: busy while held; stale dead owner reclaimed; alive/fresh/foreign-host owners kept", async (t) => {
  const home = tempDir(t)
  const options = { home, platform: "win32" }
  const lockDir = path.join(home, ".better-harness", "agy-switch.lock.d")
  const first = await acquireSwitchLock(options)
  assert.equal(first.ok, true)
  assert.ok(fs.existsSync(path.join(lockDir, "owner.json")))
  const second = await acquireSwitchLock(options)
  assert.equal(second.ok, false)
  assert.equal(second.reason, "busy")
  first.release()
  assert.equal(fs.existsSync(lockDir), false)
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"])
  await new Promise((resolve) => dead.on("close", resolve))
  const craft = (owner) => {
    fs.rmSync(lockDir, { recursive: true, force: true })
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner))
  }
  craft({ pid: dead.pid, host: os.hostname(), at: Date.now() - 3 * 60_000 })
  const reclaimed = await acquireSwitchLock(options)
  assert.equal(reclaimed.ok, true)
  reclaimed.release()
  craft({ pid: process.pid, host: os.hostname(), at: Date.now() - 3 * 60_000 })
  assert.equal((await acquireSwitchLock(options)).reason, "busy")
  craft({ pid: dead.pid, host: os.hostname(), at: Date.now() })
  assert.equal((await acquireSwitchLock(options)).reason, "busy")
  craft({ pid: dead.pid, host: "other-host", at: Date.now() - 3 * 60_000 })
  assert.equal((await acquireSwitchLock(options)).reason, "busy")
  craft({ pid: dead.pid, host: os.hostname(), at: "not-a-number" })
  assert.equal((await acquireSwitchLock(options)).reason, "busy")
  craft({ pid: dead.pid, host: os.hostname(), at: Date.now() - 3 * 60_000 })
  fs.rmSync(path.join(lockDir, "owner.json"))
  assert.equal((await acquireSwitchLock(options)).reason, "busy")
})

test("foreignAgyProcesses excludes own pids and their agy descendants (linux /proc scan)", async (t) => {
  if (process.platform !== "linux") return t.skip("needs the /proc scan on linux")
  const dir = tempDir(t, "agy-foreign-")
  fs.mkdirSync(path.join(dir, "inner"), { recursive: true })
  fs.writeFileSync(path.join(dir, "agy"), `#!/bin/sh\n"${process.execPath}" "${dir}/inner/agy" &\nsleep 30\n`)
  fs.chmodSync(path.join(dir, "agy"), 0o755)
  fs.writeFileSync(path.join(dir, "inner", "agy"), "setTimeout(() => {}, 60000)\n")
  const outer = spawn(path.join(dir, "agy"), [], { stdio: "ignore", windowsHide: true })
  let innerPid = null
  t.after(() => {
    if (innerPid) {
      try {
        process.kill(innerPid, "SIGKILL")
      } catch {}
    }
    try {
      outer.kill("SIGKILL")
    } catch {}
  })
  innerPid = await waitUntil(async () => {
    const scan = await foreignAgyProcesses({ ownPids: [], platform: "linux" })
    if (!scan.ok) return null
    const inner = scan.foreign.find((p) => p.ppid === outer.pid)
    return inner ? inner.pid : null
  }, 5000)
  assert.ok(innerPid, "inner agy descendant was not detected")
  const seen = await foreignAgyProcesses({ ownPids: [], platform: "linux" })
  assert.equal(seen.ok, true)
  assert.ok(seen.foreign.some((p) => p.pid === outer.pid), "outer agy process not listed as foreign")
  assert.ok(seen.foreign.some((p) => p.pid === innerPid), "inner agy process not listed as foreign")
  const own = await foreignAgyProcesses({ ownPids: [outer.pid], platform: "linux" })
  assert.equal(own.ok, true)
  assert.ok(!own.foreign.some((p) => p.pid === outer.pid), "own pid still listed as foreign")
  assert.ok(!own.foreign.some((p) => p.pid === innerPid), "own pid's agy descendant still listed as foreign")
})
