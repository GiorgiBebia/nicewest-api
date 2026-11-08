import { pool } from "../db/index.js";
import { emitToUser } from "../socket.js";
import { notifyAdmins, notifyUser } from "../services/notification.service.js";
import { createPhotoUploadTarget, isOwnPhotoUrl } from "../services/storage.service.js";

const MAX_PHOTOS = 6;
const MAX_MESSAGE_LENGTH = 2000;
const REPORT_REASON_MAX = 100;
const REPORT_DETAILS_MAX = 1000;

const toId = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const cleanText = (value, max) => {
  if (value === undefined || value === null) return undefined;
  return String(value).trim().slice(0, max);
};

const ageFromBirthDate = (birthDate) => {
  const d = new Date(birthDate);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
};

// შემოსული ველების გასუფთავება და ვალიდაცია. აბრუნებს { fields, photos } ან { error }
const sanitizeProfileInput = (body, userId, knownPhotoUrls = new Set()) => {
  const fields = {};

  const full_name = cleanText(body.full_name, 60);
  if (full_name !== undefined) {
    if (full_name.length < 2) return { error: "სახელი ძალიან მოკლეა" };
    fields.full_name = full_name;
  }

  if (body.birth_date !== undefined && body.birth_date !== null) {
    const age = ageFromBirthDate(body.birth_date);
    if (age === null) return { error: "დაბადების თარიღი არასწორია" };
    if (age < 18) return { error: "აპლიკაცია მხოლოდ 18+ მომხმარებლებისთვისაა" };
    if (age > 100) return { error: "დაბადების თარიღი არასწორია" };
    fields.birth_date = String(body.birth_date).slice(0, 10);
    fields.age = age; // ასაკი სერვერზე გამოითვლება
  } else if (body.age !== undefined && body.age !== null) {
    const age = Number(body.age);
    if (!Number.isInteger(age) || age < 18 || age > 100) {
      return { error: "ასაკი უნდა იყოს 18-დან 100-მდე" };
    }
    fields.age = age;
  }

  const bio = cleanText(body.bio, 500);
  if (bio !== undefined) fields.bio = bio;

  const city = cleanText(body.city, 80);
  if (city !== undefined) fields.city = city;

  if (body.gender !== undefined) {
    const g = String(body.gender).toLowerCase();
    if (!["male", "female"].includes(g)) return { error: "სქესი არასწორია" };
    fields.gender = g;
  }

  if (body.looking_for !== undefined) {
    const g = String(body.looking_for).toLowerCase();
    if (!["male", "female", "both"].includes(g)) {
      return { error: "არჩეული სქესი არასწორია" };
    }
    fields.looking_for = g;
  }

  if (body.search_radius !== undefined && body.search_radius !== null) {
    const r = Number(body.search_radius);
    if (!Number.isInteger(r) || r < 1 || r > 20000) {
      return { error: "რადიუსი არასწორია" };
    }
    fields.search_radius = r;
  }

  let minAge = body.min_age;
  let maxAge = body.max_age;
  if (minAge !== undefined && minAge !== null) {
    minAge = Number(minAge);
    if (!Number.isInteger(minAge) || minAge < 18 || minAge > 100) {
      return { error: "მინიმალური ასაკი არასწორია" };
    }
    fields.min_age = minAge;
  }
  if (maxAge !== undefined && maxAge !== null) {
    maxAge = Number(maxAge);
    if (!Number.isInteger(maxAge) || maxAge < 18 || maxAge > 100) {
      return { error: "მაქსიმალური ასაკი არასწორია" };
    }
    fields.max_age = maxAge;
  }
  if (fields.min_age !== undefined && fields.max_age !== undefined && fields.min_age > fields.max_age) {
    return { error: "მინიმალური ასაკი მაქსიმალურზე დიდია" };
  }

  let photos;
  if (body.photos !== undefined) {
    if (!Array.isArray(body.photos)) return { error: "ფოტოების ფორმატი არასწორია" };
    if (body.photos.length > MAX_PHOTOS) {
      return { error: `მაქსიმუმ ${MAX_PHOTOS} ფოტოა დაშვებული` };
    }
    photos = [];
    for (let i = 0; i < body.photos.length; i++) {
      const p = body.photos[i];
      if (!p || !(isOwnPhotoUrl(p.image_url, userId) || knownPhotoUrls.has(p.image_url))) {
        console.warn("PHOTO URL REJECTED:", { userId, url: String(p?.image_url).slice(0, 300) });
        return { error: "ფოტოს მისამართი არასწორია" };
      }
      photos.push({ image_url: p.image_url, position: i, is_main: i === 0 });
    }
  }

  return { fields, photos };
};

