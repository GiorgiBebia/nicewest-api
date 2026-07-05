import { pool } from "../db/index.js";
import { io } from "../server.js";

// ლოკაციის განახლება
export const updateLocation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { latitude, longitude } = req.body;
    await pool.query("UPDATE users SET latitude = $1, longitude = $2 WHERE id = $3", [latitude, longitude, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Location update failed" });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { full_name, age, bio, city, gender, looking_for, search_radius, min_age, max_age } = req.body;

    const query = `
      UPDATE users 
      SET 
        full_name = $1, 
        age = $2, 
        bio = $3, 
        city = $4, 
        gender = $5, 
        looking_for = $6, 
        search_radius = $7, 
        min_age = $8, 
        max_age = $9,
        status = 'pending',
        rejection_reasons = '{}'::jsonb
      WHERE id = $10
      RETURNING *
    `;

    const result = await pool.query(query, [
      full_name,
      age,
      bio,
      city,
      gender,
      looking_for,
      search_radius,
      min_age,
      max_age,
      userId,
    ]);

    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Update Profile Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getMe = async (req, res) => {
  try {
    const userId = req.user.id;

    const userResult = await pool.query(
      "SELECT id, username, email, full_name, bio, gender, looking_for, city, age, search_radius, min_age, max_age, interests, latitude, longitude, is_admin, status, rejection_reasons FROM users WHERE id=$1",
      [userId],
    );

    const photosResult = await pool.query(
      "SELECT image_url, position FROM photos WHERE user_id=$1 ORDER BY position ASC",
      [userId],
    );

    const user = userResult.rows[0];
    const photos = photosResult.rows;

    if (!user) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    const validation = {
      hasFullName: !!user.full_name,
      hasAge: !!user.age,
      hasCity: !!user.city,
      hasGender: !!user.gender,
      hasBio: !!(user.bio && user.bio.trim().length >= 5),
      hasPhotos: photos.length > 0,
    };

    const isComplete = Object.values(validation).every((val) => val === true);

    res.json({
      ...user,
      photos,
      is_complete: isComplete,
      profile_status: validation,
    });
  } catch (err) {
    console.error("GET_ME ERROR:", err);
    res.status(500).json({ error: "შეცდომა მონაცების წამოღებისას" });
  }
};

// განახლდა: გამორიცხავს ორმხრივად დაბლოკილ იუზერებს სვაიპებიდან
export const getDiscovery = async (req, res) => {
  try {
    const userId = req.user.id;
    const meResult = await pool.query(
      "SELECT latitude, longitude, search_radius, min_age, max_age, looking_for FROM users WHERE id = $1",
      [userId],
    );
    const me = meResult.rows[0];

    if (!me || !me.latitude || !me.longitude) return res.json([]);

    const discoveryResult = await pool.query(
      `WITH filtered_users AS (
          SELECT u.id, u.full_name, u.age, u.city, u.bio, u.interests,
            (6371 * acos(
                LEAST(1, GREATEST(-1, 
                  cos(radians($2)) * cos(radians(u.latitude)) * cos(radians(u.longitude) - radians($3)) + sin(radians($2)) * sin(radians(u.latitude))
                ))
            )) AS distance
          FROM users u
          WHERE u.id != $1 
          AND u.age BETWEEN $5 AND $6
          AND u.gender = $7
          AND u.latitude IS NOT NULL
          AND u.id NOT IN (SELECT to_user_id FROM likes WHERE from_user_id = $1)
          -- ფილტრი: გამორიცხოს იუზერები, ვინც მე დავბლოკე ან ვინც მე დამბლოკა
          AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $1)
          AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = $1)
      )
      SELECT f.*, 
             COALESCE(
               JSON_AGG(JSON_BUILD_OBJECT('image_url', p.image_url, 'position', p.position) ORDER BY p.position ASC) 
               FILTER (WHERE p.id IS NOT NULL), '[]'
             ) AS photos
      FROM filtered_users f
      LEFT JOIN photos p ON f.id = p.user_id
      WHERE f.distance <= $4
      GROUP BY f.id, f.full_name, f.age, f.city, f.bio, f.interests, f.distance
      ORDER BY f.distance ASC 
      LIMIT 20`,
      [userId, me.latitude, me.longitude, me.search_radius, me.min_age, me.max_age, me.looking_for],
    );
    res.json(discoveryResult.rows);
  } catch (err) {
    console.error("Discovery error:", err);
    res.status(500).json({ error: "მონაცემების წამოღება ვერ მოხერხდა" });
  }
};

export const addLike = async (req, res) => {
  const { targetUserId } = req.body;
  const myId = req.user.id;
  try {
    await pool.query("INSERT INTO likes (from_user_id, to_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      myId,
      targetUserId,
    ]);
    const reverseLike = await pool.query("SELECT id FROM likes WHERE from_user_id = $1 AND to_user_id = $2", [
      targetUserId,
      myId,
    ]);
    let isMatch = false;
    if (reverseLike.rows.length > 0) {
      isMatch = true;
      const [p1, p2] = [myId, targetUserId].sort();
      await pool.query("INSERT INTO matches (user1_id, user2_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [p1, p2]);
    }
    res.json({ success: true, isMatch });
  } catch (err) {
    res.status(500).json({ message: "შეცდომა ლაიქისას" });
  }
};

// განახლდა: მატჩების სიიდან აქრობს დაბლოკილ ხალხს
export const getMatches = async (req, res) => {
  try {
    const userId = req.user.id;
    const matchesResult = await pool.query(
      `SELECT u.id, u.full_name, p.image_url as main_photo, msg.text as last_message_text, msg.created_at as last_message_at, COALESCE(unread.count, 0) as unread_count
      FROM matches m
      JOIN users u ON (u.id = CASE WHEN m.user1_id = $1 THEN m.user2_id ELSE m.user1_id END)
      LEFT JOIN photos p ON p.user_id = u.id AND p.position = 0
      LEFT JOIN LATERAL (SELECT text, created_at FROM messages WHERE (sender_id = $1 AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = $1) ORDER BY created_at DESC LIMIT 1) msg ON true
      LEFT JOIN (SELECT sender_id, COUNT(*) as count FROM messages WHERE receiver_id = $1 AND is_read = FALSE GROUP BY sender_id) unread ON unread.sender_id = u.id
      WHERE (m.user1_id = $1 OR m.user2_id = $1)
      -- ფილტრი: არ წამოიღო თუ რომელიმეს ბლოკი აქვს ნადები
      AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $1)
      AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = $1)
      ORDER BY last_message_at DESC NULLS LAST`,
      [userId],
    );
    res.json(matchesResult.rows);
  } catch (err) {
    res.status(500).json({ error: "მონაცემების წამოღება ვერ მოხერხდა" });
  }
};

export const getChatMessages = async (req, res) => {
  try {
    const { partnerId } = req.params;
    const messages = await pool.query(
      `SELECT * FROM messages WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1) ORDER BY created_at ASC`,
      [req.user.id, partnerId],
    );
    res.json(messages.rows);
  } catch (err) {
    res.status(500).json({ error: "error" });
  }
};

// განახლდა: უშლის ხელს შეტყობინების გაგზავნას თუ იუზერი დაბლოკილია
export const sendMessage = async (req, res) => {
  try {
    const senderId = req.user.id;
    const { receiverId, content } = req.body;

    // შემოწმება: ხომ არ არის ბლოკი ორმხრივად
    const blockCheck = await pool.query(
      "SELECT id FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)",
      [senderId, receiverId],
    );

    if (blockCheck.rows.length > 0) {
      return res.status(403).json({ error: "ამ მომხმარებელთან შეტყობინების გაგზავნა შეუძლებელია." });
    }

    const matchResult = await pool.query(
      `SELECT id FROM matches WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1) LIMIT 1`,
      [senderId, receiverId],
    );

    if (matchResult.rows.length === 0) return res.status(403).json({ error: "თქვენ არ გაქვთ Match ამ მომხმარებელთან" });

    const newMessage = await pool.query(
      "INSERT INTO messages (match_id, sender_id, receiver_id, text) VALUES ($1, $2, $3, $4) RETURNING *",
      [matchResult.rows[0].id, senderId, receiverId, content],
    );

    io.to(receiverId.toString()).emit("new_message", newMessage.rows[0]);
    io.to(senderId.toString()).emit("new_message", newMessage.rows[0]);

    res.json(newMessage.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "შეტყობინების გაგზავნა ვერ მოხერხდა" });
  }
};

export const markAsRead = async (req, res) => {
  try {
    await pool.query(
      "UPDATE messages SET is_read = TRUE WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE",
      [req.params.partnerId, req.user.id],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "error" });
  }
};

