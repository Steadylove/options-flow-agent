import type { z } from "zod";

export interface AgentTool {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  jsonSchema: Record<string, unknown>;
  execute: (input: any) => Promise<unknown>;
}

export async function callTool(tool: AgentTool, raw: unknown): Promise<unknown> {
  const parsed = tool.parameters.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${tool.name} 参数无效：${detail}`);
  }
  return tool.execute(parsed.data);
}
