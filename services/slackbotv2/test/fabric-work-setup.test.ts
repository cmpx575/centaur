import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createMemoryState } from '@chat-adapter/state-memory'
import { createSlackbotV2 } from '../src/index'
import { drainFabricDeliveries, runView, type Run } from '../src/fabric'
import { recipeView, recipeRequest, type Recipe } from '../src/fabric-recipes'
import { recipeSetups, resolveSetup, setupChoiceFor, setupOptionValue, setupRef, workSetupBlocks, type WorkSetup } from '../src/fabric-work-setup'
import { parseWorkCatalog } from '../src/fabric-work'

const human: WorkSetup = { id: 'humanlayer-staged', version: '1.0.0', digest: 'a'.repeat(64), title: 'HumanLayer-inspired staged work',
  description: 'Our adaptation of planning, review and implementation. No HumanLayer product is installed.', status: 'qualified',
  method: 'Plan, review, implement and independently check', stages: ['Read context', 'Plan', 'Review plan', 'Implement', 'Check'],
  skills: ['Context review', 'One-file repair'], tools: ['Read inputs', 'Submit plan', 'Submit source'],
  mcpServers: [], runtime: 'Hermes on isolated Linux', limitations: ['One bounded repair; fresh compatible capacity and authority required.'] }
const bounded: WorkSetup = { ...human, id: 'bounded-repair', digest: 'b'.repeat(64), title: 'Bounded repair',
  description: 'The existing implement and check process.', method: 'Implement and check', stages: ['Read inputs', 'Implement', 'Check'], tools: ['Read inputs', 'Submit source'] }
const url = 'https://plane.example.test/workspace/projects/project/issues/item/'
const recipe = (): Recipe => ({ id: 'software-repair', version: '1.1.0', digest: 'c'.repeat(64), title: 'Repair software', description: 'One fixed file.',
  aliases: ['software'], taskType: 'bounded-software-repair', defaultProfile: 'focused', roles: ['Coordinator', 'Worker', 'Checker'],
  profiles: { focused: { title: 'Focused', description: 'Fixed scope.', maxCalls: { coordinator: 4, worker: 8, checker: 6 } },
    full: { title: 'Full', description: 'Same bounded work.', maxCalls: { coordinator: 4, worker: 8, checker: 6 } } },
  defaultWorkSetup: setupRef(human), workSetups: [structuredClone(human), structuredClone(bounded)] })
const menu = { projects: [{ name: 'Project', items: [{ name: 'Our work', identifier: 'PRJ-1', url }] }], stale: false }
const origin = { teamId: 'T1', channelId: 'C1', userId: 'U1', threadTs: '1790000000.000001' }
const opening = { type: 'block_actions', team: { id: 'T1' }, user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts: origin.threadTs },
  trigger_id: 'trigger', actions: [{ action_id: 'fabric_recipe_open', value: 'software-repair' }] }
const values = () => ({ plane: { url: { value: '' } }, work: { item: { selected_option: { value: url } } },
  profile: { choice: { selected_option: { value: 'full' } } } })
const submission = (view: any, state: any = values()) => ({ type: 'view_submission', team: { id: 'T1' }, user: { id: 'U1' },
  view: { ...view, id: 'V1', state: { values: state } } })
const change = (view: any) => ({ ...opening, channel: undefined, view: { ...view, id: 'V1', hash: 'hash', state: { values: values() } },
  actions: [{ action_id: 'fabric_recipe_setup_change', value: 'change' }] })
const lastView = (calls: any[]) => calls.filter(c => /views\.(open|update)$/.test(c.path)).at(-1)?.body.view

