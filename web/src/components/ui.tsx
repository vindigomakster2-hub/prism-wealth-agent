import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import {
  BadgeCheck,
  Ban,
  Bot,
  ChevronDown,
  CircleCheck,
  Clock,
  Cpu,
  Info,
  OctagonX,
  Siren,
  Sparkles,
  TrendingDown,
  TriangleAlert,
  User,
  Zap,
} from "lucide-react";
import type { ActivityEvent, Proposal } from "../api";
import { hf, short, timeAgo, usd } from "../format";

// ------------------------------------------------------------------ toasts
type Toast = { id: number; tone: "good" | "bad" | "info"; text: ReactNode };
const ToastCtx = createContext<(tone: Toast["tone"], text: ReactNode) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], text: ReactNode) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.tone === "good" ? <CircleCheck size={20} color="#4cc38a" /> : t.tone === "bad" ? <OctagonX size={20} color="#ff6b6b" /> : <Info size={20} color="#e3f56b" />}
            <div>{t.text}</div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Toast describing a pipeline outcome. */
export function proposalToast(push: ReturnType<typeof useToast>, p: Proposal) {
  if (p.status === "executed") push("good", <><b>{p.title}</b><div className="muted">Executed on-chain · {short(p.txHash)}</div></>);
  else if (p.status === "pending_approval") push("info", <><b>{p.title}</b><div className="muted">Simulated and checked. Waiting for your approval.</div></>);
  else push("bad", <><b>{p.title}</b><div className="muted">{p.checks.find((c) => !c.pass)?.detail ?? p.error ?? p.status}</div></>);
}

// ------------------------------------------------------------------ bits
export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" className={`toggle ${on ? "on" : ""}`} aria-pressed={on} aria-label={label} onClick={() => onChange(!on)} />;
}

export function StatusPill({ tone, children }: { tone: "good" | "warn" | "bad" | "lime" | "orange" | "neutral"; children: ReactNode }) {
  const icon = tone === "good" ? <CircleCheck size={13} /> : tone === "warn" ? <TriangleAlert size={13} /> : tone === "bad" ? <OctagonX size={13} /> : null;
  return (
    <span className={`pill ${tone === "neutral" ? "" : tone}`}>
      {icon}
      {children}
    </span>
  );
}

