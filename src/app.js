import express from "express";
import cors from "cors";

import authRoutes from "./routes/auth.routes.js";
import likeRoutes from "./routes/like.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import "./db/index.js";

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

// როუტების გაწერა
app.use("/auth", authRoutes);
app.use("/likes", likeRoutes);
app.use("/profile", profileRoutes);

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Server is running" });
});

// ეს ხაზი აუცილებელია, რომ server.js-მა დაინახოს 'app'
export default app;
