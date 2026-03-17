# AMR Tech — Estándares de Desarrollo v1.0

> Documento de referencia para el equipo y para agentes de IA.
> Se actualiza cuando cambian los acuerdos del equipo.

---

## 1. Principios fundamentales

### SOLID aplicado a este proyecto

**S — Single Responsibility**
Cada clase tiene exactamente un motivo para cambiar.
- Un `FlowManager` maneja flujos. No envía mensajes.
- Un `WhatautoClient` envía mensajes. No accede a DB.
- Un `FileHandler` guarda archivos. No procesa lógica de negocio.
- Máximo 200 líneas de código por clase.

**O — Open/Closed**
Las clases están abiertas a extensión, cerradas a modificación.
- Para agregar un cliente de mensajería nuevo, crear `EvolutionClient implements MessageClientInterface`.
- Nunca modificar `BotEngine` para acomodar un nuevo proveedor.

**L — Liskov Substitution**
Cualquier implementación de una interfaz debe ser intercambiable sin romper el sistema.
- `WppConnectClient` puede reemplazar a `WhatautoClient` en `webhook.php` sin cambiar nada más.

**I — Interface Segregation**
Interfaces pequeñas y específicas.
- `MessageClientInterface` tiene 6 métodos, todos de envío.
- `FileStorageInterface` tiene 2 métodos, ambos de almacenamiento.
- Nunca juntar responsabilidades en una sola interfaz grande.

**D — Dependency Inversion**
Las clases de alto nivel no dependen de las de bajo nivel. Ambas dependen de abstracciones.
- `BotEngine` depende de `MessageClientInterface`, no de `WhatautoClient`.
- `BotEngine` depende de `FileStorageInterface`, no de `FileHandler`.

---

## 2. Estructura de proyecto PHP

```
proyecto/
├── public/                    ← webroot — ÚNICO directorio accesible desde web
│   ├── index.php              ← bootstrap (no hay lógica aquí)
│   ├── webhook.php            ← si aplica
│   └── .htaccess
│
├── src/
│   ├── Contract/              ← Interfaces y tipos abstractos
│   │   ├── MessageClientInterface.php
│   │   └── RepositoryInterface.php
│   │
│   ├── Domain/                ← Núcleo del negocio — sin dependencias externas
│   │   ├── Entity/            ← Entidades con identidad
│   │   │   └── User.php
│   │   ├── ValueObject/       ← Objetos inmutables sin identidad
│   │   │   └── IncomingMessage.php
│   │   └── Event/             ← Eventos de dominio
│   │
│   ├── Application/           ← Casos de uso — orquesta Domain e Infrastructure
│   │   ├── UseCase/
│   │   │   └── ProcessIncomingMessage.php
│   │   └── Service/
│   │
│   ├── Infrastructure/        ← Detalles técnicos (DB, HTTP, archivos)
│   │   ├── Persistence/       ← Repositorios concretos
│   │   │   └── MysqlUserRepository.php
│   │   ├── Http/              ← Controllers, Middleware
│   │   └── Client/            ← APIs externas
│   │       └── WhatautoClient.php
│   │
│   └── Support/               ← Transversales (no pertenecen a ninguna capa)
│       ├── Config.php
│       ├── Logger.php
│       └── Database.php
│
├── config/
│   ├── config.php             ← retorna array (nunca define())
│   └── config.example.php    ← para Git
│
├── database/
│   ├── schema.sql
│   └── migrations/
│
├── storage/
│   ├── logs/                  ← NUNCA en webroot
│   └── uploads/               ← NUNCA en webroot
│
├── tests/
│   ├── Unit/
│   └── Integration/
│
├── vendor/
│   └── autoload.php
│
├── CLAUDE.md                  ← Contexto para IA
├── AGENTS.md                  ← Contexto para otras IAs
├── .cursorrules               ← Reglas para Cursor
├── .editorconfig
├── .gitignore
└── composer.json
```

---

## 3. Convenciones de nomenclatura

