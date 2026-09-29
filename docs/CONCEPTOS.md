# Conceptos: qué es cada cosa y por qué vale la pena

🌐 [English](en/CONCEPTS.md) | **Español**

Este documento está escrito para alguien que **no** tiene por qué saber qué es un
embedding. No hay código acá. La idea es que al terminar de leerlo se entienda
qué construimos, con qué piezas, y sobre todo **qué problema concreto resuelve**.

Si querés la referencia de las herramientas una por una, eso está en
[`COMO_FUNCIONA.md`](COMO_FUNCIONA.md). Esto es el "por qué".

---

## 1. El problema, antes de hablar de tecnología

El conocimiento de un equipo de desarrollo vive desparramado en cuatro lugares
que no se hablan entre sí:

| Dónde vive | Qué hay ahí |
|---|---|
| **El gestor de tareas** | Qué hay que hacer, quién lo hace, en qué columna está |
| **GitHub** | El código, los commits, las ramas, los PRs |
| **La documentación** (los `.md` dentro de cada repo) | Cómo funciona cada cosa, qué se decidió y por qué |
| **La cabeza de la gente** | Todo lo demás |

Cuando alguien pregunta *"¿en qué quedó lo de la generación de trámites de
BILLING?"*, la respuesta no está en ninguno de los cuatro: está **repartida**.
Hay una tarjeta en el gestor de tareas, una rama en GitHub con trabajo a medio terminar,
y un archivo markdown en esa rama que explica el diseño. Armar la respuesta
significa abrir tres pestañas y saber de antemano dónde mirar.

Ese "saber de antemano dónde mirar" es exactamente lo que no escala. Es lo que
hace que preguntarle a la persona que lo hizo sea siempre más rápido que
buscarlo — y por eso el conocimiento no se comparte: se interrumpe.

**Lo que construimos es el puente.** Un asistente que ya sabe dónde mirar,
mira solo, y contesta citando de dónde sacó cada cosa.

---

## 2. Qué es un MCP

**MCP** (Model Context Protocol) es un estándar para conectarle **herramientas**
a un asistente de IA.

La analogía que funciona es el **tomacorriente**. Antes de que existiera un
estándar de enchufes, cada artefacto venía con su propia forma de conectarse a la
electricidad. El estándar no hace que la lámpara ilumine mejor: hace que
cualquier lámpara entre en cualquier pared.

MCP es eso para la IA. Un "servidor MCP" es un adaptador que dice:
*"yo sé hablar con este sistema, y le ofrezco al asistente estas acciones
concretas"*. El asistente no necesita saber nada de GitHub ni de nuestra base de
datos: solo ve una lista de acciones disponibles con su descripción.

Este proyecto es un servidor MCP:

- **`repo-rag-mcp`** — los repositorios: estado en vivo + búsqueda sobre la
  documentación. **Solo lectura.**

### Qué es una "tool"

Una **tool** es una acción concreta que el asistente puede ejecutar. Por ejemplo
`list_branches` ("listame las ramas de este repo") o `get_file_content` ("traeme este archivo").

El detalle importante, y que sorprende a casi todos: **el asistente elige cuál
usar leyendo su descripción, como leería un manual.** No hay un `if` en el código
que diga "si el usuario pregunta X, llamá a Y". Por eso en este proyecto las
descripciones de las tools están escritas con tanto cuidado: ahí se explica
cuándo usarla, cuándo *no*, y con cuál se confunde. Esa descripción **es** la
lógica de ruteo.

---

## 3. Qué es RAG

**RAG** = *Retrieval-Augmented Generation*. En castellano: **buscá primero,
después contestá**.

Un modelo de lenguaje solo, sin RAG, es como un empleado brillante que estudió
muchísimo hasta cierta fecha y después se fue de viaje. Sabe muchísimo del mundo,
pero **no sabe nada de nuestros repos**. Si le preguntás por el sistema de turnos
de la organización, va a hacer lo peor que puede hacer: inventar una respuesta plausible,
porque su trabajo es producir texto que suene bien.

RAG cambia la mecánica en dos pasos:

1. **Buscar** los fragmentos de documentación que hablan de lo que preguntaste.
2. **Pasárselos al modelo** junto con la pregunta, y pedirle que conteste
   *usando eso*.

El modelo deja de ser el que sabe y pasa a ser el que **redacta**. La verdad
viene de nuestros documentos. Por eso el sistema puede citar archivo y rama en
cada respuesta, y por eso puede decir "no encontré nada sobre esto" en vez de
inventar.

> Frase para retener: **RAG no le enseña nada al modelo. Le pasa el apunte
> abierto en la página correcta.**

### El paso difícil es el 1

Suena fácil hasta que te preguntás: ¿cómo hace una máquina para saber que la
pregunta *"¿cómo entran los vecinos al sistema?"* se responde con una sección
titulada *"Autenticación con DNI y clave fiscal"*, si no comparten ni una sola
palabra?

Ahí entran los embeddings.

---

## 4. Qué es un embedding

