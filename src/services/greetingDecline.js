import { Markup } from "telegraf";
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
  // Бесплатная проба ничего не стоила клиенту — скидку за отказ от неё не даём.
  if (order.isFreeTrial) return { ok: false, reason: "Это была бесплатная пробная версия." };
  if (!DECLINABLE_STATUSES.has(order.status)) {
    return { ok: false, reason: "По этому заказу решение уже принято." };
  }
  // статус меняем ДО выдачи скидки — повторное нажатие уже не пройдёт проверку выше
  updateOrder(orderId, { status: "declined" });
  const promo = issuePromo({ userId, service: "greeting", sourceOrderId: orderId });
  return { ok: true, promo };
}

// Одно сообщение для отказа и от текста, и от готового видео. Кнопка ведёт в покупку
// (service:video в bot.js), где скидка уже подставится сама.
export function sendDeclineMessage(ctx, promo) {
  return ctx.reply(
    "Нам очень жаль, что поздравление получилось не таким, как Вам хотелось. " +
      "Приносим свои извинения 🙏\n\n" +
      `В знак извинения дарим Вам скидку ${promo.percent}% на следующее анимированное поздравление:\n` +
      "• применится автоматически при оплате — ничего вводить не нужно;\n" +
      `• действует до ${formatPromoDate(promo.expiresAt)} включительно.\n\n` +
      "Будем рады попробовать ещё раз и сделать поздравление, которое Вам точно понравится.",
    Markup.inlineKeyboard([Markup.button.callback("🎬 Новое поздравление со скидкой", "service:video")])
  );
}
