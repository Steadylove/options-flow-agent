import { normalizeTicker } from "../ticker.js";
import {
  fetchYahooQuote,
  parseThetaEod,
  readUnderlyingPriceSource,
  type UnderlyingQuote,
} from "../underlying/price.js";
import { mapThetaSnapshots } from "./theta-map.js";
import type { OptionsDataProvider, OptionsSummary } from "./types.js";

/**
 * ThetaData v3 REST 由本机 Theta Terminal 提供。
 * 文档默认基址是 http://127.0.0.1:25503/v3 ；staging Terminal 是 http://127.0.0.1:25504/v3。
 * 官方 HTTP 文档没有单独的公有云 REST 主机。Python 客户端直连 MDDS，不走这条 HTTP。
 * 用 THETADATA_BASE_URL 覆盖基址。
 *
 * 认证发生在 Terminal 启动时（THETADATA_API_KEY，或邮箱/密码写入 Terminal 自己的 creds.txt）。
 * 本地 REST 按官方示例是不带 Authorization 的 GET。本进程不要求这些密钥，也不会把它们放进 URL。
 *
 * Options Value 只拉 option ohlc、quote、open_interest。
 * 标的价默认走 Yahoo 图表，失败再用免费的 stock/history/eod。不请求付费的 stock snapshot。
 * trade、implied volatility、greeks 是更高档，这里不调用。
 * 映射在 theta-map.ts。连不上或形状不符时直接失败，不退回 Mock。
 */
export const DEFAULT_THETADATA_BASE_URL = "http://127.0.0.1:25503/v3";

const VALUE_SNAPSHOT_PATHS = {
  ohlc: "/option/snapshot/ohlc",
  quote: "/option/snapshot/quote",
  openInterest: "/option/snapshot/open_interest",
} as const;

export type ThetaSnapshotKind = keyof typeof VALUE_SNAPSHOT_PATHS;

const STOCK_EOD_PATH = "/stock/history/eod";

export type ThetaFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ThetaCredentials {
  apiKey?: string;
  username?: string;
  password?: string;
}

export interface ThetaConfig {
  baseUrl: string;
  credentials?: ThetaCredentials;
  env?: NodeJS.ProcessEnv;
}

export function readThetaConfig(env: NodeJS.ProcessEnv = process.env): ThetaConfig {
  return {
    baseUrl: normalizeBaseUrl(env.THETADATA_BASE_URL),
    credentials: readCredentials(env),
    env,
  };
}

export function buildThetaUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
): string {
  const base = baseUrl.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}?${new URLSearchParams(params).toString()}`;
}

export class ThetaProvider implements OptionsDataProvider {
  readonly name = "theta";
  private readonly baseUrl: string;
  private readonly fetchImpl: ThetaFetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(config: ThetaConfig, fetchImpl: ThetaFetch = fetch) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.env = config.env ?? process.env;
  }

  async fetchSummary(ticker: string): Promise<OptionsSummary> {
    const symbol = normalizeTicker(ticker);
    const priceSource = readUnderlyingPriceSource(this.env.UNDERLYING_PRICE_SOURCE);
    const [ohlc, quote] = await Promise.all([
      this.getSnapshot("ohlc", symbol),
      this.getSnapshot("quote", symbol),
    ]);
    const openInterest = await this.getSnapshot("openInterest", symbol);
    const underlying = await this.loadUnderlying(symbol, priceSource);
    return mapThetaSnapshots({
      ticker: symbol,
      ohlc: parseJson(ohlc, VALUE_SNAPSHOT_PATHS.ohlc),
      quote: parseJson(quote, VALUE_SNAPSHOT_PATHS.quote),
      openInterest: parseJson(openInterest, VALUE_SNAPSHOT_PATHS.openInterest),
      underlyingPrice: underlying.price,
      underlyingPriceNote: underlying.note,
    });
  }

  private async loadUnderlying(
    symbol: string,
    source: "yahoo" | "theta-eod",
  ): Promise<UnderlyingQuote> {
    const errors: string[] = [];
    if (source === "yahoo") {
      try {
        return await fetchYahooQuote(symbol, this.fetchImpl);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      return await this.fetchThetaEod(symbol);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    throw new Error(`标的价格获取失败，不会改用 Mock。\n${errors.join("\n")}`);
  }

  private async fetchThetaEod(symbol: string): Promise<UnderlyingQuote> {
    const end = new Date();
    const start = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000);
    const body = await this.getText(STOCK_EOD_PATH, {
      symbol,
      start_date: formatCompactDate(start),
      end_date: formatCompactDate(end),
      format: "json",
    });
    return parseThetaEod(parseJson(body, STOCK_EOD_PATH));
  }

  async getSnapshot(kind: ThetaSnapshotKind, symbol: string): Promise<string> {
    const path = VALUE_SNAPSHOT_PATHS[kind];
    return this.getText(path, { symbol, expiration: "*", format: "json" });
  }

  private async getText(path: string, params: Record<string, string>): Promise<string> {
    const url = buildThetaUrl(this.baseUrl, path, params);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new Error(
        `无法连接 ThetaData REST（${this.baseUrl}）。请确认 Theta Terminal v3 已用同一套凭证启动。不会改用 Mock。${errorDetail(error)}`,
      );
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `ThetaData 请求失败（${response.status}）${path}：${body.slice(0, 300)}。不会改用 Mock。`,
      );
    }
    return response.text();
  }
}

function readCredentials(env: NodeJS.ProcessEnv): ThetaCredentials {
  const apiKey = env.THETADATA_API_KEY?.trim() || undefined;
  const username = env.THETADATA_USERNAME?.trim() || undefined;
  const password = env.THETADATA_PASSWORD?.trim() || undefined;
  if ((username && !password) || (!username && password)) {
    throw new Error(
      "THETADATA_USERNAME 和 THETADATA_PASSWORD 需要一起设置（账号邮箱和密码）。也可以改用 THETADATA_API_KEY。",
    );
  }
  return { apiKey, username, password };
}

function formatCompactDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replaceAll("-", "");
}

function parseJson(body: string, endpoint: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`ThetaData ${endpoint} 返回的不是 JSON。不会改用 Mock。`);
  }
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message) return `${error.message}（${cause.message}）`;
  return error.message;
}

function normalizeBaseUrl(raw: string | undefined): string {
  const value = (raw?.trim() || DEFAULT_THETADATA_BASE_URL).replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`THETADATA_BASE_URL 不是合法 URL：${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("THETADATA_BASE_URL 只支持 http 或 https。");
  }
  return value;
}
