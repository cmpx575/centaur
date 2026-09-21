/** Typed cluster delegation on the existing Centaur Slack transport.
 * Reuses the live-proven launcher signature verifier and allowlists. No model
 * sits between a confirmed supported command and the durable intake commit.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { verifySlackRequest } from './launcher'
import type { SlackbotV2Options } from './types'
import { handleRecipeWebhook } from './fabric-recipes'
import { parseWorkSetup, setupRuntimeTitle, workSetupBlocks, type WorkSetup } from './fabric-work-setup'

export type Run = { requestId: string; runId: string; state: string; channelId: string; threadTs: string; planeUrl?: string;
  view?: { title: string; status: string; nextAction: string; closure: string; checked: boolean; closed: boolean };
  recipe?: { title: string; version: string; profileTitle: string; planDigest: string; roles: string[]; workSetup?: WorkSetup };
  context?: { sources: Array<{name: string}>; packetDigest: string; coverage: string };
  result?: { report?: string; error?: string; checker?: { reason?: string }; terminal?: {
    artifactVerified?: boolean; authorityClosed?: boolean; disposalVerified?: boolean; taskOutcome?: string } } }

/** Only the first line is a command; connector attribution is never task input. */
export function fabricMessageText(value: unknown): string {
  return String(value ?? '').replace(/[\u200B-\u200D\u2060\u2063\uFEFF]/g, '').trim().split('\n')[0]!
    .replace(/^<@[A-Z0-9]+(?:\|[^>]+)?>\s*/, '')
    .replace(/\s+\*?Sent using\*?\s+.*$/i, '').trim()
}

export function fabricCommand(raw: string): { payload: Record<string, any>; command: string; requestId?: string; planeUrl?: string } | undefined {
  let payload: Record<string, any>
  try { payload = JSON.parse(raw) } catch { return }
  const event = payload.event
  if (payload.type !== 'event_callback' || event?.type !== 'app_mention' || event.bot_id || event.subtype) return
  // The connector appends an attribution footer. Only the first line is a
  // typed verb and identifier; subsequent text never becomes a task prompt or authority.
  const text = fabricMessageText(event.text)
  if (!/^fabric(?:\s|$)/i.test(text)) return
  const m = /^fabric\s+(review|status)\s+([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})(?![a-zA-Z0-9._-])/i.exec(text)
  const link = text.match(/(?:<)?(https:\/\/[^\s<>|]+)(?:\|[^>]+)?(?:>)?/)
  return { payload, command: m?.[1]?.toLowerCase() ?? 'unsupported', requestId: m?.[2], planeUrl: link?.[1] }
}

export async function handleFabricWebhook(request: Request, raw: string, options: SlackbotV2Options,
  waitUntil: (promise: Promise<unknown>) => void): Promise<Response | undefined> {
  if (!options.fabricIntakeUrl) return
  const recipeResponse = await handleRecipeWebhook(request, raw, options, waitUntil)
  if (recipeResponse) return recipeResponse
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

export async function intake(options: SlackbotV2Options, path: string, body?: unknown) {
  const token = readFileSync(options.fabricTokenPath ?? '/fabric-identity/token', 'utf8').trim()
  const response = await (options.fetch ?? fetch)(options.fabricIntakeUrl! + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(2400) })
  return { ok: response.ok, status: response.status, value: await response.json() as Record<string, any> }
}

export async function slack(options: SlackbotV2Options, method: string, body: unknown) {
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
  if (run.recipe) lines.push(`Recipe: *${run.recipe.title}* ${run.recipe.version} · *${run.recipe.profileTitle}*`,
    `Team: ${run.recipe.roles.join(' → ')}`, `Plan: \`${run.recipe.planDigest.slice(0,12)}\``)
  if (run.recipe?.workSetup) {
    const setup = parseWorkSetup(run.recipe.workSetup)
    lines.push(`Work setup: ${setup.title}`, `Method: ${setup.method}`, `Runtime: ${setupRuntimeTitle(setup.runtime)}`)
  }
  if (run.context) lines.push(`Prior work: ${run.context.sources.map(s => s.name).join(', ')}`,
    `Context: \`${run.context.packetDigest.slice(0,12)}\` · ${run.context.coverage}`)
  if (run.result?.terminal) {
    const t = run.result.terminal
    lines.push(`Task: ${t.taskOutcome}. Checked artifact: ${t.artifactVerified === true}. Access closed: ${t.authorityClosed === true}. Resources disposed: ${t.disposalVerified === true}.`)
  }
  if (run.result?.error) lines.push(`Observation: ${run.result.error}`)
  if (run.result?.checker?.reason) lines.push(`Checker: ${run.result.checker.reason}`)
  return lines.join('\n')
}

