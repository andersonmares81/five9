# Five9 Ecosystem — AMR Tech

> Sistema de integración, transcripción y análisis de llamadas Five9 con API REST, backup y dashboard.

## Descripción General

**five9** es un ecosistema completo que se integra con Five9 (plataforma de centro de contacto/Workforce Optimization) para:

- **Sincronización de datos**: Importa llamadas, grabaciones y metadatos desde Five9 API
- **Transcripción de audio**: Convierte grabaciones de llamadas a texto usando OpenAI Whisper
- **Análisis de sentimiento**: Analiza transcripciones con OpenAI GPT para detectar sentimiento, idioma y temas
- **WFO Integration**: Integra con Five9 WFO (Workforce Optimization) para obtener grabaciones y métricas
- **API REST completa**: Endpoints para auth, reportes, tiempo real, grabaciones, análisis y administración
- **Backup automático**: Respalda datos diarios a MySQL externo
- **API Web PHP**: Endpoint para consultar datos de backup desde MySQL con autenticación HMAC
- **Dashboard opcional**: Interfaz web para visualizar datos

---

## Arquitectura

```
five9/
├── server/                    # Backend Node.js (Express)
│   ├── src/
│   │   ├── routes/           # API REST endpoints
│   │   ├── five9/           # Cliente Five9 API
│   │   ├── wfo/              # Integración WFO
│   │   ├── transcription/     # Whisper + GPT
│   │   ├── backup/           # Sistema de backup
│   │   ├── media/            # Almacenamiento de audio
│   │   └── db.js             # Conexión PostgreSQL
│   └── sql/
│       ├── schema.sql        # Esquema de DB
│       └── migrations/       # Migraciones
├── backup-php/               # Endpoint PHP para ingestión de backup
├── scripts/                  # Scripts de inicio/parada
├── web/                      # Frontend dashboard (opcional)
└── assets/                   # CSS del design system
```

---

## Requisitos

- **Node.js** 20+
- **PostgreSQL** 14+ (datos principales)
- **MySQL** 8+ (backup only)
- **FFmpeg** (para procesamiento de audio)
- **OpenAI API Key** (transcripción y análisis)
- **Cuenta Five9** con acceso API

---

## Instalación

### 1. Clonar el proyecto

```bash
cd /Users/andersonmartinezrestrepo/five9
```

### 2. Instalar dependencias

```bash
npm install
cd server && npm install
```

### 3. Configurar variables de entorno

```bash
cp server/.env.example server/.env
```

Editar `server/.env` con tus credenciales:

```env
# Servidor
PORT=3001
JWT_SECRET=tu-secret-muy-largo-min-32-caracteres
AUTH_MODE=jwt

# Base de datos principal (PostgreSQL)
DATABASE_URL=postgres://user:password@localhost:5432/five9

# Five9 API
FIVE9_USERNAME=tu-usuario
FIVE9_PASSWORD=tu-password
FIVE9_BASE_URL=https://app.five9.com/appsvcs/rs/svc

# OpenAI (transcripción y análisis)
OPENAI_API_KEY=sk-...
OPENAI_TRANSCRIBE_MODEL=whisper-1
OPENAI_ANALYSIS_MODEL=gpt-4o-mini

# WFO (opcional)
WFO_ENABLED=false
WFO_BASE_URL=https://cloud1656.wfo.five9.com/VOCoreWebAPI

# Backup (opcional)
BACKUP_ENABLED=false
BACKUP_ENDPOINT=http://localhost:8088/ingest.php

# Programador
ENABLE_SCHEDULER=true
SYNC_CRON=*/15 * * * *

# Administrador
ADMIN_EMAIL=admin@company.com
ADMIN_PASSWORD=ChangeMe123!
ADMIN_NAME=Admin
```

### 4. Crear base de datos PostgreSQL

```bash
# Conectarse a PostgreSQL
psql -U postgres

# Crear base de datos
CREATE DATABASE five9;

# Ejecutar schema
psql -U postgres -d five9 -f server/sql/schema.sql
```

### 5. Iniciar el servidor

```bash
# Modo desarrollo
npm run dev

# O manualmente
cd server && npm run dev
```

