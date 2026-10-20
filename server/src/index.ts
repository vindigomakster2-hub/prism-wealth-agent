import "./env.js";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { LLM_ENABLED, LLM_MODEL, PORT, TICK_MS, VISION_MODEL } from "./config.js";
import { ensureWorld, errorReason, ownerCall } from "./chain.js";
import { persona, updatePersona } from "./data/persona.js";
import { parseStress, stressTargets, stressTest } from "./engine/risk.js";
import { tick } from "./agent/autopilot.js";
import { chatWithRules } from "./agent/fallback.js";
import { chatWithLLM, resetChat } from "./agent/llm.js";
import { approveProposal, parseAction, propose, rejectProposal } from "./agent/pipeline.js";
import type { Mandate } from "./agent/types.js";
import { crashEth, initPayees, injectAttack, recoverPrice, resetWorld, setPrice, warp } from "./demo.js";
import { snapshotState } from "./state.js";
import { logEvent, newId, store } from "./store.js";
import { answer, cashState, initCash, syncNow } from "./cashflow/engine.js";
import { registerCashRoutes } from "./cashflow/routes.js";
import { cash, resetCash } from "./cashflow/state.js";
import { askOnTelegram, notifyTelegram, setTelegramPrefs, startTelegram } from "./cashflow/telegram.js";
import { feedQueue } from "./cashflow/seed.js";

const app = express();

// The API can move money, so only the local app may call it.
// Host check blocks DNS-rebinding; the origin allow-list stops other websites in the same browser.
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
// ABANQ_ALLOWED_HOSTS opens the app to other devices (a LAN IP or a tunnel host). An entry starting with "."
// also matches its subdomains, the same rule Vite uses for allowedHosts.
const extraHosts = (process.env.ABANQ_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const isExtra = (hostname: string) => extraHosts.some((h) => (h.startsWith(".") ? hostname === h.slice(1) || hostname.endsWith(h) : hostname === h));
app.use((req, res, next) => {
  const host = String(req.headers.host ?? "").toLowerCase();
  if (LOCAL.test(host) || isExtra(host.replace(/:\d+$/, ""))) return next();
  res.status(421).json({ error: "Host not allowed" });
});
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin, curl, server-to-server
      try {
        const u = new URL(origin);
        cb(null, LOCAL.test(u.host) || isExtra(u.hostname.toLowerCase()));
      } catch {
        cb(null, false);
      }
    },
  }),
);
app.use((req, res, next) => {
  // Browsers send Origin on cross-site POSTs; refuse mutations from foreign pages outright.
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin) {
    try {
      const u = new URL(origin);
      if (!LOCAL.test(u.host) && !isExtra(u.hostname.toLowerCase())) {
        res.status(403).json({ error: "Cross-origin request refused" });
        return;
      }
    } catch {
      res.status(403).json({ error: "Cross-origin request refused" });
      return;
    }
  }
  next();
});
app.use(express.json({ limit: "1mb" }));

let ready = false;
let startupError: string | null = null;

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      next(e);
    }
  };

app.use("/api", (req, res, next) => {
  if (!ready && req.path !== "/health") {
    res.status(503).json({ error: startupError ?? "Starting up: waiting for the local chain" });
    return;
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ready, error: startupError, llm: LLM_ENABLED });
});

function history(netWorth: number, liquid: number) {
  const labels: string[] = [];
  const nw: number[] = [];
  const lq: number[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push(d.toLocaleString("en-US", { month: "short" }));
    const k = (11 - i) / 11;
    const wiggle = Math.sin((11 - i) * 1.35) * 0.018 + Math.cos((11 - i) * 0.7) * 0.01;
    nw.push(i === 0 ? netWorth : netWorth * (0.84 + 0.16 * k) * (1 + wiggle));
    lq.push(i === 0 ? liquid : liquid * (0.9 + 0.1 * k) * (1 - wiggle * 0.6));
  }
  return { labels, netWorth: nw, liquid: lq };
}

