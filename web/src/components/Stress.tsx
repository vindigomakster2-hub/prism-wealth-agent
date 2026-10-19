import { useEffect, useState } from "react";
import { Plus, Save, X } from "lucide-react";
import { api, type Scenario, type StressInput, type StressParam, type StressResult, type StressTargets } from "../api";
import { BarRow } from "./charts";
import { StatusPill, useToast } from "./ui";
import { hf, usd, usdCompact } from "../format";

export const EMPTY_STRESS: StressInput = { equitiesPct: 0, cryptoPct: 0, privatePct: 0, eurUsdPct: 0, ratesBps: 0, incomePct: 0, custom: [] };

const BASE: Array<{ key: keyof StressInput; label: string; min: number; max: number; step: number; unit: string }> = [
  { key: "equitiesPct", label: "Public equities (tech moves more)", min: -60, max: 30, step: 1, unit: "%" },
  { key: "cryptoPct", label: "Crypto (ETH)", min: -80, max: 50, step: 1, unit: "%" },
  { key: "privatePct", label: "Private & venture marks", min: -80, max: 30, step: 1, unit: "%" },
  { key: "eurUsdPct", label: "EUR vs USD", min: -25, max: 25, step: 1, unit: "%" },
  { key: "ratesBps", label: "Interest rates", min: -300, max: 500, step: 25, unit: " bps" },
  { key: "incomePct", label: "Monthly income", min: -100, max: 50, step: 5, unit: "%" },
];

const KIND_LABEL: Record<StressParam["kind"], string> = {
  group: "Asset group",
  sector: "Sector (look-through)",
  region: "Region (look-through)",
  currency: "Currency",
  institution: "Institution",
  position: "Single position",
};

export function StressBuilder({ value, onChange }: { value: StressInput; onChange: (v: StressInput) => void }) {
  const toast = useToast();
  const [targets, setTargets] = useState<StressTargets | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [draft, setDraft] = useState<{ kind: StressParam["kind"]; target: string; pct: number }>({ kind: "sector", target: "technology", pct: -20 });
  const [name, setName] = useState("");

  useEffect(() => {
    api.stressTargets().then(setTargets).catch(() => undefined);
    api.scenarios().then(setScenarios).catch(() => undefined);
  }, []);

  const custom = value.custom ?? [];
  const labelOf = (p: StressParam) => targets?.[p.kind].find((t) => t.value === p.target)?.label ?? p.target;
  const options = targets?.[draft.kind] ?? [];

  const add = () => {
    if (!draft.target) return;
    onChange({ ...value, custom: [...custom, { id: `c${Date.now()}`, kind: draft.kind, target: draft.target, pct: draft.pct }] });
  };
  const save = async () => {
    if (!name.trim()) return;
    try {
      const next = await api.saveScenarios([...scenarios.filter((s) => s.name !== name.trim()), { id: `u${Date.now()}`, name: name.trim(), input: value }]);
      setScenarios(next);
      setName("");
      toast("good", `Scenario "${name.trim()}" saved`);
    } catch (e) {
      toast("bad", String(e));
    }
  };
  const remove = async (id: string) => setScenarios(await api.saveScenarios(scenarios.filter((s) => s.id !== id)));

  return (
    <div className="stack-sm">
      <div className="row-flex" style={{ gap: 6 }}>
        {scenarios.map((s) => (
          <span key={s.id} className="scenario-chip">
            <button onClick={() => onChange({ ...EMPTY_STRESS, ...s.input })}>{s.name}</button>
            {!s.builtIn && (
              <button onClick={() => remove(s.id)} aria-label={`Delete ${s.name}`}>
                <X size={12} />
              </button>
            )}
          </span>
        ))}
        <button className="btn sm ghost" onClick={() => onChange(EMPTY_STRESS)}>Clear</button>
      </div>

      {BASE.map((b) => {
        const v = Number(value[b.key] ?? 0);
        return (
          <label key={b.key} className="field">
            <span className="between">
              <span>{b.label}</span>
              <b className="num" style={{ color: v < 0 ? "#ffbcbc" : v > 0 ? "#a6e8c6" : undefined }}>
                {v > 0 ? "+" : ""}
                {v}
                {b.unit}
              </b>
            </span>
            <input type="range" min={b.min} max={b.max} step={b.step} value={v} onChange={(e) => onChange({ ...value, [b.key]: Number(e.target.value) })} />
          </label>
        );
      })}

      <div className="divider" style={{ margin: "6px 0" }} />
      <div className="muted" style={{ fontSize: 12 }}>Your own parameters (applied on top, compounding)</div>
      {custom.length === 0 && <div className="muted" style={{ fontSize: 12 }}>None yet. For example: "Region: Europe −15%", or one position at −50%.</div>}
      {custom.map((p, i) => (
        <div key={p.id ?? i} className="param-row">
          <span className="pill">{KIND_LABEL[p.kind]}</span>
          <span className="param-target">{labelOf(p)}</span>
          <input
            className="input"
            type="number"
            value={p.pct}
            style={{ width: 80, padding: "5px 8px" }}
            onChange={(e) => onChange({ ...value, custom: custom.map((x, j) => (j === i ? { ...x, pct: Number(e.target.value) } : x)) })}
            aria-label="Shock in percent"
          />
          <span className="muted">%</span>
          <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => onChange({ ...value, custom: custom.filter((_, j) => j !== i) })} aria-label="Remove parameter">
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="param-add">
        <select className="input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as StressParam["kind"], target: targets?.[e.target.value as StressParam["kind"]][0]?.value ?? "" })} aria-label="Parameter type">
          {(Object.keys(KIND_LABEL) as Array<StressParam["kind"]>).map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
        <select className="input" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} aria-label="Target">
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input className="input" type="number" value={draft.pct} onChange={(e) => setDraft({ ...draft, pct: Number(e.target.value) })} aria-label="Shock in percent" />
        <button className="btn sm" onClick={add}><Plus size={14} /> Add</button>
      </div>
      <div className="row-flex" style={{ gap: 6 }}>
        <input className="input" placeholder="Save as scenario…" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, padding: "7px 10px" }} />
        <button className="btn sm" disabled={!name.trim()} onClick={save}><Save size={14} /> Save</button>
      </div>
    </div>
  );
}

