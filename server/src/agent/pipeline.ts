import { MaxUint256, isAddress, type Interface } from "ethers";
import {
  addr,
  agentExecute,
  c,
  errorReason,
  f6,
  iface,
  readBalanceSheet,
  readOnchain,
  revertTo,
  snapshot,
  usd6,
  wei,
  withChainLock,
  type BalanceSheet,
  type Call,
  type OnchainState,
} from "../chain.js";
import { signAttestation } from "../engine/credit.js";
import { analyze, fmt } from "../state.js";
import { logEvent, newId, recordProposal, store, transferredToday } from "../store.js";
import type { Check, Delta, Expectation, Ledger, Origin, Payee, Proposal, TypedAction, Verdict } from "./types.js";

/**
 * Every action, whoever proposes it (user click, chat agent, autopilot, attacker), goes through:
 *   1. build      — typed action -> calldata, by deterministic code
 *   2. policy     — off-chain mandate checks
 *   3. simulate   — execute on an EVM snapshot, diff balances vs the declared intent, roll back
 *   4. gate       — autonomy level decides: execute now or ask the owner
 *   5. execute    — agent session key -> AgentWallet, which re-checks its own on-chain policy
 */

interface Built {
  calls: Call[];
  title: string;
  summary: string;
  notionalUsd: number;
  protective: boolean;
  expect: Expectation[];
  expectedValueChangeUsd: number;
}

export interface ProposeOpts {
  bypassPolicy?: boolean;
  protective?: boolean;
  playbook?: string;
  forceApprove?: boolean;
}

const enc = (i: Interface, fn: string, args: unknown[]) => i.encodeFunctionData(fn, args);
const ERC = iface.erc20;

const GUARD_REASONS = [
  "call not allowed by policy",
  "counterparty not allowed",
  "daily outflow limit",
  "health factor floor",
  "agent paused by owner",
  "agent key expired",
  "unauthorized",
];

export function resolvePayee(to: string): Payee | undefined {
  const t = to.trim().toLowerCase();
  return store.payees.find((p) => p.id.toLowerCase() === t || p.address.toLowerCase() === t || p.name.toLowerCase() === t);
}

function positive(n: number, what: string) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) throw new Error(`${what} must be a positive number`);
}

function describe(expect: Expectation[]): string {
  if (!expect.length) return "No balance changes expected";
  return expect
    .map((e) => `${e.ledger} ${e.direction > 0 ? "+" : "−"}${e.ledger === "WETH" || e.ledger === "COLLATERAL" ? fmt.eth(e.approx) : e.ledger === "COVER" ? e.approx : fmt.usd(e.approx, 2)}`)
    .join(" · ");
}

