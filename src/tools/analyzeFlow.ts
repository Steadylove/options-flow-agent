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
const PER_SIDE = 3;

export interface AnalyzeOptions {
  includeZeroDte?: boolean;
}

export function readIncludeZeroDte(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.INCLUDE_0DTE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

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

function biasSentence(contracts: ScoredContract[]): string {
  const callPremium = sumPremium(contracts, "call");
  const putPremium = sumPremium(contracts, "put");
  if (callPremium === putPremium) {
    return `入选异常合约的看涨与看跌权利金同为 ${fmtUsd(callPremium)}，方向中性。`;
  }
  if (callPremium > putPremium) {
    return `入选异常合约的看涨权利金 ${fmtUsd(callPremium)}，看跌 ${fmtUsd(putPremium)}，权利金净偏多。`;
  }
  return `入选异常合约的看跌权利金 ${fmtUsd(putPremium)}，看涨 ${fmtUsd(callPremium)}，权利金净偏空。`;
}

function sessionClause(summary: OptionsSummary): string {
  if (summary.source !== "theta") return "";
  let callVolume = 0;
  let putVolume = 0;
  let callPremium = 0;
  let putPremium = 0;
  for (const contract of summary.contracts) {
    if (contract.right === "call") {
      callVolume += contract.volume;
      callPremium += contract.premium;
    } else {
      putVolume += contract.volume;
      putPremium += contract.premium;
    }
  }
  return `全场成交看涨 ${fmtInt(callVolume)} 张（${fmtUsd(callPremium)}），看跌 ${fmtInt(putVolume)} 张（${fmtUsd(putPremium)}）。`;
}

function zeroDteClause(zeroDte: ScoredContract[]): string {
  if (zeroDte.length === 0) return "";
  const calls = zeroDte.filter((contract) => contract.right === "call").length;
  const puts = zeroDte.filter((contract) => contract.right === "put");
  const lead = zeroDte[0];
  const leadPut = puts[0];
  const leadText = lead
    ? `最突出的是 ${lead.contract}（成交 ${fmtInt(lead.volume)}，Vol/OI ${lead.volumeOiRatio.toFixed(2)}，权利金 ${fmtUsd(lead.premium)}）`
    : "没有可点名的合约";
  const putText = leadPut
    ? `；看跌一侧最突出的是 ${leadPut.contract}（成交 ${fmtInt(leadPut.volume)}，Vol/OI ${leadPut.volumeOiRatio.toFixed(2)}，权利金 ${fmtUsd(leadPut.premium)}）`
    : "";
  return `另有 ${zeroDte.length} 张当日到期合约达到阈值（看涨 ${calls}、看跌 ${puts.length}），默认不参与排名，因为到期日 Vol/OI 容易偏高；${leadText}${putText}。INCLUDE_0DTE=1 或 --include-0dte 可纳入。`;
}

function buildObservations(
  unusual: ScoredContract[],
  qualifying: ScoredContract[],
  zeroDte: ScoredContract[],
  summary: OptionsSummary,
): [string, string, string] {
  const session = sessionClause(summary);
  if (unusual.length === 0) {
    if (zeroDte.length > 0) {
      const lead = zeroDte[0];
      return [
        `达到阈值的合约都在当日到期，默认不放进异常表。${session}`,
        zeroDteClause(zeroDte),
        lead
          ? `若要把当日到期算进排名，看 ${lead.contract}。到期日的 Vol/OI 天然偏高，不宜单独当成方向。`
          : "到期日的 Vol/OI 天然偏高，不宜单独当成方向。",
      ];
    }
    const busiest = [...summary.contracts].sort((a, b) => b.volume - a.volume)[0];
    const busiestText = busiest
      ? `成交量最高的是 ${busiest.contract}（成交 ${fmtInt(busiest.volume)}，Vol/OI ${busiest.volumeOiRatio.toFixed(2)}），仍低于异常阈值。`
      : "摘要里没有可比较的合约。";
    return [
      `时间窗内没有合约同时达到成交量与 Vol/OI 阈值，异常表为空。${session}`,
      busiestText,
      "样本被阈值滤空时，不把零星成交解读成方向。",
    ];
  }

  const bias = `${biasSentence(qualifying)}${session}`;

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
  const excluded = zeroDteClause(zeroDte);
  const cluster = `按张数，异常流最多落在 ${topExpiry[0]}（${topExpiry[1].count}/${unusual.length}）；该期限权利金合计 ${fmtUsd(topExpiry[1].premium)}。${excluded}`;

  const lead = unusual[0];
  if (!lead) {
    throw new Error("异常合约列表为空");
  }
  const side = lead.side === "buy" ? "买入" : lead.side === "sell" ? "卖出" : "方向不明";
  const sweep = lead.sweep ? "是扫单" : "不是扫单";
  const leadText = `最突出的是 ${lead.contract}：成交 ${fmtInt(lead.volume)}，未平仓 ${fmtInt(lead.openInterest)}，Vol/OI ${lead.volumeOiRatio.toFixed(2)}，权利金 ${fmtUsd(lead.premium)}，记为${side}，${sweep}。`;

  return [bias, cluster, leadText];
}

function byScore(a: ScoredContract, b: ScoredContract): number {
  return b.score - a.score || b.premium - a.premium || a.contract.localeCompare(b.contract);
}

function selectBalanced(contracts: ScoredContract[]): ScoredContract[] {
  const calls = contracts.filter((contract) => contract.right === "call").slice(0, PER_SIDE);
  const puts = contracts.filter((contract) => contract.right === "put").slice(0, PER_SIDE);
  return [...calls, ...puts].sort(byScore);
}

function sessionDay(summary: OptionsSummary): string {
  const fromWindow = summary.window.match(/^(\d{4}-\d{2}-\d{2})\b/);
  if (fromWindow?.[1]) return fromWindow[1];
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(summary.asOf));
}

export function analyzeSummary(summary: OptionsSummary, options: AnalyzeOptions = {}): FlowAnalysis {
  const day = sessionDay(summary);
  const scored = summary.contracts
    .filter(isUnusual)
    .map((contract) => ({ ...contract, score: scoreOf(contract) }))
    .sort(byScore);
  const zeroDte = options.includeZeroDte ? [] : scored.filter((contract) => contract.expiry === day);
  const qualifying = options.includeZeroDte ? scored : scored.filter((contract) => contract.expiry !== day);
  const unusual = selectBalanced(qualifying);

  return flowAnalysisSchema.parse({
    unusual,
    observations: buildObservations(unusual, qualifying, zeroDte, summary),
    callPremium: sumPremium(qualifying, "call"),
    putPremium: sumPremium(qualifying, "put"),
    sampleSize: summary.contracts.length,
  });
}

export function createAnalyzeFlowTool(options?: AnalyzeOptions): AgentTool {
  return {
    name: "analyzeFlow",
    description:
      "根据期权摘要标出异常合约（成交量≥1000，且 Vol/OI≥2，或扫单且 Vol/OI≥1.5）。默认去掉当日到期。看涨、看跌各取最多 3 张，并给出恰好 3 条观察。把 fetchOptionsSummary 的返回值放在 summary 字段。",
    parameters: inputSchema,
    jsonSchema,
    execute: async (input) =>
      analyzeSummary(input.summary, { includeZeroDte: options?.includeZeroDte ?? readIncludeZeroDte() }),
  };
}
