import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { syncWfoInteractionRecordings } from "../src/wfo/sync.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const startPage = Number(process.argv[2] || 1);
const maxPages = Number(process.env.WFO_MAX_PAGES || 50);
const pageSize = Number(process.env.WFO_PAGE_SIZE || 100);
const useNextPage = process.env.WFO_USE_NEXT_PAGE === "true";

async function run() {
  let total = 0;
  let nextPageUrl = null;
  for (let page = startPage; page <= maxPages; page += 1) {
    const result = await syncWfoInteractionRecordings({
      pageNumber: page,
      nextPageUrl: useNextPage ? nextPageUrl : null
    });
    total += result.inserted;
    console.log(
      `page=${result.pageNumber || page} inserted=${result.inserted} skipped=${result.skipped} count=${result.count}`
    );
    nextPageUrl = useNextPage ? result.nextPage : null;
    if ((useNextPage && !nextPageUrl) || result.count < pageSize) {
      break;
    }
  }
  console.log(`total_inserted=${total}`);
}

run().catch((error) => {
  console.error("wfo_sync_failed", error.message);
  process.exit(1);
});
