import type { OnchainState } from "../chain.js";
import { persona, type AssetClass, type Sector, type Source } from "../data/persona.js";
import type { TypedAction } from "../agent/types.js";
import { cash, toUsd } from "../cashflow/state.js";
import { REGION_LABEL, SECTOR_LABEL, computeExposure, profileOf } from "./exposure.js";

export type Group = "Cash & deposits" | "Public equities" | "Bonds & T-bills" | "Private & venture" | "Crypto" | "Real assets & other";

export interface UHolding {
  id: string;
  name: string;
  sourceId: string;
  sourceName: string;
  assetClass: AssetClass | "stablecoin" | "crypto" | "tbill" | "real_estate" | "pension" | "vehicle" | "other_asset";
  group: Group;
  valueUsd: number;
  currency: string;
  selfReported?: boolean;
  ticker?: string;
  liquidityDays: number;
  sector: Sector | "crypto";
  onchain: boolean;
  encumbered?: boolean;
  apyPct?: number;
  /** Volatility / loss potential bucket. */
  riskLevel: RiskLevel;
  /** Does the position pay you, cost you, or just sit there? */
  behavior: Behavior;
}

export type RiskLevel = "low" | "medium" | "high";
export type Behavior = "income" | "neutral" | "drain";

const RISK_OF: Record<string, RiskLevel> = {
  cash: "low",
  savings: "low",
  term_deposit: "low",
  broker_cash: "low",
  stablecoin: "low",
  tbill: "low",
  bond_fund: "low",
  etf: "medium",
  p2p_lending: "medium",
  equity: "high",
  crypto: "high",
  venture: "high",
  private_equity: "high",
  real_estate: "medium",
  pension: "medium",
  vehicle: "medium",
  other_asset: "medium",
};

const MANUAL_ASSET_CLASS: Record<string, UHolding["assetClass"]> = {
  real_estate: "real_estate",
  pension: "pension",
  vehicle: "vehicle",
  crypto_wallet: "crypto",
  private_equity: "private_equity",
  other: "other_asset",
};

export interface ULiability {
  id: string;
  name: string;
  sourceName: string;
  balanceUsd: number;
  aprPct: number;
  monthlyPayment: number;
  onchain: boolean;
  currency?: string;
}

export interface Finding {
  id: string;
  severity: "high" | "medium" | "low";
  category: "concentration" | "liquidity" | "debt" | "protection" | "credit" | "loan" | "yield" | "currency" | "custody";
  title: string;
  detail: string;
  owner: "agent" | "you";
  actionLabel?: string;
  action?: TypedAction;
}

export type StressKind = "group" | "sector" | "region" | "currency" | "institution" | "position";

/** A user-defined shock: "everything in <kind> = <target> moves by <pct>%". Sector/region shocks are look-through weighted. */
export interface StressParam {
  id?: string;
  kind: StressKind;
  target: string;
  pct: number;
  label?: string;
}

export interface StressInput {
  equitiesPct: number;
  cryptoPct: number;
  privatePct: number;
  eurUsdPct: number;
  /** Parallel interest-rate move in basis points: reprices bonds by duration and changes variable interest. */
  ratesBps?: number;
  /** Change in monthly income, e.g. -100 for job loss. Drives the runway estimate. */
  incomePct?: number;
  custom?: StressParam[];
}

const GROUP_OF: Record<string, Group> = {
  cash: "Cash & deposits",
  savings: "Cash & deposits",
  term_deposit: "Cash & deposits",
  broker_cash: "Cash & deposits",
  stablecoin: "Cash & deposits",
  equity: "Public equities",
  etf: "Public equities",
  bond_fund: "Bonds & T-bills",
  tbill: "Bonds & T-bills",
  private_equity: "Private & venture",
  venture: "Private & venture",
  p2p_lending: "Private & venture",
  crypto: "Crypto",
  real_estate: "Real assets & other",
  pension: "Real assets & other",
  vehicle: "Real assets & other",
  other_asset: "Real assets & other",
};

