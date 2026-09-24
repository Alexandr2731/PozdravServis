import { Scenes, Markup } from "telegraf";
import { generateGreetingText, transcribeVoice, stylizeCartoon } from "../services/openai.js";
import { createPayment } from "../services/yookassa.js";
import { convertOggToMp3 } from "../utils/audio.js";
import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";
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

// Длительность ролика ограничена ориентиром 30 секунд (решено 23.09.2026, голосом,
// Александр — на этой длительности и HeyGen-себестоимость, и сравнение цены с BroHit
// нормально сходятся, см. knowledge/discovery-2026-09-23/01-cost-reconciliation.md).
// ~2.5 слова/сек обычной русской речи -> 30с ≈ 75 слов. Для "своего текста" это жёсткое
// ограничение (иначе реальная длительность/себестоимость видео уедет далеко за
// заложенную в цену), для ИИ-генерации — ориентир в промпте + перегенерация слишком
// длинных вариантов (openai.js, generateGreetingText).
const MAX_GREETING_TEXT_WORDS = 75;

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const videoStyleKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("🎥 Обычный (реалистичный)", "style:realistic"),
  Markup.button.callback("🎨 Мультяшный", "style:cartoon"),
]);

const textSourceKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("✍️ У меня свой текст", "textsrc:own"),
  Markup.button.callback("🤖 Помоги написать", "textsrc:help"),
]);

const textStyleKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("📝 Обычный текст", "textstyle:prose"),
  Markup.button.callback("📜 Стихи", "textstyle:poem"),
]);

// 2 варианта сразу — генерация текста (gpt-5.5, см. openai.js) дешёвая (в отличие от видео,
// где по той же причине сознательно оставлен только 1 вариант за попытку), два варианта
// почти ничего не стоят дополнительно, а выбор для клиента ощутимо лучше.
const textVariantKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("1️⃣ Вариант 1", "textvariant:0"),
  Markup.button.callback("2️⃣ Вариант 2", "textvariant:1"),
  Markup.button.callback("✏️ Переделать оба", "textvariant:edit"),
]);

// "Оживление" фото с посторонними людьми (не самим заказчиком) без их согласия — этический/
// юридический риск (по сути deepfake человека, который ничего не разрешал). Блокируем для
// ОБОИХ стилей (не только реалистичного) — даже мультяшная стилизация всё ещё использует
// чужой образ без разрешения того, кто на фото. Ослаблять это правило только для мультяшного
// стиля — отдельное продуктовое решение, не принимать его молча. Стиль выбирается раньше
// фото в этом сценарии, но сама проверка возможна только когда фото уже есть — честно
// объясняем и просим другое фото, а не генерируем молча.
const othersOnPhotoKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("Нет, только тот, кого поздравляем", "others:no"),
  Markup.button.callback("Да, есть ещё кто-то", "others:yes"),
]);

const voiceKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("🔊 Стандартный голос", "voice:default"),
]);

async function transcribeIfVoice(ctx, voice) {
  const voiceFileLink = await ctx.telegram.getFileLink(voice.file_id);
  // fetchWithTimeout, не голый fetch — скачивание с серверов Telegram иногда зависает
  // посреди запроса на этой инфраструктуре (найдено живым тестом 23.09.2026: голосовая
  // правка текста висела минутами, без единой ошибки в логах).
  const oggBuffer = Buffer.from(await (await fetchWithTimeout(voiceFileLink.href, {})).arrayBuffer());
  const mp3Buffer = await convertOggToMp3(oggBuffer);
  return transcribeVoice(mp3Buffer);
}

