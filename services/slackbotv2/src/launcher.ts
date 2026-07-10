import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Logger, StateAdapter } from 'chat'
import type { Context, Hono } from 'hono'

import type { SlackbotV2Fetch } from './types'

export const LAUNCHER_ACTION_ID = 'centaur.launch.experiment.v1'
export const LAUNCHER_CALLBACK_ID = 'centaur.launcher.submit.v1'
export const LAUNCHER_WORKFLOW_NAME = 'cmpx575_launcher'

/** Shapes already allowlisted by the cmpx575_launcher workflow — expose, do not redefine. */
export const LAUNCHER_SHAPES = [
  { key: 'experiment', label: '🧪 General experiment', title: 'General experiment' },
  { key: 'oncall-digest', label: '📟 Oncall digest', title: 'Oncall digest' },
  { key: 'knowledge-map-ingest', label: '🗺️ Knowledge-map ingest', title: 'Knowledge-map ingest' },
  { key: 'slack-inbox-to-board', label: '📥 Inbox→board', title: 'Inbox→board' },
  { key: 'quota-scheduler', label: '⏱️ Quota scheduler', title: 'Quota scheduler' }
] as const

export type LauncherShape = (typeof LAUNCHER_SHAPES)[number]['key']

const LAUNCHER_SHAPE_BY_KEY = new Map(
  LAUNCHER_SHAPES.map(shape => [shape.key, shape] as const)
)
const LAUNCHER_SHAPE_KEYS = new Set<string>(LAUNCHER_SHAPES.map(shape => shape.key))

const OBJECTIVE_BLOCK_ID = 'objective_block'
const OBJECTIVE_ACTION_ID = 'objective_input'
const SLUG_BLOCK_ID = 'slug_block'
const SLUG_ACTION_ID = 'slug_input'
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60
const CLAIM_TTL_MS = 5 * 60 * 1000
const CLAIM_REFRESH_MS = 60 * 1000
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_MAX_POLL_MS = 45 * 60 * 1000
const TERMINAL_WORKFLOW_STATES = new Set(['completed', 'failed', 'cancelled'])

type JsonRecord = Record<string, unknown>

export type SlackLauncherOptions = {
  allowedChannelIds: readonly string[]
  allowedTeamIds: readonly string[]
  allowedUserIds: readonly string[]
  apiKey?: string
  apiUrl: string
  botToken: string
  fetch?: SlackbotV2Fetch
  logger: Logger
  maxPollMs?: number
  now?: () => number
  pollIntervalMs?: number
  schedule?: (promise: Promise<unknown>) => void
  signingSecret: string
  slackApiUrl?: string
  state: StateAdapter
}

type LauncherPrivateMetadata = {
  channel_id: string
  origin_ts: string
  shape: LauncherShape
  team_id: string
  v: 1
}

type LauncherSubmission = {
  callbackId: string
  channelId: string
  idempotencyKey: string
  objective: string
  originTs: string
  shape: LauncherShape
  slug?: string
  teamId: string
  userId: string
  viewId: string
}

type LauncherRunRecord = {
  cardTs?: string
  channelId: string
  fleetJobId?: string
  launcherRunId?: string
  shape: LauncherShape
  state: 'claiming' | 'queued' | 'running' | 'completed' | 'failed'
  terminalReplySent?: boolean
  updatedAt: string
  userId: string
  workflowRunId?: string
}

class LauncherRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}

