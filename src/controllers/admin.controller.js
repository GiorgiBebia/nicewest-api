import { pool } from "../db/index.js";

export const getStats = async (req, res) => {
  try {
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

export const searchUsers = async (req, res) => {
  try {
    const { query } = req.query;

    if (!query || query.length < 2) {
      return res.status(200).json({ success: true, data: [] });
    }

    const searchQuery = `
      SELECT 
        u.id, u.username, u.full_name, u.is_admin, u.is_banned,
        p.image_url as profile_image
      FROM users u
      LEFT JOIN photos p ON u.id = p.user_id AND p.is_main = true
      WHERE u.full_name ILIKE $1 OR u.username ILIKE $1 
      LIMIT 20
    `;

    const result = await pool.query(searchQuery, [`%${query}%`]);

    return res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Search Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
