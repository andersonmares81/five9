<?php
// GSD GAU v8.5 - Heartbeat + Watchdog + Event Stream receiver
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/_event_store.php';

$version = '8.5';
$hbDir = __DIR__ . '/heartbeats';
gau_ensure_dir($hbDir);

function gau_read_payload()
{
    $raw = file_get_contents('php://input');
    $decoded = json_decode((string) $raw, true);

    if (is_array($decoded)) {
        return $decoded;
    }

    if (!empty($_POST) && is_array($_POST)) {
        return $_POST;
    }

    return null;
}

function gau_save_history($path, $entry, $max = 500)
{
    $history = gau_read_json($path, array());
    if (!is_array($history)) {
        $history = array();
    }

    array_unshift($history, $entry);
    $history = array_slice($history, 0, (int) $max);
    gau_write_json($path, $history, false);
}

function gau_get_event_cursor($hbDir)
{
    $cursor = gau_read_json(rtrim($hbDir, '/\\') . '/_events_index.json', array('last_id' => 0));
    return (int) ($cursor['last_id'] ?? 0);
}

function gau_build_watchdog_event($hn, $payload)
{
    $issues = $payload['issues'] ?? array();
    if (!is_array($issues)) {
        $issues = array((string) $issues);
    }

    $sev = gau_normalize_severity($payload['severity'] ?? 'warning');
    $category = gau_classify_watchdog_category($issues);

    return array(
        'hostname' => $hn,
        'type' => 'event',
        'event_name' => 'watchdog_issue',
        'category' => $category,
        'severity' => $sev,
        'source' => 'watchdog',
        'message' => count($issues) ? implode(' | ', array_slice($issues, 0, 3)) : 'Watchdog issue detected',
        'issues' => $issues,
        'version' => '8.5',
    );
}

