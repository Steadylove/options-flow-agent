import { runAgent, type AgentResult } from "./agent/loop.js";
import { loadDotEnv } from "./env.js";
import { normalizeTicker } from "./ticker.js";

const USAGE = `用法：pnpm brief --ticker TQQQ

默认 OPTIONS_DATA_PROVIDER=mock：从 MockProvider 读取样本，写出 output/<TICKER>-options-brief.md。
未设置 LITELLM_API_KEY 时按固定顺序调用三个 tool，不访问网络。
OPTIONS_DATA_PROVIDER=theta 时改用 ThetaData；没有凭证会直接失败，不会退回 mock。`;

interface CliArgs {
  help: boolean;
  ticker?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }

  let raw: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ticker") {
      raw = argv[index + 1];
      break;
    }
    if (arg?.startsWith("--ticker=")) {
      raw = arg.slice("--ticker=".length);
      break;
    }
  }

  if (!raw || raw.startsWith("-")) {
    throw new Error(`缺少 --ticker。\n${USAGE}`);
  }

  return { help: false, ticker: normalizeTicker(raw) };
}

function formatMode(result: AgentResult): string {
  if (result.provider === "mock") {
    return result.mode === "deterministic" ? "离线 Mock（未设置 LITELLM_API_KEY）" : "LiteLLM";
  }
  return result.mode === "deterministic" ? "ThetaData（未设置 LITELLM_API_KEY）" : "LiteLLM + ThetaData";
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.ticker) {
    console.log(USAGE);
    return;
  }

  const result = await runAgent({ ticker: args.ticker });
  console.log(`模式：${formatMode(result)}`);
  console.log(`已写入 ${result.outputPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
