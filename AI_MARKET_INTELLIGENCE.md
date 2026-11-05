# AI Market Intelligence (6.3.0)

## What it does
- Observes completed SPOT scans only.
- Tracks recurring symbol + buy-exchange + sell-exchange patterns.
- Learns from spread/net-margin observations, book validation status, stability and missing scans (an opportunity that disappears is recorded as absent).
- Adds a non-binding AI score to each SPOT opportunity and exposes `GET /api/ai/insights`.
- Does not change scanner thresholds, order-book checks, fee/slippage math, or execute orders.

## API
`GET /api/ai/insights` returns scan count, tracked patterns, persistence mode and the top current opportunities ranked by historical pattern score.

## Storage
Without configuration, history is memory-only and resets when the Render service restarts.

To persist the model history, attach a persistent Render disk to the service and set:
`AI_HISTORY_FILE=/var/data/crypto-ai-history.json`

The module limits the history file to 2 MB and tracks at most 600 patterns with 24 recent observations each. If the file is unavailable or malformed, the engine safely starts with empty history.

## Important limitations
This is a lightweight online statistical pattern learner, not a generative AI model and not a guaranteed forecast. The score is a prioritization signal only. A high score does not mean an executable arbitrage exists. Always rely on fresh quotes, order books, liquidity, fees, slippage and the mathematical validation result. DEX data is not yet included in this first SPOT learning module.