export function unifyHoldings(sources: Source[], chain: OnchainState): { holdings: UHolding[]; liabilities: ULiability[] } {
  const holdings: UHolding[] = [];
  const liabilities: ULiability[] = [];
  for (const s of sources.filter((x) => x.connected)) {
    for (const h of s.holdings) {
      holdings.push({
        id: h.id,
        name: h.name,
        sourceId: s.id,
        sourceName: s.institution,
        assetClass: h.assetClass,
        group: GROUP_OF[h.assetClass],
        valueUsd: h.valueUsd,
        currency: h.currency,
        liquidityDays: h.liquidityDays,
        sector: h.sector,
        onchain: false,
        apyPct: h.apyPct,
        ticker: h.ticker,
        riskLevel: RISK_OF[h.assetClass],
        behavior: h.apyPct ? "income" : "neutral",
        selfReported: s.selfReported,
      });
    }
    for (const l of s.liabilities) {
      liabilities.push({ ...l, sourceName: s.institution, onchain: false });
    }
  }
  // Manual entries: what no API covers (real estate, pensions, mortgages, private IOUs).
  for (const a of cash.assets) {
    const cls = MANUAL_ASSET_CLASS[a.kind] ?? "other_asset";
    holdings.push({
      id: a.id,
      name: a.name,
      sourceId: "manual",
      sourceName: "Manual entry",
      assetClass: cls,
      group: GROUP_OF[cls],
      valueUsd: toUsd(a.value, a.currency),
      currency: a.currency,
      liquidityDays: cls === "crypto" ? 0 : cls === "real_estate" ? 120 : 365,
      sector: cls === "crypto" ? "crypto" : "broad_market",
      onchain: false,
      riskLevel: RISK_OF[cls],
      behavior: "neutral",
      selfReported: true,
    });
  }
  for (const d of cash.debts) {
    liabilities.push({
      id: d.id,
      name: d.name,
      sourceName: d.counterparty ? `Private: ${d.counterparty}` : "Manual entry",
      balanceUsd: toUsd(d.balance, d.currency),
      aprPct: d.aprPct,
      monthlyPayment: toUsd(d.monthlyPayment, d.currency),
      onchain: false,
      currency: d.currency,
    });
  }
  const p = chain.ethPrice;
  const push = (h: Omit<UHolding, "sourceId" | "sourceName" | "onchain" | "group" | "riskLevel" | "behavior">) => {
    if (h.valueUsd > 0.5) {
      holdings.push({
        ...h,
        sourceId: "onchain",
        sourceName: "Abanq wallet",
        onchain: true,
        group: GROUP_OF[h.assetClass],
        riskLevel: RISK_OF[h.assetClass],
        behavior: h.apyPct ? "income" : "neutral",
      });
    }
  };
  push({ id: "oc-usdc", name: "USDC (wallet)", assetClass: "stablecoin", valueUsd: chain.wallet.usdc, currency: "USD", liquidityDays: 0, sector: "cash" });
  push({ id: "oc-weth", name: "ETH (wallet)", assetClass: "crypto", valueUsd: chain.wallet.weth * p, currency: "ETH", liquidityDays: 0, sector: "crypto" });
  push({ id: "oc-vault", name: "Treasury vault (tokenized T-bills)", assetClass: "tbill", valueUsd: chain.wallet.vault, currency: "USD", liquidityDays: 1, sector: "rates", apyPct: chain.vaultApyPct });
  push({ id: "oc-collateral", name: "ETH collateral (loan)", assetClass: "crypto", valueUsd: chain.loan.collateralUsd, currency: "ETH", liquidityDays: 0, sector: "crypto", encumbered: true });
  if (chain.loan.debt > 0.01) {
    liabilities.push({
      id: "oc-loan",
      name: "Hybrid credit line (USDC)",
      sourceName: "Abanq wallet",
      balanceUsd: chain.loan.debt,
      aprPct: chain.loan.rateBps / 100,
      monthlyPayment: (chain.loan.debt * chain.loan.rateBps) / 10000 / 12,
      onchain: true,
    });
  }
  return { holdings, liabilities };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function hfAfterPrice(chain: OnchainState, newPrice: number): number | null {
  const l = chain.loan;
  if (l.debt <= 0) return null;
  const coll = l.collateralEth * newPrice;
  return (coll * 0.8 + Math.min(l.attestedCreditLine, coll * 0.5)) / l.debt;
}

/** Approximate interest-rate duration (years) used to reprice bond-like holdings. */
function durationOf(h: UHolding): number {
  if (h.assetClass === "tbill") return 0.25;
  if (h.assetClass === "bond_fund") return /20y|tlt|long/i.test(`${h.name} ${h.ticker ?? ""}`) ? 16 : 7;
  return 0;
}

function matches(p: StressParam, h: UHolding): number {
  switch (p.kind) {
    case "group":
      return h.group === p.target ? 1 : 0;
    case "sector":
      return profileOf(h).sector[p.target] ?? 0;
    case "region":
      return profileOf(h).region[p.target] ?? 0;
    case "currency":
      return h.currency === p.target ? 1 : 0;
    case "institution":
      return h.sourceName === p.target ? 1 : 0;
    case "position":
      return h.id === p.target ? 1 : 0;
  }
}

export function stressTest(holdings: UHolding[], liabilities: ULiability[], chain: OnchainState, s: StressInput) {
  const rates = s.ratesBps ?? 0;
  const custom = s.custom ?? [];
  const multiplier = (h: UHolding) => {
    let m = 1;
    if (h.group === "Crypto") m *= 1 + s.cryptoPct / 100;
    else if (h.group === "Public equities") m *= 1 + (s.equitiesPct * (1 + 0.25 * (profileOf(h).sector.technology ?? 0))) / 100;
    else if (h.group === "Private & venture") m *= 1 + s.privatePct / 100;
    else if (h.group === "Bonds & T-bills") m *= 1 - (s.equitiesPct * 0.15) / 100; // flight to quality
    if (h.currency === "EUR") m *= 1 + s.eurUsdPct / 100;
    const d = durationOf(h);
    if (d && rates) m *= 1 - (d * rates) / 10000;
    for (const p of custom) {
      const w = matches(p, h);
      if (w) m *= 1 + (p.pct / 100) * w;
    }
    return Math.max(0, m);
  };
  const debtMultiplier = (l: ULiability) => {
    let m = 1;
    for (const p of custom) {
      if ((p.kind === "currency" && (l.currency ?? "USD") === p.target) || (p.kind === "position" && l.id === p.target)) m *= 1 + p.pct / 100;
    }
    return Math.max(0, m);
  };

  const byHolding = holdings.map((h) => ({ id: h.id, name: h.name, group: h.group, before: h.valueUsd, after: h.valueUsd * multiplier(h) }));
  const byLiability = liabilities.map((l) => ({ id: l.id, name: l.name, before: l.balanceUsd, after: l.balanceUsd * debtMultiplier(l) }));
  const debtBefore = sum(byLiability.map((l) => l.before));
  const debtAfter = sum(byLiability.map((l) => l.after));
  const before = sum(byHolding.map((h) => h.before)) - debtBefore;
  const after = sum(byHolding.map((h) => h.after)) - debtAfter;
  const groups = new Map<string, number>();
  for (const h of byHolding) groups.set(h.group, (groups.get(h.group) ?? 0) + h.after - h.before);
  if (debtAfter !== debtBefore) groups.set("Debts", debtBefore - debtAfter);

  // On-chain loan: the collateral's simulated move sets the ETH price for health factors.
  const coll = byHolding.find((h) => h.id === "oc-collateral");
  const ethMove = coll && coll.before > 0 ? coll.after / coll.before : 1 + s.cryptoPct / 100;
  const newPrice = chain.ethPrice * ethMove;
  const hfAfter = hfAfterPrice(chain, newPrice);
  const tl = chain.twin.loan;
  const twinHfAfter = tl.debt > 0 ? (tl.collateralEth * newPrice * 0.8) / tl.debt : null;

  // Cash flow: variable-rate debt and deposits reprice with rates; income shock sets runway.
  const variableDebt = liabilities.filter((l) => !/mortgage|car loan|auto/i.test(l.name));
  const interestDeltaUsd = (sum(variableDebt.map((l) => l.balanceUsd)) * rates) / 10000;
  const depositIncomeDeltaUsd = (sum(holdings.filter((h) => h.behavior === "income" && h.liquidityDays <= 30).map((h) => h.valueUsd)) * rates) / 10000;
  const income = persona.monthlyIncome * (1 + (s.incomePct ?? 0) / 100);
  const outgoings = persona.monthlyExpenses + sum(liabilities.map((l) => l.monthlyPayment)) + interestDeltaUsd / 12;
  const monthlyGapUsd = outgoings - income;
  const liquidAfter = sum(byHolding.filter((h) => {
    const src = holdings.find((x) => x.id === h.id)!;
    return !src.encumbered && src.liquidityDays <= 7;
  }).map((h) => h.after));
  const runwayMonths = monthlyGapUsd > 0 ? liquidAfter / monthlyGapUsd : null;

  return {
    input: s,
    before,
    after,
    delta: after - before,
    deltaPct: pct(after - before, before),
    byGroup: [...groups.entries()].map(([group, delta]) => ({ group, delta })),
    byHolding,
    byLiability,
    topMovers: [...byHolding].sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)).slice(0, 6).map((h) => ({ ...h, delta: h.after - h.before })),
    ethPriceAfter: newPrice,
    hfBefore: chain.loan.healthFactor,
    hfAfter,
    liquidation: hfAfter !== null && hfAfter < 1,
    twinHfAfter,
    cashflow: { interestDeltaUsd, depositIncomeDeltaUsd, netAnnualUsd: depositIncomeDeltaUsd - interestDeltaUsd },
    monthlyGapUsd,
    runwayMonths,
  };
}

