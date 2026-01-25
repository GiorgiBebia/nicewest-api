import { pool } from "../db/index.js";
import { io } from "../server.js"; // დაიმპორტე ზემოთ შექმნილი io

export const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { full_name, bio, gender, city, age, photos } = req.body;

    // 1. მომხმარებლის ძირითადი ინფორმაციის განახლება
    await pool.query(
      `UPDATE users 
       SET full_name=$1, bio=$2, gender=$3, city=$4, age=$5 
       WHERE id=$6`,
      [full_name, bio, gender, city, age, userId],
    );

    // 2. ფოტოების განახლება
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

    res.json({ success: true, message: "პროფილი და ფოტოები წარმატებით განახლდა" });
  } catch (err) {
    console.error("UPDATE ERROR:", err);
    res.status(500).json({ error: "პროფილის განახლება ვერ მოხერხდა" });
  }
};

export const getMe = async (req, res) => {
  try {
    const userId = req.user.id;
    const userResult = await pool.query(
      "SELECT id, username, email, full_name, bio, gender, city, age FROM users WHERE id=$1",
      [userId],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "მომხმარებელი ვერ მოიძებნა" });
    }

    const photosResult = await pool.query(
      "SELECT image_url, position FROM photos WHERE user_id=$1 ORDER BY position ASC",
      [userId],
    );

    const user = userResult.rows[0];
    res.json({
      ...user,
      full_name: user.full_name || "",
      bio: user.bio || "",
      city: user.city || "",
      age: user.age || "",
      gender: user.gender || "other",
      photos: photosResult.rows,
    });
  } catch (err) {
    console.error("GET ME ERROR:", err);
    res.status(500).json({ error: "მონაცემების წამოღება ვერ მოხერხდა" });
  }
};

// ახალი ფუნქცია Discovery-სთვის (MainPage-ზე გამოსაჩენად)
export const getDiscovery = async (req, res) => {
  try {
    const userId = req.user.id;

    // ვიღებთ მომხმარებლებს და მათ ფოტოებს (JSON_AGG აერთიანებს ფოტოებს მასივში)
    const discoveryResult = await pool.query(
      `SELECT 
        u.id, u.full_name, u.age, u.city, u.bio,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT('image_url', p.image_url, 'position', p.position)
            ORDER BY p.position ASC
          ) FILTER (WHERE p.id IS NOT NULL), '[]'
        ) AS photos
      FROM users u
      LEFT JOIN photos p ON u.id = p.user_id
      WHERE u.id != $1
      GROUP BY u.id
      LIMIT 20`,
      [userId],
    );

    res.json(discoveryResult.rows);
  } catch (err) {
    console.error("GET DISCOVERY ERROR:", err);
    res.status(500).json({ error: "Discovery მონაცემების წამოღება ვერ მოხერხდა" });
  }
};

export const addLike = async (req, res) => {
  const { targetUserId, type } = req.body;
  const myId = req.user.id;

  try {
    // 1. ჩავწეროთ ლაიქი
    await pool.query("INSERT INTO likes (user_id, target_user_id, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
      myId,
      targetUserId,
      type,
    ]);

    // 2. შევამოწმოთ, ხომ არ მოვწონვართ ამ იუზერს უკვე? (საპირისპირო ლაიქი)
    const reverseLike = await pool.query(
      "SELECT id FROM likes WHERE user_id = $1 AND target_user_id = $2 AND type = 'like'",
      [targetUserId, myId],
    );

    if (reverseLike.rows.length > 0) {
      // 3. თუ ორივემ მოვიწონეთ, ვქმნით Match-ს
      await pool.query("INSERT INTO matches (user_one_id, user_two_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
        myId,
        targetUserId,
      ]);
      return res.json({ isMatch: true });
    }

    res.json({ isMatch: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error adding like" });
  }
};

export const getMatches = async (req, res) => {
  try {
    const userId = req.user.id;

    // ვეძებთ იუზერებს, სადაც ლაიქი არის ორმხრივი
    const matchesResult = await pool.query(
      `SELECT 
        u.id, u.full_name, u.username,
        (SELECT image_url FROM photos WHERE user_id = u.id AND position = 0 LIMIT 1) as main_photo
      FROM users u
      JOIN likes l1 ON l1.target_user_id = u.id
      JOIN likes l2 ON l2.user_id = u.id
      WHERE l1.user_id = $1 AND l2.target_user_id = $1`,
      [userId],
    );

    res.json(matchesResult.rows);
  } catch (err) {
    console.error("GET MATCHES ERROR:", err);
    res.status(500).json({ error: "Matches წამოღება ვერ მოხერხდა" });
  }
};

// მესიჯების ისტორიის წამოღება
export const getChatMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { partnerId } = req.params;

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

// მესიჯის გაგზავნა
export const sendMessage = async (req, res) => {
  try {
    const senderId = req.user.id;
    const { receiverId, content } = req.body;

    const newMessage = await pool.query(
      "INSERT INTO messages (sender_id, receiver_id, content) VALUES ($1, $2, $3) RETURNING *",
      [senderId, receiverId, content],
    );

    const messageData = newMessage.rows[0];

    // ვუგზავნით მესიჯს რეალურ დროში ადრესატს მის "ოთახში"
    io.to(receiverId).emit("new_message", messageData);

    res.json(messageData);
  } catch (err) {
    console.error("SEND MESSAGE ERROR:", err);
    res.status(500).json({ error: "მესიჯი ვერ გაიგზავნა" });
  }
};
