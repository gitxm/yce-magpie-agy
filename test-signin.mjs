import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { tokenFileOf } from "./accounts.mjs"
import {
  cannotSignIn,
  forgetStoredSignIn,
  isDead,
  noteDead,
  readStoredSignIn,
  storedSignIn,
} from "./signin.mjs"
import { createUsageReader } from "./usage.mjs"

const SAMPLE_DARWIN_ATTR = (mdat = "20261114040000Z") => [
  'keychain: "/Users/demo/Library/Keychains/login.keychain-db"',
  "version: 512",
  'class: "genp"',
  "attributes:",
  '    "acct"<blob>="antigravity"',
  `    "mdat"<timedate>=0x31  "${mdat}\\000"`,
  '    "svce"<blob>="gemini"',
].join("\n")

function writeTokenFile(home, payload) {
  const file = tokenFileOf(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(payload), "utf8")
  return file
}

test("darwin readStoredSignIn queries Keychain attributes without -w, tracks mdat changes, and falls back to antigravity-oauth-token", async () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-signin-darwin-empty-"))
  const tokenHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-signin-darwin-file-"))
  try {
    const calls = []
    const first = await readStoredSignIn({
      platform: "darwin",
      home: emptyHome,
      env: {},
      exec: async (file, args) => {
        calls.push({ file, args })
        return { code: 0, stdout: SAMPLE_DARWIN_ATTR("20261114040000Z") }
      },
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].file, "/usr/bin/security")
    assert.ok(!calls[0].args.includes("-w"), "darwin Keychain check must not pass -w or macOS may prompt for Keychain ACL access")
    assert.equal(first.state, "present")
    assert.equal(first.canRenew, true)
    assert.equal(first.expired, false)
    assert.equal(cannotSignIn(first), "")

    noteDead(first)
    assert.equal(isDead(first), true)

    const relogged = await readStoredSignIn({
      platform: "darwin",
      home: emptyHome,
      env: {},
      exec: async () => ({ code: 0, stdout: SAMPLE_DARWIN_ATTR("20261114053000Z") }),
    })
    assert.equal(relogged.state, "present")
    assert.notEqual(relogged.fp, first.fp, "updated Keychain mdat must rotate fp so re-login clears dead status")
    assert.equal(isDead(relogged), false)

    const missing = await readStoredSignIn({
      platform: "darwin",
      home: emptyHome,
      env: {},
      exec: async () => ({ code: 44, stdout: "" }),
    })
    assert.deepEqual(missing, { state: "missing" })
    assert.match(cannotSignIn(missing), /isn't signed in/)

    writeTokenFile(tokenHome, {
      auth_method: "consumer",
      id_token_email: "mac-user@example.com",
      token: {
        access_token: "ya29.expired-1h-ago",
        refresh_token: "1//valid-refresh-token",
        expiry: "2026-11-14T01:00:00Z",
      },
    })
    const now = Date.parse("2026-11-14T04:00:00Z")
    for (const code of [44, 36]) {
      const fallback = await readStoredSignIn({
        platform: "darwin",
        home: tokenHome,
        env: {},
        now,
        exec: async () => ({ code, stdout: "" }),
      })
      assert.equal(fallback.state, "present")
      assert.equal(fallback.canRenew, true)
      assert.equal(fallback.expired, true)
      assert.equal(cannotSignIn(fallback), "")
    }
  } finally {
    forgetStoredSignIn({ dead: true })
    fs.rmSync(emptyHome, { recursive: true, force: true })
    fs.rmSync(tokenHome, { recursive: true, force: true })
  }
})

