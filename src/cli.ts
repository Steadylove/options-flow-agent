import { runAgent, type AgentResult } from "./agent/loop.js";
import { loadDotEnv } from "./env.js";
import { normalizeTicker } from "./ticker.js";
import { readIncludeZeroDte, readMinOpenInterest } from "./tools/analyzeFlow.js";

const USAGE = `用法：pnpm brief --ticker TQQQ [--include-0dte] [--min-oi 500]

默认 OPTIONS_DATA_PROVIDER=mock：从 MockProvider 读取样本，写出 output/<TICKER>-options-brief.md。
未设置 LITELLM_API_KEY 时按固定顺序调用三个 tool，不访问网络。
OPTIONS_DATA_PROVIDER=theta 时改用 ThetaData。凭证放在 Theta Terminal 里，本进程不发送密钥。
连不上 Terminal 会直接失败，不会退回 mock。
默认不把当日到期合约放进异常排名。--include-0dte 或 INCLUDE_0DTE=1 可纳入。
默认要求未平仓 ≥ 500。--min-oi 或 MIN_OPEN_INTEREST 可改，0 表示不设下限。`;

interface CliArgs {
  help: boolean;
  ticker?: string;
  includeZeroDte: boolean;
  minOpenInterest?: number;
}

function readCliMinOpenInterest(argv: string[]): number | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--min-oi") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`--min-oi 需要非负整数。\n${USAGE}`);
      }
      return readMinOpenInterest(value);
    }
    if (arg?.startsWith("--min-oi=")) {
      return readMinOpenInterest(arg.slice("--min-oi=".length));
    }
  }
  return undefined;
}

export function parseArgs(argv: string[]): CliArgs {
  const includeZeroDte = argv.includes("--include-0dte");
  const minOpenInterest = readCliMinOpenInterest(argv);
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true, includeZeroDte, minOpenInterest };
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

  return { help: false, ticker: normalizeTicker(raw), includeZeroDte, minOpenInterest };
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

  const result = await runAgent({
    ticker: args.ticker,
    includeZeroDte: args.includeZeroDte || readIncludeZeroDte(),
    minOpenInterest: args.minOpenInterest,
  });
  console.log(`模式：${formatMode(result)}`);
  console.log(`已写入 ${result.outputPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
