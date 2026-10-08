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

export const DEFAULT_MIN_OPEN_INTEREST = 500;

export interface AnalyzeOptions {
  includeZeroDte?: boolean;
  minOpenInterest?: number;
}

export function readIncludeZeroDte(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.INCLUDE_0DTE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function readMinOpenInterest(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_OPEN_INTEREST;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`MIN_OPEN_INTEREST 必须是非负整数，收到 ${raw}。不会改用 Mock。`);
  }
  return Number(raw.trim());
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

interface SideTotals {
  callVolume: number;
  putVolume: number;
  callPremium: number;
  putPremium: number;
}

function sideTotals(contracts: OptionContract[]): SideTotals {
  const totals: SideTotals = { callVolume: 0, putVolume: 0, callPremium: 0, putPremium: 0 };
  for (const contract of contracts) {
    if (contract.right === "call") {
      totals.callVolume += contract.volume;
      totals.callPremium += contract.premium;
    } else {
      totals.putVolume += contract.volume;
      totals.putPremium += contract.premium;
    }
  }
  return totals;
}

function formatBook(totals: SideTotals): string {
  return `看涨 ${fmtInt(totals.callVolume)} 张（${fmtUsd(totals.callPremium)}），看跌 ${fmtInt(totals.putVolume)} 张（${fmtUsd(totals.putPremium)}）`;
}

function sessionClause(summary: OptionsSummary, day: string): string {
  if (summary.source !== "theta") return "";
  const hasZeroDte = summary.contracts.some((contract) => contract.expiry === day);
  const all = sideTotals(summary.contracts);
  if (!hasZeroDte) return `全场：${formatBook(all)}。`;
  const later = sideTotals(summary.contracts.filter((contract) => contract.expiry !== day));
  return `全场含当日到期：${formatBook(all)}。不含当日到期：${formatBook(later)}。`;
}

function concentrationClause(contracts: ScoredContract[], label: "看涨" | "看跌"): string {
  if (contracts.length === 0) return "";
  const total = contracts.reduce((sum, contract) => sum + contract.premium, 0);
  const top = [...contracts].sort((a, b) => b.premium - a.premium || a.contract.localeCompare(b.contract))[0];
  if (!top || top.premium * 2 <= total) return "";
  if (contracts.length === 1) return `${label}权利金全部来自 ${top.contract}。`;
  const pct = Math.round((top.premium * 100) / total);
  return `${top.contract} 占${label}权利金 ${pct}%。`;
}

function directionSentence(contracts: ScoredContract[]): string {
  const calls = contracts.filter((contract) => contract.right === "call");
  const puts = contracts.filter((contract) => contract.right === "put");
  const callPremium = sumPremium(contracts, "call");
  const putPremium = sumPremium(contracts, "put");
  const scope = `全部 ${contracts.length} 张达标合约（看涨 ${calls.length} 张、看跌 ${puts.length} 张）`;
  const money = `看涨权利金 ${fmtUsd(callPremium)}，看跌 ${fmtUsd(putPremium)}`;
  const premiumLean = Math.sign(callPremium - putPremium);
  const countLean = Math.sign(calls.length - puts.length);
  let tone: string;
  if (premiumLean === 0) {
    tone = "权利金相当，方向中性";
  } else if (countLean === 0) {
    tone = premiumLean > 0 ? "张数相当、权利金偏多" : "张数相当、权利金偏空";
  } else if (premiumLean === countLean) {
    tone = premiumLean > 0 ? "张数与权利金都偏多" : "张数与权利金都偏空";
  } else {
    const countWord = countLean > 0 ? "张数偏多" : "张数偏空";
    const premiumWord = premiumLean > 0 ? "权利金偏多" : "权利金偏空";
    tone = `${countWord}、${premiumWord}，方向混杂`;
  }
  const heavier = premiumLean > 0 ? concentrationClause(calls, "看涨") : premiumLean < 0 ? concentrationClause(puts, "看跌") : "";
  return `${scope}：${money}。${tone}。${heavier}`;
}

