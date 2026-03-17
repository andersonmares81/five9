<?php
declare(strict_types=1);

function loadEnv(string $path): void
{
    if (!file_exists($path)) {
        return;
    }

    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) {
        return;
    }

    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }
        if (!str_contains($line, '=')) {
            continue;
        }
        [$key, $value] = explode('=', $line, 2);
        $key = trim($key);
        $value = trim($value);
        if ($key === '') {
            continue;
        }
        if (
            (str_starts_with($value, '"') && str_ends_with($value, '"')) ||
            (str_starts_with($value, "'") && str_ends_with($value, "'"))
        ) {
            $value = substr($value, 1, -1);
        }
        if (getenv($key) === false) {
            putenv("{$key}={$value}");
            $_ENV[$key] = $value;
            $_SERVER[$key] = $value;
        }
    }
}

function normalizeDateTime(mixed $value): ?string
{
    if ($value === null) {
        return null;
    }

    if ($value instanceof DateTimeInterface) {
        return $value->format('Y-m-d H:i:s');
    }

    if (!is_string($value)) {
        return null;
    }

    $trimmed = trim($value);
    if ($trimmed === '') {
        return null;
    }

    try {
        return (new DateTimeImmutable($trimmed))->format('Y-m-d H:i:s');
    } catch (Throwable) {
        return null;
    }
}

loadEnv(__DIR__ . '/.env');

$debug = strtolower((string) getenv('INGEST_DEBUG')) === 'true';
if ($debug) {
    ini_set('display_errors', '1');
    ini_set('display_startup_errors', '1');
    error_reporting(E_ALL);
} else {
    ini_set('display_errors', '0');
    ini_set('display_startup_errors', '0');
}
ini_set('log_errors', '1');

header('Content-Type: application/json');

if (!extension_loaded('pdo_mysql')) {
    http_response_code(500);
    echo json_encode(['error' => 'pdo_mysql extension not enabled']);
    exit;
}

$payload = json_decode(file_get_contents('php://input'), true);
if (!$payload) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid JSON payload']);
    exit;
}

$calls = $payload['calls'] ?? null;
if ($calls === null && is_array($payload)) {
    $calls = $payload;
}
if (!is_array($calls)) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing calls array']);
    exit;
}

$host = getenv('MYSQL_HOST');
$port = getenv('MYSQL_PORT') ?: '3306';
$db = getenv('MYSQL_DATABASE');
$user = getenv('MYSQL_USERNAME');
$pass = getenv('MYSQL_PASSWORD');

if (!$host || !$db || !$user) {
    http_response_code(500);
    echo json_encode(['error' => 'MySQL env vars are not configured']);
    exit;
}

$dsn = "mysql:host={$host};port={$port};dbname={$db};charset=utf8mb4";

try {
    $pdo = new PDO($dsn, $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['error' => $debug ? $e->getMessage() : 'Database connection failed']);
    exit;
}

$stmt = $pdo->prepare(
    "INSERT INTO calls_five9_backup (
        call_id, agent_id, agent_first_name, agent_last_name, event_dir,
        start_time, end_time, duration_sec, ani, dnis, result_code, screen_capture_type, raw_json
    ) VALUES (
        :call_id, :agent_id, :agent_first_name, :agent_last_name, :event_dir,
        :start_time, :end_time, :duration_sec, :ani, :dnis, :result_code, :screen_capture_type, :raw_json
    )
    ON DUPLICATE KEY UPDATE
        agent_id=VALUES(agent_id),
        agent_first_name=VALUES(agent_first_name),
        agent_last_name=VALUES(agent_last_name),
        event_dir=VALUES(event_dir),
        start_time=VALUES(start_time),
        end_time=VALUES(end_time),
        duration_sec=VALUES(duration_sec),
        ani=VALUES(ani),
        dnis=VALUES(dnis),
        result_code=VALUES(result_code),
        screen_capture_type=VALUES(screen_capture_type),
        raw_json=VALUES(raw_json),
        updated_at=NOW()"
);

$inserted = 0;
foreach ($calls as $call) {
    if (!is_array($call) || empty($call['call_id'])) {
        continue;
    }
    $stmt->execute([
        ':call_id' => (string) $call['call_id'],
        ':agent_id' => $call['agent_id'] ?? null,
        ':agent_first_name' => $call['agent_first_name'] ?? null,
        ':agent_last_name' => $call['agent_last_name'] ?? null,
        ':event_dir' => $call['event_dir'] ?? null,
        ':start_time' => normalizeDateTime($call['start_time'] ?? null),
        ':end_time' => normalizeDateTime($call['end_time'] ?? null),
        ':duration_sec' => $call['duration_sec'] ?? null,
        ':ani' => $call['ani'] ?? null,
        ':dnis' => $call['dnis'] ?? null,
        ':result_code' => $call['result_code'] ?? null,
        ':screen_capture_type' => $call['screen_capture_type'] ?? null,
        ':raw_json' => json_encode($call, JSON_UNESCAPED_UNICODE),
    ]);
    $inserted += 1;
}

echo json_encode(['status' => 'ok', 'inserted' => $inserted]);
