import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpDown,
  Bot,
  ChevronRight,
  CircleCheck,
  Clock,
  Download,
  FileDown,
  FileSpreadsheet,
  Funnel,
  Layers,
  ListTree,
  LocateFixed,
  Minus,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Waypoints,
  X,
  Zap,
} from "lucide-react";
import { useApp, type MapUi } from "../App";
import { api, type StressInput, type TypedAction } from "../api";
import { seededTrend } from "../components/charts";
import { Markdown, StatusPill } from "../components/ui";
import { hf, short, signedPct, timeAgo, usd, usdCompact } from "../format";
import { CAT_META, CAT_ORDER, buildGraph, curve, layout, liquidityLabel, shocked, type CatId, type Category, type Leaf } from "../lib/graph";

type Sel = { type: "root" } | { type: "cat"; id: CatId } | { type: "leaf"; id: string };

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

// ======================================================================= toolbar

export function MapToolbar() {
  const { map, setMap, s } = useApp();
  const [open, setOpen] = useState<null | "filter" | "sort" | "export">(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);

  const exportCsv = () => {
    const g = buildGraph(s, { sort: "value", hidden: [], source: "all" });
    const rows = [["category", "position", "institution", "value_usd", "on_chain", "risk", "behaviour", "liquidity_days", "collateral_pct"]];
    for (const l of g.all) rows.push([CAT_META[l.cat].label, l.name, l.institution, l.value.toFixed(2), String(l.onchain), l.riskLevel, l.behavior, String(l.liquidityDays ?? ""), String(l.haircutPct ?? "")]);
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `prism-positions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setOpen(null);
  };

  return (
    <div className="toolbar" ref={box}>
      <div className="tool-group">
        <button className={`tool ${map.view === "graph" ? "on" : ""}`} onClick={() => setMap({ view: "graph" })} aria-label="Graph view" title="Graph view">
          <Waypoints size={18} />
        </button>
        <button className={`tool ${map.view === "tree" ? "on" : ""}`} onClick={() => setMap({ view: "tree" })} aria-label="Tree view" title="Tree view">
          <ListTree size={18} />
        </button>
      </div>
      <div className="tool-group">
        <button className="tool" onClick={() => setMap({ zoom: Math.min(1.8, +(map.zoom + 0.1).toFixed(2)) })} aria-label="Zoom in" title="Zoom in">
          <Plus size={18} />
        </button>
        <button className="tool" onClick={() => setMap({ zoom: Math.max(0.6, +(map.zoom - 0.1).toFixed(2)) })} aria-label="Zoom out" title="Zoom out">
          <Minus size={18} />
        </button>
        <button className="tool" onClick={() => setMap({ zoom: 1, recenter: map.recenter + 1 })} aria-label="Reset view" title="Reset view">
          <LocateFixed size={17} />
        </button>
      </div>
      <div className="tool-group pop-anchor">
        <button className={`tool ${map.hidden.length || map.source !== "all" ? "dot" : ""}`} onClick={() => setOpen(open === "filter" ? null : "filter")} aria-label="Filter" title="Filter">
          <Funnel size={17} />
        </button>
        {open === "filter" && (
          <div className="popover">
            <div className="pop-title">Show</div>
            <div className="seg" style={{ marginBottom: 10 }}>
              {(["all", "offchain", "onchain"] as const).map((v) => (
                <button key={v} className={map.source === v ? "on" : ""} onClick={() => setMap({ source: v })}>
                  {v === "all" ? "All" : v === "offchain" ? "Off-chain" : "On-chain"}
                </button>
              ))}
            </div>
            {CAT_ORDER.map((id) => (
              <label key={id} className="pop-row">
                <input type="checkbox" checked={!map.hidden.includes(id)} onChange={(e) => setMap({ hidden: e.target.checked ? map.hidden.filter((x) => x !== id) : [...map.hidden, id] })} />
                <span className="swatch" style={{ background: CAT_META[id].color }} />
                {CAT_META[id].label}
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="tool-group pop-anchor">
        <button className="tool" onClick={() => setOpen(open === "sort" ? null : "sort")} aria-label="Sort positions" title="Sort positions">
          <ArrowUpDown size={17} />
        </button>
        {open === "sort" && (
          <div className="popover">
            <div className="pop-title">Sort positions by</div>
            {(["value", "liquidity", "name"] as const).map((k) => (
              <button key={k} className={`pop-item ${map.sort === k ? "on" : ""}`} onClick={() => (setMap({ sort: k }), setOpen(null))}>
                {k === "value" ? "Value" : k === "liquidity" ? "Fastest access first" : "Name"}
                {map.sort === k && <CircleCheck size={14} />}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tool-group pop-anchor">
        <button className="tool" onClick={() => setOpen(open === "export" ? null : "export")} aria-label="Export" title="Export">
          <Download size={17} />
        </button>
        {open === "export" && (
          <div className="popover" style={{ right: 0, left: "auto" }}>
            <div className="pop-title">Export</div>
            <button className="pop-item" onClick={exportCsv}>
              <FileSpreadsheet size={15} /> Positions (CSV)
            </button>
            <a className="pop-item" href="/api/export" download onClick={() => setOpen(null)}>
              <FileDown size={15} /> Full backup + audit trail (JSON)
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ======================================================================= graph

function RiskBars({ level, tone }: { level: Leaf["riskLevel"]; tone?: "policy" | "missing" }) {
  const n = level === "low" ? 1 : level === "medium" ? 2 : 3;
  const color = tone === "missing" ? "#ff6b6b" : tone === "policy" ? "#4cc38a" : level === "low" ? "#4cc38a" : level === "medium" ? "#f5c451" : "#ff6b6b";
  const filled = tone === "policy" ? 3 : tone === "missing" ? 3 : n;
  return (
    <span className="rbars" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <i key={i} style={{ background: i < filled ? color : "rgba(255,255,255,.14)" }} />
      ))}
    </span>
  );
}

function BehaviourIcon({ b }: { b: Leaf["behavior"] }) {
  if (b === "income") return <TrendingUp size={11} color="#e3f56b" aria-label="Pays you" />;
  if (b === "drain") return <TrendingDown size={11} color="#ff9a9a" aria-label="Costs you" />;
  return <Minus size={11} color="#a9a2a7" aria-label="Neutral" />;
}

function leafValue(l: Leaf, sim: StressInput | null) {
  if (l.kind === "policy") return l.missing ? "gap" : `${usdCompact(l.value)} cover`;
  return usdCompact(shocked(l, sim));
}

function Graph({ g, sel, setSel }: { g: ReturnType<typeof buildGraph>; sel: Sel; setSel: (s: Sel) => void }) {
  const { s, map, sim, setMap } = useApp();
  const [ref, size] = useSize<HTMLDivElement>();
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => setPan({ x: 0, y: 0 }), [map.recenter]);

  const W = size.w;
  const H = size.h;
  const L = useMemo(() => layout(W, H, g.categories), [W, H, g.categories]);
  const cardById = new Map(L.cards.map((c) => [c.id, c]));
  const ptById = new Map(L.pts.map((p) => [p.id, p]));
  const q = map.query.trim().toLowerCase();
  const matches = (l: Leaf) => q.length > 0 && `${l.name} ${l.institution}`.toLowerCase().includes(q);
  const anyMatch = q.length > 0 && g.leaves.some(matches);
  const selLeaf = sel.type === "leaf" ? g.leaves.find((l) => l.id === sel.id) : undefined;
  const focusCat: CatId | null = sel.type === "cat" ? sel.id : selLeaf ? selLeaf.cat : null;

  const leafEm = (l: Leaf): 0 | 1 | 2 | 3 => {
    if (hover === l.id) return 3;
    if (anyMatch) return matches(l) ? 2 : 0;
    if (sel.type === "leaf") return l.id === sel.id ? 3 : l.cat === focusCat ? 1 : 0;
    if (sel.type === "cat") return l.cat === sel.id ? 2 : 0;
    return 1;
  };
  const catEm = (c: Category): 0 | 1 | 2 => {
    if (anyMatch) return c.leaves.some(matches) ? 2 : 0;
    if (focusCat) return c.id === focusCat ? 2 : 0;
    return 1;
  };
  const lineOpacity = [0.1, 0.38, 0.85, 1];
  const showChips = L.spacing >= 29;
  const netWorth = sim ? g.leaves.filter((l) => l.kind !== "policy").reduce((a, l) => a + shocked(l, sim), 0) : s.risk.totals.netWorth;
  const nwDelta = sim ? ((netWorth - s.risk.totals.netWorth) / s.risk.totals.netWorth) * 100 : null;
  const haloR = Math.min(H * 0.42, 260);
  const selCard = focusCat ? cardById.get(focusCat) : undefined;

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPan({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y });
  };
  const onUp = () => (drag.current = null);

  return (
    <div className="map-canvas" ref={ref} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {W > 0 && (
        <div className="map-inner" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${map.zoom})`, transformOrigin: `${L.orb.x}px 50%` }}>
          <svg width={W} height={H} className="map-svg" aria-hidden="true">
            <defs>
              <radialGradient id="halo" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.05" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0.01" />
              </radialGradient>
              <radialGradient id="orbGrad" cx="36%" cy="30%" r="70%">
                <stop offset="0%" stopColor="#fffbe8" />
                <stop offset="34%" stopColor="#e3f56b" />
                <stop offset="72%" stopColor="#c98a3a" />
                <stop offset="100%" stopColor="#4a2414" />
              </radialGradient>
              <radialGradient id="orbGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#ff9a52" stopOpacity="0.55" />
                <stop offset="100%" stopColor="#ff7a2f" stopOpacity="0" />
              </radialGradient>
              <radialGradient id="flare" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#fff6dc" stopOpacity="0.95" />
                <stop offset="40%" stopColor="#efe6d2" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#efe6d2" stopOpacity="0" />
              </radialGradient>
            </defs>

            <circle cx={L.orb.x} cy={L.orb.y} r={haloR} fill="url(#halo)" stroke="rgba(255,255,255,0.05)" />
            <circle cx={L.orb.x} cy={L.orb.y} r={haloR * 0.6} fill="rgba(8,7,9,0.55)" stroke="rgba(255,255,255,0.06)" />

            {/* orb → categories */}
            {L.cards.map((card) => {
              const c = g.categories.find((x) => x.id === card.id)!;
              const em = catEm(c);
              return (
                <path
                  key={`o-${card.id}`}
                  d={curve(L.orb.x + L.orb.r + 26, L.orb.y, card.x, card.y + card.h / 2, 0.5)}
                  fill="none"
                  stroke="#efe6d2"
                  strokeOpacity={em === 2 ? 0.9 : em === 1 ? 0.5 : 0.14}
                  strokeWidth={em === 2 ? 1.4 : 1}
                  strokeDasharray={c.kind === "debt" ? "4 4" : c.kind === "policy" ? "1 4" : undefined}
                />
              );
            })}

            {/* categories → positions */}
            {g.categories.flatMap((c) => {
              const card = cardById.get(c.id)!;
              return c.leaves.map((l) => {
                const p = ptById.get(l.id)!;
                const em = leafEm(l);
                return (
                  <path
                    key={`${l.id}-${focusCat ?? "all"}`}
                    className={em >= 2 && c.kind === "asset" ? "draw" : undefined}
                    pathLength={1}
                    d={curve(card.x + card.w, card.y + card.h / 2, p.x - 4, p.y, 0.42)}
                    fill="none"
                    stroke={em === 3 ? "#e3f56b" : "#efe6d2"}
                    strokeOpacity={lineOpacity[em]}
                    strokeWidth={em >= 2 ? 1.3 : 0.9}
                    strokeDasharray={c.kind === "debt" ? "0.012 0.01" : c.kind === "policy" ? "0.004 0.01" : undefined}
                  />
                );
              });
            })}

            {selCard && <ellipse cx={selCard.x + selCard.w} cy={selCard.y + selCard.h / 2} rx={34} ry={20} fill="url(#flare)" />}

            {g.leaves.map((l) => {
              const p = ptById.get(l.id)!;
              const em = leafEm(l);
              return (
                <g key={`d-${l.id}`}>
                  {em === 3 && <circle cx={p.x} cy={p.y} r={9} fill="#e3f56b" opacity={0.25} />}
                  <circle cx={p.x} cy={p.y} r={em === 3 ? 4.5 : 3.2} fill={em === 0 ? "#6e676c" : "#efe6d2"} stroke="#141215" strokeWidth={1.5} />
                </g>
              );
            })}

            {/* orb */}
            <circle cx={L.orb.x} cy={L.orb.y} r={L.orb.r * 2.6} fill="url(#orbGlow)" />
            <g className="orb-ring" style={{ transformOrigin: `${L.orb.x}px ${L.orb.y}px` }}>
              {Array.from({ length: 64 }).map((_, i) => {
                const a = (i / 64) * Math.PI * 2;
                const rr = L.orb.r + 14 + ((i * 37) % 7);
                return <circle key={i} cx={L.orb.x + rr * Math.cos(a)} cy={L.orb.y + rr * Math.sin(a)} r={i % 5 === 0 ? 1.4 : 0.8} fill={i % 3 === 0 ? "#e3f56b" : "#efe6d2"} opacity={0.35 + ((i * 13) % 10) / 20} />;
              })}
            </g>
            <circle cx={L.orb.x} cy={L.orb.y} r={L.orb.r} fill="url(#orbGrad)" />
            <circle cx={L.orb.x - L.orb.r * 0.32} cy={L.orb.y - L.orb.r * 0.38} r={L.orb.r * 0.22} fill="#ffffff" opacity={0.55} />
          </svg>

          {/* orb label + hit area */}
          <div className="orb-label" style={{ left: L.orb.x, top: L.orb.y - L.orb.r - 92 }}>
            <div className="orb-kicker">{map.balance === "true" ? "True balance" : "Net worth"}</div>
            {map.balance === "true" ? (
              <div className="orb-value num" style={{ color: s.risk.totals.trueBalance < 0 ? "#ff8a8a" : "#e3f56b" }}>{usd(s.risk.totals.trueBalance)}</div>
            ) : (
              <div className="orb-value num">{usd(netWorth)}</div>
            )}
            {map.balance === "true" && <div className="orb-delta" style={{ color: "#a9a2a7" }}>reachable in a week − all debts</div>}
            {map.balance !== "true" && nwDelta !== null && <div className="orb-delta num" style={{ color: nwDelta < 0 ? "#ffbcbc" : "#a6e8c6" }}>{signedPct(nwDelta)} in simulation</div>}
          </div>
          <button className={`orb-hit ${sel.type === "root" ? "on" : ""}`} style={{ left: L.orb.x - L.orb.r - 18, top: L.orb.y - L.orb.r - 18, width: (L.orb.r + 18) * 2, height: (L.orb.r + 18) * 2 }} onClick={() => setSel({ type: "root" })} aria-label="Whole portfolio" />
          <div className="orb-foot" style={{ left: L.orb.x, top: L.orb.y + L.orb.r + 30 }}>
            <span className="chip num">RISK {s.risk.riskScore}</span>
            <span className="chip num">HF {hf(s.chain.loan.healthFactor)}</span>
          </div>
          <button className="btn sm orb-toggle" style={{ left: L.orb.x, top: L.orb.y + L.orb.r + 56 }} onClick={() => setMap({ balance: map.balance === "true" ? "net" : "true" })}>
            {map.balance === "true" ? "Show net worth" : "See true balance"}
          </button>

          {/* categories */}
          {L.cards.map((card) => {
            const c = g.categories.find((x) => x.id === card.id)!;
            const em = catEm(c);
            const Icon = c.icon;
            const val = c.kind === "policy" ? `${c.leaves.filter((l) => !l.missing).length}` : usdCompact(c.leaves.reduce((a, l) => a + shocked(l, sim), 0));
            return (
              <button
                key={card.id}
                className={`map-card ${em === 2 ? "on" : ""} ${em === 0 ? "dim" : ""}`}
                style={{ left: card.x, top: card.y, width: card.w, height: card.h }}
                onClick={() => setSel(sel.type === "cat" && sel.id === c.id ? { type: "root" } : { type: "cat", id: c.id })}
              >
                <span className="mc-top">
                  <Icon size={14} color={c.color} />
                  <span className="mc-val num" style={c.kind === "debt" ? { color: "#ffbcbc" } : undefined}>{val}</span>
                </span>
                <span className="mc-label">
                  {c.kind === "policy" ? `${c.label} · ${c.leaves.some((l) => l.missing) ? "1 gap" : "covered"}` : c.label}
                </span>
                {card.h >= 62 && (
                  <span className="mc-sub">
                    {c.leaves.length} position{c.leaves.length === 1 ? "" : "s"} · {c.institutions.length} source{c.institutions.length === 1 ? "" : "s"}
                    {c.kind === "asset" && <b className="num">{Math.round(c.sharePct)}%</b>}
                  </span>
                )}
              </button>
            );
          })}

          {/* positions */}
          {g.leaves.map((l) => {
            const p = ptById.get(l.id)!;
            const em = leafEm(l);
            const sv = shocked(l, sim);
            const delta = sim && l.kind === "asset" ? sv - l.value : 0;
            return (
              <button
                key={l.id}
                className={`leaf ${em === 0 ? "dim" : ""} ${em === 3 ? "on" : ""} ${showChips ? "" : "compact"}`}
                style={{ left: p.x + 10, top: p.y - (showChips ? 15 : 9) }}
                onClick={() => setSel({ type: "leaf", id: l.id })}
                onMouseEnter={() => setHover(l.id)}
                onMouseLeave={() => setHover(null)}
                title={`${l.name} · ${l.institution}`}
              >
                <span className="leaf-name">
                  {l.name}
                  {!showChips && <span className="leaf-inline num"> · {leafValue(l, sim)}</span>}
                </span>
                {showChips && (
                  <span className="leaf-chips">
                    <span className={`chip num ${l.kind === "debt" ? "neg" : ""} ${l.missing ? "warn" : ""}`}>{leafValue(l, sim)}</span>
                    {delta !== 0 && <span className="chip num neg">{usdCompact(delta)}</span>}
                    <BehaviourIcon b={l.behavior} />
                    <RiskBars level={l.riskLevel} tone={l.kind === "policy" ? (l.missing ? "missing" : "policy") : undefined} />
                    {l.onchain && <span className="chip onchain">on-chain</span>}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ======================================================================= tree

function TreeView({ g, sel, setSel }: { g: ReturnType<typeof buildGraph>; sel: Sel; setSel: (s: Sel) => void }) {
  const { sim, map } = useApp();
  const [closed, setClosed] = useState<CatId[]>([]);
  const q = map.query.trim().toLowerCase();
  return (
    <div className="tree">
      {g.categories.map((c) => {
        const Icon = c.icon;
        const isClosed = closed.includes(c.id);
        return (
          <div key={c.id} className="tree-group">
            <button className={`tree-cat ${sel.type === "cat" && sel.id === c.id ? "on" : ""}`} onClick={() => setSel({ type: "cat", id: c.id })}>
              <ChevronRight
                size={16}
                style={{ transform: isClosed ? undefined : "rotate(90deg)", transition: "transform .15s" }}
                onClick={(e) => {
                  e.stopPropagation();
                  setClosed(isClosed ? closed.filter((x) => x !== c.id) : [...closed, c.id]);
                }}
              />
              <Icon size={16} color={c.color} />
              <span className="tc-label">{c.label}</span>
              <span className="muted">{c.leaves.length} positions · {c.institutions.join(", ")}</span>
              <span className="tc-val num">{c.kind === "policy" ? "" : usd(c.leaves.reduce((a, l) => a + shocked(l, sim), 0))}</span>
            </button>
            {!isClosed &&
              c.leaves
                .filter((l) => !q || `${l.name} ${l.institution}`.toLowerCase().includes(q))
                .map((l) => (
                  <button key={l.id} className={`tree-leaf ${sel.type === "leaf" && sel.id === l.id ? "on" : ""}`} onClick={() => setSel({ type: "leaf", id: l.id })}>
                    <span className="tl-name">{l.name}</span>
                    <span className="muted">{l.institution}</span>
                    <span className="muted">{l.kind === "asset" ? liquidityLabel(l.liquidityDays) : l.kind === "debt" ? `${l.aprPct}% APR` : l.missing ? "missing" : `$${l.monthly}/mo`}</span>
                    <span><RiskBars level={l.riskLevel} tone={l.kind === "policy" ? (l.missing ? "missing" : "policy") : undefined} /></span>
                    <span className={`num tc-val ${l.kind === "debt" ? "neg-text" : ""}`}>{leafValue(l, sim)}</span>
                  </button>
                ))}
          </div>
        );
      })}
    </div>
  );
}

// ======================================================================= panel

const CAT_FINDINGS: Record<CatId, string[]> = {
  cash: ["dgs-", "idle-cash", "fx"],
  equities: ["risk-on", "capital-at-risk"],
  bonds: [],
  private: ["risk-on", "capital-at-risk"],
  crypto: ["cover-claim", "loan-health", "loan-cover", "proof", "proof-expiring"],
  real: ["capital-at-risk"],
  debts: ["debt-", "drains", "proof", "loan-health"],
  insurance: ["life-gap", "loan-cover", "cover-claim"],
};

const EXPLORE: Record<CatId, { page: "accounts" | "risk" | "credit" | "protect" | "cashflow"; label: string }> = {
  cash: { page: "accounts", label: "Open accounts" },
  equities: { page: "risk", label: "Open risk radar" },
  bonds: { page: "protect", label: "Open earn & protect" },
  private: { page: "risk", label: "Open risk radar" },
  crypto: { page: "credit", label: "Open credit" },
  real: { page: "cashflow", label: "Manage assets" },
  debts: { page: "cashflow", label: "Debts & payoff plan" },
  insurance: { page: "protect", label: "Open earn & protect" },
};

function DotBars({ values }: { values: number[] }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const rows = 11;
  return (
    <svg width={values.length * 7} height={rows * 4.6 + 2} aria-hidden="true" className="dotbars">
      {values.map((v, i) => {
        const n = 2 + Math.round(((v - min) / (max - min || 1)) * (rows - 2));
        const last = i === values.length - 1;
        return Array.from({ length: n }).map((_, j) => (
          <circle key={`${i}-${j}`} cx={i * 7 + 3} cy={rows * 4.6 - j * 4.6} r={last ? 1.6 : 1.15} fill={last ? "#e3f56b" : i > values.length - 4 ? "#efe6d2" : "#a9a2a7"} opacity={last ? 1 : 0.45 + (j / n) * 0.5} />
        ));
      })}
    </svg>
  );
}

function densify(xs: number[], n = 28) {
  if (xs.length >= n) return xs.slice(-n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (xs.length - 1);
    const a = Math.floor(t);
    const b = Math.min(xs.length - 1, a + 1);
    out.push(xs[a] + (xs[b] - xs[a]) * (t - a));
  }
  return out;
}

function Tile({ icon, value, label }: { icon: ReactNode; value: ReactNode; label: string }) {
  return (
    <div className="kpi-tile">
      <div className="kt-top">
        {icon}
        <span className="num">{value}</span>
      </div>
      <div className="kt-label">{label}</div>
    </div>
  );
}

function Panel({ g, sel, setSel }: { g: ReturnType<typeof buildGraph>; sel: Sel; setSel: (s: Sel) => void }) {
  const { s, go, run } = useApp();
  const [q, setQ] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [reply, setReply] = useState<{ q: string; text: string } | null>(null);
  const analysisRef = useRef<HTMLDivElement>(null);
  const pending = s.proposals.filter((p) => p.status === "pending_approval").length;
  const lastSync = Math.max(...s.sources.filter((x) => x.connected).map((x) => x.lastSync));
  const findings = s.risk.findings;
  const byPrefix = (prefixes: string[]) => findings.filter((f) => prefixes.some((p) => f.id.startsWith(p)));

  const ask = async (text: string) => {
    const t = text.trim();
    if (!t || asking) return;
    setQ("");
    setAsking(t);
    try {
      const turn = await api.chat(t);
      setReply({ q: t, text: turn.text });
    } catch (e) {
      setReply({ q: t, text: `Error: ${e instanceof Error ? e.message : String(e)}` });
    }
    setAsking(null);
  };

  // --------------------------------------------------------------- content per selection
  let kicker: ReactNode;
  let title: ReactNode;
  let subtitle: ReactNode;
  let statusPill: ReactNode;
  let statusText: ReactNode;
  let explore: { label: string; onClick: () => void };
  let metric: { label: string; value: string; delta: number | null; badge: string; series: number[] };
  let tiles: ReactNode[];
  let items = findings.slice(0, 3);
  let quick: Array<{ label: string; action: TypedAction; reason: string }> = [];
  let note: string | null = null;

  if (sel.type === "root") {
    const t = s.risk.totals;
    const h = s.history.netWorth;
    kicker = <><Layers size={18} /> Whole portfolio</>;
    title = "Net worth";
    subtitle = `${usd(t.netWorth)} across ${s.sources.filter((x) => x.connected).length + 1} sources`;
    statusPill = <span className="pill good"><span className="live-dot" /> Live</span>;
    statusText = <>Accounts synced {timeAgo(lastSync)}. Chain time {new Date(s.chain.chainTime * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}.</>;
    explore = { label: "Risk radar", onClick: () => go("risk") };
    metric = { label: "Net worth trend", value: usdCompact(t.netWorth), delta: ((h[h.length - 1] - h[h.length - 2]) / h[h.length - 2]) * 100, badge: s.risk.riskLabel, series: densify(h) };
    tiles = [
      <Tile key="1" icon={<Layers size={20} />} value={g.all.filter((l) => l.kind === "asset").length} label="Positions" />,
      <Tile key="2" icon={<ShieldCheck size={20} />} value={s.sources.filter((x) => x.connected).length + 1} label="Sources connected" />,
      <Tile key="3" icon={<TrendingUp size={20} />} value={usdCompact(s.risk.cashflow.passiveIncomeUsd)} label="Passive income / yr" />,
      <Tile key="4" icon={<Zap size={20} />} value={`${Math.round(s.risk.capitalAtRiskPct)}%`} label="Capital at high risk" />,
    ];
    items = [...findings.filter((f) => f.action).slice(0, 2), ...findings.filter((f) => !f.action)].slice(0, 4);
  } else if (sel.type === "cat") {
    const c = g.categories.find((x) => x.id === sel.id)!;
    const Icon = c.icon;
    const highShare = c.leaves.filter((l) => l.riskLevel === "high").reduce((a, l) => a + Math.abs(l.value), 0) / Math.max(1, Math.abs(c.value));
    kicker = <><Icon size={18} color={c.color} /> Category</>;
    title = c.label;
    subtitle = `${c.leaves.length} positions at ${c.institutions.join(", ")}`;
    const tone = c.kind === "debt" ? "warn" : c.kind === "policy" ? (c.leaves.some((l) => l.missing) ? "warn" : "good") : highShare > 0.5 ? "bad" : highShare > 0.2 ? "warn" : "good";
    statusPill = <StatusPill tone={tone}>{c.kind === "debt" ? "Costs money" : c.kind === "policy" ? (tone === "good" ? "Covered" : "Gap found") : tone === "good" ? "Low risk" : tone === "warn" ? "Medium risk" : "High risk"}</StatusPill>;
    statusText = <>Merged from {c.institutions.length} source{c.institutions.length === 1 ? "" : "s"}, synced {timeAgo(lastSync)}.</>;
    explore = { label: EXPLORE[c.id].label, onClick: () => go(EXPLORE[c.id].page) };
    const series = seededTrend(c.id, Math.max(1, Math.abs(c.value)), 28, 0.03);
    metric = {
      label: c.kind === "asset" ? "Share of net worth" : c.kind === "debt" ? "Total owed" : "Total cover",
      value: c.kind === "asset" ? `${Math.round(c.sharePct)}%` : usdCompact(Math.abs(c.value)),
      delta: ((series[series.length - 1] - series[series.length - 3]) / series[series.length - 3]) * 100,
      badge: c.kind === "asset" ? (highShare > 0.5 ? "High" : highShare > 0.2 ? "Moderate" : "Low") : c.kind === "debt" ? "Drain" : tone === "good" ? "OK" : "Gap",
      series,
    };
    const liquidWeek = c.leaves.filter((l) => (l.liquidityDays ?? 999) <= 7 && !l.encumbered).reduce((a, l) => a + l.value, 0);
    const collateral = c.leaves.reduce((a, l) => a + (l.pledgeableUsd ?? 0), 0);
    tiles =
      c.kind === "debt"
        ? [
            <Tile key="1" icon={<Layers size={20} />} value={c.leaves.length} label="Debts" />,
            <Tile key="2" icon={<TrendingDown size={20} />} value={usdCompact(s.risk.cashflow.interestCostUsd)} label="Interest / yr" />,
            <Tile key="3" icon={<Zap size={20} />} value={`${Math.max(...c.leaves.map((l) => l.aprPct ?? 0))}%`} label="Most expensive APR" />,
            <Tile key="4" icon={<ShieldCheck size={20} />} value={hf(s.chain.loan.healthFactor)} label="On-chain loan health" />,
          ]
        : c.kind === "policy"
          ? [
              <Tile key="1" icon={<ShieldCheck size={20} />} value={c.leaves.filter((l) => !l.missing).length} label="Active policies" />,
              <Tile key="2" icon={<Zap size={20} />} value={c.leaves.filter((l) => l.missing).length} label="Gaps found" />,
              <Tile key="3" icon={<TrendingDown size={20} />} value={usdCompact(s.risk.cashflow.premiumsUsd)} label="Premiums / yr" />,
              <Tile key="4" icon={<Layers size={20} />} value={c.leaves.filter((l) => l.onchain).length} label="On-chain covers" />,
            ]
          : [
              <Tile key="1" icon={<Layers size={20} />} value={c.leaves.length} label="Positions" />,
              <Tile key="2" icon={<ShieldCheck size={20} />} value={c.institutions.length} label="Institutions" />,
              <Tile key="3" icon={<Clock size={20} />} value={usdCompact(liquidWeek)} label="Spendable within a week" />,
              <Tile key="4" icon={<CircleCheck size={20} />} value={usdCompact(collateral)} label="Counts as collateral" />,
            ];
    items = byPrefix(CAT_FINDINGS[c.id]);
    if (!items.length) note = `Nothing to fix here. ${c.kind === "asset" ? `${usdCompact(collateral)} of this category already counts toward your credit line.` : ""}`;
  } else {
    const l = g.all.find((x) => x.id === sel.id) ?? g.leaves[0];
    const meta = CAT_META[l.cat];
    const src = s.sources.find((x) => x.id === l.sourceId);
    kicker = <><meta.icon size={18} color={meta.color} /> {l.institution}</>;
    title = l.name;
    subtitle = `${meta.label}${l.onchain ? " · on-chain" : " · off-chain, read-only"}`;
    statusPill = l.missing ? <StatusPill tone="bad">Missing</StatusPill> : <StatusPill tone="good">{l.onchain ? "On-chain" : "Connected"}</StatusPill>;
    statusText = l.onchain ? <>Read live from the Prism wallet {short(s.chain.wallet.address)}.</> : src ? <>Synced {timeAgo(src.lastSync)} via {src.connectMethod.toLowerCase()}.</> : <>No policy on file.</>;
    explore = l.onchain ? { label: "Open credit", onClick: () => go("credit") } : { label: "Open accounts", onClick: () => go("accounts") };
    const series = seededTrend(l.id, Math.max(1, Math.abs(l.value) || 1), 28, l.riskLevel === "high" ? 0.06 : 0.015);
    metric = {
      label: l.kind === "debt" ? "Balance owed" : l.kind === "policy" ? "Coverage" : "Position value",
      value: l.missing ? "None" : usdCompact(Math.abs(l.value)),
      delta: l.missing ? null : ((series[series.length - 1] - series[series.length - 3]) / series[series.length - 3]) * 100,
      badge: l.riskLevel === "high" ? "High risk" : l.riskLevel === "medium" ? "Medium" : "Low risk",
      series,
    };
    tiles =
      l.kind === "asset"
        ? [
            <Tile key="1" icon={<Clock size={20} />} value={l.encumbered ? "Locked" : liquidityLabel(l.liquidityDays)} label="Time to cash" />,
            <Tile key="2" icon={<CircleCheck size={20} />} value={l.haircutPct === undefined ? "n/a" : `${l.haircutPct}%`} label="Counts as collateral" />,
            <Tile key="3" icon={<Layers size={20} />} value={`${((l.value / s.risk.totals.netWorth) * 100).toFixed(1)}%`} label="Of net worth" />,
            <Tile key="4" icon={l.behavior === "income" ? <TrendingUp size={20} /> : <Minus size={20} />} value={l.apyPct ? `${l.apyPct}%` : "0%"} label="Yield" />,
          ]
        : l.kind === "debt"
          ? [
              <Tile key="1" icon={<Zap size={20} />} value={`${l.aprPct}%`} label="APR" />,
              <Tile key="2" icon={<TrendingDown size={20} />} value={usdCompact((Math.abs(l.value) * (l.aprPct ?? 0)) / 100)} label="Interest / yr" />,
              <Tile key="3" icon={<Clock size={20} />} value={usd(l.monthly ?? 0)} label="Monthly payment" />,
              <Tile key="4" icon={<Layers size={20} />} value={l.onchain ? "Agent" : "You"} label="Who can act" />,
            ]
          : [
              <Tile key="1" icon={<ShieldCheck size={20} />} value={l.missing ? "None" : usdCompact(l.value)} label="Coverage" />,
              <Tile key="2" icon={<TrendingDown size={20} />} value={l.monthly ? usd(l.monthly) : "–"} label="Premium / mo" />,
              <Tile key="3" icon={<Layers size={20} />} value={l.onchain ? "Parametric" : "Classic"} label="Type" />,
              <Tile key="4" icon={<Zap size={20} />} value={l.onchain ? "Agent" : "You"} label="Who can act" />,
            ];
    const specific: Record<string, string[]> = { "nw-card": ["debt-nw-card"], "md-term": ["dgs-Meridian"], "nw-car": ["drains"], "oc-loan": ["loan-health", "proof", "drains"] };
    items = byPrefix(specific[l.id] ?? CAT_FINDINGS[l.cat]).slice(0, 3);
    const w = s.chain.wallet;
    const idle = Math.floor(w.usdc - s.mandate.minWalletReserveUsd);
    if (l.id === "oc-usdc" && idle > 10) {
      quick.push({ label: `Park ${usdCompact(idle)} in the vault`, action: { kind: "vault_deposit", amountUsd: idle }, reason: "From the wealth map" });
      if (s.chain.loan.debt > 1) quick.push({ label: `Repay ${usdCompact(Math.min(idle, s.chain.loan.debt))}`, action: { kind: "repay", amountUsd: Math.min(idle, s.chain.loan.debt) }, reason: "From the wealth map" });
    }
    if (l.id === "oc-weth" && w.weth > 0.001) quick.push({ label: `Add ${w.weth.toFixed(2)} ETH as collateral`, action: { kind: "deposit_collateral", amountEth: Math.floor(w.weth * 1e4) / 1e4 }, reason: "From the wealth map" });
    if (l.id === "oc-collateral" && !s.chain.cover.some((x) => x.active)) quick.push({ label: "Buy liquidation cover", action: { kind: "buy_cover", coverUsd: Math.max(500, Math.ceil((s.chain.loan.debt * 0.1) / 100) * 100), days: 90 }, reason: "From the wealth map" });
    if (l.id === "oc-vault" && w.vault > 1) quick.push({ label: "Withdraw all to wallet", action: { kind: "vault_withdraw", amountUsd: w.vault + 1 }, reason: "From the wealth map" });
    if (l.id === "oc-loan") {
      if (!s.chain.attestation.active && s.credit.eligible) quick.push({ label: "Publish proof (cheaper rate)", action: { kind: "refresh_attestation" }, reason: "From the wealth map" });
      if (w.usdc > 100) quick.push({ label: `Repay ${usdCompact(Math.min(1000, w.usdc - 1))}`, action: { kind: "repay", amountUsd: Math.min(1000, Math.floor(w.usdc - 1)) }, reason: "From the wealth map" });
    }
    const cover = s.chain.cover.find((x) => `cover-${x.id}` === l.id && x.claimable > 0);
    if (cover) quick.push({ label: `Claim ${usd(cover.claimable)}`, action: { kind: "claim_cover", policyId: cover.id }, reason: "From the wealth map" });
    if (!l.onchain) note = "Off-chain and read-only: Prism analyses this position and suggests steps, and you carry them out.";
  }

  return (
    <aside className="panel">
      <div className="panel-scroll">
        <div className="panel-kicker">{kicker}</div>
        <h2 className="panel-title">{title}</h2>
        <div className="panel-sub">{subtitle}</div>

        <div className="status-box">
          <div>
            {statusPill}
            <p>{statusText}</p>
          </div>
          <button className="btn sm" onClick={explore.onClick}>
            {explore.label} <ChevronRight size={14} />
          </button>
        </div>

        <div className="metric-card">
          <div className="between">
            <span className="mc-l">{metric.label}</span>
            <span className="badge-outline">{metric.badge}</span>
          </div>
          <div className="metric-row">
            <div>
              <span className="metric-value num">{metric.value}</span>
              {metric.delta !== null && (
                <span className="metric-delta num" style={{ color: metric.delta < 0 ? "#ffbcbc" : "#a6e8c6" }}>
                  {signedPct(metric.delta)} <span className="muted">last month</span>
                </span>
              )}
            </div>
            <DotBars values={metric.series} />
          </div>
        </div>

        <div className="kpi-grid">{tiles}</div>

        <div className="analysis" ref={analysisRef}>
          <div className="analysis-head">
            <Sparkles size={17} color="#e3f56b" /> AI analysis
          </div>
          {quick.length > 0 && (
            <div className="row-flex" style={{ marginBottom: 10 }}>
              {quick.map((x) => (
                <button key={x.label} className="btn lime sm" onClick={() => run(x.action, x.reason)}>
                  {x.label}
                </button>
              ))}
            </div>
          )}
          {items.map((f) => (
            <div key={f.id} className="analysis-item">
              <b>{f.title}</b>
              <p>{f.detail}</p>
              <div className="row-flex">
                {f.action ? (
                  <button className="btn lime sm" onClick={() => run(f.action!, f.detail)}>
                    {f.actionLabel}
                  </button>
                ) : (
                  <span className="step-note">{f.owner === "agent" ? "Agent watches this" : `Your step${f.actionLabel ? `: ${f.actionLabel.toLowerCase()}` : ""}`}</span>
                )}
              </div>
            </div>
          ))}
          {note && <div className="analysis-item"><p>{note}</p></div>}
          {sel.type !== "root" && (
            <button className="btn ghost sm" onClick={() => setSel({ type: "root" })}>
              Back to whole portfolio
            </button>
          )}
        </div>

        {(asking || reply) && (
          <div className="reply">
            <div className="reply-q">{asking ?? reply?.q}</div>
            {asking ? (
              <span className="typing"><i /><i /><i /></span>
            ) : (
              <>
                <Markdown text={reply!.text} />
                <div className="row-flex" style={{ marginTop: 8 }}>
                  <button className="btn sm ghost" onClick={() => go("agent")}>Open full chat</button>
                  <button className="btn sm ghost" onClick={() => setReply(null)} aria-label="Close answer"><X size={14} /></button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="askbar">
        <form onSubmit={(e) => (e.preventDefault(), void ask(q))} className="ask-input">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={sel.type === "root" ? "Ask about your money…" : `Ask about ${typeof title === "string" ? title : "this"}…`} aria-label="Ask the agent" />
          <button type="submit" disabled={!q.trim() || Boolean(asking)} aria-label="Send">
            <Send size={16} />
          </button>
        </form>
        <div className="ask-chips">
          <span className="chip-btn"><Bot size={14} /> {s.llm.enabled ? "Claude agent" : "My agent (offline)"}</span>
          <button className="chip-btn" onClick={() => go("agent")} title="Approvals waiting">
            <Clock size={14} /> {pending ? `+${pending}` : "0"}
          </button>
          <button className="chip-btn right" onClick={() => analysisRef.current?.scrollIntoView({ behavior: "smooth" })}>
            <Sparkles size={14} /> AI analysis
          </button>
        </div>
      </div>
    </aside>
  );
}

// ======================================================================= page

export function WealthMap() {
  const { s, map, sim, setSim, openSim } = useApp();
  const [sel, setSel] = useState<Sel>({ type: "root" });
  const [stageRef, stage] = useSize<HTMLDivElement>();
  const g = useMemo(() => buildGraph(s, { sort: map.sort, hidden: map.hidden, source: map.source }), [s, map.sort, map.hidden, map.source]);

  // If the selection disappears (filter, disconnect), fall back to the whole portfolio.
  useEffect(() => {
    if (sel.type === "cat" && !g.categories.some((c) => c.id === sel.id)) setSel({ type: "root" });
    if (sel.type === "leaf" && !g.all.some((l) => l.id === sel.id)) setSel({ type: "root" });
  }, [g, sel]);

  // Enter in the header search jumps to the first match.
  useEffect(() => {
    const q = map.query.trim().toLowerCase();
    if (!q) return;
    const hit = g.leaves.find((l) => `${l.name} ${l.institution}`.toLowerCase().includes(q));
    if (hit && map.searchSubmit) setSel({ type: "leaf", id: hit.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map.searchSubmit]);

  const narrow = stage.w > 0 && stage.w < 700;
  const view: MapUi["view"] = narrow ? "tree" : map.view;

  return (
    <div className="map-page">
      <section className="stage" ref={stageRef}>
        <div className="stage-pill">
          Wealth map · {s.sources.filter((x) => x.connected).length + 1} sources · {g.leaves.length} positions <span className="live-dot" />
        </div>
        {sim && (
          <div className="sim-banner">
            <b>Simulation preview</b>
            <span className="num">
              Equities {sim.equitiesPct}% · ETH {sim.cryptoPct}% · private {sim.privatePct}% · EUR {sim.eurUsdPct}%
            </span>
            <button className="btn sm" onClick={openSim}>Edit</button>
            <button className="btn sm ghost" onClick={() => setSim(null)}>Clear</button>
          </div>
        )}
        {view === "graph" ? <Graph g={g} sel={sel} setSel={setSel} /> : <TreeView g={g} sel={sel} setSel={setSel} />}
        {narrow && <div className="muted" style={{ fontSize: 12, padding: "8px 4px" }}>The graph needs a wider window; showing the tree view.</div>}
      </section>
      <Panel g={g} sel={sel} setSel={setSel} />
    </div>
  );
}
