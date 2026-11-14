// Regression tests for isolated ACP `--app-data-dir` (preventing Magpie
// gateway + local Antigravity CLI session double counting), OAuth token file
// synchronization, and one-time legacy bridge session migration.

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { baseBody, createBridgeKit, readSse, seedAccountHome } from "./testkit.mjs"
import { tokenFileOf, writeActiveAccount } from "./accounts.mjs"

const require = createRequire(import.meta.url)

function openSqlite(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (typeof globalThis.Bun !== "undefined") {
    const { Database } = require("bun:sqlite")
    const db = new Database(file)
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, ...params) => db.prepare(sql).run(...params),
      close: () => db.close(false),
    }
  }
  const { DatabaseSync } = process.getBuiltinModule?.("node:sqlite") ?? require("node:sqlite")
  const db = new DatabaseSync(file)
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    close: () => db.close(),
  }
}

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

test("Proc.start passes --app-data-dir magpie-agy-bridge, syncs OAuth token file, and keeps antigravity-cli clean", async () => {
  await withKit({}, async (kit) => {
    seedAccountHome(kit.home, { emails: ["alpha@example.test", "beta@example.test"] })
    kit.defaultPrompt = async (agent) => {
      await agent.text("isolated ok")
      return { stopReason: "end_turn" }
    }

    const res = await readSse(await kit.request(baseBody({ metadata: { user_id: "iso-default" } })))
    assert.equal(res.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)

    const spawnArgs = kit.acpSpawns[0].args
    const flagIdx = spawnArgs.indexOf("--app-data-dir")
    assert.ok(flagIdx >= 0, `expected --app-data-dir in args: ${JSON.stringify(spawnArgs)}`)
    assert.equal(spawnArgs[flagIdx + 1], "magpie-agy-bridge")

    const bridgeTokenFile = path.join(kit.home, ".gemini", "magpie-agy-bridge", "antigravity-oauth-token")
    assert.equal(fs.existsSync(bridgeTokenFile), true, "bridge token file must be synced before spawn")
    const synced = JSON.parse(fs.readFileSync(bridgeTokenFile, "utf8"))
    assert.equal(synced.id_token_email, "alpha@example.test")

    const legacyBrain = path.join(kit.home, ".gemini", "antigravity-cli", "brain")
    assert.equal(fs.existsSync(legacyBrain), false, "bridge session must not create antigravity-cli/brain")
  })
})

test("syncBridgeTokenFile preserves same-account refreshes, mirrors account switches, and cleans up on sign-out", async () => {
  await withKit({}, async (kit) => {
    const seeded = seedAccountHome(kit.home, { emails: ["alpha@example.test", "beta@example.test"] })
    const sync = kit.module.__agyTestSyncBridgeTokenFile
    const mainTokenFile = tokenFileOf(kit.home)
    const bridgeTokenFile = path.join(kit.home, ".gemini", "magpie-agy-bridge", "antigravity-oauth-token")

    sync("magpie-agy-bridge", kit.home)
    assert.equal(JSON.parse(fs.readFileSync(bridgeTokenFile, "utf8")).id_token_email, "alpha@example.test")

    // Simulate agy acp refreshing access_token inside the isolated app-data-dir for the same account.
    const refreshedPayload = {
      auth_method: "oauth",
      id_token_email: "alpha@example.test",
      token: { access_token: "refreshed-access", refresh_token: "synthetic-fixture-0-rotated" },
    }
    fs.writeFileSync(bridgeTokenFile, JSON.stringify(refreshedPayload))
    const future = new Date(Date.now() + 10_000)
    fs.utimesSync(bridgeTokenFile, future, future)

    sync("magpie-agy-bridge", kit.home)
    const mainAfterRefresh = JSON.parse(fs.readFileSync(mainTokenFile, "utf8"))
    assert.equal(mainAfterRefresh.token.access_token, "refreshed-access", "same-account refresh must sync back to main token file")

    // Switch active account to beta@example.test: main token email changes and must win over bridge's newer timestamp.
    const switched = writeActiveAccount({ home: kit.home, email: "beta@example.test", vaultDir: seeded.vaultDir })
    assert.equal(switched.ok, true)
    sync("magpie-agy-bridge", kit.home)
    const bridgeAfterSwitch = JSON.parse(fs.readFileSync(bridgeTokenFile, "utf8"))
    assert.equal(bridgeAfterSwitch.id_token_email, "beta@example.test", "account switch must update bridge token file")

    // Removing main token file (OS keyring-only or sign-out) removes stale bridge token copy.
    fs.unlinkSync(mainTokenFile)
    sync("magpie-agy-bridge", kit.home)
    assert.equal(fs.existsSync(bridgeTokenFile), false, "removing main token file must remove stale bridge copy")
  })
})

