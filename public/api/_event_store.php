<?php
// GSD GAU v8.5 - Shared event storage helpers

if (!function_exists('gau_ensure_dir')) {
    function gau_ensure_dir($dir)
    {
        if (!is_dir($dir)) {
            mkdir($dir, 0777, true);
        }
    }
}

if (!function_exists('gau_now')) {
    function gau_now()
    {
        return date('Y-m-d H:i:s');
    }
}

if (!function_exists('gau_sanitize_hostname')) {
    function gau_sanitize_hostname($hostname)
    {
        $clean = preg_replace('/[^a-zA-Z0-9\-_]/', '', (string) $hostname);
        $clean = strtoupper(trim((string) $clean));
        return $clean !== '' ? $clean : 'UNKNOWN';
    }
}

if (!function_exists('gau_read_json')) {
    function gau_read_json($path, $default = array())
    {
        if (!file_exists($path)) {
            return $default;
        }

        $raw = file_get_contents($path);
        if ($raw === false || trim($raw) === '') {
            return $default;
        }

        $decoded = json_decode(ltrim($raw, "\xEF\xBB\xBF"), true);
        return is_array($decoded) ? $decoded : $default;
    }
}

if (!function_exists('gau_write_json')) {
    function gau_write_json($path, $data, $pretty = true)
    {
        $flags = JSON_UNESCAPED_UNICODE;
        if ($pretty) {
            $flags |= JSON_PRETTY_PRINT;
        }
        file_put_contents($path, json_encode($data, $flags), LOCK_EX);
    }
}

if (!function_exists('gau_normalize_severity')) {
    function gau_normalize_severity($severity)
    {
        $s = strtolower(trim((string) $severity));
        if ($s === 'critical' || $s === 'warning' || $s === 'info' || $s === 'ok') {
            return $s;
        }
        if ($s === 'warn') {
            return 'warning';
        }
        return 'info';
    }
}

if (!function_exists('gau_is_relevant_event')) {
    function gau_is_relevant_event($event)
    {
        $category = strtolower((string) ($event['category'] ?? ''));
        $eventName = strtolower((string) ($event['event_name'] ?? ''));

        if (in_array($category, array('network_issue', 'five9_issue', 'audio_issue', 'system_issue'), true)) {
            return true;
        }

        if ($category === 'operational' && in_array($eventName, array('install', 'startup', 'run', 'report_upload'), true)) {
            return true;
        }

        return false;
    }
}

if (!function_exists('gau_next_event_id')) {
    function gau_next_event_id($hbDir)
    {
        gau_ensure_dir($hbDir);

        $indexFile = rtrim($hbDir, '/\\') . '/_events_index.json';
        $lockFile = rtrim($hbDir, '/\\') . '/_events.lock';

        $fp = fopen($lockFile, 'c+');
        if ($fp === false) {
            return (int) time();
        }

        $next = (int) time();
        if (flock($fp, LOCK_EX)) {
            $index = gau_read_json($indexFile, array('last_id' => 0));
            $next = ((int) ($index['last_id'] ?? 0)) + 1;
            $index['last_id'] = $next;
            gau_write_json($indexFile, $index, true);
            fflush($fp);
            flock($fp, LOCK_UN);
        }

        fclose($fp);
        return $next;
    }
}

if (!function_exists('gau_classify_watchdog_category')) {
    function gau_classify_watchdog_category($issues)
    {
        $text = strtolower(implode(' | ', is_array($issues) ? $issues : array()));

        if (preg_match('/latencia|dns|ping|packet|loss|red|network|internet|gateway/', $text)) {
            return 'network_issue';
        }

        if (preg_match('/five9|softphone|servicio/', $text)) {
            return 'five9_issue';
        }

        if (preg_match('/audio|sound|microphone|mic/', $text)) {
            return 'audio_issue';
        }

        return 'system_issue';
    }
}

if (!function_exists('gau_append_event')) {
    function gau_append_event($hbDir, $event, $dedupeKey = '', $dedupeWindowSec = 180)
    {
        gau_ensure_dir($hbDir);

        $nowEpoch = time();
        $dedupeFile = rtrim($hbDir, '/\\') . '/_dedupe.json';
        $dedupe = gau_read_json($dedupeFile, array());

        if ($dedupeKey !== '') {
            $last = (int) ($dedupe[$dedupeKey] ?? 0);
            if ($last > 0 && ($nowEpoch - $last) < (int) $dedupeWindowSec) {
                return array('saved' => false, 'reason' => 'deduplicated');
            }
            $dedupe[$dedupeKey] = $nowEpoch;
            gau_write_json($dedupeFile, $dedupe, true);
        }

        $event['event_id'] = gau_next_event_id($hbDir);
        $event['server_time'] = gau_now();
        $event['severity'] = gau_normalize_severity($event['severity'] ?? 'info');

        $eventsFile = rtrim($hbDir, '/\\') . '/_events.jsonl';
        file_put_contents($eventsFile, json_encode($event, JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX);

        $isRelevant = gau_is_relevant_event($event);
        if ($isRelevant && in_array($event['severity'], array('warning', 'critical'), true)) {
            $alertsText = rtrim($hbDir, '/\\') . '/_alerts.log';
            $summary = '[' . $event['server_time'] . '] [' . strtoupper($event['severity']) . '] ' . ($event['hostname'] ?? 'UNKNOWN') . ': ' . ($event['message'] ?? ($event['event_name'] ?? 'alert'));
            file_put_contents($alertsText, $summary . "\n", FILE_APPEND | LOCK_EX);

            $alertsJsonl = rtrim($hbDir, '/\\') . '/_alerts.jsonl';
            file_put_contents($alertsJsonl, json_encode($event, JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX);
        }

        return array('saved' => true, 'event' => $event, 'relevant' => $isRelevant);
    }
}

if (!function_exists('gau_read_events_since')) {
    function gau_read_events_since($hbDir, $sinceId, $limit = 200, $onlyRelevant = true)
    {
        $eventsFile = rtrim($hbDir, '/\\') . '/_events.jsonl';
        if (!file_exists($eventsFile)) {
            return array();
        }

        $lines = file($eventsFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if (!is_array($lines)) {
            return array();
        }

        $since = (int) $sinceId;
        $max = max(1, min(500, (int) $limit));
        $out = array();

        foreach ($lines as $line) {
            $decoded = json_decode($line, true);
            if (!is_array($decoded)) {
                continue;
            }

            $eventId = (int) ($decoded['event_id'] ?? 0);
            if ($eventId <= $since) {
                continue;
            }

            if ($onlyRelevant && !gau_is_relevant_event($decoded)) {
                continue;
            }

            $out[] = $decoded;
            if (count($out) >= $max) {
                break;
            }
        }

        return $out;
    }
}

if (!function_exists('gau_read_recent_events')) {
    function gau_read_recent_events($hbDir, $limit = 20, $onlyRelevant = true)
    {
        $eventsFile = rtrim($hbDir, '/\\') . '/_events.jsonl';
        if (!file_exists($eventsFile)) {
            return array();
        }

        $lines = file($eventsFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if (!is_array($lines) || count($lines) === 0) {
            return array();
        }

        $max = max(1, min(200, (int) $limit));
        $out = array();

        for ($i = count($lines) - 1; $i >= 0; $i--) {
            $decoded = json_decode($lines[$i], true);
            if (!is_array($decoded)) {
                continue;
            }

            if ($onlyRelevant && !gau_is_relevant_event($decoded)) {
                continue;
            }

            $out[] = $decoded;
            if (count($out) >= $max) {
                break;
            }
        }

        return $out;
    }
}
