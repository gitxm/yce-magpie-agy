// Regression suite for upstream magpie-community/plugins agy-cli 0.1.4 -> 0.1.39
// mid-stream cutoff fixes, schema/permission bridges, 2-ZWSP cloaking, 112 KiB
// loop-task pinning, Gemini 4 Carbon output limit, mid-turn ToolSearch & steering,
// and OpenCode 1.x / 2.x entrypoints.
//
// Run: node --experimental-vm-modules --test test-upstream-0139.mjs

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import {
  READ_TOOL, baseBody, continueWithToolResults, createBridgeKit, readJson, readSse,
} from "./testkit.mjs"

const ZWSP = "​"
const APPEND_CAPABLE = { _meta: { antigravity: { systemPrompt: { append: true } } } }

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

function sendAcpRequest(agy, id, method, params) {
  return new Promise((resolve, reject) => {
    let buf = ""
    const prevOnStdin = agy.child.onStdin
    const restore = () => { agy.child.onStdin = prevOnStdin }
    agy.child.onStdin = (chunk) => {
      prevOnStdin?.(chunk)
      buf += String(chunk)
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (msg.id === id && msg.method === undefined) {
          restore()
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
          return
        }
      }
    }
    agy.send({ id, method, params })
  })
}

test("1. #1052: quoting terminal error banner mid-reply does not cut off turn, while trailing terminal banner still errors", async () => {
  await withKit({}, async (kit) => {
    // 1a) Quoted mid-reply followed by normal text must succeed cleanly.
    kit.prompts.push(async (agent) => {
      await agent.text("Root cause analysis:\n⚠ Agent execution terminated due to error.\n")
      await agent.text("That banner was quoted inside markdown; the stream continues to completion.")
      return { stopReason: "end_turn" }
    })
    const ok = await readSse(await kit.request(baseBody({ metadata: { user_id: "quote-ok" } })))
    assert.equal(ok.error, null, `quoted banner killed healthy turn: ${JSON.stringify(ok.error)}`)
    assert.equal(ok.stopReason, "end_turn")
    const fullText = ok.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    assert.ok(fullText.includes("⚠ Agent execution terminated due to error."))
    assert.ok(fullText.includes("the stream continues to completion."))

    // 1b) Real terminal error banner at end of prompt must still surface as SSE error.
    kit.prompts.push(async (agent) => {
      await agent.text("Partial output before crash")
      await agent.text("\n⚠ Model produced invalid output.\n")
      return { stopReason: "end_turn" }
    })
    const crashed = await readSse(await kit.request(baseBody({ metadata: { user_id: "real-crash" } })))
    assert.notEqual(crashed.error, null, "trailing terminal banner must still fail the turn")
    assert.match(crashed.error.message, /Model produced invalid output|stopped the turn/)
  })
})

test("2. #1082: session/request_permission allows declared ide-tools once and denies built-in shell/undeclared tools", async () => {
  await withKit({}, async (kit) => {
    let currentAgy = null
    kit.qaAcp = (msg, agy) => {
      currentAgy = agy
      return false
    }
    const permResults = {}
    kit.prompts.push(async (agent) => {
      const options = [
        { optionId: "allow-once-id", kind: "allow_once" },
        { optionId: "reject-once-id", kind: "reject_once" },
      ]
      permResults.declaredMcp = await sendAcpRequest(currentAgy, "perm-1", "session/request_permission", {
        sessionId: agent.sessionId,
        toolCall: { title: "mcp(ide-tools/Read)?", name: "mcp_ide-tools_Read" },
        options,
      })
      permResults.undeclaredMcp = await sendAcpRequest(currentAgy, "perm-2", "session/request_permission", {
        sessionId: agent.sessionId,
        toolCall: { title: "mcp(ide-tools/Write)", name: "mcp_ide-tools_Write" },
        options,
      })
      permResults.shellSpoof = await sendAcpRequest(currentAgy, "perm-3", "session/request_permission", {
        sessionId: agent.sessionId,
        toolCall: { title: "Run command: echo mcp(ide-tools/Read)", name: "run_command" },
        options,
      })
      await agent.text("permissions checked")
      return { stopReason: "end_turn" }
    })
    const parsed = await readSse(await kit.request(baseBody({ tools: [READ_TOOL], metadata: { user_id: "perm-check" } })))
    assert.equal(parsed.error, null)
    assert.equal(permResults.declaredMcp?.outcome?.optionId, "allow-once-id")
    assert.equal(permResults.undeclaredMcp?.outcome?.optionId, "reject-once-id")
    assert.equal(permResults.shellSpoof?.outcome?.optionId, "reject-once-id")
  })
})

