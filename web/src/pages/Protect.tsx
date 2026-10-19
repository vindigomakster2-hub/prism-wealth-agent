import { useState } from "react";
import { HeartPulse, Landmark, PiggyBank, Umbrella } from "lucide-react";
import { useApp } from "../App";
import { StatusPill } from "../components/ui";
import { duration, usd } from "../format";

export function Protect() {
  const { s, run } = useApp();
  const c = s.chain;
  const [dep, setDep] = useState(1000);
  const [wd, setWd] = useState(500);
  const [cover, setCover] = useState(Math.max(500, Math.ceil((c.loan.debt * 0.1) / 100) * 100));
  const [days, setDays] = useState(90);
  const premium = (cover * 0.04 * days) / 365;
  const policies = s.risk.insurance.policies;
  const lifeGap = s.risk.findings.find((f) => f.id === "life-gap");
  const loanRate = c.loan.rateBps / 100;

  return (
    <div className="stack">
      <div className="grid g-3">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title"><PiggyBank size={18} /> Treasury vault</h3>
              <div className="card-sub">Tokenized T-bill exposure with next-day liquidity</div>
            </div>
            <span className="pill lime">{c.vaultApyPct}% APY</span>
          </div>
          <div className="big-num num" style={{ fontSize: 40 }}>{usd(c.wallet.vault, 2)}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>earning about {usd((c.wallet.vault * c.vaultApyPct) / 100)} a year</div>
          <div className="divider" />
          <div className="stack-sm">
            <div className="row-flex">
              <input className="input" type="number" min={1} step={100} value={dep} onChange={(e) => setDep(Number(e.target.value))} style={{ maxWidth: 140 }} aria-label="Deposit amount" />
              <button className="btn" onClick={() => run({ kind: "vault_deposit", amountUsd: dep }, "Deposit from Earn & Protect")}>Deposit</button>
            </div>
            <div className="row-flex">
              <input className="input" type="number" min={1} step={100} value={wd} onChange={(e) => setWd(Number(e.target.value))} style={{ maxWidth: 140 }} aria-label="Withdraw amount" />
              <button className="btn" onClick={() => run({ kind: "vault_withdraw", amountUsd: wd }, "Withdraw from Earn & Protect")}>Withdraw</button>
            </div>
          </div>
          {c.loan.debt > 0 && loanRate > c.vaultApyPct && (
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
              Note: your loan costs {loanRate.toFixed(1)}%. Repaying debt beats parking cash at {c.vaultApyPct}%. The agent weighs this before sweeping idle cash.
            </p>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title"><Umbrella size={18} /> Liquidation cover</h3>
              <div className="card-sub">Parametric: pays the liquidation penalty automatically, verified on-chain</div>
            </div>
            <span className="pill">4% / year</span>
          </div>
          <div className="grid g-2" style={{ gap: 10 }}>
            <label className="field">
              Cover amount ($)
              <input className="input" type="number" min={100} step={100} value={cover} onChange={(e) => setCover(Number(e.target.value))} />
            </label>
            <label className="field">
              Duration
              <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
          </div>
          <div className="between" style={{ marginTop: 12 }}>
            <span className="muted">Premium</span>
            <b className="num">{usd(premium, 2)}</b>
          </div>
          <button className="btn lime" style={{ marginTop: 12, width: "100%" }} onClick={() => run({ kind: "buy_cover", coverUsd: cover, days }, "Buy cover from Earn & Protect")}>
            Buy cover
          </button>
          <div className="divider" />
          <div className="stack-sm">
            {c.cover.length === 0 && <div className="empty">No policies yet</div>}
            {c.cover.map((p) => (
              <div key={p.id} className="between" style={{ fontSize: 13 }}>
                <div>
                  <div>Policy #{p.id} · {usd(p.coverUsd)}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{p.claimed ? "Claimed" : p.active ? `${duration(p.expiry - c.chainTime)} left` : "Expired"} · premium {usd(p.premiumUsd, 2)}</div>
                </div>
                {p.claimable > 0 ? (
                  <button className="btn lime sm" onClick={() => run({ kind: "claim_cover", policyId: p.id }, "Claim cover payout")}>Claim {usd(p.claimable, 2)}</button>
                ) : (
                  <StatusPill tone={p.active ? "good" : "neutral"}>{p.claimed ? "Paid" : p.active ? "Active" : "Ended"}</StatusPill>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title"><HeartPulse size={18} /> Off-chain insurance</h3>
              <div className="card-sub">Parsed from your Harbor Insurance documents</div>
            </div>
          </div>
          <div className="stack-sm">
            {policies.map((p) => (
              <div key={p.id} className="between" style={{ fontSize: 13 }}>
                <div>
                  <div>{p.name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{usd(p.coverageUsd)} coverage · {usd(p.premiumMonthly)}/mo</div>
                </div>
                <StatusPill tone="good">Active</StatusPill>
              </div>
            ))}
          </div>
          {lifeGap && (
            <div className="finding" style={{ marginTop: 16 }}>
              <div className="ico high"><Landmark size={17} /></div>
              <div>
                <h4>{lifeGap.title}</h4>
                <p>{lifeGap.detail}</p>
                <div className="owner"><span className="pill">Your step: compare term-life quotes</span></div>
              </div>
              <span />
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            Prism doesn't sell insurance. Off-chain recommendations are decision support, not licensed advice.
          </p>
        </div>
      </div>
    </div>
  );
}
