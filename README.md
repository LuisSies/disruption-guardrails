# Disruption Companion — README de ingeniería (Track Backend/Integración)

**Track elegido: Backend/Integración.** Lo elegí por dos razones. La primera es el problema: el riesgo real del caso está en combinar reserva, eventos y políticas para decidir qué le corresponde al pasajero, y esa lógica puede resolverse de forma **determinística**, así que se puede probar, auditar y explicar regla por regla. La pantalla, en cambio, muestra una decisión que ya se tomó. La segunda es personal: el último año trabajé principalmente en React Native y quise aprovechar el desafío para profundizar en backend. La capa de frontend queda especificada como contrato en `docs/EVIDENCIA_TECNICA.md`.

## 1. Cómo correrlo en local
Requisitos: Node.js 18 o superior (probado con Node 24) y npm.
```bash
npm install
npm run demo    # caso base del enunciado (reserva ABC123) sin levantar HTTP
npm test        # 58 tests (node:test + ts-node, sin dependencias extra)
npm start       # API NestJS en http://localhost:3000 (tools mockeadas, reloj fijo 2026-09-15T11:03Z)
```
`npm run demo` imprime `assessment outcome=HUMAN_REVIEW reasons=HUMAN_APPROVAL_REQUIRED policy=POL-DELAY-2026-03` y la evaluación completa: retraso de 160 min, conexión en Lima perdida (predicción), derecho a reprogramar por R3, y revisión humana por viajar con un menor (R5). Los `curl` de la API están en `docs/EVIDENCIA_TECNICA.md`; el resumen de tests, en `docs/TESTS_RESUMEN.html`.

## 2. Problema y outcome
Un pasajero cuyo vuelo cambió necesita saber **qué pasó y cuál es su siguiente paso**, sin recibir datos no verificados y sin que se ejecuten acciones de alto impacto sin control. Outcome de la V1: una función/servicio que, dado `booking_id`, **decide** (a) si hay modificación relevante, (b) qué le corresponde según política vigente, (c) qué se puede comunicar y (d) cuándo detenerse y entregar a una persona. Métricas a observar: % de evaluaciones resueltas sin humano, % enviadas a humano por causa (conflicto / datos viejos / política), contactos al call center por reserva afectada, y **cero** reprogramaciones sin confirmación.

## 3. Ambigüedades: decisiones de V1 para cerrar con el equipo
El enunciado deja estas definiciones abiertas a propósito, y **no son decisiones que deba cerrar yo solo**. En un equipo como el descrito (PM, Product Designer, Team Lead, Software Engineer), el **Product Manager** es dueño de las definiciones de producto y coordina con Operaciones, Legal y Compliance las que no son suyas.

| Ambigüedad | Decisión V1 (propuesta) | Validar con |
|---|---|---|
| Qué es una modificación relevante | Cancelación, retraso ≥ 60 min, o conexión **predicha** perdida (retraso propagado 1:1; MCT 45 min). Cambio de puerta = informativo, no dispara flujo | **PM** + Operaciones |
| Qué se le muestra al pasajero | Solo hechos validados de fuente confiable y reciente (vuelo, retraso, nueva hora, puerta) vía plantillas con `policy_ref`. Nunca email/teléfono/documento; nunca opciones si hay aprobación humana pendiente. La respuesta completa de la API es **interna** (incluye opciones para agente y evidencia): al pasajero solo le llega `communication` | **PM** + Product Designer + Legal |
| Cuándo recomendar automáticamente | Informar + **recomendar** opciones `OFFERABLE` (sin costo, confianza HIGH, asientos suficientes, política vigente). Reprogramar solo con confirmación explícita y **solo si la política no exige aprobación humana**; con R4/R5 la ejecuta un agente desde backoffice | **PM** |
| Cuándo interviene una persona | Regla con `requires_human_approval` (R4, R5), fuentes en conflicto, datos viejos, incompletos o malformados, estados de vuelo que no sabemos interpretar, política inválida/inevaluable, sin opción ofrecible | **PM** + Operaciones / Compliance |
| Fuentes contradictorias | Fuente degradada: se descarta con registro; si **solo** ella informa un tramo, no se asume "sin novedad" → humano. Dos fuentes confiables discrepan: **no se adivina** → humano, sin comunicar. ¿Qué fuente manda (OPS_CORE vs AIRPORT_FEED)? queda como spike de fuente de verdad (§8) | **PM** + Operaciones |

