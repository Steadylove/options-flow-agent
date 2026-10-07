import { z } from "zod";
import {
  optionsSummarySchema,
  type OptionsDataProvider,
} from "../providers/types.js";
import type { AgentTool } from "./types.js";

const inputSchema = z.object({
  ticker: z.string().min(1),
});

const jsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    ticker: {
      type: "string",
      description: "标的代码，例如 TQQQ",
    },
  },
  required: ["ticker"],
};

export function createFetchOptionsSummaryTool(
  provider: OptionsDataProvider,
): AgentTool {
  return {
    name: "fetchOptionsSummary",
    description:
      "按 ticker 拉取期权流摘要。默认来自 MockProvider；OPTIONS_DATA_PROVIDER=theta 时来自 ThetaProvider。不要编造行情，必须调用此工具。",
    parameters: inputSchema,
    jsonSchema,
    execute: async (input) => {
      const summary = await provider.fetchSummary(input.ticker);
      return optionsSummarySchema.parse(summary);
    },
  };
}
