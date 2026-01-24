import { pool } from "../db/index.js";

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
      // ჯერ ვშლით ძველ ფოტოებს (რომლებსაც მერე თავიდან ჩავწერთ ახალი რიგითობით)
      await pool.query("DELETE FROM photos WHERE user_id = $1", [userId]);

      // სათითაოდ ვამატებთ ახალ ფოტოებს
      for (let i = 0; i < photos.length; i++) {
        if (photos[i]) {
          await pool.query("INSERT INTO photos (user_id, image_url, position) VALUES ($1, $2, $3)", [
            userId,
            photos[i],
            i,
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

    // ვიღებთ მომხმარებლის ინფორმაციას
    const userResult = await pool.query(
      "SELECT id, username, email, full_name, bio, gender, city, age FROM users WHERE id=$1",
      [userId],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "მომხმარებელი ვერ მოიძებნა" });
    }

    // ვიღებთ მომხმარებლის ფოტოებს რიგითობის მიხედვით
    const photosResult = await pool.query(
      "SELECT image_url, position FROM photos WHERE user_id=$1 ORDER BY position ASC",
      [userId],
    );

    const user = userResult.rows[0];

    // ვაწყობთ საბოლოო ობიექტს
    res.json({
      ...user,
      full_name: user.full_name || "",
      bio: user.bio || "",
      city: user.city || "",
      age: user.age || "",
      gender: user.gender || "other",
      photos: photosResult.rows, // ეს დაუბრუნებს ფოტოების მასივს ფრონტენდს
    });
  } catch (err) {
    console.error("GET ME ERROR:", err);
    res.status(500).json({ error: "მონაცემების წამოღება ვერ მოხერხდა" });
  }
};
