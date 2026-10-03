/** Public repository reviews and corrections stay in their originating Slack thread. */
import { fabricMessageText, intake, slack } from './fabric'
import { recipeRequest, type Recipe } from './fabric-recipes'
import { verifySlackRequest } from './launcher'
import type { SlackbotV2Options } from './types'

export function githubRepoUrl(text: string): string | undefined {
  const urls = [...text.matchAll(/https:\/\/[^\s<>|]+/g)]
  if (urls.length !== 1) return
  const url = urls[0]![0]
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/?$/.test(url)
    ? url.replace(/\/$/, '') : undefined
}

export async function handleLinksWebhook(request: Request, raw: string, options: SlackbotV2Options,
  waitUntil: (promise: Promise<unknown>) => void): Promise<Response | undefined> {
  if (!options.fabricIntakeUrl) return
  let payload
  try { payload = JSON.parse(raw) } catch { return }
  const event = payload.event
  if (payload.type !== 'event_callback' || event?.type !== 'app_mention' || event.bot_id || event.subtype) return
  const firstLine = fabricMessageText(event.text)
  if (/^fabric(?:\s|$)/i.test(firstLine)) return
  let sourceUrl = githubRepoUrl(firstLine)
  // Invalid/multiple GitHub links must fall through, including inside a review thread.
  if (!sourceUrl && (/https?:\/\/github\.com\b/i.test(String(event.text)) || !event.thread_ts)) return
  const signed = verifySlackRequest({ nowMs: Date.now(), rawBody: raw, signingSecret: options.signingSecret,
    signature: request.headers.get('x-slack-signature') ?? undefined,
    timestamp: request.headers.get('x-slack-request-timestamp') ?? undefined })
  if (!signed.ok) return new Response('invalid request', { status: 401 })
  if (!options.launcherAllowedTeamIds?.includes(payload.team_id) ||
      !options.launcherAllowedChannelIds?.includes(event.channel) ||
      !options.launcherAllowedUserIds?.includes(event.user)) return new Response('not allowed', { status: 403 })
  const origin = { teamId: payload.team_id, channelId: event.channel, threadTs: event.thread_ts || event.ts, userId: event.user }
  const query = new URLSearchParams({ teamId: origin.teamId, channelId: origin.channelId, threadTs: origin.threadTs })
  const reply = (text: string) => slack(options, 'chat.postMessage', { channel: origin.channelId,
    thread_ts: origin.threadTs, text, unfurl_links: false, unfurl_media: false })
  const refused = (error: unknown) => reply(`Fabric request refused: ${String(error ?? 'unavailable').replace(/\s+/g, ' ')}.`)
  let parentRunId: string | undefined
  let threadNote: string | undefined
  try {
    if (!sourceUrl) {
      const thread = await intake(options, '/v1/thread?' + query)
      if (!thread.ok) {
        if (thread.status >= 500) return new Response('retry', { status: 503 })
        waitUntil(refused(thread.value.error)); return new Response('ok')
      }
      const latest = thread.value.latest
      if (!latest || latest.recipeId !== 'repo-fit') return
      threadNote = String(event.text ?? '').trim().replace(/^<@[A-Z0-9]+(?:\|[^>]+)?>\s*/, '').trim()
      if (!latest.finished) {
        waitUntil(reply(threadNote.toLowerCase() === 'stop' ? 'noted; the run finishes and closes' : 'The review is still running.'))
        return new Response('ok')
      }
      if (!threadNote || [...threadNote].length > 500) {
        waitUntil(refused('Thread note must contain 1–500 characters')); return new Response('ok')
      }
      sourceUrl = latest.sourceUrl
      parentRunId = latest.runId
    } else {
      waitUntil(reply(`Read as: a public GitHub repository, ${sourceUrl.slice('https://github.com/'.length)}. Starting a fit review; the card comes back in this thread. Reply here (mention me) to correct it.`))  // not awaited: Slack wants its ack within seconds
    }
    const catalog = await intake(options, '/v1/recipes?' + new URLSearchParams({ teamId: origin.teamId,
      channelId: origin.channelId, userId: origin.userId }))
    if (!catalog.ok) {
      if (catalog.status >= 500) return new Response('retry', { status: 503 })
      waitUntil(refused(catalog.value.error)); return new Response('ok')
    }
    const recipe = (catalog.value.recipes as Recipe[]).find(r => r.id === 'repo-fit')
    if (!recipe) { waitUntil(refused('repo-fit is unavailable')); return new Response('ok') }
    const { planeUrl: _planeUrl, ...run } = recipeRequest(recipe, recipe.defaultProfile, '', origin, payload.event_id ?? event.ts)
    const result = await intake(options, '/v1/runs', { ...run, sourceUrl,
      ...(parentRunId ? { parentRunId, threadNote } : {}) })
    if (!result.ok) {
      if (result.status >= 500) return new Response('retry', { status: 503 })
      waitUntil(refused(result.value.error))
    } else if (parentRunId) {
      waitUntil(reply('Starting a follow-up review with your note; the new card comes back here.'))
    }
    return new Response('ok')
  } catch { return new Response('retry', { status: 503 }) }
}
