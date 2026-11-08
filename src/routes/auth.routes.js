import { Router } from "express";
import {
  register,
  login,
  socialLogin,
  refresh,
  logout,
  syncDevice,
  resetPassword,
  deleteAccount,
  logAppOpen,
} from "../controllers/auth.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { loginIpLimiter, loginUserLimiter, registerLimiter } from "../middleware/rateLimit.middleware.js";

const router = Router();

router.post("/register", registerLimiter, register);
router.post("/login", loginIpLimiter, loginUserLimiter, login);
router.post("/social-login", registerLimiter, socialLogin);
router.post("/refresh", refresh);
router.post("/logout", logout);

router.post("/log-open", authMiddleware, logAppOpen);
router.post("/sync-device", authMiddleware, syncDevice);
router.post("/reset-password", registerLimiter, resetPassword);
router.delete("/delete-account", authMiddleware, deleteAccount);

export default router;
