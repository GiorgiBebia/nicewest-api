import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import { pool } from "../db/index.js";
import { sendCodeEmail } from "../services/email.service.js";
import {
  CODE_TTL_MIN,
  RESEND_COOLDOWN_SEC,
  checkCode,
  consumeCode,
  dropCode,
  issueCode,
} from "../services/emailCode.service.js";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

// ორივე საიდუმლო სავალდებულოა. ნაგულისხმევი მნიშვნელობა აღარ არსებობს,
// რადგან კოდი GitHub-ზეა და ნაგულისხმევი საიდუმლო ყველასთვის ცნობილი იქნებოდა.
if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  console.error("კრიტიკული შეცდომა: JWT_SECRET და JWT_REFRESH_SECRET უნდა იყოს განსაზღვრული!");
  process.exit(1);
}

// Google Web Client ID საჯაროა (აპშიც წერია). Render-ში შეგიძლია
// GOOGLE_WEB_CLIENT_ID-ით გადაწერო (რამდენიმე მნიშვნელობა მძიმით).
const GOOGLE_CLIENT_IDS = (
  process.env.GOOGLE_WEB_CLIENT_ID || "390950464634-5l06iafa3t1vb1s00eao74ir5juogbgc.apps.googleusercontent.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// registrationToken ხელმოწერილია JWT_SECRET-ისგან განსხვავებული გასაღებით,
// რომ ის ვერასდროს გამოდგეს ჩვეულებრივ access token-ად
const REGISTRATION_SECRET = `${JWT_SECRET}:google-registration`;

const googleClient = new OAuth2Client();

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const usernameRegex = /^[\p{L}\p{N}_.]{3,30}$/u;
const REFRESH_DAYS = 30;

// Google idToken-ის რეალური გადამოწმება. კლიენტის გამოგზავნილ email-ს არასდროს ვენდობით.
// აბრუნებს { email, name } ან null-ს.
const verifyGoogleIdToken = async (idToken) => {
  if (!idToken || typeof idToken !== "string") return null;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_IDS,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified) return null;
    return {
      email: payload.email.trim().toLowerCase(),
      name: payload.name || "",
    };
  } catch (e) {
    console.warn("GOOGLE TOKEN VERIFY FAILED:", e.message);
    return null;
  }
};

// Helper: Client IP (server.js-ში დაყენებულია trust proxy, ამიტომ req.ip სანდოა)
const getClientIp = (req) => req.ip || req.socket.remoteAddress || "";

// Helper: Token Generation
const generateTokens = (user) => {
  const accessToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "15m" });
  const refreshToken = jwt.sign({ id: user.id }, JWT_REFRESH_SECRET, {
    expiresIn: `${REFRESH_DAYS}d`,
  });

  return { accessToken, refreshToken };
};

// refresh token-ის შენახვა (რამდენიმე მოწყობილობა ერთდროულად დაიშვება)
const storeRefreshToken = async (userId, refreshToken) => {
  await pool.query("DELETE FROM user_refresh_tokens WHERE user_id = $1 AND expires_at < NOW()", [userId]);
  await pool.query("INSERT INTO user_refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)", [
    userId,
    refreshToken,
    new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000),
  ]);
};

const buildLoginResponse = async (user) => {
  const { accessToken, refreshToken } = generateTokens(user);
  await storeRefreshToken(user.id, refreshToken);

  const isComplete = Boolean(user.gender && user.birth_date && user.city && user.looking_for);

  return {
    token: accessToken,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      is_complete: isComplete,
      status: user.status,
      is_admin: user.is_admin,
    },
  };
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

// Helper: App Open Logging
export const logAppOpen = async (req, res) => {
  try {
    const userId = req.user.id;

    await pool.query("INSERT INTO app_sessions (user_id) VALUES ($1)", [userId]);

    res.json({ success: true });
  } catch (err) {
    console.error("LOG APP OPEN ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა სესიის ლოგირებისას" });
  }
};

const upsertDevice = (userId, d, clientIp) =>
  pool.query(
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
      userId,
      d.brand || null,
      d.modelName || null,
      d.osName || null,
      d.osVersion || null,
      d.deviceType || null,
      d.pushToken || null,
      d.deviceUuid || null,
      clientIp || null,
    ],
  );

