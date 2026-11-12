import { pool } from "../db/index.js";
import {
  archiveRejectedPhotos,
  moveUserPhotosToDeleted,
} from "../services/storage.service.js";
import {
  notifyUserT,
  sendExpoNotifications,
} from "../services/notification.service.js";
import { emitToAdmins } from "../socket.js";
import { REVIEW_LOCK_TTL_MINUTES } from "../services/matchConfig.js";

const toId = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

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
        // ძირითადი ველები (Frontend-ის თავსებადობისთვის)
        totalUsers: parseInt(stats.total_users || 0),
        totalMales: parseInt(stats.total_males || 0),
        totalFemales: parseInt(stats.total_females || 0),

        approvedUsers: parseInt(stats.approved_users || 0),
        approvedMales: parseInt(stats.approved_males || 0),
        approvedFemales: parseInt(stats.approved_females || 0),

        rejectedUsers: parseInt(stats.rejected_users || 0),
        pendingUsers: parseInt(stats.pending_users || 0),

        // ობიექტის სახითაც (ყოველი შემთხვევისთვის)
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
    const query =
      typeof req.query.query === "string" ? req.query.query.trim() : "";

    if (!query || query.length < 2 || query.length > 60) {
      return res.status(200).json({ success: true, data: [] });
    }

    const searchQuery = `
      SELECT 
        u.id, u.username, u.full_name, u.is_admin, u.is_banned,
        p.image_url as profile_image
      FROM users u
      LEFT JOIN photos p ON u.id = p.user_id AND p.position = 0
      WHERE u.full_name ILIKE $1 ESCAPE '\\' OR u.username ILIKE $1 ESCAPE '\\'
      LIMIT 20
    `;

    const result = await pool.query(searchQuery, [
      `%${query.replace(/[\\%_]/g, "\\$&")}%`,
    ]);

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
    const { type, gender } = req.query; // type: 'all' | 'requests', gender: 'all' | 'male' | 'female'

    const params = [];
    let query = `
      SELECT u.id, u.username, u.email, u.full_name, u.bio, u.city, u.age, u.gender,
             u.birth_date, u.status, u.pending_changes, u.rejection_reasons,
             u.review_locked_by,
             (u.review_locked_by IS NOT NULL
               AND u.review_locked_at > NOW() - INTERVAL '${REVIEW_LOCK_TTL_MINUTES} minutes') AS review_lock_active,
             (SELECT a.username FROM users a WHERE a.id = u.review_locked_by) AS review_locked_by_username,
             md5(COALESCE(u.pending_changes::text, '')) AS pending_version,
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

    // ტიპის ფილტრი (ყველა vs მოთხოვნები)
    if (type === "requests") {
      query += ` AND u.pending_changes IS NOT NULL AND u.pending_changes::text != '{}' AND u.pending_changes::text != 'null'`;
    }

    // სქესის ფილტრი
    if (gender === "male" || gender === "female") {
      params.push(gender);
      query += ` AND u.gender = $${params.length}`;
    }

    query += ` GROUP BY u.id ORDER BY u.created_at DESC LIMIT 200`;

    const result = await pool.query(query, params);

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

const REJECTION_FLAGS = [
  "photos",
  "full_name",
  "city",
  "age",
  "gender",
  "looking_for",
  "bio",
];
const PHOTO_REASON_MAX = 60;

const lockIsFresh = (lockedBy, lockedAt) =>
  !!lockedBy &&
  !!lockedAt &&
  Date.now() - new Date(lockedAt).getTime() <
    REVIEW_LOCK_TTL_MINUTES * 60 * 1000;

// ადმინი იკავებს განსახილველ მომხმარებელს. იგივე endpoint heartbeat-ადაც გამოიყენება (ვადას ახლებს).
export const claimReview = async (req, res) => {
  try {
    const userId = toId(req.body?.userId);
    const adminId = req.user.id;
    if (!userId)
      return res
        .status(400)
        .json({ success: false, message: "userId is required" });

    const prev = await pool.query(
      "SELECT review_locked_by, review_locked_at FROM users WHERE id = $1",
      [userId],
    );
    if (prev.rowCount === 0)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    const wasMine =
      Number(prev.rows[0].review_locked_by) === adminId &&
      lockIsFresh(adminId, prev.rows[0].review_locked_at);

    const upd = await pool.query(
      `UPDATE users
       SET review_locked_by = $2, review_locked_at = NOW()
       WHERE id = $1
         AND (review_locked_by IS NULL
              OR review_locked_by = $2
              OR review_locked_at IS NULL
              OR review_locked_at < NOW() - make_interval(mins => $3::int))
       RETURNING md5(COALESCE(pending_changes::text, '')) AS pending_version, status`,
      [userId, adminId, REVIEW_LOCK_TTL_MINUTES],
    );

    if (upd.rowCount === 0) {
      const who = await pool.query(
        "SELECT a.id, a.username, a.full_name FROM users u JOIN users a ON a.id = u.review_locked_by WHERE u.id = $1",
        [userId],
      );
      const a = who.rows[0] || {};
      return res.status(409).json({
        success: false,
        code: "LOCKED",
        message: "ამ მომხმარებელს ამჟამად სხვა ადმინისტრატორი ამოწმებს",
        lockedBy: {
          id: a.id ? Number(a.id) : null,
          username: a.username || a.full_name || "admin",
        },
      });
    }

    if (!wasMine) {
      emitToAdmins("review_lock_changed", {
        userId,
        lockedBy: { id: adminId, username: req.user.username },
      });
    }

    return res.status(200).json({
      success: true,
      pendingVersion: upd.rows[0].pending_version,
      status: upd.rows[0].status,
    });
  } catch (error) {
    console.error("Claim Review Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const releaseReview = async (req, res) => {
  try {
    const userId = toId(req.body?.userId);
    if (!userId)
      return res
        .status(400)
        .json({ success: false, message: "userId is required" });

    const upd = await pool.query(
      `UPDATE users SET review_locked_by = NULL, review_locked_at = NULL
       WHERE id = $1 AND review_locked_by = $2
       RETURNING id`,
      [userId, req.user.id],
    );
    if (upd.rowCount > 0)
      emitToAdmins("review_lock_changed", { userId, lockedBy: null });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Release Review Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateUserStatus = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = toId(req.body?.userId);
    const rejectionReasons = req.body?.rejectionReasons;
    const adminId = req.user.id;

    if (
      !userId ||
      !rejectionReasons ||
      typeof rejectionReasons !== "object" ||
      Array.isArray(rejectionReasons)
    ) {
      return res.status(400).json({
        success: false,
        message: "userId and rejectionReasons are required",
      });
    }

    await client.query("BEGIN");

    // წამოვიღოთ მომხმარებლის pending_changes + განხილვის მდგომარეობა
    const userRes = await client.query(
      `SELECT pending_changes, status, review_locked_by, review_locked_at,
              md5(COALESCE(pending_changes::text, '')) AS pending_version
       FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const row = userRes.rows[0];

    // სხვა ადმინის მიერ დაკავებულ მომხმარებელს ვერ დავამუშავებთ
    if (
      lockIsFresh(row.review_locked_by, row.review_locked_at) &&
      Number(row.review_locked_by) !== adminId
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        code: "LOCKED",
        message: "ამ მომხმარებელს ამჟამად სხვა ადმინისტრატორი ამოწმებს",
      });
    }

    // ახალი აპი გზავნის pendingVersion-ს: თუ განხილვისას მომხმარებელმა პროფილი შეცვალა, ძველ მონაცემებზე არ ვადასტურებთ
    if (req.body?.pendingVersion !== undefined) {
      if (
        row.status !== "pending" ||
        String(req.body.pendingVersion) !== row.pending_version
      ) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          code: "STALE",
          message:
            "მომხმარებელმა ინფორმაცია შეცვალა ან უკვე განხილულია. გახსენით თავიდან.",
        });
      }
    }

    const pendingChanges = row.pending_changes;
    const liveRes = await client.query(
      "SELECT image_url FROM photos WHERE user_id = $1",
      [userId],
    );
    const liveUrls = liveRes.rows.map((r) => r.image_url);
    const pendingNewUrls = (pendingChanges?.photos?.new || [])
      .map((p) => p?.image_url)
      .filter(Boolean);

    // უარყოფილი ველები: მხოლოდ ცნობილი ველები, true/false
    const cleanReasons = {};
    for (const k of REJECTION_FLAGS)
      cleanReasons[k] = rejectionReasons[k] === true;

    // კონკრეტული ფოტოების უარყოფა: მხოლოდ ამ მომხმარებლის (ძველი ან მოლოდინში მყოფი) ფოტოები
    const allowedUrls = new Set([...liveUrls, ...pendingNewUrls]);
    const rawRejected = Array.isArray(req.body?.rejectedPhotos)
      ? req.body.rejectedPhotos
      : [];
    const rejectedPhotos = [];
    for (const item of rawRejected) {
      const url = typeof item === "string" ? item : item?.url;
      if (typeof url !== "string" || !allowedUrls.has(url)) continue;
      if (rejectedPhotos.some((r) => r.url === url)) continue;
      const reason =
        typeof item === "object" && typeof item.reason === "string"
          ? item.reason.trim().slice(0, PHOTO_REASON_MAX)
          : "";
      rejectedPhotos.push({ url, reason });
    }
    if (rejectedPhotos.length > 0) cleanReasons.photos = true;

    const hasRejections = Object.values(cleanReasons).some(
      (value) => value === true,
    );
    const finalStatus = hasRejections ? "rejected" : "approved";
    const reasonsJson = JSON.stringify({
      ...cleanReasons,
      rejected_photos: rejectedPhotos,
    });

    let urlsToMove = [];

    if (finalStatus === "approved" && pendingChanges) {
      // თუ დამტკიცდა, pending_changes-დან ახალი მნიშვნელობები გადავიტანოთ ძირითად ველებში
      const updates = [];
      const values = [];
      let paramIdx = 1;

      const allowedFields = [
        "full_name",
        "age",
        "birth_date",
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
        urlsToMove = liveUrls.filter((u) => !pendingNewUrls.includes(u));
        await client.query("DELETE FROM photos WHERE user_id = $1", [userId]);
        for (let i = 0; i < newPhotos.length; i++) {
          const photo = newPhotos[i];
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

    // სტატუსი, rejection_reasons, reviewed_by/at. უარყოფისას pending_changes რჩება (მომხმარებლის "დრაფტი"),
    // დამტკიცებისას ირეცხება. განხილვის "დაკავება" ყოველთვის იხსნება.
    const updateStatusQuery = `
      UPDATE users 
      SET status = $1::text, 
          rejection_reasons = $2, 
          pending_changes = CASE WHEN $1::text = 'approved' THEN NULL ELSE pending_changes END,
          reviewed_by = $3,
          reviewed_at = NOW(),
          review_locked_by = NULL,
          review_locked_at = NULL
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
      await moveUserPhotosToDeleted(userId, urlsToMove);
    } else {
      // ორიგინალი რჩება დრაფტისთვის, არქივში deleted/{userId}/rejected/ იწერება ასლი
      await archiveRejectedPhotos(
        userId,
        rejectedPhotos.map((r) => r.url),
      );
    }

    emitToAdmins("review_lock_changed", {
      userId,
      lockedBy: null,
      resolved: true,
    });

    // ნოთიფიკაცია (მომხმარებლის ენაზე)
    if (finalStatus === "approved") {
      notifyUserT(userId, "profile_approved", {}, { status: "approved" });
    } else {
      notifyUserT(userId, "profile_rejected", {}, { status: "rejected" });
    }

    res.status(200).json({
      success: true,
      message: `User status updated to: ${finalStatus}`,
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
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
    const reportId = toId(req.body?.reportId);
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
    const userId = toId(req.body?.userId);
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.slice(0, 300) : "";
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, message: "userId is required" });
    }
    if (userId === req.user.id) {
      return res
        .status(400)
        .json({ success: false, message: "საკუთარ თავს ვერ დაბლოკავ" });
    }

    await client.query("BEGIN");

    // 1. მომხმარებლის დაბლოკვა (ადმინისტრატორს ვერ დაბლოკავს)
    const banRes = await client.query(
      "UPDATE users SET is_banned = true WHERE id = $1 AND COALESCE(is_admin,false) = false RETURNING id",
      [userId],
    );
    if (banRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "მომხმარებელი ვერ მოიძებნა ან ადმინისტრატორია",
      });
    }
    // ძველი სესიები უქმდება
    await client.query("DELETE FROM user_refresh_tokens WHERE user_id = $1", [
      userId,
    ]);
    await client.query(
      "UPDATE reports SET status = 'resolved' WHERE reported_id = $1",
      [userId],
    );

    // 2. მომხმარებლის მოწყობილობის მონაცემების წამოღება
    const deviceRes = await client.query(
      "SELECT device_uuid, push_token, registration_ip FROM user_devices WHERE user_id = $1",
      [userId],
    );

    // 3. დაბლოკილი იდენტიფიკატორების გადატანა blocked_identifiers ცხრილში
    for (const dev of deviceRes.rows) {
      const { device_uuid, push_token, registration_ip } = dev;

      if (device_uuid) {
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
    await client.query(
      "UPDATE user_devices SET push_token = NULL WHERE user_id = $1",
      [userId],
    );

    await client.query("COMMIT");

    res.status(200).json({
      success: true,
      message: "User banned and device identifiers blacklisted successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Ban User Error:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

export const getChatHistoryForAdmin = async (req, res) => {
  try {
    const user1 = toId(req.query.user1);
    const user2 = toId(req.query.user2);

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
      LIMIT 1000
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

    const hasTargets = Array.isArray(userIds) && userIds.length > 0;
    if (!sendToAll && !hasTargets) {
      return res.status(400).json({
        success: false,
        message: "მიუთითე userIds ან sendToAll=true",
      });
    }

    let query = `SELECT ud.push_token FROM user_devices ud
      JOIN users u ON u.id = ud.user_id
      WHERE ud.push_token IS NOT NULL AND ud.push_token != ''
        AND COALESCE(u.is_banned,false) = false`;
    const queryParams = [];

    if (!sendToAll) {
      const ids = userIds.map(toId).filter(Boolean);
      query += " AND ud.user_id = ANY($1::bigint[])";
      queryParams.push(ids);
    }

    const result = await pool.query(query, queryParams);
    const tokens = result.rows.map((row) => row.push_token);

    if (tokens.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No active push tokens found for specified criteria",
      });
    }

    // Expo აქცეპტებს მაქსიმუმ 100 შეტყობინებას ერთ მოთხოვნაში
    for (let i = 0; i < tokens.length; i += 100) {
      await sendExpoNotifications(
        tokens.slice(i, i + 100),
        String(title).slice(0, 100),
        String(body).slice(0, 300),
      );
    }

    res.status(200).json({
      success: true,
      message: `Notification request sent to ${tokens.length} device(s)`,
    });
  } catch (error) {
    console.error("Send Push Notification Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
