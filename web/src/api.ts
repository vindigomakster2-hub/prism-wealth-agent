import type { ActivityEvent, Mandate, Payee, Proposal, TypedAction } from "../../server/src/agent/types";
import type { Source } from "../../server/src/data/persona";
import type { OnchainState } from "../../server/src/chain";
import type { RiskReport, StressInput, StressParam, stressTargets, stressTest } from "../../server/src/engine/risk";
import type { CreditProfile } from "../../server/src/engine/credit";
import type { ChatTurn, Scenario, Settings } from "../../server/src/store";

import type { cashState, previewCsv } from "../../server/src/cashflow/engine";
import type { CashTxn, ReceiptDraft, SpendCat } from "../../server/src/cashflow/state";

export type { ActivityEvent, ChatTurn, CreditProfile, Mandate, OnchainState, Payee, Proposal, RiskReport, Source, StressInput, TypedAction };
export type { CashTxn, ReceiptDraft, SpendCat };
export type CashState = ReturnType<typeof cashState>;
export type CsvPreview = ReturnType<typeof previewCsv>;
export type StressResult = ReturnType<typeof stressTest>;
export type StressTargets = ReturnType<typeof stressTargets>;
export type { Scenario, Settings, StressParam };

export interface AppState {
  persona: {
    name: string;
    initials: string;
    age: number;
    occupation: string;
    dependents: number;
    monthlyIncome: number;
    monthlyExpenses: number;
    walletAgeYears: number;
    email: string;
    country: string;
    memberSince: string;
    baseCurrency: string;
  };
  llm: { enabled: boolean; model: string; provider: string; vision: boolean };
  settings: Settings;
  sources: Array<Source & { total: number }>;
  chain: OnchainState;
  risk: RiskReport;
  credit: CreditProfile;
  mandate: Mandate;
  payees: Payee[];
  proposals: Proposal[];
  events: ActivityEvent[];
  chat: ChatTurn[];
  history: { labels: string[]; netWorth: number[]; liquid: number[] };
  live: Array<{ t: number; netWorth: number; onchain: number; hf: number | null }>;
  demo: { crashing: boolean; injected: boolean; autopilotRunning: boolean };
  cashBrief: { review: number; safeToSpend: number };
  blastRadius: {
    unknownAddressUsd: number;
    payeesPerDayUsd: number;
    remainingTodayUsd: number;
    offchainDailyTransferUsd: number;
    healthFloor: number;
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  state: () => request<AppState>("GET", "/state"),
  act: (action: TypedAction, reason?: string) => request<Proposal>("POST", "/actions", { action, reason }),
  approve: (id: string) => request<Proposal>("POST", `/proposals/${id}/approve`),
  reject: (id: string) => request<Proposal>("POST", `/proposals/${id}/reject`),
  mandate: (patch: Partial<Mandate>) => request<Mandate>("PUT", "/mandate", patch),
  pause: (paused: boolean) => request<{ ok: boolean }>("POST", "/wallet/pause", { paused }),
  connect: (id: string, connected: boolean) => request("POST", `/sources/${id}/connection`, { connected }),
  sync: (id: string) => request("POST", `/sources/${id}/sync`),
  stress: (s: StressInput) => request<StressResult>("POST", "/stress", s),
  chat: (message: string) => request<ChatTurn>("POST", "/chat", { message }),
  chatReset: () => request("POST", "/chat/reset"),
  crash: (pct = 35) => request("POST", "/demo/crash", { pct }),
  recover: () => request("POST", "/demo/recover"),
  warp: (days: number) => request("POST", "/demo/warp", { days }),
  inject: () => request<Proposal[]>("POST", "/demo/inject"),
  reset: () => request("POST", "/demo/reset"),
  tick: () => request("POST", "/demo/tick"),

  cash: () => request<CashState>("GET", "/cash"),
  answer: (txnId: string, category: string) => request<{ text: string; applied: number }>("POST", "/cash/answer", { txnId, category }),
  cashSync: (count = 3) => request<{ imported: number; review: number; remaining: number }>("POST", "/cash/sync", { count }),
  autosync: (on: boolean) => request("POST", "/cash/autosync", { on }),
  sampleCsv: async (name: string) => (await fetch(`/api/cash/samples/${name}`)).text(),
  importPreview: (filename: string, content: string, mapping?: Record<string, number | null>) =>
    request<CsvPreview>("POST", "/cash/import/preview", { filename, content, mapping }),
  importCommit: (filename: string, content: string, mapping?: Record<string, number | null>) =>
    request<{ kind: string; imported: number; duplicates: number; auto: number; review: number; skipped: number }>("POST", "/cash/import/commit", { filename, content, mapping }),
  scanReceipt: (body: { sample?: 1 | 2; imageBase64?: string; mediaType?: string }) => request<ReceiptDraft>("POST", "/cash/receipts/scan", body),
  confirmReceipt: (id: string, items: Array<{ id: string; category: string }>) =>
    request<{ recognised: number; taught: number; memorySize: number }>("POST", `/cash/receipts/${id}/confirm`, { items }),
  budgets: (rules: Array<{ id?: string; category: string; mode: "pct_income" | "fixed"; value: number }>) => request("PUT", "/cash/budgets", { rules }),
  addDebt: (d: Record<string, unknown>) => request("POST", "/cash/debts", d),
  deleteDebt: (id: string) => request("DELETE", `/cash/debts/${id}`),
  addAsset: (a: Record<string, unknown>) => request("POST", "/cash/assets", a),
  deleteAsset: (id: string) => request("DELETE", `/cash/assets/${id}`),
  dismissInsight: (id: string) => request("POST", `/cash/insights/${encodeURIComponent(id)}/dismiss`),
  deleteAll: () => request("POST", "/privacy/delete-all"),
  stressTargets: () => request<StressTargets>("GET", "/stress/targets"),
  scenarios: () => request<Scenario[]>("GET", "/scenarios"),
  saveScenarios: (scenarios: Scenario[]) => request<Scenario[]>("PUT", "/scenarios", { scenarios }),
  profile: (p: Partial<AppState["persona"]>) => request<AppState["persona"]>("PUT", "/profile", p),
  settings: (p: Partial<Settings>) => request<Settings>("PUT", "/settings", p),
};