/** Everything a custom stress parameter can target, for the scenario builder. */
export function stressTargets(holdings: UHolding[], liabilities: ULiability[]) {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return {
    group: uniq(holdings.map((h) => h.group)).map((v) => ({ value: v, label: v })),
    sector: Object.entries(SECTOR_LABEL).map(([value, label]) => ({ value, label })),
    region: Object.entries(REGION_LABEL).map(([value, label]) => ({ value, label })),
    currency: uniq([...holdings.map((h) => h.currency), ...liabilities.map((l) => l.currency ?? "USD")]).map((v) => ({ value: v, label: v })),
    institution: uniq(holdings.map((h) => h.sourceName)).map((v) => ({ value: v, label: v })),
    position: [...holdings.map((h) => ({ value: h.id, label: `${h.name} · ${h.sourceName}` })), ...liabilities.map((l) => ({ value: l.id, label: `${l.name} (debt)` }))],
  };
}

const STRESS_KINDS: StressKind[] = ["group", "sector", "region", "currency", "institution", "position"];

/** Validates untrusted stress input from the API. */
export function parseStress(b: Record<string, unknown>): StressInput {
  const n = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(Number(v)) ? Number(v) : 0));
  const custom = Array.isArray(b.custom) ? b.custom.slice(0, 20) : [];
  return {
    equitiesPct: n(b.equitiesPct, -100, 200),
    cryptoPct: n(b.cryptoPct, -100, 300),
    privatePct: n(b.privatePct, -100, 200),
    eurUsdPct: n(b.eurUsdPct, -60, 60),
    ratesBps: n(b.ratesBps, -500, 1000),
    incomePct: n(b.incomePct, -100, 200),
    custom: custom
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null && STRESS_KINDS.includes((p as Record<string, unknown>).kind as StressKind) && typeof (p as Record<string, unknown>).target === "string")
      .map((p, i) => ({ id: String(p.id ?? `p${i}`), kind: p.kind as StressKind, target: String(p.target), pct: n(p.pct, -100, 300), label: p.label ? String(p.label).slice(0, 80) : undefined })),
  };
}

