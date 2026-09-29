# Cómo funciona

🌐 [English](en/HOW_IT_WORKS.md) | **Español**

Explicación de qué hace el servidor, cuándo usa cada herramienta y qué esperar de
cada respuesta. No hace falta saber nada de embeddings para leer esto.

Si lo que buscás es entender los conceptos de fondo —qué es RAG, qué es un
embedding, por qué un MCP y no la API de GitHub—, eso está en
[`CONCEPTOS.md`](CONCEPTOS.md).

---

## La idea en un párrafo

El servidor no responde preguntas: **junta información y se la pasa al modelo**,
que es el que redacta la respuesta. Le da al agente nueve herramientas y una
descripción de cuándo conviene usar cada una. El agente elige.

---

## Las dos fuentes de información

Esta es la distinción que explica casi todo el comportamiento del sistema.

### Estado en vivo

Commits, pull requests, issues, contenido de un archivo. Se consultan a GitHub en
el momento, cada vez.

- **Siempre actualizado**, al segundo.
- Tarda un poco más (hay que ir a la red).
- Nunca necesita reindexar nada.

### Búsqueda sobre la documentación (RAG)

Preguntas sobre lo que los proyectos *hacen*: cómo funciona algo, qué se decidió,
qué falta. Se responden buscando en una copia local de la documentación.

- Responde por **significado**, no por palabras exactas: "¿cómo entran los
  vecinos al sistema?" encuentra la sección que habla de autenticación con DNI,
  aunque no diga "entrar" en ningún lado.
- Es instantáneo (no sale a la red).
- **Es una foto, no un espejo**: refleja la documentación tal como estaba la
  última vez que se indexó.

Regla práctica: *¿qué pasó?* es en vivo. *¿cómo funciona?* es búsqueda sobre la
documentación.

---

## Las nueve herramientas

### `list_projects`

Lista todos los repos configurados con su descripción, cuándo se tocaron por
última vez y si están indexados.

> "¿Qué proyectos tenés?" · "listame los repos de la organización"

Es también lo que el agente usa cuando nombrás un proyecto de memoria y necesita
averiguar a qué repositorio te referís.

### `get_project_status`

Estado actual de un proyecto: branch principal, último commit (quién, cuándo,
qué), cuántos PRs y cuántos issues abiertos. En vivo.

> "¿Cómo está el de turnos?" · "¿cuántos PRs abiertos tiene trámites?"

### `get_recent_commits`

Los últimos commits en crudo: sha corto, autor, fecha y mensaje. En vivo. Por
defecto trae 10.

> "¿Qué se hizo esta semana en el portal?" · "¿quién viene tocando trámites?"

Sirve para armar un resumen de actividad a mano. No lee la documentación.

### `search_project_docs`

La búsqueda sobre la documentación. Devuelve los fragmentos más relevantes, cada
uno con el repo, el archivo y la rama de donde salió, así el agente puede citar
de dónde sacó cada cosa.

Usa **dos buscadores a la vez** y combina los resultados:

- **Por significado**: entiende de qué habla la pregunta. Preguntás "cómo entran
  los vecinos" y encuentra la sección de autenticación aunque no diga "entrar".
- **Por palabra exacta**: encuentra el término tal cual está escrito. "BILLING",
  un número de trámite, el nombre de una clase.

Cada uno cubre el punto ciego del otro. El primero no sabe buscar nombres
propios; el segundo no entiende parafraseos. Por eso **conviene incluir en la
pregunta los términos literales que sepas** — hacen la búsqueda mucho más
precisa.

Cada resultado dice cómo fue encontrado: `both` significa que las palabras
exactas están en el texto, lo cual es una señal mucho más fuerte que solo
parecerse en significado.

> "¿Cómo se autentican los vecinos?" · "¿qué proyecto maneja notificaciones por
> SMS?" · "¿qué dice el tracker de turnos sobre reportes?"

Se puede acotar a un proyecto, o a una rama, o buscar en todo a la vez. Si no
encuentra nada lo dice explícitamente en vez de inventar: o la documentación no
cubre el tema, o el índice está viejo.

### `refresh_index`

Rearma el índice de búsqueda: vuelve a leer los documentos desde GitHub, los
corta en pedazos y los procesa localmente.

> "Actualizá el índice" · "reindexá turnos"

Es la única herramienta que escribe algo, y escribe **solo en tu máquina**.
Reindexar todo puede tardar varios minutos; un solo proyecto, segundos.

### `get_project_summary`

Resumen ejecutivo en una sola llamada: el estado en vivo más el comienzo del
README. Pensado para no tener que encadenar dos o tres herramientas.

> "Contame cómo viene el portal" · "resumime trámites"

No usa el índice, así que nunca está desactualizado.

### `list_branches`

Lista las ramas de un repo con su última actividad y si su documentación está
indexada.

