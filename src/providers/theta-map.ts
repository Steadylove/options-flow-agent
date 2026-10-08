import { z } from "zod";
import { round2 } from "../format.js";
import { normalizeTicker } from "../ticker.js";
import {
  optionsSummarySchema,
  type OptionContract,
  type OptionRight,
  type OptionsSummary,
} from "./types.js";

const EASTERN = "America/New_York";

const ohlcSchema = z.object({
  symbol: z.string().min(1),
  expiration: z.string().min(1),
  strike: z.number().positive(),
  right: z.string().min(1),
  timestamp: z.string().min(1),
  open: z.number().nonnegative().optional(),
  high: z.number().nonnegative().optional(),
  low: z.number().nonnegative().optional(),
  close: z.number().nonnegative(),
  volume: z.number().nonnegative(),
  vwap: z.number().positive().optional(),
});

const quoteSchema = z.object({
  symbol: z.string().min(1),
  expiration: z.string().min(1),
  strike: z.number().positive(),
  right: z.string().min(1),
  bid: z.number().nonnegative(),
  ask: z.number().nonnegative(),
});

const openInterestSchema = z.object({
  symbol: z.string().min(1),
  expiration: z.string().min(1),
  strike: z.number().positive(),
  right: z.string().min(1),
  open_interest: z.number().nonnegative(),
});

type OhlcRow = z.infer<typeof ohlcSchema>;
type QuoteRow = z.infer<typeof quoteSchema>;
type OpenInterestRow = z.infer<typeof openInterestSchema>;

interface Draft {
  symbol: string;
  expiration: string;
  strike: number;
  right: OptionRight;
  timestamp: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  vwap?: number;
  volume: number;
  bid?: number;
  ask?: number;
  openInterest?: number;
}

export interface ThetaSnapshotPayloads {
  ticker: string;
  ohlc: unknown;
  quote: unknown;
  openInterest: unknown;
  underlyingPrice: number;
  underlyingPriceNote: string;
}

export function mapThetaSnapshots(input: ThetaSnapshotPayloads): OptionsSummary {
  const ticker = normalizeTicker(input.ticker);
  const ohlcRows = parseRows(
    flattenThetaResponse(input.ohlc, "option/snapshot/ohlc"),
    ohlcSchema,
    "option/snapshot/ohlc",
  ).filter((row) => row.symbol.toUpperCase() === ticker);
  const quoteRows = parseRows(
    flattenThetaResponse(input.quote, "option/snapshot/quote"),
    quoteSchema,
    "option/snapshot/quote",
  );
  const openInterestRows = parseRows(
    flattenThetaResponse(input.openInterest, "option/snapshot/open_interest"),
    openInterestSchema,
    "option/snapshot/open_interest",
  );

  if (ohlcRows.length === 0) {
    throw new Error("ThetaData option/snapshot/ohlc 没有返回该标的的合约。不会改用 Mock。");
  }
  if (!(input.underlyingPrice > 0)) {
    throw new Error("标的价格无效。不会改用 Mock。");
  }

  const stamped = ohlcRows.map((row) => {
    const timestamp = toIsoDateTime(row.timestamp);
    return { row, timestamp, session: sessionDate(timestamp) };
  });
  const latestSession = stamped.map((row) => row.session).sort().at(-1);
  const currentRows = stamped.filter((row) => row.session === latestSession);
  if (!latestSession || currentRows.length === 0) {
    throw new Error("ThetaData option/snapshot/ohlc 没有最新交易日的成交。不会改用 Mock。");
  }

  const drafts = new Map<string, Draft>();
  for (const { row, timestamp } of currentRows) {
    const identity = identityOf(row);
    const current = drafts.get(identity.key);
    if (current && current.timestamp > timestamp) continue;
    drafts.set(identity.key, {
      symbol: ticker,
      expiration: identity.expiration,
      strike: row.strike,
      right: identity.right,
      timestamp,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      vwap: row.vwap,
      volume: Math.round(row.volume),
      bid: current?.bid,
      ask: current?.ask,
      openInterest: current?.openInterest,
    });
  }

  for (const row of quoteRows) {
    const draft = drafts.get(identityOf(row).key);
    if (!draft) continue;
    draft.bid = row.bid;
    draft.ask = row.ask;
  }
  for (const row of openInterestRows) {
    const draft = drafts.get(identityOf(row).key);
    if (!draft) continue;
    draft.openInterest = Math.round(row.open_interest);
  }

  const contracts = [...drafts.values()]
    .map((draft) => toContract(draft))
    .sort(
      (a, b) =>
        a.expiry.localeCompare(b.expiry) ||
        a.strike - b.strike ||
        a.right.localeCompare(b.right),
    );
  const latest = [...drafts.values()].map((draft) => draft.timestamp).sort().at(-1);
  if (!latest || contracts.length === 0) {
    throw new Error("ThetaData 快照里没有可映射的合约。不会改用 Mock。");
  }

  return optionsSummarySchema.parse({
    ticker,
    asOf: latest,
    window: formatEtWindow(latest),
    underlyingPrice: input.underlyingPrice,
    underlyingPriceNote: input.underlyingPriceNote,
    source: "theta",
    contracts,
  });
}

