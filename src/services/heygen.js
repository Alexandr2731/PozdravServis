const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;

// TODO: заменить на реальный вызов HeyGen API, когда появится ключ.
// Документация: https://docs.heygen.com/
export async function generateGreetingVideo({ photoFileId, text }) {
  if (!HEYGEN_API_KEY) {
    throw new Error("HEYGEN_API_KEY не задан — добавь его через /settings");
  }
  throw new Error("generateGreetingVideo ещё не реализован");
}