async function build(a: TypedAction, chain: OnchainState): Promise<Built> {
  const p = chain.ethPrice;
  const w = chain.wallet;
  const mk = (b: Omit<Built, "summary">): Built => ({ ...b, summary: describe(b.expect) });

  switch (a.kind) {
    case "deposit_collateral": {
      positive(a.amountEth, "amountEth");
      if (a.amountEth > w.weth + 1e-9) throw new Error(`Wallet holds only ${fmt.eth(w.weth)} WETH`);
      const amt = wei(a.amountEth);
      return mk({
        calls: [
          { target: addr.weth, data: enc(ERC, "approve", [addr.pool, amt]) },
          { target: addr.pool, data: enc(iface.pool, "depositCollateral", [amt]) },
        ],
        title: `Add ${fmt.eth(a.amountEth)} ETH as collateral`,
        notionalUsd: a.amountEth * p,
        protective: true,
        expect: [
          { ledger: "WETH", direction: -1, approx: a.amountEth },
          { ledger: "COLLATERAL", direction: 1, approx: a.amountEth },
        ],
        expectedValueChangeUsd: 0,
      });
    }
    case "withdraw_collateral": {
      positive(a.amountEth, "amountEth");
      return mk({
        calls: [{ target: addr.pool, data: enc(iface.pool, "withdrawCollateral", [wei(a.amountEth)]) }],
        title: `Withdraw ${fmt.eth(a.amountEth)} ETH collateral`,
        notionalUsd: a.amountEth * p,
        protective: false,
        expect: [
          { ledger: "WETH", direction: 1, approx: a.amountEth },
          { ledger: "COLLATERAL", direction: -1, approx: a.amountEth },
        ],
        expectedValueChangeUsd: 0,
      });
    }
    case "borrow": {
      positive(a.amountUsd, "amountUsd");
      return mk({
        calls: [{ target: addr.pool, data: enc(iface.pool, "borrow", [usd6(a.amountUsd)]) }],
        title: `Borrow ${fmt.usd(a.amountUsd)} USDC`,
        notionalUsd: a.amountUsd,
        protective: false,
        expect: [
          { ledger: "USDC", direction: 1, approx: a.amountUsd },
          { ledger: "DEBT", direction: 1, approx: a.amountUsd },
        ],
        expectedValueChangeUsd: 0,
      });
    }
    case "repay": {
      positive(a.amountUsd, "amountUsd");
      const debt = chain.loan.debt;
      if (debt <= 0.000001) throw new Error("There is no outstanding debt");
      const full = a.amountUsd >= debt - 0.01;
      const amount = Math.min(a.amountUsd, debt);
      const needed = full ? debt * 1.0001 + 0.01 : amount;
      if (amount > w.usdc + 1e-6) throw new Error(`Wallet holds only ${fmt.usd(w.usdc, 2)} USDC`);
      return mk({
        calls: [
          { target: addr.usdc, data: enc(ERC, "approve", [addr.pool, usd6(Math.min(needed, w.usdc))]) },
          { target: addr.pool, data: enc(iface.pool, "repay", [full ? MaxUint256 : usd6(amount)]) },
        ],
        title: full ? `Repay the loan in full (${fmt.usd(debt)})` : `Repay ${fmt.usd(amount)} of the loan`,
        notionalUsd: amount,
        protective: true,
        expect: [
          { ledger: "USDC", direction: -1, approx: amount },
          { ledger: "DEBT", direction: -1, approx: amount },
        ],
        expectedValueChangeUsd: 0,
      });
    }
    case "vault_deposit": {
      positive(a.amountUsd, "amountUsd");
      if (a.amountUsd > w.usdc + 1e-6) throw new Error(`Wallet holds only ${fmt.usd(w.usdc, 2)} USDC`);
      const amt = usd6(a.amountUsd);
      return mk({
        calls: [
          { target: addr.usdc, data: enc(ERC, "approve", [addr.vault, amt]) },
          { target: addr.vault, data: enc(iface.vault, "deposit", [amt]) },
        ],
        title: `Move ${fmt.usd(a.amountUsd)} to the treasury vault`,
        notionalUsd: a.amountUsd,
        protective: false,
        expect: [
          { ledger: "USDC", direction: -1, approx: a.amountUsd },
          { ledger: "VAULT", direction: 1, approx: a.amountUsd },
        ],
        expectedValueChangeUsd: 0,
      });
    }
    case "vault_withdraw": {
      positive(a.amountUsd, "amountUsd");
      const bal = w.vault;
      if (bal <= 0.01) throw new Error("The vault balance is empty");
      const all = a.amountUsd >= bal - 0.01;
      const amount = Math.min(a.amountUsd, bal);
      return mk({
        calls: [{ target: addr.vault, data: all ? enc(iface.vault, "withdrawAll", []) : enc(iface.vault, "withdraw", [usd6(amount)]) }],
        title: `Withdraw ${fmt.usd(amount)} from the treasury vault`,
        notionalUsd: amount,
        protective: false,
        expect: [
          { ledger: "VAULT", direction: -1, approx: amount },
          { ledger: "USDC", direction: 1, approx: amount },
        ],
        expectedValueChangeUsd: 0,
      });
    }
    case "buy_cover": {
      positive(a.coverUsd, "coverUsd");
      if (!Number.isInteger(a.days) || a.days < 1 || a.days > 365) throw new Error("days must be a whole number from 1 to 365");
      const premiumRaw: bigint = await c.cover.quote(usd6(a.coverUsd), a.days);
      const premium = f6(premiumRaw);
      if (premium > w.usdc) throw new Error(`Premium ${fmt.usd(premium, 2)} exceeds wallet USDC`);
      return mk({
        calls: [
          { target: addr.usdc, data: enc(ERC, "approve", [addr.cover, premiumRaw]) },
          { target: addr.cover, data: enc(iface.cover, "buyCover", [usd6(a.coverUsd), a.days]) },
        ],
        title: `Buy ${fmt.usd(a.coverUsd)} liquidation cover for ${a.days} days`,
        notionalUsd: premium,
        protective: true,
        expect: [
          { ledger: "USDC", direction: -1, approx: premium },
          { ledger: "COVER", direction: 1, approx: 1 },
        ],
        expectedValueChangeUsd: -premium,
      });
    }
    case "claim_cover": {
      const pol = chain.cover.find((x) => x.id === a.policyId);
      if (!pol) throw new Error(`Policy #${a.policyId} not found`);
      if (pol.claimable <= 0) throw new Error(`Policy #${a.policyId} has nothing to claim`);
      return mk({
        calls: [{ target: addr.cover, data: enc(iface.cover, "claim", [a.policyId]) }],
        title: `Claim ${fmt.usd(pol.claimable, 2)} from cover policy #${a.policyId}`,
        notionalUsd: pol.claimable,
        protective: true,
        expect: [{ ledger: "USDC", direction: 1, approx: pol.claimable }],
        expectedValueChangeUsd: pol.claimable,
      });
    }
    case "swap": {
      positive(a.amount, "amount");
      const fromUsdc = a.from === "USDC";
      if (a.from !== "USDC" && a.from !== "WETH") throw new Error("from must be USDC or WETH");
      const have = fromUsdc ? w.usdc : w.weth;
      if (a.amount > have + 1e-9) throw new Error(`Wallet holds only ${fromUsdc ? fmt.usd(have, 2) : fmt.eth(have)} ${a.from}`);
      const tin = fromUsdc ? addr.usdc : addr.weth;
      const tout = fromUsdc ? addr.weth : addr.usdc;
      const amountIn = fromUsdc ? usd6(a.amount) : wei(a.amount);
      const slip = a.maxSlippageBps ?? 50;
      const quote: bigint = await c.swap.quote(tin, tout, amountIn);
      const minOut = (quote * BigInt(10_000 - slip)) / 10_000n;
      const outNum = fromUsdc ? Number(quote) / 1e18 : Number(quote) / 1e6;
      const notional = fromUsdc ? a.amount : a.amount * p;
      return mk({
        calls: [
          { target: tin, data: enc(ERC, "approve", [addr.swap, amountIn]) },
          { target: addr.swap, data: enc(iface.swap, "swap", [tin, tout, amountIn, minOut]) },
        ],
        title: fromUsdc ? `Swap ${fmt.usd(a.amount)} USDC to ETH` : `Swap ${fmt.eth(a.amount)} ETH to USDC`,
        notionalUsd: notional,
        protective: false,
        expect: [
          { ledger: fromUsdc ? "USDC" : "WETH", direction: -1, approx: a.amount },
          { ledger: fromUsdc ? "WETH" : "USDC", direction: 1, approx: outNum },
        ],
        expectedValueChangeUsd: -notional * 0.003,
      });
    }
    case "transfer": {
      positive(a.amount, "amount");
      const payee = resolvePayee(a.to);
      const to = payee?.address ?? (isAddress(a.to) ? a.to : null);
      if (!to) throw new Error(`Unknown recipient "${a.to}"`);
      const isUsdc = a.token === "USDC";
      const have = isUsdc ? w.usdc : w.weth;
      if (a.amount > have + 1e-9) throw new Error(`Wallet holds only ${have} ${a.token}`);
      const notional = isUsdc ? a.amount : a.amount * p;
      return mk({
        calls: [{ target: isUsdc ? addr.usdc : addr.weth, data: enc(ERC, "transfer", [to, isUsdc ? usd6(a.amount) : wei(a.amount)]) }],
        title: `Send ${isUsdc ? fmt.usd(a.amount, 2) : fmt.eth(a.amount) + " ETH"} to ${payee?.name ?? fmt.short(to)}`,
        notionalUsd: notional,
        protective: false,
        expect: [{ ledger: isUsdc ? "USDC" : "WETH", direction: -1, approx: a.amount }],
        expectedValueChangeUsd: -notional,
      });
    }
    case "refresh_attestation": {
      const { credit } = analyze(chain);
      if (!credit.eligible) throw new Error(`Not eligible: ${credit.reasons.join("; ") || "score too low"}`);
      const att = await signAttestation(addr.wallet, credit, store.sources, chain.chainTime, chain.attestation.nonce);
      const calls: Call[] = [
        {
          target: addr.registry,
          data: enc(iface.registry, "publish", [att.subject, att.tier, att.score, att.creditLineUsd6, att.expiresAt, att.sourcesRoot, att.signature]),
        },
      ];
      if (!chain.loan.pledged) calls.push({ target: addr.pool, data: enc(iface.pool, "pledgeCredit", []) });
      return mk({
        calls,
        title: `${chain.attestation.exists ? "Refresh" : "Publish"} Proof of Wealth: Tier ${credit.tier}, ${fmt.usd(credit.creditLine)} credit line`,
        notionalUsd: 0,
        protective: true,
        expect: [],
        expectedValueChangeUsd: 0,
      });
    }
    case "pledge_credit":
      return mk({
        calls: [{ target: addr.pool, data: enc(iface.pool, "pledgeCredit", []) }],
        title: "Pledge the credit line to the lending pool",
        notionalUsd: 0,
        protective: true,
        expect: [],
        expectedValueChangeUsd: 0,
      });
    case "release_credit":
      return mk({
        calls: [{ target: addr.pool, data: enc(iface.pool, "releaseCredit", []) }],
        title: "Release the credit line from the lending pool",
        notionalUsd: 0,
        protective: false,
        expect: [],
        expectedValueChangeUsd: 0,
      });
    case "raw_call":
      return mk({
        calls: [{ target: a.target, data: a.data }],
        title: a.label,
        notionalUsd: w.usdc,
        protective: false,
        expect: [],
        expectedValueChangeUsd: 0,
      });
  }
}