export function flattenThetaResponse(payload: unknown, endpoint: string): Record<string, unknown>[] {
  const items = topLevelItems(payload, endpoint);
  const rows: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      throw new Error(`ThetaData ${endpoint} 的记录不是对象。不会改用 Mock。`);
    }
    if (Array.isArray(item.data)) {
      const contract = isRecord(item.contract) ? item.contract : {};
      for (const point of item.data) {
        if (!isRecord(point)) {
          throw new Error(`ThetaData ${endpoint} 的 data 元素不是对象。不会改用 Mock。`);
        }
        rows.push({ ...contract, ...point });
      }
      continue;
    }
    rows.push(item);
  }
  return rows;
}

function topLevelItems(payload: unknown, endpoint: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.response)) return payload.response;
  const keys = isRecord(payload) ? Object.keys(payload).slice(0, 8).join(", ") || "（空对象）" : typeof payload;
  throw new Error(
    `ThetaData ${endpoint} 的 JSON 形状无法识别（顶层：${keys}）。期望 { response: [...] }。不会改用 Mock。`,
  );
}

function parseRows<T>(
  rows: Record<string, unknown>[],
  schema: z.ZodType<T>,
  endpoint: string,
): T[] {
  return rows.map((row, index) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") || "(root)";
      throw new Error(
        `ThetaData ${endpoint} 第 ${index + 1} 条记录形状不符（${path}：${issue?.message ?? "未知"}）。不会改用 Mock。`,
      );
    }
    return parsed.data;
  });
}

function identityOf(row: { symbol: string; expiration: string; strike: number; right: string }): {
  key: string;
  expiration: string;
  right: OptionRight;
} {
  const expiration = normalizeExpiry(row.expiration);
  const right = normalizeRight(row.right);
  return {
    key: `${row.symbol.toUpperCase()}|${expiration}|${row.strike}|${right}`,
    expiration,
    right,
  };
}

function toContract(draft: Draft): OptionContract {
  const bid = draft.bid ?? draft.close;
  const ask = draft.ask ?? draft.close;
  const openInterest = draft.openInterest ?? 0;
  const volumeOiRatio =
    draft.openInterest === undefined
      ? 0
      : openInterest === 0
        ? draft.volume
        : round2(draft.volume / openInterest);
  const premium = Math.round(draft.volume * estimateTradePrice(draft, bid, ask) * 100);
  const strikeLabel = Number.isInteger(draft.strike) ? String(draft.strike) : draft.strike.toFixed(1);
  const rightLabel = draft.right === "call" ? "C" : "P";
  return {
    contract: `${draft.symbol} ${draft.expiration} ${strikeLabel}${rightLabel}`,
    expiry: draft.expiration,
    strike: draft.strike,
    right: draft.right,
    volume: draft.volume,
    openInterest,
    volumeOiRatio,
    last: draft.close,
    bid,
    ask,
    impliedVol: 0,
    delta: 0,
    premium,
    side: "unknown",
    sweep: false,
  };
}

function estimateTradePrice(draft: Draft, bid: number, ask: number): number {
  if (draft.vwap !== undefined && draft.vwap > 0) return draft.vwap;
  const { open, high, low, close } = draft;
  if (
    open !== undefined &&
    high !== undefined &&
    low !== undefined &&
    open > 0 &&
    high > 0 &&
    low > 0 &&
    close > 0
  ) {
    return (open + high + low + close) / 4;
  }
  if (close > 0) return close;
  const mid = (bid + ask) / 2;
  return mid > 0 ? mid : close;
}

function sessionDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: EASTERN,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function normalizeExpiry(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  throw new Error(`ThetaData 到期日无法识别：${raw}。不会改用 Mock。`);
}

function normalizeRight(raw: string): OptionRight {
  const value = raw.trim().toLowerCase();
  if (value === "call" || value === "c") return "call";
  if (value === "put" || value === "p") return "put";
  throw new Error(`ThetaData 期权方向无法识别：${raw}。不会改用 Mock。`);
}

export function toIsoDateTime(raw: string): string {
  const match = raw
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d+))?([zZ]|[+-]\d{2}:\d{2})?$/);
  if (!match) {
    throw new Error(`ThetaData 时间无法识别：${raw}。不会改用 Mock。`);
  }
  const fraction = (match[3] ?? "").padEnd(3, "0").slice(0, 3);
  const zone = match[4] ?? "";
  const padded = `${match[1]}.${fraction}${zone}`;
  const date = zone ? new Date(padded) : naiveEasternToUtc(padded);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`ThetaData 时间无法识别：${raw}。不会改用 Mock。`);
  }
  return date.toISOString();
}

function naiveEasternToUtc(localIso: string): Date {
  const utcGuess = new Date(`${localIso}Z`);
  const firstOffset = easternOffsetMinutes(utcGuess);
  let utc = new Date(utcGuess.getTime() - firstOffset * 60_000);
  const refined = easternOffsetMinutes(utc);
  if (refined !== firstOffset) {
    utc = new Date(utcGuess.getTime() - refined * 60_000);
  }
  return utc;
}

function easternOffsetMinutes(instant: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: EASTERN,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

function formatEtWindow(asOfIso: string): string {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: EASTERN,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(asOfIso));
  return `${day} 09:30–16:00 ET`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