export function StressResultView({ r }: { r: StressResult }) {
  const maxGroup = Math.max(1, ...r.byGroup.map((x) => Math.abs(x.delta)));
  return (
    <div className="stack-sm">
      <div className="between">
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Net worth after shock</div>
          <div className="big-num num" style={{ fontSize: 28 }}>{usd(r.after)}</div>
        </div>
        <StatusPill tone={r.deltaPct > -10 ? "good" : r.deltaPct > -20 ? "warn" : "bad"}>
          {r.deltaPct.toFixed(1)}% · {usdCompact(r.delta)}
        </StatusPill>
      </div>
      {r.byGroup
        .filter((g) => Math.abs(g.delta) > 1)
        .map((g) => (
          <BarRow key={g.group} label={<span className="ink2">{g.group}</span>} value={Math.abs(g.delta)} max={maxGroup} color={g.delta < 0 ? "#ff6b6b" : "#4cc38a"} display={usdCompact(g.delta)} />
        ))}
      {r.topMovers.length > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          Biggest movers: {r.topMovers.filter((m) => Math.abs(m.delta) > 1).slice(0, 4).map((m) => `${m.name} ${usdCompact(m.delta)}`).join(" · ")}
        </div>
      )}
      <div className="vs">
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Your loan health</div>
          <div className="big-num num" style={{ fontSize: 20, color: r.liquidation ? "#ff6b6b" : "#e3f56b" }}>{hf(r.hfBefore)} → {hf(r.hfAfter)}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>Passive twin: {hf(r.twinHfAfter)} · ETH {usd(r.ethPriceAfter)}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Cash flow per year</div>
          <div className="big-num num" style={{ fontSize: 20, color: r.cashflow.netAnnualUsd < 0 ? "#ffbcbc" : undefined }}>{r.cashflow.netAnnualUsd >= 0 ? "+" : "−"}{usd(Math.abs(r.cashflow.netAnnualUsd))}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            {r.runwayMonths === null ? "Income still covers spending" : `Runway ${r.runwayMonths.toFixed(1)} months (gap ${usd(r.monthlyGapUsd)}/mo)`}
          </div>
        </div>
      </div>
    </div>
  );
}
