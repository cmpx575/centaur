import { describe, expect, test } from 'bun:test'
import type { Logger, StateAdapter } from 'chat'
import { Hono } from 'hono'

import {
  CARD_CANCEL_ACTION_ID,
  CARD_REFRESH_ACTION_ID,
  CARD_RELAUNCH_ACTION_ID,
  LAUNCHER_ACTION_ID,
  LAUNCHER_CALLBACK_ID,
  LAUNCHER_SHAPES,
  launcherMessagePayload,
  registerSlackLauncher,
  runCardPayload,
  slackSignature,
  type LauncherShape
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
    const cancelMatch = url.match(/\/api\/workflows\/runs\/([^/]+)\/cancel$/)
    if (cancelMatch && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      return jsonResponse({
        ok: true,
        run_id: decodeURIComponent(cancelMatch[1] ?? 'workflow-run-1'),
        status: 'cancelling'
      })
    }
    const getMatch = url.match(/\/api\/workflows\/runs\/([^/]+)$/)
    if (getMatch && (init?.method ?? 'GET').toUpperCase() === 'GET') {
      const runId = decodeURIComponent(getMatch[1] ?? 'workflow-run-1')
      return jsonResponse({
        ok: true,
        run: workflowStates.shift() ?? {
          run_id: runId,
          status: 'completed',
          created_at: new Date(NOW_MS - 90_000).toISOString(),
          result: {
            output: {
              launcher_run_id: '2026-07-10_experiment-slack-launcher-proof',
              fleet_job_id: 'fleet-job-1',
              terminal_state: 'completed',
              shape: 'experiment'
            }
          }
        }
      })
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
  test('launchpad renders one button per allowlisted shape', () => {
    const payload = launcherMessagePayload()
    const actionsBlock = (payload.blocks as Record<string, unknown>[]).find(
      block => block.type === 'actions'
    ) as { elements: Array<Record<string, unknown>> }
    expect(actionsBlock.elements).toHaveLength(LAUNCHER_SHAPES.length)
    expect(actionsBlock.elements.length).toBeLessThanOrEqual(5)
    for (const [index, shape] of LAUNCHER_SHAPES.entries()) {
      const button = actionsBlock.elements[index]
      expect(button?.action_id).toBe(`${LAUNCHER_ACTION_ID}:${shape.key}`)
      expect(button?.value).toBe(shape.key)
      expect((button?.text as { text: string }).text).toBe(shape.label)
    }
  })

  test('launchpad action_ids are unique within the message (Slack rule)', () => {
    // Slack rejects invalid_blocks when action_id is duplicated in a message.
    // Regression for the multi-button launchpad that posted five identical ids.
    const payload = launcherMessagePayload()
    const actionsBlock = (payload.blocks as Record<string, unknown>[]).find(
      block => block.type === 'actions'
    ) as { elements: Array<Record<string, unknown>> }
    const actionIds = actionsBlock.elements.map(el => el.action_id as string)
    expect(actionIds).toHaveLength(LAUNCHER_SHAPES.length)
    expect(new Set(actionIds).size).toBe(actionIds.length)
    for (const shape of LAUNCHER_SHAPES) {
      expect(actionIds).toContain(`${LAUNCHER_ACTION_ID}:${shape.key}`)
    }
  })

  test('valid block action opens the experiment modal and acks promptly', async () => {
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
    expect(JSON.stringify(view)).toContain('General experiment')
    expect(JSON.stringify(view)).not.toContain('fixture-signing-secret')
  })

  test('bare and shape-suffixed action_ids both open a modal for a valid shape', async () => {
    // Bare id: Phase-1 launchpad message still in channel (back-compat).
    // Suffixed id: multi-button launchpad (Slack uniqueness rule).
    const cases: Array<{ action_id: string; shape: LauncherShape }> = [
      { action_id: LAUNCHER_ACTION_ID, shape: 'experiment' },
      { action_id: `${LAUNCHER_ACTION_ID}:oncall-digest`, shape: 'oncall-digest' }
    ]
    for (const { action_id, shape } of cases) {
      const harness = testHarness()
      const payload = mutate(blockActionFixture, value => {
        const action = (value.actions as Record<string, unknown>[])[0] as Record<string, unknown>
        action.action_id = action_id
        action.value = shape
      })
      const response = await signedRequest(harness.app, payload)
      expect(response.status).toBe(200)
      expect(harness.calls).toHaveLength(1)
      expect(harness.calls[0]?.url).toEndWith('/views.open')
      const view = harness.calls[0]?.body?.view as Record<string, unknown>
      const metadata = JSON.parse(String(view.private_metadata)) as { shape: string }
      expect(metadata.shape).toBe(shape)
    }
  })

  test('each allowlisted shape button opens a modal carrying that shape in private_metadata', async () => {
    for (const shape of LAUNCHER_SHAPES) {
      const harness = testHarness()
      const payload = mutate(blockActionFixture, value => {
        const action = (value.actions as Record<string, unknown>[])[0] as Record<
          string,
          unknown
        >
        // Multi-button launchpad scheme: unique action_id per shape, value = shape key.
        action.action_id = `${LAUNCHER_ACTION_ID}:${shape.key}`
        action.value = shape.key
      })
      const response = await signedRequest(harness.app, payload)
      expect(response.status).toBe(200)
      expect(harness.calls).toHaveLength(1)
      const view = harness.calls[0]?.body?.view as Record<string, unknown>
      const metadata = JSON.parse(String(view.private_metadata)) as {
        shape: string
        team_id: string
        channel_id: string
      }
      expect(metadata.shape).toBe(shape.key)
      expect(metadata.team_id).toBe('T_ALLOWED')
      expect(metadata.channel_id).toBe('C_ALLOWED')
      expect(JSON.stringify(view)).toContain(shape.title)
      expect(JSON.stringify(view)).toContain(shape.label)
    }
  })

  test('unknown shape button value is rejected and opens no modal', async () => {
    const harness = testHarness()
    const payload = mutate(blockActionFixture, value => {
      ;((value.actions as Record<string, unknown>[])[0] as Record<string, unknown>).value =
        'not-a-real-shape'
    })
    const response = await signedRequest(harness.app, payload)
    expect([400, 403, 502]).toContain(response.status)
    expect(harness.calls).toHaveLength(0)
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
    const workflowInput = (workflowCreates[0]?.body?.input ?? {}) as Record<string, unknown>
    expect(workflowInput.shape).toBe('experiment')
    const finalCard = JSON.stringify(cardUpdates.at(-1)?.body)
    expect(finalCard).toContain('2026-07-10_experiment-slack-launcher-proof')
    expect(finalCard).toContain('fleet-job-1')
    expect(finalCard).toContain('Completed')
    expect(finalCard).toContain('🧪 General experiment')
    expect(finalCard).toContain('shape `experiment`')
    expect(JSON.stringify(harness.logs)).not.toContain(
      'Prove the signed Centaur Slack launcher end to end.'
    )
    expect(JSON.stringify(harness.logs)).not.toContain('payload=')
  })

  test('view submission threads each allowlisted shape into workflow input.shape', async () => {
    for (const shape of LAUNCHER_SHAPES) {
      const harness = testHarness()
      const payload = viewSubmissionForShape(shape.key)
      const response = await signedRequest(harness.app, payload)
      expect(response.status).toBe(200)
      await Promise.all(harness.pending)

      const workflowCreates = harness.calls.filter(
        call => call.url.endsWith('/api/workflows/runs') && call.method === 'POST'
      )
      expect(workflowCreates).toHaveLength(1)
      const workflowInput = (workflowCreates[0]?.body?.input ?? {}) as Record<string, unknown>
      expect(workflowInput.shape).toBe(shape.key)
      expect(workflowInput.version).toBe(1)

      const cardPosts = harness.calls.filter(
        call => call.url.endsWith('/chat.postMessage') && !call.body?.thread_ts
      )
      expect(cardPosts).toHaveLength(1)
      const cardBody = JSON.stringify(cardPosts[0]?.body)
      expect(cardBody).toContain(shape.label)
      expect(cardBody).toContain(`shape \`${shape.key}\``)
    }
  })

  test('disallowed shape in private_metadata creates no workflow', async () => {
    const harness = testHarness()
    const payload = mutate(viewSubmissionFixture, value => {
      ;(value.view as Record<string, unknown>).private_metadata = JSON.stringify({
        v: 1,
        shape: 'not-allowlisted',
        team_id: 'T_ALLOWED',
        channel_id: 'C_ALLOWED',
        origin_ts: '1783700000.000100'
      })
    })
    const response = await signedRequest(harness.app, payload)
    expect(response.status).toBe(400)
    expect(harness.calls).toHaveLength(0)
    expect(
      harness.logs.some(
        log =>
          log.message === 'slack_launcher_submission_rejected' &&
          (log.data as { reason?: string } | undefined)?.reason === 'invalid_private_metadata'
      )
    ).toBe(true)
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

  test('status card renders richer fields and three action buttons with unique action_ids', () => {
    const payload = runCardPayload(
      {
        channelId: 'C_ALLOWED',
        createdAt: new Date(NOW_MS - 125_000).toISOString(),
        fleetJobId: 'fleet-job-1',
        launcherRunId: 'launcher-run-1',
        objective: 'Prove card buttons',
        shape: 'oncall-digest',
        state: 'running',
        userId: 'U_ALLOWED',
        workflowRunId: 'workflow-run-1'
      },
      NOW_MS
    )
    const blocks = payload.blocks as Record<string, unknown>[]
    const section = blocks.find(block => block.type === 'section') as {
      fields: Array<{ text: string }>
    }
    const fields = section.fields.map(field => field.text).join('\n')
    expect(fields).toContain('*Status*')
    expect(fields).toContain('*Shape*')
    expect(fields).toContain('📟 Oncall digest')
    expect(fields).toContain('*Worker*')
    expect(fields).toContain('`grok`')
    expect(fields).toContain('*Elapsed*')
    expect(fields).toContain('2m 5s')
    expect(fields).toContain('*Workflow run*')
    expect(fields).toContain('*Launcher run*')
    expect(fields).toContain('*Fleet job*')

    const actionsBlock = blocks.find(block => block.type === 'actions') as {
      elements: Array<Record<string, unknown>>
    }
    expect(actionsBlock.elements).toHaveLength(3)
    const actionIds = actionsBlock.elements.map(el => el.action_id as string)
    expect(actionIds).toEqual([
      CARD_REFRESH_ACTION_ID,
      CARD_CANCEL_ACTION_ID,
      CARD_RELAUNCH_ACTION_ID
    ])
    // Slack rejects invalid_blocks when action_id is duplicated in a message.
    expect(new Set(actionIds).size).toBe(actionIds.length)
    expect(actionsBlock.elements[0]?.value).toBe('workflow-run-1')
    expect(actionsBlock.elements[1]?.value).toBe('workflow-run-1')
    expect(actionsBlock.elements[1]?.style).toBe('danger')
    const relaunchValue = String(actionsBlock.elements[2]?.value)
    expect(JSON.parse(relaunchValue)).toEqual({
      shape: 'oncall-digest',
      objective: 'Prove card buttons'
    })
  })

  test('status card omits Cancel button on terminal states', () => {
    for (const state of ['completed', 'failed', 'cancelled', 'cancelling'] as const) {
      const payload = runCardPayload({
        channelId: 'C_ALLOWED',
        shape: 'experiment',
        state,
        userId: 'U_ALLOWED',
        workflowRunId: 'workflow-run-1'
      })
      const actionsBlock = (payload.blocks as Record<string, unknown>[]).find(
        block => block.type === 'actions'
      ) as { elements: Array<Record<string, unknown>> }
      const actionIds = actionsBlock.elements.map(el => el.action_id as string)
      expect(actionIds).toEqual([CARD_REFRESH_ACTION_ID, CARD_RELAUNCH_ACTION_ID])
      expect(actionIds).not.toContain(CARD_CANCEL_ACTION_ID)
      expect(new Set(actionIds).size).toBe(actionIds.length)
    }
  })

  test('card refresh block_action GETs the workflow and updates the card in place', async () => {
    const harness = testHarness({
      workflowStates: [
        { run_id: 'workflow-run-1', status: 'running' },
        {
          run_id: 'workflow-run-1',
          status: 'completed',
          result: {
            output: {
              launcher_run_id: '2026-07-10_experiment-slack-launcher-proof',
              fleet_job_id: 'fleet-job-1',
              terminal_state: 'completed'
            }
          }
        },
        {
          run_id: 'workflow-run-1',
          status: 'completed',
          result: {
            output: {
              launcher_run_id: '2026-07-10_experiment-slack-launcher-proof',
              fleet_job_id: 'fleet-job-1',
              terminal_state: 'completed',
              shape: 'experiment'
            }
          }
        }
      ]
    })
    const submit = await signedRequest(harness.app, viewSubmissionFixture)
    expect(submit.status).toBe(200)
    await Promise.all(harness.pending)
    const callsBefore = harness.calls.length

    const refreshPayload = cardBlockAction(CARD_REFRESH_ACTION_ID, 'workflow-run-1')
    const response = await signedRequest(harness.app, refreshPayload)
    expect(response.status).toBe(200)
    await Promise.all(harness.pending)

    const newCalls = harness.calls.slice(callsBefore)
    const gets = newCalls.filter(
      call =>
        call.method === 'GET' && call.url.endsWith('/api/workflows/runs/workflow-run-1')
    )
    const updates = newCalls.filter(call => call.url.endsWith('/chat.update'))
    expect(gets.length).toBeGreaterThanOrEqual(1)
    expect(updates.length).toBeGreaterThanOrEqual(1)
    const updated = JSON.stringify(updates.at(-1)?.body)
    expect(updated).toContain('workflow-run-1')
    expect(updated).toContain('Completed')
    expect(updated).toContain(CARD_REFRESH_ACTION_ID)
    expect(updated).toContain(CARD_RELAUNCH_ACTION_ID)
    expect(updates.at(-1)?.body?.channel).toBe('C_ALLOWED')
    expect(updates.at(-1)?.body?.ts).toBe('1783700100.000200')
  })

  test('card cancel block_action POSTs cancel and updates with honest wording', async () => {
    const harness = testHarness({
      workflowStates: [
        {
          run_id: 'workflow-run-1',
          status: 'completed',
          result: {
            output: {
              launcher_run_id: '2026-07-10_experiment-slack-launcher-proof',
              fleet_job_id: 'fleet-job-1',
              terminal_state: 'completed'
            }
          }
        }
      ]
    })
    const submit = await signedRequest(harness.app, viewSubmissionFixture)
    expect(submit.status).toBe(200)
    await Promise.all(harness.pending)

    // Force the stored record back to non-terminal so Cancel is meaningful.
    for (const [key, value] of harness.state.values.entries()) {
      if (typeof key === 'string' && key.includes(':launcher:run:') && value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        record.state = 'running'
        harness.state.values.set(key, record)
      }
    }

    const callsBefore = harness.calls.length
    const cancelPayload = cardBlockAction(CARD_CANCEL_ACTION_ID, 'workflow-run-1')
    const response = await signedRequest(harness.app, cancelPayload)
    expect(response.status).toBe(200)
    await Promise.all(harness.pending)

    const newCalls = harness.calls.slice(callsBefore)
    const cancelPosts = newCalls.filter(
      call =>
        call.method === 'POST' &&
        call.url.endsWith('/api/workflows/runs/workflow-run-1/cancel')
    )
    const updates = newCalls.filter(call => call.url.endsWith('/chat.update'))
    expect(cancelPosts).toHaveLength(1)
    expect(updates.length).toBeGreaterThanOrEqual(1)
    const updated = JSON.stringify(updates.at(-1)?.body)
    expect(updated).toContain('Cancel requested')
    expect(updated).toContain('workflow cancelling')
    expect(updated).toContain('fleet job may still finish')
    // Must not claim the fleet worker PID was killed.
    expect(updated.toLowerCase()).not.toContain('fleet job killed')
    expect(updated.toLowerCase()).not.toContain('worker killed')
    // Cancel button omitted while cancelling.
    expect(updated).not.toContain(CARD_CANCEL_ACTION_ID)
  })

  test('card relaunch block_action opens a modal for the stored shape (objective prefilled)', async () => {
    const harness = testHarness()
    const relaunchValue = JSON.stringify({
      shape: 'knowledge-map-ingest',
      objective: 'Re-run the knowledge map ingest slice'
    })
    const payload = cardBlockAction(CARD_RELAUNCH_ACTION_ID, relaunchValue)
    const response = await signedRequest(harness.app, payload)
    expect(response.status).toBe(200)
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]?.url).toEndWith('/views.open')
    const view = harness.calls[0]?.body?.view as Record<string, unknown>
    expect(view.callback_id).toBe(LAUNCHER_CALLBACK_ID)
    const metadata = JSON.parse(String(view.private_metadata)) as { shape: string }
    expect(metadata.shape).toBe('knowledge-map-ingest')
    expect(JSON.stringify(view)).toContain('Knowledge-map ingest')
    expect(JSON.stringify(view)).toContain('Re-run the knowledge map ingest slice')
    // New view id path is Slack-owned; private_metadata does not carry prior idempotency.
    expect(JSON.stringify(view)).not.toContain('workflow-run-1')
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

function viewSubmissionForShape(shape: LauncherShape): Record<string, unknown> {
  return mutate(viewSubmissionFixture, value => {
    ;(value.view as Record<string, unknown>).id = `V_LAUNCH_${shape}`
    ;(value.view as Record<string, unknown>).private_metadata = JSON.stringify({
      v: 1,
      shape,
      team_id: 'T_ALLOWED',
      channel_id: 'C_ALLOWED',
      origin_ts: '1783700000.000100'
    })
  })
}

function cardBlockAction(actionId: string, value: string): Record<string, unknown> {
  return mutate(blockActionFixture, payload => {
    const action = (payload.actions as Record<string, unknown>[])[0] as Record<string, unknown>
    action.action_id = actionId
    action.block_id = 'centaur_card_actions'
    action.value = value
    ;(payload.container as Record<string, unknown>).message_ts = '1783700100.000200'
    payload.message = {
      ts: '1783700100.000200',
      blocks: runCardPayload({
        channelId: 'C_ALLOWED',
        objective: 'Prove the signed Centaur Slack launcher end to end.',
        shape: 'experiment',
        state: 'running',
        userId: 'U_ALLOWED',
        workflowRunId: 'workflow-run-1'
      }).blocks
    }
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