/** Tiny markdown subset: paragraphs, "- " bullets, **bold**, _italic_ / *italic*, `code`. No raw HTML. */
export function Markdown({ text }: { text: string }) {
  const inline = (s: string, key: number) => {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_|\*[^*]+\*)/g).filter(Boolean);
    return (
      <span key={key}>
        {parts.map((p, i) => {
          if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
          if (p.startsWith("`") && p.endsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
          if ((p.startsWith("_") && p.endsWith("_")) || (p.startsWith("*") && p.endsWith("*") && p.length > 2)) return <em key={i}>{p.slice(1, -1)}</em>;
          return p;
        })}
      </span>
    );
  };
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`l${blocks.length}`}>{list.map((li, i) => <li key={i}>{inline(li, i)}</li>)}</ul>);
    list = [];
  };
  text.split("\n").forEach((line) => {
    const m = line.match(/^\s*[-•*]\s+(.*)$/);
    if (m) list.push(m[1]);
    else {
      flush();
      if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{inline(line.replace(/^#+\s*/, ""), 0)}</p>);
    }
  });
  flush();
  return <>{blocks}</>;
}

// ------------------------------------------------------------------ activity
const ORIGIN: Record<Proposal["origin"], { label: string; icon: ReactNode }> = {
  user: { label: "You", icon: <User size={12} /> },
  chat: { label: "Agent chat", icon: <Sparkles size={12} /> },
  autopilot: { label: "Autopilot", icon: <Zap size={12} /> },
  attack: { label: "Compromised agent", icon: <Siren size={12} /> },
};

function statusIcon(p: Proposal) {
  switch (p.status) {
    case "executed":
      return <CircleCheck size={22} color="#4cc38a" />;
    case "pending_approval":
      return <Clock size={22} color="#f5c451" />;
    case "blocked":
      return <OctagonX size={22} color="#ff6b6b" />;
    case "rejected":
      return <Ban size={22} color="#a9a2a7" />;
    default:
      return <TriangleAlert size={22} color="#f5c451" />;
  }
}

function statusPill(p: Proposal) {
  switch (p.status) {
    case "executed":
      return <StatusPill tone="good">Executed</StatusPill>;
    case "pending_approval":
      return <StatusPill tone="warn">Needs approval</StatusPill>;
    case "blocked":
      return <StatusPill tone="bad">Blocked{p.blockedBy === "chain" ? " on-chain" : p.blockedBy === "policy" ? " by policy" : " in simulation"}</StatusPill>;
    case "rejected":
      return <StatusPill tone="neutral">Rejected</StatusPill>;
    default:
      return <StatusPill tone="warn">{p.status}</StatusPill>;
  }
}

const LAYER_LABEL = { policy: "Policy", simulation: "Simulation", chain: "On-chain" } as const;

export function ProposalItem({
  p,
  onApprove,
  onReject,
  defaultOpen = false,
}: {
  p: Proposal;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const o = ORIGIN[p.origin];
  const diffs = p.simulation?.diffs.filter((d) => Math.abs(d.change) > (d.ledger === "WETH" || d.ledger === "COLLATERAL" ? 1e-6 : 0.009)) ?? [];
  return (
    <div className="tl-item" style={p.origin === "attack" ? { borderColor: "rgba(255,107,107,.35)" } : undefined}>
      <div className="tl-head" onClick={() => setOpen(!open)} role="button" tabIndex={0} aria-expanded={open} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}>
        {statusIcon(p)}
        <div style={{ minWidth: 0 }}>
          <div className="t">{p.title}</div>
          <div className="s" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              {o.icon} {o.label}
            </span>
            <span>·</span>
            <span>{timeAgo(p.createdAt)}</span>
            {p.notionalUsd > 0 && (
              <>
                <span>·</span>
                <span className="num">{usd(p.notionalUsd)}</span>
              </>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {statusPill(p)}
          <ChevronDown size={16} style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .15s", color: "#a9a2a7" }} />
        </div>
      </div>
      {open && (
        <div className="tl-body">
          {p.reason && <div className="ink2" style={{ fontSize: 13 }}><b style={{ color: "#f6f3ee" }}>Why: </b>{p.reason}</div>}
          {p.intent.summary && <div style={{ fontSize: 12.5 }} className="muted">Declared intent: {p.intent.summary}</div>}
          <div className="checks">
            {p.checks.map((c, i) => (
              <div className="check" key={i}>
                {c.pass ? <CircleCheck size={15} color="#4cc38a" /> : <OctagonX size={15} color="#ff6b6b" />}
                <span className="layer">{LAYER_LABEL[c.layer]}</span>
                <span>
                  <span className="lbl">{c.label}</span> <span className="det">· {c.detail}</span>
                </span>
              </div>
            ))}
          </div>
          {diffs.length > 0 && (
            <div className="diff">
              {diffs.map((d) => (
                <div key={d.ledger}>
                  <b>{d.ledger}</b>
                  <span className="num" style={{ color: d.change >= 0 ? "#a6e8c6" : "#ffbcbc" }}>
                    {d.change >= 0 ? "+" : "−"}
                    {d.ledger === "WETH" || d.ledger === "COLLATERAL" ? Math.abs(d.change).toFixed(4) : d.ledger === "COVER" ? Math.abs(d.change) : usd(Math.abs(d.change), 2)}
                  </span>
                </div>
              ))}
              {p.simulation && (
                <div>
                  <b>HEALTH</b>
                  <span className="num">
                    {hf(p.simulation.hfBefore)} → {hf(p.simulation.hfAfter)}
                  </span>
                </div>
              )}
            </div>
          )}
          {p.txHash && <div className="mono muted">tx {p.txHash}</div>}
          {p.status === "pending_approval" && onApprove && onReject && (
            <div className="row-flex">
              <button className="btn lime sm" onClick={() => onApprove(p.id)}>
                <CircleCheck size={15} /> Approve and execute
              </button>
              <button className="btn sm" onClick={() => onReject(p.id)}>
                Reject
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const EV_ICON: Record<ActivityEvent["kind"], ReactNode> = {
  market: <TrendingDown size={16} color="#ffc29f" />,
  liquidation: <Siren size={16} color="#ffb0b0" />,
  attestation: <BadgeCheck size={16} color="#e3f56b" />,
  warning: <TriangleAlert size={16} color="#f8dc95" />,
  system: <Cpu size={16} color="#d2ccce" />,
  info: <Info size={16} color="#d2ccce" />,
};

export function EventItem({ e }: { e: ActivityEvent }) {
  return (
    <div className="tl-item">
      <div className="tl-head" style={{ cursor: "default" }}>
        <div className="ev-ico">{EV_ICON[e.kind]}</div>
        <div style={{ minWidth: 0 }}>
          <div className="t" style={{ fontWeight: 500 }}>{e.title}</div>
          <div className="s">
            {e.detail ? `${e.detail} · ` : ""}
            {timeAgo(e.at)}
          </div>
        </div>
        {e.txHash ? <span className="mono muted">{short(e.txHash)}</span> : <span />}
      </div>
    </div>
  );
}

export function AgentBadge({ enabled, model }: { enabled: boolean; model: string }) {
  return (
    <span className="engine-chip" title={enabled ? `Chat runs on ${model}` : "No API key: chat uses the offline rules engine"}>
      <Bot size={14} /> {enabled ? model : "Offline agent"}
    </span>
  );
}
