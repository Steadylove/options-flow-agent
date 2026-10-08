import type { OptionsDataProvider } from "../providers/types.js";
import { createAnalyzeFlowTool } from "./analyzeFlow.js";
import { createFetchOptionsSummaryTool } from "./fetchOptionsSummary.js";
import type { AgentTool } from "./types.js";
import { createWriteBriefTool } from "./writeBrief.js";

export function createTools(
  provider: OptionsDataProvider,
  options?: { includeZeroDte?: boolean; minOpenInterest?: number },
): AgentTool[] {
  return [
    createFetchOptionsSummaryTool(provider),
    createAnalyzeFlowTool({
      includeZeroDte: options?.includeZeroDte,
      minOpenInterest: options?.minOpenInterest,
    }),
    createWriteBriefTool(),
  ];
}

export function requireTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`缺少工具 ${name}`);
  }
  return tool;
}
