import { round2 } from "../format.js";
import { normalizeTicker } from "../ticker.js";
import {
  optionsSummarySchema,
  type FlowSide,
  type OptionContract,
  type OptionRight,
  type OptionsDataProvider,
  type OptionsSummary,
} from "./types.js";

/** 冻结时钟，保证同一 ticker 每次得到同一份简报。 */
const AS_OF = "2026-10-06T20:05:00.000Z";
const WINDOW = "2026-10-06 09:30–16:00 ET";

type Quote = Omit<OptionContract, "volumeOiRatio" | "premium" | "contract"> & {
  contract?: string;
};

function withDerived(input: Quote): OptionContract {
  const volumeOiRatio =
    input.openInterest === 0
      ? input.volume
      : round2(input.volume / input.openInterest);
  const mid = (input.bid + input.ask) / 2;
  const premium = Math.round(input.volume * mid * 100);
  const rightLabel = input.right === "call" ? "C" : "P";
  const strikeLabel = Number.isInteger(input.strike)
    ? String(input.strike)
    : input.strike.toFixed(1);
  const contract =
    input.contract ?? `${input.expiry} ${strikeLabel}${rightLabel}`;
  return { ...input, contract, volumeOiRatio, premium };
}

function tqqqSummary(): OptionsSummary {
  const rows: Quote[] = [
    {
      expiry: "2026-10-09",
      strike: 80,
      right: "call",
      volume: 18420,
      openInterest: 2110,
      last: 2.45,
      bid: 2.38,
      ask: 2.52,
      impliedVol: 0.62,
      delta: 0.46,
      side: "buy",
      sweep: true,
    },
    {
      expiry: "2026-10-09",
      strike: 82,
      right: "call",
      volume: 6420,
      openInterest: 4800,
      last: 1.62,
      bid: 1.55,
      ask: 1.68,
      impliedVol: 0.58,
      delta: 0.38,
      side: "buy",
      sweep: false,
    },
    {
      expiry: "2026-10-16",
      strike: 75,
      right: "put",
      volume: 12840,
      openInterest: 1960,
      last: 1.91,
      bid: 1.85,
      ask: 1.97,
      impliedVol: 0.71,
      delta: -0.32,
      side: "buy",
      sweep: true,
    },
    {
      expiry: "2026-10-16",
      strike: 85,
      right: "call",
      volume: 2150,
      openInterest: 7600,
      last: 0.97,
      bid: 0.92,
      ask: 1.02,
      impliedVol: 0.55,
      delta: 0.28,
      side: "unknown",
      sweep: false,
    },
    {
      expiry: "2026-11-20",
      strike: 90,
      right: "call",
      volume: 7340,
      openInterest: 880,
      last: 2.19,
      bid: 2.1,
      ask: 2.28,
      impliedVol: 0.49,
      delta: 0.31,
      side: "buy",
      sweep: true,
    },
    {
      expiry: "2026-10-09",
      strike: 70,
      right: "put",
      volume: 640,
      openInterest: 15400,
      last: 0.25,
      bid: 0.22,
      ask: 0.28,
      impliedVol: 0.8,
      delta: -0.08,
      side: "sell",
      sweep: false,
    },
    {
      expiry: "2026-10-16",
      strike: 78,
      right: "call",
      volume: 9050,
      openInterest: 3200,
      last: 3.48,
      bid: 3.4,
      ask: 3.55,
      impliedVol: 0.57,
      delta: 0.55,
      side: "buy",
      sweep: true,
    },
    {
      expiry: "2026-11-20",
      strike: 65,
      right: "put",
      volume: 1880,
      openInterest: 2400,
      last: 1.46,
      bid: 1.4,
      ask: 1.52,
      impliedVol: 0.52,
      delta: -0.18,
      side: "sell",
      sweep: false,
    },
  ];

  return optionsSummarySchema.parse({
    ticker: "TQQQ",
    asOf: AS_OF,
    window: WINDOW,
    underlyingPrice: 78.42,
    source: "mock",
    contracts: rows.map((row) => {
      const contract = withDerived(row);
      return {
        ...contract,
        contract: `TQQQ ${contract.expiry} ${formatStrike(row.strike)}${row.right === "call" ? "C" : "P"}`,
      };
    }),
  });
}

