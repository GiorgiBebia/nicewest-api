import { pool } from "../db/index.js";
import { io } from "../server.js";

export const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { full_name, bio, gender, city, age, photos } = req.body;

    await pool.query(`UPDATE users SET full_name=$1, bio=$2, gender=$3, city=$4, age=$5 WHERE id=$6`, [
      full_name,
      bio,
      gender,
      city,
      age,
      userId,
    ]);

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
    console.error("UPDATE ERROR:", err);
    res.status(500).json({ error: "შეცდომა განახლებისას" });
  }
};

export const getMe = async (req, res) => {
  try {
    const userId = req.user.id;
    const userResult = await pool.query(
      "SELECT id, username, email, full_name, bio, gender, city, age FROM users WHERE id=$1",
      [userId],
    );
    const photosResult = await pool.query(
      "SELECT image_url, position FROM photos WHERE user_id=$1 ORDER BY position ASC",
      [userId],
    );
    const user = userResult.rows[0];
    res.json({ ...user, photos: photosResult.rows });
  } catch (err) {
    res.status(500).json({ error: "შეცდომა მონაცემების წამოღებისას" });
  }
};

export const getDiscovery = async (req, res) => {
  try {
    const userId = req.user.id;
    const discoveryResult = await pool.query(
      `SELECT u.id, u.full_name, u.age, u.city, u.bio,
        COALESCE(JSON_AGG(JSON_BUILD_OBJECT('image_url', p.image_url, 'position', p.position) ORDER BY p.position ASC) 
        FILTER (WHERE p.id IS NOT NULL), '[]') AS photos
      FROM users u
      LEFT JOIN photos p ON u.id = p.user_id
      WHERE u.id != $1 
      AND u.id NOT IN (SELECT to_user_id FROM likes WHERE from_user_id = $1)
      GROUP BY u.id LIMIT 20`,
      [userId],
    );
    res.json(discoveryResult.rows);
  } catch (err) {
    res.status(500).json({ error: "Discovery error" });
  }
};

export const addLike = async (req, res) => {
  const { targetUserId, type } = req.body;
  const myId = req.user.id;

  try {
    // 1. ჩავწეროთ ლაიქი (from_user_id და to_user_id გამოყენებით)
    await pool.query(
      `INSERT INTO likes (from_user_id, to_user_id) 
       VALUES ($1, $2) 
       ON CONFLICT (from_user_id, to_user_id) DO NOTHING`,
      [myId, targetUserId],
    );

    let isMatch = false;

    // 2. ვამოწმებთ უკუგება ლაიქს
    const reverseLike = await pool.query("SELECT id FROM likes WHERE from_user_id = $1 AND to_user_id = $2", [
      targetUserId,
      myId,
    ]);

    if (reverseLike.rows.length > 0) {
      isMatch = true;
      const [p1, p2] = [myId, targetUserId].sort();
      // 3. ვქმნით მატჩს (user1_id და user2_id გამოყენებით)
      await pool.query("INSERT INTO matches (user1_id, user2_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [p1, p2]);
    }

    res.json({ success: true, isMatch });
  } catch (err) {
    console.error("LIKE ERROR:", err);
    res.status(500).json({ message: "შეცდომა ლაიქისას" });
  }
};

export const getMatches = async (req, res) => {
  try {
    const userId = req.user.id;
    // ვიყენებთ matches ცხრილს user1_id და user2_id სვეტებით
    const matchesResult = await pool.query(
      `SELECT u.id, u.full_name, u.username,
        (SELECT image_url FROM photos WHERE user_id = u.id ORDER BY position ASC LIMIT 1) as main_photo
      FROM users u
      JOIN matches m ON (u.id = m.user1_id OR u.id = m.user2_id)
      WHERE (m.user1_id = $1 OR m.user2_id = $1) AND u.id != $1`,
      [userId],
    );
    res.json(matchesResult.rows);
  } catch (err) {
    console.error("GET MATCHES ERROR:", err);
    res.status(500).json({ error: "მატჩების წამოღება ვერ მოხერხდა" });
  }
};

export const getChatMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { partnerId } = req.params;

    // აქ ვამოწმებთ ორივე მხარეს
    const messages = await pool.query(
      `SELECT * FROM messages 
       WHERE (sender_id = $1 AND receiver_id = $2) 
          OR (sender_id = $2 AND receiver_id = $1) 
       ORDER BY created_at ASC`,
      [userId, partnerId],
    );
    res.json(messages.rows);
  } catch (err) {
    console.error("GET MESSAGES ERROR:", err);
    res.status(500).json({ error: "მესიჯების წამოღება ვერ მოხერხდა" });
  }
};

export const sendMessage = async (req, res) => {
  try {
    const senderId = req.user.id;
    const { receiverId, content } = req.body;

    // აქ ჩაწერე ის სახელი, რაც ბაზაში გაქვს (მაგ: receiver_id)
    const newMessage = await pool.query(
      "INSERT INTO messages (sender_id, receiver_id, content) VALUES ($1, $2, $3) RETURNING *",
      [senderId, receiverId, content],
    );

    const messageData = newMessage.rows[0];

    // Socket-ით გაგზავნა
    io.to(receiverId.toString()).emit("new_message", messageData);
    io.to(senderId.toString()).emit("new_message", messageData);

    res.json(messageData);
  } catch (err) {
    console.error("SEND MESSAGE ERROR:", err);
    res.status(500).json({ error: "ბაზაში ჩაწერა ვერ მოხერხდა. შეამოწმე სვეტის სახელი!" });
  }
};