test("3. #989/#946/#963/#1042: tools/list sets antigravity/alwaysLoad, expands $ref/allOf, rewrites/drops non-RE2 patterns, and fills Gemini array items", async () => {
  await withKit({}, async (kit) => {
    let listedTools = null
    kit.qaAcp = (msg, agy) => {
      if (msg.method === "session/prompt") {
        agy.control({ kind: "list" }).then((reply) => { listedTools = reply.result.tools })
      }
      return false
    }
    kit.prompts.push(async (agent) => {
      await agent.text("listed")
      return { stopReason: "end_turn" }
    })
    const complexTool = {
      name: "ComplexSearch",
      description: "Search across items.",
      input_schema: {
        type: "object",
        $defs: {
          QueryFilter: {
            type: "object",
            properties: {
              lookaheadSlug: { type: "string", pattern: "^(?!secret)[a-z]+$" },
              unicodeName: { type: "string", pattern: "^\\u0041+$" },
            },
            required: ["lookaheadSlug"],
          },
        },
        properties: {
          filter: { $ref: "#/$defs/QueryFilter" },
          untypedTags: { type: "array" },
        },
        required: ["filter"],
      },
    }
    const parsed = await readSse(await kit.request(baseBody({ tools: [complexTool], metadata: { user_id: "schema-check" } })))
    assert.equal(parsed.error, null)
    assert.equal(listedTools?.length, 1)
    const [tool] = listedTools
    assert.equal(tool._meta?.["antigravity/alwaysLoad"], true, "must mark client tools alwaysLoad so agy 1.5.5+ does not defer them")
    assert.equal(tool.inputSchema.$defs, undefined, "$defs must be expanded and stripped")
    assert.equal(tool.inputSchema.properties.filter.type, "object")
    assert.equal(tool.inputSchema.properties.filter.properties.lookaheadSlug.pattern, undefined, "lookahead pattern must be stripped for Go RE2")
    assert.match(tool.inputSchema.properties.filter.properties.lookaheadSlug.description ?? "", /pattern:/)
    assert.equal(tool.inputSchema.properties.filter.properties.unicodeName.pattern, "^\\x{0041}+$", "\\uXXXX must translate to RE2 \\x{XXXX}")
    assert.ok(tool.inputSchema.properties.untypedTags.items, "untyped array must receive permissive items schema for Gemini")
  })
})

test("4. #980/#1028: 2-ZWSP line-wide breakup, RFC 2119 + DSH @-path rewrite, extraWords 2-ZWSP, and 429 turned-away -> 400", async () => {
  const sdkLine = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
  const rfcLine = "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL."
  const dshFrom = "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @\"...\" quotes a path containing spaces."

  await withKit({}, async (kit) => {
    kit.agentCapabilities = APPEND_CAPABLE
    kit.prompts.push(async (agent) => {
      await agent.text("cloaked ok")
      return { stopReason: "end_turn" }
    })
    await kit.module.AntigravityBridgePlugin(undefined, { extraWords: ["CustomBlockedPhrase"] })
    const system = [sdkLine, rfcLine, dshFrom, "Keep CustomBlockedPhrase safe."].join("\n\n")
    const parsed = await readSse(await kit.request(baseBody({ system, metadata: { user_id: "cloak-0139" } })))
    assert.equal(parsed.error, null)
    const append = kit.acpLog.find((r) => r.method === "session/new")?.params?._meta?.antigravity?.systemPrompt?.append ?? ""
    assert.ok(!append.includes("Claude Agent SDK"))
    assert.ok(!append.includes(rfcLine))
    assert.ok(!append.includes("Tokens prefixed with @ are paths"))
    assert.ok(append.includes(`C${ZWSP}l${ZWSP}aude`), "must insert two ZWSPs in >=3-char words on matched lines")
    assert.ok(append.includes(`k${ZWSP}e${ZWSP}ywords`), "RFC 2119 line must be broken up with 2 ZWSPs")
    assert.ok(append.includes("When the user writes @ followed by a path"), "DSH @-path paragraph must be reworded")
    assert.ok(append.includes(`C${ZWSP}u${ZWSP}stomBlockedPhrase`), "custom extraWords must also use 2-ZWSP breakup")
  })

  // When cloaking is turned off and Antigravity returns a fake 429 on a
  // turned-away prompt, the error must be reported as the prompt being refused
  // (invalid_request_error + hint), not as an exhausted quota.
  await withKit({ env: { AGY_BRIDGE_PROMPT_CLOAK: "0" } }, async (kit) => {
    kit.agentCapabilities = APPEND_CAPABLE
    kit.prompts.push(async (agent) => {
      const workspaceDir = fs.readdirSync(kit.tmp).find((name) => name.startsWith("magpie-agy-bridge-") && !name.includes("-bin-"))
      if (workspaceDir) {
        fs.appendFileSync(
          path.join(kit.tmp, workspaceDir, "agy-acp.log"),
          "E1113 15:00:00.000000  123 errorreport.go:273] agent executor error: generating and executing: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n",
        )
      }
      await agent.text("\n⚠ Agent execution terminated due to error.\n")
      return { stopReason: "end_turn" }
    })
    const res = await kit.request(baseBody({ system: sdkLine, metadata: { user_id: "fake-429-refused" } }))
    assert.ok(res.status >= 400, `a turned-away 429 must fail the request, got ${res.status}`)
    const errBody = await res.json()
    assert.equal(errBody.error.type, "invalid_request_error",
      `turned-away 429 should be invalid_request_error, got ${JSON.stringify(errBody)}`)
    assert.match(errBody.error.message, /answered 429 to this system prompt/)
  })
})

