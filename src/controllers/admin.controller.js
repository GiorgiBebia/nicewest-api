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

// წამოიღებს ყველა იუზერს, ვისაც სტატუსი აქვს 'pending'
export const getPendingUsers = async (req, res) => {
  try {
    const query = `
      SELECT 
        u.id, u.username, u.full_name, u.email, u.bio, u.city, u.age, u.birth_date, u.status,
        p.image_url as profile_image
      FROM users u
      LEFT JOIN photos p ON u.id = p.user_id AND p.is_main = true
      WHERE u.status = 'pending' AND u.is_admin = false
      ORDER BY u.created_at DESC
    `;

    const result = await pool.query(query);

    res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get Pending Users Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// უცვლის იუზერს სტატუსს ('approved' ან 'rejected')
// უცვლის იუზერს სტატუსს და საჭიროებისას უწერს უარყოფის მიზეზებს
export const updateUserStatus = async (req, res) => {
  try {
    const { userId, status, rejectionReasons } = req.body;

    if (!userId || !status) {
      return res.status(400).json({ success: false, message: "userId და status სავალდებულოა" });
    }

    // თუ სტატუსი არის 'rejected', ვინახავთ მიზეზებს, თუ არა - ვასუფთავებთ
    const reasons = status === "rejected" ? JSON.stringify(rejectionReasons || {}) : "{}";

    const query = `
      UPDATE users 
      SET status = $1, rejection_reasons = $2 
      WHERE id = $3 
      RETURNING id, status, rejection_reasons
    `;

    const result = await pool.query(query, [status, reasons, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "მომხმარებელი ვერ მოიძებნა" });
    }

    res.status(200).json({
      success: true,
      message: `მომხმარებლის სტატუსი განახლდა: ${status}`,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Update Status Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