export function registerSlackLauncher(app: Hono, options: SlackLauncherOptions): void {
  app.post('/api/webhooks/slack/actions', async c => {
    const rawBody = await c.req.raw.clone().text()
    const verification = verifySlackRequest({
      nowMs: (options.now ?? Date.now)(),
      rawBody,
      signature: c.req.header('x-slack-signature'),
      signingSecret: options.signingSecret,
      timestamp: c.req.header('x-slack-request-timestamp')
    })
    if (!verification.ok) {
      options.logger.warn('slack_launcher_request_rejected', { reason: verification.reason })
      return c.text('invalid request', 401)
    }

    const parsed = parseInteractionPayload(rawBody)
    if (!parsed.ok) {
      options.logger.warn('slack_launcher_payload_rejected', { reason: parsed.reason })
      return c.text('invalid payload', 400)
    }

    const payload = parsed.payload
    const type = stringAt(payload, 'type')
    const teamId = stringAt(recordAt(payload, 'team'), 'id')
    const userId = stringAt(recordAt(payload, 'user'), 'id')
    if (!isAllowed(teamId, options.allowedTeamIds)) {
      return denyInteraction(c, options, type, 'team')
    }
    if (!isAllowed(userId, options.allowedUserIds)) {
      return denyInteraction(c, options, type, 'user')
    }

    if (type === 'block_actions') {
      const channelId =
        stringAt(recordAt(payload, 'channel'), 'id') ||
        stringAt(recordAt(payload, 'container'), 'channel_id')
      if (!isAllowed(channelId, options.allowedChannelIds)) {
        return denyInteraction(c, options, type, 'channel')
      }
      try {
        await openExperimentModal(payload, teamId, channelId, options)
        options.logger.info('slack_launcher_modal_opened', {
          action_id: LAUNCHER_ACTION_ID,
          channel_id: channelId,
          team_id: teamId,
          user_id: userId
        })
        return c.text('', 200)
      } catch (error) {
        options.logger.error('slack_launcher_modal_open_failed', {
          error_code: safeErrorCode(error)
        })
        return c.text('unable to open modal', 502)
      }
    }

    if (type === 'view_submission') {
      const submission = parseSubmission(payload, teamId, userId)
      if (!submission.ok) {
        if (submission.fieldErrors) {
          return c.json({ response_action: 'errors', errors: submission.fieldErrors }, 200)
        }
        options.logger.warn('slack_launcher_submission_rejected', {
          reason: submission.reason,
          team_id: teamId,
          user_id: userId
        })
        return c.text('invalid submission', 400)
      }
      if (!isAllowed(submission.value.channelId, options.allowedChannelIds)) {
        return denyInteraction(c, options, type, 'channel')
      }
      if (submission.value.teamId !== teamId) {
        return denyInteraction(c, options, type, 'metadata_team')
      }

      const task = processSubmission(submission.value, options).catch(error => {
        options.logger.error('slack_launcher_submission_failed', {
          error_code: safeErrorCode(error),
          idempotency_key: submission.value.idempotencyKey
        })
      })
      scheduleTask(c, task, options)
      options.logger.info('slack_launcher_submission_acknowledged', {
        callback_id: submission.value.callbackId,
        channel_id: submission.value.channelId,
        idempotency_key: submission.value.idempotencyKey,
        team_id: teamId,
        user_id: userId,
        view_id: submission.value.viewId
      })
      return c.text('', 200)
    }

    options.logger.info('slack_launcher_interaction_ignored', { interaction_type: type })
    return c.text('', 200)
  })
}

export function launcherMessagePayload(): JsonRecord {
  return {
    text: 'Centaur launcher: pick an experiment shape to start.',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Centaur launchpad', emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Start a scoped, durable fleet run. Pick a shape, then enter the objective in the modal. Confirmed launches are deterministic.'
        }
      },
      {
        type: 'actions',
        block_id: 'centaur_launcher_actions',
        // Slack allows at most 5 elements per actions block; one button per allowlisted shape.
        elements: LAUNCHER_SHAPES.map((shape, index) => ({
          type: 'button',
          action_id: LAUNCHER_ACTION_ID,
          text: { type: 'plain_text', text: shape.label, emoji: true },
          value: shape.key,
          ...(index === 0 ? { style: 'primary' as const } : {})
        }))
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Phase 2 · 5 shapes · signed callbacks · allowlisted to this playground · retry-safe'
          }
        ]
      }
    ]
  }
}

export function slackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${rawBody}`, 'utf8')
    .digest('hex')}`
}

export function verifySlackRequest(input: {
  nowMs: number
  rawBody: string
  signature?: string
  signingSecret: string
  timestamp?: string
}): { ok: true } | { ok: false; reason: string } {
  const timestamp = input.timestamp?.trim() ?? ''
  const timestampSeconds = Number.parseInt(timestamp, 10)
  if (!timestamp || !Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'missing_timestamp' }
  }
  const ageSeconds = Math.abs(Math.floor(input.nowMs / 1000) - timestampSeconds)
  if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' }
  }
  const actual = input.signature?.trim() ?? ''
  const expected = slackSignature(input.signingSecret, timestamp, input.rawBody)
  const actualBuffer = Buffer.from(actual, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: 'invalid_signature' }
  }
  return { ok: true }
}

