import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import profileRoutes from "./routes/profile.routes.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());

// აქ ვამბობთ, რომ ყველა პროფილის როუტი დაიწყოს /api/profile-ით
app.use("/api/profile", profileRoutes);

// Socket.io ლოგიკა
io.on("connection", (socket) => {
  socket.on("join", (userId) => socket.join(userId));
});

export { io };

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
