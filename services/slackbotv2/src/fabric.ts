/** Typed cluster delegation on the existing Centaur Slack transport.
 * Reuses the live-proven launcher signature verifier and allowlists. No model
 * sits between a confirmed supported command and the durable intake commit.
 */
import { readFileSync } from 'node:fs'
import { verifySlackRequest } from './launcher'
import type { SlackbotV2Options } from './types'

type Run = { requestId: string; runId: string; state: string; channelId: string; threadTs: string;
  result?: { report?: string; error?: string; checker?: { reason?: string }; terminal?: {
    artifactVerified?: boolean; authorityClosed?: boolean; disposalVerified?: boolean; taskOutcome?: string } } }

export function fabricCommand(raw: string): { payload: Record<string, any>; command: string; requestId?: string } | undefined {
  let payload: Record<string, any>
  try { payload = JSON.parse(raw) } catch { return }
  const event = payload.event
  if (payload.type !== 'event_callback' || event?.type !== 'app_mention' || event.bot_id || event.subtype) return
  const text = String(event.text ?? '').replace(/^<@[A-Z0-9]+>\s*/, '').trim()
  if (!/^fabric(?:\s|$)/i.test(text)) return
  const m = /^fabric\s+(review|status)\s+([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\s*$/i.exec(text)
  return { payload, command: m?.[1]?.toLowerCase() ?? 'unsupported', requestId: m?.[2] }
}

export async function handleFabricWebhook(request: Request, raw: string, options: SlackbotV2Options,
  waitUntil: (promise: Promise<unknown>) => void): Promise<Response | undefined> {
  if (!options.fabricIntakeUrl) return
  const parsed = fabricCommand(raw)
  if (!parsed) return
  const signed = verifySlackRequest({ nowMs: Date.now(), rawBody: raw, signingSecret: options.signingSecret,
    signature: request.headers.get('x-slack-signature') ?? undefined,
    timestamp: request.headers.get('x-slack-request-timestamp') ?? undefined })
  if (!signed.ok) return new Response('invalid request', { status: 401 })
  const { payload, command, requestId } = parsed
  const event = payload.event
  if (!options.launcherAllowedTeamIds?.includes(payload.team_id) ||
      !options.launcherAllowedChannelIds?.includes(event.channel) ||
      !options.launcherAllowedUserIds?.includes(event.user)) return new Response('not allowed', { status: 403 })
  const threadTs = event.thread_ts || event.ts
  const reply = (text: string, ts = threadTs) => slack(options, 'chat.postMessage', {
    channel: event.channel, thread_ts: ts, text, unfurl_links: false, unfurl_media: false })
  if (command === 'unsupported') {
    waitUntil(reply('Supported: `@centaur fabric review <request-id>` or `@centaur fabric status <request-id>`. This pilot only reviews the retained fabric evidence.'))
    return new Response('ok')
  }
  const path = command === 'review' ? '/v1/runs' : `/v1/run?teamId=${encodeURIComponent(payload.team_id)}&requestId=${encodeURIComponent(requestId!)}`
  const result = await intake(options, path, command === 'review' ? {
    requestId, taskType: 'retained-evidence-review', teamId: payload.team_id,
    channelId: event.channel, threadTs, userId: event.user } : undefined)
  if (!result.ok) {
    // Do not acknowledge transient failures: Slack can retry the same event.
    if (result.status >= 500) return new Response('retry', { status: 503 })
    waitUntil(reply(`Fabric request refused: ${String(result.value.error ?? 'unavailable')}.`))
    return new Response('ok')
  }
  const run = result.value as Run & { created?: boolean }
  if (command === 'status' || !run.created) {
    waitUntil(reply(formatRun(run)))
  } else {
    waitUntil(followRun(options, run, payload.team_id).catch(() => {
      options.logger?.warn('fabric_result_delivery_pending', { run_id: run.runId })
    }))
  }
  return new Response('ok')
}

async function intake(options: SlackbotV2Options, path: string, body?: unknown) {
  const token = readFileSync(options.fabricTokenPath ?? '/fabric-identity/token', 'utf8').trim()
  const response = await (options.fetch ?? fetch)(options.fabricIntakeUrl! + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(2400) })
  return { ok: response.ok, status: response.status, value: await response.json() as Record<string, any> }
}

async function slack(options: SlackbotV2Options, method: string, body: unknown) {
  const response = await (options.fetch ?? fetch)((options.slackApiUrl ?? 'https://slack.com/api') + '/' + method, {
    method: 'POST', headers: { Authorization: `Bearer ${options.botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  const value = await response.json() as { ok: boolean; ts?: string }
  if (!response.ok || !value.ok) throw new Error('slack_delivery_failed')
  return value
}

export function formatRun(run: Run): string {
  const lines = [`*Hermes fabric review — ${run.state}*`, `Request: \`${run.requestId}\` · Run: \`${run.runId}\``]
  if (run.result?.terminal) {
    const t = run.result.terminal
    lines.push(`Task: ${t.taskOutcome}. Checked artifact: ${t.artifactVerified === true}. Access closed: ${t.authorityClosed === true}. Resources disposed: ${t.disposalVerified === true}.`)
  }
  if (run.result?.error) lines.push(`Observation: ${run.result.error}`)
  if (run.result?.checker?.reason) lines.push(`Checker: ${run.result.checker.reason}`)
  return lines.join('\n')
}

async function followRun(options: SlackbotV2Options, initial: Run, teamId: string) {
  const card = await slack(options, 'chat.postMessage', { channel: initial.channelId, thread_ts: initial.threadTs,
    text: formatRun(initial), unfurl_links: false, unfurl_media: false })
  const until = Date.now() + 930000
  let last = initial.state
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 5000))
    let result
    try { result = await intake(options, `/v1/run?teamId=${encodeURIComponent(teamId)}&requestId=${encodeURIComponent(initial.requestId)}`) }
    catch { continue }
    if (!result.ok) continue
    const run = result.value as Run
    const terminal = ['COMPLETED', 'FAILED', 'UNKNOWN'].includes(run.state)
    if (run.state !== last || terminal) {
      await slack(options, 'chat.update', { channel: initial.channelId, ts: card.ts, text: formatRun(run) })
      last = run.state
    }
    if (terminal) {
      const report = run.result?.report
      if (report) await slack(options, 'chat.postMessage', { channel: initial.channelId, thread_ts: initial.threadTs,
        text: `${run.state === 'COMPLETED' ? 'Checked result' : 'Retained worker draft; acceptance failed'} for \`${run.runId}\`:\n${report.slice(0, 26000)}`,
        unfurl_links: false, unfurl_media: false })
      return
    }
  }
  await slack(options, 'chat.update', { channel: initial.channelId, ts: card.ts,
    text: `Result delivery needs a status check. Run \`${initial.runId}\` is retained. Use \`@centaur fabric status ${initial.requestId}\`.` })
}
