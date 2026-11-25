# Entregable 1 — Evidencia técnica

**Track:** Backend/Integración.

## Ejecutar
```bash
npm install
npm test          # 58 tests, sin dependencias de test (node:test + ts-node)
npm run demo      # caso base ABC123 sin levantar HTTP
npm start         # API NestJS en :3000 (tools mockeadas, reloj fijo 2026-09-15T11:03Z)
                  # REAL_CLOCK=true npm start → reloj real: todo cae a HUMAN_REVIEW/EVENTS_FEED_STALE (fail-closed)
                  # TOOLS_MODE≠mock → no arranca: el reloj fijo nunca se combina con tools reales

curl -X POST localhost:3000/v1/bookings/ABC123/disruption-assessment            # dry-run
curl -X POST "localhost:3000/v1/bookings/ABC123/disruption-assessment?act=true" # crea caso + notifica
curl -X POST localhost:3000/v1/bookings/ABC123/rebooking-confirmations \
     -H 'content-type: application/json' -d '{"optionId":"O1"}'
```
Resultados verificados: assess → `HUMAN_REVIEW` (`HUMAN_APPROVAL_REQUIRED`), O1 `OFFERABLE`, O2/O3 `REJECTED` · `act=true` → caso `HC-4471` + notificación `NT-9912` · confirm O1 → `REJECTED APPROVAL_REQUIRED` (R5: el endpoint del pasajero nunca reprograma si la política exige aprobación humana; la ejecuta el agente desde su backoffice) · O2 → `OPTION_NOT_OFFERABLE`. Los caminos 201 / 409 / 503 de `create_rebooking_request` se cubren en tests con una reserva sin menor (`test/application.spec.ts`).

## Alcance implementado
Tres capas; las dependencias apuntan hacia el dominio (`http → application → domain ← data`):
- `src/domain` (lógica de negocio, pura): modelo propio sin PII (`model.ts`), reconciliación de eventos, conexiones, evaluador de política, filtro de opciones, resolver, idempotencia. No importa nada fuera de sí.
- `src/application`: orquestación (`assess`, `act`, `confirm`) sobre puertos en lenguaje de dominio, con lecturas (`DisruptionDataPort`) y escrituras (`DisruptionActionsPort`) separadas.
- `src/data` (capa de datos): contratos snake_case de las tools, `mappers.ts` (contrato ↔ dominio; descarta la PII), `ToolsGateway` (timeouts, fallos → `Result`, códigos 201/409/503 → resultado de dominio), datos de referencia (aeropuerto → país) y mocks.
- `src/http`: 2 endpoints NestJS.

**Resultado del caso base (ABC123):** retraso 160 min en S1 → conexión S2 perdida (holgura −90 min, predicción). R1 no aplica (160 < 180); R3 otorga reprogramación sin costo; R5 (menor) exige persona → `HUMAN_REVIEW`, caso de prioridad alta, al pasajero solo hechos. O1 ofrecible para el agente; O2 rechazada (1 asiento para 2 pasajeros y cobro); O3 rechazada (tarifa no reembolsable).

## Capa complementaria (frontend): contrato y mensaje
La app consume `assessment.communication`; **no recalcula nada**. Renderiza por `templateId`, con texto cerrado:
- `DISRUPTION_FACTS_HANDOFF`: "Tu vuelo {vuelo} ahora sale a las {nuevaHora} (puerta {puerta}). Esto **podría** afectar tu conexión. Una persona de nuestro equipo te contactará para ayudarte con las alternativas." — sin opciones, sin promesas de compensación.
- `DISRUPTION_WITH_OPTIONS`: hechos + tarjeta por opción `OFFERABLE` + botón "Confirmar" → `POST /rebooking-confirmations`; aviso de que la disponibilidad puede cambiar.
- `DISRUPTION_INFO`: solo los hechos de la modificación, sin opciones (modificación relevante sin derecho a reprogramar).
- Sin `templateId` (`level: NONE`): no hay mensaje; la pantalla muestra solo el estado del viaje.
Reglas: "podría" para predicciones; toda notificación lleva `policyRef` (sin él la tool responde 422 y se reporta como error).

## Limitaciones conocidas
Ver README §8. Además: `confirm` no autentica al pasajero, solo rechaza cuando la política exige aprobación humana; no hay persistencia de evaluaciones (auditoría = log de códigos sin PII); estado `INDETERMINATE` no tiene todavía un job de conciliación.