test("5. #1053/#1055/#1093 & 0.1.29: Gemini 4 Carbon output limit is 262144 and 112 KiB mid-tool-loop replay pins the loop-opening user task", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_INITIAL_PROMPT_BYTES: "4096" } }, async (kit) => {
    const models = await kit.models()
    assert.deepEqual(JSON.parse(JSON.stringify(models["gemini-4-carbon"]?.limit ?? null)), { context: 1048576, output: 262144 })

    kit.prompts.push(async (agent) => {
      await agent.text("replayed")
      return { stopReason: "end_turn" }
    })
    const body = baseBody({
      messages: [
        { role: "user", content: "Turn 1 greeting from earlier completed conversation." },
        { role: "assistant", content: "Hello! Ready for your next task." },
        { role: "user", content: "PINNED_LOOP_TASK_MARKER: refactor the upstream sync pipeline." },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A".repeat(3000) }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { path: "b.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "B".repeat(3000) }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "Read", input: { path: "c.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "latest small tool result" }] },
      ],
    })
    const parsed = await readJson(await kit.request({ ...body, stream: false }))
    assert.equal(parsed.stopReason, "end_turn")
    const sentPrompt = kit.acpLog.find((r) => r.method === "session/prompt")?.params?.prompt
      .filter((p) => p.type === "text").map((p) => p.text).join("") ?? ""
    assert.ok(sentPrompt.includes("PINNED_LOOP_TASK_MARKER"), "mid-tool-loop replay must pin the user task that started the active loop")
  })
})

test("6. #942/#951 & OpenCode 2.x: mid-turn ToolSearch growth starts a second prompt on same session, and opencode.mjs + opencode2.mjs load cleanly", async () => {
  const extraTool = {
    name: "DynamicTool",
    description: "Loaded mid-turn via ToolSearch.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  }
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "discover.txt" })
      await agent.waitCancel()
      return { stopReason: "cancelled" }
    })
    kit.prompts.push(async (agent) => {
      const reply = await agent.tool("DynamicTool", { query: "ping" })
      assert.equal(reply.error, undefined)
      await agent.text("dynamic tool succeeded")
      return { stopReason: "end_turn" }
    })

    const initial = baseBody({ tools: [READ_TOOL], metadata: { user_id: "tools-grew" } })
    const step1 = await readSse(await kit.request(initial))
    assert.equal(step1.stopReason, "tool_use")

    // Client returns tool_result AND adds DynamicTool to tools[] (as Claude Code ToolSearch does).
    const step2Body = { ...continueWithToolResults(initial, step1), tools: [READ_TOOL, extraTool] }
    const step2 = await readSse(await kit.request(step2Body))
    assert.equal(step2.stopReason, "tool_use")
    assert.equal(step2.content.find((b) => b.type === "tool_use")?.name, "DynamicTool")
    // agy only lists tools that existed when the prompt began, so a grown
    // catalog replays the round in a new session (#942) instead of failing.
    assert.ok(kit.acpSpawns.length <= 2, "toolsGrew must not loop-spawn agy processes")

    const final = await readSse(await kit.request(continueWithToolResults(step2Body, step2)))
    assert.equal(final.stopReason, "end_turn")
  })

  const v1 = await import("./opencode.mjs")
  const v2 = await import("./opencode2.mjs")
  assert.equal(v1.default?.id, "yce-magpie-agy")
  assert.equal(typeof v1.default?.server, "function")
  assert.equal(v2.default?.id, "@magpie-community/yce-magpie-agy")
  assert.equal(typeof v2.default?.setup, "function")
})