### PHP

| Elemento | Convención | Ejemplo |
|---|---|---|
| Clase | PascalCase | `BotEngine` |
| Interface | PascalCase + sufijo | `MessageClientInterface` |
| Trait | PascalCase | `HasTimestamps` |
| Método | camelCase | `handleGreeting()` |
| Propiedad | camelCase | `$flowManager` |
| Constante de clase | UPPER_SNAKE | `MAX_RETRIES` |
| Archivo de clase | PascalCase.php | `BotEngine.php` |
| Archivo de test | NombreTest.php | `BotEngineTest.php` |

### JavaScript

| Elemento | Convención | Ejemplo |
|---|---|---|
| Función | camelCase | `callWebhook()` |
| Variable | camelCase | `messagePayload` |
| Constante global | UPPER_SNAKE | `MAX_RETRIES` |
| Clase | PascalCase | `BotClient` |
| Archivo módulo | camelCase.js | `webhookClient.js` |

### Base de datos

| Elemento | Convención | Ejemplo |
|---|---|---|
| Tabla | snake_case plural | `flow_steps` |
| Columna | snake_case | `created_at` |
| Índice | idx_tabla_col | `idx_contact_state` |
| FK constraint | fk_tabla_col | `fk_conv_contact` |
| UQ constraint | uq_tabla_col | `uq_phone` |

### CSS

| Elemento | Convención | Ejemplo |
|---|---|---|
| Clase componente | amr-kebab-case | `amr-card` |
| Clase modificador | amr-comp--mod | `amr-btn--danger` |
| Variable CSS | --amr-nombre | `--amr-primary` |

---

## 4. Reglas de DB

```sql
-- Estructura mínima de toda tabla
CREATE TABLE nombre_plural (
    id         INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    -- ... columnas del dominio ...
    created_at DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- Reglas:
-- 1. Siempre InnoDB
-- 2. Siempre utf8mb4 / utf8mb4_unicode_ci
-- 3. Toda FK tiene nombre: fk_tabla_columna
-- 4. Toda restricción única tiene nombre: uq_tabla_columna
-- 5. Índice en toda columna que aparezca en WHERE, JOIN, ORDER BY
-- 6. Nunca NULL en columnas requeridas (usar NOT NULL + DEFAULT)
-- 7. JSON para datos flexibles (MySQL 5.7.8+)
-- 8. Enums para campos de estado predefinido
```

---

## 5. Patrones de diseño

### Repository (Acceso a datos)

```php
// ✅ Correcto — repositorio abstrae el acceso a DB
interface ContactRepositoryInterface {
    public function findByPhone(string $phone): ?Contact;
    public function save(Contact $contact): void;
}

final class MysqlContactRepository implements ContactRepositoryInterface {
    public function __construct(private readonly PDO $db) {}
    // implementación...
}

// ❌ Incorrecto — PDO directo en lógica de negocio
class BotEngine {
    public function handle(): void {
        $pdo->query("SELECT * FROM contacts WHERE phone = ?"); // MAL
    }
}
```

### Value Object

```php
// ✅ Correcto — inmutable, sin setters, creado desde factory
final class IncomingMessage {
    public readonly string $from;
    public readonly string $body;

    private function __construct(string $from, string $body) {
        $this->from = $from;
        $this->body = $body;
    }

    public static function fromPayload(array $data): ?self {
        // validación y construcción
    }
}
```

### Strategy (Clientes intercambiables)

```php
// La interfaz define el contrato
interface MessageClientInterface {
    public function sendText(string $to, string $text): array;
}

// Dos implementaciones intercambiables
final class WhatautoClient  implements MessageClientInterface { ... }
final class WppConnectClient implements MessageClientInterface { ... }

// BotEngine no sabe cuál es cuál
final class BotEngine {
    public function __construct(
        private readonly MessageClientInterface $client
    ) {}
}
```

---

## 6. Seguridad

### Headers .htaccess (incluir en todo proyecto)

