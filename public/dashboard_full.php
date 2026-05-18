<?php
header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: https:;");

$version = '8.8';
$baseDir = __DIR__ . '/api/reportes/';
$pcFilter = strtoupper(trim((string) ($_GET['pc'] ?? '')));

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

function readTextSafe($path, $max = 180000)
{
    if (!file_exists($path) || !is_file($path)) {
        return '';
    }
    $txt = file_get_contents($path);
    if ($txt === false) {
        return '';
    }
    if (strlen($txt) > $max) {
        return substr($txt, 0, $max) . "\n... [truncado]";
    }
    return $txt;
}

$agents = array();
if (is_dir($baseDir)) {
    foreach (glob($baseDir . '*', GLOB_ONLYDIR) as $folder) {
        $pc = strtoupper(basename($folder));
        if ($pc === 'HISTORIAL' || $pc === '') {
            continue;
        }
        if ($pcFilter !== '' && $pcFilter !== $pc) {
            continue;
        }

        $summary = array(
            'pc' => $pc,
            'folder' => $folder,
            'updated' => file_exists($folder . '/last_update.txt') ? trim((string) file_get_contents($folder . '/last_update.txt')) : 'N/A',
            'identidad' => rj($folder . '/0_Identidad.json') ?: array(),
            'hardware' => rj($folder . '/1_Hardware.json') ?: array(),
            'red' => rj($folder . '/2_Red.json') ?: array(),
            'speed' => rj($folder . '/3_SpeedTest.json') ?: array(),
            'software' => rj($folder . '/4_Software.json') ?: array(),
            'vpn' => rj($folder . '/6_VPN_QoS.json') ?: array(),
            'procesos' => rj($folder . '/9_Procesos.json') ?: array(),
            'connectivity' => rj($folder . '/12_Connectivity.json') ?: array(),
        );

        $rootFiles = glob($folder . '/*.{json,csv,log}', GLOB_BRACE);
        $rootList = array();
        foreach ($rootFiles as $rf) {
            if (is_file($rf)) {
                $rootList[] = $rf;
            }
        }
        sort($rootList);

        $history = array();
        $histBase = $folder . '/historial';
        if (is_dir($histBase)) {
            $days = glob($histBase . '/*', GLOB_ONLYDIR);
            rsort($days);
            foreach ($days as $dayPath) {
                $dayName = basename($dayPath);
                $runs = glob($dayPath . '/*', GLOB_ONLYDIR);
                rsort($runs);
                $runData = array();
                foreach (array_slice($runs, 0, 10) as $run) {
                    $files = glob($run . '/*.{json,csv,log,txt}', GLOB_BRACE);
                    $runData[] = array(
                        'name' => basename($run),
                        'path' => $run,
                        'files' => $files ?: array(),
                    );
                }
                $history[] = array(
                    'day' => $dayName,
                    'runs' => $runData,
                );
            }
        }

        $summary['rootFiles'] = $rootList;
        $summary['history'] = $history;
        $agents[] = $summary;
    }
}