// განახლდა: არ აჩვენებს პროფილს თუ ბლოკია დადებული
export const getUserProfile = async (req, res) => {
  try {
    const { userId } = req.query;
    const myId = req.user.id;

    if (!userId) {
      return res.status(400).json({ error: "userId პარამეტრი აუცილებელია" });
    }

    // შემოწმება: ბლოკი ხომ არ არის
    const blockCheck = await pool.query(
      "SELECT id FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)",
      [myId, userId],
    );

    if (blockCheck.rows.length > 0) {
      return res.status(403).json({ error: "პროფილი მიუწვდომელია" });
    }

    const userResult = await pool.query(
      "SELECT id, username, full_name, bio, gender, city, age, interests FROM users WHERE id=$1",
      [userId],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    const photosResult = await pool.query(
      "SELECT image_url, position FROM photos WHERE user_id=$1 ORDER BY position ASC",
      [userId],
    );

    res.json({
      success: true,
      user: userResult.rows[0],
      photos: photosResult.rows,
    });
  } catch (err) {
    console.error("GET_USER_PROFILE ERROR:", err);
    res.status(500).json({ error: "შეცდომა მომხმარებლის პროფილის წამოღებისას" });
  }
};

/* ==========================================================
   ახალი ფუნქციები: REPORT & BLOCK ლოგიკა
   ========================================================== */

// 1. მომხმარებლის რეპორტი
export const reportUser = async (req, res) => {
  try {
    const reporterId = req.user.id;
    const { reportedUserId, reason, details } = req.body;

    if (!reportedUserId || !reason) {
      return res.status(400).json({ error: "reportedUserId და reason აუცილებელია" });
    }

    await pool.query("INSERT INTO reports (reporter_id, reported_id, reason, details) VALUES ($1, $2, $3, $4)", [
      reporterId,
      reportedUserId,
      reason,
      details || "",
    ]);

    res.json({ success: true, message: "რეპორტი წარმატებით გაიგზავნა" });
  } catch (err) {
    console.error("REPORT USER ERROR:", err);
    res.status(500).json({ error: "რეპორტის გაგზავნა ვერ მოხერხდა" });
  }
};

// 2. მომხმარებლის დაბლოკვა
export const blockUser = async (req, res) => {
  try {
    const blockerId = req.user.id;
    const { blockedUserId } = req.body;

    if (!blockedUserId) {
      return res.status(400).json({ error: "blockedUserId აუცილებელია" });
    }

    if (blockerId === parseInt(blockedUserId)) {
      return res.status(400).json({ error: "საკუთარ თავს ვერ დაბლოკავთ" });
    }

    // ჩავსვათ ბლოკი (ON CONFLICT DO NOTHING - თუ უკვე დაბლოკილი გვყავდა, შეცდომა რომ არ ამოაგდოს)
    await pool.query("INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      blockerId,
      blockedUserId,
    ]);

    // [ოპციონალური] ბლოკირებისას ავტომატურად წავშალოთ მათი Match, რომ ჩატებიდანაც გაქრეს
    await pool.query(
      `DELETE FROM matches 
       WHERE (user1_id = $1 AND user2_id = $2) 
          OR (user1_id = $2 AND user2_id = $1)`,
      [blockerId, blockedUserId],
    );

    res.json({ success: true, message: "მომხმარებელი დაბლოკილია" });
  } catch (err) {
    console.error("BLOCK USER ERROR:", err);
    res.status(500).json({ error: "მომხმარებლის დაბლოკვა ვერ მოხერხდა" });
  }
};
