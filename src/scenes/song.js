import { Scenes, Markup } from "telegraf";
import { occasionKeyboard, occasionLabel } from "../constants/occasions.js";
import { generateLyrics, generateSong, waitForSong } from "../services/mureka.js";

const lyricsReviewKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("✅ Всё нравится, делай музыку", "lyrics:ok"),
  Markup.button.callback("✏️ Поправить текст", "lyrics:edit"),
]);

function buildLyricsPrompt({ occasion, personInfo, style }, feedback) {
  const base =
    `Напиши текст поздравительной песни на русском языке.\n` +
    `Повод: ${occasion}.\n` +
    `О человеке: ${personInfo}.\n` +
    `Стиль/настроение: ${style}.`;
  return feedback ? `${base}\n\nПравка от клиента к предыдущему варианту: ${feedback}` : base;
}

export const songWizard = new Scenes.WizardScene(
  "song-wizard",
  (ctx) => {
    ctx.reply("По какому поводу песня?", occasionKeyboard);
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
    await ctx.reply(
      "Расскажи о человеке, кого поздравляем: имя, что любит, за что цените. Это станет основой текста песни."
    );
    return ctx.wizard.next();
  },
  (ctx) => {
    const info = ctx.message?.text;
    if (!info) {
      ctx.reply("Нужно текстовое описание. Попробуй ещё раз.");
      return;
    }
    ctx.wizard.state.personInfo = info;
    ctx.reply(
      "В каком музыкальном стиле сделать песню? Опиши свободно — жанр, настроение, можно указать на кого хочешь быть похожим по звучанию (например «как у Билана», «весёлая поп-баллада», «шансон»)."
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const style = ctx.message?.text;
    if (!style) {
      ctx.reply("Нужно описание стиля. Попробуй ещё раз.");
      return;
    }
    ctx.wizard.state.style = style;
    await ctx.reply("Пишу текст песни...");
    try {
      const lyrics = await generateLyrics(buildLyricsPrompt(ctx.wizard.state));
      ctx.wizard.state.lyrics = lyrics;
      await ctx.reply(`Вот текст песни:\n\n${lyrics}`, lyricsReviewKeyboard);
    } catch (err) {
      await ctx.reply(`Не получилось написать текст: ${err.message}`);
      return ctx.scene.leave();
    }
    return ctx.wizard.next();
  },
  // Одобрение текста ПЕРЕД платной генерацией музыки (Mureka) — текст можно править
  // сколько угодно раз бесплатно, музыка генерируется только после явного "нравится".
  // Раньше музыка запускалась сразу же после показа текста, без этого шага.
  async (ctx) => {
    const action = ctx.callbackQuery?.data?.split(":")[1];

    if (action === "edit") {
      await ctx.answerCbQuery();
      await ctx.reply("Что поправить в тексте? Опиши свободно.");
      ctx.wizard.state.awaitingLyricsFeedback = true;
      return; // остаёмся на этом же шаге, ждём текст с правкой
    }

    if (action === "ok") {
      await ctx.answerCbQuery();
      await ctx.reply("Собираю музыку, это займёт пару минут...");
      try {
        const taskId = await generateSong({ lyrics: ctx.wizard.state.lyrics, stylePrompt: ctx.wizard.state.style });
        const { choices } = await waitForSong(taskId);

        // Mureka отдаёт 2 варианта — показываем оба, а не только первый (раньше второй
        // терялся). Полноценный выбор варианта клиентом + бесплатный передел — часть
        // ещё не готовой механики оплаты (см. критический разбор плана), пока просто
        // не выбрасываем то, за что уже заплачен вызов Mureka.
        for (const [i, choice] of choices.entries()) {
          await ctx.replyWithAudio(choice.mp3Url, { caption: `Вариант ${i + 1} из ${choices.length} 🎵` });
        }
      } catch (err) {
        await ctx.reply(`Не получилось создать песню: ${err.message}`);
      }
      return ctx.scene.leave();
    }

    if (ctx.wizard.state.awaitingLyricsFeedback && ctx.message?.text) {
      const feedback = ctx.message.text;
      ctx.wizard.state.awaitingLyricsFeedback = false;
      await ctx.reply("Переписываю текст с учётом правки...");
      try {
        const lyrics = await generateLyrics(buildLyricsPrompt(ctx.wizard.state, feedback));
        ctx.wizard.state.lyrics = lyrics;
        await ctx.reply(`Вот обновлённый текст:\n\n${lyrics}`, lyricsReviewKeyboard);
      } catch (err) {
        await ctx.reply(`Не получилось переписать текст: ${err.message}`);
      }
      return; // остаёмся на этом же шаге, снова ждём "ok"/"edit"
    }

    ctx.reply("Выбери кнопкой выше: текст устраивает, или его нужно поправить.");
  }
);