// მოწყობილობის ველები, რომლებიც რეგისტრაციის დადასტურებამდე დროებით ინახება
const pickDevice = (body) => {
  const str = (v) => (typeof v === "string" ? v.slice(0, 200) : null);
  return {
    brand: str(body.brand),
    modelName: str(body.modelName),
    osName: str(body.osName),
    osVersion: str(body.osVersion),
    deviceType: Number.isInteger(body.deviceType) ? body.deviceType : null,
    pushToken: str(body.pushToken),
    deviceUuid: str(body.deviceUuid),
  };
};

const insertUser = async ({ username, email, hash, latitude, longitude }) => {
  const result = await pool.query(
    `INSERT INTO users (username, email, password_hash, latitude, longitude, gender, looking_for)
     VALUES ($1, $2, $3, $4, $5, NULL, NULL)
     RETURNING id, username, email, status, is_admin, gender, birth_date, city, looking_for`,
    [username, email, hash, latitude || null, longitude || null],
  );
  return result.rows[0];
};

const normalizeEmail = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const isSixDigits = (v) => typeof v === "string" && /^\d{6}$/.test(v.trim());

// კოდის შექმნა და გაგზავნა. თუ გაგზავნა ვერ მოხერხდა, ახალ ჩანაწერს ვშლით,
// რომ cooldown-მა მომხმარებელი უშედეგოდ არ დაბლოკოს (keepOnFail=true: ხელახლა გაგზავნისას ძველი payload რჩება).
// აბრუნებს { ok: true } ან { ok: false, status, body }
const sendCode = async ({ email, purpose, payload, keepOnFail = false }) => {
  let code;
  try {
    code = await issueCode({ email, purpose, payload });
  } catch (e) {
    if (e.code === "COOLDOWN") {
      return {
        ok: false,
        status: 429,
        body: {
          message: `კოდი ახლახან გაიგზავნა. სცადეთ ${e.retryAfter} წამში.`,
          retryAfter: e.retryAfter,
        },
      };
    }
    if (e.code === "NO_PENDING") {
      return {
        ok: false,
        status: 400,
        body: { message: "რეგისტრაციის მონაცემები ვერ მოიძებნა. გთხოვთ თავიდან დაიწყოთ რეგისტრაცია." },
      };
    }
    throw e;
  }

  try {
    await sendCodeEmail({ to: email, code, purpose, ttlMinutes: CODE_TTL_MIN });
    return { ok: true };
  } catch (e) {
    console.error("SEND CODE EMAIL ERROR:", e.message);
    if (!keepOnFail) await dropCode(email, purpose).catch(() => {});
    return {
      ok: false,
      status: 503,
      body: { message: "ელფოსტის გაგზავნა ვერ მოხერხდა. სცადეთ მოგვიანებით." },
    };
  }
};

const codeFailureResponse = (check) =>
  check.reason === "invalid"
    ? {
        message:
          check.attemptsLeft > 0
            ? `კოდი არასწორია. დარჩენილი მცდელობა: ${check.attemptsLeft}`
            : "კოდი არასწორია. მცდელობები ამოიწურა, მოითხოვეთ ახალი კოდი.",
        code: "CODE_INVALID",
        attemptsLeft: check.attemptsLeft,
      }
    : {
        message: "კოდს ვადა გაუვიდა ან მცდელობები ამოიწურა. მოითხოვეთ ახალი კოდი.",
        code: "CODE_EXPIRED",
      };