test("win32 readStoredSignIn falls back to antigravity-oauth-token and rotates fp on account switch", async () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-signin-win-empty-"))
  const tokenHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-signin-win-file-"))
  try {
    const missing = await readStoredSignIn({
      platform: "win32",
      home: emptyHome,
      env: {},
      exec: async () => ({ code: 0, stdout: "MISSING\r\n" }),
    })
    assert.deepEqual(missing, { state: "missing" })

    writeTokenFile(tokenHome, {
      auth_method: "consumer",
      id_token_email: "alpha@example.com",
      token: { refresh_token: "1//alpha-refresh" },
    })
    const fromFile = await readStoredSignIn({
      platform: "win32",
      home: tokenHome,
      env: {},
      exec: async () => ({ code: 0, stdout: "MISSING\r\n" }),
    })
    assert.equal(fromFile.state, "present")
    assert.equal(fromFile.canRenew, true)

    const credPayload = Buffer.from(JSON.stringify({
      token: { refresh_token: "1//cred-refresh", access_token: "ya29.cred" },
    }), "utf8").toString("base64")
    const fpAlpha = (await readStoredSignIn({
      platform: "win32",
      home: tokenHome,
      env: {},
      exec: async () => ({ code: 0, stdout: `OK ${credPayload}\r\n` }),
    })).fp

    writeTokenFile(tokenHome, {
      auth_method: "consumer",
      id_token_email: "beta@example.com",
      token: { refresh_token: "1//beta-refresh" },
    })
    const fpBeta = (await readStoredSignIn({
      platform: "win32",
      home: tokenHome,
      env: {},
      exec: async () => ({ code: 0, stdout: `OK ${credPayload}\r\n` }),
    })).fp
    assert.notEqual(fpAlpha, fpBeta, "switching antigravity-oauth-token must rotate combined fp")
  } finally {
    forgetStoredSignIn({ dead: true })
    fs.rmSync(emptyHome, { recursive: true, force: true })
    fs.rmSync(tokenHome, { recursive: true, force: true })
  }
})

