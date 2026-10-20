import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Maximize2, Minus, Plus, X } from "lucide-react";
import type { PageId } from "../App";
import type { AppState, TypedAction } from "../api";
import { BarRow, LineChart, seededTrend } from "./charts";
import { StatusPill } from "./ui";
import { hf, pct, usd, usdCompact } from "../format";
import { CAT_META, liquidityLabel, shocked, type CatId, type Category, type Leaf, type SimValues, buildGraph } from "../lib/graph";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export type Target = { kind: "orb" } | { kind: "cat"; id: CatId } | { kind: "leaf"; id: string };
type Graph = ReturnType<typeof buildGraph>;

export const CAT_FINDINGS: Record<CatId, string[]> = {
  cash: ["dgs-", "idle-cash", "fx"],
  equities: ["risk-on", "capital-at-risk"],
  bonds: [],
  private: ["risk-on", "capital-at-risk"],
  crypto: ["cover-claim", "loan-health", "loan-cover", "proof", "proof-expiring"],
  real: ["capital-at-risk"],
  debts: ["debt-", "drains", "proof", "loan-health"],
  insurance: ["life-gap", "loan-cover", "cover-claim"],
};
const LEAF_FINDINGS: Record<string, string[]> = { "nw-card": ["debt-nw-card"], "md-term": ["dgs-Meridian"], "nw-car": ["drains"], "oc-loan": ["loan-health", "proof", "drains"] };

export const EXPLORE: Record<CatId, { page: PageId; label: string }> = {
  cash: { page: "accounts", label: "Open accounts" },
  equities: { page: "risk", label: "Open risk radar" },
  bonds: { page: "protect", label: "Open earn & protect" },
  private: { page: "risk", label: "Open risk radar" },
  crypto: { page: "credit", label: "Open credit" },
  real: { page: "cashflow", label: "Manage assets" },
  debts: { page: "cashflow", label: "Debts & payoff plan" },
  insurance: { page: "protect", label: "Open earn & protect" },
};

export function relatedFindings(s: AppState, t: Target, leaf?: Leaf) {
  const all = s.risk.findings;
  const by = (prefixes: string[]) => all.filter((f) => prefixes.some((p) => f.id.startsWith(p)));
  if (t.kind === "orb") return [...all.filter((f) => f.action).slice(0, 2), ...all.filter((f) => !f.action)].slice(0, 4);
  if (t.kind === "cat") return by(CAT_FINDINGS[t.id]);
  return leaf ? by(LEAF_FINDINGS[leaf.id] ?? CAT_FINDINGS[leaf.cat]).slice(0, 3) : [];
}

/** On-chain one-click actions available for a position (off-chain positions are advice-only). */
export function quickActionsFor(l: Leaf, s: AppState): Array<{ label: string; action: TypedAction; reason: string }> {
  const out: Array<{ label: string; action: TypedAction; reason: string }> = [];
  const w = s.chain.wallet;
  const idle = Math.floor(w.usdc - s.mandate.minWalletReserveUsd);
  const reason = "From the wealth map";
  if (l.id === "oc-usdc" && idle > 10) {
    out.push({ label: `Park ${usdCompact(idle)} in the vault`, action: { kind: "vault_deposit", amountUsd: idle }, reason });
    if (s.chain.loan.debt > 1) out.push({ label: `Repay ${usdCompact(Math.min(idle, s.chain.loan.debt))}`, action: { kind: "repay", amountUsd: Math.min(idle, s.chain.loan.debt) }, reason });
  }
  if (l.id === "oc-weth" && w.weth > 0.001) out.push({ label: `Add ${w.weth.toFixed(2)} ETH as collateral`, action: { kind: "deposit_collateral", amountEth: Math.floor(w.weth * 1e4) / 1e4 }, reason });
  if (l.id === "oc-collateral" && !s.chain.cover.some((x) => x.active)) {
    out.push({ label: "Buy liquidation cover", action: { kind: "buy_cover", coverUsd: Math.max(500, Math.ceil((s.chain.loan.debt * 0.1) / 100) * 100), days: 90 }, reason });
  }
  if (l.id === "oc-vault" && w.vault > 1) out.push({ label: "Withdraw all to wallet", action: { kind: "vault_withdraw", amountUsd: w.vault + 1 }, reason });
  if (l.id === "oc-loan") {
    if (!s.chain.attestation.active && s.credit.eligible) out.push({ label: "Publish proof (cheaper rate)", action: { kind: "refresh_attestation" }, reason });
    if (w.usdc > 100) out.push({ label: `Repay ${usdCompact(Math.min(1000, w.usdc - 1))}`, action: { kind: "repay", amountUsd: Math.min(1000, Math.floor(w.usdc - 1)) }, reason });
  }
  const cover = s.chain.cover.find((x) => `cover-${x.id}` === l.id && x.claimable > 0);
  if (cover) out.push({ label: `Claim ${usd(cover.claimable)}`, action: { kind: "claim_cover", policyId: cover.id }, reason });
  return out;
}

