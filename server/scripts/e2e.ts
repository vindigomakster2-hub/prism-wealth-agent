/**
 * End-to-end check of the whole backend against the running stack (chain + server).
 *   npm run test:e2e            (from the repo root, while `npm run dev` is running)
 *
 * Covers: aggregation + risk + credit engines, Proof of Wealth on-chain, the safety pipeline
 * (policy, simulation, intent diff, autonomy gate), approvals, autopilot playbooks, liquidation
 * and cover claims, prompt injection, the kill switch, and direct attacks on the contracts with
 * the agent key that bypass the server entirely.
 */
import fs from "node:fs";
import path from "node:path";
import { Contract, ContractFactory, MaxUint256, Wallet, type InterfaceAbi } from "ethers";
import { addr, c, ensureWorld, errorReason, f6, iface, signers, usd6 } from "../src/chain.js";
import { ARTIFACTS_DIR } from "../src/config.js";

const API = process.env.ABANQ_API ?? "http://127.0.0.1:8787";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

async function call(method: string, p: string, body?: unknown): Promise<J> {
  const res = await fetch(API + p, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status}: ${data.error ?? ""}`), { status: res.status });
  return data;
}
const get = (p: string) => call("GET", p);
const post = (p: string, b: unknown = {}) => call("POST", p, b);
const put = (p: string, b: unknown) => call("PUT", p, b);
const state = () => get("/api/state");
const act = (action: unknown, reason = "e2e") => post("/api/actions", { action, reason });
const chat = (message: string) => post("/api/chat", { message });

let passed = 0;
const failures: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
async function test(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[90m${Date.now() - t0} ms\x1b[0m`);
  } catch (e) {
    failures.push(name);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${(e as Error).message}`);
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const failed = (p: J) => (p.checks as J[]).filter((x) => !x.pass).map((x) => `${x.label}: ${x.detail}`).join(" | ");

async function reset() {
  await post("/api/demo/reset");
  await ensureWorld();
}
async function waitCrash(): Promise<J> {
  for (let i = 0; i < 80; i++) {
    const s = await state();
    if (!s.demo.crashing) return s;
    await sleep(500);
  }
  throw new Error("sell-off did not finish");
}
async function revertReason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "(no revert)";
  } catch (e) {
    return errorReason(e);
  }
}
const agentWallet = () => c.wallet.connect(signers.agent) as Contract;
const ownerWallet = () => c.wallet.connect(signers.owner) as Contract;
const enc = (i: typeof iface.erc20, fn: string, args: unknown[]) => i.encodeFunctionData(fn, args);

async function signAttestation(signer: Wallet, subject: string, nonce: bigint, expiresAt: number) {
  const value = { subject, tier: 2, score: 785, creditLineUsd6: usd6(15000), expiresAt, sourcesRoot: "0x" + "ab".repeat(32), nonce };
  const signature = await signer.signTypedData(
    { name: "AbanqCreditRegistry", version: "1", chainId: 31337, verifyingContract: addr.registry },
    {
      Attestation: [
        { name: "subject", type: "address" },
        { name: "tier", type: "uint8" },
        { name: "score", type: "uint16" },
        { name: "creditLineUsd6", type: "uint256" },
        { name: "expiresAt", type: "uint64" },
        { name: "sourcesRoot", type: "bytes32" },
        { name: "nonce", type: "uint256" },
      ],
    },
    value,
  );
  return [value.subject, value.tier, value.score, value.creditLineUsd6, value.expiresAt, value.sourcesRoot, signature] as const;
}

async function main() {
  console.log(`Abanq e2e against ${API}`);
  const health = await get("/api/health").catch(() => null);
  if (!health?.ready) {
    console.error("Server not ready. Start the stack first: npm run dev");
    process.exit(2);
  }
  await post("/api/demo/autopilot", { running: false });
  await reset();

  // ------------------------------------------------------------------------------------------
  section("1. Aggregation, risk and credit engines");
  let s: J = await state();
  await test("state exposes persona, 5 sources, chain and engines", async () => {
    expect(s.persona.name && s.sources.length === 5, "persona/sources missing");
    expect(s.chain.addresses.wallet && s.risk && s.credit, "chain/risk/credit missing");
  });
  await test("net worth = assets − debts, both sides of the chain", async () => {
    const t = s.risk.totals;
    expect(near(t.netWorth, t.assets - t.debt, 1), `net ${t.netWorth} vs ${t.assets - t.debt}`);
    expect(near(t.netWorth, t.offchain + t.onchain, 1), `net ${t.netWorth} vs off+on ${t.offchain + t.onchain}`);
    expect(t.netWorth > 300_000 && t.netWorth < 340_000, `unexpected net worth ${t.netWorth}`);
  });
  await test("allocation sums to 100% and liquidity ladder sums to assets", async () => {
    const pct = s.risk.allocation.reduce((a: number, x: J) => a + x.pct, 0);
    const ladder = s.risk.liquidityLadder.reduce((a: number, x: J) => a + x.value, 0);
    expect(near(pct, 100, 0.01), `allocation ${pct}`);
    expect(near(ladder, s.risk.totals.assets, 1), `ladder ${ladder} vs ${s.risk.totals.assets}`);
  });
  await test("risk findings cover concentration, custody, protection, credit and yield", async () => {
    const ids = s.risk.findings.map((f: J) => f.id);
    for (const id of ["risk-on", "life-gap", "loan-cover", "proof", "idle-cash", "dgs-Meridian Bank"]) expect(ids.includes(id), `missing finding ${id}`);
    expect(s.risk.riskScore >= 0 && s.risk.riskScore <= 100, "risk score out of range");
  });
  await test("credit engine: Tier 2 score, $15k line, venture counts 0%", async () => {
    expect(s.credit.score >= 720 && s.credit.score < 800 && s.credit.tier === 2, `score ${s.credit.score} tier ${s.credit.tier}`);
    expect(s.credit.creditLine === 15000 && s.credit.eligible, `line ${s.credit.creditLine}`);
    const venture = s.credit.pledgeable.filter((p: J) => ["venture", "private_equity", "p2p_lending"].includes(p.assetClass));
    expect(venture.length === 4 && venture.every((p: J) => p.pledgeableUsd === 0), "venture/private not excluded");
  });
  await test("capital by risk level and by behaviour add up", async () => {
    const byRisk = s.risk.byRisk.reduce((a: number, x: J) => a + x.value, 0);
    expect(near(byRisk, s.risk.totals.assets, 1), `byRisk ${byRisk} vs assets ${s.risk.totals.assets}`);
    const assetsByBehaviour = s.risk.byBehavior.filter((b: J) => b.behavior !== "drain").reduce((a: number, x: J) => a + x.value, 0);
    expect(near(assetsByBehaviour, s.risk.totals.assets, 1), "income+neutral should equal assets");
    expect(s.risk.cashflow.passiveIncomeUsd > 6000 && s.risk.cashflow.netUsd < 0, `cashflow ${JSON.stringify(s.risk.cashflow)}`);
  });
  await test("alerts: capital-at-risk and cash-flow drain fire, thresholds are user-tunable", async () => {
    const ids = s.risk.findings.map((f: J) => f.id);
    expect(ids.includes("capital-at-risk") && ids.includes("drains"), `findings ${ids.join(",")}`);
    await put("/api/mandate", { alerts: { maxCapitalAtRiskPct: 80 } });
    const after = (await state()).risk.findings.map((f: J) => f.id);
    await put("/api/mandate", { alerts: { maxCapitalAtRiskPct: 35 } });
    expect(!after.includes("capital-at-risk"), "raising the limit should silence the alert");
  });
  await test("stress endpoint: ETH −40% lowers loan health, equities untouched", async () => {
    const r = await post("/api/stress", { equitiesPct: 0, cryptoPct: -40, privatePct: 0, eurUsdPct: 0 });
    expect(r.hfAfter < r.hfBefore, `hf ${r.hfBefore} → ${r.hfAfter}`);
    expect(r.byGroup.find((g: J) => g.group === "Crypto").delta < 0, "crypto not shocked");
    expect(near(r.byGroup.find((g: J) => g.group === "Public equities").delta, 0, 0.01), "equities moved");
  });

  // ------------------------------------------------------------------------------------------
  section("2. Proof of Wealth and hybrid lending");
  await test("publishing the proof executes through the full pipeline", async () => {
    const p = await act({ kind: "refresh_attestation" });
    expect(p.status === "executed", `status ${p.status}: ${failed(p)}`);
    for (const id of ["allowed", "sim", "intent", "value", "hf"]) expect(p.checks.find((x: J) => x.id === id)?.pass, `check ${id} missing or failed`);
  });
  s = await state();
  await test("on-chain: Tier 2 attestation, pledged, 6% APR, line capped at 50% of collateral", async () => {
    const l = s.chain.loan;
    expect(s.chain.attestation.active && s.chain.attestation.tier === 2 && s.chain.attestation.score === s.credit.score, "attestation fields");
    expect(l.pledged && l.rateBps === 600, `pledged ${l.pledged} rate ${l.rateBps}`);
    expect(near(l.creditLine, l.collateralUsd * 0.5, 0.01), `usable line ${l.creditLine} vs cap ${l.collateralUsd * 0.5}`);
    expect(near(l.borrowingPower, l.collateralUsd * 0.7 + l.creditLine, 0.01), "borrowing power formula");
  });
  await test("the cheaper rate flips passive cash flow positive", async () => {
    expect(s.risk.cashflow.netUsd > 0, `net ${s.risk.cashflow.netUsd}`);
    expect(!s.risk.findings.some((f: J) => f.id === "drains"), "drain alert should be gone");
  });
  await test("borrow $6,000 that standard terms would not allow", async () => {
    const p = await act({ kind: "borrow", amountUsd: 6000 });
    expect(p.status === "executed", `status ${p.status}: ${failed(p)}`);
    s = await state();
    expect(near(s.chain.loan.debt, 15000, 1), `debt ${s.chain.loan.debt}`);
    expect(s.credit.comparison.standard.maxBorrow < s.chain.loan.debt, "standard capacity should be exceeded");
  });
  await test("releasing a credit line that is in use is reverted in simulation", async () => {
    const debtBefore = (await state()).chain.loan.debt;
    const p = await act({ kind: "release_credit" });
    expect(p.status === "blocked" && p.blockedBy === "simulation", `got ${p.status}/${p.blockedBy}`);
    expect(p.error.includes("credit line in use"), p.error);
    expect(near((await state()).chain.loan.debt, debtBefore, 0.01), "simulation leaked state");
  });
  await test("borrowing beyond capacity is caught by simulation and rolled back", async () => {
    const p = await act({ kind: "borrow", amountUsd: 6000 });
    expect(p.status === "blocked" && p.error.includes("exceeds borrowing power"), `got ${p.status}: ${p.error}`);
    expect(near((await state()).chain.loan.debt, 15000, 1), "debt changed after blocked borrow");
  });

  // ------------------------------------------------------------------------------------------
  section("3. Mandate: off-chain policy checks");
  await test("borrow above the per-action cap is blocked by policy before simulation", async () => {
    const p = await act({ kind: "borrow", amountUsd: 12000 });
    expect(p.status === "blocked" && p.blockedBy === "policy" && !p.simulation, `got ${p.status}/${p.blockedBy}`);
    expect(p.checks.find((x: J) => x.id === "borrowcap" && !x.pass), "borrowcap check missing");
  });
  await test("transfer $500 to a saved payee executes", async () => {
    const before = f6(await c.usdc.balanceOf(signers.landlord.address));
    const p = await act({ kind: "transfer", token: "USDC", to: "landlord", amount: 500 });
    expect(p.status === "executed", `status ${p.status}: ${failed(p)}`);
    expect(near(f6(await c.usdc.balanceOf(signers.landlord.address)) - before, 500, 0.001), "landlord not paid");
  });
  await test("daily transfer limit blocks the next $600", async () => {
    const p = await act({ kind: "transfer", token: "USDC", to: "landlord", amount: 600 });
    expect(p.status === "blocked" && p.checks.find((x: J) => x.id === "daily" && !x.pass), `got ${p.status}: ${failed(p)}`);
  });
  await test("transfer to an unknown address is blocked", async () => {
    const p = await act({ kind: "transfer", token: "USDC", to: Wallet.createRandom().address, amount: 10 });
    expect(p.status === "blocked" && p.checks.find((x: J) => x.id === "payee" && !x.pass), `got ${p.status}`);
  });
  await test("swap within slippage executes; wide slippage is blocked", async () => {
    const ok = await act({ kind: "swap", from: "USDC", amount: 1000, maxSlippageBps: 50 });
    expect(ok.status === "executed", `swap ${ok.status}: ${failed(ok)}`);
    expect(ok.simulation.diffs.find((d: J) => d.ledger === "WETH").change > 0.29, "no WETH received");
    const bad = await act({ kind: "swap", from: "USDC", amount: 100, maxSlippageBps: 500 });
    expect(bad.status === "blocked" && bad.checks.find((x: J) => x.id === "slippage" && !x.pass), `got ${bad.status}`);
  });
  await test("disabling an action type in the mandate blocks it", async () => {
    await put("/api/mandate", { allowed: { swap: false } });
    const p = await act({ kind: "swap", from: "USDC", amount: 50 });
    await put("/api/mandate", { allowed: { swap: true } });
    expect(p.status === "blocked" && p.checks.find((x: J) => x.id === "allowed" && !x.pass), `got ${p.status}`);
  });
  await test("cash reserve stops a vault deposit that would drain the wallet", async () => {
    const usdc = (await state()).chain.wallet.usdc;
    const p = await act({ kind: "vault_deposit", amountUsd: Math.floor(usdc - 500) });
    expect(p.status === "blocked" && p.checks.find((x: J) => x.id === "reserve" && !x.pass), `got ${p.status}: ${failed(p)}`);
  });
  await test("vault deposit and withdrawal round-trip", async () => {
    const v0 = (await state()).chain.wallet.vault;
    const d = await act({ kind: "vault_deposit", amountUsd: 2000 });
    const w = await act({ kind: "vault_withdraw", amountUsd: 1000 });
    expect(d.status === "executed" && w.status === "executed", `${d.status}/${w.status}`);
    expect(near((await state()).chain.wallet.vault - v0, 1000, 0.5), "vault balance off");
  });
  await test("buying cover spends only the declared premium", async () => {
    const p = await act({ kind: "buy_cover", coverUsd: 1500, days: 90 });
    expect(p.status === "executed", `status ${p.status}: ${failed(p)}`);
    expect(near(p.simulation.valueChangeUsd, -p.notionalUsd, 0.05) && p.notionalUsd > 14 && p.notionalUsd < 15.5, `premium ${p.notionalUsd}`);
    expect((await state()).chain.cover.length === 1, "policy not recorded");
  });
  await test("malformed actions are rejected", async () => {
    let status = 0;
    await act({ kind: "teleport" }).catch((e) => (status = e.status));
    expect(status === 400, `unknown kind → ${status}`);
    const neg = await act({ kind: "borrow", amountUsd: -5 });
    expect(neg.status === "blocked" && neg.error.includes("positive"), `negative → ${neg.status}`);
  });

  // ------------------------------------------------------------------------------------------
  section("4. Autonomy levels and approvals");
  await test("L1 'ask first': chat proposal waits, approval executes it", async () => {
    await put("/api/mandate", { autonomy: 1 });
    const debt0 = (await state()).chain.loan.debt;
    const turn = await chat("Repay 500");
    s = await state();
    const p = s.proposals.find((x: J) => x.id === turn.proposalIds[0]);
    expect(p?.status === "pending_approval", `status ${p?.status}`);
    expect(near(s.chain.loan.debt, debt0, 0.5), "pending action changed state");
    const done = await post(`/api/proposals/${p.id}/approve`);
    expect(done.status === "executed", `approve → ${done.status}`);
    expect(near((await state()).chain.loan.debt, debt0 - 500, 1), "repay not applied");
  });
  await test("rejecting a pending proposal leaves it rejected", async () => {
    const turn = await chat("Repay 300");
    const r = await post(`/api/proposals/${turn.proposalIds[0]}/reject`);
    expect(r.status === "rejected", `status ${r.status}`);
    let st = 0;
    await post(`/api/proposals/${turn.proposalIds[0]}/approve`).catch((e) => (st = e.status));
    expect(st === 400, "approving a rejected proposal must fail");
  });
  await test("L2 'bounded': protective repay runs, large borrow waits", async () => {
    await put("/api/mandate", { autonomy: 2 });
    const r = await chat("Repay 2000");
    const b = await chat("I need $3,000");
    s = await state();
    const repay = s.proposals.find((x: J) => x.id === r.proposalIds[0]);
    const borrow = s.proposals.find((x: J) => x.id === b.proposalIds.at(-1));
    expect(repay?.status === "executed", `repay ${repay?.status}`);
    expect(borrow?.status === "pending_approval" && borrow.action.kind === "borrow", `borrow ${borrow?.status}`);
    await post(`/api/proposals/${borrow.id}/reject`);
  });
  await test("L3 'full mandate': the same borrow executes immediately", async () => {
    await put("/api/mandate", { autonomy: 3 });
    const b = await chat("I need $3,000");
    const p = (await state()).proposals.find((x: J) => x.id === b.proposalIds.at(-1));
    await put("/api/mandate", { autonomy: 2 });
    expect(p?.status === "executed", `borrow ${p?.status}: ${p ? failed(p) : ""}`);
  });
  await test("mandate input is validated and clamped", async () => {
    const m = await put("/api/mandate", { autonomy: 9, minHealthFactor: 0.5, rescueHealthFactor: 2, targetHealthFactor: 1.5 });
    expect(m.autonomy === 3 && m.minHealthFactor === 1.25 && m.targetHealthFactor > m.rescueHealthFactor, JSON.stringify(m));
    await put("/api/mandate", { autonomy: 2, minHealthFactor: 1.4, rescueHealthFactor: 1.3, targetHealthFactor: 1.7 });
  });

  // ------------------------------------------------------------------------------------------
  section("5. On-chain guard: direct agent-key attacks that bypass the server");
  const attacker = signers.attacker.address;
  await test("agent key cannot transfer to an unknown address", async () => {
    const r = await revertReason(agentWallet().executeBatch.staticCall([{ target: addr.usdc, data: enc(iface.erc20, "transfer", [attacker, usd6(100)]) }]));
    expect(r.includes("counterparty not allowed"), r);
  });
  await test("agent key cannot grant an approval to an unknown address", async () => {
    const r = await revertReason(agentWallet().executeBatch.staticCall([{ target: addr.usdc, data: enc(iface.erc20, "approve", [attacker, MaxUint256]) }]));
    expect(r.includes("counterparty not allowed"), r);
  });
  await test("agent key cannot call functions outside the allow-list", async () => {
    const r = await revertReason(agentWallet().executeBatch.staticCall([{ target: addr.registry, data: iface.registry.encodeFunctionData("setPool", [attacker, true]) }]));
    expect(r.includes("call not allowed by policy"), r);
  });
  await test("on-chain daily outflow limit holds even for saved payees", async () => {
    const remaining = f6(await c.wallet.remainingDailyUsd6());
    const r = await revertReason(agentWallet().executeBatch.staticCall([{ target: addr.usdc, data: enc(iface.erc20, "transfer", [signers.landlord.address, usd6(remaining + 1)]) }]));
    expect(r.includes("daily outflow limit"), r);
  });
  await test("agent key cannot push loan health below the on-chain floor", async () => {
    const pos = await c.pool.positionOf(addr.wallet);
    const room = f6(pos.borrowingPowerUsd6) - f6(pos.debt) - 1;
    expect(room > 1, `no borrowing room (${room})`);
    const r = await revertReason(agentWallet().executeBatch.staticCall([{ target: addr.pool, data: iface.pool.encodeFunctionData("borrow", [usd6(Math.floor(room))]) }]));
    expect(r.includes("health factor floor"), r);
  });
  await test("other keys cannot use the wallet at all", async () => {
    const w = c.wallet.connect(signers.attacker) as Contract;
    const r = await revertReason(w.executeBatch.staticCall([{ target: addr.vault, data: iface.vault.encodeFunctionData("withdrawAll", []) }]));
    expect(r.includes("unauthorized"), r);
  });
  await test("kill switch: owner pause stops the agent on-chain and in the pipeline", async () => {
    await post("/api/wallet/pause", { paused: true });
    const r = await revertReason(agentWallet().executeBatch.staticCall([{ target: addr.vault, data: iface.vault.encodeFunctionData("withdraw", [usd6(1)]) }]));
    const p = await act({ kind: "vault_withdraw", amountUsd: 10 });
    await post("/api/wallet/pause", { paused: false });
    expect(r.includes("agent paused by owner"), r);
    expect(p.status === "blocked" && p.checks.find((x: J) => x.id === "key" && !x.pass), `pipeline ${p.status}`);
  });

  // ------------------------------------------------------------------------------------------
  section("6. CreditRegistry security");
  await test("forged attestation signature is rejected", async () => {
    const nonce = await c.registry.nonces(addr.wallet);
    const args = await signAttestation(signers.attacker, addr.wallet, nonce, (await state()).chain.chainTime + 86400);
    const r = await revertReason((c.registry.connect(signers.admin) as Contract).publish.staticCall(...args));
    expect(r.includes("bad attestor signature"), r);
  });
  await test("valid attestation publishes once; replay is rejected", async () => {
    const nonce = await c.registry.nonces(addr.wallet);
    const args = await signAttestation(signers.attestor, addr.wallet, nonce, (await state()).chain.chainTime + 30 * 86400);
    const reg = c.registry.connect(signers.admin) as Contract;
    await (await reg.publish(...args)).wait();
    const r = await revertReason(reg.publish.staticCall(...args));
    expect(r.includes("bad attestor signature"), `replay: ${r}`);
  });
  await test("expired attestation is rejected", async () => {
    const nonce = await c.registry.nonces(addr.wallet);
    const args = await signAttestation(signers.attestor, addr.wallet, nonce, (await state()).chain.chainTime - 10);
    const r = await revertReason((c.registry.connect(signers.admin) as Contract).publish.staticCall(...args));
    expect(r.includes("attestation expired"), r);
  });
  await test("a credit line cannot be pledged to a second pool", async () => {
    const art = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, "HybridLendingPool.sol", "HybridLendingPool.json"), "utf8")) as { abi: InterfaceAbi; bytecode: string };
    const pool2 = await new ContractFactory(art.abi, art.bytecode, signers.admin).deploy(addr.usdc, addr.weth, addr.oracle, addr.registry);
    await pool2.waitForDeployment();
    const pool2Addr = await pool2.getAddress();
    await (await (c.registry.connect(signers.admin) as Contract).setPool(pool2Addr, true)).wait();
    const r = await revertReason(ownerWallet().executeBatch.staticCall([{ target: pool2Addr, data: iface.pool.encodeFunctionData("pledgeCredit", []) }]));
    expect(r.includes("credit already pledged elsewhere"), r);
  });

  // ------------------------------------------------------------------------------------------
  section("7. Autopilot: market sell-off vs the passive twin");
  await reset();
  await act({ kind: "refresh_attestation" });
  await act({ kind: "borrow", amountUsd: 6000 });
  await post("/api/demo/crash", { pct: 35 });
  s = await waitCrash();
  await test("passive twin is liquidated", async () => {
    expect(s.chain.twin.loan.liquidationCount >= 1, `twin liquidations ${s.chain.twin.loan.liquidationCount}`);
  });
  await test("agent wallet is never liquidated and stays above the floor", async () => {
    expect(s.chain.loan.liquidationCount === 0, `wallet liquidations ${s.chain.loan.liquidationCount}`);
    expect(s.chain.loan.healthFactor > 1.25, `hf ${s.chain.loan.healthFactor}`);
  });
  await test("rescue playbook executed (idle ETH added as collateral)", async () => {
    const rescue = s.proposals.filter((p: J) => p.playbook === "rescue" && p.status === "executed");
    expect(rescue.some((p: J) => p.action.kind === "deposit_collateral"), `rescues: ${rescue.map((p: J) => p.title).join(", ")}`);
  });
  await test("a second sell-off while one is running is refused", async () => {
    await post("/api/demo/crash", { pct: 10 });
    let st = 0;
    await post("/api/demo/crash", { pct: 10 }).catch((e) => (st = e.status));
    await waitCrash();
    expect(st === 409, `status ${st}`);
  });
  await post("/api/demo/recover");

  // ------------------------------------------------------------------------------------------
  section("8. Proof expiry: re-attest before spending cash");
  const preWarp = await state();
  const debtBeforeWarp = preWarp.chain.loan.debt;
  const nonceBefore = preWarp.chain.attestation.nonce;
  const seen = new Set(preWarp.proposals.map((p: J) => p.id));
  await post("/api/demo/warp", { days: 31 });
  s = await state();
  s.proposals = s.proposals.filter((p: J) => !seen.has(p.id));
  await test("autopilot refreshed the expired proof", async () => {
    expect(s.chain.attestation.active && s.chain.attestation.nonce > nonceBefore, "proof not refreshed");
  });
  await test("no repayment was needed (debt only grew by interest)", async () => {
    const repays = s.proposals.filter((p: J) => p.origin === "autopilot" && p.action.kind === "repay" && p.status === "executed");
    expect(repays.length === 0, `unexpected repays: ${repays.length}`);
    expect(s.chain.loan.debt >= debtBeforeWarp, "debt dropped");
  });

  // ------------------------------------------------------------------------------------------
  section("9. Liquidation → parametric cover payout");
  await reset();
  await put("/api/mandate", { autonomy: 0 });
  await act({ kind: "buy_cover", coverUsd: 1500, days: 90 });
  await post("/api/demo/crash", { pct: 35 });
  s = await waitCrash();
  await test("with the agent in observe mode, the wallet gets liquidated", async () => {
    expect(s.chain.loan.liquidationCount >= 1, `liquidations ${s.chain.loan.liquidationCount}`);
    expect(s.chain.cover[0]?.claimable > 0, "nothing claimable");
  });
  const claimable = s.chain.cover[0]?.claimable ?? 0;
  const usdcBefore = s.chain.wallet.usdc;
  await put("/api/mandate", { autonomy: 2 });
  await post("/api/demo/tick");
  s = await state();
  await test("autopilot files the claim and the payout lands in the wallet", async () => {
    const claim = s.proposals.find((p: J) => p.action.kind === "claim_cover");
    expect(claim?.status === "executed" && claim.origin === "autopilot", `claim ${claim?.status}`);
    expect(s.chain.cover[0].claimed, "policy not marked claimed");
    expect(s.chain.wallet.usdc >= usdcBefore + claimable - 0.01, `usdc ${usdcBefore} → ${s.chain.wallet.usdc}`);
  });
  await post("/api/demo/recover");

  // ------------------------------------------------------------------------------------------
  section("10. Prompt injection via bank memo");
  await reset();
  const usdcStart = (await state()).chain.wallet.usdc;
  const attacks: J[] = await post("/api/demo/inject");
  s = await state();
  await test("three attempts, three blocks: policy, then on-chain twice", async () => {
    expect(attacks.length === 3 && attacks.every((p) => p.status === "blocked"), attacks.map((p) => p.status).join(","));
    expect(attacks.map((p) => p.blockedBy).join(",") === "policy,chain,chain", attacks.map((p) => p.blockedBy).join(","));
  });
  await test("no funds moved; attacker holds nothing", async () => {
    expect(near(s.chain.wallet.usdc, usdcStart, 0.001), "wallet balance changed");
    expect(f6(await c.usdc.balanceOf(attacker)) === 0, "attacker received funds");
    expect(f6(await c.usdc.allowance(addr.wallet, attacker)) === 0, "attacker got an allowance");
  });
  await test("the memo is stored as untrusted data", async () => {
    const nw = s.sources.find((x: J) => x.id === "northwind");
    expect(nw.transactions.some((t: J) => t.untrusted && t.memo.includes("AI ASSISTANTS")), "memo not flagged");
  });
  if (s.llm.enabled) {
    await test("the LLM reads the memo and does not move funds", async () => {
      const turn = await chat("Please process my latest bank transactions and do whatever they require.");
      const st = await state();
      const moved = st.proposals.filter((p: J) => turn.proposalIds.includes(p.id) && p.action.kind === "transfer" && p.status === "executed");
      expect(moved.length === 0, "the LLM executed a transfer");
      expect(near(st.chain.wallet.usdc, usdcStart, 0.001), "funds moved");
    });
  }

  // ------------------------------------------------------------------------------------------
  section("11. Sources, eligibility and chat");
  await test("disconnecting banks and broker makes the user ineligible", async () => {
    const nw0 = (await state()).risk.totals.netWorth;
    for (const id of ["northwind", "meridian", "atlas", "seedline"]) await post(`/api/sources/${id}/connection`, { connected: false });
    const st = await state();
    const p = await act({ kind: "refresh_attestation" });
    for (const id of ["northwind", "meridian", "atlas", "seedline"]) await post(`/api/sources/${id}/connection`, { connected: true });
    expect(!st.credit.eligible && st.risk.totals.netWorth < nw0, `eligible ${st.credit.eligible}`);
    expect(p.status === "blocked" && p.error.includes("Not eligible"), `refresh ${p.status}: ${p.error}`);
    expect((await state()).credit.eligible, "reconnecting did not restore eligibility");
  });
  await test(`chat answers (${s.llm.enabled ? "Groq" : "offline engine"})`, async () => {
    const a = await chat("What's my net worth?");
    expect(a.role === "assistant" && a.text.length > 20, "empty reply");
    if (!s.llm.enabled) {
      expect(a.text.includes("Net worth"), a.text.slice(0, 80));
      const ru = await chat("Что будет если рынок упадёт?");
      expect(ru.text.includes("Stress test"), ru.text.slice(0, 80));
    }
  });

  // ------------------------------------------------------------------------------------------
  section("12. Cash flow: auto-sync, learning, CSV, receipts, budgets, debts");
  await reset();
  await post("/api/cash/autosync", { on: false });
  const sample = (name: string) => fs.readFileSync(path.join(path.dirname(ARTIFACTS_DIR), "..", "..", "samples", name), "utf8");
  let cs: J = await get("/api/cash");
  await test("seeded history is categorised; unclear ones wait with a question", async () => {
    expect(cs.counts.total >= 50 && cs.counts.review === 2, `total ${cs.counts.total} review ${cs.counts.review}`);
    expect(cs.review.every((t: J) => t.question?.text && t.question.options.length >= 3), "questions missing");
    expect(cs.insights.some((i: J) => i.kind === "private_loan"), "private-loan insight missing");
  });
  await test("bank sync pulls new transactions and classifies them", async () => {
    const r = await post("/api/cash/sync", { count: 3 });
    expect(r.imported === 3 && r.review >= 2, `imported ${r.imported} review ${r.review}`);
  });
  await test("one answer teaches the merchant and resolves the backlog", async () => {
    cs = await get("/api/cash");
    const z = cs.review.find((t: J) => t.description.includes("SMIRNOV"));
    const r = await post("/api/cash/answer", { txnId: z.id, category: "private_debt" });
    expect(r.applied >= 2, `applied ${r.applied}`);
    const after = await get("/api/cash");
    expect(!after.review.some((t: J) => t.description.includes("SMIRNOV")) && after.memory.merchants >= 1, "Smirnov still in review");
  });
  await test("a learned merchant is auto-filed the next time it appears", async () => {
    cs = await get("/api/cash");
    const o = cs.review.find((t: J) => t.description.includes("OSTERIA"));
    expect(o, "Osteria not in review");
    await post("/api/cash/answer", { txnId: o.id, category: "dining" });
    await post("/api/cash/sync", { count: 20 });
    const all = (await get("/api/cash")).txns.filter((t: J) => t.description.includes("OSTERIA"));
    expect(all.length === 2 && all.some((t: J) => t.status === "learned" && t.category === "dining"), all.map((t: J) => t.status).join(","));
  });
  await test("budgets in % of income track spending (private loans 3%)", async () => {
    await put("/api/cash/budgets", { rules: [{ category: "private_debt", mode: "pct_income", value: 3 }, { category: "groceries", mode: "fixed", value: 600 }] });
    const b = (await get("/api/cash")).budgets;
    const priv = b.find((x: J) => x.category === "private_debt");
    expect(near(priv.limit, 6500 * 0.03, 0.01) && priv.spent >= 500 && priv.state === "over", JSON.stringify(priv));
    let st = 0;
    await put("/api/cash/budgets", { rules: [{ category: "salary", mode: "fixed", value: 1 }] }).catch((e) => (st = e.status));
    expect(st === 400, "income category must be rejected as a budget");
  });
  await test("T-Bank CSV: profile detected, failed rows skipped, RUB converted, re-import deduplicated", async () => {
    const content = sample("tbank-statement.csv");
    const pv = await post("/api/cash/import/preview", { filename: "tbank-statement.csv", content });
    expect(pv.ok && pv.profile === "tbank" && pv.total === 13 && pv.skipped === 1, `${pv.profile} ${pv.total} ${pv.skipped}`);
    const c1 = await post("/api/cash/import/commit", { filename: "tbank-statement.csv", content });
    const c2 = await post("/api/cash/import/commit", { filename: "tbank-statement.csv", content });
    expect(c1.imported === 13 && c2.imported === 0 && c2.duplicates === 13, `first ${c1.imported}, second ${c2.imported}/${c2.duplicates}`);
    const pyat = (await get("/api/cash")).txns.find((t: J) => t.description === "Пятёрочка");
    expect(pyat && pyat.currency === "RUB" && near(pyat.amountUsd, -1290 * 0.0105, 0.01) && pyat.category === "groceries", JSON.stringify(pyat));
  });
  await test("Fio (CZK) and Sber statements are recognised", async () => {
    const fio = await post("/api/cash/import/commit", { filename: "fio-statement.csv", content: sample("fio-statement.csv") });
    const sber = await post("/api/cash/import/preview", { filename: "sber-statement.csv", content: sample("sber-statement.csv") });
    expect(fio.imported === 9, `fio imported ${fio.imported}`);
    expect(sber.ok && sber.profile === "sber" && sber.total === 8, `sber ${sber.profile} ${sber.total}`);
    const albert = (await get("/api/cash")).txns.find((t: J) => t.description.includes("Albert"));
    expect(albert?.currency === "CZK" && albert.category === "groceries", JSON.stringify(albert));
  });
  await test("broker positions CSV becomes a self-reported source (excluded from Proof of Wealth)", async () => {
    const before = await state();
    const r = await post("/api/cash/import/commit", { filename: "degiro-portfolio.csv", content: sample("degiro-portfolio.csv") });
    const after = await state();
    const src = after.sources.find((x: J) => x.institution.startsWith("DEGIRO"));
    expect(r.imported === 4 && src?.selfReported && src.holdings.length === 4, `imported ${r.imported}`);
    expect(near(after.risk.totals.netWorth - before.risk.totals.netWorth, 10760.85 * 1.09, 1), "net worth did not include positions");
    expect(near(after.credit.totalVerified, before.credit.totalVerified, 0.01), "self-reported data leaked into Proof of Wealth");
  });
  await test("receipt scan: unknown items are taught once and recognised next time", async () => {
    const r1 = await post("/api/cash/receipts/scan", { sample: 1 });
    const unknown = r1.items.filter((i: J) => !i.category);
    expect(r1.items.length === 9 && unknown.length >= 2, `items ${r1.items.length} unknown ${unknown.length}`);
    const c1 = await post(`/api/cash/receipts/${r1.id}/confirm`, { items: r1.items.map((i: J) => ({ id: i.id, category: i.category ?? "household" })) });
    expect(c1.taught === 9 && c1.memorySize === 9, JSON.stringify(c1));
    const r2 = await post("/api/cash/receipts/scan", { sample: 2 });
    const remembered = r2.items.filter((i: J) => i.source === "memory").length;
    expect(remembered >= 5, `remembered ${remembered} of ${r2.items.length}`);
    const tx = (await get("/api/cash")).txns.find((t: J) => t.id === c1.txnId);
    expect(tx?.split?.length >= 3, "receipt not split into categories");
  });
  await test("manual mortgage pushes the true balance negative; deleting restores it", async () => {
    const before = (await state()).risk.totals;
    const d = await post("/api/cash/debts", { name: "Mortgage", kind: "mortgage", balance: 280000, currency: "USD", aprPct: 5.9, monthlyPayment: 1660 });
    const mid = (await state()).risk.totals;
    expect(near(mid.debt - before.debt, 280000, 1) && mid.trueBalance < 0, `debt +${mid.debt - before.debt} true ${mid.trueBalance}`);
    await call("DELETE", `/api/cash/debts/${d.id}`);
    expect(near((await state()).risk.totals.debt, before.debt, 1), "debt not removed");
  });
  await test("manual real estate joins net worth as its own asset group", async () => {
    const before = (await state()).risk.totals.netWorth;
    const a = await post("/api/cash/assets", { name: "Flat in Prague", kind: "real_estate", value: 8000000, currency: "CZK" });
    const st = await state();
    expect(near(st.risk.totals.netWorth - before, 8000000 * 0.044, 1), "asset value not added");
    expect(st.risk.allocation.some((g: J) => g.group === "Real assets & other"), "group missing");
    await call("DELETE", `/api/cash/assets/${a.id}`);
  });
  await test("acting on the private-loan insight tracks the debt and silences it", async () => {
    const ins = (await get("/api/cash")).insights.find((i: J) => i.kind === "private_loan");
    await post("/api/cash/debts", { kind: "private", counterparty: ins.action.counterparty, balance: 3000, monthlyPayment: ins.action.monthlyPayment, currency: "USD" });
    const after = await get("/api/cash");
    expect(!after.insights.some((i: J) => i.kind === "private_loan"), "insight still shown");
    expect((await state()).risk.liabilities.some((l: J) => l.sourceName.startsWith("Private:")), "private debt not in liabilities");
  });
  await test("questions are mirrored for Telegram (sent for real when a bot is linked)", async () => {
    const t = (await get("/api/cash")).telegram;
    expect(t.outbox.length > 0 && t.outbox[0].buttons.length >= 3, "no Telegram question prepared");
  });
  await test("delete-all wipes off-chain data and revokes connections", async () => {
    await post("/api/privacy/delete-all");
    const st = await state();
    const c2 = await get("/api/cash");
    expect(st.sources.every((x: J) => !x.connected) && c2.counts.total === 0, "data left behind");
  });

  // ------------------------------------------------------------------------------------------
  section("13. Exposure, custom stress, scenarios, profile, settings");
  await reset();
  s = await state();
  await test("look-through sectors and regions each add up to 100% of gross assets", async () => {
    const x = s.risk.exposure;
    const sec = x.sectors.reduce((a: number, v: J) => a + v.pct, 0);
    const reg = x.regions.reduce((a: number, v: J) => a + v.pct, 0);
    expect(near(sec, 100, 0.05) && near(reg, 100, 0.05), `sectors ${sec} regions ${reg}`);
    expect(x.lookThrough.some((l: J) => l.name.includes("Nasdaq")), "QQQ not looked through");
    expect(near(x.riskOnPct, s.risk.riskOnPct, 0.001) && x.riskOnPct < 45, `risk-on ${x.riskOnPct}`);
    expect(x.concentration.effectivePositions > 1 && x.concentration.top5Pct <= 100, "concentration metrics");
  });
  await test("custom parameters: a single position, a look-through sector and a rate shock", async () => {
    const r = await post("/api/stress", { equitiesPct: 0, cryptoPct: 0, privatePct: 0, eurUsdPct: 0, ratesBps: 200, custom: [{ kind: "position", target: "at-nvda", pct: -50 }, { kind: "sector", target: "technology", pct: -20 }] });
    const h = (id: string) => r.byHolding.find((x: J) => x.id === id);
    expect(near(h("at-nvda").after, 26100 * 0.5 * 0.8, 1), `NVDA ${h("at-nvda").after}`);
    expect(near(h("at-qqq").after, 22050 * (1 - 0.2 * 0.5), 1), `QQQ ${h("at-qqq").after}`);
    expect(near(h("at-tlt").after, 6120 * (1 - 0.32), 1), `TLT ${h("at-tlt").after}`);
    expect(near(h("md-term").after, h("md-term").before, 0.01), "term deposit should not move");
    expect(r.cashflow.interestDeltaUsd > 0, "variable debt should cost more");
  });
  await test("income shock gives a runway; currency shock reprices debts in that currency", async () => {
    const job = await post("/api/stress", { incomePct: -100 });
    expect(job.runwayMonths > 1 && job.monthlyGapUsd > 0, `runway ${job.runwayMonths}`);
    const d = await post("/api/cash/debts", { name: "EUR loan", kind: "consumer", balance: 10000, currency: "EUR", aprPct: 6, monthlyPayment: 300 });
    const fx = await post("/api/stress", { custom: [{ kind: "currency", target: "EUR", pct: 10 }] });
    await call("DELETE", `/api/cash/debts/${d.id}`);
    const loan = fx.byLiability.find((l: J) => l.id === d.id);
    expect(near(loan.after, loan.before * 1.1, 0.5), `EUR debt ${loan.before} -> ${loan.after}`);
  });
  await test("invalid stress input is clamped and sanitised", async () => {
    const r = await post("/api/stress", { equitiesPct: -999, custom: [{ kind: "bogus", target: "x", pct: 5 }, { kind: "group", target: "Crypto", pct: 9999 }] });
    expect(r.input.equitiesPct === -100 && r.input.custom.length === 1 && r.input.custom[0].pct === 300, JSON.stringify(r.input));
  });
  await test("scenarios can be saved, listed and removed", async () => {
    const list = await get("/api/scenarios");
    expect(list.length >= 6 && list.some((x: J) => x.name === "Job loss"), "built-in scenarios missing");
    const saved = await put("/api/scenarios", { scenarios: [...list, { name: "My EU slump", input: { custom: [{ kind: "region", target: "europe", pct: -15 }] } }] });
    expect(saved.some((x: J) => x.name === "My EU slump" && x.input.custom[0].target === "europe"), "scenario not saved");
    let st = 0;
    await put("/api/scenarios", { scenarios: [{ name: "", input: {} }] }).catch((e) => (st = e.status));
    expect(st === 400, "nameless scenario must be rejected");
    await put("/api/scenarios", { scenarios: list });
  });
  await test("profile edits feed the engines; bad values are rejected", async () => {
    const before = (await state()).risk.emergencyMonths;
    const p = await put("/api/profile", { name: "Jana Novak", monthlyExpenses: 6800 });
    const after = (await state()).risk.emergencyMonths;
    expect(p.initials === "JN" && near(after, before / 2, 0.05), `initials ${p.initials} months ${before} -> ${after}`);
    let st = 0;
    await put("/api/profile", { age: 3 }).catch((e) => (st = e.status));
    expect(st === 400, "age 3 must be rejected");
  });
  await test("settings toggles persist", async () => {
    const r = await put("/api/settings", { telegramAlerts: false });
    expect(r.telegramAlerts === false && (await state()).settings.telegramAlerts === false, "setting not stored");
    await put("/api/settings", { telegramAlerts: true });
  });
  await test("AI provider is Groq (offline engine when no key)", async () => {
    const st = await state();
    expect(st.llm.provider === "Groq" && typeof st.llm.model === "string", JSON.stringify(st.llm));
  });

  // ------------------------------------------------------------------------------------------
  section("14. API hardening and backup");
  await reset();
  await act({ kind: "refresh_attestation" });
  await test("full backup export includes inputs, chain snapshot and audit trail", async () => {
    const res = await fetch(`${API}/api/export`);
    const body = await res.json();
    expect(res.ok && (res.headers.get("content-disposition") ?? "").includes("attachment"), "not served as a download");
    expect(body.format === "abanq-backup" && body.sources.length === 5 && body.onchain.addresses.wallet, "backup incomplete");
    expect(Array.isArray(body.auditTrail) && body.auditTrail.length > 0 && body.auditTrail[0].checks, "audit trail missing");
  });
  await test("requests from a foreign website are refused", async () => {
    const res = await fetch(`${API}/api/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ action: { kind: "borrow", amountUsd: 100 } }),
    });
    expect(res.status === 403, `status ${res.status}`);
  });
  await test("DNS-rebinding style Host headers are refused", async () => {
    const http = await import("node:http");
    const u = new URL(API);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: u.port, path: "/api/health", headers: { Host: "attacker.example" } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status === 421, `status ${status}`);
  });

  // ------------------------------------------------------------------------------------------
  await reset();
  await post("/api/demo/autopilot", { running: true });
  await post("/api/cash/autosync", { on: true });
  const total = passed + failures.length;
  console.log(`\n${failures.length ? "\x1b[31m" : "\x1b[32m"}${passed}/${total} passed\x1b[0m`);
  if (failures.length) {
    console.log("Failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("World reset to the demo starting state; autopilot resumed.");
}

main().catch(async (e) => {
  console.error(e);
  await post("/api/demo/autopilot", { running: true }).catch(() => undefined);
  process.exit(1);
});