async function generateAndShowVariants(ctx) {
  const variants = await generateGreetingText({
    occasion: ctx.wizard.state.occasion,
    personInfo: ctx.wizard.state.personInfo,
    style: ctx.wizard.state.textStyle,
    count: 2,
    maxWords: MAX_GREETING_TEXT_WORDS,
  });
  ctx.wizard.state.textVariants = variants;
  const message = variants.map((t, i) => `Вариант ${i + 1}:\n${t}`).join("\n\n———\n\n");
  await ctx.reply(`Вот что получилось:\n\n${message}`, textVariantKeyboard);
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
    await ctx.reply("В каком стиле сделать видео?", videoStyleKeyboard);
    return ctx.wizard.next();
  },
  // Стиль видео — теперь первый предметный выбор после повода, раньше текста и фото.
  // Сама проверка "реалистичный/мультяшный + посторонние на фото" случится позже, когда
  // фото уже будет на руках — здесь просто запоминаем выбор.
  async (ctx) => {
    const style = ctx.callbackQuery?.data?.split(":")[1];
    if (!style) {
      ctx.reply("Выбери стиль кнопкой выше.");
      return;
    }
    ctx.wizard.state.videoStyle = style;
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
    await ctx.reply(
      "Пришли текст поздравления — текстом, или голосовым сообщением (тогда этим же голосом " +
        "прочитает поздравление в видео — отдельно голос для клонирования спрашивать не будем)."
    );
    // "Свой текст" — без прозы/стихов (это уже готовый текст клиента, мы его не переписываем)
    // и без одобрения (одобрять нечего) — сразу к сбору текста, а оттуда сразу к фото.
    // Пропускаем 3 шага: textstyle(4), generate+show(5), approval(6) -> 7.
    ctx.wizard.selectStep(ctx.wizard.cursor + 4);
  },
  // Только для textMode === "help".
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
  // Только для textMode === "help" — собираем информацию и генерируем 2 варианта на выбор.
  async (ctx) => {
    const typed = ctx.message?.text;
    const voice = ctx.message?.voice;
    if (!typed && !voice) {
      ctx.reply("Пришли текст или голосовое сообщение.");
      return;
    }
    try {
      ctx.wizard.state.personInfo = typed || (await transcribeIfVoice(ctx, voice));
      await ctx.reply("Пишу текст поздравления, два варианта...");
      await generateAndShowVariants(ctx);
    } catch (err) {
      await ctx.reply(`Не получилось обработать: ${err.message}`);
      return;
    }
    return ctx.wizard.next();
  },
  // Выбор варианта (или переделка обоих) — обязательный шаг перед тем, как идти дальше.
  // Переделка бесплатна и без ограничения по числу попыток (в отличие от самого видео).
  async (ctx) => {
    const action = ctx.callbackQuery?.data?.split(":")[1];

    if (action === "0" || action === "1") {
      await ctx.answerCbQuery();
      ctx.wizard.state.text = ctx.wizard.state.textVariants[Number(action)];
      await ctx.reply("Теперь пришли фото, которое станет основой поздравления.");
      // next() увёл бы на шаг "свой текст" (следующий по счёту, но не по смыслу) — текст
      // уже выбран, нужен сразу шаг приёма фото (тот же, куда попадает и ветка "свой текст").
      ctx.wizard.selectStep(ctx.wizard.cursor + 2);
      return;
    }

    if (action === "edit") {
      await ctx.answerCbQuery();
      await ctx.reply(
        "Что поправить? Опиши свободно, или просто расскажи о человеке ещё раз, если хочешь другие варианты целиком."
      );
      ctx.wizard.state.awaitingTextFeedback = true;
      return; // остаёмся на этом шаге
    }

    if (ctx.wizard.state.awaitingTextFeedback && (ctx.message?.text || ctx.message?.voice)) {
      try {
        const feedback = ctx.message.text || (await transcribeIfVoice(ctx, ctx.message.voice));
        ctx.wizard.state.personInfo = `${ctx.wizard.state.personInfo}\n\nПравка от клиента: ${feedback}`;
        ctx.wizard.state.awaitingTextFeedback = false;
        await ctx.reply("Переписываю, снова два варианта...");
        await generateAndShowVariants(ctx);
      } catch (err) {
        await ctx.reply(`Не получилось переписать: ${err.message}`);
      }
      return; // остаёмся на этом же шаге, снова ждём выбор/переделку
    }

    ctx.reply("Выбери кнопкой выше: вариант 1, вариант 2, или переделать оба.");
  },
  // Только для textMode === "own" — принимаем текст как есть, без одобрения и стиля.
  // Если прислали голосом — тот же файл станет источником голоса для клонирования позже
  // (см. шаг после фото), отдельно голос уже не спрашиваем.
  async (ctx) => {
    const typed = ctx.message?.text;
    const voice = ctx.message?.voice;
    if (!typed && !voice) {
      ctx.reply("Пришли текст или голосовое сообщение.");
      return;
    }
    let text;
    let voiceFileId;
    try {
      if (voice) {
        voiceFileId = voice.file_id;
        text = await transcribeIfVoice(ctx, voice);
      } else {
        text = typed;
      }
    } catch (err) {
      await ctx.reply(`Не получилось обработать: ${err.message}`);
      return;
    }

    const words = countWords(text);
    if (words > MAX_GREETING_TEXT_WORDS) {
      await ctx.reply(
        `Текст длинноват для короткого видео-поздравления (~30 секунд) — сейчас примерно ${words} слов, ` +
          `уложись в ${MAX_GREETING_TEXT_WORDS}. Пришли покороче — текстом или голосовым.`
      );
      return; // остаёмся на этом же шаге, ждём текст ещё раз
    }

    ctx.wizard.state.text = text;
    if (voiceFileId) ctx.wizard.state.voiceFileId = voiceFileId;
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
      // Стиль выбирался раньше (в самом начале) — независимо от того, что тогда выбрали
      // (реалистичный или мультяшный), для фото с посторонними людьми блокируем оба —
      // см. комментарий у othersOnPhotoKeyboard. Не генерируем молча.
      await ctx.reply(
        "Пока мы не можем обработать фото, где кроме поздравляемого есть кто-то ещё — " +
          "«оживление» чужого образа без согласия всех, кто на фото, мы не делаем, независимо от стиля.\n\n" +
          "Пришли, пожалуйста, фото, где только тот, кого поздравляем — или начни заново командой /start, " +
          "если хочешь выбрать другой формат поздравления."
      );
      return ctx.scene.leave();
    }
    ctx.wizard.state.includesOthers = false;

    if (ctx.wizard.state.voiceFileId) {
      // Уже есть голос из шага "свой текст" (клиент наговорил его) — второй раз не спрашиваем.
      await ctx.reply("Последний шаг — на какой email прислать чек за оплату?");
      ctx.wizard.selectStep(ctx.wizard.cursor + 2);
      return;
    }

    await ctx.reply(
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
      videoStyle: ctx.wizard.state.videoStyle,
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
