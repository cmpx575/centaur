/** Typed cluster delegation on the existing Centaur Slack transport.
 * Reuses the live-proven launcher signature verifier and allowlists. No model
 * sits between a confirmed supported command and the durable intake commit.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { verifySlackRequest } from './launcher'
import type { SlackbotV2Options } from './types'

type Run = { requestId: string; runId: string; state: string; channelId: string; threadTs: string; planeUrl?: string;
  result?: { report?: string; error?: string; checker?: { reason?: string }; terminal?: {
    artifactVerified?: boolean; authorityClosed?: boolean; disposalVerified?: boolean; taskOutcome?: string } } }

export function fabricCommand(raw: string): { payload: Record<string, any>; command: string; requestId?: string; planeUrl?: string } | undefined {
  let payload: Record<string, any>
  try { payload = JSON.parse(raw) } catch { return }
  const event = payload.event
  if (payload.type !== 'event_callback' || event?.type !== 'app_mention' || event.bot_id || event.subtype) return
  // The connector appends an attribution footer. Only the first line is a
  // typed verb and identifier; subsequent text never becomes a task prompt or authority.
  const text = String(event.text ?? '').replace(/[\u200B-\u200D\u2060\u2063\uFEFF]/g, '').trim().split('\n')[0]!.replace(/^<@[A-Z0-9]+(?:\|[^>]+)?>\s*/, '').trim()
  if (!/^fabric(?:\s|$)/i.test(text)) return
  const m = /^fabric\s+(review|status)\s+([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})(?![a-zA-Z0-9._-])/i.exec(text)
  const link = text.match(/(?:<)?(https:\/\/[^\s<>|]+)(?:\|[^>]+)?(?:>)?/)
  return { payload, command: m?.[1]?.toLowerCase() ?? 'unsupported', requestId: m?.[2], planeUrl: link?.[1] }
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
  const { payload, command, requestId, planeUrl } = parsed
  const event = payload.event
  if (!options.launcherAllowedTeamIds?.includes(payload.team_id) ||
      !options.launcherAllowedChannelIds?.includes(event.channel) ||
      !options.launcherAllowedUserIds?.includes(event.user)) return new Response('not allowed', { status: 403 })
  const threadTs = event.thread_ts || event.ts
  const reply = (text: string, ts = threadTs) => slack(options, 'chat.postMessage', {
    channel: event.channel, thread_ts: ts, text, unfurl_links: false, unfurl_media: false })
  if (command === 'unsupported') {
    waitUntil(reply('Supported: `@centaur fabric review <request-id> <Plane-work-item-link>` or `@centaur fabric status <request-id>`. This service reviews retained fabric evidence against the linked objective.'))
    return new Response('ok')
  }
  const path = command === 'review' ? '/v1/runs' : `/v1/run?teamId=${encodeURIComponent(payload.team_id)}&requestId=${encodeURIComponent(requestId!)}`
  const result = await intake(options, path, command === 'review' ? {
    requestId, taskType: 'retained-evidence-review', teamId: payload.team_id,
    channelId: event.channel, threadTs, userId: event.user, ...(planeUrl ? { planeUrl } : {}) } : undefined)
  if (!result.ok) {
    // Do not acknowledge transient failures: Slack can retry the same event.
    if (result.status >= 500) return new Response('retry', { status: 503 })
    waitUntil(reply(`Fabric request refused: ${String(result.value.error ?? 'unavailable')}.`))
    return new Response('ok')
  }
  const run = result.value as Run & { created?: boolean }
  if (command === 'status' || !run.created) {
    waitUntil(reply(formatRun(run)))
  }
  // New requests are rendered by the durable outbox consumer. The webhook
  // acknowledgement cannot strand result delivery on process restart.
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
  if (run.planeUrl) lines.push(`Plane: ${run.planeUrl}`)
  if (run.result?.terminal) {
    const t = run.result.terminal
    lines.push(`Task: ${t.taskOutcome}. Checked artifact: ${t.artifactVerified === true}. Access closed: ${t.authorityClosed === true}. Resources disposed: ${t.disposalVerified === true}.`)
  }
  if (run.result?.error) lines.push(`Observation: ${run.result.error}`)
  if (run.result?.checker?.reason) lines.push(`Checker: ${run.result.checker.reason}`)
  return lines.join('\n')
}

/** A single consumer uses the existing bot credential; no token is copied to
 * the fabric or workers. Pending obligations live in the fabric ledger.
 * The send/ack gap can repeat a message; it never launches another worker.
 */
export async function drainFabricDeliveries(options: SlackbotV2Options): Promise<void> {
  const pending = await intake(options, '/v1/deliveries')
  if (!pending.ok) throw new Error('fabric_outbox_unavailable')
  for (const delivery of pending.value.deliveries as Array<{ id: string; run: Run }>) {
    const run = delivery.run
    if (!options.launcherAllowedChannelIds?.includes(run.channelId)) throw new Error('fabric_delivery_outside_allowlist')
    const report = run.result?.report
    const text = formatRun(run) + (report ? `\n\n${run.state === 'COMPLETED' ? 'Checked result' : 'Unaccepted worker draft'}:\n${report.slice(0, 26000)}` : '')
    const hash = createHash('sha256').update(delivery.id).digest('hex')
    const clientMessageId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
    const sent = await slack(options, 'chat.postMessage', { channel: run.channelId, thread_ts: run.threadTs,
      text, client_msg_id: clientMessageId, unfurl_links: false, unfurl_media: false })
    if (!sent.ts) throw new Error('fabric_delivery_unverified')
    const ack = await intake(options, '/v1/deliveries/ack', { id: delivery.id, receipt: sent.ts })
    if (!ack.ok) throw new Error('fabric_delivery_ack_pending')
  }
}

export function startFabricDelivery(options: SlackbotV2Options): () => void {
  if (!options.fabricIntakeUrl) return () => {}
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    try { await drainFabricDeliveries(options) }
    catch { options.logger?.warn('fabric_result_delivery_pending') }
    if (!stopped) { timer = setTimeout(tick, 5000); timer.unref?.() }
  }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
