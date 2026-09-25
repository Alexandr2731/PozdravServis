import { Scenes, Markup } from "telegraf";
import { createPayment } from "../services/yookassa.js";
import { createOrder, updateOrder } from "../utils/orderStore.js";
import { findActivePromo, applyPromo, formatPromoDate } from "../utils/promoStore.js";
import { registerVisit, hasUsedFreeTrial, markFreeTrialUsed } from "../utils/userStore.js";

// Покупка Услуги 1 — ДО любой работы над поздравлением (решение Александра 24.09.2026,
// knowledge/tasks.md ФЛОУ-1): выбор услуги -> стоимость и варианты покупки -> оплата ->
// только потом повод/текст/фото/голос (greeting.js). Пока только разовая покупка —
// пакеты появятся, когда станет известна себестоимость.

// Цена НЕ зашита числом сознательно — себестоимость (реальный тариф HeyGen на минуту
// видео) ещё не подтверждена (см. knowledge/unit-economics.md), поэтому цену задаёт
// переменная окружения, а не код: без неё бот честно падает с понятной ошибкой при
// попытке создать платёж, а не продаёт по случайному числу. Для теста — 10 ₽.
export function greetingPriceRub() {
  const raw = process.env.GREETING_PRICE_RUB;
  if (!raw) {
    throw new Error(
      "GREETING_PRICE_RUB не задан — цена ещё не определена (себестоимость не подтверждена), " +
        "оплату включать нельзя без явного значения"
    );
  }
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`GREETING_PRICE_RUB задан некорректно: "${raw}"`);
  }
  return price;
}

// Бесплатная проба — один раз на Telegram ID (решение Александра 25.09.2026, knowledge/tasks.md
// ФЛОУ-1). Облегчённая: один раунд вариантов текста без переделки, без отказа со скидкой
// (greeting.js / greetingFulfillment.js смотрят на order.isFreeTrial). Проба отмечается
// использованной СРАЗУ при создании заказа, а не после видео — иначе, нажав кнопку в двух
// сообщениях, можно получить две пробы. Email не спрашиваем — чека нет, оплаты нет.
async function startFreeTrial(ctx) {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (hasUsedFreeTrial(userId, "greeting")) {
    await ctx.reply("Бесплатную пробную версию Вы уже получали. Полная версия — /start.");
    return ctx.scene.leave();
  }
  registerVisit(ctx.from); // клиент мог прийти до появления учёта (userStore.js) — заводим запись
  const orderId = createOrder({
    chatId: ctx.chat.id,
    userId,
    priceRub: 0,
    isFreeTrial: true,
    status: "paid",
  });
  markFreeTrialUsed(userId, "greeting", orderId);
  await ctx.reply("🎁 Отлично, начинаем Ваше бесплатное поздравление!");
  await ctx.scene.leave();
  return ctx.scene.enter("greeting-wizard", { orderId });
}

export const greetingPurchaseWizard = new Scenes.WizardScene(
  "greeting-purchase",
  async (ctx) => {
    let price;
    try {
      price = greetingPriceRub();
    } catch (err) {
      await ctx.reply(`Оплата пока недоступна: ${err.message}. Попробуйте, пожалуйста, позже.`);
      return ctx.scene.leave();
    }
    // Скидка за прошлый отказ от этой же услуги (promoStore.js) применяется сама.
    const promo = findActivePromo(String(ctx.from.id), "greeting");
    const finalPrice = applyPromo(price, promo);
    ctx.wizard.state.price = finalPrice;
    ctx.wizard.state.promoId = promo?.promoId ?? null;
    const trialAvailable = !hasUsedFreeTrial(String(ctx.from.id), "greeting");
    const priceLine = promo
      ? `Стоимость: ${finalPrice} ₽ вместо ${price} ₽ — Ваша скидка ${promo.percent}% (действует до ${formatPromoDate(promo.expiresAt)}).`
      : `Стоимость: ${price} ₽ — разовая покупка.`;
    await ctx.reply(
      "🎬 Анимированное поздравление\n\n" +
        "Оживим фото: человек на нём сам прочитает поздравление — голосом того, кто поздравляет, " +
        "или стандартным голосом. Стиль видео — реалистичный или мультяшный. Длительность — около 30 секунд.\n\n" +
        "Что входит:\n" +
        "• текст — Ваш или напишем за Вас: 2 варианта на выбор и ещё 2, если первые не подойдут\n" +
        "• обычный текст или стихи\n" +
        "• готовое видео прямо сюда, в чат\n\n" +
        `${priceLine}\n\n` +
        "Не понравится — подарим скидку 50% на следующее анимированное поздравление." +
        (trialAvailable
          ? "\n\n🎁 Первое поздравление — в подарок! Бесплатная пробная версия: 2 варианта текста " +
            "на выбор, без переделки."
          : ""),
      Markup.inlineKeyboard([
        ...(trialAvailable ? [[Markup.button.callback("🎁 Попробовать бесплатно", "purchase:trial")]] : []),
        [Markup.button.callback(`💳 Купить за ${finalPrice} ₽`, "purchase:buy")],
      ])
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.callbackQuery?.data === "purchase:trial") return startFreeTrial(ctx);
    if (ctx.callbackQuery?.data !== "purchase:buy") {
      await ctx.reply("Нажмите «Купить» выше или /start, чтобы вернуться в меню.");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.reply("На какой email прислать чек за оплату?");
    return ctx.wizard.next();
  },
  async (ctx) => {
    const email = ctx.message?.text?.trim();
    if (!email || !email.includes("@")) {
      await ctx.reply("Похоже, это не email. Пришлите, пожалуйста, ещё раз.");
      return;
    }
    const price = ctx.wizard.state.price;

    const orderId = createOrder({
      chatId: ctx.chat.id,
      userId: String(ctx.from.id),
      email,
      priceRub: price,
      promoId: ctx.wizard.state.promoId,
      status: "awaiting_payment",
    });

    try {
      const { paymentId, confirmationUrl } = await createPayment({
        amountRub: price,
        description: `PozdravServis — анимированное поздравление (заказ ${orderId})`,
        returnUrl: `https://t.me/${(await ctx.telegram.getMe()).username}`,
        customer: { email },
      });
      updateOrder(orderId, { paymentId });

      // Кнопка вместо голой длинной ссылки в тексте (живой прогон 23.09.2026, knowledge/tasks.md ОПЛАТА-1).
      await ctx.reply(
        "Нажмите кнопку, чтобы оплатить. Сразу после оплаты мы напишем сюда — и начнём создавать поздравление.\n\n" +
          "Ссылка действует около часа.",
        Markup.inlineKeyboard([Markup.button.url(`💳 Оплатить ${price} ₽`, confirmationUrl)])
      );
    } catch (err) {
      await ctx.reply(`Не получилось создать платёж: ${err.message}. Попробуйте ещё раз позже — /start.`);
    }
    return ctx.scene.leave();
  }
);
