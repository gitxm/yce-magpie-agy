// Plugin Options（Magpie「插件→已安装→Options」JSON 编辑器，入口第二参数）的
// 校验与生效回归：非法值初始化抛错含键名、未知键忽略记事件、空串/null 视为未设、
// 优先级 packageOptions > 环境变量 > 默认，以及 agyPath / maxProcs 两个可观测落点；
// 以及 Providers 页三个布尔开关（auth.options + hostOption）的声明约束与即时生效。
// 运行：node --experimental-vm-modules --test test-options.mjs
// 全部经 testkit.mjs 加载真实 index.mjs 与进程内假 agy，不调用真实 agy。

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

// 把 Options JSON 应用进当前 kit 的模块实例（入口第二参数）。
function applyOptions(kit, options) {
  return kit.module.AntigravityBridgePlugin(undefined, options)
}

function promptText(params) {
  return (params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
}

// "TOOL" 请求一个 Read 并等 MCP 回包；其余请求直接回纯文本。
function scriptedAgent(kit) {
  kit.defaultPrompt = async (agent) => {
    const text = promptText({ prompt: agent.prompt })
    const current = text.includes("<current_turn>") ? text.slice(text.lastIndexOf("<current_turn>")) : text
    if (current.includes("TOOL")) {
      await agent.tool("Read", { path: `/repo/${agent.index}.txt` })
      await agent.text("after tool")
      return { stopReason: "end_turn" }
    }
    await agent.text(`answer ${agent.index}`)
    return { stopReason: "end_turn" }
  }
}

async function pendingToolTurn(kit, body) {
  const parsed = await readSse(await kit.request(body))
  assert.equal(parsed.stopReason, "tool_use")
  return parsed
}

async function errorOf(response) {
  return { status: response.status, body: await response.json() }
}

function captureStderr() {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = function write(chunk, ...rest) {
    const text = String(chunk)
    if (text.startsWith("[agy-bridge] ")) {
      lines.push(JSON.parse(text.slice("[agy-bridge] ".length)))
      return true
    }
    return original.call(this, chunk, ...rest)
  }
  return { lines, restore: () => { process.stderr.write = original } }
}

test("无参调用入口照常工作，空串与 null 视为未设", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    await applyOptions(kit)
    await applyOptions(kit, {})
    await applyOptions(kit, { agyPath: "", maxProcs: null })
    assert.equal(kit.module.__agyTestFindAgy(), kit.agyPath, "未设时仍按环境变量找 agy")
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "no-arg" } })))
    assert.equal(parsed.stopReason, "end_turn")
    assert.ok(kit.acpSpawns.length >= 1)
  })
})

test("非法 Options 值在初始化时抛错并写明键名", async () => {
  await withKit({}, async (kit) => {
    await assert.rejects(applyOptions(kit, { maxProcs: 0 }), /maxProcs/)
    await assert.rejects(applyOptions(kit, { maxProcs: 65 }), /maxProcs/)
    await assert.rejects(applyOptions(kit, { accounts: ["bad"] }), /accounts/)
    await assert.rejects(applyOptions(kit, { accounts: ["first last@example.com"] }), /accounts/)
    await assert.rejects(applyOptions(kit, { idleMs: "x" }), /idleMs/)
    await assert.rejects(applyOptions(kit, { resumeTtlMs: -1 }), /resumeTtlMs/)
    await assert.rejects(applyOptions(kit, { agyPath: 42 }), /agyPath/)
  })
})

test("未知键忽略并记一条 bridge 事件", async () => {
  const stderr = captureStderr()
  try {
    await withKit({}, async (kit) => {
      await applyOptions(kit, { nonsense: 1, agyPath: "" })
      const rows = stderr.lines.filter((row) => row.action === "plugin_options")
      assert.equal(rows.length, 1, "未知键应记且只记一条事件")
      assert.match(rows[0].keys, /nonsense/)
    })
  } finally {
    stderr.restore()
  }
})

test("agyPath 选项压过环境变量，实际 spawn 换成指定可执行文件", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const agyB = kit.makeFakeAgy("agy-b")
    await applyOptions(kit, { agyPath: agyB })
    assert.equal(kit.module.__agyTestFindAgy(), agyB)
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "agy-path" } })))
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.at(-1).file, agyB, "会话进程应 spawn 指定的 agyPath")
  })
})

