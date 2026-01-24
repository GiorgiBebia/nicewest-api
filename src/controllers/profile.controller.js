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
