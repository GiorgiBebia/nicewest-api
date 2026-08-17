import { pool } from "../db/index.js";

// Expo Push API-ზე შეტყობინების გაგზავნა
export const sendExpoNotifications = async (tokens, title, body, data = {}) => {
  if (!tokens || tokens.length === 0) return;

  const messages = tokens.map((token) => ({
    to: token,
    sound: "default",
    title,
    body,
    data,
  }));

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

// კონკრეტული მომხმარებლისთვის Push ნოთიფიკაციის გაგზავნა
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
