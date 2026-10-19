import { useState } from "react";
import { Clock, FlaskConical, RotateCcw, ShieldX, Siren, TrendingDown, TrendingUp } from "lucide-react";
import { useApp } from "../App";
import { api } from "../api";
import { EventItem, ProposalItem, StatusPill, useToast } from "../components/ui";
import { duration, eth, hf, healthTone, usd } from "../format";

const SCRIPT = [
  "Overview: one net worth across banks, broker, venture, insurance and the wallet.",
  "Risk radar: 48% riding the tech cycle, a deposit over the guarantee, no life cover, an unprotected loan.",
  "Proof of Wealth: publish the proof. 9% becomes 6% APR, and $8.5k extra borrowing power, without selling anything.",
  "Borrow $6,000 on the Credit page, then buy liquidation cover.",
  "Demo lab: run the sell-off. The twin is liquidated; the agent adds collateral within one tick.",
  "Prompt injection: the bank memo attack is blocked by policy, then on-chain even with policy bypassed.",
  "Time jump +31 days: the proof expires, and the agent re-attests before spending any cash.",
];

export function Lab() {
  const { s, refresh, approve, reject } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const c = s.chain;
  const twin = c.twin.loan;

  const go = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast("info", done);
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
    await refresh();
  };

  const attacks = s.proposals.filter((p) => p.origin === "attack").slice(0, 3);
  const market = s.events.filter((e) => e.kind === "market" || e.kind === "liquidation").slice(0, 6);
  const t1 = healthTone(c.loan.healthFactor);

  return (
    <div className="stack">
      <div className="grid g-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title"><Siren size={18} /> Agent vs passive twin</h3>
              <div className="card-sub">Same starting position: 5 ETH collateral, $9,000 debt. Only one has an agent.</div>
            </div>
            <span className="pill dark num">ETH {usd(c.ethPrice)}</span>
          </div>
          <div className="vs">
            <div style={{ borderColor: "rgba(227,245,107,.35)" }}>
              <div className="between"><b>You, with Prism</b><StatusPill tone={t1}>{t1 === "good" ? "Safe" : t1 === "warn" ? "Watch" : "At risk"}</StatusPill></div>
              <div className="big-num" style={{ fontSize: 44, color: "#e3f56b", marginTop: 8 }}>{hf(c.loan.healthFactor)}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {eth(c.loan.collateralEth)} ETH · {usd(c.loan.debt)} debt · credit line {usd(c.loan.creditLine)}
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>Liquidations: {c.loan.liquidationCount}</div>
            </div>
            <div style={{ borderColor: twin.liquidationCount ? "rgba(255,107,107,.45)" : undefined }}>
              <div className="between"><b>Passive twin</b>{twin.liquidationCount ? <StatusPill tone="bad">Liquidated</StatusPill> : <StatusPill tone={healthTone(twin.healthFactor)}>No agent</StatusPill>}</div>
              <div className="big-num" style={{ fontSize: 44, marginTop: 8, color: (twin.healthFactor ?? 9) < 1.1 ? "#ff6b6b" : "#efe6d2" }}>{hf(twin.healthFactor)}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{eth(twin.collateralEth)} ETH · {usd(twin.debt)} debt</div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                Liquidations: {twin.liquidationCount}
                {twin.liquidationPenalty > 0 ? ` · lost ${usd(twin.liquidationPenalty)} in penalties` : ""}
              </div>
            </div>
          </div>
          <div className="row-flex" style={{ marginTop: 16 }}>
            <button className="btn danger" disabled={Boolean(busy) || s.demo.crashing} onClick={() => go("crash", () => api.crash(35), "Sell-off started: ETH −35% in 5 steps")}>
              <TrendingDown size={16} /> {s.demo.crashing ? "Sell-off running…" : "Run ETH sell-off (−35%)"}
            </button>
            <button className="btn" disabled={Boolean(busy) || s.demo.crashing} onClick={() => go("recover", () => api.recover(), "ETH restored to $3,400")}>
              <TrendingUp size={16} /> Restore price
            </button>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title"><FlaskConical size={18} /> Scenarios</h3>
          <div className="card-sub">Each one hits the real contracts on the local chain</div>
          <div className="stack-sm" style={{ marginTop: 14 }}>
            <div className="finding">
              <div className="ico high"><ShieldX size={17} /></div>
              <div>
                <h4>Prompt injection via bank memo</h4>
                <p>A memo tells "AI assistants" to send all USDC to an attacker. We simulate an agent that obeys, then also bypass the off-chain policy engine.</p>
              </div>
              <button className="btn danger sm" disabled={Boolean(busy)} onClick={() => go("inject", () => api.inject(), "Attack attempts finished. See the results below.")}>Launch attack</button>
            </div>
            <div className="finding">
              <div className="ico medium"><Clock size={17} /></div>
              <div>
                <h4>Jump forward 31 days</h4>
                <p>Interest accrues and Proof of Wealth expires ({c.attestation.exists ? duration(c.attestation.expiresAt - c.chainTime) + " left" : "not published"}). Watch the agent re-attest before it spends anything.</p>
              </div>
              <button className="btn sm" disabled={Boolean(busy)} onClick={() => go("warp", () => api.warp(31), "Moved forward 31 days")}>+31 days</button>
            </div>
            <div className="finding">
              <div className="ico low"><RotateCcw size={17} /></div>
              <div>
                <h4>Reset the world</h4>
                <p>Redeploys every contract and restores the starting balances.</p>
              </div>
              <button className="btn sm" disabled={Boolean(busy)} onClick={() => go("reset", () => api.reset(), "Fresh world deployed")}>Reset</button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid g-main">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Attack results</h3>
              <div className="card-sub">Defence in depth: policy, then simulation, then the on-chain guard</div>
            </div>
          </div>
          <div className="timeline">
            {attacks.length ? attacks.map((p) => <ProposalItem key={p.id} p={p} defaultOpen onApprove={approve} onReject={reject} />) : <div className="empty">Launch the attack to see each layer respond</div>}
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <h3 className="card-title">Market tape</h3>
            <div className="timeline" style={{ marginTop: 12 }}>
              {market.length ? market.map((e) => <EventItem key={e.id} e={e} />) : <div className="empty">Quiet market</div>}
            </div>
          </div>
          <div className="card">
            <h3 className="card-title">Pitch script</h3>
            <ol className="ink2" style={{ paddingLeft: 18, margin: "10px 0 0", fontSize: 13, display: "flex", flexDirection: "column", gap: 8 }}>
              {SCRIPT.map((line) => <li key={line}>{line}</li>)}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
