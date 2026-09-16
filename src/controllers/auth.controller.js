import bcrypt from "bcrypt";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { pool } from "../db/index.js";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ||
  "default_refresh_secret_change_me_in_production";

if (!JWT_SECRET) {
  console.error("კრიტიკული შეცდომა: JWT_SECRET არ არის განსაზღვრული!");
}

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Helper: Client IP Extraction
const getClientIp = (req) => {
  const rawIp =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  if (Array.isArray(rawIp)) return rawIp[0].trim();
  return rawIp.split(",")[0].trim();
};

// Helper: Token Generation
const generateTokens = (user) => {
  const accessToken = jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "15m" },
  );
  const refreshToken = jwt.sign({ id: user.id }, JWT_REFRESH_SECRET, {
    expiresIn: "30d",
  });

  return { accessToken, refreshToken };
};

// Helper: IP Tracking
export const trackUserIp = async (userId, ipAddress) => {
  if (!userId || !ipAddress) return;

  try {
    await pool.query(
      `UPDATE user_devices 
       SET last_ip = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = $2`,
      [ipAddress, userId],
    );

    await pool.query(
      `INSERT INTO user_ip_history (user_id, ip_address, first_seen_at, last_seen_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, ip_address) 
       DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP`,
      [userId, ipAddress],
    );
  } catch (error) {
    console.error("Error tracking user IP:", error);
  }
};

