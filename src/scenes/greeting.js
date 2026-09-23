import { Scenes, Markup } from "telegraf";
import { generateGreetingText, transcribeVoice, stylizeCartoon } from "../services/openai.js";
import { createPayment } from "../services/yookassa.js";
import { convertOggToMp3 } from "../utils/audio.js";
import { occasionKeyboard, occasionLabel } from "../constants/occasions.js";
import { createOrder, updateOrder } from "../utils/orderStore.js";

// Цена НЕ зашита числом сознательно — себестоимость (реальный тариф HeyGen на минуту
// видео) ещё не подтверждена (см. knowledge/discovery-2026-09-23/01-cost-reconciliation.md),
// поэтому цену задаёт переменная окружения, а не код: без неё бот честно падает с
// понятной ошибкой при попытке создать платёж, а не продаёт по случайному числу.
function greetingPriceRub() {
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

const textSourceKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("✍️ У меня свой текст", "textsrc:own"),
  Markup.button.callback("🤖 Помоги написать", "textsrc:help"),
]);

const textStyleKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("📝 Обычный текст", "textstyle:prose"),
  Markup.button.callback("📜 Стихи", "textstyle:poem"),
]);

const styleKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("🎥 Обычный (реалистичный)", "style:realistic"),
  Markup.button.callback("🎨 Мультяшный", "style:cartoon"),
]);

// Реалистичное "оживление" фото с посторонними людьми (не самим заказчиком) без их
// согласия — этический/юридический риск (по сути deepfake человека, который ничего не
// разрешал). Мультяшный стиль пока тоже фактически подменяется реалистичным (см. ниже),
// поэтому пока безопасного варианта для таких фото просто нет — честно говорим об этом,
// а не генерируем молча.
const othersOnPhotoKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("Нет, только тот, кого поздравляем", "others:no"),
  Markup.button.callback("Да, есть ещё кто-то", "others:yes"),
]);

const voiceKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("🔊 Стандартный голос", "voice:default"),
]);

async function transcribeIfVoice(ctx, voice) {
  const voiceFileLink = await ctx.telegram.getFileLink(voice.file_id);
  const oggBuffer = Buffer.from(await (await fetch(voiceFileLink.href)).arrayBuffer());
  const mp3Buffer = await convertOggToMp3(oggBuffer);
  return transcribeVoice(mp3Buffer);
}

