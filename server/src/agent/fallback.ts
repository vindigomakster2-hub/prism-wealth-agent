import { stressTest } from "../engine/risk.js";
import { fmt, snapshotState } from "../state.js";
import { store } from "../store.js";
import { propose } from "./pipeline.js";
import type { Proposal, TypedAction } from "./types.js";
import { cashState } from "../cashflow/engine.js";

/**
 * Offline agent used when no GROQ_API_KEY is configured. Same tools, same safety
 * pipeline, simple intent matching (English and Russian keywords) instead of an LLM.
 */

function parseAmount(t: string): number | null {
  const m = t.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)\s*(k|к|тыс)?/i);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const has = (t: string, re: RegExp) => re.test(t);

function outcome(p: Proposal): string {
  const failed = p.checks.filter((c) => !c.pass);
  switch (p.status) {
    case "executed":
      return `✅ **${p.title}**: executed on-chain. Health ${fmt.hf(p.simulation?.hfBefore ?? null)} → ${fmt.hf(p.simulation?.hfAfter ?? null)}.`;
    case "pending_approval": {
      const m = store.mandate;
      const why = m.autonomy <= 1 ? "your autonomy level asks first" : `above your ${fmt.usd(m.autoApproveLimitUsd)} auto-approve limit`;
      return `⏳ **${p.title}**: simulated and policy-checked; waiting for your approval (${why}).`;
    }
    case "blocked":
      return `⛔ **${p.title}**: blocked. ${failed.map((c) => `${c.label}: ${c.detail}`).join("; ")}`;
    default:
      return `⚠️ **${p.title}**: ${p.status}${p.error ? `, ${p.error}` : ""}.`;
  }
}

