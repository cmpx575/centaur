/** Thin launch review. Intake computes every value; this file only renders it.
 * Readiness is not authority: Launch sends the sealed request to the same
 * POST /v1/runs, which re-checks everything and refuses if the reviewed
 * execution profile (model + limits) changed since this view was built. */
import { slackText } from './fabric'

export const STATUSES = ['ok', 'missing', 'waiting', 'expired', 'blocked', 'failing', 'unknown', 'n/a'] as const
type Status = typeof STATUSES[number]
export type ReviewCheck = { id: string; status: Status; blocking: boolean; code?: string; text: string }
export type Review = { version: 1; launchable: boolean; state: string; readiness: string
  firstBlocker: { id: string; status: Status; code?: string; text: string } | null
  requestedModel: string; executionProfile: { digest: string; mode: string; model: string }
  placement: { coordination: { cluster: string; node: string; namespace: string; runtime: string } | null
    executor: { kind: string; title: string } | null }
  team: { members: Array<{ role: string; model: string }> }
  limits: Array<{ id: string; label: string; value: string; epoch?: number }>
  destination: { slack: { channelId: string; threadTs: string }; plane?: string | null }
  checks: ReviewCheck[]; warnings: Array<{ code: string; runIds?: string[] }>; observedAt: number }

const plain = (text: string) => ({ type: 'plain_text', text })
const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } })
const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: text.slice(0, 2900) }] })
const str = (v: unknown, max = 2000) => typeof v === 'string' && v.length <= max
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)

/** Strict shape check: an unparseable answer is "Unavailable", never "ready". */
export function parseReview(value: any): Review {
  const r = value?.review
  const ok = r && r.version === 1 && typeof r.launchable === 'boolean' && str(r.state, 64) && str(r.readiness)
    && str(r.requestedModel, 200) && r.executionProfile && hex(r.executionProfile.digest) && str(r.executionProfile.mode, 20)
    && Array.isArray(r.checks) && r.checks.length <= 20 && r.checks.every((c: any) => c && str(c.id, 40)
      && (STATUSES as readonly string[]).includes(c.status) && typeof c.blocking === 'boolean' && str(c.text, 500))
    && Array.isArray(r.limits) && r.limits.length <= 12 && r.limits.every((l: any) => l && str(l.id, 40) && str(l.label, 60) && str(l.value, 400))
    && r.team && Array.isArray(r.team.members) && r.team.members.length <= 6
    && r.team.members.every((m: any) => str(m.role, 100) && str(m.model, 200))
    && r.placement && r.destination?.slack && Array.isArray(r.warnings) && typeof r.observedAt === 'number'
  if (!ok) throw new Error('invalid_review')
  // Readiness is not authority, but a contradictory answer must never show Launch.
  const blocked = r.checks.some((c: ReviewCheck) => c.blocking && c.status !== 'ok')
  if (r.launchable === blocked || value.ready !== r.launchable) throw new Error('inconsistent_review')
  return r as Review
}

const mark = (c: ReviewCheck) => c.status === 'ok' ? '✅' : c.status === 'n/a' ? '➖' : c.blocking ? '⛔' : '⚠️'
const word = (c: ReviewCheck) => c.status === 'ok' ? 'OK' : c.status === 'n/a' ? 'n/a' : c.status.toUpperCase()
const time = (epoch: number) => new Date(epoch * 1000).toISOString().slice(11, 19) + ' UTC'
const date = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

export type ReviewSummary = { recipeTitle: string; version: string; profileTitle: string; setupTitle?: string; planeUrl: string }

export function reviewBlocks(review: Review, summary: ReviewSummary) {
  const where = review.placement.coordination
  const banner = review.launchable
    ? `*Eligible to attempt* — every blocking check passed at ${time(review.observedAt)}. Launch re-checks everything and uses one slot.`
    : `*Not launchable:* ${slackText(review.firstBlocker?.text ?? review.readiness)}${review.firstBlocker?.code ? ` (\`${review.firstBlocker.code}\`)` : ''}`
  return [
    section(banner),
    section(`*What:* ${slackText(summary.recipeTitle)} ${slackText(summary.version)} · ${slackText(summary.profileTitle)}`
      + (summary.setupTitle ? ` · ${slackText(summary.setupTitle)}` : '') + `\n*Item:* ${slackText(summary.planeUrl)}`),
    section(`*Where:* ${where ? `${slackText(where.cluster)} · ${slackText(where.node)} · ${slackText(where.namespace)} · ${slackText(where.runtime)}` : 'no Linux coordination'}`
      + (review.placement.executor ? `\n*Executor:* ${slackText(review.placement.executor.title)}` : '')),
    section(`*Who (requested model ${slackText(review.requestedModel)}):* `
      + review.team.members.map(m => `${slackText(m.role)} (${slackText(m.model)})`).join(' → ')),
    section('*Limits*\n' + review.limits.map(l => `• ${slackText(l.label)}: ${slackText(l.value)}${l.epoch ? ' ' + date(l.epoch) : ''}`).join('\n')),
    section(`*Destination:* this thread${review.destination.plane ? ' and the Plane item' : ''}`),
    section('*Checks*\n' + review.checks.map(c => `${mark(c)} ${slackText(c.id)}: ${word(c)} — ${slackText(c.text)}`).join('\n')),
    ...(review.warnings.length ? [section('*Warnings*\n' + review.warnings.map(w =>
      `⚠️ ${slackText(w.code)}${w.runIds?.length ? ': ' + w.runIds.map(slackText).join(', ') : ''}`).join('\n'))] : []),
    context(`Checked ${time(review.observedAt)} · profile \`${review.executionProfile.digest.slice(0, 12)}\` (${slackText(review.executionProfile.mode)}) · models are the requested route; the upstream identity is not observed.`)
  ]
}

export function reviewView(review: Review, summary: ReviewSummary, metadata: string, callbackId: string) {
  return { type: 'modal', callback_id: callbackId, title: plain('Review launch'), close: plain('Back'),
    ...(review.launchable ? { submit: plain('Launch') } : {}), private_metadata: metadata,
    blocks: reviewBlocks(review, summary) }
}

export function launchedView(run: { runId?: string; requestId?: string; state?: string }, replay: boolean) {
  return { type: 'modal', title: plain('Launched'), close: plain('Done'), clear_on_close: true, blocks: [
    section(`${replay ? 'Already launched' : 'Launched'} as run \`${slackText(String(run.runId ?? 'unknown'))}\` — ${slackText(String(run.state ?? 'QUEUED'))}.`),
    context('Progress and the checked result are posted to this thread and the Plane item.')] }
}

export function refusedView(text: string, code: string) {
  return { type: 'modal', title: plain('Not launched'), close: plain('Done'), clear_on_close: true, blocks: [
    section(`Not launched: ${slackText(text)}`),
    context(`\`${slackText(code)}\` · nothing was reserved and no slot was used. Open the recipe again to review current values.`)] }
}

export function reviewButtonMessage(value: string, summary: ReviewSummary) {
  return { text: 'Review this launch before anything starts.', blocks: [
    section(`*Review launch:* ${slackText(summary.recipeTitle)} · ${slackText(summary.profileTitle)}\n${slackText(summary.planeUrl)}`),
    { type: 'actions', elements: [{ type: 'button', action_id: 'fabric_recipe_review_open', text: plain('Review launch'), value }] },
    context('Only you can use this button. Reviewing starts nothing; Launch in the review starts one run.')] }
}
