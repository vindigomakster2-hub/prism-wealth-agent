import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { BadgeCheck, Bell, Bot, FlaskConical, Landmark, Plus, Receipt, RefreshCw, Search, Settings as SettingsIcon, ShieldAlert, TrendingDown, Umbrella, UserRound, Waypoints, X } from "lucide-react";
import { Account, Settings } from "./pages/Settings";
import { CashFlow } from "./pages/CashFlow";
import { api, type AppState, type Proposal, type StressInput, type StressResult, type TypedAction } from "./api";
import { AgentBadge, proposalToast, ToastProvider, useToast } from "./components/ui";
import { AbanqLogo } from "./components/AbanqArt";
import { SimulationModal } from "./components/SimulationModal";
import type { CatId, SortKey, SourceFilter } from "./lib/graph";
import { MapToolbar, WealthMap } from "./pages/WealthMap";
import { Accounts } from "./pages/Accounts";
import { Risk } from "./pages/Risk";
import { Credit } from "./pages/Credit";
import { Agent } from "./pages/Agent";
import { Protect } from "./pages/Protect";
import { Lab } from "./pages/Lab";

const PAGES = [
  { id: "overview", label: "Wealth map", icon: Waypoints, title: "Wealth map", sub: "", el: WealthMap },
  { id: "cashflow", label: "Cash flow", icon: Receipt, title: "Cash flow", sub: "Bank sync, statements and receipts, categorised by an agent that learns from your answers", el: CashFlow },
  { id: "accounts", label: "Accounts", icon: Landmark, title: "Connected accounts", sub: "Read-only links to banks, brokers, funds and insurers", el: Accounts },
  { id: "risk", label: "Risk radar", icon: ShieldAlert, title: "Risk radar", sub: "Whole-portfolio risk, measured across on-chain and off-chain", el: Risk },
  { id: "credit", label: "Proof of Wealth", icon: BadgeCheck, title: "Proof of Wealth", sub: "Verified off-chain assets as collateral for on-chain credit", el: Credit },
  { id: "agent", label: "Agent", icon: Bot, title: "Agent console", sub: "Talk to the agent, set its mandate, audit every decision", el: Agent },
  { id: "protect", label: "Earn & Protect", icon: Umbrella, title: "Earn & protect", sub: "Yield on idle cash and cover for your positions", el: Protect },
  { id: "lab", label: "Demo lab", icon: FlaskConical, title: "Demo lab", sub: "Stress the system live: market crash, time travel, prompt injection", el: Lab },
  { id: "account", label: "Account", icon: UserRound, title: "Account", sub: "Your profile, wallet keys and data", el: Account, bottom: true },
  { id: "settings", label: "Settings", icon: SettingsIcon, title: "Settings", sub: "Notifications, bank sync, map layout and integrations", el: Settings, bottom: true },
] as const;

export type PageId = (typeof PAGES)[number]["id"];

/** A simulation previewed on the map: the inputs and the server's per-position result. */
export interface Sim {
  input: StressInput;
  result: StressResult;
}

export interface MapUi {
  view: "graph" | "tree";
  zoom: number;
  hidden: CatId[];
  sort: SortKey;
  source: SourceFilter;
  query: string;
  searchSubmit: number;
  recenter: number;
  resetLayout: number;
  balance: "net" | "true";
}

interface Ctx {
  s: AppState;
  refresh: () => Promise<void>;
  go: (p: PageId) => void;
  run: (action: TypedAction, reason?: string) => Promise<Proposal | null>;
  approve: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
  map: MapUi;
  setMap: (patch: Partial<MapUi>) => void;
  sim: Sim | null;
  setSim: (s: Sim | null) => void;
  openSim: () => void;
}
const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

const pageFromHash = (): PageId => {
  const h = window.location.hash.replace("#", "");
  return (PAGES.find((p) => p.id === h)?.id ?? "overview") as PageId;
};

