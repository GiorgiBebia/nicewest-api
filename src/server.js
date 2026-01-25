import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import profileRoutes from "./routes/profile.routes.js";
import authRoutes from "./routes/auth.routes.js";
import likeRoutes from "./routes/like.routes.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  // Render-ისთვის აუცილებელი პარამეტრები
  transports: ["polling", "websocket"],
});

app.use(cors());
app.use(express.json());

app.use("/profile", profileRoutes);
app.use("/auth", authRoutes);
app.use("/likes", likeRoutes);

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("join", (userId) => {
    if (userId) {
      socket.join(userId.toString());
      console.log(`User ${userId} joined room`);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

export { io }; // ეს უნდა იყოს ბოლოში, რომ io ინიციალიზებული დახვდეს

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
