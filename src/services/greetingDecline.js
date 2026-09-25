import { getOrder, updateOrder } from "../utils/orderStore.js";
import { issuePromo, formatPromoDate } from "../utils/promoStore.js";

// Статусы, из которых клиент вправе отказаться от заказа и получить скидку на следующий:
// - paid / in_progress — отказ на этапе текста (оба раунда вариантов не подошли);
// - awaiting_review — отказ от готового видео.
// Любой другой статус (уже забрал, уже отказался, ещё не оплатил) — скидки нет. Проверка
// статуса обязательна: без неё повторное нажатие кнопки выдавало бы скидку каждый раз.
const DECLINABLE_STATUSES = new Set(["paid", "in_progress", "awaiting_review"]);

/**
 * Отказ от заказа: деньги не возвращаются, клиент получает скидку на следующее
 * анимированное поздравление (решение 25.09.2026, см. promoStore.js).
 * @returns {{ ok: true, promo: object } | { ok: false, reason: string }}
 */
export function declineGreetingOrder(orderId, userId) {
  const order = getOrder(orderId);
  if (!order || order.userId !== userId) return { ok: false, reason: "Заказ не найден." };
  if (!DECLINABLE_STATUSES.has(order.status)) {
    return { ok: false, reason: "По этому заказу решение уже принято." };
  }
  // статус меняем ДО выдачи скидки — повторное нажатие уже не пройдёт проверку выше
  updateOrder(orderId, { status: "declined" });
  const promo = issuePromo({ userId, service: "greeting", sourceOrderId: orderId });
  return { ok: true, promo };
}

export function declineMessage(promo) {
  return (
    "Жаль, что не подошло 😔\n\n" +
    `Дарим скидку ${promo.percent}% на следующее анимированное поздравление — ` +
    `она применится сама при оплате. Действует до ${formatPromoDate(promo.expiresAt)}.\n\n` +
    "Попробовать ещё раз — /start."
  );
}
