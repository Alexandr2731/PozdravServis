import { Scenes, Markup } from "telegraf";
import { createPayment } from "../services/yookassa.js";
import { createOrder, updateOrder } from "../utils/orderStore.js";

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

export const greetingPurchaseWizard = new Scenes.WizardScene(
  "greeting-purchase",
  async (ctx) => {
    let price;
    try {
      price = greetingPriceRub();
    } catch (err) {
      await ctx.reply(`Оплата пока недоступна: ${err.message}. Попробуй позже.`);
      return ctx.scene.leave();
    }
    ctx.wizard.state.price = price;
    await ctx.reply(
      "🎬 Анимированное поздравление\n\n" +
        "Оживим фото: человек на нём сам прочитает поздравление — голосом того, кто поздравляет, " +
        "или стандартным голосом. Стиль видео — реалистичный или мультяшный. Длительность — около 30 секунд.\n\n" +
        "Что входит:\n" +
        "• текст — свой или напишем за тебя: 2 варианта на выбор и ещё 2, если первые не подойдут\n" +
        "• обычный текст или стихи\n" +
        "• готовое видео прямо сюда, в чат\n\n" +
        `Стоимость: ${price} ₽ — разовая покупка.\n\n` +
        "Не понравится — вернём половину стоимости баллами на счёт (1 балл = 1 ₽), " +
        "их можно потратить на следующий заказ.",
      Markup.inlineKeyboard([Markup.button.callback(`💳 Купить за ${price} ₽`, "purchase:buy")])
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.callbackQuery?.data !== "purchase:buy") {
      await ctx.reply("Нажми «Купить» выше или /start, чтобы вернуться в меню.");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.reply("На какой email прислать чек за оплату?");
    return ctx.wizard.next();
  },
  async (ctx) => {
    const email = ctx.message?.text?.trim();
    if (!email || !email.includes("@")) {
      await ctx.reply("Похоже, это не email. Пришли ещё раз.");
      return;
    }
    const price = ctx.wizard.state.price;

    const orderId = createOrder({
      chatId: ctx.chat.id,
      userId: String(ctx.from.id),
      email,
      priceRub: price,
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
        "Нажми кнопку, чтобы оплатить. Сразу после оплаты я напишу сюда — и начнём создавать поздравление.\n\n" +
          "Ссылка действует около часа.",
        Markup.inlineKeyboard([Markup.button.url(`💳 Оплатить ${price} ₽`, confirmationUrl)])
      );
    } catch (err) {
      await ctx.reply(`Не получилось создать платёж: ${err.message}. Попробуй ещё раз позже — /start.`);
    }
    return ctx.scene.leave();
  }
);
