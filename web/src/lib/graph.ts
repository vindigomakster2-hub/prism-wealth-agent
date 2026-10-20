import { Coins, CreditCard, House, Landmark, ChartCandlestick, Rocket, ScrollText, Umbrella, type LucideIcon } from "lucide-react";
import type { AppState, StressResult } from "../api";

export type CatId = "cash" | "equities" | "bonds" | "private" | "crypto" | "real" | "debts" | "insurance";
export type LeafKind = "asset" | "debt" | "policy";

export interface Leaf {
  id: string;
  name: string;
  institution: string;
  cat: CatId;
  kind: LeafKind;
  value: number;
  onchain: boolean;
  sourceId: string;
  behavior: "income" | "neutral" | "drain";
  riskLevel: "low" | "medium" | "high";
  liquidityDays?: number;
  apyPct?: number;
  aprPct?: number;
  haircutPct?: number;
  pledgeableUsd?: number;
  currency?: string;
  sector?: string;
  assetClass?: string;
  group?: string;
  missing?: boolean;
  encumbered?: boolean;
  monthly?: number;
}

export interface Category {
  id: CatId;
  label: string;
  color: string;
  icon: LucideIcon;
  kind: LeafKind;
  value: number;
  leaves: Leaf[];
  institutions: string[];
  sharePct: number;
}

export const CAT_META: Record<CatId, { label: string; color: string; icon: LucideIcon; kind: LeafKind; group?: string }> = {
  cash: { label: "Deposits & cash", color: "#3987e5", icon: Landmark, kind: "asset", group: "Cash & deposits" },
  equities: { label: "Stocks & ETFs", color: "#d95926", icon: ChartCandlestick, kind: "asset", group: "Public equities" },
  bonds: { label: "Bonds & T-bills", color: "#199e70", icon: ScrollText, kind: "asset", group: "Bonds & T-bills" },
  private: { label: "Venture & private", color: "#c98500", icon: Rocket, kind: "asset", group: "Private & venture" },
  crypto: { label: "Crypto", color: "#d55181", icon: Coins, kind: "asset", group: "Crypto" },
  real: { label: "Real assets & other", color: "#efe6d2", icon: House, kind: "asset", group: "Real assets & other" },
  debts: { label: "Debts", color: "#a9a2a7", icon: CreditCard, kind: "debt" },
  insurance: { label: "Insurance", color: "#e3f56b", icon: Umbrella, kind: "policy" },
};

export const CAT_ORDER: CatId[] = ["cash", "equities", "bonds", "private", "crypto", "real", "debts", "insurance"];
const CAT_OF_GROUP = Object.fromEntries(Object.entries(CAT_META).filter(([, m]) => m.group).map(([id, m]) => [m.group, id])) as Record<string, CatId>;

export type SortKey = "value" | "liquidity" | "name";
export type SourceFilter = "all" | "offchain" | "onchain";

export function buildGraph(s: AppState, opts: { sort: SortKey; hidden: CatId[]; source: SourceFilter }) {
  const haircut = new Map(s.credit.pledgeable.map((p) => [p.id, p]));
  const leaves: Leaf[] = [];

  for (const h of s.risk.holdings) {
    const hc = haircut.get(h.id);
    leaves.push({
      id: h.id,
      name: h.name,
      institution: h.sourceName,
      cat: CAT_OF_GROUP[h.group],
      kind: "asset",
      value: h.valueUsd,
      onchain: h.onchain,
      sourceId: h.sourceId,
      behavior: h.behavior,
      riskLevel: h.riskLevel,
      liquidityDays: h.liquidityDays,
      apyPct: h.apyPct,
      haircutPct: hc?.haircutPct,
      pledgeableUsd: hc?.pledgeableUsd,
      currency: h.currency,
      sector: h.sector,
      assetClass: h.assetClass,
      group: h.group,
      encumbered: h.encumbered,
    });
  }
  for (const l of s.risk.liabilities) {
    leaves.push({
      id: l.id,
      name: l.name,
      institution: l.sourceName,
      cat: "debts",
      kind: "debt",
      value: -l.balanceUsd,
      onchain: l.onchain,
      sourceId: l.onchain ? "onchain" : "",
      behavior: "drain",
      riskLevel: l.aprPct > 15 ? "high" : l.aprPct > 7 ? "medium" : "low",
      aprPct: l.aprPct,
      monthly: l.monthlyPayment,
    });
  }
  if (s.risk.insurance.connected) {
    for (const p of s.risk.insurance.policies) {
      leaves.push({
        id: p.id,
        name: p.name,
        institution: "Harbor Insurance",
        cat: "insurance",
        kind: "policy",
        value: p.coverageUsd,
        onchain: false,
        sourceId: "harbor",
        behavior: "drain",
        riskLevel: "low",
        monthly: p.premiumMonthly,
      });
    }
    for (const c of s.chain.cover.filter((x) => x.active)) {
      leaves.push({
        id: `cover-${c.id}`,
        name: `Liquidation cover #${c.id}`,
        institution: "Abanq wallet",
        cat: "insurance",
        kind: "policy",
        value: c.coverUsd,
        onchain: true,
        sourceId: "onchain",
        behavior: "drain",
        riskLevel: "low",
      });
    }
    if (!s.risk.insurance.hasLife) {
      leaves.push({
        id: "life-missing",
        name: "Life cover",
        institution: "Not covered",
        cat: "insurance",
        kind: "policy",
        value: 0,
        onchain: false,
        sourceId: "harbor",
        behavior: "neutral",
        riskLevel: "high",
        missing: true,
      });
    }
  }

  const visible = leaves.filter((l) => opts.source === "all" || (opts.source === "onchain" ? l.onchain : !l.onchain));
  const sorter = (a: Leaf, b: Leaf) =>
    opts.sort === "name" ? a.name.localeCompare(b.name) : opts.sort === "liquidity" ? (a.liquidityDays ?? 999) - (b.liquidityDays ?? 999) : Math.abs(b.value) - Math.abs(a.value);

  // Shares are measured against gross assets, the same base the Risk page uses, so they add up to 100%.
  const grossAssets = s.risk.totals.assets;
  const categories: Category[] = CAT_ORDER.filter((id) => !opts.hidden.includes(id))
    .map((id) => {
      const meta = CAT_META[id];
      const own = visible.filter((l) => l.cat === id).sort(sorter);
      const value = meta.kind === "policy" ? own.reduce((a, l) => a + l.value, 0) : own.reduce((a, l) => a + l.value, 0);
      return {
        id,
        label: meta.label,
        color: meta.color,
        icon: meta.icon,
        kind: meta.kind,
        value,
        leaves: own,
        institutions: [...new Set(own.filter((l) => !l.missing).map((l) => l.institution))],
        sharePct: meta.kind === "policy" ? 0 : (Math.abs(value) / Math.max(1, grossAssets)) * 100,
      };
    })
    .filter((c) => c.leaves.length > 0);

  return { categories, leaves: categories.flatMap((c) => c.leaves), all: leaves };
}

