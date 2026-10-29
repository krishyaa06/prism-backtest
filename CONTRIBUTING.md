# Contributing to prism-backtest

Thanks for taking the time to contribute! prism-backtest is a command-line tool by [Prism Protocol](https://github.com/krishyaa06) — Prism Backtest runs trading strategies over daily OHLCV data the way they would have traded. Bars are fed one at a time, so a strategy can't see the future, and orders decided on a close fill at the next open. Fills pay NSE delivery or intraday charges (STT, exchange fees, SEBI fee, stamp duty, GST, DP charge) plus a half-spread and square-root market impact, and they are capped at a share of daily volume. Stops are gap-aware, and position limits, gross exposure limits and a drawdown kill switch sit between the strategy and the market. Seven built-in strategies cover trend, mean reversion, breakout, cross-sectional momentum and pairs trading. Parameter sweeps report the deflated Sharpe ratio, rolling walk-forward analysis keeps every test window out of sample, and a block bootstrap gives a distribution instead of a single equity curve. A regime-switching synthetic market with jumps and a cointegrated pair lets everything run without downloading data, and a strict CSV loader takes real data.

## Getting started

```bash
git clone https://github.com/krishyaa06/prism-backtest.git
cd prism-backtest
npm start
```

## Before you open a pull request

Make sure everything passes locally:

```bash
npm test
```

## Guidelines

- **Zero dependencies.** Please don't add runtime dependencies — use Node.js built-ins (`node:fs`, `node:path`, `node:test`, …).
- **No build step, no frameworks.** Keep it plain HTML, CSS and JavaScript so it runs straight from GitHub Pages.
- **Everything stays in the browser.** Don't send user data to any server.
- Keep pull requests small and focused — one feature or fix per PR.
- Update the README when you change behaviour, flags or options.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add --json output
fix: handle empty input
docs: clarify install steps
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`. Add a short entry under **[Unreleased]** in [CHANGELOG.md](CHANGELOG.md) for user-facing changes.

## Reporting bugs & ideas

Open an [issue](https://github.com/krishyaa06/prism-backtest/issues) with:

- what you expected vs. what happened
- steps to reproduce
- your OS, browser or Node.js version

**Security issues:** please don't open a public issue — contact the maintainer privately via [GitHub](https://github.com/krishyaa06).

## License

By contributing, you agree that your contributions will be licensed under the project's [license](LICENSE).
