<?php
header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self';");

$version = '8.8';
$baseDir = __DIR__ . '/api/reportes/';
$hbDir = __DIR__ . '/api/heartbeats/';
$pcFilter = strtoupper(trim((string) ($_GET['pc'] ?? '')));
require_once __DIR__ . '/api/_event_store.php';

function rj($path)
{
    if (!file_exists($path)) {
        return null;
    }
    $raw = file_get_contents($path);
    if ($raw === false) {
        return null;
    }
    $decoded = json_decode(ltrim($raw, "\xEF\xBB\xBF"), true);
    return is_array($decoded) ? $decoded : null;
}

function toA($v)
{
    if (!$v) {
        return array();
    }
    if (isset($v[0])) {
        return $v;
    }
    if (isset($v['value']) && is_array($v['value'])) {
        return $v['value'];
    }
    return array($v);
}

function enrichHeartbeat($d)
{
    if (!is_array($d)) {
        return null;
    }

    $last = strtotime((string) ($d['received_at'] ?? $d['ts'] ?? '2000-01-01'));
    if ($last <= 0) {
        $last = strtotime('2000-01-01');
    }

    $ago = time() - $last;
    $agoMin = (int) round($ago / 60);

    $d['_online'] = $ago < 600;
    $d['_warning'] = !$d['_online'] && $ago < 1200;
    $d['_offline'] = !$d['_online'] && !$d['_warning'];
    $d['_ago_min'] = $agoMin;
    $d['_ago_text'] = $agoMin < 1 ? 'Ahora' : ($agoMin < 60 ? $agoMin . ' min' : round($agoMin / 60, 1) . ' h');

    return $d;
}

function gau_event_text($event)
{
    $parts = array(
        (string) ($event['category'] ?? ''),
        (string) ($event['event_name'] ?? ''),
        (string) ($event['message'] ?? ''),
        implode(' | ', toA($event['issues'] ?? array()))
    );
    return strtolower(trim(implode(' | ', $parts)));
}

function gau_event_is_five9_related($event)
{
    $text = gau_event_text($event);
    return (bool) preg_match('/five9|softphone|svc five9|gateway\.five9|api\.five9/', $text);
}

function gau_event_is_other_relevant($event)
{
    $text = gau_event_text($event);
    return (bool) preg_match('/descon|disconnect|offline|sin red|latencia|ping|packet|loss|dns|gateway|internet|speedtest|download|upload|cpu|ram|memoria|memory|procesador/', $text);
}

function gau_alert_icon($event)
{
    $text = gau_event_text($event);
    if (preg_match('/five9|softphone/', $text)) {
        return 'bi-headset';
    }
    if (preg_match('/vpn|anyconnect|openvpn|forticlient|globalprotect|pulse/', $text)) {
        return 'bi-shield-lock';
    }
    if (preg_match('/descon|disconnect|offline|sin red/', $text)) {
        return 'bi-plug';
    }
    if (preg_match('/latencia|ping|packet|loss|dns|gateway|internet|speedtest|download|upload/', $text)) {
        return 'bi-wifi-off';
    }
    if (preg_match('/cpu|procesador/', $text)) {
        return 'bi-cpu';
    }
    if (preg_match('/ram|memoria|memory/', $text)) {
        return 'bi-bar-chart-line';
    }
    if (preg_match('/audio|sound|microphone|mic/', $text)) {
        return 'bi-mic-mute';
    }
    return 'bi-exclamation-triangle';
}

function gau_alert_bucket($event, $profilesByHost)
{
    $host = strtoupper(preg_replace('/[^A-Z0-9\-_]/', '', (string) ($event['hostname'] ?? '')));
    $profile = $profilesByHost[$host] ?? array('has_five9' => false, 'has_vpn' => false);
    $hasFive9 = !empty($profile['has_five9']);
    $hasVpn = !empty($profile['has_vpn']);
    $isFive9 = gau_event_is_five9_related($event);

    if ($hasFive9) {
        return 'five9';
    }

    if ($hasVpn) {
        return $isFive9 ? null : 'vpn';
    }

    if ($isFive9) {
        return null;
    }

    return gau_event_is_other_relevant($event) ? 'other' : null;
}

$reportFolders = array();
if (is_dir($baseDir)) {
    foreach (glob($baseDir . '*', GLOB_ONLYDIR) as $f) {
        $name = basename($f);
        if ($name !== '' && $name[0] !== '_' && $name !== 'historial') {
            $reportFolders[strtoupper($name)] = $f;
        }
    }
}

$heartbeats = array();
if (is_dir($hbDir)) {
    foreach (glob($hbDir . '/*.heartbeat.json') as $f) {
        $host = strtoupper(str_replace('.heartbeat.json', '', basename($f)));
        $hb = enrichHeartbeat(rj($f));
        if ($hb) {
            $heartbeats[$host] = $hb;
        }
    }

    if (empty($heartbeats)) {
        foreach (glob($hbDir . '/*.json') as $f) {
            $base = basename($f, '.json');
            if ($base === '' || $base[0] === '_' || strpos($base, '_history') !== false || strpos($base, '.') !== false) {
                continue;
            }

            $raw = rj($f);
            if (!$raw) {
                continue;
            }

            if (isset($raw['heartbeat']) && is_array($raw['heartbeat'])) {
                $hb = enrichHeartbeat($raw['heartbeat']);
            } else {
                $hb = enrichHeartbeat($raw);
            }

            if ($hb) {
                $heartbeats[strtoupper($base)] = $hb;
            }
        }
    }
}

$watchdogs = array();
if (is_dir($hbDir)) {
    foreach (glob($hbDir . '/*.watchdog.json') as $f) {
        $host = strtoupper(str_replace('.watchdog.json', '', basename($f)));
        $wd = rj($f);
        if ($wd) {
            $watchdogs[$host] = $wd;
        }
    }

    if (empty($watchdogs)) {
        foreach (glob($hbDir . '/*.json') as $f) {
            $base = basename($f, '.json');
            if ($base === '' || $base[0] === '_' || strpos($base, '_history') !== false || strpos($base, '.') !== false) {
                continue;
            }

            $raw = rj($f);
            if (!$raw) {
                continue;
            }

            if (isset($raw['watchdog']) && is_array($raw['watchdog'])) {
                $watchdogs[strtoupper($base)] = $raw['watchdog'];
            } elseif (($raw['type'] ?? '') === 'watchdog') {
                $watchdogs[strtoupper($base)] = $raw;
            }
        }
    }
}

$allHosts = array_unique(array_merge(array_keys($reportFolders), array_keys($heartbeats), array_keys($watchdogs)));
sort($allHosts);
if ($pcFilter !== '') {
    $allHosts = array_values(array_filter($allHosts, function ($h) use ($pcFilter) {
        return strtoupper((string) $h) === $pcFilter;
    }));
}

$agents = array();

