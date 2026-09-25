import { Scenes, Markup } from "telegraf";
import { generateGreetingText, transcribeVoice, stylizeCartoon } from "../services/openai.js";
import { convertOggToMp3 } from "../utils/audio.js";
import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";
import { occasionKeyboard, occasionLabel } from "../constants/occasions.js";
import { getOrder, updateOrder } from "../utils/orderStore.js";
import { hasFreeRevisionsLeft, accumulateVariants } from "../utils/revisionRules.js";
import { fulfillGreetingOrder } from "../services/greetingFulfillment.js";
import { declineGreetingOrder, declineMessage } from "../services/greetingDecline.js";

// Сцена запускается ТОЛЬКО по уже оплаченному заказу (решение 24.09.2026, knowledge/tasks.md
// ФЛОУ-1): оплата — в greetingPurchase.js, вход сюда — ctx.scene.enter("greeting-wizard",
// { orderId }) из bot.js. Всё, что клиент выбирает здесь, дописывается в этот заказ, а в
// конце сразу запускается генерация видео.

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

// 2 варианта за раунд — генерация текста (gpt-5.5, см. openai.js) дешёвая (в отличие от
// видео, где сознательно только 1 вариант за попытку), выбор для клиента ощутимо лучше.
// Раундов — 1 + FREE_REVISIONS_LIMIT (revisionRules.js), т.е. 2 варианта + ещё 2. Варианты
// копятся: после переделки можно выбрать любой из всех 4. Когда переделки кончились —
// вместо "Переделать" свой текст или отказ со скидкой на следующий заказ (оплата уже прошла).
const VARIANT_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];

function textVariantKeyboard(variantsCount, canRevise) {
  const variantButtons = Array.from({ length: variantsCount }, (_, i) =>
    Markup.button.callback(`${VARIANT_EMOJI[i] ?? i + 1} Вариант ${i + 1}`, `textvariant:${i}`)
  );
  const rows = [];
  for (let i = 0; i < variantButtons.length; i += 2) rows.push(variantButtons.slice(i, i + 2));
  if (canRevise) {
    rows.push([Markup.button.callback("✏️ Переделать", "textvariant:edit")]);
  } else {
    rows.push([Markup.button.callback("✍️ Пришлю свой текст", "textvariant:own")]);
    rows.push([Markup.button.callback("🎟 Отказаться — скидка 50% на следующее", "textvariant:decline")]);
  }
  return Markup.inlineKeyboard(rows);
}

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
  const firstNumber = (ctx.wizard.state.textVariants?.length ?? 0) + 1;
  ctx.wizard.state.textVariants = accumulateVariants(ctx.wizard.state.textVariants, variants);
  // сколько переделок уже использовано: 0 после первого раунда, 1 после второго
  ctx.wizard.state.textRevisions = ctx.wizard.state.textVariants.length / 2 - 1;
  const canRevise = hasFreeRevisionsLeft(ctx.wizard.state.textRevisions);

  const message = variants.map((t, i) => `Вариант ${firstNumber + i}:\n${t}`).join("\n\n———\n\n");
  const footer = canRevise
    ? ""
    : "\n\nМожно выбрать любой из вариантов — и новых, и прошлых. Если ни один не подходит — " +
      "пришли свой текст или откажись от заказа — дадим скидку 50% на следующее поздравление.";
  await ctx.reply(
    `Вот что получилось:\n\n${message}${footer}`,
    textVariantKeyboard(ctx.wizard.state.textVariants.length, canRevise)
  );
}

// Финал сценария: всё собрано -> дописываем в оплаченный заказ и сразу запускаем генерацию.
// Не ждём её здесь (до 10 минут) — видео придёт отдельным сообщением из fulfillGreetingOrder.
async function startGeneration(ctx) {
  const { orderId } = ctx.wizard.state;
  const order = updateOrder(orderId, {
    status: "generating",
    occasion: ctx.wizard.state.occasion,
    text: ctx.wizard.state.text,
    videoStyle: ctx.wizard.state.videoStyle,
    photoFileId: ctx.wizard.state.photoFileId,
    voiceFileId: ctx.wizard.state.voiceFileId,
  });
  await ctx.reply(
    "🎬 Генерация видео началась ⚡\nОбычно занимает не более 10 минут.\nЯ пришлю видео сюда, как только будет готово 🎧"
  );
  const telegram = ctx.telegram;
  fulfillGreetingOrder(telegram, order).catch(async (err) => {
    console.error("fulfillGreetingOrder failed:", err);
    updateOrder(orderId, { status: "failed", error: err.message });
    await telegram
      .sendMessage(order.chatId, `Не получилось создать видео: ${err.message}. Напиши нам — разберёмся и вернём деньги.`)
      .catch(() => {});
  });
  return ctx.scene.leave();
}

