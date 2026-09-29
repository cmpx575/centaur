/** Retry-until-accepted programs (fabric docs/shapes.md). The fabric's code decides every next attempt;
 * this file only adds a Stop button to attempt cards and relays an allowlisted person's Stop. Stop skips
 * the next attempt; a running attempt finishes and closes as usual. */
import { verifySlackRequest } from './launcher'
import { intake, slack } from './fabric'
import { seal, unseal } from './fabric-recipes'
import type { SlackbotV2Options } from './types'

export type Program = { programId: string; attempt: number; maxAttempts: number; state: string; outcome?: string | null
  stoppable?: boolean; final?: boolean }
export const STOP_ACTION = 'fabric_program_stop'
const PROGRAM_ID = /^pg-[0-9a-f]{16}$/

/** Sealed to the thread's channel so a copied button cannot stop another channel's program. */
export function stopButton(program: Program, channelId: string, secret: string) {
  return { type: 'button', action_id: STOP_ACTION, style: 'danger', text: { type: 'plain_text', text: `Stop (skip attempt ${program.attempt + 1})` },
    value: seal({ programId: program.programId, channelId }, secret),
    confirm: { title: { type: 'plain_text', text: 'Skip the next attempt?' },
      text: { type: 'mrkdwn', text: 'No further attempt starts. A running attempt finishes and closes as usual.' },
      confirm: { type: 'plain_text', text: 'Stop' }, deny: { type: 'plain_text', text: 'Keep going' } } }
}

export function stopRefusal(code: string) {
  const reasons: Record<string, string> = {
    PROGRAM_ENDED: 'the retry has already ended.',
    PROGRAM_NO_NEXT_ATTEMPT: 'this is the last attempt; there is nothing left to skip.',
    PROGRAM_NOT_FOUND: 'this retry is not in this channel.',
    OUTSIDE_ALLOWLIST: 'you are not on the allowlist.'
  }
  return (reasons[code] ?? 'the fabric refused it.') + ` (${code})`
}

export async function handleProgramWebhook(request: Request, raw: string, options: SlackbotV2Options,
  waitUntil: (promise: Promise<unknown>) => void): Promise<Response | undefined> {
  if (!options.fabricIntakeUrl) return
  let payload: any
  try { payload = JSON.parse(raw.startsWith('payload=') ? new URLSearchParams(raw).get('payload')! : raw) } catch { return }
  const action = payload.actions?.[0]
  if (payload.type !== 'block_actions' || action?.action_id !== STOP_ACTION) return
  const signed = verifySlackRequest({ nowMs: Date.now(), rawBody: raw, signingSecret: options.signingSecret,
    signature: request.headers.get('x-slack-signature') ?? undefined, timestamp: request.headers.get('x-slack-request-timestamp') ?? undefined })
  if (!signed.ok) return new Response('invalid request', { status: 401 })
  const teamId = payload.team?.id ?? payload.team_id, userId = payload.user?.id, channelId = payload.channel?.id
  if (!options.launcherAllowedTeamIds?.includes(teamId) || !options.launcherAllowedUserIds?.includes(userId)
    || !options.launcherAllowedChannelIds?.includes(channelId)) return new Response('not allowed', { status: 403 })
  let sealed: any
  try {
    sealed = unseal(action.value, options.signingSecret)
    if (!sealed || sealed.channelId !== channelId || !PROGRAM_ID.test(String(sealed.programId))) throw new Error('invalid_seal')
  } catch { return new Response('invalid action', { status: 403 }) }
  let result
  try { result = await intake(options, '/v1/programs/stop', { programId: sealed.programId, teamId, channelId, userId }) }
  catch { return new Response('retry', { status: 503 }) }
  if (!result.ok && result.status >= 500) return new Response('retry', { status: 503 })
  const text = result.ok
    ? `Stop requested by <@${userId}>: attempt ${Number(result.value.attempt) + 1} will not start. A running attempt finishes and closes as usual.`
    : `Stop not applied: ${stopRefusal(String(result.value.error ?? 'unavailable'))}`
  waitUntil(slack(options, 'chat.postMessage', { channel: channelId, thread_ts: payload.message?.thread_ts ?? payload.message?.ts,
    text, unfurl_links: false, unfurl_media: false }))
  return new Response('ok')
}
