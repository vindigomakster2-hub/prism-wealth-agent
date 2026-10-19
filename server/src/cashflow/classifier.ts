import { cash, type CashTxn, type QuestionOption, type SpendCat } from "./state.js";

/**
 * Categorisation: learned memory first (your past answers), then rules (EN / RU / CZ merchants),
 * then the bank's own category hint. Anything below the confidence bar goes to the review inbox
 * with a concrete question; your answer is remembered for every future transaction from that merchant.
 */

export const REVIEW_THRESHOLD = 0.7;

/** Stable merchant key: drop references, card numbers, dates and punctuation. */
export function merchantKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/\b(ref|ид|id|№|#)\s*[\w-]+/g, " ")
    .replace(/[*#№/\\_.,:;"'()\[\]-]+/g, " ")
    .replace(/\b\d[\d\s]*\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ");
}

/** Item key for receipts: same idea, also strips units and percentages. */
export function itemKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\d+([.,]\d+)?\s*(%|г|гр|кг|мл|л|шт|g|kg|ml|l|pcs)\b/g, " ")
    .replace(/[^a-zа-яёčďěňřšťůžáéíóúý&]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RULES: Array<{ cat: SpendCat; re: RegExp; conf?: number }> = [
  { cat: "salary", re: /salary|payroll|зарплат|заработн|mzda|výplata/ },
  { cat: "transfers", re: /between own accounts|own account|между своими|пополнение вклада|savings transfer|převod mezi/ },
  { cat: "groceries", re: /whole foods|trader joe|safeway|grocer|supermarket|пят[её]рочк|pyaterochka|магнит|перекр[её]ст|лента|lenta|ашан|auchan|вкусвилл|vkusvill|albert|lidl|billa|kaufland|tesco|penny|rohlik|rohlík|globus/ },
  { cat: "dining", re: /coffee|кофе|cafe|кафе|restaurant|ресторан|burger|бургер|pizza|пицц|starbucks|blue bottle|sweetgreen|shake shack|chipotle|kfc|mcdonald|вкусно и точка|шоколадниц|bistro|kavárna|restaurace|wolt|foodora|доставка еды/ },
  { cat: "transport", re: /uber|lyft|bolt|yandex go|яндекс go|такси|taxi|metro|метро|mta|dpp|lítačka|shell|bp |exxon|chevron|азс|лукойл|lukoil|газпромнефть|fuel|бензин|parking|парков/ },
  { cat: "housing", re: /rent|аренд|квартплат|oak street|nájem|properties/ },
  { cat: "utilities", re: /electric|con ed|pg&e|электро|жкх|internet|интернет|мтс|mts|билайн|beeline|мегафон|megafon|ростелеком|tele2|verizon|at&t|t-mobile|vodafone|o2 |čez|pre |innogy/ },
  { cat: "health", re: /pharm|cvs|walgreens|аптек|apteka|lékárna|dr\.?max|benu|clinic|клиник|стомат|dental|doctor|врач/ },
  { cat: "personal_care", re: /barber|парикмах|салон красоты|золотое яблоко|летуаль|letual|sephora|dm drogerie|rossmann|teta/ },
  { cat: "clothing", re: /zara|h&m|uniqlo|gap |nike|adidas|lamoda|ламода|спортмастер|sportmaster|одежд|reserved|about you/ },
  { cat: "subscriptions", re: /netflix|spotify|apple\.com|icloud|youtube|disney|hbo|кинопоиск|яндекс плюс|yandex plus|okko|chatgpt|openai|claude|anthropic|subscription|подписк|předplatné/ },
  { cat: "education", re: /course|курс|skillbox|udemy|coursera|школ|university|univerzit/ },
  { cat: "entertainment", re: /steam|playstation|xbox|cinema|кино|kino|концерт|theatre|театр|ticketmaster|goout/ },
  { cat: "travel", re: /hotel|отель|airbnb|booking\.com|aviasales|аэрофлот|aeroflot|ryanair|wizz|delta air|united air|ржд|rzd|regiojet|české dráhy/ },
  { cat: "debt_payment", re: /loan payment|loan pmt|card payment|погашение кредит|ипотек|mortgage|splátka|úvěr/ },
  { cat: "marketplace", re: /amazon|amzn|wildberries|wb |ozon|озон|aliexpress|яндекс маркет|alza|allegro|temu|shein/, conf: 0.55 },
  { cat: "private_debt", re: /zelle|venmo|cash app|перевод|сбп|sbp|p2p|card to card|с карты на карту|ип |ip |převod|okamžitá platba/, conf: 0.45 },
];

/** Bank-provided categories (T-Bank / Sber / Fio style) → ours. Used as a hint, not a verdict. */
const BANK_CATEGORY: Array<{ re: RegExp; cat: SpendCat }> = [
  { re: /супермаркет|продукт|potraviny/, cat: "groceries" },
  { re: /ресторан|фастфуд|кафе|restaurace/, cat: "dining" },
  { re: /транспорт|такси|топливо|азс|doprava/, cat: "transport" },
  { re: /аптек|медицин|zdraví/, cat: "health" },
  { re: /одежда|обувь|oblečení/, cat: "clothing" },
  { re: /связь|коммунал|energie/, cat: "utilities" },
  { re: /развлеч|кино|zábava/, cat: "entertainment" },
  { re: /красота/, cat: "personal_care" },
  { re: /путешеств|отел|авиа|cestování/, cat: "travel" },
  { re: /образован/, cat: "education" },
  { re: /пополнени|зарплат|příjem/, cat: "salary" },
];

const ITEM_RULES: Array<{ cat: SpendCat; re: RegExp }> = [
  { cat: "groceries", re: /мол|молок|кефир|сыр|хлеб|батон|яйц|кур|говяд|свин|овощ|фрукт|банан|яблок|томат|огур|картоф|масло|йогурт|творог|рис|макарон|кофе|чай|сок|вода|milk|bread|egg|cheese|chicken|banana|apple|mléko|chléb|sýr|vejce/ },
  { cat: "personal_care", re: /шамп|з\/п|зубн|мыло|гель д\/душ|гель для душ|дезод|крем|бритв|shampoo|toothpaste|soap|šampon/ },
  { cat: "clothing", re: /футб|носк|брюк|джинс|куртк|рубаш|шорт|t-shirt|socks|jeans|tričko|ponožky/ },
];

export interface Verdict {
  category: SpendCat | null;
  status: CashTxn["status"];
  confidence: number;
  reason: string;
}

export function classify(description: string, amount: number, bankCategory?: string): Verdict {
  const key = merchantKey(description);
  const learned = cash.merchantMemory.get(key);
  if (learned) return { category: learned, status: "learned", confidence: 0.99, reason: "Remembered from your earlier answer" };

  const text = ` ${description.toLowerCase()} `;
  if (amount > 0 && !/refund|возврат|vrácení/.test(text)) {
    const rule = RULES.find((r) => r.cat === "salary" && r.re.test(text));
    if (rule) return { category: "salary", status: "auto", confidence: 0.9, reason: "Rule: payroll keyword" };
    if (/transfer|перевод|převod|zelle|venmo/.test(text)) return { category: "transfers", status: "review", confidence: 0.4, reason: "Incoming transfer, purpose unknown" };
    return { category: "other_income", status: "review", confidence: 0.5, reason: "Unrecognised income" };
  }
  for (const r of RULES) {
    if (r.cat === "salary") continue;
    if (r.re.test(text)) {
      const conf = r.conf ?? 0.88;
      return { category: r.cat, status: conf >= REVIEW_THRESHOLD ? "auto" : "review", confidence: conf, reason: `Rule: matched "${text.match(r.re)?.[0].trim()}"` };
    }
  }
  if (bankCategory) {
    const hint = BANK_CATEGORY.find((b) => b.re.test(bankCategory.toLowerCase()));
    if (hint) return { category: hint.cat, status: "auto", confidence: 0.75, reason: `Bank category "${bankCategory}"` };
  }
  return { category: null, status: "review", confidence: 0.2, reason: "Unknown merchant" };
}

const opt = (category: SpendCat, label: string): QuestionOption => ({ category, label });

/** The question the agent asks (in the app and in Telegram) for an unclear transaction. */
export function questionFor(t: Pick<CashTxn, "description" | "amount" | "currency" | "date" | "category">): { text: string; options: QuestionOption[] } {
  const amt = `${Math.abs(t.amount).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${t.currency}`;
  const d = t.description.toLowerCase();
  if (t.amount > 0) {
    return {
      text: `You received ${amt} from "${t.description}" on ${t.date}. What was it?`,
      options: [opt("other_income", "Income (refund, side job)"), opt("transfers", "From my own account"), opt("private_debt", "Someone repaid me"), opt("gifts", "Gift")],
    };
  }
  if (t.category === "marketplace" || /amazon|amzn|wildberries|ozon|alza|aliexpress/.test(d)) {
    return {
      text: `${amt} at ${t.description} on ${t.date}. What did you buy?`,
      options: [opt("household", "Household goods"), opt("clothing", "Clothing"), opt("groceries", "Groceries"), opt("personal_care", "Personal care"), opt("other", "Electronics / other")],
    };
  }
  if (t.category === "private_debt" || /zelle|venmo|перевод|сбп|ип |ip |převod/.test(` ${d} `)) {
    return {
      text: `You sent ${amt} to "${t.description}" on ${t.date}. What was it for?`,
      options: [opt("private_debt", "Repaying a private loan"), opt("gifts", "Gift"), opt("other", "Paying for a service"), opt("transfers", "My own account")],
    };
  }
  return {
    text: `I don't recognise "${t.description}" (${amt}, ${t.date}). What is it?`,
    options: [opt("dining", "Café / restaurant"), opt("groceries", "Groceries"), opt("entertainment", "Entertainment"), opt("subscriptions", "Subscription"), opt("other", "Something else")],
  };
}

export function classifyItem(raw: string): { category: SpendCat | null; source: "memory" | "rule" | null } {
  const key = itemKey(raw);
  const learned = cash.itemMemory.get(key);
  if (learned) return { category: learned, source: "memory" };
  const text = raw.toLowerCase();
  const rule = ITEM_RULES.find((r) => r.re.test(text));
  return rule ? { category: rule.cat, source: "rule" } : { category: null, source: null };
}
