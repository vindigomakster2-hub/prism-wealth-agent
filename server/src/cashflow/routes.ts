import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, NextFunction, Request, Response } from "express";
import { logEvent } from "../store.js";
import { addAsset, addDebt, answer, cashState, commitCsv, confirmReceipt, previewCsv, setBudgets, syncNow } from "./engine.js";
import { createLink, fetchRequisition, gocardlessConfigured, listInstitutions } from "./gocardless.js";
import { sampleReceipt, scanWithVision } from "./receipts.js";
import { cash } from "./state.js";
import { ingest } from "./engine.js";

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => Promise<void>;

const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../samples");
const SAMPLE_FILES = ["tbank-statement.csv", "sber-statement.csv", "fio-statement.csv", "degiro-portfolio.csv"];

const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

export function registerCashRoutes(app: Express, wrap: Wrap) {
  app.get("/api/cash", wrap(() => cashState()));

  app.post(
    "/api/cash/answer",
    wrap((req) => {
      const { txnId, category } = req.body ?? {};
      if (!txnId || !category) throw bad("txnId and category are required");
      return answer(String(txnId), String(category));
    }),
  );

  app.post("/api/cash/sync", wrap((req) => syncNow(Math.max(1, Math.min(20, Number(req.body?.count ?? 3))))));
  app.post(
    "/api/cash/autosync",
    wrap((req) => {
      cash.autoSync = Boolean(req.body?.on);
      return { autoSync: cash.autoSync };
    }),
  );

  // ----------------------------------------------------------- CSV import
  app.get(
    "/api/cash/samples/:name",
    wrap((req, res) => {
      const name = String(req.params.name);
      if (!SAMPLE_FILES.includes(name)) throw Object.assign(new Error("Unknown sample"), { status: 404 });
      res.type("text/csv").send(fs.readFileSync(path.join(SAMPLES_DIR, name), "utf8"));
    }),
  );
  app.post(
    "/api/cash/import/preview",
    wrap((req) => {
      const { filename, content, mapping } = req.body ?? {};
      if (typeof content !== "string" || !content.trim()) throw bad("content is required");
      if (content.length > 5_000_000) throw bad("File too large (5 MB max)");
      return previewCsv(String(filename ?? "statement.csv"), content, mapping);
    }),
  );
  app.post(
    "/api/cash/import/commit",
    wrap((req) => {
      const { filename, content, mapping } = req.body ?? {};
      if (typeof content !== "string" || !content.trim()) throw bad("content is required");
      return commitCsv(String(filename ?? "statement.csv"), content, mapping);
    }),
  );

  // ----------------------------------------------------------- receipts
  app.post(
    "/api/cash/receipts/scan",
    wrap(async (req) => {
      const { sample, imageBase64, mediaType } = req.body ?? {};
      if (sample === 1 || sample === 2) return sampleReceipt(sample);
      if (typeof imageBase64 !== "string" || !imageBase64) throw bad("imageBase64 or sample is required");
      return scanWithVision(imageBase64.replace(/^data:[^,]+,/, ""), String(mediaType ?? "image/jpeg"));
    }),
  );
  app.post(
    "/api/cash/receipts/:id/confirm",
    wrap((req) => confirmReceipt(String(req.params.id), Array.isArray(req.body?.items) ? req.body.items : [])),
  );

  // ----------------------------------------------------------- budgets, debts, assets
  app.put("/api/cash/budgets", wrap((req) => setBudgets(req.body?.rules)));
  app.post("/api/cash/debts", wrap((req) => addDebt(req.body ?? {})));
  app.delete(
    "/api/cash/debts/:id",
    wrap((req) => {
      cash.debts = cash.debts.filter((d) => d.id !== req.params.id);
      return { ok: true };
    }),
  );
  app.post("/api/cash/assets", wrap((req) => addAsset(req.body ?? {})));
  app.delete(
    "/api/cash/assets/:id",
    wrap((req) => {
      cash.assets = cash.assets.filter((a) => a.id !== req.params.id);
      return { ok: true };
    }),
  );
  app.post(
    "/api/cash/insights/:id/dismiss",
    wrap((req) => {
      cash.dismissedInsights.add(String(req.params.id));
      return { ok: true };
    }),
  );

  // ----------------------------------------------------------- real open banking (GoCardless, PSD2 AIS)
  app.get("/api/connect/gocardless/status", wrap(() => ({ configured: gocardlessConfigured() })));
  app.get("/api/connect/gocardless/institutions", wrap((req) => listInstitutions(String(req.query.country ?? "CZ").toUpperCase())));
  app.post(
    "/api/connect/gocardless/link",
    wrap((req) => {
      const institutionId = String(req.body?.institutionId ?? "");
      if (!institutionId) throw bad("institutionId is required");
      return createLink(institutionId, String(req.body?.redirect ?? "http://127.0.0.1:5173/#cashflow"));
    }),
  );
  app.post(
    "/api/connect/gocardless/sync",
    wrap(async (req) => {
      const raws = await fetchRequisition(String(req.body?.requisitionId ?? ""));
      const res = ingest(raws, "sync");
      logEvent({ kind: "info", title: `Bank sync: ${res.imported} new transactions`, detail: `${res.duplicates} already known, ${res.review} need your answer` });
      return res;
    }),
  );
}
