import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { handleFabricWebhook, drainFabricDeliveries } from '../src/fabric'
import { drainProposals, proposalMessage, parseItem, type ProposalItem } from '../src/fabric-proposals'
import { seal } from '../src/fabric-recipes'
import { readiness } from './launch-review-double'

const TS = '1790309200.000100'
const PID = 'pr-285daf426543'
const card = (patch: Record<string, unknown> = {}) => ({ proposalId: PID, revision: 1, state: 'PENDING', class: 'closure-gap',
  title: 'Diagnose 5 ios-build-smoke runs left unverified (24 Sep)', label: 'Closure not verified',
  facts: ['ios-0924-07 · Needs attention · 2026-09-24T11:49:13Z · GET …/<run>-result TIMEOUT'], observedAt: 1790309100,
  offer: ['Runs: Review prior work · Triage · Linux (k3s002) · model gpt-6-sol', 'Limits: ≤ 4/8/6 model calls · 15 min · model gateway only', 'Uses one spare generic Linux slot.'],
  planeUrl: 'https://plane.example.test/ws/projects/p/issues/i/', publishedAt: 1790309100, expiresAt: 1790568300,
  decidedBy: null, decisionReason: null, runId: null, slackTs: TS, readiness: { launchable: true, firstBlocker: null, observedAt: 1790309150 }, ...patch })
const request = { requestId: 'recipe-4cd4de41d679166dcddb0d92', taskType: 'retained-evidence-review', teamId: 'T1', channelId: 'C1', threadTs: TS,
  planeUrl: 'https://plane.example.test/ws/projects/p/issues/i/', recipeId: 'evidence-review', recipeVersion: '1.2.0', recipeDigest: 'e'.repeat(64),
  profile: 'triage', expectedProfileDigest: 'd'.repeat(64), proposalId: PID, proposalRevision: '1' }
const arm = (patch: Record<string, unknown> = {}): ProposalItem => ({ id: `${PID}:1:slack:arm`, op: 'arm', channelId: 'C1', card: card(patch) as any, request: { ...request } })

