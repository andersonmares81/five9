<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

/**
 * RESPUESTA JSON
 */
function jsonResponse(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * CARGAR .ENV SIMPLE
 */
function loadEnv(string $path): array
{
    if (!file_exists($path)) {
        throw new RuntimeException(".env no encontrado en: {$path}");
    }

    $vars = [];
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);

    foreach ($lines as $line) {
        $line = trim($line);

        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }

        $pos = strpos($line, '=');
        if ($pos === false) {
            continue;
        }

        $key = trim(substr($line, 0, $pos));
        $value = trim(substr($line, $pos + 1));

        // quitar comillas si existen
        if (
            (str_starts_with($value, '"') && str_ends_with($value, '"')) ||
            (str_starts_with($value, "'") && str_ends_with($value, "'"))
        ) {
            $value = substr($value, 1, -1);
        }

        $vars[$key] = $value;
        $_ENV[$key] = $value;
        putenv("$key=$value");
    }

    return $vars;
}

/**
 * OBTENER VARIABLE ENV
 */
function envVar(string $key, ?string $default = null): ?string
{
    $value = $_ENV[$key] ?? getenv($key);
    if ($value === false || $value === null || $value === '') {
        return $default;
    }
    return (string)$value;
}

/**
 * OBTENER HEADER
 */
function getHeaderValue(string $name): ?string
{
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    return $_SERVER[$key] ?? null;
}

/**
 * VALIDAR FECHAS
 */
function isValidDate(string $date): bool
{
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        return true;
    }
    if (preg_match('/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/', $date)) {
        return true;
    }
    return false;
}

function isValidUnixTimestamp(string $value): bool
{
    return ctype_digit($value);
}

/**
 * BASE DE FIRMA
 */
function buildSignatureBase(array $queryParams, string $timestamp): string
{
    ksort($queryParams);
    $queryString = http_build_query($queryParams);
    return $timestamp . '|' . $queryString;
}

