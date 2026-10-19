import type { UHolding } from "./risk.js";

/**
 * Look-through exposure. Funds are broken into their (approximate) index sector and region weights,
 * single positions map directly. Every share is a percentage of GROSS ASSETS, so sectors, regions,
 * currencies and asset groups each add up to 100%.
 */

export const SECTOR_LABEL: Record<string, string> = {
  technology: "Technology",
  communication: "Communication services",
  consumer: "Consumer",
  financials: "Financials",
  health: "Health care",
  industrials: "Industrials",
  energy: "Energy & materials",
  gov_bonds: "Government bonds & T-bills",
  private_credit: "Private credit",
  real_estate: "Real estate",
  crypto: "Crypto",
  cash: "Cash & deposits",
  other: "Other",
};

export const REGION_LABEL: Record<string, string> = {
  us: "United States",
  europe: "Europe",
  japan: "Japan",
  em: "Emerging markets",
  other_dev: "Other developed",
  global_crypto: "Global / on-chain",
};

type Weights = Record<string, number>;
interface Profile {
  sector: Weights;
  region: Weights;
  method: "look-through" | "direct";
  index?: string;
}

// Rounded index weights from public factsheets; a look-through estimate, not live holdings data.
const INDEX: Record<string, { label: string; sector: Weights; region: Weights }> = {
  nasdaq100: {
    label: "Nasdaq-100",
    sector: { technology: 0.5, communication: 0.15, consumer: 0.19, health: 0.06, industrials: 0.05, other: 0.05 },
    region: { us: 0.97, other_dev: 0.03 },
  },
  msci_world: {
    label: "MSCI World",
    sector: { technology: 0.26, financials: 0.16, health: 0.1, industrials: 0.11, consumer: 0.16, communication: 0.08, energy: 0.07, other: 0.06 },
    region: { us: 0.72, europe: 0.15, japan: 0.05, other_dev: 0.08 },
  },
  all_world: {
    label: "FTSE All-World",
    sector: { technology: 0.25, financials: 0.16, health: 0.1, industrials: 0.11, consumer: 0.16, communication: 0.08, energy: 0.07, other: 0.07 },
    region: { us: 0.63, europe: 0.13, japan: 0.06, em: 0.1, other_dev: 0.08 },
  },
  sp500: {
    label: "S&P 500",
    sector: { technology: 0.32, financials: 0.13, health: 0.1, consumer: 0.16, communication: 0.1, industrials: 0.08, energy: 0.06, other: 0.05 },
    region: { us: 1 },
  },
};

const INDEX_MATCH: Array<[RegExp, keyof typeof INDEX]> = [
  [/\bqqq\b|nasdaq[- ]?100/i, "nasdaq100"],
  [/msci world|\biwda\b|\bswda\b|\burth\b/i, "msci_world"],
  [/all[- ]world|\bvwrl\b|\bvwce\b|\bacwi\b/i, "all_world"],
  [/s&p ?500|\bspy\b|\bvoo\b|\bcspx\b|\bivv\b/i, "sp500"],
];

const US_NAMES = /\b(aapl|apple|nvda|nvidia|msft|microsoft|googl?|alphabet|amzn|amazon|meta|tsla|tesla|tlt)\b/i;
const EU_NAMES = /\b(asml|sap|lvmh|nestl[eé]|novo nordisk|siemens)\b/i;
const REGION_BY_ID: Record<string, string> = { "sl-options": "europe", "sl-crowd": "europe", "sl-p2p": "europe", "sl-safe": "us" };

function regionByCurrency(ccy: string): string {
  if (ccy === "USD") return "us";
  if (["EUR", "CZK", "GBP", "CHF", "PLN"].includes(ccy)) return "europe";
  if (["RUB", "KZT", "CNY", "INR", "BRL"].includes(ccy)) return "em";
  if (ccy === "ETH") return "global_crypto";
  return "other_dev";
}

