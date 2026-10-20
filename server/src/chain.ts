import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  Interface,
  JsonRpcProvider,
  MaxUint256,
  Wallet,
  formatUnits,
  parseUnits,
  type InterfaceAbi,
} from "ethers";
import { ARTIFACTS_DIR, DEPLOYMENTS_FILE, ETH_START_PRICE, ROLE_INDEX, RPC_URL, TEST_MNEMONIC } from "./config.js";

export const provider = new JsonRpcProvider(RPC_URL, { chainId: 31337, name: "abanq-local" }, {
  staticNetwork: true,
  cacheTimeout: -1,
});

type Role = keyof typeof ROLE_INDEX;
export const signers = Object.fromEntries(
  Object.entries(ROLE_INDEX).map(([role, i]) => {
    const hd = HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
    return [role, new Wallet(hd.privateKey, provider)];
  }),
) as Record<Role, Wallet>;

// ------------------------------------------------------------------ artifacts

type Artifact = { abi: InterfaceAbi; bytecode: string };
const artifactCache = new Map<string, Artifact>();
function artifact(name: string): Artifact {
  let a = artifactCache.get(name);
  if (!a) {
    const file = path.join(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`);
    if (!fs.existsSync(file)) throw new Error(`Missing artifact ${file}. Run "npm run compile" first.`);
    a = JSON.parse(fs.readFileSync(file, "utf8")) as Artifact;
    artifactCache.set(name, a);
  }
  return a;
}

const CONTRACTS = ["MockERC20", "PriceOracle", "CreditRegistry", "HybridLendingPool", "TBillVault", "CoverPool", "SimpleSwap", "AgentWallet"];
/** Fingerprint of the compiled contracts, so a recompile forces a fresh deployment. */
function artifactsHash(): string {
  return createHash("sha1").update(CONTRACTS.map((n) => artifact(n).bytecode).join("|")).digest("hex");
}

export const iface = {
  erc20: new Interface(artifact("MockERC20").abi),
  oracle: new Interface(artifact("PriceOracle").abi),
  registry: new Interface(artifact("CreditRegistry").abi),
  pool: new Interface(artifact("HybridLendingPool").abi),
  vault: new Interface(artifact("TBillVault").abi),
  cover: new Interface(artifact("CoverPool").abi),
  swap: new Interface(artifact("SimpleSwap").abi),
  wallet: new Interface(artifact("AgentWallet").abi),
};

// ----------------------------------------------------------------- deployment

export interface Addresses {
  usdc: string;
  weth: string;
  oracle: string;
  registry: string;
  pool: string;
  vault: string;
  cover: string;
  swap: string;
  wallet: string;
}

export let addr: Addresses;
export let c: Record<keyof Addresses, Contract>;

function bind(a: Addresses) {
  addr = a;
  c = {
    usdc: new Contract(a.usdc, iface.erc20, provider),
    weth: new Contract(a.weth, iface.erc20, provider),
    oracle: new Contract(a.oracle, iface.oracle, provider),
    registry: new Contract(a.registry, iface.registry, provider),
    pool: new Contract(a.pool, iface.pool, provider),
    vault: new Contract(a.vault, iface.vault, provider),
    cover: new Contract(a.cover, iface.cover, provider),
    swap: new Contract(a.swap, iface.swap, provider),
    wallet: new Contract(a.wallet, iface.wallet, provider),
  };
}

export const as = (contract: Contract, role: Role) => contract.connect(signers[role]) as Contract;
export const usd6 = (n: number) => parseUnits(n.toFixed(6), 6);
export const wei = (n: number) => parseUnits(n.toFixed(18), 18);
export const f6 = (x: bigint) => Number(formatUnits(x, 6));
export const f18 = (x: bigint) => Number(formatUnits(x, 18));
const e8 = (n: number) => parseUnits(n.toFixed(8), 8);

async function deploy(name: string, ...args: unknown[]): Promise<string> {
  const a = artifact(name);
  const factory = new ContractFactory(a.abi, a.bytecode, signers.admin);
  const ct = await factory.deploy(...args);
  await ct.waitForDeployment();
  return ct.getAddress();
}

async function send(p: Promise<{ wait: () => Promise<unknown> }>) {
  const tx = await p;
  await tx.wait();
}

export type Call = { target: string; data: string };

/** Fresh protocol + seeded demo state. Mirrors a mainnet fork with real protocols in a production setup. */
export async function deployWorld(): Promise<Addresses> {
  const { owner, agent, attestor, landlord } = signers;
  const usdc = await deploy("MockERC20", "USD Coin (demo)", "USDC", 6);
  const weth = await deploy("MockERC20", "Wrapped Ether (demo)", "WETH", 18);
  const oracle = await deploy("PriceOracle");
  const registry = await deploy("CreditRegistry", attestor.address);
  const pool = await deploy("HybridLendingPool", usdc, weth, oracle, registry);
  const vault = await deploy("TBillVault", usdc, 480);
  const cover = await deploy("CoverPool", usdc, pool);
  const swap = await deploy("SimpleSwap", oracle);
  const wallet = await deploy("AgentWallet", owner.address, agent.address, oracle);
  const a: Addresses = { usdc, weth, oracle, registry, pool, vault, cover, swap, wallet };
  bind(a);

  const admin = (x: Contract) => as(x, "admin");
  await send(admin(c.oracle).setPrice(weth, e8(ETH_START_PRICE)));
  await send(admin(c.oracle).setPrice(usdc, e8(1)));
  await send(admin(c.registry).setPool(pool, true));

  for (const [to, amount] of [
    [pool, 2_000_000],
    [vault, 250_000],
    [cover, 300_000],
    [swap, 1_000_000],
    [signers.liquidator.address, 500_000],
  ] as const) {
    await send(admin(c.usdc).mint(to, usd6(amount)));
  }
  for (const [to, amount] of [
    [swap, 600],
    [wallet, 7],
    [signers.twin.address, 5],
  ] as const) {
    await send(admin(c.weth).mint(to, wei(amount)));
  }

  // On-chain mandate for the agent key, signed by the owner.
  const sel = (i: Interface, fn: string) => i.getFunction(fn)!.selector;
  const allow: Array<[string, Interface, string]> = [
    [pool, iface.pool, "depositCollateral"],
    [pool, iface.pool, "withdrawCollateral"],
    [pool, iface.pool, "borrow"],
    [pool, iface.pool, "repay"],
    [pool, iface.pool, "pledgeCredit"],
    [pool, iface.pool, "releaseCredit"],
    [vault, iface.vault, "deposit"],
    [vault, iface.vault, "withdraw"],
    [vault, iface.vault, "withdrawAll"],
    [cover, iface.cover, "buyCover"],
    [cover, iface.cover, "claim"],
    [swap, iface.swap, "swap"],
    [registry, iface.registry, "publish"],
    [usdc, iface.erc20, "approve"],
    [usdc, iface.erc20, "transfer"],
    [weth, iface.erc20, "approve"],
    [weth, iface.erc20, "transfer"],
  ];
  const w = as(c.wallet, "owner");
  await send(w.setAllowedCalls(allow.map((x) => x[0]), allow.map((x) => sel(x[1], x[2])), true));
  await send(w.setCounterparties([pool, vault, cover, swap, owner.address, landlord.address], true));
  await send(w.setDailyLimit(usd6(2000)));
  await send(w.setHealthGuard(pool, parseUnits("1.25", 18)));

  // Starting position: 5 WETH collateral, 9,000 USDC debt, 3,000 USDC parked in the vault.
  await send(
    w.executeBatch([
      { target: weth, data: iface.erc20.encodeFunctionData("approve", [pool, wei(5)]) },
      { target: pool, data: iface.pool.encodeFunctionData("depositCollateral", [wei(5)]) },
      { target: pool, data: iface.pool.encodeFunctionData("borrow", [usd6(9000)]) },
      { target: usdc, data: iface.erc20.encodeFunctionData("approve", [vault, usd6(3000)]) },
      { target: vault, data: iface.vault.encodeFunctionData("deposit", [usd6(3000)]) },
    ]),
  );

  // Passive twin: identical collateral and debt, no agent watching it.
  await send(as(c.weth, "twin").approve(pool, wei(5)));
  await send(as(c.pool, "twin").depositCollateral(wei(5)));
  await send(as(c.pool, "twin").borrow(usd6(9000)));
  await send(as(c.usdc, "liquidator").approve(pool, MaxUint256));

  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify({ ...a, artifactsHash: artifactsHash() }, null, 2));
  return a;
}

export async function waitForChain(maxSeconds = 90) {
  for (let i = 0; i < maxSeconds; i++) {
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      if (i === 0) console.log(`[chain] waiting for JSON-RPC at ${RPC_URL} ...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`No chain at ${RPC_URL}. Start it with "npm run chain".`);
}

export async function ensureWorld(): Promise<{ reused: boolean }> {
  await waitForChain();
  if (fs.existsSync(DEPLOYMENTS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8")) as Addresses & { artifactsHash?: string };
    // Reuse only if the chain still has the contracts AND they were built from the current sources.
    if (saved.artifactsHash === artifactsHash() && (await provider.getCode(saved.wallet)) !== "0x") {
      bind(saved);
      return { reused: true };
    }
  }
  await deployWorld();
  return { reused: false };
}

// ------------------------------------------------------------------- locking

let queue: Promise<unknown> = Promise.resolve();
/** Serialises everything that touches chain state (simulations temporarily mutate it). Not re-entrant. */
export function withChainLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

// -------------------------------------------------------------- chain helpers

export async function chainTime(): Promise<number> {
  const b = await provider.getBlock("latest");
  return b ? b.timestamp : Math.floor(Date.now() / 1000);
}

export async function snapshot(): Promise<string> {
  return provider.send("evm_snapshot", []);
}

export async function revertTo(id: string) {
  await provider.send("evm_revert", [id]);
}

export async function increaseTime(seconds: number) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

export async function setEthPrice(usd: number) {
  await send(as(c.oracle, "admin").setPrice(addr.weth, e8(usd)));
}

export async function agentExecute(calls: Call[]): Promise<{ hash: string; gasUsed: number }> {
  const tx = await as(c.wallet, "agent").executeBatch(calls);
  const receipt = await tx.wait();
  return { hash: tx.hash, gasUsed: Number(receipt?.gasUsed ?? 0n) };
}

export async function ownerCall(fn: string, args: unknown[]): Promise<string> {
  const tx = await as(c.wallet, "owner")[fn](...args);
  await tx.wait();
  return tx.hash;
}

export function errorReason(e: unknown): string {
  const err = e as { reason?: string; shortMessage?: string; message?: string; info?: { error?: { message?: string } } };
  const raw = err?.reason ?? err?.info?.error?.message ?? err?.shortMessage ?? err?.message ?? String(e);
  return String(raw)
    .replace(/^execution reverted:?\s*/i, "")
    .replace(/^VM Exception while processing transaction: reverted with reason string '(.*)'$/, "$1")
    .replace(/^"|"$/g, "");
}

// --------------------------------------------------------------- state reads

const MAX = MaxUint256;
const hfNum = (x: bigint) => (x === MAX ? null : f18(x));

export interface LoanView {
  collateralEth: number;
  collateralUsd: number;
  debt: number;
  creditLine: number;
  attestedCreditLine: number;
  borrowingPower: number;
  liquidationValue: number;
  healthFactor: number | null;
  rateBps: number;
  tier: number;
  pledged: boolean;
  available: number;
  liquidationPrice: number | null;
  liquidationPenalty: number;
  liquidationCount: number;
}

async function loanOf(user: string, ethPrice: number): Promise<LoanView> {
  const [p, penalty, count, active] = await Promise.all([
    c.pool.positionOf(user),
    c.pool.liquidationPenaltyUsd6(user),
    c.pool.liquidationCount(user),
    c.registry.activeCredit(user),
  ]);
  const collateralEth = f18(p.collateral);
  const debt = f6(p.debt);
  const attestedCreditLine = p.pledged ? f6(active[1]) : 0;
  // Price at which liquidationValue == debt (credit capped at 50% of collateral value).
  let liquidationPrice: number | null = null;
  if (debt > 0 && collateralEth > 0) {
    const capped = debt / (1.3 * collateralEth);
    liquidationPrice = attestedCreditLine >= 0.5 * collateralEth * capped ? capped : (debt - attestedCreditLine) / (0.8 * collateralEth);
    if (liquidationPrice < 0) liquidationPrice = 0;
  }
  return {
    collateralEth,
    collateralUsd: f6(p.collateralUsd6),
    debt,
    creditLine: f6(p.creditLineUsd6),
    attestedCreditLine,
    borrowingPower: f6(p.borrowingPowerUsd6),
    liquidationValue: f6(p.liquidationValueUsd6),
    healthFactor: hfNum(p.healthFactor),
    rateBps: Number(p.rateBps),
    tier: Number(p.tier),
    pledged: Boolean(p.pledged),
    available: Math.max(0, f6(p.borrowingPowerUsd6) - debt),
    liquidationPrice,
    liquidationPenalty: f6(penalty),
    liquidationCount: Number(count),
  };
}

export interface CoverView {
  id: number;
  coverUsd: number;
  premiumUsd: number;
  start: number;
  expiry: number;
  claimed: boolean;
  claimable: number;
  active: boolean;
}

export interface OnchainState {
  chainTime: number;
  ethPrice: number;
  addresses: Addresses;
  wallet: { address: string; usdc: number; weth: number; wethUsd: number; vault: number; netValue: number };
  loan: LoanView;
  attestation: {
    exists: boolean;
    active: boolean;
    tier: number;
    score: number;
    creditLine: number;
    issuedAt: number;
    expiresAt: number;
    sourcesRoot: string;
    nonce: number;
  };
  cover: CoverView[];
  agentKey: {
    address: string;
    owner: string;
    paused: boolean;
    expiry: number;
    dailyLimit: number;
    remainingToday: number;
    minHealthFactor: number;
  };
  twin: { address: string; loan: LoanView };
  vaultApyPct: number;
}

export async function readOnchain(): Promise<OnchainState> {
  const w = addr.wallet;
  const [now, priceE8, usdcBal, wethBal, vaultBal, att, active, nonce, policyIds, paused, expiry, limit, remaining, minHf] =
    await Promise.all([
      chainTime(),
      c.oracle.priceE8(addr.weth),
      c.usdc.balanceOf(w),
      c.weth.balanceOf(w),
      c.vault.balanceOfAssets(w),
      c.registry.attestations(w),
      c.registry.activeCredit(w),
      c.registry.nonces(w),
      c.cover.policiesOf(w),
      c.wallet.agentPaused(),
      c.wallet.agentExpiry(),
      c.wallet.dailyLimitUsd6(),
      c.wallet.remainingDailyUsd6(),
      c.wallet.minHealthFactor(),
    ]);
  const ethPrice = Number(formatUnits(priceE8, 8));
  const [loan, twinLoan] = await Promise.all([loanOf(w, ethPrice), loanOf(signers.twin.address, ethPrice)]);

  const cover: CoverView[] = await Promise.all(
    (policyIds as bigint[]).map(async (id) => {
      const [p, claimable] = await Promise.all([c.cover.policies(id), c.cover.claimable(id)]);
      return {
        id: Number(id),
        coverUsd: f6(p.coverUsd6),
        premiumUsd: f6(p.premiumUsd6),
        start: Number(p.start),
        expiry: Number(p.expiry),
        claimed: Boolean(p.claimed),
        claimable: f6(claimable),
        active: !p.claimed && Number(p.expiry) > now,
      };
    }),
  );

  const usdc = f6(usdcBal);
  const weth = f18(wethBal);
  const vault = f6(vaultBal);
  return {
    chainTime: now,
    ethPrice,
    addresses: addr,
    wallet: {
      address: w,
      usdc,
      weth,
      wethUsd: weth * ethPrice,
      vault,
      netValue: usdc + weth * ethPrice + vault + loan.collateralUsd - loan.debt,
    },
    loan,
    attestation: {
      exists: Number(att.expiresAt) > 0,
      active: Number(active[2]) > now,
      tier: Number(att.tier),
      score: Number(att.score),
      creditLine: f6(att.creditLineUsd6),
      issuedAt: Number(att.issuedAt),
      expiresAt: Number(att.expiresAt),
      sourcesRoot: att.sourcesRoot,
      nonce: Number(nonce),
    },
    cover,
    agentKey: {
      address: signers.agent.address,
      owner: signers.owner.address,
      paused: Boolean(paused),
      expiry: Number(expiry),
      dailyLimit: f6(limit),
      remainingToday: f6(remaining),
      minHealthFactor: f18(minHf),
    },
    twin: { address: signers.twin.address, loan: twinLoan },
    vaultApyPct: 4.8,
  };
}

/** Compact balance sheet used for simulation diffs. */
export interface BalanceSheet {
  USDC: number;
  WETH: number;
  VAULT: number;
  COLLATERAL: number;
  DEBT: number;
  COVER: number;
  hf: number | null;
  netValueUsd: number;
  ethPrice: number;
}

export async function readBalanceSheet(): Promise<BalanceSheet> {
  const w = addr.wallet;
  const [usdcBal, wethBal, vaultBal, p, policies, priceE8] = await Promise.all([
    c.usdc.balanceOf(w),
    c.weth.balanceOf(w),
    c.vault.balanceOfAssets(w),
    c.pool.positionOf(w),
    c.cover.policiesOf(w),
    c.oracle.priceE8(addr.weth),
  ]);
  const ethPrice = Number(formatUnits(priceE8, 8));
  const USDC = f6(usdcBal);
  const WETH = f18(wethBal);
  const VAULT = f6(vaultBal);
  const COLLATERAL = f18(p.collateral);
  const DEBT = f6(p.debt);
  return {
    USDC,
    WETH,
    VAULT,
    COLLATERAL,
    DEBT,
    COVER: (policies as bigint[]).length,
    hf: hfNum(p.healthFactor),
    netValueUsd: USDC + WETH * ethPrice + VAULT + COLLATERAL * ethPrice - DEBT,
    ethPrice,
  };
}

/** Market liquidation bot: liquidates any unhealthy tracked position (the twin, or the user's wallet). */
export async function runLiquidator(): Promise<Array<{ user: string; repaid: number; hash: string }>> {
  const out: Array<{ user: string; repaid: number; hash: string }> = [];
  for (const user of [signers.twin.address, addr.wallet]) {
    const hf: bigint = await c.pool.healthFactor(user);
    if (hf >= parseUnits("1", 18)) continue;
    const debt: bigint = await c.pool.debtOf(user);
    const repay = debt / 2n;
    if (repay === 0n) continue;
    try {
      const tx = await as(c.pool, "liquidator").liquidate(user, repay);
      await tx.wait();
      out.push({ user, repaid: f6(repay), hash: tx.hash });
    } catch (e) {
      console.warn("[liquidator]", errorReason(e));
    }
  }
  return out;
}
