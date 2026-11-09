// Exercise the real HTTP → bridge → fake ACP path, including persisted sessions.
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import {
  baseBody, continueWithToolResults, createBridgeKit as createTestKit,
  padBodyToTokens, readJson, readSse, usageTotal,
} from "./testkit.mjs"

const GEMINI = "gemini-4-argon-high"
const GEMINI_LOW = "gemini-4-argon-low"
const CLAUDE = "claude-sonnet-5-5-low"
const INLINE = "<external_system_instructions>"
const SYSTEM = "Follow the fixture instructions exactly."
const fields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
const snapshot = (usage) => Object.fromEntries(fields.map((key) => [key, usage[key]]))
const vector = (values) => Object.fromEntries(fields.map((key, index) => [key, values[index]]))
const ZERO = vector([0, 0, 0, 0])

function acpUsage(input, read, write, output, thinking = 0, total = input + read + write + output) {
  return { inputTokens: input, cachedReadTokens: read, cachedWriteTokens: write,
    outputTokens: output, thoughtTokens: thinking, totalTokens: total }
}

const WARM = acpUsage(800, 3200, 0, 20)
const answer = (usage = WARM, toolCalls = 0) => async (agent) => {
  for (let index = 0; index < toolCalls; index++) await agent.tool("Read", { path: `/fixture/${index}` })
  await agent.text("OK")
  return { stopReason: "end_turn", usage }
}

async function withKit(fn, env = {}) {
  const kit = await createTestKit({ env: { AGY_BRIDGE_EVENTS: "0", ...env } })
  kit.env.AGY_BRIDGE_STATE_FILE = path.join(kit.tmp, "sessions.json")
  kit.defaultPrompt = answer()
  try { return await fn(kit) } finally { await kit.dispose() }
}

function enableSessions(kit, onRequest = () => false) {
  kit.qaAcp = (request, agy) => {
    if (onRequest(request, agy) === true) return true
    if (request.method === "initialize") {
      agy.respond(request.id, { protocolVersion: 1, agentCapabilities: {
        _meta: { antigravity: { systemPrompt: { append: true } } },
        sessionCapabilities: { resume: true },
      } })
      return true
    }
    if (request.method === "session/resume") {
      agy.sessionId = request.params.sessionId
      agy.control({ kind: "list" })
      agy.respond(request.id, { sessionId: agy.sessionId, models: { currentModelId: kit.initialAgyModel } })
      return true
    }
    return false
  }
}

async function request(kit, body) {
  const response = await kit.request(body)
  const parsed = await (body.stream === false ? readJson(response) : readSse(response))
  assert.equal(parsed.error, null, JSON.stringify(parsed.error))
  return parsed
}

function follow(body, parsed, changes = {}) {
  return { ...body, messages: [...body.messages, { role: "assistant", content: parsed.content },
    { role: "user", content: "Continue with the next task." }], ...changes }
}

async function toolTurn(kit, body, calls) {
  const steps = []
  for (let i = 0; i < calls; i++) {
    const parsed = await request(kit, body)
    assert.equal(parsed.stopReason, "tool_use")
    assert.deepEqual(parsed.content.filter((block) => block.type === "tool_use").map((block) => block.name), ["Read"])
    steps.push(parsed)
    body = continueWithToolResults(body, parsed)
  }
  const estimate = await kit.countTokens(body)
  const final = await request(kit, body)
  assert.equal(final.stopReason, "end_turn")
  return { steps, final, estimate, body }
}

const bodyFor = (model) => baseBody({ model, system: SYSTEM, tools: [] })
const logOf = (kit, method) => kit.acpLog.filter((row) => row.method === `session/${method}`)
const appendOf = (row) => row.params._meta?.antigravity?.systemPrompt?.append
const promptText = (row) => row.params.prompt.filter((part) => part.type === "text").map((part) => part.text).join("\n")
const stateFile = (kit) => kit.env.AGY_BRIDGE_STATE_FILE
const stateOf = (kit) => JSON.parse(fs.readFileSync(stateFile(kit), "utf8"))
const parked = (kit, sessionId) => stateOf(kit).entries.find((entry) => entry.sessionId === sessionId)