async function fixture(work: (send: (payload: any, signed?: boolean) => Promise<Response>, calls: any[], current: Recipe[], options: any) => Promise<void>) {
  const directory = mkdtempSync(tmpdir() + '/fabric-setup-'); writeFileSync(directory + '/token', 'synthetic-service-identity')
  const calls: any[] = [], current = [recipe()]
  const options = { apiUrl: '', botToken: 'synthetic', signingSecret: 'synthetic', fabricIntakeUrl: 'http://intake', fabricTokenPath: directory + '/token',
    launcherAllowedTeamIds: ['T1', 'T2'], launcherAllowedChannelIds: ['C1', 'C2'], launcherAllowedUserIds: ['U1', 'U2'],
    state: createMemoryState(), recoverRenderObligationsOnStart: false,
    fetch: (async (input: any, init: any) => {
      const u = new URL(String(input)), body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method, body })
      if (u.pathname === '/v1/recipes') return Response.json({ recipes: current })
      if (u.pathname === '/v1/recipe-catalog') return Response.json({ recipes: current, launchEnabled: false, scope: 'Read-only catalog; admission and capacity are not verified.' })
      if (u.pathname === '/v1/work-items') return Response.json(menu)
      if (u.pathname === '/v1/runs' && init.method === 'POST') return Response.json({ created: true }, { status: 202 })
      if (['/api/chat.postMessage', '/api/views.open', '/api/views.update'].includes(u.pathname)) return Response.json({ ok: true, ts: '2', view: { id: 'V1' } })
      throw new Error('unexpected request ' + u.pathname)
    }) as typeof fetch }
  const bot = createSlackbotV2(options)
  const send = async (payload: any, signed = true) => {
    const raw = payload.type === 'event_callback' ? JSON.stringify(payload) : new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
    const stamp = String(Math.floor(Date.now() / 1000)), signature = 'v0=' + createHmac('sha256', 'synthetic').update(`v0:${stamp}:${raw}`).digest('hex')
    return bot.app.request(new Request('http://localhost' + (payload.type === 'event_callback' ? '/api/slack/events' : '/api/webhooks/slack/actions'),
      { method: 'POST', body: raw, headers: signed ? { 'x-slack-signature': signature, 'x-slack-request-timestamp': stamp } : {} }))
  }
  try { await work(send, calls, current, options) } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('software launch shows the full default and submits its exact tuple', () => fixture(async (send, calls) => {
  expect((await send(opening)).status).toBe(200)
  const view = lastView(calls), text = JSON.stringify(view)
  for (const word of ['HumanLayer-inspired staged work', 'Method:', 'Stages:', 'Skills:', 'Tools:', 'MCP servers: None declared', 'Runtime:', 'Change setup', 'No HumanLayer product']) expect(text).toContain(word)
  expect(text).not.toContain('workSetupDigest')
  expect(view.private_metadata.length).toBeLessThan(3000)
  expect((await send(submission(view))).status).toBe(200)
  const request = calls.find(c => c.path === '/v1/runs').body
  expect(request).toMatchObject({ workSetupId: human.id, workSetupVersion: human.version, workSetupDigest: human.digest, planeUrl: url, profile: 'full' })
  expect(Object.values(request).every(v => typeof v === 'string')).toBe(true)
  await send(submission(view)); expect(calls.filter(c => c.path === '/v1/runs')[1].body).toEqual(request)
}))

test('searchable Change setup is read-only and preserves item/profile into exact selected preview and Start', () => fixture(async (send, calls) => {
  await send(opening); await send(change(lastView(calls)))
  const picker = lastView(calls), select = picker.blocks.find((b: any) => b.block_id === 'work_setup')
  expect(picker.submit.text).toBe('Use setup'); expect(select.element.type).toBe('static_select')
  expect(select.element.placeholder.text).toBe('Search work setups')
  expect(select.element.options.map((o: any) => o.value)).toEqual([setupOptionValue(human), setupOptionValue(bounded)])
  const selected = { ...values(), work_setup: { choice: { selected_option: { value: setupOptionValue(bounded) } } } }
  const response = await send(submission(picker, selected)), result = await response.json()
  expect(result.response_action).toBe('update'); const preview = result.view
  expect(preview.submit.text).toBe('Start'); expect(JSON.stringify(preview.blocks)).toContain('Work setup: Bounded repair')
  expect(preview.blocks.find((b: any) => b.block_id === 'work').element.initial_option.value).toBe(url)
  expect(preview.blocks.find((b: any) => b.block_id === 'profile').element.initial_option.value).toBe('full')
  expect(calls.filter(c => c.path.startsWith('/v1/')).every(c => c.method === 'GET')).toBe(true)
  await send(submission(preview))
  expect(calls.filter(c => c.path === '/v1/runs')).toHaveLength(1)
  expect(calls.find(c => c.path === '/v1/runs').body).toMatchObject({ workSetupId: bounded.id, workSetupVersion: bounded.version, workSetupDigest: bounded.digest, planeUrl: url, profile: 'full' })
}))

