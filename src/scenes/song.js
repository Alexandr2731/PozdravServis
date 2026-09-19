import { Scenes } from "telegraf";
import { occasionKeyboard, occasionLabel } from "../constants/occasions.js";
import { generateLyrics, generateSong, waitForSong } from "../services/mureka.js";

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
      const lyricsPrompt =
        `Напиши текст поздравительной песни на русском языке.\n` +
        `Повод: ${ctx.wizard.state.occasion}.\n` +
        `О человеке: ${ctx.wizard.state.personInfo}.\n` +
        `Стиль/настроение: ${style}.`;
      const lyrics = await generateLyrics(lyricsPrompt);
      ctx.wizard.state.lyrics = lyrics;
      await ctx.reply(`Вот текст песни:\n\n${lyrics}\n\nСобираю музыку, это займёт пару минут...`);

      const taskId = await generateSong({ lyrics, stylePrompt: style });
      const { mp3Url, videoUrl } = await waitForSong(taskId);

      if (mp3Url) await ctx.replyWithAudio(mp3Url, { caption: "Готово! Вот твоя песня 🎵" });
      if (videoUrl) await ctx.replyWithVideo(videoUrl, { caption: "И клип к ней 🎬" });
      if (!mp3Url && !videoUrl) await ctx.reply("Песня сгенерирована, но не удалось получить файл.");
    } catch (err) {
      await ctx.reply(`Не получилось создать песню: ${err.message}`);
    }
    return ctx.scene.leave();
  }
);
