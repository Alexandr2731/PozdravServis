import { createServer } from "node:http";
import crypto from "node:crypto";
import { Telegraf, Scenes, session, Markup } from "telegraf";
import { greetingWizard } from "./scenes/greeting.js";
import { songWizard } from "./scenes/song.js";
import { getPayment } from "./services/yookassa.js";
import { getOrder, getOrderByPaymentId, updateOrder } from "./utils/orderStore.js";
import { fulfillGreetingOrder } from "./services/greetingFulfillment.js";
import { hasFreeRevisionsLeft, canOfferRefund, refundAmount } from "./utils/revisionRules.js";
import { addPoints, getBalance } from "./utils/balanceStore.js";

const bot = new Telegraf(process.env.BOT_TOKENNP);
const stage = new Scenes.Stage([greetingWizard, songWizard]);

bot.use(session());
bot.use(stage.middleware());

const serviceKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("🎬 Анимированное видео-поздравление", "service:video"),
  Markup.button.callback("🎵 Именная песня + клип", "service:song"),
]);

bot.start(async (ctx) => {
  await ctx.reply(
    `Привет, ${ctx.from.first_name || "друг"}! 👋\n\n` +
      "Я — «PozdravServis», сервис креативных поздравлений с помощью ИИ.\n\n" +
      "Что я умею:\n" +
      "🎬 Оживить фото — на нём Вы сами зачитаете поздравление (с Вашим текстом или мы поможем его написать за Вас), в обычном или стихотворном стиле текста, в обычном или мультяшном варианте видео, голосом того, кто поздравляет\n" +
      "🎵 Собрать именную песню с клипом в честь того, кого поздравляете\n\n" +
      "Как это устроено:\n" +
      "1. Выбираешь формат и повод\n" +
      "2. Присылаешь фото и текст (или просишь помочь с текстом)\n" +
      "3. Оплачиваешь — получаешь результат\n" +
      "4. Не понравилось — переделаем один раз бесплатно\n" +
      "5. Если и это не подошло — вернём половину стоимости баллами на счёт\n\n" +
      "Готов начать?"
  );
  return ctx.reply("Выбери, с чего начнём:", serviceKeyboard);
});

bot.action("service:video", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.scene.enter("greeting-wizard");
});

bot.action("service:song", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.scene.enter("song-wizard");
});

bot.action(/^greeting:like:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Рады, что понравилось! 🎉");
  await ctx.reply("Спасибо! Если захочешь сделать ещё одно поздравление — жми /start.");
});

bot.action(/^greeting:redo:(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = getOrder(orderId);
  if (!order) return ctx.answerCbQuery("Заказ не найден.");
  if (!hasFreeRevisionsLeft(order.revisionCount)) {
    return ctx.answerCbQuery("Бесплатная переделка уже использована.");
  }
  await ctx.answerCbQuery();
  const updated = updateOrder(orderId, { revisionCount: order.revisionCount + 1 });
  await ctx.reply("Переделываю, это снова займёт пару минут...");
  try {
    await fulfillGreetingOrder(bot, updated);
  } catch (err) {
    console.error("Redo generation failed:", err);
    await ctx.reply(`Не получилось переделать: ${err.message}. Напиши нам, разберёмся.`);
  }
});

bot.action(/^greeting:refund:(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = getOrder(orderId);
  if (!order) return ctx.answerCbQuery("Заказ не найден.");
  if (!canOfferRefund(order.revisionCount)) {
    return ctx.answerCbQuery("Сначала нужно попробовать бесплатную переделку.");
  }
  await ctx.answerCbQuery();
  const amount = refundAmount(order.priceRub);
  const balance = addPoints(order.userId, amount);
  updateOrder(orderId, { status: "unsatisfied_refunded" });
  await ctx.reply(
    `Жаль, что не подошло. Начислили ${amount.toFixed(0)} баллов на счёт — итого у тебя ${balance.toFixed(0)} ` +
      `баллов, их можно использовать на следующий заказ. Проверить баланс — /balance.`
  );
});

bot.command("balance", async (ctx) => {
  const balance = getBalance(String(ctx.from.id));
  await ctx.reply(`Твой баланс: ${balance.toFixed(0)} баллов.`);
});

bot.help((ctx) =>
  ctx.reply(
    "Как это работает:\n\n" +
      "1. Выбери тип поздравления командой /start\n" +
      "2. Пришли фото и текст поздравления\n" +
      "3. Дождись готового видео (пара минут)\n\n" +
      "/start — начать новое поздравление"
  )
);

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
    res.writeHead(200).end("ok"); // отвечаем ЮKassa сразу, генерация может занять пару минут

    fulfillGreetingOrder(bot, getOrder(order.orderId)).catch(async (err) => {
      console.error("fulfillGreetingOrder failed after payment:", err);
      await bot.telegram
        .sendMessage(order.chatId, `Оплата прошла, но не получилось создать видео: ${err.message}. Напиши нам, разберёмся и вернём деньги.`)
        .catch(() => {});
    });
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
