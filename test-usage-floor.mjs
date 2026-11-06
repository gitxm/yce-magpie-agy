// 末条 usage 上下文下限回归（源自 configs 仓 test_agy_bridge_final_usage_floor.mjs，
// 0.1.0 曾随插件迁仓带入，0.2.0 主线重构后按新结构重新移植）：ACP result.usage
// 可能是本轮增量（远小于窗口），末条输入合计不能被它拉塌，也不能把
// inputTokenScale 校准到下限；message_start 与非流式响应带请求体的非零估算输入。
//
// 运行：node --experimental-vm-modules --test test-usage-floor.mjs
// 全部经真实仓内 index.mjs 的 fetch → Proc → ACP → 流生成/消费路径，假 agy 见 testkit.mjs。

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  baseBody, continueWithToolResults, createBridgeKit, padBodyToTokens, readJson, readSse, usageTotal,
} from "./testkit.mjs"

async function withKit(fn) {
  const kit = await createBridgeKit({})
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

/** 驱动一整轮：遇到 tool_use 就接回 tool_result，直到收尾。 */
async function runTurn(kit, body, { stream = true } = {}) {
  const responses = []
  const estimates = []
  let current = stream ? body : { ...body, stream: false }
  for (let guard = 0; guard < 32; guard++) {
    estimates.push(await kit.countTokens(current))
    const response = await kit.request(current)
    const parsed = stream ? await readSse(response) : await readJson(response)
    assert.equal(parsed.error, null, JSON.stringify(parsed.error))
    responses.push(parsed)
    if (parsed.stopReason !== "tool_use") return { responses, estimates }
    current = continueWithToolResults(current, parsed)
  }
  throw new Error("工具回合超过 32 次仍未收尾")
}

test("多工具轮末步 ACP 返回增量小值：末条输入合计不低于同轮最后中间步的 90%", async () => {
  await withKit(async (kit) => {
    kit.prompts.push(async (agent) => {
      for (let round = 0; round < 3; round++) await agent.tool("Read", { path: `/repo/file-${round}.ts` })
      await agent.text("done")
      // 增量口径：只有本轮最后一次内部调用的几 k，而不是整个窗口。
      return { stopReason: "end_turn", usage: { inputTokens: 5_000, cachedReadTokens: 4_000, outputTokens: 20 } }
    })
    const body = await padBodyToTokens(kit, baseBody(), 100_000)
    const { responses } = await runTurn(kit, body)
    assert.equal(responses.length, 4)
    const lastIntermediate = usageTotal(responses[2].usage)
    const final = responses[3]
    const finalTotal = usageTotal(final.usage)
    assert.ok(lastIntermediate > 90_000, `中间步窗口 ${lastIntermediate} 不在 100k 量级`)
    assert.ok(finalTotal >= 0.9 * lastIntermediate, `末条 ${finalTotal} 低于最后中间步 ${lastIntermediate} 的 90%（上下文被拉塌）`)
    assert.ok(final.usage.output_tokens >= 1)
    assert.equal(kit.turns[0].responseSteps.at(-1).usageKind, "context_floor")
  })
})

test("单步增量型 result.usage 被抬到下限并标记 context_floor，output 口径不变", async () => {
  await withKit(async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.thought("considering")
      await agent.text("single step answer")
      return { stopReason: "end_turn", usage: { inputTokens: 5_000, cachedReadTokens: 1_000, outputTokens: 30, thoughtTokens: 5 } }
    })
    const body = await padBodyToTokens(kit, baseBody(), 20_000)
    const { responses, estimates } = await runTurn(kit, body)
    assert.equal(responses.length, 1)
    const [parsed] = responses
    const total = usageTotal(parsed.usage)
    assert.ok(total >= Math.round(0.5 * estimates[0]), `单步末条 ${total} 未抬到估算下限 ${Math.round(0.5 * estimates[0])}`)
    assert.ok(total <= Math.round(1.5 * estimates[0]), `单步末条 ${total} 超过 1.5 倍估算`)
    assert.equal(kit.turns[0].responseSteps[0].usageKind, "context_floor")
    // output 与 thinking 沿用 ACP 精确值（35 = 30 + 5）。
    assert.equal(parsed.usage.output_tokens, 35)
    assert.equal(parsed.usage.output_tokens_details?.thinking_tokens, 5)
  })
})

