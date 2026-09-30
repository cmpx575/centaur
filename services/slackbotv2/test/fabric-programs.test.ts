import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { handleFabricWebhook, drainFabricDeliveries, type Run } from '../src/fabric'
import { unseal, type Recipe } from '../src/fabric-recipes'
import { readiness } from './launch-review-double'

const TS = '1789846137.000001'
const PG = 'pg-0123456789abcdef'
const shape = { id: 'retry-until-accepted', version: '1.0.0', digest: 's'.repeat(64), title: 'Retry until accepted',
  description: 'One more attempt with the reasons', scope: 'parent', lead: 'code', limits: { maxAttempts: 2, deadlineSeconds: 10800 } }
const research: Recipe = { id: 'research-packet', version: '1.3.1', digest: 'r'.repeat(64), title: 'Prepare a research handoff', description: 'Research',
  aliases: ['research'], taskType: 'retained-evidence-review', defaultProfile: 'focused', roles: ['Coordinator', 'Worker', 'Checker'],
  profiles: { focused: { title: 'Focused', description: 'Six sources', maxCalls: { coordinator: 4, worker: 8, checker: 6 } } }, shapes: [shape] }
const review: Recipe = { ...research, id: 'evidence-review', aliases: ['review'], title: 'Review prior work', shapes: undefined }
const program = (patch: Record<string, unknown> = {}) => ({ programId: PG, shape: 'retry-until-accepted', attempt: 1, maxAttempts: 2,
  state: 'RUNNING', outcome: null, stoppable: true, ...patch })
const run = (patch: Partial<Run> = {}): Run => ({ requestId: 'recipe-1', runId: 'lx-1', state: 'FAILED', channelId: 'C1', threadTs: TS,
  view: { title: 'Item', status: 'Attempt 1 of 2 · Needs revision', nextAction: 'The fabric starts attempt 2 by itself.', closure: 'Access closed', checked: false, closed: true },
  program: program() as any, ...patch })