test('setup picker rejects changed catalogs, invented options and unsupported candidates without starting', () => fixture(async (send, calls, current) => {
  await send(opening); await send(change(lastView(calls))); const picker = lastView(calls)
  const select = (value: string) => submission(picker, { ...values(), work_setup: { choice: { selected_option: { value } } } })
  expect(await (await send(select('invented'))).json()).toMatchObject({ response_action: 'errors' })
  current[0]!.workSetups![1]!.status = 'research-only'
  expect(await (await send(select(setupOptionValue(bounded)))).json()).toMatchObject({ response_action: 'errors' })
  expect(calls.filter(c => c.path === '/v1/runs')).toHaveLength(0)
  expect(recipeView(current[0]!, 'synthetic', menu, { ...setupChoiceFor(current[0]!)!, editing: true }).blocks
    .find((b: any) => b.block_id === 'work_setup')).toMatchObject({ element: { options: [expect.objectContaining({ value: setupOptionValue(human) })] } })
}))

test('stale selected setup or recipe refuses at Start with no silent default', () => fixture(async (send, calls, current) => {
  await send(opening); const view = lastView(calls)
  current[0]!.workSetups![0]!.digest = 'd'.repeat(64); current[0]!.defaultWorkSetup = setupRef(current[0]!.workSetups![0]!)
  expect(await (await send(submission(view))).json()).toMatchObject({ response_action: 'errors', errors: { profile: expect.stringContaining('changed') } })
  expect(calls.filter(c => c.path === '/v1/runs')).toHaveLength(0)
}))

test('signed setup interactions bind user, team, channel and sealed selection', () => fixture(async (send, calls) => {
  await send(opening); const view = lastView(calls), request = change(view)
  expect((await send(request, false)).status).toBe(401)
  expect((await send({ ...request, user: { id: 'U2' } })).status).toBe(403)
  expect((await send({ ...request, team: { id: 'T2' } })).status).toBe(403)
  expect((await send({ ...request, channel: { id: 'C2' } })).status).toBe(403)
  expect((await send({ ...request, view: { ...request.view, private_metadata: view.private_metadata.replace('humanlayer-staged', 'bounded-repair') } })).status).toBe(403)
  expect(calls.filter(c => c.path === '/v1/runs')).toHaveLength(0)
}))

test('explicit named software request uses the current workflow default and keeps stable replay identity', () => fixture(async (send, calls) => {
  const event = { type: 'event_callback', team_id: 'T1', event_id: 'E1', event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: origin.threadTs, text: 'fabric run software focused ' + url } }
  await send(event); await send(event)
  const requests = calls.filter(c => c.path === '/v1/runs')
  expect(requests).toHaveLength(2); expect(requests[0].body).toEqual(requests[1].body)
  expect(requests[0].body.workSetupId).toBe(human.id)
}))

test('strict setup parsing rejects partial or duplicate catalogs and preserves ordinary recipes', () => {
  const r = recipe()
  expect(() => recipeSetups({ defaultWorkSetup: r.defaultWorkSetup })).toThrow()
  expect(() => recipeSetups({ ...r, workSetups: [{ ...human, mcpServers: undefined } as any] })).toThrow()
  expect(() => recipeSetups({ ...r, workSetups: [human, human] })).toThrow()
  expect(() => resolveSetup(r, { ...setupRef(human), version: 'changed' })).toThrow()
  expect(() => parseWorkCatalog({ recipes: [{ ...r, workSetups: [{ ...human, tools: [null] }] }], launchEnabled: false, scope: 'Read only.' })).toThrow()
  const { workSetups, defaultWorkSetup, ...ordinary } = r
  expect(recipeSetups(ordinary as Recipe)).toBeUndefined()
  expect(recipeRequest(ordinary, 'focused', url, origin, 'E1')).not.toHaveProperty('workSetupId')
  expect(recipeView(ordinary, 'synthetic').blocks.some((b: any) => b.elements?.some((e: any) => e.text?.text === 'Change setup'))).toBe(false)
})

