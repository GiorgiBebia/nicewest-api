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
    const { full_name, bio, gender, city, age, photos, search_radius, min_age, max_age } = req.body;

    await pool.query(
      `UPDATE users 
       SET full_name=$1, bio=$2, gender=$3, city=$4, age=$5, search_radius=$6, min_age=$7, max_age=$8
       WHERE id=$9`,
      [full_name, bio, gender, city, age, search_radius || 50, min_age || 18, max_age || 100, userId],
    );

    if (photos && Array.isArray(photos)) {
      await pool.query("DELETE FROM photos WHERE user_id = $1", [userId]);
      for (const photo of photos) {
        if (photo && photo.image_url) {
          await pool.query("INSERT INTO photos (user_id, image_url, position) VALUES ($1, $2, $3)", [
            userId,
            photo.image_url,
            photo.position || 0,
          ]);
        }
      }
    }
    res.json({ success: true, message: "პროფილი განახლდა" });
  } catch (err) {
    res.status(500).json({ error: "შეცდომა განახლებისას" });
  }
};

export const getMe = async (req, res) => {
  try {
    const userId = req.user.id;
    const userResult = await pool.query(
      "SELECT id, username, email, full_name, bio, gender, city, age, search_radius, latitude, longitude FROM users WHERE id=$1",
      [userId],
    );
    const photosResult = await pool.query(
      "SELECT image_url, position FROM photos WHERE user_id=$1 ORDER BY position ASC",
      [userId],
    );
    res.json({ ...userResult.rows[0], photos: photosResult.rows });
  } catch (err) {
    res.status(500).json({ error: "შეცდომა მონაცემების წამოღებისას" });
  }
};

export const getDiscovery = async (req, res) => {
  try {
    const userId = req.user.id;
    const meResult = await pool.query(
      "SELECT latitude, longitude, search_radius, min_age, max_age FROM users WHERE id = $1",
      [userId],
    );
    const me = meResult.rows[0];

    if (!me.latitude || !me.longitude) return res.json([]);

    const discoveryResult = await pool.query(
      `SELECT u.id, u.full_name, u.age, u.city, u.bio,
          (6371 * acos(cos(radians($2)) * cos(radians(u.latitude)) * cos(radians(u.longitude) - radians($3)) + sin(radians($2)) * sin(radians(u.latitude)))) AS distance,
          COALESCE(JSON_AGG(JSON_BUILD_OBJECT('image_url', p.image_url, 'position', p.position) ORDER BY p.position ASC) 
          FILTER (WHERE p.id IS NOT NULL), '[]') AS photos
      FROM users u
      LEFT JOIN photos p ON u.id = p.user_id
      WHERE u.id != $1 
      AND u.id NOT IN (SELECT to_user_id FROM likes WHERE from_user_id = $1)
      AND u.age BETWEEN $5 AND $6
      AND u.latitude IS NOT NULL 
      AND (6371 * acos(cos(radians($2)) * cos(radians(u.latitude)) * cos(radians(u.longitude) - radians($3)) + sin(radians($2)) * sin(radians(u.latitude)))) <= $4
      GROUP BY u.id 
      ORDER BY distance ASC LIMIT 30`,
      [userId, me.latitude, me.longitude, me.search_radius, me.min_age, me.max_age],
    );
    res.json(discoveryResult.rows);
  } catch (err) {
    res.status(500).json({ error: "Discovery error" });
  }
};

// დანარჩენი ფუნქციები (addLike, getMatches, getChatMessages, sendMessage, markAsRead) იგივე დატოვე...
export const addLike = async (req, res) => {
  const { targetUserId } = req.body;
  const myId = req.user.id;
  try {
    await pool.query("INSERT INTO likes (from_user_id, to_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      myId,
      targetUserId,
    ]);
    let isMatch = false;
    const reverseLike = await pool.query("SELECT id FROM likes WHERE from_user_id = $1 AND to_user_id = $2", [
      targetUserId,
      myId,
    ]);
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

export const getMatches = async (req, res) => {
  try {
    const userId = req.user.id;
    const matchesResult = await pool.query(
      `SELECT u.id, u.full_name, (SELECT image_url FROM photos WHERE user_id = u.id ORDER BY position ASC LIMIT 1) as main_photo,
      (SELECT text FROM messages WHERE (sender_id = $1 AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = $1) ORDER BY created_at DESC LIMIT 1) as last_message_text,
      (SELECT created_at FROM messages WHERE (sender_id = $1 AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = $1) ORDER BY created_at DESC LIMIT 1) as last_message_at,
      (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = $1 AND is_read = FALSE) as unread_count
      FROM users u JOIN matches m ON (u.id = m.user1_id OR u.id = m.user2_id)
      WHERE (m.user1_id = $1 OR m.user2_id = $1) AND u.id != $1 ORDER BY last_message_at DESC NULLS LAST`,
      [userId],
    );
    res.json(matchesResult.rows);
  } catch (err) {
    res.status(500).json({ error: "error" });
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

export const sendMessage = async (req, res) => {
  try {
    const senderId = req.user.id;
    const { receiverId, content } = req.body;
    const matchResult = await pool.query(
      `SELECT id FROM matches WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1) LIMIT 1`,
      [senderId, receiverId],
    );
    if (matchResult.rows.length === 0) return res.status(403).json({ error: "No match" });
    const newMessage = await pool.query(
      "INSERT INTO messages (match_id, sender_id, receiver_id, text) VALUES ($1, $2, $3, $4) RETURNING *",
      [matchResult.rows[0].id, senderId, receiverId, content],
    );
    io.to(receiverId.toString()).emit("new_message", newMessage.rows[0]);
    io.to(senderId.toString()).emit("new_message", newMessage.rows[0]);
    res.json(newMessage.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "error" });
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
