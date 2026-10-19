import { randomUUID } from "node:crypto";
import { LLM_ENABLED, VISION_MODEL } from "../config.js";
import { extractWithTool } from "../agent/groq.js";
import { classifyItem } from "./classifier.js";
import { CATS, cash, type ReceiptDraft, type ReceiptItem, type SpendCat } from "./state.js";

const id = () => randomUUID().slice(0, 8);

/** Two receipts from the same store a week apart: the second one shows what the agent learned. */
const SAMPLES: Array<Omit<ReceiptDraft, "id" | "status" | "createdAt" | "via">> = [
  {
    merchant: "ГИПЕРМАРКЕТ ЛЕНТА №118",
    date: "",
    currency: "RUB",
    total: 0,
    items: [
      ["МОЛ ПАСТ ПРОСТОКВ 3.2% 930Г", "Milk 3.2%, 930 g", 1, 109.99],
      ["ХЛЕБ БОРОДИНСК НАРЕЗ 300Г", "Borodinsky bread, sliced", 1, 64.9],
      ["ЯЙЦО КУР С0 10ШТ", "Eggs C0, 10 pcs", 1, 129],
      ["ШАМП H&S ОСН УХОД 400МЛ", "Head & Shoulders shampoo", 1, 459],
      ["З/П COLGATE ТОТАЛ 75МЛ", "Colgate Total toothpaste", 1, 219],
      ["ФУТБ МУЖ ХЛОП Р.50", "Men's cotton T-shirt", 1, 799],
      ["ГУБКА Д/ПОСУДЫ 5ШТ", "Dish sponges, 5 pcs", 1, 89],
      ["ЧИПСЫ LAYS КРАБ 140Г", "Lay's crab chips", 2, 149],
      ["ПАКЕТ ЛЕНТА", "Carrier bag", 1, 9.99],
    ].map(([raw, name, qty, price]) => ({ id: "", raw: raw as string, name: name as string, qty: qty as number, price: price as number, category: null, source: null })),
  },
  {
    merchant: "ГИПЕРМАРКЕТ ЛЕНТА №118",
    date: "",
    currency: "RUB",
    total: 0,
    items: [
      ["МОЛ ПАСТ ПРОСТОКВ 3.2% 930Г", "Milk 3.2%, 930 g", 2, 109.99],
      ["ХЛЕБ БОРОДИНСК НАРЕЗ 300Г", "Borodinsky bread, sliced", 1, 64.9],
      ["СЫР ГАУДА 45% 200Г", "Gouda cheese 45%", 1, 239],
      ["ЧИПСЫ LAYS КРАБ 140Г", "Lay's crab chips", 1, 149],
      ["ГУБКА Д/ПОСУДЫ 5ШТ", "Dish sponges, 5 pcs", 1, 89],
      ["ГЕЛЬ Д/ДУША NIVEA 250МЛ", "Nivea shower gel", 1, 279],
      ["БАТАРЕЙКИ GP AA 4ШТ", "GP AA batteries, 4 pcs", 1, 329],
      ["ПАКЕТ ЛЕНТА", "Carrier bag", 1, 9.99],
    ].map(([raw, name, qty, price]) => ({ id: "", raw: raw as string, name: name as string, qty: qty as number, price: price as number, category: null, source: null })),
  },
];

function finalize(d: Omit<ReceiptDraft, "id" | "status" | "createdAt">): ReceiptDraft {
  const items: ReceiptItem[] = d.items.map((it) => {
    const known = classifyItem(it.raw);
    // Memory beats the AI's guess: the user already taught us this item.
    const useKnown = known.source === "memory" || !it.category;
    return { ...it, id: id(), category: useKnown ? known.category : it.category, source: useKnown ? known.source : it.source };
  });
  const total = Math.round(items.reduce((a, i) => a + i.qty * i.price, 0) * 100) / 100;
  const draft: ReceiptDraft = { ...d, id: id(), items, total: d.total || total, date: d.date || new Date().toISOString().slice(0, 10), status: "draft", createdAt: Date.now() };
  cash.receipts.unshift(draft);
  cash.receipts = cash.receipts.slice(0, 20);
  return draft;
}

export function sampleReceipt(n: 1 | 2): ReceiptDraft {
  const s = SAMPLES[n - 1];
  return finalize({ ...s, items: s.items.map((i) => ({ ...i })), via: "sample" });
}

const CAT_IDS = Object.keys(CATS).filter((c) => CATS[c as SpendCat].kind === "spend");

export async function scanWithVision(imageBase64: string, mediaType: string): Promise<ReceiptDraft> {
  if (!LLM_ENABLED || !VISION_MODEL) {
    throw new Error("Receipt photos need GROQ_API_KEY and GROQ_VISION_MODEL (a Groq model with image input). Try a sample receipt meanwhile.");
  }
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mediaType)) throw new Error("Upload a PNG, JPEG, WEBP or GIF photo");
  const out = await extractWithTool<{
    merchant: string;
    date: string;
    currency: string;
    total: number;
    items: Array<{ raw: string; name: string; qty: number; price: number; category: string }>;
  }>(
    "You read shopping receipts. Receipts often use cryptic abbreviations (e.g. 'МОЛ ПАСТ 3.2%' is pasteurised milk). Transcribe every line item exactly as printed in `raw`, expand it into a clear `name`, and pick the most likely category, or 'unknown' if you are unsure. Prices are per unit. Respond only by calling record_receipt.",
    [
      { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
      { type: "text", text: "Extract this receipt with record_receipt." },
    ],
    {
      name: "record_receipt",
      description: "Record the parsed receipt.",
      parameters: {
        type: "object",
        properties: {
          merchant: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD, or empty if not printed" },
          currency: { type: "string", description: "ISO code, e.g. RUB, CZK, EUR, USD" },
          total: { type: "number" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                raw: { type: "string" },
                name: { type: "string" },
                qty: { type: "number" },
                price: { type: "number" },
                category: { type: "string", enum: [...CAT_IDS, "unknown"] },
              },
              required: ["raw", "name", "qty", "price", "category"],
            },
          },
        },
        required: ["merchant", "currency", "total", "items"],
      },
    },
    VISION_MODEL,
  );
  return finalize({
    merchant: out.merchant || "Receipt",
    date: /^\d{4}-\d{2}-\d{2}$/.test(out.date ?? "") ? out.date : "",
    currency: (out.currency || "USD").toUpperCase(),
    total: Number(out.total) || 0,
    via: "ai",
    items: (out.items ?? []).map((i) => ({
      id: "",
      raw: String(i.raw),
      name: String(i.name || i.raw),
      qty: Number(i.qty) || 1,
      price: Number(i.price) || 0,
      category: CAT_IDS.includes(i.category) ? (i.category as SpendCat) : null,
      source: CAT_IDS.includes(i.category) ? "ai" : null,
    })),
  });
}
