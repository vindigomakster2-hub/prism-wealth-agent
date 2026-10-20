import { keccak256, toUtf8Bytes, concat } from "ethers";
import { addr, signers, usd6 } from "../chain.js";
import type { OnchainState } from "../chain.js";
import { persona, type Source } from "../data/persona.js";
import type { RiskReport } from "./risk.js";

/** Haircut = share of a verified off-chain asset that counts toward the credit line. */
export const HAIRCUTS: Record<string, { pct: number; reason: string }> = {
  cash: { pct: 70, reason: "Withdrawable at any time, so only a snapshot" },
  savings: { pct: 70, reason: "Withdrawable at any time, so only a snapshot" },
  broker_cash: { pct: 70, reason: "Withdrawable at any time, so only a snapshot" },
  term_deposit: { pct: 80, reason: "Locked until maturity, which makes it sticky" },
  equity: { pct: 50, reason: "Single-name price volatility" },
  etf: { pct: 60, reason: "Diversified, daily liquidity" },
  bond_fund: { pct: 75, reason: "Low volatility" },
  private_equity: { pct: 0, reason: "Illiquid, and the valuation can't be verified by a market" },
  venture: { pct: 0, reason: "Illiquid, and the valuation can't be verified by a market" },
  p2p_lending: { pct: 0, reason: "Illiquid with borrower credit risk" },
};

export const TIER_RATE_BPS = [900, 750, 600, 450];
export const TIER_CAP_USD = [0, 5_000, 15_000, 50_000];
export const TIER_MIN_SCORE = [0, 640, 720, 800];
export const CREDIT_RATIO = 0.15;
export const ATTESTATION_DAYS = 30;

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

export function computeCredit(sources: Source[], chain: OnchainState, risk: RiskReport) {
  // Only API-verified sources count: CSV imports and manual entries are self-reported.
  const connected = sources.filter((s) => s.connected && !s.selfReported && (s.kind === "bank" || s.kind === "broker" || s.kind === "venture"));
  const pledgeable = connected.flatMap((s) =>
    s.holdings.map((h) => {
      const hc = HAIRCUTS[h.assetClass] ?? { pct: 0, reason: "Unsupported asset" };
      return {
        id: h.id,
        name: h.name,
        institution: s.institution,
        assetClass: h.assetClass,
        valueUsd: h.valueUsd,
        haircutPct: hc.pct,
        pledgeableUsd: (h.valueUsd * hc.pct) / 100,
        reason: hc.reason,
      };
    }),
  );
  const totalVerified = pledgeable.reduce((a, b) => a + b.valueUsd, 0);
  const totalPledgeable = pledgeable.reduce((a, b) => a + b.pledgeableUsd, 0);

  const salaryCount = sources.find((s) => s.id === "northwind" && s.connected)?.transactions.filter((t) => t.description.startsWith("Salary")).length ?? 0;
  const monthlyDebt = risk.liabilities.filter((l) => !l.onchain).reduce((a, l) => a + l.monthlyPayment, 0);
  const dti = (monthlyDebt / persona.monthlyIncome) * 100;
  const liqCount = chain.loan.liquidationCount;

  const factors = [
    {
      key: "wealth",
      label: "Verified liquid wealth",
      weight: 0.25,
      score: clamp((100 * Math.log10(1 + totalPledgeable / 1000)) / Math.log10(501)),
      detail: `$${Math.round(totalPledgeable).toLocaleString("en-US")} after haircuts`,
    },
    {
      key: "income",
      label: "Income stability",
      weight: 0.2,
      score: salaryCount >= 6 ? 95 : salaryCount * 15,
      detail: salaryCount ? `${salaryCount} of 6 months of salary verified` : "Connect a salary account",
    },
    { key: "debt", label: "Debt burden", weight: 0.15, score: clamp(100 - dti * 2), detail: `${dti.toFixed(1)}% of income goes to debt payments` },
    {
      key: "buffer",
      label: "Liquidity buffer",
      weight: 0.15,
      score: clamp((risk.emergencyMonths / 6) * 100),
      detail: `${risk.emergencyMonths.toFixed(1)} months of expenses in cash`,
    },
    {
      key: "onchain",
      label: "On-chain track record",
      weight: 0.15,
      score: clamp(60 + Math.min(20, persona.walletAgeYears * 6) + (liqCount === 0 ? 15 : -20 * liqCount)),
      detail: `${persona.walletAgeYears}-year-old wallet, ${liqCount} liquidation${liqCount === 1 ? "" : "s"}`,
    },
    {
      key: "diversification",
      label: "Diversification",
      weight: 0.1,
      score: clamp(100 - Math.max(0, risk.riskOnPct - 25) * 2),
      detail: `${Math.round(risk.riskOnPct)}% of net worth in tech and crypto`,
    },
  ];
  const s01 = factors.reduce((a, f) => a + (f.score * f.weight) / 100, 0);
  const score = Math.round(300 + 550 * s01);
  const tier = score >= TIER_MIN_SCORE[3] ? 3 : score >= TIER_MIN_SCORE[2] ? 2 : score >= TIER_MIN_SCORE[1] ? 1 : 0;
  const creditLine = tier === 0 ? 0 : Math.floor(Math.min(totalPledgeable * CREDIT_RATIO, TIER_CAP_USD[tier]) / 100) * 100;

  const coll = chain.loan.collateralUsd;
  const standardMax = coll * 0.7;
  const hybridMax = coll * 0.7 + Math.min(creditLine, coll * 0.5);
  const debt = chain.loan.debt;
  const nextTierGap = tier < 3 ? TIER_MIN_SCORE[tier + 1] - score : 0;

  const reasons: string[] = [];
  if (!connected.some((s) => s.kind === "bank")) reasons.push("Connect at least one bank account");
  if (tier === 0) reasons.push(`Score ${score} is below the Tier 1 minimum of ${TIER_MIN_SCORE[1]}`);

  return {
    score,
    tier,
    eligible: tier > 0 && reasons.length === 0,
    reasons,
    rateBps: TIER_RATE_BPS[tier],
    creditLine,
    factors,
    pledgeable,
    totalVerified,
    totalPledgeable,
    creditRatioPct: CREDIT_RATIO * 100,
    tiers: TIER_MIN_SCORE.map((min, t) => ({ tier: t, minScore: min, rateBps: TIER_RATE_BPS[t], capUsd: TIER_CAP_USD[t] })),
    nextTier: tier < 3 ? { tier: tier + 1, pointsNeeded: nextTierGap, rateBps: TIER_RATE_BPS[tier + 1] } : null,
    comparison: {
      standard: { ltvPct: 70, aprPct: TIER_RATE_BPS[0] / 100, maxBorrow: standardMax, available: Math.max(0, standardMax - debt) },
      hybrid: { ltvPct: coll > 0 ? (hybridMax / coll) * 100 : 70, aprPct: TIER_RATE_BPS[tier] / 100, maxBorrow: hybridMax, available: Math.max(0, hybridMax - debt) },
      annualSavingsUsd: (debt * (TIER_RATE_BPS[0] - TIER_RATE_BPS[tier])) / 10000,
    },
  };
}

