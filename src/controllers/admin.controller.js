import { pool } from "../db/index.js";

export const getStats = async (req, res) => {
  try {
    // ვარაუდი: PostgreSQL (თუ სხვაა, Query შეცვალე)
    const result = await pool.query("SELECT COUNT(*) as total FROM users");
    const totalUsers = result.rows[0].total;

    res.status(200).json({
      success: true,
      data: {
        totalUsers: parseInt(totalUsers),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
