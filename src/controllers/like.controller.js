import { pool } from "../db/index.js";

export const likeUser = async (req, res) => {
  try {
    const from = req.user.id;
    const { to } = req.body;

    if (!to) return res.status(400).json({ error: "Target user ID (to) is required" });

    // ლაიქის ჩაწერა (თუ უკვე არსებობს, არაფერს იზამს)
    await pool.query("INSERT INTO likes (from_user_id, to_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [from, to]);

    // შემოწმება: ხომ არ დაგვალაიქა ამ იუზერმაც?
    const matchCheck = await pool.query("SELECT * FROM likes WHERE from_user_id = $1 AND to_user_id = $2", [to, from]);

    if (matchCheck.rows.length > 0) {
      // მეტჩის ჩაწერა (დუბლიკატის დაზღვევით)
      await pool.query("INSERT INTO matches (user1_id, user2_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [from, to]);
      return res.json({ match: true });
    }

    res.json({ match: false });
  } catch (err) {
    console.error("LIKE ERROR:", err);
    res.status(500).json({ error: "ლაიქის პროცესი დაფეილდა" });
  }
};
