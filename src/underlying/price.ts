import { z } from "zod";
import { flattenThetaResponse } from "../providers/theta-map.js";

export type HttpGet = (url: string, init?: RequestInit) => Promise<Response>;

export interface UnderlyingQuote {
  price: number;
  note: string;
}

const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

const yahooChartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({
            regularMarketPrice: z.number().positive(),
            regularMarketTime: z.number().int().positive(),
          }),
        }),
      )
      .min(1),
    error: z.unknown().nullable().optional(),
  }),
});

const eodRowSchema = z.object({
  close: z.number().positive(),
  last_trade: z.string().optional(),
  created: z.string().optional(),
});

export function readUnderlyingPriceSource(raw: string | undefined): "yahoo" | "theta-eod" {
  const value = raw?.trim().toLowerCase() || "yahoo";
  if (value === "yahoo" || value === "theta-eod") return value;
  throw new Error(`未知 UNDERLYING_PRICE_SOURCE：${raw}。请使用 yahoo 或 theta-eod。不会改用 Mock。`);
}

export function yahooChartUrl(host: string, ticker: string): string {
  return `${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
}

export function parseYahooChart(payload: unknown): UnderlyingQuote {
  const parsed = yahooChartSchema.safeParse(payload);
  if (!parsed.success || parsed.data.chart.error) {
    throw new Error("Yahoo 图表响应形状无法识别。");
  }
  const meta = parsed.data.chart.result[0]?.meta;
  if (!meta) throw new Error("Yahoo 图表响应形状无法识别。");
  return {
    price: meta.regularMarketPrice,
    note: `Yahoo 实时/延迟 ${formatEtClock(meta.regularMarketTime)}`,
  };
}

export async function fetchYahooQuote(ticker: string, fetchImpl: HttpGet): Promise<UnderlyingQuote> {
  const errors: string[] = [];
  for (const host of YAHOO_HOSTS) {
    const url = yahooChartUrl(host, ticker);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "options-flow-agent" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        errors.push(`${host} HTTP ${response.status}`);
        continue;
      }
      return parseYahooChart(JSON.parse(await response.text()) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${host} ${message}`);
    }
  }
  throw new Error(`Yahoo 图表没有返回 ${ticker} 的价格（${errors.join("；")}）。`);
}

export function parseThetaEod(payload: unknown): UnderlyingQuote {
  const rows = flattenThetaResponse(payload, "stock/history/eod")
    .map((row, index) => {
      const parsed = eodRowSchema.safeParse(row);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          `ThetaData stock/history/eod 第 ${index + 1} 条记录形状不符（${issue?.path.join(".") || "(root)"}：${issue?.message ?? "未知"}）。不会改用 Mock。`,
        );
      }
      return parsed.data;
    })
    .filter((row) => row.close > 0)
    .sort((a, b) => eodSortKey(a).localeCompare(eodSortKey(b)));
  const latest = rows.at(-1);
  const stamp = latest ? (latest.last_trade ?? latest.created ?? "") : "";
  const day = stamp.slice(0, 10);
  if (!latest || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("ThetaData stock/history/eod 没有给出可用的收盘价。不会改用 Mock。");
  }
  return { price: latest.close, note: `Theta 日线收盘 ${day}` };
}

export function formatEtClock(unixSeconds: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(unixSeconds * 1000))
      .map((part) => [part.type, part.value]),
  );
  const hour = (parts.hour ?? "00").padStart(2, "0");
  const minute = (parts.minute ?? "00").padStart(2, "0");
  return `${hour}:${minute} ET`;
}

function eodSortKey(row: { last_trade?: string; created?: string }): string {
  return row.last_trade ?? row.created ?? "";
}
