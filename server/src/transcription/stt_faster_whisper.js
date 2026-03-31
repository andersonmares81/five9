import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

function resolvePythonCommands() {
  const fromEnv = process.env.PYTHON_BIN;
  if (fromEnv && String(fromEnv).trim()) {
    return [String(fromEnv).trim()];
  }
  if (process.platform === "win32") {
    return ["python", "py -3", "python3"];
  }
  return ["python3", "python"];
}

function resolveModel(requestedModel) {
  return (
    requestedModel ||
    process.env.FASTER_WHISPER_MODEL ||
    process.env.TRANSCRIBE_MODEL ||
    "small"
  );
}

export async function transcribeFileWithFasterWhisper({ filePath, model }) {
  if (!filePath) throw new Error("missing_file");

  const here = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.join(here, "stt_faster_whisper.py");
  const baseArgs = [
    "-u",
    scriptPath,
    "--file",
    filePath,
    "--model",
    resolveModel(model),
    "--device",
    process.env.FASTER_WHISPER_DEVICE || "cpu",
    "--compute-type",
    process.env.FASTER_WHISPER_COMPUTE_TYPE || "int8",
    "--vad-filter",
    "true"
  ];

  const language = process.env.FASTER_WHISPER_LANGUAGE;
  if (language && String(language).trim()) {
    baseArgs.push("--language", String(language).trim());
  }

  const pythonCommands = resolvePythonCommands();
  let lastError = null;

  for (const command of pythonCommands) {
    const segments = String(command)
      .split(" ")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const executable = segments[0];
    const commandArgs = [...segments.slice(1), ...baseArgs];

    try {
      const { stdout } = await execFileAsync(executable, commandArgs, {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        maxBuffer: 32 * 1024 * 1024
      });
      const trimmed = String(stdout || "").trim();
      if (!trimmed) throw new Error("transcribe_failed");
      const parsed = JSON.parse(trimmed);
      return { model: resolveModel(model), response: parsed };
    } catch (error) {
      lastError = error;
      const stderr = String(error?.stderr || "");
      const message = String(error?.message || "");
      if (stderr.includes("ModuleNotFoundError") && stderr.includes("faster_whisper")) {
        throw new Error("faster_whisper_not_installed");
      }
      if (stderr.includes("No module named") && stderr.includes("faster_whisper")) {
        throw new Error("faster_whisper_not_installed");
      }
      if (message.includes("ENOENT") || message.includes("not found")) {
        continue;
      }
      throw new Error("transcribe_failed");
    }
  }

  if (lastError) {
    throw new Error("python_not_found");
  }
  throw new Error("transcribe_failed");
}
