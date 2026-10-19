import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Camera,
  CircleCheck,
  FileSpreadsheet,
  HandCoins,
  House,
  Inbox,
  Lightbulb,
  MessageCircle,
  Percent,
  RefreshCw,
  ScanLine,
  Smartphone,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { useApp } from "../App";
import { api, type CashState, type CsvPreview, type ReceiptDraft } from "../api";
import { BarRow } from "../components/charts";
import { StatusPill, useToast } from "../components/ui";
import { usd, usdCompact } from "../format";

const STATUS: Record<string, { label: string; tone: "good" | "warn" | "lime" | "neutral" }> = {
  auto: { label: "Rule", tone: "neutral" },
  learned: { label: "Learned", tone: "lime" },
  ai: { label: "Claude", tone: "lime" },
  review: { label: "Needs answer", tone: "warn" },
  confirmed: { label: "You", tone: "good" },
};
const CURRENCIES = ["USD", "EUR", "CZK", "RUB", "KZT", "GBP"];
const native = (n: number, ccy: string) => `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${ccy}`;

async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buf);
  // Russian bank exports are often Windows-1251; fall back when UTF-8 decoding produced junk.
  return utf8.includes("�") ? new TextDecoder("windows-1251").decode(buf) : utf8;
}

function useCash() {
  const [c, setC] = useState<CashState | null>(null);
  const load = useCallback(async () => {
    try {
      setC(await api.cash());
    } catch {
      /* the global banner covers connectivity */
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);
  return [c, load] as const;
}

export function CashFlow() {
  const { s, refresh } = useApp();
  const toast = useToast();
  const [c, reload] = useCash();
  const [filter, setFilter] = useState<"all" | "review" | "csv" | "receipt" | "sync">("all");

  const after = async (p: Promise<unknown>, ok?: string) => {
    try {
      await p;
      if (ok) toast("good", ok);
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : String(e));
    }
    await Promise.all([reload(), refresh()]);
  };

  if (!c) return <div className="empty">Loading cash flow…</div>;
  const m = c.month;
  const label = (cat: string | null) => (cat ? c.categories[cat as keyof typeof c.categories]?.label ?? cat : "Unclear");
  const txns = c.txns.filter((t) => filter === "all" || (filter === "review" ? t.status === "review" : t.source === filter));
  const maxCat = Math.max(1, ...m.byCategory.map((x) => Math.max(x.usd, x.lastMonthUsd)));
  const autoPct = c.counts.total ? Math.round((c.counts.auto / c.counts.total) * 100) : 0;

  return (
    <div className="stack">
      <div className="grid g-4">
        <div className="card tight metric-card" style={{ marginTop: 0 }}>
          <div className="between"><span className="mc-l">Safe to spend</span><span className="badge-outline">{m.safeToSpend.daysLeft} days left</span></div>
          <div className="metric-value num" style={{ fontSize: 34, marginTop: 10, color: m.safeToSpend.amount < 0 ? "#ffbcbc" : undefined }}>{usd(m.safeToSpend.amount)}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            ≈ {usd(Math.max(0, m.safeToSpend.perDay))}/day after bills ({usdCompact(m.safeToSpend.fixedExpected)}) and 10% savings
          </div>
        </div>
        <div className="card tight">
          <div className="muted" style={{ fontSize: 12 }}>Spent this month</div>
          <div className="big-num" style={{ fontSize: 30 }}>{usd(m.totalSpend)}</div>
          <div className="muted" style={{ fontSize: 12 }}>Savings rate {m.savingsRatePct.toFixed(0)}% of {usdCompact(m.incomeBase)} income</div>
        </div>
        <div className="card tight">
          <div className="muted" style={{ fontSize: 12 }}>Categorised automatically</div>
          <div className="big-num" style={{ fontSize: 30 }}>{autoPct}%</div>
          <div className="muted" style={{ fontSize: 12 }}>{c.memory.merchants} merchants and {c.memory.items} receipt items learned</div>
        </div>
        <div className="card tight" style={c.counts.review ? { borderColor: "rgba(245,196,81,.4)" } : undefined}>
          <div className="muted" style={{ fontSize: 12 }}>Waiting for your answer</div>
          <div className="big-num" style={{ fontSize: 30 }}>{c.counts.review}</div>
          <div className="row-flex" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => after(api.cashSync(3), "Synced with the bank")}>
              <RefreshCw size={13} /> Sync now
            </button>
            <button className={`btn sm ${c.feed.autoSync ? "lime" : ""}`} onClick={() => after(api.autosync(!c.feed.autoSync))}>
              Auto-sync {c.feed.autoSync ? "on" : "off"}
            </button>
          </div>
        </div>
      </div>

      <div className="grid g-main">
        <ReviewInbox c={c} onAnswer={(id, cat) => after(api.answer(id, cat).then((r) => toast("good", r.text)))} label={label} />
        <TelegramCard c={c} onAnswer={(id, cat) => after(api.answer(id, cat))} />
      </div>

      <div className="grid g-main">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Where the money went</h3>
              <div className="card-sub">This month in USD; the faint bar is last month. All currencies converted at demo rates.</div>
            </div>
          </div>
          <div className="stack-sm">
            {m.byCategory.map((x) => (
              <div key={x.category}>
                <BarRow label={<span className="ink2">{x.label}</span>} value={x.usd} max={maxCat} color={x.category === "unclear" ? "#f5c451" : "#e3f56b"} display={usd(x.usd)} />
                {x.lastMonthUsd > 0 && (
                  <div className="bar-row" style={{ marginTop: 3 }}>
                    <span />
                    <div className="meter" style={{ height: 3 }}><i style={{ width: `${(x.lastMonthUsd / maxCat) * 100}%`, background: "rgba(239,230,210,.35)" }} /></div>
                    <span className="v muted" style={{ fontSize: 11 }}>{usd(x.lastMonthUsd)}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          {m.byCurrency.length > 0 && (
            <div className="row-flex" style={{ marginTop: 14 }}>
              {m.byCurrency.map((x) => (
                <span key={x.currency} className="pill">{native(x.native, x.currency)} ≈ {usd(x.usd)}</span>
              ))}
            </div>
          )}
        </div>
        <Budgets c={c} save={(rules) => after(api.budgets(rules), "Budgets saved")} />
      </div>

      <div className="grid g-2">
        <CsvImport onDone={() => Promise.all([reload(), refresh()]).then(() => undefined)} />
        <ReceiptScanner llm={c.llm} categories={c.categories} spend={c.spendCategories} onDone={() => Promise.all([reload(), refresh()]).then(() => undefined)} />
      </div>

      <div className="grid g-2">
        <Debts c={c} onChange={after} />
        <div className="stack">
          <Insights c={c} onChange={after} />
          <ManualAssets c={c} onChange={after} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">Transactions</h3>
            <div className="card-sub">Change any category: the agent remembers the merchant from then on</div>
          </div>
          <div className="seg" style={{ minWidth: 380 }}>
            {(["all", "review", "sync", "csv", "receipt"] as const).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "review" ? "Unclear" : f === "sync" ? "Bank feed" : f === "csv" ? "CSV" : "Receipts"}
              </button>
            ))}
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="t">
            <thead>
              <tr><th>Date</th><th>Description</th><th className="r">Amount</th><th>Category</th><th>How</th></tr>
            </thead>
            <tbody>
              {txns.slice(0, 80).map((t) => (
                <tr key={t.id}>
                  <td className="muted">{t.date}</td>
                  <td>
                    <div>{t.description}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{t.account}{t.split ? ` · split into ${t.split.length} categories` : ""}</div>
                  </td>
                  <td className="r">
                    <div style={{ color: t.amount > 0 ? "#a6e8c6" : undefined }}>{native(t.amount, t.currency)}</div>
                    {t.currency !== "USD" && <div className="muted" style={{ fontSize: 11.5 }}>{usd(t.amountUsd, 2)}</div>}
                  </td>
                  <td>
                    <select className="input" style={{ padding: "5px 8px", borderRadius: 9, minWidth: 150 }} value={t.category ?? ""} onChange={(e) => after(api.answer(t.id, e.target.value))} aria-label="Category">
                      {!t.category && <option value="">Unclear…</option>}
                      {Object.entries(c.categories).map(([id, v]) => (
                        <option key={id} value={id}>{v.label}</option>
                      ))}
                    </select>
                  </td>
                  <td title={t.reason}>
                    <StatusPill tone={STATUS[t.status].tone}>{STATUS[t.status].label}</StatusPill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {txns.length === 0 && <div className="empty">Nothing here</div>}
        </div>
        <div className="between" style={{ marginTop: 14 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {c.openBanking.gocardless ? "Real bank connector (GoCardless, PSD2) is configured." : "Bank feed is simulated. Set GOCARDLESS_SECRET_ID/KEY to connect real EU banks through PSD2."}
          </span>
          <button className="btn sm danger" onClick={() => confirm("Delete all off-chain data and revoke every connection?") && after(api.deleteAll(), "All off-chain data deleted")}>
            Delete all my data
          </button>
        </div>
      </div>
    </div>
  );
}

// ======================================================================= review inbox

function ReviewInbox({ c, onAnswer, label }: { c: CashState; onAnswer: (id: string, cat: string) => void; label: (c: string | null) => string }) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title"><Inbox size={18} /> Agent questions</h3>
          <div className="card-sub">Unclear transactions. Answer once per merchant and the agent files them itself from then on.</div>
        </div>
        <span className="pill">{c.review.length} open</span>
      </div>
      <div className="stack-sm">
        {c.review.length === 0 && <div className="empty"><CircleCheck size={16} /> All clear. New unclear transactions will appear here and in Telegram.</div>}
        {c.review.slice(0, 6).map((t) => (
          <div key={t.id} className="analysis-item" style={{ marginBottom: 0 }}>
            <div className="between">
              <b>{t.question?.text ?? t.description}</b>
              <span className="muted num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{native(t.amount, t.currency)}</span>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              {t.reason}
              {t.category ? ` · best guess: ${label(t.category)}` : ""}
              {t.askedVia.includes("telegram") ? " · also asked in Telegram" : ""}
            </p>
            <div className="row-flex" style={{ gap: 6 }}>
              {t.question?.options.map((o) => (
                <button key={o.category + o.label} className="btn sm" onClick={() => onAnswer(t.id, o.category)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ======================================================================= telegram

function TelegramCard({ c, onAnswer }: { c: CashState; onAnswer: (id: string, cat: string) => void }) {
  const t = c.telegram;
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title"><MessageCircle size={18} /> Telegram</h3>
          <div className="card-sub">The agent asks where you already are</div>
        </div>
        <StatusPill tone={t.linked ? "good" : t.configured ? "warn" : "neutral"}>{t.linked ? `Linked${t.username ? ` · @${t.username}` : ""}` : t.configured ? "Waiting for /start" : "Not configured"}</StatusPill>
      </div>
      {!t.configured && (
        <ol className="ink2" style={{ fontSize: 12.5, paddingLeft: 18, margin: "0 0 12px" }}>
          <li>Create a bot with @BotFather and copy its token.</li>
          <li>Restart the server with <span className="kbd">TELEGRAM_BOT_TOKEN</span> set.</li>
          <li>Send <span className="kbd">/start</span> to your bot. That chat becomes the only one that can answer.</li>
        </ol>
      )}
      {t.configured && !t.linked && <p className="ink2" style={{ fontSize: 12.5 }}>Open Telegram and send /start to @{t.username ?? "your bot"} to link this chat.</p>}
      {t.lastError && <p style={{ fontSize: 12, color: "#ffbcbc" }}>Last error: {t.lastError}</p>}
      <div className="phone">
        <div className="phone-head"><Smartphone size={14} /> Prism bot {t.linked ? "" : "· preview"}</div>
        {t.outbox.length === 0 && <div className="muted" style={{ fontSize: 12, padding: 10 }}>No messages yet</div>}
        {t.outbox.slice(0, 3).map((msg) => (
          <div key={msg.at + msg.text} className="tg-msg">
            <div>{msg.text}</div>
            {msg.done ? (
              <div className="tg-done">✅ {msg.done}</div>
            ) : (
              <div className="tg-buttons">
                {msg.buttons.map((b) => {
                  const [, id, cat] = b.data.split("|");
                  return (
                    <button key={b.data} onClick={() => onAnswer(id, cat)}>
                      {b.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{t.sent} sent · {t.answered} answered from Telegram</div>
    </div>
  );
}

// ======================================================================= budgets

function Budgets({ c, save }: { c: CashState; save: (rules: Array<{ id?: string; category: string; mode: "pct_income" | "fixed"; value: number }>) => void }) {
  const [cat, setCat] = useState("private_debt");
  const [mode, setMode] = useState<"pct_income" | "fixed">("pct_income");
  const [value, setValue] = useState(3);
  const rules = c.budgets.map(({ id, category, mode, value }) => ({ id, category, mode, value }));
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title"><Percent size={17} /> Budgets</h3>
          <div className="card-sub">As a share of income or a fixed amount. Income base: {usd(c.month.incomeBase)}</div>
        </div>
      </div>
      <div className="stack-sm">
        {c.budgets.map((b) => (
          <div key={b.id}>
            <div className="between" style={{ fontSize: 13 }}>
              <span>
                {b.label} <span className="muted">· {b.mode === "pct_income" ? `${b.value}% of income` : usd(b.value)}</span>
              </span>
              <span className="row-flex" style={{ gap: 6 }}>
                <span className="num ink2">{usd(b.spent)} / {usd(b.limit)}</span>
                <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => save(rules.filter((r) => r.id !== b.id))} aria-label={`Remove ${b.label} budget`}>
                  <X size={13} />
                </button>
              </span>
            </div>
            <div className="meter" style={{ marginTop: 5 }}>
              <i style={{ width: `${Math.min(100, b.pct)}%`, background: b.state === "over" ? "#ff6b6b" : b.state === "warn" ? "#f5c451" : "#4cc38a" }} />
            </div>
          </div>
        ))}
      </div>
      <div className="divider" />
      <div className="row-flex" style={{ gap: 8 }}>
        <select className="input" style={{ width: "auto", flex: 1 }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Budget category">
          {c.spendCategories.map((id) => <option key={id} value={id}>{c.categories[id].label}</option>)}
        </select>
        <select className="input" style={{ width: "auto" }} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label="Budget type">
          <option value="pct_income">% of income</option>
          <option value="fixed">USD / month</option>
        </select>
        <input className="input" type="number" min={0.5} step={0.5} style={{ width: 90 }} value={value} onChange={(e) => setValue(Number(e.target.value))} aria-label="Budget value" />
        <button className="btn lime sm" onClick={() => save([...rules.filter((r) => r.category !== cat), { category: cat, mode, value }])}>Set</button>
      </div>
    </div>
  );
}

// ======================================================================= CSV import

const SAMPLES = [
  { file: "tbank-statement.csv", label: "T-Bank" },
  { file: "sber-statement.csv", label: "Sber" },
  { file: "fio-statement.csv", label: "Fio (CZ)" },
  { file: "degiro-portfolio.csv", label: "DEGIRO positions" },
];

function CsvImport({ onDone }: { onDone: () => Promise<void> }) {
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [pv, setPv] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const input = useRef<HTMLInputElement>(null);

  const load = async (name: string, content: string, m?: Record<string, number | null>) => {
    setFile({ name, content });
    try {
      const p = await api.importPreview(name, content, m);
      setPv(p);
      if (p.ok) setMapping(p.mapping as unknown as Record<string, number | null>);
    } catch (e) {
      toast("bad", String(e));
    }
  };
  const commit = async () => {
    if (!file) return;
    try {
      const r = await api.importCommit(file.name, file.content, mapping);
      toast("good", r.kind === "positions" ? `Imported ${r.imported} positions as a self-reported broker account` : `Imported ${r.imported}: ${r.auto} filed automatically, ${r.review} need your answer, ${r.duplicates} duplicates skipped`);
      setPv(null);
      setFile(null);
      await onDone();
    } catch (e) {
      toast("bad", String(e));
    }
  };
  const fields = pv?.ok ? (pv.kind === "transactions" ? ["date", "amount", "currency", "description"] : ["name", "symbol", "quantity", "value"]) : [];

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title"><FileSpreadsheet size={18} /> Import a statement</h3>
          <div className="card-sub">Bank CSV (T-Bank, Sber, Fio or any other) or broker positions. Re-importing never duplicates.</div>
        </div>
      </div>
      <div className="row-flex">
        <button className="btn" onClick={() => input.current?.click()}><Upload size={15} /> Choose CSV</button>
        <input ref={input} type="file" accept=".csv,.txt" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) await load(f.name, await readText(f)); e.target.value = ""; }} />
        <span className="muted" style={{ fontSize: 12 }}>or a sample:</span>
        {SAMPLES.map((x) => (
          <button key={x.file} className="btn sm ghost" onClick={async () => load(x.file, await api.sampleCsv(x.file))}>{x.label}</button>
        ))}
      </div>
      {pv && !pv.ok && <p style={{ color: "#ffbcbc", fontSize: 13 }}>{pv.error}</p>}
      {pv?.ok && (
        <>
          <div className="row-flex" style={{ margin: "14px 0 8px" }}>
            <span className="pill lime">{pv.label}</span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {pv.total} {pv.kind === "positions" ? "positions" : "rows"} · {pv.skipped} skipped{pv.kind === "transactions" ? ` · ${pv.duplicates} already imported` : ""}
            </span>
          </div>
          <div className="grid g-4" style={{ gap: 8 }}>
            {fields.map((f) => (
              <label key={f} className="field">
                {f}
                <select
                  className="input"
                  style={{ padding: "6px 8px" }}
                  value={mapping[f] ?? ""}
                  onChange={(e) => {
                    const next = { ...mapping, [f]: e.target.value === "" ? null : Number(e.target.value) };
                    setMapping(next);
                    if (file) void load(file.name, file.content, next);
                  }}
                >
                  <option value="">none</option>
                  {pv.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table className="t">
              <tbody>
                {pv.kind === "transactions"
                  ? (pv.preview as Array<{ date: string; description: string; amount: number; currency: string; guess: { category: string | null; status: string } }>).map((r, i) => (
                      <tr key={i}>
                        <td className="muted">{r.date}</td>
                        <td>{r.description}</td>
                        <td className="r">{native(r.amount, r.currency)}</td>
                        <td>{r.guess.status === "review" ? <StatusPill tone="warn">will ask</StatusPill> : <span className="pill">{r.guess.category}</span>}</td>
                      </tr>
                    ))
                  : (pv.preview as Array<{ name: string; symbol: string; value: number; ccy: string; assetClass: string }>).map((r, i) => (
                      <tr key={i}>
                        <td>{r.name}</td>
                        <td className="muted">{r.symbol}</td>
                        <td className="muted">{r.assetClass}</td>
                        <td className="r">{native(r.value, r.ccy)}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          <div className="row-flex" style={{ marginTop: 12 }}>
            <button className="btn lime" onClick={commit}>Import {pv.total}</button>
            <button className="btn ghost" onClick={() => setPv(null)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

// ======================================================================= receipts

function ReceiptScanner({ llm, categories, spend, onDone }: { llm: boolean; categories: CashState["categories"]; spend: CashState["spendCategories"]; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [draft, setDraft] = useState<ReceiptDraft | null>(null);
  const [cats, setCats] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const open = (d: ReceiptDraft) => {
    setDraft(d);
    setCats(Object.fromEntries(d.items.map((i) => [i.id, i.category ?? ""])));
  };
  const scan = async (body: Parameters<typeof api.scanReceipt>[0]) => {
    setBusy(true);
    try {
      open(await api.scanReceipt(body));
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  const photo = async (f: File) => {
    const b64 = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    await scan({ imageBase64: b64, mediaType: f.type || "image/jpeg" });
  };
  const save = async () => {
    if (!draft) return;
    try {
      const r = await api.confirmReceipt(draft.id, draft.items.map((i) => ({ id: i.id, category: cats[i.id] })));
      toast("good", `Saved. ${r.recognised} items recognised automatically, ${r.taught} taught. The agent now knows ${r.memorySize} items.`);
      setDraft(null);
      await onDone();
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : String(e));
    }
  };
  const known = draft?.items.filter((i) => i.source === "memory").length ?? 0;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title"><ScanLine size={18} /> Scan a receipt</h3>
          <div className="card-sub">Items land in a review step. Teach the unknown ones once; next time they are recognised.</div>
        </div>
      </div>
      <div className="row-flex">
        <button className="btn" disabled={!llm || busy} title={llm ? undefined : "Needs ANTHROPIC_API_KEY for Claude Vision"} onClick={() => input.current?.click()}>
          <Camera size={15} /> Photo
        </button>
        <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) await photo(f); e.target.value = ""; }} />
        <button className="btn sm ghost" disabled={busy} onClick={() => scan({ sample: 1 })}>Sample receipt 1</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => scan({ sample: 2 })}>Sample receipt 2 (a week later)</button>
        {busy && <RefreshCw size={15} className="spin" />}
      </div>
      {!llm && <p className="muted" style={{ fontSize: 12 }}>Photo scanning uses Claude Vision; without an API key, use the samples.</p>}
      {draft && (
        <>
          <div className="row-flex" style={{ margin: "14px 0 8px" }}>
            <b>{draft.merchant}</b>
            <span className="muted" style={{ fontSize: 12.5 }}>{draft.date} · {native(draft.total, draft.currency)}</span>
            {known > 0 && <span className="pill lime"><Sparkles size={12} /> {known} of {draft.items.length} recognised from memory</span>}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="t">
              <tbody>
                {draft.items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <div className="mono" style={{ fontSize: 11.5 }}>{i.raw}</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>{i.name}</div>
                    </td>
                    <td className="r muted">{i.qty} × {i.price}</td>
                    <td>
                      <select className="input" style={{ padding: "5px 8px", borderRadius: 9, borderColor: cats[i.id] ? undefined : "rgba(245,196,81,.6)" }} value={cats[i.id] ?? ""} onChange={(e) => setCats({ ...cats, [i.id]: e.target.value })} aria-label={`Category for ${i.raw}`}>
                        <option value="">Teach me…</option>
                        {spend.map((id) => <option key={id} value={id}>{categories[id].label}</option>)}
                      </select>
                    </td>
                    <td>{i.source === "memory" ? <span className="pill lime">memory</span> : i.source === "ai" ? <span className="pill lime">Claude</span> : i.source === "rule" ? <span className="pill">rule</span> : <span className="pill warn">new</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row-flex" style={{ marginTop: 12 }}>
            <button className="btn lime" disabled={draft.items.some((i) => !cats[i.id])} onClick={save}>Save receipt</button>
            <button className="btn ghost" onClick={() => setDraft(null)}>Discard</button>
          </div>
        </>
      )}
    </div>
  );
}

// ======================================================================= debts, insights, assets

function payoffMonths(balance: number, aprPct: number, monthly: number) {
  if (monthly <= 0) return Infinity;
  const r = aprPct / 1200;
  if (r === 0) return Math.ceil(balance / monthly);
  if (monthly <= balance * r) return Infinity;
  return Math.ceil(-Math.log(1 - (r * balance) / monthly) / Math.log(1 + r));
}

function Debts({ c, onChange }: { c: CashState; onChange: (p: Promise<unknown>, ok?: string) => Promise<void> }) {
  const { s } = useApp();
  const [form, setForm] = useState({ name: "", kind: "mortgage", balance: "", currency: "USD", aprPct: "", monthlyPayment: "", counterparty: "" });
  const t = s.risk.totals;
  const debts = useMemo(() => [...s.risk.liabilities].sort((a, b) => b.aprPct - a.aprPct), [s.risk.liabilities]);
  const manualIds = new Set(c.debts.map((d) => d.id));
  const preset = (p: Partial<typeof form>) => setForm({ ...form, ...p });
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title"><HandCoins size={18} /> Debts and the true balance</h3>
          <div className="card-sub">Loans, mortgages, cards and private IOUs. Paying the highest rate first saves the most.</div>
        </div>
      </div>
      <div className="vs">
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Net worth</div>
          <div className="big-num num" style={{ fontSize: 24 }}>{usd(t.netWorth)}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>everything you own minus everything you owe</div>
        </div>
        <div style={{ borderColor: t.trueBalance < 0 ? "rgba(255,107,107,.5)" : undefined }}>
          <div className="muted" style={{ fontSize: 12 }}>True balance</div>
          <div className="big-num num" style={{ fontSize: 24, color: t.trueBalance < 0 ? "#ff8a8a" : "#e3f56b" }}>{usd(t.trueBalance)}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>money reachable within a week minus all debts</div>
        </div>
      </div>
      <table className="t" style={{ marginTop: 12 }}>
        <thead>
          <tr><th>Debt (highest rate first)</th><th className="r">Balance</th><th className="r">APR</th><th className="r">Paid off in</th><th /></tr>
        </thead>
        <tbody>
          {debts.map((d) => {
            const n = payoffMonths(d.balanceUsd, d.aprPct, d.monthlyPayment);
            return (
              <tr key={d.id}>
                <td>{d.name}<div className="muted" style={{ fontSize: 11.5 }}>{d.sourceName}</div></td>
                <td className="r">{usd(d.balanceUsd)}</td>
                <td className="r">{d.aprPct}%</td>
                <td className="r muted">{n === Infinity ? "never at this payment" : n > 24 ? `${(n / 12).toFixed(1)} yr` : `${n} mo`}</td>
                <td className="r">{manualIds.has(d.id) && <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => onChange(api.deleteDebt(d.id))} aria-label={`Remove ${d.name}`}><X size={13} /></button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="divider" />
      <div className="row-flex" style={{ gap: 6, marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Add:</span>
        <button className="btn sm ghost" onClick={() => preset({ name: "Mortgage", kind: "mortgage", aprPct: "5.9", balance: "280000", monthlyPayment: "1660" })}>Mortgage</button>
        <button className="btn sm ghost" onClick={() => preset({ name: "Consumer loan", kind: "consumer", aprPct: "14.5", balance: "8000", monthlyPayment: "350" })}>Consumer loan</button>
        <button className="btn sm ghost" onClick={() => preset({ name: "IOU", kind: "private", aprPct: "0", balance: "3000", monthlyPayment: "500", counterparty: "A. Smirnov" })}>Private IOU</button>
      </div>
      <div className="grid g-3" style={{ gap: 8 }}>
        <input className="input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="input" placeholder="Balance" type="number" value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} />
        <select className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>{CURRENCIES.map((x) => <option key={x}>{x}</option>)}</select>
        <input className="input" placeholder="APR %" type="number" value={form.aprPct} onChange={(e) => setForm({ ...form, aprPct: e.target.value })} />
        <input className="input" placeholder="Monthly payment" type="number" value={form.monthlyPayment} onChange={(e) => setForm({ ...form, monthlyPayment: e.target.value })} />
        <button className="btn lime" onClick={() => onChange(api.addDebt({ ...form, balance: Number(form.balance), aprPct: Number(form.aprPct), monthlyPayment: Number(form.monthlyPayment) }), "Debt added").then(() => setForm({ ...form, name: "", balance: "", counterparty: "" }))}>
          Add debt
        </button>
      </div>
    </div>
  );
}

function Insights({ c, onChange }: { c: CashState; onChange: (p: Promise<unknown>, ok?: string) => Promise<void> }) {
  const [balance, setBalance] = useState<Record<string, string>>({});
  return (
    <div className="card">
      <h3 className="card-title"><Lightbulb size={18} color="#e3f56b" /> What the agent noticed</h3>
      <div className="stack-sm" style={{ marginTop: 12 }}>
        {c.insights.length === 0 && <div className="empty">Nothing unusual right now</div>}
        {c.insights.map((i) => (
          <div key={i.id} className="analysis-item" style={{ marginBottom: 0 }}>
            <div className="between">
              <b>{i.title}</b>
              {i.kind !== "review" && <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => onChange(api.dismissInsight(i.id))} aria-label="Dismiss"><X size={13} /></button>}
            </div>
            <p>{i.detail}</p>
            {i.action?.kind === "add_private_debt" && (
              <div className="row-flex" style={{ gap: 6 }}>
                <input className="input" type="number" placeholder="Still owed" style={{ width: 130, padding: "6px 10px" }} value={balance[i.id] ?? ""} onChange={(e) => setBalance({ ...balance, [i.id]: e.target.value })} />
                <button
                  className="btn lime sm"
                  disabled={!Number(balance[i.id])}
                  onClick={() => {
                    const a = i.action as { counterparty: string; monthlyPayment: number; currency: string };
                    void onChange(api.addDebt({ kind: "private", counterparty: a.counterparty, balance: Number(balance[i.id]), monthlyPayment: a.monthlyPayment, currency: a.currency, aprPct: 0 }), "Private loan added to your debts");
                  }}
                >
                  Track as a debt
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ManualAssets({ c, onChange }: { c: CashState; onChange: (p: Promise<unknown>, ok?: string) => Promise<void> }) {
  const [form, setForm] = useState({ name: "", kind: "real_estate", value: "", currency: "USD" });
  return (
    <div className="card">
      <h3 className="card-title"><House size={18} /> Assets no API covers</h3>
      <div className="card-sub">Real estate, pensions, vehicles, private wallets. Shown in net worth, never counted toward Proof of Wealth.</div>
      <div className="stack-sm" style={{ marginTop: 12 }}>
        {c.assets.map((a) => (
          <div key={a.id} className="between" style={{ fontSize: 13 }}>
            <span>{a.name} <span className="muted">· {a.kind.replace("_", " ")}</span></span>
            <span className="row-flex" style={{ gap: 6 }}>
              <span className="num">{native(a.value, a.currency)}</span>
              <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => onChange(api.deleteAsset(a.id))} aria-label={`Remove ${a.name}`}><X size={13} /></button>
            </span>
          </div>
        ))}
      </div>
      <div className="grid g-2" style={{ gap: 8, marginTop: 10 }}>
        <input className="input" placeholder="Name, e.g. Flat in Prague" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          <option value="real_estate">Real estate</option>
          <option value="pension">Pension</option>
          <option value="vehicle">Vehicle</option>
          <option value="crypto_wallet">Private crypto wallet</option>
          <option value="private_equity">Private equity</option>
          <option value="other">Other</option>
        </select>
        <input className="input" placeholder="Current value" type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
        <div className="row-flex" style={{ gap: 6, flexWrap: "nowrap" }}>
          <select className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>{CURRENCIES.map((x) => <option key={x}>{x}</option>)}</select>
          <button className="btn lime" onClick={() => onChange(api.addAsset({ ...form, value: Number(form.value) }), "Asset added").then(() => setForm({ ...form, name: "", value: "" }))}>Add</button>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 11.5, marginBottom: 0 }}>
        <Bot size={12} /> Tip: assets and debts you add appear on the wealth map instantly.
      </p>
    </div>
  );
}
