/** Typed actions are the only way the agent (LLM or autopilot) can touch the chain.
 *  Calldata is always built by deterministic code, never written by a model. */
export type TypedAction =
  | { kind: "deposit_collateral"; amountEth: number }
  | { kind: "withdraw_collateral"; amountEth: number }
  | { kind: "borrow"; amountUsd: number }
  | { kind: "repay"; amountUsd: number }
  | { kind: "vault_deposit"; amountUsd: number }
  | { kind: "vault_withdraw"; amountUsd: number }
  | { kind: "buy_cover"; coverUsd: number; days: number }
  | { kind: "claim_cover"; policyId: number }
  | { kind: "swap"; from: "USDC" | "WETH"; amount: number; maxSlippageBps?: number }
  | { kind: "transfer"; token: "USDC" | "WETH"; to: string; amount: number }
  | { kind: "refresh_attestation" }
  | { kind: "pledge_credit" }
  | { kind: "release_credit" }
  /** Only produced by the compromised-agent demo. Off-chain policy always rejects it. */
  | { kind: "raw_call"; target: string; data: string; label: string };

export type ActionKind = TypedAction["kind"];

export type Origin = "user" | "chat" | "autopilot" | "attack";

export type Ledger = "USDC" | "WETH" | "VAULT" | "COLLATERAL" | "DEBT" | "COVER";

export interface Expectation {
  ledger: Ledger;
  direction: 1 | -1;
  approx: number;
}

export interface Delta {
  ledger: Ledger;
  before: number;
  after: number;
  change: number;
}

export interface Check {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
  layer: "policy" | "simulation" | "chain";
}

export type Verdict = "approved" | "needs_approval" | "blocked";
export type Status = "executed" | "pending_approval" | "blocked" | "rejected" | "failed" | "superseded";

export interface Proposal {
  id: string;
  createdAt: number;
  origin: Origin;
  action: TypedAction;
  title: string;
  reason: string;
  notionalUsd: number;
  protective: boolean;
  intent: { summary: string; expect: Expectation[]; expectedValueChangeUsd: number };
  simulation?: {
    ok: boolean;
    error?: string;
    diffs: Delta[];
    hfBefore: number | null;
    hfAfter: number | null;
    valueChangeUsd: number;
    gasUsed?: number;
  };
  checks: Check[];
  verdict: Verdict;
  status: Status;
  blockedBy?: "policy" | "simulation" | "chain";
  txHash?: string;
  executedAt?: number;
  error?: string;
  playbook?: string;
}

export interface Mandate {
  /** 0 observe · 1 ask first · 2 bounded autopilot · 3 full mandate */
  autonomy: 0 | 1 | 2 | 3;
  minHealthFactor: number;
  rescueHealthFactor: number;
  targetHealthFactor: number;
  maxBorrowPerActionUsd: number;
  autoApproveLimitUsd: number;
  dailyTransferLimitUsd: number;
  minWalletReserveUsd: number;
  maxSlippageBps: number;
  allowed: Record<Exclude<ActionKind, "raw_call">, boolean>;
  playbooks: {
    protectLoan: boolean;
    keepProofFresh: boolean;
    claimCover: boolean;
    optimizeIdleCash: boolean;
  };
  /** User-tuned thresholds for proactive alerts. */
  alerts: {
    maxCapitalAtRiskPct: number;
    idleCashUsd: number;
  };
}

export interface Payee {
  id: string;
  name: string;
  address: string;
}

export interface ActivityEvent {
  id: string;
  at: number;
  kind: "market" | "system" | "liquidation" | "attestation" | "info" | "warning";
  title: string;
  detail?: string;
  txHash?: string;
}
