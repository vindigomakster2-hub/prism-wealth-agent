import type { RawTxn } from "./seed.js";

/**
 * Real open-banking connector (PSD2 AIS) via GoCardless Bank Account Data, which acts as the
 * licensed AISP across the EEA (incl. Czech banks: ČSOB, KB, Fio, MONETA, Česká spořitelna).
 * Enabled when GOCARDLESS_SECRET_ID / GOCARDLESS_SECRET_KEY are set. Flow:
 *   institutions → requisition (user consents in the bank's UI) → accounts → transactions.
 * Read-only by construction; Abanq never sees bank credentials. Some banks allow only ~4 calls
 * per account per day, so sync on demand and cache.
 */

const BASE = "https://bankaccountdata.gocardless.com/api/v2";
const SECRET_ID = process.env.GOCARDLESS_SECRET_ID ?? "";
const SECRET_KEY = process.env.GOCARDLESS_SECRET_KEY ?? "";

let token: { access: string; exp: number } | null = null;
export const requisitions: Array<{ id: string; institutionId: string; link: string; status: string; createdAt: number; accounts: string[] }> = [];

export const gocardlessConfigured = () => Boolean(SECRET_ID && SECRET_KEY);

async function auth(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.access;
  const r = await fetch(`${BASE}/token/new/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ secret_id: SECRET_ID, secret_key: SECRET_KEY }),
  });
  const j = (await r.json()) as { access?: string; access_expires?: number; detail?: string; summary?: string };
  if (!r.ok || !j.access) throw new Error(j.detail ?? j.summary ?? `GoCardless auth failed (${r.status})`);
  token = { access: j.access, exp: Date.now() + (j.access_expires ?? 3600) * 1000 };
  return j.access;
}

async function gc<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  if (!gocardlessConfigured()) throw new Error("GoCardless is not configured: set GOCARDLESS_SECRET_ID and GOCARDLESS_SECRET_KEY");
  const access = await auth();
  const r = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", accept: "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const j = (await r.json()) as T & { detail?: string; summary?: string };
  if (!r.ok) throw new Error(j.detail ?? j.summary ?? `GoCardless ${r.status}`);
  return j;
}

export function listInstitutions(country: string) {
  return gc<Array<{ id: string; name: string; bic?: string; logo?: string; transaction_total_days?: string }>>(`/institutions/?country=${encodeURIComponent(country)}`);
}

export async function createLink(institutionId: string, redirect: string) {
  const r = await gc<{ id: string; link: string; status: string }>("/requisitions/", {
    method: "POST",
    body: { redirect, institution_id: institutionId, reference: `abanq-${Date.now()}`, user_language: "EN" },
  });
  requisitions.unshift({ id: r.id, institutionId, link: r.link, status: r.status, createdAt: Date.now(), accounts: [] });
  return r;
}

interface GcTxn {
  transactionId?: string;
  internalTransactionId?: string;
  bookingDate?: string;
  valueDate?: string;
  transactionAmount: { amount: string; currency: string };
  creditorName?: string;
  debtorName?: string;
  remittanceInformationUnstructured?: string;
  remittanceInformationUnstructuredArray?: string[];
  additionalInformation?: string;
}

/** Pulls booked transactions for every account behind a requisition, normalised to RawTxn. */
export async function fetchRequisition(requisitionId: string): Promise<RawTxn[]> {
  const req = await gc<{ id: string; status: string; accounts: string[]; institution_id: string }>(`/requisitions/${requisitionId}/`);
  const entry = requisitions.find((x) => x.id === requisitionId);
  if (entry) {
    entry.status = req.status;
    entry.accounts = req.accounts;
  }
  if (req.status !== "LN") throw new Error(`Bank consent not completed yet (status ${req.status}). Finish the bank's authorisation page first.`);
  const out: RawTxn[] = [];
  for (const acc of req.accounts) {
    const t = await gc<{ transactions: { booked: GcTxn[] } }>(`/accounts/${acc}/transactions/`);
    for (const x of t.transactions.booked ?? []) {
      const description =
        x.creditorName ?? x.debtorName ?? x.remittanceInformationUnstructured ?? x.remittanceInformationUnstructuredArray?.join(" ") ?? x.additionalInformation ?? "Bank transaction";
      out.push({
        date: x.bookingDate ?? x.valueDate ?? new Date().toISOString().slice(0, 10),
        description,
        amount: Number(x.transactionAmount.amount),
        currency: x.transactionAmount.currency,
        account: `${req.institution_id} · ${acc.slice(0, 8)}`,
        externalId: x.transactionId ?? x.internalTransactionId ?? `${acc}-${x.bookingDate}-${x.transactionAmount.amount}-${description}`,
      });
    }
  }
  return out;
}