// ------------------------------------------------------------------ checks

function policyChecks(a: TypedAction, b: Built, chain: OnchainState): Check[] {
  const m = store.mandate;
  const out: Check[] = [];
  const add = (id: string, label: string, pass: boolean, detail: string) => out.push({ id, label, pass, detail, layer: "policy" });

  if (a.kind === "raw_call") {
    add("typed", "Typed actions only", false, "Raw calldata is never accepted from an agent, only typed actions built by code");
  } else {
    const ok = m.allowed[a.kind];
    add("allowed", "Allowed by your mandate", ok, ok ? `"${a.kind.replace(/_/g, " ")}" is enabled` : `"${a.kind.replace(/_/g, " ")}" is disabled in your mandate`);
  }
  if (chain.agentKey.paused) add("key", "Agent key active", false, "You paused the agent key");
  if (a.kind === "transfer") {
    const payee = resolvePayee(a.to);
    add("payee", "Recipient is a saved payee", Boolean(payee), payee ? payee.name : `${fmt.short(a.to)} is not in your address book`);
    const total = transferredToday() + b.notionalUsd;
    add("daily", "Daily transfer limit", total <= m.dailyTransferLimitUsd, `${fmt.usd(total)} of ${fmt.usd(m.dailyTransferLimitUsd)} today`);
  }
  if (a.kind === "borrow") {
    add("borrowcap", "Borrow size cap", a.amountUsd <= m.maxBorrowPerActionUsd, `${fmt.usd(a.amountUsd)}, cap ${fmt.usd(m.maxBorrowPerActionUsd)}`);
  }
  if (a.kind === "swap") {
    const s = a.maxSlippageBps ?? 50;
    add("slippage", "Slippage bound", s <= m.maxSlippageBps, `${s / 100}%, max ${m.maxSlippageBps / 100}%`);
  }
  const usdcOut = b.expect.find((e) => e.ledger === "USDC" && e.direction < 0)?.approx ?? 0;
  if (["vault_deposit", "buy_cover", "transfer", "swap"].includes(a.kind) && usdcOut > 0) {
    const left = chain.wallet.usdc - usdcOut;
    add("reserve", "Cash reserve kept", left >= m.minWalletReserveUsd - 0.01, `${fmt.usd(left)} left, reserve ${fmt.usd(m.minWalletReserveUsd)}`);
  }
  return out;
}

