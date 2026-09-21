import { test, expect } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { handleFabricWebhook } from '../src/fabric'
import { ARTIFACT_KINDS, isResumeAction, parseResumeArtifact, parseResumeBrief, parseResumeSelection,
  resumeArtifactView, resumeHistoryView, type ArtifactRef, type ResumeBrief, type ResumeSelection } from '../src/fabric-resume'

const url = 'https://plane.example.test/workspace/projects/project/issues/item/'
const items = [
  { kind: 'softwareSource', content: 'print("<@USER> & 雪")\n', mediaType: 'text/x-python; charset=utf-8', label: 'Source' },
  { kind: 'softwareHtml', content: '<!doctype html>\n<html><body>&lt;script&gt; &amp; café</body></html>\n', mediaType: 'text/html; charset=utf-8', label: 'HTML' },
  { kind: 'softwareResult', content: '{"status":"COMPLETED","childAbsent":true}\n', mediaType: 'application/json', label: 'Execution receipt' },
] as const
const reference = (kind: ArtifactRef['kind'], content: string, mediaType: string): ArtifactRef => ({
  runId: 'software-run', requestId: 'software-request', generation: 'a'.repeat(64), kind, mediaType,
  sha256: createHash('sha256').update(content).digest('hex'), byteLength: Buffer.byteLength(content),
})
const refs = () => [reference('report', 'Accepted repair.', 'text/markdown'), ...items.map(i => reference(i.kind, i.content, i.mediaType))]
const brief = (): ResumeBrief => ({ schemaVersion: 1, observedAt: 1790000000, planeUrl: url, title: 'Repair history renderer',
  objective: { sourceRunId: 'software-run', updatedAt: null, basis: 'Frozen same-item context.' },
  scope: { complete: true, attemptCount: 1, identity: 'exact-plane-url-and-channel' }, summary: 'One checked repair.',
  attempts: [{ runId: 'software-run', requestId: 'software-request', generation: 'a'.repeat(64), created: 1790000000,
    state: 'COMPLETED', recipe: { id: 'software-repair', title: 'Repair the renderer', profile: 'focused' },
    status: 'ACCEPTED', label: 'Checked result available', taskOutcome: 'COMPLETED',
    closure: { authorityClosed: true, disposalVerified: true, label: 'Access and child closed.' },
    checker: { accepted: true, reason: 'Source and exact externally checked output match the receipt.' },
    archiveSha256: 'b'.repeat(64), evidence: refs() }], latestRunId: 'software-run', acceptedRunIds: ['software-run'],
  research: { status: 'ACCEPTED', code: 'ACCEPTED', message: 'Checked handoff recorded.' },
  continuation: { enabled: false, code: 'FRESH_AUTHORITY_REQUIRED', message: 'Fresh authority required.', serviceWindowOpen: true },
  limits: ['Read-only retained results.'] })
const buttons = (view: any) => view.blocks.flatMap((b: any) => b.elements ?? []).filter((e: any) => e.type === 'button')
const valueFor = (selection: ResumeSelection) => JSON.stringify(selection)

test('one software attempt exposes the exact four artifacts with distinct read-only labels', () => {
  const b = parseResumeBrief(brief(), url)
  expect(b.attempts[0]!.evidence).toHaveLength(4)
  expect(ARTIFACT_KINDS).toEqual(['report', 'gpuResult', 'softwareSource', 'softwareHtml', 'softwareResult'])
  const view = resumeHistoryView(b, 0, valueFor)
  expect(buttons(view).slice(0, 4).map((b: any) => b.text.text)).toEqual(['Read checked report', 'Source', 'HTML', 'Execution receipt'])
  for (const kind of ARTIFACT_KINDS) expect(isResumeAction('fabric_resume_artifact_' + kind)).toBe(true)
  expect(buttons(view).every((b: any) => !/start|retry|launch|share/i.test(b.text.text))).toBe(true)
})

