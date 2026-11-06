// Independent black-box QA. Every account, process and credential is synthetic.
// No production source transforms, no real agy, and no developer-home access.
// Optional testkit hooks replace ACP/CLI/OS boundaries only.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import { accountKey, accountsFileOf, acquireSwitchLock, captureCurrent, discoverAccounts,
  emailFromTokenPayload, tokenFileOf, vaultFileOf, writeActiveAccount } from "./accounts.mjs"
import { maskEmail, maskedAccountReport, parseUsageReport } from "./usage.mjs"
import { baseBody, createBridgeKit, readSse, seedAccountHome, tick } from "./testkit.mjs"

const require = createRequire(import.meta.url)
const firstEmail = "alpha.qa@example.test"
const secondEmail = "beta.qa@example.test"
const thirdEmail = "charlie.qa@example.test"
const quotaReport = (fraction = 0.6) => ({ status: "SUCCESS", command: { name: "usage", data: { groups: [
  { name: "Gemini Models", buckets: [{ id: "session", window: "5h", remaining_fraction: fraction }] },
  { name: "Claude and GPT models", buckets: [{ id: "week", window: "weekly", remaining_fraction: 0.75 }] },
] } } })
const host = switches => ({ magpie: { option: (_provider, key) => switches[key] } })
const follow = (body, parsed, text = "continue") => ({ ...body, messages: [...body.messages,
  { role: "assistant", content: parsed.content }, { role: "user", content: text }] })

async function withKit(fn, options = {}) {
  const kit = await createBridgeKit(options)
  try { return await fn(kit) } finally { await kit.dispose() }
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-qa-switch-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function pendingAgent(kit) {
  kit.defaultPrompt = async agent => { await agent.tool("Read", { path: `/qa/${agent.index}` }); await agent.text("done") }
}

function installCli(kit) {
  kit.qaCommands = []
  kit.qaSpawn = (file, args, _opts, makeChild) => {
    if (!["flock", "perl"].includes(file) && !args.includes("--version") && !args.includes("/usage")) return
    const child = makeChild()
    child.stdout.destroy = child.stderr.destroy = () => {}
    kit.qaCommands.push({ file, args, child })
    setImmediate(() => {
      if (child.closed) return
      if (["flock", "perl"].includes(file)) {
        child.stdout.emit("data", "locked\n")
        child.stdin.end = () => child.finish(0)
        return
      }
      const output = args.includes("--version") ? "1.3.5\n" : JSON.stringify(quotaReport())
      child.stdout.emit("data", Buffer.from(output))
      child.finish(0)
    })
    return child
  }
  // Deterministic process discovery: there are no external agy processes.
  // Preserve /proc/version and all fixture file IO through the default reader.
  kit.qaReadFile = (file, _args, readDefault) => {
    if (/^\/proc\/\d+\/cmdline$/.test(String(file))) return Buffer.from("")
    return readDefault()
  }
  kit.qaAcp = (message, agy) => {
    if (message.method === "initialize") {
      agy.respond(message.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: true } } })
      return true
    }
    if (message.method === "session/resume") {
      agy.sessionId = message.params.sessionId
      agy.control({ kind: "list" })
      agy.respond(message.id, { sessionId: agy.sessionId, models: { currentModelId: kit.initialAgyModel } })
      return true
    }
    return false
  }
}

async function setupSwitch(kit, options = {}) {
  installCli(kit)
  const seeded = seedAccountHome(kit.home, { env: kit.env, emails: [firstEmail, secondEmail, thirdEmail], ...options })
  kit.plugin = await kit.module.AntigravityBridgePlugin(host({ auto_switch: true }), options.packageOptions)
  kit.defaultPrompt = async agent => { await agent.text(`answer ${agent.index}`) }
  return seeded
}

function current(seeded) { return JSON.parse(fs.readFileSync(seeded.accountsFile, "utf8")).active }
const switchNow = kit => kit.module.__agyTestScheduleAccountSwitch({ reason: "qa", modelFamily: "gemini-4-argon" })

