import { describe, it, expect, beforeAll } from "vitest";

let signToken;
let authMiddleware;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret";
  const mod = await import("../src/auth.js");
  signToken = mod.signToken;
  authMiddleware = mod.authMiddleware;
});

describe("authMiddleware", () => {
  it("rejects missing token", async () => {
    process.env.AUTH_MODE = "jwt";
    const req = { headers: {} };
    const res = createRes();
    let nextCalled = false;

    await authMiddleware(req, res, () => {
      nextCalled = true;
    });

    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it("accepts valid token", async () => {
    process.env.AUTH_MODE = "jwt";
    const token = signToken({ userId: 1, email: "test@example.com" });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = createRes();
    let nextCalled = false;

    await authMiddleware(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("accepts missing token in passthrough mode", async () => {
    process.env.AUTH_MODE = "passthrough";
    const req = { headers: {} };
    const res = createRes();
    let nextCalled = false;

    await authMiddleware(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(req.user).toEqual({ token: "passthrough" });
  });
});

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}