/** Simulated value per node id, taken from the server's stress result (assets and debts). */
export type SimValues = Map<string, number> | null;

export function simValues(result: StressResult | null | undefined): SimValues {
  if (!result) return null;
  const m = new Map<string, number>();
  for (const h of result.byHolding) m.set(h.id, h.after);
  for (const l of result.byLiability) m.set(l.id, -l.after);
  return m;
}

export const shocked = (l: Leaf, sim: SimValues) => (sim && l.kind !== "policy" ? sim.get(l.id) ?? l.value : l.value);

export function liquidityLabel(days?: number) {
  if (days === undefined) return "n/a";
  if (days <= 0) return "Same day";
  if (days <= 7) return `${days} day${days > 1 ? "s" : ""}`;
  if (days <= 365) return `${Math.round(days / 30)} mo`;
  return `${(days / 365).toFixed(1)} yr`;
}

export const LEAF_GAP = 40; // vertical px reserved per position label: no two labels can overlap
const TOP_RESERVE = 64; // room for the stage pill and simulation banner
const BOTTOM_RESERVE = 28;

/**
 * Layout: orb on the left, category column, positions on an arc to the right (after the reference).
 * The canvas grows taller than the viewport when there are many positions; the caller scales it to fit.
 */
export function layout(viewW: number, viewH: number, categories: Category[], collapsed: CatId[]) {
  const leaves = categories.filter((c) => !collapsed.includes(c.id)).flatMap((c) => c.leaves);
  const n = Math.max(1, categories.length);
  const needH = Math.max(leaves.length * LEAF_GAP, n * 84) + TOP_RESERVE + BOTTOM_RESERVE;
  const H = Math.max(viewH, needH);
  const fit = Math.min(1, viewH / H);
  const W = viewW / fit;
  const cy = TOP_RESERVE + (H - TOP_RESERVE - BOTTOM_RESERVE) / 2;
  const orb = { x: Math.max(130, W * 0.12), y: cy, r: 40 };
  const cardW = Math.min(214, Math.max(170, W * 0.18));
  const gap = 12;
  const cardH = Math.min(76, (H - TOP_RESERVE - BOTTOM_RESERVE - gap * (n - 1)) / n);
  const colX = orb.x + Math.max(150, W * 0.14);
  const total = n * cardH + (n - 1) * gap;
  const cards = categories.map((c, i) => ({ id: c.id, x: colX, y: cy - total / 2 + i * (cardH + gap), w: cardW, h: cardH }));

  const labelW = 200;
  const xMid = W - labelW - 16;
  const xEnd = colX + cardW + 120;
  const yExt = Math.max(60, (Math.max(leaves.length - 1, 1) * LEAF_GAP) / 2);
  const d = Math.max(40, xMid - xEnd);
  const R = (yExt * yExt + d * d) / (2 * d);
  const acx = xMid - R;
  const L = leaves.length;
  const pts = leaves.map((lf, i) => {
    const t = L === 1 ? 0 : -1 + (2 * i) / (L - 1);
    const y = cy + t * yExt;
    const x = acx + Math.sqrt(Math.max(0, R * R - (y - cy) ** 2));
    return { id: lf.id, cat: lf.cat, x, y };
  });
  return { W, H, fit, orb, cards, pts, haloR: Math.min(260, colX - orb.x + 40, H * 0.42) };
}

export function curve(x1: number, y1: number, x2: number, y2: number, bend = 0.45) {
  const dx = (x2 - x1) * bend;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
