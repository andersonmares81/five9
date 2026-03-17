import { describe, expect, it } from "vitest";
import { parseCurlSession } from "../src/wfo/session.js";

describe("parseCurlSession", () => {
  it("selects the InteractionRecordings request from a multi-curl dump", () => {
    const rawText = `∫curl 'https://cloud1656.wfo.five9.com/five9wfo/wfonavigation/asset-manifest.json' \\
  -H 'accept: */*' ;
curl 'https://cloud1656.wfo.five9.com/VOCoreWebAPI/api/InteractionRecordings/GetAll/ONLINE_DB?pageNumber=5' \\
  -H 'authorization: Bearer abc.def.ghi' \\
  -H 'content-type: application/json' \\
  -b 'a=1; b=2' \\
  --data-raw '"$filter=( START_TIME ge 2026-03-01T05:00:00.000Z and START_TIME le 2026-03-04T04:45:00.000Z )&$orderby=START_TIME asc"'`;

    const session = parseCurlSession(rawText);

    expect(session.selectedUrl).toContain("/VOCoreWebAPI/api/InteractionRecordings/GetAll/ONLINE_DB");
    expect(session.pageNumber).toBe(5);
    expect(session.token).toBe("abc.def.ghi");
    expect(session.headers.cookie).toContain("a=1");
    expect(session.payload).toContain("$filter=");
  });

  it("prefers the request that already includes a filter", () => {
    const rawText = `curl 'https://cloud1656.wfo.five9.com/VOCoreWebAPI/api/InteractionRecordings/GetAll/ONLINE_DB?pageNumber=1' \\
  -H 'authorization: Bearer first.token' \\
  --data-raw '"$orderby=START_TIME desc"' ;
curl 'https://cloud1656.wfo.five9.com/VOCoreWebAPI/api/InteractionRecordings/GetAll/ONLINE_DB?pageNumber=9' \\
  -H 'authorization: Bearer second.token' \\
  -b 'x=1' \\
  --data-raw '"$filter=( START_TIME ge 2026-03-01T05:00:00.000Z )&$orderby=START_TIME asc"'`;

    const session = parseCurlSession(rawText);

    expect(session.pageNumber).toBe(9);
    expect(session.token).toBe("second.token");
    expect(session.payload).toContain("$filter=");
  });
});
