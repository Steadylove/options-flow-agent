import { z } from "zod";

export const optionRightSchema = z.enum(["call", "put"]);
export const flowSideSchema = z.enum(["buy", "sell", "unknown"]);

export const optionContractSchema = z.object({
  contract: z.string().min(1),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strike: z.number().positive(),
  right: optionRightSchema,
  volume: z.number().int().nonnegative(),
  openInterest: z.number().int().nonnegative(),
  volumeOiRatio: z.number().nonnegative(),
  last: z.number().nonnegative(),
  bid: z.number().nonnegative(),
  ask: z.number().nonnegative(),
  impliedVol: z.number().nonnegative(),
  delta: z.number().min(-1).max(1),
  premium: z.number().nonnegative(),
  side: flowSideSchema,
  sweep: z.boolean(),
});

export const optionsSummarySchema = z.object({
  ticker: z.string().min(1),
  asOf: z.string().datetime(),
  window: z.string().min(1),
  underlyingPrice: z.number().positive(),
  source: z.literal("mock"),
  contracts: z.array(optionContractSchema).min(1),
});

export type OptionRight = z.infer<typeof optionRightSchema>;
export type FlowSide = z.infer<typeof flowSideSchema>;
export type OptionContract = z.infer<typeof optionContractSchema>;
export type OptionsSummary = z.infer<typeof optionsSummarySchema>;

/** Week1 只有 MockProvider。接口留好，真实数据源不在本周范围。 */
export interface OptionsDataProvider {
  readonly name: string;
  fetchSummary(ticker: string): Promise<OptionsSummary>;
}