async function fixture(body: (h: { send: (p: any, signed?: boolean) => Promise<Response | undefined>; calls: any[]; routes: Record<string, (b: any) => Response>; options: any }) => Promise<void>) {
  const dir = mkdtempSync(tmpdir() + '/fabric-programs-'); writeFileSync(dir + '/token', 'test-identity')
  const calls: any[] = [], waits: Promise<unknown>[] = []
  const routes: Record<string, (b: any) => Response> = {
    '/v1/programs/stop': b => Response.json({ ok: true, programId: b.programId, stopRequested: true, attempt: 1, maxAttempts: 2 }),
    '/v1/recipes': () => Response.json({ recipes: [research, review] }),
    '/v1/launch-readiness': () => Response.json(readiness()),
    '/v1/deliveries': () => Response.json({ deliveries: [] }),
    '/v1/deliveries/ack': () => Response.json({ ok: true })
  }
  const options = { apiUrl: '', botToken: 'test', signingSecret: 'test', fabricIntakeUrl: 'http://intake', fabricTokenPath: dir + '/token',
    launcherAllowedTeamIds: ['T1'], launcherAllowedChannelIds: ['C1', 'C2'], launcherAllowedUserIds: ['U1', 'U2'],
    fetch: (async (url: any, init: any) => {
      const path = new URL(String(url)).pathname, payload = init.body ? JSON.parse(init.body) : undefined
      calls.push({ path, body: payload })
      if (routes[path]) return routes[path](payload)
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
const actions = (message: any) => message.blocks.find((b: any) => b.type === 'actions').elements
const click = (value: string, patch: Record<string, any> = {}) => ({ type: 'block_actions', team: { id: 'T1' }, user: { id: 'U2' },
  channel: { id: 'C1' }, message: { ts: '1789846200.000001', thread_ts: TS }, actions: [{ action_id: 'fabric_program_stop', value }], ...patch })
const event = (text: string) => ({ type: 'event_callback', team_id: 'T1', event_id: 'E1',
  event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: TS, text: '<@UBOT> ' + text } })

async function stopValue(options: any, routes: any, calls: any[], item = run()) {
  routes['/v1/deliveries'] = () => Response.json({ deliveries: [{ id: 'lx-1:result:slack', run: item }] })
  await drainFabricDeliveries(options)
  const posted = calls.filter(c => c.path === '/api/chat.postMessage').at(-1).body
  return actions(posted).find((b: any) => b.action_id === 'fabric_program_stop')?.value as string | undefined
}

test('an attempt card with a next attempt carries a sealed Stop; the last, final or plain card does not', () => fixture(async ({ calls, routes, options }) => {
  const value = await stopValue(options, routes, calls)
  expect(unseal(value!, 'test')).toEqual({ programId: PG, channelId: 'C1' })
  const posted = calls.filter(c => c.path === '/api/chat.postMessage').at(-1).body
  expect(posted.thread_ts).toBe(TS)
  expect(JSON.stringify(posted.blocks)).toContain('Attempt 1 of 2 · Needs revision')
  expect(await stopValue(options, routes, calls, run({ program: program({ attempt: 2, stoppable: false }) as any }))).toBeUndefined()
  expect(await stopValue(options, routes, calls, run({ program: program({ final: true, state: 'ENDED' }) as any }))).toBeUndefined()
  expect(await stopValue(options, routes, calls, run({ program: undefined }))).toBeUndefined()
}))

test('Stop relays the clicker to the fabric and answers in the thread', () => fixture(async ({ send, calls, routes, options }) => {
  const value = (await stopValue(options, routes, calls))!
  expect((await send(click(value)))!.status).toBe(200)
  expect(calls.find(c => c.path === '/v1/programs/stop').body).toEqual({ programId: PG, teamId: 'T1', channelId: 'C1', userId: 'U2' })
  const reply = calls.filter(c => c.path === '/api/chat.postMessage').at(-1).body
  expect(reply).toMatchObject({ channel: 'C1', thread_ts: TS })
  expect(reply.text).toContain('Stop requested by <@U2>: attempt 2 will not start')
  routes['/v1/programs/stop'] = () => Response.json({ error: 'PROGRAM_NO_NEXT_ATTEMPT' }, { status: 409 })
  await send(click(value))
  expect(calls.filter(c => c.path === '/api/chat.postMessage').at(-1).body.text).toContain('this is the last attempt')
}))

test('Stop refuses an unsigned click, a stranger, another channel and a forged value without calling the fabric', () => fixture(async ({ send, calls, routes, options }) => {
  const value = (await stopValue(options, routes, calls))!
  expect((await send(click(value), false))!.status).toBe(401)
  expect((await send(click(value, { user: { id: 'U9' } })))!.status).toBe(403)
  expect((await send(click(value, { channel: { id: 'C2' } })))!.status).toBe(403)
  expect((await send(click(JSON.stringify({ body: JSON.stringify({ programId: PG, channelId: 'C1' }), signature: 'f'.repeat(64) }))))!.status).toBe(403)
  expect(calls.filter(c => c.path === '/v1/programs/stop')).toHaveLength(0)
}))

test('fabric launch seals source: person by default, lane with a trailing lane (also after retry)', () => fixture(async ({ send, calls }) => {
  const sealed = () => unseal(calls.filter(c => c.path === '/api/chat.postEphemeral').at(-1).body.blocks
    .find((b: any) => b.type === 'actions').elements[0].value, 'test').request
  await send(event('fabric launch research focused <https://plane.example.test/work|work>'))
  expect(sealed().source).toBe('person')
  await send(event('fabric launch research focused <https://plane.example.test/work|work> lane'))
  expect(sealed().source).toBe('lane')
  await send(event('fabric launch research focused <https://plane.example.test/work|work> retry lane'))
  expect(sealed()).toMatchObject({ source: 'lane', shapeId: shape.id })
  expect(calls.filter(c => c.path === '/v1/runs')).toHaveLength(0)
}))

test('fabric launch … retry reviews the recipe with its retry shape; without it or on another recipe nothing changes', () => fixture(async ({ send, calls }) => {
  await send(event('fabric launch research focused <https://plane.example.test/work|work> retry'))
  const ephemeral = calls.filter(c => c.path === '/api/chat.postEphemeral').at(-1).body
  expect(JSON.stringify(ephemeral.blocks)).toContain('Retry until accepted (up to 2 attempts)')
  const sealed = unseal(ephemeral.blocks.find((b: any) => b.type === 'actions').elements[0].value, 'test')
  expect(sealed.request).toMatchObject({ recipeId: 'research-packet', shapeId: shape.id, shapeVersion: shape.version, shapeDigest: shape.digest })
  await send(event('fabric launch research focused <https://plane.example.test/work|work>'))
  const plainSeal = unseal(calls.filter(c => c.path === '/api/chat.postEphemeral').at(-1).body.blocks.find((b: any) => b.type === 'actions').elements[0].value, 'test')
  expect(Object.keys(plainSeal.request).some(k => k.startsWith('shape'))).toBe(false)
  await send(event('fabric launch review focused <https://plane.example.test/work|work> retry'))
  expect(calls.filter(c => c.path === '/api/chat.postMessage').at(-1).body.text).toContain('does not offer "Retry until accepted"')
  expect(calls.filter(c => c.path === '/v1/runs')).toHaveLength(0)
}))
