import { pool } from "../db/index.js";

export const likeUser = async (req, res) => {
  try {
    const from = req.user.id;
    const { to } = req.body;

    if (!to) return res.status(400).json({ error: "Target user ID (to) is required" });

    // 1. იუზერის ლაიქების სტატუსის ამოღება
    const userRes = await pool.query("SELECT likes_left, last_like_reset FROM users WHERE id = $1", [from]);

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    let { likes_left, last_like_reset } = userRes.rows[0];
    const now = new Date();
    const lastReset = new Date(last_like_reset || 0);

    // დროის განსხვავება საათებში
    const hoursPassed = (now - lastReset) / (1000 * 60 * 60);

    // 2. თუ 12 საათი ან მეტია გასული, ვანახლებთ ლიმიტს 30-მდე
    if (hoursPassed >= 12) {
      likes_left = 30;
      last_like_reset = now;

      await pool.query("UPDATE users SET likes_left = $1, last_like_reset = $2 WHERE id = $3", [
        likes_left,
        last_like_reset,
        from,
      ]);
    }

    // 3. თუ ლაიქები ამოწურულია
    if (likes_left <= 0) {
      // ვითვლით რამდენი წუთი დარჩა განახლებამდე
      const nextReset = new Date(lastReset.getTime() + 12 * 60 * 60 * 1000);
      const minutesLeft = Math.ceil((nextReset - now) / (1000 * 60));

      return res.status(429).json({
        error: "დღიური ლაიქების ლიმიტი ამოიწურა!",
        likes_left: 0,
        nextResetInMinutes: minutesLeft,
      });
    }

    // 4. ლაიქის ჩაწერა (თუ უკვე არსებობს, არაფერს იზამს)
    await pool.query("INSERT INTO likes (from_user_id, to_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [from, to]);

    // 5. ლაიქის ჩამოჭრა (-1)
    const updatedLikesLeft = likes_left - 1;
    await pool.query("UPDATE users SET likes_left = $1 WHERE id = $2", [updatedLikesLeft, from]);

    // 6. შემოწმება: ხომ არ დაგვალაიქა ამ იუზერმაც? (MATCH check)
    const matchCheck = await pool.query("SELECT * FROM likes WHERE from_user_id = $1 AND to_user_id = $2", [to, from]);

    if (matchCheck.rows.length > 0) {
      // მეტჩის ჩაწერა (დუბლიკატის დაზღვევით)
      await pool.query("INSERT INTO matches (user1_id, user2_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [from, to]);
      return res.json({ match: true, likes_left: updatedLikesLeft });
    }

    res.json({ match: false, likes_left: updatedLikesLeft });
  } catch (err) {
    console.error("LIKE ERROR:", err);
    res.status(500).json({ error: "ლაიქის პროცესი დაფეილდა" });
  }
};

// დამატებითი ენდფოინტი: იუზერის დარჩენილი ლაიქების შესამოწმებლად (ფრონტენდზე საჩვენებლად)
export const getLikesStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRes = await pool.query("SELECT likes_left, last_like_reset FROM users WHERE id = $1", [userId]);

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    let { likes_left, last_like_reset } = userRes.rows[0];
    const now = new Date();
    const lastReset = new Date(last_like_reset || 0);
    const hoursPassed = (now - lastReset) / (1000 * 60 * 60);

    if (hoursPassed >= 12) {
      likes_left = 30;
      await pool.query("UPDATE users SET likes_left = $1, last_like_reset = $2 WHERE id = $3", [30, now, userId]);
    }

    res.json({ likes_left, last_like_reset });
  } catch (err) {
    console.error("GET LIKES STATUS ERROR:", err);
    res.status(500).json({ error: "სტატუსის წამოღება დაფეილდა" });
  }
};
