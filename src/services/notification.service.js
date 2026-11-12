import { pool } from "../db/index.js";
import { normalizeLang, renderPush } from "../i18n/pushMessages.js";

// ოპციონალური: სრული ლოგოს public URL (მაგ. Supabase-ის public bucket-ში ატვირთული NiceWest_Logo.png).
// თუ მითითებულია, Expo-ს richContent.image-ად გადაეცემა (გაშლილ შეტყობინებაში ჩანს).
const PUSH_IMAGE_URL = process.env.PUSH_IMAGE_URL || "";

// Expo Push API-ზე შეტყობინების გაგზავნა
export const sendExpoNotifications = async (tokens, title, body, data = {}) => {
  if (!tokens || tokens.length === 0) return;

  const messages = tokens.map((token) => {
    const m = {
      to: token,
      sound: "default",
      title,
      body,
      data,
      channelId: "default",
      priority: "high",
    };
    if (PUSH_IMAGE_URL) m.richContent = { image: PUSH_IMAGE_URL };
    return m;
  });

  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });
  } catch (error) {
    console.error("Error sending push notification via Expo:", error);
  }
};

// ყველა ადმინისტრატორისთვის Push ნოთიფიკაციის გაგზავნა
export const notifyAdmins = async (title, body, data = {}) => {
  try {
    const query = `
      SELECT ud.push_token 
      FROM user_devices ud
      JOIN users u ON u.id = ud.user_id
      WHERE u.is_admin = true 
        AND ud.push_token IS NOT NULL 
        AND ud.push_token != ''
    `;
    const result = await pool.query(query);
    const tokens = result.rows.map((row) => row.push_token);

    if (tokens.length > 0) {
      await sendExpoNotifications(tokens, title, body, data);
    }
  } catch (error) {
    console.error("Error notifying admins:", error);
  }
};

// კონკრეტული მომხმარებლისთვის Push ნოთიფიკაციის გაგზავნა (ტექსტი უკვე მზადაა)
export const notifyUser = async (userId, title, body, data = {}) => {
  try {
    const query = `
      SELECT push_token 
      FROM user_devices 
      WHERE user_id = $1 
        AND push_token IS NOT NULL 
        AND push_token != ''
    `;
    const result = await pool.query(query, [userId]);
    const tokens = result.rows.map((row) => row.push_token);

    if (tokens.length > 0) {
      await sendExpoNotifications(tokens, title, body, data);
    }
  } catch (error) {
    console.error("Error notifying user:", error);
  }
};

// ლოკალიზებული Push: ტექსტი აიღება pushMessages.js-იდან მომხმარებლის ენის (users.language) მიხედვით.
// key მაგ.: "match", "chat_message", "likes_reset", "match_reminder"...
export const notifyUserT = async (userId, key, params = {}, data = {}) => {
  try {
    const result = await pool.query(
      `SELECT ud.push_token, u.language
       FROM user_devices ud
       JOIN users u ON u.id = ud.user_id
       WHERE ud.user_id = $1
         AND ud.push_token IS NOT NULL
         AND ud.push_token != ''`,
      [userId],
    );
    if (result.rows.length === 0) return;

    const lang = normalizeLang(result.rows[0].language);
    const msg = renderPush(key, lang, params);
    if (!msg) return;

    await sendExpoNotifications(
      result.rows.map((r) => r.push_token),
      msg.title,
      msg.body,
      data,
    );
  } catch (error) {
    console.error("Error notifying user (localized):", error);
  }
};