export function profileOf(h: UHolding): Profile {
  const text = `${h.name} ${h.ticker ?? ""}`;
  if (h.assetClass === "etf" || h.assetClass === "pension") {
    const hit = INDEX_MATCH.find(([re]) => re.test(text));
    if (hit) {
      const idx = INDEX[hit[1]];
      return { sector: idx.sector, region: idx.region, method: "look-through", index: idx.label };
    }
  }
  if (h.assetClass === "pension") {
    // Typical balanced pension fund: 60% world equity, 40% government bonds.
    const eq = INDEX.msci_world.sector;
    const sector: Weights = { gov_bonds: 0.4 };
    for (const [k, w] of Object.entries(eq)) sector[k] = (sector[k] ?? 0) + w * 0.6;
    return { sector, region: { ...Object.fromEntries(Object.entries(INDEX.msci_world.region).map(([k, w]) => [k, w * 0.6])), [regionByCurrency(h.currency)]: 0.4 }, method: "look-through", index: "60/40 balanced fund" };
  }

  let sector = "other";
  if (h.group === "Crypto") sector = "crypto";
  else if (h.assetClass === "real_estate") sector = "real_estate";
  else if (h.assetClass === "bond_fund" || h.assetClass === "tbill" || h.sector === "rates") sector = "gov_bonds";
  else if (h.sector === "cash" || h.group === "Cash & deposits") sector = "cash";
  else if (h.sector === "tech") sector = "technology";
  else if (h.sector === "consumer") sector = "consumer";
  else if (h.sector === "credit") sector = "private_credit";
  else if (h.assetClass === "etf") {
    return { sector: INDEX.msci_world.sector, region: INDEX.msci_world.region, method: "look-through", index: "MSCI World (assumed)" };
  }

  let region = REGION_BY_ID[h.id] ?? (US_NAMES.test(text) ? "us" : EU_NAMES.test(text) ? "europe" : "");
  if (!region) region = h.assetClass === "crypto" ? "global_crypto" : h.assetClass === "stablecoin" || h.assetClass === "tbill" ? "us" : regionByCurrency(h.currency);
  return { sector: { [sector]: 1 }, region: { [region]: 1 }, method: "direct" };
}

export function computeExposure(holdings: UHolding[], assets: number, netWorth: number) {
  const sectors = new Map<string, number>();
  const regions = new Map<string, number>();
  const lookThrough: Array<{ id: string; name: string; index: string; value: number }> = [];
  for (const h of holdings) {
    const p = profileOf(h);
    for (const [k, w] of Object.entries(p.sector)) sectors.set(k, (sectors.get(k) ?? 0) + h.valueUsd * w);
    for (const [k, w] of Object.entries(p.region)) regions.set(k, (regions.get(k) ?? 0) + h.valueUsd * w);
    if (p.method === "look-through") lookThrough.push({ id: h.id, name: h.name, index: p.index ?? "", value: h.valueUsd });
  }
  const pct = (v: number) => (assets > 0 ? (v / assets) * 100 : 0);
  const list = (m: Map<string, number>, labels: Record<string, string>) =>
    [...m.entries()]
      .filter(([, v]) => v > 0.5)
      .map(([key, value]) => ({ key, label: labels[key] ?? key, value, pct: pct(value) }))
      .sort((a, b) => b.value - a.value);

  // Concentration: Herfindahl-Hirschman index over individual positions.
  const weights = holdings.filter((h) => h.valueUsd > 0).map((h) => h.valueUsd / Math.max(1, assets));
  const hhi = weights.reduce((a, w) => a + w * w, 0);
  const sorted = [...holdings].sort((a, b) => b.valueUsd - a.valueUsd);
  const top5 = sorted.slice(0, 5).reduce((a, h) => a + h.valueUsd, 0);
  const riskOnValue = (sectors.get("technology") ?? 0) + (sectors.get("crypto") ?? 0);

  return {
    basis: "gross assets" as const,
    sectors: list(sectors, SECTOR_LABEL),
    regions: list(regions, REGION_LABEL),
    lookThrough,
    riskOnValue,
    riskOnPct: pct(riskOnValue),
    concentration: {
      hhi,
      effectivePositions: hhi > 0 ? 1 / hhi : 0,
      top1Pct: pct(sorted[0]?.valueUsd ?? 0),
      top5Pct: pct(top5),
      positions: holdings.length,
    },
    top: sorted.slice(0, 8).map((h) => ({ id: h.id, name: h.name, value: h.valueUsd, pct: pct(h.valueUsd), pctOfNetWorth: netWorth > 0 ? (h.valueUsd / netWorth) * 100 : 0, sector: profileOf(h).method === "direct" ? Object.keys(profileOf(h).sector)[0] : "fund" })),
  };
}