app.get(
  "/api/state",
  wrap(async () => {
    const { chain, risk, credit } = await snapshotState();
    return {
      persona,
      llm: { enabled: LLM_ENABLED, model: LLM_MODEL, provider: "Groq", vision: Boolean(VISION_MODEL) },
      settings: store.settings,
      sources: store.sources.map((s) => ({
        ...s,
        transactions: s.transactions.slice(0, 8),
        total: s.holdings.reduce((a, h) => a + h.valueUsd, 0) - s.liabilities.reduce((a, l) => a + l.balanceUsd, 0),
      })),
      chain,
      risk,
      credit,
      mandate: store.mandate,
      payees: store.payees,
      proposals: store.proposals.slice(0, 80),
      events: store.events.slice(0, 80),
      chat: store.chatLog,
      history: history(risk.totals.netWorth, risk.totals.liquidSameWeek),
      live: store.liveSeries,
      demo: { ...store.demo, autopilotRunning: store.autopilotRunning },
      cashBrief: { review: cash.txns.filter((t) => t.status === "review").length, safeToSpend: cashState().month.safeToSpend.amount },
      blastRadius: {
        unknownAddressUsd: 0,
        payeesPerDayUsd: chain.agentKey.dailyLimit,
        remainingTodayUsd: chain.agentKey.remainingToday,
        offchainDailyTransferUsd: store.mandate.dailyTransferLimitUsd,
        healthFloor: chain.agentKey.minHealthFactor,
      },
    };
  }),
);

/** Full backup: every input, the on-chain snapshot and the complete audit trail, in one JSON file. */
app.get(
  "/api/export",
  wrap(async (_req, res) => {
    const { chain, risk, credit } = await snapshotState();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Disposition", `attachment; filename="abanq-backup-${stamp}.json"`);
    return {
      format: "abanq-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      persona,
      sources: store.sources,
      mandate: store.mandate,
      payees: store.payees,
      onchain: chain,
      summary: {
        netWorth: risk.totals.netWorth,
        riskScore: risk.riskScore,
        capitalAtRiskPct: risk.capitalAtRiskPct,
        cashflow: risk.cashflow,
        creditScore: credit.score,
        tier: credit.tier,
        findings: risk.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title })),
      },
      auditTrail: store.proposals,
      events: store.events,
      chat: store.chatLog,
    };
  }),
);

app.post(
  "/api/sources/:id/connection",
  wrap((req) => {
    const s = store.sources.find((x) => x.id === req.params.id);
    if (!s) throw Object.assign(new Error("Unknown source"), { status: 404 });
    s.connected = Boolean(req.body?.connected);
    s.lastSync = Date.now();
    logEvent({ kind: "info", title: `${s.institution} ${s.connected ? "connected" : "disconnected"}`, detail: s.connectMethod });
    return { ok: true };
  }),
);

app.post(
  "/api/sources/:id/sync",
  wrap((req) => {
    const s = store.sources.find((x) => x.id === req.params.id);
    if (!s) throw Object.assign(new Error("Unknown source"), { status: 404 });
    s.lastSync = Date.now();
    return { ok: true };
  }),
);

app.post(
  "/api/actions",
  wrap(async (req) => {
    const action = parseAction(req.body?.action);
    return propose(action, "user", String(req.body?.reason ?? "Requested in the app"));
  }),
);

registerCashRoutes(app, wrap);

/** GDPR-style "delete my data": revokes every connection and wipes all off-chain data and chat. */
app.post(
  "/api/privacy/delete-all",
  wrap(() => {
    for (const s of store.sources) {
      s.connected = false;
      s.transactions = [];
    }
    store.sources = store.sources.filter((s) => !s.selfReported);
    resetCash();
    store.chatLog = [];
    resetChat();
    logEvent({ kind: "system", title: "All off-chain data deleted", detail: "Connections revoked; on-chain records are public and immutable by nature" });
    return { ok: true };
  }),
);

app.post("/api/proposals/:id/approve", wrap((req) => approveProposal(String(req.params.id))));
app.post("/api/proposals/:id/reject", wrap((req) => rejectProposal(String(req.params.id))));

