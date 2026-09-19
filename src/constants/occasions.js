import { Markup } from "telegraf";

export const OCCASIONS = [
  ["birthday", "🎂 День рождения"],
  ["newyear", "🎄 Новый год"],
  ["march8", "💐 8 Марта"],
  ["feb23", "🎖 23 Февраля"],
  ["feb14", "❤️ 14 Февраля"],
  ["wedding", "💍 Свадьба / годовщина"],
  ["birth", "👶 Рождение ребёнка"],
  ["graduation", "🎓 Выпускной"],
  ["love", "💌 Признание в любви"],
  ["other", "✨ Без повода / другое"],
];

export const occasionKeyboard = Markup.inlineKeyboard(
  OCCASIONS.map(([code, label]) => Markup.button.callback(label, `occasion:${code}`)),
  { columns: 2 }
);

export function occasionLabel(code) {
  return OCCASIONS.find(([c]) => c === code)?.[1] ?? code;
}