for (const [name, raw, expected, thinking] of [
  ["independent input, read and write", acpUsage(1000, 400, 50, 30, 5), [1000, 30, 400, 50], 5],
  ["read exceeds input", acpUsage(200, 5000, 0, 20), [200, 20, 5000, 0], 0],
  ["all input is cached", acpUsage(0, 50_000, 0, 15, 5), [0, 15, 50_000, 0], 5],
  ["output below thinking", acpUsage(1000, 0, 0, 4, 10), [1000, 10, 0, 0], 10],
  ["inconsistent totalTokens", acpUsage(1000, 400, 50, 30, 5, 9999), [1000, 30, 400, 50], 5],
]) {
  test(`cache stats: ACP exclusive usage — ${name}`, () => withKit(async (kit) => {
    kit.prompts.push(answer(raw))
    const parsed = await request(kit, bodyFor(GEMINI))
    assert.equal(parsed.stopReason, "end_turn")
    assert.deepEqual(snapshot(parsed.usage), vector(expected))
    assert.equal(parsed.usage.output_tokens_details?.thinking_tokens ?? 0, thinking)
  }))
}

// Magpie 0.1.3150 (*Usage).add only overwrites a bucket with a positive value.
function mergeMagpieUsage(start, delta) {
  return Object.fromEntries(fields.map((key) => [key, delta[key] > 0 ? delta[key] : start[key]]))
}

test("cache stats: Magpie 0.1.3150 merger matches the four binary replays", () => {
  for (const [start, delta, merged] of [
    [[100_000, 0, 90_000, 0], [4000, 21, 60_000, 200], [4000, 21, 60_000, 200]],
    [[100_000, 0, 0, 0], [0, 21, 99_000, 0], [100_000, 21, 99_000, 0]],
    [[20_000, 0, 80_000, 0], [99_000, 21, 0, 0], [99_000, 21, 80_000, 0]],
    [[0, 0, 0, 0], [0, 21, 99_000, 200], [0, 21, 99_000, 200]],
  ]) assert.deepEqual(mergeMagpieUsage(vector(start), vector(delta)), vector(merged))
})

for (const [name, raw, expected, warm] of [
  ["full cache hit", acpUsage(0, 99_000, 0, 21), [0, 21, 99_000, 0]],
  ["cold start with cache writes after a warm turn", acpUsage(99_000, 0, 200, 21), [99_000, 21, 0, 200], true],
  ["mixed cache hit", acpUsage(4000, 60_000, 200, 21), [4000, 21, 60_000, 200]],
  ["small uncached request", acpUsage(80, 0, 0, 4), [80, 4, 0, 0]],
]) {
  test(`cache stats: Magpie SSE starts at zero and matches JSON — ${name}`, async () => {
    const run = (stream) => withKit(async (kit) => {
      let body = bodyFor(GEMINI)
      if (warm) body = follow(body, await request(kit, body))
      kit.prompts[kit.promptSerial] = answer(raw)
      return request(kit, { ...body, stream })
    })
    const sse = await run(true)
    const json = await run(false)
    assert.equal(sse.stopReason, "end_turn")
    assert.equal(json.stopReason, "end_turn")
    const start = snapshot(sse.events.find((event) => event.event === "message_start").data.message.usage)
    const delta = snapshot(sse.events.find((event) => event.event === "message_delta").data.usage)
    assert.deepEqual(start, ZERO)
    assert.deepEqual(delta, vector(expected))
    assert.deepEqual(mergeMagpieUsage(start, delta), delta)
    assert.deepEqual(snapshot(json.usage), delta)
  })
}

test("cache stats: two warm tool turns retain cache reads and bound the final window", () => withKit(async (kit) => {
  const body = await padBodyToTokens(kit, baseBody({ model: GEMINI }), 4000)
  const samples = [acpUsage(1000, 18_000, 1000, 100), acpUsage(2000, 8000, 200, 80)]
  kit.prompts.push(answer(), answer(samples[0], 2), answer(samples[1], 1))
  const first = await request(kit, body)
  const second = await toolTurn(kit, follow(body, first), 2)
  const third = await toolTurn(kit, follow(second.body, second.final), 1)
  assert.equal(new Set(logOf(kit, "prompt").map((row) => row.sessionId)).size, 1)
  for (const [index, turn] of [second, third].entries()) {
    for (const parsed of turn.steps) assert.ok(parsed.usage.cache_read_input_tokens > 0, "warm tool step lost cache reads")
    const final = turn.final.usage
    const total = usageTotal(final)
    assert.ok(final.cache_read_input_tokens > 0, "final tool step lost cache reads")
    assert.ok(total <= Math.round(1.5 * turn.estimate), `final window ${total} exceeds 1.5 × ${turn.estimate}`)
    const { inputTokens, cachedReadTokens, cachedWriteTokens } = samples[index]
    assert.ok(Math.abs(final.cache_read_input_tokens / total - cachedReadTokens /
      (inputTokens + cachedReadTokens + cachedWriteTokens)) <= 1 / total, "final step distorted the measured cache share")
  }
}))

