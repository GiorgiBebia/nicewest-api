import { pool } from "../db/index.js";
import { notifyUser } from "../services/notification.service.js";

export const getStats = async (req, res) => {
  try {
    const query = `
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
        COUNT(*) FILTER (WHERE status = 'pending') as pending
      FROM users
    `;

    const result = await pool.query(query);
    const row = result.rows[0];

    res.status(200).json({
      success: true,
      data: {
        totalUsers: parseInt(row.total || 0),
        approvedUsers: parseInt(row.approved || 0),
        rejectedUsers: parseInt(row.rejected || 0),
        pendingUsers: parseInt(row.pending || 0),
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

export const getPendingUsers = async (req, res) => {
  try {
    const query = `
      SELECT 
        u.id, 
        u.username, 
        u.full_name, 
        u.email, 
        u.bio, 
        u.city, 
        u.age, 
        u.birth_date, 
        u.status, 
        u.created_at,
        u.rejection_reasons,
        u.pending_changes,
        (
          SELECT image_url 
          FROM photos 
          WHERE user_id = u.id AND (position = 0 OR is_main = true)
          LIMIT 1
        ) AS profile_image,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', ph.id,
                'image_url', ph.image_url,
                'position', ph.position,
                'is_main', ph.is_main
              )
            ) 
            FROM photos ph 
            WHERE ph.user_id = u.id
          ), '[]'::json
        ) AS photos
      FROM users u
      WHERE u.status = 'pending'
      ORDER BY u.created_at DESC
    `;

    const result = await pool.query(query);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error("Get Pending Users Error:", error);
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
  const client = await pool.connect();
  try {
    const { userId, rejectionReasons } = req.body;

    if (!userId || !rejectionReasons) {
      return res.status(400).json({ success: false, message: "userId and rejectionReasons are required" });
    }

    const hasRejections = Object.values(rejectionReasons).some((value) => value === true);
    const finalStatus = hasRejections ? "rejected" : "approved";
    const reasonsJson = JSON.stringify(rejectionReasons);

    await client.query("BEGIN");

    // წამოვიღოთ მომხმარებლის pending_changes
    const userRes = await client.query("SELECT pending_changes FROM users WHERE id = $1", [userId]);
    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const pendingChanges = userRes.rows[0].pending_changes;

    if (finalStatus === "approved" && pendingChanges) {
      // თუ დამტკიცდა, pending_changes-დან ახალი მნიშვნელობები გადავიტანოთ ძირითად ველებში
      const updates = [];
      const values = [];
      let paramIdx = 1;

      const allowedFields = [
        "full_name",
        "age",
        "bio",
        "city",
        "gender",
        "looking_for",
        "search_radius",
        "min_age",
        "max_age",
      ];

      allowedFields.forEach((field) => {
        if (pendingChanges[field] && pendingChanges[field].new !== undefined) {
          updates.push(`${field} = $${paramIdx}`);
          values.push(pendingChanges[field].new);
          paramIdx++;
        }
      });

      if (updates.length > 0) {
        values.push(userId);
        const dynamicQuery = `UPDATE users SET ${updates.join(", ")} WHERE id = $${paramIdx}`;
        await client.query(dynamicQuery, values);
      }

      // თუ ფოტოებიც შეიცვალა
      if (pendingChanges.photos && pendingChanges.photos.new) {
        const newPhotos = pendingChanges.photos.new;
        await client.query("DELETE FROM photos WHERE user_id = $1", [userId]);
        for (let i = 0; i < newPhotos.length; i++) {
          const photo = newPhotos[i];
          if (photo && photo.image_url) {
            const photoPos = photo.position !== undefined ? photo.position : i;
            await client.query("INSERT INTO photos (user_id, image_url, position, is_main) VALUES ($1, $2, $3, $4)", [
              userId,
              photo.image_url,
              photoPos,
              photoPos === 0,
            ]);
          }
        }
      }
    }

    // სტატუსის განახლება და pending_changes-ის გასუფთავება
    const updateStatusQuery = `
      UPDATE users 
      SET status = $1, rejection_reasons = $2, pending_changes = NULL 
      WHERE id = $3 
      RETURNING id, status, rejection_reasons
    `;
    const result = await client.query(updateStatusQuery, [finalStatus, reasonsJson, userId]);

    await client.query("COMMIT");

    // ნოთიფიკაცია
    if (finalStatus === "approved") {
      notifyUser(
        userId,
        "პროფილი დადასტურებულია! 🎉",
        "თქვენი განაცხადი წარმატებით დამოწმდა. ახლა შეგიძლიათ ისარგებლოთ აპლიკაციით.",
        { status: "approved" },
      );
    } else {
      notifyUser(
        userId,
        "პროფილის განაცხადი უარყოფილია ⚠️",
        "თქვენს პროფილში დაფიქსირდა ხარვეზი. გთხოვთ შეამოწმოთ დეტალები და განაახლოთ პროფილი.",
        { status: "rejected" },
      );
    }

    res.status(200).json({
      success: true,
      message: `User status updated to: ${finalStatus}`,
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Update Status Error:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

export const getAdminReports = async (req, res) => {
  try {
    const query = `
      SELECT 
        r.id, r.reason, r.details, r.status, r.created_at,
        r.reporter_id,
        r.reported_id,
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

export const resolveReport = async (req, res) => {
  try {
    const { reportId } = req.body;
    if (!reportId) {
      return res.status(400).json({ success: false, message: "reportId is required" });
    }

    await pool.query("UPDATE reports SET status = 'resolved' WHERE id = $1", [reportId]);
    res.status(200).json({ success: true, message: "Report resolved successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const banUserByAdmin = async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, reason } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: "userId is required" });
    }

    await client.query("BEGIN");

    // 1. მომხმარებლის დაბლოკვა
    await client.query("UPDATE users SET is_banned = true WHERE id = $1", [userId]);
    await client.query("UPDATE reports SET status = 'resolved' WHERE reported_id = $1", [userId]);

    // 2. მომხმარებლის მოწყობილობის მონაცემების წამოღება
    const deviceRes = await client.query(
      "SELECT device_uuid, push_token, registration_ip FROM user_devices WHERE user_id = $1",
      [userId],
    );

    // 3. დაბლოკილი იდენტიფიკატორების გადატანა blocked_identifiers ცხრილში
    if (deviceRes.rows.length > 0) {
      const { device_uuid, push_token, registration_ip } = deviceRes.rows[0];

      if (device_uuid || push_token || registration_ip) {
        await client.query(
          `INSERT INTO blocked_identifiers (device_uuid, push_token, ip_address, reason)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (device_uuid) DO UPDATE 
           SET push_token = EXCLUDED.push_token,
               ip_address = EXCLUDED.ip_address,
               reason = EXCLUDED.reason`,
          [device_uuid || null, push_token || null, registration_ip || null, reason || `Banned user ID: ${userId}`],
        );
      }
    }

    await client.query("COMMIT");

    res.status(200).json({ success: true, message: "User banned and device identifiers blacklisted successfully" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Ban User Error:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

export const getChatHistoryForAdmin = async (req, res) => {
  try {
    const { user1, user2 } = req.query;

    if (!user1 || !user2) {
      return res.status(400).json({ success: false, message: "user1 and user2 parameters are required" });
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

export const sendPushNotification = async (req, res) => {
  try {
    const { title, body, userIds, sendToAll } = req.body;

    if (!title || !body) {
      return res.status(400).json({ success: false, message: "title and body are required" });
    }

    let query = "SELECT push_token FROM user_devices WHERE push_token IS NOT NULL AND push_token != ''";
    let queryParams = [];

    if (!sendToAll && Array.isArray(userIds) && userIds.length > 0) {
      query += " AND user_id = ANY($1)";
      queryParams.push(userIds);
    }

    const result = await pool.query(query, queryParams);
    const tokens = result.rows.map((row) => row.push_token);

    if (tokens.length === 0) {
      return res.status(400).json({ success: false, message: "No active push tokens found for specified criteria" });
    }

    const messages = tokens.map((token) => ({
      to: token,
      sound: "default",
      title: title,
      body: body,
    }));

    const expoResponse = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    const responseData = await expoResponse.json();

    res.status(200).json({
      success: true,
      message: `Notification request sent to ${tokens.length} device(s)`,
      expoResult: responseData,
    });
  } catch (error) {
    console.error("Send Push Notification Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
