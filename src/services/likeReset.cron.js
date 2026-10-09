import cron from "node-cron";
import { pool } from "../db/index.js";
import { notifyUser } from "./notification.service.js";

export const initLikeResetCron = () => {
  // ყოველ 5 წუთში ერთხელ შემოწმება
  cron.schedule("*/5 * * * *", async () => {
    try {
      const query = `
        UPDATE users
        SET likes_left = 30,
            last_like_reset = NOW()
        WHERE likes_left < 30
          AND last_like_reset <= NOW() - INTERVAL '12 hours'
        RETURNING id;
      `;

      const result = await pool.query(query);

      for (const row of result.rows) {
        await notifyUser(
          row.id,
          "მოწონებები განახლდა! 🎉",
          "შენი 30 დღიური მოწონება კვლავ აქტიურია. დაბრუნდი აპლიკაციაში!",
          { type: "likes_reset" },
        );
      }

      if (result.rows.length > 0) {
        console.log(
          `[CRON] ${result.rows.length} მომხმარებელს აღუდგა ლაიქები და გაეგზავნა ნოთიფიკაცია.`,
        );
      }
    } catch (error) {
      console.error("[CRON ERROR] ლაიქების აღდგენა დაფეილდა:", error);
    }
  });
};
