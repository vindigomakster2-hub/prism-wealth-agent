import { useEffect, useState } from "react";
import { CircleCheck, ShieldCheck, TriangleAlert, Zap } from "lucide-react";
import { useApp } from "../App";
import { api, type StressInput, type StressResult } from "../api";
import { BarRow, Donut, Gauge } from "../components/charts";
import { StatusPill } from "../components/ui";
import { hf, pct, usd, usdCompact } from "../format";

const GROUP_COLOR: Record<string, string> = {
  "Cash & deposits": "#3987e5",
  "Public equities": "#d95926",
  "Bonds & T-bills": "#199e70",
  "Private & venture": "#c98500",
  Crypto: "#d55181",
};

const SECTOR_LABEL: Record<string, string> = {
  tech: "Technology",
  crypto: "Crypto",
  broad_market: "Broad market",
  rates: "Rates & T-bills",
  consumer: "Consumer",
  credit: "Private credit",
  cash: "Cash",
};

const SLIDERS: Array<{ key: keyof StressInput; label: string; min: number; max: number }> = [
  { key: "equitiesPct", label: "Public equities (tech moves 1.25×)", min: -60, max: 30 },
  { key: "cryptoPct", label: "ETH", min: -80, max: 50 },
  { key: "privatePct", label: "Private & venture marks", min: -80, max: 30 },
  { key: "eurUsdPct", label: "EUR vs USD", min: -25, max: 25 },
];

