# Instalación (Windows + OpenCode)

🌐 [English](en/INSTALLATION.md) | **Español**

Guía paso a paso. Al final vas a poder preguntarle al agente por el estado de los
repos de la organización sin salir del editor.

Tiempo estimado: 20 minutos, la mayoría esperando descargas.

---

## 1. Requisitos

### Node.js 20 o superior

```powershell
node --version
```

Si no lo tenés: https://nodejs.org (elegí la versión LTS).

### pnpm

```powershell
npm install -g pnpm
pnpm --version
```

### Ollama + el modelo de embeddings

Ollama es lo que convierte el texto de la documentación en números para poder
buscarla por significado. Corre **local**: nada de lo que se indexa sale de tu
máquina.

**1. Instalar Ollama.** Con winget, desde PowerShell:

```powershell
winget install --id Ollama.Ollama
```

O bajando el instalador de https://ollama.com/download — da lo mismo.

> **Abrí una terminal nueva después de instalar.** El instalador agrega Ollama al
> PATH, pero las terminales que ya estaban abiertas siguen con el PATH viejo y te
> van a decir `ollama: command not found`. No es un error de instalación: cerrá y
> abrí de nuevo.

**2. Descargar el modelo** (una sola vez; es multilingüe y pesa alrededor de
1 GB, así que puede tardar):

```powershell
ollama pull bge-m3
```

**3. Verificar** que quedó todo:

```powershell
ollama list
```

Tenés que ver `bge-m3:latest` en la lista.

Ollama arranca solo con Windows. Si en algún momento no responde, abrí una
terminal y dejá corriendo `ollama serve`.

---

## 2. Instalar el servidor

```powershell
cd C:\ruta\donde\lo\quieras
git clone <url-del-repo> repo-rag-mcp
cd repo-rag-mcp
pnpm install
pnpm build
```

> `pnpm install` compila un componente nativo (`better-sqlite3`). Si ves un aviso
> tipo *"Ignored build scripts"*, corré `pnpm rebuild better-sqlite3` y listo. No
> hace falta Visual Studio: baja un binario ya compilado.

---

## 3. Generar el token de GitHub

El servidor necesita un token para leer los repos. **Solo lectura**: aunque
alguien se lo pidiera, el servidor no tiene ninguna función que escriba.

1. Entrá a https://github.com/settings/personal-access-tokens/new
   (Settings → Developer settings → Personal access tokens → **Fine-grained tokens**)
2. **Token name**: `repo-rag-mcp`
3. **Expiration**: 90 días (anotá la fecha, vas a tener que renovarlo)
4. **Resource owner**: tu organización
5. **Repository access** → *Only select repositories* → elegí únicamente los
   repos que querés consultar
6. **Permissions** → *Repository permissions*, poné en **Read-only**:

   | Permiso | Valor | Para qué |
   |---|---|---|
   | Contents | Read-only | Leer README y demás documentación |
   | Metadata | Read-only | Datos del repo (obligatorio, se activa solo) |
   | Pull requests | Read-only | Contar PRs abiertos |
   | Issues | Read-only | Contar issues abiertos |

   **No habilites nada en Write.**

7. **Generate token** y copiá el valor. GitHub lo muestra una sola vez.

> Si el token es de una organización, puede quedar pendiente de aprobación de un
> administrador. Hasta que lo aprueben, las llamadas van a dar error de permisos.

---

## 4. Configurar el servidor

### 4.1 El archivo `.env`

Copiá el ejemplo y editalo:

```powershell
copy .env.example .env
notepad .env
```

Pegá el token:

```
GITHUB_TOKEN=github_pat_loquecopiaste
```

El resto de las variables ya tienen valores por defecto que funcionan. **No
compartas ni subas este archivo**: `.gitignore` ya lo excluye.

### 4.2 El archivo `repos.json`

**Es obligatorio**: sin este archivo el server no arranca. No se versiona (está en
`.gitignore`) porque nombra tus repos internos; el repo solo trae la plantilla
`repos.example.json`. Copiala y editala:

