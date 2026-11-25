// Ejecuta el caso base sin levantar Nest:  npm run demo
import { AssessmentService } from './application/assessment.service';
import { NOW } from './data/mock/fixtures';
import { mockTools } from './data/mock/mock-tools';
import { REFERENCE_DATA } from './data/reference/airports';
import { ToolsGateway } from './data/tools-gateway';

(async () => {
  const gateway = new ToolsGateway(mockTools());
  const svc = new AssessmentService({ data: gateway, actions: gateway, reference: REFERENCE_DATA, clock: () => NOW, log: console.log });
  const a = await svc.assess('ABC123');
  console.log(JSON.stringify(a, null, 2));
})();
