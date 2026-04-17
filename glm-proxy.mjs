/**
 * GLM Proxy - Converts Anthropic Messages API format to OpenAI Chat Completions
 * format for compatibility with ZhipuAI's GLM models.
 *
 * Usage: node glm-proxy.mjs
 * The proxy reads configuration from the current environment and, if present,
 * a local .env.glm file next to this script.
 */

import http from "node:http"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_ENV_PATH = process.env.GLM_ENV_FILE || path.join(SCRIPT_DIR, ".env.glm")
const LOCAL_ENV = loadLocalEnv(LOCAL_ENV_PATH)

function loadLocalEnv(filePath) {
  if (!existsSync(filePath)) {
    return {}
  }

  const result = {}
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) {
      continue
    }

    let [, key, value] = match
    value = value.trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }

  return result
}

function getSetting(name, fallback) {
  if (process.env[name] !== undefined && process.env[name] !== "") {
    return process.env[name]
  }
  if (LOCAL_ENV[name] !== undefined && LOCAL_ENV[name] !== "") {
    return LOCAL_ENV[name]
  }
  return fallback
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseFloatValue(value, fallback) {
  const parsed = Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : fallback
}

const GLM_API_BASE = getSetting(
  "GLM_API_BASE",
  "https://open.bigmodel.cn/api/coding/paas/v4",
)
const GLM_API_KEY = getSetting("GLM_API_KEY", "")
const PROXY_PORT = parseInteger(getSetting("GLM_PROXY_PORT", "3827"), 3827)
const DEFAULT_MODEL = getSetting("GLM_MODEL", "glm-5.1")
const DEFAULT_MAX_TOKENS = parseInteger(
  getSetting("GLM_MAX_TOKENS", "131072"),
  131072,
)
const DEFAULT_TEMPERATURE = parseFloatValue(
  getSetting("GLM_TEMPERATURE", "0.2"),
  0.2,
)
const STREAM_READ_TIMEOUT = parseInteger(
  getSetting("GLM_STREAM_READ_TIMEOUT", "120000"),
  120000,
)

function isTerminationError(err) {
  if (err instanceof DOMException && err.name === "AbortError") return true
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    return (
      msg.includes("terminated") ||
      msg.includes("aborted") ||
      msg.includes("cancel") ||
      msg.includes("timeout") ||
      msg.includes("client disconnected") ||
      msg.includes("econnreset") ||
      msg.includes("socket hang up")
    )
  }
  return false
}

if (!GLM_API_KEY) {
  console.error("[GLM Proxy] Missing GLM_API_KEY.")
  if (existsSync(LOCAL_ENV_PATH)) {
    console.error(
      `[GLM Proxy] Checked local config at ${LOCAL_ENV_PATH}, but GLM_API_KEY was not set.`,
    )
  } else {
    console.error(
      `[GLM Proxy] Set GLM_API_KEY in your environment or create ${LOCAL_ENV_PATH} from .env.glm.example.`,
    )
  }
  process.exit(1)
}

// ============================================================
// Anthropic -> OpenAI request conversion
// ============================================================

function toolResultContentToString(content) {
  if (typeof content === "string") {
    return content
  }
  if (Array.isArray(content)) {
    return content.map(block => block?.text || "").join("")
  }
  return ""
}

function safeParseJson(input, fallback = {}) {
  if (typeof input !== "string" || input.trim() === "") {
    return fallback
  }
  try {
    return JSON.parse(input)
  } catch {
    return { _raw: input }
  }
}

function convertContentBlocks(blocks) {
  const parts = []
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      parts.push(block.text)
    } else if (block.type === "thinking" && block.thinking) {
      parts.push(`<thinking>\n${block.thinking}\n</thinking>`)
    } else if (block.type === "tool_use") {
      parts.push(`[Tool Use: ${block.name}(${JSON.stringify(block.input)})]`)
    } else if (block.type === "tool_result") {
      parts.push(
        `[Tool Result (${block.tool_use_id}): ${toolResultContentToString(block.content)}]`,
      )
    } else if (block.type === "image" && block.source) {
      parts.push(`[Image: ${block.source.media_type}, base64 data]`)
    }
  }
  return parts.join("\n")
}