type Route = (body: any, init: any) => Response | Promise<Response>
async function fixture(body: (h: { send: (p: any, signed?: boolean) => Promise<Response | undefined>; calls: any[]; routes: Record<string, Route>; options: any }) => Promise<void>) {
  const dir = mkdtempSync(tmpdir() + '/fabric-proposals-'); writeFileSync(dir + '/token', 'test-identity')
  const calls: any[] = [], waits: Promise<unknown>[] = []
  const routes: Record<string, Route> = {
    '/v1/proposals': () => Response.json({ items: [] }),
    '/v1/proposals/ack': () => Response.json({ ok: true }),
    '/v1/proposals/decision': b => Response.json({ ok: true, proposalId: b.proposalId, revision: 2, state: 'DISMISSED' }),
    '/v1/proposals/scan': () => Response.json({ ok: true, enabled: true }),
    '/v1/proposals/status': () => Response.json({ enabled: true, controls: { lastScanAt: 1790309100 }, pilot: { start: 1790309100, end: 1790913900, launches: 0, budget: 3 },
      proposals: [card()] }),
    '/v1/proposals/preview': () => Response.json({ backfillSince: '2026-09-24T00:00:00Z', groups: [{ label: 'Closure not verified', title: 'Diagnose 5', runIds: ['ios-0924-07'], launchable: true }],
      excluded: { 'closed-control': ['ios-0925-neg-01'] }, quota: [] }),
    '/v1/runs': () => Response.json({ created: true, runId: 'lx-0925-09', state: 'QUEUED' }, { status: 202 }),
    '/v1/launch-readiness': () => Response.json(readiness()),
    '/v1/deliveries': () => Response.json({ deliveries: [] }),
    '/v1/deliveries/ack': () => Response.json({ ok: true }),
    '/api/conversations.history': () => Response.json({ ok: true, messages: [] }),
    '/api/chat.postMessage': () => Response.json({ ok: true, ts: '1790309200.000100' })
  }
  const options = { apiUrl: '', botToken: 'test', signingSecret: 'test', fabricIntakeUrl: 'http://intake', fabricTokenPath: dir + '/token',
    launcherAllowedTeamIds: ['T1'], launcherAllowedChannelIds: ['C1'], launcherAllowedUserIds: ['U1', 'U2'],
    fetch: (async (url: any, init: any) => {
      const path = new URL(String(url)).pathname
      let payload: any
      try { payload = init.body ? (init.headers?.['Content-Type']?.includes('urlencoded') ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body)) : undefined } catch { payload = init.body }
      calls.push({ path, body: payload, query: new URL(String(url)).search })
      const route = routes[path]
      if (route) return route(payload, init)
      if (path.startsWith('/api/')) return Response.json({ ok: true, ts: '2' })
      throw new Error('unexpected ' + path)
    }) as typeof fetch }
  const send = async (payload: any, signed = true) => {
    const raw = payload.type === 'event_callback' ? JSON.stringify(payload) : new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
    const stamp = String(Math.floor(Date.now() / 1000)), signature = 'v0=' + createHmac('sha256', 'test').update(`v0:${stamp}:${raw}`).digest('hex')
    const req = new Request('http://localhost/api/slack/events', { method: 'POST', body: raw, headers: signed ? { 'x-slack-signature': signature, 'x-slack-request-timestamp': stamp } : {} })
    const response = await handleFabricWebhook(req, raw, options as any, p => waits.push(p)); await Promise.all(waits); return response
  }
  try { await body({ send, calls, routes, options }) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const click = (actionId: string, value: string, patch: Record<string, any> = {}) => ({ type: 'block_actions', team: { id: 'T1' }, user: { id: 'U2' },
  channel: { id: 'C1' }, message: { ts: TS }, container: { message_ts: TS }, trigger_id: 'trigger', actions: [{ action_id: actionId, value }], ...patch })
const buttons = (message: any) => message.blocks.find((b: any) => b.type === 'actions')?.elements ?? []
const valueOf = (item: ProposalItem, action: string) => buttons(proposalMessage(item, 'test')).find((b: any) => b.action_id === 'fabric_proposal_' + action)?.value
const runs = (calls: any[]) => calls.filter(c => c.path === '/v1/runs')
const mention = (text: string) => ({ type: 'event_callback', team_id: 'T1', event_id: 'E1',
  event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1790309300.000001', text: '<@UBOT> ' + text } })

// ------------------------------------------------------------------ poller: post → arm → update
test('post is unarmed, reconciled by history first, and acked with its ts', () => fixture(async ({ calls, routes, options }) => {
  routes['/v1/proposals'] = () => Response.json({ items: [{ id: `${PID}:1:slack:post`, op: 'post', channelId: 'C1', createdAt: 1790309100, card: card({ slackTs: null, readiness: null }) }] })
  await drainProposals(options)
  const posted = calls.find(c => c.path === '/api/chat.postMessage').body
  expect(buttons(posted)).toHaveLength(0)
  expect(JSON.stringify(posted.blocks)).toContain('Preparing — checking readiness')
  expect(posted.metadata).toEqual({ event_type: 'fabric_proposal', event_payload: { outboxId: `${PID}:1:slack:post`, proposalId: PID } })
  expect(calls.findIndex(c => c.path === '/api/conversations.history')).toBeLessThan(calls.findIndex(c => c.path === '/api/chat.postMessage'))
  expect(calls.find(c => c.path === '/v1/proposals/ack').body).toEqual({ id: `${PID}:1:slack:post`, receipt: TS })
}))

test('A14: a post without a ts stays unacked, and the next drain finds it in history instead of posting again', () => fixture(async ({ calls, routes, options }) => {
  routes['/v1/proposals'] = () => Response.json({ items: [{ id: `${PID}:1:slack:post`, op: 'post', channelId: 'C1', createdAt: 1790309100, card: card({ slackTs: null }) }] })
  routes['/api/chat.postMessage'] = () => Response.json({ ok: true })
  await expect(drainProposals(options)).rejects.toThrow('fabric_proposal_unverified')
  expect(calls.filter(c => c.path === '/v1/proposals/ack')).toHaveLength(0)
  routes['/api/conversations.history'] = () => Response.json({ ok: true, messages: [{ ts: '1790309201.000001',
    metadata: { event_type: 'fabric_proposal', event_payload: { outboxId: `${PID}:1:slack:post` } } }] })
  await drainProposals(options)
  expect(calls.filter(c => c.path === '/api/chat.postMessage')).toHaveLength(1)
  expect(calls.find(c => c.path === '/v1/proposals/ack').body.receipt).toBe('1790309201.000001')
}))

test('arm updates the same message with sealed buttons; a blocked card shows its blocker and Refresh, never Launch', () => fixture(async ({ calls, routes, options }) => {
  routes['/v1/proposals'] = () => Response.json({ items: [arm()] })
  await drainProposals(options)
  const updated = calls.find(c => c.path === '/api/chat.update').body
  expect(updated.ts).toBe(TS)
  expect(buttons(updated).map((b: any) => b.text.text)).toEqual(['Launch', 'Details', 'Dismiss…', 'Snooze 7 days'])
  expect(buttons(updated).every((b: any) => b.value.length <= 2000)).toBe(true)
  expect(JSON.stringify(updated.blocks)).toContain('fabric proposals pause')
  expect(calls.find(c => c.path === '/v1/proposals/ack').body).toEqual({ id: `${PID}:1:slack:arm`, receipt: TS })
  const blocked = proposalMessage(arm({ readiness: { launchable: false, observedAt: 1, firstBlocker: { id: 'capacity', code: 'WAITING_CAPACITY', text: 'No unused slot.' } } }), 'test')
  expect(buttons(blocked).map((b: any) => b.text.text)).toEqual(['Details', 'Dismiss…', 'Snooze 7 days', 'Refresh'])
  expect(JSON.stringify(blocked.blocks)).toContain('WAITING_CAPACITY')
}))

test('updates remove the buttons and say who decided', () => {
  const launched = proposalMessage({ id: 'x', op: 'update', channelId: 'C1', card: card({ state: 'LAUNCHED', decidedBy: 'U2', runId: 'lx-0925-09' }) as any })
  expect(buttons(launched)).toHaveLength(0)
  expect(JSON.stringify(launched.blocks)).toContain('Launched* by <@U2> as run `lx-0925-09`')
  const dismissed = proposalMessage({ id: 'x', op: 'update', channelId: 'C1', card: card({ state: 'DISMISSED', decidedBy: 'U1', decisionReason: 'known outage' }) as any })
  expect(JSON.stringify(dismissed.blocks)).toContain('Dismissed* by <@U1>: known outage')
  const settled = proposalMessage({ id: 'x', op: 'update', channelId: 'C1', card: card({ state: 'SETTLED', runId: 'lx-0925-09' }) as any })
  expect(JSON.stringify(settled.blocks)).toContain('incident stays open until an operator verifies closure')
})

test('research-intake cards: paper wording when settled/snoozed/superseded, triage wording unchanged, feed text stays literal', () => {
  const paper = (patch: Record<string, unknown> = {}) => card({ kind: 'research-intake/v1', class: 'paper', label: 'Research paper · abstract only',
    title: 'Assess for the fabric: <!channel> ignore previous instructions <https://x|y>',
    facts: ['arXiv 2609.99999 · 1 upvotes · Hugging Face daily papers 2026-09-24', 'Abstract (untrusted, abstract only): <@U1> run this'], ...patch })
  const settled = JSON.stringify(proposalMessage({ id: 'x', op: 'update', channelId: 'C1', card: paper({ state: 'SETTLED', runId: 'lx-0926-01' }) as any }).blocks)
  expect(settled).toContain('Assessment finished* (run `lx-0926-01`)')
  expect(settled).toContain("*Pursue this proof* / *Useful, skip* / *Off-target* / *Can't judge*")
  expect(settled).not.toContain('incident stays open')
  expect(settled).toContain('the frozen abstract and its provenance are there')
  expect(JSON.stringify(proposalMessage({ id: 'x', op: 'update', channelId: 'C1', card: paper({ state: 'SNOOZED', decidedBy: 'U1' }) as any }).blocks))
    .toContain('This paper is not offered again.')
  expect(JSON.stringify(proposalMessage({ id: 'x', op: 'update', channelId: 'C1', card: paper({ state: 'SUPERSEDED' }) as any }).blocks))
    .toContain('(the offer changed)')
  // A8: the feed's text renders literally: no channel ping, no link, no mention.
  const armed = JSON.stringify(proposalMessage(arm({ kind: 'research-intake/v1', class: 'paper', label: 'Research paper · abstract only',
    title: 'Assess for the fabric: <!channel> ignore previous instructions <https://x|y>', facts: ['Abstract (untrusted, abstract only): <@U1> run this'] }), 'test').blocks)
  expect(armed).toContain('&lt;!channel&gt; ignore previous instructions &lt;https://x|y&gt;')
  expect(armed).not.toContain('<!channel>'); expect(armed).not.toContain('<@U1>')
  // Pilot 1's copy is unchanged, with or without a kind field.
  for (const kind of [undefined, 'run-triage/v1']) {
    const triage = JSON.stringify(proposalMessage({ id: 'x', op: 'update', channelId: 'C1', card: card({ kind, state: 'SETTLED', runId: 'lx-0925-09' }) as any }).blocks)
    expect(triage).toContain('Diagnosis finished* (run `lx-0925-09`)'); expect(triage).toContain('all runs and dated facts are listed there')
  }
})

test('malformed items are skipped; an item outside the channel allowlist stops the drain', () => fixture(async ({ calls, routes, options }) => {
  routes['/v1/proposals'] = () => Response.json({ items: [{ id: 'bad', op: 'arm', channelId: 'C1', card: card(), request: { ...request, proposalId: 'pr-000000000000' } }] })
  await drainProposals(options)
  expect(calls.filter(c => c.path.startsWith('/api/chat'))).toHaveLength(0)
  expect(() => parseItem({ ...arm(), request: { ...request, extra: 'x' } })).toThrow()
  routes['/v1/proposals'] = () => Response.json({ items: [{ ...arm(), channelId: 'C9', request: { ...request, channelId: 'C9' } }] })
  await expect(drainProposals(options)).rejects.toThrow('fabric_proposal_outside_allowlist')
}))

// ------------------------------------------------------------------ Launch
test('Launch posts the sealed request as the allowlisted clicker, in the card thread', () => fixture(async ({ send, calls }) => {
  expect((await send(click('fabric_proposal_launch', valueOf(arm(), 'launch'))))!.status).toBe(200)
  expect(runs(calls)).toHaveLength(1)
  expect(runs(calls)[0].body).toEqual({ ...request, userId: 'U2' })
  expect(calls.find(c => c.path === '/api/chat.postEphemeral').body.text).toContain('Launched as run `lx-0925-09`')
}))

test('A11/A21: non-allowlisted clicker, tampered seal, other channel, other message or unsigned → nothing reaches the intake', () => fixture(async ({ send, calls }) => {
  const value = valueOf(arm(), 'launch')
  const tampered = JSON.parse(value); tampered.body = tampered.body.replace('"profile":"triage"', '"profile":"full"')
  const other = seal({ proposalId: PID, revision: 1, teamId: 'T1', channelId: 'C1', messageTs: '1790309999.000001', request: { ...request, threadTs: '1790309999.000001' } }, 'test')
  const cases: Array<[any, number, boolean?]> = [
    [click('fabric_proposal_launch', value, { user: { id: 'U9' } }), 403],
    [click('fabric_proposal_launch', JSON.stringify(tampered)), 403],
    [click('fabric_proposal_launch', value, { channel: { id: 'C2' } }), 403],
    [click('fabric_proposal_launch', value, { message: { ts: '1790309999.000001' }, container: { message_ts: '1790309999.000001' } }), 403],
    [click('fabric_proposal_launch', other), 403],
    [click('fabric_proposal_launch', value), 401, false]]
  for (const [payload, status, signed] of cases) expect((await send(payload, signed ?? true))!.status).toBe(status)
  expect(runs(calls)).toHaveLength(0)
}))

test('A23: a lost intake answer shows nothing as launched; the second click replays the same request', () => fixture(async ({ send, calls, routes }) => {
  let n = 0
  routes['/v1/runs'] = () => { if (n++ === 0) throw new DOMException('timeout', 'TimeoutError'); return Response.json({ created: false, runId: 'lx-0925-09', state: 'QUEUED' }) }
  const value = valueOf(arm(), 'launch')
  await send(click('fabric_proposal_launch', value))
  const first = calls.filter(c => c.path === '/api/chat.postEphemeral').map(c => c.body.text)
  expect(first[0]).toContain('nothing is known to have started'); expect(first[0]).not.toContain('Launched as')
  await send(click('fabric_proposal_launch', value))
  expect(runs(calls).map(c => c.body.requestId)).toEqual([request.requestId, request.requestId])
  expect(calls.filter(c => c.path === '/api/chat.postEphemeral')[1].body.text).toContain('Already launched as run `lx-0925-09`')
}))

test('a refused launch says why and starts nothing', () => fixture(async ({ send, calls, routes }) => {
  routes['/v1/runs'] = () => Response.json({ error: 'PROPOSAL_CLOSED' }, { status: 409 })
  await send(click('fabric_proposal_launch', valueOf(arm(), 'launch')))
  expect(calls.find(c => c.path === '/api/chat.postEphemeral').body.text).toContain('dismissed, snoozed, expired or already launched. (PROPOSAL_CLOSED)')
}))

// ------------------------------------------------------------------ Details, Dismiss, Snooze, Refresh, Resume
test('Details opens the review read-only (no Launch in the modal) and never posts a run', () => fixture(async ({ send, calls }) => {
  await send(click('fabric_proposal_details', valueOf(arm(), 'details')))
  const view = calls.find(c => c.path === '/api/views.open').body.view
  expect(view.submit).toBeUndefined(); expect(view.callback_id).toBeUndefined()
  expect(JSON.stringify(view.blocks)).toContain('Read-only')
  expect(calls.find(c => c.path === '/v1/launch-readiness').body.userId).toBe('U2')
  expect(runs(calls)).toHaveLength(0)
}))

test('Dismiss asks for an optional reason, then records the decision as the clicker', () => fixture(async ({ send, calls, routes }) => {
  await send(click('fabric_proposal_dismiss', valueOf(arm(), 'dismiss')))
  const modal = calls.find(c => c.path === '/api/views.open').body.view
  expect(modal.callback_id).toBe('fabric_proposal_dismiss_submit')
  const submit = (user = 'U2') => ({ type: 'view_submission', team: { id: 'T1' }, user: { id: user },
    view: { callback_id: 'fabric_proposal_dismiss_submit', private_metadata: modal.private_metadata, state: { values: { reason: { text: { value: ' known Mac host outage ' } } } } } })
  expect(await (await send(submit()))!.json()).toEqual({ response_action: 'clear' })
  expect(calls.find(c => c.path === '/v1/proposals/decision').body).toEqual({ teamId: 'T1', channelId: 'C1', userId: 'U2', decision: 'dismiss',
    proposalId: PID, revision: 1, reason: 'known Mac host outage' })
  expect((await send(submit('U1')))!.status).toBe(403)   // the modal is bound to whoever opened it
  routes['/v1/proposals/decision'] = () => Response.json({ error: 'PROPOSAL_CLOSED' }, { status: 409 })
  expect((await (await send(submit()))!.json()).errors.reason).toContain('PROPOSAL_CLOSED')
}))

test('Snooze and Refresh send their decisions; Resume clears the quota latch', () => fixture(async ({ send, calls }) => {
  await send(click('fabric_proposal_snooze', valueOf(arm(), 'snooze')))
  await send(click('fabric_proposal_refresh', valueOf(arm({ readiness: { launchable: false, observedAt: 1, firstBlocker: null } }), 'refresh')))
  const quota = seal({ kind: 'quota', teamId: 'T1', channelId: 'C1' }, 'test')
  await send(click('fabric_proposal_resume', quota, { message: { ts: '1790309300.000001' } }))
  expect(calls.filter(c => c.path === '/v1/proposals/decision').map(c => c.body.decision)).toEqual(['snooze', 'refresh', 'quota-resume'])
  expect(calls.find(c => c.path === '/api/chat.update').body.text).toBe('Proposals resumed')
}))

// ------------------------------------------------------------------ commands
test('fabric proposals commands: status, preview, scan, pause, reoffer, and a usage hint', () => fixture(async ({ send, calls }) => {
  for (const text of ['fabric proposals', 'fabric proposals preview', 'fabric proposals scan', 'fabric proposals pause', `fabric proposals reoffer ${PID}`, 'fabric proposals launch'])
    await send(mention(text))
  const replies = calls.filter(c => c.path === '/api/chat.postMessage').map(c => c.body.text)
  expect(replies[0]).toContain('launches 0/3'); expect(replies[1]).toContain('closed-control 1')
  expect(replies[2]).toContain('Scan requested'); expect(replies[3]).toBe('Proposals paused.')
  expect(replies[4]).toContain('revision 2'); expect(replies[5]).toContain('Use `@centaur fabric proposals`')
  expect(calls.find(c => c.path === '/v1/proposals/scan').body).toEqual({ teamId: 'T1', channelId: 'C1', userId: 'U1' })
  expect(calls.filter(c => c.path === '/v1/proposals/decision').map(c => c.body.decision)).toEqual(['pause', 'reoffer'])
  expect(runs(calls)).toHaveLength(0)
}))

// ------------------------------------------------------------------ small extra: failed-run cards show why
test('a failed run card shows result.error, not only "Work stopped"', () => fixture(async ({ calls, routes, options }) => {
  routes['/v1/deliveries'] = () => Response.json({ deliveries: [{ id: 'lx-1:result:slack', run: { requestId: 'r', runId: 'lx-1', state: 'FAILED', channelId: 'C1', threadTs: TS,
    view: { title: 'Evidence review', status: 'Work stopped', nextAction: 'Read the run failure.', closure: 'Access closed', checked: false, closed: true },
    result: { error: 'The shared model credential reported its usage limit (MODEL_USAGE_LIMIT_REACHED); the call was not retried.' } } }] })
  await drainFabricDeliveries(options)
  const posted = calls.find(c => c.path === '/api/chat.postMessage').body
  expect(posted.text).toContain('Observation: The shared model credential reported its usage limit')
  expect(JSON.stringify(posted.blocks)).toContain('*Observation:* The shared model credential')
}))
