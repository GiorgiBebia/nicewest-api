import cron from "node-cron";
import { pool } from "../db/index.js";
import { notifyUserT } from "./notification.service.js";
import { MATCH_REMINDER_HOURS, MATCH_TTL_HOURS } from "./matchConfig.js";

// "მიმოწერა არ დაწყებულა" = ამ წყვილს შორის არცერთი შეტყობინება არ არსებობს
const NO_MESSAGES = `
  NOT EXISTS (
    SELECT 1 FROM messages x
    WHERE (x.sender_id = m.user1_id AND x.receiver_id = m.user2_id)
       OR (x.sender_id = m.user2_id AND x.receiver_id = m.user1_id)
  )`;

const NOT_BLOCKED_AND_ACTIVE = `
  NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE (b.blocker_id = m.user1_id AND b.blocked_id = m.user2_id)
       OR (b.blocker_id = m.user2_id AND b.blocked_id = m.user1_id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM users bu
    WHERE bu.id IN (m.user1_id, m.user2_id) AND COALESCE(bu.is_banned, false) = true
  )`;

// 1) ვადაგასული Match-ები: ვადა გავიდა და არავის დაუწერია
const expireMatches = async () => {
  const res = await pool.query(
    `WITH exp AS (
       UPDATE matches m
       SET expired_at = NOW()
       WHERE m.expired_at IS NULL
         AND m.matched_at <= NOW() - make_interval(hours => $1::int)
         AND ${NO_MESSAGES}
       RETURNING m.id, m.user1_id, m.user2_id
     )
     SELECT e.id, e.user1_id, e.user2_id, u1.full_name AS name1, u2.full_name AS name2
     FROM exp e
     JOIN users u1 ON u1.id = e.user1_id
     JOIN users u2 ON u2.id = e.user2_id`,
    [MATCH_TTL_HOURS],
  );

  for (const r of res.rows) {
    await notifyUserT(
      r.user1_id,
      "match_expired",
      { name: r.name2 || "" },
      { type: "match_expired" },
    );
    await notifyUserT(
      r.user2_id,
      "match_expired",
      { name: r.name1 || "" },
      { type: "match_expired" },
    );
  }
  if (res.rows.length)
    console.log(`[CRON] ვადა გაუვიდა ${res.rows.length} Match-ს`);
};

// 2) შეხსენება ყოველ MATCH_REMINDER_HOURS საათში (ორივე მხარეს), სანამ მიმოწერა არ დაიწყება
const remindMatches = async () => {
  const res = await pool.query(
    `WITH due AS (
       UPDATE matches m
       SET last_reminder_at = NOW()
       WHERE m.expired_at IS NULL
         AND m.matched_at > NOW() - make_interval(hours => $1::int)
         AND COALESCE(m.last_reminder_at, m.matched_at) <= NOW() - make_interval(hours => $2::int)
         AND ${NO_MESSAGES}
         AND ${NOT_BLOCKED_AND_ACTIVE}
       RETURNING m.id, m.user1_id, m.user2_id, m.matched_at
     )
     SELECT d.id, d.user1_id, d.user2_id, d.matched_at, u1.full_name AS name1, u2.full_name AS name2
     FROM due d
     JOIN users u1 ON u1.id = d.user1_id
     JOIN users u2 ON u2.id = d.user2_id`,
    [MATCH_TTL_HOURS, MATCH_REMINDER_HOURS],
  );

  for (const r of res.rows) {
    const hoursLeft = Math.max(
      1,
      Math.ceil(
        MATCH_TTL_HOURS -
          (Date.now() - new Date(r.matched_at).getTime()) / 36e5,
      ),
    );
    await notifyUserT(
      r.user1_id,
      "match_reminder",
      { name: r.name2 || "", hours: hoursLeft },
      { type: "match_reminder", targetUserId: r.user2_id },
    );
    await notifyUserT(
      r.user2_id,
      "match_reminder",
      { name: r.name1 || "", hours: hoursLeft },
      { type: "match_reminder", targetUserId: r.user1_id },
    );
  }
  if (res.rows.length)
    console.log(
      `[CRON] Match-ის შეხსენება გაეგზავნა ${res.rows.length} წყვილს`,
    );
};

// 3) "N ადამიანს მოსწონხარ": დღეში მაქსიმუმ ერთხელ, მხოლოდ თუ ახალი ლაიქი გაჩნდა, დღის საათებში (თბილისის დრო)
const tbilisiHour = () =>
  parseInt(
    new Date().toLocaleString("en-US", {
      timeZone: "Asia/Tbilisi",
      hour: "numeric",
      hour12: false,
    }),
    10,
  ) % 24;

const sendLikesDigest = async () => {
  const h = tbilisiHour();
  if (h < 11 || h >= 22) return;

  const res = await pool.query(
    `SELECT u.id, COUNT(*)::int AS cnt
     FROM users u
     JOIN likes l ON l.to_user_id = u.id
     JOIN users s ON s.id = l.from_user_id
                 AND s.status = 'approved' AND COALESCE(s.is_banned, false) = false
     WHERE u.status = 'approved'
       AND COALESCE(u.is_banned, false) = false
       AND (u.likes_digest_sent_at IS NULL OR u.likes_digest_sent_at <= NOW() - INTERVAL '24 hours')
       AND NOT EXISTS (SELECT 1 FROM likes x WHERE x.from_user_id = u.id AND x.to_user_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM dislikes d WHERE d.from_user_id = u.id AND d.to_user_id = s.id)
       AND NOT EXISTS (
         SELECT 1 FROM blocks b
         WHERE (b.blocker_id = u.id AND b.blocked_id = s.id) OR (b.blocker_id = s.id AND b.blocked_id = u.id)
       )
     GROUP BY u.id, u.likes_digest_sent_at
     HAVING MAX(l.created_at) > COALESCE(u.likes_digest_sent_at, '-infinity'::timestamptz)
     LIMIT 500`,
  );
  if (res.rows.length === 0) return;

  await pool.query(
    "UPDATE users SET likes_digest_sent_at = NOW() WHERE id = ANY($1::bigint[])",
    [res.rows.map((r) => r.id)],
  );

  for (const r of res.rows) {
    await notifyUserT(
      r.id,
      "likes_digest",
      { count: r.cnt },
      { type: "likes_received" },
    );
  }
  console.log(
    `[CRON] "მოსწონხარ" შეტყობინება გაეგზავნა ${res.rows.length} მომხმარებელს`,
  );
};

export const initMatchCron = () => {
  // ყოველ 10 წუთში: ვადა + შეხსენებები
  cron.schedule("*/10 * * * *", async () => {
    try {
      await expireMatches();
      await remindMatches();
    } catch (error) {
      console.error("[CRON ERROR] Match ვადა/შეხსენება:", error);
    }
  });

  // ყოველი საათის 5-ე წუთზე: "N ადამიანს მოსწონხარ"
  cron.schedule("5 * * * *", async () => {
    try {
      await sendLikesDigest();
    } catch (error) {
      console.error("[CRON ERROR] Likes digest:", error);
    }
  });
};