const LEDGERS: Ledger[] = ["USDC", "WETH", "VAULT", "COLLATERAL", "DEBT", "COVER"];
const absTol: Record<Ledger, number> = { USDC: 1, VAULT: 1, DEBT: 1, WETH: 1e-6, COLLATERAL: 1e-6, COVER: 0 };

function diffSheets(before: BalanceSheet, after: BalanceSheet): Delta[] {
  return LEDGERS.map((l) => ({ ledger: l, before: before[l], after: after[l], change: after[l] - before[l] }));
}

function intentCheck(expect: Expectation[], diffs: Delta[]): Check {
  const problems: string[] = [];
  for (const d of diffs) {
    const e = expect.find((x) => x.ledger === d.ledger);
    const tol = Math.max(absTol[d.ledger], e ? e.approx * 0.03 : 0);
    if (!e) {
      if (Math.abs(d.change) > absTol[d.ledger]) problems.push(`unexpected ${d.ledger} change ${d.change > 0 ? "+" : ""}${round(d.change)}`);
      continue;
    }
    if (Math.sign(d.change) !== e.direction || Math.abs(Math.abs(d.change) - e.approx) > tol) {
      problems.push(`${d.ledger} moved ${round(d.change)}, declared ${e.direction > 0 ? "+" : "−"}${round(e.approx)}`);
    }
  }
  return {
    id: "intent",
    label: "Outcome matches declared intent",
    pass: problems.length === 0,
    detail: problems.length ? problems.join("; ") : "Every balance change was declared up front",
    layer: "simulation",
  };
}

