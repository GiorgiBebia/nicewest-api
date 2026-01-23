import { pool } from "../db.js";

export const likeUser = async (req, res) => {
  const from = req.user.id;
  const { to } = req.body;

  await pool.query("INSERT INTO likes (from_user_id,to_user_id) VALUES ($1,$2)", [from, to]);

  const match = await pool.query(
    `SELECT * FROM likes
     WHERE from_user_id=$1 AND to_user_id=$2`,
    [to, from]
  );

  if (match.rows.length) {
    await pool.query("INSERT INTO matches (user1_id,user2_id) VALUES ($1,$2)", [from, to]);
    return res.json({ match: true });
  }

  res.json({ match: false });
};
