import { Router } from "express";
import { register, login, refresh, syncDevice } from "../controllers/auth.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js"; // სწორი იმპორტი შენი ფაილიდან

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/refresh", refresh);

// იყენებს შენს authMiddleware-ს
router.post("/sync-device", authMiddleware, syncDevice);

export default router;