export const register = async (req, res) => {
  try {
    const { username, email, password, registrationToken, deviceUuid, pushToken, latitude, longitude } = req.body;

    const clientIp = getClientIp(req);

    // --- Google-ით რეგისტრაცია: email მოდის მხოლოდ ხელმოწერილი ტოკენიდან ---
    let emailTrim;
    let verifiedByGoogle = false;

    if (registrationToken) {
      try {
        const decoded = jwt.verify(registrationToken, REGISTRATION_SECRET);
        if (decoded.purpose !== "google-register" || !decoded.email) {
          throw new Error("bad token");
        }
        emailTrim = String(decoded.email).toLowerCase();
        verifiedByGoogle = true;
      } catch (e) {
        return res.status(400).json({
          message: "Google-ის დადასტურების ვადა გაუვიდა. გთხოვთ თავიდან სცადოთ Google-ით შესვლა.",
        });
      }
    } else {
      if (!email || typeof email !== "string") {
        return res.status(400).json({ message: "ყველა აუცილებელი ველი შევსებული უნდა იყოს" });
      }
      emailTrim = email.trim().toLowerCase();
    }

    if (!username || typeof username !== "string") {
      return res.status(400).json({ message: "ყველა აუცილებელი ველი შევსებული უნდა იყოს" });
    }

    const usernameTrim = username.trim();

    if (!usernameRegex.test(usernameTrim)) {
      return res.status(400).json({
        message: "მომხმარებლის სახელი უნდა იყოს 3-30 სიმბოლო (ასოები, ციფრები, _ და .)",
      });
    }

    if (!emailRegex.test(emailTrim)) {
      return res.status(400).json({ message: "მოყვანილი Email არასწორია" });
    }

    // პაროლი სავალდებულოა, თუ Google-ით არ ვრეგისტრირდებით
    if (!verifiedByGoogle || password) {
      if (typeof password !== "string" || password.length < 8 || password.length > 72) {
        return res.status(400).json({ message: "პაროლი უნდა იყოს 8-დან 72 სიმბოლომდე" });
      }
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
        return res.status(403).json({ message: "ამ მოწყობილობიდან რეგისტრაცია შეზღუდულია." });
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
        return res.status(403).json({ message: "რეგისტრაცია შეჩერებულია უსაფრთხოების მიზეზით." });
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
        return res.status(400).json({ message: "ეს მომხმარებლის სახელი უკვე დაკავებულია" });
      }
      return res.status(400).json({ message: "ეს Email უკვე გამოყენებულია" });
    }

    const hash = password ? await bcrypt.hash(password, 10) : null;

    // --- ჩვეულებრივი რეგისტრაცია: ანგარიშს ჯერ არ ვქმნით ---
    // მონაცემებს დროებით ვინახავთ და ვაგზავნით ელფოსტის კოდს. მომხმარებელი შეიქმნება
    // მხოლოდ POST /auth/register/verify-ზე, ამიტომ დაუდასტურებელი ანგარიშები ბაზაში არ ხვდება.
    if (!verifiedByGoogle) {
      const sent = await sendCode({
        email: emailTrim,
        purpose: "register",
        payload: {
          username: usernameTrim,
          passwordHash: hash,
          latitude: latitude || null,
          longitude: longitude || null,
          clientIp: clientIp || null,
          device: pickDevice(req.body),
        },
      });
      if (!sent.ok) return res.status(sent.status).json(sent.body);

      return res.json({
        success: true,
        verificationRequired: true,
        email: emailTrim,
        codeTtlMinutes: CODE_TTL_MIN,
        resendAfterSec: RESEND_COOLDOWN_SEC,
      });
    }

    // --- Google-ით რეგისტრაცია: email უკვე დადასტურებულია Google-ის მიერ ---
    const newUser = await insertUser({
      username: usernameTrim,
      email: emailTrim,
      hash,
      latitude,
      longitude,
    });

    // --- 4. მოწყობილობის ჩაწერა ---
    await upsertDevice(newUser.id, req.body, clientIp);

    // --- 5. IP ისტორია ---
    if (clientIp) {
      await trackUserIp(newUser.id, clientIp);
    }

    // Google-ით რეგისტრირებულს პაროლის გარეშე პირდაპირ ვუბრუნებთ სესიას
    const session = await buildLoginResponse(newUser);
    return res.json({ success: true, ...session });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ message: "ეს მომხმარებელი ან Email უკვე გამოყენებულია" });
    }
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა რეგისტრაციისას" });
  }
};

