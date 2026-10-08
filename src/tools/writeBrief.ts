import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fmtInt, fmtPx, fmtUsd } from "../format.js";
import { normalizeTicker } from "../ticker.js";
import { flowAnalysisSchema, scoredContractSchema, type ScoredContract } from "./analyzeFlow.js";
import type { AgentTool } from "./types.js";

export const writeBriefInputSchema = z.object({
  ticker: z.string().min(1),
  window: z.string().min(1),
  asOf: z.string().min(1),
  underlyingPrice: z.number().positive(),
  source: z.string().min(1),
  underlyingPriceNote: z.string().min(1).optional(),
  unusual: z.array(scoredContractSchema),
  observations: flowAnalysisSchema.shape.observations,
  sampleSize: z.number().int().nonnegative().optional(),
});

export const writeBriefResultSchema = z.object({
  path: z.string().min(1),
});

export type WriteBriefInput = z.infer<typeof writeBriefInputSchema>;
export type WriteBriefResult = z.infer<typeof writeBriefResultSchema>;

const jsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    ticker: { type: "string" },
    window: { type: "string", description: "摘要里的时间窗" },
    asOf: { type: "string" },
    underlyingPrice: { type: "number" },
    source: { type: "string" },
    underlyingPriceNote: { type: "string", description: "标的价来源与时间，例如 Yahoo 实时/延迟 16:00 ET" },
    unusual: {
      type: "array",
      description: "analyzeFlow 返回的 unusual 数组",
      items: { type: "object" },
    },
    observations: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "string" },
      description: "analyzeFlow 返回的 3 条观察，按顺序原样传入",
    },
    sampleSize: { type: "integer" },
  },
  required: [
    "ticker",
    "window",
    "asOf",
    "underlyingPrice",
    "source",
    "unusual",
    "observations",
  ],
};

function rightLabel(right: ScoredContract["right"]): string {
  return right === "call" ? "看涨" : "看跌";
}

function sideLabel(side: ScoredContract["side"]): string {
  if (side === "buy") return "买入";
  if (side === "sell") return "卖出";
  return "不明";
}

function sourceLabel(source: string): string {
  if (source === "mock") return "MockProvider（固定样本，非实盘行情）";
  if (source === "theta") {
    return "ThetaData Options Value（ohlc / quote / open interest 快照，约 15 分钟延迟；扫单与希腊值不在该档）";
  }
  return source;
}

export function renderBrief(input: WriteBriefInput): string {
  const rows =
    input.unusual.length > 0
      ? input.unusual
          .map(
            (contract) =>
              `| ${contract.contract} | ${contract.expiry} | ${fmtPx(contract.strike)} | ${rightLabel(contract.right)} | ${fmtInt(contract.volume)} | ${fmtInt(contract.openInterest)} | ${contract.volumeOiRatio.toFixed(2)} | ${fmtUsd(contract.premium)} | ${sideLabel(contract.side)} | ${contract.sweep ? "是" : "否"} |`,
          )
          .join("\n")
      : "| （无达到阈值的合约） | — | — | — | — | — | — | — | — | — |";

  const sampleLine =
    input.sampleSize === undefined ? "" : `\n- 样本合约数：${fmtInt(input.sampleSize)}`;
  const priceLine = input.underlyingPriceNote
    ? `- 标的价格：${fmtPx(input.underlyingPrice)}（${input.underlyingPriceNote}）`
    : `- 标的价格：${fmtPx(input.underlyingPrice)}`;

  return `# ${input.ticker} 期权流研究简报

## 标的 / 时间窗

- 标的：${input.ticker}
- 时间窗：${input.window}
- 截止时间：${input.asOf}
${priceLine}
- 数据来源：${sourceLabel(input.source)}${sampleLine}

## 异常合约表

| 合约 | 到期 | 行权价 | 类型 | 成交量 | 未平仓 | Vol/OI | 权利金 | 方向 | 扫单 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## 观察

1. ${input.observations[0]}
2. ${input.observations[1]}
3. ${input.observations[2]}

## 免责声明

本简报由研究代理自动生成，仅用于学习 agent 工作流与复盘，**不是投资建议**。不构成对任何证券的买卖推荐。期权可能在到期时归零。请自行核实数据并独立决策。
`;
}

export function createWriteBriefTool(
  outputDir = path.resolve(process.cwd(), "output"),
): AgentTool {
  return {
    name: "writeBrief",
    description:
      "把异常合约表和 3 条观察写成 Markdown，写入 output/<TICKER>-options-brief.md。observations 必须是恰好 3 条。",
    parameters: writeBriefInputSchema,
    jsonSchema,
    execute: async (input) => {
      const ticker = normalizeTicker(input.ticker);
      const markdown = renderBrief({ ...input, ticker });
      await mkdir(outputDir, { recursive: true });
      const absolute = path.join(outputDir, `${ticker}-options-brief.md`);
      await writeFile(absolute, markdown, "utf8");
      const relative = path.relative(process.cwd(), absolute).split(path.sep).join("/");
      return { path: relative || absolute };
    },
  };
}
