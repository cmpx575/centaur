import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { handleFabricWebhook } from '../src/fabric'
import { parseVmCommand, duration, drainVmDeliveries, vmCardText, type VmLease } from '../src/fabric-vms'

const lease = (patch: Partial<VmLease> = {}): VmLease => ({ lease: 'vl-0925-84770e', state: 'HELD', pending: null, os: 'ubuntu-desktop',
  size: 'medium', hours: 8, script: 'none', network: 'internet', vm: 'ubuntu2404-t1-fabric-84770e', from: null, expires: 1790350000,
  error: null, channelId: 'C1', threadTs: '1.0', owner: 'U1',
  access: { vnc: 'virtctl --context k vnc ubuntu2404-t1-fabric-84770e -n fabric-vms', ssh: 'virtctl --context k ssh fabric@vm/ubuntu2404-t1-fabric-84770e/fabric-vms -i ~/.ssh/id_ed25519' },
  view: { title: 'ubuntu-desktop · medium · vl-0925-84770e', status: 'Ready', nextAction: 'Open it with the VNC or SSH line below.',
    vm: 'ubuntu2404-t1-fabric-84770e', expires: '2026-09-25 18:00 UTC', network: 'internet', script: 'none',
    accessLines: ['virtctl --context k vnc ubuntu2404-t1-fabric-84770e -n fabric-vms', 'virtctl --context k ssh fabric@vm/x/fabric-vms'],
    actions: ['stop', 'save', 'discard'] }, ...patch })

