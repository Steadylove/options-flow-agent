import { normalizeTicker } from "../ticker.js";
import type { OptionsDataProvider, OptionsSummary } from "./types.js";

/**
 * ThetaData v3 REST 由本机 Theta Terminal 提供。
 * 文档默认基址是 http://127.0.0.1:25503/v3 ；staging Terminal 是 http://127.0.0.1:25504/v3。
 * 官方 HTTP 文档没有单独的公有云 REST 主机。Python 客户端直连 MDDS，不走这条 HTTP。
 * 用 THETADATA_BASE_URL 覆盖基址。
 *
 * 认证发生在 Terminal 启动时（THETADATA_API_KEY，或邮箱/密码写入 Terminal 自己的 creds.txt）。
 * 本地 REST 按官方示例是不带 Authorization 的 GET。本进程只检查环境变量里有没有凭证，
 * 不会把密钥放进 URL，也不会写 creds.txt。
 *
 * Options Value 档位可用的快照：ohlc、quote、open_interest。
 * trade 快照是 Standard 档，这里不调用。
 */
export const DEFAULT_THETADATA_BASE_URL = "http://127.0.0.1:25503/v3";

const VALUE_SNAPSHOT_PATHS = {
  ohlc: "/option/snapshot/ohlc",
  quote: "/option/snapshot/quote",
  openInterest: "/option/snapshot/open_interest",
} as const;

export type ThetaSnapshotKind = keyof typeof VALUE_SNAPSHOT_PATHS;

export interface ThetaCredentials {
  apiKey?: string;
  username?: string;
  password?: string;
}

export interface ThetaConfig {
  baseUrl: string;
  credentials: ThetaCredentials;
}

export function missingThetaCredentialsMessage(): string {
  return [
    "已选择 ThetaData（OPTIONS_DATA_PROVIDER=theta），但没有凭证。",
    "在 .env 里设置 THETADATA_API_KEY（门户里的 API key），或同时设置 THETADATA_USERNAME 与 THETADATA_PASSWORD（账号邮箱和密码）。",
    "不要把密钥提交进仓库。本程序不会代写 creds.txt。",
    `然后启动 Theta Terminal v3，再请求 ${DEFAULT_THETADATA_BASE_URL}（可用 THETADATA_BASE_URL 覆盖）。`,
    "没有订阅时请把 OPTIONS_DATA_PROVIDER 留空或设为 mock。这里不会自动退回 Mock。",
  ].join("\n");
}

export function readThetaConfig(env: NodeJS.ProcessEnv = process.env): ThetaConfig {
  const credentials = readCredentials(env);
  assertThetaCredentials(credentials);
  return {
    baseUrl: normalizeBaseUrl(env.THETADATA_BASE_URL),
    credentials,
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

  constructor(config: ThetaConfig) {
    assertThetaCredentials(config.credentials);
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  async fetchSummary(ticker: string): Promise<OptionsSummary> {
    const symbol = normalizeTicker(ticker);
    const body = await this.getSnapshot("ohlc", symbol);
    throw new Error(
      `ThetaData 已返回 ${symbol} 的 option/snapshot/ohlc（${body.length} 字节），但骨架还不会把它映射成 OptionsSummary。请改用 OPTIONS_DATA_PROVIDER=mock。`,
    );
  }

  async getSnapshot(kind: ThetaSnapshotKind, symbol: string): Promise<string> {
    const path = VALUE_SNAPSHOT_PATHS[kind];
    const url = buildThetaUrl(this.baseUrl, path, {
      symbol,
      expiration: "*",
      format: "json",
    });
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new Error(
        `无法连接 ThetaData REST（${this.baseUrl}）。请确认 Theta Terminal v3 已用同一套凭证启动。${errorDetail(error)}`,
      );
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `ThetaData 请求失败（${response.status}）${path}：${body.slice(0, 300)}`,
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

function assertThetaCredentials(credentials: ThetaCredentials): void {
  if (credentials.apiKey || (credentials.username && credentials.password)) return;
  throw new Error(missingThetaCredentialsMessage());
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
