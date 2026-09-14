import { Telegraf, Scenes, session } from "telegraf";
import { greetingWizard } from "./scenes/greeting.js";

console.log("DEBUG BOT_TOKENNP present:", Boolean(process.env.BOT_TOKENNP), "length:", (process.env.BOT_TOKENNP || "").length);
console.log("DEBUG all env keys:", Object.keys(process.env).filter(k => k.includes("BOT") || k.includes("TOKEN") || k.includes("MUREKA")));

const bot = new Telegraf(process.env.BOT_TOKENNP);
const stage = new Scenes.Stage([greetingWizard]);

bot.use(session());
bot.use(stage.middleware());

bot.start((ctx) =>
  ctx.reply(
    "Привет! Я помогу создать необычное поздравление.\n\n" +
      "1 — Анимированное видео-поздравление\n" +
      "2 — Именная песня + клип\n\n" +
      "Напиши 1 или 2, чтобы начать."
  )
);

bot.hears("1", (ctx) => ctx.scene.enter("greeting-wizard"));

bot.launch();
