import type { CashTxn } from "./state.js";

/**
 * Telegram channel for the agent's questions. Set TELEGRAM_BOT_TOKEN (from @BotFather), start the
 * server, then send /start to the bot: that chat becomes the owner chat. Uses long polling, so it
 * works behind NAT/localhost with no webhook. Only the linked chat can answer.
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

export const tg = {
  configured: Boolean(TOKEN),
  chatId: (process.env.TELEGRAM_CHAT_ID ?? null) as string | null,
  username: null as string | null,
  lastError: null as string | null,
  sent: 0,
  answered: 0,
  /** Last messages the bot sent, mirrored in the UI as a phone preview. */
  outbox: [] as Array<{ at: number; text: string; buttons: Array<{ label: string; data: string }>; done?: string }>,
};

type AnswerHandler = (txnId: string, category: string) => Promise<string>;
type StartHandler = () => Promise<void>;
let onAnswer: AnswerHandler | null = null;
let onStart: StartHandler | null = null;

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as { ok: boolean; result: T; description?: string };
  if (!j.ok) throw new Error(j.description ?? `Telegram ${method} failed`);
  return j.result;
}

function remember(text: string, buttons: Array<{ label: string; data: string }>) {
  tg.outbox.unshift({ at: Date.now(), text, buttons });
  tg.outbox = tg.outbox.slice(0, 12);
}

/** Records the question in the outbox (always, for the in-app preview) and sends it if linked. */
export async function askOnTelegram(t: CashTxn): Promise<boolean> {
  if (!t.question) return false;
  const text = `🤔 ${t.question.text}`;
  const buttons = t.question.options.map((o) => ({ label: o.label, data: `c|${t.id}|${o.category}` }));
  remember(text, buttons);
  if (!TOKEN || !tg.chatId || !prefs.questions) return false;
  try {
    await call("sendMessage", {
      chat_id: tg.chatId,
      text,
      reply_markup: { inline_keyboard: buttons.map((b) => [{ text: b.label, callback_data: b.data }]) },
    });
    tg.sent++;
    return true;
  } catch (e) {
    tg.lastError = e instanceof Error ? e.message : String(e);
    return false;
  }
}

/** One-way alerts (insights). Only sent for real; not mirrored, so the in-app preview stays focused on questions. */
export async function notifyTelegram(text: string) {
  if (!TOKEN || !tg.chatId || !prefs.alerts) return;
  await call("sendMessage", { chat_id: tg.chatId, text })
    .then(() => tg.sent++)
    .catch((e) => (tg.lastError = String(e)));
}

const prefs = { questions: true, alerts: true };
/** Mirrors Settings → Notifications. */
export function setTelegramPrefs(p: { questions: boolean; alerts: boolean }) {
  prefs.questions = p.questions;
  prefs.alerts = p.alerts;
}

/** Marks a question as answered in the in-app mirror (answers can arrive from either side). */
export function markAnswered(txnId: string, confirmation: string) {
  for (const m of tg.outbox) if (m.buttons.some((b) => b.data.startsWith(`c|${txnId}|`))) m.done = confirmation;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number; text?: string } };
}

async function handle(u: Update) {
  if (u.message?.text?.startsWith("/start")) {
    if (tg.chatId && String(u.message.chat.id) !== tg.chatId) return;
    tg.chatId = String(u.message.chat.id);
    await call("sendMessage", { chat_id: tg.chatId, text: "Halo is linked ✅ I'll ask here when a transaction is unclear. Tap an answer and I'll remember it for that merchant." });
    await onStart?.();
    return;
  }
  const q = u.callback_query;
  if (!q?.data || !q.message) return;
  if (String(q.message.chat.id) !== tg.chatId) return; // only the linked owner chat may answer
  const [kind, txnId, category] = q.data.split("|");
  if (kind !== "c" || !onAnswer) return;
  let reply = "";
  try {
    reply = await onAnswer(txnId, category);
    tg.answered++;
  } catch (e) {
    reply = e instanceof Error ? e.message : String(e);
  }
  await call("answerCallbackQuery", { callback_query_id: q.id, text: reply.slice(0, 190) }).catch(() => undefined);
  await call("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `${q.message.text ?? ""}\n\n✅ ${reply}` }).catch(() => undefined);
}

export async function startTelegram(handlers: { onAnswer: AnswerHandler; onStart: StartHandler }) {
  onAnswer = handlers.onAnswer;
  onStart = handlers.onStart;
  if (!TOKEN) return;
  try {
    const me = await call<{ username: string }>("getMe", {});
    tg.username = me.username;
    console.log(`[telegram] bot @${me.username} ready${tg.chatId ? "" : ": send /start to link your chat"}`);
  } catch (e) {
    tg.lastError = e instanceof Error ? e.message : String(e);
    console.warn("[telegram]", tg.lastError);
    return;
  }
  let offset = 0;
  for (;;) {
    try {
      const updates = await call<Update[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handle(u).catch((e) => (tg.lastError = String(e)));
      }
    } catch (e) {
      tg.lastError = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
