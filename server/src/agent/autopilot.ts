import { readOnchain, runLiquidator, signers, withChainLock, type OnchainState } from "../chain.js";
import { analyze, fmt } from "../state.js";
import { logEvent, store } from "../store.js";
import { propose } from "./pipeline.js";
import type { Proposal, TypedAction } from "./types.js";

/**
 * Fast path. The LLM is too slow (and too non-deterministic) for liquidation races, so protective
 * playbooks are plain code that the user pre-authorises through the mandate. Claude handles the
 * slow path: explaining, planning, and anything that needs judgement.
 */

const hasPending = (playbook: string) => store.proposals.some((p) => p.playbook === playbook && p.status === "pending_approval");
let lastBlocked = new Map<string, number>();
let lastRescueLog = 0;

function cooledDown(playbook: string, ms = 20_000) {
  const t = lastBlocked.get(playbook) ?? 0;
  return Date.now() - t > ms;
}

async function run(action: TypedAction, reason: string, playbook: string, protective = true): Promise<Proposal | null> {
  if (hasPending(playbook) || !cooledDown(playbook)) return null;
  const p = await propose(action, "autopilot", reason, { playbook, protective });
  if (p.status === "blocked" || p.status === "failed") lastBlocked.set(playbook, Date.now());
  return p;
}

/** Next step that moves loan health toward the target, using the cheapest source first. */
function nextRescueStep(s: OnchainState): { action: TypedAction; reason: string } | null {
  const m = store.mandate;
  const l = s.loan;
  if (l.debt <= 0 || l.healthFactor === null || l.healthFactor >= m.targetHealthFactor) return null;
  const target = m.targetHealthFactor;
  const p = s.ethPrice;
  const shortfallDebt = l.debt - l.liquidationValue / target;
  const why = `Loan health ${fmt.hf(l.healthFactor)} is below ${m.rescueHealthFactor.toFixed(2)} at ETH ${fmt.usd(p)}. Restoring it to ${target.toFixed(2)}.`;

  if (s.wallet.weth > 0.001) {
    const need = (l.debt * target - l.liquidationValue) / (0.8 * p);
    const amountEth = Math.min(s.wallet.weth, Math.max(need * 1.02, 0.001));
    return { action: { kind: "deposit_collateral", amountEth: Math.floor(amountEth * 1e4) / 1e4 }, reason: `${why} Idle ETH is the cheapest buffer: no swap and no fees.` };
  }
  const spendable = s.wallet.usdc - 25;
  if (spendable > 10) {
    const amountUsd = Math.floor(Math.min(spendable, shortfallDebt * 1.02));
    if (amountUsd > 10) return { action: { kind: "repay", amountUsd }, reason: `${why} Repaying with idle USDC.` };
  }
  if (s.wallet.vault > 10) {
    const amountUsd = Math.floor(Math.min(s.wallet.vault, shortfallDebt * 1.03));
    if (amountUsd > 10) return { action: { kind: "vault_withdraw", amountUsd }, reason: `${why} Pulling USDC out of the treasury vault to repay.` };
  }
  return null;
}

let busy = false;
let rerun = false;

export async function tick(): Promise<void> {
  if (busy) {
    rerun = true;
    return;
  }
  busy = true;
  try {
    do {
      rerun = false;
      await tickOnce();
    } while (rerun);
  } catch (e) {
    console.error("[autopilot]", e);
  } finally {
    busy = false;
  }
}