Un **embedding** es una forma de convertir un texto en **coordenadas de
significado**.

La analogía: imaginá un mapa gigante donde cada texto ocupa una posición. No un
mapa geográfico — un mapa de *temas*. Todo lo que habla de autenticación cae en
una zona; todo lo que habla de reportes cae en otra, lejos. Textos que dicen lo
mismo con palabras distintas caen **cerca**, porque lo que decide la posición es
el sentido, no las letras.

Un embedding es la dirección de un texto en ese mapa. Técnicamente es una lista
larga de números, pero alcanza con entenderlo así: **es una posición, y se pueden
medir distancias entre posiciones**.

Entonces buscar se vuelve geometría:

1. Se calcula la posición de la **pregunta** en el mapa.
2. Se buscan los fragmentos de documentación **más cercanos** a esa posición.
3. Esos son los resultados.

Por eso "cómo entran los vecinos" encuentra la sección de autenticación: en el
mapa de significados están al lado, aunque en el diccionario no se toquen.

Quien calcula esas coordenadas es un modelo especializado en eso — nosotros
usamos uno llamado `bge-m3`, **corriendo en la máquina local**. Volvemos a esto
en el punto 8, porque tiene una consecuencia importante para la organización.

### Chunks: por qué se corta la documentación en pedazos

Un README entero no tiene *un* significado: tiene diez. Si le calculamos una sola
posición al archivo completo, queda en el promedio de todos sus temas — es decir,
en ningún lado útil.

Por eso cada documento se corta en **chunks** (fragmentos), respetando los
títulos y subtítulos que el autor ya escribió. Cada sección es una unidad de
sentido y recibe su propia posición en el mapa.

Es la diferencia entre indexar un libro entero bajo "libro" e indexarlo por
capítulo. Cuando buscás, te devuelve el capítulo, no la biblioteca.

### El índice: qué es y por qué existe

Calcular la posición de un texto cuesta tiempo. Hacerlo para toda la
documentación de todos los repos en el momento en que alguien pregunta sería
inaceptablemente lento.

Así que se hace **una vez, por adelantado**, y se guarda en una base de datos
local (un archivo en tu máquina). Eso es **el índice**: la copia de la
documentación con sus coordenadas ya calculadas. Buscar contra el índice es
instantáneo.

**Consecuencia clave, y es la que más confunde: el índice es una foto, no un
espejo.** Refleja la documentación tal como estaba la última vez que se indexó.
Si alguien reescribió un README hace diez minutos, la búsqueda todavía contesta
con la versión anterior.

Por eso el servidor **se reindexa solo al arrancar** —todo repo cuyo índice tenga
más de 12 horas se actualiza en segundo plano— y además hay una herramienta para
forzarlo a mano. Y por eso el estado en vivo (commits, PRs, issues) **no** pasa
por el índice: eso se le pregunta a GitHub en el momento, siempre.

> Regla práctica: *"¿qué pasó?"* es en vivo. *"¿cómo funciona?"* es índice.

---

## 5. Por qué la búsqueda usa dos motores a la vez

El buscador por significado tiene un punto ciego serio: **no sabe buscar nombres
propios**. Si preguntás por `BILLING`, o por un número de trámite, o por el
nombre exacto de una clase, el mapa de significados no ayuda — esos términos no
tienen "sentido", tienen **identidad**.

Para eso está el buscador clásico por **palabra exacta** (se llama BM25; es la
técnica de toda la vida: cuenta apariciones y pondera qué tan raro es cada
término). Ese encuentra `BILLING` al instante, pero no entiende que "cómo entran
los vecinos" y "autenticación" son lo mismo.

Cada uno cubre el punto ciego del otro, así que **corren los dos y se combinan
los resultados**. Esto no es teoría: lo medimos sobre preguntas reales sacadas de
una conversación de uso.

| | Encontró el documento correcto en el top 5 |
|---|---|
| Solo por significado | 4 de 6 |
| Solo por palabra exacta | 3 de 6 |
| **Los dos combinados** | **4 de 6, y mucho mejor rankeado** |

El caso que lo demuestra: la pregunta real sobre BILLING pasó del **puesto 146
al puesto 3**.

*(Salvedad honesta: son 6 preguntas. La dirección es clara, la precisión del
número no. Hacen falta más preguntas reales de uso para afinarlo — y eso solo
sale de usar el sistema.)*

**De acá sale un consejo práctico para quien pregunta:** incluí en tu pregunta
los términos literales que sepas. "¿Qué dice la documentación de BILLING sobre
la generación de trámites?" funciona mucho mejor que "¿cómo va lo de
billing?", porque le da material a los dos buscadores.

### Cómo se combinan (en una frase)

Un puntaje de "cercanía en el mapa" y un puntaje de "cuántas veces aparece la
palabra" están en escalas que no se pueden sumar — es como promediar grados
Celsius con kilómetros. Así que no se suman los puntajes: **se suman las
posiciones en cada ranking**. Lo que salió primero en cualquiera de las dos
listas sube. Es una técnica estándar y no hay que recalibrar nada cuando cambia
el modelo o crece la documentación.