test("usage reader keeps renewable sign-in on empty-output /usage timeout, while genuine auth failure marks expired", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-signin-usage-"))
  const isWin = process.platform === "win32"
  const script = path.join(dir, "fake-usage-agy.mjs")
  const exe = path.join(dir, isWin ? "agy.cmd" : "agy")
  try {
    fs.writeFileSync(script, [
      'const args = process.argv.slice(2)',
      'if (args[0] === "--version") { console.log("1.5.0"); process.exit(0) }',
      'const mode = process.env.SIGNIN_USAGE_MODE',
      'if (mode === "silent-hang") { setInterval(() => {}, 1000) }',
      'else if (mode === "auth-hang") {',
      '  console.log("Open this link in a browser: https://accounts.google.com/o/oauth2/auth")',
      '  setInterval(() => {}, 1000)',
      '} else if (mode === "auth-exit") {',
      '  console.error("Not logged in")',
      '  process.exit(1)',
      '}',
    ].join("\n"), "utf8")
    if (isWin) {
      fs.writeFileSync(exe, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8")
    } else {
      fs.writeFileSync(exe, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o700 })
    }

    const renewable = {
      state: "present",
      fp: "renewable-1h-expired-access-token",
      canRenew: true,
      expiresAt: Date.now() - 3600_000,
      expired: true,
    }
    const silentTimeoutReader = createUsageReader(() => exe, {
      env: { ...process.env, SIGNIN_USAGE_MODE: "silent-hang" },
      tempRoot: dir,
      timeoutMs: isWin ? 1200 : 400,
      versionTimeoutMs: isWin ? 1000 : 800,
      signIn: async () => renewable,
    })
    const kept = await silentTimeoutReader()
    assert.equal(kept.signIn, "kept", "1-hour access_token expiry with valid refresh_token must not drop Magpie sign-in on timeout")
    assert.equal(isDead(renewable), false, "transient /usage timeout must not poison renewable fp in dead set")

    const promptHangToken = { ...renewable, fp: "prompt-hang-fp" }
    const authHangReader = createUsageReader(() => exe, {
      env: { ...process.env, SIGNIN_USAGE_MODE: "auth-hang" },
      tempRoot: dir,
      timeoutMs: isWin ? 1200 : 400,
      versionTimeoutMs: isWin ? 1000 : 800,
      signIn: async () => promptHangToken,
    })
    const promptExpired = await authHangReader()
    assert.equal(promptExpired.signIn, "expired")
    assert.equal(isDead(promptHangToken), true)

    const revokedToken = { ...renewable, fp: "revoked-fp" }
    const authExitReader = createUsageReader(() => exe, {
      env: { ...process.env, SIGNIN_USAGE_MODE: "auth-exit" },
      tempRoot: dir,
      signIn: async () => revokedToken,
    })
    const exitExpired = await authExitReader()
    assert.equal(exitExpired.signIn, "expired")
    assert.equal(isDead(revokedToken), true)
  } finally {
    forgetStoredSignIn({ dead: true })
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test("authorize recovers from stale noteDead when agy models works and reuses renewable local sign-in on transient network error", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-signin-auth-"))
  const home = path.join(dir, "home")
  const isWin = process.platform === "win32"
  const script = path.join(dir, "fake-auth-agy.mjs")
  const exe = path.join(dir, isWin ? "agy.cmd" : "agy")
  const logFile = path.join(dir, "spawns.jsonl")

  fs.writeFileSync(script, [
    'import fs from "node:fs"',
    'import readline from "node:readline"',
    'const args = process.argv.slice(2)',
    'fs.appendFileSync(process.env.SIGNIN_AUTH_LOG, JSON.stringify({ args }) + "\\n")',
    'const mode = process.env.SIGNIN_MODELS_MODE || "ok"',
    'if (args[0] === "models") {',
    '  if (mode === "ok") {',
    '    process.stdout.write("gemini-3.8-flash-high  Gemini 3.8 Flash (High)\\n")',
    '    process.exit(0)',
    '  }',
    '  if (mode === "net-fail") {',
    '    process.stderr.write("Error: dial tcp 142.250.4.95:443: i/o timeout\\n")',
    '    process.exit(1)',
    '  }',
    '  process.stderr.write("Error: Please sign in to view available models.\\n")',
    '  process.exit(1)',
    '}',
    'if (args[0] === "acp" && args.includes("--login")) {',
    '  process.stdout.write("https://accounts.google.com/o/oauth2/auth?client_id=test&response_type=code\\n")',
    '  const rl = readline.createInterface({ input: process.stdin })',
    '  rl.once("line", () => process.exit(0))',
    '  setTimeout(() => process.exit(0), 200)',
    '}',
  ].join("\n"), "utf8")
  if (isWin) {
    fs.writeFileSync(exe, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8")
  } else {
    fs.writeFileSync(exe, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o700 })
  }

  writeTokenFile(home, {
    auth_method: "consumer",
    id_token_email: "user@example.com",
    token: { refresh_token: "1//local-valid-refresh", access_token: "ya29.local" },
  })

  const envKeys = ["HOME", "USERPROFILE", "AGY_PATH", "AGY_BRIDGE_STORED_SIGNIN", "FAKE_AGY_LOG", "SIGNIN_AUTH_LOG", "SIGNIN_MODELS_MODE"]
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]))
  const origHomedir = os.homedir

  try {
    os.homedir = () => home
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.AGY_PATH = exe
    process.env.AGY_BRIDGE_STORED_SIGNIN = "file"
    process.env.SIGNIN_AUTH_LOG = logFile
    delete process.env.FAKE_AGY_LOG

    forgetStoredSignIn({ dead: true })
    const current = await storedSignIn({ fresh: true })
    assert.equal(current.state, "present")
    noteDead(current)
    assert.equal(isDead(current), true)

    const { AntigravityBridgePlugin } = await import("./index.mjs?signin-authorize-suite")
    const plugin = await AntigravityBridgePlugin()
    const readSpawns = () => (fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [])

    // 1) Stale isDead mark is cleared when explicit `authorize()` sees `agy models` succeed.
    process.env.SIGNIN_MODELS_MODE = "ok"
    const recovered = await plugin.auth.methods[0].authorize()
    assert.equal(recovered.method, "auto")
    assert.equal(recovered.url, "")
    assert.equal(isDead(current), false, "successful agy models probe must clear stale dead mark")
    assert.equal((await recovered.callback())?.type, "success")

    // 2) Transient network/timeout failure during `agy models` reuses local renewable credential instead of starting `agy acp --login`.
    process.env.SIGNIN_MODELS_MODE = "net-fail"
    const beforeNet = readSpawns().length
    const netReused = await plugin.auth.methods[0].authorize()
    const netSpawns = readSpawns().slice(beforeNet)
    assert.equal(netReused.method, "auto", "transient network error with renewable local credential must not force re-login")
    assert.ok(!netSpawns.some((s) => s.args.includes("--login")), "must not spawn agy acp --login on network timeout")

    // 3) Genuine sign-in failure still launches `agy acp --login` OAuth flow.
    process.env.SIGNIN_MODELS_MODE = "auth-fail"
    const prompted = await plugin.auth.methods[0].authorize()
    assert.equal(prompted.method, "code")
    assert.match(prompted.url ?? "", /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/)
  } finally {
    os.homedir = origHomedir
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    forgetStoredSignIn({ dead: true })
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test("native win32 CredReadW script executes cleanly through powershell.exe", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  const started = Date.now()
  const result = await readStoredSignIn({ platform: "win32", env: {} })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 9000, `CredReadW PowerShell read hung until timeout (${elapsed}ms)`)
  assert.ok(["present", "missing"].includes(result.state), `expected present or missing from CredReadW, got ${JSON.stringify(result)}`)
  if (result.state === "present") {
    assert.equal(typeof result.fp, "string")
    assert.equal(result.fp.length, 32)
    assert.equal(typeof result.canRenew, "boolean")
  }
})
