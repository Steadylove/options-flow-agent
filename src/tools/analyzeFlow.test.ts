import assert from "node:assert/strict";
import test from "node:test";
import { MockProvider } from "../providers/mock.js";
import { renderBrief } from "./writeBrief.js";
import { analyzeSummary, readMinOpenInterest } from "./analyzeFlow.js";
import type { OptionContract, OptionsSummary } from "../providers/types.js";

function contract(input: Pick<OptionContract, "contract" | "expiry" | "right" | "volume" | "openInterest" | "premium"> & Partial<OptionContract>): OptionContract {
  const ratio = input.openInterest === 0 ? input.volume : Math.round((input.volume / input.openInterest) * 100) / 100;
  return {
    contract: input.contract,
    expiry: input.expiry,
    strike: input.strike ?? 80,
    right: input.right,
    volume: input.volume,
    openInterest: input.openInterest,
    volumeOiRatio: input.volumeOiRatio ?? ratio,
    last: 1,
    bid: 1,
    ask: 1,
    impliedVol: 0,
    delta: 0,
    premium: input.premium,
    side: input.side ?? "unknown",
    sweep: input.sweep ?? false,
  };
}

function summary(contracts: OptionContract[], source: OptionsSummary["source"] = "theta"): OptionsSummary {
  return {
    ticker: "TQQQ",
    asOf: "2026-10-07T20:00:00.000Z",
    window: "2026-10-07 09:30–16:00 ET",
    underlyingPrice: 83.62,
    source,
    contracts,
  };
}

test("方向混杂时点明张数和单一合约，不写净偏多", () => {
  const analysis = analyzeSummary(
    summary([
      contract({ contract: "TQQQ 2026-10-16 90C", expiry: "2026-10-16", right: "call", volume: 2000, openInterest: 800, premium: 1_000_000 }),
      contract({ contract: "TQQQ 2026-10-16 80P", expiry: "2026-10-16", right: "put", volume: 2000, openInterest: 800, premium: 200_000 }),
      contract({ contract: "TQQQ 2026-10-23 75P", expiry: "2026-10-23", right: "put", volume: 2000, openInterest: 800, premium: 200_000 }),
      contract({ contract: "TQQQ 2026-10-30 70P", expiry: "2026-10-30", right: "put", volume: 2000, openInterest: 800, premium: 200_000 }),
    ]),
  );
  assert.equal(
    analysis.observations[0],
    "全部 4 张达标合约（看涨 1 张、看跌 3 张）：看涨权利金 $1,000,000，看跌 $600,000。张数偏空、权利金偏多，方向混杂。看涨权利金全部来自 TQQQ 2026-10-16 90C。全场：看涨 2,000 张（$1,000,000），看跌 6,000 张（$600,000）。",
  );
  assert.equal(analysis.observations[0].includes("净偏多"), false);
  assert.equal(analysis.observations[1].includes("最突出"), false);
  assert.match(analysis.observations[2], /^表内最突出的是 /);
});

test("全场含当日到期与不含当日到期分开写", () => {
  const analysis = analyzeSummary(
    summary([
      contract({ contract: "TQQQ 2026-10-07 80C", expiry: "2026-10-07", right: "call", volume: 5000, openInterest: 1000, premium: 800_000 }),
      contract({ contract: "TQQQ 2026-10-16 80C", expiry: "2026-10-16", right: "call", volume: 2000, openInterest: 1000, premium: 300_000 }),
      contract({ contract: "TQQQ 2026-10-16 80P", expiry: "2026-10-16", right: "put", volume: 1500, openInterest: 600, premium: 100_000 }),
    ]),
  );
  assert.match(analysis.observations[0], /全场含当日到期：看涨 7,000 张（\$1,100,000），看跌 1,500 张（\$100,000）/);
  assert.match(analysis.observations[0], /不含当日到期：看涨 2,000 张（\$300,000），看跌 1,500 张（\$100,000）/);
  assert.match(analysis.observations[0], /全部 2 张达标合约/);
  assert.match(analysis.observations[1], /另有 1 张当日到期达标，未进排名/);
  assert.equal(analysis.observations[1].includes("最突出"), false);

  const included = analyzeSummary(
    summary([
      contract({ contract: "TQQQ 2026-10-07 80C", expiry: "2026-10-07", right: "call", volume: 5000, openInterest: 1000, premium: 800_000 }),
      contract({ contract: "TQQQ 2026-10-16 80P", expiry: "2026-10-16", right: "put", volume: 1500, openInterest: 600, premium: 100_000 }),
    ]),
    { includeZeroDte: true },
  );
  assert.match(included.observations[0], /全部 2 张达标合约（看涨 1 张、看跌 1 张）/);
  assert.match(included.observations[0], /全场含当日到期：/);
  assert.match(included.observations[1], /表内 2 张，即全部达标合约/);
  assert.equal(included.observations[1].includes("未进排名"), false);
});