async function openExperimentModal(
  payload: JsonRecord,
  teamId: string,
  channelId: string,
  options: SlackLauncherOptions
): Promise<void> {
  const actions = arrayAt(payload, 'actions')
  if (actions.length !== 1) throw new LauncherRequestError('invalid_action_count', 400)
  const action = asRecord(actions[0])
  const actionId = stringAt(action, 'action_id')
  const shapeValue = stringAt(action, 'value')
  if (actionId !== LAUNCHER_ACTION_ID || !isLauncherShape(shapeValue)) {
    throw new LauncherRequestError('disallowed_action', 400)
  }
  const shape = shapeValue
  const shapeInfo = shapeMeta(shape)
  const triggerId = stringAt(payload, 'trigger_id')
  if (!triggerId) throw new LauncherRequestError('missing_trigger_id', 400)
  const metadata: LauncherPrivateMetadata = {
    v: 1,
    shape,
    team_id: teamId,
    channel_id: channelId,
    origin_ts: stringAt(recordAt(payload, 'container'), 'message_ts')
  }
  await slackApi(options, 'views.open', {
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: LAUNCHER_CALLBACK_ID,
      private_metadata: JSON.stringify(metadata),
      // Slack modal titles max out at 24 characters.
      title: { type: 'plain_text', text: truncatePlainText(shapeInfo.title, 24), emoji: true },
      submit: { type: 'plain_text', text: 'Launch' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Launching ${shapeInfo.label} (\`${shape}\`)`
            }
          ]
        },
        {
          type: 'input',
          block_id: OBJECTIVE_BLOCK_ID,
          label: { type: 'plain_text', text: 'Objective' },
          element: {
            type: 'plain_text_input',
            action_id: OBJECTIVE_ACTION_ID,
            multiline: true,
            min_length: 1,
            max_length: 2000,
            placeholder: { type: 'plain_text', text: 'What should this run prove or build?' }
          }
        },
        {
          type: 'input',
          block_id: SLUG_BLOCK_ID,
          optional: true,
          label: { type: 'plain_text', text: 'Short slug (optional)' },
          element: {
            type: 'plain_text_input',
            action_id: SLUG_ACTION_ID,
            max_length: 63,
            placeholder: { type: 'plain_text', text: 'e.g. slack-launcher-proof' }
          }
        }
      ]
    }
  })
}

function parseSubmission(
  payload: JsonRecord,
  teamId: string,
  userId: string
):
  | { ok: true; value: LauncherSubmission }
  | { ok: false; reason: string; fieldErrors?: Record<string, string> } {
  const view = recordAt(payload, 'view')
  const callbackId = stringAt(view, 'callback_id')
  const viewId = stringAt(view, 'id')
  if (callbackId !== LAUNCHER_CALLBACK_ID || !viewId) {
    return { ok: false, reason: 'disallowed_callback' }
  }
  const metadata = parsePrivateMetadata(stringAt(view, 'private_metadata'))
  if (!metadata) return { ok: false, reason: 'invalid_private_metadata' }
  if (metadata.v !== 1 || !isLauncherShape(metadata.shape)) {
    return { ok: false, reason: 'disallowed_shape' }
  }

  const values = recordAt(recordAt(view, 'state'), 'values')
  const objective = stringAt(recordAt(recordAt(values, OBJECTIVE_BLOCK_ID), OBJECTIVE_ACTION_ID), 'value').trim()
  const slug = stringAt(recordAt(recordAt(values, SLUG_BLOCK_ID), SLUG_ACTION_ID), 'value').trim()
  const fieldErrors: Record<string, string> = {}
  if (!objective || objective.length > 2000) {
    fieldErrors[OBJECTIVE_BLOCK_ID] = 'Enter an objective between 1 and 2000 characters.'
  }
  if (slug && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    fieldErrors[SLUG_BLOCK_ID] = 'Use 1–63 lowercase letters, digits, or hyphens.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, reason: 'invalid_fields', fieldErrors }
  }

  return {
    ok: true,
    value: {
      callbackId,
      channelId: metadata.channel_id,
      idempotencyKey: `slack-launcher:${teamId}:${viewId}:${callbackId}`,
      objective,
      originTs: metadata.origin_ts,
      shape: metadata.shape,
      slug: slug || undefined,
      teamId: metadata.team_id,
      userId,
      viewId
    }
  }
}

