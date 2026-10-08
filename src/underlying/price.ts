import { z } from "zod";
import { flattenThetaResponse } from "../providers/theta-map.js";

export type HttpGet = (url: string, init?: RequestInit) => Promise<Response>;

export interface UnderlyingQuote {
  price: number;
  note: string;
}

const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

const tradingPeriodSchema = z.object({
  start: z.number(),
  end: z.number(),
});

const yahooChartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({
            regularMarketPrice: z.number().positive(),
            regularMarketTime: z.number().int().positive(),
            currentTradingPeriod: z
              .object({
                pre: tradingPeriodSchema.optional(),
                regular: tradingPeriodSchema.optional(),
                post: tradingPeriodSchema.optional(),
              })
              .optional(),
            tradingPeriods: z.array(z.array(tradingPeriodSchema)).optional(),
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
    note: `Yahoo ${yahooSessionKind(meta)} ${formatEtStamp(meta.regularMarketTime)}`,
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

export function formatEtParts(unixSeconds: number): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(unixSeconds * 1000))
      .map((part) => [part.type, part.value]),
  );
  const hour = (parts.hour ?? "00").padStart(2, "0");
  const minute = (parts.minute ?? "00").padStart(2, "0");
  const month = (parts.month ?? "01").padStart(2, "0");
  const day = (parts.day ?? "01").padStart(2, "0");
  return { date: `${parts.year}-${month}-${day}`, time: `${hour}:${minute}` };
}

export function formatEtClock(unixSeconds: number): string {
  return `${formatEtParts(unixSeconds).time} ET`;
}

export function formatEtStamp(unixSeconds: number): string {
  const parts = formatEtParts(unixSeconds);
  return `${parts.date} ${parts.time} ET`;
}

function yahooSessionKind(meta: {
  regularMarketTime: number;
  currentTradingPeriod?: {
    pre?: { start: number; end: number };
    regular?: { start: number; end: number };
    post?: { start: number; end: number };
  };
  tradingPeriods?: { start: number; end: number }[][];
}): string {
  const time = meta.regularMarketTime;
  const chartPeriod = meta.tradingPeriods?.flat().find((period) => time >= period.start && time <= period.end);
  if (chartPeriod) return time >= chartPeriod.end ? "常规交易收盘" : "盘中延迟";
  const current = meta.currentTradingPeriod;
  if (current?.regular && time >= current.regular.start && time <= current.regular.end) {
    return time >= current.regular.end ? "常规交易收盘" : "盘中延迟";
  }
  if (current?.pre && time >= current.pre.start && time < current.pre.end) return "盘前";
  if (current?.post && time >= current.post.start && time < current.post.end) return "盘后";
  const clock = formatEtParts(time).time;
  if (clock === "16:00") return "常规交易收盘";
  if (clock > "16:00") return "盘后";
  if (clock < "09:30") return "盘前";
  return "盘中延迟";
}

function eodSortKey(row: { last_trade?: string; created?: string }): string {
  return row.last_trade ?? row.created ?? "";
}
