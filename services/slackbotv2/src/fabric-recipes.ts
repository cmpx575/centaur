/** Recipe choices are read from the fabric; this file owns only Slack UX. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { verifySlackRequest } from './launcher'
import { intake, slack, formatRun, fabricMessageText, recentRuns, runView, slackText, type Run } from './fabric'
import type { SlackbotV2Options } from './types'
import { capabilityMessage, capabilityView, parseCapabilityOverview } from './fabric-capabilities'
import { exactResumeUrl, isResumeAction, parseResumeArtifact, parseResumeBrief, parseResumeSelection,
  resumeArtifactView, resumeFeedbackView, resumeHistoryView, resumeMessage, type ResumeSelection } from './fabric-resume'
import { isWorkAction, parseWorkCatalog, parseWorkMenu, parseWorkSelection, selectedWorkUrl, workActionMatches,
  workMenuDigest, workMessage, workNavigation, workOverviewView, workPickerView, workRecipesView, workRecipeView,
  workUnavailableView, type WorkSelection } from './fabric-work'
import { recipeSetups, resolveSetup, setupChoiceFor, setupOptionValue, setupPickerBlock, setupRequestFields,
  workSetupBlocks, type RecipeSetups, type SetupChoice, type WorkSetupRef } from './fabric-work-setup'
import { launchedView, parseReview, refusedView, reviewButtonMessage, reviewView, type ReviewSummary } from './fabric-launch-review'

export type Recipe = RecipeSetups & { id: string; version: string; digest: string; title: string; description: string;
  aliases: string[]; taskType: string; defaultProfile: string; roles: string[];
  profiles: Record<string, { title: string; description: string; maxCalls: Record<string, number> }> }
type Origin = { teamId: string; channelId: string; userId: string; threadTs: string }
const plain = (text: string) => ({ type: 'plain_text', text })
const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } })
const prefix = 'fabric_recipe_'
type WorkMenu = { stale?: boolean; projects: Array<{ name: string; limited?: boolean;
  items: Array<{ name: string; identifier: string; url: string }> }> }
type Availability = { remaining: number; open: boolean; admitUntil: number }

export function recipeMenu(recipes: Recipe[], availability?: Availability) {
  return { text: 'Choose a recipe for this work. Each recipe includes its team, context and checks.', blocks: [
    section('*Start work*\nChoose a recipe, pick the work item, and review how the team will run it.'),
    ...(availability ? [section(availability.open ? `${availability.remaining} runs available in this batch.` : 'This batch cannot start another run. An operator needs to renew its capacity or admission window.')] : []),
    ...recipes.flatMap(r => [section(`*${slackText(r.title)}*\n${slackText(r.description)}\n${r.roles.map(slackText).join(' → ')}${recipeSetups(r) ? '\nDefault setup: ' + slackText(recipeSetups(r)!.selected.title) : ''}`),
      { type: 'actions', elements: [{ type: 'button', action_id: prefix + 'open', text: plain('Choose how to run'), value: r.id }] }]),
    { type: 'actions', elements: [{ type: 'button', action_id: prefix + 'recent', text: plain('Recent work') },
      { type: 'button', action_id: prefix + 'capabilities', text: plain('Capabilities') }] },
    section('You can also mention `fabric launch review focused <Plane-item-link>` for a private review with a Launch button, `fabric run review focused <Plane-item-link>`, `fabric runs`, or `fabric resume <Plane-item-link>` for a read-only work history.')
  ] }
}

type FormValues = { plane?: string; work?: string; profile?: string }
export function recipeView(recipe: Recipe, metadata: string, work?: WorkMenu, setup?: SetupChoice, values: FormValues = {}) {
  const options = Object.entries(recipe.profiles).map(([value, p]) => ({ text: plain(p.title), value, description: plain(p.description.slice(0,75)) }))
  const groups = work?.projects.filter(p => p.items.length).slice(0, 10).map(p => ({ label: plain(p.name.slice(0,75)),
    options: p.items.slice(0,30).map(i => ({ text: plain(`${i.identifier} · ${i.name}`.slice(0,75)), value: i.url })) })) ?? []
  const selectedWork = groups.flatMap(g => g.options).find(o => o.value === values.work)
  const pasted = values.plane || (!selectedWork ? values.work : '')
  const selectedSetup = resolveSetup(recipe, setup?.selected, setup?.catalogDigest)
  return { type: 'modal', callback_id: prefix + (setup?.editing ? 'setup_submit' : 'submit'), title: plain(setup?.editing ? 'Change setup' : 'Start work'),
    submit: plain(setup?.editing ? 'Use setup' : 'Review'), close: plain('Back'),
    private_metadata: metadata, blocks: [section(`*${slackText(recipe.title)}* · ${slackText(recipe.version)}\n${slackText(recipe.description)}\n*Team:* ${recipe.roles.map(slackText).join(' → ')}`),
      ...(groups.length ? [{ type: 'input', block_id: 'work', optional: true, label: plain('Project and work item'),
        hint: plain('Recent items from enabled projects. The latest objective is read when the work starts.'),
        element: { type: 'static_select', action_id: 'item', placeholder: plain('Choose work from Plane'), option_groups: groups,
          ...(selectedWork ? { initial_option: selectedWork } : {}) } }] : []),
      ...(work?.stale ? [section('The item list could not be refreshed. You can paste the current Plane link below.')] : []),
      { type: 'input', block_id: 'plane', optional: groups.length > 0, label: plain(groups.length ? 'Or paste a Plane work-item link' : 'Plane work item'),
        hint: plain('Choose one item above or paste one link. Only enabled projects can run.'),
        element: { type: 'plain_text_input', action_id: 'url', max_length: 500, ...(pasted ? { initial_value: pasted } : {}) } },
      { type: 'input', block_id: 'profile', label: plain('How to run'),
        element: { type: 'static_select', action_id: 'choice', options,
          initial_option: options.find(o => o.value === (values.profile || recipe.defaultProfile)) } },
      ...Object.values(recipe.profiles).map(p => section(`*${slackText(p.title)}:* ${slackText(p.description)}`)),
      ...(selectedSetup ? [...workSetupBlocks(selectedSetup),
        ...(setup?.editing ? [setupPickerBlock(recipe, selectedSetup)] : [{ type: 'actions', elements: [
          { type: 'button', action_id: prefix + 'setup_change', text: plain('Change setup'), value: 'change' }] }]),
        { type: 'section', text: plain('A setup describes the method and available tools for this workflow. It does not add capacity or grant new permissions.') }] : []),
      section('Review shows the model, limits and checks first; nothing starts until you press Launch there. One launch creates one run: Hermes coordinates a separate worker and checker, the outcome returns to this thread and the Plane item, and temporary access and resources close afterward.')
    ] }
}

function formValues(payload: any): FormValues {
  const values = payload.view?.state?.values ?? {}
  const result = { plane: values.plane?.url?.value ?? '', work: values.work?.item?.selected_option?.value ?? '',
    profile: values.profile?.choice?.selected_option?.value ?? '' }
  if (Object.values(result).some(v => typeof v !== 'string')) throw new Error('invalid_form')
  return result
}
function recipeMetadata(origin: Origin, recipe: Recipe, secret: string, setup?: SetupChoice) {
  const value = seal({ origin, recipe: { id: recipe.id, version: recipe.version, digest: recipe.digest, taskType: recipe.taskType },
    ...(setup ? { setup } : {}) }, secret)
  if (value.length > 3000) throw new Error('recipe_metadata_too_large')
  return value
}

export function seal(value: unknown, secret: string) {
  const body = JSON.stringify(value)
  return JSON.stringify({ body, signature: createHmac('sha256', secret).update(body).digest('hex') })
}
export function unseal(raw: string, secret: string): any {
  const { body, signature } = JSON.parse(raw)
  if (typeof body !== 'string' || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('invalid_metadata')
  const expected = createHmac('sha256', secret).update(body).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('invalid_metadata')
  return JSON.parse(body)
}

export function recipeRequest(recipe: Recipe, profile: string, planeUrl: string, origin: Origin, eventKey: string, setup?: WorkSetupRef) {
  const chosen = setup ?? recipeSetups(recipe)?.selected
  return { ...origin, requestId: 'recipe-' + createHash('sha256').update(origin.teamId + ':' + eventKey).digest('hex').slice(0, 24),
    taskType: recipe.taskType, planeUrl, recipeId: recipe.id, recipeVersion: recipe.version, recipeDigest: recipe.digest, profile,
    ...setupRequestFields(chosen) }
}

const LAUNCH_FIELDS = ['requestId', 'taskType', 'teamId', 'channelId', 'threadTs', 'userId', 'planeUrl', 'recipeId', 'recipeVersion',
  'recipeDigest', 'profile', 'workSetupId', 'workSetupVersion', 'workSetupDigest', 'expectedProfileDigest']
function launchRequest(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([k, v]) => !LAUNCH_FIELDS.includes(k) || typeof v !== 'string')) throw new Error('invalid_launch')
  return value as Record<string, string>
}
function summaryFrom(answer: any, planeUrl: string): ReviewSummary {
  const recipe = answer?.recipe ?? {}
  return { recipeTitle: String(recipe.title ?? 'Recipe'), version: String(recipe.version ?? ''), profileTitle: String(recipe.profileTitle ?? ''),
    ...(recipe.workSetup?.title ? { setupTitle: String(recipe.workSetup.title) } : {}), planeUrl }
}
/** One readiness call → a review view whose Launch carries the exact request and the reviewed profile. */
type Built = { unavailable: true } | { refused: string } | { view: ReturnType<typeof reviewView> }
async function buildReview(options: SlackbotV2Options, origin: Origin, request: Record<string, string | undefined>, secret: string): Promise<Built> {
  let answer
  try { answer = await intake(options, '/v1/launch-readiness', request) } catch { return { unavailable: true } }
  if (!answer.ok) return answer.status >= 500 ? { unavailable: true } : { refused: String(answer.value.error ?? 'unavailable') }
  let review
  try { review = parseReview(answer.value) } catch { return { unavailable: true } }
  const summary = summaryFrom(answer.value, request.planeUrl ?? '')
  const launch = { ...request, expectedProfileDigest: review.executionProfile.digest }
  const metadata = seal({ origin, launch }, secret)
  if (metadata.length > 3000) return { unavailable: true }
  return { view: reviewView(review, summary, metadata, prefix + 'launch') }
}

