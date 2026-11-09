// 末条 usage 上下文下限回归（源自 configs 仓 test_agy_bridge_final_usage_floor.mjs，
// 0.1.0 曾随插件迁仓带入，0.2.0 主线重构后按新结构重新移植）：ACP result.usage
// 可能是本轮增量（远小于窗口），末条输入合计不能被它拉塌，也不能把本模型族的
// 校准（scale / cacheRatio）带偏；抬到下限时保留本次实测的读、写占比。
// message_start 固定四字段全 0，非流式最终 usage 由 message_delta 决定。
// 夹具按 ACP 排他口径造数：inputTokens 只含未缓存输入，outputTokens 已含 thoughtTokens。
//
// 运行：node --experimental-vm-modules --test test-usage-floor.mjs
// 全部经真实仓内 index.mjs 的 fetch → Proc → ACP → 流生成/消费路径，假 agy 见 testkit.mjs。

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  acpUsage, baseBody, continueWithToolResults, createBridgeKit, padBodyToTokens, readJson, readSse, usageTotal,
} from "./testkit.mjs"

const ZERO_USAGE = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }

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

test("多工具轮末步 ACP 返回增量小值：末条不低于最后中间步的 90%，读量按实测占比保留", async () => {
  await withKit(async (kit) => {
    kit.prompts.push(async (agent) => {
      for (let round = 0; round < 3; round++) await agent.tool("Read", { path: `/repo/file-${round}.ts` })
      await agent.text("done")
      // 增量口径：只有本轮最后一次内部调用的几 k，而不是整个窗口。
      return { stopReason: "end_turn", usage: acpUsage({ input: 5_000, read: 4_000, output: 20 }) }
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
    // 抬到下限不再把读量抹成 0：按本次实测 R/(I+R+W)=4/9 等比拆，余数归未缓存输入。
    assert.ok(final.usage.cache_read_input_tokens > 0, "触发下限时读量被抹成 0")
    assert.equal(final.usage.cache_read_input_tokens, Math.round(finalTotal * 4 / 9))
    assert.equal(final.usage.cache_creation_input_tokens, 0)
  })
})

test("单步增量型 result.usage 被抬到下限并标记 context_floor，读量按实测占比、output 口径不变", async () => {
  await withKit(async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.thought("considering")
      await agent.text("single step answer")
      return { stopReason: "end_turn", usage: acpUsage({ input: 5_000, read: 1_000, output: 30, thought: 5 }) }
    })
    const body = await padBodyToTokens(kit, baseBody(), 20_000)
    const { responses, estimates } = await runTurn(kit, body)
    assert.equal(responses.length, 1)
    const [parsed] = responses
    const total = usageTotal(parsed.usage)
    assert.ok(total >= Math.round(0.5 * estimates[0]), `单步末条 ${total} 未抬到估算下限 ${Math.round(0.5 * estimates[0])}`)
    assert.ok(total <= Math.round(1.5 * estimates[0]), `单步末条 ${total} 超过 1.5 倍估算`)
    assert.equal(kit.turns[0].responseSteps[0].usageKind, "context_floor")
    assert.equal(parsed.usage.cache_read_input_tokens, Math.round(total / 6), "读量没有按本次实测 1/6 占比保留")
    // output 已含 thinking（35 = 正文 30 + 思考 5），沿用 ACP 精确值，不再加一次思考。
    assert.equal(parsed.usage.output_tokens, 35)
    assert.equal(parsed.usage.output_tokens_details?.thinking_tokens, 5)
  })
})

test("增量型末条不污染本模型族的校准（scale 与 cacheRatio）", async () => {
  await withKit(async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await agent.text("done")
      return { stopReason: "end_turn", usage: acpUsage({ input: 5_000, read: 5_000, output: 10 }) }
    })
    const body = await padBodyToTokens(kit, baseBody(), 80_000)
    const { responses } = await runTurn(kit, body)
    assert.equal(responses.length, 2)
    const [turn] = kit.turns
    assert.equal(turn.responseSteps.at(-1).usageKind, "context_floor")
    assert.equal(turn.proc.calibration.get(turn.family), undefined,
      `增量末条写入了校准 ${JSON.stringify(turn.proc.calibration.get(turn.family))}`)
  })
})

test("累计型正常 result.usage 不被误改：原样透传并照常校准本族 scale 与 cacheRatio", async () => {
  await withKit(async (kit) => {
    const raw = acpUsage({ input: 9_000, read: 6_000, output: 30 })
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
    const [turn] = kit.turns
    const calibration = turn.proc.calibration.get(turn.family)
    assert.ok(Math.abs(calibration.scale - 0.75) < 0.01, `正常样本应校准 scale≈0.75，实际 ${calibration.scale}`)
    assert.ok(Math.abs(calibration.cacheRatio - 0.4) < 0.01, `cacheRatio 应≈0.4，实际 ${calibration.cacheRatio}`)
  })
})

test("多步累计型正常末条不触发下限", async () => {
  await withKit(async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await agent.tool("Read", { path: "/b" })
      await agent.text("done")
      // 整轮累计约为 3 次窗口（I+R=300k），按权重拆给末步后约等于一个窗口，远高于下限。
      return { stopReason: "end_turn", usage: acpUsage({ input: 100_000, read: 200_000, output: 20 }) }
    })
    const body = await padBodyToTokens(kit, baseBody(), 100_000)
    const { responses, estimates } = await runTurn(kit, body)
    assert.equal(responses.length, 3)
    assert.notEqual(kit.turns[0].responseSteps.at(-1).usageKind, "context_floor")
    const finalTotal = usageTotal(responses[2].usage)
    assert.ok(finalTotal >= Math.round(0.5 * estimates[2]) && finalTotal <= Math.round(1.5 * estimates[2]), `末条 ${finalTotal} 不在 [0.5,1.5]×估算内`)
    assert.equal(responses[2].usage.cache_read_input_tokens, Math.round(finalTotal * 2 / 3), "末步三桶没有按实测占比拆分")
  })
})

test("message_start 四字段全 0，非流式最终 usage 等于 message_delta 的结算值", async () => {
  await withKit(async (kit) => {
    const script = async (agent) => {
      await agent.text("hello")
      return { stopReason: "end_turn", usage: acpUsage({ input: 30_000, output: 5 }) }
    }
    kit.prompts.push(script)
    kit.prompts.push(script)
    const body = await padBodyToTokens(kit, baseBody(), 30_000)
    const response = await kit.request(body)
    const parsed = await readSse(response)
    const start = parsed.events.find((item) => item.event === "message_start")
    assert.deepEqual(JSON.parse(JSON.stringify(start.data.message.usage)), ZERO_USAGE)
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.usage)),
      { input_tokens: 30_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 })
    const nonStream = await kit.request({ ...body, stream: false })
    const json = await readJson(nonStream)
    assert.deepEqual(JSON.parse(JSON.stringify(json.usage)), JSON.parse(JSON.stringify(parsed.usage)))
  })
})
