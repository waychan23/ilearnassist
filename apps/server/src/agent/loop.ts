import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ChatStreamEvent, Copilot, Message, ToolCall, Workspace } from "@guided-learning/shared";
import type { AppConfig } from "../config.js";
import { buildModel } from "./model.js";

const MAX_STEPS = 15;

export interface RunAgentResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface RunAgentInput {
  config: AppConfig;
  workspace: Workspace;
  copilot?: Copilot;
  providerId?: string;
  modelId?: string;
  /** Prior persisted user/assistant messages (oldest first). */
  history: Message[];
  userMessage: string;
  tools: StructuredToolInterface[];
  onEvent: (event: ChatStreamEvent) => void;
}

/** Turn a chunk's `content` (string OR complex content blocks) into plain text. */
function chunkText(chunk: AIMessageChunk): string {
  const c = chunk.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
          return block.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function buildSystemPrompt(workspace: Workspace, copilot?: Copilot): string {
  const base =
    copilot?.systemPrompt?.trim() ||
    "You are a helpful, precise AI assistant. You can use file tools to read and write files inside the user's active workspace, and a web_search tool to look up current information. Prefer giving the answer directly, and only use tools when they are genuinely needed.";

  const workspaceNote =
    `\n\nThe user is working inside a workspace located at:\n${workspace.dirPath}\n` +
    `All file tools are sandboxed to this directory. Use paths relative to it ` +
    `(or absolute paths under it). Never attempt to access files outside this directory.`;

  return base + workspaceNote;
}

/**
 * A basic, bounded ReAct agent loop over LangChain primitives:
 *   model/stream (token streaming) -> tool calls -> tool execution -> repeat.
 * Emits `text`, `tool_start` and `tool_end` events as it runs.
 */
export async function runAgentStream(input: RunAgentInput): Promise<RunAgentResult> {
  const { llm, modelId } = buildModel(input.config, input.providerId, input.modelId);
  const modelWithTools = llm.bindTools(input.tools);

  const messages: BaseMessage[] = [
    new SystemMessage(buildSystemPrompt(input.workspace, input.copilot)),
    ...input.history.map((m) =>
      m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)
    ),
    new HumanMessage(input.userMessage),
  ];

  const toolByName = new Map<string, StructuredToolInterface>(input.tools.map((t) => [t.name, t]));
  const toolCalls: ToolCall[] = [];
  let finalContent = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    const chunks: AIMessageChunk[] = [];
    const stream = await modelWithTools.stream(messages);

    for await (const chunk of stream) {
      chunks.push(chunk);
      const text = chunkText(chunk);
      if (text) {
        finalContent += text;
        input.onEvent({ type: "text", delta: text });
      }
    }

    if (chunks.length === 0) break;
    const aiMessage = chunks.reduce((acc, c) => acc.concat(c) as AIMessageChunk);
    messages.push(aiMessage);

    const calls = aiMessage.tool_calls ?? [];
    if (calls.length === 0) {
      // No tool calls: the model's final answer is this message's content.
      finalContent = chunkText(aiMessage) || finalContent;
      break;
    }

    for (const call of calls) {
      const id = call.id ?? `call_${step}_${toolCalls.length}`;
      const name = call.name ?? "unknown";
      const args = JSON.stringify(call.args ?? {});

      input.onEvent({ type: "tool_start", toolCall: { id, name, input: args } });

      let output = "";
      const t = toolByName.get(name);
      if (t) {
        try {
          const result = await t.invoke(call.args ?? {});
          output = typeof result === "string" ? result : JSON.stringify(result);
        } catch (err) {
          output = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        output = `Unknown tool "${name}".`;
      }

      toolCalls.push({ id, name, input: args, output });
      input.onEvent({ type: "tool_end", toolCall: { id, name, input: args, output } });

      messages.push(new ToolMessage({ tool_call_id: id, name, content: output }));
    }
  }

  if (!finalContent) {
    finalContent =
      "The assistant ran out of steps while working on this task. Please ask a follow-up to continue.";
  }
  return { content: finalContent, toolCalls };
}

/** Re-exported for clarity at the call site. */
export { buildModel } from "./model.js";