test("AGY_BRIDGE_APP_DATA_DIR validates safe relative names, supports opt-out, and swaps pooled procs on change", async () => {
  await withKit({}, async (kit) => {
    const resolveDir = kit.module.__agyTestBridgeAppDataDirName
    assert.equal(resolveDir({}), "magpie-agy-bridge")
    assert.equal(resolveDir({ AGY_BRIDGE_APP_DATA_DIR: "0" }), "")
    assert.equal(resolveDir({ AGY_BRIDGE_APP_DATA_DIR: "off" }), "")
    assert.equal(resolveDir({ AGY_BRIDGE_APP_DATA_DIR: "antigravity-cli" }), "")
    assert.equal(resolveDir({ AGY_BRIDGE_APP_DATA_DIR: "/abs/not-allowed" }), "magpie-agy-bridge")
    assert.equal(resolveDir({ AGY_BRIDGE_APP_DATA_DIR: "C:\\abs\\win" }), "magpie-agy-bridge")
    assert.equal(resolveDir({ AGY_BRIDGE_APP_DATA_DIR: "../escape" }), "magpie-agy-bridge")
    assert.equal(resolveDir({ AGY_BRIDGE_APP_DATA_DIR: "custom-bridge" }), "custom-bridge")

    kit.defaultPrompt = async (agent) => {
      await agent.text(`reply-${agent.index}`)
      return { stopReason: "end_turn" }
    }

    const body1 = baseBody({ metadata: { user_id: "swap-dir" }, messages: [{ role: "user", content: "hi" }] })
    const r1 = await readSse(await kit.request(body1))
    assert.equal(r1.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
    assert.ok(kit.acpSpawns[0].args.includes("--app-data-dir"))

    kit.env.AGY_BRIDGE_APP_DATA_DIR = "0"
    const body2 = {
      ...body1,
      messages: [
        ...body1.messages,
        { role: "assistant", content: [{ type: "text", text: "reply-1" }] },
        { role: "user", content: "next" },
      ],
    }
    const r2 = await readSse(await kit.request(body2))
    assert.equal(r2.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2, "changing AGY_BRIDGE_APP_DATA_DIR must swap incompatible pooled process")
    assert.equal(kit.acpSpawns[1].args.includes("--app-data-dir"), false, "opt-out must omit --app-data-dir")
  })
})

test("migrateLegacyBridgeSessions moves legacy bridge sessions out of antigravity-cli while leaving real CLI sessions intact", async () => {
  await withKit({}, async (kit) => {
    const legacyRoot = path.join(kit.home, ".gemini", "antigravity-cli")
    const targetRoot = path.join(kit.home, ".gemini", "magpie-agy-bridge")
    const oldTime = new Date(Date.now() - 60_000)

    const createSessionDb = (sid, blobText, mtime = oldTime) => {
      const dbPath = path.join(legacyRoot, "conversations", `${sid}.db`)
      const db = openSqlite(dbPath)
      db.exec("CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)")
      db.run("INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)", "main", Buffer.from(blobText, "utf8"))
      db.close()
      fs.utimesSync(dbPath, mtime, mtime)
      const transcript = path.join(legacyRoot, "brain", sid, ".system_generated", "logs", "transcript_full.jsonl")
      fs.mkdirSync(path.dirname(transcript), { recursive: true })
      fs.writeFileSync(transcript, '{"type":"PLANNER_RESPONSE","output_tokens":42}\n')
      fs.utimesSync(transcript, mtime, mtime)
      const ann = path.join(legacyRoot, "annotations", `${sid}.pb`)
      fs.mkdirSync(path.dirname(ann), { recursive: true })
      fs.writeFileSync(ann, "ann")
    }

    createSessionDb("bridge-old-1", "\n(file:///tmp/magpie-agy-bridge-abc123\x12\rmagpie-bridgeB\"Bridges only client-declared tools")
    createSessionDb("real-cli-1", "\n(file:///Users/dev/my-project\x12\x1bfile:///Users/dev/my-project")
    createSessionDb("bridge-fresh-1", "\n(file:///tmp/magpie-agy-bridge-fresh1", new Date())

    // Orphan bridge brain directory without a .db file
    const orphanTranscript = path.join(legacyRoot, "brain", "bridge-orphan-1", ".system_generated", "logs", "transcript.jsonl")
    fs.mkdirSync(path.dirname(orphanTranscript), { recursive: true })
    fs.writeFileSync(orphanTranscript, '{"type":"USER_INPUT","content":"<USER_REQUEST>\\n<conversation_history>\\nHuman: hi"}\n')
    fs.utimesSync(orphanTranscript, oldTime, oldTime)

    const migrate = kit.module.__agyTestMigrateLegacyBridgeSessions
    const firstRun = await migrate({ appDataDir: "magpie-agy-bridge", home: kit.home, minAgeMs: 5_000 })
    assert.equal(firstRun.migrated, 2, "old bridge db + orphan bridge brain must migrate")
    assert.equal(firstRun.deferred, 1, "freshly modified bridge db must be deferred")
    assert.equal(fs.existsSync(path.join(targetRoot, ".migrated-legacy-v1")), false, "sentinel waits while deferred > 0")

    // Migrated bridge session moved completely out of antigravity-cli into magpie-agy-bridge
    assert.equal(fs.existsSync(path.join(legacyRoot, "brain", "bridge-old-1")), false)
    assert.equal(fs.existsSync(path.join(legacyRoot, "conversations", "bridge-old-1.db")), false)
    assert.equal(fs.existsSync(path.join(targetRoot, "brain", "bridge-old-1", ".system_generated", "logs", "transcript_full.jsonl")), true)
    assert.equal(fs.existsSync(path.join(targetRoot, "conversations", "bridge-old-1.db")), true)
    assert.equal(fs.existsSync(path.join(targetRoot, "annotations", "bridge-old-1.pb")), true)
    assert.equal(fs.existsSync(path.join(targetRoot, "brain", "bridge-orphan-1")), true)

    // Real standalone CLI session stayed untouched in antigravity-cli
    assert.equal(fs.existsSync(path.join(legacyRoot, "brain", "real-cli-1")), true)
    assert.equal(fs.existsSync(path.join(legacyRoot, "conversations", "real-cli-1.db")), true)
    assert.equal(fs.existsSync(path.join(targetRoot, "brain", "real-cli-1")), false)

    // Second run with minAgeMs=0 finishes the deferred session and writes sentinel
    const secondRun = await migrate({ appDataDir: "magpie-agy-bridge", home: kit.home, minAgeMs: 0 })
    assert.equal(secondRun.migrated, 1)
    assert.equal(secondRun.deferred, 0)
    assert.equal(fs.existsSync(path.join(targetRoot, ".migrated-legacy-v1")), true)
    assert.equal(fs.existsSync(path.join(targetRoot, "brain", "bridge-fresh-1")), true)
    assert.equal(fs.existsSync(path.join(legacyRoot, "brain", "real-cli-1")), true)
  })
})
