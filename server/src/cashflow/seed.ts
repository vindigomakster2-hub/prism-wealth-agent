import type { BudgetRule } from "./state.js";

/** Three months of everyday-account history plus a queue of "new" transactions the bank feed releases. */

export interface RawTxn {
  date: string;
  description: string;
  amount: number;
  currency: string;
  account: string;
  externalId: string;
  bankCategory?: string;
}

const ACCOUNT = "Northwind Bank · Everyday account";

function rng(seed: number) {
  let h = seed >>> 0;
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 2 ** 32;
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function historySeed(now = new Date()): RawTxn[] {
  const r = rng(42);
  const out: RawTxn[] = [];
  let n = 0;
  const push = (d: Date, description: string, amount: number) => {
    if (d > now) return;
    out.push({ date: iso(d), description, amount: Math.round(amount * 100) / 100, currency: "USD", account: ACCOUNT, externalId: `nw-${n++}` });
  };
  for (let back = 2; back >= 0; back--) {
    const y = now.getFullYear();
    const m = now.getMonth() - back;
    const day = (dd: number) => new Date(Date.UTC(y, m, dd, 12));
    push(day(1), "OAK STREET PROPERTIES RENT", -1650);
    push(day(25), "LUMEN SOFTWARE GMBH PAYROLL", 6500);
    push(day(3), "CON ED ELECTRIC", -(80 + r() * 30));
    push(day(5), "VERIZON WIRELESS", -65);
    push(day(7), "NETFLIX.COM", -15.49);
    push(day(7), "SPOTIFY USA", -11.99);
    push(day(9), "OPENAI *CHATGPT SUBSCR", -20);
    push(day(12), "NORTHWIND CARD PAYMENT", -300);
    push(day(15), "AUTO LOAN PMT NORTHWIND", -410);
    for (let i = 0; i < 4; i++) push(day(2 + i * 7), i % 2 ? "TRADER JOE'S #552" : "WHOLE FOODS MKT #102", -(55 + r() * 80));
    const dining = back === 0 ? 7 : 4; // this month runs hot: the agent should notice
    for (let i = 0; i < dining; i++) push(day(3 + i * 4), ["SQ *BLUE BOTTLE COFFEE", "SWEETGREEN 041", "SHAKE SHACK 1124"][i % 3], -(9 + r() * 38));
    for (let i = 0; i < 3; i++) push(day(4 + i * 9), i % 2 ? "SHELL OIL 5744" : "UBER *TRIP", -(15 + r() * 40));
    if (back > 0) push(day(10), "ZELLE TO A. SMIRNOV", -500);
    if (back === 1) push(day(18), "CVS/PHARMACY #0423", -23.1);
    if (back === 2) push(day(20), "H&M 0423 SOHO", -64.9);
  }
  return out;
}

/** Transactions that "arrive" from the bank feed while the demo runs. */
export function feedQueue(now = new Date()): RawTxn[] {
  const today = iso(now);
  const items: Array<[string, number]> = [
    ["ZELLE TO A. SMIRNOV", -500],
    ["TST* OSTERIA ROMA", -72.5],
    ["AMZN Mktp US*2K4L19", -137.9],
    ["WHOLE FOODS MKT #102", -84.2],
    ["UBER *TRIP", -18.4],
    ["VENMO *J.LEE", -40],
    ["KLARNA*ZARA US", -89],
    ["PAYPAL *STEAMGAMES", -29.99],
    ["IRS TREAS 310 TAX REF", 412],
    ["SQ *BLUE BOTTLE COFFEE", -6.5],
    ["CVS/PHARMACY #0423", -18.75],
    ["TST* OSTERIA ROMA", -64],
  ];
  return items.map(([description, amount], i) => ({ date: today, description, amount, currency: "USD", account: ACCOUNT, externalId: `feed-${i}` }));
}

export function defaultBudgets(): BudgetRule[] {
  return [
    { id: "b-groc", category: "groceries", mode: "pct_income", value: 8 },
    { id: "b-dine", category: "dining", mode: "pct_income", value: 3 },
    { id: "b-trans", category: "transport", mode: "fixed", value: 250 },
    { id: "b-subs", category: "subscriptions", mode: "fixed", value: 60 },
    { id: "b-priv", category: "private_debt", mode: "pct_income", value: 3 },
  ];
}