export async function handleRecipeWebhook(request: Request, raw: string, options: SlackbotV2Options,
  waitUntil: (promise: Promise<unknown>) => void): Promise<Response | undefined> {
  if (!options.fabricIntakeUrl) return
  let payload: any
  try { payload = JSON.parse(raw.startsWith('payload=') ? new URLSearchParams(raw).get('payload')! : raw) } catch { return }
  const event = payload.event, action = payload.actions?.[0]
  const text = fabricMessageText(event?.text)
  const mention = payload.type === 'event_callback' && event?.type === 'app_mention' && !event.bot_id && !event.subtype
    && /^fabric\s+(recipes|run|runs|capabilities|resume|work|launch)(?:\s|$)/i.test(text)
  const opening = payload.type === 'block_actions' && action?.action_id === prefix + 'open'
  const resumeNavigation = payload.type === 'block_actions' && isResumeAction(action?.action_id)
  const workNavigationAction = payload.type === 'block_actions' && isWorkAction(action?.action_id)
  const workSubmission = payload.type === 'view_submission' && payload.view?.callback_id === 'fabric_work_submit'
  const navigation = payload.type === 'block_actions' && [prefix+'recent', prefix+'menu', prefix+'details', prefix+'plane', prefix+'capabilities'].includes(action?.action_id)
  const submission = payload.type === 'view_submission' && payload.view?.callback_id === prefix + 'submit'
  const setupChange = payload.type === 'block_actions' && action?.action_id === prefix + 'setup_change'
  const setupSubmission = payload.type === 'view_submission' && payload.view?.callback_id === prefix + 'setup_submit'
  const launchSubmission = payload.type === 'view_submission' && payload.view?.callback_id === prefix + 'launch'
  const reviewOpen = payload.type === 'block_actions' && action?.action_id === prefix + 'review_open'
  if (!mention && !opening && !submission && !navigation && !resumeNavigation && !workNavigationAction && !workSubmission && !setupChange && !setupSubmission
    && !launchSubmission && !reviewOpen) return
  const signed = verifySlackRequest({ nowMs: Date.now(), rawBody: raw, signingSecret: options.signingSecret,
    signature: request.headers.get('x-slack-signature') ?? undefined, timestamp: request.headers.get('x-slack-request-timestamp') ?? undefined })
  if (!signed.ok) return new Response('invalid request', { status: 401 })
  let saved: any
  if (submission || setupChange || setupSubmission) {
    try {
      saved = unseal(payload.view.private_metadata, options.signingSecret)
      if (!saved.origin || !['teamId', 'channelId', 'userId', 'threadTs'].every(k => typeof saved.origin[k] === 'string' && saved.origin[k])
        || ((setupChange || setupSubmission) && (!saved.setup || (setupSubmission && saved.setup.editing !== true)))) throw new Error('invalid_view')
    } catch { return new Response('invalid view', { status: 403 }) }
  }
  if (launchSubmission || reviewOpen) {
    try {
      saved = unseal(launchSubmission ? payload.view.private_metadata : action.value, options.signingSecret)
      launchRequest(launchSubmission ? saved.launch : saved.request)
      if (!saved.origin || !['teamId', 'channelId', 'userId', 'threadTs'].every(k => typeof saved.origin[k] === 'string' && saved.origin[k])) throw new Error('invalid_launch_origin')
    } catch { return new Response('invalid view', { status: 403 }) }
  }
  let workSelection: WorkSelection | undefined
  if (workNavigationAction || workSubmission) {
    try {
      saved = unseal(workSubmission ? payload.view.private_metadata : action.value, options.signingSecret)
      workSelection = parseWorkSelection(saved.work)
      if (!saved.origin || !['teamId', 'channelId', 'userId', 'threadTs'].every(k => typeof saved.origin[k] === 'string' && saved.origin[k])
        || (workNavigationAction && !workActionMatches(action.action_id, workSelection))
        || (workSubmission && (workSelection.kind !== 'pick' || !(saved.menuDigest === null || /^[a-f0-9]{64}$/.test(saved.menuDigest))))) {
        throw new Error('invalid_work_origin')
      }
    } catch { return new Response('invalid view', { status: 403 }) }
  }
  let resumeSelection: ResumeSelection | undefined
  if (resumeNavigation) {
    try {
      saved = unseal(action.value, options.signingSecret)
      resumeSelection = parseResumeSelection(saved.resume)
      if (!saved.origin || !['teamId', 'channelId', 'userId', 'threadTs'].every(k => typeof saved.origin[k] === 'string')
        || !action.action_id.startsWith('fabric_resume_' + resumeSelection.kind)) throw new Error('invalid_resume_origin')
    } catch { return new Response('invalid view', { status: 403 }) }
  }
  const origin: Origin = { teamId: payload.team_id ?? payload.team?.id, userId: event?.user ?? payload.user?.id,
    channelId: event?.channel ?? payload.channel?.id ?? saved?.origin.channelId,
    threadTs: event?.thread_ts ?? event?.ts ?? payload.message?.thread_ts ?? payload.message?.ts ?? saved?.origin.threadTs }
  if (!options.launcherAllowedTeamIds?.includes(origin.teamId) || !options.launcherAllowedChannelIds?.includes(origin.channelId)
      || !options.launcherAllowedUserIds?.includes(origin.userId) || (saved && (saved.origin.userId !== origin.userId || saved.origin.teamId !== origin.teamId))
      || ((submission || setupChange || setupSubmission || resumeNavigation || workNavigationAction || workSubmission || launchSubmission || reviewOpen)
        && saved.origin.channelId !== origin.channelId)) {
    return new Response('not allowed', { status: 403 })
  }
  const query = new URLSearchParams({ teamId: origin.teamId, channelId: origin.channelId, userId: origin.userId })
  const reply = (body: Record<string, unknown>) => slack(options, 'chat.postMessage', { ...body,
    channel: origin.channelId, thread_ts: origin.threadTs, unfurl_links: false, unfurl_media: false })
  if (setupChange || setupSubmission) {
    try {
      const [catalog, menu] = await Promise.all([intake(options, '/v1/recipe-catalog?' + query), intake(options, '/v1/work-items?' + query)])
      if (!catalog.ok || !menu.ok) return new Response('retry', { status: 503 })
      const recipe = parseWorkCatalog(catalog.value).recipes.find(r => r.id === saved.recipe.id)
      if (!recipe || recipe.digest !== saved.recipe.digest || recipe.version !== saved.recipe.version) throw new Error('work_setup_changed')
      const old = resolveSetup(recipe, saved.setup.selected, saved.setup.catalogDigest)
      if (!old) throw new Error('work_setup_unavailable')
      let selected = old
      if (setupSubmission) {
        const choice = payload.view.state?.values?.work_setup?.choice?.selected_option?.value
        selected = recipeSetups(recipe)!.setups.find(s => s.status === 'qualified' && setupOptionValue(s) === choice)!
        if (!selected) throw new Error('work_setup_unavailable')
      }
      const setup = { ...setupChoiceFor(recipe, selected)!, ...(setupChange ? { editing: true } : {}) }
      const view = recipeView(recipe, recipeMetadata(origin, recipe, options.signingSecret, setup), menu.value as WorkMenu, setup, formValues(payload))
      if (setupSubmission) return Response.json({ response_action: 'update', view })
      await slack(options, 'views.update', { view_id: payload.view.id, hash: payload.view.hash, view })
      return new Response('ok')
    } catch {
      if (setupSubmission) return Response.json({ response_action: 'errors', errors: { work_setup: 'This setup changed or is unavailable. Close this form and open the current recipe again.' } })
      await slack(options, 'views.update', { view_id: payload.view.id, hash: payload.view.hash, view: {
        type: 'modal', title: plain('Setup unavailable'), close: plain('Close'), blocks: [section('This setup changed or is unavailable. Open the current recipe again. Nothing was started.')] } })
      return new Response('ok')
    }
  }
  const workValueFor = (selection: WorkSelection) => {
    const value = seal({ origin, work: selection }, options.signingSecret)
    if (value.length > 2000) throw new Error('work_selection_too_large')
    return value
  }
  const resumeValueFor = (selection: ResumeSelection) => {
    const value = seal({ origin, resume: selection }, options.signingSecret)
    if (value.length > 2000) throw new Error('resume_selection_too_large')
    return value
  }
  if ((mention && /^fabric\s+work(?:\s|$)/i.test(text)) || workNavigationAction || workSubmission) {
    if (mention) {
      waitUntil(reply(/^fabric\s+work\s*$/i.test(text) ? workMessage(workValueFor)
        : { text: 'Use `fabric work` to choose an existing Plane item. Browsing starts no work.' }))
      return new Response('ok')
    }
    const formError = (message: string) => Response.json({ response_action: 'errors', errors: { plane: message } })
    const show = async (view: unknown) => {
      if (payload.view?.id) await slack(options, 'views.update', { view_id: payload.view.id, hash: payload.view.hash, view })
      else await slack(options, 'views.open', { trigger_id: payload.trigger_id, view })
    }
    let planeUrl: string | undefined
    try {
      if (workSubmission) {
        const values = payload.view.state?.values ?? {}
        const pasted = values.plane?.url?.value ?? '', selected = values.work?.item?.selected_option?.value ?? ''
        if (typeof pasted !== 'string' || typeof selected !== 'string' || (!pasted.trim() && !selected) || (pasted.trim() && selected)) {
          return formError('Choose one item or paste one exact Plane link.')
        }
        if (selected) {
          const result = await intake(options, '/v1/work-items?' + query)
          if (!result.ok) return formError('The item list is unavailable. Refresh it or paste the exact Plane link.')
          const menu = parseWorkMenu(result.value)
          if (menu.stale || saved.menuDigest !== workMenuDigest(menu)) return formError('The item list is stale or changed. Refresh it, then choose again, or paste the exact Plane link.')
          planeUrl = selectedWorkUrl(menu, selected)
          if (!planeUrl) return formError('This choice is no longer in the list. Refresh it or paste the exact Plane link.')
        } else {
          try { planeUrl = exactResumeUrl(pasted.trim()) } catch { return formError('Paste one exact HTTPS Plane work-item link without a query or fragment.') }
        }
      } else if (workSelection?.kind === 'pick') {
        const result = await intake(options, '/v1/work-items?' + query)
        const menu = result.ok ? parseWorkMenu(result.value) : null
        await show(workPickerView(menu, seal({ origin, work: { kind: 'pick' }, menuDigest: menu ? workMenuDigest(menu) : null }, options.signingSecret), workValueFor))
        return new Response('ok')
      } else if (workSelection) planeUrl = workSelection.planeUrl
      if (!planeUrl) throw new Error('missing_work_item')
      query.set('planeUrl', planeUrl)
      const result = await intake(options, '/v1/resume-brief?' + query)
      if (!result.ok) {
        if (workSubmission) return formError('History is unavailable. Check the exact Plane item link and enabled channel, then try again.')
        await show(workUnavailableView(planeUrl, workValueFor))
        return new Response('ok')
      }
      const brief = parseResumeBrief(result.value, planeUrl)
      let view: unknown = workOverviewView(brief, resumeValueFor, workValueFor)
      if (workSelection?.kind === 'recipes' || workSelection?.kind === 'recipe') {
        // Catalog is discovery only. No allocation or eligibility query is performed.
        query.delete('planeUrl')
        const result = await intake(options, '/v1/recipe-catalog?' + query)
        if (!result.ok) throw new Error('work_catalog_unavailable')
        const catalog = parseWorkCatalog(result.value)
        view = workSelection.kind === 'recipes' ? workRecipesView(catalog, brief, workSelection.page, workValueFor)
          : workRecipeView(catalog.recipes.find(r => r.id === workSelection.recipeId), brief, workSelection, workValueFor)
      }
      if (workSubmission) return Response.json({ response_action: 'update', view })
      await show(view)
      return new Response('ok')
    } catch {
      if (workSubmission) return formError('This view is temporarily unavailable. Try again; nothing was started.')
      try { await show(workUnavailableView(planeUrl, workValueFor)); return new Response('ok') }
      catch { return new Response('retry', { status: 503 }) }
    }
  }
  if ((mention && /^fabric\s+resume(?:\s|$)/i.test(text)) || resumeNavigation) {
    const match = /^fabric\s+resume\s+(?:<(https:\/\/[^\s<>|]+)(?:\|[^>]+)?>|(https:\/\/[^\s<>|]+))\s*$/i.exec(text)
    let planeUrl: string
    try { planeUrl = exactResumeUrl(resumeSelection?.planeUrl ?? match?.[1] ?? match?.[2]) }
    catch {
      waitUntil(reply({ text: 'Use `fabric resume <exact Plane work-item link>` to read its history. Nothing is started.' }))
      return new Response('ok')
    }
    if (resumeSelection?.kind === 'plane') return new Response('ok')
    query.set('planeUrl', planeUrl)
    const valueFor = (selection: ResumeSelection) => {
      const value = seal({ origin, resume: selection }, options.signingSecret)
      if (value.length > 2000) throw new Error('resume_selection_too_large')
      return value
    }
    try {
      let view
      if (resumeSelection?.kind === 'artifact') {
        const reference = resumeSelection.reference
        for (const key of ['runId', 'generation', 'kind', 'sha256'] as const) query.set(key, reference[key])
        const result = await intake(options, '/v1/resume-artifact?' + query)
        if (!result.ok) return new Response('unavailable', { status: result.status >= 500 ? 503 : 403 })
        view = resumeArtifactView(parseResumeArtifact(result.value, reference), resumeSelection, valueFor)
      } else {
        const result = await intake(options, '/v1/resume-brief?' + query)
        if (!result.ok) {
          if (result.status >= 500) return new Response('retry', { status: 503 })
          if (resumeNavigation) return new Response('not allowed', { status: 403 })
          waitUntil(reply({ text: 'This work history is unavailable here. Use the exact Plane item link in an enabled channel. Nothing was started.' }))
          return new Response('ok')
        }
        const brief = parseResumeBrief(result.value, planeUrl)
        if (!resumeNavigation) {
          waitUntil(reply(resumeMessage(brief, valueFor)))
          return new Response('ok')
        }
        if (resumeSelection?.kind === 'feedback') view = resumeFeedbackView(brief, resumeSelection, valueFor)
        else {
          const history = resumeHistoryView(brief, resumeSelection?.page ?? 0, valueFor)
          view = { ...history, blocks: [...history.blocks, workNavigation(planeUrl, workValueFor, true)] }
        }
      }
      if (payload.view?.id) await slack(options, 'views.update', { view_id: payload.view.id, hash: payload.view.hash, view })
      else await slack(options, 'views.open', { trigger_id: payload.trigger_id, view })
      return new Response('ok')
    } catch { return new Response('retry', { status: 503 }) }
  }
  if (navigation && action.action_id === prefix+'plane') return new Response('ok')
  if ((mention && /^fabric\s+capabilities\s*$/i.test(text)) || (navigation && action.action_id === prefix+'capabilities')) {
    const result = await intake(options, '/v1/capabilities?' + query)
    if (!result.ok) return new Response('retry', { status: result.status >= 500 ? 503 : 403 })
    let overview
    try { overview = parseCapabilityOverview(result.value) } catch { return new Response('retry', { status: 503 }) }
    if (navigation) await slack(options, 'views.open', { trigger_id: payload.trigger_id, view: capabilityView(overview) })
    else waitUntil(reply(capabilityMessage(overview)))
    return new Response('ok')
  }
  if ((mention && /^fabric\s+runs\s*$/i.test(text)) || (navigation && [prefix+'recent',prefix+'details'].includes(action.action_id))) {
    const result = await intake(options, '/v1/runs?' + query)
    if (!result.ok) return new Response('retry', { status: result.status >= 500 ? 503 : 403 })
    if (action?.action_id === prefix+'details') {
      const run = (result.value.runs as Run[]).find(r => r.requestId === action.value)
      if (!run) { waitUntil(reply({text:'This run is outside the recent list. Open its Plane item for the retained result.'})); return new Response('ok') }
      await slack(options, 'views.open', {trigger_id:payload.trigger_id, view:runView(run)})
    } else waitUntil(reply(recentRuns(result.value.runs)))
    return new Response('ok')
  }
  if (submission) {
    const values = payload.view.state?.values ?? {}
    const profile = values.profile?.choice?.selected_option?.value ?? ''
    const pasted = (values.plane?.url?.value ?? '').trim()
    const selected = values.work?.item?.selected_option?.value ?? ''
    if ((!pasted && !selected) || (pasted && selected)) return Response.json({ response_action:'errors', errors:{plane:'Choose one item or paste one link, then review.'} })
    const planeUrl = pasted || selected
    if (saved.setup?.editing) return Response.json({ response_action: 'errors', errors: { profile: 'Review the chosen setup before starting.' } })
    // Review is read-only. The request id binds this form and its exact choice,
    // so Launch after a lost response replays instead of starting twice.
    const choice = createHash('sha256').update(JSON.stringify([planeUrl, profile, saved.setup?.selected ?? null])).digest('hex').slice(0, 16)
    const request = recipeRequest(saved.recipe, profile, planeUrl, origin, payload.view.id + ':' + choice, saved.setup?.selected)
    const built = await buildReview(options, origin, request, options.signingSecret)
    if ('unavailable' in built) return Response.json({ response_action: 'errors', errors: { plane: "Couldn't check eligibility: intake didn't answer. Nothing launched. Try again." } })
    if ('refused' in built) {
      const key = /PROFILE|RECIPE|WORK_SETUP/.test(built.refused) ? 'profile' : 'plane'
      return Response.json({ response_action: 'errors', errors: { [key]: refusalText(built.refused) } })
    }
    return Response.json({ response_action: 'push', view: built.view })
  }
  if (launchSubmission) {
    let result
    try { result = await intake(options, '/v1/runs', saved.launch) } catch { return new Response('retry', { status: 503 }) }
    if (!result.ok) {
      if (result.status >= 500) return new Response('retry', { status: 503 })
      const code = String(result.value.error ?? 'unavailable')
      return Response.json({ response_action: 'update', view: refusedView(refusalText(code), code) })
    }
    return Response.json({ response_action: 'update', view: launchedView(result.value, result.value.created === false) })
  }
  if (reviewOpen) {
    const built = await buildReview(options, origin, saved.request, options.signingSecret)
    const view = 'view' in built ? built.view : 'refused' in built ? refusedView(refusalText(built.refused), built.refused)
      : refusedView("Couldn't check eligibility: intake didn't answer. Nothing launched. Try again.", 'UNAVAILABLE')
    await slack(options, 'views.open', { trigger_id: payload.trigger_id, view })
    return new Response('ok')
  }
  if (opening) {
    // Opening and editing are previews. Consumed capacity must not hide their
    // catalog; admission is checked only by the unchanged Start submission.
    const catalog = await intake(options, '/v1/recipe-catalog?' + query)
    if (!catalog.ok) return new Response('retry', { status: catalog.status >= 500 ? 503 : 403 })
    let recipe: Recipe | undefined
    try { recipe = parseWorkCatalog(catalog.value).recipes.find(r => r.id === action.value) }
    catch { return new Response('catalog unavailable', { status: 503 }) }
    if (!recipe) return new Response('unknown recipe', { status: 409 })
    const work = await intake(options, '/v1/work-items?' + query)
    const setup = setupChoiceFor(recipe)
    await slack(options, 'views.open', { trigger_id: payload.trigger_id,
      view: recipeView(recipe, recipeMetadata(origin, recipe, options.signingSecret, setup), work.ok ? work.value as WorkMenu : undefined, setup) })
    return new Response('ok')
  }
  const result = await intake(options, '/v1/recipes?' + query)
  if (!result.ok) return new Response('retry', { status: result.status >= 500 ? 503 : 403 })
  const recipes = result.value.recipes as Recipe[]
  if (/^fabric\s+recipes\s*$/i.test(text) || (navigation && action.action_id === prefix+'menu')) {
    waitUntil(reply(recipeMenu(recipes, result.value.availability)))
    return new Response('ok')
  }
  const launchMatch = /^fabric\s+launch\s+([a-z0-9-]+)(?:\s+([a-z0-9-]+))?\s+(?:<)?(https:\/\/[^\s<>|]+)(?:\|[^>]+)?(?:>)?\s*$/i.exec(text)
  if (/^fabric\s+launch(?:\s|$)/i.test(text)) {
    const chosen = launchMatch && recipes.find(r => [r.id, ...r.aliases].includes(launchMatch[1]!.toLowerCase()))
    const profile = launchMatch?.[2]?.toLowerCase() ?? chosen?.defaultProfile
    if (!launchMatch || !chosen || !profile || !chosen.profiles[profile]) {
      waitUntil(reply({ text: 'Use `fabric launch <recipe> [profile] <Plane-item-link>` for a private review with a Launch button. Nothing was started.' }))
      return new Response('ok')
    }
    const request = recipeRequest(chosen, profile, launchMatch[3]!, origin, payload.event_id ?? event.ts)
    const summary: ReviewSummary = { recipeTitle: chosen.title, version: chosen.version, profileTitle: chosen.profiles[profile]!.title,
      ...(recipeSetups(chosen) ? { setupTitle: recipeSetups(chosen)!.selected.title } : {}), planeUrl: request.planeUrl! }
    const value = seal({ origin, request }, options.signingSecret)
    if (value.length > 2000) { waitUntil(reply({ text: 'This launch is too large to review here. Use `fabric recipes`.' })); return new Response('ok') }
    // Ephemeral and sealed to the requester: others never see or use this button.
    waitUntil(slack(options, 'chat.postEphemeral', { channel: origin.channelId, user: origin.userId, thread_ts: origin.threadTs,
      ...reviewButtonMessage(value, summary) }))
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
    waitUntil(reply({ text: refusalText(submitted.value.error) }))
  } else if (!submitted.value.created) waitUntil(reply({ text: formatRun(submitted.value as any) }))
  return new Response('ok')
}

