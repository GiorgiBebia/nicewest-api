import { pool } from "../db/index.js";
import { notifyUser } from "../services/notification.service.js";

const DAILY_LIKES = 30; // ერთ ციკლში მისაცემი ლაიქები
const RESET_HOURS = 12; // ციკლის ხანგრძლივობა
const REWARD_AMOUNT = 5; // ერთი რეკლამის ნახვის ჯილდო (სერვერზე ფიქსირებულია)
const REWARD_MAX_PER_DAY = 5; // დღეში მაქსიმუმ რამდენჯერ
const REWARD_MIN_GAP_SECONDS = 20; // ორ ჯილდოს შორის მინიმალური დრო

const minutesUntilReset = (lastReset, now) => {
  const next = new Date(lastReset).getTime() + RESET_HOURS * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((next - now.getTime()) / 60000));
};

const parseUserId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export const likeUser = async (req, res) => {
  const from = req.user.id;
  const to = parseUserId(req.body?.to);

  if (!to) {
    return res.status(400).json({ error: "Target user ID (to) is required" });
  }
  if (to === from) {
    return res.status(400).json({ error: "საკუთარ თავს ვერ დალაიქებთ" });
  }

  const client = await pool.connect();
  let notifyReset = false;
  let newMatch = false;
  let senderName = null;
  let targetName = null;

  try {
    await client.query("BEGIN");

    // 1. სამიზნე მომხმარებელი უნდა არსებობდეს, დამტკიცებული იყოს და დაბლოკილი არ იყოს
    const target = await client.query(
      `SELECT u.id, u.full_name FROM users u
       WHERE u.id = $1
         AND u.status = 'approved'
         AND COALESCE(u.is_banned, false) = false
         AND NOT EXISTS (
           SELECT 1 FROM blocks b
           WHERE (b.blocker_id = $2 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $2)
         )`,
      [to, from],
    );

    if (target.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "მომხმარებელი მიუწვდომელია" });
    }
    targetName = target.rows[0].full_name;

    // 2. გამგზავნის სტრიქონის დაბლოკვა: ერთი მომხმარებლის პარალელური ლაიქები რიგში დგება
    const meRes = await client.query(
      "SELECT likes_left, last_like_reset, full_name FROM users WHERE id = $1 FOR UPDATE",
      [from],
    );

    if (meRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    let { likes_left, last_like_reset } = meRes.rows[0];
    senderName = meRes.rows[0].full_name;

    const now = new Date();
    let lastReset = last_like_reset ? new Date(last_like_reset) : null;
    const hoursPassed = lastReset ? (now - lastReset) / 36e5 : Infinity;

    // 3. 12 საათი გავიდა: ლაიქები 30-მდე ივსება (ბონუსით მიღებულს არ ვაკლებთ)
    if (!lastReset || hoursPassed >= RESET_HOURS) {
      notifyReset = likes_left < DAILY_LIKES && likes_left <= 0;
      likes_left = Math.max(likes_left, DAILY_LIKES);
      lastReset = now;
      await client.query("UPDATE users SET likes_left = $1, last_like_reset = $2 WHERE id = $3", [
        likes_left,
        now,
        from,
      ]);
    }

    // 4. ლაიქის ჩაწერა. თუ უკვე არსებობს, ლაიქი არ იკლება და არაფერი მეორდება
    const ins = await client.query(
      `INSERT INTO likes (from_user_id, to_user_id) VALUES ($1, $2)
       ON CONFLICT (from_user_id, to_user_id) DO NOTHING
       RETURNING id`,
      [from, to],
    );

    if (ins.rowCount === 0) {
      await client.query("COMMIT");
      return res.json({ match: false, likes_left });
    }

    // 5. ლიმიტის შემოწმება. თუ ამოწურულია, ჩაწერილ ლაიქს უკან ვაბრუნებთ
    if (likes_left <= 0) {
      await client.query("ROLLBACK");
      return res.status(429).json({
        error: "დღიური ლაიქების ლიმიტი ამოიწურა!",
        likes_left: 0,
        nextResetInMinutes: minutesUntilReset(lastReset || now, now),
      });
    }

    // 6. ლაიქის ჩამოჭრა. თუ ციკლი სავსე იყო, ტაიმერი პირველი ლაიქიდან იწყება
    const dec = await client.query(
      `UPDATE users
       SET likes_left = likes_left - 1,
           last_like_reset = CASE WHEN likes_left >= $1 THEN $2 ELSE last_like_reset END
       WHERE id = $3
       RETURNING likes_left`,
      [DAILY_LIKES, now, from],
    );
    const updatedLikesLeft = dec.rows[0].likes_left;

    // 7. ორმხრივი ლაიქი: match იქმნება მხოლოდ ერთხელ (უნიკალური წყვილი)
    const reverse = await client.query("SELECT 1 FROM likes WHERE from_user_id = $1 AND to_user_id = $2", [to, from]);

    let isMatch = false;
    if (reverse.rows.length > 0) {
      isMatch = true;
      const [u1, u2] = from < to ? [from, to] : [to, from];
      const m = await client.query(
        `INSERT INTO matches (user1_id, user2_id) VALUES ($1, $2)
         ON CONFLICT (user1_id, user2_id) DO NOTHING
         RETURNING id`,
        [u1, u2],
      );
      newMatch = m.rowCount > 0;
    }

    await client.query("COMMIT");

    // შეტყობინებები კომიტის შემდეგ, ფონურად
    if (notifyReset) {
      notifyUser(from, "მოწონებები განახლდა! 🎉", "შენი 30 დღიური მოწონება კვლავ აქტიურია. დაბრუნდი აპლიკაციაში!", {
        type: "likes_reset",
      });
    }

    if (newMatch) {
      notifyUser(to, "ახალი Match! 🎉", `შენ და ${senderName || "მომხმარებელმა"} მოეწონეთ ერთმანეთი!`, {
        type: "match",
        targetUserId: from,
      });
      notifyUser(from, "ახალი Match! 🎉", `შენ და ${targetName || "მომხმარებელმა"} მოეწონეთ ერთმანეთი!`, {
        type: "match",
        targetUserId: to,
      });
    }

    return res.json({ match: isMatch, likes_left: updatedLikesLeft });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("LIKE ERROR:", err);
    res.status(500).json({ error: "ლაიქის პროცესი დაფეილდა" });
  } finally {
    client.release();
  }
};