async function processSubmission(
  submission: LauncherSubmission,
  options: SlackLauncherOptions
): Promise<void> {
  const claimKey = launcherClaimKey(submission.idempotencyKey)
  const claimToken = randomUUID()
  const acquired = await options.state.setIfNotExists(claimKey, claimToken, CLAIM_TTL_MS)
  if (!acquired) {
    options.logger.info('slack_launcher_duplicate_ignored', {
      idempotency_key: submission.idempotencyKey,
      view_id: submission.viewId
    })
    return
  }

  const refresh = setInterval(() => {
    void options.state
      .get<string>(claimKey)
      .then(current =>
        current === claimToken
          ? options.state.set(claimKey, claimToken, CLAIM_TTL_MS)
          : undefined
      )
      .catch(() => undefined)
  }, CLAIM_REFRESH_MS)

  let record = await getRunRecord(options.state, submission.idempotencyKey)
  try {
    if (record?.state === 'completed' || record?.state === 'failed') return

    if (!record?.cardTs) {
      const posted = await slackApi(options, 'chat.postMessage', {
        channel: submission.channelId,
        client_msg_id: deterministicUuid(`${submission.idempotencyKey}:card`),
        ...runCardPayload({
          channelId: submission.channelId,
          shape: submission.shape,
          state: 'queued',
          userId: submission.userId
        })
      })
      const cardTs = stringAt(posted, 'ts')
      if (!cardTs) throw new LauncherRequestError('slack_missing_card_ts', 502)
      record = {
        cardTs,
        channelId: submission.channelId,
        shape: submission.shape,
        state: 'claiming',
        updatedAt: new Date((options.now ?? Date.now)()).toISOString(),
        userId: submission.userId
      }
      await setRunRecord(options.state, submission.idempotencyKey, record)
    }

    if (!record.workflowRunId) {
      const created = await centaurApi(options, '/api/workflows/runs', {
        method: 'POST',
        body: {
          workflow_name: LAUNCHER_WORKFLOW_NAME,
          idempotency_key: submission.idempotencyKey,
          input: {
            version: 1,
            shape: submission.shape,
            objective: submission.objective,
            slug: submission.slug ?? '',
            requested_by: `slack:${submission.userId}`,
            source: {
              team_id: submission.teamId,
              channel_id: submission.channelId,
              thread_ts: record.cardTs,
              origin_ts: submission.originTs
            },
            idempotency_key: submission.idempotencyKey
          }
        }
      })
      const workflowRunId = stringAt(created, 'run_id')
      if (!workflowRunId) throw new LauncherRequestError('api_missing_workflow_run_id', 502)
      record.workflowRunId = workflowRunId
      record.state = 'queued'
      record.updatedAt = new Date((options.now ?? Date.now)()).toISOString()
      await setRunRecord(options.state, submission.idempotencyKey, record)
      await updateRunCard(options, record)
    }

    const terminal = await pollWorkflow(options, record)
    const resultEnvelope = recordAt(terminal, 'result')
    const resultOutput = recordAt(resultEnvelope, 'output')
    const result = Object.keys(resultOutput).length > 0 ? resultOutput : resultEnvelope
    record.launcherRunId = stringAt(result, 'launcher_run_id') || record.launcherRunId
    record.fleetJobId = stringAt(result, 'fleet_job_id') || record.fleetJobId
    const workflowState = stringAt(terminal, 'status')
    const fleetTerminalState = stringAt(result, 'terminal_state')
    record.state =
      workflowState === 'completed' && fleetTerminalState !== 'failed' ? 'completed' : 'failed'
    record.updatedAt = new Date((options.now ?? Date.now)()).toISOString()
    await updateRunCard(options, record)

    if (!record.terminalReplySent) {
      await slackApi(options, 'chat.postMessage', {
        channel: record.channelId,
        thread_ts: record.cardTs,
        client_msg_id: deterministicUuid(`${submission.idempotencyKey}:terminal`),
        text: terminalReplyText(record)
      })
      record.terminalReplySent = true
    }
    await setRunRecord(options.state, submission.idempotencyKey, record)
    options.logger.info('slack_launcher_run_terminal', {
      fleet_job_id: record.fleetJobId,
      idempotency_key: submission.idempotencyKey,
      launcher_run_id: record.launcherRunId,
      state: record.state,
      workflow_run_id: record.workflowRunId
    })
  } catch (error) {
    if (record?.cardTs) {
      record.state = 'failed'
      record.updatedAt = new Date((options.now ?? Date.now)()).toISOString()
      await updateRunCard(options, record).catch(() => undefined)
      if (!record.terminalReplySent) {
        await slackApi(options, 'chat.postMessage', {
          channel: record.channelId,
          thread_ts: record.cardTs,
          client_msg_id: deterministicUuid(`${submission.idempotencyKey}:terminal`),
          text: terminalReplyText(record)
        })
          .then(() => {
            if (record) record.terminalReplySent = true
          })
          .catch(() => undefined)
      }
      await setRunRecord(options.state, submission.idempotencyKey, record).catch(() => undefined)
    }
    throw error
  } finally {
    clearInterval(refresh)
    try {
      const current = await options.state.get<string>(claimKey)
      if (current === claimToken) await options.state.delete(claimKey)
    } catch {
      // TTL expiry is the crash-safe release path.
    }
  }
}