const PHOTO_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// ფოტოს ატვირთვის ბილეთი: აპი ამით ტვირთავს პირდაპირ Supabase Storage-ზე (anon key-ის გარეშე)
export const createPhotoUploadUrl = async (req, res) => {
  try {
    const ext = PHOTO_TYPES[req.body?.contentType];
    if (!ext) {
      return res.status(400).json({ message: "ფოტოს ფორმატი არასწორია (JPEG, PNG ან WebP)" });
    }
    const index = Number(req.body?.index);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PHOTOS) {
      return res.status(400).json({ message: "ფოტოს ნომერი არასწორია" });
    }

    const target = await createPhotoUploadTarget(req.user.id, index, ext);
    res.json({ success: true, ...target });
  } catch (err) {
    console.error("PHOTO UPLOAD URL ERROR:", err);
    res.status(500).json({ message: "ატვირთვის მომზადება ვერ მოხერხდა" });
  }
};

// ლოკაციის განახლება
export const updateLocation = async (req, res) => {
  try {
    const userId = req.user.id;
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({ error: "კოორდინატები არასწორია" });
    }

    await pool.query("UPDATE users SET latitude = $1, longitude = $2 WHERE id = $3", [latitude, longitude, userId]);
    res.json({ success: true });
  } catch (err) {
    console.error("UPDATE LOCATION ERROR:", err);
    res.status(500).json({ error: "Location update failed" });
  }
};

// უკვე შენახული (ძველი ან განხილვის მოლოდინში მყოფი) ფოტოები ისევ დასაშვებია
const loadKnownPhotoUrls = async (userId) => {
  try {
    const r = await pool.query(
      `SELECT image_url AS url FROM photos WHERE user_id = $1
       UNION
       SELECT e->>'image_url' AS url
       FROM users u,
            jsonb_array_elements(
              CASE WHEN jsonb_typeof(u.pending_changes::jsonb->'photos'->'new') = 'array'
                   THEN u.pending_changes::jsonb->'photos'->'new' ELSE '[]'::jsonb END
            ) e
       WHERE u.id = $1`,
      [userId],
    );
    return new Set(r.rows.map((x) => x.url).filter(Boolean));
  } catch (err) {
    console.error("LOAD KNOWN PHOTOS ERROR:", err);
    return new Set();
  }
};

