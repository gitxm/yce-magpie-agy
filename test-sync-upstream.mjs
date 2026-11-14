// scripts/sync-upstream.mjs 的回归：本地造一个上游 git 仓，覆盖
// 检查、无冲突合并、provider ID 归一化、冲突报告与状态推进。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { syncUpstream } from "./scripts/sync-upstream.mjs"

function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr || res.stdout}`)
  return res.stdout
}

function writeUpstreamRepo(root, files) {
  const repo = path.join(root, "upstream")
  fs.mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "fixture@example.test")
  git(repo, "config", "user.name", "fixture")
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(repo, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "upstream base")
  const base = git(repo, "rev-parse", "HEAD").trim()
  return { repo, base }
}

function commitAll(repo, message) {
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", message)
  return git(repo, "rev-parse", "HEAD").trim()
}

function fixture({ localIndex = "const PROVIDER_ID = \"yce-magpie-agy\"\nexport const a = 1\n", upstreamV2 = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yce-sync-test-"))
  const pkgDir = path.join(root, "pkg")
  fs.mkdirSync(pkgDir)
  fs.writeFileSync(path.join(pkgDir, "index.mjs"), localIndex)
  const { repo, base } = writeUpstreamRepo(root, {
    "packages/agy-cli/index.mjs": "const PROVIDER_ID = \"agy-cli\"\nexport const a = 1\n",
    "packages/agy-cli/package.json": JSON.stringify({ name: "@magpie-community/opencode-agy-cli-auth", version: "0.1.3" }, null, 2) + "\n",
    "packages/agy-cli/test/smoke.mjs": "// upstream test\n",
  })
  fs.writeFileSync(path.join(pkgDir, ".upstream-sync.json"), JSON.stringify({
    upstreamRepo: repo,
    upstreamBranch: "main",
    upstreamPath: "packages/agy-cli",
    syncedCommit: base,
    syncedVersion: "0.1.3",
  }, null, 2) + "\n")
  if (upstreamV2 !== null) {
    fs.writeFileSync(path.join(repo, "packages/agy-cli/index.mjs"), upstreamV2)
    fs.writeFileSync(path.join(repo, "packages/agy-cli/package.json"), JSON.stringify({ name: "@magpie-community/opencode-agy-cli-auth", version: "0.1.39" }, null, 2) + "\n")
    commitAll(repo, "agy-cli 0.1.39: fixture change")
  }
  return { root, repo, pkgDir }
}

test("check reports the new upstream version and pending files without touching the tree", () => {
  const { pkgDir, root } = fixture({ upstreamV2: "const PROVIDER_ID = \"agy-cli\"\nexport const a = 2\n" })
  try {
    const local = fs.readFileSync(path.join(pkgDir, "index.mjs"), "utf8")
    const report = syncUpstream({ cwd: pkgDir, apply: false })
    assert.equal(report.upToDate, false)
    assert.equal(report.latestVersion, "0.1.39")
    assert.deepEqual(report.pendingFiles, ["index.mjs"])
    assert.equal(report.upstreamCommits.length, 1)
    assert.equal(fs.readFileSync(path.join(pkgDir, "index.mjs"), "utf8"), local, "check must not write")
    const state = JSON.parse(fs.readFileSync(path.join(pkgDir, ".upstream-sync.json"), "utf8"))
    assert.equal(state.syncedVersion, "0.1.3", "check must not advance the state file")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("apply merges a non-conflicting upstream change and rewrites the provider ID", () => {
  const { pkgDir, root } = fixture({ upstreamV2: "const PROVIDER_ID = \"agy-cli\"\nexport const a = 2\n" })
  try {
    const report = syncUpstream({ cwd: pkgDir, apply: true })
    assert.equal(report.applied, true)
    assert.deepEqual(report.conflictFiles, [])
    const merged = fs.readFileSync(path.join(pkgDir, "index.mjs"), "utf8")
    assert.match(merged, /"yce-magpie-agy"/, "provider ID must stay yce-magpie-agy")
    assert.ok(!merged.includes("\"agy-cli\""), "upstream provider ID must be normalized")
    assert.match(merged, /export const a = 2/, "upstream change must be merged")
    const state = JSON.parse(fs.readFileSync(path.join(pkgDir, ".upstream-sync.json"), "utf8"))
    assert.equal(state.syncedVersion, "0.1.39")
    assert.equal(state.syncedCommit, report.latestCommit)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a conflicting change is written with markers, reported, and the state still advances", () => {
  const { pkgDir, root } = fixture({
    localIndex: "const PROVIDER_ID = \"yce-magpie-agy\"\nlocalOnly()\n",
    upstreamV2: "const PROVIDER_ID = \"agy-cli\"\nupstreamOnly()\n",
  })
  try {
    const report = syncUpstream({ cwd: pkgDir, apply: true })
    assert.equal(report.applied, true)
    assert.deepEqual(report.conflictFiles, ["index.mjs"])
    const merged = fs.readFileSync(path.join(pkgDir, "index.mjs"), "utf8")
    assert.match(merged, /<<<<<<< /)
    assert.match(merged, /localOnly\(\)/)
    assert.match(merged, /upstreamOnly\(\)/)
    assert.match(merged, />>>>>>> /)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("an up-to-date checkout is a no-op", () => {
  const { pkgDir, root } = fixture()
  try {
    const report = syncUpstream({ cwd: pkgDir, apply: true })
    assert.equal(report.upToDate, true)
    assert.equal(report.applied, false)
    assert.deepEqual(report.mergedFiles, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a missing upstream file listed in the state fails loudly instead of guessing", () => {
  const { pkgDir, root } = fixture()
  try {
    const stateFile = path.join(pkgDir, ".upstream-sync.json")
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"))
    state.syncedCommit = "0".repeat(40)
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n")
    assert.throws(() => syncUpstream({ cwd: pkgDir, apply: false }), /not found in upstream repository/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
