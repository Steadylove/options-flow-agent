const TICKER_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export function normalizeTicker(raw: string): string {
  const ticker = raw.trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) {
    throw new Error(`无效 ticker：${raw.trim() || "（空）"}。示例：TQQQ`);
  }
  return ticker;
}