function watchEvents(t) {
  const rows = []
  const write = process.stderr.write
  process.stderr.write = function (chunk, ...args) {
    const value = String(chunk)
    if (value.startsWith("[agy-bridge] ")) { rows.push(JSON.parse(value.slice(13))); return true }
    return write.call(this, chunk, ...args)
  }
  t.after(() => { process.stderr.write = write })
  return rows
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

for (const value of [0, -1, 65, 1.5, "2", false]) {
  test(`QA options: maxProcs rejects ${JSON.stringify(value)} instead of coercing or clamping`, async () => {
    await withKit(async kit => {
      await assert.rejects(kit.module.AntigravityBridgePlugin(undefined, { maxProcs: value }), /"maxProcs"/)
      assert.equal(kit.acpSpawns.length, 0)
    })
  })
}

test("QA options: inclusive maxProcs bounds 1 and 64 are usable", async () => {
  for (const value of [1, 64]) await withKit(async kit => {
    await kit.module.AntigravityBridgePlugin(undefined, { maxProcs: value })
    kit.defaultPrompt = async agent => { await agent.text("accepted") }
    assert.equal((await readSse(await kit.request(baseBody()))).stopReason, "end_turn")
  })
})

test("QA options: non-array accounts and invalid members fail before starting agy", async () => {
  await withKit(async kit => {
    for (const accounts of [{}, "one@example.test", 1, true,
      ["without-at"], ["one @example.test"], ["one\t@example.test"], ["one@example.test\n"], [null], [1]]) {
      await assert.rejects(kit.module.AntigravityBridgePlugin(undefined, { accounts }), /"accounts"/)
    }
    assert.equal(kit.children.size, 0)
  })
})

for (const unset of [null, ""]) {
  test(`QA options: agyPath=${JSON.stringify(unset)} clears an old override and restores env resolution`, async () => {
    await withKit(async kit => {
      const override = kit.makeFakeAgy("qa-override")
      await kit.module.AntigravityBridgePlugin(undefined, { agyPath: override })
      await kit.module.AntigravityBridgePlugin(undefined, { agyPath: unset })
      kit.defaultPrompt = async agent => { await agent.text("fallback") }
      await readSse(await kit.request(baseBody()))
      assert.equal(kit.acpSpawns[0].file, kit.agyPath)
    })
  })
}

test("QA options: agyPath rejects arrays, booleans and objects without coercing", async () => {
  await withKit(async kit => {
    for (const agyPath of [[], {}, true, 42]) {
      await assert.rejects(kit.module.AntigravityBridgePlugin(undefined, { agyPath }), /"agyPath"/)
    }
  })
})

test("QA options: package override beats env, clearing it restores env, clearing env restores default", async () => {
  await withKit(async kit => {
    pendingAgent(kit)
    await kit.module.AntigravityBridgePlugin(undefined, { maxProcs: 2 })
    for (let i = 0; i < 2; i++) {
      assert.equal((await readSse(await kit.request(baseBody({ metadata: { user_id: `qa-cap-${i}` } })))).stopReason, "tool_use")
    }
    const full = await kit.request(baseBody({ metadata: { user_id: "qa-cap-2" } }))
    assert.equal(full.status, 503)
    assert.match(await full.text(), /2 agy processes/)
    await kit.module.AntigravityBridgePlugin(undefined, { maxProcs: null })
    const envFull = await kit.request(baseBody({ metadata: { user_id: "qa-cap-3" } }))
    assert.equal(envFull.status, 503)
    assert.match(await envFull.text(), /1 agy processes/)
    delete kit.env.AGY_BRIDGE_MAX_PROCS
    assert.equal((await readSse(await kit.request(baseBody({ metadata: { user_id: "qa-cap-4" } })))).stopReason, "tool_use")
    assert.equal(kit.acpSpawns.length, 3)
  }, { env: { AGY_BRIDGE_MAX_PROCS: "1" } })
})

test("QA options: unknown keys produce one names-only event while valid fields still apply", async t => {
  const events = watchEvents(t)
  await withKit(async kit => {
    await kit.module.AntigravityBridgePlugin(undefined, { futureFlag: "do-not-log-this-value", anotherFlag: { secret: "hidden" }, maxProcs: 1 })
    const rows = events.filter(row => row.action === "plugin_options")
    assert.equal(rows.length, 1)
    assert.equal(rows[0].reason, "ignored_unknown_keys")
    assert.deepEqual(rows[0].keys.split(",").sort(), ["anotherFlag", "futureFlag"])
    assert.doesNotMatch(JSON.stringify(rows), /do-not-log-this-value|hidden/)
  })
})

test("QA declarations: keys are unique, bounded and safe; destructive switch is opt-in with confirmation", async () => {
  await withKit(async kit => {
    const options = kit.plugin.auth.options
    assert.ok(options.length > 0 && options.length <= 10)
    assert.equal(new Set(options.map(option => option.key)).size, options.length)
    for (const option of options) {
      assert.match(option.key, /^[a-z0-9_-]{1,40}$/)
      for (const [field, max] of [["label", 60], ["description", 300], ["confirm", 300]]) {
        if (field === "confirm" && option[field] === undefined) continue
        assert.equal(typeof option[field], "string")
        assert.ok(option[field].trim().length > 0 && option[field].length <= max)
      }
      assert.equal(typeof option.default, "boolean")
    }
    const switching = options.find(option => option.key === "auto_switch")
    assert.equal(switching.default, false)
    assert.match(switching.confirm, /google_accounts\.json/)
  })
})

for (const value of [undefined, null, "false"]) {
  test(`QA host switches: non-boolean ${String(value)} falls through to legacy env then defaults`, async () => {
    await withKit(async kit => {
      const switches = { thinking_summary: value, minimal_agent: value, auto_switch: value }
      await kit.module.AntigravityBridgePlugin(host(switches))
      kit.defaultPrompt = async agent => { await agent.thought("private plan"); await agent.text("answer") }
      const body = baseBody()
      const off = await readSse(await kit.request(body))
      assert.equal(off.content.some(block => block.type === "thinking"), false)
      assert.equal(kit.module.autoSwitchEnabled(), false)
      const agents = fs.readdirSync(kit.tmp, { recursive: true }).filter(file => String(file).endsWith("agent.md"))
      assert.equal(agents.length, 1)
      assert.doesNotMatch(fs.readFileSync(path.join(kit.tmp, agents[0]), "utf8"), /excludeDefaultComponents/)
      delete kit.env.AGY_BRIDGE_THINKING
      delete kit.env.AGY_BRIDGE_MINIMAL_AGENT
      const on = await readSse(await kit.request(follow(body, off)))
      assert.equal(on.content.some(block => block.type === "thinking"), true)
      assert.equal(kit.acpSpawns.length, 2)
    }, { env: { AGY_BRIDGE_THINKING: "0", AGY_BRIDGE_MINIMAL_AGENT: "0" } })
  })
}

test("QA accounts: malformed token JSON and malformed nested JWT cannot create a vault", t => {
  const home = tempHome(t)
  const vaultDir = path.join(home, "vault")
  fs.mkdirSync(path.dirname(tokenFileOf(home)), { recursive: true })
  for (const raw of ["{broken", "null", "[]", JSON.stringify({ token: { id_token: "a.###.c" } }),
    JSON.stringify({ token: { id_token: `a.${Buffer.from("[]").toString("base64url")}.c` } })]) {
    fs.writeFileSync(tokenFileOf(home), raw)
    assert.equal(captureCurrent({ home, vaultDir }).ok, false)
    assert.equal(discoverAccounts({ home, vaultDir }).current, null)
    assert.equal(fs.existsSync(vaultDir), false)
  }
})

test("QA accounts: mixed-case token/active/old entries share identity and old cannot duplicate current", t => {
  const home = tempHome(t)
  writeJson(tokenFileOf(home), { id_token_email: "Alpha.QA@Example.TEST" })
  writeJson(accountsFileOf(home), { active: firstEmail, old: [firstEmail.toUpperCase(), secondEmail, secondEmail.toUpperCase(), null, "not-email"] })
  const found = discoverAccounts({ home, vaultDir: path.join(home, "vault") })
  assert.equal(found.mismatch, false)
  assert.deepEqual(found.candidates.map(row => row.email), [firstEmail, secondEmail])
  assert.equal(found.candidates.filter(row => row.current).length, 1)
  assert.equal(accountKey(found.current), accountKey(firstEmail))
})

test("QA accounts: valid nested email survives invalid top-level JWT and non-object token shapes", () => {
  for (const token of [null, [], "invalid", 42]) assert.equal(emailFromTokenPayload({ token }), null)
  assert.equal(emailFromTokenPayload({ id_token: "broken", token: { id_token_email: secondEmail } }), secondEmail)
  const jwt = `a.${Buffer.from(JSON.stringify({ email: secondEmail })).toString("base64url")}.c`
  assert.equal(emailFromTokenPayload({ id_token: "not.a.jwt", token: { id_token: jwt } }), secondEmail)
})

test("QA accounts: writing the already-current captured account twice is stable", t => {
  const home = tempHome(t)
  const seeded = seedAccountHome(home, { env: {}, emails: [firstEmail, secondEmail] })
  assert.equal(writeActiveAccount({ home, email: firstEmail, vaultDir: seeded.vaultDir }).ok, true)
  const before = [seeded.tokenFile, seeded.accountsFile].map(file => fs.readFileSync(file, "utf8"))
  assert.equal(writeActiveAccount({ home, email: firstEmail, vaultDir: seeded.vaultDir }).ok, true)
  assert.deepEqual([seeded.tokenFile, seeded.accountsFile].map(file => fs.readFileSync(file, "utf8")), before)
  assert.deepEqual(JSON.parse(before[1]), { active: firstEmail, old: [secondEmail] })
})

test("QA accounts: colliding/wrong-identity vault slot fails verification and restores both files", t => {
  const home = tempHome(t)
  const seeded = seedAccountHome(home, { env: {}, emails: [firstEmail, secondEmail] })
  // A different identity in the same 16-hex slot simulates the on-disk result
  // of a truncated-hash collision without guessing a SHA-256 preimage.
  fs.copyFileSync(vaultFileOf(seeded.vaultDir, firstEmail), vaultFileOf(seeded.vaultDir, secondEmail))
  const before = [seeded.tokenFile, seeded.accountsFile].map(file => fs.readFileSync(file, "utf8"))
  const result = writeActiveAccount({ home, email: secondEmail, vaultDir: seeded.vaultDir })
  assert.equal(result.ok, false)
  assert.equal(result.restored, true)
  assert.match(result.reason, /verification failed/)
  assert.deepEqual([seeded.tokenFile, seeded.accountsFile].map(file => fs.readFileSync(file, "utf8")), before)
})

test("QA accounts: directory-lock double release cannot remove a newly acquired owner's lock", async t => {
  const home = tempHome(t)
  const a = await acquireSwitchLock({ home, platform: "win32" })
  assert.equal(a.ok, true)
  assert.equal((await acquireSwitchLock({ home, platform: "win32" })).reason, "busy")
  await a.release()
  const b = await acquireSwitchLock({ home, platform: "win32" })
  assert.equal(b.ok, true)
  try {
    await a.release()
    assert.equal((await acquireSwitchLock({ home, platform: "win32" })).reason, "busy")
  } finally { await b.release() }
})

for (const [detail, shouldSwitch] of [
  ["code 429: retry later", false],
  ["code 4299: unrelated number", false],
  ["upstream says quota_exhausted at end", true],
  ["prefix [QuOtA_ExHaUsTeD] suffix", true],
  ["MODEL_CAPACITY_EXHAUSTED with QUOTA_EXHAUSTED", false],
]) {
  test(`QA switching: classify ${detail}`, async t => {
    const events = watchEvents(t)
    await withKit(async kit => {
      const seeded = await setupSwitch(kit)
      kit.defaultPrompt = async agent => {
        const args = kit.acpSpawns.at(-1).args
        fs.appendFileSync(args[args.indexOf("--log-file") + 1], `E1106 qa.go:1] agent executor error: generating and executing: ${detail}\n`)
        await agent.text("\n⚠ Agent execution terminated due to error.\n")
      }
      const response = await kit.request(baseBody({ stream: false, tools: [] }))
      assert.equal(response.status, detail.includes("4299") ? 502 : 429)
      await response.text()
      await waitFor(() => events.some(row => row.action === "account_switch") || kit.timers.refed().length === 0,
        "quota response did not settle")
      if (shouldSwitch) await waitFor(() => current(seeded) === secondEmail, "account quota did not switch")
      else {
        await tick(); await tick()
        assert.equal(current(seeded), firstEmail)
        assert.equal(fs.existsSync(path.join(seeded.vaultDir, "cooldown.json")), false)
      }
      assert.equal(kit.promptSerial, 1, "failed request is never automatically replayed")
    })
  })
}

test("QA switching: a candidate at cooldown expiry is eligible and configured duplicates do not change order", async () => {
  await withKit(async kit => {
    const seeded = await setupSwitch(kit, { packageOptions: { accounts: [firstEmail, secondEmail, secondEmail, thirdEmail] } })
    writeJson(path.join(seeded.vaultDir, "cooldown.json"), {
      [accountKey(secondEmail)]: { gemini: kit.clock.now() + 1 },
      [accountKey(thirdEmail)]: { gemini: kit.clock.now() + 10_000 },
    })
    await switchNow(kit)
    assert.equal(current(seeded), firstEmail)
    kit.clock.advance(1)
    await switchNow(kit)
    assert.equal(current(seeded), secondEmail)
  })
})

test("QA switching: an old generation trigger cannot rotate the newly active account", async () => {
  await withKit(async kit => {
    const seeded = await setupSwitch(kit)
    await switchNow(kit)
    assert.equal(current(seeded), secondEmail)
    const before = fs.readFileSync(path.join(seeded.vaultDir, "cooldown.json"), "utf8")
    await kit.module.__agyTestScheduleAccountSwitch({ reason: "qa-stale", modelFamily: "gemini-4-argon", generation: 0 })
    assert.equal(current(seeded), secondEmail)
    assert.equal(fs.readFileSync(path.join(seeded.vaultDir, "cooldown.json"), "utf8"), before)
  })
})

test("QA switching: A to B to A resumes the A session while still inside its TTL", async () => {
  await withKit(async kit => {
    const seeded = await setupSwitch(kit, { emails: [firstEmail, secondEmail] })
    const body = baseBody({ tools: [] })
    const first = await readSse(await kit.request(body))
    const originalSession = kit.acpLog.find(row => row.method === "session/prompt").sessionId
    const continued = follow(body, first)
    await switchNow(kit)
    assert.equal(current(seeded), secondEmail)
    await readSse(await kit.request(continued))
    assert.equal(kit.acpLog.filter(row => row.method === "session/new").length, 2)
    writeJson(path.join(seeded.vaultDir, "cooldown.json"), {})
    kit.clock.advance(1_000)
    await switchNow(kit)
    assert.equal(current(seeded), firstEmail)
    await readSse(await kit.request(continued))
    assert.deepEqual(kit.acpLog.filter(row => row.method === "session/resume").map(row => row.params.sessionId), [originalSession])
  })
})

test("QA switching: legacy untagged sessions resume before any switch, and are refused after a recorded switch", async () => {
  let saved
  const body = baseBody({ tools: [] })
  let parsed
  await withKit(async kit => {
    installCli(kit)
    kit.defaultPrompt = async agent => { await agent.text("legacy") }
    parsed = await readSse(await kit.request(body))
    const file = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "sessions.json")
    saved = JSON.parse(fs.readFileSync(file, "utf8"))
    assert.ok(saved.entries.length > 0 && saved.entries.every(row => !row.account))
  })
  for (const switched of [false, true]) await withKit(async kit => {
    installCli(kit)
    kit.defaultPrompt = async agent => { await agent.text("continued legacy") }
    const file = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "sessions.json")
    writeJson(file, { ...saved, ...(switched ? { accountSwitchOccurred: true } : {}) })
    await readSse(await kit.request(follow(body, parsed)))
    assert.equal(kit.acpLog.filter(row => row.method === "session/resume").length, switched ? 0 : 1)
  })
})

