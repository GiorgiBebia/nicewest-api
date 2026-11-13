import cron from "node-cron";
import { pool } from "../db/index.js";
import { purgeOldDeletedPhotos } from "./storage.service.js";

// წაშლილი ანგარიშების არქივი ინახება მხოლოდ შეზღუდული ვადით (თაღლითობისგან და დარღვევებისგან დასაცავად),
// შემდეგ საბოლოოდ იშლება. ეს ვადა privacy policy-შიც წერია (90 დღე). შეცვლა: RETENTION_DAYS env.
const DAYS = Math.max(30, Number(process.env.RETENTION_DAYS) || 90);

const TABLES = [
  "deleted_users",
  "deleted_messages",
  "deleted_photos",
  "deleted_likes",
  "deleted_images",
];

export const runRetention = async () => {
  for (const table of TABLES) {
    try {
      const r = await pool.query(
        `DELETE FROM ${table} WHERE deleted_at < NOW() - ($1 || ' days')::interval`,
        [String(DAYS)],
      );
      if (r.rowCount > 0)
        console.log(`[RETENTION] ${table}: წაიშალა ${r.rowCount} ჩანაწერი`);
    } catch (e) {
      console.error(`[RETENTION ERROR] ${table}:`, e.message);
    }
  }
  const files = await purgeOldDeletedPhotos(DAYS);
  if (files > 0)
    console.log(`[RETENTION] storage deleted/: წაიშალა ${files} ფაილი`);
};

export const initRetentionCron = () => {
  // ყოველდღე 03:30-ზე (სერვერის დროით)
  cron.schedule("30 3 * * *", () => {
    runRetention().catch((e) => console.error("[RETENTION ERROR]", e));
  });
};
