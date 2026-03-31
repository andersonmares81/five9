# Manual de instalacion, configuracion y uso de Five9

## 1. Objetivo del manual

Este documento describe como instalar, configurar y operar el sistema `five9` en un entorno local o semilocal. La version recomendada para Windows 11 usa:

- `WSL2` para backend Node.js, PostgreSQL, Python y FFmpeg
- `XAMPP` para Apache, PHP y opcionalmente MySQL
- navegador en Windows para operar el dashboard

Tambien sirve como referencia general del proyecto aunque la instalacion se haga en macOS o Linux.

## 2. Componentes del sistema

El proyecto esta compuesto por:

- `server/`: backend Node.js + Express con integraciones Five9, WFO, analisis, backup y automatizacion
- `web/`: dashboard React + Vite
- `backup-php/`: endpoint PHP para recibir backups en MySQL
- `web/api/calls_endpoint.php`: endpoint PHP para consultar datos de backup con HMAC
- `server/sql/`: esquema y migraciones de PostgreSQL
- `scripts/`: arranque y parada del entorno local
- `scripts/windows/`: utilidades de operacion desde Windows hacia WSL

## 3. Arquitectura recomendada en Windows 11

```text
Windows 11
├─ XAMPP Apache (:80)
│  ├─ sirve web/dist
│  ├─ proxy /api -> WSL http://127.0.0.1:3001/api
│  ├─ alias /backup-api -> web/api/calls_endpoint.php
│  └─ alias /backup-ingest -> backup-php/ingest.php
├─ XAMPP PHP
├─ XAMPP MySQL (opcional)
└─ Navegador

WSL2
├─ Node.js 20+
├─ npm
├─ Python 3.10+
├─ FFmpeg
├─ PostgreSQL 14+
└─ backend five9 :3001
```

## 4. Requisitos previos

### 4.1 Requisitos funcionales

- cuenta Five9 con acceso API
- credenciales Five9 REST
- acceso al tenant WFO si usaras grabaciones WFO
- clave OpenAI si usaras transcripcion o analisis por OpenAI

### 4.2 Requisitos tecnicos

- Node.js 20+
- npm
- PostgreSQL 14+
- Python 3.10+
- FFmpeg
- PHP 8.x con `pdo_mysql`
- MySQL 8+ si usaras `backup-php` o `web/api`

## 5. Instalacion en Windows 11 con WSL + XAMPP

### 5.1 Instalar WSL2

En PowerShell como administrador:

```powershell
wsl --install -d Ubuntu
```

Verificar:

```powershell
wsl -l -v
```

### 5.2 Instalar XAMPP

Instala XAMPP en `C:\xampp` o define otra ruta si lo prefieres. Debes tener disponibles:

- Apache
- PHP
- MySQL opcional

### 5.3 Preparar WSL

Dentro de Ubuntu:

```bash
sudo apt update
sudo apt install -y curl git build-essential ffmpeg python3 python3-pip python3-venv postgresql-client
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 5.4 Ubicar el repositorio

Puedes trabajar en:

- recomendado: `/home/<usuario>/five9`
- aceptable: `/mnt/c/.../five9`

Ejemplo:

```bash
cd /home/<usuario>
git clone <repo> five9
cd five9
```

### 5.5 Instalar dependencias

```bash
npm install
cd server && npm install
cd ..
```

## 6. Configuracion inicial

### 6.1 Archivo principal del backend

Crear:

```bash
cp server/.env.example server/.env
```

Variables minimas para arrancar:

```env
PORT=3001
DATABASE_URL=postgres://user:password@127.0.0.1:5432/five9
JWT_SECRET=change-me-with-32-chars-minimum
AUTH_MODE=jwt

