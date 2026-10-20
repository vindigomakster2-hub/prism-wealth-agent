import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
export const PORT = Number(process.env.PORT ?? 8787);
export const ARTIFACTS_DIR = path.resolve(here, "../../contracts/artifacts/contracts");
export const DEPLOYMENTS_FILE = path.resolve(here, "../.deployments.json");

/** Hardhat's public test mnemonic. These keys are test-only and must never hold real funds. */
export const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/** Account index for each role on the local chain. */
export const ROLE_INDEX = {
  admin: 0, // deploys protocol contracts, owns the oracle (stands in for the market)
  owner: 1, // the user's own key: unrestricted control of the AgentWallet
  agent: 2, // the AI's scoped session key
  attestor: 3, // signs Proof-of-Wealth attestations
  liquidator: 4, // market liquidation bot
  twin: 5, // passive borrower with the same starting position, no agent
  landlord: 6, // whitelisted payee
  attacker: 7, // address used by the prompt-injection demo
} as const;

/** AI provider: Groq (OpenAI-compatible API). Without GROQ_API_KEY the offline rules agent is used. */
export const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
export const LLM_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
/** Groq lists no production model with image input; set this to one that accepts images to enable receipt photos. */
export const VISION_MODEL = process.env.GROQ_VISION_MODEL ?? "";
export const LLM_ENABLED = process.env.ABANQ_LLM !== "off" && Boolean(GROQ_API_KEY);

export const TICK_MS = 4000;
export const ETH_START_PRICE = 3400;