export const login = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || typeof username !== "string") {
      return res.status(400).json({ message: "მომხმარებლის სახელი აუცილებელია" });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ message: "პაროლი აუცილებელია" });
    }

    const usernameTrim = username.trim();

    // 1. შემოწმება: ხომ არ არის მომხმარებელი წაშლილთა/არქივის ცხრილში?
    const deletedCheck = await pool.query(
      "SELECT id FROM deleted_users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)",
      [usernameTrim],
    );

    if (deletedCheck.rows.length > 0) {
      return res.status(403).json({ message: "ეს ანგარიში წაშლილია და წვდომა შეზღუდულია." });
    }

    // 2. ძირითადი იუზერის ძებნა (username ან email)
    const result = await pool.query(
      `SELECT * FROM users
       WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
       ORDER BY (LOWER(username) = LOWER($1)) DESC
       LIMIT 1`,
      [usernameTrim],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "მომხმარებელი ვერ მოიძებნა" });
    }

    const user = result.rows[0];

    if (user.is_banned) {
      return res.status(403).json({ message: "თქვენი ანგარიში დაბლოკილია", code: "BANNED" });
    }

    // Google-ით შექმნილ ანგარიშს, რომელსაც პაროლი არ აქვს, პაროლით ვერ შეხვალ
    if (!user.password_hash) {
      return res.status(400).json({
        message: "ეს ანგარიში Google-ით შეიქმნა. გთხოვთ გამოიყენოთ „Google-ით შესვლა“.",
      });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ message: "პაროლი არასწორია" });
    }

    const clientIp = getClientIp(req);
    if (clientIp) {
      await trackUserIp(user.id, clientIp);
    }

    res.json(await buildLoginResponse(user));
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა ავტორიზაციისას" });
  }
};

export const socialLogin = async (req, res) => {
  try {
    const { idToken, name, deviceUuid, pushToken } = req.body;

    // email-ს ვიღებთ მხოლოდ Google-ის მიერ ხელმოწერილი ტოკენიდან
    const google = await verifyGoogleIdToken(idToken);
    if (!google) {
      return res.status(401).json({ message: "Google-ის ავტორიზაცია ვერ დადასტურდა" });
    }

    const emailTrim = google.email;

    // შემოწმება: ხომ არ არის წაშლილი ანგარიში?
    const deletedCheck = await pool.query("SELECT id FROM deleted_users WHERE LOWER(email) = LOWER($1)", [emailTrim]);

    if (deletedCheck.rows.length > 0) {
      return res.status(403).json({ message: "ეს ანგარიში წაშლილია და წვდომა შეზღუდულია." });
    }

    const clientIp = getClientIp(req);

    if (deviceUuid || pushToken) {
      const blockedCheck = await pool.query(
        `SELECT id FROM blocked_identifiers
         WHERE ($1::text IS NOT NULL AND device_uuid = $1)
            OR ($2::text IS NOT NULL AND push_token = $2)`,
        [deviceUuid || null, pushToken || null],
      );

      if (blockedCheck.rows.length > 0) {
        return res.status(403).json({ message: "ამ მოწყობილობიდან ავტორიზაცია შეზღუდულია." });
      }
    }

    const userResult = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [emailTrim]);

    if (userResult.rows.length === 0) {
      // ახალი მომხმარებელი: ვაძლევთ 15-წუთიან ხელმოწერილ ტოკენს რეგისტრაციის დასასრულებლად
      const displayName = google.name || name || "";
      const registrationToken = jwt.sign(
        { purpose: "google-register", email: emailTrim, name: displayName },
        REGISTRATION_SECRET,
        { expiresIn: "15m" },
      );
      return res.json({
        isNewUser: true,
        email: emailTrim,
        name: displayName,
        registrationToken,
      });
    }

    const user = userResult.rows[0];
    if (user.is_banned) {
      return res.status(403).json({ message: "თქვენი ანგარიში დაბლოკილია", code: "BANNED" });
    }

    await upsertDevice(user.id, req.body, clientIp);

    if (clientIp) {
      await trackUserIp(user.id, clientIp);
    }

    res.json(await buildLoginResponse(user));
  } catch (err) {
    console.error("SOCIAL LOGIN ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა სოციალური ავტორიზაციისას" });
  }
};

export const refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken || typeof refreshToken !== "string") return res.status(401).json({ message: "No Refresh Token" });

    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);

    const dbTokenResult = await pool.query(
      "SELECT id FROM user_refresh_tokens WHERE token = $1 AND user_id = $2 AND expires_at > NOW()",
      [refreshToken, decoded.id],
    );

    if (dbTokenResult.rows.length === 0) {
      return res.status(403).json({ message: "Invalid Refresh Token" });
    }

    const userResult = await pool.query("SELECT id, username, is_banned FROM users WHERE id = $1", [decoded.id]);
    const user = userResult.rows[0];

    if (!user) return res.status(403).json({ message: "User not found" });

    if (user.is_banned) {
      return res.status(403).json({ message: "თქვენი ანგარიში დაბლოკილია", code: "BANNED" });
    }

    const newAccessToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "15m" });

    res.json({ accessToken: newAccessToken });
  } catch (e) {
    console.error("REFRESH ERROR:", e.message);
    res.status(403).json({ message: "Expired or Invalid Refresh Token" });
  }
};

