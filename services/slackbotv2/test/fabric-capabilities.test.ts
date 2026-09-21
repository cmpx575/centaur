import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createMemoryState } from '@chat-adapter/state-memory'
import { createSlackbotV2 } from '../src/index'
import { capabilityMessage, capabilityView, parseCapabilityOverview, type CapabilityOverview } from '../src/fabric-capabilities'
import { recipeMenu } from '../src/fabric-recipes'

export const overview: CapabilityOverview = {
  schemaVersion: 1,
  profiles: [
    { id: 'windows-inventory', title: 'Windows inventory', status: 'qualified',
      summary: 'A checked inventory on a temporary Windows VM.', prerequisites: ['An enabled recipe and fresh VM capacity.'] },
    { id: 'ios-build', title: 'iOS build and simulator', status: 'needs-qualification',
      summary: 'Reuse the earlier app build and simulator work.', prerequisites: ['A compatible Mac image.', 'Connect artifact checks and cleanup.'] },
    { id: 'private-linux', title: 'Private Linux desktop', status: 'research-only',
      summary: 'Compare disposable desktop options.', prerequisites: ['Verify the network and desktop profile before use.'] },
  ],
  teamSummary: 'Hermes coordinates a separate worker and checker. Additional agent providers need qualification.',
  capacityNote: 'Availability is checked when you request work.',
  requestedProviders: [{ id: 'Additional provider', status: 'research-only', summary: 'Not yet connected to the run workflow.' }],
}