export function Risk() {
  const { s, run, go } = useApp();
  const r = s.risk;
  const [stress, setStress] = useState<StressInput>({ equitiesPct: -25, cryptoPct: -40, privatePct: -30, eurUsdPct: -5 });
  const [result, setResult] = useState<StressResult | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api.stress(stress).then(setResult).catch(() => undefined);
    }, 180);
    return () => clearTimeout(t);
  }, [stress, s.chain.ethPrice, s.chain.loan.debt]);

  const scoreColor = r.riskScore < 30 ? "#4cc38a" : r.riskScore < 50 ? "#e3f56b" : r.riskScore < 70 ? "#f5c451" : "#ff6b6b";
  const maxLadder = Math.max(...r.liquidityLadder.map((l) => l.value));
  const maxSector = Math.max(...r.sectorExposure.map((x) => x.value));

  return (
    <div className="stack">
      <div className="grid g-3">
        <div className="card">
          <h3 className="card-title">Risk score</h3>
          <div className="card-sub">0 is calm, 100 is fragile. Covers on-chain and off-chain together. Each bar shows a factor score and its weight.</div>
          <div style={{ marginTop: 18 }}>
            <Gauge value={r.riskScore} min={0} max={100} color={scoreColor} size={250}>
              <div className="big-num" style={{ fontSize: 40 }}>{r.riskScore}</div>
              <StatusPill tone={r.riskScore < 50 ? "good" : r.riskScore < 70 ? "warn" : "bad"}>{r.riskLabel}</StatusPill>
            </Gauge>
          </div>
          <div className="stack-sm" style={{ marginTop: 18 }}>
            {r.components.map((c) => (
              <BarRow key={c.key} label={<span className="ink2">{c.key}</span>} value={c.value} max={100} color={c.value > 60 ? "#ff6b6b" : c.value > 30 ? "#f5c451" : "#4cc38a"} display={`${Math.round(c.value)} · ${Math.round(c.weight * 100)}%`} />
            ))}
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">Allocation</h3>
          <div className="card-sub">Across {s.sources.filter((x) => x.connected).length} institutions and the on-chain wallet</div>
          <div style={{ display: "flex", gap: 18, alignItems: "center", marginTop: 18, flexWrap: "wrap", justifyContent: "center" }}>
            <Donut
              slices={r.allocation.map((a) => ({ label: a.group, value: a.value, color: GROUP_COLOR[a.group] }))}
              center={
                <div>
                  <div className="big-num" style={{ fontSize: 22 }}>{usdCompact(r.totals.assets)}</div>
                  <div className="muted" style={{ fontSize: 12 }}>gross assets</div>
                </div>
              }
            />
            <div className="stack-sm" style={{ flex: 1, minWidth: 170 }}>
              {r.allocation.map((a) => (
                <div key={a.group} className="between" style={{ fontSize: 13 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="swatch" style={{ background: GROUP_COLOR[a.group] }} />
                    {a.group}
                  </span>
                  <span className="num ink2">{pct(a.pct)} · {usdCompact(a.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">Liquidity ladder</h3>
          <div className="card-sub">How fast each dollar can become spendable cash</div>
          <div className="stack-sm" style={{ marginTop: 18 }}>
            {r.liquidityLadder.map((l) => (
              <BarRow key={l.bucket} label={<span className="ink2">{l.bucket}</span>} value={l.value} max={maxLadder} color={l.bucket.startsWith("Locked") ? "#d55181" : "#e3f56b"} display={usdCompact(l.value)} />
            ))}
          </div>
          <div className="divider" />
          <div className="stack-sm" style={{ fontSize: 13 }}>
            {r.checks.map((c) => (
              <div key={c.label} className="between">
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {c.ok ? <CircleCheck size={15} color="#4cc38a" /> : <TriangleAlert size={15} color="#f5c451" />}
                  {c.label}
                </span>
                <span className="muted">{c.detail}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid g-main">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Findings</h3>
              <div className="card-sub">Sorted by severity. Each one says who can fix it.</div>
            </div>
            <span className="pill">{r.findings.length} open</span>
          </div>
          <div className="stack-sm">
            {r.findings.map((f) => (
              <div className="finding" key={f.id}>
                <div className={`ico ${f.severity}`}>{f.owner === "agent" ? <Zap size={17} /> : <ShieldCheck size={17} />}</div>
                <div>
                  <h4>{f.title}</h4>
                  <p>{f.detail}</p>
                  <div className="owner">
                    <StatusPill tone={f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "neutral"}>{f.severity}</StatusPill>
                    <span className="pill">{f.owner === "agent" ? "Agent can act on-chain" : "Off-chain: your step"}</span>
                    {f.owner === "you" && f.actionLabel && <span className="muted" style={{ fontSize: 12.5 }}>→ {f.actionLabel}</span>}
                  </div>
                </div>
                {f.action ? (
                  <button className="btn lime sm" onClick={() => run(f.action!, f.detail)}>
                    {f.actionLabel}
                  </button>
                ) : f.owner === "agent" ? (
                  <button className="btn sm" onClick={() => go("agent")}>Agent settings</button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">Stress test</h3>
          <div className="card-sub">Drag a shock and see net worth and loan health respond</div>
          <div className="stack-sm" style={{ marginTop: 16 }}>
            {SLIDERS.map((sl) => (
              <label key={sl.key} className="field">
                <span className="between">
                  <span>{sl.label}</span>
                  <b className="num" style={{ color: stress[sl.key] < 0 ? "#ffbcbc" : "#a6e8c6" }}>
                    {stress[sl.key] > 0 ? "+" : ""}
                    {stress[sl.key]}%
                  </b>
                </span>
                <input type="range" min={sl.min} max={sl.max} step={1} value={stress[sl.key]} onChange={(e) => setStress({ ...stress, [sl.key]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
          {result && (
            <>
              <div className="divider" />
              <div className="between">
                <div>
                  <div className="muted" style={{ fontSize: 12 }}>Net worth after shock</div>
                  <div className="big-num" style={{ fontSize: 30 }}>{usd(result.after)}</div>
                </div>
                <StatusPill tone={result.deltaPct > -10 ? "good" : result.deltaPct > -20 ? "warn" : "bad"}>
                  {result.deltaPct.toFixed(1)}% · {usdCompact(result.delta)}
                </StatusPill>
              </div>
              <div className="stack-sm" style={{ marginTop: 14 }}>
                {result.byGroup
                  .filter((g) => Math.abs(g.delta) > 1)
                  .map((g) => (
                    <BarRow
                      key={g.group}
                      label={
                        <span className="ink2" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <span className="swatch" style={{ background: GROUP_COLOR[g.group] }} />
                          {g.group}
                        </span>
                      }
                      value={Math.abs(g.delta)}
                      max={Math.max(...result.byGroup.map((x) => Math.abs(x.delta)))}
                      color={g.delta < 0 ? "#ff6b6b" : "#4cc38a"}
                      display={usdCompact(g.delta)}
                    />
                  ))}
              </div>
              <div className="vs" style={{ marginTop: 14 }}>
                <div>
                  <div className="muted" style={{ fontSize: 12 }}>Your loan health</div>
                  <div className="big-num" style={{ fontSize: 24, color: result.liquidation ? "#ff6b6b" : "#e3f56b" }}>
                    {hf(result.hfBefore)} → {hf(result.hfAfter)}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>{result.liquidation ? "Rescue playbook would fire first" : "Stays above liquidation"}</div>
                </div>
                <div>
                  <div className="muted" style={{ fontSize: 12 }}>Passive twin, no agent</div>
                  <div className="big-num" style={{ fontSize: 24, color: (result.twinHfAfter ?? 9) < 1 ? "#ff6b6b" : "#efe6d2" }}>{hf(result.twinHfAfter)}</div>
                  <div className="muted" style={{ fontSize: 12 }}>ETH at {usd(result.ethPriceAfter)}</div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="grid g-2">
        <div className="card">
          <h3 className="card-title">Capital by risk level</h3>
          <div className="card-sub">
            Alert above {s.mandate.alerts.maxCapitalAtRiskPct}% in high-risk assets (set on the Agent page). Now: {Math.round(r.capitalAtRiskPct)}%
          </div>
          <div className="stack-sm" style={{ marginTop: 16 }}>
            {r.byRisk.map((x) => (
              <BarRow
                key={x.level}
                label={<span className="ink2" style={{ textTransform: "capitalize" }}>{x.level} risk</span>}
                value={x.value}
                max={r.totals.assets}
                color={x.level === "high" ? "#ff6b6b" : x.level === "medium" ? "#f5c451" : "#4cc38a"}
                display={`${pct(x.pct)} · ${usdCompact(x.value)}`}
              />
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Low: cash, deposits, T-bills, bonds. Medium: ETFs, P2P loans, real assets. High: single stocks, crypto, private stakes.</p>
        </div>
        <div className="card">
          <h3 className="card-title">What pays you, what costs you</h3>
          <div className="card-sub">Capital by behaviour, and the yearly cash it produces or drains</div>
          <table className="t" style={{ marginTop: 10 }}>
            <tbody>
              {r.byBehavior.map((b) => (
                <tr key={b.behavior}>
                  <td style={{ textTransform: "capitalize" }}>{b.behavior === "drain" ? "Debts (drain)" : b.behavior === "income" ? "Pays income" : "Neutral"}</td>
                  <td className="r">{usdCompact(b.value)}</td>
                  <td className="r" style={{ color: b.annualUsd > 0 ? "#a6e8c6" : b.annualUsd < 0 ? "#ffbcbc" : undefined }}>{b.annualUsd === 0 ? "–" : `${b.annualUsd > 0 ? "+" : "−"}${usd(Math.abs(b.annualUsd))}/yr`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="between" style={{ marginTop: 12 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>Passive income − interest − premiums</span>
            <StatusPill tone={r.cashflow.netUsd >= 0 ? "good" : "warn"}>{r.cashflow.netUsd >= 0 ? "+" : "−"}{usd(Math.abs(r.cashflow.netUsd))}/yr</StatusPill>
          </div>
        </div>
      </div>

      <div className="grid g-3">
        <div className="card">
          <h3 className="card-title">Sector exposure</h3>
          <div className="card-sub">{Math.round(r.riskOnPct)}% of net worth sits in tech and crypto, which tend to fall together</div>
          <div className="stack-sm" style={{ marginTop: 16 }}>
            {r.sectorExposure
              .slice()
              .sort((a, b) => b.value - a.value)
              .map((x) => (
                <BarRow key={x.sector} label={<span className="ink2">{SECTOR_LABEL[x.sector] ?? x.sector}</span>} value={x.value} max={maxSector} color={x.sector === "tech" || x.sector === "crypto" ? "#ff9a52" : "#efe6d2"} display={pct(x.pct)} />
              ))}
          </div>
        </div>
        <div className="card">
          <h3 className="card-title">Largest positions</h3>
          <div className="card-sub">Share of net worth</div>
          <table className="t" style={{ marginTop: 10 }}>
            <tbody>
              {r.topHoldings.map((h) => (
                <tr key={h.name}>
                  <td>{h.name}</td>
                  <td className="r muted">{pct(h.pct, 1)}</td>
                  <td className="r">{usdCompact(h.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3 className="card-title">Custody & currency</h3>
          <div className="card-sub">Deposit guarantees and FX exposure</div>
          <div className="stack-sm" style={{ marginTop: 14, fontSize: 13 }}>
            {r.depositGuarantee.map((d) => (
              <div key={d.bank}>
                <div className="between">
                  <span>{d.bank}</span>
                  {d.excess > 0 ? <StatusPill tone="warn">{usdCompact(d.excess)} unprotected</StatusPill> : <StatusPill tone="good">Fully covered</StatusPill>}
                </div>
                <div className="meter" style={{ marginTop: 6 }}>
                  <i style={{ width: `${Math.min(100, (d.amount / d.limit) * 100)}%`, background: d.excess > 0 ? "#f5c451" : "#4cc38a" }} />
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {usd(d.amount)} held, {usd(d.limit)} guaranteed
                </div>
              </div>
            ))}
            <div className="divider" style={{ margin: "6px 0" }} />
            {r.currencies.map((c) => (
              <BarRow key={c.ccy} label={<span className="ink2">{c.ccy}</span>} value={c.pct} max={100} color="#efe6d2" display={pct(c.pct)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