---

## 6. Sobre la palabra "topics"

Aclaración, porque genera confusión: **"topic" no es un concepto de este
servidor.** No hay temas configurables ni categorías que alguien tenga que
mantener. La organización del contenido sale sola de la estructura que ya tienen
los documentos (títulos y subtítulos) y de las coordenadas de significado.

Si la palabra apareció en alguna conversación, viene de otro lado: el sistema de
memoria que usa el asistente entre sesiones usa "topic" como etiqueta para
agrupar notas que van evolucionando. Es una pieza del asistente, no de nuestros
repos.

---

## 7. Por qué un MCP y no "que use la API de GitHub"

Esta es la pregunta correcta y merece una respuesta concreta. GitHub tiene una
API pública; un asistente moderno podría, en principio, pegarle directamente.
Cuatro razones por las que no alcanza:

**1. La API contesta datos crudos; nosotros necesitamos respuestas.**
"¿Cómo viene el portal?" con la API cruda son cuatro o cinco llamadas encadenadas
(traer el repo, la rama por defecto, el último commit, los PRs abiertos, los
issues) y después armar el rompecabezas. Nuestro `get_project_summary` es **una**
llamada que devuelve exactamente eso, ya ordenado. Menos pasos, menos lugares
donde equivocarse, respuestas más rápidas y más baratas.

**2. La API no busca por significado. Punto.**
GitHub no tiene forma de responder "¿qué proyecto maneja notificaciones por SMS?"
sin que vos ya sepas en qué repo mirar. Toda la mitad RAG de este sistema —el
mapa de significados, los fragmentos, la búsqueda híbrida— **no existe en
GitHub**. Es la parte que agrega valor real y no se reemplaza con acceso a la
API.

**3. Solo lectura, garantizado por construcción.**
Un asistente con un token de GitHub genérico puede cerrar un issue, aprobar un PR
o hacer push. No porque alguien quiera: porque se equivocó de herramienta en un
momento ambiguo. En nuestro servidor **esas funciones directamente no existen en
el código**. No es una configuración que se pueda cambiar por accidente ni un
permiso que alguien pueda tocar: no hay nada que llamar. Lo único que escribe es
el índice local, en tu máquina.

**4. Nuestras convenciones están adentro.**
En la organización `main` es producción y `dev` es la réplica, y el trabajo en curso vive
en ramas que nunca llegan a `main`. El servidor indexa esas dos ramas más
cualquier rama con actividad reciente, y **cada resultado dice en qué ramas
aparece** — o sea, si eso ya está en producción o todavía es trabajo a medio
hacer. Un asistente con acceso crudo a la API mira `main` y te dice que el
proyecto no tiene esa funcionalidad. Y tendría razón, y estaría equivocado.

Resumiendo: la API es una fuente. El MCP es una **fuente más el criterio de cómo
usarla**, y ese criterio es lo que hoy vive solo en la cabeza del equipo.

---

## 8. Qué sale de la organización y qué no

Importante para cualquier conversación sobre datos internos:

- **El análisis del texto es local.** Las coordenadas de significado se calculan
  con un modelo que corre en la máquina, no en un servicio externo. La
  documentación de los repos **no se manda a ningún proveedor de IA** para ser
  indexada.
- **El índice es un archivo local.** No hay base de datos en la nube.
- **Lo único que sale a internet** son consultas de **lectura** a la API de
  GitHub, con un token que el equipo ya tiene.
- **Nada se escribe en GitHub.** Nunca.

---

## 9. Los límites, dichos de frente

Para que nadie se lleve una sorpresa:

- **El índice puede estar viejo.** Se refresca solo al arrancar y se puede
  forzar, pero entre medio es una foto. El estado en vivo no tiene este problema.
- **No lee el código fuente**, solo la documentación en markdown. Si preguntás
  cómo está implementada una función, el servidor no la tiene.
- **La calidad de las respuestas es la calidad de la documentación.** Esto es lo
  más importante de todo el documento: RAG no crea conocimiento, lo encuentra. Un
  repo sin documentación no se vuelve consultable por instalar esto. El lado
  bueno es que da un incentivo directo y visible a documentar: lo que se escribe
  se vuelve consultable por todo el equipo esa misma noche.
- **No reemplaza mirar el repo.** Para el diff exacto de un commit o la discusión
  de un PR, GitHub sigue siendo mejor.
- **El asistente puede elegir mal la herramienta.** Es menos probable con
  descripciones bien escritas, pero pasa. Por eso cada respuesta cita el archivo
  y la rama: se puede verificar.

---

## En dos frases

Teníamos el conocimiento del equipo repartido en tres sistemas que no se hablan,
y la forma más rápida de acceder a él era interrumpir a alguien. Ahora hay un
asistente que sabe dónde mirar, mira solo, contesta citando la fuente, y **no
puede romper nada porque no tiene con qué escribir**.
