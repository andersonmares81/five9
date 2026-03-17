import express from "express";
import { query } from "../db.js";
import { signToken, verifyPassword } from "../auth.js";

const router = express.Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "missing_credentials" });
  }

  const result = await query("SELECT id, email, name, password_hash FROM users WHERE email = $1", [
    email
  ]);
  const user = result.rows[0];
  if (!user) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  const token = signToken({ userId: user.id, email: user.email });
  return res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

router.post("/logout", (_req, res) => {
  return res.json({ ok: true });
});

export default router;
