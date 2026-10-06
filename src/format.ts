const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const pxFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function fmtInt(value: number): string {
  return intFmt.format(value);
}

export function fmtUsd(value: number): string {
  return usdFmt.format(value);
}

export function fmtPx(value: number): string {
  return pxFmt.format(value);
}
