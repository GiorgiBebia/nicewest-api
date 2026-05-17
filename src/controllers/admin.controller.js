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
export const updateUserStatus = async (req, res) => {
  try {
    const { userId, status } = req.body;

    if (!userId || !status) {
      return res.status(400).json({ success: false, message: "userId და status სავალდებულოა" });
    }

    // შევცვალოთ სტატუსი ბაზაში
    const query = "UPDATE users SET status = $1 WHERE id = $2 RETURNING id, status";
    const result = await pool.query(query, [status, userId]);

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
