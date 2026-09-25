/** Intake double for POST /v1/launch-readiness: a launchable thin review. */
export const PROFILE = 'd'.repeat(64)
export function readiness(overrides: Record<string, any> = {}, ready = true) {
  const checks = [
    { id: 'requester', status: 'ok', blocking: true, text: 'On the launch list for this channel.', source: 'policy' },
    { id: 'admission-window', status: 'ok', blocking: true, text: 'Admission is open.', source: 'policy' },
    { id: 'active-run', status: ready ? 'ok' : 'blocked', blocking: true, ...(ready ? {} : { code: 'ITEM_RUN_ACTIVE' }),
      text: ready ? 'No active run for this item.' : 'A run for this Plane item is still queued or running.', source: 'ledger' },
    { id: 'approval', status: 'ok', blocking: true, text: 'Covered by the operator batch (capacity generation 26).', source: 'policy' },
    { id: 'capacity', status: 'ok', blocking: true, text: 'An unused batch slot is available.', source: 'policy' },
    { id: 'prerequisites', status: 'ok', blocking: true, text: 'None required.', source: 'ledger' },
    { id: 'credentials', status: 'unknown', blocking: false, text: 'Plane service credential health is not observed by intake (UNKNOWN; not blocking).', source: 'factory-observation' }]
  const blocker = checks.find(c => c.blocking && c.status !== 'ok')
  return { ready, ...(ready ? {} : { reason: 'ITEM_RUN_ACTIVE' }), observedAt: 1790000000,
    recipe: { title: 'Review prior work', version: '1.1.0', profileTitle: 'Full packet' },
    review: { version: 1, launchable: ready, state: ready ? 'ready' : 'active-run',
      firstBlocker: blocker ? { id: blocker.id, status: blocker.status, code: (blocker as any).code, text: blocker.text } : null,
      readiness: ready ? 'Eligible to attempt.' : 'Not launchable.', item: { projectId: 'p', itemId: 'i' },
      authorityKind: 'existing-service-policy', requestedModel: 'gpt-6-sol',
      executionProfile: { model: 'gpt-6-sol', mode: 'relaxed', maxCalls: { coordinator: 8, worker: 40, checker: 24 }, limitsDigest: 'e'.repeat(64), digest: PROFILE },
      placement: { coordination: { cluster: 'k3s002', node: 'gujranwala', namespace: 'execution-fabric', runtime: 'qualified-linux-hermes' }, executor: null, confirmedAt: 'launch' },
      team: { members: [{ role: 'Coordinator', model: 'gpt-6-sol' }, { role: 'Worker', model: 'gpt-6-sol' }, { role: 'Checker', model: 'gpt-6-sol' }] },
      limits: [{ id: 'attempts', label: 'Attempts', value: 'attempt 1 on this item' },
        { id: 'model-calls', label: 'Model calls', value: 'coordinator 8 · worker 40 · checker 24 (relaxed)' },
        { id: 'tokens', label: 'Tokens', value: 'up to 32,768 output tokens per request (relaxed) · total not budgeted' },
        { id: 'time', label: 'Time', value: 'finish within 45 min of start + 5 min cleanup (relaxed)' },
        { id: 'network', label: 'Network', value: 'model gateway only' },
        { id: 'launch-before', label: 'Launch before', value: 'admission window end (UTC epoch)', epoch: 1791468243 }],
      destination: { slack: { channelId: 'C1', threadTs: '1789846137.000001' }, plane: 'https://plane.example.test/work' },
      checks, warnings: [], policy: { capacityGeneration: 26, admitUntil: 1791468243 }, planDigest: 'f'.repeat(64), observedAt: 1790000000,
      ...overrides } }
}
/** The pushed review view, submitted as Launch by the same user. */
export const launchSubmission = (pushed: any, user = 'U1', team = 'T1') =>
  ({ type: 'view_submission', team: { id: team }, user: { id: user }, view: { ...pushed, id: 'V2', state: { values: {} } } })