// გასვლა: refresh token უქმდება და push ტოკენი იშლება, რომ მოწყობილობაზე
// შემდეგ ანგარიშს წინა მომხმარებლის შეტყობინებები არ მიუვიდეს
export const logout = async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (refreshToken && typeof refreshToken === "string") {
      let userId = null;
      try {
        userId = jwt.verify(refreshToken, JWT_REFRESH_SECRET).id;
      } catch (e) {
        userId = jwt.decode(refreshToken)?.id ?? null;
      }
      const del = await pool.query("DELETE FROM user_refresh_tokens WHERE token = $1", [refreshToken]);
      // push ტოკენს ვშლით მხოლოდ მაშინ, როცა ტოკენი რეალურად ჩვენი იყო
      if (userId && del.rowCount > 0) {
        await pool.query("UPDATE user_devices SET push_token = NULL WHERE user_id = $1", [userId]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error("LOGOUT ERROR:", err);
    res.json({ success: true });
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
          registration_ip = COALESCE(user_devices.registration_ip, EXCLUDED.registration_ip),
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
    res.status(500).json({ message: "სერვერის შეცდომა მოწყობილობის სინქრონიზაციისას" });
  }
};

// POST /auth/register/verify  { email, code }
// კოდის დადასტურების შემდეგ იქმნება რეალური ანგარიში (წინა ვერსიის register-ის პასუხის იგივე ფორმატით).
export const verifyRegistration = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";

    if (!emailRegex.test(email) || !isSixDigits(code)) {
      return res.status(400).json({ message: "მიუთითეთ ელფოსტა და 6-ნიშნა კოდი" });
    }

    const check = await checkCode({ email, purpose: "register", code });
    if (!check.ok) return res.status(400).json(codeFailureResponse(check));

    const p = check.payload;
    if (!p?.username || !p?.passwordHash) {
      return res.status(400).json(codeFailureResponse({ reason: "expired" }));
    }

    // კოდის გაგზავნიდან ამ წუთამდე სხვას შეიძლებოდა დაეკავებინა username ან email
    const existing = await pool.query(
      "SELECT username FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)",
      [p.username, email],
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({
        message: "ეს მომხმარებლის სახელი ან Email უკვე გამოყენებულია. გთხოვთ თავიდან სცადოთ.",
        code: "ALREADY_TAKEN",
      });
    }

    let newUser;
    try {
      newUser = await insertUser({
        username: p.username,
        email,
        hash: p.passwordHash,
        latitude: p.latitude,
        longitude: p.longitude,
      });
    } catch (err) {
      if (err.code === "23505") {
        return res.status(400).json({
          message: "ეს მომხმარებელი ან Email უკვე გამოყენებულია",
          code: "ALREADY_TAKEN",
        });
      }
      throw err;
    }

    // ანგარიში შეიქმნა: კოდი იხარჯება (ერთჯერადია)
    await consumeCode(check.id);

    await upsertDevice(newUser.id, p.device || {}, p.clientIp);
    if (p.clientIp) {
      await trackUserIp(newUser.id, p.clientIp);
    }

    res.json({
      success: true,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
      },
    });
  } catch (err) {
    console.error("VERIFY REGISTRATION ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა რეგისტრაციის დადასტურებისას" });
  }
};

// POST /auth/register/resend  { email }
// ახალი კოდი იმავე დროებითი რეგისტრაციის მონაცემებზე (მინიმუმ 60 წამის ინტერვალით)
export const resendRegistrationCode = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "მოყვანილი Email არასწორია" });
    }

    const sent = await sendCode({ email, purpose: "register", keepOnFail: true });
    if (!sent.ok) return res.status(sent.status).json(sent.body);

    res.json({ success: true, codeTtlMinutes: CODE_TTL_MIN, resendAfterSec: RESEND_COOLDOWN_SEC });
  } catch (err) {
    console.error("RESEND REGISTRATION CODE ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა" });
  }
};