function convertAnthropicToOpenAI(req) {
  const messages = []

  if (req.system) {
    const systemContent =
      typeof req.system === "string" ? req.system : convertContentBlocks(req.system)
    messages.push({ role: "system", content: systemContent })
  }

  for (const msg of req.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content)) {
      continue
    }

    const toolUseBlocks = msg.content.filter(block => block.type === "tool_use")
    const toolResultBlocks = msg.content.filter(block => block.type === "tool_result")
    const textBlocks = msg.content.filter(
      block => block.type === "text" || block.type === "thinking",
    )

    if (msg.role === "assistant" && toolUseBlocks.length > 0) {
      messages.push({
        role: "assistant",
        content:
          textBlocks
            .map(block => block.text || (block.thinking ? `<thinking>\n${block.thinking}\n</thinking>` : ""))
            .filter(Boolean)
            .join("\n") || null,
        tool_calls: toolUseBlocks.map((block, index) => ({
          id: block.id || `call_${index}`,
          type: "function",
          function: {
            name: block.name,
            arguments:
              typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}),
          },
        })),
      })
      continue
    }

    if (msg.role === "user" && toolResultBlocks.length > 0) {
      const textContent = textBlocks.map(block => block.text || "").join("\n")
      for (const block of toolResultBlocks) {
        messages.push({
          role: "tool",
          tool_call_id: block.tool_use_id || "",
          content: toolResultContentToString(block.content),
        })
      }
      if (textContent) {
        messages.push({ role: "user", content: textContent })
      }
      continue
    }

    const contentParts = []
    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        contentParts.push({ type: "text", text: block.text })
      } else if (block.type === "image" && block.source) {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })
      } else if (block.type === "thinking" && block.thinking) {
        contentParts.push({
          type: "text",
          text: `<thinking>\n${block.thinking}\n</thinking>`,
        })
      }
    }

    messages.push({
      role: msg.role,
      content:
        contentParts.length === 1 && contentParts[0].type === "text"
          ? contentParts[0].text
          : contentParts,
    })
  }

  const openAIReq = {
    model: req.model || DEFAULT_MODEL,
    messages,
    max_tokens: req.max_tokens || DEFAULT_MAX_TOKENS,
    stream: req.stream || false,
    temperature:
      req.temperature !== undefined ? req.temperature : DEFAULT_TEMPERATURE,
  }

  if (req.tools?.length > 0) {
    openAIReq.tools = req.tools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }))
  }

  if (req.tool_choice) {
    if (req.tool_choice.type === "auto") {
      openAIReq.tool_choice = "auto"
    } else if (req.tool_choice.type === "any") {
      openAIReq.tool_choice = "required"
    } else if (req.tool_choice.type === "tool") {
      openAIReq.tool_choice = {
        type: "function",
        function: { name: req.tool_choice.name },
      }
    }
  }

  if (req.stop_sequences) {
    openAIReq.stop = req.stop_sequences
  }

  return openAIReq
}

// ============================================================
// OpenAI -> Anthropic response conversion
// ============================================================