test('unknown duplicate crossed identity and wrong software media types fail closed', () => {
  const changes = [
    (b: ResumeBrief) => { b.attempts[0]!.evidence[1]!.kind = 'softwareArchive' as any },
    (b: ResumeBrief) => { b.attempts[0]!.evidence.push(b.attempts[0]!.evidence[1]!) },
    (b: ResumeBrief) => { b.attempts[0]!.evidence[1]!.generation = 'c'.repeat(64) },
    (b: ResumeBrief) => { b.attempts[0]!.evidence[2]!.mediaType = 'text/markdown' },
  ]
  for (const change of changes) { const b = brief(); change(b); expect(() => parseResumeBrief(b, url)).toThrow() }
  expect(isResumeAction('fabric_resume_artifact_softwareArchive')).toBe(false)
  for (const item of items) {
    const ref = reference(item.kind, item.content, item.mediaType)
    expect(parseResumeSelection({ kind: 'artifact', planeUrl: url, page: 0, reference: ref })).toMatchObject({ reference: ref })
    expect(() => parseResumeSelection({ kind: 'artifact', planeUrl: url, page: 0, reference: { ...ref, mediaType: 'text/plain' } })).toThrow()
    if (item.kind !== 'softwareResult') expect(() => parseResumeSelection({ kind: 'artifact', planeUrl: url, page: 0,
      reference: { ...ref, mediaType: ref.mediaType.replace('; ', ';') } })).toThrow()
  }
})

test('software artifacts retain exact UTF-8 byte and SHA validation without fallback', () => {
  for (const item of items) {
    const ref = reference(item.kind, item.content, item.mediaType)
    const value = { reference: ref, content: item.content, basis: 'Exact retained bytes.', accepted: true }
    expect(parseResumeArtifact(value, ref).content).toBe(item.content)
    for (const changed of [
      { ...value, content: item.content + 'x' }, { ...value, accepted: undefined },
      { ...value, reference: { ...ref, byteLength: ref.byteLength + 1 } },
      { ...value, reference: { ...ref, sha256: '0'.repeat(64) } },
      { ...value, reference: { ...ref, requestId: 'another-request' } },
      { ...value, reference: { ...ref, kind: 'report' } },
    ]) expect(() => parseResumeArtifact(changed, ref)).toThrow()
  }
})

test('source and HTML content stay inert plain text, including active-looking payloads', () => {
  const content = '<script>fetch("https://evil.example/")</script><img src=x onerror=alert(1)><@USER>\n<!channel> & 雪'
  const ref = reference('softwareHtml', content, 'text/html; charset=utf-8')
  const a = parseResumeArtifact({ reference: ref, content, accepted: true, basis: 'Retained output.' }, ref)
  const view = resumeArtifactView(a, { kind: 'artifact', planeUrl: url, page: 0, reference: ref }, valueFor)
  expect(view.title.text).toBe('HTML')
  expect((view.blocks[0] as any).text.text).toContain('HTML is shown as plain text.')
  expect((view.blocks[1] as any).text).toEqual({ type: 'plain_text', text: content })
  expect(view.blocks.every((b: any) => b.type === 'section' || b.type === 'actions')).toBe(true)
  expect(buttons(view).every((b: any) => !b.url)).toBe(true)
  for (const b of view.blocks as any[]) if (b.text) expect(b.text.type).toBe('plain_text')
})

test('long software output and receipt stay fully pageable without broken Unicode or title overflow', () => {
  for (const item of items) {
    const content = 'x'.repeat(17999) + '🙂雪' + item.content.repeat(800)
    const ref = reference(item.kind, content, item.mediaType)
    const a = parseResumeArtifact({ reference: ref, content, basis: 'Exact retained bytes.', accepted: false }, ref)
    const parts: string[] = []
    for (let page = 0; page < Math.ceil(content.length / 18000); page++) {
      const view = resumeArtifactView(a, { kind: 'artifact', planeUrl: url, page, reference: ref }, valueFor)
      expect(view.title.text).toBe(item.label)
      expect(view.title.text.length).toBeLessThanOrEqual(24)
      expect((view.blocks[0] as any).text.text).toContain('Acceptance is not established.')
      parts.push(...view.blocks.slice(1, -2).map((b: any) => b.text.text))
      for (const part of parts) expect(part).not.toMatch(/\ud800(?![\udc00-\udfff])/)
    }
    expect(parts.join('')).toBe(content)
  }
})