export const slackText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const plain = (text: string) => ({ type: 'plain_text', text })
const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } })

export function runSummary(run: Run): string {
  if (!run.view) return formatRun(run)
  const setup = run.recipe?.workSetup ? parseWorkSetup(run.recipe.workSetup) : undefined
  return `*${slackText(run.view.title)}* · *${run.view.status}*\n${run.view.nextAction}\n${run.view.closure}${setup ? '\nWork setup: ' + slackText(setup.title) : ''}`
}

export function runActions(run: Run) {
  return { type: 'actions', elements: [
    { type: 'button', action_id: 'fabric_recipe_details', text: plain('View run'), value: run.requestId },
    ...(run.planeUrl ? [{ type: 'button', action_id: 'fabric_recipe_plane', text: plain('Open in Plane'), url: run.planeUrl }] : [])
  ] }
}

export function recentRuns(runs: Run[]) {
  const text = runs.length ? runs.map(r => `${r.view?.title ?? r.recipe?.title ?? 'Evidence review'}: ${r.view?.status ?? r.state}`).join('\n')
    : 'No fabric runs in this channel yet. Choose a recipe to start.'
  return { text, blocks: [section('*Recent work*'),
    ...(runs.length ? runs.flatMap(r => [section(runSummary(r)), runActions(r)]) : [section(text)]),
    { type: 'actions', elements: [
      { type: 'button', action_id: 'fabric_recipe_menu', text: plain('Start work') },
      { type: 'button', action_id: 'fabric_recipe_recent', text: plain('Refresh runs') }
    ] }
  ] }
}

export function runView(run: Run) {
  const report = run.result?.report
  const blocks: Record<string, unknown>[] = [section(runSummary(run)), section(slackText(formatRun(run)).slice(0, 2900)),
    ...(run.recipe?.workSetup ? workSetupBlocks(run.recipe.workSetup) : [])]
  if (report) {
    blocks.push(section(run.view?.checked && run.view?.closed ? '*Checked result*' : '*Worker draft — review the verification above*'))
    for (let i = 0; i < Math.min(report.length, 24000); i += 2400) blocks.push(section(slackText(report.slice(i, i + 2400)).slice(0, 2900)))
  }
  if (run.planeUrl) blocks.push(section(`<${run.planeUrl}|Open the full work item in Plane>`))
  return { type: 'modal', title: plain('Run details'), close: plain('Close'), blocks }
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
    const text = runSummary(run) + (report ? `\n\n${run.state === 'COMPLETED' ? 'Checked result' : 'Unaccepted worker draft'}:\n${slackText(report.slice(0, 600))}` : '')
    const blocks = [section(runSummary(run)),
      ...(run.recipe ? [section(`*${slackText(run.recipe.title)}* · ${slackText(run.recipe.profileTitle)}\n${run.recipe.roles.map(slackText).join(' → ')}`)] : []),
      ...(run.recipe?.workSetup ? [{ type: 'section', text: plain(`Method: ${parseWorkSetup(run.recipe.workSetup).method}\nRuntime: ${setupRuntimeTitle(run.recipe.workSetup.runtime)}`) }] : []),
      ...(run.result?.checker?.reason ? [section('*Checker:* ' + slackText(run.result.checker.reason).slice(0, 1700))] : []),
      ...(report ? [section(`*${run.state === 'COMPLETED' ? 'Result preview' : 'Unaccepted draft preview'}*\n${slackText(report.slice(0, 600))}`)] : []), runActions(run)]
    const hash = createHash('sha256').update(delivery.id).digest('hex')
    const clientMessageId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
    const sent = await slack(options, 'chat.postMessage', { channel: run.channelId, thread_ts: run.threadTs,
      text, blocks, client_msg_id: clientMessageId, unfurl_links: false, unfurl_media: false })
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