export const updateProfile = async (req, res) => {
  const known = req.body?.photos !== undefined ? await loadKnownPhotoUrls(req.user.id) : new Set();
  const parsed = sanitizeProfileInput(req.body || {}, req.user.id, known);
  if (parsed.error) {
    return res.status(400).json({ success: false, message: parsed.error });
  }
  const { fields, photos } = parsed;

  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const isAdmin = req.user.is_admin;
    const authUsername = req.user.username;

    await client.query("BEGIN");

    if (isAdmin) {
      const keys = Object.keys(fields);
      if (keys.length > 0) {
        const sets = keys.map((k, i) => `${k} = $${i + 1}`);
        await client.query(
          `UPDATE users SET ${sets.join(", ")},
             status = 'approved',
             pending_changes = NULL,
             rejection_reasons = '{}'::jsonb
           WHERE id = $${keys.length + 1}`,
          [...keys.map((k) => fields[k]), userId],
        );
      }

      if (photos) {
        await client.query("DELETE FROM photos WHERE user_id = $1", [userId]);
        for (const p of photos) {
          await client.query("INSERT INTO photos (user_id, image_url, position, is_main) VALUES ($1, $2, $3, $4)", [
            userId,
            p.image_url,
            p.position,
            p.is_main,
          ]);
        }
      }

      const me = await client.query("SELECT * FROM users WHERE id = $1", [userId]);
      await client.query("COMMIT");
      const { password_hash, ...safe } = me.rows[0];
      return res.status(200).json({ success: true, data: safe });
    }

    const currentUserRes = await client.query(
      "SELECT full_name, age, birth_date, bio, city, gender, looking_for, search_radius, min_age, max_age FROM users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    const currentUser = currentUserRes.rows[0] || {};

    const currentPhotosRes = await client.query(
      "SELECT image_url, position, is_main FROM photos WHERE user_id = $1 ORDER BY position ASC",
      [userId],
    );
    const currentPhotos = currentPhotosRes.rows.map((p, i) => ({
      image_url: p.image_url,
      position: i,
      is_main: i === 0,
    }));

    const changes = {};
    for (const key of Object.keys(fields)) {
      let oldVal = currentUser[key];
      if (key === "birth_date" && oldVal instanceof Date) {
        oldVal = oldVal.toISOString().slice(0, 10);
      }
      if (String(fields[key]) !== String(oldVal ?? "")) {
        changes[key] = { old: currentUser[key] ?? null, new: fields[key] };
      }
    }

    if (photos) {
      if (JSON.stringify(photos) !== JSON.stringify(currentPhotos)) {
        changes.photos = { old: currentPhotos, new: photos };
      }
    }

    const pendingJson = Object.keys(changes).length > 0 ? JSON.stringify(changes) : null;

    const userResult = await client.query(
      `UPDATE users
       SET status = 'pending',
           pending_changes = $1,
           rejection_reasons = '{}'::jsonb
       WHERE id = $2
       RETURNING id, username, email, full_name, bio, gender, looking_for, city, age, birth_date, search_radius, min_age, max_age, status, is_admin`,
      [pendingJson, userId],
    );
    await client.query("COMMIT");

    notifyAdmins(
      "ახალი განაცხადი 📝",
      `მომხმარებელმა (${fields.full_name || authUsername}) განაახლა პროფილი და ელოდება დადასტურებას.`,
      { type: "PENDING_USER", userId },
    );

    return res.status(200).json({ success: true, data: userResult.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Update Profile Error:", error);
    res.status(500).json({ success: false, message: "პროფილის განახლება ვერ მოხერხდა" });
  } finally {
    client.release();
  }
};

export const getMe = async (req, res) => {
  try {
    const userId = req.user.id;

    const userResult = await pool.query(
      "SELECT id, username, email, full_name, bio, gender, looking_for, city, age, birth_date, search_radius, min_age, max_age, interests, latitude, longitude, is_admin, status, rejection_reasons FROM users WHERE id=$1",
      [userId],
    );

    const photosResult = await pool.query(
      "SELECT image_url, position, is_main FROM photos WHERE user_id=$1 ORDER BY position ASC",
      [userId],
    );

    const user = userResult.rows[0];
    const photos = photosResult.rows;

    if (!user) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    const validation = {
      hasFullName: !!user.full_name,
      hasAge: !!(user.age || user.birth_date),
      hasCity: !!user.city,
      hasGender: !!user.gender,
      hasBio: !!(user.bio && user.bio.trim().length >= 5),
      hasPhotos: photos.length > 0,
    };

    const isComplete = Object.values(validation).every((val) => val === true);

    res.json({
      ...user,
      photos,
      is_complete: isComplete,
      profile_status: validation,
    });
  } catch (err) {
    console.error("GET_ME ERROR:", err);
    res.status(500).json({ error: "შეცდომა მონაცების წამოღებისას" });
  }
};

// გამორიცხავს ორმხრივად დაბლოკილ, დისლაიქებულ და დაბანილ იუზერებს + პაგინაცია
export const getDiscovery = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const meResult = await pool.query(
      "SELECT latitude, longitude, search_radius, min_age, max_age, looking_for FROM users WHERE id = $1",
      [userId],
    );
    const me = meResult.rows[0];

    if (!me || me.latitude === null || me.longitude === null) return res.json([]);

    const radius = Number(me.search_radius) || 50;
    const minAge = me.min_age ?? 18;
    const maxAge = me.max_age ?? 100;
    const lookingFor = me.looking_for || "female";

    const discoveryResult = await pool.query(
      `WITH filtered_users AS (
          SELECT u.id, u.full_name, u.age, u.city, u.bio, u.interests,
            (6371 * acos(
                LEAST(1, GREATEST(-1,
                  cos(radians($2::float8)) * cos(radians(u.latitude::float8)) * cos(radians(u.longitude::float8) - radians($3::float8))
                  + sin(radians($2::float8)) * sin(radians(u.latitude::float8))
                ))
            )) AS distance
          FROM users u
          WHERE u.id != $1
          AND u.age BETWEEN $5 AND $6
          AND ($7 = 'both' OR u.gender = $7)
          AND u.status = 'approved'
          AND COALESCE(u.is_banned, false) = false
          AND u.latitude IS NOT NULL
          AND u.longitude IS NOT NULL
          AND u.latitude::float8 BETWEEN $2::float8 - ($4::float8 / 111.0) AND $2::float8 + ($4::float8 / 111.0)
          AND NOT EXISTS (SELECT 1 FROM likes l WHERE l.from_user_id = $1 AND l.to_user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM dislikes d WHERE d.from_user_id = $1 AND d.to_user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))
      )
      SELECT f.id, f.full_name, f.age, f.city, f.bio, f.interests,
             GREATEST(1, CEIL(f.distance))::int AS distance,
             COALESCE(
               JSON_AGG(JSON_BUILD_OBJECT('image_url', p.image_url, 'position', p.position, 'is_main', p.is_main) ORDER BY p.position ASC)
               FILTER (WHERE p.id IS NOT NULL), '[]'
             ) AS photos
      FROM filtered_users f
      LEFT JOIN photos p ON f.id = p.user_id
      WHERE f.distance <= $4
      GROUP BY f.id, f.full_name, f.age, f.city, f.bio, f.interests, f.distance
      ORDER BY f.distance ASC, f.id ASC
      LIMIT $8 OFFSET $9`,
      [userId, me.latitude, me.longitude, radius, minAge, maxAge, lookingFor, limit, offset],
    );
    res.json(discoveryResult.rows);
  } catch (err) {
    console.error("Discovery error:", err);
    res.status(500).json({ error: "მონაცემების წამოღება ვერ მოხერხდა" });
  }
};