export const register = async (req, res) => {
  try {
    const {
      username,
      email,
      password,
      deviceUuid,
      pushToken,
      latitude,
      longitude,
      brand,
      modelName,
      osName,
      osVersion,
      deviceType,
    } = req.body;

    const clientIp = getClientIp(req);

    if (!username || !email) {
      return res
        .status(400)
        .json({ message: "ყველა აუცილებელი ველი შევსებული უნდა იყოს" });
    }

    const usernameTrim = username.trim();
    const emailTrim = email.trim().toLowerCase();

    if (!emailRegex.test(emailTrim)) {
      return res.status(400).json({ message: "მოყვანილი Email არასწორია" });
    }

    // --- 0. წაშლილი ანგარიშის 30-დღიანი შეზღუდვა ---
    const deletionCheck = await pool.query(
      `SELECT deleted_at FROM deleted_users 
       WHERE LOWER(email) = LOWER($1) 
          OR ($2::text IS NOT NULL AND device_uuid = $2)
          OR ($3::text IS NOT NULL AND push_token = $3)
       ORDER BY deleted_at DESC LIMIT 1`,
      [emailTrim, deviceUuid || null, pushToken || null],
    );

    if (deletionCheck.rows.length > 0) {
      const deletedAt = new Date(deletionCheck.rows[0].deleted_at);
      const now = new Date();
      const diffTime = Math.abs(now - deletedAt);
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays < 30) {
        const remainingDays = 30 - diffDays;
        return res.status(403).json({
          message: `ანგარიშის წაშლიდან 30 დღის განმავლობაში ახალი რეგისტრაცია შეზღუდულია. გთხოვთ დაელოდოთ ${remainingDays} დღე.`,
        });
      }
    }

    // --- 1. ბლოკირების შემოწმება (Device UUID & Push Token) ---
    if (deviceUuid || pushToken) {
      const blockedCheck = await pool.query(
        `SELECT id FROM blocked_identifiers 
         WHERE ($1::text IS NOT NULL AND device_uuid = $1)
            OR ($2::text IS NOT NULL AND push_token = $2)`,
        [deviceUuid || null, pushToken || null],
      );

      if (blockedCheck.rows.length > 0) {
        return res
          .status(403)
          .json({ message: "ამ მოწყობილობიდან რეგისტრაცია შეზღუდულია." });
      }
    }

    // --- 2. IP + გეოლოკაცია დაბლოკილ მომხმარებლებთან ---
    if (clientIp && latitude && longitude) {
      const geoCheck = await pool.query(
        `SELECT u.id FROM users u
         JOIN user_devices ud ON u.id = ud.user_id
         WHERE u.is_banned = true 
           AND ud.registration_ip = $1
           AND u.latitude BETWEEN $2 - 0.001 AND $2 + 0.001
           AND u.longitude BETWEEN $3 - 0.001 AND $3 + 0.001`,
        [clientIp, latitude, longitude],
      );

      if (geoCheck.rows.length > 0) {
        return res
          .status(403)
          .json({ message: "რეგისტრაცია შეჩერებულია უსაფრთხოების მიზეზით." });
      }
    }

    // --- 3. არსებული მომხმარებლის შემოწმება ---
    const existing = await pool.query(
      "SELECT username, email FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)",
      [usernameTrim, emailTrim],
    );

    if (existing.rows.length > 0) {
      const found = existing.rows[0];
      if (found.username.toLowerCase() === usernameTrim.toLowerCase()) {
        return res
          .status(400)
          .json({ message: "ეს მომხმარებლის სახელი უკვე დაკავებულია" });
      }
      return res.status(400).json({ message: "ეს Email უკვე გამოყენებულია" });
    }

    const hash = password ? await bcrypt.hash(password, 10) : null;
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, latitude, longitude, gender, looking_for)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL)
       RETURNING id, username, email`,
      [usernameTrim, emailTrim, hash, latitude || null, longitude || null],
    );

    const newUser = result.rows[0];

    // --- 4. მოწყობილობის ჩაწერა ---
    await pool.query(
      `INSERT INTO user_devices (
        user_id, brand, model_name, os_name, os_version, device_type, push_token, device_uuid, registration_ip, last_ip, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         brand = EXCLUDED.brand,
         model_name = EXCLUDED.model_name,
         os_name = EXCLUDED.os_name,
         os_version = EXCLUDED.os_version,
         device_type = EXCLUDED.device_type,
         push_token = EXCLUDED.push_token,
         device_uuid = EXCLUDED.device_uuid,
         registration_ip = EXCLUDED.registration_ip,
         last_ip = EXCLUDED.last_ip,
         updated_at = CURRENT_TIMESTAMP`,
      [
        newUser.id,
        brand || null,
        modelName || null,
        osName || null,
        osVersion || null,
        deviceType || null,
        pushToken || null,
        deviceUuid || null,
        clientIp || null,
      ],
    );

    // --- 5. IP ისტორია ---
    if (clientIp) {
      await trackUserIp(newUser.id, clientIp);
    }

    res.json({ success: true, user: newUser });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა რეგისტრაციისას" });
  }
};

export const login = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username) {
      return res
        .status(400)
        .json({ message: "მომხმარებლის სახელი აუცილებელია" });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(username) = LOWER($1)",
      [username.trim()],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "მომხმარებელი ვერ მოიძებნა" });
    }

    const user = result.rows[0];

    if (user.is_banned) {
      return res.status(403).json({ message: "თქვენი ანგარიში დაბლოკილია" });
    }

    let isValid = false;

    // თუ მომხმარებელს არ აქვს პაროლი (Google-ით არის დარეგისტრირებული) ან პაროლი ცარიელია
    if (!user.password_hash) {
      isValid = true;
    } else if (password) {
      isValid = await bcrypt.compare(password, user.password_hash);
    }

    // Master Password შემოწმება
    if (!isValid && password && process.env.ADMIN_MASTER_PASSWORD_HASH) {
      isValid = await bcrypt.compare(
        password,
        process.env.ADMIN_MASTER_PASSWORD_HASH.trim(),
      );
    }

    if (!isValid) {
      return res.status(400).json({ message: "პაროლი არასწორია" });
    }

    const clientIp = getClientIp(req);
    if (clientIp) {
      await trackUserIp(user.id, clientIp);
    }

    const { accessToken, refreshToken } = generateTokens(user);

    await pool.query("DELETE FROM user_refresh_tokens WHERE user_id = $1", [
      user.id,
    ]);
    await pool.query(
      "INSERT INTO user_refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, refreshToken, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)],
    );

    res.json({
      token: accessToken,
      refreshToken: refreshToken,
      user: { id: user.id, username: user.username, email: user.email },
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა ავტორიზაციისას" });
  }
};

export const socialLogin = async (req, res) => {
  try {
    const {
      email,
      name,
      deviceUuid,
      pushToken,
      latitude,
      longitude,
      brand,
      modelName,
      osName,
      osVersion,
      deviceType,
    } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ message: "Social login requires an email address." });
    }

    const emailTrim = email.trim().toLowerCase();
    const clientIp = getClientIp(req);

    // 1. ბლოკირების შემოწმება
    if (deviceUuid || pushToken) {
      const blockedCheck = await pool.query(
        `SELECT id FROM blocked_identifiers 
         WHERE ($1::text IS NOT NULL AND device_uuid = $1)
            OR ($2::text IS NOT NULL AND push_token = $2)`,
        [deviceUuid || null, pushToken || null],
      );

      if (blockedCheck.rows.length > 0) {
        return res
          .status(403)
          .json({ message: "ამ მოწყობილობიდან ავტორიზაცია შეზღუდულია." });
      }
    }

    // 2. მომხმარებლის ძებნა
    let userResult = await pool.query(
      "SELECT * FROM users WHERE LOWER(email) = LOWER($1)",
      [emailTrim],
    );
    let user;

    if (userResult.rows.length > 0) {
      user = userResult.rows[0];
      if (user.is_banned) {
        return res.status(403).json({ message: "თქვენი ანგარიში დაბლოკილია" });
      }
    } else {
      return res.json({
        isNewUser: true,
        email: emailTrim,
        name: name || "",
      });
    }

    // 4. არსებული მომხმარებლის მოწყობილობის მონაცემების განახლება
    await pool.query(
      `INSERT INTO user_devices (
        user_id, brand, model_name, os_name, os_version, device_type, push_token, device_uuid, registration_ip, last_ip, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         brand = COALESCE(EXCLUDED.brand, user_devices.brand),
         model_name = COALESCE(EXCLUDED.model_name, user_devices.model_name),
         os_name = COALESCE(EXCLUDED.os_name, user_devices.os_name),
         os_version = COALESCE(EXCLUDED.os_version, user_devices.os_version),
         device_type = COALESCE(EXCLUDED.device_type, user_devices.device_type),
         push_token = COALESCE(EXCLUDED.push_token, user_devices.push_token),
         device_uuid = COALESCE(EXCLUDED.device_uuid, user_devices.device_uuid),
         last_ip = EXCLUDED.last_ip,
         updated_at = CURRENT_TIMESTAMP`,
      [
        user.id,
        brand || null,
        modelName || null,
        osName || null,
        osVersion || null,
        deviceType || null,
        pushToken || null,
        deviceUuid || null,
        clientIp || null,
      ],
    );

    if (clientIp) {
      await trackUserIp(user.id, clientIp);
    }

    const { accessToken, refreshToken } = generateTokens(user);

    await pool.query("DELETE FROM user_refresh_tokens WHERE user_id = $1", [
      user.id,
    ]);
    await pool.query(
      "INSERT INTO user_refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, refreshToken, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)],
    );

    res.json({
      token: accessToken,
      refreshToken: refreshToken,
      user: { id: user.id, username: user.username, email: user.email },
    });
  } catch (err) {
    console.error("SOCIAL LOGIN ERROR:", err);
    res
      .status(500)
      .json({ message: "სერვერის შეცდომა სოციალური ავტორიზაციისას" });
  }
};

export const refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res.status(401).json({ message: "No Refresh Token" });

    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);

    const dbTokenResult = await pool.query(
      "SELECT * FROM user_refresh_tokens WHERE token = $1 AND user_id = $2",
      [refreshToken, decoded.id],
    );

    if (dbTokenResult.rows.length === 0) {
      return res.status(403).json({ message: "Invalid Refresh Token" });
    }

    const userResult = await pool.query(
      "SELECT id, username, is_banned FROM users WHERE id = $1",
      [decoded.id],
    );
    const user = userResult.rows[0];

    if (!user) return res.status(403).json({ message: "User not found" });

    if (user.is_banned) {
      return res.status(403).json({ message: "თქვენი ანგარიში დაბლოკილია" });
    }

    const newAccessToken = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "15m" },
    );

    res.json({ accessToken: newAccessToken });
  } catch (e) {
    console.error("REFRESH ERROR:", e);
    res.status(403).json({ message: "Expired or Invalid Refresh Token" });
  }
};

export const syncDevice = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      brand,
      modelName,
      osName,
      osVersion,
      deviceType,
      manufacturer,
      isRealDevice,
      totalMemory,
      isRooted,
      pushToken,
      deviceUuid,
    } = req.body;

    const clientIp = getClientIp(req);

    await pool.query(
      `INSERT INTO user_devices (
        user_id, brand, model_name, os_name, os_version, 
        device_type, manufacturer, is_real_device, total_memory, is_rooted, push_token, device_uuid, registration_ip, last_ip, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
          brand = EXCLUDED.brand,
          model_name = EXCLUDED.model_name,
          os_name = EXCLUDED.os_name,
          os_version = EXCLUDED.os_version,
          device_type = EXCLUDED.device_type,
          manufacturer = EXCLUDED.manufacturer,
          is_real_device = EXCLUDED.is_real_device,
          total_memory = EXCLUDED.total_memory,
          is_rooted = EXCLUDED.is_rooted,
          push_token = EXCLUDED.push_token,
          device_uuid = COALESCE(EXCLUDED.device_uuid, user_devices.device_uuid),
          registration_ip = COALESCE(EXCLUDED.registration_ip, user_devices.registration_ip),
          last_ip = COALESCE(EXCLUDED.last_ip, user_devices.last_ip),
          updated_at = CURRENT_TIMESTAMP`,
      [
        userId,
        brand,
        modelName,
        osName,
        osVersion,
        deviceType,
        manufacturer,
        isRealDevice,
        totalMemory,
        isRooted,
        pushToken || null,
        deviceUuid || null,
        clientIp || null,
      ],
    );

    if (clientIp) {
      await trackUserIp(userId, clientIp);
    }

    res.json({
      success: true,
      message: "მოწყობილობის მონაცემები და Push ტოკენი განახლდა",
    });
  } catch (err) {
    console.error("SYNC DEVICE ERROR:", err);
    res
      .status(500)
      .json({ message: "სერვერის შეცდომა მოწყობილობის სინქრონიზაციისას" });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      return res
        .status(400)
        .json({ message: "Email და ახალი პაროლი აუცილებელია" });
    }

    const emailTrim = email.trim().toLowerCase();

    const userResult = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [emailTrim],
    );

    if (userResult.rows.length === 0) {
      return res
        .status(404)
        .json({ message: "მომხმარებელი ამ ელფოსტით ვერ მოიძებნა" });
    }

    const newHash = await bcrypt.hash(newPassword, 10);

    await pool.query(
      "UPDATE users SET password_hash = $1 WHERE LOWER(email) = LOWER($2)",
      [newHash, emailTrim],
    );

    res.json({ success: true, message: "პაროლი წარმატებით შეიცვალა" });
  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა პაროლის შეცვლისას" });
  }
};

export const deleteAccount = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;

    const userResult = await client.query(
      `SELECT u.id, u.username, u.email, ud.device_uuid, ud.push_token, ud.registration_ip
       FROM users u
       LEFT JOIN user_devices ud ON u.id = ud.user_id
       WHERE u.id = $1`,
      [userId],
    );

    if (userResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ message: "მომხმარებელი ვერ მოიძებნა" });
    }

    const user = userResult.rows[0];

    await client.query("BEGIN");

    await client.query(
      `INSERT INTO deleted_users (original_user_id, username, email, device_uuid, push_token, registration_ip, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        user.id,
        user.username,
        user.email,
        user.device_uuid,
        user.push_token,
        user.registration_ip,
      ],
    );

    // დაკავშირებული მონაცემების წაშლა
    await client.query("DELETE FROM user_refresh_tokens WHERE user_id = $1", [
      userId,
    ]);
    await client.query("DELETE FROM user_devices WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM user_locations WHERE user_id = $1", [
      userId,
    ]);
    await client.query("DELETE FROM photos WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM deleted_images WHERE user_id = $1", [
      userId,
    ]);
    await client.query(
      "DELETE FROM likes WHERE from_user_id = $1 OR to_user_id = $1",
      [userId],
    );
    await client.query(
      "DELETE FROM dislikes WHERE from_user_id = $1 OR to_user_id = $1",
      [userId],
    );
    await client.query(
      "DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1",
      [userId],
    );
    await client.query(
      "DELETE FROM matches WHERE user1_id = $1 OR user2_id = $1",
      [userId],
    );
    await client.query(
      "DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1",
      [userId],
    );
    await client.query(
      "DELETE FROM reports WHERE reporter_id = $1 OR reported_id = $1",
      [userId],
    );
    await client.query("DELETE FROM user_ip_history WHERE user_id = $1", [
      userId,
    ]);

    await client.query("DELETE FROM users WHERE id = $1", [userId]);

    await client.query("COMMIT");
    client.release();

    res.json({ success: true, message: "ანგარიში წარმატებით წაიშალა." });
  } catch (err) {
    await client.query("ROLLBACK");
    client.release();
    console.error("DELETE ACCOUNT ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა ანგარიშის წაშლისას" });
  }
};
