<?php
// ================================================================
// GSD GAU - API receptora de reportes v8.7
// Recibe ZIP del agente, extrae, organiza por PC y publica evento
// ================================================================
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/_event_store.php';

$version = '8.8';
$baseFolder = __DIR__ . '/reportes/';
$hbDir = __DIR__ . '/heartbeats/';
gau_ensure_dir($baseFolder);
gau_ensure_dir($hbDir);

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(array('status' => 'error', 'message' => 'Metodo no permitido', 'version' => $version));
    exit;
}

if (!isset($_FILES['file'])) {
    echo json_encode(array('status' => 'error', 'message' => 'No se recibio archivo', 'version' => $version));
    exit;
}

$zipFile = $_FILES['file']['tmp_name'];
$fileName = basename((string) $_FILES['file']['name']);

$pcName = trim((string) ($_POST['hostname'] ?? ''));
if ($pcName === '') {
    $parts = explode('_', $fileName);
    $pcName = $parts[0] ?? 'UNKNOWN';
}

$pcName = gau_sanitize_hostname($pcName);
if ($pcName === 'UNKNOWN' || $pcName === '' || in_array(strtolower($pcName), array('report', 'gau', 'zip', 'unknown'), true)) {
    $pcName = 'PC_' . date('His');
}

$pcFolder = $baseFolder . $pcName . '/';
$agente = (string) ($_POST['agente'] ?? 'N/A');
$email = (string) ($_POST['email'] ?? 'N/A');
$turno = (string) ($_POST['turno'] ?? 'N/A');
$dayFolder = date('Y-m-d');
$timestamp = date('Ymd_His');
$histFolder = $pcFolder . 'historial/' . $dayFolder . '/' . $timestamp . '/';

gau_ensure_dir($pcFolder);
gau_ensure_dir($histFolder);

$zip = new ZipArchive();
if ($zip->open($zipFile) !== true) {
    echo json_encode(array('status' => 'error', 'message' => 'Fallo al abrir ZIP', 'version' => $version));
    exit;
}

$zip->extractTo($histFolder);
$zip->close();

$files = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($histFolder, RecursiveDirectoryIterator::SKIP_DOTS)
);

$extractedJson = array();
$extractedCsv = array();

foreach ($files as $file) {
    if (!$file->isFile()) {
        continue;
    }

    $ext = strtolower((string) $file->getExtension());
    if ($ext !== 'json' && $ext !== 'csv') {
        continue;
    }

    $dest = $pcFolder . $file->getFilename();
    copy($file->getPathname(), $dest);

    if ($ext === 'json') {
        $extractedJson[] = $file->getFilename();
    } elseif ($ext === 'csv') {
        $extractedCsv[] = $file->getFilename();
    }
}

$meta = array(
    'version' => $version,
    'pc' => $pcName,
    'agente' => $agente,
    'email' => $email,
    'turno' => $turno,
    'zip_recibido' => $fileName,
    'timestamp' => date('Y-m-d H:i:s'),
    'dia' => $dayFolder,
    'folder_historial' => 'reportes/' . $pcName . '/historial/' . $dayFolder . '/' . $timestamp . '/',
    'json_files' => $extractedJson,
    'csv_files' => $extractedCsv,
);

file_put_contents($pcFolder . 'last_update.txt', date('Y-m-d H:i:s'));
gau_write_json($pcFolder . '_meta_recepcion.json', $meta, true);

foreach (array('Report', 'GAU', 'Unknown') as $bad) {
    $badPath = $baseFolder . $bad;
    if (!is_dir($badPath)) {
        continue;
    }

    foreach (glob($badPath . '/*') as $f) {
        if (is_file($f)) {
            @unlink($f);
        }
    }
    @rmdir($badPath);
}

$indexFile = $baseFolder . '_indice_agentes.json';
$indice = gau_read_json($indexFile, array());
$indice[$pcName] = array(
    'agente' => $agente,
    'email' => $email,
    'turno' => $turno,
    'ultimo_reporte' => date('Y-m-d H:i:s'),
    'archivos_json' => count($extractedJson),
    'archivos_csv' => count($extractedCsv),
    'version' => $version,
    'dia' => $dayFolder,
);
gau_write_json($indexFile, $indice, true);

$eventSeverity = count($extractedJson) > 0 ? 'info' : 'warning';
$eventCategory = count($extractedJson) > 0 ? 'operational' : 'system_issue';
$eventMessage = count($extractedJson) > 0
    ? 'Reporte ZIP procesado (' . count($extractedJson) . ' JSON).'
    : 'ZIP procesado sin JSON utilizable.';

$eventPayload = array(
    'hostname' => $pcName,
    'type' => 'event',
    'event_name' => 'report_upload',
    'category' => $eventCategory,
    'severity' => $eventSeverity,
    'source' => 'reporte_api',
    'message' => $eventMessage,
    'version' => $version,
    'details' => array(
        'zip' => $fileName,
        'json_count' => count($extractedJson),
        'csv_count' => count($extractedCsv),
        'agente' => $agente,
        'email' => $email,
        'turno' => $turno,
        'dia' => $dayFolder,
        'folder_historial' => 'reportes/' . $pcName . '/historial/' . $dayFolder . '/' . $timestamp . '/',
    ),
);

$dedupeKey = $pcName . '|report_upload|' . $fileName;
$eventResult = gau_append_event($hbDir, $eventPayload, $dedupeKey, 30);

echo json_encode(array(
    'status' => 'success',
    'version' => $version,
    'pc' => $pcName,
    'agente' => $agente,
    'archivos_json' => count($extractedJson),
    'archivos_csv' => count($extractedCsv),
    'carpeta' => 'reportes/' . $pcName . '/',
    'folder_historial' => 'reportes/' . $pcName . '/historial/' . $dayFolder . '/' . $timestamp . '/',
    'event_saved' => (bool) ($eventResult['saved'] ?? false),
    'event_id' => isset($eventResult['event']['event_id']) ? $eventResult['event']['event_id'] : null,
));
exit;