const riskMix = (leaves: Leaf[]) => {
  const total = leaves.reduce((a, l) => a + Math.abs(l.value), 0) || 1;
  return (["low", "medium", "high"] as const).map((k) => ({ k, pct: (leaves.filter((l) => l.riskLevel === k).reduce((a, l) => a + Math.abs(l.value), 0) / total) * 100 }));
};
const RISK_COLOR = { low: "#4cc38a", medium: "#f5c451", high: "#ff6b6b" } as const;

function MixBar({ leaves }: { leaves: Leaf[] }) {
  const mix = riskMix(leaves);
  return (
    <div className="mixbar" title={mix.map((m) => `${m.k} ${m.pct.toFixed(0)}%`).join(" · ")}>
      {mix.filter((m) => m.pct > 0).map((m) => <i key={m.k} style={{ width: `${m.pct}%`, background: RISK_COLOR[m.k] }} />)}
    </div>
  );
}

// =================================================================== brief (on-map popover)

export function BriefCard({
  t,
  g,
  s,
  sim,
  netWorth,
  collapsed,
  onToggleCollapse,
  onDive,
  onClose,
}: {
  t: Target;
  g: Graph;
  s: AppState;
  sim: SimValues;
  netWorth: number;
  collapsed: CatId[];
  onToggleCollapse: (id: CatId) => void;
  onDive: () => void;
  onClose: () => void;
}) {
  let body: React.ReactNode = null;
  let title = "";
  if (t.kind === "orb") {
    title = "Whole portfolio";
    const assets = g.leaves.filter((l) => l.kind === "asset").reduce((a, l) => a + shocked(l, sim), 0);
    const debts = g.leaves.filter((l) => l.kind === "debt").reduce((a, l) => a + shocked(l, sim), 0);
    body = (
      <>
        <div className="brief-value num">{usd(netWorth)}</div>
        <div className="brief-rows">
          <span>Assets</span><b className="num">{usdCompact(assets)}</b>
          <span>Debts</span><b className="num neg-text">{usdCompact(debts)}</b>
          <span>True balance</span><b className="num">{usdCompact(s.risk.totals.trueBalance)}</b>
          <span>Risk score</span><b className="num">{s.risk.riskScore}/100</b>
        </div>
      </>
    );
  } else if (t.kind === "cat") {
    const c = g.categories.find((x) => x.id === t.id);
    if (!c) return null;
    title = c.label;
    const value = c.leaves.reduce((a, l) => a + shocked(l, sim), 0);
    body = (
      <>
        <div className="brief-value num">{c.kind === "policy" ? `${c.leaves.filter((l) => !l.missing).length} policies` : usd(value)}</div>
        {c.kind === "asset" && <div className="muted" style={{ fontSize: 12 }}>{pct(c.sharePct, 1)} of assets · {plural(c.leaves.length, "position")} · {plural(c.institutions.length, "source")}</div>}
        {c.kind !== "policy" && <MixBar leaves={c.leaves} />}
        <div className="brief-list">
          {[...c.leaves].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 4).map((l) => (
            <div key={l.id} className="between"><span className="ellip">{l.name}</span><span className="num muted">{l.kind === "policy" ? (l.missing ? "gap" : usdCompact(l.value)) : usdCompact(shocked(l, sim))}</span></div>
          ))}
        </div>
        <button className="btn sm ghost" onPointerDown={(e) => e.stopPropagation()} onClick={() => onToggleCollapse(c.id)}>
          {collapsed.includes(c.id) ? <><Plus size={13} /> Show positions</> : <><Minus size={13} /> Hide positions</>}
        </button>
      </>
    );
  } else {
    const l = g.all.find((x) => x.id === t.id);
    if (!l) return null;
    title = l.name;
    const v = shocked(l, sim);
    body = (
      <>
        <div className="muted" style={{ fontSize: 12 }}>{l.institution} · {CAT_META[l.cat].label}</div>
        <div className="brief-value num">{l.kind === "policy" ? (l.missing ? "Not covered" : `${usd(l.value)} cover`) : usd(v)}</div>
        {sim && l.kind !== "policy" && v !== l.value && <div className="num neg-text" style={{ fontSize: 12 }}>{usdCompact(v - l.value)} in simulation</div>}
        <div className="brief-rows">
          {l.kind === "asset" && (
            <>
              <span>Of net worth</span><b className="num">{pct((l.value / Math.max(1, s.risk.totals.netWorth)) * 100, 1)}</b>
              <span>Time to cash</span><b>{l.encumbered ? "Locked" : liquidityLabel(l.liquidityDays)}</b>
              <span>Yield</span><b className="num">{l.apyPct ? `${l.apyPct}%` : "none"}</b>
              <span>Collateral value</span><b className="num">{l.haircutPct === undefined ? "n/a" : `${l.haircutPct}%`}</b>
            </>
          )}
          {l.kind === "debt" && (
            <>
              <span>APR</span><b className="num">{l.aprPct}%</b>
              <span>Monthly</span><b className="num">{usd(l.monthly ?? 0)}</b>
            </>
          )}
          <span>Risk</span><b style={{ color: RISK_COLOR[l.riskLevel], textTransform: "capitalize" }}>{l.riskLevel}</b>
        </div>
      </>
    );
  }
  return (
    <div className="brief" onPointerDown={(e) => e.stopPropagation()}>
      <div className="between">
        <b className="brief-title">{title}</b>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>
      {body}
      <button className="btn lime sm" style={{ marginTop: 8, width: "100%" }} onClick={onDive}>
        <Maximize2 size={13} /> Dive deeper
      </button>
    </div>
  );
}

