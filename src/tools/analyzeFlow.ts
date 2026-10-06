import { z } from "zod";
import { fmtInt, fmtUsd, round2 } from "../format.js";
import {
  optionContractSchema,
  optionsSummarySchema,
  type OptionContract,
  type OptionsSummary,
} from "../providers/types.js";
import type { AgentTool } from "./types.js";

const MIN_VOLUME = 1000;
const MIN_VOL_OI = 2;
const SWEEP_VOL_OI = 1.5;
const SWEEP_WEIGHT = 1.25;
const MAX_UNUSUAL = 5;

export const scoredContractSchema = optionContractSchema.extend({
  score: z.number().nonnegative(),
});

export const flowAnalysisSchema = z.object({
  unusual: z.array(scoredContractSchema),
  observations: z.tuple([
    z.string().min(1),
    z.string().min(1),
    z.string().min(1),
  ]),
  callPremium: z.number().nonnegative(),
  putPremium: z.number().nonnegative(),
  sampleSize: z.number().int().nonnegative(),
});

export type ScoredContract = z.infer<typeof scoredContractSchema>;
export type FlowAnalysis = z.infer<typeof flowAnalysisSchema>;

const inputSchema = z.object({
  summary: optionsSummarySchema,
});

const jsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "object",
      description: "fetchOptionsSummary 返回的完整摘要，原样传入",
    },
  },
  required: ["summary"],
};

function isUnusual(contract: OptionContract): boolean {
  if (contract.volume < MIN_VOLUME) return false;
  if (contract.volumeOiRatio >= MIN_VOL_OI) return true;
  return contract.sweep && contract.volumeOiRatio >= SWEEP_VOL_OI;
}

function scoreOf(contract: OptionContract): number {
  const weight = contract.sweep ? SWEEP_WEIGHT : 1;
  const premium = Math.max(contract.premium, 1);
  return round2(contract.volumeOiRatio * weight * Math.log10(premium));
}

function sumPremium(contracts: ScoredContract[], right: "call" | "put"): number {
  return contracts
    .filter((contract) => contract.right === right)
    .reduce((total, contract) => total + contract.premium, 0);
}

function buildObservations(
  unusual: ScoredContract[],
  summary: OptionsSummary,
): [string, string, string] {
  if (unusual.length === 0) {
    const busiest = [...summary.contracts].sort((a, b) => b.volume - a.volume)[0];
    const busiestText = busiest
      ? `成交量最高的是 ${busiest.contract}（成交 ${fmtInt(busiest.volume)}，Vol/OI ${busiest.volumeOiRatio.toFixed(2)}），仍低于异常阈值。`
      : "摘要里没有可比较的合约。";
    return [
      "时间窗内没有合约同时达到成交量与 Vol/OI 阈值，异常表为空。",
      busiestText,
      "样本被阈值滤空时，不把零星成交解读成方向。",
    ];
  }

  const callPremium = sumPremium(unusual, "call");
  const putPremium = sumPremium(unusual, "put");
  const bias =
    callPremium === putPremium
      ? `入选异常合约的看涨与看跌权利金同为 ${fmtUsd(callPremium)}，方向中性。`
      : callPremium > putPremium
        ? `入选异常合约的看涨权利金 ${fmtUsd(callPremium)}，看跌 ${fmtUsd(putPremium)}，权利金净偏多。`
        : `入选异常合约的看跌权利金 ${fmtUsd(putPremium)}，看涨 ${fmtUsd(callPremium)}，权利金净偏空。`;

  const byExpiry = new Map<string, { count: number; premium: number }>();
  for (const contract of unusual) {
    const current = byExpiry.get(contract.expiry) ?? { count: 0, premium: 0 };
    current.count += 1;
    current.premium += contract.premium;
    byExpiry.set(contract.expiry, current);
  }
  const topExpiry = [...byExpiry.entries()].sort(
    (a, b) => b[1].count - a[1].count || b[1].premium - a[1].premium,
  )[0];
  if (!topExpiry) {
    throw new Error("异常合约分组为空");
  }
  const cluster = `按张数，异常流最多落在 ${topExpiry[0]}（${topExpiry[1].count}/${unusual.length}）；该期限权利金合计 ${fmtUsd(topExpiry[1].premium)}。`;

  const lead = unusual[0];
  if (!lead) {
    throw new Error("异常合约列表为空");
  }
  const side = lead.side === "buy" ? "买入" : lead.side === "sell" ? "卖出" : "方向不明";
  const sweep = lead.sweep ? "是扫单" : "不是扫单";
  const leadText = `最突出的是 ${lead.contract}：成交 ${fmtInt(lead.volume)}，未平仓 ${fmtInt(lead.openInterest)}，Vol/OI ${lead.volumeOiRatio.toFixed(2)}，权利金 ${fmtUsd(lead.premium)}，记为${side}，${sweep}。`;

  return [bias, cluster, leadText];
}

export function analyzeSummary(summary: OptionsSummary): FlowAnalysis {
  const unusual = summary.contracts
    .filter(isUnusual)
    .map((contract) => ({ ...contract, score: scoreOf(contract) }))
    .sort(
      (a, b) =>
        b.score - a.score || b.premium - a.premium || a.contract.localeCompare(b.contract),
    )
    .slice(0, MAX_UNUSUAL);

  return flowAnalysisSchema.parse({
    unusual,
    observations: buildObservations(unusual, summary),
    callPremium: sumPremium(unusual, "call"),
    putPremium: sumPremium(unusual, "put"),
    sampleSize: summary.contracts.length,
  });
}

export function createAnalyzeFlowTool(): AgentTool {
  return {
    name: "analyzeFlow",
    description:
      "根据期权摘要标出异常合约（成交量≥1000，且 Vol/OI≥2，或扫单且 Vol/OI≥1.5），并给出恰好 3 条观察。把 fetchOptionsSummary 的返回值放在 summary 字段。",
    parameters: inputSchema,
    jsonSchema,
    execute: async (input) => analyzeSummary(input.summary),
  };
}
