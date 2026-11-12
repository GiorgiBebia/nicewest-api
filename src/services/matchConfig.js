// Match-ის ვადის პარამეტრები. შეგიძლია Render-ის env-ით შეცვალო (MATCH_TTL_HOURS=24 და ა.შ.)
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const MATCH_TTL_HOURS = int(process.env.MATCH_TTL_HOURS, 48); // რამდენ საათში იწურება Match, თუ არავინ დაწერა
export const MATCH_REMINDER_HOURS = int(process.env.MATCH_REMINDER_HOURS, 10); // შეხსენების ინტერვალი
export const REVIEW_LOCK_TTL_MINUTES = int(
  process.env.REVIEW_LOCK_TTL_MINUTES,
  3,
); // ადმინის "დაკავების" ვადა (heartbeat-ის გარეშე)