// POST /auth/forgot-password  { email }
// პასუხი ყოველთვის ერთნაირია, რომ ვერავინ გაიგოს რომელი ელფოსტებია რეგისტრირებული
export const forgotPassword = async (req, res) => {
  const genericResponse = { success: true, codeTtlMinutes: CODE_TTL_MIN, resendAfterSec: RESEND_COOLDOWN_SEC };

  try {
    const email = normalizeEmail(req.body?.email);
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "მოყვანილი Email არასწორია" });
    }

    const userResult = await pool.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [email]);

    if (userResult.rows.length > 0) {
      // cooldown-ის ან გაგზავნის შეცდომის შედეგს მომხმარებელს არ ვუჩვენებთ (ანგარიშის არსებობა არ გამოვაჩინოთ)
      await sendCode({ email, purpose: "reset_password", payload: null });
    }

    res.json(genericResponse);
  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა" });
  }
};

// POST /auth/reset-password  { email, code, newPassword }
// პაროლის შეცვლა ელფოსტით მიღებული კოდით. წინა ვერსიაში ნებისმიერს შეეძლო ნებისმიერი
// email-ის პაროლის შეცვლა, ახლა კოდის გარეშე შეცვლა შეუძლებელია.
export const resetPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const newPassword = req.body?.newPassword;

    if (!emailRegex.test(email) || !isSixDigits(code)) {
      return res.status(400).json({ message: "მიუთითეთ ელფოსტა და 6-ნიშნა კოდი" });
    }
    if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 72) {
      return res.status(400).json({ message: "პაროლი უნდა იყოს 8-დან 72 სიმბოლომდე" });
    }

    const check = await checkCode({ email, purpose: "reset_password", code });
    if (!check.ok) return res.status(400).json(codeFailureResponse(check));

    // კოდი ერთჯერადია: თუ ორი მოთხოვნა ერთდროულად მოვიდა, მხოლოდ ერთი გაივლის
    if (!(await consumeCode(check.id))) {
      return res.status(400).json(codeFailureResponse({ reason: "expired" }));
    }

    const hash = await bcrypt.hash(newPassword, 10);
    const upd = await pool.query("UPDATE users SET password_hash = $1 WHERE LOWER(email) = LOWER($2) RETURNING id", [
      hash,
      email,
    ]);

    if (upd.rows.length === 0) {
      return res.status(400).json(codeFailureResponse({ reason: "expired" }));
    }

    // პაროლის შეცვლისას ყველა მოწყობილობაზე სესია უქმდება
    await pool.query("DELETE FROM user_refresh_tokens WHERE user_id = $1", [upd.rows[0].id]);

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

    await client.query("BEGIN");

    // 1. დაკავშირებული დამხმარე ცხრილების გაწმენდა
    await client.query("DELETE FROM user_refresh_tokens WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM user_devices WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM user_locations WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM app_sessions WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM reward_claims WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM photos WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM likes WHERE from_user_id = $1 OR to_user_id = $1", [userId]);
    await client.query("DELETE FROM dislikes WHERE from_user_id = $1 OR to_user_id = $1", [userId]);
    await client.query("DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1", [userId]);
    await client.query("DELETE FROM matches WHERE user1_id = $1 OR user2_id = $1", [userId]);
    await client.query("DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1", [userId]);
    await client.query("DELETE FROM reports WHERE reporter_id = $1 OR reported_id = $1", [userId]);
    await client.query("DELETE FROM user_ip_history WHERE user_id = $1", [userId]);
    // თუ ეს ადმინი სხვა მომხმარებლებს ამტკიცებდა, FK-ს ვწყვეტთ
    await client.query("UPDATE users SET reviewed_by = NULL WHERE reviewed_by = $1", [userId]);

    // 2. ამ DELETE-ის გაშვებისას ავტომატურად ამოქმედდება archive_user_full_data ტრიგერი
    await client.query("DELETE FROM users WHERE id = $1", [userId]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "ანგარიში წარმატებით წაიშალა და გადავიდა არქივში.",
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("DELETE ACCOUNT ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა ანგარიშის წაშლისას" });
  } finally {
    client.release();
  }
};
