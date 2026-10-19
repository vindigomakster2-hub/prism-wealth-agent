import { useEffect, useState } from "react";
import { Play, X } from "lucide-react";
import { useApp } from "../App";
import { api, type StressInput, type StressResult } from "../api";
import { BarRow } from "./charts";
import { StatusPill, useToast } from "./ui";
import { hf, usd, usdCompact } from "../format";

const PRESETS: Array<{ name: string; s: StressInput }> = [
  { name: "Tech correction", s: { equitiesPct: -25, cryptoPct: -30, privatePct: -30, eurUsdPct: 0 } },
  { name: "Crypto winter", s: { equitiesPct: -5, cryptoPct: -60, privatePct: -10, eurUsdPct: 0 } },
  { name: "2008-style crash", s: { equitiesPct: -45, cryptoPct: -55, privatePct: -50, eurUsdPct: -10 } },
  { name: "Euro slide", s: { equitiesPct: 0, cryptoPct: 0, privatePct: 0, eurUsdPct: -15 } },
];

const SLIDERS: Array<{ key: keyof StressInput; label: string; min: number; max: number }> = [
  { key: "equitiesPct", label: "Public equities (tech moves 1.25×)", min: -60, max: 30 },
  { key: "cryptoPct", label: "ETH", min: -80, max: 50 },
  { key: "privatePct", label: "Private & venture marks", min: -80, max: 30 },
  { key: "eurUsdPct", label: "EUR vs USD", min: -25, max: 25 },
];

export function SimulationModal({ onClose }: { onClose: () => void }) {
  const { sim, setSim, go, refresh } = useApp();
  const toast = useToast();
  const [s, setS] = useState<StressInput>(sim ?? PRESETS[0].s);
  const [r, setR] = useState<StressResult | null>(null);

  useEffect(() => {
    const t = setTimeout(() => api.stress(s).then(setR).catch(() => undefined), 150);
    return () => clearTimeout(t);
  }, [s]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const preview = () => {
    setSim(s);
    go("overview");
    onClose();
  };
  const replay = async () => {
    try {
      await api.crash(Math.min(80, Math.abs(s.cryptoPct)));
      toast("info", `Replaying ETH ${s.cryptoPct}% on-chain in 5 steps. The autopilot is live.`);
      setSim(null);
      go("lab");
      onClose();
      await refresh();
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="New simulation">
        <div className="between">
          <div>
            <h3 className="card-title">New simulation</h3>
            <div className="card-sub">Shock the whole balance sheet, preview it on the map, or replay the ETH move on-chain</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="row-flex" style={{ margin: "14px 0" }}>
          {PRESETS.map((p) => (
            <button key={p.name} className="btn sm" onClick={() => setS(p.s)}>{p.name}</button>
          ))}
        </div>
        <div className="grid g-2" style={{ gap: 18 }}>
          <div className="stack-sm">
            {SLIDERS.map((sl) => (
              <label key={sl.key} className="field">
                <span className="between">
                  <span>{sl.label}</span>
                  <b className="num" style={{ color: s[sl.key] < 0 ? "#ffbcbc" : "#a6e8c6" }}>
                    {s[sl.key] > 0 ? "+" : ""}
                    {s[sl.key]}%
                  </b>
                </span>
                <input type="range" min={sl.min} max={sl.max} value={s[sl.key]} onChange={(e) => setS({ ...s, [sl.key]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
          <div>
            {r && (
              <>
                <div className="muted" style={{ fontSize: 12 }}>Net worth after shock</div>
                <div className="between">
                  <span className="big-num num" style={{ fontSize: 30 }}>{usd(r.after)}</span>
                  <StatusPill tone={r.deltaPct > -10 ? "good" : r.deltaPct > -20 ? "warn" : "bad"}>{r.deltaPct.toFixed(1)}%</StatusPill>
                </div>
                <div className="stack-sm" style={{ marginTop: 12 }}>
                  {r.byGroup
                    .filter((g) => Math.abs(g.delta) > 1)
                    .map((g) => (
                      <BarRow key={g.group} label={<span className="ink2">{g.group}</span>} value={Math.abs(g.delta)} max={Math.max(...r.byGroup.map((x) => Math.abs(x.delta)))} color={g.delta < 0 ? "#ff6b6b" : "#4cc38a"} display={usdCompact(g.delta)} />
                    ))}
                </div>
                <div className="vs" style={{ marginTop: 12 }}>
                  <div>
                    <div className="muted" style={{ fontSize: 12 }}>Your loan health</div>
                    <div className="big-num num" style={{ fontSize: 22, color: r.liquidation ? "#ff6b6b" : "#e3f56b" }}>{hf(r.hfBefore)} → {hf(r.hfAfter)}</div>
                  </div>
                  <div>
                    <div className="muted" style={{ fontSize: 12 }}>Passive twin</div>
                    <div className="big-num num" style={{ fontSize: 22 }}>{hf(r.twinHfAfter)}</div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="row-flex" style={{ marginTop: 18, justifyContent: "flex-end" }}>
          <button className="btn" onClick={replay} disabled={s.cryptoPct >= 0} title={s.cryptoPct >= 0 ? "Set a negative ETH move to replay it on-chain" : undefined}>
            <Play size={15} /> Replay ETH move on-chain
          </button>
          <button className="btn lime" onClick={preview}>Preview on the map</button>
        </div>
      </div>
    </div>
  );
}
