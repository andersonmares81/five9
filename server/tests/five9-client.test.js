import { afterEach, describe, expect, it } from "vitest";
import nock from "nock";
import { createFive9Client } from "../src/five9/client.js";

const base = "http://five9.test";
const api = "http://five9-api.test";

function setupEnv() {
  process.env.FIVE9_BASE_URL = `${base}/appsvcs/rs/svc`;
  process.env.FIVE9_USERNAME = "user";
  process.env.FIVE9_PASSWORD = "pass";
}

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("Five9 client", () => {
  it("logs in, fetches metadata, and calls API", async () => {
    setupEnv();
    nock.disableNetConnect();

    nock(base)
      .post("/appsvcs/rs/svc/auth/login")
      .reply(200, { apiUrl: `${api}/appsvcs/rs/svc` });

    nock(base)
      .get("/appsvcs/rs/svc/auth/metadata")
      .reply(200, { apiUrl: `${api}/appsvcs/rs/svc` });

    nock(api)
      .get("/appsvcs/rs/svc/agents/123/interactions/calls")
      .reply(200, { calls: [] });

    const client = createFive9Client();
    const data = await client.request("/agents/123/interactions/calls");

    expect(data.calls).toEqual([]);
    expect(nock.isDone()).toBe(true);
  });

  it("retries on 401", async () => {
    setupEnv();
    nock.disableNetConnect();

    nock(base)
      .post("/appsvcs/rs/svc/auth/login")
      .twice()
      .reply(200, { apiUrl: `${api}/appsvcs/rs/svc` });

    nock(base)
      .get("/appsvcs/rs/svc/auth/metadata")
      .twice()
      .reply(200, { apiUrl: `${api}/appsvcs/rs/svc` });

    nock(api)
      .get("/appsvcs/rs/svc/agents/99/interactions/calls")
      .reply(401)
      .get("/appsvcs/rs/svc/agents/99/interactions/calls")
      .reply(200, { calls: [{ callId: "1" }] });

    const client = createFive9Client();
    const data = await client.request("/agents/99/interactions/calls");

    expect(data.calls).toHaveLength(1);
    expect(nock.isDone()).toBe(true);
  });
});