test("未平仓低于下限的合约不进排名，下限可调", () => {
  const rows = [
    contract({ contract: "TQQQ 2026-10-16 90C", expiry: "2026-10-16", right: "call", volume: 3000, openInterest: 114, premium: 900_000, volumeOiRatio: 26.32 }),
    contract({ contract: "TQQQ 2026-10-16 80C", expiry: "2026-10-16", right: "call", volume: 2000, openInterest: 800, premium: 200_000, volumeOiRatio: 2.5 }),
  ];
  const strict = analyzeSummary(summary(rows, "mock"));
  assert.deepEqual(
    strict.unusual.map((row) => row.contract),
    ["TQQQ 2026-10-16 80C"],
  );
  assert.match(strict.observations[1], /未平仓低于 500/);
  const loose = analyzeSummary(summary(rows, "mock"), { minOpenInterest: 0 });
  assert.equal(loose.unusual[0]?.contract, "TQQQ 2026-10-16 90C");
  assert.equal(loose.observations[1].includes("未平仓低于"), false);
  assert.throws(() => readMinOpenInterest("abc"), /非负整数/);
  assert.throws(() => readMinOpenInterest("-1"), /不会改用 Mock/);
  assert.equal(readMinOpenInterest(undefined), 500);
  assert.equal(readMinOpenInterest("0"), 0);
});

test("多张里单张超过该侧权利金一半时点名", () => {
  const analysis = analyzeSummary(
    summary(
      [
        contract({ contract: "TQQQ 2026-10-16 90C", expiry: "2026-10-16", right: "call", volume: 4000, openInterest: 1000, premium: 800_000 }),
        contract({ contract: "TQQQ 2026-10-16 80C", expiry: "2026-10-16", right: "call", volume: 2000, openInterest: 1000, premium: 100_000 }),
        contract({ contract: "TQQQ 2026-10-16 70P", expiry: "2026-10-16", right: "put", volume: 2000, openInterest: 1000, premium: 100_000 }),
      ],
      "mock",
    ),
  );
  assert.match(analysis.observations[0], /张数与权利金都偏多/);
  assert.match(analysis.observations[0], /TQQQ 2026-10-16 90C 占看涨权利金 89%/);
});

test("Mock 简报的四张异常合约顺序不变，观察口径已改写", async () => {
  const priced = await new MockProvider().fetchSummary("TQQQ");
  const analysis = analyzeSummary(priced);
  assert.deepEqual(
    analysis.unusual.map((row) => row.contract),
    [
      "TQQQ 2026-10-09 80C",
      "TQQQ 2026-11-20 90C",
      "TQQQ 2026-10-16 75P",
      "TQQQ 2026-10-16 78C",
    ],
  );
  assert.deepEqual(analysis.observations, [
    "全部 4 张达标合约（看涨 3 张、看跌 1 张）：看涨权利金 $9,265,235，看跌 $2,452,440。张数与权利金都偏多。",
    "表内 4 张，即全部达标合约。到期最集中在 2026-10-16（2 张）。",
    "表内最突出的是 TQQQ 2026-10-09 80C：成交 18,420，未平仓 2,110，Vol/OI 8.73，权利金 $4,512,900，记为买入，是扫单。",
  ]);
  const markdown = renderBrief({
    ticker: priced.ticker,
    window: priced.window,
    asOf: priced.asOf,
    underlyingPrice: priced.underlyingPrice,
    source: priced.source,
    unusual: analysis.unusual,
    observations: analysis.observations,
    sampleSize: analysis.sampleSize,
  });
  assert.match(markdown, /标的价格：78\.42\n/);
  assert.equal(markdown.includes("标的价格：78.42（"), false);
});
