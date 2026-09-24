import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { handleFabricWebhook } from '../src/fabric'
import { parseReview, reviewView } from '../src/fabric-launch-review'
import type { Recipe } from '../src/fabric-recipes'
import { readiness, launchSubmission, PROFILE } from './launch-review-double'

const recipe: Recipe = { id: 'evidence-review', version: '1.1.0', digest: 'a'.repeat(64), title: 'Review prior work', description: 'A checked review',
  aliases: ['review'], taskType: 'retained-evidence-review', defaultProfile: 'focused', roles: ['Coordinator', 'Worker', 'Checker'],
  profiles: { focused: { title: 'Focused', description: 'Three sources', maxCalls: { coordinator: 8, worker: 24, checker: 16 } },
    full: { title: 'Full packet', description: 'Seven sources', maxCalls: { coordinator: 8, worker: 40, checker: 24 } } } }
const work = 'https://plane.example.test/work'
const event = (text: string, id = 'E1') => ({ type: 'event_callback', team_id: 'T1', event_id: id,
  event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1789846137.000001', text: '<@UBOT> ' + text } })
const opening = { type: 'block_actions', team: { id: 'T1' }, user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts: '1789846137.000001' },
  trigger_id: 'trigger', actions: [{ action_id: 'fabric_recipe_open', value: 'evidence-review' }] }
const submission = (view: any) => ({ type: 'view_submission', team: { id: 'T1' }, user: { id: 'U1' }, view: { ...view, id: 'V1',
  state: { values: { plane: { url: { value: work } }, profile: { choice: { selected_option: { value: 'full' } } } } } } })

type Behaviour = { review?: () => Response | Promise<Response>; runs?: () => Response }
async function fixture(body: (send: (payload: any, signed?: boolean) => Promise<Response | undefined>, calls: any[], set: (b: Behaviour) => void) => Promise<void>) {
  const dir = mkdtempSync(tmpdir() + '/fabric-review-'); writeFileSync(dir + '/token', 'test-identity')
  const calls: any[] = [], waits: Promise<unknown>[] = []
  let behaviour: Behaviour = {}
  const options = { apiUrl: '', botToken: 'test', signingSecret: 'test', fabricIntakeUrl: 'http://intake', fabricTokenPath: dir + '/token',
    launcherAllowedTeamIds: ['T1'], launcherAllowedChannelIds: ['C1'], launcherAllowedUserIds: ['U1', 'U2'],
    fetch: (async (url: any, init: any) => {
      const path = new URL(String(url)).pathname, payload = init.body ? JSON.parse(init.body) : undefined; calls.push({ path, body: payload })
      if (path === '/v1/recipes') return Response.json({ recipes: [recipe] })
      if (path === '/v1/recipe-catalog') return Response.json({ recipes: [recipe], launchEnabled: false, scope: 'Read-only catalog.' })
      if (path === '/v1/work-items') return Response.json({ projects: [], stale: false })
      if (path === '/v1/launch-readiness') return behaviour.review ? behaviour.review() : Response.json(readiness())
      if (path === '/v1/runs' && init.method === 'POST') return behaviour.runs ? behaviour.runs() : Response.json({ created: true, runId: 'lx-0925-01', state: 'QUEUED' }, { status: 202 })
      if (path.startsWith('/api/')) return Response.json({ ok: true, ts: '2' })
      throw new Error('unexpected ' + path)
    }) as typeof fetch }
  const send = async (payload: any, signed = true) => {
    const raw = payload.type === 'event_callback' ? JSON.stringify(payload) : new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
    const stamp = String(Math.floor(Date.now() / 1000)), signature = 'v0=' + createHmac('sha256', 'test').update(`v0:${stamp}:${raw}`).digest('hex')
    const req = new Request('http://localhost/api/slack/events', { method: 'POST', body: raw, headers: signed ? { 'x-slack-signature': signature, 'x-slack-request-timestamp': stamp } : {} })
    const response = await handleFabricWebhook(req, raw, options, p => waits.push(p)); await Promise.all(waits); return response
  }
  try { await body(send, calls, b => { behaviour = b }) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const recipeForm = async (send: any, calls: any[]) => { await send(opening); return calls.find(c => c.path.endsWith('views.open')).body.view }
const runs = (calls: any[]) => calls.filter(c => c.path === '/v1/runs' && c.body)

test('Review shows what, where, who, limits and destination; Launch only when launchable', () => fixture(async (send, calls) => {
  const form = await recipeForm(send, calls)
  expect(form.submit.text).toBe('Review')
  const pushed = await (await send(submission(form)))!.json()
  const text = JSON.stringify(pushed.view.blocks)
  for (const part of ['Eligible to attempt', 'k3s002 · gujranwala', 'requested model gpt-6-sol', 'worker 40', '32,768', 'this thread and the Plane item', 'credentials: UNKNOWN'])
    expect(text).toContain(part)
  expect(pushed.view.submit.text).toBe('Launch'); expect(pushed.view.title.text.length).toBeLessThanOrEqual(24)
  expect(pushed.view.blocks.length).toBeLessThanOrEqual(100)
  expect(pushed.view.blocks.every((b: any) => (b.text?.text ?? b.elements?.[0]?.text ?? '').length <= 3000)).toBe(true)
  expect(runs(calls)).toHaveLength(0)
}))

test('a not-launchable review names its first blocker and has no Launch', () => fixture(async (send, calls, set) => {
  set({ review: () => Response.json(readiness({}, false)) })
  const pushed = await (await send(submission(await recipeForm(send, calls))))!.json()
  expect(pushed.view.submit).toBeUndefined()
  expect(JSON.stringify(pushed.view.blocks)).toContain('Not launchable:* A run for this Plane item is still queued or running. (`ITEM_RUN_ACTIVE`)')
  expect(runs(calls)).toHaveLength(0)
}))

test('an inconsistent, malformed or unanswered review is Unavailable and starts nothing', () => fixture(async (send, calls, set) => {
  const form = await recipeForm(send, calls)
  const answers: Array<() => Response | Promise<Response>> = [
    () => Response.json(readiness({ launchable: true, checks: readiness({}, false).review.checks })),
    () => Response.json({ ready: true, review: { version: 2 } }),
    () => Response.json({ error: 'boom' }, { status: 503 }),
    () => { throw new DOMException('timeout', 'TimeoutError') }]
  for (const review of answers) {
    set({ review })
    expect(await (await send(submission(form)))!.json()).toEqual({ response_action: 'errors',
      errors: { plane: "Couldn't check eligibility: intake didn't answer. Nothing launched. Try again." } })
  }
  set({ review: () => Response.json({ error: 'EXECUTION_PROFILE_CHANGED_REFRESH' }, { status: 409 }) })
  expect(await (await send(submission(form)))!.json()).toMatchObject({ response_action: 'errors', errors: { profile: expect.stringContaining('Review again') } })
  expect(runs(calls)).toHaveLength(0)
}))

test('Launch sends the sealed request once per press; refusal and outage are explicit', () => fixture(async (send, calls, set) => {
  const pushed = await (await send(submission(await recipeForm(send, calls))))!.json()
  set({ runs: () => Response.json({ error: 'EXECUTION_PROFILE_CHANGED_REFRESH' }, { status: 409 }) })
  const refused = await (await send(launchSubmission(pushed.view)))!.json()
  expect(refused).toMatchObject({ response_action: 'update', view: { title: { text: 'Not launched' }, clear_on_close: true } })
  expect(JSON.stringify(refused.view)).toContain('EXECUTION_PROFILE_CHANGED_REFRESH')
  set({ runs: () => Response.json({ error: 'down' }, { status: 503 }) })
  expect((await send(launchSubmission(pushed.view)))!.status).toBe(503)
  set({})
  const ok = await (await send(launchSubmission(pushed.view)))!.json()
  expect(ok.view.title.text).toBe('Launched'); expect(JSON.stringify(ok.view)).toContain('lx-0925-01')
  const bodies = runs(calls).map(c => c.body)
  expect(bodies).toHaveLength(3); expect(new Set(bodies.map(b => JSON.stringify(b))).size).toBe(1)
  expect(bodies[0].expectedProfileDigest).toBe(PROFILE)
}))

test('Launch is bound to the reviewer: other users, channels and tampered metadata are refused', () => fixture(async (send, calls) => {
  const pushed = await (await send(submission(await recipeForm(send, calls))))!.json()
  expect((await send(launchSubmission(pushed.view, 'U2')))!.status).toBe(403)
  expect((await send(launchSubmission({ ...pushed.view, private_metadata: pushed.view.private_metadata.replace('full', 'focused') })))!.status).toBe(403)
  expect((await send(launchSubmission(pushed.view), false))!.status).toBe(401)
  expect(runs(calls)).toHaveLength(0)
}))

test('fabric launch posts a requester-only Review launch button that opens the same review', () => fixture(async (send, calls) => {
  await send(event('fabric launch review full <https://plane.example.test/work|work>'))
  const ephemeral = calls.find(c => c.path.endsWith('chat.postEphemeral'))
  expect(ephemeral.body).toMatchObject({ channel: 'C1', user: 'U1', thread_ts: '1789846137.000001' })
  expect(calls.filter(c => c.path.endsWith('chat.postMessage'))).toHaveLength(0)
  const button = ephemeral.body.blocks.find((b: any) => b.type === 'actions').elements[0]
  const click = (user: string) => ({ type: 'block_actions', team: { id: 'T1' }, user: { id: user }, channel: { id: 'C1' },
    message: { ts: '1789846137.000001' }, trigger_id: 't', actions: [{ action_id: button.action_id, value: button.value }] })
  expect((await send(click('U2')))!.status).toBe(403)
  expect((await send(click('U1')))!.status).toBe(200)
  const opened = calls.filter(c => c.path.endsWith('views.open')).at(-1).body.view
  expect(opened.callback_id).toBe('fabric_recipe_launch'); expect(opened.submit.text).toBe('Launch')
  expect(calls.find(c => c.path === '/v1/launch-readiness').body).toMatchObject({ recipeId: 'evidence-review', profile: 'full', planeUrl: work })
  expect(runs(calls)).toHaveLength(0)
  await send(event('fabric launch nonsense'))
  expect(calls.filter(c => c.path.endsWith('chat.postMessage')).at(-1).body.text).toContain('fabric launch <recipe>')
}))

test('copy rules: n/a is neutral, unknown is UNKNOWN, no approval wording without an ok approval', () => {
  const answer = readiness({}, false)
  answer.review.checks.push({ id: 'capacity', status: 'n/a', blocking: false, text: 'Decided by a one-use reservation, if an operator adds one.', source: 'policy' })
  const view = reviewView(parseReview(answer), { recipeTitle: 'R', version: '1', profileTitle: 'P', planeUrl: work }, '{}', 'fabric_recipe_launch')
  const text = JSON.stringify(view)
  expect(text).toContain('➖ capacity: n/a'); expect(text).toContain('credentials: UNKNOWN'); expect(text).not.toContain('✅ capacity: n/a')
  expect(() => parseReview({ ...answer, ready: true })).toThrow()
})
