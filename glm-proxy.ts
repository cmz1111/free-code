/**
 * GLM Proxy - Converts Anthropic Messages API format to OpenAI Chat Completions
 * format for compatibility with ZhipuAI's GLM models.
 *
 * Usage: bun run glm-proxy.ts
 * The proxy reads configuration from the current environment and, if present,
 * a local .env.glm file next to this script.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

type EnvMap = Record<string, string>

type AnthropicContentBlock =
  | { type: "text"; text?: string }
  | { type: "image"; source?: { type: string; media_type: string; data: string } }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: string | AnthropicContentBlock[] }
  | { type: "thinking"; thinking?: string; text?: string }

type AnthropicMessage = {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

type AnthropicTool = {
  name: string
  description?: string
  input_schema: unknown
}

type AnthropicRequest = {
  model?: string
  messages?: AnthropicMessage[]
  max_tokens?: number
  stream?: boolean
  system?: string | AnthropicContentBlock[]
  temperature?: number
  tools?: AnthropicTool[]
  tool_choice?: { type?: string; name?: string }
  stop_sequences?: string[]
}

type OpenAIRequest = {
  model: string
  messages: Array<Record<string, unknown>>
  max_tokens: number
  stream: boolean
  temperature: number
  tools?: Array<Record<string, unknown>>
  tool_choice?: unknown
  stop?: string[]
}

type StreamToolRecord = {
  index: number
  id: string
  name: string
  argumentsText: string
  closed: boolean
}

const SCRIPT_DIR = import.meta.dir
const LOCAL_ENV_PATH = process.env.GLM_ENV_FILE || path.join(SCRIPT_DIR, ".env.glm")
const LOCAL_ENV = loadLocalEnv(LOCAL_ENV_PATH)

function loadLocalEnv(filePath: string): EnvMap {
  if (!existsSync(filePath)) {
    return {}
  }

  const result: EnvMap = {}
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

function getSetting(name: string, fallback: string): string {
  if (process.env[name] !== undefined && process.env[name] !== "") {
    return process.env[name] as string
  }
  if (LOCAL_ENV[name] !== undefined && LOCAL_ENV[name] !== "") {
    return LOCAL_ENV[name]
  }
  return fallback
}

function parseInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseFloatValue(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value)
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

function isTerminationError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    return (
      msg.includes("terminated") ||
      msg.includes("aborted") ||
      msg.includes("cancel") ||
      msg.includes("timeout") ||
      msg.includes("client disconnected")
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

function toolResultContentToString(
  content: string | AnthropicContentBlock[] | undefined,
): string {
  if (typeof content === "string") {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map(block => ("text" in block && typeof block.text === "string" ? block.text : ""))
      .join("")
  }
  return ""
}

function safeParseJson(input: unknown, fallback: unknown = {}): unknown {
  if (typeof input !== "string" || input.trim() === "") {
    return fallback
  }
  try {
    return JSON.parse(input)
  } catch {
    return { _raw: input }
  }
}

function convertContentBlocks(blocks: AnthropicContentBlock[]): string {
  const parts: string[] = []
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

function convertAnthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
  const messages: Array<Record<string, unknown>> = []

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
            .map(block =>
              block.type === "text"
                ? block.text || ""
                : block.thinking
                  ? `<thinking>\n${block.thinking}\n</thinking>`
                  : "",
            )
            .filter(Boolean)
            .join("\n") || null,
        tool_calls: toolUseBlocks.map((block, index) => ({
          id: block.id || `call_${index}`,
          type: "function",
          function: {
            name: block.name,
            arguments:
              typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input || {}),
          },
        })),
      })
      continue
    }

    if (msg.role === "user" && toolResultBlocks.length > 0) {
      const textContent = textBlocks
        .map(block => ("text" in block && block.text ? block.text : ""))
        .join("\n")
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

    const contentParts: Array<Record<string, unknown>> = []
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
        contentParts.length === 1 && contentParts[0]?.type === "text"
          ? contentParts[0]?.text
          : contentParts,
    })
  }

  const openAIReq: OpenAIRequest = {
    model: req.model || DEFAULT_MODEL,
    messages,
    max_tokens: req.max_tokens || DEFAULT_MAX_TOKENS,
    stream: req.stream || false,
    temperature:
      req.temperature !== undefined ? req.temperature : DEFAULT_TEMPERATURE,
  }

  if (req.tools?.length) {
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
    } else if (req.tool_choice.type === "tool" && req.tool_choice.name) {
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

function generateId(prefix = "msg"): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

function mapFinishReason(
  finishReason: string | null | undefined,
  hadToolCalls: boolean,
): "tool_use" | "max_tokens" | "end_turn" {
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

function convertOpenAIToAnthropic(openAIResp: any, model: string): Record<string, unknown> {
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

  const content: Array<Record<string, unknown>> = []
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

function formatSSE(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

function ensureTextBlock(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: {
    nextContentBlockIndex: number
    currentTextBlockIndex: number | null
  },
): number {
  if (state.currentTextBlockIndex !== null) {
    return state.currentTextBlockIndex
  }
  const index = state.nextContentBlockIndex++
  state.currentTextBlockIndex = index
  controller.enqueue(
    encoder.encode(
      formatSSE("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
    ),
  )
  return index
}

function closeTextBlock(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: {
    currentTextBlockIndex: number | null
  },
): void {
  if (state.currentTextBlockIndex === null) {
    return
  }
  controller.enqueue(
    encoder.encode(
      formatSSE("content_block_stop", {
        type: "content_block_stop",
        index: state.currentTextBlockIndex,
      }),
    ),
  )
  state.currentTextBlockIndex = null
}

function ensureThinkingBlock(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: {
    nextContentBlockIndex: number
    currentThinkingBlockIndex: number | null
  },
): number {
  if (state.currentThinkingBlockIndex !== null) {
    return state.currentThinkingBlockIndex
  }
  const index = state.nextContentBlockIndex++
  state.currentThinkingBlockIndex = index
  controller.enqueue(
    encoder.encode(
      formatSSE("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      }),
    ),
  )
  return index
}

function closeThinkingBlock(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: {
    currentThinkingBlockIndex: number | null
  },
): void {
  if (state.currentThinkingBlockIndex === null) {
    return
  }
  controller.enqueue(
    encoder.encode(
      formatSSE("content_block_stop", {
        type: "content_block_stop",
        index: state.currentThinkingBlockIndex,
      }),
    ),
  )
  state.currentThinkingBlockIndex = null
}

function ensureToolBlock(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: {
    nextContentBlockIndex: number
    toolCallsByIndex: Map<number, StreamToolRecord>
    currentTextBlockIndex: number | null
    currentThinkingBlockIndex: number | null
  },
  toolIndex: number,
  toolCall: any,
): StreamToolRecord {
  let record = state.toolCallsByIndex.get(toolIndex)
  if (!record) {
    closeTextBlock(controller, encoder, state)
    closeThinkingBlock(controller, encoder, state)

    const index = state.nextContentBlockIndex++
    record = {
      index,
      id: toolCall.id || generateId("toolu"),
      name: toolCall.function?.name || "unknown_tool",
      argumentsText: "",
      closed: false,
    }
    state.toolCallsByIndex.set(toolIndex, record)
    controller.enqueue(
      encoder.encode(
        formatSSE("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: record.id,
            name: record.name,
            input: {},
          },
        }),
      ),
    )
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

function closeToolBlock(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  record: StreamToolRecord,
): void {
  if (record.closed) {
    return
  }
  controller.enqueue(
    encoder.encode(
      formatSSE("content_block_stop", {
        type: "content_block_stop",
        index: record.index,
      }),
    ),
  )
  record.closed = true
}

async function streamOpenAIToAnthropic(
  glmResp: Response,
  model: string,
  clientSignal?: AbortSignal,
): Promise<Response> {
  const messageId = generateId()

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const reader = glmResp.body?.getReader()
      if (!reader) {
        throw new Error("GLM response did not include a readable stream body")
      }

      const state = {
        nextContentBlockIndex: 0,
        currentTextBlockIndex: null as number | null,
        currentThinkingBlockIndex: null as number | null,
        toolCallsByIndex: new Map<number, StreamToolRecord>(),
        hadToolCalls: false,
        finishReason: null as string | null,
        inputTokens: 0,
        outputTokens: 0,
      }

      controller.enqueue(
        encoder.encode(
          formatSSE("message_start", {
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
          }),
        ),
      )

      // Stream-level abort controller: aborts when client disconnects or read times out
      const streamAbort = new AbortController()
      let readTimeoutTimer = setTimeout(() => {
        console.warn("[GLM Proxy] Stream read timeout — aborting upstream reader")
        streamAbort.abort()
      }, STREAM_READ_TIMEOUT)

      if (clientSignal) {
        if (clientSignal.aborted) {
          clearTimeout(readTimeoutTimer)
          reader.cancel().catch(() => {})
          controller.close()
          return
        }
        clientSignal.addEventListener(
          "abort",
          () => {
            console.warn("[GLM Proxy] Client disconnected — aborting upstream reader")
            clearTimeout(readTimeoutTimer)
            streamAbort.abort()
          },
          { once: true },
        )
      }

      try {
        const decoder = new TextDecoder()
        let buffer = ""

        while (!streamAbort.signal.aborted) {
          let readResult: { done: boolean; value?: Uint8Array }
          try {
            readResult = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) => {
                streamAbort.signal.addEventListener("abort", () => {
                  reject(new DOMException("Stream read aborted", "AbortError"))
                })
              }),
            ])
          } catch (readErr) {
            if (
              readErr instanceof DOMException &&
              readErr.name === "AbortError"
            ) {
              break
            }
            throw readErr
          }

          const { done, value } = readResult
          if (done) {
            break
          }

          // Reset read timeout on each successful chunk
          clearTimeout(readTimeoutTimer)
          readTimeoutTimer = setTimeout(() => {
            console.warn("[GLM Proxy] Stream read timeout — aborting upstream reader")
            streamAbort.abort()
          }, STREAM_READ_TIMEOUT)

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() || ""

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data: ")) {
              continue
            }

            const payload = trimmed.slice(6)
            if (payload === "[DONE]") {
              continue
            }

            let data: any
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
              const index = ensureThinkingBlock(controller, encoder, state)
              controller.enqueue(
                encoder.encode(
                  formatSSE("content_block_delta", {
                    type: "content_block_delta",
                    index,
                    delta: {
                      type: "thinking_delta",
                      thinking: delta.reasoning_content,
                    },
                  }),
                ),
              )
            }

            if (typeof delta.content === "string" && delta.content) {
              closeThinkingBlock(controller, encoder, state)
              const index = ensureTextBlock(controller, encoder, state)
              controller.enqueue(
                encoder.encode(
                  formatSSE("content_block_delta", {
                    type: "content_block_delta",
                    index,
                    delta: { type: "text_delta", text: delta.content },
                  }),
                ),
              )
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const toolCall of delta.tool_calls) {
                const toolIndex =
                  typeof toolCall.index === "number"
                    ? toolCall.index
                    : state.toolCallsByIndex.size
                const record = ensureToolBlock(
                  controller,
                  encoder,
                  state,
                  toolIndex,
                  toolCall,
                )
                state.hadToolCalls = true

                if (toolCall.function?.arguments) {
                  record.argumentsText += toolCall.function.arguments
                  controller.enqueue(
                    encoder.encode(
                      formatSSE("content_block_delta", {
                        type: "content_block_delta",
                        index: record.index,
                        delta: {
                          type: "input_json_delta",
                          partial_json: toolCall.function.arguments,
                        },
                      }),
                    ),
                  )
                }
              }
            }
          }
        }

        closeThinkingBlock(controller, encoder, state)
        closeTextBlock(controller, encoder, state)

        const orderedToolBlocks = Array.from(state.toolCallsByIndex.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, record]) => record)
        for (const record of orderedToolBlocks) {
          closeToolBlock(controller, encoder, record)
        }

        controller.enqueue(
          encoder.encode(
            formatSSE("message_delta", {
              type: "message_delta",
              delta: {
                stop_reason: mapFinishReason(state.finishReason, state.hadToolCalls),
                stop_sequence: null,
              },
              usage: { output_tokens: state.outputTokens },
            }),
          ),
        )
        controller.enqueue(
          encoder.encode(
            formatSSE("message_stop", {
              type: "message_stop",
              usage: {
                input_tokens: state.inputTokens,
                output_tokens: state.outputTokens,
              },
            }),
          ),
        )
      } catch (streamErr) {
        if (isTerminationError(streamErr)) {
          // Client disconnect or upstream termination — not a bug, just log at info level
          console.warn(
            `[GLM Proxy] Stream ended prematurely (${streamErr instanceof Error ? streamErr.message : String(streamErr)})`,
          )
        } else {
          console.error("[GLM Proxy] Stream error:", streamErr)
        }
        // Best-effort cleanup via the ReadableStream controller
        try {
          closeThinkingBlock(controller, encoder, state)
          closeTextBlock(controller, encoder, state)
          for (const record of state.toolCallsByIndex.values()) {
            closeToolBlock(controller, encoder, record)
          }
          controller.enqueue(
            encoder.encode(
              formatSSE("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: state.outputTokens },
              }),
            ),
          )
          controller.enqueue(
            encoder.encode(
              formatSSE("message_stop", {
                type: "message_stop",
                usage: {
                  input_tokens: state.inputTokens,
                  output_tokens: state.outputTokens,
                },
              }),
            ),
          )
        } catch {
          // Best-effort cleanup; the stream may already be closed
        }
      } finally {
        clearTimeout(readTimeoutTimer)
        reader.cancel().catch(() => {})
      }
      controller.close()
    },
  })

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

async function forwardToGLM(
  openAIReq: OpenAIRequest,
  timeoutMs: number = 300000,
  clientSignal?: AbortSignal,
): Promise<Response> {
  const glmUrl = `${GLM_API_BASE}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Also abort upstream if the client disconnects during the initial fetch
  if (clientSignal) {
    if (clientSignal.aborted) {
      clearTimeout(timer)
      controller.abort()
    } else {
      clientSignal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          controller.abort()
        },
        { once: true },
      )
    }
  }

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

const server = Bun.serve({
  port: PROXY_PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      })
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          proxy: "glm",
          model: DEFAULT_MODEL,
          config: existsSync(LOCAL_ENV_PATH) ? "env+.env.glm" : "env",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    if (url.pathname === "/v1/models") {
      return new Response(
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
        {
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    if (url.pathname === "/v1/messages" && req.method === "POST") {
      try {
        const anthropicReq = (await req.json()) as AnthropicRequest
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

        const glmResp = await forwardToGLM(openAIReq, 300000, req.signal)
        if (!glmResp.ok) {
          let errText: string
          try {
            errText = await glmResp.text()
          } catch (textErr) {
            errText = isTerminationError(textErr)
              ? "(connection terminated while reading error response)"
              : `(failed to read error body: ${textErr instanceof Error ? textErr.message : String(textErr)})`
          }
          console.error(`[GLM Proxy] GLM API error: ${glmResp.status} ${errText}`)
          return new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "api_error",
                message: `GLM API error: ${glmResp.status} - ${errText}`,
              },
            }),
            {
              status: glmResp.status,
              headers: { "Content-Type": "application/json" },
            },
          )
        }

        if (anthropicReq.stream) {
          return await streamOpenAIToAnthropic(glmResp, model, req.signal)
        }

        let openAIData: any
        try {
          openAIData = await glmResp.json()
        } catch (jsonErr) {
          if (isTerminationError(jsonErr)) {
            console.warn(
              `[GLM Proxy] Non-stream response terminated: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
            )
            return new Response(
              JSON.stringify({
                type: "error",
                error: {
                  type: "api_error",
                  message: "GLM API connection was terminated before response completed",
                },
              }),
              {
                status: 502,
                headers: { "Content-Type": "application/json" },
              },
            )
          }
          throw jsonErr
        }
        const anthropicResp = convertOpenAIToAnthropic(openAIData, model)
        console.log(
          `[GLM Proxy] Response: stop_reason=${String(
            anthropicResp.stop_reason,
          )}, content_blocks=${Array.isArray(anthropicResp.content) ? anthropicResp.content.length : 0}`,
        )
        return new Response(JSON.stringify(anthropicResp), {
          headers: { "Content-Type": "application/json" },
        })
      } catch (err) {
        if (isTerminationError(err)) {
          console.warn(
            `[GLM Proxy] Request aborted (${err instanceof Error ? err.message : String(err)})`,
          )
        } else {
          console.error("[GLM Proxy] Request handling error:", err)
        }
        // In the Bun version headers are managed by the Response object,
        // so double-write is unlikely, but we still return a safe error.
        return new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "server_error",
              message: `Proxy error: ${err instanceof Error ? err.message : String(err)}`,
            },
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        )
      }
    }

    return new Response("Not Found", { status: 404 })
  },
})

console.log("")
console.log("============================================================")
console.log("  GLM Proxy Server")
console.log("============================================================")
console.log(`  Proxy:      http://localhost:${server.port}`)
console.log(`  GLM API:    ${GLM_API_BASE}`)
console.log(`  Model:      ${DEFAULT_MODEL}`)
console.log(`  Max Tokens: ${DEFAULT_MAX_TOKENS}`)
console.log("============================================================")
console.log("")
console.log("  free-code env vars:")
console.log("")
console.log("  set ANTHROPIC_API_KEY=<your_glm_api_key>")
console.log(`  set ANTHROPIC_BASE_URL=http://localhost:${server.port}`)
console.log("")
console.log("============================================================")
console.log("")