export async function chatWithRules(text: string): Promise<{ text: string; proposalIds: string[] }> {
  const t = text.toLowerCase();
  const amount = parseAmount(t);
  const { chain, risk, credit } = await snapshotState();
  const ids: string[] = [];
  const act = async (a: TypedAction, why: string) => {
    const p = await propose(a, "chat", why);
    ids.push(p.id);
    return outcome(p);
  };

  if (has(t, /(borrow|loan|need|lend|займ|кредит|занять|нужн|одолж)/) && amount) {
    const c = credit.comparison;
    const lines = [
      `You can raise **${fmt.usd(amount)}** without selling anything:`,
      `- Standard DeFi terms: ${fmt.usd(c.standard.available)} available at ${c.standard.aprPct}% APR`,
      `- With Proof of Wealth (Tier ${credit.tier}): ${fmt.usd(c.hybrid.available)} available at ${c.hybrid.aprPct}% APR`,
      `- Breaking the Meridian term deposit early would forfeit its accrued 4.0% interest.`,
    ];
    if (!chain.attestation.active && credit.eligible) {
      lines.push("", "Publishing your proof first so the cheaper terms apply:");
      lines.push(await act({ kind: "refresh_attestation" }, "Unlock tiered rate and credit line before borrowing"));
    }
    lines.push(await act({ kind: "borrow", amountUsd: amount }, `You asked to borrow ${fmt.usd(amount)}`));
    return { text: lines.join("\n"), proposalIds: ids };
  }

  if (has(t, /(repay|pay back|pay off|погас|вернуть|верни)/)) {
    const amt = amount ?? chain.loan.debt;
    return { text: await act({ kind: "repay", amountUsd: amt }, "You asked to repay the loan"), proposalIds: ids };
  }

  if (has(t, /(insur|cover|protect|страх|защит)/)) {
    const lines: string[] = [];
    const coverFinding = risk.findings.find((f) => f.id === "loan-cover");
    if (coverFinding?.action) lines.push(await act(coverFinding.action, coverFinding.detail));
    else lines.push("Your on-chain loan already has active liquidation cover.");
    if (risk.findings.some((f) => f.id === "life-gap")) {
      lines.push("", `**Off-chain gap:** no life cover with a dependent. Rule of thumb: about ${fmt.usd(78000 * 10)}. Compare term-life quotes; that step is yours (decision support, not advice).`);
    }
    return { text: lines.join("\n"), proposalIds: ids };
  }

  if (has(t, /(proof|attest|score|rating|tier|рейтинг|скор|доказ|кредитн)/)) {
    const lines = [
      `**Abanq score ${credit.score}, Tier ${credit.tier}.** ${fmt.usd(credit.totalPledgeable)} of verified assets after haircuts gives a ${fmt.usd(credit.creditLine)} credit line at ${(credit.rateBps / 100).toFixed(1)}% APR (standard: 9.0%).`,
      ...credit.factors.map((f) => `- ${f.label}: ${Math.round(f.score)}/100 (${f.detail})`),
    ];
    if (credit.nextTier) lines.push(`Tier ${credit.nextTier.tier} needs ${credit.nextTier.pointsNeeded} more points. Diversification is the biggest lever.`);
    if (!chain.attestation.active && credit.eligible) lines.push("", await act({ kind: "refresh_attestation" }, "You asked about your credit proof"));
    return { text: lines.join("\n"), proposalIds: ids };
  }

  if (has(t, /(idle|yield|earn|vault|park|доход|процент|вклад|кэш|свобод)/)) {
    const f = risk.findings.find((x) => x.id === "idle-cash");
    if (!f?.action) return { text: "No idle stablecoins above your cash reserve right now.", proposalIds: ids };
    return { text: `${f.detail}\n${await act(f.action, f.detail)}`, proposalIds: ids };
  }

  if (has(t, /(safe to spend|can i spend|spend this month|потратить|можно тратить|бюджет|budget|subscription|подписк)/)) {
    const c = cashState();
    const s = c.month.safeToSpend;
    return {
      text: [
        `**Safe to spend: ${fmt.usd(s.amount)}** for the rest of the month (about ${fmt.usd(Math.max(0, s.perDay))}/day for ${s.daysLeft} days).`,
        `- Income base ${fmt.usd(c.month.incomeBase)}, bills and loans ${fmt.usd(s.fixedExpected)}, savings target ${fmt.usd(s.savingsTarget)}, already spent ${fmt.usd(s.discretionary)}`,
        ...c.budgets.map((b) => `- ${b.label}: ${fmt.usd(b.spent)} of ${fmt.usd(b.limit)}${b.mode === "pct_income" ? ` (${b.value}% of income)` : ""}${b.state === "over" ? " ⚠️ over" : ""}`),
        ...c.insights.filter((i) => i.kind === "subscriptions" || i.kind === "private_loan").map((i) => `- ${i.title}`),
        c.review.length ? `${c.review.length} transactions are waiting for your answer on the Cash flow page.` : "",
      ].filter(Boolean).join("\n"),
      proposalIds: ids,
    };
  }

  if (has(t, /(crash|stress|what if|drop|fall|упад|кризис|обвал|если)/)) {
    const s = stressTest(risk.holdings, risk.liabilities, chain, { equitiesPct: -25, cryptoPct: -40, privatePct: -30, eurUsdPct: -5 });
    return {
      text: [
        "**Stress test:** equities −25% (tech −31%), ETH −40%, private −30%, EUR −5%",
        `- Net worth ${fmt.usd(s.before)} → **${fmt.usd(s.after)}** (${s.deltaPct.toFixed(1)}%)`,
        ...s.byGroup.filter((g) => Math.abs(g.delta) > 1).map((g) => `- ${g.group}: ${fmt.usd(g.delta)}`),
        `- Loan health ${fmt.hf(s.hfBefore)} → **${fmt.hf(s.hfAfter)}**${s.liquidation ? ". Liquidation without action; the rescue playbook would add collateral first." : ""}`,
        `- Passive twin with no agent: health ${fmt.hf(s.twinHfAfter)}`,
      ].join("\n"),
      proposalIds: ids,
    };
  }

  if (has(t, /(risk|danger|safe|риск|опасн|безопас)/)) {
    return {
      text: [
        `**Risk ${risk.riskScore}/100 (${risk.riskLabel}).** Top issues:`,
        ...risk.findings.slice(0, 5).map((f) => `- **${f.title}**: ${f.detail} _(${f.owner === "agent" ? "I can do this" : "your step"})_`),
      ].join("\n"),
      proposalIds: ids,
    };
  }

  if (has(t, /(net worth|overview|total|how much|сколько|капитал|итог|всего|баланс|обзор)/)) {
    return {
      text: [
        `**Net worth ${fmt.usd(risk.totals.netWorth)}**: ${fmt.usd(risk.totals.offchain)} off-chain and ${fmt.usd(risk.totals.onchain)} on-chain.`,
        ...risk.allocation.map((a) => `- ${a.group}: ${fmt.usd(a.value)} (${a.pct.toFixed(0)}%)`),
        `Loan health ${fmt.hf(chain.loan.healthFactor)}, ETH ${fmt.usd(chain.ethPrice)}.`,
      ].join("\n"),
      proposalIds: ids,
    };
  }

  return {
    text: [
      `I'm running in **offline mode** (no Groq API key), so I understand a fixed set of requests:`,
      "- *What's my net worth?* · *How risky am I?* · *What if markets crash?*",
      "- *I need $5,000* · *Repay 2000* · *Protect my loan* · *Put idle cash to work* · *Show my credit score*",
      "- *How much can I safely spend this month?* · *How are my budgets?*",
      `Set GROQ_API_KEY and restart the server to switch on the AI agent (${store.mandate.autonomy >= 2 ? "autopilot is on" : "autopilot needs approvals"}).`,
    ].join("\n"),
    proposalIds: ids,
  };
}