async function pollWorkflow(
  options: SlackLauncherOptions,
  record: LauncherRunRecord
): Promise<JsonRecord> {
  const startedAt = (options.now ?? Date.now)()
  const maxPollMs = options.maxPollMs ?? DEFAULT_MAX_POLL_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  let runningCardShown = record.state === 'running'
  while ((options.now ?? Date.now)() - startedAt <= maxPollMs) {
    const response = await centaurApi(
      options,
      `/api/workflows/runs/${encodeURIComponent(record.workflowRunId ?? '')}`
    )
    const wrappedRun = recordAt(response, 'run')
    const run = Object.keys(wrappedRun).length > 0 ? wrappedRun : response
    const status = stringAt(run, 'status')
    if (TERMINAL_WORKFLOW_STATES.has(status)) return run
    if (status === 'running' && !runningCardShown) {
      record.state = 'running'
      record.updatedAt = new Date((options.now ?? Date.now)()).toISOString()
      await updateRunCard(options, record)
      runningCardShown = true
    }
    await sleep(pollIntervalMs)
  }
  return { status: 'failed', failure: { code: 'workflow_poll_timeout' } }
}

async function updateRunCard(
  options: SlackLauncherOptions,
  record: LauncherRunRecord
): Promise<void> {
  await slackApi(options, 'chat.update', {
    channel: record.channelId,
    ts: record.cardTs,
    ...runCardPayload(record)
  })
}

function runCardPayload(record: Partial<LauncherRunRecord> & { channelId: string; userId: string }): JsonRecord {
  const state = record.state ?? 'queued'
  const rawShape = record.shape ?? ''
  const shape: LauncherShape = isLauncherShape(rawShape) ? rawShape : 'experiment'
  const shapeInfo = shapeMeta(shape)
  const stateDisplay = {
    claiming: ':large_yellow_circle: Queued',
    queued: ':large_yellow_circle: Queued',
    running: ':large_blue_circle: Running',
    completed: ':white_check_mark: Completed',
    failed: ':x: Failed'
  }[state]
  return {
    text: `Centaur ${shapeInfo.title} ${state}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: shapeInfo.label, emoji: true }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Status*\n${stateDisplay}` },
          {
            type: 'mrkdwn',
            text: `*Workflow run*\n${slackCode(record.workflowRunId)}`
          },
          {
            type: 'mrkdwn',
            text: `*Launcher run*\n${slackCode(record.launcherRunId)}`
          },
          { type: 'mrkdwn', text: `*Fleet job*\n${slackCode(record.fleetJobId)}` }
        ]
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Requested by <@${record.userId}> · shape \`${shape}\` · one terminal reply`
          }
        ]
      }
    ]
  }
}

function terminalReplyText(record: LauncherRunRecord): string {
  const icon = record.state === 'completed' ? '✅' : '❌'
  const launcher = record.launcherRunId ? `\`${record.launcherRunId}\`` : '`unavailable`'
  const fleet = record.fleetJobId ? `\`${record.fleetJobId}\`` : '`unavailable`'
  return `${icon} Launcher run ${launcher} ${record.state}. Fleet job ${fleet}.`
}

