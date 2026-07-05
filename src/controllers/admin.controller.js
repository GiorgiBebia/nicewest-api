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
      LEFT JOIN photos p ON u.id = p.user_id AND p.position = 0
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

export const getPendingReports = async (req, res) => {
  try {
    const query = `
      SELECT 
        r.id, 
        r.reason, 
        r.details, 
        r.status, 
        r.created_at,
        r.reporter_id,
        r.reported_id,
        reporter.username AS reporter_username,
        reporter.full_name AS reporter_name,
        reported.username AS reported_username,
        reported.full_name AS reported_name
      FROM reports r
      JOIN users reporter ON r.reporter_id = reporter.id
      JOIN users reported ON r.reported_id = reported.id
      WHERE r.status = 'pending'
    `;

    const result = await pool.query(query);

    res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get Pending Reports Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateUserStatus = async (req, res) => {
  try {
    const { userId, rejectionReasons } = req.body;

    if (!userId || !rejectionReasons) {
      return res.status(400).json({ success: false, message: "userId და rejectionReasons სავალდებულოა" });
    }

    const hasRejections = Object.values(rejectionReasons).some((value) => value === true);
    const finalStatus = hasRejections ? "rejected" : "approved";
    const reasonsStr = JSON.stringify(rejectionReasons);

    const query = `
      UPDATE users 
      SET status = $1, rejection_reasons = $2 
      WHERE id = $3 
      RETURNING id, status, rejection_reasons
    `;

    const result = await pool.query(query, [finalStatus, reasonsStr, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "მომხმარებელი ვერ მოიძებნა" });
    }

    res.status(200).json({
      success: true,
      message: `მომხმარებლის სტატუსი შენახულია: ${finalStatus}`,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Update Status Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ==========================================================
   ახალი ფუნქციები: რეპორტები და ბანი ადმინისთვის
   ========================================================== */

// 1. ყველა მიმდინარე რეპორტის წამოღება
export const getAdminReports = async (req, res) => {
  try {
    const query = `
      SELECT 
        r.id, r.reason, r.details, r.status, r.created_at,
        reporter.username as reporter_username, reporter.full_name as reporter_name,
        reported.id as reported_user_id, reported.username as reported_username, reported.full_name as reported_name
      FROM reports r
      JOIN users reporter ON r.reporter_id = reporter.id
      JOIN users reported ON r.reported_id = reported.id
      WHERE r.status = 'pending'
      ORDER BY r.created_at DESC
    `;
    const result = await pool.query(query);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error("Get Admin Reports Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// 2. რეპორტის დახურვა (უარყოფა ან მოგვარება ბანის გარეშე)
export const resolveReport = async (req, res) => {
  try {
    const { reportId } = req.body;
    if (!reportId) {
      return res.status(400).json({ success: false, message: "reportId სავალდებულოა" });
    }

    await pool.query("UPDATE reports SET status = 'resolved' WHERE id = $1", [reportId]);
    res.status(200).json({ success: true, message: "საჩივარი დაარქივდა წარმატებით" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 3. მომხმარებლის დაბლოკვა (ბანი) და მისი რეპორტების დახურვა
export const banUserByAdmin = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: "userId სავალდებულოა" });
    }

    // ვუცვლით ბანის ველს users ცხრილში
    await pool.query("UPDATE users SET is_banned = true WHERE id = $1", [userId]);

    // ავტომატურად ვუხურავთ ამ იუზერზე შესულ ყველა ღია საჩივარს
    await pool.query("UPDATE reports SET status = 'resolved' WHERE reported_id = $1", [userId]);

    res.status(200).json({ success: true, message: "მომხმარებელს დაედო ბანი სისტემაში" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
// ორ მომხმარებელს შორის მიმოწერის წამოღება ადმინისტრატორისთვის

export const getChatHistoryForAdmin = async (req, res) => {
  try {
    const { user1, user2 } = req.query;

    if (!user1 || !user2) {
      return res.status(400).json({ success: false, message: "user1 და user2 პარამეტრები სავალდებულოა" });
    }

    const query = `
      SELECT id, sender_id, receiver_id, text, created_at 
      FROM messages 
      WHERE (sender_id = $1 AND receiver_id = $2) 
         OR (sender_id = $2 AND receiver_id = $1)
      ORDER BY created_at ASC
    `;

    const result = await pool.query(query, [user1, user2]);

    res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get Chat History Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