test("增量型末条不污染 inputTokenScale 与 lastCacheRatio", async () => {
  await withKit(async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await agent.text("done")
      return { stopReason: "end_turn", usage: { inputTokens: 5_000, cachedReadTokens: 5_000, outputTokens: 10 } }
    })
    const body = await padBodyToTokens(kit, baseBody(), 80_000)
    const { responses } = await runTurn(kit, body)
    assert.equal(responses.length, 2)
    const { proc } = kit.turns[0]
    assert.equal(proc.inputTokenScale, 1, `inputTokenScale 被增量末条拉到 ${proc.inputTokenScale}`)
    assert.equal(proc.lastCacheRatio, 0, `lastCacheRatio 被增量末条改成 ${proc.lastCacheRatio}`)
  })
})

test("累计型正常 result.usage 不被误改：原样透传并照常校准 scale", async () => {
  await withKit(async (kit) => {
    const raw = { inputTokens: 15_000, cachedReadTokens: 6_000, cachedWriteTokens: 0, outputTokens: 30 }
    kit.prompts.push(async (agent) => {
      await agent.text("normal single step")
      return { stopReason: "end_turn", usage: raw }
    })
    const body = await padBodyToTokens(kit, baseBody(), 20_000)
    const { responses } = await runTurn(kit, body)
    const [parsed] = responses
    assert.equal(kit.turns[0].responseSteps[0].usageKind, "exact")
    assert.equal(parsed.usage.input_tokens, 9_000)
    assert.equal(parsed.usage.cache_read_input_tokens, 6_000)
    assert.equal(usageTotal(parsed.usage), 15_000)
    const { proc } = kit.turns[0]
    assert.ok(Math.abs(proc.inputTokenScale - 0.75) < 0.01, `正常样本应校准 scale≈0.75，实际 ${proc.inputTokenScale}`)
    assert.ok(Math.abs(proc.lastCacheRatio - 0.4) < 0.01, `lastCacheRatio 应≈0.4，实际 ${proc.lastCacheRatio}`)
  })
})

test("多步累计型正常末条不触发下限", async () => {
  await withKit(async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await agent.tool("Read", { path: "/b" })
      await agent.text("done")
      // 整轮累计约为 3 次窗口，按权重拆给末步后约等于一个窗口，远高于下限。
      return { stopReason: "end_turn", usage: { inputTokens: 300_000, cachedReadTokens: 200_000, outputTokens: 20 } }
    })
    const body = await padBodyToTokens(kit, baseBody(), 100_000)
    const { responses, estimates } = await runTurn(kit, body)
    assert.equal(responses.length, 3)
    assert.notEqual(kit.turns[0].responseSteps.at(-1).usageKind, "context_floor")
    const finalTotal = usageTotal(responses[2].usage)
    assert.ok(finalTotal >= Math.round(0.5 * estimates[2]) && finalTotal <= Math.round(1.5 * estimates[2]), `末条 ${finalTotal} 不在 [0.5,1.5]×估算内`)
  })
})

test("message_start 与非流式响应带请求体的非零估算输入", async () => {
  await withKit(async (kit) => {
    const script = async (agent) => {
      await agent.text("hello")
      return { stopReason: "end_turn", usage: { inputTokens: 30_000, cachedReadTokens: 0, outputTokens: 5 } }
    }
    kit.prompts.push(script)
    kit.prompts.push(script)
    const body = await padBodyToTokens(kit, baseBody(), 30_000)
    const response = await kit.request(body)
    const parsed = await readSse(response)
    const start = parsed.events.find((item) => item.event === "message_start")
    assert.equal(start.data.message.usage.output_tokens, 0)
    const startTotal = usageTotal(start.data.message.usage)
    assert.ok(startTotal >= 29_000 && startTotal <= 31_000, `message_start 输入估算 ${startTotal} 偏离 30k 量级`)
    const nonStream = await kit.request({ ...body, stream: false })
    const json = await readJson(nonStream)
    const jsonTotal = usageTotal(json.usage)
    assert.ok(jsonTotal >= 29_000 && jsonTotal <= 31_000, `非流式响应输入估算 ${jsonTotal} 偏离 30k 量级`)
  })
})
