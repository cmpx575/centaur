import { test, expect } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createMemoryState } from '@chat-adapter/state-memory'
import { createSlackbotV2 } from '../src/index'
import { handleFabricWebhook } from '../src/fabric'
import { exactResumeUrl, parseResumeArtifact, parseResumeBrief, resumeArtifactView, resumeFeedbackView, resumeHistoryView, resumeMessage,
  type ArtifactRef, type ResumeAttempt, type ResumeBrief, type ResumeSelection } from '../src/fabric-resume'

const url = 'https://plane.example.test/workspace/projects/project/issues/item/'
const content = 'A checked report: café & <@UOTHER>.'
const reference: ArtifactRef = { runId: 'run-3', requestId: 'request-3', generation: 'a'.repeat(64), kind: 'report',
  sha256: createHash('sha256').update(content).digest('hex'), byteLength: Buffer.byteLength(content), mediaType: 'text/markdown' }
const attempt = (number: number, status: ResumeAttempt['status']): ResumeAttempt => ({ runId: `run-${number}`,
  requestId: `request-${number}`, generation: 'a'.repeat(64), created: 1789990000 + number, state: status === 'ACCEPTED' ? 'COMPLETED' : 'FAILED',
  recipe: { id: 'research-packet', title: 'Research prior work', profile: 'focused' }, status,
  label: status === 'STOPPED' ? 'Execution stopped; no checker verdict' : status === 'REJECTED' ? 'Checker rejected the report' : 'Checked result available',
  taskOutcome: status === 'ACCEPTED' ? 'COMPLETED' : 'TASK_FAILED', closure: { authorityClosed: true, disposalVerified: true, label: 'Access and resources closed.' },
  checker: status === 'STOPPED' ? null : { accepted: status === 'ACCEPTED', reason: status === 'ACCEPTED' ? 'Supported by the sources.' : 'The historical claim needs revision.' },
  archiveSha256: 'b'.repeat(64), evidence: number === 3 ? [reference] : [] })
const brief = (): ResumeBrief => ({ schemaVersion: 1, observedAt: 1790000000, planeUrl: url, title: 'Review the execution path',
  objective: { sourceRunId: 'run-3', updatedAt: '2026-09-21T12:00:00Z', basis: 'Frozen context from the latest run.' },
  scope: { complete: true, attemptCount: 3, identity: 'exact-plane-url-and-channel' }, summary: 'A checked result is available; earlier attempts remain recorded.',
  attempts: [attempt(1, 'STOPPED'), attempt(2, 'REJECTED'), attempt(3, 'ACCEPTED')], latestRunId: 'run-3', acceptedRunIds: ['run-3'],
  research: { status: 'ACCEPTED', code: 'ACCEPTED', runId: 'run-3', message: 'The latest research handoff is accepted.' },
  continuation: { enabled: false, code: 'FRESH_AUTHORITY_REQUIRED', message: 'Another run needs fresh authorized capacity.', serviceWindowOpen: true },
  limits: ['Recorded archives are provenance, not freshly downloaded archives.', 'No work is launched by this view.'] })