test("QA switching: unreadable /proc/version still obeys WSL_DISTRO_NAME and otherwise allows Linux", async t => {
  if (process.platform !== "linux") return t.skip("Linux-specific WSL detection")
  await withKit(async kit => {
    await kit.module.AntigravityBridgePlugin(host({ auto_switch: true }))
    kit.qaReadFile = (file, _args, readDefault) => {
      if (file === "/proc/version") throw Object.assign(new Error("fixture EACCES"), { code: "EACCES" })
      return readDefault()
    }
    kit.env.WSL_DISTRO_NAME = "QA-WSL"
    assert.equal(kit.module.autoSwitchEnabled(), false)
    delete kit.env.WSL_DISTRO_NAME
    assert.equal(kit.module.autoSwitchEnabled(), true)
  })
})

for (const [email, expected] of [
  ["first.middle.last+tag@sub.department.example.test", "f***@s***.test"],
  ["student.name@research.university.education", "s***@r***.education"],
]) {
  test(`QA usage mask: multi-part address ${email} never reaches display intact`, () => {
    assert.equal(maskEmail(email), expected)
    const report = parseUsageReport(quotaReport())
    const before = structuredClone(report)
    const masked = maskedAccountReport(report, email)
    assert.equal(masked.windows[0].name, `${expected} · Gemini · 5 hours`)
    assert.ok(!JSON.stringify(masked).includes(email))
    assert.deepEqual(report, before)
    masked.windows[0].used = 99
    assert.equal(report.windows[0].used, 40)
  })
}