export const getMatches = async (req, res) => {
  try {
    const userId = req.user.id;
    const matchesResult = await pool.query(
      `SELECT u.id, u.full_name, p.image_url AS main_photo,
              msg.text AS last_message_text, msg.created_at AS last_message_at,
              COALESCE(unread.count, 0)::int AS unread_count
       FROM matches m
       JOIN users u ON u.id = CASE WHEN m.user1_id = $1 THEN m.user2_id ELSE m.user1_id END
       LEFT JOIN LATERAL (
         SELECT image_url FROM photos WHERE user_id = u.id
         ORDER BY is_main DESC, position ASC LIMIT 1
       ) p ON true
       LEFT JOIN LATERAL (
         SELECT text, created_at FROM messages
         WHERE (sender_id = $1 AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = $1)
         ORDER BY created_at DESC LIMIT 1
       ) msg ON true
       LEFT JOIN (
         SELECT sender_id, COUNT(*) AS count FROM messages
         WHERE receiver_id = $1 AND is_read = FALSE GROUP BY sender_id
       ) unread ON unread.sender_id = u.id
       WHERE (m.user1_id = $1 OR m.user2_id = $1)
         AND COALESCE(u.is_banned, false) = false
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))
       ORDER BY last_message_at DESC NULLS LAST, m.matched_at DESC`,
      [userId],
    );
    res.json(matchesResult.rows);
  } catch (err) {
    console.error("GET MATCHES ERROR:", err);
    res.status(500).json({ error: "მონაცემების წამოღება ვერ მოხერხდა" });
  }
};

