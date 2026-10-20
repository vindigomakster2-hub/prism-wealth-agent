import { useState } from "react";
import { BadgeCheck, EyeOff, Fingerprint, Lock, RefreshCw } from "lucide-react";
import { useApp } from "../App";
import { BarRow, Gauge } from "../components/charts";
import { StatusPill } from "../components/ui";
import { duration, hf, short, usd, usdCompact } from "../format";

export function Credit() {
  const { s, run } = useApp();
  const { credit, chain } = s;
  const loan = chain.loan;
  const att = chain.attestation;
  const [amount, setAmount] = useState(3000);
  const [repay, setRepay] = useState(1000);
  const [busy, setBusy] = useState(false);

  const coll = loan.collateralUsd;
  const usableLine = loan.pledged ? loan.creditLine : Math.min(credit.creditLine, coll * 0.5);
  const capacity = coll * 0.7 + (att.active && loan.pledged ? loan.creditLine : 0);
  const available = Math.max(0, capacity - loan.debt);
  const hfAfter = (amt: number, withProof: boolean) => {
    const d = loan.debt + amt;
    if (d <= 0) return null;
    return (coll * 0.8 + (withProof ? usableLine : 0)) / d;
  };
  const rate = att.active ? loan.rateBps / 100 : 9;
  const cmp = credit.comparison;
  const sliderMax = Math.max(500, Math.floor(Math.max(available, cmp.hybrid.available) / 100) * 100);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  return (
    <div className="stack">
      <div className="grid g-3">
        <div className="card">
          <h3 className="card-title"><BadgeCheck size={18} color="#e3f56b" /> Abanq score</h3>
          <div className="card-sub">From {usdCompact(credit.totalVerified)} of verified off-chain assets</div>
          <div style={{ marginTop: 16 }}>
            <Gauge
              value={credit.score}
              min={300}
              max={850}
              color="#e3f56b"
              size={260}
              marks={credit.tiers.slice(1).map((t) => ({ at: t.minScore, label: `T${t.tier}` }))}
            >
              <div className="big-num" style={{ fontSize: 42 }}>{credit.score}</div>
              <span className="pill lime">Tier {credit.tier} · {(credit.rateBps / 100).toFixed(1)}% APR</span>
            </Gauge>
          </div>
          <p className="muted" style={{ fontSize: 12.5, textAlign: "center", marginBottom: 0 }}>
            {credit.nextTier
              ? `${credit.nextTier.pointsNeeded} points to Tier ${credit.nextTier.tier} (${(credit.nextTier.rateBps / 100).toFixed(1)}% APR). Diversification is your weakest factor.`
              : "Top tier reached."}
          </p>
        </div>

        <div className="card">
          <h3 className="card-title">What drives the score</h3>
          <div className="card-sub">Weighted factors, each 0–100</div>
          <div className="stack" style={{ gap: 14, marginTop: 16 }}>
            {credit.factors.map((f) => (
              <div key={f.key}>
                <BarRow label={<span>{f.label}</span>} value={f.score} max={100} color={f.score >= 80 ? "#4cc38a" : f.score >= 60 ? "#e3f56b" : "#f5c451"} display={`${Math.round(f.score)} · ${Math.round(f.weight * 100)}%`} />
                <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{f.detail}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">Standard DeFi vs Abanq</h3>
          <div className="card-sub">Same {usd(coll)} of ETH collateral, same pool</div>
          <table className="t" style={{ marginTop: 14 }}>
            <thead>
              <tr><th /><th className="r">Standard</th><th className="r" style={{ color: "#e3f56b" }}>Abanq · T{credit.tier}</th></tr>
            </thead>
            <tbody>
              <tr><td>Max borrow</td><td className="r">{usd(cmp.standard.maxBorrow)}</td><td className="r"><b>{usd(cmp.hybrid.maxBorrow)}</b></td></tr>
              <tr><td>Effective LTV</td><td className="r">{cmp.standard.ltvPct.toFixed(0)}%</td><td className="r"><b>{cmp.hybrid.ltvPct.toFixed(0)}%</b></td></tr>
              <tr><td>APR</td><td className="r">{cmp.standard.aprPct.toFixed(1)}%</td><td className="r"><b>{cmp.hybrid.aprPct.toFixed(1)}%</b></td></tr>
              <tr><td>Available now</td><td className="r">{usd(cmp.standard.available)}</td><td className="r"><b>{usd(cmp.hybrid.available)}</b></td></tr>
            </tbody>
          </table>
          <div className="banner" style={{ marginTop: 16, marginBottom: 0, background: "rgba(227,245,107,.08)", borderColor: "rgba(227,245,107,.3)", color: "#eef7b4" }}>
            Saves {usd(cmp.annualSavingsUsd)} a year in interest on the current {usd(loan.debt)} debt.
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            The credit line is capped at 50% of on-chain collateral, so a loan is never fully unsecured.
          </p>
        </div>
      </div>

      <div className="grid g-main">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Borrow against your whole balance sheet</h3>
              <div className="card-sub">Executed by the agent key, after simulation and policy checks</div>
            </div>
            <StatusPill tone={att.active && loan.pledged ? "good" : "warn"}>{att.active && loan.pledged ? "Proof active" : "Standard terms"}</StatusPill>
          </div>
          <label className="field">
            <span className="between">
              <span>Amount</span>
              <b className="big-num num" style={{ fontSize: 26, color: "#f6f3ee" }}>{usd(amount)}</b>
            </span>
            <input type="range" min={100} max={sliderMax} step={100} value={Math.min(amount, sliderMax)} onChange={(e) => setAmount(Number(e.target.value))} />
          </label>
          <div className="vs" style={{ marginTop: 14 }}>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>Without proof · 9.0% APR</div>
              <div className="big-num" style={{ fontSize: 26, color: (hfAfter(amount, false) ?? 9) < 1.25 ? "#ff6b6b" : "#efe6d2" }}>health {hf(hfAfter(amount, false))}</div>
              <div className="muted" style={{ fontSize: 12 }}>{amount > cmp.standard.available ? "Exceeds standard capacity" : `${usd((amount * 9) / 1200, 2)}/mo interest`}</div>
            </div>
            <div style={{ borderColor: "rgba(227,245,107,.3)" }}>
              <div className="muted" style={{ fontSize: 12 }}>With Proof of Wealth · {(credit.rateBps / 100).toFixed(1)}% APR</div>
              <div className="big-num" style={{ fontSize: 26, color: (hfAfter(amount, true) ?? 9) < 1.25 ? "#ff6b6b" : "#e3f56b" }}>health {hf(hfAfter(amount, true))}</div>
              <div className="muted" style={{ fontSize: 12 }}>{usd((amount * credit.rateBps) / 120000, 2)}/mo interest</div>
            </div>
          </div>
          <div className="row-flex" style={{ marginTop: 16 }}>
            {!att.active && credit.eligible && (
              <button className="btn lime" disabled={busy} onClick={() => act(() => run({ kind: "refresh_attestation" }, "Unlock tiered terms before borrowing"))}>
                <Fingerprint size={16} /> Publish proof first
              </button>
            )}
            <button className="btn primary" disabled={busy || amount > available + 0.01} onClick={() => act(() => run({ kind: "borrow", amountUsd: amount }, `Borrow ${usd(amount)} from the Credit page`))}>
              Borrow {usd(amount)}
            </button>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {usd(available)} available now at {rate.toFixed(1)}% APR
            </span>
          </div>
          <div className="divider" />
          <div className="row-flex">
            <input className="input" type="number" min={1} step={100} value={repay} onChange={(e) => setRepay(Number(e.target.value))} style={{ maxWidth: 160 }} aria-label="Repay amount" />
            <button className="btn" disabled={busy || loan.debt <= 0} onClick={() => act(() => run({ kind: "repay", amountUsd: repay }, "Repay from the Credit page"))}>
              Repay
            </button>
            <button className="btn ghost" disabled={busy || loan.debt <= 0} onClick={() => act(() => run({ kind: "repay", amountUsd: loan.debt + 1 }, "Repay in full"))}>
              Repay all ({usd(loan.debt)})
            </button>
            <span className="muted" style={{ fontSize: 12.5 }}>Wallet: {usd(chain.wallet.usdc)} USDC</span>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title"><Lock size={17} /> On-chain attestation</h3>
              <div className="card-sub">EIP-712 signed by the attestor, verified by CreditRegistry</div>
            </div>
            <StatusPill tone={att.active ? "good" : att.exists ? "bad" : "neutral"}>{att.active ? "Active" : att.exists ? "Expired" : "Not published"}</StatusPill>
          </div>
          <table className="t">
            <tbody>
              <tr><td className="muted">Tier · score</td><td className="r">{att.exists ? `T${att.tier} · ${att.score}` : "–"}</td></tr>
              <tr><td className="muted">Credit line</td><td className="r">{att.exists ? usd(att.creditLine) : "–"}</td></tr>
              <tr><td className="muted">Usable now (≤50% of collateral)</td><td className="r">{usd(loan.creditLine)}</td></tr>
              <tr><td className="muted">Expires in</td><td className="r">{att.exists ? duration(att.expiresAt - chain.chainTime) : "–"}</td></tr>
              <tr><td className="muted">Pledged to pool</td><td className="r">{loan.pledged ? "Yes, exclusively" : "No"}</td></tr>
              <tr><td className="muted">Evidence root</td><td className="r mono">{att.exists ? short(att.sourcesRoot) : "–"}</td></tr>
            </tbody>
          </table>
          <div className="row-flex" style={{ marginTop: 14 }}>
            <button className="btn lime" disabled={busy || !credit.eligible} onClick={() => act(() => run({ kind: "refresh_attestation" }, "Publish or refresh Proof of Wealth"))}>
              <RefreshCw size={15} /> {att.exists ? "Refresh proof" : "Publish proof"}
            </button>
            {loan.pledged && (
              <button className="btn ghost" disabled={busy} onClick={() => act(() => run({ kind: "release_credit" }, "Release credit line"))}>
                Release line
              </button>
            )}
          </div>
          <div className="banner" style={{ marginTop: 16, marginBottom: 0, background: "rgba(255,255,255,.05)", borderColor: "var(--stroke-2)", color: "var(--ink-2)" }}>
            <EyeOff size={18} />
            <span>Only tier, score, line, expiry and an evidence hash go on-chain. Balances and account names never do.</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">What counts as collateral</h3>
            <div className="card-sub">
              Haircuts protect lenders against withdrawals and price moves. Credit line = {credit.creditRatioPct}% of pledgeable value, capped by tier.
            </div>
          </div>
          <span className="big-num num" style={{ fontSize: 22 }}>{usd(credit.totalPledgeable)}</span>
        </div>
        <table className="t">
          <thead>
            <tr><th>Asset</th><th>Institution</th><th className="r">Value</th><th className="r">Counts</th><th className="r">Pledgeable</th><th>Why</th></tr>
          </thead>
          <tbody>
            {credit.pledgeable.map((p) => (
              <tr key={p.id} style={{ opacity: p.haircutPct === 0 ? 0.6 : 1 }}>
                <td>{p.name}</td>
                <td className="muted">{p.institution}</td>
                <td className="r">{usd(p.valueUsd)}</td>
                <td className="r">{p.haircutPct}%</td>
                <td className="r"><b>{usd(p.pledgeableUsd)}</b></td>
                <td className="muted" style={{ fontSize: 12 }}>{p.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