function gau_build_operational_event($hn, $payload)
{
    $eventName = strtolower(trim((string) ($payload['event_name'] ?? '')));
    if ($eventName === '') {
        return null;
    }

    $allowed = array('install', 'startup', 'run');
    if (!in_array($eventName, $allowed, true)) {
        return null;
    }

    return array(
        'hostname' => $hn,
        'type' => 'event',
        'event_name' => $eventName,
        'category' => 'operational',
        'severity' => gau_normalize_severity($payload['severity'] ?? 'info'),
        'source' => 'agent',
        'message' => (string) ($payload['message'] ?? strtoupper($eventName) . ' event'),
        'version' => '8.5',
        'details' => isset($payload['details']) ? $payload['details'] : array(),
    );
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = gau_read_payload();
    if (!is_array($data)) {
        echo json_encode(array('status' => 'error', 'msg' => 'Invalid JSON payload'));
        exit;
    }

    if (empty($data['hostname'])) {
        echo json_encode(array('status' => 'error', 'msg' => 'No hostname'));
        exit;
    }

    $hn = gau_sanitize_hostname($data['hostname']);
    $type = strtolower(trim((string) ($data['type'] ?? 'heartbeat')));
    if (!in_array($type, array('heartbeat', 'watchdog', 'event'), true)) {
        $type = 'heartbeat';
    }

    $receivedAt = gau_now();
    $data['hostname'] = $hn;
    $data['type'] = $type;
    $data['version'] = (string) ($data['version'] ?? $version);
    $data['received_at'] = $receivedAt;
    $data['ip_origin'] = $_SERVER['REMOTE_ADDR'] ?? 'unknown';

    if (!isset($data['severity'])) {
        $data['severity'] = $type === 'watchdog' ? 'ok' : 'info';
    }
    $data['severity'] = gau_normalize_severity($data['severity']);

    $typedFile = $hbDir . '/' . $hn . '.' . $type . '.json';
    gau_write_json($typedFile, $data, true);

    $combinedFile = $hbDir . '/' . $hn . '.json';
    $combined = gau_read_json($combinedFile, array('hostname' => $hn));
    $combined[$type] = $data;
    $combined['hostname'] = $hn;
    $combined['last_type'] = $type;
    $combined['last_received_at'] = $receivedAt;

    if ($type === 'heartbeat') {
        foreach (array('ts', 'cpu_pct', 'ram_pct', 'five9_running', 'five9_service', 'teams_running', 'vpn_active', 'vpn_name', 'ip_publica') as $field) {
            if (array_key_exists($field, $data)) {
                $combined[$field] = $data[$field];
            }
        }
    }

    if ($type === 'watchdog') {
        $combined['severity'] = $data['severity'];
        $combined['issues'] = $data['issues'] ?? array();
    }

    gau_write_json($combinedFile, $combined, true);

    gau_save_history($hbDir . '/' . $hn . '.' . $type . '_history.json', $data, 500);

    if ($type === 'heartbeat') {
        gau_save_history($hbDir . '/' . $hn . '_history.json', $data, 500);
    }

    $savedEvent = null;

    if ($type === 'event') {
        $eventName = strtolower(trim((string) ($data['event_name'] ?? 'custom')));
        $category = strtolower(trim((string) ($data['category'] ?? 'system_issue')));
        $severity = gau_normalize_severity($data['severity'] ?? 'info');
        $issues = $data['issues'] ?? array();
        if (!is_array($issues)) {
            $issues = array((string) $issues);
        }

        $eventPayload = array(
            'hostname' => $hn,
            'type' => 'event',
            'event_name' => $eventName,
            'category' => $category,
            'severity' => $severity,
            'source' => (string) ($data['source'] ?? 'agent'),
            'message' => (string) ($data['message'] ?? $eventName),
            'issues' => $issues,
            'version' => (string) ($data['version'] ?? $version),
            'details' => isset($data['details']) ? $data['details'] : array(),
        );

        $dedupeKey = $hn . '|event|' . $eventName . '|' . $category . '|' . md5($eventPayload['message']);
        $savedEvent = gau_append_event($hbDir, $eventPayload, $dedupeKey, 120);
    }

    if ($type === 'watchdog' && ($data['severity'] ?? 'ok') !== 'ok') {
        $wdEvent = gau_build_watchdog_event($hn, $data);
        $wdKey = $hn . '|watchdog|' . ($wdEvent['category'] ?? 'system_issue') . '|' . md5($wdEvent['message']);
        $savedEvent = gau_append_event($hbDir, $wdEvent, $wdKey, 240);
    }

    if ($type === 'heartbeat' && !empty($data['event_name'])) {
        $opEvent = gau_build_operational_event($hn, $data);
        if (is_array($opEvent)) {
            $opKey = $hn . '|op|' . $opEvent['event_name'];
            $savedEvent = gau_append_event($hbDir, $opEvent, $opKey, 90);
        }
    }

    echo json_encode(array(
        'status' => 'ok',
        'version' => $version,
        'hostname' => $hn,
        'type' => $type,
        'received_at' => $receivedAt,
        'event_saved' => is_array($savedEvent) ? (bool) ($savedEvent['saved'] ?? false) : false,
        'event_id' => is_array($savedEvent) && isset($savedEvent['event']['event_id']) ? $savedEvent['event']['event_id'] : null,
    ));
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = strtolower(trim((string) ($_GET['action'] ?? 'status')));

    if ($action === 'cursor') {
        echo json_encode(array('status' => 'ok', 'last_id' => gau_get_event_cursor($hbDir)));
        exit;
    }

    if ($action === 'events_since') {
        $sinceId = isset($_GET['since_id']) ? (int) $_GET['since_id'] : 0;
        $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 100;
        $onlyRelevant = !isset($_GET['only_relevant']) || (int) $_GET['only_relevant'] === 1;

        $events = gau_read_events_since($hbDir, $sinceId, $limit, $onlyRelevant);
        $lastId = gau_get_event_cursor($hbDir);
        $nextSince = $sinceId;
        if (!empty($events)) {
            $lastEvent = end($events);
            $nextSince = (int) ($lastEvent['event_id'] ?? $sinceId);
        }

        echo json_encode(array(
            'status' => 'ok',
            'since_id' => $sinceId,
            'last_id' => $lastId,
            'next_since' => $nextSince,
            'count' => count($events),
            'events' => $events,
            'server_time' => gau_now(),
            'version' => $version,
        ), JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($action === 'alerts') {
        $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 50;
        $events = gau_read_recent_events($hbDir, $limit, true);

        $alerts = array_values(array_filter($events, function ($e) {
            $sev = strtolower((string) ($e['severity'] ?? 'info'));
            return $sev === 'warning' || $sev === 'critical';
        }));

        echo json_encode(array(
            'status' => 'ok',
            'count' => count($alerts),
            'alerts' => $alerts,
            'version' => $version,
        ), JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($action === 'history') {
        $hnRaw = (string) ($_GET['hostname'] ?? '');
        if ($hnRaw === '') {
            echo json_encode(array('status' => 'error', 'msg' => 'hostname requerido'));
            exit;
        }

        $hn = gau_sanitize_hostname($hnRaw);
        $type = strtolower(trim((string) ($_GET['type'] ?? 'heartbeat')));
        if (!in_array($type, array('heartbeat', 'watchdog', 'event'), true)) {
            $type = 'heartbeat';
        }

        $historyPath = $hbDir . '/' . $hn . '.' . $type . '_history.json';
        $history = gau_read_json($historyPath, array());

        if ($type === 'heartbeat' && empty($history)) {
            $history = gau_read_json($hbDir . '/' . $hn . '_history.json', array());
        }

        echo json_encode($history, JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($action === 'status') {
        $hosts = array();

        foreach (glob($hbDir . '/*.heartbeat.json') as $f) {
            $name = basename($f);
            $hn = strtoupper(str_replace('.heartbeat.json', '', $name));
            $hosts[$hn] = true;
        }

        foreach (glob($hbDir . '/*.watchdog.json') as $f) {
            $name = basename($f);
            $hn = strtoupper(str_replace('.watchdog.json', '', $name));
            $hosts[$hn] = true;
        }

        foreach (glob($hbDir . '/*.json') as $f) {
            $name = basename($f);
            if (strpos($name, '_') === 0 || strpos($name, '.heartbeat.') !== false || strpos($name, '.watchdog.') !== false || strpos($name, '_history') !== false || strpos($name, '_index') !== false) {
                continue;
            }
            $hn = strtoupper(str_replace('.json', '', $name));
            $hosts[$hn] = true;
        }

        $agents = array();
        $now = time();

        foreach (array_keys($hosts) as $hn) {
            $hb = gau_read_json($hbDir . '/' . $hn . '.heartbeat.json', array());
            $wd = gau_read_json($hbDir . '/' . $hn . '.watchdog.json', array());
            $combined = gau_read_json($hbDir . '/' . $hn . '.json', array());

            if (empty($hb) && isset($combined['heartbeat']) && is_array($combined['heartbeat'])) {
                $hb = $combined['heartbeat'];
            }
            if (empty($wd) && isset($combined['watchdog']) && is_array($combined['watchdog'])) {
                $wd = $combined['watchdog'];
            }

            $last = strtotime((string) ($hb['received_at'] ?? $hb['ts'] ?? $combined['last_received_at'] ?? '2000-01-01'));
            if ($last <= 0) {
                $last = strtotime('2000-01-01');
            }

            $ago = $now - $last;
            $agoMin = (int) round($ago / 60);
            $online = $ago < 600;
            $warning = !$online && $ago < 1200;

            $agents[$hn] = array(
                'hostname' => $hn,
                'version' => (string) ($hb['version'] ?? $wd['version'] ?? $combined['version'] ?? $version),
                'received_at' => $hb['received_at'] ?? $combined['last_received_at'] ?? null,
                'ts' => $hb['ts'] ?? null,
                'five9_running' => (bool) ($hb['five9_running'] ?? false),
                'five9_service' => (bool) ($hb['five9_service'] ?? false),
                'teams_running' => (bool) ($hb['teams_running'] ?? false),
                'vpn_active' => (bool) ($hb['vpn_active'] ?? false),
                'vpn_name' => $hb['vpn_name'] ?? null,
                'cpu_pct' => $hb['cpu_pct'] ?? null,
                'ram_pct' => $hb['ram_pct'] ?? null,
                'ip_publica' => $hb['ip_publica'] ?? null,
                'severity' => (string) ($wd['severity'] ?? $combined['severity'] ?? 'ok'),
                'issues' => $wd['issues'] ?? $combined['issues'] ?? array(),
                '_online' => $online,
                '_warning' => $warning,
                '_offline' => !$online && !$warning,
                '_ago_min' => $agoMin,
                '_ago_text' => $agoMin < 1 ? 'Ahora' : ($agoMin < 60 ? $agoMin . ' min' : round($agoMin / 60, 1) . ' h'),
            );
        }

        $onlineCount = count(array_filter($agents, function ($a) { return !empty($a['_online']); }));
        $offlineCount = count(array_filter($agents, function ($a) { return !empty($a['_offline']); }));

        echo json_encode(array(
            'status' => 'ok',
            'version' => $version,
            'server_time' => gau_now(),
            'total' => count($agents),
            'online' => $onlineCount,
            'offline' => $offlineCount,
            'agents' => $agents,
            'last_event_id' => gau_get_event_cursor($hbDir),
        ), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
        exit;
    }

    echo json_encode(array('status' => 'error', 'msg' => 'Action no valida', 'version' => $version));
    exit;
}

echo json_encode(array('status' => 'error', 'msg' => 'Metodo no soportado', 'version' => $version));