// =================================================================== deep dive (full view)

export function DeepDive({
  t,
  g,
  s,
  sim,
  onClose,
  onSelect,
  go,
  run,
}: {
  t: Target;
  g: Graph;
  s: AppState;
  sim: SimValues;
  onClose: () => void;
  onSelect: (t: Target) => void;
  go: (p: PageId) => void;
  run: (a: TypedAction, reason?: string) => Promise<unknown>;
}) {
  const [whatIf, setWhatIf] = useState(0);
  useEffect(() => setWhatIf(0), [t]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const nw = s.risk.totals.netWorth;
  const leaf = t.kind === "leaf" ? g.all.find((x) => x.id === t.id) : undefined;
  const cat: Category | undefined = t.kind === "cat" ? g.categories.find((c) => c.id === t.id) : leaf ? g.categories.find((c) => c.id === leaf.cat) : undefined;
  const findings = relatedFindings(s, t, leaf);
  const labels = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => new Date(now.getFullYear(), now.getMonth() - 11 + i, 1).toLocaleString("en-US", { month: "short" }));
  }, []);

  let header: React.ReactNode;
  let content: React.ReactNode;

  if (t.kind === "orb") {
    header = (
      <>
        <div className="eyebrow">Whole portfolio</div>
        <h2 className="panel-title" style={{ marginTop: 4 }}>Balance sheet</h2>
      </>
    );
    content = (
      <div className="grid g-2" style={{ gap: 18 }}>
        <div>
          <table className="t">
            <thead><tr><th>Category</th><th className="r">Value</th><th className="r">Share</th><th /></tr></thead>
            <tbody>
              {g.categories.filter((c) => c.kind !== "policy").map((c) => (
                <tr key={c.id} className="clickable-row" onClick={() => onSelect({ kind: "cat", id: c.id })}>
                  <td><span className="swatch" style={{ background: c.color, marginRight: 8 }} />{c.label}</td>
                  <td className={`r ${c.kind === "debt" ? "neg-text" : ""}`}>{usd(c.leaves.reduce((a, l) => a + shocked(l, sim), 0))}</td>
                  <td className="r muted">{c.kind === "asset" ? pct(c.sharePct, 1) : ""}</td>
                  <td className="r"><ChevronRight size={14} /></td>
                </tr>
              ))}
              <tr><td><b>Net worth</b></td><td className="r"><b>{usd(nw)}</b></td><td /><td /></tr>
              <tr><td>True balance (reachable in a week − all debts)</td><td className={`r ${s.risk.totals.trueBalance < 0 ? "neg-text" : ""}`}>{usd(s.risk.totals.trueBalance)}</td><td /><td /></tr>
            </tbody>
          </table>
        </div>
        <div className="stack-sm">
          <div className="muted" style={{ fontSize: 12 }}>Net worth, 12 months (modelled from statements; last point live)</div>
          <LineChart labels={s.history.labels} series={[{ name: "Net worth", values: s.history.netWorth, color: "#e3f56b" }]} height={180} format={(v) => usdCompact(v)} />
          <div className="muted" style={{ fontSize: 12 }}>Liquidity ladder</div>
          {s.risk.liquidityLadder.map((b) => (
            <BarRow key={b.bucket} label={<span className="ink2">{b.bucket}</span>} value={b.value} max={Math.max(...s.risk.liquidityLadder.map((x) => x.value))} color="#e3f56b" display={usdCompact(b.value)} />
          ))}
        </div>
      </div>
    );
  } else if (t.kind === "cat" && cat) {
    const Icon = cat.icon;
    const total = cat.leaves.reduce((a, l) => a + Math.abs(l.value), 0) || 1;
    header = (
      <>
        <div className="eyebrow" style={{ display: "flex", gap: 8, alignItems: "center" }}><Icon size={15} color={cat.color} /> Category</div>
        <h2 className="panel-title" style={{ marginTop: 4 }}>{cat.label}</h2>
        <div className="panel-sub">{cat.leaves.length} positions at {cat.institutions.join(", ")}</div>
      </>
    );
    content = (
      <div className="stack">
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))" }}>
          <div className="kpi-tile"><div className="kt-top"><span className="num">{cat.kind === "policy" ? cat.leaves.filter((l) => !l.missing).length : usdCompact(cat.leaves.reduce((a, l) => a + shocked(l, sim), 0))}</span></div><div className="kt-label">{cat.kind === "policy" ? "Active policies" : "Value"}</div></div>
          <div className="kpi-tile"><div className="kt-top"><span className="num">{cat.kind === "asset" ? pct(cat.sharePct, 1) : cat.leaves.length}</span></div><div className="kt-label">{cat.kind === "asset" ? "Of assets" : "Items"}</div></div>
          <div className="kpi-tile"><div className="kt-top"><span className="num">{usdCompact(cat.leaves.filter((l) => (l.liquidityDays ?? 999) <= 7 && !l.encumbered && l.kind === "asset").reduce((a, l) => a + l.value, 0))}</span></div><div className="kt-label">Cash within a week</div></div>
          <div className="kpi-tile"><div className="kt-top"><span className="num">{usdCompact(cat.leaves.reduce((a, l) => a + (l.pledgeableUsd ?? 0), 0))}</span></div><div className="kt-label">Counts as collateral</div></div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="t">
            <thead>
              <tr><th>Position</th><th>Where</th><th className="r">Value</th><th className="r">Of category</th><th>Risk</th><th>Access</th><th className="r">{cat.kind === "debt" ? "APR" : "Yield"}</th><th className="r">Collateral</th><th /></tr>
            </thead>
            <tbody>
              {[...cat.leaves].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).map((l) => (
                <tr key={l.id} className="clickable-row" onClick={() => onSelect({ kind: "leaf", id: l.id })}>
                  <td>{l.name}{l.onchain && <span className="chip onchain" style={{ marginLeft: 6 }}>on-chain</span>}</td>
                  <td className="muted">{l.institution}</td>
                  <td className={`r ${l.kind === "debt" ? "neg-text" : ""}`}>{l.kind === "policy" ? (l.missing ? "gap" : usd(l.value)) : usd(shocked(l, sim))}</td>
                  <td className="r muted">{pct((Math.abs(l.value) / total) * 100, 1)}</td>
                  <td style={{ color: RISK_COLOR[l.riskLevel], textTransform: "capitalize" }}>{l.riskLevel}</td>
                  <td className="muted">{l.kind === "asset" ? (l.encumbered ? "Locked" : liquidityLabel(l.liquidityDays)) : "–"}</td>
                  <td className="r">{l.kind === "debt" ? `${l.aprPct}%` : l.apyPct ? `${l.apyPct}%` : "–"}</td>
                  <td className="r muted">{l.haircutPct === undefined ? "–" : `${l.haircutPct}%`}</td>
                  <td className="r"><ChevronRight size={14} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {cat.kind === "asset" && (
          <div className="grid g-2" style={{ gap: 18 }}>
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Risk mix (by value)</div>
              <MixBar leaves={cat.leaves} />
              <div className="row-flex" style={{ marginTop: 8, gap: 12, fontSize: 12 }}>
                {riskMix(cat.leaves).map((m) => <span key={m.k}><span className="swatch" style={{ background: RISK_COLOR[m.k] }} /> {m.k} {m.pct.toFixed(0)}%</span>)}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Sensitivity: if this category moves…</div>
              {[-10, -20, -30].map((p) => {
                const d = (cat.leaves.reduce((a, l) => a + l.value, 0) * p) / 100;
                return (
                  <div key={p} className="between" style={{ fontSize: 13 }}>
                    <span>{p}%</span>
                    <span className="num neg-text">{usdCompact(d)} · net worth {pct((d / nw) * 100, 1)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  } else if (leaf) {
    const meta = CAT_META[leaf.cat];
    const series = seededTrend(leaf.id, Math.max(1, Math.abs(leaf.value) || 1), 12, leaf.riskLevel === "high" ? 0.06 : 0.015);
    const quick = quickActionsFor(leaf, s);
    const d = (leaf.value * whatIf) / 100;
    header = (
      <>
        <div className="eyebrow" style={{ display: "flex", gap: 8, alignItems: "center" }}><meta.icon size={15} color={meta.color} /> {leaf.institution} · {meta.label}</div>
        <h2 className="panel-title" style={{ marginTop: 4 }}>{leaf.name}</h2>
        <div className="panel-sub">{leaf.onchain ? "On-chain: the agent can act on it within your mandate" : "Off-chain and read-only: Abanq advises, you act"}</div>
      </>
    );
    content = (
      <div className="grid g-2" style={{ gap: 18 }}>
        <div className="stack-sm">
          <div className="brief-rows big">
            <span>Value</span><b className="num">{leaf.kind === "policy" ? (leaf.missing ? "Not covered" : `${usd(leaf.value)} cover`) : usd(shocked(leaf, sim))}</b>
            {leaf.kind === "asset" && (
              <>
                <span>Of net worth</span><b className="num">{pct((leaf.value / Math.max(1, nw)) * 100, 1)}</b>
                <span>Time to cash</span><b>{leaf.encumbered ? "Locked as loan collateral" : liquidityLabel(leaf.liquidityDays)}</b>
                <span>Yield</span><b className="num">{leaf.apyPct ? `${leaf.apyPct}% (${usd((leaf.value * leaf.apyPct) / 100)}/yr)` : "none"}</b>
                <span>Collateral value</span><b className="num">{leaf.haircutPct === undefined ? "Not counted" : `${leaf.haircutPct}% → ${usd(leaf.pledgeableUsd ?? 0)}`}</b>
                <span>Currency</span><b>{leaf.currency}</b>
              </>
            )}
            {leaf.kind === "debt" && (
              <>
                <span>APR</span><b className="num">{leaf.aprPct}%</b>
                <span>Interest per year</span><b className="num">{usd((Math.abs(leaf.value) * (leaf.aprPct ?? 0)) / 100)}</b>
                <span>Monthly payment</span><b className="num">{usd(leaf.monthly ?? 0)}</b>
              </>
            )}
            <span>Risk level</span><b style={{ color: RISK_COLOR[leaf.riskLevel], textTransform: "capitalize" }}>{leaf.riskLevel}</b>
            <span>Behaviour</span><b style={{ textTransform: "capitalize" }}>{leaf.behavior === "income" ? "Pays you" : leaf.behavior === "drain" ? "Costs you" : "Neutral"}</b>
          </div>
          {leaf.kind === "asset" && (
            <label className="field" style={{ marginTop: 8 }}>
              <span className="between"><span>What if it moves</span><b className="num">{whatIf > 0 ? "+" : ""}{whatIf}%</b></span>
              <input type="range" min={-80} max={80} value={whatIf} onChange={(e) => setWhatIf(Number(e.target.value))} />
              <span className="muted">Net worth {d >= 0 ? "+" : "−"}{usd(Math.abs(d))} ({pct((d / Math.max(1, nw)) * 100, 2)}){leaf.encumbered ? `, loan health would follow ETH (now ${hf(s.chain.loan.healthFactor)})` : ""}</span>
            </label>
          )}
          {quick.length > 0 && (
            <div className="row-flex">
              {quick.map((q) => <button key={q.label} className="btn lime sm" onClick={() => run(q.action, q.reason)}>{q.label}</button>)}
            </div>
          )}
        </div>
        <div>
          {leaf.kind === "asset" && (
            <>
              <div className="muted" style={{ fontSize: 12 }}>12-month trend (modelled; last point live)</div>
              <LineChart labels={labels} series={[{ name: leaf.name, values: series, color: "#e3f56b" }]} height={190} format={(v) => usdCompact(v)} />
            </>
          )}
          {cat && (
            <button className="btn sm ghost" onClick={() => onSelect({ kind: "cat", id: cat.id })} style={{ marginTop: 8 }}>
              ← All of {cat.label}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="Details">
        <div className="between" style={{ alignItems: "flex-start" }}>
          <div>{header}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div style={{ marginTop: 16 }}>{content}</div>
        {findings.length > 0 && (
          <>
            <div className="divider" />
            <div className="analysis-head">AI analysis</div>
            <div className="grid g-2" style={{ gap: 10 }}>
              {findings.map((f) => (
                <div key={f.id} className="analysis-item" style={{ marginBottom: 0 }}>
                  <div className="between"><b>{f.title}</b><StatusPill tone={f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "neutral"}>{f.severity}</StatusPill></div>
                  <p>{f.detail}</p>
                  {f.action ? <button className="btn lime sm" onClick={() => run(f.action!, f.detail)}>{f.actionLabel}</button> : <span className="step-note">{f.owner === "agent" ? "Agent watches this" : `Your step${f.actionLabel ? `: ${f.actionLabel.toLowerCase()}` : ""}`}</span>}
                </div>
              ))}
            </div>
          </>
        )}
        {cat && t.kind !== "orb" && (
          <div className="row-flex" style={{ marginTop: 16, justifyContent: "flex-end" }}>
            <button className="btn sm" onClick={() => { go(EXPLORE[cat.id].page); onClose(); }}>{EXPLORE[cat.id].label} <ChevronRight size={14} /></button>
          </div>
        )}
      </div>
    </div>
  );
}
