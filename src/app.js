import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import "./db/index.js";

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use("/auth", authRoutes);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

export default app;
