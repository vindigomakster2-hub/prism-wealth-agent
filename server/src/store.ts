import { randomUUID } from "node:crypto";
import { initialSources, resetPersona, type Source } from "./data/persona.js";
import type { ActivityEvent, Mandate, Payee, Proposal } from "./agent/types.js";
import type { StressInput } from "./engine/risk.js";

export interface Scenario {
  id: string;
  name: string;
  input: StressInput;
  builtIn?: boolean;
}

export function defaultScenarios(): Scenario[] {
  const base = { equitiesPct: 0, cryptoPct: 0, privatePct: 0, eurUsdPct: 0, ratesBps: 0, incomePct: 0, custom: [] };
  return [
    { id: "tech", name: "Tech correction", builtIn: true, input: { ...base, equitiesPct: -25, cryptoPct: -30, privatePct: -30 } },
    { id: "crypto", name: "Crypto winter", builtIn: true, input: { ...base, equitiesPct: -5, cryptoPct: -60, privatePct: -10 } },
    { id: "2008", name: "2008-style crash", builtIn: true, input: { ...base, equitiesPct: -45, cryptoPct: -55, privatePct: -50, eurUsdPct: -10 } },
    { id: "rates", name: "Rates +200 bps", builtIn: true, input: { ...base, ratesBps: 200 } },
    { id: "job", name: "Job loss", builtIn: true, input: { ...base, incomePct: -100, privatePct: -40 } },
    { id: "eur", name: "Euro slide", builtIn: true, input: { ...base, eurUsdPct: -15 } },
  ];
}

export interface Settings {
  /** Send questions about unclear transactions to Telegram. */
  telegramQuestions: boolean;
  /** Send new insights (budget overruns, detected private loans) to Telegram. */
  telegramAlerts: boolean;
}
const defaultSettings = (): Settings => ({ telegramQuestions: true, telegramAlerts: true });

export function defaultMandate(): Mandate {
  return {
    autonomy: 2,
    minHealthFactor: 1.4,
    rescueHealthFactor: 1.3,
    targetHealthFactor: 1.7,
    maxBorrowPerActionUsd: 10_000,
    autoApproveLimitUsd: 2_500,
    dailyTransferLimitUsd: 1_000,
    minWalletReserveUsd: 1_000,
    maxSlippageBps: 100,
    allowed: {
      deposit_collateral: true,
      withdraw_collateral: true,
      borrow: true,
      repay: true,
      vault_deposit: true,
      vault_withdraw: true,
      buy_cover: true,
      claim_cover: true,
      swap: true,
      transfer: true,
      refresh_attestation: true,
      pledge_credit: true,
      release_credit: true,
    },
    playbooks: { protectLoan: true, keepProofFresh: true, claimCover: true, optimizeIdleCash: false },
    alerts: { maxCapitalAtRiskPct: 35, idleCashUsd: 1_000 },
  };
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  proposalIds: string[];
  engine?: "llm" | "rules";
}

export const store = {
  sources: initialSources() as Source[],
  mandate: defaultMandate(),
  payees: [] as Payee[],
  proposals: [] as Proposal[],
  events: [] as ActivityEvent[],
  transfers: { day: "", usd: 0 },
  chatLog: [] as ChatTurn[],
  demo: { crashing: false, injected: false },
  liveSeries: [] as Array<{ t: number; netWorth: number; onchain: number; hf: number | null }>,
  /** Background autopilot ticks. Survives demo resets so test runs stay deterministic. */
  autopilotRunning: true,
  scenarios: defaultScenarios(),
  settings: defaultSettings(),
  alertedInsights: new Set<string>(),
};

export function resetStore() {
  // Imported broker sources live in store.sources too, so a reset drops them with the rest.
  store.sources = initialSources();
  store.mandate = defaultMandate();
  store.proposals = [];
  store.events = [];
  store.transfers = { day: "", usd: 0 };
  store.chatLog = [];
  store.demo = { crashing: false, injected: false };
  store.liveSeries = [];
  store.scenarios = defaultScenarios();
  store.settings = defaultSettings();
  store.alertedInsights = new Set();
  resetPersona();
}

export const newId = () => randomUUID().slice(0, 8);

export function logEvent(e: Omit<ActivityEvent, "id" | "at">) {
  store.events.unshift({ ...e, id: newId(), at: Date.now() });
  store.events = store.events.slice(0, 200);
}

export function recordProposal(p: Proposal) {
  const i = store.proposals.findIndex((x) => x.id === p.id);
  if (i >= 0) store.proposals[i] = p;
  else store.proposals.unshift(p);
  store.proposals = store.proposals.slice(0, 200);
}

export function transferredToday(): number {
  const day = new Date().toISOString().slice(0, 10);
  if (store.transfers.day !== day) store.transfers = { day, usd: 0 };
  return store.transfers.usd;
}