type Route = (body: any) => Response | Promise<Response>
async function fixture(body: (h: { mention: (text: string, user?: string, eventId?: string) => Promise<Response | undefined>;
  calls: any[]; routes: Record<string, Route>; options: any; posts: () => string[] }) => Promise<void>) {
  const dir = mkdtempSync(tmpdir() + '/fabric-vms-'); writeFileSync(dir + '/token', 'test-identity')
  const calls: any[] = [], waits: Promise<unknown>[] = []
  const routes: Record<string, Route> = {
    '/v1/vms': () => Response.json({ ...lease({ state: 'ADMITTED' }), created: true }, { status: 202 }),
    '/v1/vms/deliveries': () => Response.json({ deliveries: [] }),
    '/v1/vms/deliveries/ack': () => Response.json({ ok: true }),
    '/api/chat.postMessage': () => Response.json({ ok: true, ts: '1790309200.000200' }),
  }
  const options = { apiUrl: '', botToken: 'test', signingSecret: 'test', fabricIntakeUrl: 'http://intake', fabricTokenPath: dir + '/token',
    launcherAllowedTeamIds: ['T1'], launcherAllowedChannelIds: ['C1'], launcherAllowedUserIds: ['U1', 'U2'],
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url))
      const payload = init.body ? JSON.parse(init.body) : undefined
      calls.push({ path: u.pathname, method: init.method, body: payload, query: u.search })
      const route = routes[u.pathname]
      if (route) return route(payload)
      throw new Error('unexpected ' + u.pathname)
    }) as typeof fetch }
  const mention = async (text: string, user = 'U1', eventId = 'Ev1') => {
    const raw = JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: eventId,
      event: { type: 'app_mention', text: '<@UBOT> ' + text, user, channel: 'C1', ts: '1790309000.000100' } })
    const stamp = String(Math.floor(Date.now() / 1000)), signature = 'v0=' + createHmac('sha256', 'test').update(`v0:${stamp}:${raw}`).digest('hex')
    const req = new Request('http://localhost/api/slack/events', { method: 'POST', body: raw, headers: { 'x-slack-signature': signature, 'x-slack-request-timestamp': stamp } })
    const response = await handleFabricWebhook(req, raw, options as any, p => waits.push(p)); await Promise.all(waits); return response
  }
  const posts = () => calls.filter(c => c.path === '/api/chat.postMessage').map(c => c.body.text as string)
  try { await body({ mention, calls, routes, options, posts }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('parser: defaults, sizes, durations, script, isolated, actions', () => {
  expect(parseVmCommand('fabric vm ubuntu-desktop')).toEqual({ verb: 'request', os: 'ubuntu-desktop' })
  expect(parseVmCommand('<@U1> fabric vm ubuntu-desktop small 2h script=dev-tools')).toEqual(
    { verb: 'request', os: 'ubuntu-desktop', size: 'small', hours: '2', script: 'dev-tools' })
  expect(parseVmCommand('fabric vm ubuntu-desktop large 15m isolated')).toEqual(
    { verb: 'request', os: 'ubuntu-desktop', size: 'large', hours: '0.25', network: 'isolated' })
  expect(parseVmCommand('fabric vm ubuntu-desktop huge')).toEqual({ verb: 'request', os: 'ubuntu-desktop', size: 'huge' })
  expect(parseVmCommand('fabric vm resume vl-0925-84770e 4h')).toEqual({ verb: 'resume', lease: 'vl-0925-84770e', hours: '4' })
  expect(parseVmCommand('fabric vm save vl-0925-84770e keep-1')).toEqual({ verb: 'save', lease: 'vl-0925-84770e', name: 'keep-1' })
  expect(parseVmCommand('fabric vm from keep-1 small')).toEqual({ verb: 'from', save: 'keep-1', size: 'small' })
  expect(parseVmCommand('fabric vm discard nope')?.verb).toBe('invalid')
  expect(parseVmCommand('fabric vm ubuntu-desktop $(rm -rf)')?.verb).toBe('invalid')
  expect(parseVmCommand('fabric vm')).toEqual({ verb: 'help' })
  expect(parseVmCommand('fabric run x')).toBeUndefined()
  expect(duration('90m')).toBe('1.5')
  expect(duration('8x')).toBeUndefined()
})

test('request posts typed fields with the Slack event id as requestId; new lease card comes from the outbox', () => fixture(async ({ mention, calls, posts }) => {
  expect((await mention('fabric vm ubuntu-desktop small 2h script=dev-tools'))?.status).toBe(200)
  const post = calls.find(c => c.path === '/v1/vms' && c.method === 'POST')
  expect(post.body).toEqual({ requestId: 'Ev1', threadTs: '1790309000.000100', teamId: 'T1', channelId: 'C1', userId: 'U1',
    action: 'request', os: 'ubuntu-desktop', size: 'small', hours: '2', script: 'dev-tools' })
  expect(posts()).toEqual([])
}))

test('refusal is shown with its code and nothing else happens', () => fixture(async ({ mention, routes, posts }) => {
  routes['/v1/vms'] = () => Response.json({ error: 'VM_SIZE_OVER_CAP' }, { status: 409 })
  await mention('fabric vm ubuntu-desktop huge')
  expect(posts()[0]).toContain('`VM_SIZE_OVER_CAP`')
  expect(posts()[0]).toContain('Nothing was created')
}))

test('replay (created=false) shows the current card; 5xx asks Slack to retry', () => fixture(async ({ mention, routes, posts }) => {
  routes['/v1/vms'] = () => Response.json({ ...lease(), created: false })
  await mention('fabric vm ubuntu-desktop')
  expect(posts()[0]).toContain('*Ready*')
  expect(posts()[0]).toContain('virtctl --context k vnc')
  routes['/v1/vms'] = () => Response.json({ error: 'VM_LEDGER_UNAVAILABLE' }, { status: 503 })
  expect((await mention('fabric vm ubuntu-desktop', 'U1', 'Ev2'))?.status).toBe(503)
}))

test('from <save> resolves the save OS from the listing; unknown save creates nothing', () => fixture(async ({ mention, routes, calls, posts }) => {
  routes['/v1/vms'] = (b) => b ? Response.json({ ...lease(), created: true }, { status: 202 })
    : Response.json({ leases: [], saves: [{ name: 'keep-1', lease: 'vl-0925-84770e', os: 'ubuntu-desktop', state: 'READY' }], readiness: {} })
  await mention('fabric vm from keep-1 small')
  const post = calls.find(c => c.path === '/v1/vms' && c.method === 'POST')
  expect(post.body).toMatchObject({ action: 'request', os: 'ubuntu-desktop', from: 'keep-1', size: 'small' })
  await mention('fabric vm from nope', 'U1', 'Ev3')
  expect(posts().at(-1)).toContain('No saved disk')
  expect(calls.filter(c => c.path === '/v1/vms' && c.method === 'POST').length).toBe(1)
}))

test('list renders leases, saves and the Ceph floor decision', () => fixture(async ({ mention, routes, posts }) => {
  routes['/v1/vms'] = () => Response.json({ leases: [lease({ state: 'STOPPED_KEPT', view: { ...lease().view, status: 'Stopped · disk kept' } })],
    saves: [{ name: 'keep-1', lease: 'vl-0925-84770e', os: 'ubuntu-desktop', state: 'READY' }],
    readiness: { cephBlockMaxAvailGiB: 1710, floorGiB: 500, decision: 'ADMIT' } })
  await mention('fabric vm list')
  expect(posts()[0]).toContain('Stopped · disk kept')
  expect(posts()[0]).toContain('`keep-1`')
  expect(posts()[0]).toContain('floor 500 GiB): ADMIT')
}))

test('non-allowlisted user is refused before intake', () => fixture(async ({ mention, calls }) => {
  expect((await mention('fabric vm ubuntu-desktop', 'INTRUDER'))?.status).toBe(403)
  expect(calls.filter(c => c.path.startsWith('/v1/')).length).toBe(0)
}))

test('outbox: post in the lease thread, then ack with the Slack ts; outside-allowlist channel stops the batch', () => fixture(async ({ routes, calls, options }) => {
  routes['/v1/vms/deliveries'] = () => Response.json({ deliveries: [{ id: 'vl-0925-84770e:01:ready', event: 'ready', lease: lease() }] })
  await drainVmDeliveries(options)
  const post = calls.find(c => c.path === '/api/chat.postMessage')
  expect(post.body.thread_ts).toBe('1.0')
  expect(post.body.text).toContain('virtctl --context k ssh')
  expect(calls.find(c => c.path === '/v1/vms/deliveries/ack').body).toEqual({ id: 'vl-0925-84770e:01:ready', receipt: '1790309200.000200' })
  routes['/v1/vms/deliveries'] = () => Response.json({ deliveries: [{ id: 'x:01:ready', event: 'ready', lease: lease({ channelId: 'C9' }) }] })
  await expect(drainVmDeliveries(options)).rejects.toThrow('fabric_vm_delivery_outside_allowlist')
}))

test('disabled lane is a quiet no-op for the poller', () => fixture(async ({ routes, options, calls }) => {
  routes['/v1/vms/deliveries'] = () => Response.json({ error: 'VM_LANE_DISABLED' }, { status: 503 })
  await drainVmDeliveries(options)
  expect(calls.filter(c => c.path === '/api/chat.postMessage').length).toBe(0)
}))

test('card: access lines only while held; save event names the save', () => {
  expect(vmCardText(lease({ state: 'STOPPED_KEPT', view: { ...lease().view, status: 'Stopped · disk kept', accessLines: [], actions: ['resume', 'save', 'discard'] } }), 'saved:keep-1'))
    .toContain('saved as `keep-1`')
  expect(vmCardText(lease())).toContain('`@centaur fabric vm save vl-0925-84770e <name>`')
})
