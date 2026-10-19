import { createHash, randomUUID } from "node:crypto";
import { LLM_ENABLED } from "../config.js";
import { extractWithTool } from "../agent/groq.js";
import type { Holding, Source } from "../data/persona.js";
import { logEvent, store } from "../store.js";
import { classify, itemKey, merchantKey, questionFor } from "./classifier.js";
import { currencyIn, detect, parseAmount, parseCsv, parseDate, type Detection, type PositionMapping, type TxnMapping } from "./csv.js";
import { gocardlessConfigured, requisitions } from "./gocardless.js";
import { defaultBudgets, feedQueue, historySeed, type RawTxn } from "./seed.js";
import { askOnTelegram, markAnswered, tg } from "./telegram.js";
import {
  CATS,
  FX_USD,
  cash,
  resetCash,
  toUsd,
  type AssetKind,
  type BudgetRule,
  type CashTxn,
  type DebtKind,
  type Insight,
  type SpendCat,
  type TxnSource,
} from "./state.js";

const newId = () => randomUUID().slice(0, 8);
const hashOf = (r: RawTxn) => createHash("sha1").update(`${r.account}|${r.date}|${r.amount}|${r.currency}|${r.description}`).digest("hex").slice(0, 16);
const SPEND_CATS = (Object.keys(CATS) as SpendCat[]).filter((c) => CATS[c].kind === "spend");
const FIXED: SpendCat[] = ["housing", "utilities", "debt_payment", "subscriptions", "private_debt"];
const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

// ------------------------------------------------------------------ ingestion

export function ingest(raws: RawTxn[], source: TxnSource, importId?: string) {
  const keys = new Set(cash.txns.map((t) => t.dedupeKey));
  const created: CashTxn[] = [];
  let duplicates = 0;
  for (const r of raws) {
    const dedupeKey = r.externalId ? `${r.account}|${r.externalId}` : hashOf(r);
    if (keys.has(dedupeKey)) {
      duplicates++;
      continue;
    }
    keys.add(dedupeKey);
    const v = classify(r.description, r.amount, r.bankCategory);
    const t: CashTxn = {
      id: newId(),
      date: r.date,
      amount: r.amount,
      currency: r.currency.toUpperCase(),
      amountUsd: toUsd(r.amount, r.currency),
      description: r.description,
      key: merchantKey(r.description),
      source,
      account: r.account,
      category: v.category,
      status: v.status,
      confidence: v.confidence,
      reason: v.reason,
      askedVia: [],
      bankCategory: r.bankCategory,
      importId,
      dedupeKey,
    };
    if (t.status === "review") {
      t.question = questionFor(t);
      t.askedVia.push("app");
    }
    created.push(t);
  }
  cash.txns.push(...created);
  cash.txns.sort((a, b) => b.date.localeCompare(a.date));
  const review = created.filter((t) => t.status === "review");
  const ask = (list: CashTxn[]) => list.filter((t) => t.status === "review").forEach((t) => void askOnTelegram(t).then((ok) => ok && t.askedVia.push("telegram")));
  if (LLM_ENABLED && review.length) void triageWithLLM(review).finally(() => ask(review));
  else ask(review);
  return { imported: created.length, duplicates, auto: created.length - review.length, review: review.length, ids: created.map((t) => t.id) };
}

