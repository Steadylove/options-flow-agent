import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeSummary } from "../tools/analyzeFlow.js";
import { renderBrief } from "../tools/writeBrief.js";
import {
  documentedOhlcSample,
  tqqqOhlc,
  tqqqOpenInterest,
  tqqqQuotes,
} from "./fixtures/theta-value.js";
import { MockProvider } from "./mock.js";
import {
  DEFAULT_THETADATA_BASE_URL,
  ThetaProvider,
  type ThetaFetch,
} from "./theta.js";
import { mapThetaSnapshots, toIsoDateTime } from "./theta-map.js";
import { optionsSummarySchema } from "./types.js";

const payloads = {
  ticker: "tqqq",
  ohlc: tqqqOhlc,
  quote: tqqqQuotes,
  openInterest: tqqqOpenInterest,
  underlyingPrice: 78.42,
  underlyingPriceNote: "Yahoo 实时/延迟 15:45 ET",
};

test("Theta 快照映射成与 Mock 相同的摘要形状", () => {
  const summary = mapThetaSnapshots(payloads);
  assert.equal(optionsSummarySchema.safeParse(summary).success, true);
  assert.equal(summary.source, "theta");
  assert.equal(summary.ticker, "TQQQ");
  assert.equal(summary.underlyingPrice, 78.42);
  assert.equal(summary.underlyingPriceNote, "Yahoo 实时/延迟 15:45 ET");
  assert.equal(summary.asOf, "2026-10-06T19:45:00.000Z");
  assert.equal(summary.window, "2026-10-06 09:30–16:00 ET");
  assert.equal(summary.contracts.length, 4);

  const lead = summary.contracts.find((contract) => contract.contract === "TQQQ 2026-11-20 90C");
  assert.ok(lead);
  assert.equal(lead.volume, 3000);
  assert.equal(lead.openInterest, 600);
  assert.equal(lead.volumeOiRatio, 5);
  assert.equal(lead.premium, 637_500);
  assert.equal(lead.side, "unknown");
  assert.equal(lead.sweep, false);
  assert.equal(lead.impliedVol, 0);
  assert.equal(lead.delta, 0);
});