async function tickOnce() {
  const m = store.mandate;
  let s = await withChainLock(readOnchain);
  const agentOn = m.autonomy >= 1 && !s.agentKey.paused;

  if (agentOn) {
    if (m.playbooks.claimCover) {
      for (const pol of s.cover.filter((x) => x.claimable > 0)) {
        await run({ kind: "claim_cover", policyId: pol.id }, `Policy #${pol.id} pays ${fmt.usd(pol.claimable, 2)} after a liquidation. Claiming automatically.`, `claim-${pol.id}`);
      }
    }

    // Before spending any cash on a rescue: re-attesting is free and restores the credit line.
    if (m.playbooks.keepProofFresh && s.attestation.exists && s.chainTime > s.attestation.expiresAt - 3 * 86400) {
      const { credit } = analyze(s);
      if (credit.eligible) {
        await run(
          { kind: "refresh_attestation" },
          s.attestation.active
            ? "Proof of Wealth expires within 3 days. Re-verifying connected accounts and refreshing it before the credit line lapses."
            : "Proof of Wealth expired, so the credit line dropped out of loan health. Re-verifying and republishing costs nothing, so it comes before any repayment.",
          "proof",
        );
        s = await withChainLock(readOnchain);
      }
    }

    if (m.playbooks.protectLoan && s.loan.healthFactor !== null && s.loan.healthFactor < m.rescueHealthFactor) {
      if (!hasPending("rescue") && Date.now() - lastRescueLog > 15_000) {
        lastRescueLog = Date.now();
        logEvent({ kind: "warning", title: `Rescue playbook triggered (health ${fmt.hf(s.loan.healthFactor)})`, detail: `ETH ${fmt.usd(s.ethPrice)}` });
      }
      for (let i = 0; i < 4; i++) {
        const step = nextRescueStep(s);
        if (!step) break;
        const p = await run(step.action, step.reason, "rescue");
        if (!p || p.status !== "executed") break;
        s = await withChainLock(readOnchain);
        if (step.action.kind === "vault_withdraw") {
          const amountUsd = Math.floor(Math.min(s.wallet.usdc - 25, s.loan.debt));
          if (amountUsd > 10) {
            const r = await run({ kind: "repay", amountUsd }, "Repaying with the USDC just withdrawn from the vault.", "rescue");
            if (!r || r.status !== "executed") break;
            s = await withChainLock(readOnchain);
          }
        }
      }
    }

    if (m.playbooks.optimizeIdleCash && (s.loan.healthFactor === null || s.loan.healthFactor >= m.minHealthFactor)) {
      const idle = s.wallet.usdc - m.minWalletReserveUsd;
      if (idle > 2000) {
        const repayBetter = s.loan.debt > 0 && s.loan.rateBps / 100 > s.vaultApyPct;
        const amountUsd = Math.floor(repayBetter ? Math.min(idle, s.loan.debt) : idle);
        await run(
          repayBetter ? { kind: "repay", amountUsd } : { kind: "vault_deposit", amountUsd },
          repayBetter
            ? `${fmt.usd(idle)} USDC is idle. Repaying ${(s.loan.rateBps / 100).toFixed(1)}% debt earns more than the ${s.vaultApyPct}% vault.`
            : `${fmt.usd(idle)} USDC is idle. Parking it in the ${s.vaultApyPct}% treasury vault.`,
          "idle-cash",
          false,
        );
      }
    }
  }

  // The market: liquidation bots act on any unhealthy position, whether or not an agent protects it.
  const liquidations = await withChainLock(runLiquidator);
  for (const l of liquidations) {
    const isTwin = l.user === signers.twin.address;
    logEvent({
      kind: "liquidation",
      title: isTwin ? `Passive twin liquidated: ${fmt.usd(l.repaid)} debt seized` : `Your loan was liquidated: ${fmt.usd(l.repaid)} repaid by a liquidator`,
      detail: isTwin ? "Same starting position, no agent watching it." : "The cover policy can now pay out the liquidation penalty.",
      txHash: l.hash,
    });
  }

  const now = await withChainLock(readOnchain);
  const { risk } = analyze(now);
  store.liveSeries.push({ t: Date.now(), netWorth: risk.totals.netWorth, onchain: now.wallet.netValue, hf: now.loan.healthFactor });
  store.liveSeries = store.liveSeries.slice(-120);
}

export function resetAutopilot() {
  lastBlocked = new Map();
  lastRescueLog = 0;
}
