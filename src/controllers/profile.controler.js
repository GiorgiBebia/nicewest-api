import { pool } from "../db/index.js";

export const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    // დავამატე full_name და age, როგორც მთხოვე
    const { full_name, bio, gender, city, age } = req.body;

    await pool.query(
      `UPDATE users 
       SET full_name=$1, bio=$2, gender=$3, city=$4, age=$5 
       WHERE id=$6`,
      [full_name, bio, gender, city, age, userId],
    );

    res.json({ success: true, message: "პროფილი განახლდა" });
  } catch (err) {
    console.error("UPDATE ERROR:", err);
    res.status(500).json({ error: "Profile update failed" });
  }
};

export const getMe = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      "SELECT id, username, email, full_name, bio, gender, city, age FROM users WHERE id=$1",
      [userId],
    );

    if (result.rows.length === 0) return res.status(404).json({ message: "User not found" });

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Get profile failed" });
  }
};
