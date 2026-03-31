# Five9 en Windows 11 con WSL, Python y XAMPP

## Objetivo

Levantar el sistema completo separando responsabilidades por plataforma:

- `WSL2`: backend Node.js, PostgreSQL, Python, FFmpeg, sincronizaciones Five9/WFO
- `Windows + XAMPP`: Apache, PHP y opcionalmente MySQL para `backup-php` y `web/api`
- `Browser en Windows`: acceso al dashboard por Apache o Vite

Esta topología evita pelear con binarios mixtos de Node/Python/PHP y deja a Apache/XAMPP en el lado Windows, que es donde normalmente se administra mejor.

## Arquitectura recomendada

```text
Windows 11
├─ XAMPP Apache (:80)
│  ├─ sirve web/dist
│  ├─ proxy /api  -> WSL http://127.0.0.1:3001/api
│  ├─ alias /backup-api -> web/api/calls_endpoint.php
│  └─ alias /backup-ingest -> backup-php/ingest.php
├─ XAMPP PHP
└─ XAMPP MySQL (opcional)

WSL2 Ubuntu
├─ Node 20+
├─ npm
├─ Python 3.10+
├─ ffmpeg
├─ PostgreSQL 14+
└─ five9 backend on :3001
```

## 1. Preparar Windows 11

Instalar:

1. `WSL2` con Ubuntu
2. `XAMPP` con Apache y PHP 8.x
3. Opcional: usar MySQL de XAMPP si quieres hospedar el backup PHP en Windows
4. Node no es necesario en Windows para correr el backend; se usará dentro de WSL

Comandos iniciales:

```powershell
wsl --install -d Ubuntu
```

Si ya tienes WSL:

```powershell
wsl -l -v
```

## 2. Preparar WSL

Dentro de Ubuntu:

```bash
sudo apt update
sudo apt install -y curl git build-essential ffmpeg python3 python3-pip python3-venv postgresql-client
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Clona o ubica el repo dentro de WSL. Dos rutas válidas:

- Recomendado: `/home/<user>/five9`
- Alternativo: `/mnt/c/.../five9`

Instala dependencias:

```bash
cd /ruta/al/repo/five9
npm install
cd server && npm install
```

Si usarás transcripción local:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip faster-whisper
```

Si usas el virtualenv, exporta:

```bash
export PYTHON_BIN=/ruta/al/repo/five9/.venv/bin/python
```

## 3. Configurar backend y PostgreSQL

Crear el archivo de entorno:

```bash
cp server/.env.example server/.env
```

Variables mínimas:

```env
PORT=3001
DATABASE_URL=postgres://user:password@localhost:5432/five9
JWT_SECRET=change-me
AUTH_MODE=jwt
ADMIN_EMAIL=admin@company.com
ADMIN_PASSWORD=ChangeMe123!
ADMIN_NAME=Admin
```

Crear base de datos:

```bash
psql -U postgres -d five9 -f server/sql/schema.sql
```

## 4. Configurar PHP en XAMPP

Archivos a preparar:

- `backup-php/.env` desde `backup-php/.env.example`
- `web/.env` desde `web/.env.example`

`web/.env` se usa para `web/api/calls_endpoint.php`.

Si MySQL vive en XAMPP, normalmente bastará con:

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=five9_backup
MYSQL_USERNAME=root
MYSQL_PASSWORD=
```

## 5. Compilar frontend para Apache

Desde Windows:

```powershell
npm run build:web:windows
```

Eso genera `web/dist`, que Apache servirá como SPA estática.

## 6. Configurar VirtualHost de XAMPP

Usa como base:

- [scripts/windows/apache/five9-xampp-vhost.conf](/Users/andersonmartinezrestrepo/five9/scripts/windows/apache/five9-xampp-vhost.conf)

Pasos:

1. Reemplaza `C:/path/to/five9` por la ruta real del repo en Windows.
2. Copia el bloque al archivo `C:\xampp\apache\conf\extra\httpd-vhosts.conf`.
3. Verifica en `httpd.conf` que estén habilitados:
   - `mod_proxy`
   - `mod_proxy_http`
   - `mod_rewrite`
4. Agrega a `hosts`:

```text
127.0.0.1 five9.local
```

Con esta configuración:

- `http://five9.local/` sirve `web/dist`
- `http://five9.local/api/*` se redirige al backend Node en WSL
- `http://five9.local/backup-api/calls_endpoint.php` expone el endpoint PHP de consulta
- `http://five9.local/backup-ingest/ingest.php` expone el ingest PHP

## 7. Operación diaria desde Windows

Validar entorno:

```powershell
npm run check:windows
```

Iniciar backend/frontend en WSL:

```powershell
npm run start:local:windows
```

Detener servicios:

```powershell
npm run stop:local:windows
```

Variables opcionales en Windows:

```powershell
$env:FIVE9_WSL_DISTRO="Ubuntu"
$env:FIVE9_WSL_PROJECT_PATH="/home/anderson/five9"
$env:FIVE9_XAMPP_ROOT="C:\xampp"
```

## 8. Qué corre dónde

- `npm run start:local:windows`: arranca Node backend y Vite dentro de WSL
- XAMPP Apache: sirve la versión compilada para uso estable
- Vite `:5173`: útil para desarrollo frontend
- Apache `:80`: útil para operación tipo staging/local estable

## 9. Notas importantes

- Si Apache en Windows no llega a `127.0.0.1:3001`, primero confirma que el backend en WSL responde con `curl http://127.0.0.1:3001/api/health`.
- `faster-whisper` y `ffmpeg` deben existir en WSL, no en XAMPP.
- `backup-php/ingest.php` y `web/api/calls_endpoint.php` corren con el PHP de XAMPP; asegúrate de tener `pdo_mysql` habilitado.
- Si quieres evitar mezclar archivos entre Windows y Linux, clona el repo dentro del home de WSL y ajusta `FIVE9_WSL_PROJECT_PATH`.
