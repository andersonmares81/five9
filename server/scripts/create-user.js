import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { hashPassword } from "../src/auth.js";
import { query } from "../src/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const email = process.env.ADMIN_EMAIL;
const name = process.env.ADMIN_NAME || "Admin";
const password = process.env.ADMIN_PASSWORD;

if (!email || !password) {
  console.error("Missing ADMIN_EMAIL or ADMIN_PASSWORD");
  process.exit(1);
}

const passwordHash = await hashPassword(password);
await query(
  "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING",
  [email, name, passwordHash]
);

console.log("user_created", email);
process.exit(0);
