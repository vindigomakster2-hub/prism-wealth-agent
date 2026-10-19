/**
 * Cash-flow state: transactions from bank sync / CSV import / receipts, the classifier's learned
 * memory, budgets, manually tracked debts and the Telegram link. In-memory for the demo.
 */

export type SpendCat =
  | "salary"
  | "other_income"
  | "groceries"
  | "dining"
  | "transport"
  | "housing"
  | "utilities"
  | "health"
  | "personal_care"
  | "clothing"
  | "household"
  | "marketplace"
  | "subscriptions"
  | "education"
  | "entertainment"
  | "travel"
  | "debt_payment"
  | "private_debt"
  | "gifts"
  | "transfers"
  | "other";

export const CATS: Record<SpendCat, { label: string; kind: "income" | "spend" | "transfer" }> = {
  salary: { label: "Salary", kind: "income" },
  other_income: { label: "Other income", kind: "income" },
  groceries: { label: "Groceries", kind: "spend" },
  dining: { label: "Cafés & restaurants", kind: "spend" },
  transport: { label: "Transport & fuel", kind: "spend" },
  housing: { label: "Rent & housing", kind: "spend" },
  utilities: { label: "Utilities & phone", kind: "spend" },
  health: { label: "Health & pharmacy", kind: "spend" },
  personal_care: { label: "Personal care", kind: "spend" },
  clothing: { label: "Clothing", kind: "spend" },
  household: { label: "Household goods", kind: "spend" },
  marketplace: { label: "Marketplace orders", kind: "spend" },
  subscriptions: { label: "Subscriptions", kind: "spend" },
  education: { label: "Education", kind: "spend" },
  entertainment: { label: "Entertainment", kind: "spend" },
  travel: { label: "Travel", kind: "spend" },
  debt_payment: { label: "Loan & card payments", kind: "spend" },
  private_debt: { label: "Repaying private loans", kind: "spend" },
  gifts: { label: "Gifts", kind: "spend" },
  transfers: { label: "Between own accounts", kind: "transfer" },
  other: { label: "Other", kind: "spend" },
};

/** Demo FX table (units of USD per 1 unit). Real deployments pull a daily rate feed. */
export const FX_USD: Record<string, number> = { USD: 1, EUR: 1.09, CZK: 0.044, RUB: 0.0105, KZT: 0.002, GBP: 1.27 };
export const toUsd = (amount: number, ccy: string) => amount * (FX_USD[ccy.toUpperCase()] ?? 1);

export type TxnStatus = "auto" | "learned" | "ai" | "review" | "confirmed";
export type TxnSource = "sync" | "csv" | "receipt" | "seed";

export interface QuestionOption {
  label: string;
  category: SpendCat;
}

export interface CashTxn {
  id: string;
  date: string;
  amount: number;
  currency: string;
  amountUsd: number;
  description: string;
  key: string;
  source: TxnSource;
  account: string;
  category: SpendCat | null;
  status: TxnStatus;
  confidence: number;
  reason: string;
  question?: { text: string; options: QuestionOption[] };
  askedVia: Array<"app" | "telegram">;
  split?: Array<{ category: SpendCat; amountUsd: number }>;
  receiptId?: string;
  bankCategory?: string;
  importId?: string;
  /** External transaction id (or a stable hash) so re-syncs and re-imports are idempotent. */
  dedupeKey: string;
}

export interface ReceiptItem {
  id: string;
  raw: string;
  name: string;
  qty: number;
  price: number;
  category: SpendCat | null;
  source: "memory" | "rule" | "ai" | null;
}

export interface ReceiptDraft {
  id: string;
  merchant: string;
  date: string;
  currency: string;
  total: number;
  items: ReceiptItem[];
  status: "draft" | "confirmed";
  via: "claude" | "sample";
  createdAt: number;
}

export interface BudgetRule {
  id: string;
  category: SpendCat;
  mode: "pct_income" | "fixed";
  value: number;
}

export type DebtKind = "mortgage" | "consumer" | "credit_card" | "car" | "private" | "other";

export interface ManualDebt {
  id: string;
  name: string;
  kind: DebtKind;
  balance: number;
  currency: string;
  aprPct: number;
  monthlyPayment: number;
  counterparty?: string;
  createdAt: number;
}

export type AssetKind = "real_estate" | "pension" | "vehicle" | "crypto_wallet" | "private_equity" | "other";

/** Things no API covers (per the data-access research): entered by hand, valued by the user. */
export interface ManualAsset {
  id: string;
  name: string;
  kind: AssetKind;
  value: number;
  currency: string;
  createdAt: number;
}

export interface Insight {
  id: string;
  kind: "private_loan" | "spike" | "subscriptions" | "budget" | "review";
  title: string;
  detail: string;
  action?: { kind: "add_private_debt"; counterparty: string; monthlyPayment: number; currency: string } | { kind: "open_review" };
  dismissed?: boolean;
}

export const cash = {
  txns: [] as CashTxn[],
  merchantMemory: new Map<string, SpendCat>(),
  itemMemory: new Map<string, SpendCat>(),
  receipts: [] as ReceiptDraft[],
  budgets: [] as BudgetRule[],
  debts: [] as ManualDebt[],
  assets: [] as ManualAsset[],
  dismissedInsights: new Set<string>(),
  feedCursor: 0,
  autoSync: true,
  lastSync: 0,
  imports: [] as Array<{ id: string; filename: string; profile: string; rows: number; imported: number; duplicates: number; at: number }>,
};

export function resetCash() {
  cash.txns = [];
  cash.merchantMemory = new Map();
  cash.itemMemory = new Map();
  cash.receipts = [];
  cash.budgets = [];
  cash.debts = [];
  cash.assets = [];
  cash.dismissedInsights = new Set();
  cash.feedCursor = 0;
  cash.autoSync = true;
  cash.lastSync = 0;
  cash.imports = [];
}
