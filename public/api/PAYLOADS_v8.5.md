# GSD GAU v8.5 - Payloads recomendados

## Endpoint
- `POST /api/heartbeat.php`

## 1) Evento de instalacion
```json
{
  "hostname": "PC001",
  "type": "event",
  "event_name": "install",
  "category": "operational",
  "severity": "info",
  "message": "Agente v8.5 instalado correctamente",
  "version": "8.5"
}
```

## 2) Evento de startup (encendido/logon)
```json
{
  "hostname": "PC001",
  "type": "event",
  "event_name": "startup",
  "category": "operational",
  "severity": "info",
  "message": "Heartbeat task iniciada",
  "version": "8.5"
}
```

## 3) Evento run (ejecucion de scan/manual)
```json
{
  "hostname": "PC001",
  "type": "event",
  "event_name": "run",
  "category": "operational",
  "severity": "info",
  "message": "Scan v8.5 ejecutado",
  "version": "8.5"
}
```

## 4) Heartbeat normal
```json
{
  "hostname": "PC001",
  "type": "heartbeat",
  "ts": "2026-05-07 16:20:00",
  "cpu_pct": 31,
  "ram_pct": 62,
  "five9_running": true,
  "five9_service": true,
  "teams_running": false,
  "vpn_active": false,
  "version": "8.5"
}
```

## 5) Watchdog con issue de red/Five9/audio
```json
{
  "hostname": "PC001",
  "type": "watchdog",
  "severity": "critical",
  "issues": [
    "DNS five9.com fallo",
    "Sin red activa"
  ],
  "version": "8.5"
}
```

## Nota de filtro en dashboard
El panel de alertas en vivo solo muestra:
- `operational`: `install`, `startup`, `run`, `report_upload`
- categorias de issue: `network_issue`, `five9_issue`, `audio_issue`, `system_issue`