for (const calls of [0, 1]) {
  test(`cache stats: ${calls ? "tool final" : "single response"} context floor preserves measured cache share`, () => withKit(async (kit) => {
    const body = await padBodyToTokens(kit, baseBody({ model: GEMINI }), 20_000)
    kit.prompts.push(answer(acpUsage(500, 300, 200, 40), calls))
    const { final, estimate } = await toolTurn(kit, body, calls)
    assert.equal(usageTotal(final.usage), estimate, "small ACP sample did not lift to the context estimate")
    assert.equal(final.usage.cache_read_input_tokens, Math.round(0.3 * estimate))
    assert.equal(final.usage.cache_creation_input_tokens, Math.round(0.2 * estimate))
  }))
}

test("cache stats: Gemini calibration stays in its family on a Gemini → Claude → Gemini session", () => withKit(async (kit) => {
  // No system instruction: a placement change must not rebuild the session and hide calibration bleed.
  enableSessions(kit)
  const body = baseBody({ model: GEMINI, system: "" })
  kit.prompts.push(answer(WARM), answer(acpUsage(4000, 0, 0, 50), 1), answer(WARM, 1))
  const first = await request(kit, body)
  const claude = await toolTurn(kit, follow(body, first, { model: CLAUDE }), 1)
  const gemini = await toolTurn(kit, follow(claude.body, claude.final, { model: GEMINI_LOW }), 1)
  assert.equal(logOf(kit, "new").length, 1, "model changes must stay in the same session for this test")
  assert.deepEqual(kit.setModels, [GEMINI, CLAUDE, GEMINI_LOW])
  assert.equal(claude.steps[0].usage.cache_read_input_tokens, 0)
  const returned = gemini.steps[0].usage
  assert.equal(returned.cache_read_input_tokens, Math.round(0.8 * usageTotal(returned)))
}))

test("cache stats: Claude starts inline and Gemini reuses it without repeating instructions", () => withKit(async (kit) => {
  enableSessions(kit)
  const body = bodyFor(CLAUDE)
  const first = await request(kit, body)
  await request(kit, follow(body, first, { model: GEMINI }))
  const starts = logOf(kit, "new")
  const [initial, switched] = logOf(kit, "prompt")
  assert.equal(starts.length, 1)
  assert.equal(logOf(kit, "resume").length, 0)
  assert.equal(appendOf(starts[0]), undefined)
  assert.equal(initial.sessionId, switched.sessionId)
  assert.ok(promptText(initial).includes(`${INLINE}\n${SYSTEM}\n</external_system_instructions>`))
  assert.equal(promptText(initial).split(SYSTEM).length - 1, 1)
  assert.ok(!promptText(switched).includes(INLINE) && !promptText(switched).includes(SYSTEM))
  assert.deepEqual(kit.setModels, [CLAUDE, GEMINI])
}))

test("cache stats: Gemini starts with append; switching to Claude parks it and starts inline", () => withKit(async (kit) => {
  let geminiId, parkedAtClaudeStartup
  enableSessions(kit, ({ method }) => {
    if (method === "session/new" && geminiId) parkedAtClaudeStartup = parked(kit, geminiId)
  })
  const body = bodyFor(GEMINI)
  const first = await request(kit, body)
  geminiId = logOf(kit, "prompt")[0].sessionId
  await request(kit, follow(body, first, { model: CLAUDE }))
  const starts = logOf(kit, "new")
  const [initial, switched] = logOf(kit, "prompt")
  assert.ok(appendOf(starts[0])?.includes(SYSTEM))
  assert.ok(!promptText(initial).includes(INLINE) && !promptText(initial).includes(SYSTEM))
  assert.equal(starts.length, 2, "switching from appended Gemini instructions to Claude must start a new session")
  assert.equal(logOf(kit, "resume").length, 0)
  assert.notEqual(initial.sessionId, switched.sessionId)
  assert.equal(parkedAtClaudeStartup?.sessionId, geminiId)
  assert.equal(appendOf(starts[1]), undefined)
  assert.ok(promptText(switched).includes(`${INLINE}\n${SYSTEM}\n</external_system_instructions>`))
}))

