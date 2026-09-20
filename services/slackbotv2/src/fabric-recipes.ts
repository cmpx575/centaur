/** Recipe choices are read from the fabric; this file owns only Slack UX. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { verifySlackRequest } from './launcher'
import { intake, slack, formatRun, fabricMessageText } from './fabric'
import type { SlackbotV2Options } from './types'

export type Recipe = { id: string; version: string; digest: string; title: string; description: string;
  aliases: string[]; taskType: string; defaultProfile: string; roles: string[];
  profiles: Record<string, { title: string; description: string; maxCalls: Record<string, number> }> }
type Origin = { teamId: string; channelId: string; userId: string; threadTs: string }
const plain = (text: string) => ({ type: 'plain_text', text })
const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } })
const prefix = 'fabric_recipe_'

export function recipeMenu(recipes: Recipe[]) {
  return { text: 'Choose a recipe for this work. Each recipe includes its team, context and checks.', blocks: [
    section('*Run work with a recipe*\nChoose a process, link the Plane item, and use its configured team.'),
    ...recipes.flatMap(r => [section(`*${r.title}*\n${r.description}\n${r.roles.join(' → ')}`),
      { type: 'actions', elements: [{ type: 'button', action_id: prefix + 'open', text: plain('Choose how to run'), value: r.id }] }]),
    section('You can also mention `fabric run review focused <Plane-item-link>` or `fabric runs` to return to recent work.')
  ] }
}

export function recipeView(recipe: Recipe, metadata: string) {
  const options = Object.entries(recipe.profiles).map(([value, p]) => ({ text: plain(p.title), value, description: plain(p.description.slice(0,75)) }))
  return { type: 'modal', callback_id: prefix + 'submit', title: plain('Run a recipe'), submit: plain('Run'), close: plain('Back'),
    private_metadata: metadata, blocks: [section(`*${recipe.title}* · ${recipe.version}\n${recipe.description}\n*Team:* ${recipe.roles.join(' → ')}`),
      { type: 'input', block_id: 'plane', label: plain('Plane work item'),
        hint: plain('Use an item from an enabled project. Its objective will guide selection of prior work.'),
        element: { type: 'plain_text_input', action_id: 'url', max_length: 500 } },
      { type: 'input', block_id: 'profile', label: plain('How to run'),
        element: { type: 'static_select', action_id: 'choice', options,
          initial_option: options.find(o => o.value === recipe.defaultProfile) } },
      ...Object.values(recipe.profiles).map(p => section(`*${p.title}:* ${p.description}`)),
      section('The selected sources and team will appear in this thread and the Plane item. Changing mode does not change access.')
    ] }
}

function seal(value: unknown, secret: string) {
  const body = JSON.stringify(value)
  return JSON.stringify({ body, signature: createHmac('sha256', secret).update(body).digest('hex') })
}
function unseal(raw: string, secret: string): any {
  const { body, signature } = JSON.parse(raw)
  if (typeof body !== 'string' || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('invalid_metadata')
  const expected = createHmac('sha256', secret).update(body).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('invalid_metadata')
  return JSON.parse(body)
}

export function recipeRequest(recipe: Recipe, profile: string, planeUrl: string, origin: Origin, eventKey: string) {
  return { ...origin, requestId: 'recipe-' + createHash('sha256').update(origin.teamId + ':' + eventKey).digest('hex').slice(0, 24),
    taskType: recipe.taskType, planeUrl, recipeId: recipe.id, recipeVersion: recipe.version, recipeDigest: recipe.digest, profile }
}

export async function handleRecipeWebhook(request: Request, raw: string, options: SlackbotV2Options,
  waitUntil: (promise: Promise<unknown>) => void): Promise<Response | undefined> {
  if (!options.fabricIntakeUrl) return
  let payload: any
  try { payload = JSON.parse(raw.startsWith('payload=') ? new URLSearchParams(raw).get('payload')! : raw) } catch { return }
  const event = payload.event, action = payload.actions?.[0]
  const text = fabricMessageText(event?.text)
  const mention = payload.type === 'event_callback' && event?.type === 'app_mention' && !event.bot_id && !event.subtype
    && /^fabric\s+(recipes|run|runs)(?:\s|$)/i.test(text)
  const opening = payload.type === 'block_actions' && action?.action_id === prefix + 'open'
  const submission = payload.type === 'view_submission' && payload.view?.callback_id === prefix + 'submit'
  if (!mention && !opening && !submission) return
  const signed = verifySlackRequest({ nowMs: Date.now(), rawBody: raw, signingSecret: options.signingSecret,
    signature: request.headers.get('x-slack-signature') ?? undefined, timestamp: request.headers.get('x-slack-request-timestamp') ?? undefined })
  if (!signed.ok) return new Response('invalid request', { status: 401 })
  let saved: any
  if (submission) {
    try { saved = unseal(payload.view.private_metadata, options.signingSecret) } catch { return new Response('invalid view', { status: 403 }) }
  }
  const origin: Origin = { teamId: payload.team_id ?? payload.team?.id, userId: event?.user ?? payload.user?.id,
    channelId: event?.channel ?? payload.channel?.id ?? saved?.origin.channelId,
    threadTs: event?.thread_ts ?? event?.ts ?? payload.message?.thread_ts ?? payload.message?.ts ?? saved?.origin.threadTs }
  if (!options.launcherAllowedTeamIds?.includes(origin.teamId) || !options.launcherAllowedChannelIds?.includes(origin.channelId)
      || !options.launcherAllowedUserIds?.includes(origin.userId) || (saved && (saved.origin.userId !== origin.userId || saved.origin.teamId !== origin.teamId))) {
    return new Response('not allowed', { status: 403 })
  }
  const query = new URLSearchParams({ teamId: origin.teamId, channelId: origin.channelId, userId: origin.userId })
  const reply = (body: Record<string, unknown>) => slack(options, 'chat.postMessage', { ...body,
    channel: origin.channelId, thread_ts: origin.threadTs, unfurl_links: false, unfurl_media: false })
  if (mention && /^fabric\s+runs\s*$/i.test(text)) {
    const result = await intake(options, '/v1/runs?' + query)
    if (!result.ok) return new Response('retry', { status: result.status >= 500 ? 503 : 403 })
    waitUntil(reply({ text: result.value.runs.length ? result.value.runs.map(formatRun).join('\n\n') : 'No fabric runs in this channel yet. Use `fabric recipes` to start.' }))
    return new Response('ok')
  }
  if (submission) {
    const values = payload.view.state?.values ?? {}
    const profile = values.profile?.choice?.selected_option?.value ?? ''
    const planeUrl = (values.plane?.url?.value ?? '').trim()
    const result = await intake(options, '/v1/runs', recipeRequest(saved.recipe, profile, planeUrl, origin, payload.view.id))
    if (!result.ok) {
      if (result.status >= 500) return new Response('retry', { status: 503 })
      const key = /PROFILE|RECIPE/.test(result.value.error ?? '') ? 'profile' : 'plane'
      return Response.json({ response_action: 'errors', errors: { [key]: `Could not start: ${result.value.error ?? 'unavailable'}.` } })
    }
    return Response.json({ response_action: 'clear' })
  }
  const result = await intake(options, '/v1/recipes?' + query)
  if (!result.ok) return new Response('retry', { status: result.status >= 500 ? 503 : 403 })
  const recipes = result.value.recipes as Recipe[]
  if (opening) {
    const recipe = recipes.find(r => r.id === action.value)
    if (!recipe) return new Response('unknown recipe', { status: 409 })
    await slack(options, 'views.open', { trigger_id: payload.trigger_id,
      view: recipeView(recipe, seal({ origin, recipe: { id: recipe.id, version: recipe.version, digest: recipe.digest, taskType: recipe.taskType } }, options.signingSecret)) })
    return new Response('ok')
  }
  if (/^fabric\s+recipes\s*$/i.test(text)) {
    waitUntil(reply(recipeMenu(recipes)))
    return new Response('ok')
  }
  const match = /^fabric\s+run\s+([a-z0-9-]+)(?:\s+([a-z0-9-]+))?\s+(?:<)?(https:\/\/[^\s<>|]+)(?:\|[^>]+)?(?:>)?\s*$/i.exec(text)
  const recipe = match && recipes.find(r => [r.id, ...r.aliases].includes(match[1]!.toLowerCase()))
  if (!match || !recipe) {
    waitUntil(reply({ text: 'Choose `fabric recipes`, or use `fabric run review focused <Plane-item-link>`.' }))
    return new Response('ok')
  }
  const submitted = await intake(options, '/v1/runs', recipeRequest(recipe, match[2]?.toLowerCase() ?? recipe.defaultProfile, match[3]!, origin, payload.event_id ?? event.ts))
  if (!submitted.ok) {
    if (submitted.status >= 500) return new Response('retry', { status: 503 })
    waitUntil(reply({ text: `Could not start: ${submitted.value.error ?? 'unavailable'}.` }))
  } else if (!submitted.value.created) waitUntil(reply({ text: formatRun(submitted.value as any) }))
  return new Response('ok')
}