test("maxProcs 选项压过 AGY_BRIDGE_MAX_PROCS：第 3 个并发会话先 503，脱离时间到后 LRU 回收放行", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_PROCS: "3" } }, async (kit) => {
    scriptedAgent(kit)
    await applyOptions(kit, { maxProcs: 2 })
    const convA = baseBody({ metadata: { user_id: "cap-a" }, messages: [{ role: "user", content: "TOOL a" }] })
    const convB = baseBody({ metadata: { user_id: "cap-b" }, messages: [{ role: "user", content: "TOOL b" }] })
    const convC = baseBody({ metadata: { user_id: "cap-c" }, messages: [{ role: "user", content: "plain c" }] })
    await pendingToolTurn(kit, convA)
    await pendingToolTurn(kit, convB)
    // 环境变量写 3、选项写 2：第 3 个会话立刻 503 说明生效的是 2。
    const busy = await errorOf(await kit.request(convC))
    assert.equal(busy.status, 503)
    assert.match(busy.body.error.message, /2 agy processes are running/)
    // 挂起回合脱离时间（默认 30 秒）到达后，池压走 LRU 回收而不是继续 503。
    kit.clock.advance(31_000)
    const served = await readSse(await kit.request(convC))
    assert.equal(served.stopReason, "end_turn")
  })
})

// ---------------------------------------------------------------- Providers 页开关

// 假宿主输入：switches 里已保存的键由 Providers 页返回，未保存的键返回 undefined。
function fakeHostInput(switches, seen = null) {
  return { magpie: { option: (id, key) => { if (seen) seen.set(key, id); return switches[key] } } }
}

// 每次回复都先发思考摘要再发正文，用于观察 thinking 块转发。
function thinkingAgent(kit) {
  kit.defaultPrompt = async (agent) => {
    await agent.thought(`plan ${agent.index}`)
    await agent.text(`answer ${agent.index}`)
    return { stopReason: "end_turn" }
  }
}

// 把上一轮响应接进下一轮请求（无工具版）：assistant 原样回传，再追加新 user 消息。
function followUp(body, parsed, userText) {
  const assistant = parsed.content.map((block) => block.type === "thinking"
    ? { type: "thinking", thinking: block.thinking, signature: block.signature }
    : { type: "text", text: block.text })
  return { ...body, messages: [...body.messages, { role: "assistant", content: assistant }, { role: "user", content: userText }] }
}

const hasThinking = (parsed) => parsed.content.some((block) => block.type === "thinking")

test("auth.options 声明三个开关且符合 Magpie 约束", async () => {
  await withKit({}, async (kit) => {
    const options = kit.plugin.auth.options
    assert.ok(Array.isArray(options), "auth.options 应为数组")
    assert.equal(options.length, 3)
    assert.deepEqual(options.map((option) => option.key), ["thinking_summary", "minimal_agent", "auto_switch"])
    for (const option of options) {
      assert.match(option.key, /^[a-z0-9_-]{1,40}$/)
      assert.equal(typeof option.label, "string")
      assert.ok(option.label.length > 0 && option.label.length <= 60)
      assert.equal(typeof option.description, "string")
      assert.ok(option.description.length > 0 && option.description.length <= 300)
      assert.equal(typeof option.default, "boolean")
      assert.ok(option.labels && typeof option.labels === "object" && !Array.isArray(option.labels))
      assert.ok(option.descriptions && typeof option.descriptions === "object" && !Array.isArray(option.descriptions))
      for (const lang of ["zh", "zh-TW"]) {
        assert.equal(typeof option.labels[lang], "string")
        assert.ok(option.labels[lang].length > 0 && option.labels[lang].length <= 60)
        assert.equal(typeof option.descriptions[lang], "string")
        assert.ok(option.descriptions[lang].length > 0 && option.descriptions[lang].length <= 300)
      }
      if ("confirm" in option) {
        assert.equal(typeof option.confirm, "string")
        assert.ok(option.confirm.length > 0 && option.confirm.length <= 300)
        assert.ok(option.confirms && typeof option.confirms === "object" && !Array.isArray(option.confirms))
        for (const lang of ["zh", "zh-TW"]) {
          assert.equal(typeof option.confirms[lang], "string")
          assert.ok(option.confirms[lang].length > 0 && option.confirms[lang].length <= 300)
        }
      }
    }
    const auto = options.find((option) => option.key === "auto_switch")
    assert.equal(auto.default, false)
    assert.ok(auto.confirm, "auto_switch 应带确认提示")
    assert.equal(kit.plugin.auth.single, true, "single: true 保持不变")
  })
})

