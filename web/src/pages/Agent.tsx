import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Pause, Play, RotateCcw, Send, ShieldCheck } from "lucide-react";
import { useApp } from "../App";
import { api, type Mandate } from "../api";
import { EventItem, Markdown, ProposalItem, StatusPill, Toggle, useToast } from "../components/ui";
import { hf, usd } from "../format";

const LEVELS = [
  { n: 0, name: "Observe", text: "Watches and explains. Never acts on its own." },
  { n: 1, name: "Ask first", text: "Simulates every move, then waits for your approval." },
  { n: 2, name: "Bounded", text: "Protective moves and small actions run on their own. Larger ones ask." },
  { n: 3, name: "Full mandate", text: "Anything that passes every check runs immediately." },
] as const;

const SUGGESTIONS = [
  "How risky is my situation?",
  "I need $4,000 for a laptop. Cheapest way?",
  "What happens if markets crash?",
  "Protect my loan",
  "Put my idle cash to work",
  "Show my credit score",
];

const ACTION_LABEL: Record<keyof Mandate["allowed"], string> = {
  deposit_collateral: "Add collateral",
  withdraw_collateral: "Withdraw collateral",
  borrow: "Borrow",
  repay: "Repay",
  vault_deposit: "Vault deposit",
  vault_withdraw: "Vault withdraw",
  buy_cover: "Buy cover",
  claim_cover: "Claim cover",
  swap: "Swap",
  transfer: "Transfer to payees",
  refresh_attestation: "Refresh proof",
  pledge_credit: "Pledge credit",
  release_credit: "Release credit",
};

function NumField({ label, value, onCommit, step = 1, suffix }: { label: string; value: number; onCommit: (v: number) => void; step?: number; suffix?: string }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <label className="field">
      <span>{label}{suffix ? <span className="muted"> ({suffix})</span> : null}</span>
      <input className="input" type="number" step={step} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => Number(v) !== value && onCommit(Number(v))} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

