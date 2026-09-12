import { Scenes } from "telegraf";
import { generateGreetingVideo } from "../services/heygen.js";

export const greetingWizard = new Scenes.WizardScene(
  "greeting-wizard",
  (ctx) => {
    ctx.reply("Пришли фото, которое станет основой поздравления.");
    return ctx.wizard.next();
  },
  (ctx) => {
    const photo = ctx.message?.photo?.at(-1);
    if (!photo) {
      ctx.reply("Нужно именно фото. Попробуй ещё раз.");
      return;
    }
    ctx.wizard.state.photoFileId = photo.file_id;
    ctx.reply("Теперь пришли текст поздравления.");
    return ctx.wizard.next();
  },
  async (ctx) => {
    const text = ctx.message?.text;
    if (!text) {
      ctx.reply("Нужен текст поздравления. Попробуй ещё раз.");
      return;
    }
    ctx.reply("Собираю поздравление, это займёт пару минут...");
    const videoUrl = await generateGreetingVideo({
      photoFileId: ctx.wizard.state.photoFileId,
      text,
    });
    await ctx.reply(`Готово! ${videoUrl}`);
    return ctx.scene.leave();
  }
);