test("Providers 页 thinking_summary 即时生效：关掉响应无 thinking 块，改回同模块下一请求立即恢复", async () => {
  await withKit({}, async (kit) => {
    thinkingAgent(kit)
    const switches = {}
    const seen = new Map()
    await kit.module.AntigravityBridgePlugin(fakeHostInput(switches, seen))
    const body = baseBody({ metadata: { user_id: "switch-thinking" } })
    const onFirst = await readSse(await kit.request(body))
    assert.ok(hasThinking(onFirst), "默认开：转发思考摘要")
    switches.thinking_summary = false
    const off = await readSse(await kit.request(followUp(body, onFirst, "second")))
    assert.ok(!hasThinking(off), "关掉后响应无 thinking 块")
    assert.equal(off.stopReason, "end_turn")
    switches.thinking_summary = true
    const onAgain = await readSse(await kit.request(followUp(followUp(body, onFirst, "second"), off, "third")))
    assert.ok(hasThinking(onAgain), "改回后同一模块下一请求立即恢复（每请求现读）")
    assert.equal(off.model, onAgain.model, "同一模型继续服务")
    for (const id of seen.values()) assert.equal(id, "yce-magpie-agy", "宿主应按 provider id 读取开关")
  })
})

test("minimal_agent=false：新进程 agent.md 不含 excludeDefaultComponents，已有进程被换掉", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const agentFiles = () => fs.readdirSync(kit.tmp, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("magpie-agy-bridge-"))
      .map((entry) => path.join(kit.tmp, entry.name, ".agents", "agents", "magpie-bridge", "agent.md"))
      .filter((file) => fs.existsSync(file))
    const body = baseBody({ metadata: { user_id: "switch-minimal" } })
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
    const before = agentFiles()
    assert.equal(before.length, 1, "第一份 agent.md 已写出")
    assert.match(fs.readFileSync(before[0], "utf8"), /excludeDefaultComponents: true/, "默认开：含最小 agent 配置")
    const switches = { minimal_agent: false }
    await kit.module.AntigravityBridgePlugin(fakeHostInput(switches))
    const second = await readSse(await kit.request(followUp(body, first, "second")))
    assert.equal(second.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2, "开关值不一致应按不兼容路径换新进程")
    const fresh = agentFiles().filter((file) => !before.includes(file))
    assert.equal(fresh.length, 1, "换新进程会另写一份 agent.md")
    assert.ok(!fs.readFileSync(fresh[0], "utf8").includes("excludeDefaultComponents: true"),
      "minimal_agent=false 的新进程 agent.md 不含 excludeDefaultComponents")
  })
})

test("auto_switch 开关可读：无宿主恒关，宿主保存后现读", async () => {
  await withKit({}, async (kit) => {
    assert.equal(kit.module.autoSwitchEnabled(), false, "无宿主、无环境变量：恒关")
    const switches = { auto_switch: true }
    await kit.module.AntigravityBridgePlugin(fakeHostInput(switches))
    assert.equal(kit.module.autoSwitchEnabled(), true)
    switches.auto_switch = false
    assert.equal(kit.module.autoSwitchEnabled(), false, "现读：改回 false 立即生效")
  })
})

test("无参入口（旧宿主）下 AGY_BRIDGE_THINKING=0 仍关思考摘要，撤掉环境变量后回落默认开", async () => {
  await withKit({ env: { AGY_BRIDGE_THINKING: "0" } }, async (kit) => {
    thinkingAgent(kit)
    const body = baseBody({ metadata: { user_id: "legacy-thinking" } })
    const off = await readSse(await kit.request(body))
    assert.ok(!hasThinking(off), "旧宿主环境变量 0 仍关闭思考摘要")
    assert.equal(off.stopReason, "end_turn")
    delete kit.env.AGY_BRIDGE_THINKING
    const on = await readSse(await kit.request(followUp(body, off, "second")))
    assert.ok(hasThinking(on), "撤掉环境变量后回落默认开")
  })
})
