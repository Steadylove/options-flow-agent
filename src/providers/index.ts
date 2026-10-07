import { MockProvider } from "./mock.js";
import { readThetaConfig, ThetaProvider } from "./theta.js";
import type { OptionsDataProvider } from "./types.js";

export function createOptionsDataProvider(
  env: NodeJS.ProcessEnv = process.env,
): OptionsDataProvider {
  const selected = (env.OPTIONS_DATA_PROVIDER ?? "").trim().toLowerCase() || "mock";
  if (selected === "mock") return new MockProvider();
  if (selected === "theta") return new ThetaProvider(readThetaConfig(env));
  throw new Error(
    `未知 OPTIONS_DATA_PROVIDER：${env.OPTIONS_DATA_PROVIDER}。请使用 mock 或 theta。`,
  );
}
