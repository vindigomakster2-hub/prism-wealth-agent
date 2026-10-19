import { readOnchain, withChainLock, type OnchainState } from "./chain.js";
import { computeCredit } from "./engine/credit.js";
import { buildRiskReport } from "./engine/risk.js";
import { store } from "./store.js";

/** Risk and credit depend on each other (credit needs risk metrics; risk surfaces credit eligibility). */
export function analyze(chain: OnchainState) {
  const risk0 = buildRiskReport(store.sources, chain, store.mandate, { tier: 0, rateBps: 900, creditLine: 0, eligible: false });
  const credit = computeCredit(store.sources, chain, risk0);
  const risk = buildRiskReport(store.sources, chain, store.mandate, {
    tier: credit.tier,
    rateBps: credit.rateBps,
    creditLine: credit.creditLine,
    eligible: credit.eligible,
  });
  return { risk, credit };
}

export async function snapshotState() {
  const chain = await withChainLock(readOnchain);
  return { chain, ...analyze(chain) };
}

export const fmt = {
  usd: (n: number, digits = 0) =>
    `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`,
  eth: (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 }),
  short: (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a),
  hf: (h: number | null) => (h === null ? "∞" : h.toFixed(2)),
};
