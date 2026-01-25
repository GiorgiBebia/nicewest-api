import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import profileRoutes from "./routes/profile.routes.js"; // შეამოწმე გზა

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // React Native-ისთვის
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

app.use("/api/profile", profileRoutes);

// Socket.io ლოგიკა
io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // მომხმარებლის ოთახში შესვლა (მისი ID-ს მიხედვით)
  socket.on("join", (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined their room`);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// ექსპორტი, რომ კონტროლერმა შეძლოს მესიჯების გაგზავნა
export { io };

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
