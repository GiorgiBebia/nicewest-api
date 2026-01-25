import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import profileRoutes from "./routes/profile.routes.js";
import authRoutes from "./routes/auth.routes.js"; // დარწმუნდი რომ გაქვს ეს ფაილი

dotenv.config();

const app = express();
const server = http.createServer(app);

// Socket.io კონფიგურაცია
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// ვამაგრებთ როუტებს პირდაპირ /profile-ზე
app.use("/api/profile", profileRoutes);
app.use("/api/auth", authRoutes); // <--- ეს აუცილებელია ლოგინისთვის!

// Socket.io ლოგიკა
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join", (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined room`);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// ექსპორტი კონტროლერისთვის
export { io };

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
