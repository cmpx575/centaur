import { describe, expect, test } from 'bun:test'
import type { Logger, StateAdapter } from 'chat'
import { Hono } from 'hono'

import {
  LAUNCHER_ACTION_ID,
  LAUNCHER_CALLBACK_ID,
  registerSlackLauncher,
  slackSignature
} from '../src/launcher'

const SIGNING_SECRET = 'fixture-signing-secret'
const NOW_MS = 1_783_700_100_000
const NOW_SECONDS = String(Math.floor(NOW_MS / 1000))

const blockActionFixture = (await Bun.file(
  `${import.meta.dir}/fixtures/launcher-block-action.json`
).json()) as Record<string, unknown>
const viewSubmissionFixture = (await Bun.file(
  `${import.meta.dir}/fixtures/launcher-view-submission.json`
).json()) as Record<string, unknown>

type FetchCall = {
  body?: Record<string, unknown>
  method: string
  url: string
}

class MemoryState {
  readonly values = new Map<string, unknown>()

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value))
  }

  async setIfNotExists(key: string, value: unknown): Promise<boolean> {
    if (this.values.has(key)) return false
    this.values.set(key, structuredClone(value))
    return true
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function testHarness(input: {
  allowedChannelIds?: string[]
  allowedTeamIds?: string[]
  allowedUserIds?: string[]
  workflowStates?: Record<string, unknown>[]
} = {}) {
  const app = new Hono()
  const calls: FetchCall[] = []
  const logs: Array<{ data?: unknown; level: string; message: string }> = []
  const pending: Promise<unknown>[] = []
  const state = new MemoryState()
  const workflowStates = [...(input.workflowStates ?? [])]
  const fetcher = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(request)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ body, method: init?.method ?? 'GET', url })
    if (url.endsWith('/views.open')) return jsonResponse({ ok: true, view: { id: 'V_MODAL' } })
    if (url.endsWith('/chat.update')) return jsonResponse({ ok: true, ts: body?.ts })
    if (url.endsWith('/chat.postMessage')) {
      return jsonResponse({ ok: true, ts: body?.thread_ts ? '1783700100.000300' : '1783700100.000200' })
    }
    if (url.endsWith('/api/workflows/runs') && init?.method === 'POST') {
      return jsonResponse({
        ok: true,
        run_id: 'workflow-run-1',
        task_id: 'workflow-task-1',
        status: 'queued',
        created: true
      })
    }
    if (url.endsWith('/api/workflows/runs/workflow-run-1')) {
      return jsonResponse(
        workflowStates.shift() ?? {
          run_id: 'workflow-run-1',
          status: 'completed',
          result: {
            launcher_run_id: '2026-07-10_experiment-slack-launcher-proof',
            fleet_job_id: 'fleet-job-1',
            terminal_state: 'completed'
          }
        }
      )
    }
    return jsonResponse({ ok: false, error: 'unhandled_test_url' }, 500)
  }
  const logger = {
    child: () => logger,
    debug: (message: string, data?: unknown) => logs.push({ level: 'debug', message, data }),
    error: (message: string, data?: unknown) => logs.push({ level: 'error', message, data }),
    info: (message: string, data?: unknown) => logs.push({ level: 'info', message, data }),
    warn: (message: string, data?: unknown) => logs.push({ level: 'warn', message, data })
  }
  registerSlackLauncher(app, {
    allowedChannelIds: input.allowedChannelIds ?? ['C_ALLOWED'],
    allowedTeamIds: input.allowedTeamIds ?? ['T_ALLOWED'],
    allowedUserIds: input.allowedUserIds ?? ['U_ALLOWED'],
    apiKey: 'api-key-placeholder',
    apiUrl: 'https://centaur.test',
    botToken: 'bot-token-placeholder',
    fetch: fetcher,
    logger: logger as Logger,
    maxPollMs: 100,
    now: () => NOW_MS,
    pollIntervalMs: 1,
    schedule: promise => pending.push(promise),
    signingSecret: SIGNING_SECRET,
    slackApiUrl: 'https://slack.test/api',
    state: state as unknown as StateAdapter
  })
  return { app, calls, logs, pending, state }
}