const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10000) / 10000);

async function simulate(calls: Call[]) {
  const before = await readBalanceSheet();
  const snap = await snapshot();
  try {
    const { gasUsed } = await agentExecute(calls);
    const after = await readBalanceSheet();
    return { ok: true as const, before, after, gasUsed };
  } catch (e) {
    return { ok: false as const, before, error: errorReason(e) };
  } finally {
    await revertTo(snap);
  }
}

function gate(p: Proposal): Verdict {
  if (p.origin === "user") return "approved";
  const m = store.mandate;
  if (m.autonomy <= 1) return "needs_approval";
  if (m.autonomy === 2) return p.protective || p.notionalUsd <= m.autoApproveLimitUsd ? "approved" : "needs_approval";
  return "approved";
}

function block(p: Proposal, by: Proposal["blockedBy"], error?: string): Proposal {
  p.verdict = "blocked";
  p.status = "blocked";
  p.blockedBy = by;
  if (error) p.error = error;
  recordProposal(p);
  return p;
}

async function runPipeline(p: Proposal, opts: ProposeOpts): Promise<Proposal> {
  p.checks = [];
  p.simulation = undefined;
  p.error = undefined;
  p.blockedBy = undefined;
  const chain = await readOnchain();

  let b: Built;
  try {
    b = await build(p.action, chain);
  } catch (e) {
    p.title ||= p.action.kind.replace(/_/g, " ");
    p.checks.push({ id: "build", label: "Action is well-formed", pass: false, detail: errorReason(e), layer: "policy" });
    return block(p, "policy", errorReason(e));
  }
  p.title = b.title;
  p.notionalUsd = b.notionalUsd;
  p.protective = opts.protective ?? b.protective;
  p.intent = { summary: b.summary, expect: b.expect, expectedValueChangeUsd: b.expectedValueChangeUsd };

  const pc = policyChecks(p.action, b, chain);
  const policyFailed = pc.some((x) => !x.pass);
  if (policyFailed && opts.bypassPolicy) {
    for (const x of pc) if (!x.pass) x.detail += " (bypassed: demo of a compromised off-chain guard)";
  }
  p.checks.push(...pc);
  if (policyFailed && !opts.bypassPolicy) return block(p, "policy");

  const sim = await simulate(b.calls);
  if (!sim.ok) {
    const guard = GUARD_REASONS.some((r) => sim.error.includes(r));
    p.simulation = { ok: false, error: sim.error, diffs: [], hfBefore: sim.before.hf, hfAfter: null, valueChangeUsd: 0 };
    p.checks.push({
      id: guard ? "guard" : "sim",
      label: guard ? "Smart-account guard (on-chain)" : "Simulation on chain snapshot",
      pass: false,
      detail: guard ? `AgentWallet reverted: "${sim.error}"` : `Reverted: ${sim.error}`,
      layer: guard ? "chain" : "simulation",
    });
    return block(p, guard ? "chain" : "simulation", sim.error);
  }

  const diffs = diffSheets(sim.before, sim.after);
  const valueChange = sim.after.netValueUsd - sim.before.netValueUsd;
  p.simulation = { ok: true, diffs, hfBefore: sim.before.hf, hfAfter: sim.after.hf, valueChangeUsd: valueChange, gasUsed: sim.gasUsed };
  const m = store.mandate;
  const valueTol = Math.max(2, Math.abs(b.notionalUsd) * 0.005);
  // "Not worse" allows for the second of interest that accrues between the before/after reads;
  // without the tolerance, loan-neutral actions (claiming cover) would be blocked mid-crisis.
  const hfOk = sim.after.hf === null || sim.after.hf >= m.minHealthFactor || (sim.before.hf !== null && sim.after.hf >= sim.before.hf * (1 - 1e-4));
  const sc: Check[] = [
    { id: "sim", label: "Simulation on chain snapshot", pass: true, detail: `Ran on a snapshot (${sim.gasUsed.toLocaleString("en-US")} gas), then rolled back`, layer: "simulation" },
    intentCheck(b.expect, diffs),
    {
      id: "value",
      label: "No unexplained value leaves",
      pass: valueChange >= b.expectedValueChangeUsd - valueTol,
      detail: `Net value ${valueChange >= 0 ? "+" : ""}${fmt.usd(valueChange, 2)} (expected ${fmt.usd(b.expectedValueChangeUsd, 2)})`,
      layer: "simulation",
    },
    {
      id: "hf",
      label: "Loan health floor",
      pass: hfOk,
      detail: `Health ${fmt.hf(sim.before.hf)} → ${fmt.hf(sim.after.hf)}, floor ${m.minHealthFactor.toFixed(2)}`,
      layer: "policy",
    },
  ];
  p.checks.push(...sc);
  if (sc.some((x) => !x.pass) && !opts.bypassPolicy) return block(p, "simulation");

  p.verdict = opts.forceApprove ? "approved" : gate(p);
  if (p.verdict === "needs_approval") {
    p.status = "pending_approval";
    recordProposal(p);
    return p;
  }

  try {
    const r = await agentExecute(b.calls);
    p.status = "executed";
    p.txHash = r.hash;
    p.executedAt = Date.now();
    if (p.action.kind === "transfer") store.transfers.usd += b.notionalUsd;
    if (p.action.kind === "refresh_attestation") {
      logEvent({ kind: "attestation", title: "Proof of Wealth published on-chain", detail: b.title, txHash: r.hash });
    }
  } catch (e) {
    p.status = "failed";
    p.error = errorReason(e);
  }
  recordProposal(p);
  return p;
}