El servidor iniciara en `http://localhost:3001`

---

## Configuración Adicional

### Five9 API

El sistema usa la API REST de Five9 para obtener:
- Llamadas (interacciones)
- Grabaciones de llamadas
- Metadatos de agentes
- Estadísticas en tiempo real

Configura en `.env`:
- `FIVE9_USERNAME` / `FIVE9_PASSWORD` - Credenciales Five9
- `FIVE9_SUPERVISOR_ID` - ID del supervisor
- `FIVE9_AGENT_IDS` - IDs de agentes a monitorear

### WFO (Workforce Optimization)

Para integrar con Five9 WFO:

1. Habilitar `WFO_ENABLED=true`
2. Configurar `WFO_BASE_URL` (ej: `https://cloud1659.wfo.five.com/VOCoreWebAPI`)
3. Obtener headers y payload desde DevTools del navegador
4. Configurar `WFO_HEADERS_JSON` y `WFO_PAYLOAD_JSON`

### Backup a MySQL

Para respaldo automático:

1. Crear base de datos MySQL:
```bash
# Ver backup-php/README.md para detalles
```

2. Habilitar en `.env`:
```env
BACKUP_ENABLED=true
BACKUP_ENDPOINT=http://tu-servidor:8088/ingest.php
BACKUP_CRON=0 19 * * *
BACKUP_TIMEZONE=America/Bogota
```

---

## API Endpoints

### Autenticación

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/auth/login` | Iniciar sesión |
| POST | `/api/auth/register` | Registrar usuario |
| GET | `/api/auth/me` | Datos del usuario actual |

### Llamadas y Grabaciones

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/recordings` | Listar grabaciones |
| GET | `/api/recordings/:id` | Obtener grabación específica |
| POST | `/api/recordings/:id/transcribe` | Transcribir grabación |

### Análisis

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/analysis/transcribe` | Transcribir llamada |
| GET | `/api/analysis/:callId` | Obtener análisis de llamada |

### Reportes

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/reports/calls` | Reporte de llamadas |
| GET | `/api/reports/aggregates` | Agregados diarios |
| GET | `/api/reports/agents` | Estadísticas por agente |

### WFO

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/wfo/recordings` | Grabaciones WFO |
| POST | `/api/wfo/sync` | Sincronizar grabaciones |

### Tiempo Real

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/realtime/agents` | Agentes en tiempo real |
| GET | `/api/realtime/calls` | Llamadas activas |

### Administración

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/admin/users` | Listar usuarios |
| POST | `/api/admin/users` | Crear usuario |
| GET | `/api/admin/stats` | Estadísticas del sistema |

### Sistema

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/system/health` | Estado del sistema |
| POST | `/api/system/sync` | Forzar sincronización |

### Backup

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/backup/push` | Enviar backup manual |
| GET | `/api/backup/status` | Estado del backup |

---

## Uso

### Sincronización Automática

El programador (scheduler) sincroniza datos automáticamente según `SYNC_CRON`:

```env
SYNC_CRON=*/15 * * * *  # Cada 15 minutos
```

### Transcribir una Llamada

```bash
curl -X POST http://localhost:3001/api/analysis/transcribe \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"callId": "12345"}'
```

### Forzar Sincronización

```bash
curl -X POST http://localhost:3001/api/system/sync \
  -H "Authorization: Bearer <token>"
