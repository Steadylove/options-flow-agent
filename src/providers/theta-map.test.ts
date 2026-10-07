import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSummary } from "../tools/analyzeFlow.js";
import { renderBrief } from "../tools/writeBrief.js";
import {
  documentedOhlcSample,
  tqqqOhlc,
  tqqqOpenInterest,
  tqqqQuotes,
  tqqqUnderlying,
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
  underlying: tqqqUnderlying,
};

test("Theta 快照映射成与 Mock 相同的摘要形状", () => {
  const summary = mapThetaSnapshots(payloads);
  assert.equal(optionsSummarySchema.safeParse(summary).success, true);
  assert.equal(summary.source, "theta");
  assert.equal(summary.ticker, "TQQQ");
  assert.equal(summary.underlyingPrice, 78.42);
  assert.equal(summary.asOf, "2026-10-06T19:45:00.000Z");
  assert.equal(summary.window, "2026-10-06 09:30–16:00 ET");
  assert.equal(summary.contracts.length, 4);

  const lead = summary.contracts.find((contract) => contract.contract === "TQQQ 2026-11-20 90C");
  assert.ok(lead);
  assert.equal(lead.volume, 3000);
  assert.equal(lead.openInterest, 600);
  assert.equal(lead.volumeOiRatio, 5);
  assert.equal(lead.premium, 660_000);
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
});

test("文档中的 OHLC 示例能摊平，缺报价时用成交价", () => {
  assert.equal(toIsoDateTime("2025-08-20T15:25:31.03"), "2025-08-20T19:25:31.030Z");
  const summary = mapThetaSnapshots({
    ticker: "AAPL",
    ohlc: documentedOhlcSample,
    quote: { response: [] },
    openInterest: { response: [] },
    underlying: {
      response: [{ symbol: "AAPL", close: 230.5, timestamp: "2025-08-20T15:25:00" }],
    },
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
    ["/stock/snapshot/ohlc", tqqqUnderlying],
  ]);
  const fetchImpl: ThetaFetch = async (url) => {
    urls.push(url);
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
  assert.equal(urls.some((url) => url.includes("/option/snapshot/trade")), false);
  assert.equal(urls.some((url) => url.includes("sentinel-password-value")), false);
  assert.equal(urls.filter((url) => url.includes("/option/snapshot/ohlc")).length, 1);
  assert.equal(urls.filter((url) => url.includes("/stock/snapshot/ohlc")).length, 1);
});

test("MockProvider 的 TQQQ 样本没有被 Theta 映射改动", async () => {
  const summary = await new MockProvider().fetchSummary("TQQQ");
  const lead = summary.contracts.find((contract) => contract.contract === "TQQQ 2026-10-09 80C");
  assert.equal(summary.source, "mock");
  assert.equal(lead?.premium, 4_512_900);
  assert.equal(lead?.sweep, true);
  assert.equal(lead?.side, "buy");
});
