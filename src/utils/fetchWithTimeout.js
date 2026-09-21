// Обычный fetch не имеет тайм-аута: подвисшее соединение не резолвится и не реджектится,
// бот просто зависает навсегда (реальный инцидент с зависшим вызовом внешнего API в проекте den-rozhdeniya).
export async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Запрос к ${url} превысил тайм-аут ${timeoutMs}мс`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
