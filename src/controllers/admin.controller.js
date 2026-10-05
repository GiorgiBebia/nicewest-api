import { pool } from "../db/index.js";
import { notifyUser } from "../services/notification.service.js";

export const getStats = async (req, res) => {
  try {
    const query = `
      SELECT 
        -- რეგისტრირებული (სულ)
        COUNT(*) AS total_users,
        COUNT(*) FILTER (WHERE gender = 'male') AS total_males,
        COUNT(*) FILTER (WHERE gender = 'female') AS total_females,

        -- ავტორიზებული / დადასტურებული (Approved)
        COUNT(*) FILTER (WHERE status = 'approved') AS approved_users,
        COUNT(*) FILTER (WHERE status = 'approved' AND gender = 'male') AS approved_males,
        COUNT(*) FILTER (WHERE status = 'approved' AND gender = 'female') AS approved_females,

        -- უარყოფილი (Rejected)
        COUNT(*) FILTER (WHERE status = 'rejected') AS rejected_users,

        -- მოლოდინის რეჟიმში (Pending)
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_users
      FROM users;
    `;

    const result = await pool.query(query);
    const stats = result.rows[0];

    res.status(200).json({
      success: true,
      data: {
        totalUsers: parseInt(stats.total_users || 0),
        totalMales: parseInt(stats.total_males || 0),
        totalFemales: parseInt(stats.total_females || 0),

        approvedUsers: parseInt(stats.approved_users || 0),
        approvedMales: parseInt(stats.approved_males || 0),
        approvedFemales: parseInt(stats.approved_females || 0),

        rejectedUsers: parseInt(stats.rejected_users || 0),
        pendingUsers: parseInt(stats.pending_users || 0),

        total: {
          all: parseInt(stats.total_users || 0),
          males: parseInt(stats.total_males || 0),
          females: parseInt(stats.total_females || 0),
        },
        approved: {
          all: parseInt(stats.approved_users || 0),
          males: parseInt(stats.approved_males || 0),
          females: parseInt(stats.approved_females || 0),
        },
      },
    });
  } catch (error) {
    console.error("Get Stats Error:", error);
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
    const { type, gender } = req.query;

    let query = `
      SELECT u.id, u.username, u.email, u.full_name, u.bio, u.city, u.age, u.gender,
             u.birth_date, u.status, u.pending_changes, u.rejection_reasons,
             u.created_at,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', p.id,
                   'image_url', p.image_url,
                   'is_main', p.is_main,
                   'position', p.position
                 ) ORDER BY p.position ASC
               ) FILTER (WHERE p.id IS NOT NULL), '[]'
             ) AS photos
      FROM users u
      LEFT JOIN photos p ON u.id = p.user_id
      WHERE u.status = 'pending'
    `;

    if (type === "requests") {
      query += ` AND u.pending_changes IS NOT NULL AND u.pending_changes::text != '{}' AND u.pending_changes::text != 'null'`;
    }

    if (gender && gender !== "all") {
      query += ` AND u.gender = '${gender}'`;
    }

    query += ` GROUP BY u.id, u.username, u.email, u.full_name, u.bio, u.city, u.age, u.gender, u.birth_date, u.status, u.pending_changes, u.rejection_reasons, u.created_at
               ORDER BY u.created_at DESC`;

    const result = await pool.query(query);

    return res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get Pending Users Error:", error);
    return res.status(500).json({ success: false, message: error.message });
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
    const adminId = req.user?.id || req.user?.userId;

    if (!userId || !rejectionReasons) {
      return res.status(400).json({
        success: false,
        message: "userId and rejectionReasons are required",
      });
    }

    // შემოწმება: არის თუ არა რეალურად რაიმე ხარვეზი მონიშნული
    const hasRejections = Object.entries(rejectionReasons).some(
      ([key, value]) => {
        if (key === "rejectedPhotos") {
          return Array.isArray(value) && value.length > 0;
        }
        return value === true;
      },
    );

    const finalStatus = hasRejections ? "rejected" : "approved";
    const reasonsJson = JSON.stringify(rejectionReasons);

    await client.query("BEGIN");

    const userRes = await client.query(
      "SELECT pending_changes FROM users WHERE id = $1",
      [userId],
    );
    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const pendingChanges = userRes.rows[0].pending_changes;

    if (finalStatus === "approved" && pendingChanges) {
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
        "birth_date",
      ];

      allowedFields.forEach((field) => {
        let newValue = undefined;
        if (pendingChanges[field] !== undefined) {
          if (
            typeof pendingChanges[field] === "object" &&
            pendingChanges[field] !== null &&
            pendingChanges[field].new !== undefined
          ) {
            newValue = pendingChanges[field].new;
          } else {
            newValue = pendingChanges[field];
          }
        }

        if (newValue !== undefined) {
          updates.push(`${field} = $${paramIdx}`);
          values.push(newValue);
          paramIdx++;
        }
      });

      if (updates.length > 0) {
        values.push(userId);
        const dynamicQuery = `UPDATE users SET ${updates.join(", ")} WHERE id = $${paramIdx}`;
        await client.query(dynamicQuery, values);
      }

      // ფოტოების განახლება
      const photosToUpdate =
        pendingChanges.photos?.new ||
        (Array.isArray(pendingChanges.photos) ? pendingChanges.photos : null);

      if (photosToUpdate) {
        await client.query("DELETE FROM photos WHERE user_id = $1", [userId]);
        for (let i = 0; i < photosToUpdate.length; i++) {
          const photo = photosToUpdate[i];
          if (photo && photo.image_url) {
            const photoPos = photo.position !== undefined ? photo.position : i;
            await client.query(
              "INSERT INTO photos (user_id, image_url, position, is_main) VALUES ($1, $2, $3, $4)",
              [userId, photo.image_url, photoPos, photoPos === 0],
            );
          }
        }
      }
    }

    const updateStatusQuery = `
      UPDATE users 
      SET status = $1, 
          rejection_reasons = $2, 
          pending_changes = NULL,
          reviewed_by = $3,
          reviewed_at = NOW()
      WHERE id = $4 
      RETURNING id, status, rejection_reasons, reviewed_by, reviewed_at
    `;
    const result = await client.query(updateStatusQuery, [
      finalStatus,
      reasonsJson,
      adminId,
      userId,
    ]);

    await client.query("COMMIT");

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
      return res
        .status(400)
        .json({ success: false, message: "reportId is required" });
    }

    await pool.query("UPDATE reports SET status = 'resolved' WHERE id = $1", [
      reportId,
    ]);
    res
      .status(200)
      .json({ success: true, message: "Report resolved successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const banUserByAdmin = async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, reason } = req.body;
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, message: "userId is required" });
    }

    await client.query("BEGIN");

    await client.query("UPDATE users SET is_banned = true WHERE id = $1", [
      userId,
    ]);
    await client.query(
      "UPDATE reports SET status = 'resolved' WHERE reported_id = $1",
      [userId],
    );

    const deviceRes = await client.query(
      "SELECT device_uuid, push_token, registration_ip FROM user_devices WHERE user_id = $1",
      [userId],
    );

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
          [
            device_uuid || null,
            push_token || null,
            registration_ip || null,
            reason || `Banned user ID: ${userId}`,
          ],
        );
      }
    }

    await client.query("COMMIT");

    res.status(200).json({
      success: true,
      message: "User banned and device identifiers blacklisted successfully",
    });
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
      return res.status(400).json({
        success: false,
        message: "user1 and user2 parameters are required",
      });
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
      return res
        .status(400)
        .json({ success: false, message: "title and body are required" });
    }

    let query =
      "SELECT push_token FROM user_devices WHERE push_token IS NOT NULL AND push_token != ''";
    let queryParams = [];

    if (!sendToAll && Array.isArray(userIds) && userIds.length > 0) {
      query += " AND user_id = ANY($1)";
      queryParams.push(userIds);
    }

    const result = await pool.query(query, queryParams);
    const tokens = result.rows.map((row) => row.push_token);

    if (tokens.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No active push tokens found for specified criteria",
      });
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

export const getUserByIdForAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT u.id, u.username, u.email, u.full_name, u.bio, u.city, u.age, u.gender,
             u.birth_date, u.status, u.pending_changes, u.rejection_reasons, u.created_at,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', p.id,
                   'image_url', p.image_url,
                   'is_main', p.is_main,
                   'position', p.position
                 ) ORDER BY p.position ASC
               ) FILTER (WHERE p.id IS NOT NULL), '[]'
             ) AS photos
      FROM users u
      LEFT JOIN photos p ON u.id = p.user_id
      WHERE u.id = $1
      GROUP BY u.id, u.username, u.email, u.full_name, u.bio, u.city, u.age, u.gender, u.birth_date, u.status, u.pending_changes, u.rejection_reasons, u.created_at
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    return res.status(200).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Get User By ID Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
