import { createServer } from "node:http";
import crypto from "node:crypto";
import { Telegraf, Scenes, session, Markup } from "telegraf";
import { greetingWizard } from "./scenes/greeting.js";
import { greetingPurchaseWizard } from "./scenes/greetingPurchase.js";
import { songWizard } from "./scenes/song.js";
import { getPayment } from "./services/yookassa.js";
import { getOrder, getOrderByPaymentId, updateOrder, findUnfinishedPaidOrder } from "./utils/orderStore.js";
import { declineGreetingOrder, sendDeclineMessage } from "./services/greetingDecline.js";
import { markPromoUsed } from "./utils/promoStore.js";
import { registerVisit } from "./utils/userStore.js";

const bot = new Telegraf(process.env.BOT_TOKENNP);
const stage = new Scenes.Stage([greetingWizard, greetingPurchaseWizard, songWizard]);

bot.use(session());
// stage.middleware() подключается НИЖЕ, после всех stage.* обработчиков: Telegraf снимает
// список обработчиков stage в момент вызова middleware(), добавленные позже не сработают.

// Три услуги (решение 24.09.2026, knowledge/tasks.md ФЛОУ-1). Работаем строго поэтапно:
// пока доводим только Услугу 1 — песня и клип в меню с пометкой «скоро». Сцена песни
// (song.js) сейчас недоступна из меню: она генерирует бесплатно, без оплаты.
const serviceKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("🎬 Анимированное поздравление", "service:video")],
  [Markup.button.callback("🎵 Поздравительная песня — скоро", "service:soon")],
  [Markup.button.callback("🎞 Поздравительный клип — скоро", "service:soon")],
]);

// Глобальные команды и кнопки висят на stage, а не на bot: обработчики stage срабатывают
// РАНЬШЕ активной сцены, а wizard иначе проглатывает всё сам — /start посреди сценария
// отвечал «Выбери кнопкой выше» (найдено прогоном 24.09.2026). Оплаченный заказ при этом
// не теряется — service:video продолжит его (findUnfinishedPaidOrder).
stage.start(async (ctx) => {
  await ctx.scene.leave();
  // Учёт клиента и источника (метка из ссылки ?start=...) — userStore.js.
  try {
    registerVisit(ctx.from, ctx.payload);
  } catch (err) {
    console.error("registerVisit failed:", err); // учёт не должен ломать приветствие
  }
  await ctx.reply(
    `Здравствуйте, ${ctx.from.first_name || "друг"}! 👋\n\n` +
      "Мы — «PozdravServis», сервис креативных поздравлений с помощью ИИ.\n\n" +
      "Что мы умеем:\n" +
      "🎬 Анимированное поздравление — оживим фото: человек на нём сам прочитает поздравление " +
      "(Вашим текстом или мы поможем написать — обычным текстом или стихами), голосом того, кто поздравляет, " +
      "в реалистичном или мультяшном стиле\n" +
      "🎵 Поздравительная песня — скоро\n" +
      "🎞 Поздравительный клип — скоро\n\n" +
      "Как это устроено:\n" +
      "1. Вы выбираете услугу и оплачиваете её\n" +
      "2. Выбираете повод, присылаете фото и текст (или мы поможем с текстом)\n" +
      "3. Получаете готовое видео прямо сюда, в чат\n" +
      "4. Понравилось — забираете. Не понравилось — дарим скидку 50% на следующее поздравление\n\n" +
      "🎁 Первое анимированное поздравление — бесплатно!"
  );
  return ctx.reply("С чего начнём?", serviceKeyboard);
});

stage.action("service:video", async (ctx) => {
  await ctx.answerCbQuery();
  // Уже оплаченный, но не доделанный заказ (бросил сценарий, рестарт бота) — продолжаем
  // его, а не просим платить второй раз.
  const unfinished = findUnfinishedPaidOrder(String(ctx.from.id));
  if (unfinished) {
    await ctx.reply("У Вас есть незаконченное поздравление — продолжаем с него.");
    return ctx.scene.enter("greeting-wizard", { orderId: unfinished.orderId });
  }
  return ctx.scene.enter("greeting-purchase");
});

stage.action("service:soon", (ctx) =>
  ctx.answerCbQuery("Скоро! Пока доступно анимированное поздравление 🎬", { show_alert: true })
);

// Кнопка из сообщения «Оплата получена» (вебхук ЮKassa ниже) — вход в сценарий по оплаченному заказу.
stage.action(/^greeting:start:(.+)$/, async (ctx) => {
  const order = getOrder(ctx.match[1]);
  if (!order || order.userId !== String(ctx.from.id)) return ctx.answerCbQuery("Заказ не найден.");
  if (order.status !== "paid" && order.status !== "in_progress") {
    return ctx.answerCbQuery("Этот заказ уже в работе или выполнен. Новый заказ — /start.", { show_alert: true });
  }
  await ctx.answerCbQuery();
  return ctx.scene.enter("greeting-wizard", { orderId: order.orderId });
});

