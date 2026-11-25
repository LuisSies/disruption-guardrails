import { Module } from '@nestjs/common';
import { AssessmentService } from './application/assessment.service';
import { RebookingService } from './application/rebooking.service';
import { NOW } from './data/mock/fixtures';
import { mockTools } from './data/mock/mock-tools';
import { REFERENCE_DATA } from './data/reference/airports';
import { ToolsGateway } from './data/tools-gateway';
import { ToolsPort } from './data/tools.port';
import { AssessmentController } from './http/assessment.controller';

// Tools y reloj se eligen JUNTOS: el reloj fijo solo existe en modo mock, así que es imposible
// conectar tools reales con el reloj congelado (anularía los controles de frescura y TTL).
//  - TOOLS_MODE=mock (default): tools mockeadas + reloj fijo en el instante de los fixtures
//    (2026-09-15T11:03Z). REAL_CLOCK=true muestra el comportamiento fail-closed (todo EVENTS_FEED_STALE).
//  - cualquier otro valor: requiere un cliente real de las tools (no implementado) => falla al arrancar.
function toolsAndClock(): { tools: ToolsPort; clock: () => Date } {
  const mode = process.env.TOOLS_MODE ?? 'mock';
  if (mode !== 'mock') throw new Error(`TOOLS_MODE=${mode}: cliente real de las tools no implementado`);
  return { tools: mockTools(), clock: process.env.REAL_CLOCK === 'true' ? () => new Date() : () => NOW };
}
const { tools, clock } = toolsAndClock();

@Module({
  controllers: [AssessmentController],
  providers: [
    { provide: ToolsGateway, useFactory: () => new ToolsGateway(tools, 3000) },
    {
      provide: AssessmentService,
      useFactory: (g: ToolsGateway) => new AssessmentService({ data: g, actions: g, reference: REFERENCE_DATA, clock, log: (m) => console.log(m) }),
      inject: [ToolsGateway],
    },
    {
      provide: RebookingService,
      useFactory: (a: AssessmentService, g: ToolsGateway) => new RebookingService(a, g, g),
      inject: [AssessmentService, ToolsGateway],
    },
  ],
})
export class AppModule {}