ADMIN_EMAIL=admin@company.com
ADMIN_PASSWORD=ChangeMe123!
ADMIN_NAME=Admin
```

### 6.2 Configuracion Five9

Agregar al `server/.env`:

```env
FIVE9_BASE_URL=https://app.five9.com/appsvcs/rs/svc
FIVE9_USERNAME=tu_usuario
FIVE9_PASSWORD=tu_password
FIVE9_CALLS_PATH=/agents/1234/interactions/calls
FIVE9_REALTIME_PATH=/agents/realtime
FIVE9_SUPERVISOR_ID=2385
FIVE9_AGENT_IDS=1262,1270
```

### 6.3 Configuracion WFO

Si usaras WFO:

```env
WFO_ENABLED=true
WFO_BASE_URL=https://<tenant>.wfo.five9.com/VOCoreWebAPI
WFO_METHOD=POST
WFO_HEADERS_JSON={}
WFO_PAYLOAD_JSON={}
WFO_PAGE_SIZE=100
WFO_MAX_PAGES=50
```

Nota: en la practica, la sesion WFO se puede cargar desde la propia UI pegando cURL, headers o HAR.

### 6.4 Configuracion OpenAI

```env
OPENAI_API_KEY=sk-...
OPENAI_TRANSCRIBE_MODEL=whisper-1
OPENAI_ANALYSIS_MODEL=gpt-4o-mini
TRANSCRIBE_PROVIDER=openai
SENTIMENT_PROVIDER=openai
```

### 6.5 Configuracion de transcripcion local con Python

Si vas a usar `faster-whisper`, dentro del repo en WSL:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip faster-whisper
```

Luego define en `server/.env`:

```env
PYTHON_BIN=/ruta/al/proyecto/five9/.venv/bin/python
FASTER_WHISPER_MODEL=small
FASTER_WHISPER_DEVICE=cpu
FASTER_WHISPER_COMPUTE_TYPE=int8
TRANSCRIBE_PROVIDER=faster_whisper
```

Si no defines `PYTHON_BIN`, el sistema intentara resolver `python3` o `python` automaticamente.

### 6.6 Configuracion del backup PHP

Crear:

```bash
cp backup-php/.env.example backup-php/.env
cp web/.env.example web/.env
```

Completar ambos con los datos de MySQL y seguridad requerida.

Ejemplo base para `backup-php/.env`:

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=five9_backup
MYSQL_USERNAME=root
MYSQL_PASSWORD=
INGEST_DEBUG=false
```

Ejemplo base para `web/.env`:

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=five9_backup
MYSQL_USERNAME=root
MYSQL_PASSWORD=
API_BEARER_TOKEN=change-me
API_SHARED_SECRET=change-me-32-chars-min
MAX_LIMIT=100
MAX_TIME_SKEW=300
```

## 7. Base de datos

### 7.1 PostgreSQL principal

Crear base:

```bash
psql -U postgres -c 'CREATE DATABASE five9;'
```

Aplicar esquema:

```bash
psql -U postgres -d five9 -f server/sql/schema.sql
psql -U postgres -d five9 -f server/sql/migrations/001_recordings.sql
psql -U postgres -d five9 -f server/sql/migrations/002_wfo_fields.sql
```

### 7.2 MySQL para backup

Crear base y tabla del backup siguiendo:

- `backup-php/README.md`

Ese modulo usa la tabla `calls_five9_backup`.

## 8. Configuracion de Apache en XAMPP

### 8.1 Compilar frontend

Desde Windows:

```powershell
npm run build:web:windows
```

Esto genera `web/dist`.

### 8.2 Crear VirtualHost

Usar como plantilla:

- `scripts/windows/apache/five9-xampp-vhost.conf`

Pasos:

1. reemplazar `C:/path/to/five9` por la ruta real del proyecto en Windows
2. copiar el contenido a `C:\xampp\apache\conf\extra\httpd-vhosts.conf`
3. habilitar en Apache:
   - `proxy_module`
   - `proxy_http_module`
   - `rewrite_module`
4. agregar al archivo `hosts`:

```text
127.0.0.1 five9.local
```

## 9. Arranque del sistema

### 9.1 Validar entorno Windows

```powershell
npm run check:windows
```

### 9.2 Arrancar backend y frontend en WSL

```powershell
npm run start:local:windows
```

Esto levanta:

- backend: `http://127.0.0.1:3001`
- frontend Vite: `http://127.0.0.1:5173`

### 9.3 Operar por Apache

Si Apache esta configurado:

- dashboard estable: `http://five9.local/`
- API backend proxied: `http://five9.local/api/...`
- consulta PHP backup: `http://five9.local/backup-api/calls_endpoint.php`
- ingest PHP backup: `http://five9.local/backup-ingest/ingest.php`