```

---

## Scripts Disponibles

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Iniciar servidor en modo desarrollo |
| `npm run start:local` | Iniciar stack completo local |
| `npm run stop:local` | Detener stack local |
| `npm run start:stack` | Iniciar con Docker |
| `npm run stop:stack` | Detener Docker |
| `npm run start:backup-local` | Iniciar backup MySQL local |
| `npm run stop:backup-local` | Detener backup MySQL |

---

## Procesamiento de Audio

El sistema puede:
1. **Descargar** audio desde Five9/WFO
2. **Segmentar** archivos grandes (por defecto 10 min)
3. **Transcribir** con Whisper (OpenAI)
4. **Separar** hablantes heurísticamente
5. **Analizar** sentimiento con GPT

Configuración de transcripción:

```env
TRANSCRIBE_MAX_BYTES=25165824  # 24MB por defecto
TRANSCRIBE_SEGMENT_SECONDS=600  # 10 minutos
```

---

## Producción

Para despliegue en producción:

1. Configurar `NODE_ENV=production`
2. Usar `JWT_SECRET` seguro (mínimo 32 caracteres)
3. Configurar `AUTH_MODE=jwt`
4. Habilitar HTTPS
5. Configurar logs apropiados
6. Usar PostgreSQL gestionado (no local)

## API Web (Endpoint PHP)

El sistema incluye un endpoint PHP (`web/api/calls_endpoint.php`) para exponer los datos de backup desde MySQL a través de una API REST segura.

### Configuración

1. Copiar `.env.example` a `web/.env`:

```env
# MySQL (donde están los datos de backup)
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=five9_backup
MYSQL_USERNAME=usuario
MYSQL_PASSWORD=clave

# Seguridad API
API_BEARER_TOKEN=tu-bearer-token
API_SHARED_SECRET=tu-secret-compartido-min-32-caracteres

# Límites
MAX_LIMIT=100
MAX_TIME_SKEW=300
```

### Autenticación

La API usa autenticación con:
1. **Bearer Token** en header `Authorization`
2. **Firma HMAC-SHA256** en headers `X-Timestamp` y `X-Signature`

### Headers Requeridos

```
Authorization: Bearer <token>
X-Timestamp: <unix_timestamp>
X-Signature: <hmac_sha256_signature>
```

### Parámetros de Consulta

| Parámetro | Descripción |
|-----------|-------------|
| `call_id` | ID de llamada |
| `agent_id` | ID del agente |
| `event_dir` | Dirección (IN/OUT) |
| `ani` | Número del llamante |
| `dnis` | Número marcado |
| `result_code` | Código de resultado |
| `date_from` | Fecha inicio (YYYY-MM-DD) |
| `date_to` | Fecha fin (YYYY-MM-DD) |
| `include_raw` | Incluir JSON raw (0/1) |
| `limit` | Límite de resultados (default 20) |
| `offset` | Offset para paginación |

### Ejemplo de Uso

```php
<?php
$token = 'tu-bearer-token';
$secret = 'tu-secret-compartido';
$timestamp = time();

$queryParams = [
    'date_from' => '2026-03-01',
    'date_to' => '2026-03-17',
    'limit' => 50
];

ksort($queryParams);
$signatureBase = $timestamp . '|' . http_build_query($queryParams);
$signature = hash_hmac('sha256', $signatureBase, $secret);

$ch = curl_init('https://tu-dominio.com/api/calls_endpoint.php?' . http_build_query($queryParams));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "Authorization: Bearer $token",
    "X-Timestamp: $timestamp",
    "X-Signature: $signature"
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$response = curl_exec($ch);
curl_close($ch);

$data = json_decode($response, true);
print_r($data);
```

### Respuesta

```json
{
  "ok": true,
  "meta": {
    "limit": 20,
    "offset": 0,
    "returned": 20,
    "total": 150,
    "filters": { ... }
  },
  "data": [ ... ]
}
```

---

## Troubleshooting

### Error de autenticación Five9

Verificar credenciales en `.env` y que el usuario tenga permisos API.

### Error de transcripción

- Verificar `OPENAI_API_KEY` válida
- Verificar que FFmpeg esté instalado: `ffmpeg -version`
- Revisar logs en la consola

### Error de conexión WFO

- Verificar `WFO_HEADERS_JSON` y `WFO_PAYLOAD_JSON`
- La sesión puede haber expirado; obtener nuevos valores del navegador

### Backup no funciona

- Verificar que MySQL esté corriendo
- Verificar `BACKUP_ENDPOINT` accesible
- Revisar logs de error

---

## Tecnologías

- **Backend**: Node.js 20+, Express
- **Base de datos**: PostgreSQL 14+ (datos), MySQL 8+ (backup)
- **Transcripción**: OpenAI Whisper
- **Análisis**: OpenAI GPT
- **Auth**: JWT
- **Programación**: node-cron
- **HTTP**: Axios con cookie jar
- **Audio**: FFmpeg

---

## Licencia

MIT License - AMR Tech