usort($agents, function ($a, $b) {
    return strcmp($a['pc'], $b['pc']);
});
?>
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GSD GAU | Full Report v<?=$version?></title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css" rel="stylesheet">
<style>
:root{--brand:#1a237e;--accent:#00d4ff}
body{background:#f4f6fb;font-family:'Segoe UI',sans-serif}
.navbar{background:var(--brand);border-bottom:3px solid var(--accent)}
.block{background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.kv{display:flex;justify-content:space-between;border-bottom:1px solid #eef2f7;padding:5px 0;font-size:.86rem}
.kv:last-child{border-bottom:none}
pre{white-space:pre-wrap;word-break:break-word;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:10px;font-size:.73rem;max-height:320px;overflow:auto}
.file-pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#e2e8f0;font-size:.72rem;margin:2px 4px 2px 0}
.day-title{font-weight:700;font-size:.9rem;color:#334155}
</style>
</head>
<body>

<nav class="navbar navbar-dark px-4 py-2 shadow-sm mb-3">
<div class="d-flex align-items-center gap-2">
<span class="navbar-brand fw-bold mb-0"><i class="bi bi-journal-richtext me-2"></i>GAU FULL REPORT <span class="badge bg-info text-dark ms-2">v<?=$version?></span></span>
<a href="dashboard.php" class="btn btn-sm btn-outline-light"><i class="bi bi-grid me-1"></i>Resumen</a>
</div>
<div class="text-light small">Generado: <?=date('Y-m-d H:i:s')?> COT</div>
</nav>

<div class="container pb-4">
<?php if (!$agents): ?>
<div class="alert alert-warning">No hay equipos con reportes disponibles.</div>
<?php else: ?>
<?php foreach ($agents as $a):
$pc = $a['pc'];
$id = $a['identidad'];
$hw = $a['hardware'];
$red = $a['red'];
$spd = $a['speed'];
$soft = $a['software'];
$vpn = $a['vpn'];
?>
<div class="block mb-3 p-3">
<div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
<div>
<h5 class="mb-1"><i class="bi bi-pc-display-horizontal me-1"></i><?=$pc?></h5>
<div class="text-muted small">Ultimo update: <?=$a['updated']?></div>
</div>
<div>
<a class="btn btn-sm btn-outline-primary" href="dashboard.php?pc=<?=urlencode($pc)?>"><i class="bi bi-eye me-1"></i>Ver en resumen</a>
</div>
</div>

<div class="row g-3 mt-1">
<div class="col-md-4">
<div class="block p-2">
<div class="fw-semibold mb-1">Resumen principal</div>
<div class="kv"><span>Nombre</span><b><?=htmlspecialchars((string)($id['Nombre'] ?? $pc))?></b></div>
<div class="kv"><span>Email</span><b><?=htmlspecialchars((string)($id['Email'] ?? 'N/A'))?></b></div>
<div class="kv"><span>Tipo red</span><b><?=htmlspecialchars((string)($id['Tipo_Red'] ?? ($red['NetType'] ?? 'N/A')))?></b></div>
<div class="kv"><span>IP publica</span><b><?=htmlspecialchars((string)($red['IP_Publica'] ?? $spd['Public_IP'] ?? 'N/A'))?></b></div>
<div class="kv"><span>Download</span><b><?=htmlspecialchars((string)($spd['Download_Mbps'] ?? '0'))?> Mbps</b></div>
<div class="kv"><span>Upload</span><b><?=htmlspecialchars((string)($spd['Upload_Mbps'] ?? '0'))?> Mbps</b></div>
<div class="kv"><span>Ping</span><b><?=htmlspecialchars((string)($spd['Ping_ms'] ?? 'N/A'))?> ms</b></div>
<div class="kv"><span>VPN</span><b><?=!empty($vpn['VPN_Activa']) ? 'Activa' : 'No'?></b></div>
<div class="kv"><span>Modelo</span><b><?=htmlspecialchars((string)($hw['Modelo'] ?? 'N/A'))?></b></div>
</div>
</div>

<div class="col-md-8">
<div class="block p-2">
<div class="fw-semibold mb-2">Archivos actuales (snapshot)</div>
<?php if (!$a['rootFiles']): ?>
<div class="text-muted small">Sin archivos actuales.</div>
<?php else: ?>
<div class="mb-2">
<?php foreach ($a['rootFiles'] as $f): ?><span class="file-pill"><?=htmlspecialchars(basename($f))?></span><?php endforeach; ?>
</div>
<?php foreach ($a['rootFiles'] as $f):
$base = basename($f);
$txt = readTextSafe($f);
?>
<details class="mb-2">
<summary class="fw-semibold"><?=htmlspecialchars($base)?></summary>
<pre><?=htmlspecialchars($txt)?></pre>
</details>
<?php endforeach; ?>
<?php endif; ?>
</div>
</div>
</div>

<div class="block p-2 mt-3">
<div class="fw-semibold mb-2">Historial por dia (full report)</div>
<?php if (empty($a['history'])): ?>
<div class="text-muted small">Sin historial por dias.</div>
<?php else: ?>
<?php foreach ($a['history'] as $day): ?>
<details class="mb-2">
<summary class="day-title"><?=htmlspecialchars($day['day'])?> (<?=count($day['runs'])?> ejecuciones visibles)</summary>
<div class="mt-2">
<?php foreach ($day['runs'] as $run): ?>
<details class="mb-2">
<summary><b><?=htmlspecialchars($run['name'])?></b> - <?=count($run['files'])?> archivos</summary>
<?php if (empty($run['files'])): ?>
<div class="text-muted small">Sin archivos en esta ejecución.</div>
<?php else: ?>
<div class="mb-2">
<?php foreach ($run['files'] as $rf): ?><span class="file-pill"><?=htmlspecialchars(basename($rf))?></span><?php endforeach; ?>
</div>
<?php foreach ($run['files'] as $rf): ?>
<details class="mb-2">
<summary><?=htmlspecialchars(basename($rf))?></summary>
<pre><?=htmlspecialchars(readTextSafe($rf))?></pre>
</details>
<?php endforeach; ?>
<?php endif; ?>
</details>
<?php endforeach; ?>
</div>
</details>
<?php endforeach; ?>
<?php endif; ?>
</div>
</div>
<?php endforeach; ?>
<?php endif; ?>
</div>

</body>
</html>
