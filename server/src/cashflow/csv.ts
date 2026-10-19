/**
 * Statement import. Detects the delimiter, the bank/broker profile and the column mapping from the
 * header row; the UI lets the user correct the mapping before anything is imported.
 */

export interface ParsedCsv {
  delimiter: string;
  headers: string[];
  rows: string[][];
}

export interface TxnMapping {
  date: number;
  amount: number;
  currency: number | null;
  description: number;
  counterparty: number | null;
  category: number | null;
  status: number | null;
  externalId: number | null;
}

export interface PositionMapping {
  name: number;
  symbol: number | null;
  quantity: number;
  price: number | null;
  value: number | null;
  currency: number | null;
}

export type Detection =
  | { kind: "transactions"; profile: string; label: string; mapping: TxnMapping }
  | { kind: "positions"; profile: string; label: string; mapping: PositionMapping };

export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  const first = clean.split("\n")[0] ?? "";
  const counts = [";", ",", "\t"].map((d) => ({ d, n: first.split(d).length }));
  const delimiter = counts.sort((a, b) => b.n - a.n)[0].d;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n") {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field.trim());
  rows.push(row);
  const [headers, ...data] = rows;
  return { delimiter, headers: headers.map((h) => h.trim()), rows: data.filter((r) => r.some((c) => c !== "")) };
}

const norm = (h: string) => h.toLowerCase().replace(/["']/g, "").trim();
function find(headers: string[], aliases: string[]): number | null {
  const hs = headers.map(norm);
  for (const a of aliases) {
    const i = hs.indexOf(a);
    if (i >= 0) return i;
  }
  for (const a of aliases) {
    const i = hs.findIndex((h) => h.includes(a));
    if (i >= 0) return i;
  }
  return null;
}

export function detect(headers: string[], filename = ""): Detection | null {
  const hs = headers.map(norm);
  const fname = filename.toLowerCase();

  const qty = find(headers, ["quantity", "qty", "amount", "počet", "количество", "кол-во"]);
  const product = find(headers, ["product", "produkt", "name", "název", "наименование", "инструмент", "security"]);
  const date = find(headers, ["дата операции", "date", "datum", "transaction date", "booking date", "дата", "datum zaúčtování"]);
  if (date === null && qty !== null && product !== null) {
    return {
      kind: "positions",
      profile: hs.some((h) => h.includes("symbol/isin")) ? "degiro" : "positions",
      label: hs.some((h) => h.includes("symbol/isin")) ? "DEGIRO portfolio export" : "Broker positions (generic)",
      mapping: {
        name: product,
        symbol: find(headers, ["symbol/isin", "isin", "symbol", "ticker", "тикер"]),
        quantity: qty,
        price: find(headers, ["closing", "close", "price", "cena", "цена", "last"]),
        value: find(headers, ["value in eur", "local value", "market value", "value", "hodnota", "стоимость"]),
        currency: find(headers, ["currency", "měna", "валюта"]),
      },
    };
  }

  const amount = find(headers, ["сумма операции", "objem", "částka", "amount", "сумма в валюте счёта", "сумма в валюте счета", "сумма"]);
  const description = find(headers, ["описание", "description", "merchant", "zpráva pro příjemce", "назначение платежа", "назначение", "poznámka", "details"]);
  if (date === null || amount === null) return null;

  let profile = "generic";
  let label = "Generic bank CSV";
  if (hs.includes("кэшбэк") || (hs.includes("номер карты") && hs.includes("дата платежа"))) {
    profile = "tbank";
    label = "T-Bank (Тинькофф) statement";
  } else if (hs.includes("id operace") || hs.includes("objem")) {
    profile = "fio";
    label = "Fio banka statement";
    // Card payments carry the merchant in "Poznámka"; transfers in the counterparty name.
    const note = find(headers, ["poznámka"]);
    if (note !== null) return { kind: "transactions", profile, label, mapping: {
      date,
      amount,
      currency: find(headers, ["měna"]),
      description: note,
      counterparty: find(headers, ["název protiúčtu"]),
      category: null,
      status: null,
      externalId: find(headers, ["id operace"]),
    } };
  } else if (fname.includes("sber") || hs.some((h) => h.includes("сумма в валюте счёта") || h.includes("сумма в валюте счета"))) {
    profile = "sber";
    label = "Sber statement (CSV)";
  }
  return {
    kind: "transactions",
    profile,
    label,
    mapping: {
      date,
      amount,
      currency: find(headers, ["валюта операции", "валюта", "currency", "měna"]),
      description: description ?? find(headers, ["název protiúčtu", "counterparty"]) ?? amount,
      counterparty: find(headers, ["název protiúčtu", "counterparty", "получатель", "контрагент"]),
      category: find(headers, ["категория", "category", "kategorie"]),
      status: find(headers, ["статус", "status"]),
      externalId: find(headers, ["id operace", "id операции", "transaction id", "external id"]),
    },
  };
}

export function parseDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [mm, dd] = a > 12 ? [b, a] : [a, b];
    return `${m[3]}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  return null;
}

/** "-1 290,00", "1,290.50", "−84.2", "USD 1234.56" → number. */
export function parseAmount(s: string): number | null {
  let t = s.replace(/[\s ]/g, "").replace(/[−–]/g, "-").replace(/[^\d,.\-+]/g, "");
  if (!t) return null;
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    t = lastComma > lastDot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (lastComma >= 0) {
    t = /,\d{1,2}$/.test(t) ? t.replace(/,/g, (m, i) => (i === lastComma ? "." : "")) : t.replace(/,/g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function currencyIn(s: string): string | null {
  const m = s.toUpperCase().match(/\b(USD|EUR|RUB|CZK|KZT|GBP)\b/);
  if (m) return m[1];
  if (s.includes("₽")) return "RUB";
  if (s.includes("€")) return "EUR";
  if (s.includes("$")) return "USD";
  if (/kč/i.test(s)) return "CZK";
  return null;
}