try {
    /**
     * CARGAR .ENV
     * Ajusta la ruta según dónde guardes el archivo
     */
    $envPath = dirname(__DIR__) . '/.env';
    loadEnv($envPath);

    $dbHost = envVar('MYSQL_HOST');
    $dbPort = envVar('MYSQL_PORT', '3306');
    $dbName = envVar('MYSQL_DATABASE');
    $dbUser = envVar('MYSQL_USERNAME');
    $dbPass = envVar('MYSQL_PASSWORD');

    $apiBearerToken = envVar('API_BEARER_TOKEN');
    $apiSharedSecret = envVar('API_SHARED_SECRET');
    $maxLimit = (int)envVar('MAX_LIMIT', '100');
    $maxTimeSkew = (int)envVar('MAX_TIME_SKEW', '300');

    if (!$dbHost || !$dbName || !$dbUser) {
        throw new RuntimeException('Faltan variables de conexión MySQL en el .env');
    }

    if (!$apiBearerToken || !$apiSharedSecret) {
        throw new RuntimeException('Faltan API_BEARER_TOKEN o API_SHARED_SECRET en el .env');
    }

    /**
     * SOLO GET
     */
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        jsonResponse(405, [
            'ok' => false,
            'error' => 'Método no permitido. Usa GET.'
        ]);
    }

    /**
     * TOKEN
     */
    $authHeader = getHeaderValue('Authorization');
    if (!$authHeader || !preg_match('/^Bearer\s+(.+)$/i', $authHeader, $matches)) {
        jsonResponse(401, [
            'ok' => false,
            'error' => 'Falta Authorization Bearer token.'
        ]);
    }

    $bearerToken = trim($matches[1]);
    if (!hash_equals($apiBearerToken, $bearerToken)) {
        jsonResponse(401, [
            'ok' => false,
            'error' => 'Token inválido.'
        ]);
    }

    /**
     * FIRMA HMAC
     */
    $timestamp = getHeaderValue('X-Timestamp');
    $clientSignature = getHeaderValue('X-Signature');

    if (!$timestamp || !$clientSignature) {
        jsonResponse(401, [
            'ok' => false,
            'error' => 'Faltan headers X-Timestamp o X-Signature.'
        ]);
    }

    if (!isValidUnixTimestamp($timestamp)) {
        jsonResponse(401, [
            'ok' => false,
            'error' => 'X-Timestamp inválido.'
        ]);
    }

    $now = time();
    $requestTime = (int)$timestamp;

    if (abs($now - $requestTime) > $maxTimeSkew) {
        jsonResponse(401, [
            'ok' => false,
            'error' => 'Petición expirada o fuera de ventana permitida.'
        ]);
    }

    $queryParams = $_GET;
    $signatureBase = buildSignatureBase($queryParams, $timestamp);
    $expectedSignature = hash_hmac('sha256', $signatureBase, $apiSharedSecret);

    if (!hash_equals($expectedSignature, $clientSignature)) {
        jsonResponse(401, [
            'ok' => false,
            'error' => 'Firma inválida.'
        ]);
    }

    /**
     * FILTROS
     */
    $callId      = isset($_GET['call_id']) ? trim((string)$_GET['call_id']) : null;
    $agentId     = isset($_GET['agent_id']) ? trim((string)$_GET['agent_id']) : null;
    $eventDir    = isset($_GET['event_dir']) ? trim((string)$_GET['event_dir']) : null;
    $ani         = isset($_GET['ani']) ? trim((string)$_GET['ani']) : null;
    $dnis        = isset($_GET['dnis']) ? trim((string)$_GET['dnis']) : null;
    $resultCode  = isset($_GET['result_code']) ? trim((string)$_GET['result_code']) : null;
    $dateFrom    = isset($_GET['date_from']) ? trim((string)$_GET['date_from']) : null;
    $dateTo      = isset($_GET['date_to']) ? trim((string)$_GET['date_to']) : null;
    $includeRaw  = isset($_GET['include_raw']) ? (int)$_GET['include_raw'] : 0;
    $offset      = isset($_GET['offset']) ? (int)$_GET['offset'] : 0;
    $limit       = isset($_GET['limit']) ? (int)$_GET['limit'] : 20;

    if ($limit < 1) {
        $limit = 20;
    }
    if ($limit > $maxLimit) {
        $limit = $maxLimit;
    }
    if ($offset < 0) {
        $offset = 0;
    }

    if ($dateFrom !== null && !isValidDate($dateFrom)) {
        jsonResponse(400, [
            'ok' => false,
            'error' => 'date_from inválido. Usa YYYY-MM-DD o YYYY-MM-DD HH:MM:SS'
        ]);
    }

    if ($dateTo !== null && !isValidDate($dateTo)) {
        jsonResponse(400, [
            'ok' => false,
            'error' => 'date_to inválido. Usa YYYY-MM-DD o YYYY-MM-DD HH:MM:SS'
        ]);
    }

    /**
     * EVITAR CONSULTAS MASIVAS
     */
    $hasUsefulFilter =
        !empty($callId) ||
        !empty($agentId) ||
        !empty($ani) ||
        !empty($dnis) ||
        !empty($resultCode) ||
        !empty($eventDir) ||
        !empty($dateFrom) ||
        !empty($dateTo);

    if (!$hasUsefulFilter) {
        jsonResponse(400, [
            'ok' => false,
            'error' => 'Debes enviar al menos un filtro para evitar consultas masivas.'
        ]);
    }

    /**
     * CONEXIÓN PDO
     */
    $dsn = "mysql:host={$dbHost};port={$dbPort};dbname={$dbName};charset=utf8mb4";

    $pdo = new PDO($dsn, $dbUser, $dbPass ?? '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    /**
     * COLUMNAS
     */
    $columns = [
        'call_id',
        'agent_id',
        'agent_first_name',
        'agent_last_name',
        'event_dir',
        'start_time',
        'end_time',
        'duration_sec',
        'ani',
        'dnis',
        'result_code',
        'screen_capture_type',
        'created_at',
        'updated_at'
    ];

    if ($includeRaw === 1) {
        $columns[] = 'raw_json';
    }

    $sql = 'SELECT ' . implode(', ', $columns) . ' FROM calls_five9_backup WHERE 1=1';
    $params = [];

    if (!empty($callId)) {
        $sql .= ' AND call_id = :call_id';
        $params[':call_id'] = $callId;
    }

    if (!empty($agentId)) {
        $sql .= ' AND agent_id = :agent_id';
        $params[':agent_id'] = $agentId;
    }

    if (!empty($eventDir)) {
        $sql .= ' AND event_dir = :event_dir';
        $params[':event_dir'] = $eventDir;
    }

    if (!empty($ani)) {
        $sql .= ' AND ani = :ani';
        $params[':ani'] = $ani;
    }

    if (!empty($dnis)) {
        $sql .= ' AND dnis = :dnis';
        $params[':dnis'] = $dnis;
    }

    if (!empty($resultCode)) {
        $sql .= ' AND result_code = :result_code';
        $params[':result_code'] = $resultCode;
    }

    if (!empty($dateFrom)) {
        if (strlen($dateFrom) === 10) {
            $dateFrom .= ' 00:00:00';
        }
        $sql .= ' AND start_time >= :date_from';
        $params[':date_from'] = $dateFrom;
    }

    if (!empty($dateTo)) {
        if (strlen($dateTo) === 10) {
            $dateTo .= ' 23:59:59';
        }
        $sql .= ' AND start_time <= :date_to';
        $params[':date_to'] = $dateTo;
    }

    $sql .= ' ORDER BY start_time DESC LIMIT :limit OFFSET :offset';

    $stmt = $pdo->prepare($sql);

    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, PDO::PARAM_STR);
    }

    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);

    $stmt->execute();
    $rows = $stmt->fetchAll();

    /**
     * TOTAL
     */
    $countSql = 'SELECT COUNT(*) FROM calls_five9_backup WHERE 1=1';
    $countParams = [];

    if (!empty($callId)) {
        $countSql .= ' AND call_id = :call_id';
        $countParams[':call_id'] = $callId;
    }
    if (!empty($agentId)) {
        $countSql .= ' AND agent_id = :agent_id';
        $countParams[':agent_id'] = $agentId;
    }
    if (!empty($eventDir)) {
        $countSql .= ' AND event_dir = :event_dir';
        $countParams[':event_dir'] = $eventDir;
    }
    if (!empty($ani)) {
        $countSql .= ' AND ani = :ani';
        $countParams[':ani'] = $ani;
    }
    if (!empty($dnis)) {
        $countSql .= ' AND dnis = :dnis';
        $countParams[':dnis'] = $dnis;
    }
    if (!empty($resultCode)) {
        $countSql .= ' AND result_code = :result_code';
        $countParams[':result_code'] = $resultCode;
    }
    if (!empty($dateFrom)) {
        $countSql .= ' AND start_time >= :date_from';
        $countParams[':date_from'] = $params[':date_from'];
    }
    if (!empty($dateTo)) {
        $countSql .= ' AND start_time <= :date_to';
        $countParams[':date_to'] = $params[':date_to'];
    }

    $countStmt = $pdo->prepare($countSql);
    foreach ($countParams as $key => $value) {
        $countStmt->bindValue($key, $value, PDO::PARAM_STR);
    }
    $countStmt->execute();
    $total = (int)$countStmt->fetchColumn();

    $responseData = [
        'ok' => true,
        'meta' => [
            'limit' => $limit,
            'offset' => $offset,
            'returned' => count($rows),
            'total' => $total,
            'filters' => [
                'call_id' => $callId,
                'agent_id' => $agentId,
                'event_dir' => $eventDir,
                'ani' => $ani,
                'dnis' => $dnis,
                'result_code' => $resultCode,
                'date_from' => $dateFrom,
                'date_to' => $dateTo,
                'include_raw' => $includeRaw
            ]
        ],
        'data' => $rows
    ];

    $responseJson = json_encode($responseData, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $responseSignature = hash_hmac('sha256', $responseJson, $apiSharedSecret);

    header('X-Response-Signature: ' . $responseSignature);
    echo $responseJson;
    exit;

} catch (Throwable $e) {
    jsonResponse(500, [
        'ok' => false,
        'error' => 'Error interno del servidor.',
        'detail' => $e->getMessage()
    ]);
}
