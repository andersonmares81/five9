# Five9 MySQL Backup Ingest

Endpoint pensado para recibir el backup diario desde el backend Node.

## Configuración

1) Copia `.env.example` a `.env` y completa:

```
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=five9_backup
MYSQL_USERNAME=usuario
MYSQL_PASSWORD=clave
INGEST_DEBUG=false
```

2) Crea la tabla:

```
CREATE TABLE calls_five9_backup (
  call_id VARCHAR(64) PRIMARY KEY,
  agent_id VARCHAR(128),
  agent_first_name VARCHAR(64),
  agent_last_name VARCHAR(64),
  event_dir VARCHAR(32),
  start_time DATETIME,
  end_time DATETIME,
  duration_sec INT,
  ani VARCHAR(32),
  dnis VARCHAR(32),
  result_code VARCHAR(32),
  screen_capture_type VARCHAR(32),
  raw_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(raw_json)),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

## Uso

Envía un `POST` con JSON:

```
{ "calls": [ { ... } ] }
```

## Debug

Para ver errores exactos desde PHP:

```
INGEST_DEBUG=true
```

Respuesta:

```
{ "status": "ok", "inserted": 100 }
```

## Local Docker stack

Desde la raíz del proyecto puedes levantar MySQL + `ingest.php` localmente:

```bash
npm run start:backup-local
```

Esto expone:

- MySQL: `127.0.0.1:3307`
- Ingest API: `http://127.0.0.1:8088/ingest.php`

Para apagarlo:

```bash
npm run stop:backup-local
```
