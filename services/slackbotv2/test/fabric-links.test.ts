import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { handleFabricWebhook } from '../src/fabric'
import { githubRepoUrl } from '../src/fabric-links'
import type { SlackbotV2Options } from '../src/types'

const url = 'https://github.com/example/repository'
const recipe = { id: 'repo-fit', version: '1', digest: 'a'.repeat(64), taskType: 'retained-evidence-review',
  defaultProfile: 'focused', profiles: { focused: {} } }
const latest = { runId: 'run-1', recipeId: 'repo-fit', sourceUrl: url, finished: true }
async function fixture(work: (send: (text: string, thread?: boolean, signed?: boolean) => Promise<Response | undefined>, calls: any[]) => Promise<void>,
  config: { latest?: any; failure?: number; options?: Partial<SlackbotV2Options> } = {}) {
  const dir = mkdtempSync(tmpdir() + '/fabric-links-')
  writeFileSync(dir + '/token', 'test-identity')
  const calls: any[] = []
  const options: SlackbotV2Options = { apiUrl: '', botToken: 'test', signingSecret: 'test', fabricIntakeUrl: 'http://intake',
    fabricTokenPath: dir + '/token', launcherAllowedTeamIds: ['T1'], launcherAllowedChannelIds: ['C1'], launcherAllowedUserIds: ['U1'],
    fetch: (async (input: any, init: any) => {
      const parsed = new URL(String(input)), body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ path: parsed.pathname, query: parsed.searchParams, body })
      if (parsed.pathname === '/v1/thread') return Response.json({ latest: config.latest })
      if (parsed.pathname === '/v1/recipes') return Response.json({ recipes: [recipe] })
      if (parsed.pathname === '/v1/runs') return config.failure ? Response.json({ error: 'REFUSED\nreason' }, { status: config.failure }) : Response.json({ created: true })
      if (parsed.pathname === '/api/chat.postMessage') return Response.json({ ok: true, ts: '2' })
      throw new Error('unexpected transport ' + parsed.pathname)
    }) as typeof fetch, ...config.options }
  const send = async (text: string, thread = false, signed = true) => {
    const raw = JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: 'E1', event: {
      type: 'app_mention', user: 'U1', channel: 'C1', ts: '1789846137.000002',
      ...(thread ? { thread_ts: '1789846137.000001' } : {}), text: '<@UBOT> ' + text } })
    const stamp = String(Math.floor(Date.now() / 1000))
    const signature = 'v0=' + createHmac('sha256', 'test').update(`v0:${stamp}:${raw}`).digest('hex')
    const pending: Promise<unknown>[] = []
    const response = await handleFabricWebhook(new Request('http://localhost', { headers: signed ? {
      'x-slack-signature': signature, 'x-slack-request-timestamp': stamp } : {} }), raw, options, p => pending.push(p))
    await Promise.all(pending)
    return response
  }
  try { await work(send, calls) } finally { rmSync(dir, { recursive: true, force: true }) }
}