```apache
Header set X-Content-Type-Options "nosniff"
Header set X-Frame-Options "SAMEORIGIN"
Header set X-XSS-Protection "1; mode=block"
Header set Referrer-Policy "strict-origin-when-cross-origin"
Header set Permissions-Policy "camera=(), microphone=(), geolocation=()"
```

### PHP

```php
// Comparar tokens de forma segura (timing-safe)
if (!hash_equals($expected, $incoming)) { /* 401 */ }

// Validar uploads
$finfo = new finfo(FILEINFO_MIME_TYPE);
$mime = $finfo->file($tmpPath);
if (!in_array($mime, ALLOWED_MIMES, true)) { /* rechazar */ }

// Logs sin datos sensibles
$this->logger->info("User {$userId} logged in"); // OK
$this->logger->info("Password: {$password}");    // NUNCA
```

---

## 7. Testing

### PHP — PHPUnit

```php
final class BotEngineTest extends TestCase {
    public function test_handles_greeting_for_new_user(): void {
        // Arrange
        $client  = $this->createMock(MessageClientInterface::class);
        $db      = $this->createInMemoryDb();
        $engine  = new BotEngine($db, $client, /* ... */);

        // Assert mock expectation
        $client->expects($this->once())
               ->method('sendText')
               ->with($this->anything(), $this->stringContains('Hola'));

        // Act
        $engine->handle(IncomingMessage::fromWppPayload([...]));
    }
}
```

### JavaScript — Jest

```javascript
// tests/services/webhookClient.test.js
const { callWebhook } = require('../../src/services/webhookClient');

describe('callWebhook', () => {
  it('retries on failure and resolves empty array', async () => {
    // Arrange: mock axios to fail
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('timeout'));

    // Act
    const result = await callWebhook({ event: 'message', data: {} });

    // Assert
    expect(result).toEqual([]);
  });
});
```

---

## 8. Git workflow

### Ramas

```
main        ← producción (protegida, solo merge via PR)
develop     ← integración
feature/*   ← nuevas funcionalidades (desde develop)
fix/*       ← correcciones (desde develop o main)
hotfix/*    ← urgentes en producción (desde main)
```

### Commits — Conventional Commits

```
feat:     nueva funcionalidad
fix:      corrección de bug
refactor: refactoring sin cambio de comportamiento
docs:     documentación
test:     tests
chore:    tareas de mantenimiento (deps, config)
style:    formato, espacios (sin cambio de lógica)

Ejemplos:
feat(bot): add wpp-connect client for whatsapp-web.js integration
fix(flow): correct getFirstStep fetch chain
docs(readme): update installation steps for Hostinger
test(engine): add unit test for greeting state
```

### Pull Request template

```markdown
## ¿Qué hace este PR?
<!-- Descripción concisa -->

## Tipo de cambio
- [ ] Nueva funcionalidad
- [ ] Corrección de bug
- [ ] Refactoring
- [ ] Documentación

## Testing
- [ ] Tests unitarios pasando
- [ ] Probado manualmente

## Checklist
- [ ] Sigue SOLID
- [ ] Sin credenciales hardcodeadas
- [ ] Sin console.log / botLog en producción
- [ ] Schema migration incluida si aplica
```

---

## 9. Checklist de revisión de código

Antes de hacer commit o PR, verificar:

- [ ] `declare(strict_types=1)` en todos los PHP
- [ ] Sin `define()` global — usando Config
- [ ] Sin `global` variables
- [ ] Sin SQL concatenado
- [ ] Sin credenciales hardcodeadas
- [ ] Sin `console.log` / `botLog` en producción
- [ ] Clases < 200 líneas
- [ ] Tests para lógica de negocio nueva
- [ ] `.env` y `config.php` en `.gitignore`
- [ ] `final` en clases concretas
- [ ] Interfaces para dependencias inyectadas
- [ ] Variables CSS del design system en frontend
- [ ] Responsive en dashboard (breakpoints documentados)