test("同一套异常规则能从 Theta 摘要写出简报", () => {
  const summary = mapThetaSnapshots(payloads);
  const analysis = analyzeSummary(summary);
  assert.deepEqual(
    analysis.unusual.map((contract) => contract.contract),
    ["TQQQ 2026-11-20 90C", "TQQQ 2026-10-16 80C"],
  );
  assert.equal(analysis.observations.length, 3);
  assert.match(analysis.observations[0], /权利金净偏多/);
  assert.match(analysis.observations[2], /TQQQ 2026-11-20 90C/);
  assert.match(analysis.observations[2], /方向不明/);
  assert.match(analysis.observations[2], /不是扫单/);

  const markdown = renderBrief({
    ticker: summary.ticker,
    window: summary.window,
    asOf: summary.asOf,
    underlyingPrice: summary.underlyingPrice,
    underlyingPriceNote: summary.underlyingPriceNote,
    source: summary.source,
    unusual: analysis.unusual,
    observations: analysis.observations,
    sampleSize: analysis.sampleSize,
  });
  assert.match(markdown, /## 标的 \/ 时间窗/);
  assert.match(markdown, /## 异常合约表/);
  assert.match(markdown, /## 观察/);
  assert.match(markdown, /## 免责声明/);
  assert.match(markdown, /不是投资建议/);
  assert.match(markdown, /ThetaData Options Value/);
  assert.match(markdown, /标的价格：78\.42（Yahoo 实时\/延迟 15:45 ET）/);
});

test("文档中的 OHLC 示例能摊平，缺报价时用成交价", () => {
  assert.equal(toIsoDateTime("2025-08-20T15:25:31.03"), "2025-08-20T19:25:31.030Z");
  const summary = mapThetaSnapshots({
    ticker: "AAPL",
    ohlc: documentedOhlcSample,
    quote: { response: [] },
    openInterest: { response: [] },
    underlyingPrice: 230.5,
    underlyingPriceNote: "Yahoo 实时/延迟 15:25 ET",
  });
  const contract = summary.contracts[0];
  assert.ok(contract);
  assert.equal(contract.contract, "AAPL 2026-01-16 275C");
  assert.equal(contract.volume, 202);
  assert.equal(contract.last, 1.51);
  assert.equal(contract.bid, 1.51);
  assert.equal(contract.ask, 1.51);
  assert.equal(contract.volumeOiRatio, 0);
});

test("响应形状不对或连不上 Terminal 时失败，且不请求 Mock", async () => {
  assert.throws(() => mapThetaSnapshots({ ...payloads, ohlc: { html: "<table>" } }), /形状无法识别/);
  assert.throws(() => mapThetaSnapshots({ ...payloads, ohlc: { response: [] } }), /没有返回该标的的合约/);
  assert.throws(
    () =>
      mapThetaSnapshots({
        ...payloads,
        ohlc: {
          response: [
            {
              contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 80, right: "BOTH" },
              data: [{ close: 1, volume: 10, timestamp: "2026-10-06T15:00:00" }],
            },
          ],
        },
      }),
    /方向无法识别/,
  );

  let calls = 0;
  const fetchImpl: ThetaFetch = async () => {
    calls += 1;
    throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:25503") });
  };
  const provider = new ThetaProvider(
    { baseUrl: DEFAULT_THETADATA_BASE_URL, credentials: { apiKey: "sentinel-api-key-value" } },
    fetchImpl,
  );
  await assert.rejects(provider.fetchSummary("TQQQ"), /无法连接 ThetaData REST/);
  await assert.rejects(provider.fetchSummary("TQQQ"), /不会改用 Mock/);
  await assert.rejects(provider.fetchSummary("TQQQ"), (error: unknown) => {
    assert.equal(error instanceof Error && error.message.includes("sentinel-api-key-value"), false);
    return true;
  });
  assert.ok(calls > 0);

  calls = 0;
  assert.throws(
    () => new ThetaProvider({ baseUrl: DEFAULT_THETADATA_BASE_URL, credentials: {} }, fetchImpl),
    /没有凭证/,
  );
  assert.equal(calls, 0);
});

test("ThetaProvider 用 Value 档快照，不调用 trade", async () => {
  const urls: string[] = [];
  const bodies = new Map<string, unknown>([
    ["/option/snapshot/ohlc", tqqqOhlc],
    ["/option/snapshot/quote", tqqqQuotes],
    ["/option/snapshot/open_interest", tqqqOpenInterest],
  ]);
  const fetchImpl: ThetaFetch = async (url) => {
    urls.push(url);
    if (url.includes("finance.yahoo.com")) {
      return new Response(
        JSON.stringify({
          chart: {
            result: [{ meta: { regularMarketPrice: 83.62, regularMarketTime: 1791403200 } }],
            error: null,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const path = new URL(url).pathname.replace("/v3", "");
    const body = bodies.get(path);
    assert.ok(body, path);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const provider = new ThetaProvider(
    {
      baseUrl: DEFAULT_THETADATA_BASE_URL,
      credentials: { username: "person@example.com", password: "sentinel-password-value" },
    },
    fetchImpl,
  );
  const summary = await provider.fetchSummary("TQQQ");
  assert.equal(summary.contracts.length, 4);
  assert.equal(summary.underlyingPrice, 83.62);
  assert.equal(summary.underlyingPriceNote, "Yahoo 实时/延迟 16:00 ET");
  assert.equal(urls.some((url) => url.includes("/option/snapshot/trade")), false);
  assert.equal(urls.some((url) => url.includes("/stock/snapshot/")), false);
  assert.equal(urls.some((url) => url.includes("/stock/history/eod")), false);
  assert.equal(urls.some((url) => url.includes("sentinel-password-value")), false);
  assert.equal(urls.filter((url) => url.includes("/option/snapshot/ohlc")).length, 1);
});

test("更早交易日的成交不计入当日成交量", () => {
  const summary = mapThetaSnapshots({
    ...payloads,
    ohlc: {
      response: [
        ...tqqqOhlc.response,
        {
          contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 85, right: "CALL" },
          data: [
            {
              volume: 4000,
              open: 1.2,
              high: 1.4,
              low: 1,
              close: 1.2,
              timestamp: "2026-10-07T15:00:00",
            },
          ],
        },
        {
          contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 60, right: "PUT" },
          data: [
            {
              volume: 90000,
              open: 3,
              high: 3.2,
              low: 2.8,
              close: 3,
              timestamp: "2026-10-02T11:00:00",
            },
          ],
        },
      ],
    },
    openInterest: {
      response: [
        {
          contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 85, right: "CALL" },
          data: [{ open_interest: 500, timestamp: "2026-10-07T06:30:00" }],
        },
      ],
    },
  });
  assert.deepEqual(
    summary.contracts.map((contract) => contract.contract),
    ["TQQQ 2026-10-16 85C"],
  );
  assert.equal(summary.contracts[0]?.volume, 4000);
  assert.equal(summary.contracts[0]?.premium, 480_000);
  assert.equal(summary.window, "2026-10-07 09:30–16:00 ET");
  const analysis = analyzeSummary(summary);
  assert.deepEqual(
    analysis.unusual.map((contract) => contract.contract),
    ["TQQQ 2026-10-16 85C"],
  );
});

test("权利金优先用 VWAP，否则用典型价，再退回收盘价或中价", () => {
  const withVwap = {
    response: tqqqOhlc.response.map((item, index) =>
      index === 2
        ? { ...item, data: item.data.map((bar) => ({ ...bar, vwap: 2.5 })) }
        : item,
    ),
  };
  const vwapSummary = mapThetaSnapshots({ ...payloads, ohlc: withVwap });
  assert.equal(
    vwapSummary.contracts.find((contract) => contract.contract.endsWith("90C"))?.premium,
    750_000,
  );

  const closeOnly = mapThetaSnapshots({
    ticker: "TQQQ",
    ohlc: {
      response: [
        {
          contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 80, right: "CALL" },
          data: [{ close: 1.5, volume: 100, timestamp: "2026-10-06T15:00:00" }],
        },
      ],
    },
    quote: {
      response: [
        {
          contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 80, right: "CALL" },
          data: [{ bid: 1, ask: 1.2 }],
        },
      ],
    },
    openInterest: { response: [] },
    underlyingPrice: 78.42,
    underlyingPriceNote: "Yahoo 实时/延迟 15:00 ET",
  });
  assert.equal(closeOnly.contracts[0]?.premium, 15_000);

  const midOnly = mapThetaSnapshots({
    ticker: "TQQQ",
    ohlc: {
      response: [
        {
          contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 80, right: "CALL" },
          data: [{ close: 0, volume: 100, timestamp: "2026-10-06T15:00:00" }],
        },
      ],
    },
    quote: {
      response: [
        {
          contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 80, right: "CALL" },
          data: [{ bid: 1, ask: 1.4 }],
        },
      ],
    },
    openInterest: { response: [] },
    underlyingPrice: 78.42,
    underlyingPriceNote: "Yahoo 实时/延迟 15:00 ET",
  });
  assert.equal(midOnly.contracts[0]?.premium, 12_000);
});

test("实盘样本写出完整简报，并丢掉更早交易日的合约", () => {
  const summary = mapThetaSnapshots({
    ticker: "TQQQ",
    ohlc: readLiveJson("option_snapshot_ohlc.json"),
    quote: readLiveJson("option_snapshot_quote.json"),
    openInterest: readLiveJson("option_snapshot_open_interest.json"),
    underlyingPrice: 83.62,
    underlyingPriceNote: "Yahoo 实时/延迟 16:00 ET",
  });
  assert.deepEqual(
    summary.contracts.map((contract) => contract.contract),
    ["TQQQ 2026-10-12 81C", "TQQQ 2026-10-12 81P"],
  );
  const put = summary.contracts.find((contract) => contract.contract.endsWith("81P"));
  const call = summary.contracts.find((contract) => contract.contract.endsWith("81C"));
  assert.equal(put?.premium, 29_839);
  assert.equal(put?.volume, 327);
  assert.equal(put?.openInterest, 353);
  assert.equal(call?.premium, 7_482);
  assert.equal(summary.asOf, "2026-10-07T19:58:43.188Z");
  assert.equal(summary.window, "2026-10-07 09:30–16:00 ET");

  const analysis = analyzeSummary(summary);
  assert.equal(analysis.observations.length, 3);
  assert.equal(analysis.unusual.length, 0);
  const markdown = renderBrief({
    ticker: summary.ticker,
    window: summary.window,
    asOf: summary.asOf,
    underlyingPrice: summary.underlyingPrice,
    underlyingPriceNote: summary.underlyingPriceNote,
    source: summary.source,
    unusual: analysis.unusual,
    observations: analysis.observations,
    sampleSize: analysis.sampleSize,
  });
  assert.match(markdown, /## 异常合约表/);
  assert.match(markdown, /无达到阈值的合约/);
  assert.match(markdown, /1\. 时间窗内没有合约同时达到成交量与 Vol\/OI 阈值/);
  assert.match(markdown, /2\. /);
  assert.match(markdown, /3\. /);
  assert.match(markdown, /标的价格：83\.62（Yahoo 实时\/延迟 16:00 ET）/);
  assert.equal(markdown.includes("65P"), false);
});

test("Yahoo 失败时用免费日线收盘，两边都失败则退出", async () => {
  const eod = readLiveJson("stock_history_eod.json");
  const forbidden = readFileSync(livePath("stock_snapshot_ohlc_403.txt"), "utf8");
  const yahooOk = {
    chart: {
      result: [{ meta: { regularMarketPrice: 83.62, regularMarketTime: 1791403200 } }],
      error: null,
    },
  };

  const fallbackUrls: string[] = [];
  const fallback = new ThetaProvider(
    {
      baseUrl: DEFAULT_THETADATA_BASE_URL,
      credentials: { apiKey: "sentinel-api-key-value" },
      env: { UNDERLYING_PRICE_SOURCE: "yahoo" },
    },
    async (url) => {
      fallbackUrls.push(url);
      if (url.includes("finance.yahoo.com")) {
        return new Response("upstream", { status: 500 });
      }
      const path = new URL(url).pathname.replace("/v3", "");
      if (path === "/stock/history/eod") {
        return jsonResponse(eod);
      }
      const body = liveOptionBody(path);
      assert.ok(body, path);
      return jsonResponse(body);
    },
  );
  const summary = await fallback.fetchSummary("TQQQ");
  assert.equal(summary.underlyingPrice, 84.25);
  assert.equal(summary.underlyingPriceNote, "Theta 日线收盘 2026-10-06");
  assert.equal(summary.contracts.length, 2);
  assert.equal(fallbackUrls.some((url) => url.includes("/stock/snapshot/")), false);
  assert.equal(fallbackUrls.some((url) => url.includes("sentinel-api-key-value")), false);
  assert.match(fallbackUrls.find((url) => url.includes("/stock/history/eod")) ?? "", /start_date=\d{8}/);

  const eodOnlyUrls: string[] = [];
  const eodOnly = new ThetaProvider(
    {
      baseUrl: DEFAULT_THETADATA_BASE_URL,
      credentials: { apiKey: "sentinel-api-key-value" },
      env: { UNDERLYING_PRICE_SOURCE: "theta-eod" },
    },
    async (url) => {
      eodOnlyUrls.push(url);
      if (url.includes("finance.yahoo.com")) return jsonResponse(yahooOk);
      const path = new URL(url).pathname.replace("/v3", "");
      if (path === "/stock/history/eod") return jsonResponse(eod);
      const body = liveOptionBody(path);
      assert.ok(body, path);
      return jsonResponse(body);
    },
  );
  const eodSummary = await eodOnly.fetchSummary("TQQQ");
  assert.equal(eodSummary.underlyingPrice, 84.25);
  assert.equal(eodSummary.underlyingPriceNote, "Theta 日线收盘 2026-10-06");
  assert.equal(eodOnlyUrls.some((url) => url.includes("finance.yahoo.com")), false);

  let failedCalls = 0;
  const blocked = new ThetaProvider(
    {
      baseUrl: DEFAULT_THETADATA_BASE_URL,
      credentials: { username: "person@example.com", password: "sentinel-password-value" },
      env: { UNDERLYING_PRICE_SOURCE: "yahoo" },
    },
    async (url) => {
      failedCalls += 1;
      if (url.includes("finance.yahoo.com")) return new Response("no", { status: 502 });
      const path = new URL(url).pathname.replace("/v3", "");
      if (path === "/stock/history/eod") {
        return new Response(forbidden, { status: 403 });
      }
      const body = liveOptionBody(path);
      assert.ok(body, path);
      return jsonResponse(body);
    },
  );
  await assert.rejects(blocked.fetchSummary("TQQQ"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /标的价格获取失败，不会改用 Mock/);
    assert.match(error.message, /FREE subscription/);
    assert.equal(error.message.includes("sentinel-password-value"), false);
    return true;
  });
  assert.ok(failedCalls > 0);

  let invalidCalls = 0;
  const invalid = new ThetaProvider(
    {
      baseUrl: DEFAULT_THETADATA_BASE_URL,
      credentials: { apiKey: "sentinel-api-key-value" },
      env: { UNDERLYING_PRICE_SOURCE: "paid-stock" },
    },
    async () => {
      invalidCalls += 1;
      return jsonResponse({});
    },
  );
  await assert.rejects(invalid.fetchSummary("TQQQ"), /未知 UNDERLYING_PRICE_SOURCE/);
  await assert.rejects(invalid.fetchSummary("TQQQ"), /不会改用 Mock/);
  assert.equal(invalidCalls, 0);
});

function livePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/live/${name}`, import.meta.url));
}

function readLiveJson(name: string): unknown {
  return JSON.parse(readFileSync(livePath(name), "utf8")) as unknown;
}

function liveOptionBody(path: string): unknown {
  if (path === "/option/snapshot/ohlc") return readLiveJson("option_snapshot_ohlc.json");
  if (path === "/option/snapshot/quote") return readLiveJson("option_snapshot_quote.json");
  if (path === "/option/snapshot/open_interest") return readLiveJson("option_snapshot_open_interest.json");
  return undefined;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("MockProvider 的 TQQQ 样本没有被 Theta 映射改动", async () => {
  const summary = await new MockProvider().fetchSummary("TQQQ");
  const lead = summary.contracts.find((contract) => contract.contract === "TQQQ 2026-10-09 80C");
  assert.equal(summary.source, "mock");
  assert.equal(lead?.premium, 4_512_900);
  assert.equal(lead?.sweep, true);
  assert.equal(lead?.side, "buy");
});