test("QA usage mask: on then off restores the actual unmasked CLI report byte for byte", async () => {
  await withKit(async kit => {
    await setupSwitch(kit)
    const masked = await kit.plugin.auth.usage()
    assert.deepEqual(masked.windows.map(row => row.name), [
      "a***@e***.test · Gemini · 5 hours", "a***@e***.test · Claude & GPT · 7 days",
    ])
    const off = await kit.module.AntigravityBridgePlugin(host({ auto_switch: false }))
    const actual = await off.auth.usage()
    assert.equal(JSON.stringify(actual), JSON.stringify({ ...parseUsageReport(quotaReport()), signIn: "kept" }))
    assert.deepEqual(actual.windows.map(row => row.name), ["Gemini · 5 hours", "Claude & GPT · 7 days"])
    assert.ok(!JSON.stringify(actual).includes("@"))
  })
})

// Minimal isolated loader for usage generation and missing-tool tests. Real
// implementation modules stay intact; spawn and home are injected boundaries.
async function loadBoundaryModule(name, home, overrides) {
  const file = fileURLToPath(new URL(name, import.meta.url))
  const cache = new Map()
  const root = new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file })
  await root.link(async specifier => {
    if (cache.has(specifier)) return cache.get(specifier)
    if (specifier.startsWith("./")) {
      const real = await import(new URL(specifier, import.meta.url))
      const module = new vm.SyntheticModule(Object.keys(real), function () {
        for (const [key, value] of Object.entries(real)) this.setExport(key, value)
      })
      cache.set(specifier, module)
      return module
    }
    const real = require(specifier)
    const value = { ...real, ...(specifier === "node:os" ? { homedir: () => home } : {}), ...overrides[specifier] }
    const names = [...new Set([...Object.keys(value), "default"])].filter(key => /^[\w$]+$/.test(key))
    const module = new vm.SyntheticModule(names, function () {
      for (const key of names) this.setExport(key, key === "default" ? value : value[key])
    })
    cache.set(specifier, module)
    return module
  })
  await root.evaluate()
  return root.namespace
}

