# Prism: hybrid TradFi → DeFi wealth agent

**Track:** Topic F, Agent Wallet. An AI wallet agent that manages assets, executes on-chain transactions and controls risk on its own.

Prism pulls in the user's **whole balance sheet**: bank accounts and deposits, brokerage positions, venture and crowdfunding stakes, insurance, debts, real estate and an on-chain wallet. It also learns their **cash flow** from bank sync, statements and receipts. It scores risk and creditworthiness across all of it, turns verified **off-chain wealth into better on-chain credit terms** ("Proof of Wealth"), and runs the on-chain side (borrowing, repaying, yield, insurance, liquidation defence) inside limits that a smart contract enforces.

> **Pitch:** the AI sees everything, acts on-chain, and its worst case is capped by a contract. The cap is a number: **$0** to unknown addresses.

**→ Full test walkthrough (Russian): [TESTING.md](TESTING.md)**

---

## Run it

Requirements: Node 20+ (tested on Node 25; Hardhat prints a version warning, which is harmless).

```bash
npm install
npm run dev
```

| Process | URL | What |
|---|---|---|
| chain | `127.0.0.1:8545` | Hardhat local EVM (test keys only) |
| server | `127.0.0.1:8787` | Agent server. Deploys and seeds contracts on first start |
| web | **http://127.0.0.1:5173** | The app |

With `npm run dev` running, in a second terminal:

```bash
npm run test:e2e
```

That runs **70 end-to-end checks** across the API and direct contract attacks.

### Optional integrations (environment variables)

| Variable | Enables |
|---|---|
| `ANTHROPIC_API_KEY` | Claude (`claude-opus-5-5`) for chat, receipt photos (vision) and triage of unclear transactions. Without it, an offline agent covers the same flows |
| `TELEGRAM_BOT_TOKEN` (`TELEGRAM_CHAT_ID` optional) | The agent asks about unclear transactions in Telegram. Send `/start` to the bot to link the chat |
| `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY` | Real EU bank connections via GoCardless Bank Account Data (PSD2 AIS) |
| `PRISM_ALLOWED_HOSTS` | Extra host names allowed to reach the API (default: localhost only) |
| `PRISM_LLM=off` | Forces the offline agent even when a key is set |

The Claude, Telegram and GoCardless code paths typecheck, but they have **not been run against the live services** in this repo, because no keys were available. Everything else is covered by the e2e suite.

---

## What's in the app

| Page | What it shows |
|---|---|
| **Wealth map** | Graph explorer. The net-worth orb links to categories (deposits, stocks, bonds, venture, crypto, real assets, debts, insurance), and each category links to the individual positions across banks, brokers and the wallet. Selecting any node opens a detail panel with metrics, an AI analysis and an "ask" bar. The view has a graph/tree toggle, zoom/pan, filter, sort, search, CSV/JSON export, a **true balance** toggle and **New simulation**, which previews a market shock on every position |
| **Cash flow** | Bank auto-sync; agent questions about unclear transactions (in the app and in Telegram); one answer teaches the merchant; CSV import (T-Bank, Sber, Fio, generic, DEGIRO positions); receipt scanning with item-level learning; budgets as **% of income** or fixed; multi-currency; debts with an avalanche payoff plan; true balance; manual assets; safe-to-spend; GDPR delete |
| **Accounts** | Connected sources and the smart wallet |
| **Risk radar** | Risk score, findings (each says who can fix it), allocation, liquidity ladder, capital by risk level and by behaviour (income / neutral / drain), stress test |
| **Proof of Wealth** | Score, tier, haircuts, standard vs hybrid terms, borrow and repay, the on-chain attestation |
| **Agent** | Chat, autonomy levels L0–L3, blast radius, kill switch, approvals, audit trail, mandate and alert thresholds |
| **Earn & Protect** | Treasury vault, parametric liquidation cover, off-chain insurance gaps |
| **Demo lab** | Agent vs passive twin under an ETH sell-off, prompt injection, time travel, reset |

---

## Architecture

```
 Data in (read-only)                         Agent server (Node/TS)                                Local EVM
 ─────────────────────                       ───────────────────────────────────────────          ─────────────────────────
 Open banking (GoCardless / demo feed) ─┐    cash-flow engine: classify → learn → ask (app/TG)
 Bank CSV (T-Bank, Sber, Fio, generic) ─┤    risk engine: net worth, concentration, liquidity
 Broker positions CSV (DEGIRO…)        ─┼──▶ credit engine: score, tier, haircuts ── attestor ─EIP-712─▶ CreditRegistry
 Receipts (Claude Vision)              ─┤
 Manual: debts, real estate, pensions  ─┘    Claude agent ┐                                       ▼
                                             Autopilot    ├─▶ SAFETY PIPELINE ──▶ AgentWallet ──▶ HybridLendingPool
                                             You (UI)     │   1 typed action       (on-chain     TBillVault · CoverPool
                                             Attacker demo┘   2 off-chain policy    policy)      SimpleSwap · PriceOracle
                                                              3 snapshot simulation + intent diff
                                                              4 autonomy gate  5 execute with agent key
```