/** The LLM looks at the unclear ones: files what it is sure about, sharpens the question for the rest. */
async function triageWithLLM(txns: CashTxn[]) {
  try {
    const out = await extractWithTool<{ results: Array<{ id: string; category: string; confidence: number; question: string }> }>(
      "You categorise personal bank transactions. Descriptors are often cryptic: 'TST*' is a Toast restaurant terminal, 'SQ *' a Square merchant, 'AMZN Mktp' Amazon Marketplace, 'IRS TREAS 310' a US tax refund. For each transaction give the most likely category, your confidence from 0 to 1, and one short, friendly question for the owner in case you are unsure. Person-to-person transfers are ambiguous by nature: keep confidence below 0.6 for them. Respond only by calling classify_transactions.",
      JSON.stringify(txns.map((t) => ({ id: t.id, description: t.description, amount: t.amount, currency: t.currency, date: t.date }))),
      {
        name: "classify_transactions",
        description: "Return a category guess and a clarifying question for each transaction.",
        parameters: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  category: { type: "string", enum: Object.keys(CATS) },
                  confidence: { type: "number" },
                  question: { type: "string" },
                },
                required: ["id", "category", "confidence", "question"],
              },
            },
          },
          required: ["results"],
        },
      },
    );
    for (const r of out.results ?? []) {
      const t = cash.txns.find((x) => x.id === r.id);
      const cat = r.category as SpendCat;
      if (!t || t.status !== "review" || !(cat in CATS)) continue;
      if (r.confidence >= 0.85 && !["private_debt", "transfers", "gifts"].includes(cat)) {
        Object.assign(t, { category: cat, status: "ai", confidence: r.confidence, reason: `AI: ${CATS[cat].label} (${Math.round(r.confidence * 100)}% sure)`, question: undefined });
        markAnswered(t.id, `AI filed it under ${CATS[cat].label}`);
      } else if (t.question) {
        t.question.text = r.question || t.question.text;
        t.reason = `AI suggests ${CATS[cat].label}, asking you to confirm`;
        if (!t.question.options.some((o) => o.category === cat)) t.question.options.unshift({ category: cat, label: CATS[cat].label });
      }
    }
  } catch (e) {
    console.warn("[triage]", e instanceof Error ? e.message : e);
  }
}

export function answer(txnId: string, category: string): { text: string; applied: number } {
  if (!(category in CATS)) throw new Error(`Unknown category "${category}"`);
  const t = cash.txns.find((x) => x.id === txnId);
  if (!t) throw new Error("Transaction not found");
  const cat = category as SpendCat;
  Object.assign(t, { category: cat, status: "confirmed", confidence: 1, reason: "You confirmed it", question: undefined });
  cash.merchantMemory.set(t.key, cat);
  let applied = 0;
  for (const o of cash.txns) {
    if (o !== t && o.key === t.key && (o.status === "review" || o.status === "ai")) {
      Object.assign(o, { category: cat, status: "learned", confidence: 0.99, reason: "Learned from your answer", question: undefined });
      markAnswered(o.id, `Filed under ${CATS[cat].label}`);
      applied++;
    }
  }
  const text = `${CATS[cat].label}. I'll file "${t.description}" there from now on${applied ? `, and updated ${applied} similar` : ""}.`;
  markAnswered(t.id, text);
  return { text, applied };
}

export function syncNow(n = 3) {
  const q = feedQueue();
  const batch = q.slice(cash.feedCursor, cash.feedCursor + n);
  cash.feedCursor += batch.length;
  cash.lastSync = Date.now();
  return { ...ingest(batch, "sync"), remaining: q.length - cash.feedCursor };
}

export function initCash() {
  resetCash();
  cash.budgets = defaultBudgets();
  ingest(historySeed(), "seed");
}

// ------------------------------------------------------------------ analytics

const monthOf = (d: Date) => d.toISOString().slice(0, 7);

function spendByCat(txns: CashTxn[]) {
  const out = new Map<SpendCat | "unclear", number>();
  for (const t of txns) {
    if (t.amountUsd >= 0) continue;
    if (t.split?.length) {
      for (const s of t.split) out.set(s.category, (out.get(s.category) ?? 0) + s.amountUsd);
      continue;
    }
    const c = t.category;
    if (c && CATS[c].kind !== "spend") continue;
    const k = c ?? "unclear";
    out.set(k, (out.get(k) ?? 0) - t.amountUsd);
  }
  return out;
}