// Copy only fixture state into a fresh bridge instance, as on a process restart.
async function parkingFixture(model) {
  return withKit(async (kit) => {
    enableSessions(kit)
    const body = baseBody({ model, system: SYSTEM })
    const first = await request(kit, body)
    const id = logOf(kit, "prompt")[0].sessionId
    const state = stateOf(kit)
    assert.equal(state.entries.find((entry) => entry.sessionId === id)?.sessionId, id)
    return { id, state, next: follow(body, first) }
  })
}

function installState(kit, state) {
  fs.writeFileSync(stateFile(kit), JSON.stringify(state))
  // Fake ACP's newly allocated session IDs must differ from the restored record.
  kit.sessionSerial = state.entries.length
}

test("cache stats: mismatched parked history remains on disk when replacement startup fails", async () => {
  const { id, state, next } = await parkingFixture(GEMINI)
  await withKit(async (kit) => {
    installState(kit, state)
    enableSessions(kit, (rpc, agy) => {
      if (rpc.method !== "session/new") return
      agy.send({ id: rpc.id, error: { code: -32603, message: "fixture replacement startup failed" } })
      return true
    })
    // A different system string changes the conversation key. Alter history to
    // keep the same key and force the bridge to validate the candidate record.
    next.messages[1] = { role: "assistant", content: "Changed prior answer." }
    const response = await kit.request(next)
    assert.ok(!response.ok)
    assert.match(await response.text(), /fixture replacement startup failed/)
    assert.equal(logOf(kit, "resume").length, 0)
    assert.equal(logOf(kit, "new").length, 1)
    assert.deepEqual(parked(kit, id), state.entries[0])
  })
})

test("cache stats: inline resume into Gemini consumes only after acknowledgement and never appends instructions", async () => {
  const { id, state, next } = await parkingFixture(CLAUDE)
  await withKit(async (kit) => {
    installState(kit, state)
    let beforeAck, afterAck
    enableSessions(kit, ({ method }) => {
      if (method === "session/resume") beforeAck = parked(kit, id)
      if (method === "session/set_model") afterAck = { entry: parked(kit, id) }
    })
    const parsed = await request(kit, { ...next, model: GEMINI })
    assert.equal(parsed.stopReason, "end_turn")
    const [resume] = logOf(kit, "resume")
    assert.equal(resume.params.sessionId, id)
    assert.equal(logOf(kit, "new").length, 0)
    assert.deepEqual(beforeAck, state.entries[0], "record disappeared before ACP acknowledged the resume")
    assert.deepEqual(afterAck, { entry: undefined }, "resume must consume the record before starting the first turn")
    assert.equal(appendOf(resume), undefined)
    assert.ok(!promptText(logOf(kit, "prompt")[0]).includes(INLINE))
  })
})

test("cache stats: a resumed session restores its family's cache ratio for the first tool step", async () => {
  const { id, state, next } = await parkingFixture(CLAUDE)
  await withKit(async (kit) => {
    installState(kit, state)
    enableSessions(kit)
    kit.prompts.push(answer(WARM, 1))
    const { steps } = await toolTurn(kit, next, 1)
    assert.equal(logOf(kit, "resume")[0]?.params.sessionId, id)
    assert.equal(logOf(kit, "new").length, 0)
    const usage = steps[0].usage
    assert.ok(usage.cache_read_input_tokens > 0, "resumed first tool step lost the saved cache ratio")
    assert.equal(usage.cache_read_input_tokens, Math.round(0.8 * usageTotal(usage)))
  })
})