foreach ($allHosts as $pc) {
    $folder = $reportFolders[$pc] ?? null;
    $reportFolderName = $folder ? basename($folder) : $pc;

    $id = $folder ? rj($folder . '/0_Identidad.json') : null;
    $hw = $folder ? rj($folder . '/1_Hardware.json') : null;
    $net = $folder ? rj($folder . '/2_Red.json') : null;
    $spd = $folder ? rj($folder . '/3_SpeedTest.json') : null;
    $sw = $folder ? rj($folder . '/4_Software.json') : null;
    $vpn = $folder ? rj($folder . '/6_VPN_QoS.json') : null;
    $av = $folder ? rj($folder . '/7_Antivirus.json') : null;
    $proc = $folder ? rj($folder . '/9_Procesos.json') : null;
    $lu = $folder && file_exists($folder . '/last_update.txt') ? @file_get_contents($folder . '/last_update.txt') : null;

    if (!$id) {
        $id = array('Nombre' => $pc, 'ISP' => 'N/A', 'Tipo_Red' => '?', 'Email' => 'N/A', 'Extension' => 'N/A');
    }
    if (!$hw) {
        $hw = array();
    }
    if (!$net) {
        $net = array();
    }
    if (!$spd) {
        $spd = array();
    }
    if (!$sw) {
        $sw = array();
    }
    if (!$vpn) {
        $vpn = array();
    }
    if (!$av) {
        $av = array();
    }
    if (!$proc) {
        $proc = array();
    }

    $f9soft = false;
    $f9v = null;
    $f9any = false;
    $voipOthers = array();
    $voipRegex = '/zoom|webex|ringcentral|3cx|avaya|genesys|skype|vonage|dialpad|aircall|talkdesk|goto/i';
    $softwarePool = toA($sw['Software_Completo'] ?? $sw['Software_Relevante'] ?? array());
    foreach ($softwarePool as $s) {
        $name = (string) ($s['Nombre'] ?? '');
        if ($name === '') {
            continue;
        }

        if (stripos($name, 'five9 softphone') !== false) {
            $f9soft = true;
            $f9v = $s['Version'] ?? 'Si';
        }

        if (stripos($name, 'five9') !== false) {
            $f9any = true;
            continue;
        }

        if (preg_match($voipRegex, $name)) {
            $voipOthers[] = $name;
        }
    }
    $voipOthers = array_values(array_unique($voipOthers));
    $hasOtherVoip = count($voipOthers) > 0;

    $tr = strtolower((string) ($id['Tipo_Red'] ?? ''));
    $isCable = strpos($tr, 'cable') !== false || strpos($tr, 'ethernet') !== false || strpos($tr, 'lan') !== false;
    $isWifi = strpos($tr, 'wifi') !== false || strpos($tr, 'wi-fi') !== false;
    $conn = $isCable ? 'cable' : ($isWifi ? 'wifi' : '?');

    $vpa = !empty($vpn['VPN_Activa']);
    $vpl = null;
    if ($vpa) {
        $vp = toA($vpn['VPN_Procesos'] ?? array());
        $vpl = $vp[0]['ProcessName'] ?? 'Activa';
    }

    $avr = !empty($av['Defender_RT']);
    $tmb = (int) ($proc['Teams_MB'] ?? 0);
    $mbps = (float) ($spd['Download_Mbps'] ?? 0);

    $hb = $heartbeats[$pc] ?? null;
    $isOnline = $hb ? !empty($hb['_online']) : false;
    $isWarn = $hb ? !empty($hb['_warning']) : false;
    $agoText = $hb['_ago_text'] ?? 'Sin heartbeat';
    $hbF9 = $hb['five9_running'] ?? false;
    $hbF9svc = $hb['five9_service'] ?? false;
    $hbCpu = $hb['cpu_pct'] ?? null;
    $hbRam = $hb['ram_pct'] ?? null;

    $wd = $watchdogs[$pc] ?? null;
    $wdSev = strtolower((string) ($wd['severity'] ?? 'ok'));
    if ($wdSev === 'warn') {
        $wdSev = 'warning';
    }
    if (!in_array($wdSev, array('ok', 'warning', 'critical'), true)) {
        $wdSev = 'ok';
    }

    $wdIssues = toA($wd['issues'] ?? array());

    $cardTone = $f9any ? 'tone-five9' : ($hasOtherVoip ? 'tone-voip' : 'tone-default');
    $tagList = array();
    if ($f9any) {
        $tagList[] = array('label' => 'Five9', 'type' => 'five9');
    }
    if ($hasOtherVoip) {
        $tagList[] = array('label' => 'VoIP', 'type' => 'voip');
    }
    if ($vpa) {
        $tagList[] = array('label' => 'VPN', 'type' => 'vpn');
    }
    if ($isCable) {
        $tagList[] = array('label' => 'Cable', 'type' => 'net-cable');
    } elseif ($isWifi) {
        $tagList[] = array('label' => 'WiFi', 'type' => 'net-wifi');
    }

    $agents[] = compact(
        'pc',
        'reportFolderName',
        'id',
        'hw',
        'net',
        'spd',
        'sw',
        'vpn',
        'av',
        'proc',
        'lu',
        'f9soft',
        'f9v',
        'f9any',
        'hasOtherVoip',
        'voipOthers',
        'conn',
        'isCable',
        'isWifi',
        'vpa',
        'vpl',
        'avr',
        'tmb',
        'mbps',
        'isOnline',
        'isWarn',
        'agoText',
        'hbF9',
        'hbF9svc',
        'hbCpu',
        'hbRam',
        'wdSev',
        'wdIssues',
        'cardTone',
        'tagList',
        'folder'
    );
}

$total = count($agents);
$online = count(array_filter($agents, function ($a) { return $a['isOnline']; }));
$offline = $total - $online;
$f9softCount = count(array_filter($agents, function ($a) { return $a['f9soft']; }));
$f9liveCount = count(array_filter($agents, function ($a) { return !empty($a['hbF9']); }));
$otherVoipCount = count(array_filter($agents, function ($a) { return !empty($a['hasOtherVoip']); }));
$vpnCount = count(array_filter($agents, function ($a) { return !empty($a['vpa']); }));
$critical = count(array_filter($agents, function ($a) { return $a['wdSev'] === 'critical'; }));
$warning = count(array_filter($agents, function ($a) { return $a['wdSev'] === 'warning'; }));

$liveEvents = gau_read_recent_events($hbDir, 200, true);
$agentProfilesByHost = array();
foreach ($agents as $ag) {
    $host = strtoupper((string) ($ag['pc'] ?? ''));
    if ($host === '') {
        continue;
    }
    $agentProfilesByHost[$host] = array(
        'has_five9' => !empty($ag['f9any']),
        'has_vpn' => !empty($ag['vpa']),
        'five9_live' => !empty($ag['hbF9'])
    );
}

$liveBuckets = array('five9' => array(), 'vpn' => array(), 'other' => array());
foreach ($liveEvents as $ev) {
    $bucket = gau_alert_bucket($ev, $agentProfilesByHost);
    if ($bucket !== null && isset($liveBuckets[$bucket])) {
        $liveBuckets[$bucket][] = $ev;
    }
}

