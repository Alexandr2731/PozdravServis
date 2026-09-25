import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

// Промокоды за отказ от заказа — вместо прежнего «половина стоимости баллами» (решение
// Александра 25.09.2026, knowledge/tasks.md ФЛОУ-1). Промокод — не текстовый код, а скидка,
// привязанная к Telegram-аккаунту клиента: бот сам применяет её при следующей покупке,
// передать её другому или использовать дважды нельзя. Скидка действует только на ту
// услугу, от которой клиент отказался. Тот же JSON-файл на диске, что orderStore.js, —
// временно, до БД (ДАННЫЕ-1).

// Условия по каждой услуге отдельно — для разных услуг скидка может быть разной.
// 50% и 30 дней — предварительно, пересмотреть после расчёта себестоимости.
export const PROMO_RULES = {
  greeting: { percent: 50, days: 30 },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const PROMOS_FILE = join(DATA_DIR, "promos.json");

function readAll() {
  if (!existsSync(PROMOS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PROMOS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(promos) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PROMOS_FILE, JSON.stringify(promos, null, 2), "utf8");
}

/** Выдаёт клиенту скидку на услугу по правилам PROMO_RULES. */
export function issuePromo({ userId, service, sourceOrderId }) {
  const rule = PROMO_RULES[service];
  if (!rule) throw new Error(`Нет правил промокода для услуги "${service}"`);
  const promoId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + rule.days * 24 * 60 * 60 * 1000).toISOString();
  const promos = readAll();
  promos[promoId] = {
    promoId,
    userId,
    service,
    percent: rule.percent,
    sourceOrderId,
    createdAt: new Date().toISOString(),
    expiresAt,
    usedByOrderId: null,
  };
  writeAll(promos);
  return promos[promoId];
}

/** Действующая (не использованная, не истёкшая) скидка клиента на услугу — самая крупная. */
export function findActivePromo(userId, service) {
  const now = new Date().toISOString();
  return Object.values(readAll())
    .filter((p) => p.userId === userId && p.service === service && !p.usedByOrderId && p.expiresAt > now)
    .sort((a, b) => b.percent - a.percent || a.expiresAt.localeCompare(b.expiresAt))[0];
}

/** Помечает скидку использованной — вызывается только после успешной оплаты. */
export function markPromoUsed(promoId, orderId) {
  const promos = readAll();
  if (!promos[promoId] || promos[promoId].usedByOrderId) return;
  promos[promoId].usedByOrderId = orderId;
  writeAll(promos);
}

/** Цена со скидкой, в целых рублях (не меньше 1 ₽ — минимальная сумма платежа). */
export function applyPromo(priceRub, promo) {
  if (!promo) return priceRub;
  return Math.max(1, Math.round(priceRub * (1 - promo.percent / 100)));
}

export function formatPromoDate(iso) {
  return new Date(iso).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
}