export function buildRiskReport(
  sources: Source[],
  chain: OnchainState,
  mandate: { minWalletReserveUsd: number; rescueHealthFactor: number; alerts: { maxCapitalAtRiskPct: number; idleCashUsd: number } },
  creditHint: { tier: number; rateBps: number; creditLine: number; eligible: boolean },
) {
  const { holdings, liabilities } = unifyHoldings(sources, chain);
  const assets = sum(holdings.map((h) => h.valueUsd));
  const debt = sum(liabilities.map((l) => l.balanceUsd));
  const netWorth = assets - debt;
  const offchain = sum(holdings.filter((h) => !h.onchain).map((h) => h.valueUsd)) - sum(liabilities.filter((l) => !l.onchain).map((l) => l.balanceUsd));
  const onchain = chain.wallet.netValue;

  const groups: Group[] = ["Cash & deposits", "Public equities", "Bonds & T-bills", "Private & venture", "Crypto", "Real assets & other"];
  const allocation = groups
    .map((g) => {
      const value = sum(holdings.filter((h) => h.group === g).map((h) => h.valueUsd));
      return { group: g, value, pct: pct(value, assets) };
    })
    .filter((x) => x.value > 0);

  const ladderDefs = [
    { bucket: "Same day", max: 0 },
    { bucket: "Within a week", max: 7 },
    { bucket: "Within a year", max: 365 },
    { bucket: "Over a year", max: Infinity },
  ];
  let lo = -1;
  const liquidityLadder = ladderDefs.map((b) => {
    const value = sum(holdings.filter((h) => !h.encumbered && h.liquidityDays > lo && h.liquidityDays <= b.max).map((h) => h.valueUsd));
    lo = b.max;
    return { bucket: b.bucket, value, pct: pct(value, assets) };
  });
  const encumbered = sum(holdings.filter((h) => h.encumbered).map((h) => h.valueUsd));
  if (encumbered > 0) liquidityLadder.push({ bucket: "Locked as collateral", value: encumbered, pct: pct(encumbered, assets) });

  // Look-through exposure: everything below is a share of GROSS ASSETS, so each breakdown sums to 100%.
  const exposure = computeExposure(holdings, assets, netWorth);
  const riskOnPct = exposure.riskOnPct;
  const sectorExposure = exposure.sectors;

  const currencies = [...new Set(holdings.map((h) => h.currency))]
    .map((ccy) => ({ ccy, value: sum(holdings.filter((h) => h.currency === ccy).map((h) => h.valueUsd)) }))
    .filter((x) => x.value > 0)
    .map((x) => ({ ...x, pct: pct(x.value, assets) }));

  const topHoldings = exposure.top;

  const emergencyCash = sum(holdings.filter((h) => ["cash", "savings", "broker_cash"].includes(h.assetClass)).map((h) => h.valueUsd));
  const emergencyMonths = emergencyCash / persona.monthlyExpenses;

  const depositGuarantee = sources
    .filter((s) => s.connected && s.kind === "bank" && s.depositGuaranteeLimitUsd)
    .map((s) => {
      const amount = sum(s.holdings.map((h) => h.valueUsd));
      return { bank: s.institution, amount, limit: s.depositGuaranteeLimitUsd!, excess: Math.max(0, amount - s.depositGuaranteeLimitUsd!) };
    });

  const policies = sources.filter((s) => s.connected).flatMap((s) => s.policies);
  const insuranceConnected = sources.some((s) => s.connected && s.kind === "insurance");
  const hasLife = policies.some((p) => p.kind === "life" && p.active);
  const activeCover = chain.cover.some((c) => c.active);
  const hf = chain.loan.healthFactor;

  // ---------------------------------------------------------------- findings
  const findings: Finding[] = [];
  const claimable = chain.cover.find((c) => c.claimable > 0);
  if (claimable) {
    findings.push({
      id: "cover-claim",
      severity: "high",
      category: "protection",
      title: `Cover payout available: ${usd(claimable.claimable)}`,
      detail: "Your loan was liquidated while covered. The claim is verified on-chain, so no paperwork is needed.",
      owner: "agent",
      actionLabel: "Claim payout",
      action: { kind: "claim_cover", policyId: claimable.id },
    });
  }
  if (hf !== null && hf < mandate.rescueHealthFactor) {
    findings.push({
      id: "loan-health",
      severity: "high",
      category: "loan",
      title: `Loan health ${hf.toFixed(2)}: close to liquidation`,
      detail: `Liquidation starts at 1.00. At ETH ${usd(chain.loan.liquidationPrice ?? 0)} the position can be seized with a 5% penalty.`,
      owner: "agent",
      actionLabel: "Run rescue playbook",
    });
  } else if (hf !== null && hf < 1.6) {
    findings.push({
      id: "loan-health",
      severity: "medium",
      category: "loan",
      title: `Thin safety buffer on the loan (health ${hf.toFixed(2)})`,
      detail: `A ${Math.round((1 - (chain.loan.liquidationPrice ?? 0) / chain.ethPrice) * 100)}% ETH drop triggers liquidation.`,
      owner: "agent",
    });
  }
  if (riskOnPct > 35) {
    findings.push({
      id: "risk-on",
      severity: riskOnPct > 45 ? "high" : "medium",
      category: "concentration",
      title: `${Math.round(riskOnPct)}% of your assets ride the tech cycle`,
      detail: `Look-through technology plus crypto, counting funds by their index weights (QQQ is about half tech). Employer options, NVDA/AAPL/MSFT, the SAFE and ETH tend to fall together, and your salary depends on the same sector. Effective number of positions: ${exposure.concentration.effectivePositions.toFixed(1)}.`,
      owner: "you",
      actionLabel: "Trim single-name tech by ~$20k into broad-market or bond funds",
    });
  }
  for (const d of depositGuarantee.filter((x) => x.excess > 0)) {
    findings.push({
      id: `dgs-${d.bank}`,
      severity: "medium",
      category: "custody",
      title: `${usd(d.excess)} above the deposit guarantee at ${d.bank}`,
      detail: `Guaranteed up to ${usd(d.limit)} per bank. The excess is unprotected if the bank fails.`,
      owner: "you",
      actionLabel: "Split the deposit across two banks at maturity",
    });
  }
  for (const l of liabilities.filter((x) => !x.onchain && x.aprPct > 15)) {
    findings.push({
      id: `debt-${l.id}`,
      severity: "medium",
      category: "debt",
      title: `${l.name} at ${l.aprPct}% APR`,
      detail: `Paying ${usd(l.balanceUsd)} from savings (3.1%) saves about ${usd((l.balanceUsd * (l.aprPct - 3.1)) / 100)} a year.`,
      owner: "you",
      actionLabel: "Pay off the balance from instant savings",
    });
  }
  if (insuranceConnected && persona.dependents > 0 && !hasLife) {
    findings.push({
      id: "life-gap",
      severity: "high",
      category: "protection",
      title: "No life cover with a dependent",
      detail: `Rule of thumb: about 10× income (${usd(persona.monthlyIncome * 12 * 10)}). Term life at ${persona.age} is usually inexpensive. Indicative only, not advice.`,
      owner: "you",
      actionLabel: "Compare term-life quotes",
    });
  }
  if (chain.loan.debt > 0 && !activeCover) {
    const coverUsd = Math.max(500, Math.ceil((chain.loan.debt * 0.1) / 100) * 100);
    findings.push({
      id: "loan-cover",
      severity: "medium",
      category: "protection",
      title: "On-chain loan has no liquidation cover",
      detail: `Parametric cover of ${usd(coverUsd)} for 90 days costs about ${usd((coverUsd * 0.04 * 90) / 365)} and pays out automatically if the loan is liquidated.`,
      owner: "agent",
      actionLabel: "Buy cover",
      action: { kind: "buy_cover", coverUsd, days: 90 },
    });
  }
  const idle = chain.wallet.usdc - mandate.minWalletReserveUsd;
  if (idle > mandate.alerts.idleCashUsd) {
    const loanRate = chain.loan.rateBps / 100;
    const repayBetter = chain.loan.debt > 0 && loanRate > chain.vaultApyPct;
    const amount = Math.floor(repayBetter ? Math.min(idle, chain.loan.debt) : idle);
    findings.push({
      id: "idle-cash",
      severity: "low",
      category: "yield",
      title: `${usd(idle)} USDC sitting idle`,
      detail: repayBetter
        ? `Repaying ${loanRate.toFixed(1)}% debt beats the ${chain.vaultApyPct}% treasury vault.`
        : `The treasury vault pays ${chain.vaultApyPct}% with next-day liquidity.`,
      owner: "agent",
      actionLabel: repayBetter ? `Repay ${usd(amount)}` : `Move ${usd(amount)} to the vault`,
      action: repayBetter ? { kind: "repay", amountUsd: amount } : { kind: "vault_deposit", amountUsd: amount },
    });
  }
  if (!chain.attestation.active && creditHint.eligible) {
    findings.push({
      id: "proof",
      severity: "medium",
      category: "credit",
      title: chain.attestation.exists ? "Proof of Wealth expired" : "Off-chain wealth isn't working for you on-chain",
      detail: `You pay ${(chain.loan.rateBps / 100).toFixed(1)}% APR. Verified bank and broker assets qualify you for Tier ${creditHint.tier}: ${(creditHint.rateBps / 100).toFixed(1)}% APR and a ${usd(creditHint.creditLine)} credit line.`,
      owner: "agent",
      actionLabel: chain.attestation.exists ? "Refresh proof" : "Publish proof",
      action: { kind: "refresh_attestation" },
    });
  } else if (chain.attestation.active && chain.attestation.expiresAt - chain.chainTime < 5 * 86400) {
    findings.push({
      id: "proof-expiring",
      severity: "medium",
      category: "credit",
      title: "Proof of Wealth expires soon",
      detail: "When it lapses, the credit line and rate discount disappear and loan health drops.",
      owner: "agent",
      actionLabel: "Refresh proof",
      action: { kind: "refresh_attestation" },
    });
  }
  const eurShare = currencies.find((x) => x.ccy === "EUR")?.pct ?? 0;
  if (eurShare > 25) {
    findings.push({
      id: "fx",
      severity: "low",
      category: "currency",
      title: `${Math.round(eurShare)}% of assets in EUR, spending in USD`,
      detail: "A 10% EUR/USD move shifts net worth by about " + usd((assets * eurShare) / 1000) + ".",
      owner: "you",
    });
  }

  // --------------------------------------------- capital by risk level & by behaviour
  const levels: RiskLevel[] = ["low", "medium", "high"];
  const byRisk = levels.map((level) => {
    const value = sum(holdings.filter((h) => h.riskLevel === level).map((h) => h.valueUsd));
    return { level, value, pct: pct(value, assets) };
  });
  const capitalAtRiskPct = byRisk[2].pct;
  const passiveIncomeUsd = sum(holdings.map((h) => (h.valueUsd * (h.apyPct ?? 0)) / 100));
  const interestCostUsd = sum(liabilities.map((l) => (l.balanceUsd * l.aprPct) / 100));
  const premiumsUsd = sum(policies.filter((p) => p.active).map((p) => p.premiumMonthly * 12));
  const byBehavior = [
    { behavior: "income" as Behavior, value: sum(holdings.filter((h) => h.behavior === "income").map((h) => h.valueUsd)), annualUsd: passiveIncomeUsd },
    { behavior: "neutral" as Behavior, value: sum(holdings.filter((h) => h.behavior === "neutral").map((h) => h.valueUsd)), annualUsd: 0 },
    { behavior: "drain" as Behavior, value: debt, annualUsd: -(interestCostUsd + premiumsUsd) },
  ];
  const cashflow = { passiveIncomeUsd, interestCostUsd, premiumsUsd, netUsd: passiveIncomeUsd - interestCostUsd - premiumsUsd };

  if (capitalAtRiskPct > mandate.alerts.maxCapitalAtRiskPct) {
    findings.push({
      id: "capital-at-risk",
      severity: capitalAtRiskPct > mandate.alerts.maxCapitalAtRiskPct + 15 ? "high" : "medium",
      category: "concentration",
      title: `${Math.round(capitalAtRiskPct)}% of capital is in high-risk assets`,
      detail: `Your alert limit is ${mandate.alerts.maxCapitalAtRiskPct}%. Single stocks, crypto and private stakes can lose most of their value in a bad year.`,
      owner: "you",
      actionLabel: "Move part of the single-stock positions into low-risk assets",
    });
  }
  if (cashflow.netUsd < 0) {
    findings.push({
      id: "drains",
      severity: "low",
      category: "yield",
      title: `Interest and premiums cost ${usd(interestCostUsd + premiumsUsd)}/yr, more than passive income`,
      detail: `Your assets pay ${usd(passiveIncomeUsd)}/yr. The most expensive drain is the ${liabilities.slice().sort((a, b) => b.aprPct - a.aprPct)[0]?.name.toLowerCase() ?? "debt"} at ${liabilities.slice().sort((a, b) => b.aprPct - a.aprPct)[0]?.aprPct ?? 0}% APR.`,
      owner: chain.loan.debt > 0 && !chain.attestation.active && creditHint.eligible ? "agent" : "you",
      actionLabel: chain.loan.debt > 0 && !chain.attestation.active && creditHint.eligible ? "Publish proof to cut the loan rate" : "Pay down the most expensive debt first",
      action: chain.loan.debt > 0 && !chain.attestation.active && creditHint.eligible ? { kind: "refresh_attestation" } : undefined,
    });
  }

  const checks = [
    { label: "Emergency fund", ok: emergencyMonths >= 6, detail: `${emergencyMonths.toFixed(1)} months of expenses in cash` },
    { label: "Debt-to-assets", ok: pct(debt, assets) < 30, detail: `${pct(debt, assets).toFixed(1)}% of assets` },
    { label: "Income stability", ok: true, detail: "6 of 6 salary payments on time" },
    { label: "Health insurance", ok: policies.some((p) => p.kind === "health" && p.active), detail: "Family plan active" },
  ];

  // ------------------------------------------------------------- risk score
  const illiquidPct = pct(sum(holdings.filter((h) => h.liquidityDays > 365).map((h) => h.valueUsd)), assets);
  const loanRisk = hf === null ? 0 : hf >= 2 ? 5 : hf >= 1.6 ? 25 : hf >= 1.35 ? 55 : hf >= 1.15 ? 80 : 100;
  const protectionGap = (!hasLife && persona.dependents > 0 ? 60 : 0) + (chain.loan.debt > 0 && !activeCover ? 40 : 0);
  const components = [
    { key: "Concentration", value: clamp(((riskOnPct - 20) / 40) * 100), weight: 0.25 },
    { key: "Loan health", value: loanRisk, weight: 0.2 },
    { key: "Protection gaps", value: clamp(protectionGap), weight: 0.15 },
    { key: "Illiquidity", value: clamp((illiquidPct / 40) * 100), weight: 0.15 },
    { key: "Leverage", value: clamp((pct(debt, assets) / 40) * 100), weight: 0.15 },
    { key: "Custody & FX", value: clamp((depositGuarantee.some((d) => d.excess > 0) ? 60 : 0) + (eurShare > 25 ? 40 : 0)), weight: 0.1 },
  ];
  const riskScore = Math.round(sum(components.map((c) => c.value * c.weight)));
  const riskLabel = riskScore < 30 ? "Low" : riskScore < 50 ? "Moderate" : riskScore < 70 ? "Elevated" : "High";

  const sevRank = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  return {
    holdings,
    liabilities,
    totals: {
      assets,
      debt,
      netWorth,
      offchain,
      onchain,
      liquidSameWeek: liquidityLadder[0].value + liquidityLadder[1].value,
      /** "Real balance": what you could actually raise within a week, minus everything you owe. */
      trueBalance: liquidityLadder[0].value + liquidityLadder[1].value - debt,
    },
    allocation,
    liquidityLadder,
    sectorExposure,
    exposure,
    currencies,
    topHoldings,
    riskOnPct,
    emergencyMonths,
    depositGuarantee,
    insurance: { policies, hasLife, connected: insuranceConnected },
    byRisk,
    capitalAtRiskPct,
    byBehavior,
    cashflow,
    findings,
    checks,
    riskScore,
    riskLabel,
    components,
  };
}

export type RiskReport = ReturnType<typeof buildRiskReport>;
