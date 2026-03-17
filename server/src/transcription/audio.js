import axios from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function resolveBinary(envKey, fallbackPath, fallbackName) {
  const fromEnv = process.env[envKey];
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  if (fallbackPath && fs.existsSync(fallbackPath)) return fallbackPath;
  return fallbackName;
}

function safeTempPath(ext) {
  const id = crypto.randomBytes(10).toString("hex");
  const suffix = ext ? `.${ext.replace(/^\./, "")}` : ".bin";
  return path.join(os.tmpdir(), `five9-audio-${id}${suffix}`);
}

function sanitizeUrlForStorage(urlValue) {
  try {
    const url = new URL(urlValue);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export async function downloadUrlToFile({ url, headers, fileExt }) {
  const filePath = safeTempPath(fileExt || "bin");
  const response = await axios.get(url, {
    headers: headers || {},
    responseType: "stream",
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400
  });
  await pipeline(response.data, fs.createWriteStream(filePath));
  return {
    filePath,
    contentType: response.headers?.["content-type"] || null,
    contentLength: response.headers?.["content-length"] ? Number(response.headers["content-length"]) : null,
    urlSanitized: sanitizeUrlForStorage(url)
  };
}

export async function writeStreamToFile({ stream, fileExt }) {
  const filePath = safeTempPath(fileExt || "bin");
  await pipeline(stream, fs.createWriteStream(filePath));
  return { filePath };
}

export async function probeDurationSeconds(filePath) {
  try {
    const ffprobe = resolveBinary("FFPROBE_PATH", "/opt/homebrew/bin/ffprobe", "ffprobe");
    const { stdout } = await execFileAsync(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nk=1:nw=1",
      filePath
    ]);
    const value = Number(String(stdout || "").trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export async function splitAudioToMp3Segments({ inputPath, segmentSeconds = 600 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "five9-segments-"));
  const outPattern = path.join(dir, "segment-%03d.mp3");

  const ffmpeg = resolveBinary("FFMPEG_PATH", "/opt/homebrew/bin/ffmpeg", "ffmpeg");
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "48k",
    "-f",
    "segment",
    "-segment_time",
    String(segmentSeconds),
    "-reset_timestamps",
    "1",
    outPattern
  ]);

  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("segment-") && name.endsWith(".mp3"))
    .map((name) => path.join(dir, name))
    .sort();

  return { dir, files };
}

export function cleanupFiles(paths) {
  for (const item of paths || []) {
    if (!item) continue;
    try {
      fs.rmSync(item, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
