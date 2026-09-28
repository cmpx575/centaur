/** Proposal cards (fabric docs/proposals.md): run triage and research intake. The fabric files a
 * proposal; this file only renders it and relays an allowlisted person's
 * decision. Launch is an ordinary POST /v1/runs with the clicker as userId;
 * the intake re-checks the proposal, the offer and every admission rule and
 * refuses rather than substitutes. Nothing here launches on a timer. */
import { createHash } from 'node:crypto'
import { verifySlackRequest } from './launcher'
import { intake, slack, slackText, fabricMessageText } from './fabric'
import { seal, unseal, refusalText } from './fabric-recipes'
import { parseReview, reviewBlocks } from './fabric-launch-review'
import type { SlackbotV2Options } from './types'

export type ProposalCard = { proposalId: string; kind?: string; revision: number; state: string; class: string; title: string; label: string
  facts: string[]; observedAt: number; offer: string[]; planeUrl: string | null; publishedAt: number | null; expiresAt: number | null
  decidedBy: string | null; decisionReason: string | null; runId: string | null; slackTs: string | null
  readiness: { launchable: boolean; firstBlocker: { id: string; code?: string; text: string } | null; observedAt: number } | null }
export type ProposalItem = { id: string; op: 'post' | 'arm' | 'update' | 'info'; channelId: string; createdAt?: number
  card?: ProposalCard; request?: Record<string, string>; info?: { kind: string; runIds: string[]; at: number } }
type Seal = { proposalId: string; revision: number; teamId: string; channelId: string; messageTs: string; request?: Record<string, string> }