app.put(
  "/api/mandate",
  wrap((req) => {
    const body = (req.body ?? {}) as Partial<Mandate>;
    const m = store.mandate;
    const num = (v: unknown, lo: number, hi: number, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
    };
    if (body.autonomy !== undefined) m.autonomy = num(body.autonomy, 0, 3, m.autonomy) as Mandate["autonomy"];
    if (body.minHealthFactor !== undefined) m.minHealthFactor = num(body.minHealthFactor, 1.25, 3, m.minHealthFactor);
    if (body.rescueHealthFactor !== undefined) m.rescueHealthFactor = num(body.rescueHealthFactor, 1.05, 2.5, m.rescueHealthFactor);
    if (body.targetHealthFactor !== undefined) m.targetHealthFactor = num(body.targetHealthFactor, 1.2, 3, m.targetHealthFactor);
    if (body.maxBorrowPerActionUsd !== undefined) m.maxBorrowPerActionUsd = num(body.maxBorrowPerActionUsd, 0, 1e6, m.maxBorrowPerActionUsd);
    if (body.autoApproveLimitUsd !== undefined) m.autoApproveLimitUsd = num(body.autoApproveLimitUsd, 0, 1e6, m.autoApproveLimitUsd);
    if (body.dailyTransferLimitUsd !== undefined) m.dailyTransferLimitUsd = num(body.dailyTransferLimitUsd, 0, 1e6, m.dailyTransferLimitUsd);
    if (body.minWalletReserveUsd !== undefined) m.minWalletReserveUsd = num(body.minWalletReserveUsd, 0, 1e6, m.minWalletReserveUsd);
    if (body.maxSlippageBps !== undefined) m.maxSlippageBps = num(body.maxSlippageBps, 0, 1000, m.maxSlippageBps);
    if (body.allowed) for (const [k, v] of Object.entries(body.allowed)) if (k in m.allowed) m.allowed[k as keyof Mandate["allowed"]] = Boolean(v);
    if (body.playbooks) for (const [k, v] of Object.entries(body.playbooks)) if (k in m.playbooks) m.playbooks[k as keyof Mandate["playbooks"]] = Boolean(v);
    if (body.alerts) {
      if (body.alerts.maxCapitalAtRiskPct !== undefined) m.alerts.maxCapitalAtRiskPct = num(body.alerts.maxCapitalAtRiskPct, 5, 100, m.alerts.maxCapitalAtRiskPct);
      if (body.alerts.idleCashUsd !== undefined) m.alerts.idleCashUsd = num(body.alerts.idleCashUsd, 0, 1e6, m.alerts.idleCashUsd);
    }
    if (m.targetHealthFactor <= m.rescueHealthFactor) m.targetHealthFactor = Math.round((m.rescueHealthFactor + 0.3) * 100) / 100;
    return m;
  }),
);

app.post(
  "/api/wallet/pause",
  wrap(async (req) => {
    const paused = Boolean(req.body?.paused);
    const hash = await ownerCall("setAgentPaused", [paused]);
    logEvent({ kind: "system", title: paused ? "Agent key paused by owner" : "Agent key resumed by owner", detail: "Signed with the owner key", txHash: hash });
    return { ok: true, hash };
  }),
);

app.post(
  "/api/stress",
  wrap(async (req) => {
    const { chain, risk } = await snapshotState();
    return stressTest(risk.holdings, risk.liabilities, chain, parseStress(req.body ?? {}));
  }),
);

app.get(
  "/api/stress/targets",
  wrap(async () => {
    const { risk } = await snapshotState();
    return stressTargets(risk.holdings, risk.liabilities);
  }),
);

app.get("/api/scenarios", wrap(() => store.scenarios));
app.put(
  "/api/scenarios",
  wrap((req) => {
    const list = Array.isArray(req.body?.scenarios) ? req.body.scenarios : null;
    if (!list) throw Object.assign(new Error("scenarios must be an array"), { status: 400 });
    store.scenarios = list.slice(0, 30).map((x: Record<string, unknown>, i: number) => {
      const name = String(x.name ?? "").trim().slice(0, 60);
      if (!name) throw Object.assign(new Error("Every scenario needs a name"), { status: 400 });
      return { id: String(x.id || `s${Date.now()}-${i}`), name, builtIn: Boolean(x.builtIn), input: parseStress((x.input ?? {}) as Record<string, unknown>) };
    });
    return store.scenarios;
  }),
);

app.put("/api/profile", wrap((req) => updatePersona(req.body ?? {})));
app.get("/api/settings", wrap(() => store.settings));
app.put(
  "/api/settings",
  wrap((req) => {
    const b = req.body ?? {};
    if (b.telegramQuestions !== undefined) store.settings.telegramQuestions = Boolean(b.telegramQuestions);
    if (b.telegramAlerts !== undefined) store.settings.telegramAlerts = Boolean(b.telegramAlerts);
    setTelegramPrefs({ questions: store.settings.telegramQuestions, alerts: store.settings.telegramAlerts });
    return store.settings;
  }),
);