function expirySentence(table: ScoredContract[], qualifyingCount: number): string {
  const byExpiry = new Map<string, number>();
  for (const contract of table) {
    byExpiry.set(contract.expiry, (byExpiry.get(contract.expiry) ?? 0) + 1);
  }
  const top = [...byExpiry.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!top) throw new Error("异常合约分组为空");
  const scope =
    table.length === qualifyingCount
      ? `表内 ${table.length} 张，即全部达标合约`
      : `表内 ${table.length} 张，全部 ${qualifyingCount} 张达标合约里只展示了这些`;
  return `${scope}。到期最集中在 ${top[0]}（${top[1]} 张）。`;
}

function exclusionNotes(zeroDteCount: number, lowOiCount: number, minOi: number): string {
  const notes: string[] = [];
  if (zeroDteCount > 0) notes.push(`另有 ${zeroDteCount} 张当日到期达标，未进排名。`);
  if (lowOiCount > 0) notes.push(`另有 ${lowOiCount} 张因未平仓低于 ${fmtInt(minOi)} 未入排名。`);
  return notes.join("");
}

function leadSentence(lead: ScoredContract): string {
  const side = lead.side === "buy" ? "买入" : lead.side === "sell" ? "卖出" : "方向不明";
  const sweep = lead.sweep ? "是扫单" : "不是扫单";
  return `表内最突出的是 ${lead.contract}：成交 ${fmtInt(lead.volume)}，未平仓 ${fmtInt(lead.openInterest)}，Vol/OI ${lead.volumeOiRatio.toFixed(2)}，权利金 ${fmtUsd(lead.premium)}，记为${side}，${sweep}。`;
}

function buildObservations(
  unusual: ScoredContract[],
  qualifying: ScoredContract[],
  zeroDteCount: number,
  lowOiCount: number,
  minOi: number,
  summary: OptionsSummary,
  day: string,
): [string, string, string] {
  const session = sessionClause(summary, day);
  const excluded = exclusionNotes(zeroDteCount, lowOiCount, minOi);
  if (unusual.length === 0) {
    if (zeroDteCount > 0 || lowOiCount > 0) {
      return [
        `没有计入排名的达标合约。${session}`,
        `${excluded}到期日的 Vol/OI、以及很小的未平仓，都不单独当成方向。`,
        "异常表为空，没有表内第一名。",
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

  const lead = unusual[0];
  if (!lead) throw new Error("异常合约列表为空");
  return [
    `${directionSentence(qualifying)}${session}`,
    `${expirySentence(unusual, qualifying.length)}${excluded}`,
    leadSentence(lead),
  ];
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
  const minOi = options.minOpenInterest ?? DEFAULT_MIN_OPEN_INTEREST;
  const scored = summary.contracts
    .filter(isUnusual)
    .map((contract) => ({ ...contract, score: scoreOf(contract) }))
    .sort(byScore);
  const lowOi = scored.filter((contract) => contract.openInterest < minOi);
  const eligible = scored.filter((contract) => contract.openInterest >= minOi);
  const zeroDte = options.includeZeroDte ? [] : eligible.filter((contract) => contract.expiry === day);
  const qualifying = options.includeZeroDte ? eligible : eligible.filter((contract) => contract.expiry !== day);
  const unusual = selectBalanced(qualifying);

  return flowAnalysisSchema.parse({
    unusual,
    observations: buildObservations(unusual, qualifying, zeroDte.length, lowOi.length, minOi, summary, day),
    callPremium: sumPremium(qualifying, "call"),
    putPremium: sumPremium(qualifying, "put"),
    sampleSize: summary.contracts.length,
  });
}

export function createAnalyzeFlowTool(options?: AnalyzeOptions): AgentTool {
  return {
    name: "analyzeFlow",
    description:
      "根据期权摘要标出异常合约（成交量≥1000，未平仓默认≥500，且 Vol/OI≥2，或扫单且 Vol/OI≥1.5）。默认去掉当日到期。看涨、看跌各取最多 3 张，并给出恰好 3 条观察。把 fetchOptionsSummary 的返回值放在 summary 字段。",
    parameters: inputSchema,
    jsonSchema,
    execute: async (input) =>
      analyzeSummary(input.summary, {
        includeZeroDte: options?.includeZeroDte ?? readIncludeZeroDte(),
        minOpenInterest: options?.minOpenInterest ?? readMinOpenInterest(process.env.MIN_OPEN_INTEREST),
      }),
  };
}
