import { test, expect } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createMemoryState } from '@chat-adapter/state-memory'
import { createSlackbotV2 } from '../src/index'
import { parseWorkCatalog, parseWorkMenu, parseWorkSelection, selectedWorkUrl, workGroups, workMenuDigest,
  workMessage, workPickerView, workRecipeView, workRecipesView, type WorkCatalog, type WorkMenu, type WorkSelection } from '../src/fabric-work'
import type { ResumeBrief } from '../src/fabric-resume'

const url = 'https://plane.example.test/workspace/projects/project/issues/item/'
const originalUrl = 'https://plane.example.test/workspace/projects/project/work-items/item'
const content = 'A checked report.'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const ref = { runId: 'run1', requestId: 'request1', generation: 'a'.repeat(64), kind: 'report',
  sha256: hash(content), byteLength: Buffer.byteLength(content), mediaType: 'text/markdown' }
const menu = (): WorkMenu => ({ capturedAt: 1790000000, stale: false, projects: [{ name: 'Research <@OTHER>', limited: true,
  items: [{ name: 'Existing item & context', identifier: 'PRJ-1', url }] }] })
const brief = (planeUrl = url): ResumeBrief => ({ schemaVersion: 1, observedAt: 1790000000, planeUrl, title: 'Existing <@OTHER> work',
  objective: { sourceRunId: 'run1', updatedAt: null, basis: 'Retained context.' },
  scope: { complete: true, attemptCount: 1, identity: 'exact-plane-url-and-channel' },
  summary: 'One accepted result.', latestRunId: 'run1', acceptedRunIds: ['run1'], attempts: [{
    runId: 'run1', requestId: 'request1', generation: 'a'.repeat(64), created: 1790000000, state: 'COMPLETED',
    recipe: { id: 'research-packet', title: 'Research', profile: 'focused' }, status: 'ACCEPTED', label: 'Checked result available',
    taskOutcome: 'COMPLETED', closure: { authorityClosed: true, disposalVerified: true, label: 'Access and resources closed.' },
    checker: { accepted: true, reason: 'Verified against sources.' }, archiveSha256: 'b'.repeat(64), evidence: [ref as any] }],
  research: { status: 'ACCEPTED', code: 'ACCEPTED', message: 'Latest research accepted.' },
  continuation: { enabled: false, code: 'FRESH_AUTHORITY_REQUIRED', message: 'Fresh authorized packet and compatible capacity required.', serviceWindowOpen: false },
  limits: ['Exact URL and channel only.'] })
const catalog = (): WorkCatalog => ({ launchEnabled: false, scope: 'Read-only recipe catalog; admission and capacity are not verified.', recipes: [{
  id: 'cuda-smoke', version: '1.0.0', digest: 'c'.repeat(64), title: 'Fixed CUDA <@OTHER>', description: 'One bounded computation.',
  aliases: ['cuda'], taskType: 'retained-evidence-review', defaultProfile: 'focused', adapter: 'cuda-smoke-v1', requiresCheckedResearch: true,
  roles: ['Coordinator', 'Worker', 'Checker'], profiles: { focused: { title: 'Focused', description: 'One fixed check.', maxCalls: { coordinator: 4, worker: 8, checker: 6 } } } }] })