test('signed software artifact actions preserve HMAC origin and exact GET identity, with fresh acceptance', async () => {
  const dir = mkdtempSync(tmpdir() + '/fabric-software-ui-')
  writeFileSync(dir + '/token', 'synthetic-test-identity')
  const calls: any[] = [], waits: Promise<unknown>[] = []
  const options = { apiUrl: '', botToken: 'test', signingSecret: 'test', fabricIntakeUrl: 'http://intake', fabricTokenPath: dir + '/token',
    launcherAllowedTeamIds: ['T1'], launcherAllowedChannelIds: ['C1'], launcherAllowedUserIds: ['U1'],
    fetch: (async (input: any, init: any) => {
      const u = new URL(String(input)); const body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method, body })
      if (u.pathname === '/v1/resume-brief') return Response.json(brief())
      if (u.pathname === '/v1/resume-artifact') {
        const item = items.find(i => i.kind === u.searchParams.get('kind'))!
        return Response.json({ reference: reference(item.kind, item.content, item.mediaType), content: item.content,
          basis: 'Current acceptance is not established.', accepted: false })
      }
      if (['/api/chat.postMessage', '/api/views.open', '/api/views.update'].includes(u.pathname)) return Response.json({ ok: true, ts: '2' })
      throw new Error('unexpected call ' + u.pathname)
    }) as typeof fetch }
  const send = async (payload: any) => {
    const raw = payload.type === 'event_callback' ? JSON.stringify(payload) : new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
    const stamp = String(Math.floor(Date.now() / 1000))
    const sig = 'v0=' + createHmac('sha256', 'test').update(`v0:${stamp}:${raw}`).digest('hex')
    const request = new Request('http://localhost/', { method: 'POST', body: raw,
      headers: { 'x-slack-signature': sig, 'x-slack-request-timestamp': stamp } })
    const response = await handleFabricWebhook(request, raw, options, p => waits.push(p))
    await Promise.all(waits)
    return response
  }
  const action = (button: any, inView = true) => ({ type: 'block_actions', team: { id: 'T1' }, user: { id: 'U1' },
    ...(inView ? { view: { id: 'V1', hash: 'view-hash' } } : { channel: { id: 'C1' }, message: { ts: '1790000000.000001' } }),
    trigger_id: 'trigger', actions: [{ action_id: button.action_id, value: button.value }] })
  try {
    await send({ type: 'event_callback', team_id: 'T1', event_id: 'E1', event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1790000000.000001', text: '<@UBOT> fabric resume ' + url } })
    await send(action(buttons(calls.find(c => c.path.endsWith('chat.postMessage')).body)[0], false))
    const view = calls.find(c => c.path.endsWith('views.open')).body.view
    for (const item of items) {
      const button = buttons(view).find((b: any) => b.action_id === 'fabric_resume_artifact_' + item.kind)
      const sealed = JSON.parse(button.value)
      const tampered = { ...button, value: JSON.stringify({ ...sealed, body: sealed.body.replace('software-run', 'other-run') }) }
      const before = calls.length
      expect((await send(action(tampered)))?.status).toBe(403)
      expect((await send({ ...action(button), user: { id: 'U2' } }))?.status).toBe(403)
      expect(calls.length).toBe(before)
      expect((await send(action(button)))?.status).toBe(200)
      const get = calls.findLast(c => c.path === '/v1/resume-artifact')
      const ref = reference(item.kind, item.content, item.mediaType)
      expect(get.query).toEqual({ teamId: 'T1', channelId: 'C1', userId: 'U1', planeUrl: url,
        runId: ref.runId, generation: ref.generation, kind: item.kind, sha256: ref.sha256 })
      const modal = calls.findLast(c => c.path.endsWith('views.update')).body.view
      expect(modal.title.text).toBe(item.label)
      expect(modal.blocks[0].text.text).toContain('Acceptance is not established.')
    }
    expect(calls.filter(c => c.path.startsWith('/v1/')).every(c => c.method === 'GET')).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
