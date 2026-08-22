export const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ";

export const genCode = () =>
  Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");

export const genId = () => Math.random().toString(36).slice(2, 10);

export const normalize = (s) => (s || "").toLowerCase().trim().replace(/[^a-z0-9 ]/g, "");

export const isCorrect = (guess, answer) => {
  const g = normalize(guess);
  const a = normalize(answer);
  if (!g || !a) return false;
  if (g === a) return true;
  if (a.length > 3 && g.includes(a)) return true;
  if (g.length > 3 && a.includes(g)) return true;
  return false;
};