export function monthSummary(now = new Date()) {
  const m = monthOf(now);
  const prev = monthOf(new Date(now.getFullYear(), now.getMonth() - 1, 15));
  const cur = cash.txns.filter((t) => t.date.startsWith(m));
  const last = cash.txns.filter((t) => t.date.startsWith(prev));
  const incomeOf = (xs: CashTxn[]) => xs.filter((t) => t.amountUsd > 0 && t.category && CATS[t.category].kind === "income").reduce((a, t) => a + t.amountUsd, 0);
  const income = incomeOf(cur);
  const lastIncome = incomeOf(last);
  const incomeBase = Math.max(income, lastIncome);
  const spend = spendByCat(cur);
  const lastSpend = spendByCat(last);
  const totalSpend = [...spend.values()].reduce((a, b) => a + b, 0);
  const byCurrency = new Map<string, { native: number; usd: number }>();
  for (const t of cur.filter((x) => x.amount < 0)) {
    const e = byCurrency.get(t.currency) ?? { native: 0, usd: 0 };
    e.native += -t.amount;
    e.usd += -t.amountUsd;
    byCurrency.set(t.currency, e);
  }
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = Math.max(1, daysInMonth - now.getDate() + 1);
  const fixedExpected = FIXED.reduce((a, c) => a + Math.max(spend.get(c) ?? 0, lastSpend.get(c) ?? 0), 0);
  const discretionary = [...spend.entries()].filter(([c]) => !FIXED.includes(c as SpendCat)).reduce((a, [, v]) => a + v, 0);
  const savingsTarget = incomeBase * 0.1;
  const safe = incomeBase - fixedExpected - savingsTarget - discretionary;
  return {
    month: m,
    income,
    incomeBase,
    totalSpend,
    savingsRatePct: incomeBase > 0 ? ((incomeBase - totalSpend) / incomeBase) * 100 : 0,
    byCategory: [...spend.entries()].map(([category, usd]) => ({ category, label: category === "unclear" ? "Waiting for your answer" : CATS[category].label, usd, lastMonthUsd: category === "unclear" ? 0 : lastSpend.get(category) ?? 0 })).sort((a, b) => b.usd - a.usd),
    byCurrency: [...byCurrency.entries()].map(([currency, v]) => ({ currency, ...v })),
    safeToSpend: { amount: safe, perDay: safe / daysLeft, daysLeft, fixedExpected, savingsTarget, discretionary },
  };
}
export type MonthSummary = ReturnType<typeof monthSummary>;