test('setup text stays inert and full bounded tools/runtime remain visible in valid sized blocks', () => {
  const s = { ...human, title: '<@U1> & setup', tools: Array.from({ length: 20 }, (_, i) => `${i}:` + 'x'.repeat(190)), runtime: 'LAST_RUNTIME' }
  const blocks = workSetupBlocks(s)
  expect(blocks.every(b => b.text.type === 'plain_text' && b.text.text.length <= 2900)).toBe(true)
  expect(blocks.map(b => b.text.text).join('\n')).toContain(s.tools[19]!)
  expect(blocks.map(b => b.text.text).join('\n')).toContain('LAST_RUNTIME')
  expect(workSetupBlocks({ ...human, tools: ['delegate_review', 'submit_verdict'] }).map(b => b.text.text).join('\n'))
    .toContain('Tools: Delegate work · Record independent verdict')
})

test('durable final delivery and run details display the actual frozen setup and acknowledge only sent result', () => fixture(async (_send, calls, _current, options) => {
  const run: Run = { ...origin, requestId: 'request-1', runId: 'run-1', state: 'COMPLETED', planeUrl: url,
    view: { title: 'Our work', status: 'Ready to review', nextAction: 'Inspect the checked result.', closure: 'Access closed.', checked: true, closed: true },
    recipe: { title: 'Repair software', version: '1.1.0', profileTitle: 'Focused', planDigest: 'c'.repeat(64), roles: ['Coordinator', 'Worker', 'Checker'], workSetup: bounded },
    result: { report: 'A checked result.', checker: { reason: 'Exact output verified.' } } }
  const original = options.fetch
  options.fetch = async (input: any, init: any) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/deliveries') return Response.json({ deliveries: [{ id: 'delivery-1', run }] })
    if (path === '/v1/deliveries/ack') { calls.push({ path, body: JSON.parse(init.body) }); return Response.json({ ok: true }) }
    return original(input, init)
  }
  await drainFabricDeliveries(options)
  const posted = calls.find(c => c.path.endsWith('chat.postMessage')).body
  expect(posted.text).toContain('Work setup: Bounded repair')
  expect(JSON.stringify(posted.blocks)).toContain('Implement and check')
  expect(JSON.stringify(runView(run))).toContain('Tools: Read inputs · Submit source')
  expect(calls.at(-1).path).toBe('/v1/deliveries/ack')
  expect(posted.blocks.length).toBeLessThanOrEqual(50)
}))


test('repeated signed Start reaches the immutable run after a committed response is lost and capacity disappears', () => fixture(async (send, calls, _current, options) => {
  await send(opening); const view = lastView(calls), original = options.fetch
  let committed: Record<string, string> | undefined, commits = 0, posts = 0
  options.fetch = async (input: any, init: any) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/recipes' && committed) return Response.json({ recipes: [] })
    if (path === '/v1/runs' && init.method === 'POST') {
      const request = JSON.parse(init.body); posts++
      if (!committed) { committed = request; commits++; return Response.json({ error: 'response_lost_after_commit' }, { status: 503 }) }
      expect(request).toEqual(committed)
      return Response.json({ created: false, requestId: request.requestId, runId: 'the-only-run' })
    }
    return original(input, init)
  }
  expect((await send(submission(view))).status).toBe(503)
  // The ordinary launch menu now has no capacity; catalog identity remains readable.
  expect(await (await options.fetch('http://intake/v1/recipes', { method: 'GET' })).json()).toEqual({ recipes: [] })
  expect(await (await send(submission(view))).json()).toEqual({ response_action: 'clear' })
  expect(commits).toBe(1); expect(posts).toBe(2)
  expect(calls.filter(c => c.path === '/v1/recipe-catalog')).toHaveLength(2)
}))