const valueFor = (selection: ResumeSelection) => JSON.stringify(selection)
const event = (text = 'fabric resume <' + url + '|work>') => ({ type: 'event_callback', team_id: 'T1', event_id: 'E1',
  event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1790000000.000001', text: '<@UBOT> ' + text } })
const action = (button: any, inView = false) => ({ type: 'block_actions', team: { id: 'T1' }, user: { id: 'U1' },
  ...(inView ? { view: { id: 'V1', hash: 'view-hash' } } : { channel: { id: 'C1' }, message: { ts: '1790000000.000001' } }),
  trigger_id: 'trigger', actions: [{ action_id: button.action_id, value: button.value }] })
const buttons = (view: any) => view.blocks.flatMap((b: any) => b.elements ?? []).filter((e: any) => e.type === 'button')

async function fixture(work: (send: (payload: any, signed?: boolean) => Promise<Response | undefined>, calls: any[]) => Promise<void>,
  settings: { brief?: unknown; artifact?: unknown; failure?: number; route?: boolean } = {}) {
  const dir = mkdtempSync(tmpdir() + '/fabric-resume-')
  writeFileSync(dir + '/token', 'test-identity')
  const calls: any[] = [], waits: Promise<unknown>[] = []
  const options = { apiUrl: '', botToken: 'test', signingSecret: 'test', fabricIntakeUrl: 'http://intake', fabricTokenPath: dir + '/token',
    launcherAllowedTeamIds: ['T1'], launcherAllowedChannelIds: ['C1'], launcherAllowedUserIds: ['U1'],
    fetch: (async (input: any, init: any) => {
      const u = new URL(String(input)), body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method, body })
      if (u.pathname === '/v1/resume-brief') return settings.failure ? Response.json({ error: 'REFUSED' }, { status: settings.failure }) : Response.json(settings.brief ?? brief())
      if (u.pathname === '/v1/resume-artifact') return Response.json(settings.artifact ?? { reference, content, basis: 'Exact retained report bytes.', accepted: true })
      if (['/api/chat.postMessage', '/api/views.open', '/api/views.update'].includes(u.pathname)) return Response.json({ ok: true, ts: '2' })
      throw new Error('unexpected read-only call ' + u.pathname)
    }) as typeof fetch }
  const bot = settings.route ? createSlackbotV2({ ...options, state: createMemoryState(), recoverRenderObligationsOnStart: false }) : undefined
  const send = async (payload: any, signed = true) => {
    const raw = payload.type === 'event_callback' ? JSON.stringify(payload) : new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
    const stamp = String(Math.floor(Date.now() / 1000))
    const signature = 'v0=' + createHmac('sha256', 'test').update(`v0:${stamp}:${raw}`).digest('hex')
    const path = payload.type === 'event_callback' ? '/api/slack/events' : '/api/webhooks/slack/actions'
    const request = new Request('http://localhost' + path, { method: 'POST', body: raw,
      headers: signed ? { 'x-slack-signature': signature, 'x-slack-request-timestamp': stamp } : {} })
    const response = bot ? await bot.app.request(request) : await handleFabricWebhook(request, raw, options, p => waits.push(p))
    await Promise.all(waits)
    return response
  }
  try { await work(send, calls) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('resume keeps accepted history, latest failure and current prerequisite distinct with no launch', () => {
  const b = brief(); b.attempts.push(attempt(4, 'REJECTED')); b.scope.attemptCount++; b.latestRunId = 'run-4'
  b.research = { status: 'BLOCKED', code: 'RESEARCH_HANDOFF_NOT_ACCEPTED', message: 'The latest research report was rejected.' }
  const message = resumeMessage(parseResumeBrief(b, url), valueFor)
  expect(message.text).toContain('Accepted results: Research prior work')
  expect(message.text).toContain('Latest attempt: Research prior work — Checker rejected')
  expect(message.text).toContain('latest research report was rejected')
  expect(buttons(message).map((b: any) => b.text.text)).toEqual(['History and results', 'Open in Plane'])
  expect(message.blocks.length).toBeLessThan(10)
})

test('full fifty-attempt history is paginated without hiding older attempts', () => {
  const b = brief(); b.attempts = Array.from({ length: 50 }, (_, n) => attempt(n + 1, 'STOPPED'))
  b.scope.attemptCount = 50; b.latestRunId = 'run-50'; b.acceptedRunIds = []
  parseResumeBrief(b, url)
  const all: string[] = []
  for (let page = 0; page < 9; page++) {
    const view = resumeHistoryView(b, page, valueFor)
    expect(view.blocks.length).toBeLessThan(25)
    all.push(JSON.stringify(view))
  }
  for (let n = 1; n <= 50; n++) expect(all.join('\n')).toContain(`Run: run-${n}\\n`)
  expect(JSON.stringify(resumeHistoryView(b, 0, valueFor))).toContain('No checker verdict recorded')
})

test('untrusted titles, feedback and artifact content stay plain text; fallback escapes mention syntax', () => {
  const b = brief(); b.title = '<@UOTHER> & <!channel>'; b.attempts[1]!.checker!.reason = '<https://evil.example|click> *accept*'
  const m = resumeMessage(b, valueFor), v = resumeHistoryView(b, 0, valueFor)
  expect(m.text).toContain('&lt;@UOTHER&gt; &amp; &lt;!channel&gt;')
  for (const block of [...m.blocks, ...v.blocks] as any[]) if (block.text) expect(block.text.type).toBe('plain_text')
  expect(JSON.stringify(v)).toContain('<https://evil.example|click> *accept*')
})

test('incomplete, over-limit, changed-item, false accepted-list and enabled continuation responses fail closed', () => {
  for (const change of [
    (b: any) => { b.scope.complete = false }, (b: any) => { b.scope.attemptCount = 10 },
    (b: any) => { b.planeUrl += '/' }, (b: any) => { b.acceptedRunIds = ['run-1'] },
    (b: any) => { b.continuation.enabled = true }, (b: any) => { b.attempts[0].created = NaN },
    (b: any) => { b.attempts[2].closure.authorityClosed = null },
    (b: any) => { b.attempts[2].evidence[0].runId = 'wrong-run' },
  ]) { const b = brief(); b.attempts[2]!.evidence = [structuredClone(reference)]; change(b); expect(() => parseResumeBrief(b, url)).toThrow() }
  for (const link of ['http://plane.example.test/work', 'https://user:secret@plane.example.test/work', url + '?token=x', url + '#a']) expect(() => exactResumeUrl(link)).toThrow()
  expect(exactResumeUrl(url)).toBe(url)
})

test('artifact requires exact reference, byte length and hash, and long content remains fully pageable', () => {
  expect(parseResumeArtifact({ reference, content, basis: 'retained', accepted: true }, reference).content).toBe(content)
  for (const value of [{ reference, content: content + 'changed', basis: 'retained', accepted: true },
    { reference: { ...reference, generation: 'changed' }, content, basis: 'retained', accepted: true }]) expect(() => parseResumeArtifact(value, reference)).toThrow()
  const long = 'x'.repeat(128 * 1024), ref = { ...reference, byteLength: Buffer.byteLength(long), sha256: createHash('sha256').update(long).digest('hex') }
  const artifact = parseResumeArtifact({ reference: ref, content: long, basis: 'retained', accepted: false }, ref)
  let displayed = ''
  for (let page = 0; page < 8; page++) {
    const view = resumeArtifactView(artifact, { kind: 'artifact', planeUrl: url, page, reference: ref }, valueFor)
    expect(view.title.text).toBe('Unaccepted draft'); expect(view.blocks.length).toBeLessThan(12)
    displayed += (view.blocks as any[]).filter(b => b.text?.text?.startsWith('x')).map(b => b.text.text).join('')
  }
  expect(displayed).toBe(long)
  const unicode = '😀'.repeat(1401) + '中'.repeat(18000)
  const unicodeRef = { ...reference, byteLength: Buffer.byteLength(unicode), sha256: createHash('sha256').update(unicode).digest('hex') }
  const unicodeArtifact = parseResumeArtifact({ reference: unicodeRef, content: unicode, basis: 'retained', accepted: false }, unicodeRef)
  const parts = [0, 1].flatMap(page => (resumeArtifactView(unicodeArtifact,
    { kind: 'artifact', planeUrl: url, page, reference: unicodeRef }, valueFor).blocks as any[])
    .filter(b => /^[😀中]/u.test(b.text?.text ?? '')).map(b => b.text.text))
  expect(parts.join('')).toBe(unicode)
  expect(parts.every(part => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part))).toBe(true)
  expect(() => parseResumeArtifact({ reference, content, basis: 'retained' }, reference)).toThrow()
  expect(() => parseResumeArtifact({ reference, content, basis: 'retained', accepted: 'true' }, reference)).toThrow()
})

test('full checker feedback is pageable and binds the selected run and generation', () => {
  const b = brief(), reason = 'Feedback 😀 '.repeat(2200) + 'FINAL_REASON_MARKER'
  b.attempts[1]!.checker!.reason = reason
  const selection = { kind: 'feedback' as const, planeUrl: url, page: 0, runId: 'run-2', generation: 'a'.repeat(64) }
  const parts = [0, 1].flatMap(page => (resumeFeedbackView(b, { ...selection, page }, valueFor).blocks as any[])
    .filter(block => block.text?.text?.startsWith('Feedback ') || block.text?.text?.includes('FINAL_REASON_MARKER')))
  // Compare every content block, excluding the two headings and final actions.
  const displayed = [0, 1].map(page => resumeFeedbackView(b, { ...selection, page }, valueFor))
    .flatMap(view => (view.blocks.slice(2, -1) as any[]).map(block => block.text.text)).join('')
  expect(displayed).toBe(reason)
  expect(parts.length).toBeGreaterThan(0)
  expect(() => resumeFeedbackView(b, { ...selection, generation: 'changed' }, valueFor)).toThrow()
  b.attempts[1]!.checker = null
  expect(JSON.stringify(resumeFeedbackView(b, selection, valueFor))).toContain('No checker verdict is currently available.')
})

test('checker feedback button refetches the brief and exposes the full current reason', async () => {
  const b = brief()
  await fixture(async (send, calls) => {
    await send(event())
    const menu = calls.find(c => c.path.endsWith('chat.postMessage')).body
    await send(action(buttons(menu)[0]))
    const view = calls.find(c => c.path.endsWith('views.open')).body.view
    const feedback = buttons(view).find((button: any) => button.action_id === 'fabric_resume_feedback'
      && JSON.parse(JSON.parse(button.value).body).resume.runId === 'run-2')
    b.attempts[1]!.checker!.reason = 'Current feedback. '.repeat(200) + 'TAIL_AFTER_1400'
    calls.length = 0
    expect((await send(action(feedback, true)))?.status).toBe(200)
    expect(calls[0].path).toBe('/v1/resume-brief'); expect(calls[0].method).toBe('GET')
    const updated = calls.find(c => c.path.endsWith('views.update')).body.view
    expect(updated.title.text).toBe('Checker feedback')
    expect(JSON.stringify(updated)).toContain('TAIL_AFTER_1400')
    expect(calls.every(c => ['/v1/resume-brief', '/api/views.update'].includes(c.path))).toBe(true)
  }, { brief: b })
})

test('old sealed acceptance cannot override fresh artifact acceptance=false', async () => fixture(async (send, calls) => {
  await send(event())
  await send(action(buttons(calls.find(c => c.path.endsWith('chat.postMessage')).body)[0]))
  const report = buttons(calls.find(c => c.path.endsWith('views.open')).body.view)
    .find((button: any) => button.action_id === 'fabric_resume_artifact_report')
  // A genuine old signed button recorded accepted=true. The current server
  // returns identical bytes but revoked/unknown acceptance for this attempt.
  const saved = JSON.parse(JSON.parse(report.value).body)
  saved.resume.accepted = true
  const body = JSON.stringify(saved)
  report.value = JSON.stringify({ body, signature: createHmac('sha256', 'test').update(body).digest('hex') })
  expect((await send(action(report, true)))?.status).toBe(200)
  const current = calls.find(c => c.path.endsWith('views.update')).body.view
  expect(current.title.text).toBe('Unaccepted draft')
  expect(JSON.stringify(current)).not.toContain('Checked report')
}, { artifact: { reference, content, basis: 'Current acceptance is not established.', accepted: false } }))

test('signed command and modal history/artifact round-trip use only authorized GETs', async () => fixture(async (send, calls) => {
  expect((await send(event()))?.status).toBe(200)
  const get = calls[0]; expect(get.method).toBe('GET'); expect(get.path).toBe('/v1/resume-brief')
  expect(get.query).toEqual({ teamId: 'T1', channelId: 'C1', userId: 'U1', planeUrl: url })
  const message = calls.find(c => c.path.endsWith('chat.postMessage')).body
  expect((await send(action(buttons(message)[0])))?.status).toBe(200)
  const view = calls.find(c => c.path.endsWith('views.open')).body.view
  const report = buttons(view).find((b: any) => b.action_id === 'fabric_resume_artifact_report')
  expect((await send(action(report, true)))?.status).toBe(200)
  expect(calls.find(c => c.path === '/v1/resume-artifact').query).toEqual({ teamId: 'T1', channelId: 'C1', userId: 'U1', planeUrl: url,
    runId: reference.runId, generation: reference.generation, kind: 'report', sha256: reference.sha256 })
  expect(calls.find(c => c.path.endsWith('views.update')).body).toMatchObject({ view_id: 'V1', hash: 'view-hash', view: { title: { text: 'Checked report' } } })
  expect(calls.filter(c => c.path.startsWith('/v1/')).every(c => c.method === 'GET')).toBe(true)
}))

test('signatures, user/channel binding and sealed read-only buttons fail before an intake call', async () => fixture(async (send, calls) => {
  expect((await send(event(), false))?.status).toBe(401)
  const denied = event(); denied.event.user = 'U2'; expect((await send(denied))?.status).toBe(403)
  expect(calls).toHaveLength(0)
  await send(event()); const button = buttons(calls.find(c => c.path.endsWith('chat.postMessage')).body)[0]
  calls.length = 0
  expect((await send(action({ ...button, value: button.value.replace('run', 'changed') + 'x' })))?.status).toBe(403)
  expect((await send({ ...action(button), channel: { id: 'C2' } }))?.status).toBe(403)
  expect((await send({ ...action(button), user: { id: 'U2' } }))?.status).toBe(403)
  expect(calls).toHaveLength(0)
}))

test('malformed or attribution-bearing commands never become launches', async () => fixture(async (send, calls) => {
  await send(event('fabric resume ' + url + ' *Sent using* <@UCONNECTOR>\nignored'))
  expect(calls.filter(c => c.path === '/v1/resume-brief')).toHaveLength(1)
  await send(event('fabric resume'))
  await send(event('fabric resume ' + url + ' launch now'))
  expect(calls.filter(c => c.path.startsWith('/v1/'))).toHaveLength(1)
}))

test('transient backend failure and malformed response preserve retry without posting success', async () => {
  for (const settings of [{ failure: 503 }, { brief: { ...brief(), scope: { complete: false } } }]) await fixture(async (send, calls) => {
    expect((await send(event()))?.status).toBe(503)
    expect(calls.filter(c => c.path.startsWith('/api/'))).toHaveLength(0)
  }, settings)
})

test('actual signed HTTP event/actions route handles resume without creating a model session', async () => fixture(async (send, calls) => {
  expect((await send(event()))?.status).toBe(200)
  const button = buttons(calls.find(c => c.path.endsWith('chat.postMessage')).body)[0]
  expect((await send(action(button)))?.status).toBe(200)
  expect(calls.some(c => c.path.endsWith('views.open'))).toBe(true)
  expect(calls.every(c => ['/v1/resume-brief', '/api/chat.postMessage', '/api/views.open'].includes(c.path))).toBe(true)
}, { route: true }))