function formatStrike(strike: number): string {
  return Number.isInteger(strike) ? String(strike) : strike.toFixed(1);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundStrike(value: number): number {
  if (value >= 100) return Math.max(1, Math.round(value));
  return Math.max(0.5, Math.round(value * 2) / 2);
}

interface GenericSpec {
  expiry: string;
  moneyness: number;
  right: OptionRight;
  unusual: boolean;
  sweep: boolean;
  side: FlowSide;
}

function genericSummary(ticker: string): OptionsSummary {
  const rand = mulberry32(hashString(ticker));
  const underlying = round2(30 + rand() * 120);
  const specs: GenericSpec[] = [
    { expiry: "2026-10-09", moneyness: 1.02, right: "call", unusual: true, sweep: true, side: "buy" },
    { expiry: "2026-10-09", moneyness: 0.98, right: "put", unusual: false, sweep: false, side: "sell" },
    { expiry: "2026-10-16", moneyness: 1.05, right: "call", unusual: true, sweep: false, side: "buy" },
    { expiry: "2026-10-16", moneyness: 0.95, right: "put", unusual: true, sweep: true, side: "buy" },
    { expiry: "2026-10-16", moneyness: 1, right: "call", unusual: false, sweep: false, side: "unknown" },
    { expiry: "2026-11-20", moneyness: 1.1, right: "call", unusual: true, sweep: true, side: "buy" },
    { expiry: "2026-11-20", moneyness: 0.9, right: "put", unusual: false, sweep: false, side: "sell" },
    { expiry: "2026-10-09", moneyness: 1.08, right: "call", unusual: false, sweep: false, side: "unknown" },
  ];

  const used = new Set<string>();
  const contracts = specs.map((spec) => {
    let strike = roundStrike(underlying * spec.moneyness);
    while (used.has(`${spec.expiry}:${strike}:${spec.right}`)) {
      strike = roundStrike(strike + 0.5);
    }
    used.add(`${spec.expiry}:${strike}:${spec.right}`);

    const openInterest = spec.unusual
      ? 400 + Math.floor(rand() * 2000)
      : 3000 + Math.floor(rand() * 12000);
    const volume = spec.unusual
      ? Math.max(1200, Math.round(openInterest * (spec.sweep ? 4 + rand() : 2.4)))
      : Math.max(80, Math.round(openInterest * (0.05 + rand() * 0.35)));
    const intrinsic =
      spec.right === "call"
        ? Math.max(underlying - strike, 0)
        : Math.max(strike - underlying, 0);
    const timeValue = round2(0.35 + rand() * (spec.expiry === "2026-11-20" ? 3.2 : 1.6));
    const mid = round2(Math.max(0.05, intrinsic * 0.35 + timeValue));
    const spread = round2(Math.max(0.01, mid * 0.04));
    const bid = round2(Math.max(0.01, mid - spread));
    const ask = round2(mid + spread);
    const absDelta = round2(
      Math.min(0.85, Math.max(0.08, 0.55 - Math.abs(spec.moneyness - 1) * 3)),
    );

    return withDerived({
      contract: `${ticker} ${spec.expiry} ${formatStrike(strike)}${spec.right === "call" ? "C" : "P"}`,
      expiry: spec.expiry,
      strike,
      right: spec.right,
      volume,
      openInterest,
      last: mid,
      bid,
      ask,
      impliedVol: round2(0.35 + rand() * 0.4),
      delta: spec.right === "call" ? absDelta : -absDelta,
      side: spec.side,
      sweep: spec.sweep,
    });
  });

  return optionsSummarySchema.parse({
    ticker,
    asOf: AS_OF,
    window: WINDOW,
    underlyingPrice: underlying,
    source: "mock",
    contracts,
  });
}

export class MockProvider implements OptionsDataProvider {
  readonly name = "mock";

  async fetchSummary(ticker: string): Promise<OptionsSummary> {
    const normalized = normalizeTicker(ticker);
    const summary = normalized === "TQQQ" ? tqqqSummary() : genericSummary(normalized);
    return structuredClone(summary);
  }
}
