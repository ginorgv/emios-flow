# Pieza EMIOS para EMIOS Flow

Integra la plataforma **EMIOS** (gestión energética) con **EMIOS Flow** (Activepieces CE).

## Conexión

Una sola conexión por cliente/servidor:

| Campo | Descripción |
|---|---|
| **URL del servidor EMIOS** | Sin barra final. Por defecto el servidor de producción de EMIOS. |
| **Usuario del API** | Usuario de EMIOS con acceso al API externo. |
| **Contraseña del API** | Se guarda cifrada por la plataforma (nunca viaja en el flujo). |

## Acciones

| Acción | Qué hace |
|---|---|
| **Listar redes** | Devuelve las redes a las que tiene acceso el usuario del API. |
| **Listar sensores** | Sensores de una red (desplegable). |
| **Valores actuales de un sensor** | Último valor disponible (tiempo real e intervalos procesados). |
| **Histórico de valores** | Valores entre dos fechas, con el intervalo que se elija (hora, día, mes…). |
| **Simular factura** | Simula la factura del sensor con una de sus tarifas. |

Los identificadores de red, sensor y tarifa **no se escriben a mano**: los desplegables se
rellenan consultando el propio API de EMIOS. Al elegir la red, se cargan sus sensores; al
elegir el sensor, sus tarifas.

## Formatos y límites del API de EMIOS

- Las fechas se envían en formato EMIOS: `dd-mm-yyyy_HH:MM:SS` (ejemplo `03-06-2024_00:00:00`).
- Límites: 31 días por consulta de histórico (366 días en algunos intervalos), 50.000 valores,
  20 sensores, 5 tarifas y hasta 60 peticiones por minuto.

## Detalles técnicos

Pieza escrita en JavaScript (CommonJS), sin paso de compilación. Toda la lógica de acceso al
API está en `src/lib/emios-api.js`, que centraliza la llamada GET, el control de errores y la
lectura tolerante de las listas.

---

# Cómo publicar una versión nueva

No hace falta reconstruir la imagen de EMIOS Flow: la plataforma instala la pieza subiendo un
`.tgz` (pieza `CUSTOM` de tipo `ARCHIVE`) y **instala sola** la dependencia
`@activepieces/pieces-framework`.

```powershell
cd piece-emios

# 1. Editar el código en src/ y SUBIR LA VERSION en package.json (x.y.z).
#    La plataforma rechaza una version ya existente para el mismo nombre.

# 2. (solo la primera vez) instalar el framework para poder validar en local
npm install --no-audit --no-fund

# 3. Validar que la pieza carga y expone bien acciones y propiedades
node probar-pieza.js

# 4. Empaquetar
npm pack        # genera activepieces-piece-emios-<version>.tgz  (~5 KB)
```

**Subirla** (hay que ser administrador de plataforma):

- **Interfaz**: EMIOS Flow → *Administrador de Plataforma* → **Piezas** → subir pieza → elegir el `.tgz`.
- **API**: `POST /api/v1/pieces` en `multipart/form-data` con los campos
  `packageType=ARCHIVE`, `scope=PLATFORM`, `pieceName=@activepieces/piece-emios`,
  `pieceVersion=<version>` y el fichero en el campo `pieceArchive`.

**Al usarla en un flujo**, dos detalles que cuestan tiempo si no se saben:

1. La conexión se referencia como `"auth": "{{connections['<externalId>']}}"` — **no** vale el id
   interno de la conexión (la pieza recibiría las credenciales vacías).
2. El resultado de una acción es **el objeto devuelto directamente**: se referencia como
   `{{step_1['output'].campo}}`, **sin** `.body` (a diferencia de la pieza HTTP).

**Lección sobre las credenciales**: la plataforma entrega la conexión de dos formas
(`{props: {...}}` o los props planos) según el caso; `normalizaCredenciales()` en
`src/lib/emios-api.js` acepta las dos.