export const dislikeUser = async (req, res) => {
  try {
    const from = req.user.id;
    const to = parseUserId(req.body?.to);

    if (!to) {
      return res.status(400).json({ error: "Target user ID (to) is required" });
    }
    if (to === from) {
      return res.status(400).json({ error: "არასწორი მომხმარებელი" });
    }

    await pool.query(
      `INSERT INTO dislikes (from_user_id, to_user_id)
       SELECT $1, u.id FROM users u WHERE u.id = $2
       ON CONFLICT (from_user_id, to_user_id) DO NOTHING`,
      [from, to],
    );

    res.json({ success: true });
  } catch (err) {
    console.error("DISLIKE ERROR:", err);
    res.status(500).json({ error: "დისლაიქის პროცესი დაფეილდა" });
  }
};

export const getLikesStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRes = await pool.query("SELECT likes_left, last_like_reset FROM users WHERE id = $1", [userId]);

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    let { likes_left, last_like_reset } = userRes.rows[0];
    const now = new Date();
    const lastReset = last_like_reset ? new Date(last_like_reset) : null;
    const hoursPassed = lastReset ? (now - lastReset) / 36e5 : Infinity;

    if (!lastReset || hoursPassed >= RESET_HOURS) {
      const wasEmpty = likes_left <= 0;
      likes_left = Math.max(likes_left, DAILY_LIKES);
      last_like_reset = now;
      await pool.query("UPDATE users SET likes_left = $1, last_like_reset = $2 WHERE id = $3", [
        likes_left,
        now,
        userId,
      ]);

      if (wasEmpty) {
        notifyUser(userId, "მოწონებები განახლდა! 🎉", "შენი 30 დღიური მოწონება კვლავ აქტიურია. დაბრუნდი აპლიკაციაში!", {
          type: "likes_reset",
        });
      }
    }

    // დარჩენილი წუთები, თუ ლაიქები 0-ია
    let nextResetInMinutes = 0;
    if (likes_left <= 0 && last_like_reset) {
      nextResetInMinutes = minutesUntilReset(last_like_reset, now);
    }

    res.json({ likes_left, last_like_reset, nextResetInMinutes });
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
        AND u.status = 'approved'
        AND COALESCE(u.is_banned, false) = false
        AND NOT EXISTS (SELECT 1 FROM likes x WHERE x.from_user_id = $1 AND x.to_user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM dislikes x WHERE x.from_user_id = $1 AND x.to_user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))
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

// ბონუს ლაიქები რეკლამის ნახვისთვის. რაოდენობას სერვერი განსაზღვრავს (კლიენტის amount იგნორირდება).
// შენიშვნა: სრულ დაცვას AdMob-ის server-side verification მოითხოვს. აქ არის დღიური ლიმიტი
// და მინიმალური დროის ინტერვალი, რომ ულიმიტო ლაიქების აღება შეუძლებელი იყოს.
export const addRewardLikes = async (req, res) => {
  const userId = req.user.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // ერთი მომხმარებლის პარალელური მოთხოვნები რიგში დგება
    await client.query("SELECT pg_advisory_xact_lock($1)", [userId]);

    const recent = await client.query(
      `SELECT COUNT(*)::int AS c, MAX(created_at) AS last
       FROM reward_claims
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId],
    );
    const { c, last } = recent.rows[0];

    if (c >= REWARD_MAX_PER_DAY) {
      await client.query("ROLLBACK");
      return res.status(429).json({
        error: "დღიური ბონუსის ლიმიტი ამოიწურა",
        code: "REWARD_LIMIT",
      });
    }

    if (last && Date.now() - new Date(last).getTime() < REWARD_MIN_GAP_SECONDS * 1000) {
      await client.query("ROLLBACK");
      return res.status(429).json({ error: "ძალიან სწრაფად ითხოვთ ბონუსს", code: "REWARD_TOO_FAST" });
    }

    await client.query("INSERT INTO reward_claims (user_id) VALUES ($1)", [userId]);

    const updateRes = await client.query(
      "UPDATE users SET likes_left = likes_left + $1 WHERE id = $2 RETURNING likes_left",
      [REWARD_AMOUNT, userId],
    );

    if (updateRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    await client.query("COMMIT");
    res.json({ success: true, likes_left: updateRes.rows[0].likes_left });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("ADD REWARD LIKES ERROR:", err);
    res.status(500).json({ error: "ბონუს ლაიქების დამატება დაფეილდა" });
  } finally {
    client.release();
  }
};