## 4. Decisiones y alternativas descartadas
- **Núcleo puro y determinístico** (`assessDisruption`): mismos inputs ⇒ misma decisión.
- **Sin IA en runtime.** Un LLM añadiría latencia, costo por interacción, no determinismo y **propensa a prompt injection** sin mejorar la exactitud. Mensajes = plantillas cerradas con `policy_ref`.
- **Fail-closed con lógica de 3 valores** para evaluar las condiciones de política (`false AND desconocido = false`; `true AND desconocido = desconocido → humano`).
- **Dos fases para escribir:** `assess` nunca escribe cambios de reserva; `confirm` re-evalúa con datos frescos (las opciones expiran en 120 s), usa clave de idempotencia determinística, y trata 409 como éxito y 503/timeout como **indeterminado** (reintenta con la *misma* clave; si persiste, caso humano, sin afirmar éxito ni fallo).
- **Por eso 2 endpoints y no 1:** `disruption-assessment` lee y decide (se puede reintentar sin riesgo, si falla deriva a humano); `rebooking-confirmations` es la **única** vía a `create_rebooking_request`, y la llamada misma es la confirmación explícita. Tienen permisos, auditoría y semántica de error distintos (degradar vs. idempotencia/indeterminado). Descartado: un endpoint que evalúe y reprograme (salta la confirmación) o uno con campo `action` (mezcla seguro e inseguro en la misma ruta). `?act=true` es un flag y no un tercer endpoint porque solo hace escrituras de bajo impacto (caso humano + notificación con `policy_ref`), nunca toca la reserva.
- Descartado: un único "agente" orquestador. Cada paso del flujo tiene reglas claras; un agente sumaría no-determinismo en la ruta de mayor impacto.

## 5. Consulta compleja: *"Mi vuelo se atrasó, ¿pierdo mi conexión y me devuelven la plata?"*
Entrada **estructurada** (botones/intents cerrados: "¿pierdo mi conexión?", "quiero reprogramar", "quiero compensación"); texto libre no se interpreta en V1 (se deriva a persona).
1. *Recuperar contexto* (mínimo): reserva → eventos → *solo si hay modificación relevante* política + opciones, en paralelo, con timeout por tool.
2. *Determinístico:* reconciliar eventos, calcular conexión, evaluar reglas, filtrar opciones.
3. *Se detiene* ante conflicto, datos viejos, `requires_human_approval`, o cuando "devolución" no tiene sustento (tarifa no reembolsable, confianza LOW) → `create_human_case` con evidencia **sin PII** (ids, reglas, versión de política).
4. *Hoy no hay IA.* Si se agregara después (p. ej. clasificar intención de texto libre), sería **solo clasificación a enum cerrado**, sin herramientas de escritura ni acceso a PII, nunca generación de respuestas.

## 6. Clasificación de pasos
| Paso | Clasificación | Razón | Riesgo | Control / fallback |
|---|---|---|---|---|
| Leer reserva/eventos/política/opciones | Determinístico | Contratos fijos | Tool caída o lenta | Timeout → `Result` → humano |
| Reconciliar fuentes | Determinístico | Reglas de confianza explícitas | Información contradictoria | Descarta degradadas; conflicto → humano |
| Relevancia y conexión | Determinístico | Aritmética sobre datos validados | Predicción errónea | Se redacta "podría"; MCT configurable |
| Evaluar política | Determinístico | Reglas versionadas | Condición desconocida | Parser con lista blanca; inevaluable → humano |
| Filtrar opciones | Determinístico | Candidatas ≠ decisión | Asientos/TTL/costo | Re-validación al confirmar |
| Comunicar | Determinístico (plantilla) | `notify` exige `policy_ref` | Información no validada | Niveles NONE / FACTS_ONLY / FULL |
| Aprobar R4/R5, conflictos | **Human-controlled** | Alto impacto / ambigüedad | Demora | Caso con SLA y evidencia |
| Reprogramar | **Human/pasajero-confirmado** | Acción irreversible | Doble ejecución | Idempotencia, 409/503 |
| IA / agentes | No usado | Ver §4 | — | — |

## 7. Cómo lo validé
- `npm test`: 58 tests sobre el caso base, control humano, datos no confiables, bordes de la política y PII. Los tests generados por la IA no los tomé como fuente de verdad: los audité contra el enunciado (así apareció el salto de aprobación con cualquier `caseId`), saqué el relleno y verifiqué cada test nuevo rompiendo el código a propósito. Resumen por riesgo en `docs/TESTS_RESUMEN.html`.
- Typecheck, `npm run demo` y la API NestJS con los `curl` de `docs/EVIDENCIA_TECNICA.md`.
- Un code review con BMad (lentes adversarial, edge cases y verification gap): corregí los hallazgos que contradecían esta entrega (un REFUND ejecutable como reprogramación, eventos malformados que terminaban en silencio, TTL incalculable).

## 8. Riesgos y próximos pasos
Es una prueba con datos mock y reloj fijo; no está pensada para desplegarse ni operar con casos reales. Antes de una versión real haría:
- **Spike de fuente de verdad** de los datos operacionales: qué sistema manda por tipo de evento. Hoy, sin datos confiables se deriva a humano.
- **Autenticación** del pasajero y un **endpoint de backoffice** para que el agente ejecute las reprogramaciones aprobadas (R4/R5), registrando quién aprobó.
- **Idempotencia de `?act=true`**: hoy un reintento duplica el caso humano y la notificación.
- **Zonas horarias reales** y MCT por aeropuerto (hoy, supuestos).
- **Shadow mode**: comparar las decisiones con las de agentes antes de activar `act`.