export function Agent() {
  const { s, refresh, approve, reject } = useApp();
  const toast = useToast();
  const m = s.mandate;
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "actions" | "blocked" | "market">("all");
  const logRef = useRef<HTMLDivElement>(null);
  const pending = s.proposals.filter((p) => p.status === "pending_approval");

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [s.chat.length, sending]);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || sending) return;
    setMsg("");
    setSending(t);
    try {
      await api.chat(t);
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : String(e));
    }
    setSending(null);
    await refresh();
  };

  const patch = async (p: Partial<Mandate>) => {
    try {
      await api.mandate(p);
      await refresh();
    } catch (e) {
      toast("bad", String(e));
    }
  };

  const pause = async () => {
    try {
      await api.pause(!s.chain.agentKey.paused);
      toast("good", s.chain.agentKey.paused ? "Agent key resumed" : "Agent key paused on-chain. It can no longer sign anything.");
      await refresh();
    } catch (e) {
      toast("bad", String(e));
    }
  };

  const feed = useMemo(() => {
    const items = [
      ...s.proposals.map((p) => ({ at: p.createdAt, kind: p.status === "blocked" ? "blocked" : "actions", el: <ProposalItem key={p.id} p={p} onApprove={approve} onReject={reject} /> })),
      ...s.events.map((e) => ({ at: e.at, kind: e.kind === "market" ? "market" : "event", el: <EventItem key={e.id} e={e} /> })),
    ].sort((a, b) => b.at - a.at);
    if (filter === "all") return items.filter((i) => i.kind !== "market").slice(0, 40);
    if (filter === "actions") return items.filter((i) => i.kind === "actions" || i.kind === "blocked").slice(0, 40);
    return items.filter((i) => i.kind === filter).slice(0, 40);
  }, [s.proposals, s.events, filter, approve, reject]);

  const byId = new Map(s.proposals.map((p) => [p.id, p]));

  return (
    <div className="stack">
      <div className="grid g-main">
        <div className="card chat">
          <div className="card-head">
            <div>
              <h3 className="card-title"><Bot size={18} /> Prism agent</h3>
              <div className="card-sub">
                {s.llm.enabled ? `Claude (${s.llm.model}) with read tools and one action tool` : "Offline mode: set ANTHROPIC_API_KEY to talk to Claude"}
              </div>
            </div>
            <button className="btn sm ghost" onClick={() => api.chatReset().then(refresh)}>
              <RotateCcw size={14} /> New chat
            </button>
          </div>
          <div className="chat-log" ref={logRef}>
            {s.chat.length === 0 && !sending && (
              <div className="msg assistant">
                <Markdown text={`Hi ${s.persona.name.split(" ")[0]}. I can see all ${s.sources.filter((x) => x.connected).length} connected institutions plus your smart wallet. I act on-chain within your mandate and give step-by-step advice for everything off-chain. What would you like to do?`} />
              </div>
            )}
            {s.chat.map((t) => (
              <div key={t.id} className={`msg ${t.role}`}>
                {t.role === "assistant" ? <Markdown text={t.text} /> : t.text}
                {t.proposalIds.length > 0 && (
                  <div className="row-flex" style={{ marginTop: 8 }}>
                    {t.proposalIds.map((id) => {
                      const p = byId.get(id);
                      if (!p) return null;
                      const tone = p.status === "executed" ? "good" : p.status === "pending_approval" ? "warn" : "bad";
                      return <StatusPill key={id} tone={tone}>{p.title}</StatusPill>;
                    })}
                  </div>
                )}
              </div>
            ))}
            {sending && (
              <>
                <div className="msg user">{sending}</div>
                <div className="msg assistant"><span className="typing"><i /><i /><i /></span></div>
              </>
            )}
          </div>
          <div className="suggest">
            {SUGGESTIONS.map((q) => (
              <button key={q} onClick={() => send(q)} disabled={Boolean(sending)}>{q}</button>
            ))}
          </div>
          <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send(msg); }}>
            <input className="input" placeholder="Ask about your money, or tell the agent what to do…" value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Message the agent" />
            <button className="btn lime" type="submit" disabled={!msg.trim() || Boolean(sending)} aria-label="Send">
              <Send size={16} />
            </button>
          </form>
        </div>

        <div className="stack">
          <div className="card">
            <h3 className="card-title">Autonomy</h3>
            <div className="card-sub">How much the agent may do without asking</div>
            <div className="seg" style={{ marginTop: 14 }} role="radiogroup" aria-label="Autonomy level">
              {LEVELS.map((l) => (
                <button key={l.n} className={m.autonomy === l.n ? "on" : ""} role="radio" aria-checked={m.autonomy === l.n} onClick={() => patch({ autonomy: l.n })}>
                  L{l.n} {l.name}
                </button>
              ))}
            </div>
            <p className="ink2" style={{ fontSize: 13, margin: "12px 0 0" }}>{LEVELS[m.autonomy].text}</p>
          </div>

          <div className="card" style={{ borderColor: "rgba(227,245,107,.25)" }}>
            <div className="card-head">
              <div>
                <h3 className="card-title"><ShieldCheck size={18} color="#e3f56b" /> Blast radius</h3>
                <div className="card-sub">Worst case if the AI were fully compromised, enforced by the wallet contract</div>
              </div>
            </div>
            <div className="grid g-3" style={{ gap: 10 }}>
              <div className="card inset tight">
                <div className="big-num" style={{ fontSize: 26, color: "#e3f56b" }}>$0</div>
                <div className="muted" style={{ fontSize: 12 }}>to unknown addresses</div>
              </div>
              <div className="card inset tight">
                <div className="big-num" style={{ fontSize: 26 }}>{usd(s.blastRadius.payeesPerDayUsd)}</div>
                <div className="muted" style={{ fontSize: 12 }}>per day, saved payees only</div>
              </div>
              <div className="card inset tight">
                <div className="big-num" style={{ fontSize: 26 }}>{hf(s.blastRadius.healthFloor)}</div>
                <div className="muted" style={{ fontSize: 12 }}>loan health floor</div>
              </div>
            </div>
            <div className="between" style={{ marginTop: 14 }}>
              <span className="muted" style={{ fontSize: 12.5 }}>Owner key can freeze the agent in one transaction.</span>
              <button className={`btn sm ${s.chain.agentKey.paused ? "lime" : "danger"}`} onClick={pause}>
                {s.chain.agentKey.paused ? <><Play size={14} /> Resume agent</> : <><Pause size={14} /> Pause agent key</>}
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Approvals</h3>
              <span className="pill">{pending.length} waiting</span>
            </div>
            <div className="timeline">
              {pending.length ? pending.map((p) => <ProposalItem key={p.id} p={p} onApprove={approve} onReject={reject} defaultOpen />) : <div className="empty">Nothing waiting. Simulated actions that exceed your limits appear here.</div>}
            </div>
          </div>
        </div>
      </div>

      <div className="grid g-main">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Audit trail</h3>
              <div className="card-sub">Open any action to see the declared intent, the simulated balance changes and every check</div>
            </div>
            <div className="seg" style={{ minWidth: 300 }}>
              {(["all", "actions", "blocked", "market"] as const).map((f) => (
                <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)} style={{ textTransform: "capitalize" }}>{f}</button>
              ))}
            </div>
          </div>
          <div className="timeline">{feed.length ? feed.map((f) => f.el) : <div className="empty">Nothing here yet</div>}</div>
        </div>

        <div className="stack">
          <div className="card">
            <h3 className="card-title">Mandate</h3>
            <div className="card-sub">Off-chain policy the agent must pass before anything is signed</div>
            <div className="grid g-2" style={{ gap: 12, marginTop: 14 }}>
              <NumField label="Auto-approve up to" suffix="$" value={m.autoApproveLimitUsd} step={100} onCommit={(v) => patch({ autoApproveLimitUsd: v })} />
              <NumField label="Max borrow per action" suffix="$" value={m.maxBorrowPerActionUsd} step={500} onCommit={(v) => patch({ maxBorrowPerActionUsd: v })} />
              <NumField label="Daily transfers" suffix="$" value={m.dailyTransferLimitUsd} step={100} onCommit={(v) => patch({ dailyTransferLimitUsd: v })} />
              <NumField label="Wallet cash reserve" suffix="$" value={m.minWalletReserveUsd} step={100} onCommit={(v) => patch({ minWalletReserveUsd: v })} />
              <NumField label="Health floor for new risk" value={m.minHealthFactor} step={0.05} onCommit={(v) => patch({ minHealthFactor: v })} />
              <NumField label="Rescue below health" value={m.rescueHealthFactor} step={0.05} onCommit={(v) => patch({ rescueHealthFactor: v })} />
              <NumField label="Rescue target health" value={m.targetHealthFactor} step={0.05} onCommit={(v) => patch({ targetHealthFactor: v })} />
              <NumField label="Max slippage" suffix="bps" value={m.maxSlippageBps} step={10} onCommit={(v) => patch({ maxSlippageBps: v })} />
            </div>
            <div className="divider" />
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Proactive alerts</div>
            <div className="grid g-2" style={{ gap: 12 }}>
              <NumField label="Alert when high-risk capital exceeds" suffix="%" value={m.alerts.maxCapitalAtRiskPct} step={5} onCommit={(v) => patch({ alerts: { ...m.alerts, maxCapitalAtRiskPct: v } })} />
              <NumField label="Flag idle wallet cash above" suffix="$" value={m.alerts.idleCashUsd} step={100} onCommit={(v) => patch({ alerts: { ...m.alerts, idleCashUsd: v } })} />
            </div>
          </div>
          <div className="card">
            <h3 className="card-title">Playbooks</h3>
            <div className="card-sub">Pre-approved code paths. They react within one tick, no LLM in the loop.</div>
            <div className="stack-sm" style={{ marginTop: 12 }}>
              {(
                [
                  ["protectLoan", "Protect the loan", "Add idle ETH, repay, or pull from the vault when health drops"],
                  ["keepProofFresh", "Keep proof fresh", "Re-attest before Proof of Wealth expires"],
                  ["claimCover", "Claim cover", "File cover claims automatically after a liquidation"],
                  ["optimizeIdleCash", "Optimize idle cash", "Repay expensive debt or use the vault"],
                ] as const
              ).map(([k, title, text]) => (
                <div key={k} className="between">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{title}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{text}</div>
                  </div>
                  <Toggle on={m.playbooks[k]} onChange={(v) => patch({ playbooks: { ...m.playbooks, [k]: v } })} label={title} />
                </div>
              ))}
            </div>
            <div className="divider" />
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Allowed action types</div>
            <div className="row-flex">
              {(Object.keys(m.allowed) as Array<keyof Mandate["allowed"]>).map((k) => (
                <button key={k} className={`pill ${m.allowed[k] ? "lime" : ""}`} style={{ border: "none", cursor: "pointer" }} aria-pressed={m.allowed[k]} onClick={() => patch({ allowed: { ...m.allowed, [k]: !m.allowed[k] } })}>
                  {ACTION_LABEL[k]}
                </button>
              ))}
            </div>
            <div className="divider" />
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Saved payees</div>
            {s.payees.map((p) => (
              <div key={p.id} className="between" style={{ fontSize: 13 }}>
                <span>{p.name}</span>
                <span className="mono muted">{p.address.slice(0, 8)}…{p.address.slice(-4)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