function generateId(prefix = "msg") {
  return `${prefix}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

function mapFinishReason(finishReason, hadToolCalls) {
  if (finishReason === "tool_calls") {
    return "tool_use"
  }
  if (finishReason === "length") {
    return "max_tokens"
  }
  if (finishReason === "stop" || finishReason === "content_filter") {
    return hadToolCalls ? "tool_use" : "end_turn"
  }
  return hadToolCalls ? "tool_use" : "end_turn"
}

function convertOpenAIToAnthropic(openAIResp, model) {
  const choice = openAIResp.choices?.[0]
  if (!choice) {
    return {
      id: generateId(),
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  }

  const content = []
  const message = choice.message || {}
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []

  if (message.content) {
    content.push({ type: "text", text: message.content })
  }

  for (const toolCall of toolCalls) {
    content.push({
      type: "tool_use",
      id: toolCall.id || generateId("toolu"),
      name: toolCall.function?.name || "unknown_tool",
      input: safeParseJson(toolCall.function?.arguments, {}),
    })
  }

  return {
    id: generateId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: openAIResp.usage?.prompt_tokens || 0,
      output_tokens: openAIResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

// ============================================================
// Streaming conversion
// ============================================================

function formatSSE(event, payload) {
  return `event: ${event}\ndata: ${payload}\n\n`
}

function writeSSE(res, event, payload) {
  res.write(formatSSE(event, JSON.stringify(payload)))
}

function ensureTextBlock(res, state) {
  if (state.currentTextBlockIndex !== null) {
    return state.currentTextBlockIndex
  }
  const index = state.nextContentBlockIndex++
  state.currentTextBlockIndex = index
  writeSSE(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  })
  return index
}

function closeTextBlock(res, state) {
  if (state.currentTextBlockIndex === null) {
    return
  }
  writeSSE(res, "content_block_stop", {
    type: "content_block_stop",
    index: state.currentTextBlockIndex,
  })
  state.currentTextBlockIndex = null
}

function ensureThinkingBlock(res, state) {
  if (state.currentThinkingBlockIndex !== null) {
    return state.currentThinkingBlockIndex
  }
  const index = state.nextContentBlockIndex++
  state.currentThinkingBlockIndex = index
  writeSSE(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "" },
  })
  return index
}

function closeThinkingBlock(res, state) {
  if (state.currentThinkingBlockIndex === null) {
    return
  }
  writeSSE(res, "content_block_stop", {
    type: "content_block_stop",
    index: state.currentThinkingBlockIndex,
  })
  state.currentThinkingBlockIndex = null
}

function ensureToolBlock(res, state, toolIndex, toolCall) {
  let record = state.toolCallsByIndex.get(toolIndex)
  if (!record) {
    closeTextBlock(res, state)
    closeThinkingBlock(res, state)

    const index = state.nextContentBlockIndex++
    record = {
      index,
      id: toolCall.id || generateId("toolu"),
      name: toolCall.function?.name || "unknown_tool",
      argumentsText: "",
      closed: false,
    }
    state.toolCallsByIndex.set(toolIndex, record)
    writeSSE(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: record.id,
        name: record.name,
        input: {},
      },
    })
    return record
  }

  if (toolCall.id && !record.id) {
    record.id = toolCall.id
  }
  if (toolCall.function?.name) {
    record.name = toolCall.function.name
  }
  return record
}

function closeToolBlock(res, record) {
  if (record.closed) {
    return
  }
  writeSSE(res, "content_block_stop", {
    type: "content_block_stop",
    index: record.index,
  })
  record.closed = true
}

async function streamOpenAIToAnthropic(glmResp, res, model, clientReq) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })

  const messageId = generateId()
  const state = {
    nextContentBlockIndex: 0,
    currentTextBlockIndex: null,
    currentThinkingBlockIndex: null,
    toolCallsByIndex: new Map(),
    hadToolCalls: false,
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
  }

  writeSSE(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  // Track client disconnect and read timeout
  let clientDisconnected = false
  let readTimeoutTimer = null

  const onClientClose = () => {
    clientDisconnected = true
    if (readTimeoutTimer) clearTimeout(readTimeoutTimer)
    console.warn("[GLM Proxy] Client disconnected — aborting upstream reader")
  }

  if (clientReq) {
    clientReq.on("close", onClientClose)
  }

  try {
    const reader = glmResp.body?.getReader()
    if (!reader) {
      throw new Error("GLM response did not include a readable stream body")
    }

    const decoder = new TextDecoder()
    let buffer = ""

    while (!clientDisconnected) {
      // Set per-chunk read timeout
      if (readTimeoutTimer) clearTimeout(readTimeoutTimer)
      readTimeoutTimer = setTimeout(() => {
        console.warn("[GLM Proxy] Stream read timeout — aborting upstream reader")
        reader.cancel().catch(() => {})
      }, STREAM_READ_TIMEOUT)

      let readResult
      try {
        readResult = await reader.read()
      } catch (readErr) {
        if (isTerminationError(readErr) || clientDisconnected) {
          break
        }
        throw readErr
      }

      const { done, value } = readResult
      if (done) {
        break
      }

      // Reset read timeout on each successful chunk
      if (readTimeoutTimer) clearTimeout(readTimeoutTimer)
      readTimeoutTimer = setTimeout(() => {
        console.warn("[GLM Proxy] Stream read timeout — aborting upstream reader")
        reader.cancel().catch(() => {})
      }, STREAM_READ_TIMEOUT)

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(":")) {
          continue
        }
        if (!trimmed.startsWith("data: ")) {
          continue
        }

        const payload = trimmed.slice(6)
        if (payload === "[DONE]") {
          continue
        }

        let data
        try {
          data = JSON.parse(payload)
        } catch {
          continue
        }

        const choice = data.choices?.[0] || {}
        const delta = choice.delta || {}
        if (choice.finish_reason) {
          state.finishReason = choice.finish_reason
        }

        if (data.usage) {
          state.inputTokens = data.usage.prompt_tokens || state.inputTokens
          state.outputTokens = data.usage.completion_tokens || state.outputTokens
        }

        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          const index = ensureThinkingBlock(res, state)
          writeSSE(res, "content_block_delta", {
            type: "content_block_delta",
            index,
            delta: {
              type: "thinking_delta",
              thinking: delta.reasoning_content,
            },
          })
        }

        if (typeof delta.content === "string" && delta.content) {
          closeThinkingBlock(res, state)
          const index = ensureTextBlock(res, state)
          writeSSE(res, "content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: delta.content },
          })
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls) {
            const toolIndex =
              typeof toolCall.index === "number"
                ? toolCall.index
                : state.toolCallsByIndex.size
            const record = ensureToolBlock(res, state, toolIndex, toolCall)
            state.hadToolCalls = true

            if (toolCall.function?.arguments) {
              record.argumentsText += toolCall.function.arguments
              writeSSE(res, "content_block_delta", {
                type: "content_block_delta",
                index: record.index,
                delta: {
                  type: "input_json_delta",
                  partial_json: toolCall.function.arguments,
                },
              })
            }
          }
        }
      }
    }

    closeThinkingBlock(res, state)
    closeTextBlock(res, state)

    const orderedToolBlocks = Array.from(state.toolCallsByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, record]) => record)
    for (const record of orderedToolBlocks) {
      closeToolBlock(res, record)
    }

    const stopReason = mapFinishReason(state.finishReason, state.hadToolCalls)
    writeSSE(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: state.outputTokens },
    })
    writeSSE(res, "message_stop", {
      type: "message_stop",
      usage: {
        input_tokens: state.inputTokens,
        output_tokens: state.outputTokens,
      },
    })
  } catch (streamErr) {
    if (isTerminationError(streamErr) || clientDisconnected) {
      console.warn(
        `[GLM Proxy] Stream ended prematurely (${streamErr instanceof Error ? streamErr.message : String(streamErr)})`,
      )
    } else {
      console.error("[GLM Proxy] Stream error:", streamErr)
    }
    // Headers are already sent, so send an SSE error event and end gracefully
    try {
      closeThinkingBlock(res, state)
      closeTextBlock(res, state)
      for (const record of state.toolCallsByIndex.values()) {
        closeToolBlock(res, record)
      }
      writeSSE(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: state.outputTokens },
      })
      writeSSE(res, "message_stop", {
        type: "message_stop",
        usage: {
          input_tokens: state.inputTokens,
          output_tokens: state.outputTokens,
        },
      })
    } catch {
      // Best-effort cleanup; the connection may already be broken
    }
  } finally {
    if (readTimeoutTimer) clearTimeout(readTimeoutTimer)
    if (clientReq) clientReq.off("close", onClientClose)
  }
  res.end()
}

// ============================================================
// Request helpers
// ============================================================

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", chunk => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function sendAnthropicError(res, status, type, message) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(
    JSON.stringify({
      type: "error",
      error: { type, message },
    }),
  )
}

async function forwardToGLM(openAIReq, timeoutMs = 300000) {
  const glmUrl = `${GLM_API_BASE}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(glmUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GLM_API_KEY}`,
      },
      body: JSON.stringify(openAIReq),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================
// HTTP Server
// ============================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PROXY_PORT}`)

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "*")

  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        status: "ok",
        proxy: "glm",
        model: DEFAULT_MODEL,
        config: existsSync(LOCAL_ENV_PATH) ? "env+.env.glm" : "env",
      }),
    )
    return
  }

  if (url.pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        data: [
          {
            id: DEFAULT_MODEL,
            object: "model",
            created: Date.now(),
            owned_by: "zhipuai",
          },
        ],
      }),
    )
    return
  }

  if (url.pathname === "/v1/messages" && req.method === "POST") {
    try {
      const body = await readBody(req)
      const anthropicReq = JSON.parse(body)
      const model = anthropicReq.model || DEFAULT_MODEL

      console.log(
        `[GLM Proxy] Request: model=${model}, stream=${Boolean(
          anthropicReq.stream,
        )}, messages=${anthropicReq.messages?.length || 0}, tools=${
          anthropicReq.tools?.length || 0
        }`,
      )

      const openAIReq = convertAnthropicToOpenAI(anthropicReq)
      openAIReq.model = DEFAULT_MODEL

      const glmResp = await forwardToGLM(openAIReq)
      if (!glmResp.ok) {
        let errText
        try {
          errText = await glmResp.text()
        } catch (textErr) {
          errText = isTerminationError(textErr)
            ? "(connection terminated while reading error response)"
            : `(failed to read error body: ${textErr instanceof Error ? textErr.message : String(textErr)})`
        }
        console.error(`[GLM Proxy] GLM API error: ${glmResp.status} ${errText}`)
        sendAnthropicError(
          res,
          glmResp.status,
          "api_error",
          `GLM API error: ${glmResp.status} - ${errText}`,
        )
        return
      }

      if (anthropicReq.stream) {
        await streamOpenAIToAnthropic(glmResp, res, model, req)
        return
      }

      let openAIData
      try {
        openAIData = await glmResp.json()
      } catch (jsonErr) {
        if (isTerminationError(jsonErr)) {
          console.warn(`[GLM Proxy] Non-stream response terminated: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`)
          if (!res.headersSent) {
            sendAnthropicError(res, 502, "api_error", "GLM API connection was terminated before response completed")
          }
          return
        }
        throw jsonErr
      }
      const anthropicResp = convertOpenAIToAnthropic(openAIData, model)
      console.log(
        `[GLM Proxy] Response: stop_reason=${anthropicResp.stop_reason}, content_blocks=${anthropicResp.content?.length || 0}`,
      )
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(anthropicResp))
      return
    } catch (err) {
      if (isTerminationError(err)) {
        console.warn(`[GLM Proxy] Request aborted (${err instanceof Error ? err.message : String(err)})`)
      } else {
        console.error("[GLM Proxy] Request handling error:", err)
      }
      if (res.headersSent) {
        // Headers already sent (e.g. streaming started); cannot send a new response
        console.error("[GLM Proxy] Cannot send error response - headers already sent. Ending connection.")
        try { res.end() } catch { /* ignore */ }
      } else {
        sendAnthropicError(
          res,
          500,
          "server_error",
          `Proxy error: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" })
  res.end("Not Found")
})

server.listen(PROXY_PORT, () => {
  console.log("")
  console.log("============================================================")
  console.log("  GLM Proxy Server (Node.js)")
  console.log("============================================================")
  console.log(`  Proxy:      http://localhost:${PROXY_PORT}`)
  console.log(`  GLM API:    ${GLM_API_BASE}`)
  console.log(`  Model:      ${DEFAULT_MODEL}`)
  console.log(`  Max Tokens: ${DEFAULT_MAX_TOKENS}`)
  console.log("============================================================")
  console.log("")
  console.log("  free-code env vars:")
  console.log("")
  console.log("  set ANTHROPIC_API_KEY=<your_glm_api_key>")
  console.log(`  set ANTHROPIC_BASE_URL=http://localhost:${PROXY_PORT}`)
  console.log("")
  console.log("============================================================")
  console.log("")
})