```powershell
copy repos.example.json repos.json
notepad repos.json
```

Reemplazá todos los valores `REPLACE-ME`. Si quedan, el server avisa por stderr al
arrancar. Ejemplo ya completo:

```json
{
  "org": "nombre-de-la-organizacion",
  "defaultDocs": ["README.md", "CLAUDE.md", "TRACKER.md", "NEGOCIO.md", "docs/**"],
  "repos": [
    {
      "alias": "turnos",
      "repo": "sistema-turnos",
      "description": "Turnos online para trámites"
    }
  ]
}
```

- `alias` es el nombre corto que vas a usar al preguntar ("el de turnos").
  Minúsculas y guiones.
- `repo` es el nombre exacto en GitHub.
- `docs` es opcional por repo: si un proyecto guarda la documentación en otro
  lado, ponéselo ahí y pisa la lista general.

---

## 5. Primer indexado

```powershell
pnpm reindex
```

Salida esperada:

```
Indexing 4 repositories with bge-m3...
  OK    example-org/sistema-turnos: 3 files, 27 chunks
  OK    example-org/trámites: 2 files, 14 chunks
  ...
Index up to date.
```

La primera vez tarda más porque Ollama carga el modelo en memoria.

Para reindexar un solo proyecto:

```powershell
pnpm reindex turnos
```

---

## 6. Conectar el servidor a OpenCode

Abrí (o creá) el archivo de configuración de OpenCode y agregá el servidor:

```json
{
  "mcp": {
    "repos-rag": {
      "type": "local",
      "command": ["node", "C:/ruta/completa/repo-rag-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

Detalles que importan:

- Usá la **ruta absoluta** a `dist/index.js`.
- Barras normales `/`, o barras invertidas dobles `\\`. Una sola `\` rompe el JSON.
- Tiene que apuntar a `dist/`, no a `src/` (por eso corriste `pnpm build`).
- No hace falta pasar variables de entorno: el servidor lee su propio `.env`.

Reiniciá OpenCode y pedile algo como *"listame los proyectos de la organización"*.

---

## 7. Si algo falla

### "Cannot reach Ollama at http://localhost:11434"

Ollama no está corriendo. Abrí una terminal y dejá:

```powershell
ollama serve
```

### "Ollama does not have the model bge-m3"

```powershell
ollama pull bge-m3
```

### "Not found on GitHub: org/repo"

Tres causas posibles, en orden de probabilidad:

1. El nombre en `repos.json` no coincide exactamente con el de GitHub (mirá
   mayúsculas y guiones).
2. El token no incluye ese repo en *Repository access*.
3. El token todavía no fue aprobado por un administrador de la organización.

### "GitHub rejected the token (401)"

El token está mal copiado, venció o fue revocado. Generá uno nuevo y actualizá
`.env`.

### "The GitHub token is not allowed to read..."

Le falta algún permiso. Volvé al paso 3 y revisá que Contents, Metadata, Pull
requests e Issues estén los cuatro en Read-only.

### "GitHub rate limit hit"

Pediste demasiado en poco tiempo. El mensaje dice a qué hora se libera la cuota.
Suele pasar con `refresh_index` sin argumentos sobre muchos repos: reindexá de a
uno.

### "The documentation index is empty"

Todavía no corriste `pnpm reindex`, o el índice se borró. Corrélo.

### El agente responde con información vieja

El índice es una **foto**, no un espejo. Si la documentación cambió, corré
`pnpm reindex` (o pedile al agente que use `refresh_index`). El estado de commits
y PRs, en cambio, siempre es en vivo y nunca queda viejo.

### El servidor no aparece en OpenCode

Probá arrancarlo a mano para ver el error:

```powershell
node dist/index.js
```

Debería imprimir `repo-rag MCP server running on stdio — ...`. Si imprime
otra cosa, ese es el problema real. Cortá con `Ctrl+C`.
