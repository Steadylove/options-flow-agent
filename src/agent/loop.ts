import { z } from "zod";
import { createOptionsDataProvider } from "../providers/index.js";
import { optionsSummarySchema } from "../providers/types.js";
import { flowAnalysisSchema } from "../tools/analyzeFlow.js";
import { createTools, requireTool } from "../tools/index.js";
import { callTool, type AgentTool } from "../tools/types.js";
import { writeBriefResultSchema } from "../tools/writeBrief.js";

const MAX_STEPS = 8;

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function").optional(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.string().optional(),
          content: z.string().nullable().optional(),
          tool_calls: z.array(toolCallSchema).optional(),
        }),
      }),
    )
    .min(1),
});

type ToolCall = z.infer<typeof toolCallSchema>;

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AgentResult {
  outputPath: string;
  mode: "deterministic" | "llm";
  provider: string;
}

export async function runAgent(options: { ticker: string }): Promise<AgentResult> {
  const provider = createOptionsDataProvider();
  const tools = createTools(provider);
  const apiKey = process.env.LITELLM_API_KEY?.trim();
  if (!apiKey) {
    return { ...(await runDeterministic(tools, options.ticker)), provider: provider.name };
  }
  return { ...(await runLlm(tools, options.ticker, apiKey)), provider: provider.name };
}

async function runDeterministic(
  tools: AgentTool[],
  ticker: string,
): Promise<Omit<AgentResult, "provider">> {
  const summary = optionsSummarySchema.parse(
    await callTool(requireTool(tools, "fetchOptionsSummary"), { ticker }),
  );
  const analysis = flowAnalysisSchema.parse(
    await callTool(requireTool(tools, "analyzeFlow"), { summary }),
  );
  const written = writeBriefResultSchema.parse(
    await callTool(requireTool(tools, "writeBrief"), {
      ticker: summary.ticker,
      window: summary.window,
      asOf: summary.asOf,
      underlyingPrice: summary.underlyingPrice,
      source: summary.source,
      unusual: analysis.unusual,
      observations: analysis.observations,
      sampleSize: analysis.sampleSize,
    }),
  );
  return { outputPath: written.path, mode: "deterministic" };
}

function liteLlmConfig(apiKey: string): { url: string; apiKey: string; model: string } {
  const base = (process.env.LITELLM_BASE_URL || "http://localhost:4000/v1").replace(/\/$/, "");
  return {
    url: `${base}/chat/completions`,
    apiKey,
    model: process.env.LITELLM_MODEL || "gpt-4o-mini",
  };
}

async function runLlm(
  tools: AgentTool[],
  ticker: string,
  apiKey: string,
): Promise<Omit<AgentResult, "provider">> {
  const config = liteLlmConfig(apiKey);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是期权流研究代理。行情只能来自工具，禁止编造合约或价格。",
        "按顺序调用：",
        "1. fetchOptionsSummary，参数 { ticker }",
        "2. analyzeFlow，把上一步返回值原样放进 summary",
        "3. writeBrief，使用 summary 的 ticker、window、asOf、underlyingPrice、source，以及 analyzeFlow 的 unusual、observations、sampleSize",
        "writeBrief 成功后停止。",
      ].join("\n"),
    },
    {
      role: "user",
      content: `请为 ${ticker} 生成期权流研究简报。`,
    },
  ];

  const openAiTools = tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
    },
  }));

  let outputPath: string | undefined;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const message = await completeChat(config, messages, openAiTools);
    const toolCalls = message.tool_calls ?? [];
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });

    if (toolCalls.length === 0) {
      if (outputPath) return { outputPath, mode: "llm" };
      messages.push({
        role: "user",
        content: "请调用工具完成简报，不要只回复文字。",
      });
      continue;
    }

    for (const toolCall of toolCalls) {
      const content = await runToolCall(tools, toolCall);
      if (toolCall.function.name === "writeBrief") {
        const parsed = writeBriefResultSchema.safeParse(content);
        if (parsed.success) outputPath = parsed.data.path;
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(content),
      });
    }

    if (outputPath) return { outputPath, mode: "llm" };
  }

  throw new Error(`Agent 在 ${MAX_STEPS} 步内没有写完简报。`);
}

async function runToolCall(tools: AgentTool[], toolCall: ToolCall): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === toolCall.function.name);
  if (!tool) {
    return { error: `未知工具 ${toolCall.function.name}` };
  }
  let args: unknown;
  try {
    args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
  } catch {
    return { error: "工具参数不是合法 JSON" };
  }
  try {
    return await callTool(tool, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

async function completeChat(
  config: { url: string; apiKey: string; model: string },
  messages: ChatMessage[],
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
): Promise<z.infer<typeof chatResponseSchema>["choices"][number]["message"]> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LiteLLM 请求失败（${response.status}）：${body.slice(0, 500)}`);
  }

  const parsed = chatResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("LiteLLM 返回了无法识别的 chat completion");
  }
  const choice = parsed.data.choices[0];
  if (!choice) {
    throw new Error("LiteLLM 返回了空的 choices");
  }
  return choice.message;
}
