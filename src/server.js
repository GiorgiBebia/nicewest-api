import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

import { pool } from "./db/index.js";
import { setIo } from "./socket.js";
import profileRoutes from "./routes/profile.routes.js";
import authRoutes from "./routes/auth.routes.js";
import likeRoutes from "./routes/like.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import { initLikeResetCron } from "./services/likeReset.cron.js";
import { initMatchCron } from "./services/matchExpiry.cron.js";
import { initRetentionCron } from "./services/retention.cron.js";
import { globalLimiter } from "./middleware/rateLimit.middleware.js";

if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
  console.error("JWT_SECRET და JWT_REFRESH_SECRET აუცილებელია!");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// Render/Cloudflare Tunnel-ის უკან ვართ: ერთი პროქსი
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.get("/ping", (req, res) => res.status(200).send("pong"));

app.use(helmet());
// მობილური აპი CORS-ს არ საჭიროებს; თუ ვებ-ადმინი გაჩნდება, ALLOWED_ORIGINS-ში ჩაწერე
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : false,
  }),
);
app.use(express.json({ limit: "100kb" }));
app.use(globalLimiter);

app.use("/profile", profileRoutes);
app.use("/auth", authRoutes);
app.use("/likes", likeRoutes);
app.use("/admin", adminRoutes);

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  console.error("UNHANDLED ERROR:", err);
  res.status(500).json({ error: "Server error" });
});

// ---------------- Socket.io ----------------
const io = new Server(server, {
  cors: { origin: allowedOrigins.length ? allowedOrigins : false },
  transports: ["polling", "websocket"],
  maxHttpBufferSize: 1e5,
});

// ავტორიზაცია: კლიენტმა უნდა გამოგზავნოს access token (socket.handshake.auth.token)
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("UNAUTHORIZED"));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const r = await pool.query(
      "SELECT id, COALESCE(is_admin,false) AS is_admin FROM users WHERE id = $1 AND COALESCE(is_banned,false) = false",
      [decoded.id],
    );
    if (r.rows.length === 0) return next(new Error("UNAUTHORIZED"));

    socket.userId = Number(r.rows[0].id);
    socket.isAdmin = r.rows[0].is_admin === true;
    next();
  } catch (e) {
    next(new Error("UNAUTHORIZED"));
  }
});

io.on("connection", (socket) => {
  // მომხმარებელი მხოლოდ საკუთარ ოთახში შედის (კლიენტის "join" აღარ გვჭირდება)
  socket.join(String(socket.userId));
  // ადმინები ერთიან ოთახში, რომ განხილვის "დაკავების" ცვლილებები ერთმანეთს ეცნობოთ
  if (socket.isAdmin) socket.join("admins");
  socket.on("disconnect", () => {});
});

setIo(io);

initLikeResetCron();
initMatchCron();
initRetentionCron();

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

export { io };
