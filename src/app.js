import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes from "./routes/auth.routes.js";
import likeRoutes from "./routes/like.routes.js";
import "./db/index.js";
import profileRoutes from "./routes/profile.routes.js";

dotenv.config(); // აუცილებელია აქ

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/likes", likeRoutes);
app.use("/profile", profileRoutes);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
});