type Call = { path: string; method: string; body?: any; query: URLSearchParams; authorization?: string | null }
async function fixture(work: (send: (payload: any, signed?: boolean) => Promise<Response>, calls: Call[]) => Promise<void>,
  response = { status: 200, body: overview as unknown }) {
  const dir = mkdtempSync(tmpdir() + '/fabric-capabilities-')
  writeFileSync(dir + '/token', 'test-intake-identity')
  const calls: Call[] = []
  const bot = createSlackbotV2({ apiUrl: '', botToken: 'test', signingSecret: 'test',
    fabricIntakeUrl: 'http://intake', fabricTokenPath: dir + '/token',
    launcherAllowedTeamIds: ['T1'], launcherAllowedChannelIds: ['C1'], launcherAllowedUserIds: ['U1'],
    state: createMemoryState(), recoverRenderObligationsOnStart: false,
    fetch: (async (url: any, init: any) => {
      const parsed = new URL(String(url))
      const call = { path: parsed.pathname, method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined, query: parsed.searchParams,
        authorization: new Headers(init.headers).get('Authorization') }
      calls.push(call)
      if (call.path === '/v1/capabilities') return Response.json(response.body, { status: response.status })
      if (call.path === '/api/chat.postMessage') return Response.json({ ok: true, ts: '2' })
      if (call.path === '/api/views.open') return Response.json({ ok: true })
      throw new Error('unexpected ' + call.path)
    }) as typeof fetch })
  const send = async (payload: any, signed = true) => {
    const raw = payload.type === 'event_callback' ? JSON.stringify(payload) : new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
    const stamp = String(Math.floor(Date.now() / 1000))
    const signature = 'v0=' + createHmac('sha256', 'test').update(`v0:${stamp}:${raw}`).digest('hex')
    const path = payload.type === 'event_callback' ? '/api/slack/events' : '/api/webhooks/slack/actions'
    const waits: Promise<unknown>[] = []
    const request = new Request('http://localhost' + path, { method: 'POST', body: raw,
      headers: signed ? { 'x-slack-signature': signature, 'x-slack-request-timestamp': stamp } : {} })
    const result = await bot.app.request(request, undefined, { waitUntil: (promise: Promise<unknown>) => waits.push(promise), passThroughOnException() {} })
    await Promise.all(waits)
    return result
  }
  try { await work(send, calls) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const mention = { type: 'event_callback', team_id: 'T1', event_id: 'ECAP1', event: {
  type: 'app_mention', user: 'U1', channel: 'C1', ts: '1789980000.000001', thread_ts: '1789970000.000001',
  text: '<@UBOT> fabric capabilities *Sent using* <@UCHATGPT>' } }
const button = { type: 'block_actions', team: { id: 'T1' }, user: { id: 'U1' }, channel: { id: 'C1' },
  message: { ts: '1789980000.000001' }, trigger_id: 'trigger', actions: [{ action_id: 'fabric_recipe_capabilities' }] }

test('capability overview distinguishes proof, prerequisites and capacity without launch controls', () => {
  const message = capabilityMessage(overview)
  expect(message.text).toContain('Qualified: Windows inventory')
  expect(message.text).toContain('Needs qualification: iOS build and simulator')
  expect(message.text).toContain('Research only: Private Linux desktop')
  expect(message.text).toContain('A compatible Mac image.')
  expect(message.text).toContain('Free machines, GPUs, access and approval are checked separately')
  expect(message.text).toContain('Agent options under research')
  expect(message.blocks.every(block => ['section', 'header'].includes(block.type))).toBe(true)
  expect(capabilityView(overview)).not.toHaveProperty('submit')
  expect(recipeMenu([]).blocks.some((block: any) => block.elements?.some((element: any) =>
    element.action_id === 'fabric_recipe_capabilities' && element.text.text === 'Capabilities'))).toBe(true)
})

test('bounded layouts keep all three groups below message limits with plain text cards', () => {
  const large = { ...overview, profiles: Array.from({ length: 100 }, (_, index) => ({ ...overview.profiles[index % 3]!,
    id: String(index), title: '<@U1> ' + 't'.repeat(400), summary: 's'.repeat(5000), prerequisites: Array(12).fill('p'.repeat(2000)) })) }
  const message = capabilityMessage(large)
  expect(message.blocks.length).toBeLessThanOrEqual(50)
  expect(message.blocks.every(block => block.text.type === 'plain_text' && block.text.text.length <= 3000)).toBe(true)
  expect(message.text.length).toBeLessThan(40000)
  expect(message.text).not.toContain('<@U1>')
  expect(message.text).toContain('&lt;@U1&gt;')
  expect(message.blocks.some(block => block.text.text === 'Showing 40 of 100 capabilities.')).toBe(true)
})

test('invalid or unknown qualification and provider state cannot be rendered as qualified', () => {
  expect(parseCapabilityOverview(overview)).toEqual(overview)
  for (const invalid of [{ ...overview, schemaVersion: 2 }, { ...overview, profiles: [{ ...overview.profiles[0], status: 'ready' }] },
    { ...overview, requestedProviders: [{ id: 'unverified', status: 'qualified', summary: 'Ready' }] }]) {
    expect(() => parseCapabilityOverview(invalid)).toThrow('invalid_capability_overview')
  }
})

test('signed mention reads capability descriptions and replies to the originating thread through the route', async () => fixture(async (send, calls) => {
  expect((await send(mention)).status).toBe(200)
  expect(calls.map(call => call.path)).toEqual(['/v1/capabilities', '/api/chat.postMessage'])
  expect(calls[0]!.method).toBe('GET')
  expect(Object.fromEntries(calls[0]!.query)).toEqual({ teamId: 'T1', channelId: 'C1', userId: 'U1' })
  expect(calls[0]!.authorization).toBe('Bearer test-intake-identity')
  expect(calls[1]!.body).toMatchObject({ channel: 'C1', thread_ts: '1789970000.000001', text: capabilityMessage(overview).text })
}))

test('capabilities button opens a read-only modal and does not submit a run', async () => fixture(async (send, calls) => {
  expect((await send(button)).status).toBe(200)
  expect(calls.map(call => call.path)).toEqual(['/v1/capabilities', '/api/views.open'])
  expect(calls[1]!.body).toEqual({ trigger_id: 'trigger', view: capabilityView(overview) })
}))

test('unsigned or disallowed actors cannot read capability descriptions', async () => fixture(async (send, calls) => {
  expect((await send(mention, false)).status).toBe(401)
  expect((await send(button, false)).status).toBe(401)
  expect((await send({ ...button, user: { id: 'OTHER' } })).status).toBe(403)
  expect((await send({ ...button, team: { id: 'OTHER' } })).status).toBe(403)
  expect((await send({ ...button, channel: { id: 'OTHER' } })).status).toBe(403)
  expect(calls).toHaveLength(0)
}))

test('transient backend failure remains retryable without a false capability message', async () => fixture(async (send, calls) => {
  expect((await send(mention)).status).toBe(503)
  expect(calls.map(call => call.path)).toEqual(['/v1/capabilities'])
}, { status: 503, body: { error: 'TEMPORARY' } }))

test('invalid catalog response remains retryable and cannot invent capabilities', async () => fixture(async (send, calls) => {
  expect((await send(button)).status).toBe(503)
  expect(calls.map(call => call.path)).toEqual(['/v1/capabilities'])
}, { status: 200, body: { schemaVersion: 2, profiles: [] } }))
