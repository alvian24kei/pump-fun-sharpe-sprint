// "Quiet Hours" — a disciplined paper bot for the Pump.fun Sharpe Sprint.
// Run by the grader as `node /bot/main.ts` with this repository mounted at /bot.
// The strategy lives in strategy.ts; the SDK shim is vendored byte for byte
// from the kit's sdk/ts/makefun-bot.ts at vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