> "¿En qué rama está la tarea de BILLING?" · "¿qué ramas hay en trámites?"

Sirve porque todas las demás herramientas miran la rama principal salvo que se
les diga otra cosa. Si el trabajo todavía no se mergeó, esta es la que lo
encuentra.

### `get_file_content`

Trae un archivo entero, sin cortar.

> "Mostrame el TRACKER completo de turnos" · "leeme el NEGOCIO.md del portal"

Cuando pedís *un archivo por su nombre*, va esta. Cuando preguntás por *un tema*,
va `search_project_docs`, que busca en todos los archivos sin que tengas que
adivinar en cuál está.

### `compare_status`

El estado en vivo de varios proyectos en una sola llamada, ordenado por
actividad más reciente. Si no le pasás repos, los compara todos.

> "¿Cómo vienen todos los proyectos?" · "¿cuál se movió último?"

Es `get_project_status` repetido, pero sin encadenar una llamada por repo. Un
repo que falla se reporta como tal y no tumba al resto del listado.

---

## De la pregunta a la herramienta

| Lo que preguntás | Lo que dispara |
|---|---|
| "¿Qué proyectos hay?" | `list_projects` |
| "¿Cómo viene turnos?" | `get_project_summary` |
| "¿Cuántos PRs abiertos tiene el portal?" | `get_project_status` |
| "¿Qué se hizo esta semana?" | `get_recent_commits` |
| "¿Cómo se autentican los vecinos?" | `search_project_docs` |
| "¿Qué proyecto manda SMS?" | `search_project_docs` (en todos los repos) |
| "Mostrame el TRACKER de turnos" | `get_file_content` |
| "¿En qué rama está X?" | `list_branches` |
| "Actualizá la documentación" | `refresh_index` |
| "¿Cómo vienen todos los proyectos?" | `compare_status` |

---

## Ramas: producción, réplica y trabajo en curso

Los repos de la organización siguen una convención: **`main` es producción** y **`dev`
es la réplica**. El índice cubre las dos, y además cualquier rama con actividad
en los últimos 30 días.

Esto importa porque **la documentación del trabajo en curso vive en la rama
donde se está trabajando**, y no llega a `main` hasta que se mergea. Si el
índice solo mirara `main`, todo lo que está a mitad de camino sería invisible —
justo lo que uno más quiere preguntar.

Por eso cada resultado de búsqueda dice **en qué ramas** aparece:

- Aparece en `main` → está en producción.
- Aparece en `main` y `dev` → igual en las dos.
- Aparece **solo** en una rama de feature → es trabajo en curso, todavía no
  está en producción.

Cuando un texto es idéntico en varias ramas se muestra **una sola vez**,
listando todas las ramas donde está. Sin eso, un repo con seis ramas activas
llenaría los resultados con seis copias de lo mismo.

---

## Cuándo se actualiza el índice

Indexar significa leer la documentación de GitHub y procesarla localmente. Cuesta
tiempo y trabajo de máquina, así que no pasa en cada pregunta. Pasa en tres
momentos:

1. **Al arrancar el servidor**, solo. Todo repo cuyo índice tenga más de 12 horas
   se actualiza en segundo plano. Se puede cambiar ese umbral, o desactivarlo.
2. **Cuando se lo pedís**, con `refresh_index`.
3. Fuera del agente, corriendo `pnpm reindex` a mano.

El punto 1 corre **sin bloquear el arranque**: las herramientas ya contestan
—desde el índice viejo— mientras la actualización va por detrás. Es a propósito:
un servidor que contesta con un índice de ayer es muchísimo mejor que uno que te
deja esperando a que termine de indexar.

La consecuencia práctica que queda igual: si alguien reescribió un README hace
diez minutos, `search_project_docs` puede seguir contestando con la versión
anterior hasta la próxima actualización. Ante la duda, pedile al agente que
reindexe ese repo y volvé a preguntar. El estado de commits, PRs e issues **no**
tiene este problema: siempre es en vivo.

---

## Qué NO hace este servidor

- **No escribe nada en GitHub.** No crea ni cierra issues, no comenta, no aprueba
  PRs, no hace push. No es una configuración que se pueda cambiar: esas funciones
  no existen en el código.
- **No lee el código fuente.** El índice solo toma documentación en markdown. Si
  preguntás cómo está implementada una función, el servidor no la tiene.
- **No reemplaza mirar el repo.** Para el detalle fino —el diff exacto de un
  commit, la discusión de un PR, un archivo de configuración— sigue siendo mejor
  abrir GitHub.
- **No inventa.** Cuando la búsqueda no encuentra nada relevante lo dice, y
  cuando un repo no responde lo reporta en vez de omitirlo en silencio.
- **No manda tu documentación a ningún lado.** El procesamiento de texto es
  local, con Ollama en tu máquina. Lo único que sale a internet son las consultas
  de lectura a la API de GitHub.