for (const [name, error, retain] of [
  ["deletes a missing session", { code: -32000, message: "session not found: fixture" }, false],
  ["retains a temporary upstream failure", { code: -32603, message: "upstream temporarily unavailable" }, true],
  ["retains a timed out handshake", null, true],
]) {
  test(`cache stats: parked resume ${name}`, async () => {
    const { id, state, next } = await parkingFixture(GEMINI)
    await withKit(async (kit) => {
      installState(kit, state)
      enableSessions(kit, (rpc, agy) => {
        if (rpc.method === "session/resume") {
          if (error) agy.send({ id: rpc.id, error })
          return true
        }
        if (rpc.method === "session/new") {
          agy.send({ id: rpc.id, error: { code: -32603, message: "fixture replacement startup failed" } })
          return true
        }
      })
      const response = await kit.request(next)
      assert.ok(!response.ok)
      assert.match(await response.text(), error ? /fixture replacement startup failed/ : /timed out starting agy acp/)
      assert.deepEqual(logOf(kit, "resume").map((row) => row.params.sessionId), [id])
      assert.equal(logOf(kit, "new").length, error ? 1 : 0)
      assert.deepEqual(parked(kit, id), retain ? state.entries[0] : undefined)
    }, error ? {} : { AGY_BRIDGE_START_TIMEOUT_MS: "750" })
  })
}

test("cache stats: a legacy parked record without placement or calibration still resumes", async () => {
  const { id, state, next } = await parkingFixture(GEMINI)
  for (const entry of state.entries) {
    delete entry.instructionsInSession
    delete entry.calibration
  }
  await withKit(async (kit) => {
    installState(kit, state)
    enableSessions(kit)
    const response = await request(kit, next)
    assert.equal(response.stopReason, "end_turn")
    assert.equal(logOf(kit, "new").length, 0)
    assert.deepEqual(logOf(kit, "resume").map((row) => row.params.sessionId), [id])
    assert.ok(appendOf(logOf(kit, "resume")[0])?.includes(SYSTEM))
    assert.equal(logOf(kit, "prompt")[0].sessionId, id)
  })
})

const SCHEMA = { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } } }
const TOOL = { name: "Read", description: "Read a fixture file.", input_schema: SCHEMA }
const HINTED_TOOL = { ...TOOL, cache_control: { type: "ephemeral" } }

test("cache stats: MCP re-lists tools only on real description or schema changes", () => withKit(async (kit) => {
  const notices = [], lists = []
  kit.qaAcp = ({ method }, agy) => {
    if (method !== "session/prompt" || lists.length) return
    const list = () => lists.push(agy.control({ kind: "list" }))
    const watcher = new EventEmitter()
    watcher.setEncoding = () => watcher
    watcher.write = (line) => { notices.push(JSON.parse(line)); list(); return true }
    watcher.destroy = () => watcher.emit("close")
    kit.controlHandler(watcher)
    watcher.emit("data", JSON.stringify({ kind: "watch", token: agy.token }) + "\n")
    list()
  }
  const reordered = { input_schema: SCHEMA, name: TOOL.name, description: TOOL.description }
  const reversed = { ...TOOL, input_schema: { ...SCHEMA, properties: { limit: SCHEMA.properties.limit, path: SCHEMA.properties.path } } }
  const renamed = { ...TOOL, description: "Read a different fixture file." }
  const retyped = { ...renamed, input_schema: { ...SCHEMA, properties: { ...SCHEMA.properties, limit: { type: "number" } } } }
  let body = baseBody({ model: GEMINI, tools: [TOOL] })
  const listCounts = []
  for (const tool of [TOOL, reordered, reversed, { ...reversed, cache_control: HINTED_TOOL.cache_control }, reversed, renamed, retyped]) {
    body = { ...body, tools: [tool] }
    body = follow(body, await request(kit, body))
    listCounts.push(lists.length)
  }
  assert.equal(logOf(kit, "new").length, 1)
  assert.deepEqual(listCounts, [1, 1, 1, 1, 1, 2, 3])
  assert.deepEqual(notices, [{ event: "tools_changed" }, { event: "tools_changed" }])
  const catalogs = (await Promise.all(lists)).map((reply) => reply.result.tools[0])
  assert.deepEqual(catalogs.map((tool) => tool.description), [TOOL.description, renamed.description, renamed.description])
  assert.deepEqual(catalogs.map((tool) => tool.inputSchema.properties.limit.type), ["integer", "integer", "number"])
}))

test("cache stats: count_tokens ignores tool-level cache_control", () => withKit(async (kit) => {
  const plain = await kit.countTokens(baseBody({ tools: [TOOL] }))
  const hinted = await kit.countTokens(baseBody({ tools: [HINTED_TOOL] }))
  assert.equal(hinted, plain)
}))