$agentProfilesJson = json_encode($agentProfilesByHost, JSON_UNESCAPED_UNICODE);
$cursorData = gau_read_json($hbDir . '/_events_index.json', array('last_id' => 0));
$lastEventId = (int) ($cursorData['last_id'] ?? 0);
?>
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GSD GAU | Live Dashboard v<?=$version?></title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css" rel="stylesheet">
<style>
:root{--gsd-dark:#0d1b3e;--gsd-blue:#1a237e;--gsd-cyan:#00d4ff}
body{background:#f0f2f5;font-family:'Segoe UI',sans-serif;font-size:.9rem}
.navbar{background:var(--gsd-blue);border-bottom:3px solid var(--gsd-cyan)}
.stat-bar{background:var(--gsd-dark);color:#fff;padding:8px 0;font-size:.78rem}
.filter-bar{background:#fff;border-bottom:1px solid #e5e7eb;padding:10px 0;position:sticky;top:0;z-index:100}
.fb{font-size:.73rem;padding:4px 12px;border-radius:20px;border:1px solid #d1d5db;background:#fff;color:#374151;cursor:pointer;transition:.15s;white-space:nowrap}
.fb:hover{background:#f3f4f6}.fb.on{background:var(--gsd-blue);color:#fff;border-color:var(--gsd-blue)}
.fb.og{background:#10b981;color:#fff;border-color:#10b981}.fb.or{background:#ef4444;color:#fff;border-color:#ef4444}
.fb.oy{background:#f59e0b;color:#fff;border-color:#f59e0b}.fb.ob{background:#3b82f6;color:#fff;border-color:#3b82f6}
.fb.ov{background:#8b5cf6;color:#fff;border-color:#8b5cf6}
.si{font-size:.8rem;border-radius:20px;padding:5px 14px;border:1px solid #d1d5db;max-width:220px}
.ac-card{background:#fff;border-radius:12px;border:none;box-shadow:0 2px 8px rgba(0,0,0,.07);transition:.2s;position:relative;overflow:hidden}
.ac-card:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,.1)}
.ca{height:4px;border-radius:12px 12px 0 0;background:var(--gsd-cyan)}.ca.bad{background:#ef4444}
.ac-card.tone-five9{background:#eff6ff;border:1px solid #bfdbfe}
.ac-card.tone-five9 .ca{background:#2563eb}
.ac-card.tone-voip{background:#ecfdf5;border:1px solid #a7f3d0}
.ac-card.tone-voip .ca{background:#10b981}
.ac-card.vpn-active{box-shadow:0 0 0 2px #c4b5fd inset}
.status-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:4px}
.dot-on{background:#10b981;box-shadow:0 0 6px #10b981;animation:blink 2s infinite}
.dot-warn{background:#f59e0b;animation:blink 1s infinite}
.dot-off{background:#ef4444}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}
.kv{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #f1f1f1;font-size:.82rem}.kv:last-child{border-bottom:none}.kv .k{color:#6c757d}.kv .v{font-weight:500;max-width:65%;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.f9b{font-size:.63rem;padding:2px 7px;border-radius:10px;font-weight:600}
.f9ok{background:#d1fae5;color:#065f46}.f9no{background:#fee2e2;color:#991b1b}.f9on{background:#dbeafe;color:#1e40af;animation:blink 2s infinite}
.tg{font-size:.62rem;padding:2px 8px;border-radius:999px;font-weight:700;letter-spacing:.01em}
.tg-five9{background:#dbeafe;color:#1d4ed8}
.tg-voip{background:#dcfce7;color:#166534}
.tg-vpn{background:#ede9fe;color:#6d28d9}
.tg-net-cable{background:#cffafe;color:#0e7490}
.tg-net-wifi{background:#fef3c7;color:#92400e}
.pw{background:#d1fae5;color:#065f46;font-size:.68rem;padding:2px 8px;border-radius:20px;font-weight:600}
.pwf{background:#fef3c7;color:#92400e;font-size:.68rem;padding:2px 8px;border-radius:20px;font-weight:600}
.alert-strip{padding:4px 10px;font-size:.72rem;border-radius:6px;margin-bottom:4px}
.as-crit{background:#fee2e2;color:#991b1b;border-left:3px solid #ef4444}
.as-warn{background:#fef3c7;color:#92400e;border-left:3px solid #f59e0b}
.lu{font-size:.68rem;color:#9ca3af}
.live-card{border:0;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.live-row{padding:10px 12px;border-bottom:1px solid #eef2f7;font-size:.8rem}
.live-row:last-child{border-bottom:none}
.live-time{font-size:.68rem;color:#6b7280}
.live-pill{font-size:.62rem;padding:2px 7px;border-radius:10px;font-weight:700;text-transform:uppercase}
.live-ico{font-size:.88rem;margin-right:6px}
.pill-critical{background:#fee2e2;color:#991b1b}
.pill-warning{background:#fef3c7;color:#92400e}
.pill-info{background:#dbeafe;color:#1e40af}
.pill-ok{background:#d1fae5;color:#065f46}
.live-ind{font-size:.72rem}
.layout-wrap{padding-inline:14px}
.alerts-sidebar{position:sticky;top:122px}
.alerts-group{border-top:1px solid #eef2f7}
.alerts-group:first-child{border-top:none}
.alerts-group-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;font-size:.77rem;font-weight:700}
.alerts-five9 .alerts-group-head{background:#eff6ff;color:#1d4ed8}
.alerts-vpn .alerts-group-head{background:#f5f3ff;color:#6d28d9}
.alerts-other .alerts-group-head{background:#f3f4f6;color:#374151}
.alerts-body{max-height:calc((100vh - 280px)/3);overflow:auto}
.alerts-empty{padding:12px;color:#6b7280;font-size:.82rem}
.modal-header{background:var(--gsd-blue)}
.toast-wrap{position:fixed;top:88px;right:12px;z-index:1100}
.refresh-btn{font-size:.75rem;padding:2px 10px;border-radius:15px;border:1px solid rgba(255,255,255,.3);color:#fff;background:transparent;cursor:pointer}
.refresh-btn:hover{background:rgba(255,255,255,.1)}
@media (max-width: 1199px){
.layout-wrap{padding-inline:0}
.alerts-sidebar{position:static;top:auto}
.alerts-body{max-height:220px}
}
</style>
</head>
<body>

<nav class="navbar navbar-dark px-4 py-2 shadow-sm mb-0">
<span class="navbar-brand fw-bold"><i class="bi bi-shield-lock-fill text-info me-2"></i>GAU LIVE DASHBOARD <span class="badge bg-info text-dark ms-2" style="font-size:.65rem">v<?=$version?></span></span>
<div class="d-flex align-items-center gap-3">
<a href="dashboard_full.php" class="refresh-btn text-decoration-none"><i class="bi bi-journal-richtext me-1"></i>Full Report</a>
<button class="refresh-btn" onclick="location.reload()"><i class="bi bi-arrow-clockwise me-1"></i>Refresh</button>
<span class="text-light" style="font-size:.75rem"><i class="bi bi-clock me-1"></i><?=date('Y-m-d H:i:s')?> COT</span>
</div>
</nav>

<div class="stat-bar"><div class="container d-flex gap-3 flex-wrap">
<span><span class="status-dot dot-on"></span>Online: <b id="st-online"><?=$online?></b></span>
<span><span class="status-dot dot-off"></span>Offline: <b id="st-offline"><?=$offline?></b></span>
<span><i class="bi bi-people-fill text-info me-1"></i>Total: <b id="st-total"><?=$total?></b></span>
<span style="color:#00d4ff"><i class="bi bi-headset me-1"></i>Softphone: <b><?=$f9softCount?>/<?=$total?></b></span>
<span style="color:#60a5fa"><i class="bi bi-broadcast me-1"></i>Five9 Live: <b><?=$f9liveCount?></b></span>
<span style="color:#22c55e"><i class="bi bi-telephone-inbound me-1"></i>Otro VoIP: <b><?=$otherVoipCount?></b></span>
<span style="color:#a78bfa"><i class="bi bi-shield-lock me-1"></i>VPN: <b><?=$vpnCount?></b></span>
<?php if($critical):?><span class="text-danger"><i class="bi bi-exclamation-octagon-fill me-1"></i>Critical: <b><?=$critical?></b></span><?php endif;?>
<?php if($warning):?><span style="color:#fbbf24"><i class="bi bi-exclamation-triangle-fill me-1"></i>Warning: <b><?=$warning?></b></span><?php endif;?>
<span><i class="bi bi-broadcast-pin me-1"></i>Live poll: <span id="pollStatus">iniciando</span></span>
</div></div>

<div class="filter-bar shadow-sm"><div class="container d-flex gap-2 flex-wrap align-items-center">
<input type="text" class="si" id="si" placeholder="Buscar...">
<span style="color:#d1d5db;margin:0 2px">|</span>
<button class="fb on" onclick="sf('all',this)">Todos</button>
<button class="fb" onclick="sf('online',this)" style="border-color:#10b981">Online</button>
<button class="fb" onclick="sf('offline',this)" style="border-color:#ef4444">Offline</button>
<span style="color:#d1d5db">|</span>
<button class="fb" onclick="sf('f9soft',this)" style="border-color:#0ea5e9">Five9 Softphone</button>
<button class="fb" onclick="sf('f9no',this)" style="border-color:#ef4444">Sin Softphone</button>
<button class="fb" onclick="sf('f9live',this)" style="border-color:#3b82f6">Five9 Live</button>
<button class="fb" onclick="sf('voip',this)" style="border-color:#22c55e">Otro VoIP</button>
<button class="fb" onclick="sf('vpn',this)" style="border-color:#a78bfa">VPN</button>
<span style="color:#d1d5db">|</span>
<button class="fb" onclick="sf('crit',this)" style="border-color:#ef4444">Critical</button>
<button class="fb" onclick="sf('warn',this)" style="border-color:#f59e0b">Warning</button>
</div></div>

<div class="container-fluid mt-3 layout-wrap">
<div class="row g-3 align-items-start">
<div class="col-xxl-9 col-xl-8">
<?php if(!$agents):?>
<div class="text-center py-5 text-muted"><i class="bi bi-inbox" style="font-size:3rem"></i><p class="mt-3">Sin reportes ni heartbeats.</p></div>
<?php else:?>
<div class="row g-3" id="grid">
<?php foreach($agents as $a): $pc=$a['pc'];$id=$a['id'];$hw=$a['hw'];$net=$a['net'];$sw=$a['sw'];?>
<div class="col-xxl-4 col-lg-6 ac"
 data-host="<?=strtolower($pc)?>"
 data-n="<?=strtolower((string)($id['Nombre']??$pc))?>" data-h="<?=strtolower($pc)?>" data-i="<?=strtolower((string)($id['ISP']??''))?>"
 data-f9soft="<?=$a['f9soft']?'y':'n'?>" data-f9live="<?=$a['hbF9']?'y':'n'?>"
 data-voip="<?=$a['hasOtherVoip']?'y':'n'?>" data-vpn="<?=$a['vpa']?'y':'n'?>"
 data-online="<?=$a['isOnline']?'y':($a['isWarn']?'w':'n')?>"
 data-sev="<?=$a['wdSev']?>" data-c="<?=$a['conn']?>">
<div class="ac-card h-100 <?=$a['cardTone']?> <?=$a['vpa']?'vpn-active':''?>"><div class="ca <?=!$a['f9soft']?'bad':''?>"></div><div class="p-3">
<div class="d-flex justify-content-between align-items-start mb-1">
<div><div class="d-flex align-items-center gap-1">
<span class="status-dot <?=$a['isOnline']?'dot-on':($a['isWarn']?'dot-warn':'dot-off')?>"></span>
<span class="fw-bold text-primary" style="font-size:.88rem"><?=htmlspecialchars((string)($id['Nombre']??$pc))?></span>
</div><div class="text-muted" style="font-size:.7rem"><?=htmlspecialchars($pc)?> &bull; <span class="ago-text"><?=$a['agoText']?></span></div>
<div class="d-flex gap-1 mt-1 flex-wrap">
<?php foreach (($a['tagList'] ?? array()) as $tg): ?>
<span class="tg tg-<?=htmlspecialchars((string)($tg['type'] ?? ''))?>"><?=htmlspecialchars((string)($tg['label'] ?? 'Tag'))?></span>
<?php endforeach; ?>
</div>
</div>
<?php if($a['isCable']):?><span class="pw"><i class="bi bi-ethernet me-1"></i>CABLE</span>
<?php elseif($a['isWifi']):?><span class="pwf"><i class="bi bi-wifi me-1"></i>WIFI</span><?php endif;?>
</div>

<div class="d-flex gap-1 mb-2 flex-wrap">
<?php if($a['f9soft']):?><span class="f9b f9ok"><i class="bi bi-headset me-1"></i>Softphone <?=htmlspecialchars((string)$a['f9v'])?></span>
<?php else:?><span class="f9b f9no"><i class="bi bi-telephone-x me-1"></i>Sin Softphone</span><?php endif;?>
<?php if($a['hbF9']):?><span class="f9b f9on"><i class="bi bi-broadcast me-1"></i>Live</span><?php endif;?>
<?php if($a['hbF9svc']):?><span class="f9b" style="background:#dbeafe;color:#1e40af"><i class="bi bi-gear me-1"></i>Svc OK</span><?php endif;?>
<?php if($a['hasOtherVoip']):?><span class="f9b" style="background:#dcfce7;color:#166534"><i class="bi bi-telephone-inbound me-1"></i><?=htmlspecialchars(implode(', ',array_slice($a['voipOthers'],0,2)))?></span><?php endif;?>
</div>

<?php if($a['wdSev']==='critical'):?><div class="alert-strip as-crit"><i class="bi bi-exclamation-octagon-fill me-1"></i><?=htmlspecialchars(implode(' | ',array_slice($a['wdIssues'],0,2)))?></div>
<?php elseif($a['wdSev']==='warning'):?><div class="alert-strip as-warn"><i class="bi bi-exclamation-triangle-fill me-1"></i><?=htmlspecialchars(implode(' | ',array_slice($a['wdIssues'],0,2)))?></div>
<?php endif;?>

<div class="row g-1 text-center mb-2">
<div class="col-3 bg-light rounded py-1"><div style="font-size:.6rem;color:#6c757d">DOWN</div><div style="font-size:.8rem;font-weight:600"><?=$a['mbps']>0?$a['mbps'].'<small>Mbps</small>':'<span class="text-danger">-</span>'?></div></div>
<div class="col-3 rounded py-1" style="background:<?=$a['f9soft']?'#d1fae5':'#fee2e2'?>"><div style="font-size:.6rem;color:<?=$a['f9soft']?'#065f46':'#991b1b'?>">SOFT</div><div style="font-size:.8rem;font-weight:600;color:<?=$a['f9soft']?'#065f46':'#991b1b'?>"><?=$a['f9soft']?'v'.$a['f9v']:'<i class="bi bi-x-circle"></i>'?></div></div>
<div class="col-3 bg-light rounded py-1"><div style="font-size:.6rem;color:#6c757d">CPU</div><div style="font-size:.8rem;font-weight:600;color:<?=($a['hbCpu']??0)>80?'#ef4444':'inherit'?>"><?=$a['hbCpu']!==null?$a['hbCpu'].'%':'-'?></div></div>
<div class="col-3 bg-light rounded py-1"><div style="font-size:.6rem;color:#6c757d">RAM</div><div style="font-size:.8rem;font-weight:600;color:<?=($a['hbRam']??0)>85?'#ef4444':'inherit'?>"><?=$a['hbRam']!==null?$a['hbRam'].'%':($hw['RAM_Total_GB']??'?').'G'?></div></div>
</div>

<div class="kv"><span class="k">ISP</span><span class="v"><?=htmlspecialchars((string)($id['ISP']??'N/A'))?></span></div>
<div class="kv"><span class="k">IP</span><span class="v"><?=htmlspecialchars((string)($net['IP_Publica']??'N/A'))?></span></div>
<div class="kv"><span class="k">Chrome</span><span class="v"><?=htmlspecialchars((string)($sw['Chrome_Version']??'N/A'))?></span></div>
<div class="kv"><span class="k">VPN</span><span class="v"><?=$a['vpl']?'<span class="badge bg-warning text-dark" style="font-size:.7rem">'.htmlspecialchars((string)$a['vpl']).'</span>':'<span class="badge bg-secondary" style="font-size:.7rem">No</span>'?></span></div>
<div class="kv"><span class="k">AV</span><span class="v"><?=$a['avr']?'<span class="badge bg-success" style="font-size:.7rem">RT On</span>':'<span class="badge bg-danger" style="font-size:.7rem">RT Off</span>'?></span></div>
<div class="kv"><span class="k">Teams</span><span class="v"><?=$a['tmb']>0?'<span class="badge bg-warning text-dark" style="font-size:.7rem">'.$a['tmb'].' MB</span>':'<span class="badge bg-success" style="font-size:.7rem">Off</span>'?></span></div>
<div class="kv"><span class="k">Modelo</span><span class="v"><?=htmlspecialchars((string)($hw['Modelo']??'N/A'))?></span></div>
<?php if($a['lu']):?><div class="lu mt-1 text-end"><i class="bi bi-clock me-1"></i>Scan: <?=htmlspecialchars(trim((string)$a['lu']))?></div><?php endif;?>
</div>
<div class="px-3 pb-3 d-flex gap-2">
<button class="btn btn-primary btn-sm w-100 rounded-pill" onclick="vr('<?=htmlspecialchars($a['reportFolderName'])?>','<?=htmlspecialchars($pc)?>')"><i class="bi bi-file-earmark-medical me-1"></i>Resumen</button>
<a class="btn btn-outline-secondary btn-sm rounded-pill" href="dashboard_full.php?pc=<?=urlencode((string)$pc)?>" target="_blank"><i class="bi bi-journal-text"></i></a>
</div>
</div></div>
<?php endforeach;?>
</div>
<?php endif;?>
</div>
<div class="col-xxl-3 col-xl-4">
<div class="card live-card alerts-sidebar">
<div class="card-header d-flex justify-content-between align-items-center py-2">
<div class="fw-semibold"><i class="bi bi-bell-fill text-warning me-1"></i>Alertas en vivo</div>
<div class="live-ind d-flex align-items-center gap-1">
<span class="badge bg-secondary" id="liveCountTotal"><?=count($liveBuckets['five9']) + count($liveBuckets['vpn']) + count($liveBuckets['other'])?></span>
<span id="liveState" class="badge text-bg-secondary">Esperando...</span>
</div>
</div>
<div class="card-body p-0" id="livePanels">
<div class="alerts-group alerts-five9">
<div class="alerts-group-head"><span><i class="bi bi-headset me-1"></i>Five9</span><span class="badge bg-primary" id="liveCountFive9"><?=count($liveBuckets['five9'])?></span></div>
<div class="alerts-body" id="liveEventsFive9">
<?php if (empty($liveBuckets['five9'])): ?>
<div class="alerts-empty" id="liveEmptyFive9">Sin alertas Five9.</div>
<?php else: ?>
<?php foreach ($liveBuckets['five9'] as $ev):
$sev = strtolower((string) ($ev['severity'] ?? 'info'));
$pill = $sev === 'critical' ? 'pill-critical' : ($sev === 'warning' ? 'pill-warning' : ($sev === 'ok' ? 'pill-ok' : 'pill-info'));
$host = htmlspecialchars((string) ($ev['hostname'] ?? 'N/A'));
$cat = htmlspecialchars((string) ($ev['category'] ?? 'system_issue'));
$msg = htmlspecialchars((string) ($ev['message'] ?? ($ev['event_name'] ?? 'evento')));
$time = htmlspecialchars((string) ($ev['server_time'] ?? $ev['received_at'] ?? ''));
$ico = htmlspecialchars(gau_alert_icon($ev));
$hRaw = strtoupper((string) ($ev['hostname'] ?? ''));
$f9Live = !empty($agentProfilesByHost[$hRaw]['five9_live']);
$eid = (int) ($ev['event_id'] ?? 0);
?>
<div class="live-row" data-eid="<?=$eid?>" data-group="five9">
<div class="d-flex justify-content-between align-items-start gap-2">
<div>
<div><span class="live-pill <?=$pill?>"><?=$sev?></span> <b><?=$host?></b> <span class="text-muted">/ <?=$cat?></span> <span class="badge <?=$f9Live ? 'bg-success' : 'bg-secondary'?>" style="font-size:.62rem"><?=$f9Live ? 'F9 Live' : 'F9 Off'?></span></div>
<div><i class="bi <?=$ico?> live-ico"></i><?=$msg?></div>
</div>
<div class="live-time"><?=$time?></div>
</div>
</div>
<?php endforeach; ?>
<?php endif; ?>
</div>
</div>

<div class="alerts-group alerts-vpn">
<div class="alerts-group-head"><span><i class="bi bi-shield-lock me-1"></i>VPN</span><span class="badge bg-secondary" id="liveCountVpn"><?=count($liveBuckets['vpn'])?></span></div>
<div class="alerts-body" id="liveEventsVpn">
<?php if (empty($liveBuckets['vpn'])): ?>
<div class="alerts-empty" id="liveEmptyVpn">Sin alertas VPN.</div>
<?php else: ?>
<?php foreach ($liveBuckets['vpn'] as $ev):
$sev = strtolower((string) ($ev['severity'] ?? 'info'));
$pill = $sev === 'critical' ? 'pill-critical' : ($sev === 'warning' ? 'pill-warning' : ($sev === 'ok' ? 'pill-ok' : 'pill-info'));
$host = htmlspecialchars((string) ($ev['hostname'] ?? 'N/A'));
$cat = htmlspecialchars((string) ($ev['category'] ?? 'system_issue'));
$msg = htmlspecialchars((string) ($ev['message'] ?? ($ev['event_name'] ?? 'evento')));
$time = htmlspecialchars((string) ($ev['server_time'] ?? $ev['received_at'] ?? ''));
$ico = htmlspecialchars(gau_alert_icon($ev));
$eid = (int) ($ev['event_id'] ?? 0);
?>
<div class="live-row" data-eid="<?=$eid?>" data-group="vpn">
<div class="d-flex justify-content-between align-items-start gap-2">
<div>
<div><span class="live-pill <?=$pill?>"><?=$sev?></span> <b><?=$host?></b> <span class="text-muted">/ <?=$cat?></span></div>
<div><i class="bi <?=$ico?> live-ico"></i><?=$msg?></div>
</div>
<div class="live-time"><?=$time?></div>
</div>
</div>
<?php endforeach; ?>
<?php endif; ?>
</div>
</div>

<div class="alerts-group alerts-other">
<div class="alerts-group-head"><span><i class="bi bi-pc-display-horizontal me-1"></i>Otros Equipos</span><span class="badge bg-dark" id="liveCountOther"><?=count($liveBuckets['other'])?></span></div>
<div class="alerts-body" id="liveEventsOther">
<?php if (empty($liveBuckets['other'])): ?>
<div class="alerts-empty" id="liveEmptyOther">Sin alertas de conectividad/rendimiento.</div>
<?php else: ?>
<?php foreach ($liveBuckets['other'] as $ev):
$sev = strtolower((string) ($ev['severity'] ?? 'info'));
$pill = $sev === 'critical' ? 'pill-critical' : ($sev === 'warning' ? 'pill-warning' : ($sev === 'ok' ? 'pill-ok' : 'pill-info'));
$host = htmlspecialchars((string) ($ev['hostname'] ?? 'N/A'));
$cat = htmlspecialchars((string) ($ev['category'] ?? 'system_issue'));
$msg = htmlspecialchars((string) ($ev['message'] ?? ($ev['event_name'] ?? 'evento')));
$time = htmlspecialchars((string) ($ev['server_time'] ?? $ev['received_at'] ?? ''));
$ico = htmlspecialchars(gau_alert_icon($ev));
$eid = (int) ($ev['event_id'] ?? 0);
?>
<div class="live-row" data-eid="<?=$eid?>" data-group="other">
<div class="d-flex justify-content-between align-items-start gap-2">
<div>
<div><span class="live-pill <?=$pill?>"><?=$sev?></span> <b><?=$host?></b> <span class="text-muted">/ <?=$cat?></span></div>
<div><i class="bi <?=$ico?> live-ico"></i><?=$msg?></div>
</div>
<div class="live-time"><?=$time?></div>
</div>
</div>
<?php endforeach; ?>
<?php endif; ?>
</div>
</div>
</div>
</div>
</div>
</div>
</div>

<div class="modal fade" id="dm" tabindex="-1"><div class="modal-dialog modal-xl modal-dialog-scrollable"><div class="modal-content border-0 shadow"><div class="modal-header py-2"><h6 class="modal-title text-white fw-bold mb-0"><i class="bi bi-file-earmark-medical me-2"></i><span id="mp"></span></h6><button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div><div class="modal-body bg-light p-0" id="mb"></div></div></div></div>

<div class="toast-wrap" id="toastWrap"></div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
let cf='all';
let lastEventId=<?=$lastEventId?>;
const agentProfiles=<?=$agentProfilesJson ?: '{}';?>;
const seenEventIds=new Set(Array.from(document.querySelectorAll('#livePanels .live-row[data-eid]')).map(x=>Number(x.dataset.eid)||0));

function sf(f,b){cf=f;document.querySelectorAll('.fb').forEach(x=>x.className='fb');
const c=f==='f9no'||f==='offline'||f==='crit'?'or':f==='f9soft'||f==='online'||f==='voip'?'og':f==='warn'?'oy':f==='f9live'?'ob':f==='vpn'?'ov':'on';
b.classList.add('fb',c);af()}
function af(){const s=document.getElementById('si').value.toLowerCase();
document.querySelectorAll('.ac').forEach(c=>{const n=c.dataset.n,h=c.dataset.h,i=c.dataset.i,fs=c.dataset.f9soft,fl=c.dataset.f9live,ol=c.dataset.online,sv=c.dataset.sev,vp=c.dataset.vpn,vo=c.dataset.voip;
let ms=!s||n.includes(s)||h.includes(s)||i.includes(s);
let mf=true;switch(cf){case'online':mf=ol==='y';break;case'offline':mf=ol==='n';break;case'f9soft':mf=fs==='y';break;case'f9no':mf=fs==='n';break;case'f9live':mf=fl==='y';break;case'voip':mf=vo==='y';break;case'vpn':mf=vp==='y';break;case'crit':mf=sv==='critical';break;case'warn':mf=sv==='warning';break}
c.style.display=ms&&mf?'':'none'})}
document.getElementById('si').addEventListener('input',af);

function sevPill(sev){const s=(sev||'info').toLowerCase();if(s==='critical')return'pill-critical';if(s==='warning')return'pill-warning';if(s==='ok')return'pill-ok';return'pill-info'}
function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m]))}
function normHost(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9\-_]/g,'')}
function evtText(ev){
  const issues=Array.isArray(ev?.issues)?ev.issues.join(' | '):String(ev?.issues||'');
  return `${ev?.category||''} | ${ev?.event_name||''} | ${ev?.message||''} | ${issues}`.toLowerCase();
}
function isFive9Related(ev){return /five9|softphone|gateway\.five9|api\.five9/.test(evtText(ev))}
function isOtherRelevant(ev){return /descon|disconnect|offline|sin red|latencia|ping|packet|loss|dns|gateway|internet|speedtest|download|upload|cpu|ram|memoria|memory|procesador/.test(evtText(ev))}
function alertIcon(ev){
  const t=evtText(ev);
  if(/five9|softphone/.test(t)) return 'bi-headset';
  if(/vpn|anyconnect|openvpn|forticlient|globalprotect|pulse/.test(t)) return 'bi-shield-lock';
  if(/descon|disconnect|offline|sin red/.test(t)) return 'bi-plug';
  if(/latencia|ping|packet|loss|dns|gateway|internet|speedtest|download|upload/.test(t)) return 'bi-wifi-off';
  if(/cpu|procesador/.test(t)) return 'bi-cpu';
  if(/ram|memoria|memory/.test(t)) return 'bi-bar-chart-line';
  if(/audio|sound|microphone|mic/.test(t)) return 'bi-mic-mute';
  return 'bi-exclamation-triangle';
}
function classifyLiveGroup(ev){
  const host=normHost(ev?.hostname||'');
  const profile=agentProfiles[host]||{has_five9:false,has_vpn:false};
  const five9=isFive9Related(ev);
  if(profile.has_five9) return 'five9';
  if(profile.has_vpn) return five9 ? null : 'vpn';
  if(five9) return null;
  return isOtherRelevant(ev) ? 'other' : null;
}
function updateLiveCount(){
  const five9=document.querySelectorAll('#liveEventsFive9 .live-row').length;
  const vpn=document.querySelectorAll('#liveEventsVpn .live-row').length;
  const other=document.querySelectorAll('#liveEventsOther .live-row').length;
  const total=five9+vpn+other;
  const bT=document.getElementById('liveCountTotal');
  const bF=document.getElementById('liveCountFive9');
  const bV=document.getElementById('liveCountVpn');
  const bO=document.getElementById('liveCountOther');
  if(bT) bT.textContent=String(total);
  if(bF) bF.textContent=String(five9);
  if(bV) bV.textContent=String(vpn);
  if(bO) bO.textContent=String(other);
}

function addLiveEvent(ev){
  const group=classifyLiveGroup(ev);
  if(!group) return;
  const eid=Number(ev.event_id||0);
  if(eid&&seenEventIds.has(eid)) return;
  if(eid) seenEventIds.add(eid);

  const map={five9:'liveEventsFive9',vpn:'liveEventsVpn',other:'liveEventsOther'};
  const empties={five9:'liveEmptyFive9',vpn:'liveEmptyVpn',other:'liveEmptyOther'};
  const live=document.getElementById(map[group]);
  const empty=document.getElementById(empties[group]);
  if(!live) return;
  if(empty) empty.remove();

  const row=document.createElement('div');
  row.className='live-row';
  row.dataset.group=group;
  if(eid) row.dataset.eid=eid;

  const sev=(ev.severity||'info').toLowerCase();
  const host=esc(ev.hostname||'N/A');
  const cat=esc(ev.category||'system_issue');
  const msg=esc(ev.message||ev.event_name||'evento');
  const time=esc(ev.server_time||ev.received_at||'');
  const ico=alertIcon(ev);
  const hostKey=normHost(ev.hostname||'');
  const p=agentProfiles[hostKey]||{five9_live:false};
  const f9Badge=group==='five9' ? `<span class="badge ${p.five9_live?'bg-success':'bg-secondary'}" style="font-size:.62rem">${p.five9_live?'F9 Live':'F9 Off'}</span>` : '';
  row.innerHTML=`<div class="d-flex justify-content-between align-items-start gap-2"><div><div><span class="live-pill ${sevPill(sev)}">${esc(sev)}</span> <b>${host}</b> <span class="text-muted">/ ${cat}</span> ${f9Badge}</div><div><i class="bi ${ico} live-ico"></i>${msg}</div></div><div class="live-time">${time}</div></div>`;
  live.prepend(row);

  while(live.querySelectorAll('.live-row').length>150){live.removeChild(live.lastElementChild)}
  updateLiveCount();

  if(sev==='critical'||sev==='warning'||(ev.category||'')==='operational'){
    showToast(ev);
  }
}

function showToast(ev){
  const wrap=document.getElementById('toastWrap');
  const sev=(ev.severity||'info').toLowerCase();
  const cls=sev==='critical'?'text-bg-danger':sev==='warning'?'text-bg-warning':'text-bg-primary';
  const toast=document.createElement('div');
  toast.className='toast align-items-center border-0 mb-2';
  toast.setAttribute('role','alert');
  toast.innerHTML=`<div class="d-flex ${cls}"><div class="toast-body"><b>${esc(ev.hostname||'N/A')}</b> - ${esc(ev.message||ev.event_name||'evento')}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  wrap.appendChild(toast);
  const t=new bootstrap.Toast(toast,{delay:5000});
  t.show();
  toast.addEventListener('hidden.bs.toast',()=>toast.remove());
}

async function pollEvents(){
  try{
    const r=await fetch(`api/heartbeat.php?action=events_since&since_id=${lastEventId}&only_relevant=1&limit=120&v=${Date.now()}`,{cache:'no-store'});
    if(!r.ok) throw new Error('http '+r.status);
    const d=await r.json();
    if(d && Array.isArray(d.events)){
      d.events.forEach(addLiveEvent);
      if(Number(d.next_since||0)>lastEventId){
        lastEventId=Number(d.next_since||0);
      }else if(Number(d.last_id||0)>lastEventId && d.events.length===0){
        lastEventId=Number(d.last_id||0);
      }
    }
    document.getElementById('liveState').className='badge text-bg-success';
    document.getElementById('liveState').textContent='Conectado';
    document.getElementById('pollStatus').textContent='ok';
  }catch(e){
    document.getElementById('liveState').className='badge text-bg-danger';
    document.getElementById('liveState').textContent='Sin respuesta';
    document.getElementById('pollStatus').textContent='error';
  }
}

async function refreshStats(){
  try{
    const r=await fetch('api/heartbeat.php?action=status&v='+Date.now(),{cache:'no-store'});
    if(!r.ok)return;
    const d=await r.json();
    if(d&&d.status==='ok'){
      document.getElementById('st-online').textContent=d.online??'-';
      document.getElementById('st-offline').textContent=d.offline??'-';
      document.getElementById('st-total').textContent=d.total??'-';
    }
  }catch{}
}

function toArr(v){if(!v)return[];if(Array.isArray(v))return v;if(typeof v==='object'&&Array.isArray(v.value))return v.value;if(typeof v==='object'&&Object.keys(v).length>0)return[v];return[]}
async function lj(u){try{const r=await fetch(u+'?v='+Date.now());if(!r.ok)return null;return JSON.parse((await r.text()).replace(/^\uFEFF/,'').trim())}catch{return null}}
function lc(m){if(!m||isNaN(m))return'secondary';return m<50?'success':m<100?'warning':'danger'}
function rLat(l){const a=toArr(l?.value??l);if(!a.length)return'<div class="text-muted p-2">Sin datos.</div>';return`<table class="table table-sm mb-0" style="font-size:.8rem"><thead><tr><th>Destino</th><th>Host</th><th>Lat</th><th>Loss</th></tr></thead><tbody>${a.map(x=>`<tr><td>${x.Destino??''}</td><td><code>${x.Host??''}</code></td><td><span class="badge bg-${lc(x.Latencia_ms)}">${x.Latencia_ms} ms</span></td><td>${x.PktLoss_pct??x.PktLoss??0}%</td></tr>`).join('')}</tbody></table>`}
function rSw(l){const a=toArr(l);if(!a.length)return'<div class="text-muted p-2">Sin datos.</div>';return`<table class="table table-sm table-striped mb-0" style="font-size:.78rem"><thead><tr><th>Nombre</th><th>Version</th><th>Editor</th></tr></thead><tbody>${a.map(s=>`<tr><td>${s.Nombre??''}</td><td>${s.Version??''}</td><td>${s.Editor??''}</td></tr>`).join('')}</tbody></table>`}
function rLog(l,lb){const a=toArr(l);if(!a.length)return`<div class="text-muted p-2">Sin errores ${lb}.</div>`;return a.map(x=>`<div class="p-2 border-bottom"><span class="text-danger fw-semibold">[${x.Fecha??'?'}]</span> ${(x.Message??x.ProviderName??'').substring(0,240)}</div>`).join('')}

async function vr(folderName, displayHost){
  const pc=(displayHost||folderName||'').toUpperCase();
  const m=new bootstrap.Modal(document.getElementById('dm'));
  document.getElementById('mp').innerText=pc;
  const b=document.getElementById('mb');
  b.innerHTML='<div class="text-center p-5"><div class="spinner-border text-primary"></div></div>';
  m.show();

  const p='api/reportes/'+folderName+'/';
  const [id,hw,net,spd,sw,aud,vpn,av,upd,proc,logs,conn,hbHist,wdHist]=await Promise.all([
    lj(p+'0_Identidad.json'),lj(p+'1_Hardware.json'),lj(p+'2_Red.json'),lj(p+'3_SpeedTest.json'),lj(p+'4_Software.json'),lj(p+'5_Audio.json'),
    lj(p+'6_VPN_QoS.json'),lj(p+'7_Antivirus.json'),lj(p+'8_WindowsUpdate.json'),lj(p+'9_Procesos.json'),lj(p+'11_Logs_Forenses.json'),lj(p+'12_Connectivity.json'),
    lj('api/heartbeat.php?action=history&type=heartbeat&hostname='+encodeURIComponent(pc)),
    lj('api/heartbeat.php?action=history&type=watchdog&hostname='+encodeURIComponent(pc))
  ]);

  const mbps=spd?.Download_Mbps??0,mc=mbps>=10?'success':mbps>=5?'warning':'danger';
  const vp=toArr(vpn?.VPN_Procesos),vn=vp.length?(vp[0].ProcessName??'Activa'):'No';
  const wdTimeline=Array.isArray(wdHist)?wdHist.slice(0,30):[];
  const hbTimeline=Array.isArray(hbHist)?hbHist.slice(0,30):[];

  b.innerHTML=`
  <div class="p-3">
    <div class="row g-3">
      <div class="col-md-4">
        <h6>Agente</h6>
        <div class="kv"><span class="k">Nombre</span><span class="v">${id?.Nombre??pc}</span></div>
        <div class="kv"><span class="k">Email</span><span class="v">${id?.Email??'N/A'}</span></div>
        <div class="kv"><span class="k">Extension</span><span class="v">${id?.Extension??'N/A'}</span></div>
        <div class="kv"><span class="k">ISP</span><span class="v">${id?.ISP??'N/A'}</span></div>
        <h6 class="mt-3">Hardware</h6>
        <div class="kv"><span class="k">Modelo</span><span class="v">${hw?.Modelo??'N/A'}</span></div>
        <div class="kv"><span class="k">CPU</span><span class="v">${hw?.CPU??'N/A'}</span></div>
        <div class="kv"><span class="k">RAM</span><span class="v">${hw?.RAM_Total_GB??'?'} GB</span></div>
      </div>
      <div class="col-md-4">
        <h6>Red y rendimiento</h6>
        <div class="kv"><span class="k">Download</span><span class="v"><span class="badge bg-${mc}">${mbps} Mbps</span></span></div>
        <div class="kv"><span class="k">Upload</span><span class="v">${spd?.Upload_Mbps??0} Mbps</span></div>
        <div class="kv"><span class="k">Ping/Jitter</span><span class="v">${spd?.Ping_ms??'N/A'} ms / ${spd?.Jitter_ms??'N/A'} ms</span></div>
        <div class="kv"><span class="k">Speedtest</span><span class="v"><span class="badge bg-${(String(spd?.Speedtest_Status||'')).toUpperCase()==='OK'?'success':'danger'}">${spd?.Speedtest_Status??'N/A'}</span></span></div>
        <div class="kv"><span class="k">IP</span><span class="v">${net?.IP_Publica??'N/A'}</span></div>
        <div class="kv"><span class="k">DNS</span><span class="v">${Array.isArray(net?.DNS)?net.DNS.join(', '):(net?.DNS??'N/A')}</span></div>
        <div class="mt-2">${rLat(spd?.Latencias)}</div>
      </div>
      <div class="col-md-4">
        <h6>Estado operativo</h6>
        <div class="kv"><span class="k">VPN</span><span class="v"><span class="badge bg-${vpn?.VPN_Activa?'warning text-dark':'secondary'}">${vpn?.VPN_Activa?vn:'No'}</span></span></div>
        <div class="kv"><span class="k">Defender</span><span class="v"><span class="badge bg-${av?.Defender_RT?'success':'danger'}">${av?.Defender_RT?'On':'Off'}</span></span></div>
        <div class="kv"><span class="k">Teams</span><span class="v"><span class="badge bg-${(proc?.Teams_MB??0)>0?'warning text-dark':'success'}">${(proc?.Teams_MB??0)>0?proc.Teams_MB+' MB':'Off'}</span></span></div>
        <div class="kv"><span class="k">Parches pendientes</span><span class="v">${upd?.Pendientes_Count??0}</span></div>
      </div>
    </div>

    <h6 class="mt-4">Timeline Heartbeat (ultimos 30)</h6>
    <div class="bg-white border rounded" style="max-height:220px;overflow:auto">
      ${hbTimeline.length?`<table class="table table-sm mb-0" style="font-size:.75rem"><thead><tr><th>Hora</th><th>CPU</th><th>RAM</th><th>Five9</th><th>VPN</th></tr></thead><tbody>${hbTimeline.map(h=>`<tr><td>${(h.ts??h.received_at??'').substring(11,19)}</td><td>${h.cpu_pct??'-'}%</td><td>${h.ram_pct??'-'}%</td><td><span class="badge bg-${h.five9_running?'success':'danger'}">${h.five9_running?'On':'Off'}</span></td><td>${h.vpn_name??'-'}</td></tr>`).join('')}</tbody></table>`:'<div class="text-muted p-2">Sin historial.</div>'}
    </div>

    <h6 class="mt-4">Timeline Watchdog (ultimos 30)</h6>
    <div class="bg-white border rounded" style="max-height:220px;overflow:auto">
      ${wdTimeline.length?wdTimeline.map(w=>`<div class="p-2 border-bottom"><span class="badge bg-${w.severity==='critical'?'danger':(w.severity==='warning'?'warning text-dark':'secondary')}">${w.severity??'ok'}</span> ${(w.issues||[]).slice(0,2).join(' | ')||'Sin issues'} <span class="text-muted" style="font-size:.75rem">${w.received_at??w.ts??''}</span></div>`).join(''):'<div class="text-muted p-2">Sin historial.</div>'}
    </div>

    <h6 class="mt-4">Software relevante</h6>
    <div class="bg-white border rounded">${rSw(sw?.Software_Relevante)}</div>

    <h6 class="mt-4">Logs forenses</h6>
    <div class="bg-white border rounded mb-2" style="max-height:180px;overflow:auto">${rLog(logs?.App_Errores,'App')}</div>
    <div class="bg-white border rounded" style="max-height:180px;overflow:auto">${rLog(logs?.Audio_Eventos,'Audio')}</div>

    <h6 class="mt-4">Conectividad (conexion/desconexion)</h6>
    <div class="bg-white border rounded mb-2" style="max-height:180px;overflow:auto">${(toArr(conn?.ConnectionEvents_Tail).length?toArr(conn?.ConnectionEvents_Tail).map(x=>`<div class="p-2 border-bottom">${x}</div>`).join(''):'<div class="text-muted p-2">Sin eventos de conectividad.</div>')}</div>
    <div class="bg-white border rounded" style="max-height:180px;overflow:auto">${(toArr(conn?.ConnectionLog_Tail).length?toArr(conn?.ConnectionLog_Tail).map(x=>`<div class="p-2 border-bottom"><code>${x}</code></div>`).join(''):'<div class="text-muted p-2">Sin log CSV de conectividad.</div>')}</div>
  </div>`;
}

pollEvents();
refreshStats();
updateLiveCount();
setInterval(pollEvents,5000);
setInterval(refreshStats,30000);
</script>
</body>
</html>
