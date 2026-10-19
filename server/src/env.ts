/**
 * Loads keys from the repo-root `.env` (see `.env.example`) before any module reads process.env.
 * Imported first by index.ts. Variables already set in the shell win; a missing file is fine.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(file)) process.loadEnvFile(file);
