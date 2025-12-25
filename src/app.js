import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use("/auth", authRoutes);

export default app;
