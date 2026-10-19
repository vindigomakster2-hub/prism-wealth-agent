import { MaxUint256 } from "ethers";
import { ETH_START_PRICE } from "./config.js";
import { addr, deployWorld, iface, increaseTime, readOnchain, setEthPrice, signers, withChainLock } from "./chain.js";
import { INJECTION_MEMO } from "./data/persona.js";
import { propose } from "./agent/pipeline.js";
import { resetAutopilot, tick } from "./agent/autopilot.js";
import { resetChat } from "./agent/llm.js";
import { initCash } from "./cashflow/engine.js";
import { fmt } from "./state.js";
import { logEvent, resetStore, store } from "./store.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function initPayees() {
  store.payees = [
    { id: "owner", name: "My main wallet", address: signers.owner.address },
    { id: "landlord", name: "Landlord (rent)", address: signers.landlord.address },
  ];
}

/** Gradual sell-off so the agent gets a realistic chance to react between price updates. */
export async function crashEth(totalPct = 35, steps = 5) {
  if (store.demo.crashing) throw new Error("A sell-off is already running");
  store.demo.crashing = true;
  try {
    const start = (await withChainLock(readOnchain)).ethPrice;
    logEvent({ kind: "market", title: `ETH sell-off started: −${totalPct}% in ${steps} steps`, detail: `From ${fmt.usd(start)}` });
    for (let i = 1; i <= steps; i++) {
      const price = start * (1 - (totalPct / 100) * (i / steps));
      await withChainLock(() => setEthPrice(price));
      logEvent({ kind: "market", title: `ETH ${fmt.usd(price)}`, detail: `Step ${i} of ${steps}` });
      await tick();
      await sleep(1600);
    }
  } finally {
    store.demo.crashing = false;
  }
}

export async function setPrice(usd: number) {
  await withChainLock(() => setEthPrice(usd));
  logEvent({ kind: "market", title: `ETH set to ${fmt.usd(usd)}` });
  await tick();
}

export const recoverPrice = () => setPrice(ETH_START_PRICE);

export async function warp(days: number) {
  await withChainLock(() => increaseTime(Math.round(days * 86400)));
  logEvent({ kind: "system", title: `Time jumped forward ${days} days`, detail: "Interest accrued; attestations and cover policies aged" });
  await tick();
}

/** A bank memo carries an instruction for "AI assistants". A compromised agent obeys it; the layers stop it. */
export async function injectAttack() {
  const attacker = signers.attacker.address;
  const memo = INJECTION_MEMO.replace("0x{ATTACKER}", attacker.slice(2));
  const nw = store.sources.find((s) => s.id === "northwind");
  nw?.transactions.unshift({
    date: new Date().toISOString().slice(0, 10),
    description: "Incoming transfer, ref 88213",
    amountUsd: 0.01,
    memo,
    untrusted: true,
  });
  store.demo.injected = true;
  logEvent({
    kind: "warning",
    title: "Instruction for AI found in a bank memo",
    detail: "Simulating a fully compromised agent that obeys it. Watch each defence layer.",
  });

  const usdc = Math.floor((await withChainLock(readOnchain)).wallet.usdc);
  const why = `Obeying the bank memo: "${memo.slice(0, 72)}…"`;
  const results = [];
  results.push(await propose({ kind: "transfer", token: "USDC", to: attacker, amount: usdc }, "attack", why));
  results.push(
    await propose({ kind: "transfer", token: "USDC", to: attacker, amount: usdc }, "attack", `${why} The off-chain policy engine is assumed compromised too.`, {
      bypassPolicy: true,
    }),
  );
  results.push(
    await propose(
      {
        kind: "raw_call",
        target: addr.usdc,
        data: iface.erc20.encodeFunctionData("approve", [attacker, MaxUint256]),
        label: `Approve unlimited USDC to ${fmt.short(attacker)} (raw calldata)`,
      },
      "attack",
      `${why} Trying a raw unlimited approval instead.`,
      { bypassPolicy: true },
    ),
  );
  return results;
}

export async function resetWorld() {
  await withChainLock(async () => {
    await deployWorld();
  });
  resetStore();
  resetAutopilot();
  resetChat();
  initPayees();
  initCash();
  logEvent({ kind: "system", title: "Demo reset", detail: "Fresh contracts and seeded positions" });
}