### Contracts (`contracts/contracts`)

| Contract | Role |
|---|---|
| `CreditRegistry` | EIP-712 attestations from the attestor: tier, score, credit line, expiry, evidence root (never balances). Each line can be pledged to one pool at a time |
| `HybridLendingPool` | Borrow USDC against WETH. Tiered APR (9 / 7.5 / 6 / 4.5%). Borrowing power = 70% LTV + pledged credit line, capped at 50% of collateral |
| `AgentWallet` | Smart account. The owner key is unrestricted. The agent key can only call allow-listed functions, can only pay allow-listed counterparties, has a 24h USD limit and a health-factor floor, and can be paused and expires |
| `TBillVault`, `CoverPool`, `SimpleSwap`, `PriceOracle`, `MockERC20` | Tokenized T-bills, parametric cover, and local stand-ins |

### Data access, following the research note

| Source | How Prism gets it | Status |
|---|---|---|
| Bank accounts and transactions | PSD2 AIS through an aggregator (GoCardless Bank Account Data); never credentials | Connector implemented (env-gated); demo uses a simulated feed |
| Bank statements | CSV with profiles (T-Bank, Sber, Fio) plus header auto-detection and manual column mapping; Windows-1251 fallback | ✅ tested |
| Broker positions | Positions as the source of truth: DEGIRO-style CSV now, broker APIs (IBKR, Trading 212) later | ✅ CSV tested |
| Loans, mortgages, IOUs, real estate, pensions | Manual entry (not covered by PSD2) | ✅ tested |
| Self-reported data | Shown in net worth, **excluded from Proof of Wealth** | ✅ tested |
| Idempotent sync | Dedupe by external transaction ID or a stable hash | ✅ tested |

---

## Faults in the original idea, and how Prism fixes them

| Original Variant A | Problem | Prism's fix |
|---|---|---|
| Off-chain assets as "reputational collateral" | A contract can't seize a bank deposit | Hybrid collateral: the credit line counts only up to 50% of on-chain collateral |
| One snapshot of wealth | The user can withdraw it the next day | Attestations expire after 30 days, and the agent re-verifies |
| Same assets pledged twice | Double-pledging | Each line is exclusive to one pool |
| Venture counted as wealth | Illiquid, no market price | 0% haircut; still visible in the risk picture |
| Privacy | Balances on a public chain | Only tier, score, line, expiry and an evidence hash go on-chain |
| AI gives advice and buys insurance | Licensing; no off-chain execution | Off-chain is advice, on-chain is action |
| Autonomous wallet | Prompt injection, hallucinated transactions | Typed actions, simulation with intent diff, mandate, on-chain guard |
| Too slow for liquidations | LLM latency | Fast path (code playbooks) plus slow path (Claude) |

### Bugs found and fixed by the e2e suite

- **Health-floor false positive.** One second of interest accrues between the before and after reads, so loan-neutral actions (claiming cover) were blocked exactly during a crisis. Fixed with a relative tolerance.
- **Open CORS.** Any website open in the user's browser could POST `/api/actions` to `127.0.0.1` and borrow money as "the user". Fixed with an origin allow-list, a cross-origin mutation block and a Host check against DNS rebinding.

### Ideas borrowed from Aurum (concepts only; that repo is PolyForm-Noncommercial, no code copied)

Capital by behaviour (income / neutral / drain) and by risk level, user-tunable alert thresholds, a full JSON backup, Host-header protection, and bank CSV import with bank profiles.

---

## Production path (what's mocked)

| Here | In production |
|---|---|
| Hardhat local chain, mock tokens and oracle | Mainnet fork for staging, then an L2 with real protocols and oracles |
| Persona data and the simulated bank feed | GoCardless (EEA) or another AIS aggregator; broker APIs |
| Attestor key on the server | Attestor in a TEE with zkTLS proofs |
| Owner key held by the server for the demo | User's passkey or hardware wallet; agent key in KMS/TEE |
| Demo FX table | A daily FX rate feed |
| In-memory store | PostgreSQL with per-user isolation and encrypted tokens |

*Decision support only, not financial advice.*
