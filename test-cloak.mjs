// 假 429 绕过（prompt_cloak）与 agy 1.5.x 重试横幅过滤的回归。
// 背景：Antigravity 看到 Claude Agent SDK（Claude Code 子代理、claude -p）等身份句会回
// 假的 429 RESOURCE_EXHAUSTED，agy 无限重试，客户端一个工具都调不起来；agy 1.5.x 的
// 重试横幅改成 "⚠ API error (attempt N): ..."，旧过滤认不出，会当正文漏给客户端。
// 运行：node --experimental-vm-modules --test test-cloak.mjs
// 全部经 testkit.mjs 加载真实 index.mjs 与进程内假 agy，不调用真实 agy。

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

const ZWSP = "\u200b"
const SDK_LINE = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const BILLING_LINE = "x-anthropic-billing-header: cc_version=2.1.316.d4e; cc_entrypoint=sdk-cli;"
const SDK_SYSTEM = [
  { type: "text", text: BILLING_LINE },
  { type: "text", text: SDK_LINE },
  { type: "text", text: "You are an agent for Claude Code." },
]

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

function fakeHostInput(switches) {
  return { magpie: { option: (_id, key) => switches[key] } }
}

function promptText(params) {
  return (params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
}

function appendedInstructions(kit) {
  const call = kit.acpLog.find((row) => row.method === "session/new")
  return call?.params?._meta?.antigravity?.systemPrompt?.append ?? null
}

function firstPrompt(kit) {
  return promptText(kit.acpLog.find((row) => row.method === "session/prompt")?.params)
}

function plainAgent(kit) {
  kit.defaultPrompt = async (agent) => {
    await agent.text(`answer ${agent.index}`)
    return { stopReason: "end_turn" }
  }
}

const appendCapable = { _meta: { antigravity: { systemPrompt: { append: true } } } }

test("Gemini 会话级 append：Agent SDK 身份句与计费头被插入零宽空格，原文不外发", async () => {
  await withKit({}, async (kit) => {
    plainAgent(kit)
    kit.agentCapabilities = appendCapable
    const parsed = await readSse(await kit.request(baseBody({ system: SDK_SYSTEM, metadata: { user_id: "cloak-gemini" } })))
    assert.equal(parsed.stopReason, "end_turn")
    const append = appendedInstructions(kit)
    assert.equal(typeof append, "string", "Gemini 会话应带 systemPrompt.append")
    assert.ok(!append.includes("Claude Agent SDK"), "原样身份句不应发给 agy")
    assert.ok(!append.includes("x-anthropic-billing-header"), "原样计费头不应发给 agy")
    assert.ok(append.includes(`C${ZWSP}laude Agent SDK`), "身份句在首字母后插入零宽空格")
    assert.ok(append.includes(`x${ZWSP}-anthropic-billing-header`), "计费头在首字母后插入零宽空格")
    assert.ok(append.includes("You are an agent for Claude Code."), "其余系统文本不变")
  })
})

test("内联放置（Claude 模型）：external_system_instructions 同样被处理", async () => {
  await withKit({}, async (kit) => {
    plainAgent(kit)
    kit.agentCapabilities = appendCapable
    const body = baseBody({ model: "yce-magpie-agy/claude-opus-5-5", system: SDK_SYSTEM, metadata: { user_id: "cloak-inline" } })
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(appendedInstructions(kit), null, "Claude 模型不走会话级 append")
    const prompt = firstPrompt(kit)
    assert.match(prompt, /<external_system_instructions>/)
    assert.ok(!prompt.includes("Claude Agent SDK"))
    assert.ok(prompt.includes(`C${ZWSP}laude Agent SDK`))
  })
})

test("尾随 system 消息也按系统级文本处理，用户正文保持原样", async () => {
  await withKit({}, async (kit) => {
    plainAgent(kit)
    kit.agentCapabilities = appendCapable
    const body = baseBody({
      metadata: { user_id: "cloak-trailing" },
      messages: [
        { role: "user", content: "tell me about the Claude Agent SDK" },
        { role: "system", content: `# Environment\n${SDK_LINE}` },
      ],
    })
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = firstPrompt(kit)
    assert.ok(prompt.includes("tell me about the Claude Agent SDK"), "用户正文不改")
    assert.ok(prompt.includes(`Anthropic's C${ZWSP}laude Agent SDK.`), "尾随 system 文本被处理")
  })
})

test("prompt_cloak 关闭或 AGY_BRIDGE_PROMPT_CLOAK=0 时原样发送", async () => {
  await withKit({}, async (kit) => {
    plainAgent(kit)
    kit.agentCapabilities = appendCapable
    await kit.module.AntigravityBridgePlugin(fakeHostInput({ prompt_cloak: false }))
    await readSse(await kit.request(baseBody({ system: SDK_SYSTEM, metadata: { user_id: "cloak-off" } })))
    const append = appendedInstructions(kit)
    assert.ok(append.includes(SDK_LINE), "开关关闭：原样")
    assert.ok(!append.includes(ZWSP))
  })
  await withKit({ env: { AGY_BRIDGE_PROMPT_CLOAK: "0" } }, async (kit) => {
    plainAgent(kit)
    kit.agentCapabilities = appendCapable
    await readSse(await kit.request(baseBody({ system: SDK_SYSTEM, metadata: { user_id: "cloak-env-off" } })))
    assert.ok(appendedInstructions(kit).includes(SDK_LINE), "旧宿主环境变量 0：原样")
  })
})

test("处理只发生在出站文本：会话复用不受影响（第二轮不换进程）", async () => {
  await withKit({}, async (kit) => {
    plainAgent(kit)
    kit.agentCapabilities = appendCapable
    const body = baseBody({ system: SDK_SYSTEM, metadata: { user_id: "cloak-reuse" } })
    const first = await readSse(await kit.request(body))
    const second = await readSse(await kit.request({
      ...body,
      messages: [...body.messages, { role: "assistant", content: first.content.map((block) => ({ type: "text", text: block.text })) }, { role: "user", content: "next" }],
    }))
    assert.equal(second.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1, "同一会话复用同一个 agy 进程")
  })
})

test("agy 1.5.x 的 \"⚠ API error (attempt N)\" 重试横幅被过滤，不进入回复正文", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("\n⚠ ")
      await agent.text("API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).")
      await agent.text("\n")
      await agent.text("\n⚠ API error (attempt 2): UNAVAILABLE (code 503): try again\n")
      await agent.text("final answer")
      return { stopReason: "end_turn" }
    }
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "retry-banner" } })))
    assert.equal(parsed.stopReason, "end_turn")
    const text = parsed.content.filter((block) => block.type === "text").map((block) => block.text).join("")
    assert.ok(!text.includes("API error"), `重试横幅不应漏给客户端：${JSON.stringify(text)}`)
    assert.equal(text.trim(), "final answer")
  })
})