describe('Centaur Slack launcher signed interaction route', () => {
  test('valid block action opens the fixed experiment modal and acks promptly', async () => {
    const harness = testHarness()
    const started = performance.now()
    const response = await signedRequest(harness.app, blockActionFixture)
    const elapsedMs = performance.now() - started

    expect(response.status).toBe(200)
    expect(elapsedMs).toBeLessThan(100)
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]?.url).toEndWith('/views.open')
    const view = harness.calls[0]?.body?.view as Record<string, unknown>
    expect(view.callback_id).toBe(LAUNCHER_CALLBACK_ID)
    expect(view.private_metadata).toBe(
      '{"v":1,"shape":"experiment","team_id":"T_ALLOWED","channel_id":"C_ALLOWED","origin_ts":"1783700000.000100"}'
    )
    expect(JSON.stringify(view)).not.toContain('fixture-signing-secret')
  })

  test('one submission creates one card, workflow, terminal update, and thread reply', async () => {
    const harness = testHarness({
      workflowStates: [
        { run_id: 'workflow-run-1', status: 'running' },
        {
          run_id: 'workflow-run-1',
          status: 'completed',
          result: {
            launcher_run_id: '2026-07-10_experiment-slack-launcher-proof',
            fleet_job_id: 'fleet-job-1',
            terminal_state: 'completed'
          }
        }
      ]
    })

    const response = await signedRequest(harness.app, viewSubmissionFixture)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    await Promise.all(harness.pending)

    const cardPosts = harness.calls.filter(
      call => call.url.endsWith('/chat.postMessage') && !call.body?.thread_ts
    )
    const threadReplies = harness.calls.filter(
      call => call.url.endsWith('/chat.postMessage') && call.body?.thread_ts
    )
    const workflowCreates = harness.calls.filter(
      call => call.url.endsWith('/api/workflows/runs') && call.method === 'POST'
    )
    const cardUpdates = harness.calls.filter(call => call.url.endsWith('/chat.update'))
    expect(cardPosts).toHaveLength(1)
    expect(threadReplies).toHaveLength(1)
    expect(workflowCreates).toHaveLength(1)
    expect(cardUpdates.length).toBeGreaterThanOrEqual(2)

    expect(workflowCreates[0]?.body?.idempotency_key).toBe(
      'slack-launcher:T_ALLOWED:V_LAUNCH_001:centaur.launcher.submit.v1'
    )
    expect(workflowCreates[0]?.body?.workflow_name).toBe('cmpx575_launcher')
    const finalCard = JSON.stringify(cardUpdates.at(-1)?.body)
    expect(finalCard).toContain('2026-07-10_experiment-slack-launcher-proof')
    expect(finalCard).toContain('fleet-job-1')
    expect(finalCard).toContain('Completed')
    expect(JSON.stringify(harness.logs)).not.toContain(
      'Prove the signed Centaur Slack launcher end to end.'
    )
    expect(JSON.stringify(harness.logs)).not.toContain('payload=')
  })

  test('identical view retry never creates a second workflow, card, or terminal reply', async () => {
    const harness = testHarness()
    const first = await signedRequest(harness.app, viewSubmissionFixture)
    const retry = await signedRequest(harness.app, viewSubmissionFixture)
    expect(first.status).toBe(200)
    expect(retry.status).toBe(200)
    await Promise.all(harness.pending)

    expect(
      harness.calls.filter(call => call.url.endsWith('/api/workflows/runs') && call.method === 'POST')
    ).toHaveLength(1)
    expect(
      harness.calls.filter(call => call.url.endsWith('/chat.postMessage') && !call.body?.thread_ts)
    ).toHaveLength(1)
    expect(
      harness.calls.filter(call => call.url.endsWith('/chat.postMessage') && call.body?.thread_ts)
    ).toHaveLength(1)
    expect(harness.logs.some(log => log.message === 'slack_launcher_duplicate_ignored')).toBe(true)
  })

  test('invalid and stale signatures cause no downstream IO', async () => {
    const harness = testHarness()
    const invalid = await signedRequest(harness.app, blockActionFixture, {
      signature: slackSignature('wrong-secret', NOW_SECONDS, formBody(blockActionFixture))
    })
    const staleTimestamp = String(Number(NOW_SECONDS) - 301)
    const stale = await signedRequest(harness.app, blockActionFixture, {
      timestamp: staleTimestamp
    })

    expect(invalid.status).toBe(401)
    expect(stale.status).toBe(401)
    expect(harness.calls).toHaveLength(0)
  })

  test('disallowed team, channel, user, and action cause no downstream IO', async () => {
    const cases = [
      mutate(blockActionFixture, payload => {
        ;(payload.team as Record<string, unknown>).id = 'T_DENIED'
      }),
      mutate(blockActionFixture, payload => {
        ;(payload.channel as Record<string, unknown>).id = 'C_DENIED'
      }),
      mutate(blockActionFixture, payload => {
        ;(payload.user as Record<string, unknown>).id = 'U_DENIED'
      }),
      mutate(blockActionFixture, payload => {
        ;((payload.actions as Record<string, unknown>[])[0] as Record<string, unknown>).action_id =
          'centaur.launch.disallowed.v1'
      })
    ]

    for (const payload of cases) {
      const harness = testHarness()
      const response = await signedRequest(harness.app, payload)
      expect([400, 403, 502]).toContain(response.status)
      expect(harness.calls).toHaveLength(0)
    }
  })

  test('invalid objective and slug return modal field errors with no downstream IO', async () => {
    const payload = mutate(viewSubmissionFixture, value => {
      const values = ((value.view as Record<string, unknown>).state as Record<string, unknown>)
        .values as Record<string, Record<string, Record<string, unknown>>>
      values.objective_block!.objective_input!.value = ''
      values.slug_block!.slug_input!.value = 'Not Valid'
    })
    const harness = testHarness()
    const response = await signedRequest(harness.app, payload)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      response_action: 'errors',
      errors: {
        objective_block: 'Enter an objective between 1 and 2000 characters.',
        slug_block: 'Use 1–63 lowercase letters, digits, or hyphens.'
      }
    })
    expect(harness.calls).toHaveLength(0)
  })

  test('fixture action and callback IDs remain versioned and fixed', () => {
    const action = (blockActionFixture.actions as Record<string, unknown>[])[0]
    const view = viewSubmissionFixture.view as Record<string, unknown>
    expect(action?.action_id).toBe(LAUNCHER_ACTION_ID)
    expect(view.callback_id).toBe(LAUNCHER_CALLBACK_ID)
  })
})

async function signedRequest(
  app: Hono,
  payload: Record<string, unknown>,
  override: { signature?: string; timestamp?: string } = {}
): Promise<Response> {
  const body = formBody(payload)
  const timestamp = override.timestamp ?? NOW_SECONDS
  return app.request('/api/webhooks/slack/actions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature':
        override.signature ?? slackSignature(SIGNING_SECRET, timestamp, body)
    },
    body
  })
}

function formBody(payload: Record<string, unknown>): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
}

function mutate(
  fixture: Record<string, unknown>,
  change: (payload: Record<string, unknown>) => void
): Record<string, unknown> {
  const payload = clone(fixture)
  change(payload)
  return payload
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
