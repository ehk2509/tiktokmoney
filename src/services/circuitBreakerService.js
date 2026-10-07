export class CircuitBreakerService {
  constructor({
    observabilityService,
    enabled = envBool(process.env.CIRCUIT_BREAKERS_ENABLED, true),
  } = {}) {
    if (!observabilityService) throw new Error('circuit breaker requires observability service');
    this.observabilityService = observabilityService;
    this.enabled = enabled;
  }

  async evaluate(operation) {
    const snapshot = await this.observabilityService.snapshot();
    if (!this.enabled) {
      return {
        operation,
        allowed: true,
        enabled: false,
        status: snapshot.status,
        blockingIncidents: [],
      };
    }

    const blockingCodes = operationBlockingCodes(operation);
    const blockingIncidents = snapshot.incidents.filter((incident) => (
      blockingCodes.has(incident.code)
    ));

    return {
      operation,
      allowed: blockingIncidents.length === 0,
      enabled: true,
      status: snapshot.status,
      blockingIncidents,
    };
  }

  async assertAllowed(operation) {
    const decision = await this.evaluate(operation);
    if (decision.allowed) return decision;
    const codes = decision.blockingIncidents.map((item) => item.code).join(', ');
    const error = new Error(`circuit breaker open for ${operation}: ${codes}`);
    error.code = 'CIRCUIT_BREAKER_OPEN';
    error.operation = operation;
    error.decision = decision;
    throw error;
  }

  async status() {
    const operations = ['generation', 'publishing', 'publishing-recovery'];
    const decisions = {};
    for (const operation of operations) {
      decisions[operation] = await this.evaluate(operation);
    }
    return {
      enabled: this.enabled,
      generatedAt: new Date().toISOString(),
      operations: decisions,
    };
  }
}

function operationBlockingCodes(operation) {
  if (operation === 'generation') {
    return new Set([
      'project_failure_rate_high',
      'daily_budget_overrun',
      'orchestration_retry_backlog',
      'orchestration_stuck_jobs',
    ]);
  }

  if (operation === 'publishing') {
    return new Set([
      'tiktok_auth_missing',
      'tiktok_reauthorization_required',
      'orchestration_retry_backlog',
      'orchestration_stuck_jobs',
    ]);
  }

  if (operation === 'publishing-recovery') {
    return new Set([
      'tiktok_auth_missing',
      'tiktok_reauthorization_required',
    ]);
  }

  return new Set();
}

function envBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