export const greetingWizard = new Scenes.WizardScene(
  "greeting-wizard",
  async (ctx) => {
    const order = ctx.wizard.state.orderId && getOrder(ctx.wizard.state.orderId);
    if (!order || (order.status !== "paid" && order.status !== "in_progress")) {
      await ctx.reply("Сначала нужно оплатить поздравление — жми /start.");
      return ctx.scene.leave();
    }
    updateOrder(order.orderId, { status: "in_progress" });
    await ctx.reply("По какому поводу поздравление?", occasionKeyboard);
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
      await ctx.reply("✍️ Пишу текст поздравления, два варианта — это займёт около 10 секунд...");
      await generateAndShowVariants(ctx);
    } catch (err) {
      await ctx.reply(`Не получилось обработать: ${err.message}`);
      return;
    }
    return ctx.wizard.next();
  },
  // Выбор варианта (или переделка) — обязательный шаг перед тем, как идти дальше.
  // Переделка одна (revisionRules.js) — каждый раунд стоит денег, а заказ уже оплачен.
  async (ctx) => {
    const action = ctx.callbackQuery?.data?.split(":")[1];
    const variantIndex = Number(action);

    if (Number.isInteger(variantIndex) && ctx.wizard.state.textVariants?.[variantIndex]) {
      await ctx.answerCbQuery();
      ctx.wizard.state.text = ctx.wizard.state.textVariants[variantIndex];
      await ctx.reply("Теперь пришли фото, которое станет основой поздравления.");
      // next() увёл бы на шаг "свой текст" (следующий по счёту, но не по смыслу) — текст
      // уже выбран, нужен сразу шаг приёма фото (тот же, куда попадает и ветка "свой текст").
      ctx.wizard.selectStep(ctx.wizard.cursor + 2);
      return;
    }

    if (action === "own") {
      await ctx.answerCbQuery();
      await ctx.reply(
        "Пришли свой текст поздравления — текстом, или голосовым сообщением (тогда этим же голосом " +
          "прочитает поздравление в видео)."
      );
      return ctx.wizard.next(); // -> шаг "свой текст"
    }

    if (action === "decline") {
      await ctx.answerCbQuery();
      const result = declineGreetingOrder(ctx.wizard.state.orderId, String(ctx.from.id));
      await ctx.reply(result.ok ? declineMessage(result.promo) : result.reason);
      return ctx.scene.leave();
    }

    if (action === "edit" && hasFreeRevisionsLeft(ctx.wizard.state.textRevisions ?? 0)) {
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
        await ctx.reply("✍️ Переписываю, снова два варианта — около 10 секунд...");
        await generateAndShowVariants(ctx);
      } catch (err) {
        await ctx.reply(`Не получилось переписать: ${err.message}`);
      }
      return; // остаёмся на этом же шаге, снова ждём выбор/переделку
    }

    if (ctx.callbackQuery) await ctx.answerCbQuery();
    await ctx.reply("Выбери кнопкой под вариантами выше.");
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
      // Заказ уже оплачен — не выкидываем из сценария, а просим другое фото.
      await ctx.reply(
        "Пока мы не можем обработать фото, где кроме поздравляемого есть кто-то ещё — " +
          "«оживление» чужого образа без согласия всех, кто на фото, мы не делаем, независимо от стиля.\n\n" +
          "Пришли, пожалуйста, другое фото — где только тот, кого поздравляем."
      );
      return ctx.wizard.back(); // -> снова шаг приёма фото
    }
    ctx.wizard.state.includesOthers = false;

    if (ctx.wizard.state.voiceFileId) {
      // Уже есть голос из шага "свой текст" (клиент наговорил его) — второй раз не спрашиваем.
      return startGeneration(ctx);
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
    return startGeneration(ctx);
  }
);