### 9.4 Detener servicios

```powershell
npm run stop:local:windows
```

## 10. Primer uso del sistema

### 10.1 Acceso inicial

Una vez que el backend este arriba, usa el dashboard y autentica con el usuario administrador definido en `server/.env`.

### 10.2 Sincronizacion de llamadas

Usa el dashboard o los endpoints administrativos para:

- sincronizar llamadas Five9
- sincronizar grabaciones
- recalcular agregados

### 10.3 Cargar sesion WFO

Desde la UI puedes pegar:

- texto cURL
- headers manuales
- HAR de navegador

Eso permite habilitar descargas y procesos WFO sin depender de un login embebido.

### 10.4 Transcribir llamadas

Opciones:

- OpenAI
- `faster-whisper` local en WSL

El flujo normal es:

1. sincronizar o prefetchear media
2. disparar transcripcion
3. revisar transcript y analisis desde la UI

### 10.5 Enviar backup a ingest

Si el endpoint PHP esta habilitado, puedes empujar datos manualmente o por scheduler hacia `backup-php/ingest.php`.

## 11. Scheduler y automatizacion

Variables relevantes en `server/.env`:

```env
ENABLE_SCHEDULER=true
SYNC_CRON=*/15 * * * *

BACKUP_ENABLED=true
BACKUP_ENDPOINT=http://127.0.0.1:8088/ingest.php
BACKUP_CRON=0 19 * * *
BACKUP_TIMEZONE=America/Bogota

ENABLE_AUTOMATION=true
AUTOMATION_CRON=0 * * * *
AUTOMATION_TIMEZONE=America/Bogota
AUTOMATION_BACKFILL_DAYS_PER_RUN=2
AUTOMATION_SYNC_MAX_PAGES=20
```

## 12. Comandos utiles

### 12.1 Desarrollo general

```bash
npm run dev
npm run dev:web
npm run dev:server
npm run test
```

### 12.2 Arranque local

```bash
npm run start:local
npm run stop:local
```

### 12.3 Windows

```powershell
npm run check:windows
npm run build:web:windows
npm run start:local:windows
npm run stop:local:windows
```

### 12.4 Backup local por Docker

```bash
npm run start:backup-local
npm run stop:backup-local
```

## 13. Uso de la API PHP de consulta

El endpoint `web/api/calls_endpoint.php` exige:

- header `Authorization: Bearer <token>`
- header `X-Timestamp`
- header `X-Signature`

La firma se construye con:

```text
timestamp|querystring_ordenado
```

y luego:

```text
hash_hmac('sha256', base, API_SHARED_SECRET)
```

## 14. Troubleshooting

### 14.1 Apache no llega al backend

Validar en WSL:

```bash
curl http://127.0.0.1:3001/api/health
```

Si falla, el backend no esta arriba o `server/.env` esta incompleto.

### 14.2 Python no encontrado

Revisar:

- `python3 --version`
- `which python3`
- `PYTHON_BIN` en `server/.env`

### 14.3 `faster-whisper` no instalado

Dentro del entorno Python correcto:

```bash
python -m pip install -U faster-whisper
```

### 14.4 Error de `pdo_mysql`

Habilitar la extension en el PHP de XAMPP y reiniciar Apache.

### 14.5 Error con WFO

Renovar la sesion desde la UI pegando de nuevo cURL, headers o HAR actuales del navegador.

### 14.6 Error de backup endpoint

Verificar:

- `backup-php/.env`
- MySQL activo
- URL configurada en `BACKUP_ENDPOINT`
- reachability entre backend y endpoint PHP

## 15. Recomendaciones operativas

- no usar credenciales reales en archivos versionados
- mantener `server/.env`, `backup-php/.env` y `web/.env` fuera de git
- si el proyecto se ejecuta en Windows, preferir el backend dentro de WSL y no en Node nativo de Windows
- si trabajas con audio local, instala `ffmpeg` dentro de WSL
- validar manualmente los flujos sensibles antes de habilitar cron o backup automatico

## 16. Documentos complementarios

- `README.md`
- `.amrosai/docs/02-guia-desarrollo.md`
- `.amrosai/docs/03-windows-11-wsl-xampp.md`
- `backup-php/README.md`