export function propose(action: TypedAction, origin: Origin, reason: string, opts: ProposeOpts = {}): Promise<Proposal> {
  const p: Proposal = {
    id: newId(),
    createdAt: Date.now(),
    origin,
    action,
    title: "",
    reason,
    notionalUsd: 0,
    protective: false,
    intent: { summary: "", expect: [], expectedValueChangeUsd: 0 },
    checks: [],
    verdict: "blocked",
    status: "blocked",
    playbook: opts.playbook,
  };
  return withChainLock(() => runPipeline(p, opts));
}

export function approveProposal(id: string): Promise<Proposal> {
  const p = store.proposals.find((x) => x.id === id);
  if (!p) return Promise.reject(new Error("Proposal not found"));
  if (p.status !== "pending_approval") return Promise.reject(new Error(`Proposal is ${p.status}`));
  return withChainLock(() => runPipeline(p, { forceApprove: true, protective: p.protective }));
}

export function rejectProposal(id: string): Proposal {
  const p = store.proposals.find((x) => x.id === id);
  if (!p) throw new Error("Proposal not found");
  if (p.status === "pending_approval") {
    p.status = "rejected";
    recordProposal(p);
  }
  return p;
}

/** Validates untrusted (LLM / HTTP) input into a TypedAction. */
export function parseAction(raw: unknown): TypedAction {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (k: string) => {
    const v = typeof o[k] === "string" ? Number(o[k]) : o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`"${k}" must be a number`);
    return v;
  };
  const str = (k: string) => {
    if (typeof o[k] !== "string" || !(o[k] as string).trim()) throw new Error(`"${k}" is required`);
    return (o[k] as string).trim();
  };
  switch (o.kind) {
    case "deposit_collateral":
    case "withdraw_collateral":
      return { kind: o.kind, amountEth: num("amountEth") };
    case "borrow":
    case "repay":
    case "vault_deposit":
    case "vault_withdraw":
      return { kind: o.kind, amountUsd: num("amountUsd") };
    case "buy_cover":
      return { kind: "buy_cover", coverUsd: num("coverUsd"), days: Math.round(num("days")) };
    case "claim_cover":
      return { kind: "claim_cover", policyId: Math.round(num("policyId")) };
    case "swap": {
      const from = str("from").toUpperCase();
      if (from !== "USDC" && from !== "WETH") throw new Error(`"from" must be USDC or WETH`);
      return { kind: "swap", from, amount: num("amount"), maxSlippageBps: o.maxSlippageBps === undefined ? undefined : num("maxSlippageBps") };
    }
    case "transfer": {
      const token = str("token").toUpperCase();
      if (token !== "USDC" && token !== "WETH") throw new Error(`"token" must be USDC or WETH`);
      return { kind: "transfer", token, to: str("to"), amount: num("amount") };
    }
    case "refresh_attestation":
    case "pledge_credit":
    case "release_credit":
      return { kind: o.kind };
    default:
      throw new Error(`Unknown action kind "${String(o.kind)}"`);
  }
}