export const getChatMessages = async (req, res) => {
  try {
    const partnerId = toId(req.params.partnerId);
    if (!partnerId) return res.status(400).json({ error: "არასწორი მომხმარებელი" });

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 500);
    const messages = await pool.query(
      `SELECT * FROM (
         SELECT * FROM messages
         WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
         ORDER BY created_at DESC, id DESC LIMIT $3
       ) t ORDER BY created_at ASC, id ASC`,
      [req.user.id, partnerId, limit],
    );
    res.json(messages.rows);
  } catch (err) {
    console.error("GET CHAT MESSAGES ERROR:", err);
    res.status(500).json({ error: "error" });
  }
};

export const sendMessage = async (req, res) => {
  try {
    const senderId = req.user.id;
    const receiverId = toId(req.body?.receiverId);
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";

    if (!receiverId || receiverId === senderId) {
      return res.status(400).json({ error: "არასწორი მიმღები" });
    }
    if (!content) {
      return res.status(400).json({ error: "შეტყობინება ცარიელია" });
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: "შეტყობინება ძალიან გრძელია" });
    }

    // ერთი მოთხოვნით: match არსებობს, ორივე მხარე აქტიურია და ბლოკი არ არის
    const matchResult = await pool.query(
      `SELECT m.id FROM matches m
       JOIN users r ON r.id = $2 AND COALESCE(r.is_banned,false) = false
       WHERE ((m.user1_id = $1 AND m.user2_id = $2) OR (m.user1_id = $2 AND m.user2_id = $1))
         AND NOT EXISTS (
           SELECT 1 FROM blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1)
         )
       LIMIT 1`,
      [senderId, receiverId],
    );

    if (matchResult.rows.length === 0) {
      return res.status(403).json({
        error: "ამ მომხმარებელთან შეტყობინების გაგზავნა შეუძლებელია.",
      });
    }

    const newMessage = await pool.query(
      "INSERT INTO messages (match_id, sender_id, receiver_id, text) VALUES ($1, $2, $3, $4) RETURNING *",
      [matchResult.rows[0].id, senderId, receiverId, content],
    );
    const message = newMessage.rows[0];

    emitToUser(receiverId, "new_message", message);
    emitToUser(senderId, "new_message", message);

    const senderRes = await pool.query("SELECT full_name, username FROM users WHERE id = $1", [senderId]);
    const senderName = senderRes.rows[0]?.full_name || senderRes.rows[0]?.username || "მომხმარებელმა";

    const formattedContent = content.length > 50 ? `${content.substring(0, 50)}...` : content;

    notifyUser(receiverId, `ახალი შეტყობინება: ${senderName}`, formattedContent, {
      type: "chat_message",
      senderId,
    });

    res.json(message);
  } catch (err) {
    console.error("SEND MESSAGE ERROR:", err);
    res.status(500).json({ error: "შეტყობინების გაგზავნა ვერ მოხერხდა" });
  }
};

