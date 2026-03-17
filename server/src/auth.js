import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

export async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function authMiddleware(req, res, next) {
  const mode = (process.env.AUTH_MODE || "jwt").toLowerCase();
  if (mode === "disabled") {
    return next();
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (mode === "passthrough") {
    req.user = { token: token || "passthrough" };
    return next();
  }
  if (!token) {
    return res.status(401).json({ error: "missing_token" });
  }
  if (mode === "token") {
    const shared = process.env.AUTH_SHARED_TOKEN || "";
    if (shared && token === shared) {
      req.user = { token };
      return next();
    }
    return res.status(401).json({ error: "invalid_token" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ error: "invalid_token" });
  }
}