const valueFor = (s: WorkSelection) => JSON.stringify(s)
const buttons = (view: any): any[] => view.blocks.flatMap((b: any) => b.elements ?? []).filter((b: any) => b.type === 'button')
const button = (view: any, text: string) => {
  const result = buttons(view).find(b => b.text.text === text)
  if (!result) throw new Error('missing button: ' + text)
  return result
}
const event = (text = 'fabric work') => ({ type: 'event_callback', team_id: 'T1', event_id: 'E1',
  event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1790000000.000001', text: '<@BOT> ' + text } })
const action = (b: any, inView = true) => ({ type: 'block_actions', team: { id: 'T1' }, user: { id: 'U1' },
  ...(inView ? { view: { id: 'V1', hash: 'hash' } } : { channel: { id: 'C1' }, message: { ts: '1790000000.000001' } }),
  trigger_id: 'trigger', actions: [{ action_id: b.action_id, value: b.value }] })
const submission = (view: any, selected = '', pasted = '') => ({ type: 'view_submission', team: { id: 'T1' }, user: { id: 'U1' },
  view: { id: 'V1', callback_id: view.callback_id, private_metadata: view.private_metadata,
    state: { values: { work: { item: { selected_option: selected ? { value: selected } : null } }, plane: { url: { value: pasted } } } } } })

type Settings = { menu: unknown; brief: (url: string) => unknown; catalog: unknown; failPath?: string; failStatus?: number }
async function fixture(work: (send: (p: any, signed?: boolean) => Promise<Response>, calls: any[], settings: Settings) => Promise<void>) {
  const dir = mkdtempSync(tmpdir() + '/fabric-work-')
  writeFileSync(dir + '/token', 'test-service-identity')
  const calls: any[] = [], settings: Settings = { menu: menu(), brief, catalog: catalog() }
  const bot = createSlackbotV2({ apiUrl: '', botToken: 'test', signingSecret: 'test', fabricIntakeUrl: 'http://intake', fabricTokenPath: dir + '/token',
    launcherAllowedTeamIds: ['T1', 'T2'], launcherAllowedChannelIds: ['C1', 'C2'], launcherAllowedUserIds: ['U1', 'U2'],
    state: createMemoryState(), recoverRenderObligationsOnStart: false,
    fetch: (async (input: any, init: any) => {
      const u = new URL(String(input)), body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method, body })
      if (settings.failPath === u.pathname) return Response.json({ error: 'UNAVAILABLE' }, { status: settings.failStatus ?? 503 })
      if (u.pathname === '/v1/work-items') return Response.json(settings.menu)
      if (u.pathname === '/v1/resume-brief') return Response.json(settings.brief(u.searchParams.get('planeUrl')!))
      if (u.pathname === '/v1/recipe-catalog') return Response.json(settings.catalog)
      if (u.pathname === '/v1/resume-artifact') return Response.json({ reference: ref, content, accepted: true, basis: 'Exact bytes verified.' })
      if (['/api/chat.postMessage', '/api/views.open', '/api/views.update'].includes(u.pathname)) return Response.json({ ok: true, ts: '2', view: { id: 'V1' } })
      throw new Error('unexpected side effect or route ' + u.pathname)
    }) as typeof fetch })
  const send = async (payload: any, signed = true) => {
    const raw = payload.type === 'event_callback' ? JSON.stringify(payload) : new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
    const stamp = String(Math.floor(Date.now() / 1000))
    const signature = 'v0=' + createHmac('sha256', 'test').update(`v0:${stamp}:${raw}`).digest('hex')
    const response = await bot.app.request(new Request('http://localhost' + (payload.type === 'event_callback' ? '/api/slack/events' : '/api/webhooks/slack/actions'),
      { method: 'POST', body: raw, headers: signed ? { 'x-slack-signature': signature, 'x-slack-request-timestamp': stamp } : {} }))
    await Promise.resolve()
    return response
  }
  try { await work(send, calls, settings) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const lastView = (calls: any[]) => calls.filter(c => c.path.endsWith('views.open') || c.path.endsWith('views.update')).at(-1)?.body.view
async function openPicker(send: (p: any) => Promise<Response>, calls: any[]) {
  expect((await send(event())).status).toBe(200)
  const message = calls.find(c => c.path.endsWith('chat.postMessage')).body
  expect((await send(action(button(message, 'Choose work'), false))).status).toBe(200)
  return lastView(calls)
}

test('work-first signed route joins picker, exact history, report and recipe preview with only fabric GETs', () => fixture(async (send, calls) => {
  const picker = await openPicker(send, calls)
  expect(picker.submit.text).toBe('View work')
  const selected = picker.blocks.find((b: any) => b.block_id === 'work').element.option_groups[0].options[0].value
  const response = await send(submission(picker, selected))
  const overview = (await response.json()).view
  expect(JSON.stringify(overview)).toContain('Accepted results: Research')
  expect(JSON.stringify(overview)).toContain('not a fresh Plane read')
  await send(action(button(overview, 'History and results')))
  await send(action(button(lastView(calls), 'Read checked report')))
  expect(JSON.stringify(lastView(calls))).toContain(content)
  await send(action(button(lastView(calls), 'Back to history')))
  await send(action(button(lastView(calls), 'Work overview')))
  await send(action(button(lastView(calls), 'Browse recipes')))
  expect(JSON.stringify(lastView(calls))).toContain('service window is closed')
  await send(action(button(lastView(calls), 'Inspect recipe')))
  const preview = lastView(calls)
  expect(JSON.stringify(preview)).toContain('Requires accepted research')
  expect(JSON.stringify(preview)).toContain('Current resource readiness and capacity are not verified')
  expect(JSON.stringify(preview)).toContain('worker 8')
  expect(preview.submit).toBeUndefined()
  expect(buttons(preview).map(b => b.text.text)).toEqual(['Back to recipes', 'Work overview'])
  await send(action(button(preview, 'Work overview')))
  await send(action(button(lastView(calls), 'Choose another item')))
  expect(lastView(calls).callback_id).toBe('fabric_work_submit')
  const reads = calls.filter(c => c.path.startsWith('/v1/'))
  expect(reads.every(c => c.method === 'GET')).toBe(true)
  expect(reads.every(c => ['/v1/work-items', '/v1/resume-brief', '/v1/resume-artifact', '/v1/recipe-catalog'].includes(c.path))).toBe(true)
  expect(reads.filter(c => c.query.planeUrl).every(c => c.query.planeUrl === url)).toBe(true)
  expect(reads.filter(c => c.path === '/v1/recipe-catalog').every(c => !c.query.planeUrl)).toBe(true)
  expect(JSON.stringify(calls)).not.toContain('/v1/runs')
}))

test('picker rechecks current cache and rejects changed, stale, disappeared or injected choices', () => fixture(async (send, calls, settings) => {
  const picker = await openPicker(send, calls), selected = workGroups(menu())[0]!.options[0]!.value
  const changed = menu(); changed.projects[0]!.items[0]!.name = 'Updated name'; settings.menu = changed
  expect(await (await send(submission(picker, selected))).json()).toMatchObject({ response_action: 'errors' })
  settings.menu = { ...menu(), stale: true }
  expect(await (await send(submission(picker, selected))).json()).toMatchObject({ response_action: 'errors' })
  settings.menu = { ...menu(), projects: [] }
  expect(await (await send(submission(picker, selected))).json()).toMatchObject({ response_action: 'errors' })
  settings.menu = menu()
  expect(await (await send(submission(picker, hash('not-in-menu')))).json()).toMatchObject({ response_action: 'errors' })
  expect(calls.filter(c => c.path === '/v1/resume-brief')).toHaveLength(0)
  settings.menu = { ...menu(), capturedAt: 1790000010 }
  expect(await (await send(submission(picker, selected))).json()).toMatchObject({ response_action: 'update' })
}))

test('empty/stale/unavailable menus retain exact-link access, no aliases are normalized', () => fixture(async (send, calls, settings) => {
  settings.menu = { projects: [], capturedAt: null, stale: true }
  const picker = await openPicker(send, calls)
  expect(JSON.stringify(picker)).toContain('No recent work items')
  expect(picker.blocks.some((b: any) => b.block_id === 'work')).toBe(false)
  expect(await (await send(submission(picker, '', originalUrl))).json()).toMatchObject({ response_action: 'update' })
  expect(calls.find(c => c.path === '/v1/resume-brief').query.planeUrl).toBe(originalUrl)
  settings.failPath = '/v1/work-items'
  await send(action(button(picker, 'Refresh list')))
  expect(JSON.stringify(lastView(calls))).toContain('unavailable or stale')
  expect(await (await send(submission(lastView(calls), '', url))).json()).toMatchObject({ response_action: 'update' })
}))

test('signature and sealed actor, team, channel and action-kind binding precede every read', () => fixture(async (send, calls) => {
  const picker = await openPicker(send, calls)
  const b = button(picker, 'Refresh list'), before = calls.length
  for (const p of [
    { ...action(b), user: { id: 'U2' } }, { ...action(b), team: { id: 'T2' } },
    { ...action(b, false), channel: { id: 'C2' } },
    action({ ...b, value: b.value.replace('pick', 'overview') }),
    action({ ...b, action_id: 'fabric_work_overview' }),
    { ...submission(picker, '', url), user: { id: 'U2' } },
    { ...submission(picker, '', url), channel: { id: 'C2' } }
  ]) expect((await send(p)).status).toBe(403)
  expect((await send(action(b), false)).status).toBe(401)
  expect(calls.length).toBe(before)
}))

test('bad/ambiguous input and untrusted backend shapes cannot become a run or fabricated history', () => fixture(async (send, calls, settings) => {
  const picker = await openPicker(send, calls)
  for (const [selected, pasted] of [['', ''], [workGroups(menu())[0]!.options[0]!.value, url], ['', url + '?x=1'], ['', 'http://plane.example.test/item']]) {
    expect(await (await send(submission(picker, selected, pasted))).json()).toMatchObject({ response_action: 'errors' })
  }
  expect(calls.filter(c => c.path === '/v1/resume-brief')).toHaveLength(0)
  settings.brief = () => ({ ...brief(), planeUrl: 'https://wrong.example.test/item' })
  expect(await (await send(submission(picker, '', url))).json()).toMatchObject({ response_action: 'errors' })
  settings.brief = brief
  settings.failPath = '/v1/resume-brief'; settings.failStatus = 403
  expect(await (await send(submission(picker, '', url))).json()).toMatchObject({ response_action: 'errors' })
  expect(calls.every(c => c.method !== 'POST' || c.path.startsWith('/api/'))).toBe(true)
}))

test('fresh recipe digest and prerequisite state are rechecked, catalog errors stay read-only', () => fixture(async (send, calls, settings) => {
  const picker = await openPicker(send, calls)
  const overview = (await (await send(submission(picker, '', url))).json()).view
  await send(action(button(overview, 'Browse recipes')))
  const inspect = button(lastView(calls), 'Inspect recipe')
  const changed = catalog(); changed.recipes[0]!.digest = 'd'.repeat(64); settings.catalog = changed
  await send(action(inspect)); expect(JSON.stringify(lastView(calls))).toContain('recipe changed')
  expect(JSON.stringify(lastView(calls))).not.toContain('Call limits')
  settings.catalog = catalog(); settings.brief = u => ({ ...brief(u), research: { status: 'BLOCKED', code: 'REJECTED', message: 'Latest research rejected.' } })
  await send(action(inspect)); expect(JSON.stringify(lastView(calls))).toContain('Latest research rejected')
  settings.failPath = '/v1/recipe-catalog'
  await send(action(inspect)); expect(lastView(calls).title.text).toBe('Work unavailable')
  expect(buttons(lastView(calls)).map(b => b.text.text)).toContain('Try overview again')
  expect(calls.filter(c => c.path.startsWith('/v1/')).every(c => c.method === 'GET')).toBe(true)
}))

test('picker hash options fit Slack even for long exact URLs and bounded notices are explicit', () => {
  const m = menu(); m.projects = Array.from({ length: 12 }, (_, p) => ({ name: '😀'.repeat(60), limited: true,
    items: Array.from({ length: 40 }, (_, i) => ({ name: 'x'.repeat(150), identifier: `${p}-${i}`, url: url + `${p}-${i}-` + 'x'.repeat(200) })) }))
  parseWorkMenu(m)
  const v = workPickerView(m, 'metadata', valueFor), groups = workGroups(m)
  expect(groups).toHaveLength(10); expect(groups[0]!.options).toHaveLength(30)
  expect(groups.flatMap(g => g.options).every(o => o.value.length === 64 && o.text.text.length <= 75)).toBe(true)
  expect(JSON.stringify(v)).toContain('limited list')
  expect(selectedWorkUrl(m, groups[0]!.options[0]!.value)).toBe(m.projects[0]!.items[0]!.url)
  expect(selectedWorkUrl(m, hash(m.projects[11]!.items[0]!.url))).toBeUndefined()
  expect(workMenuDigest(m)).not.toEqual(workMenuDigest(menu()))
})

test('catalog pagination covers all fifty recipes and previews never advertise eligibility', () => {
  const c = catalog(), base = c.recipes[0]!
  c.recipes = Array.from({ length: 50 }, (_, i) => ({ ...base, id: `recipe-${i}`, title: `Recipe ${i}` }))
  parseWorkCatalog(c)
  const ids: string[] = []
  for (let page = 0; page < 9; page++) {
    const v = workRecipesView(c, brief(), page, valueFor)
    expect(v.blocks.length).toBeLessThan(20)
    for (const b of buttons(v).filter(b => b.action_id === 'fabric_work_recipe')) ids.push(JSON.parse(b.value).recipeId)
    expect(v).not.toHaveProperty('submit')
  }
  expect(new Set(ids).size).toBe(50)
  const selection = { kind: 'recipe' as const, planeUrl: url, page: 0, recipeId: base.id, digest: base.digest }
  const view = workRecipeView(base, brief(), selection, valueFor)
  expect(JSON.stringify(view)).not.toContain('runs available')
  expect(buttons(view).some(b => /^(Start|Retry)$/.test(b.text.text))).toBe(false)
  expect(view.blocks.filter((b: any) => b.type === 'section').every((b: any) => b.text.type === 'plain_text')).toBe(true)
  expect(workMessage(valueFor).text.length).toBeGreaterThan(40)
})

test('strict menu/catalog/action parsers reject malformed identities and control limits', () => {
  for (const m of [null, { ...menu(), stale: 'false' }, { ...menu(), capturedAt: NaN }, { ...menu(), projects: [menu().projects[0], menu().projects[0]] }]) {
    expect(() => parseWorkMenu(m)).toThrow()
  }
  const bad = catalog(); bad.recipes[0]!.profiles.focused!.maxCalls.worker = NaN
  for (const c of [null, { ...catalog(), launchEnabled: true }, bad, { ...catalog(), recipes: [catalog().recipes[0], catalog().recipes[0]] }]) {
    expect(() => parseWorkCatalog(c)).toThrow()
  }
  for (const s of [{ kind: 'start' }, { kind: 'recipes', planeUrl: url, page: -1 }, { kind: 'recipe', planeUrl: url, page: 0, recipeId: 'r', digest: 'bad' }]) {
    expect(() => parseWorkSelection(s)).toThrow()
  }
})