async function slackApi(
  options: SlackLauncherOptions,
  method: string,
  body: JsonRecord
): Promise<JsonRecord> {
  const fetcher = options.fetch ?? globalThis.fetch
  const base = (options.slackApiUrl ?? 'https://slack.com/api').replace(/\/+$/, '')
  const response = await fetcher(`${base}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.botToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  })
  const data = await response.json().catch(() => ({}))
  const result = asRecord(data)
  if (!response.ok || result.ok !== true) {
    throw new LauncherRequestError(
      `slack_${method}_${stringAt(result, 'error') || response.status}`,
      response.status
    )
  }
  return result
}

async function centaurApi(
  options: SlackLauncherOptions,
  path: string,
  request: { method?: string; body?: JsonRecord } = {}
): Promise<JsonRecord> {
  const fetcher = options.fetch ?? globalThis.fetch
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`
  const response = await fetcher(`${options.apiUrl.replace(/\/+$/, '')}${path}`, {
    method: request.method ?? 'GET',
    headers,
    body: request.body ? JSON.stringify(request.body) : undefined
  })
  if (!response.ok) {
    throw new LauncherRequestError(`centaur_api_http_${response.status}`, response.status)
  }
  return asRecord(await response.json().catch(() => ({})))
}

function parseInteractionPayload(
  rawBody: string
): { ok: true; payload: JsonRecord } | { ok: false; reason: string } {
  try {
    const payloadText = new URLSearchParams(rawBody).get('payload')
    if (!payloadText) return { ok: false, reason: 'missing_payload' }
    const payload = JSON.parse(payloadText)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'payload_not_object' }
    }
    return { ok: true, payload: payload as JsonRecord }
  } catch {
    return { ok: false, reason: 'malformed_payload' }
  }
}

function parsePrivateMetadata(value: string): LauncherPrivateMetadata | undefined {
  try {
    const metadata = JSON.parse(value) as JsonRecord
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
    const shape = stringAt(metadata, 'shape')
    if (!isLauncherShape(shape)) return undefined
    const team_id = stringAt(metadata, 'team_id')
    const channel_id = stringAt(metadata, 'channel_id')
    if (!team_id || !channel_id) return undefined
    return {
      v: Number(metadata.v) as 1,
      shape,
      team_id,
      channel_id,
      origin_ts: stringAt(metadata, 'origin_ts')
    }
  } catch {
    return undefined
  }
}

export function isLauncherShape(value: string): value is LauncherShape {
  return LAUNCHER_SHAPE_KEYS.has(value)
}

function shapeMeta(shape: LauncherShape): (typeof LAUNCHER_SHAPES)[number] {
  return LAUNCHER_SHAPE_BY_KEY.get(shape) ?? LAUNCHER_SHAPES[0]
}

function truncatePlainText(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, Math.max(max - 1, 1)).trimEnd() + '…'
}

function denyInteraction(
  c: Context,
  options: SlackLauncherOptions,
  interactionType: string,
  dimension: string
): Response {
  options.logger.warn('slack_launcher_interaction_denied', {
    dimension,
    interaction_type: interactionType
  })
  return c.text('forbidden', 403)
}

function scheduleTask(c: Context, promise: Promise<unknown>, options: SlackLauncherOptions): void {
  if (options.schedule) {
    options.schedule(promise)
    return
  }
  try {
    c.executionCtx.waitUntil(promise)
  } catch {
    void promise.catch(() => undefined)
  }
}

function launcherClaimKey(idempotencyKey: string): string {
  return `slackbotv2:launcher:claim:${createHash('sha256').update(idempotencyKey).digest('hex')}`
}

function launcherRecordKey(idempotencyKey: string): string {
  return `slackbotv2:launcher:run:${createHash('sha256').update(idempotencyKey).digest('hex')}`
}

async function getRunRecord(
  state: StateAdapter,
  idempotencyKey: string
): Promise<LauncherRunRecord | undefined> {
  return (await state.get<LauncherRunRecord>(launcherRecordKey(idempotencyKey))) ?? undefined
}

async function setRunRecord(
  state: StateAdapter,
  idempotencyKey: string,
  record: LauncherRunRecord
): Promise<void> {
  await state.set(launcherRecordKey(idempotencyKey), record, RECORD_TTL_MS)
}

function deterministicUuid(value: string): string {
  const chars = createHash('sha256').update(value).digest('hex').slice(0, 32).split('')
  chars[12] = '5'
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16] ?? '0', 16) % 4] ?? '8'
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function safeErrorCode(error: unknown): string {
  if (error instanceof LauncherRequestError) return error.code
  if (error instanceof Error && error.name) return error.name
  return 'unknown_error'
}

function slackCode(value: string | undefined): string {
  return value ? `\`${value}\`` : '_pending_'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(ms, 0)))
}

function isAllowed(value: string, allowlist: readonly string[]): boolean {
  return Boolean(value) && allowlist.includes(value)
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {}
}

function recordAt(value: JsonRecord, key: string): JsonRecord {
  return asRecord(value[key])
}

function arrayAt(value: JsonRecord, key: string): unknown[] {
  return Array.isArray(value[key]) ? value[key] : []
}

function stringAt(value: JsonRecord, key: string): string {
  return typeof value[key] === 'string' ? value[key] : ''
}