function Shell() {
  const [s, setS] = useState<AppState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [map, setMapState] = useState<MapUi>({ view: "graph", zoom: 1, hidden: [], sort: "value", source: "all", query: "", searchSubmit: 0, recenter: 0, resetLayout: 0, balance: "net" });
  const [sim, setSim] = useState<Sim | null>(null);
  const [simOpen, setSimOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      setS(await api.state());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => {
      clearInterval(t);
      window.removeEventListener("hashchange", onHash);
    };
  }, [refresh]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const go = useCallback((p: PageId) => {
    window.location.hash = p;
    setPage(p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const setMap = useCallback((patch: Partial<MapUi>) => setMapState((m) => ({ ...m, ...patch })), []);

  const run = useCallback(
    async (action: TypedAction, reason?: string) => {
      try {
        const p = await api.act(action, reason);
        proposalToast(toast, p);
        await refresh();
        return p;
      } catch (e) {
        toast("bad", e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [refresh, toast],
  );
  const approve = useCallback(
    async (id: string) => {
      try {
        proposalToast(toast, await api.approve(id));
      } catch (e) {
        toast("bad", e instanceof Error ? e.message : String(e));
      }
      await refresh();
    },
    [refresh, toast],
  );
  const reject = useCallback(
    async (id: string) => {
      await api.reject(id).catch(() => undefined);
      await refresh();
    },
    [refresh],
  );

  if (!s) {
    return (
      <div className="loading-screen">
        <div>
          <AbanqLogo size={48} />
          <h2 style={{ fontFamily: "var(--display)", fontWeight: 400 }}>Starting Abanq…</h2>
          <p className="muted" style={{ maxWidth: 420 }}>
            {err ? <>Waiting for the API: {err}. Run <span className="kbd">npm run dev</span> in the project root.</> : "Connecting to the agent server and local chain."}
          </p>
          <RefreshCw className="spin" size={18} />
        </div>
      </div>
    );
  }

  const meta = PAGES.find((p) => p.id === page)!;
  const Page = meta.el;
  const pending = s.proposals.filter((p) => p.status === "pending_approval");
  const isMap = page === "overview";

  return (
    <AppCtx.Provider value={{ s, refresh, go, run, approve, reject, map, setMap, sim, setSim, openSim: () => setSimOpen(true) }}>
      <div className="app-bg" />
      <div className="shell">
        <nav className="sidebar" aria-label="Main">
          <div className="logo">
            <AbanqLogo />
          </div>
          {PAGES.filter((p) => !("bottom" in p)).map((p) => (
            <button key={p.id} className={`nav-btn ${page === p.id ? "active" : ""}`} onClick={() => go(p.id)} aria-label={p.label} aria-current={page === p.id ? "page" : undefined}>
              <p.icon size={21} strokeWidth={1.7} />
              {((p.id === "agent" && pending.length > 0) || (p.id === "cashflow" && s.cashBrief.review > 0)) && <span className="badge-dot" />}
              <span className="tip">{p.id === "cashflow" && s.cashBrief.review ? `${p.label} · ${s.cashBrief.review} questions` : p.label}</span>
            </button>
          ))}
          <div className="spacer" />
          <div className="side-bottom" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {PAGES.filter((p) => "bottom" in p).map((p) => (
              <button key={p.id} className={`nav-btn ${page === p.id ? "active" : ""}`} onClick={() => go(p.id)} aria-label={p.label} aria-current={page === p.id ? "page" : undefined}>
                <p.icon size={21} strokeWidth={1.7} />
                <span className="tip">{p.label}</span>
              </button>
            ))}
            <button className="nav-btn" onClick={() => go("agent")} aria-label={`${pending.length} approvals waiting`}>
              <Bell size={21} strokeWidth={1.7} />
              {pending.length > 0 && <span className="badge-dot" />}
              <span className="tip">{pending.length ? `${pending.length} waiting for approval` : "No approvals waiting"}</span>
            </button>
          </div>
        </nav>

        <main className="main">
          <header className="appbar">
            <div className="brand">
              <span className="brand-name">Abanq</span>
              <span className="brand-sub">Wealth Agent Platform</span>
            </div>
            <div className="appbar-center">{isMap && <MapToolbar />}</div>
            <div className="appbar-right">
              <button className="btn-outline" onClick={() => setSimOpen(true)}>
                <Plus size={16} /> New simulation
              </button>
              <AgentBadge enabled={s.llm.enabled} model={s.llm.model} />
              {isMap &&
                (searchOpen ? (
                  <form
                    className="search-box"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setMap({ searchSubmit: map.searchSubmit + 1 });
                    }}
                  >
                    <Search size={15} />
                    <input ref={searchRef} value={map.query} onChange={(e) => setMap({ query: e.target.value })} placeholder="Find a position…" aria-label="Find a position" />
                    <button type="button" onClick={() => (setMap({ query: "" }), setSearchOpen(false))} aria-label="Close search">
                      <X size={14} />
                    </button>
                  </form>
                ) : (
                  <button className="icon-btn" onClick={() => setSearchOpen(true)} aria-label="Search positions">
                    <Search size={19} />
                  </button>
                ))}
              <button className="icon-btn" onClick={() => go("agent")} aria-label="Approvals">
                <Bell size={19} strokeWidth={1.8} />
                {pending.length > 0 && <span className="count">{pending.length}</span>}
              </button>
              <button className="avatar" style={{ border: "none", cursor: "pointer" }} title={`${s.persona.name}: account`} onClick={() => go("account")} aria-label="Account">
                {s.persona.initials}
              </button>
            </div>
          </header>

          {s.demo.crashing && (
            <div className="banner">
              <TrendingDown size={18} /> Market sell-off in progress: ETH {`$${Math.round(s.chain.ethPrice).toLocaleString("en-US")}`}. The autopilot is watching loan health.
            </div>
          )}
          {pending.length > 0 && page !== "agent" && !isMap && (
            <div className="banner" style={{ background: "rgba(245,196,81,.10)", borderColor: "rgba(245,196,81,.35)", color: "#f8dc95" }}>
              <Bell size={18} />
              <span style={{ flex: 1 }}>
                {pending.length} agent action{pending.length > 1 ? "s" : ""} simulated and waiting for your approval.
              </span>
              <button className="btn sm" onClick={() => go("agent")}>
                Review
              </button>
            </div>
          )}

          {!isMap && (
            <div className="page-head">
              <h1 className="page-title">{meta.title}</h1>
              <div className="page-sub">{meta.sub}</div>
            </div>
          )}
          <Page />
        </main>
      </div>
      {simOpen && <SimulationModal onClose={() => setSimOpen(false)} />}
    </AppCtx.Provider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
