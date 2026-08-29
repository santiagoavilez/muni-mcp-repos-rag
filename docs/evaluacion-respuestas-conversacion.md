# Evaluacion de respuestas de la conversacion

Documento para medir la calidad, precision, actualidad y trazabilidad de las respuestas obtenidas mediante el MCP.

## 1. Rama de la tarea de generacion de trámites para BILLING

**Pregunta**

> ¿En qué rama está la tarea de generación de trámites para BILLING?

**Respuesta entregada**

La tarea **“API generación de trámites - BILLING”** está en la rama:

`feature/external-api`

Repositorio: `example-org/project-a-back`

**Evidencia consultada**

- Tablero `Seguimiento de trámites`, tarea 45.
- Repositorio `example-org/project-a-back`.
- Archivo `API_DOCUMENTATION.md` en la rama `feature/external-api`.

**Evaluacion**

- Exactitud: [ ]
- La rama coincide con la tarea: [ ]
- La respuesta distingue una rama de trabajo de `main`: [ ]
- La evidencia es suficiente: [ ]

## 2. Estado de Project B

**Pregunta**

> ¿Cómo viene Project B?

**Respuesta entregada**

**Project B está estable y bastante avanzado:**

- Repositorio: `example-org/project-b-back`.
- Rama principal: `main`.
- Última actividad: **27/08/2026**.
- Último cambio: soporte para acción `unpublish` en estados de formularios, con mensajes y tests actualizados.
- Pull requests abiertos: **0**.
- Issues abiertos: **0**.
- Ramas de trabajo recientes: permisos de colaboración, permisos por etapas y exportación de respuestas.

**Lectura entregada**

El desarrollo activo parece integrado en `main`; las ramas de permisos quedaron principalmente con actividad del **11/08**.

**Evidencia consultada**

- Estado vivo del repositorio `example-org/project-b-back`.
- Último commit `<sha>`, realizado por Developer A.
- Lista de ramas y commits recientes.

**Evaluacion**

- El estado general está correctamente fundamentado: [ ]
- La fecha y el último cambio son correctos: [ ]
- La conclusión sobre desarrollo integrado es válida: [ ]
- Se separan hechos de interpretación: [ ]

## 3. Autor del ultimo commit de Project B

**Pregunta**

> ¿Quién hizo el último commit de Project B?

**Respuesta entregada**

El último commit de Project B lo hizo **Developer A**, en `main`, el **27/08/2026**.

**Evidencia consultada**

- Repositorio `example-org/project-b-back`.
- Commit `<commit-sha>`.

**Evaluacion**

- Autor correcto: [ ]
- Rama correcta: [ ]
- Fecha correcta: [ ]
- Se verificó el dato en GitHub: [ ]

## 4. Estado general de los proyectos

**Pregunta**

> ¿Cómo vienen los proyectos en general?

**Respuesta entregada**

- **Project A:** es el proyecto más activo. Tiene trabajo reciente sobre migración LEGACY y una rama específica para la API de generación externa, incluida BILLING. Sin PRs ni issues abiertos.
- **Project B:** activo y estable. El último cambio agregó `unpublish` para formularios, con tests actualizados. Sin PRs ni issues abiertos.
- **Project C:** más quieto en `main`. Su último commit integrado fue el **23/07**, aunque registra actividad de ramas hasta el **27/08**. Sin PRs ni issues abiertos.

**Conclusión entregada**

Project A concentra el desarrollo actual; Project B está en mantenimiento evolutivo; Project C parece estar en una etapa de menor movimiento.

**Evidencia consultada**

- Estado vivo de los tres repositorios registrados.
- Últimos commits, ramas, PRs e issues.

**Evaluacion**

- La comparación de actividad entre proyectos es justa: [ ]
- Se distingue actividad en `main` de actividad en ramas: [ ]
- Los datos de PRs e issues son correctos: [ ]
- La conclusión evita sobreinterpretar la actividad: [ ]

## 5. Correlacion entre el gestor de tareas y Project A

