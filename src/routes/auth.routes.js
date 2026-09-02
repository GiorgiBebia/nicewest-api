import { Router } from "express";
import { register, login, refresh, syncDevice, resetPassword, deleteAccount } from "../controllers/auth.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/refresh", refresh);

router.post("/sync-device", authMiddleware, syncDevice);
router.post("/reset-password", resetPassword);
router.delete("/delete-account", authMiddleware, deleteAccount);

export default router;