export type CreditProfile = ReturnType<typeof computeCredit>;

/** Commitment to the evidence behind the attestation (per-source snapshot hashes). */
export function evidenceRoot(sources: Source[]): { root: string; leaves: Array<{ source: string; hash: string }> } {
  const leaves = sources
    .filter((s) => s.connected && !s.selfReported && s.kind !== "insurance")
    .map((s) => {
      const snapshot = JSON.stringify({ id: s.id, holdings: s.holdings.map((h) => [h.id, h.valueUsd]), lastSync: s.lastSync });
      return { source: s.institution, hash: keccak256(toUtf8Bytes(snapshot)) };
    });
  const root = leaves.length ? keccak256(concat(leaves.map((l) => l.hash))) : keccak256(toUtf8Bytes("empty"));
  return { root, leaves };
}

/** Attestor signs an EIP-712 attestation. In production this runs inside a TEE fed by zkTLS proofs. */
export async function signAttestation(subject: string, profile: CreditProfile, sources: Source[], chainNow: number, nonce: number) {
  const expiresAt = chainNow + ATTESTATION_DAYS * 86400;
  const { root } = evidenceRoot(sources);
  const value = {
    subject,
    tier: profile.tier,
    score: profile.score,
    creditLineUsd6: usd6(profile.creditLine),
    expiresAt,
    sourcesRoot: root,
    nonce,
  };
  const signature = await signers.attestor.signTypedData(
    { name: "AbanqCreditRegistry", version: "1", chainId: 31337, verifyingContract: addr.registry },
    {
      Attestation: [
        { name: "subject", type: "address" },
        { name: "tier", type: "uint8" },
        { name: "score", type: "uint16" },
        { name: "creditLineUsd6", type: "uint256" },
        { name: "expiresAt", type: "uint64" },
        { name: "sourcesRoot", type: "bytes32" },
        { name: "nonce", type: "uint256" },
      ],
    },
    value,
  );
  return { ...value, signature };
}
