import { getOrder, updateOrder } from "../utils/orderStore.js";
import { addPoints } from "../utils/balanceStore.js";
import { refundAmount } from "../utils/revisionRules.js";

// Статусы, из которых клиент вправе отказаться с возвратом половины баллами:
// - paid / in_progress — отказ на этапе текста (оба раунда вариантов не подошли);
// - awaiting_review — отказ от готового видео.
// Любой другой статус (уже забрал, уже вернули, ещё не оплатил) — возврата нет. Проверка
// статуса обязательна: без неё повторное нажатие кнопки начисляло баллы каждый раз.
const REFUNDABLE_STATUSES = new Set(["paid", "in_progress", "awaiting_review"]);

/**
 * Возврат половины стоимости заказа баллами (1 балл = 1 ₽).
 * @returns {{ ok: true, amount: number, balance: number } | { ok: false, reason: string }}
 */
export function refundGreetingOrder(orderId, userId) {
  const order = getOrder(orderId);
  if (!order || order.userId !== userId) return { ok: false, reason: "Заказ не найден." };
  if (!REFUNDABLE_STATUSES.has(order.status)) {
    return { ok: false, reason: "По этому заказу возврат уже оформлен или недоступен." };
  }
  // статус меняем ДО начисления — повторное нажатие уже не пройдёт проверку выше
  updateOrder(orderId, { status: "unsatisfied_refunded" });
  const amount = refundAmount(order.priceRub);
  const balance = addPoints(userId, amount);
  return { ok: true, amount, balance };
}
