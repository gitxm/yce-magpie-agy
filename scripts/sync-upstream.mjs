#!/usr/bin/env node
// Synchronizes upstream changes from magpie-community/plugins (packages/agy-cli)
// into @magpie-community/yce-magpie-agy via 3-way git merge-file while preserving
// yce-magpie-agy's provider identity, multi-account switching, localization, and
// usage calibration extensions.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_SKIP_FILES = new Set([
  "package.json",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "README.en.md",
  "HANDOFF.md",
  "accounts.mjs",
])

export function parseArgs(argv) {
  const opts = {
    apply: false,
    check: true,
    json: false,
    cwd: process.cwd(),
    repo: "",
    branch: "",
    stateFile: "",
    only: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--apply") {
      opts.apply = true
      opts.check = false
    } else if (arg === "--check") {
      opts.check = true
      opts.apply = false
    } else if (arg === "--json") {
      opts.json = true
    } else if (arg === "--cwd" && argv[i + 1]) {
      opts.cwd = path.resolve(argv[++i])
    } else if (arg === "--repo" && argv[i + 1]) {
      opts.repo = argv[++i]
    } else if (arg === "--branch" && argv[i + 1]) {
      opts.branch = argv[++i]
    } else if (arg === "--state" && argv[i + 1]) {
      opts.stateFile = path.resolve(argv[++i])
    } else if (arg === "--only" && argv[i + 1]) {
      opts.only = new Set(argv[++i].split(",").map((s) => s.trim()).filter(Boolean))
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return opts
}

export function normalizeUpstreamContent(_relPath, content) {
  return String(content)
    .replaceAll("@magpie-community/opencode-agy-cli-auth", "@magpie-community/yce-magpie-agy")
    .replace(/const PROVIDER_ID\s*=\s*["']agy-cli["']/g, 'const PROVIDER_ID = "yce-magpie-agy"')
    .replace(/\bproviderID:\s*["']agy-cli["']/g, 'providerID: "yce-magpie-agy"')
    .replaceAll('"agy-cli/', '"yce-magpie-agy/')
    .replaceAll("'agy-cli/", "'yce-magpie-agy/")
}

function runGit(args, { cwd, allowNonZero = false } = {}) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  if (res.error) throw res.error
  if (!allowNonZero && res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${res.status}): ${(res.stderr || res.stdout || "").trim()}`)
  }
  return res
}

function resolveGitRef(gitDir, branch) {
  const candidates = [
    `refs/remotes/origin/${branch}`,
    `refs/heads/${branch}`,
    branch,
    "HEAD",
  ]
  for (const candidate of candidates) {
    const res = runGit(["-C", gitDir, "rev-parse", "--verify", `${candidate}^{commit}`], { allowNonZero: true })
    if (res.status === 0) return res.stdout.trim()
  }
  throw new Error(`Unable to resolve branch "${branch}" in ${gitDir}`)
}

function prepareUpstreamGitDir(repo, branch, sparsePaths, tempDirs) {
  if (fs.existsSync(repo)) {
    return path.resolve(repo)
  }
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "yce-agy-upstream-"))
  tempDirs.push(cloneDir)
  runGit([
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    "--sparse",
    "--branch",
    branch,
    repo,
    cloneDir,
  ])
  runGit(["-C", cloneDir, "sparse-checkout", "set", "--no-cone", ...sparsePaths])
  return cloneDir
}

function gitShowOptional(gitDir, spec) {
  const res = runGit(["-C", gitDir, "show", spec], { allowNonZero: true })
  return res.status === 0 ? res.stdout : null
}

function addFilesToPackageJson(cwd, addedFiles) {
  if (!addedFiles.length) return
  const pkgPath = path.join(cwd, "package.json")
  if (!fs.existsSync(pkgPath)) return
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  if (!Array.isArray(pkg.files)) return
  let changed = false
  for (const rel of addedFiles) {
    if (!pkg.files.includes(rel)) {
      pkg.files.push(rel)
      changed = true
    }
  }
  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8")
  }
}

export function syncUpstream(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd())
  const stateFile = path.resolve(options.stateFile || path.join(cwd, ".upstream-sync.json"))
  if (!fs.existsSync(stateFile)) {
    throw new Error(`Missing upstream state file: ${stateFile}`)
  }
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"))
  const repo = options.repo || state.upstreamRepo
  const branch = options.branch || state.upstreamBranch || "main"
  const upstreamPath = (state.upstreamPath || "packages/agy-cli").replace(/^\/+|\/+$/g, "")
  const cloakPath = (state.cloakPath || "").replace(/^\/+|\/+$/g, "")
  const syncedCommit = String(state.syncedCommit || "").trim()
  if (!repo || !syncedCommit) {
    throw new Error("Invalid .upstream-sync.json: upstreamRepo and syncedCommit are required")
  }

  const tempDirs = []
  try {
    const sparsePaths = [upstreamPath, ...(cloakPath ? [cloakPath] : [])]
    const gitDir = prepareUpstreamGitDir(repo, branch, sparsePaths, tempDirs)
    const tipRef = resolveGitRef(gitDir, branch)

    const latestRes = runGit(["-C", gitDir, "rev-list", "-1", tipRef, "--", upstreamPath])
    const latestCommit = latestRes.stdout.trim()
    if (!latestCommit) {
      throw new Error(`No commits found touching ${upstreamPath} on ${branch}`)
    }

    const upstreamPkgRaw = gitShowOptional(gitDir, `${latestCommit}:${upstreamPath}/package.json`)
    const latestVersion = upstreamPkgRaw ? (JSON.parse(upstreamPkgRaw).version || "") : ""

    const baseVerify = runGit(["-C", gitDir, "cat-file", "-e", `${syncedCommit}^{commit}`], { allowNonZero: true })
    if (baseVerify.status !== 0) {
      throw new Error(`Base syncedCommit ${syncedCommit} not found in upstream repository ${repo}`)
    }

    if (latestCommit === syncedCommit) {
      return {
        upToDate: true,
        applied: false,
        syncedCommit,
        latestCommit,
        syncedVersion: state.syncedVersion || "",
        latestVersion,
        mergedFiles: [],
        addedFiles: [],
        conflictFiles: [],
        upstreamCommits: [],
        upstreamTestChanges: [],
        cloakChanged: false,
      }
    }

    const logRes = runGit(["-C", gitDir, "log", "--oneline", `${syncedCommit}..${latestCommit}`, "--", upstreamPath])
    const upstreamCommits = logRes.stdout.split("\n").map((line) => line.trim()).filter(Boolean)

    const diffNamesRes = runGit(["-C", gitDir, "diff", "--name-only", syncedCommit, latestCommit, "--", upstreamPath])
    const changedPaths = diffNamesRes.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    const prefix = `${upstreamPath}/`
    const changedRel = changedPaths
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))

    const upstreamTestChanges = changedRel.filter((rel) => rel.startsWith("test/") || rel.endsWith(".test.mjs"))

    let cloakChanged = false
    if (cloakPath) {
      const cloakDiff = runGit(["-C", gitDir, "diff", "--name-only", syncedCommit, latestCommit, "--", cloakPath], { allowNonZero: true })
      cloakChanged = Boolean(cloakDiff.stdout.trim())
    }

    if (!options.apply) {
      return {
        upToDate: false,
        applied: false,
        syncedCommit,
        latestCommit,
        syncedVersion: state.syncedVersion || "",
        latestVersion,
        pendingFiles: changedRel.filter((rel) => rel.endsWith(".mjs") && !rel.includes("/") && !rel.endsWith(".test.mjs") && !DEFAULT_SKIP_FILES.has(rel)),
        mergedFiles: [],
        addedFiles: [],
        conflictFiles: [],
        upstreamCommits,
        upstreamTestChanges,
        cloakChanged,
      }
    }

    const treeRes = runGit(["-C", gitDir, "ls-tree", "-r", "--name-only", latestCommit, "--", upstreamPath])
    const upstreamFiles = treeRes.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))

    const mergeScratch = fs.mkdtempSync(path.join(os.tmpdir(), "yce-agy-merge-"))
    tempDirs.push(mergeScratch)

    const mergedFiles = []
    const addedFiles = []
    const conflictFiles = []

    for (const rel of upstreamFiles) {
      if (rel.includes("/") || !rel.endsWith(".mjs") || rel.endsWith(".test.mjs")) continue
      if (DEFAULT_SKIP_FILES.has(rel)) continue
      if (options.only && !options.only.has(rel)) continue

      const rawTheirs = gitShowOptional(gitDir, `${latestCommit}:${upstreamPath}/${rel}`)
      if (rawTheirs === null) continue
      const theirsText = normalizeUpstreamContent(rel, rawTheirs)

      const rawBase = gitShowOptional(gitDir, `${syncedCommit}:${upstreamPath}/${rel}`)
      const baseText = rawBase !== null ? normalizeUpstreamContent(rel, rawBase) : ""

      const localFile = path.join(cwd, rel)
      if (!fs.existsSync(localFile)) {
        fs.writeFileSync(localFile, theirsText, "utf8")
        addedFiles.push(rel)
        continue
      }

      if (rawBase !== null && baseText === theirsText) continue
      const oursText = fs.readFileSync(localFile, "utf8")
      if (oursText === theirsText) continue

      const oursTmp = path.join(mergeScratch, `${rel}.ours`)
      const baseTmp = path.join(mergeScratch, `${rel}.base`)
      const theirsTmp = path.join(mergeScratch, `${rel}.theirs`)
      fs.writeFileSync(oursTmp, oursText, "utf8")
      fs.writeFileSync(baseTmp, baseText, "utf8")
      fs.writeFileSync(theirsTmp, theirsText, "utf8")

      const mergeRes = runGit(
        ["merge-file", "-L", `ours/${rel}`, "-L", `base/${rel}`, "-L", `upstream/${rel}`, oursTmp, baseTmp, theirsTmp],
        { allowNonZero: true },
      )
      if (mergeRes.status < 0 || mergeRes.status >= 128) {
        throw new Error(`git merge-file failed for ${rel} (exit ${mergeRes.status}): ${(mergeRes.stderr || "").trim()}`)
      }
      const mergedContent = fs.readFileSync(oursTmp, "utf8")
      fs.writeFileSync(localFile, mergedContent, "utf8")
      if (mergeRes.status === 0) {
        mergedFiles.push(rel)
      } else {
        conflictFiles.push(rel)
      }
    }

    addFilesToPackageJson(cwd, addedFiles)

    const nextState = {
      ...state,
      syncedCommit: latestCommit,
      syncedVersion: latestVersion || state.syncedVersion,
    }
    fs.writeFileSync(stateFile, JSON.stringify(nextState, null, 2) + "\n", "utf8")

    return {
      upToDate: false,
      applied: true,
      syncedCommit,
      latestCommit,
      syncedVersion: state.syncedVersion || "",
      latestVersion,
      mergedFiles,
      addedFiles,
      conflictFiles,
      upstreamCommits,
      upstreamTestChanges,
      cloakChanged,
    }
  } finally {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(
      "Usage: node scripts/sync-upstream.mjs [--check | --apply] [--only <files>] [--repo <url|dir>] [--branch <name>] [--json]\n",
    )
    return
  }
  const result = syncUpstream({
    apply: opts.apply,
    cwd: opts.cwd,
    repo: opts.repo,
    branch: opts.branch,
    stateFile: opts.stateFile,
    only: opts.only,
  })
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  } else if (result.upToDate) {
    process.stdout.write(`Up to date with upstream ${result.latestVersion || ""} (${result.latestCommit.slice(0, 10)}).\n`)
  } else if (!result.applied) {
    process.stdout.write(
      `Upstream update available: ${result.syncedVersion} (${result.syncedCommit.slice(0, 7)}) -> ${result.latestVersion} (${result.latestCommit.slice(0, 7)}), ${result.upstreamCommits.length} commits.\n`,
    )
  } else {
    process.stdout.write(
      `Synced upstream ${result.latestVersion} (${result.latestCommit.slice(0, 10)}): merged=${result.mergedFiles.length}, added=${result.addedFiles.length}, conflicts=${result.conflictFiles.length}.\n`,
    )
    if (result.conflictFiles.length) {
      process.stderr.write(`Conflicts requiring resolution: ${result.conflictFiles.join(", ")}\n`)
    }
  }
  if (result.applied && result.conflictFiles.length > 0) {
    process.exitCode = 2
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`sync-upstream error: ${error?.message || error}\n`)
    process.exitCode = 1
  }
}