export function refusalText(error: unknown) {
  const code = String(error ?? 'unavailable')
  const reasons: Record<string,string> = {
    WAITING_CAPACITY:'This batch has no runs left. An operator needs to add a fresh batch.',
    ADMISSION_EXPIRED:'This batch has expired. An operator needs to renew it before work can start.',
    RECIPE_CHANGED_REFRESH_MENU:'This recipe changed. Close this form and open the menu again.',
    WORK_SETUP_CHANGED_REFRESH_MENU:'This work setup changed. Close this form and open the menu again.',
    PLANE_PROJECT_OUTSIDE_ALLOWLIST:'This project is not enabled. Choose an item from an enabled project.',
    INVALID_PLANE_URL:'Paste a work-item link from the connected Plane workspace.',
    INVALID_PLANE_ITEM_PATH:'Paste a link to a specific Plane work item.',
    UNSUPPORTED_PROFILE:'Choose one of the recipe modes shown in this form.',
    ITEM_RUN_ACTIVE:'A run for this Plane item is still in progress. Wait for it to finish, then try again.',
    LINUX_CONCURRENCY_FULL:'The Linux lane is at its active-run limit. Try again when a run finishes.',
    WAITING_SOFTWARE_CAPACITY:'This item has no one-use repair reservation for you. An operator must add one.',
    EXECUTION_PROFILE_CHANGED_REFRESH:'The model or limits changed since your review. Review again; nothing was started.',
    REQUEST_ID_CONFLICT:'A launch from this review already exists with different content. Open the recipe again.'
  }
  return (reasons[code] ?? 'The request could not start. Check the selected work and recipe.') + ` (${code})`
}