export function budgetStatus(s: MonthSummary) {
  return cash.budgets.map((b) => {
    const limit = b.mode === "pct_income" ? (s.incomeBase * b.value) / 100 : b.value;
    const spent = s.byCategory.find((c) => c.category === b.category)?.usd ?? 0;
    const pct = limit > 0 ? (spent / limit) * 100 : 0;
    return { ...b, label: CATS[b.category].label, limit, spent, pct, state: pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok" };
  });
}

export function insights(s: MonthSummary): Insight[] {
  const out: Insight[] = [];
  const now = Date.now();
  // 1. Regular transfers to the same person → probably a private loan.
  const p2p = new Map<string, CashTxn[]>();
  for (const t of cash.txns) {
    if (t.amount >= 0) continue;
    if (t.category === "private_debt" || (t.status === "review" && /zelle|venmo|перевод|сбп|převod/.test(t.description.toLowerCase()))) {
      p2p.set(t.key, [...(p2p.get(t.key) ?? []), t]);
    }
  }
  for (const [key, list] of p2p) {
    const months = new Set(list.map((t) => t.date.slice(0, 7)));
    const name = list[0].description.replace(/^(zelle|venmo)\s*(to|\*)?\s*/i, "").trim();
    if (months.size >= 2 && !cash.debts.some((d) => d.counterparty && key.includes(merchantKey(d.counterparty)))) {
      const avg = list.reduce((a, t) => a - t.amount, 0) / list.length;
      out.push({
        id: `pl-${key}`,
        kind: "private_loan",
        title: `Regular transfers to ${name} look like a private loan`,
        detail: `${list.length} payments of about ${fmt(avg)} over ${months.size} months. Track it as a debt so net worth and the budget see the real picture.`,
        action: { kind: "add_private_debt", counterparty: name, monthlyPayment: Math.round(avg), currency: list[0].currency },
      });
    }
  }
  // 2. Category running hot vs last month.
  for (const c of s.byCategory) {
    if (c.category === "unclear" || c.lastMonthUsd < 50) continue;
    if (c.usd > c.lastMonthUsd * 1.3 && c.usd - c.lastMonthUsd > 50) {
      out.push({ id: `spike-${c.category}`, kind: "spike", title: `${c.label} is ${Math.round((c.usd / c.lastMonthUsd - 1) * 100)}% above last month`, detail: `${fmt(c.usd)} so far this month vs ${fmt(c.lastMonthUsd)} in all of last month.` });
    }
  }
  // 3. Subscriptions.
  const subs = cash.txns.filter((t) => t.category === "subscriptions" && now - Date.parse(t.date) < 35 * 86400e3);
  if (subs.length >= 3) {
    const names = [...new Set(subs.map((t) => t.description.split(/[*.]/)[0].trim()))];
    out.push({ id: "subs", kind: "subscriptions", title: `${names.length} subscriptions cost ${fmt(subs.reduce((a, t) => a - t.amountUsd, 0))}/month`, detail: `${names.join(", ")}. Which of these are you still using?` });
  }
  // 4. Budgets.
  for (const b of budgetStatus(s).filter((x) => x.state !== "ok")) {
    out.push({ id: `budget-${b.id}`, kind: "budget", title: `${b.label}: ${Math.round(b.pct)}% of budget used`, detail: `${fmt(b.spent)} of ${fmt(b.limit)}${b.mode === "pct_income" ? ` (${b.value}% of income)` : ""}, ${s.safeToSpend.daysLeft} days left in the month.` });
  }
  // 5. Open questions.
  const review = cash.txns.filter((t) => t.status === "review").length;
  if (review) out.push({ id: "review", kind: "review", title: `${review} transaction${review > 1 ? "s" : ""} need${review > 1 ? "" : "s"} your answer`, detail: "Answer once per merchant and the agent remembers it.", action: { kind: "open_review" } });
  return out.filter((i) => !cash.dismissedInsights.has(i.id));
}

// ------------------------------------------------------------------ CSV import

const DEFAULT_CCY: Record<string, string> = { tbank: "RUB", sber: "RUB", fio: "CZK", generic: "USD" };

function rowsToRaws(rows: string[][], m: TxnMapping, profile: string, account: string) {
  const raws: RawTxn[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (m.status !== null && /failed|отказ|declined|zamítnut/i.test(r[m.status] ?? "")) {
      skipped++;
      continue;
    }
    const date = parseDate(r[m.date] ?? "");
    const amount = parseAmount(r[m.amount] ?? "");
    if (!date || amount === null) {
      skipped++;
      continue;
    }
    const currency = ((m.currency !== null ? r[m.currency] : "") || currencyIn(r[m.amount] ?? "") || DEFAULT_CCY[profile] || "USD").toUpperCase().replace("RUR", "RUB").replace("KČ", "CZK");
    const description = (r[m.description] || (m.counterparty !== null ? r[m.counterparty] : "") || "Bank transaction").trim();
    raws.push({
      date,
      amount,
      currency: currency in FX_USD ? currency : "USD",
      description,
      account,
      externalId: m.externalId !== null && r[m.externalId] ? r[m.externalId] : "",
      bankCategory: m.category !== null ? r[m.category] : undefined,
    });
  }
  return { raws, skipped };
}

function positions(rows: string[][], headers: string[], m: PositionMapping) {
  const valueHeader = m.value !== null ? headers[m.value].toLowerCase() : "";
  return rows
    .map((r, i) => {
      const qty = parseAmount(r[m.quantity] ?? "") ?? 0;
      const price = m.price !== null ? parseAmount(r[m.price] ?? "") : null;
      const valueCell = m.value !== null ? r[m.value] ?? "" : "";
      const ccy = (valueHeader.includes("eur") ? "EUR" : (m.currency !== null ? r[m.currency] : "") || currencyIn(valueCell) || currencyIn(m.price !== null ? r[m.price] ?? "" : "") || "EUR").toUpperCase();
      const value = parseAmount(valueCell) ?? qty * (price ?? 0);
      const name = (r[m.name] ?? "").trim();
      const symbol = m.symbol !== null ? (r[m.symbol] ?? "").trim() : "";
      const assetClass: Holding["assetClass"] = /etf|ucits|ishares|vanguard|index|spdr|xtrackers|amundi/i.test(name) ? "etf" : /bond|treasury|govt|dluhopis/i.test(name) ? "bond_fund" : /^cash|hotovost/i.test(name) ? "broker_cash" : "equity";
      const sector = /apple|microsoft|nvidia|alphabet|google|amazon|meta|tesla|asml|amd|broadcom|netflix|nasdaq/i.test(name) ? "tech" : assetClass === "bond_fund" ? "rates" : assetClass === "broker_cash" ? "cash" : "broad_market";
      return { i, name, symbol, qty, value, ccy, assetClass, sector };
    })
    .filter((p) => p.name && p.value > 0);
}

export function previewCsv(filename: string, content: string, override?: Partial<TxnMapping> & Partial<PositionMapping> & { kind?: "transactions" | "positions" }) {
  const p = parseCsv(content);
  let d: Detection | null = detect(p.headers, filename);
  if (override && d) d = { ...d, mapping: { ...d.mapping, ...override } } as Detection;
  if (!d) return { ok: false as const, headers: p.headers, sample: p.rows.slice(0, 5), error: "Couldn't find the date and amount columns. Pick them below." };
  if (d.kind === "transactions") {
    const { raws, skipped } = rowsToRaws(p.rows, d.mapping, d.profile, filename);
    const keys = new Set(cash.txns.map((t) => t.dedupeKey));
    const duplicates = raws.filter((r) => keys.has(r.externalId ? `${r.account}|${r.externalId}` : hashOf(r))).length;
    return {
      ok: true as const,
      kind: d.kind,
      profile: d.profile,
      label: d.label,
      headers: p.headers,
      mapping: d.mapping,
      total: raws.length,
      skipped,
      duplicates,
      preview: raws.slice(0, 6).map((r) => ({ ...r, guess: classify(r.description, r.amount, r.bankCategory) })),
    };
  }
  const pos = positions(p.rows, p.headers, d.mapping);
  return { ok: true as const, kind: d.kind, profile: d.profile, label: d.label, headers: p.headers, mapping: d.mapping, total: pos.length, skipped: p.rows.length - pos.length, duplicates: 0, preview: pos.slice(0, 6) };
}

export function commitCsv(filename: string, content: string, override?: Partial<TxnMapping> & Partial<PositionMapping>) {
  const p = parseCsv(content);
  let d = detect(p.headers, filename);
  if (!d) throw new Error("Couldn't detect the date and amount columns");
  if (override) d = { ...d, mapping: { ...d.mapping, ...override } } as Detection;
  const importId = newId();
  if (d.kind === "transactions") {
    const { raws, skipped } = rowsToRaws(p.rows, d.mapping, d.profile, `${d.label} · ${filename}`);
    const res = ingest(raws, "csv", importId);
    cash.imports.unshift({ id: importId, filename, profile: d.label, rows: p.rows.length, imported: res.imported, duplicates: res.duplicates, at: Date.now() });
    logEvent({ kind: "info", title: `Imported ${res.imported} transactions from ${filename}`, detail: `${d.label}: ${res.auto} categorised automatically, ${res.review} need your answer, ${res.duplicates} duplicates skipped` });
    return { kind: d.kind, ...res, skipped };
  }
  const pos = positions(p.rows, p.headers, d.mapping);
  const id = `import-${importId}`;
  const source: Source = {
    id,
    institution: d.profile === "degiro" ? "DEGIRO (CSV)" : `Broker (${filename})`,
    kind: "broker",
    connectMethod: "Positions CSV import · self-reported",
    connected: true,
    lastSync: Date.now(),
    accent: "#efe6d2",
    selfReported: true,
    holdings: pos.map((x) => ({
      id: `${id}-${x.i}`,
      name: x.name,
      ticker: x.symbol || undefined,
      assetClass: x.assetClass,
      valueUsd: toUsd(x.value, x.ccy),
      nativeValue: x.value,
      currency: x.ccy,
      liquidityDays: 2,
      sector: x.sector as Holding["sector"],
    })),
    liabilities: [],
    policies: [],
    transactions: [],
  };
  store.sources.push(source);
  cash.imports.unshift({ id: importId, filename, profile: d.label, rows: p.rows.length, imported: pos.length, duplicates: 0, at: Date.now() });
  logEvent({ kind: "info", title: `Imported ${pos.length} positions from ${filename}`, detail: `${d.label}. Self-reported, so it is excluded from Proof of Wealth.` });
  return { kind: d.kind, imported: pos.length, duplicates: 0, auto: pos.length, review: 0, skipped: p.rows.length - pos.length, ids: [] as string[] };
}

// ------------------------------------------------------------------ receipts

export function confirmReceipt(receiptId: string, items: Array<{ id: string; category: string }>) {
  const r = cash.receipts.find((x) => x.id === receiptId);
  if (!r) throw new Error("Receipt not found");
  if (r.status === "confirmed") throw new Error("Receipt already saved");
  let taught = 0;
  let recognised = 0;
  for (const it of r.items) {
    const chosen = items.find((x) => x.id === it.id)?.category ?? it.category;
    if (!chosen || !(chosen in CATS)) throw new Error(`Pick a category for "${it.raw}"`);
    if (it.source === "memory" && chosen === it.category) recognised++;
    else taught++;
    it.category = chosen as SpendCat;
    cash.itemMemory.set(itemKey(it.raw), chosen as SpendCat);
  }
  r.status = "confirmed";
  const split = new Map<SpendCat, number>();
  for (const it of r.items) split.set(it.category!, (split.get(it.category!) ?? 0) - toUsd(it.qty * it.price, r.currency));
  const total = r.items.reduce((a, it) => a + it.qty * it.price, 0);
  const t: CashTxn = {
    id: newId(),
    date: r.date,
    amount: -Math.round(total * 100) / 100,
    currency: r.currency,
    amountUsd: toUsd(-total, r.currency),
    description: r.merchant,
    key: merchantKey(r.merchant),
    source: "receipt",
    account: "Receipt scan",
    category: [...split.entries()].sort((a, b) => a[1] - b[1])[0][0],
    status: "confirmed",
    confidence: 1,
    reason: `Receipt with ${r.items.length} items split into ${split.size} categories`,
    askedVia: [],
    split: [...split.entries()].map(([category, amountUsd]) => ({ category, amountUsd })),
    receiptId: r.id,
    dedupeKey: `receipt|${r.id}`,
  };
  cash.txns.unshift(t);
  cash.txns.sort((a, b) => b.date.localeCompare(a.date));
  return { recognised, taught, txnId: t.id, memorySize: cash.itemMemory.size };
}

// ------------------------------------------------------------------ manual entries

const DEBT_KINDS: DebtKind[] = ["mortgage", "consumer", "credit_card", "car", "private", "other"];
const ASSET_KINDS: AssetKind[] = ["real_estate", "pension", "vehicle", "crypto_wallet", "private_equity", "other"];

export function addDebt(b: Record<string, unknown>) {
  const balance = Number(b.balance);
  if (!Number.isFinite(balance) || balance <= 0) throw new Error("Balance must be a positive number");
  const kind = (DEBT_KINDS.includes(b.kind as DebtKind) ? b.kind : "other") as DebtKind;
  const currency = String(b.currency ?? "USD").toUpperCase();
  if (!(currency in FX_USD)) throw new Error(`Unsupported currency ${currency}`);
  const debt = {
    id: newId(),
    name: String(b.name ?? "").trim() || (kind === "private" ? `Private loan${b.counterparty ? ` (${b.counterparty})` : ""}` : kind),
    kind,
    balance,
    currency,
    aprPct: Math.max(0, Number(b.aprPct ?? 0) || 0),
    monthlyPayment: Math.max(0, Number(b.monthlyPayment ?? 0) || 0),
    counterparty: b.counterparty ? String(b.counterparty) : undefined,
    createdAt: Date.now(),
  };
  cash.debts.push(debt);
  logEvent({ kind: "info", title: `Debt added: ${debt.name}`, detail: `${debt.balance.toLocaleString("en-US")} ${currency}` });
  return debt;
}

export function addAsset(b: Record<string, unknown>) {
  const value = Number(b.value);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Value must be a positive number");
  const currency = String(b.currency ?? "USD").toUpperCase();
  if (!(currency in FX_USD)) throw new Error(`Unsupported currency ${currency}`);
  const kind = (ASSET_KINDS.includes(b.kind as AssetKind) ? b.kind : "other") as AssetKind;
  const asset = { id: newId(), name: String(b.name ?? "").trim() || kind.replace("_", " "), kind, value, currency, createdAt: Date.now() };
  cash.assets.push(asset);
  return asset;
}

export function setBudgets(rules: unknown): BudgetRule[] {
  if (!Array.isArray(rules)) throw new Error("rules must be an array");
  cash.budgets = rules.map((r: Record<string, unknown>) => {
    const category = r.category as SpendCat;
    if (!(category in CATS) || CATS[category].kind !== "spend") throw new Error(`Unknown spending category "${String(r.category)}"`);
    const mode = r.mode === "fixed" ? "fixed" : "pct_income";
    const value = Number(r.value);
    if (!Number.isFinite(value) || value <= 0 || (mode === "pct_income" && value > 100)) throw new Error(`Invalid budget value for ${category}`);
    return { id: String(r.id || newId()), category, mode, value };
  });
  return cash.budgets;
}

// ------------------------------------------------------------------ payload

export function cashState() {
  const month = monthSummary();
  return {
    month,
    budgets: budgetStatus(month),
    insights: insights(month),
    txns: cash.txns.slice(0, 150),
    review: cash.txns.filter((t) => t.status === "review"),
    counts: {
      total: cash.txns.length,
      auto: cash.txns.filter((t) => ["auto", "learned", "ai"].includes(t.status)).length,
      review: cash.txns.filter((t) => t.status === "review").length,
    },
    debts: cash.debts,
    assets: cash.assets,
    receipts: cash.receipts.slice(0, 6),
    imports: cash.imports.slice(0, 10),
    memory: { merchants: cash.merchantMemory.size, items: cash.itemMemory.size },
    feed: { remaining: feedQueue().length - cash.feedCursor, autoSync: cash.autoSync, lastSync: cash.lastSync },
    telegram: { configured: tg.configured, linked: Boolean(tg.chatId), username: tg.username, lastError: tg.lastError, sent: tg.sent, answered: tg.answered, outbox: tg.outbox.slice(0, 6) },
    openBanking: { gocardless: gocardlessConfigured(), requisitions },
    categories: CATS,
    spendCategories: SPEND_CATS,
    fx: FX_USD,
    llm: LLM_ENABLED,
  };
}