const prefix = 'fabric_proposal_'
const plain = (text: string) => ({ type: 'plain_text', text })
const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } })
const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: text.slice(0, 2900) }] })
const when = (epoch?: number | null) => epoch ? new Date(epoch * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'
const TS = /^\d{10}\.\d{6}$/
const REQUEST_FIELDS = ['requestId', 'taskType', 'teamId', 'channelId', 'threadTs', 'planeUrl', 'recipeId', 'recipeVersion',
  'recipeDigest', 'profile', 'expectedProfileDigest', 'proposalId', 'proposalRevision']

const str = (v: unknown, max = 3000) => typeof v === 'string' && v.length <= max
/** Strict shape check: an unexpected item is skipped and left pending, never rendered with buttons. */
export function parseItem(value: any): ProposalItem {
  const ok = value && str(value.id, 200) && ['post', 'arm', 'update', 'info'].includes(value.op) && str(value.channelId, 40)
  if (!ok) throw new Error('invalid_proposal_item')
  if (value.op === 'info') {
    if (!value.info || value.info.kind !== 'quota' || !Array.isArray(value.info.runIds)) throw new Error('invalid_proposal_item')
    return value
  }
  const c = value.card
  if (!c || !/^pr-[0-9a-f]{12}$/.test(c.proposalId) || typeof c.revision !== 'number' || !str(c.state, 20) || !str(c.title, 300)
    || !Array.isArray(c.facts) || !Array.isArray(c.offer) || !str(c.label, 100)) throw new Error('invalid_proposal_card')
  if (value.op === 'arm') {
    const r = value.request
    if (!r || Object.keys(r).some(k => !REQUEST_FIELDS.includes(k)) || REQUEST_FIELDS.some(k => typeof r[k] !== 'string')
      || r.proposalId !== c.proposalId || r.proposalRevision !== String(c.revision) || r.threadTs !== c.slackTs || !TS.test(c.slackTs)
      || r.channelId !== value.channelId) throw new Error('invalid_proposal_request')
  }
  if ((value.op === 'update' || value.op === 'arm') && !TS.test(c.slackTs ?? '')) throw new Error('invalid_proposal_card')
  return value
}

function heading(card: ProposalCard) {
  return section(`*Proposal · ${slackText(card.title)}*\n${slackText(card.label)} · revision ${card.revision}`)
}
function facts(card: ProposalCard) {
  return section(card.facts.map(f => '• ' + slackText(f)).join('\n') || 'No facts recorded.')
}
const RESEARCH = 'research-intake/v1'
function planeLink(card: ProposalCard) {
  const what = card.kind === RESEARCH ? 'the frozen abstract and its provenance are there' : 'all runs and dated facts are listed there'
  return card.planeUrl ? [section(`<${card.planeUrl}|Open the proposal in Plane> · ${what}`)] : []
}

const OUTCOME: Record<string, (c: ProposalCard) => string> = {
  LAUNCHED: c => `*Launched* by <@${c.decidedBy}> as run \`${slackText(c.runId ?? '')}\`. Progress and the checked result follow in this thread.`,
  SETTLED: c => `*Diagnosis finished* (run \`${slackText(c.runId ?? '')}\`). The review is settled; the incident stays open until an operator verifies closure of the runs above.`,
  DISMISSED: c => `*Dismissed* by <@${c.decidedBy}>${c.decisionReason ? ': ' + slackText(c.decisionReason) : ''}. This card can no longer launch.`,
  SNOOZED: c => `*Snoozed* by <@${c.decidedBy}>. New runs of this incident stay quiet for 7 days.`,
  EXPIRED: c => `*Expired unanswered.* To offer it again: \`@centaur fabric proposals reoffer ${c.proposalId}\``,
  SUPERSEDED: c => `*Superseded* by revision ${c.revision + 1} (new evidence). Use the newer card.`
}
/** Research intake ("a paper a day"): the same states, with paper wording; the verdict is a plain reply in this thread. */
const RESEARCH_OUTCOME: Record<string, (c: ProposalCard) => string> = {
  SETTLED: c => `*Assessment finished* (run \`${slackText(c.runId ?? '')}\`). Reply in this thread with one of: `
    + '*Pursue this proof* / *Useful, skip* / *Off-target* / *Can\'t judge*, plus one sentence. The assessment authorizes nothing downstream.',
  SNOOZED: c => `*Snoozed* by <@${c.decidedBy}>. This paper is not offered again.`,
  SUPERSEDED: c => `*Superseded* by revision ${c.revision + 1} (the offer changed). Use the newer card.`
}
const outcome = (card: ProposalCard) => (card.kind === RESEARCH && RESEARCH_OUTCOME[card.state]) || OUTCOME[card.state]

/** Unarmed (post), armed (arm, with sealed buttons) or closed (update) card blocks. */
export function proposalMessage(item: ProposalItem, secret?: string) {
  const card = item.card!
  const text = `Proposal · ${card.title}`
  if (item.op === 'post') return { text, blocks: [heading(card), facts(card), context('Preparing — checking readiness before the Launch button appears…')] }
  if (item.op === 'update') return { text: `${text} — ${card.state}`, blocks: [heading(card), facts(card),
    section((outcome(card) ?? (() => `State: ${slackText(card.state)}`))(card)), ...planeLink(card)] }
  const readiness = card.readiness
  const base: Seal = { proposalId: card.proposalId, revision: card.revision, teamId: String(item.request!.teamId), channelId: item.channelId, messageTs: String(card.slackTs) }
  const launchValue = seal({ ...base, request: item.request }, secret!)
  const small = seal(base, secret!)
  if (launchValue.length > 2000 || small.length > 2000) throw new Error('proposal_seal_too_large')
  const launchable = readiness?.launchable === true
  const buttons = [
    ...(launchable ? [{ type: 'button', style: 'primary', action_id: prefix + 'launch', text: plain('Launch'), value: launchValue }] : []),
    { type: 'button', action_id: prefix + 'details', text: plain('Details'), value: launchValue },
    { type: 'button', action_id: prefix + 'dismiss', text: plain('Dismiss…'), value: small },
    { type: 'button', action_id: prefix + 'snooze', text: plain('Snooze 7 days'), value: small },
    ...(!launchable ? [{ type: 'button', action_id: prefix + 'refresh', text: plain('Refresh'), value: small }] : [])]
  return { text, blocks: [heading(card), facts(card), section(card.offer.map(slackText).join('\n')),
    ...(!launchable ? [section(`*Not launchable now:* ${slackText(readiness?.firstBlocker?.text ?? 'readiness unavailable')}`
      + (readiness?.firstBlocker?.code ? ` (\`${slackText(readiness.firstBlocker.code)}\`)` : ''))] : []),
    ...planeLink(card),
    { type: 'actions', elements: buttons },
    context(`Checked ${when(readiness?.observedAt)} · offer expires ${when(card.expiresAt)} · Launch starts one run as you; the intake re-checks everything. `
      + 'Edits to the Plane item after this card are not used. Pause all proposals: `@centaur fabric proposals pause`')] }
}

function quotaMessage(item: ProposalItem, teamId: string, secret: string) {
  const value = seal({ kind: 'quota', teamId, channelId: item.channelId }, secret)
  return { text: 'Shared model quota exhausted; proposals paused', blocks: [
    section(`*Shared model quota exhausted; proposals are paused.*\nRuns that hit the usage limit: ${item.info!.runIds.map(r => '`' + slackText(r) + '`').join(', ')}`),
    { type: 'actions', elements: [{ type: 'button', action_id: prefix + 'resume', text: plain('Resume proposals'), value }] },
    context('No model run is proposed for a usage-limit failure. Resume records these runs as acknowledged; a new failure pauses again.')] }
}

function clientMessageId(id: string) {
  const hash = createHash('sha256').update('proposal:' + id).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

async function history(options: SlackbotV2Options, channel: string, oldest: number) {
  const body = new URLSearchParams({ channel, limit: '100', include_all_metadata: 'true', oldest: String(Math.max(0, Math.floor(oldest))) })
  const response = await (options.fetch ?? fetch)((options.slackApiUrl ?? 'https://slack.com/api') + '/conversations.history', {
    method: 'POST', headers: { Authorization: `Bearer ${options.botToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), signal: AbortSignal.timeout(10000) })
  const value = await response.json() as { ok: boolean; messages?: Array<{ ts: string; metadata?: { event_type?: string; event_payload?: any } }> }
  if (!response.ok || !value.ok) throw new Error('slack_history_unavailable')
  return value.messages ?? []
}

/** Post-then-arm. A post whose ts was lost is found again in channel history before any second post. */
export async function drainProposals(options: SlackbotV2Options): Promise<void> {
  const pending = await intake(options, '/v1/proposals')
  if (!pending.ok) throw new Error('fabric_proposals_unavailable')
  for (const raw of (pending.value.items ?? []) as unknown[]) {
    let item: ProposalItem
    try { item = parseItem(raw) } catch { options.logger?.warn('fabric_proposal_item_invalid'); continue }
    if (!options.launcherAllowedChannelIds?.includes(item.channelId)) throw new Error('fabric_proposal_outside_allowlist')
    let ts: string
    if (item.op === 'post' || item.op === 'info') {
      const message = item.op === 'post' ? proposalMessage(item) : quotaMessage(item, options.launcherAllowedTeamIds?.[0] ?? '', options.signingSecret)
      const seen = (await history(options, item.channelId, (item.createdAt ?? 0) - 300))
        .find(m => m.metadata?.event_type === 'fabric_proposal' && m.metadata.event_payload?.outboxId === item.id)
      if (seen) ts = seen.ts
      else {
        const sent = await slack(options, 'chat.postMessage', { channel: item.channelId, ...message, client_msg_id: clientMessageId(item.id),
          metadata: { event_type: 'fabric_proposal', event_payload: { outboxId: item.id, proposalId: item.card?.proposalId ?? 'quota' } },
          unfurl_links: false, unfurl_media: false })
        if (!sent.ts) throw new Error('fabric_proposal_unverified')
        ts = sent.ts
      }
    } else {
      ts = item.card!.slackTs!
      await slack(options, 'chat.update', { channel: item.channelId, ts, ...proposalMessage(item, options.signingSecret) })
    }
    const ack = await intake(options, '/v1/proposals/ack', { id: item.id, receipt: ts })
    if (!ack.ok) throw new Error('fabric_proposal_ack_pending')
  }
}

export function startProposalPoller(options: SlackbotV2Options, everyMs = 30000): () => void {
  if (!options.fabricIntakeUrl) return () => {}
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    try { await drainProposals(options) }
    catch { options.logger?.warn('fabric_proposal_delivery_pending') }
    if (!stopped) { timer = setTimeout(tick, everyMs); timer.unref?.() }
  }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}

function statusText(value: any) {
  const c = value.controls ?? {}, pilot = value.pilot ?? {}
  const lines = [`*Proposals* — ${value.enabled ? 'enabled' : 'disabled'}${c.paused ? ' · *paused*' : ''}${c.quotaLatched ? ' · *quota latched*' : ''}`,
    `Last scan: ${when(c.lastScanAt)}${c.deferredSince ? ` · deferred while busy since ${when(c.deferredSince)}` : ''}`,
    `Pilot: ${pilot.start ? when(pilot.start) + ' → ' + when(pilot.end) : 'not started'} · launches ${pilot.launches ?? 0}/${pilot.budget ?? '?'}`]
  for (const p of (value.proposals ?? []).slice(-5)) lines.push(`• \`${p.proposalId}\` r${p.revision} · ${p.state} · ${slackText(p.title)}`)
  return lines.join('\n')
}
function previewText(value: any) {
  const lines = [`*Proposal preview* (read-only) — backfill since ${slackText(String(value.backfillSince))}`]
  for (const g of value.groups ?? []) lines.push(`• ${slackText(g.label)}: ${slackText(g.title)} — ${g.runIds.map((r: string) => '`' + slackText(r) + '`').join(', ')}${g.launchable ? '' : ' (info only)'}`)
  const excluded = Object.entries(value.excluded ?? {}).map(([k, v]) => `${k} ${(v as string[]).length}`).join(' · ')
  if (excluded) lines.push('Excluded: ' + excluded)
  if ((value.quota ?? []).length) lines.push('Usage-limit runs (never proposed): ' + value.quota.join(', '))
  return lines.join('\n')
}

const PROPOSAL_REFUSALS: Record<string, string> = {
  PROPOSAL_CLOSED: 'This proposal was dismissed, snoozed, expired or already launched.',
  PROPOSAL_SUPERSEDED: 'New evidence replaced this proposal. Use the newer card.',
  PROPOSAL_MISMATCH: 'This button no longer matches the proposal. Nothing started.',
  PROPOSAL_BINDING_MISMATCH: 'This launch is not bound to its proposal. Nothing started.',
  PROPOSALS_PAUSED: 'Proposals are paused. `@centaur fabric proposals resume` (or Resume on the quota card) first.',
  PROPOSAL_PILOT_ENDED: 'The proposal pilot window has ended.',
  PROPOSAL_BUDGET_SPENT: 'The pilot has used all of its proposal launches.',
  PROPOSAL_RUN_OUTSTANDING: 'Another proposal run is still active or not verified closed.',
  PROPOSAL_NOT_EXPIRED: 'Only an expired proposal can be offered again.',
  PROPOSAL_PENDING_LIMIT: 'Another proposal is already open.',
  PROPOSAL_NOT_FOUND: 'No such proposal.'
}
export function proposalRefusal(code: string) {
  return PROPOSAL_REFUSALS[code] ? `${PROPOSAL_REFUSALS[code]} (${code})` : refusalText(code)
}

/** Buttons, the dismiss modal and `fabric proposals …` mentions. Returns undefined when not ours. */
export async function handleProposalWebhook(request: Request, raw: string, options: SlackbotV2Options,
  waitUntil: (promise: Promise<unknown>) => void): Promise<Response | undefined> {
  if (!options.fabricIntakeUrl) return
  let payload: any
  try { payload = JSON.parse(raw.startsWith('payload=') ? new URLSearchParams(raw).get('payload')! : raw) } catch { return }
  const event = payload.event, action = payload.actions?.[0]
  const text = fabricMessageText(event?.text)
  const mention = payload.type === 'event_callback' && event?.type === 'app_mention' && !event.bot_id && !event.subtype
    && /^fabric\s+proposals(?:\s|$)/i.test(text)
  const button = payload.type === 'block_actions' && typeof action?.action_id === 'string' && action.action_id.startsWith(prefix)
  const dismissSubmit = payload.type === 'view_submission' && payload.view?.callback_id === prefix + 'dismiss_submit'
  if (!mention && !button && !dismissSubmit) return
  const signed = verifySlackRequest({ nowMs: Date.now(), rawBody: raw, signingSecret: options.signingSecret,
    signature: request.headers.get('x-slack-signature') ?? undefined, timestamp: request.headers.get('x-slack-request-timestamp') ?? undefined })
  if (!signed.ok) return new Response('invalid request', { status: 401 })
  const teamId = payload.team_id ?? payload.team?.id, userId = event?.user ?? payload.user?.id
  // Allowlist-bound, not requester-bound: any allowlisted person may decide; the clicker is recorded.
  if (!options.launcherAllowedTeamIds?.includes(teamId) || !options.launcherAllowedUserIds?.includes(userId)) return new Response('not allowed', { status: 403 })
  const who = (channelId: string) => ({ teamId, channelId, userId })

  if (mention) {
    const channelId = event.channel
    if (!options.launcherAllowedChannelIds?.includes(channelId)) return new Response('not allowed', { status: 403 })
    const reply = (message: string) => slack(options, 'chat.postMessage', { channel: channelId, thread_ts: event.thread_ts || event.ts,
      text: message, unfurl_links: false, unfurl_media: false })
    const m = /^fabric\s+proposals(?:\s+(scan|pause|resume|preview|reoffer)(?:\s+(pr-[0-9a-f]{12}))?)?\s*$/i.exec(text)
    if (!m || (m[1]?.toLowerCase() === 'reoffer' && !m[2])) {
      waitUntil(reply('Use `@centaur fabric proposals` (status), `… proposals preview`, `… proposals scan`, `… proposals pause|resume` or `… proposals reoffer <id>`.'))
      return new Response('ok')
    }
    const verb = m[1]?.toLowerCase()
    const query = new URLSearchParams(who(channelId))
    let result
    try {
      result = !verb ? await intake(options, '/v1/proposals/status?' + query)
        : verb === 'preview' ? await intake(options, '/v1/proposals/preview?' + query)
        : verb === 'scan' ? await intake(options, '/v1/proposals/scan', who(channelId))
        : await intake(options, '/v1/proposals/decision', { ...who(channelId), decision: verb, ...(m[2] ? { proposalId: m[2] } : {}) })
    } catch { return new Response('retry', { status: 503 }) }
    if (!result.ok) {
      if (result.status >= 500) return new Response('retry', { status: 503 })
      waitUntil(reply('Not done: ' + proposalRefusal(String(result.value.error ?? 'unavailable'))))
      return new Response('ok')
    }
    const v = result.value
    waitUntil(reply(!verb ? statusText(v) : verb === 'preview' ? previewText(v)
      : verb === 'scan' ? `Scan requested. The next idle factory loop scans${v.enabled ? '' : ' (proposals are disabled, so nothing is filed)'}. At most one new proposal a day.`
      : verb === 'reoffer' ? `Offered again as revision ${v.revision}; a new card follows.`
      : `Proposals ${verb === 'pause' ? 'paused' : 'resumed'}.`))
    return new Response('ok')
  }

  let sealed: any
  try {
    sealed = unseal(dismissSubmit ? payload.view.private_metadata : action.value, options.signingSecret)
    if (!sealed || sealed.teamId !== teamId || typeof sealed.channelId !== 'string') throw new Error('invalid_seal')
  } catch { return new Response('invalid view', { status: 403 }) }
  const channelId = dismissSubmit ? sealed.channelId : payload.channel?.id
  if (sealed.channelId !== channelId || !options.launcherAllowedChannelIds?.includes(channelId)) return new Response('not allowed', { status: 403 })
  const ephemeral = (message: string) => slack(options, 'chat.postEphemeral', { channel: channelId, user: userId, text: message })

  if (button && action.action_id === prefix + 'resume') {
    if (sealed.kind !== 'quota') return new Response('invalid view', { status: 403 })
    const result = await intake(options, '/v1/proposals/decision', { ...who(channelId), decision: 'quota-resume' }).catch(() => undefined)
    if (!result || result.status >= 500) return new Response('retry', { status: 503 })
    waitUntil(result.ok
      ? slack(options, 'chat.update', { channel: channelId, ts: payload.message?.ts, text: 'Proposals resumed',
          blocks: [section(`*Proposals resumed* by <@${userId}>. The usage-limit runs are recorded as acknowledged; a new failure pauses again.`)] })
      : ephemeral('Not done: ' + proposalRefusal(String(result.value.error))))
    return new Response('ok')
  }
  // Every card button is bound to the exact message it was sealed into.
  if (!/^pr-[0-9a-f]{12}$/.test(sealed.proposalId ?? '') || typeof sealed.revision !== 'number' || !TS.test(sealed.messageTs ?? '')
    || (button && (payload.message?.ts !== sealed.messageTs || (payload.container?.message_ts && payload.container.message_ts !== sealed.messageTs))))
    return new Response('not allowed', { status: 403 })

  if (dismissSubmit) {
    if (sealed.userId !== userId) return new Response('not allowed', { status: 403 })
    const reason = String(payload.view.state?.values?.reason?.text?.value ?? '').trim().slice(0, 300)
    const result = await intake(options, '/v1/proposals/decision', { ...who(channelId), decision: 'dismiss',
      proposalId: sealed.proposalId, revision: sealed.revision, ...(reason ? { reason } : {}) }).catch(() => undefined)
    if (!result || result.status >= 500) return Response.json({ response_action: 'errors', errors: { reason: "Couldn't reach the intake. Nothing changed; try again." } })
    if (!result.ok) return Response.json({ response_action: 'errors', errors: { reason: proposalRefusal(String(result.value.error)) } })
    return Response.json({ response_action: 'clear' })
  }
  const base = { ...who(channelId), proposalId: sealed.proposalId, revision: sealed.revision }
  switch (action.action_id) {
    case prefix + 'launch': {
      const req = sealed.request
      if (!req || req.proposalId !== sealed.proposalId || req.threadTs !== sealed.messageTs || req.channelId !== channelId) return new Response('invalid view', { status: 403 })
      // The clicker is the requester. Nothing is shown as launched before the intake commits.
      let result
      try { result = await intake(options, '/v1/runs', { ...req, userId }) }
      catch {
        waitUntil(ephemeral("Couldn't reach the intake, so nothing is known to have started. Press Launch again: a launch that did commit is replayed, never doubled."))
        return new Response('ok')
      }
      if (result.status >= 500) {
        waitUntil(ephemeral('The intake is unavailable. Nothing started; press Launch again in a moment.'))
        return new Response('ok')
      }
      waitUntil(ephemeral(result.ok ? `${result.value.created === false ? 'Already launched' : 'Launched'} as run \`${slackText(String(result.value.runId))}\`. Progress and the checked result follow in this thread and the Plane item.`
        : 'Not launched: ' + proposalRefusal(String(result.value.error ?? 'unavailable'))))
      return new Response('ok')
    }
    case prefix + 'details': {
      if (!sealed.request) return new Response('invalid view', { status: 403 })
      let view: any
      try {
        const answer = await intake(options, '/v1/launch-readiness', { ...sealed.request, userId })
        if (!answer.ok) throw new Error(String(answer.value.error ?? 'unavailable'))
        const review = parseReview(answer.value), recipe = answer.value.recipe ?? {}
        // Read-only: Details never launches; the card's Launch is the one action.
        view = { type: 'modal', title: plain('Proposal details'), close: plain('Close'), blocks: [
          ...reviewBlocks(review, { recipeTitle: String(recipe.title ?? 'Recipe'), version: String(recipe.version ?? ''),
            profileTitle: String(recipe.profileTitle ?? ''), planeUrl: String(sealed.request.planeUrl) }),
          context('Read-only. Use Launch on the card to start the run.')] }
      } catch (error) {
        view = { type: 'modal', title: plain('Proposal details'), close: plain('Close'), blocks: [
          section('Details are unavailable: ' + slackText(proposalRefusal(String((error as Error).message)))), context('Nothing was started.')] }
      }
      waitUntil(slack(options, 'views.open', { trigger_id: payload.trigger_id, view }))
      return new Response('ok')
    }
    case prefix + 'dismiss': {
      const metadata = seal({ ...sealed, userId }, options.signingSecret)
      waitUntil(slack(options, 'views.open', { trigger_id: payload.trigger_id, view: { type: 'modal', callback_id: prefix + 'dismiss_submit',
        title: plain('Dismiss proposal'), submit: plain('Dismiss'), close: plain('Back'), private_metadata: metadata, blocks: [
          section('Dismissing closes this card for good: the intake refuses its Launch from now on. New runs of the same incident may be proposed later.'),
          { type: 'input', block_id: 'reason', optional: true, label: plain('Reason (optional)'),
            element: { type: 'plain_text_input', action_id: 'text', max_length: 300 } }] } }))
      return new Response('ok')
    }
    case prefix + 'snooze':
    case prefix + 'refresh': {
      const decision = action.action_id === prefix + 'snooze' ? 'snooze' : 'refresh'
      const result = await intake(options, '/v1/proposals/decision', { ...base, decision }).catch(() => undefined)
      if (!result || result.status >= 500) return new Response('retry', { status: 503 })
      waitUntil(ephemeral(result.ok ? (decision === 'snooze' ? 'Snoozed for 7 days. The card updates shortly.' : 'Readiness is being checked again; the card updates shortly.')
        : 'Not done: ' + proposalRefusal(String(result.value.error))))
      return new Response('ok')
    }
  }
  return new Response('unknown action', { status: 400 })
}