export const markAsRead = async (req, res) => {
  try {
    const partnerId = toId(req.params.partnerId);
    if (!partnerId) return res.status(400).json({ error: "არასწორი მომხმარებელი" });

    await pool.query(
      "UPDATE messages SET is_read = TRUE WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE",
      [partnerId, req.user.id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error("MARK AS READ ERROR:", err);
    res.status(500).json({ error: "error" });
  }
};

export const getUserProfile = async (req, res) => {
  try {
    const targetId = toId(req.query.userId);
    const myId = req.user.id;

    if (!targetId) {
      return res.status(400).json({ error: "userId პარამეტრი აუცილებელია" });
    }

    // ნებისმიერი პროფილი ხელმისაწვდომია მხოლოდ: საკუთარი, ადმინისტრატორისთვის,
    // match-ისთვის, ან მისთვის ვინც მე დამილაიქა/ვინც მე დავლაიქე
    if (targetId !== myId && !req.user.is_admin) {
      const access = await pool.query(
        `SELECT u.id FROM users u
         WHERE u.id = $2
           AND u.status = 'approved'
           AND COALESCE(u.is_banned,false) = false
           AND NOT EXISTS (
             SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1)
           )
           AND (
             EXISTS (SELECT 1 FROM matches m WHERE (m.user1_id = $1 AND m.user2_id = u.id) OR (m.user1_id = u.id AND m.user2_id = $1))
             OR EXISTS (SELECT 1 FROM likes l WHERE (l.from_user_id = $1 AND l.to_user_id = u.id) OR (l.from_user_id = u.id AND l.to_user_id = $1))
           )`,
        [myId, targetId],
      );
      if (access.rows.length === 0) {
        return res.status(403).json({ error: "პროფილი მიუწვდომელია" });
      }
    }

    const userResult = await pool.query(
      "SELECT id, username, full_name, bio, gender, city, age, interests FROM users WHERE id=$1",
      [targetId],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    const photosResult = await pool.query(
      "SELECT image_url, position, is_main FROM photos WHERE user_id=$1 ORDER BY position ASC",
      [targetId],
    );

    res.json({
      success: true,
      user: userResult.rows[0],
      photos: photosResult.rows,
    });
  } catch (err) {
    console.error("GET_USER_PROFILE ERROR:", err);
    res.status(500).json({ error: "შეცდომა მომხმარებლის პროფილის წამოღებისას" });
  }
};

export const reportUser = async (req, res) => {
  try {
    const reporterId = req.user.id;
    const reportedId = toId(req.body?.reportedUserId);
    const reason = cleanText(req.body?.reason, REPORT_REASON_MAX);
    const details = cleanText(req.body?.details, REPORT_DETAILS_MAX) || "";

    if (!reportedId || !reason) {
      return res.status(400).json({ error: "reportedUserId და reason აუცილებელია" });
    }
    if (reportedId === reporterId) {
      return res.status(400).json({ error: "საკუთარ თავზე რეპორტს ვერ გააგზავნით" });
    }

    const exists = await pool.query("SELECT 1 FROM users WHERE id = $1", [reportedId]);
    if (exists.rows.length === 0) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    // იგივე წყვილზე 24 საათში ერთზე მეტი აქტიური რეპორტი არ იქმნება
    const dup = await pool.query(
      `SELECT 1 FROM reports
       WHERE reporter_id = $1 AND reported_id = $2
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [reporterId, reportedId],
    );
    if (dup.rows.length === 0) {
      await pool.query("INSERT INTO reports (reporter_id, reported_id, reason, details) VALUES ($1, $2, $3, $4)", [
        reporterId,
        reportedId,
        reason,
        details,
      ]);
    }

    res.json({ success: true, message: "რეპორტი წარმატებით გაიგზავნა" });
  } catch (err) {
    console.error("REPORT USER ERROR:", err);
    res.status(500).json({ error: "რეპორტის გაგზავნა ვერ მოხერხდა" });
  }
};

export const blockUser = async (req, res) => {
  try {
    const blockerId = req.user.id;
    const blockedId = toId(req.body?.blockedUserId);

    if (!blockedId) {
      return res.status(400).json({ error: "blockedUserId აუცილებელია" });
    }
    if (blockerId === blockedId) {
      return res.status(400).json({ error: "საკუთარ თავს ვერ დაბლოკავთ" });
    }

    const exists = await pool.query("SELECT 1 FROM users WHERE id = $1", [blockedId]);
    if (exists.rows.length === 0) {
      return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
    }

    await pool.query(
      "INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT (blocker_id, blocked_id) DO NOTHING",
      [blockerId, blockedId],
    );

    await pool.query(
      `DELETE FROM matches
       WHERE (user1_id = $1 AND user2_id = $2)
          OR (user1_id = $2 AND user2_id = $1)`,
      [blockerId, blockedId],
    );

    res.json({ success: true, message: "მომხმარებელი დაბლოკილია" });
  } catch (err) {
    console.error("BLOCK USER ERROR:", err);
    res.status(500).json({ error: "მომხმარებლის დაბლოკვა ვერ მოხერხდა" });
  }
};