for (const text of [url, url + '/', `<${url}>`, `<${url}/|repository>`]) {
  test('repo URL form ' + text, () => expect(githubRepoUrl(text)).toBe(url))
}
for (const text of [url + ' ' + url, url + '/issues', url + '?x=1', url + '#readme']) {
  test('invalid URL falls through ' + text, async () => fixture(async (send, calls) => {
    expect(await send(text, true)).toBeUndefined(); expect(calls).toHaveLength(0)
  }, { latest }))
}
test('launch pins, origin, reading before launch and deterministic replay', async () => fixture(async (send, calls) => {
  expect((await send(`<${url}|repo>`))?.status).toBe(200)
  const run = calls.find(c => c.path === '/v1/runs').body
  expect(run).toMatchObject({ teamId: 'T1', channelId: 'C1', userId: 'U1', threadTs: '1789846137.000002',
    recipeId: 'repo-fit', recipeVersion: '1', recipeDigest: recipe.digest, profile: 'focused', sourceUrl: url, source: 'person' })
  expect(run.planeUrl).toBeUndefined(); expect(run.parentRunId).toBeUndefined()
  expect(run.requestId).toMatch(/^recipe-[a-f0-9]{24}$/)
  expect(calls[0].body.text).toBe('Read as: a public GitHub repository, example/repository. Starting a fit review; the card comes back in this thread. Reply here (mention me) to correct it.')
  await send(url)
  expect(calls.filter(c => c.path === '/v1/runs')[1].body).toEqual(run)
}))
for (const options of [{ launcherAllowedTeamIds: [] }, { launcherAllowedChannelIds: ['C2'] }, { launcherAllowedUserIds: undefined }]) {
  test('allowlist refusal ' + JSON.stringify(options), async () => fixture(async (send, calls) => {
    expect((await send(url))?.status).toBe(403); expect(calls).toHaveLength(0)
  }, { options }))
}
test('signature refusal', async () => fixture(async (send, calls) => {
  expect((await send(url, false, false))?.status).toBe(401); expect(calls).toHaveLength(0)
}))
for (const note of ['please reconsider', 'stop']) {
  test('open review note ' + note, async () => fixture(async (send, calls) => {
    expect((await send(note, true))?.status).toBe(200)
    expect(calls.map(c => c.path)).toEqual(['/v1/thread', '/api/chat.postMessage'])
    expect(calls[1].body.text).toBe(note === 'stop' ? 'noted; the run finishes and closes' : 'The review is still running.')
  }, { latest: { ...latest, finished: false } }))
}
test('finished follow-up binds source, parent and full trimmed note', async () => fixture(async (send, calls) => {
  await send('  reconsider\nwith this correction  ', true)
  expect(calls[0].query.get('threadTs')).toBe('1789846137.000001')
  expect(calls.find(c => c.path === '/v1/runs').body).toMatchObject({ sourceUrl: url, parentRunId: 'run-1',
    threadNote: 'reconsider\nwith this correction', threadTs: '1789846137.000001' })
  expect(calls.at(-1).body.text).toBe('Starting a follow-up review with your note; the new card comes back here.')
}, { latest }))
for (const value of [null, { ...latest, recipeId: 'other' }]) {
  test('unrelated thread falls through ' + JSON.stringify(value), async () => fixture(async (send, calls) => {
    expect(await send('hello', true)).toBeUndefined(); expect(calls).toHaveLength(1)
  }, { latest: value }))
}
test('note limit counts code points', async () => fixture(async (send, calls) => {
  await send('😀'.repeat(500), true)
  expect(calls.find(c => c.path === '/v1/runs').body.threadNote).toBe('😀'.repeat(500))
  calls.length = 0
  await send('x'.repeat(501), true)
  expect(calls.some(c => c.path === '/v1/runs')).toBe(false)
}, { latest }))
test('refusal is one line', async () => fixture(async (send, calls) => {
  expect((await send(url))?.status).toBe(200)
  expect(calls.at(-1).body.text).toBe('Fabric request refused: REFUSED reason.')
}, { failure: 409 }))
test('transient intake failure asks Slack to retry', async () => fixture(async send => {
  expect((await send(url))?.status).toBe(503)
}, { failure: 503 }))
test('only first line launches and root mentions fall through', async () => fixture(async (send, calls) => {
  expect(await send('hello\n' + url)).toBeUndefined()
  expect(await send('hello')).toBeUndefined()
  expect(calls).toHaveLength(0)
  await send(url + '\nadditional context', true)
  expect(calls.find(c => c.path === '/v1/runs').body.threadTs).toBe('1789846137.000001')
}))
test('fabric command with repo link stays with command handler', async () => fixture(async (send, calls) => {
  await send('fabric unknown ' + url)
  expect(calls.map(c => c.path)).toEqual(['/api/chat.postMessage'])
  expect(calls[0].body.text).toContain('Supported:')
}))
test('follow-up refusal does not announce a launch', async () => fixture(async (send, calls) => {
  await send('reconsider', true)
  expect(calls.at(-1).body.text).toBe('Fabric request refused: REFUSED reason.')
  expect(calls.filter(c => c.path === '/api/chat.postMessage')).toHaveLength(1)
}, { latest, failure: 409 }))
