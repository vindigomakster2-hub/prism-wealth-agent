import { useEffect, useState } from "react";
import { Bot, Database, Download, KeyRound, LayoutDashboard, MessageCircle, Pause, Play, RotateCcw, Shield, Trash, UserRound, Wifi } from "lucide-react";
import { useApp } from "../App";
import { api, type CashState } from "../api";
import { StatusPill, Toggle, useToast } from "../components/ui";
import { duration, short, usd } from "../format";

// =================================================================== Account

export function Account() {
  const { s, refresh, go } = useApp();
  const toast = useToast();
  const p = s.persona;
  const [form, setForm] = useState({ name: p.name, email: p.email, occupation: p.occupation, country: p.country, age: String(p.age), dependents: String(p.dependents), monthlyIncome: String(p.monthlyIncome), monthlyExpenses: String(p.monthlyExpenses) });
  useEffect(() => {
    setForm({ name: p.name, email: p.email, occupation: p.occupation, country: p.country, age: String(p.age), dependents: String(p.dependents), monthlyIncome: String(p.monthlyIncome), monthlyExpenses: String(p.monthlyExpenses) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.name, p.email, p.occupation, p.country, p.age, p.dependents, p.monthlyIncome, p.monthlyExpenses]);

  const save = async () => {
    try {
      await api.profile({ ...form, age: Number(form.age), dependents: Number(form.dependents), monthlyIncome: Number(form.monthlyIncome), monthlyExpenses: Number(form.monthlyExpenses) });
      toast("good", "Profile saved. Risk and credit were recalculated.");
      await refresh();
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : String(e));
    }
  };
  const k = s.chain.agentKey;
  const field = (key: keyof typeof form, label: string, type = "text") => (
    <label className="field">
      {label}
      <input className="input" type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  );

  return (
    <div className="grid g-main">
      <div className="card">
        <div className="card-head">
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <div className="avatar" style={{ width: 56, height: 56, fontSize: 18, margin: 0 }}>{p.initials}</div>
            <div>
              <h3 className="card-title">{p.name}</h3>
              <div className="card-sub">Member since {new Date(p.memberSince).toLocaleDateString("en-GB", { month: "long", year: "numeric" })} · base currency {p.baseCurrency}</div>
            </div>
          </div>
          <span className="pill"><UserRound size={13} /> Profile</span>
        </div>
        <div className="grid g-2" style={{ gap: 12 }}>
          {field("name", "Full name")}
          {field("email", "Email", "email")}
          {field("occupation", "Occupation")}
          {field("country", "Country of residence")}
          {field("age", "Age", "number")}
          {field("dependents", "Dependents", "number")}
          {field("monthlyIncome", "Monthly income (USD)", "number")}
          {field("monthlyExpenses", "Monthly expenses (USD)", "number")}
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          Income, expenses and dependents feed the emergency-fund check, the debt-to-income factor of your Abanq score and the life-cover rule of thumb.
          Right now: {s.risk.emergencyMonths.toFixed(1)} months of expenses in cash, score {s.credit.score}.
        </p>
        <div className="row-flex">
          <button className="btn lime" onClick={save}>Save profile</button>
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <h3 className="card-title"><KeyRound size={17} /> Wallet keys</h3>
          <div className="card-sub">Your owner key controls everything; the agent key is scoped by the smart wallet</div>
          <table className="t" style={{ marginTop: 10 }}>
            <tbody>
              <tr><td className="muted">Smart wallet</td><td className="r mono">{short(s.chain.wallet.address)}</td></tr>
              <tr><td className="muted">Owner key (you)</td><td className="r mono">{short(k.owner)}</td></tr>
              <tr><td className="muted">Agent session key</td><td className="r mono">{short(k.address)}</td></tr>
              <tr><td className="muted">Agent key expires in</td><td className="r">{duration(k.expiry - s.chain.chainTime)}</td></tr>
              <tr><td className="muted">Daily limit to saved payees</td><td className="r">{usd(k.dailyLimit)}</td></tr>
            </tbody>
          </table>
          <div className="row-flex" style={{ marginTop: 12 }}>
            <button
              className={`btn sm ${k.paused ? "lime" : "danger"}`}
              onClick={async () => {
                await api.pause(!k.paused).catch((e) => toast("bad", String(e)));
                await refresh();
              }}
            >
              {k.paused ? <><Play size={14} /> Resume agent</> : <><Pause size={14} /> Pause agent key</>}
            </button>
            <button className="btn sm ghost" onClick={() => go("agent")}>Mandate & limits</button>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title"><Database size={17} /> Your data</h3>
          <div className="card-sub">Export everything, or delete all off-chain data and revoke every connection</div>
          <div className="row-flex" style={{ marginTop: 12 }}>
            <a className="btn sm" href="/api/export" download><Download size={14} /> Download full backup (JSON)</a>
            <button
              className="btn sm danger"
              onClick={async () => {
                if (!confirm("Delete all off-chain data and revoke every connection?")) return;
                await api.deleteAll().catch((e) => toast("bad", String(e)));
                toast("good", "All off-chain data deleted. On-chain records are public and stay.");
                await refresh();
              }}
            >
              <Trash size={14} /> Delete all my data
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =================================================================== Settings

export function Settings() {
  const { s, refresh, map, setMap } = useApp();
  const toast = useToast();
  const [cash, setCash] = useState<CashState | null>(null);
  useEffect(() => {
    api.cash().then(setCash).catch(() => undefined);
  }, []);
  const set = async (patch: Parameters<typeof api.settings>[0]) => {
    try {
      await api.settings(patch);
      await refresh();
    } catch (e) {
      toast("bad", String(e));
    }
  };
  const tg = cash?.telegram;

  return (
    <div className="grid g-2">
      <div className="stack">
        <div className="card">
          <h3 className="card-title"><MessageCircle size={17} /> Notifications</h3>
          <div className="card-sub">Telegram messages from the agent (only when a bot is linked)</div>
          <div className="stack-sm" style={{ marginTop: 12 }}>
            <div className="between">
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>Questions about unclear transactions</div>
                <div className="muted" style={{ fontSize: 12 }}>Answer with one tap; the agent remembers the merchant</div>
              </div>
              <Toggle on={s.settings.telegramQuestions} onChange={(v) => set({ telegramQuestions: v })} label="Telegram questions" />
            </div>
            <div className="between">
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>Alerts and insights</div>
                <div className="muted" style={{ fontSize: 12 }}>Budget overruns, detected private loans, subscription totals</div>
              </div>
              <Toggle on={s.settings.telegramAlerts} onChange={(v) => set({ telegramAlerts: v })} label="Telegram alerts" />
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title"><Wifi size={17} /> Bank sync</h3>
          <div className="between" style={{ marginTop: 12 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Automatic sync</div>
              <div className="muted" style={{ fontSize: 12 }}>Pull new transactions in the background</div>
            </div>
            {cash && (
              <Toggle
                on={cash.feed.autoSync}
                onChange={async (v) => {
                  await api.autosync(v);
                  setCash(await api.cash());
                }}
                label="Automatic bank sync"
              />
            )}
          </div>
        </div>

        <div className="card">
          <h3 className="card-title"><LayoutDashboard size={17} /> Wealth map</h3>
          <div className="stack-sm" style={{ marginTop: 12 }}>
            <div className="between">
              <span style={{ fontSize: 13.5 }}>Default view</span>
              <div className="seg" style={{ minWidth: 200 }}>
                <button className={map.view === "graph" ? "on" : ""} onClick={() => setMap({ view: "graph" })}>Graph</button>
                <button className={map.view === "tree" ? "on" : ""} onClick={() => setMap({ view: "tree" })}>Tree</button>
              </div>
            </div>
            <div className="between">
              <span style={{ fontSize: 13.5 }}>Dragged node positions and hidden categories</span>
              <button
                className="btn sm"
                onClick={() => {
                  try {
                    localStorage.removeItem("abanq.map.v1");
                  } catch {
                    /* storage unavailable */
                  }
                  setMap({ resetLayout: map.resetLayout + 1, recenter: map.recenter + 1, zoom: 1 });
                  toast("good", "Map layout reset");
                }}
              >
                <RotateCcw size={14} /> Reset layout
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <h3 className="card-title"><Bot size={17} /> Integrations</h3>
          <div className="card-sub">Configured with environment variables on the server. Setup steps are in the README.</div>
          <table className="t" style={{ marginTop: 10 }}>
            <tbody>
              <tr>
                <td>AI agent (Groq)</td>
                <td className="muted">{s.llm.enabled ? s.llm.model : "offline rules engine"}</td>
                <td className="r"><StatusPill tone={s.llm.enabled ? "good" : "neutral"}>{s.llm.enabled ? "Connected" : "Off"}</StatusPill></td>
              </tr>
              <tr>
                <td>Receipt photos</td>
                <td className="muted">Groq vision model</td>
                <td className="r"><StatusPill tone={s.llm.vision ? "good" : "neutral"}>{s.llm.vision ? "On" : "Off"}</StatusPill></td>
              </tr>
              <tr>
                <td>Telegram bot</td>
                <td className="muted">{tg?.linked ? `@${tg.username ?? "bot"} · ${tg.sent} sent, ${tg.answered} answered` : tg?.configured ? `@${tg.username ?? "bot"}` : "not set up"}</td>
                <td className="r"><StatusPill tone={tg?.linked ? "good" : "neutral"}>{tg?.linked ? "Linked" : "Not linked"}</StatusPill></td>
              </tr>
              <tr>
                <td>Open banking (PSD2)</td>
                <td className="muted">GoCardless Bank Account Data</td>
                <td className="r"><StatusPill tone={cash?.openBanking.gocardless ? "good" : "neutral"}>{cash?.openBanking.gocardless ? "Configured" : "Demo feed"}</StatusPill></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3 className="card-title"><Shield size={17} /> Security</h3>
          <ul className="ink2" style={{ fontSize: 13, paddingLeft: 18, margin: "10px 0 0", display: "flex", flexDirection: "column", gap: 6 }}>
            <li>The API answers only to this app on localhost; other websites and foreign Host headers are refused.</li>
            <li>Bank and broker links are read-only; Abanq never stores credentials.</li>
            <li>The agent key cannot pay unknown addresses, enforced by the smart-wallet contract.</li>
            <li>Every agent action is simulated, policy-checked and logged in the audit trail.</li>
          </ul>
        </div>

        <div className="card">
          <h3 className="card-title"><RotateCcw size={17} /> Demo</h3>
          <div className="card-sub">Redeploy the contracts and restore the starting state</div>
          <button
            className="btn sm"
            style={{ marginTop: 12 }}
            onClick={async () => {
              await api.reset().catch((e) => toast("bad", String(e)));
              toast("good", "Fresh world deployed");
              await refresh();
            }}
          >
            Reset demo world
          </button>
        </div>
      </div>
    </div>
  );
}
