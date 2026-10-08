import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  fetchYahooQuote,
  formatEtClock,
  parseThetaEod,
  parseYahooChart,
  readUnderlyingPriceSource,
  type HttpGet,
} from "./price.js";

const liveEod = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../providers/fixtures/live/stock_history_eod.json", import.meta.url)),
    "utf8",
  ),
) as unknown;

const yahooPayload = {
  chart: {
    result: [{ meta: { regularMarketPrice: 83.62, regularMarketTime: 1791403200 } }],
    error: null,
  },
};

test("Yahoo 图表解析出价格和美东时刻", () => {
  assert.equal(formatEtClock(1791403200), "16:00 ET");
  const quote = parseYahooChart(yahooPayload);
  assert.equal(quote.price, 83.62);
  assert.equal(quote.note, "Yahoo 实时/延迟 16:00 ET");
  assert.throws(() => parseYahooChart({ chart: { result: [], error: { code: "Not Found" } } }), /无法识别/);
});

test("query1 失败时改问 query2", async () => {
  const urls: string[] = [];
  const fetchImpl: HttpGet = async (url, init) => {
    urls.push(url);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("user-agent"), "options-flow-agent");
    if (url.includes("query1")) return new Response("down", { status: 500 });
    return new Response(JSON.stringify(yahooPayload), { status: 200 });
  };
  const quote = await fetchYahooQuote("TQQQ", fetchImpl);
  assert.equal(quote.price, 83.62);
  assert.match(urls[0] ?? "", /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/TQQQ\?interval=1m&range=1d/);
  assert.match(urls[1] ?? "", /query2\.finance\.yahoo\.com/);
});

test("免费 EOD 取最后一根日线，且不要求 symbol 或 timestamp", () => {
  const quote = parseThetaEod(liveEod);
  assert.equal(quote.price, 84.25);
  assert.equal(quote.note, "Theta 日线收盘 2026-10-06");
  assert.throws(() => parseThetaEod({ response: [{ close: 1 }] }), /没有给出可用的收盘价/);
});

test("标的价来源只接受 yahoo 与 theta-eod", () => {
  assert.equal(readUnderlyingPriceSource(undefined), "yahoo");
  assert.equal(readUnderlyingPriceSource("  Yahoo "), "yahoo");
  assert.equal(readUnderlyingPriceSource("theta-eod"), "theta-eod");
  assert.throws(() => readUnderlyingPriceSource("paid-stock"), /未知 UNDERLYING_PRICE_SOURCE/);
  assert.throws(() => readUnderlyingPriceSource("paid-stock"), /不会改用 Mock/);
});