// Без бесплатной переделки видео (решено 2026-09-23) — сразу развилка: забрал результат,
// или отказ со скидкой на следующий заказ. Текст клиент уже согласовал в сценарии
// (greeting.js), поэтому предмет спора на этом шаге — только сама генерация видео.
stage.action(/^greeting:accept:(.+)$/, async (ctx) => {
  const order = getOrder(ctx.match[1]);
  if (!order || order.userId !== String(ctx.from.id) || order.status !== "awaiting_review") {
    return ctx.answerCbQuery("По этому заказу решение уже принято.");
  }
  updateOrder(order.orderId, { status: "delivered" });
  await ctx.answerCbQuery("Готово! 🎉");
  await ctx.reply(
    order.isFreeTrial
      ? "Спасибо, что попробовали наш сервис! 🎁\n\nВ полной версии — ещё 2 варианта текста, если первые не подойдут. " +
          "Сделать следующее поздравление — /start."
      : "Спасибо, что выбрали нас! Если захотите сделать ещё одно поздравление — нажмите /start."
  );
});

stage.action(/^greeting:decline:(.+)$/, async (ctx) => {
  const result = declineGreetingOrder(ctx.match[1], String(ctx.from.id));
  if (!result.ok) return ctx.answerCbQuery(result.reason, { show_alert: true });
  await ctx.answerCbQuery();
  await sendDeclineMessage(ctx, result.promo);
});

stage.help((ctx) =>
  ctx.reply(
    "Как это работает:\n\n" +
      "1. /start — выберите услугу и оплатите её\n" +
      "2. Выберите повод, пришлите фото и текст (или попросите помочь с текстом)\n" +
      "3. Дождитесь готового видео (обычно до 10 минут)"
  )
);

bot.use(stage.middleware());

// Старая кнопка из уже законченного сценария (например, повторный «Отказаться») —
// без ответа у клиента бесконечно крутится индикатор на кнопке.
bot.on("callback_query", (ctx) => ctx.answerCbQuery("Эта кнопка уже неактуальна. Начать заново — /start"));

bot.telegram.setMyCommands([
  { command: "start", description: "Начать новое поздравление" },
  { command: "help", description: "Как это работает" },
]);

// Webhook mode instead of long-polling: avoids the 409 "Conflict" errors that
// happen when Railway briefly runs old+new containers during a rolling deploy —
// with polling both would fight over getUpdates, with webhooks Telegram just
// pushes to whichever instance is reachable.
const WEBHOOK_SECRET = crypto.createHash("sha256").update(process.env.BOT_TOKENNP).digest("hex").slice(0, 32);
const WEBHOOK_PATH = `/webhook/${WEBHOOK_SECRET}`;
const YOOKASSA_WEBHOOK_PATH = `/yookassa/${WEBHOOK_SECRET}`;
const PORT = process.env.PORT || 3000;
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || "na-pamyat-d-bot-production.up.railway.app";

const webhookHandler = bot.webhookCallback(WEBHOOK_PATH);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ЮKassa шлёт уведомление о смене статуса платежа сюда. НЕ доверяем статусу из тела
// уведомления напрямую (кто угодно может прислать поддельный POST на этот URL) —
// уведомление используем только как повод переспросить сам платёж у ЮKassa по своим
// ключам (см. getPayment в services/yookassa.js). ЮKassa повторяет недоставленные
// уведомления — обработка должна быть идемпотентной (см. проверку order.status ниже).
async function handleYookassaWebhook(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const paymentId = body?.object?.id;
    if (!paymentId) {
      res.writeHead(200).end("ok");
      return;
    }

    const payment = await getPayment(paymentId);
    if (payment.status !== "succeeded") {
      res.writeHead(200).end("ok"); // не succeeded — canceled/waiting, ничего не делаем
      return;
    }

    const order = getOrderByPaymentId(paymentId);
    if (!order) {
      console.error("YooKassa webhook: no order for paymentId", paymentId);
      res.writeHead(200).end("ok");
      return;
    }
    if (order.status !== "awaiting_payment") {
      res.writeHead(200).end("ok"); // уже обработан — повтор вебхука, идемпотентность
      return;
    }

    updateOrder(order.orderId, { status: "paid" });
    // Скидку гасим только после успешной оплаты: брошенный платёж её не сжигает.
    if (order.promoId) markPromoUsed(order.promoId, order.orderId);
    res.writeHead(200).end("ok");

    // Оплата теперь в НАЧАЛЕ (ФЛОУ-1, 24.09.2026): после неё клиент проходит сценарий
    // (повод, текст, фото, голос), генерация стартует в конце сценария (greeting.js).
    // Сцену из вебхука открыть нельзя (нет update от клиента) — поэтому кнопка «Начать».
    // Сообщение сразу — чтобы клиент видел, что оплата прошла (просьба Александра 24.09).
    await bot.telegram
      .sendMessage(
        order.chatId,
        "✅ Оплата получена, спасибо!\n\nТеперь создадим поздравление — это займёт пару минут: " +
          "повод, текст, фото и голос. Нажмите «Начать» 👇",
        Markup.inlineKeyboard([Markup.button.callback("▶️ Начать", `greeting:start:${order.orderId}`)])
      )
      .catch((err) => console.error("payment confirmation message failed:", err));
  } catch (err) {
    console.error("YooKassa webhook error:", err);
    res.writeHead(200).end("ok"); // 200 всё равно — иначе ЮKassa будет бесконечно ретраить кривой запрос
  }
}

createServer((req, res) => {
  if (req.url === WEBHOOK_PATH) return webhookHandler(req, res);
  if (req.url === YOOKASSA_WEBHOOK_PATH && req.method === "POST") return handleYookassaWebhook(req, res);
  res.end("ok");
}).listen(PORT);

bot.telegram.setWebhook(`https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}`).catch((err) => {
  console.error("setWebhook failed:", err.message);
});

process.once("SIGTERM", () => bot.stop("SIGTERM"));
process.once("SIGINT", () => bot.stop("SIGINT"));
