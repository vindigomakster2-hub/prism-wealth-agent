import { useState } from "react";
import { Bot, KeyRound, Link, Lock, RefreshCw, ShieldCheck, Unlink, Wallet } from "lucide-react";
import { useApp } from "../App";
import { api } from "../api";
import { StatusPill, Toggle, useToast } from "../components/ui";
import { duration, eth, hf, short, timeAgo, usd } from "../format";

const CLASS_LABEL: Record<string, string> = {
  cash: "Current account",
  savings: "Savings",
  term_deposit: "Term deposit",
  equity: "Stock",
  etf: "ETF",
  bond_fund: "Bond fund",
  broker_cash: "Cash",
  private_equity: "Private equity",
  venture: "Venture",
  p2p_lending: "P2P lending",
};

export function Accounts() {
  const { s, refresh } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const c = s.chain;

  const toggle = async (id: string, connected: boolean) => {
    setBusy(id);
    // Visible consent step: in production this is the bank's OAuth / open-banking consent screen.
    if (connected) await new Promise((r) => setTimeout(r, 1100));
    try {
      await api.connect(id, connected);
      toast("good", connected ? "Read-only access granted" : "Access revoked, data removed from analysis");
    } catch (e) {
      toast("bad", String(e));
    }
    setBusy(null);
    await refresh();
  };

  return (
    <div className="stack">
      <div className="grid g-3">
        <div className="card tight">
          <div className="row-flex"><Lock size={18} color="#e3f56b" /><b>Read-only by design</b></div>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>Prism never sees bank passwords. Each link is a revocable open-banking or broker API consent with balance and transaction scopes only.</p>
        </div>
        <div className="card tight">
          <div className="row-flex"><ShieldCheck size={18} color="#e3f56b" /><b>Verifiable, not just imported</b></div>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>Snapshots are hashed into an evidence root that goes on-chain with your Proof of Wealth. In production the attestor runs on zkTLS proofs inside a TEE.</p>
        </div>
        <div className="card tight">
          <div className="row-flex"><Bot size={18} color="#e3f56b" /><b>Off-chain is advice, on-chain is action</b></div>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>The agent can only move assets in your smart wallet. For banks and brokers it prepares step-by-step instructions.</p>
        </div>
      </div>

      <div className="grid g-2">
        {s.sources.map((src) => (
          <div className="card" key={src.id} style={{ opacity: src.connected ? 1 : 0.72 }}>
            <div className="card-head">
              <div style={{ display: "flex", gap: 14, alignItems: "center", minWidth: 0 }}>
                <div className="thumb" style={{ width: 54, height: 54, fontSize: 17, background: `linear-gradient(135deg, ${src.accent}, ${src.accent}55 70%, #1c1a1e)` }}>
                  {src.institution.split(" ").map((w) => w[0]).join("").slice(0, 2)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <h3 className="card-title">{src.institution}</h3>
                  <div className="card-sub">{src.connectMethod}</div>
                </div>
              </div>
              <div className="row-flex" style={{ flexWrap: "nowrap" }}>
                {busy === src.id ? (
                  <span className="pill lime"><RefreshCw size={13} className="spin" /> {src.connected ? "Revoking…" : "Requesting consent…"}</span>
                ) : (
                  <StatusPill tone={src.connected ? "good" : "neutral"}>{src.connected ? "Connected" : "Not connected"}</StatusPill>
                )}
                <Toggle on={src.connected} onChange={(v) => void toggle(src.id, v)} label={`${src.connected ? "Disconnect" : "Connect"} ${src.institution}`} />
              </div>
            </div>

            {src.holdings.length > 0 && (
              <table className="t">
                <thead>
                  <tr><th>Holding</th><th>Type</th><th className="r">Access</th><th className="r">Value</th></tr>
                </thead>
                <tbody>
                  {src.holdings.map((h) => (
                    <tr key={h.id}>
                      <td>{h.name}{h.ticker ? <span className="muted"> · {h.ticker}</span> : null}</td>
                      <td className="muted">{CLASS_LABEL[h.assetClass]}{h.apyPct ? ` · ${h.apyPct}%` : ""}</td>
                      <td className="r muted">{h.liquidityDays === 0 ? "Instant" : `${h.liquidityDays}d`}</td>
                      <td className="r">{h.currency === "EUR" ? <span className="muted">€{h.nativeValue.toLocaleString("en-US")} · </span> : null}{usd(h.valueUsd)}</td>
                    </tr>
                  ))}
                  {src.liabilities.map((l) => (
                    <tr key={l.id}>
                      <td>{l.name}</td>
                      <td className="muted">Liability · {l.aprPct}% APR</td>
                      <td className="r muted">{usd(l.monthlyPayment)}/mo</td>
                      <td className="r" style={{ color: "#ffbcbc" }}>−{usd(l.balanceUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {src.policies.length > 0 && (
              <table className="t">
                <thead>
                  <tr><th>Policy</th><th>Type</th><th className="r">Premium</th><th className="r">Coverage</th></tr>
                </thead>
                <tbody>
                  {src.policies.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td className="muted" style={{ textTransform: "capitalize" }}>{p.kind}</td>
                      <td className="r muted">{usd(p.premiumMonthly)}/mo</td>
                      <td className="r">{usd(p.coverageUsd)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>Life insurance</td>
                    <td className="muted">Life</td>
                    <td className="r muted">–</td>
                    <td className="r"><StatusPill tone="warn">Missing</StatusPill></td>
                  </tr>
                </tbody>
              </table>
            )}
            {src.transactions.some((t) => t.untrusted) && (
              <div className="banner" style={{ marginTop: 14, marginBottom: 0, background: "rgba(255,107,107,.10)", borderColor: "rgba(255,107,107,.35)", color: "#ffc7c7" }}>
                <ShieldCheck size={18} /> A transaction memo contains instructions aimed at AI assistants. It is treated as untrusted data and never acted on.
              </div>
            )}
            <div className="between" style={{ marginTop: 14 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                {src.connected ? `Synced ${timeAgo(src.lastSync)}` : "Not included in analysis"}
              </span>
              {src.kind !== "insurance" && <span className="big-num num" style={{ fontSize: 20 }}>{usd(src.total)}</span>}
            </div>
          </div>
        ))}

        <div className="card" style={{ borderColor: "rgba(227,245,107,.25)" }}>
          <div className="card-head">
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <div className="thumb" style={{ width: 54, height: 54, background: "linear-gradient(135deg, #e3f56b, #e3f56b55 70%, #1c1a1e)" }}>
                <Wallet size={24} color="#1d1f0a" />
              </div>
              <div>
                <h3 className="card-title">Prism smart wallet</h3>
                <div className="card-sub mono">{c.wallet.address}</div>
              </div>
            </div>
            <StatusPill tone={c.agentKey.paused ? "warn" : "good"}>{c.agentKey.paused ? "Agent paused" : "Agent active"}</StatusPill>
          </div>
          <table className="t">
            <tbody>
              <tr><td>USDC</td><td className="r">{usd(c.wallet.usdc, 2)}</td></tr>
              <tr><td>ETH</td><td className="r">{eth(c.wallet.weth)} ETH · {usd(c.wallet.wethUsd)}</td></tr>
              <tr><td>Treasury vault ({c.vaultApyPct}% APY)</td><td className="r">{usd(c.wallet.vault, 2)}</td></tr>
              <tr><td>Loan collateral</td><td className="r">{eth(c.loan.collateralEth)} ETH · {usd(c.loan.collateralUsd)}</td></tr>
              <tr><td>Loan debt</td><td className="r" style={{ color: "#ffbcbc" }}>−{usd(c.loan.debt, 2)}</td></tr>
              <tr><td>Health factor</td><td className="r">{hf(c.loan.healthFactor)}</td></tr>
            </tbody>
          </table>
          <div className="divider" />
          <div className="stack-sm" style={{ fontSize: 12.5 }}>
            <div className="between"><span className="muted"><KeyRound size={13} /> Owner key (you)</span><span className="mono">{short(c.agentKey.owner)}</span></div>
            <div className="between"><span className="muted"><Bot size={13} /> Agent session key</span><span className="mono">{short(c.agentKey.address)} · expires in {duration(c.agentKey.expiry - c.chainTime)}</span></div>
            <div className="between"><span className="muted"><Link size={13} /> Lending pool</span><span className="mono">{short(c.addresses.pool)}</span></div>
            <div className="between"><span className="muted"><Unlink size={13} /> Credit registry</span><span className="mono">{short(c.addresses.registry)}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