**Pregunta**

> ¿Cómo se correlacionan las tareas del gestor de tareas con Project A, qué se está haciendo y qué está completo?

**Respuesta entregada**

| Tarea | Estado en el gestor de tareas | Correlación con el repositorio |
|---|---|---|
| Migrar datos de LEGACY a la fecha | Finalizado | El trabajo de migración fue integrado a `main` mediante el PR #15. Incluye trámites, movimientos, oficinas y operadores. |
| API generación de trámites - BILLING | En progreso | Está en `feature/external-api`. Ya existe la API externa `/api/external`, con configuración para BILLING y banda de numeración reservada. Todavía no está integrada a `main`. |
| Trámites con fecha incorrecta en LEGACY | En revisión | Hay documentación y diagnósticos sobre inconsistencias de datos de LEGACY, pero la tarea no figura como finalizada. Requiere validar o corregir los casos detectados. |
| Vista de movimientos por oficina y día | Por hacer | El backend ya tiene filtros por fecha, pero el filtro por `office_id` está implementado y deshabilitado. La funcionalidad solicitada aún no está terminada. |

**Conclusión entregada**

La migración de datos está completa; actualmente se trabaja principalmente en la API de trámites externos para BILLING. Quedan pendientes la corrección de fechas y el informe de movimientos por oficina y rango de días.

**Evidencia consultada**

- Tablero `Seguimiento de trámites`, con tareas 45, 46, 57 y 59.
- Comparación de ramas y commits del repositorio de Project A.
- Documentación de API externa y migración LEGACY.
- Documentación de filtros de movimientos, donde `office_id` figura implementado pero deshabilitado.

**Evaluacion**

- Cada tarea está correctamente vinculada con evidencia del repositorio: [ ]
- El estado del gestor de tareas se diferencia del estado técnico de Git: [ ]
- La afirmación de que la API no está en `main` es correcta: [ ]
- La afirmación de que la migración está completa requiere validación adicional: [ ]
- Se identifican correctamente los pendientes: [ ]

## 6. Diferencias entre `dev` y `main` y desarrollo actual

**Pregunta**

> ¿Qué cambios hay en `dev` que no están en `main` en los proyectos, qué se está desarrollando en este momento? ¿Puedes decirme los nombres de los archivos?

**Respuesta entregada**

### Project A

`dev` está **51 commits adelante** de `main`. El desarrollo principal es la **API de trámites para orígenes externos**, especialmente BILLING.

Archivos representativos informados: omitidos en esta versión pública.

### Project C

`dev` está **16 commits adelante y 3 commits atrás** de `main`. El desarrollo principal es el flujo de **pagos online y Mercado Pago**.

Archivos representativos informados: omitidos en esta versión pública.

### Project B

`dev` no tiene cambios propios pendientes respecto de `main`: está **4 commits detrás** y la comparación no devuelve archivos exclusivos de `dev`.

**Evidencia consultada**

- Comparación GitHub `main...dev` para cada repositorio.
- Lista de archivos modificados, agregados y eliminados.
- Commits recientes y ramas activas.

**Evaluacion**

- Los conteos de commits son correctos: [ ]
- Los archivos mencionados pertenecen realmente a la comparación: [ ]
- Se distingue `dev` de otras ramas de feature: [ ]
- La lista de archivos es completa o se identifica explícitamente como representativa: [ ]
- La interpretación de "desarrollo actual" está respaldada por commits recientes: [ ]

## Criterios generales de medicion

- **Exactitud:** el dato coincide con la fuente consultada.
- **Actualidad:** la respuesta aclara cuándo se verificó la información.
- **Trazabilidad:** incluye repositorio, rama, tarea, commit o archivo verificable.
- **Separación de hechos e inferencias:** diferencia el estado registrado de la interpretación del asistente.
- **Completitud:** responde todas las partes de la pregunta, especialmente cuando se solicitan archivos.
- **Calibración:** expresa incertidumbre cuando el índice o la evidencia no permiten confirmar algo.
