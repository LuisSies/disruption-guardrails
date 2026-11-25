import { Policy } from './model';

/**
 * Las reglas llegan como strings ("delay_minutes >= 180 AND international").
 * NUNCA se usa eval/Function: se parsea una gramática mínima con lista blanca.
 * Lógica de 3 valores (Kleene): true / false / null(desconocido).
 *  - false AND desconocido => false (no hace falta el dato)
 *  - true  AND desconocido => desconocido (fail-closed hacia humano)
 *  - gramática no soportada => UNPARSEABLE (fail-closed hacia humano)
 */
export type Facts = Record<string, number | boolean | undefined>;
export type Tri = true | false | null;
export type ConditionResult = Tri | 'UNPARSEABLE';

const CLAUSE = /^([a-z_]+)\s*(>=|<=|==|!=|>|<)\s*(true|false|\d+)$/;
const BARE = /^[a-z_]+$/;

function evalClause(raw: string, facts: Facts): ConditionResult {
  const c = raw.trim();
  if (BARE.test(c)) {
    const v = facts[c];
    return typeof v === 'boolean' ? v : null;
  }
  const m = CLAUSE.exec(c);
  if (!m) return 'UNPARSEABLE';
  const [, name, op, lit] = m;
  const left = facts[name];
  if (left === undefined) return null;
  const right: number | boolean = lit === 'true' ? true : lit === 'false' ? false : Number(lit);
  if (op === '==') return left === right;
  if (op === '!=') return left !== right;
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  switch (op) {
    case '>=': return left >= right;
    case '<=': return left <= right;
    case '>': return left > right;
    default: return left < right;
  }
}

export function evaluateCondition(condition: string, facts: Facts): ConditionResult {
  const results: Tri[] = [];
  for (const clause of condition.split(/\s+AND\s+/)) {
    const r = evalClause(clause, facts);
    if (r === 'UNPARSEABLE') return 'UNPARSEABLE';
    results.push(r);
  }
  if (results.includes(false)) return false;
  if (results.includes(null)) return null;
  return true;
}

export interface Entitlement {
  ruleId: string;
  entitlement: string;
  requiresHumanApproval: boolean;
}

export interface PolicyEvaluation {
  entitlements: Entitlement[];
  unresolved: { ruleId: string; reason: 'UNKNOWN_FACT' | 'UNPARSEABLE' }[];
  ruleResults: Record<string, ConditionResult>;
}

export function evaluatePolicy(policy: Policy, facts: Facts): PolicyEvaluation {
  const entitlements: Entitlement[] = [];
  const unresolved: PolicyEvaluation['unresolved'] = [];
  const ruleResults: Record<string, ConditionResult> = {};
  for (const rule of policy.rules) {
    const r = evaluateCondition(rule.condition, facts);
    ruleResults[rule.id] = r;
    if (r === true) {
      entitlements.push({
        ruleId: rule.id,
        entitlement: rule.entitlement,
        requiresHumanApproval: rule.requiresHumanApproval,
      });
    } else if (r === null) unresolved.push({ ruleId: rule.id, reason: 'UNKNOWN_FACT' });
    else if (r === 'UNPARSEABLE') unresolved.push({ ruleId: rule.id, reason: 'UNPARSEABLE' });
  }
  return { entitlements, unresolved, ruleResults };
}
