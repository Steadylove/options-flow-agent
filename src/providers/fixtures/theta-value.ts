/** 按 ThetaData v3 文档记录的 JSON 形状，供无 Terminal 的测试使用。不是实盘数据。 */

export const tqqqOhlc = {
  response: [
    {
      contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 80, right: "CALL" },
      data: [
        {
          volume: 5000,
          open: 1.05,
          high: 1.25,
          low: 0.95,
          close: 1.1,
          count: 40,
          timestamp: "2026-10-06T15:40:00.120",
        },
      ],
    },
    {
      contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 70, right: "PUT" },
      data: [
        {
          volume: 2000,
          open: 0.4,
          high: 0.55,
          low: 0.35,
          close: 0.45,
          count: 12,
          timestamp: "2026-10-06T15:10:00",
        },
      ],
    },
    {
      contract: { symbol: "TQQQ", expiration: "20261120", strike: 90, right: "C" },
      data: [
        {
          volume: 3000,
          open: 2,
          high: 2.4,
          low: 1.9,
          close: 2.2,
          count: 18,
          timestamp: "2026-10-06T15:45:00.000",
        },
      ],
    },
    {
      contract: { symbol: "TQQQ", expiration: "2026-10-09", strike: 75, right: "PUT" },
      data: [
        {
          volume: 800,
          open: 0.2,
          high: 0.3,
          low: 0.15,
          close: 0.22,
          count: 6,
          timestamp: "2026-10-06T14:05:00.000",
        },
      ],
    },
  ],
};

export const tqqqQuotes = {
  response: [
    {
      contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 80, right: "CALL" },
      data: [{ bid: 1, ask: 1.2, timestamp: "2026-10-06T15:40:01.000" }],
    },
    {
      contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 70, right: "PUT" },
      data: [{ bid: 0.4, ask: 0.5, timestamp: "2026-10-06T15:10:01.000" }],
    },
    {
      contract: { symbol: "TQQQ", expiration: "2026-11-20", strike: 90, right: "CALL" },
      data: [{ bid: 2, ask: 2.4, timestamp: "2026-10-06T15:45:01.000" }],
    },
    {
      contract: { symbol: "TQQQ", expiration: "2026-10-09", strike: 75, right: "PUT" },
      data: [{ bid: 0.2, ask: 0.24, timestamp: "2026-10-06T14:05:01.000" }],
    },
  ],
};

export const tqqqOpenInterest = {
  response: [
    {
      contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 80, right: "CALL" },
      data: [{ open_interest: 1000, timestamp: "2026-10-06T06:30:00" }],
    },
    {
      contract: { symbol: "TQQQ", expiration: "2026-10-16", strike: 70, right: "PUT" },
      data: [{ open_interest: 4000, timestamp: "2026-10-06T06:30:00" }],
    },
    {
      contract: { symbol: "TQQQ", expiration: "2026-11-20", strike: 90, right: "CALL" },
      data: [{ open_interest: 600, timestamp: "2026-10-06T06:30:00" }],
    },
    {
      contract: { symbol: "TQQQ", expiration: "2026-10-09", strike: 75, right: "PUT" },
      data: [{ open_interest: 100, timestamp: "2026-10-06T06:30:00" }],
    },
  ],
};

export const tqqqUnderlying = {
  response: [
    {
      symbol: "TQQQ",
      open: 77.8,
      high: 79.1,
      low: 77.4,
      close: 78.42,
      volume: 42000000,
      count: 180000,
      timestamp: "2026-10-06T15:44:00.000",
    },
  ],
};

/** 文档里的 option/snapshot/ohlc JSON 示例，缩成一条。 */
export const documentedOhlcSample = {
  response: [
    {
      contract: { symbol: "AAPL", expiration: "2026-01-16", strike: 275, right: "CALL" },
      data: [
        {
          volume: 202,
          high: 1.78,
          low: 1.51,
          count: 29,
          close: 1.51,
          open: 1.78,
          timestamp: "2025-08-20T15:25:31.03",
        },
      ],
    },
  ],
};