export const greetingWizard = new Scenes.WizardScene(
  "greeting-wizard",
  (ctx) => {
    ctx.reply("По какому поводу поздравление?", occasionKeyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const code = ctx.callbackQuery?.data?.split(":")[1];
    if (!code) {
      ctx.reply("Выбери повод кнопкой выше.");
      return;
    }
    ctx.wizard.state.occasion = occasionLabel(code);
    await ctx.answerCbQuery();
    await ctx.reply("У тебя уже есть текст или стих поздравления, или помочь его написать?", textSourceKeyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const choice = ctx.callbackQuery?.data?.split(":")[1];
    if (!choice) {
      ctx.reply("Выбери кнопкой выше.");
      return;
    }
    ctx.wizard.state.textMode = choice;
    await ctx.answerCbQuery();
    if (choice === "help") {
      await ctx.reply("В каком стиле написать текст?", textStyleKeyboard);
      return ctx.wizard.next(); // -> шаг выбора прозы/стихов
    }
    await ctx.reply("Пришли текст поздравления — текстом или голосовым сообщением.");
    // "Свой текст" не нуждается в выборе прозы/стихов — пропускаем этот шаг сразу к сбору текста.
    ctx.wizard.selectStep(ctx.wizard.cursor + 2);
  },
  // Только для textMode === "help" — выбор до генерации, влияет на промпт в openai.js.
  async (ctx) => {
    const style = ctx.callbackQuery?.data?.split(":")[1];
    if (!style) {
      ctx.reply("Выбери кнопкой выше.");
      return;
    }
    ctx.wizard.state.textStyle = style;
    await ctx.answerCbQuery();
    await ctx.reply("Расскажи о человеке, кого поздравляем: имя, что любит, за что цените.");
    return ctx.wizard.next();
  },
  async (ctx) => {
    const typed = ctx.message?.text;
    const voice = ctx.message?.voice;
    if (!typed && !voice) {
      ctx.reply("Пришли текст или голосовое сообщение.");
      return;
    }
    try {
      if (ctx.wizard.state.textMode === "help") {
        const personInfo = typed || (await transcribeIfVoice(ctx, voice));
        await ctx.reply("Пишу текст поздравления...");
        const text = await generateGreetingText({
          occasion: ctx.wizard.state.occasion,
          personInfo,
          style: ctx.wizard.state.textStyle,
        });
        ctx.wizard.state.text = text;
        await ctx.reply(`Вот что получилось:\n\n${text}`);
      } else {
        ctx.wizard.state.text = typed || (await transcribeIfVoice(ctx, voice));
      }
    } catch (err) {
      await ctx.reply(`Не получилось обработать: ${err.message}`);
      return;
    }
    await ctx.reply("Теперь пришли фото, которое станет основой поздравления.");
    return ctx.wizard.next();
  },
  (ctx) => {
    const photo = ctx.message?.photo?.at(-1);
    if (!photo) {
      ctx.reply("Нужно именно фото. Попробуй ещё раз.");
      return;
    }
    ctx.wizard.state.photoFileId = photo.file_id;
    ctx.reply("Кроме того, кого поздравляем, на фото есть ещё кто-то?", othersOnPhotoKeyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const answer = ctx.callbackQuery?.data?.split(":")[1];
    if (!answer) {
      ctx.reply("Ответь кнопкой выше.");
      return;
    }
    await ctx.answerCbQuery();
    if (answer === "yes") {
      // Пока мультяшный стиль не готов (см. следующий шаг), безопасной генерации для
      // фото с посторонними людьми просто нет — не делаем молча, объясняем и просим
      // другое фото, вместо того чтобы сгенерировать реалистичное видео без их согласия.
      await ctx.reply(
        "Пока мы не можем обработать фото, где кроме поздравляемого есть кто-то ещё — " +
          "«оживление» фото в реалистичном стиле без согласия всех, кто на нём есть, мы не делаем.\n\n" +
          "Пришли, пожалуйста, фото, где только тот, кого поздравляем — или начни заново командой /start, " +
          "если хочешь выбрать другой формат поздравления."
      );
      return ctx.scene.leave();
    }
    ctx.wizard.state.includesOthers = false;
    await ctx.reply("В каком стиле сделать видео?", styleKeyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const style = ctx.callbackQuery?.data?.split(":")[1];
    if (!style) {
      ctx.reply("Выбери стиль кнопкой выше.");
      return;
    }
    await ctx.answerCbQuery();
    const prefix =
      style === "cartoon" ? "Мультяшный стиль пока в разработке — сделаем в обычном (реалистичном).\n\n" : "";
    await ctx.reply(
      prefix +
        "Хочешь, чтобы поздравление звучало голосом того, кто поздравляет?\n\n" +
        "Пришли голосовое сообщение (10-30 секунд, чётко и без шума) — или нажми кнопку, чтобы использовать стандартный голос.",
      voiceKeyboard
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const isSkip = ctx.callbackQuery?.data === "voice:default";
    const voice = ctx.message?.voice;
    if (!isSkip && !voice) {
      ctx.reply("Пришли голосовое сообщение или нажми кнопку «Стандартный голос».");
      return;
    }
    if (isSkip) await ctx.answerCbQuery();
    if (voice) ctx.wizard.state.voiceFileId = voice.file_id;

    await ctx.reply("Последний шаг — на какой email прислать чек за оплату?");
    return ctx.wizard.next();
  },
  // Оплата — генерация начинается только после подтверждённого платежа (см. вебхук в
  // bot.js), а не сразу здесь. До этого шага не тратим ни рубля на HeyGen — ни фото не
  // грузим как asset, ни голос не клонируем — на случай, если клиент вообще не оплатит.
  async (ctx) => {
    const email = ctx.message?.text?.trim();
    if (!email || !email.includes("@")) {
      ctx.reply("Похоже, это не email. Пришли ещё раз.");
      return;
    }

    let price;
    try {
      price = greetingPriceRub();
    } catch (err) {
      await ctx.reply(`Оплата пока недоступна: ${err.message}. Попробуй позже.`);
      return ctx.scene.leave();
    }

    const orderId = createOrder({
      chatId: ctx.chat.id,
      userId: String(ctx.from.id),
      occasion: ctx.wizard.state.occasion,
      text: ctx.wizard.state.text,
      photoFileId: ctx.wizard.state.photoFileId,
      voiceFileId: ctx.wizard.state.voiceFileId,
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

      await ctx.reply(
        `Стоимость: ${price} ₽.\n\nОплати по ссылке — после оплаты пришлю готовое видео сюда же, обычно в течение пары минут:\n${confirmationUrl}`
      );
    } catch (err) {
      await ctx.reply(`Не получилось создать платёж: ${err.message}. Попробуй ещё раз позже.`);
    }
    return ctx.scene.leave();
  }
);