app.post(
  "/api/chat",
  wrap(async (req) => {
    const message = String(req.body?.message ?? "").trim().slice(0, 4000);
    if (!message) throw Object.assign(new Error("Empty message"), { status: 400 });
    store.chatLog.push({ id: newId(), role: "user", text: message, at: Date.now(), proposalIds: [] });
    let reply: { text: string; proposalIds: string[] };
    let engine: "llm" | "rules" = "rules";
    if (LLM_ENABLED) {
      try {
        reply = await chatWithLLM(message);
        engine = "llm";
      } catch (e) {
        console.error("[llm]", e);
        reply = await chatWithRules(message);
        reply.text = `_The AI provider is unavailable (${errorReason(e)}), so this answer comes from offline mode._\n\n${reply.text}`;
      }
    } else {
      reply = await chatWithRules(message);
    }
    const turn = { id: newId(), role: "assistant" as const, text: reply.text, at: Date.now(), proposalIds: reply.proposalIds, engine };
    store.chatLog.push(turn);
    return turn;
  }),
);

app.post(
  "/api/chat/reset",
  wrap(() => {
    store.chatLog = [];
    resetChat();
    return { ok: true };
  }),
);

// ------------------------------------------------------------------ demo lab
app.post(
  "/api/demo/crash",
  wrap((req) => {
    if (store.demo.crashing) throw Object.assign(new Error("A sell-off is already running"), { status: 409 });
    const pct = Math.max(5, Math.min(80, Number(req.body?.pct ?? 35)));
    crashEth(pct).catch((e) => logEvent({ kind: "warning", title: "Sell-off aborted", detail: errorReason(e) }));
    return { started: true };
  }),
);
app.post("/api/demo/price", wrap((req) => setPrice(Math.max(1, Number(req.body?.usd ?? 3400)))));
app.post("/api/demo/recover", wrap(() => recoverPrice()));
app.post("/api/demo/warp", wrap((req) => warp(Math.max(1, Math.min(400, Number(req.body?.days ?? 31))))));
app.post("/api/demo/inject", wrap(() => injectAttack()));
app.post("/api/demo/reset", wrap(() => resetWorld()));
app.post("/api/demo/tick", wrap(() => tick()));
app.post(
  "/api/demo/autopilot",
  wrap((req) => {
    store.autopilotRunning = Boolean(req.body?.running);
    return { running: store.autopilotRunning };
  }),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number })?.status ?? 400;
  res.status(status).json({ error: errorReason(err) });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[server] Abanq API on http://127.0.0.1:${PORT} (LLM: ${LLM_ENABLED ? LLM_MODEL : "offline rules"})`);
  if (extraHosts.length) console.log(`[server] also open to: ${extraHosts.join(", ")} (ABANQ_ALLOWED_HOSTS)`);
});

(async () => {
  try {
    const { reused } = await ensureWorld();
    initPayees();
    initCash();
    ready = true;
    void startTelegram({
      onAnswer: async (txnId, category) => answer(txnId, category).text,
      onStart: async () => {
        for (const t of cash.txns.filter((x) => x.status === "review" && !x.askedVia.includes("telegram")).slice(0, 5)) {
          if (await askOnTelegram(t)) t.askedVia.push("telegram");
        }
      },
    });
    // Bank auto-sync: the demo feed releases one new transaction every 15 s while enabled.
    setInterval(() => {
      if (cash.autoSync && cash.feedCursor < feedQueue().length) syncNow(1);
      // Proactive alerts: each new insight goes to Telegram once (if linked and enabled in Settings).
      for (const i of cashState().insights) {
        if (i.kind === "review" || store.alertedInsights.has(i.id)) continue;
        store.alertedInsights.add(i.id);
        void notifyTelegram(`💡 ${i.title}\n${i.detail}`);
      }
    }, 15_000);
    logEvent({ kind: "system", title: reused ? "Reconnected to the local chain" : "Contracts deployed and demo state seeded" });
    console.log(`[server] world ${reused ? "reused" : "deployed"}; autopilot every ${TICK_MS} ms`);
    setInterval(() => {
      if (store.autopilotRunning) void tick();
    }, TICK_MS);
  } catch (e) {
    startupError = errorReason(e);
    console.error("[server] startup failed:", e);
  }
})();