test("QA locks: missing tools are distinguishable from an occupied POSIX lock", async t => {
  const home = tempHome(t)
  for (const mode of ["missing", "busy"]) {
    const commands = []
    const module = await loadBoundaryModule("./accounts.mjs", home, { "node:child_process": { spawn(command) {
      commands.push(command)
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      setImmediate(() => mode === "missing"
        ? child.emit("error", Object.assign(new Error("missing fixture tool"), { code: "ENOENT" }))
        : child.emit("close", 1))
      return child
    } } })
    const result = await module.acquireSwitchLock({ home, platform: "linux" })
    assert.equal(result.ok, false)
    if (mode === "busy") { assert.equal(result.reason, "busy"); assert.deepEqual(commands, ["flock"]) }
    else { assert.match(result.reason, /flock\/perl missing/); assert.deepEqual(commands, ["flock", "perl"]) }
  }
})

test("QA usage generation: generation change alone discards an in-flight result and joins the new query", async t => {
  const home = tempHome(t)
  const requests = []
  let generation = 0
  let gateVisits = 0
  const module = await loadBoundaryModule("./usage.mjs", home, { "node:child_process": { spawn(_file, args) {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdout.destroy = child.stderr.destroy = () => {}
    child.exitCode = null
    child.kill = () => true
    const complete = report => {
      child.stdout.emit("data", Buffer.from(typeof report === "string" ? report : JSON.stringify(report)))
      child.exitCode = 0
      child.emit("close", 0)
    }
    if (args.includes("--version")) setImmediate(() => complete("1.3.5"))
    else requests.push({ complete })
    return child
  } } })
  const read = module.createUsageReader(() => "/synthetic/agy", { tempRoot: home, env: { HOME: home },
    getGeneration: () => generation, waitForGate: async () => { gateVisits++ } })
  const old = read()
  await waitFor(() => requests.length === 1, "first usage did not start")
  generation++
  const fresh = read()
  await waitFor(() => requests.length === 2, "new-generation usage did not start")
  requests[0].complete(quotaReport(0.1))
  await waitFor(() => gateVisits === 3, "old waiter did not join the new generation")
  await tick()
  requests[1].complete(quotaReport(0.8))
  const results = await Promise.all([old, fresh])
  assert.deepEqual(results.map(row => row.windows[0].used), [20, 20])
  assert.equal(requests.length, 2, "retry joins the already running new-generation query")
  results[0].windows[0].used = 100
  assert.equal(results[1].windows[0].used, 20)
  assert.deepEqual(fs.readdirSync(home), [])
})
