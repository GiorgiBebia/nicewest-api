import { pool } from "../db/index.js";
import { notifyUser } from "../services/notification.service.js";

export const likeUser = async (req, res) => {
  try {
    const from = req.user.id;
    const { to } = req.body;

    if (!to)
      return res.status(400).json({ error: "Target user ID (to) is required" });

    // 1. შევამოწმოთ, უკვე დალაიქებული ხომ არ ჰყავს ეს მომხმარებელი
    const existingLike = await pool.query(
      "SELECT id FROM likes WHERE from_user_id = $1 AND to_user_id = $2",
      [from, to],
    );

    if (existingLike.rows.length > 0) {
      const userRes = await pool.query(
        "SELECT likes_left FROM users WHERE id = $1",
        [from],
      );
      return res.json({
        match: false,
        likes_left: userRes.rows[0]?.likes_left ?? 0,
      });
    }

    // 2. შევამოწმოთ და განვაახლოთ 12-საათიანი ტაიმერი
    const userRes = await pool.query(
      "SELECT likes_left, last_like_reset, full_name FROM users WHERE id = $1",
      [from],
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    let {
      likes_left,
      last_like_reset,
      full_name: senderName,
    } = userRes.rows[0];
    const now = new Date();
    const lastReset = new Date(last_like_reset || 0);
    const hoursPassed = (now - lastReset) / (1000 * 60 * 60);

    if (hoursPassed >= 12) {
      await pool.query(
        "UPDATE users SET likes_left = 30, last_like_reset = $1 WHERE id = $2",
        [now, from],
      );
      likes_left = 30;
      last_like_reset = now;
    }

    // 3. ATOMIC UPDATE: ლაიქის ჩამოჭრა
    const decrementRes = await pool.query(
      "UPDATE users SET likes_left = likes_left - 1 WHERE id = $1 AND likes_left > 0 RETURNING likes_left, last_like_reset",
      [from],
    );

    if (decrementRes.rows.length === 0) {
      const nextReset = new Date(
        new Date(last_like_reset).getTime() + 12 * 60 * 60 * 1000,
      );
      const minutesLeft = Math.max(
        1,
        Math.ceil((nextReset - now) / (1000 * 60)),
      );

      return res.status(429).json({
        error: "დღიური ლაიქების ლიმიტი ამოიწურა!",
        likes_left: 0,
        nextResetInMinutes: minutesLeft,
      });
    }

    const updatedLikesLeft = decrementRes.rows[0].likes_left;

    // 4. ლაიქის ჩაწერა likes ცხრილში
    await pool.query(
      "INSERT INTO likes (from_user_id, to_user_id) VALUES ($1, $2)",
      [from, to],
    );

    // 5. შემოწმება MATCH-ზე
    const matchCheck = await pool.query(
      "SELECT * FROM likes WHERE from_user_id = $1 AND to_user_id = $2",
      [to, from],
    );

    if (matchCheck.rows.length > 0) {
      await pool.query(
        "INSERT INTO matches (user1_id, user2_id) VALUES ($1, $2)",
        [from, to],
      );

      const targetUserRes = await pool.query(
        "SELECT full_name FROM users WHERE id = $1",
        [to],
      );
      const targetName = targetUserRes.rows[0]?.full_name || "მომხმარებელმა";

      notifyUser(
        to,
        "ახალი Match! 🎉",
        `შენ და ${senderName || "მომხმარებელმა"} მოეწონეთ ერთმანეთი!`,
        {
          type: "match",
          targetUserId: from,
        },
      );

      notifyUser(
        from,
        "ახალი Match! 🎉",
        `შენ და ${targetName} მოეწონეთ ერთმანეთი!`,
        {
          type: "match",
          targetUserId: to,
        },
      );

      return res.json({ match: true, likes_left: updatedLikesLeft });
    }

    res.json({ match: false, likes_left: updatedLikesLeft });
  } catch (err) {
    console.error("LIKE ERROR:", err);
    res.status(500).json({ error: "ლაიქის პროცესი დაფეილდა" });
  }
};

export const dislikeUser = async (req, res) => {
  try {
    const from = req.user.id;
    const { to } = req.body;

    if (!to)
      return res.status(400).json({ error: "Target user ID (to) is required" });

    const existing = await pool.query(
      "SELECT id FROM dislikes WHERE from_user_id = $1 AND to_user_id = $2",
      [from, to],
    );

    if (existing.rows.length === 0) {
      await pool.query(
        "INSERT INTO dislikes (from_user_id, to_user_id) VALUES ($1, $2)",
        [from, to],
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DISLIKE ERROR:", err);
    res.status(500).json({ error: "დისლაიქის პროცესი დაფეილდა" });
  }
};

export const getLikesStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRes = await pool.query(
      "SELECT likes_left, last_like_reset FROM users WHERE id = $1",
      [userId],
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    let { likes_left, last_like_reset } = userRes.rows[0];
    const now = new Date();
    const lastReset = new Date(last_like_reset || 0);
    const hoursPassed = (now - lastReset) / (1000 * 60 * 60);

    if (hoursPassed >= 12) {
      likes_left = 30;
      await pool.query(
        "UPDATE users SET likes_left = 30, last_like_reset = $1 WHERE id = $2",
        [now, userId],
      );
    }

    res.json({ likes_left, last_like_reset });
  } catch (err) {
    console.error("GET LIKES STATUS ERROR:", err);
    res.status(500).json({ error: "სტატუსის წამოღება დაფეილდა" });
  }
};

export const getUsersWhoLikedMe = async (req, res) => {
  try {
    const userId = req.user.id;

    const query = `
      SELECT 
        u.id, 
        u.full_name, 
        u.age, 
        u.city, 
        u.bio, 
        u.interests,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT('image_url', p.image_url, 'position', p.position, 'is_main', p.is_main) 
            ORDER BY p.position ASC
          ) FILTER (WHERE p.id IS NOT NULL), '[]'
        ) AS photos
      FROM likes l
      JOIN users u ON l.from_user_id = u.id
      LEFT JOIN photos p ON u.id = p.user_id
      WHERE l.to_user_id = $1
        AND u.id NOT IN (SELECT to_user_id FROM likes WHERE from_user_id = $1)
        AND u.id NOT IN (SELECT to_user_id FROM dislikes WHERE from_user_id = $1)
        AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $1)
        AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = $1)
      GROUP BY u.id, u.full_name, u.age, u.city, u.bio, u.interests, l.created_at
      ORDER BY l.created_at DESC;
    `;

    const result = await pool.query(query, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("GET USERS WHO LIKED ME ERROR:", err);
    res.status(500).json({ error: "მონაცემების წამოღება ვერ მოხერხდა" });
  }
};

export const addRewardLikes = async (req, res) => {
  try {
    const userId = req.user.id;
    const amount = req.body.amount || 5;

    const updateRes = await pool.query(
      "UPDATE users SET likes_left = likes_left + $1 WHERE id = $2 RETURNING likes_left",
      [amount, userId],
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    res.json({ success: true, likes_left: updateRes.rows[0].likes_left });
  } catch (err) {
    console.error("ADD REWARD LIKES ERROR:", err);
    res.status(500).json({ error: "ბონუს ლაიქების დამატება დაფეილდა" });
  }
};
