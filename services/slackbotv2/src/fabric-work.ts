/** Work-first navigation. Every choice is a read-only view, never a run request. */
import { createHash } from 'node:crypto'
import { exactResumeUrl, resumeMessage, type ResumeBrief, type ResumeSelection } from './fabric-resume'
import type { Recipe } from './fabric-recipes'

export type WorkMenu = { capturedAt: number | null; stale: boolean; projects: Array<{ name: string; limited?: boolean;
  items: Array<{ name: string; identifier: string; url: string }> }> }
export type WorkRecipe = Recipe & { adapter?: string; requiresCheckedResearch?: boolean }
export type WorkCatalog = { recipes: WorkRecipe[]; launchEnabled: false; scope: string }
export type WorkSelection = { kind: 'pick' } | { kind: 'overview'; planeUrl: string }
  | { kind: 'recipes'; planeUrl: string; page: number }
  | { kind: 'recipe'; planeUrl: string; page: number; recipeId: string; digest: string }
type ValueFor = (selection: WorkSelection) => string
type Block = Record<string, unknown>
const prefix = 'fabric_work_'
const PAGE_SIZE = 6
const plain = (text: string) => ({ type: 'plain_text', text })
const clip = (text: string, limit: number) => text.length > limit ? text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : text
const section = (text: string): Block => ({ type: 'section', text: plain(clip(text || 'No information available.', 2900)) })
const string = (value: unknown): value is string => typeof value === 'string'
const sha = (value: unknown): value is string => string(value) && /^[a-f0-9]{64}$/.test(value)
const id = (value: unknown): value is string => string(value) && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export function parseWorkMenu(value: unknown): WorkMenu {
  const m = value as WorkMenu
  if (!m || typeof m.stale !== 'boolean' || !(m.capturedAt === null || (typeof m.capturedAt === 'number'
    && Number.isFinite(m.capturedAt) && m.capturedAt >= 0)) || !Array.isArray(m.projects) || m.projects.length > 100
    || m.projects.some(p => !p || !string(p.name) || (p.limited !== undefined && typeof p.limited !== 'boolean')
      || !Array.isArray(p.items) || p.items.length > 100 || p.items.some(i => !i || !string(i.name)
        || !string(i.identifier) || exactResumeUrl(i.url) !== i.url))) throw new Error('invalid_work_menu')
  const urls = m.projects.flatMap(p => p.items.map(i => i.url))
  if (new Set(urls).size !== urls.length) throw new Error('duplicate_work_item')
  return m
}

export function workGroups(menu: WorkMenu) {
  return menu.projects.filter(p => p.items.length).slice(0, 10).map(p => ({ label: plain(clip(p.name || 'Project', 75)),
    options: p.items.slice(0, 30).map(i => ({ text: plain(clip(`${i.identifier} · ${i.name}`, 75)), value: hash(i.url) })) }))
}
export function workMenuDigest(menu: WorkMenu) { return hash(JSON.stringify(workGroups(menu))) }
export function selectedWorkUrl(menu: WorkMenu, value: string): string | undefined {
  // Match only options actually shown; full URLs cannot fit Slack's option-value limit.
  if (!workGroups(menu).some(g => g.options.some(o => o.value === value))) return
  return menu.projects.flatMap(p => p.items).find(i => hash(i.url) === value)?.url
}

export function parseWorkSelection(value: unknown): WorkSelection {
  const s = value as WorkSelection
  if (!s || !['pick', 'overview', 'recipes', 'recipe'].includes(s.kind)) throw new Error('invalid_work_selection')
  if (s.kind !== 'pick' && exactResumeUrl(s.planeUrl) !== s.planeUrl) throw new Error('invalid_work_selection')
  if ((s.kind === 'recipes' || s.kind === 'recipe') && (!Number.isInteger(s.page) || s.page < 0 || s.page > 49)) throw new Error('invalid_work_page')
  if (s.kind === 'recipe' && (!id(s.recipeId) || !sha(s.digest))) throw new Error('invalid_work_recipe')
  return s
}
export function isWorkAction(value: unknown): boolean {
  return string(value) && /^fabric_work_(pick|overview|recipes(?:_previous|_next)?|recipe)$/.test(value)
}
export function workActionMatches(action: string, selection: WorkSelection) {
  return isWorkAction(action) && action.replace(/_(previous|next)$/, '') === prefix + selection.kind
}

function button(text: string, selection: WorkSelection, valueFor: ValueFor, suffix = '') {
  return { type: 'button', action_id: prefix + selection.kind + suffix, text: plain(text), value: valueFor(selection) }
}
export function workNavigation(planeUrl: string, valueFor: ValueFor, overview = false): Block {
  return { type: 'actions', elements: [
    ...(overview ? [button('Work overview', { kind: 'overview', planeUrl }, valueFor)] : []),
    button('Browse recipes', { kind: 'recipes', planeUrl, page: 0 }, valueFor),
    button('Choose another item', { kind: 'pick' }, valueFor)] }
}
export function workMessage(valueFor: ValueFor) {
  return { text: 'Choose an existing Plane work item to read its history, results and recipe options. Browsing starts no work.', blocks: [
    section('Your work\nChoose an existing Plane item, inspect what happened, then explore recipes. Browsing starts no work.'),
    { type: 'actions', elements: [button('Choose work', { kind: 'pick' }, valueFor),
      { type: 'button', action_id: 'fabric_recipe_recent', text: plain('Recent work') },
      { type: 'button', action_id: 'fabric_recipe_capabilities', text: plain('Capabilities') }] }] }
}
export function workPickerView(menu: WorkMenu | null, metadata: string, valueFor: ValueFor) {
  const groups = menu ? workGroups(menu) : []
  const limited = menu && (menu.projects.length > 10 || menu.projects.some(p => p.limited || p.items.length > 30))
  return { type: 'modal', callback_id: 'fabric_work_submit', title: plain('Choose work'), submit: plain('View work'), close: plain('Close'),
    private_metadata: metadata, blocks: [section('Choose a recent item from an enabled project, or paste its exact Plane link. This opens history; it does not start a run.'),
      ...(groups.length ? [{ type: 'input', block_id: 'work', optional: true, label: plain('Project and work item'),
        element: { type: 'static_select', action_id: 'item', placeholder: plain('Choose work from Plane'), option_groups: groups } }] : []),
      ...(limited ? [section('This is a limited list of recent items, not the complete project backlog. Paste the exact link for an item not shown.')] : []),
      ...(!menu || menu.stale ? [section('The saved item list is unavailable or stale. Refresh the list, or paste the exact Plane link to inspect retained history.')] : []),
      ...(menu && !groups.length ? [section('No recent work items are listed. You can still paste an enabled Plane item link.')] : []),
      { type: 'input', block_id: 'plane', optional: groups.length > 0, label: plain(groups.length ? 'Or paste the exact Plane link' : 'Exact Plane work-item link'),
        element: { type: 'plain_text_input', action_id: 'url', max_length: 500 } },
      { type: 'actions', elements: [button('Refresh list', { kind: 'pick' }, valueFor)] }] }
}

export function workOverviewView(brief: ResumeBrief, resumeValueFor: (selection: ResumeSelection) => string, valueFor: ValueFor) {
  return { type: 'modal', callback_id: 'fabric_work_view', title: plain('Work overview'), close: plain('Close'), blocks: [
    ...resumeMessage(brief, resumeValueFor).blocks,
    ...(brief.objective.sourceRunId === null ? [section(`No retained objective is available yet. Open this item in Plane for its current details.\n${brief.planeUrl}`)] : []),
    section('History uses this exact link and channel. The objective comes from retained run context, not a fresh Plane read.'),
    workNavigation(brief.planeUrl, valueFor)] }
}

export function parseWorkCatalog(value: unknown): WorkCatalog {
  const c = value as WorkCatalog
  if (!c || c.launchEnabled !== false || !string(c.scope) || !Array.isArray(c.recipes) || c.recipes.length > 50
    || c.recipes.some(r => !r || !id(r.id) || !sha(r.digest) || !string(r.version) || !string(r.title) || !string(r.description)
      || !Array.isArray(r.roles) || !r.roles.length || r.roles.length > 10 || r.roles.some(role => !string(role))
      || (r.adapter !== undefined && !string(r.adapter)) || (r.requiresCheckedResearch !== undefined && typeof r.requiresCheckedResearch !== 'boolean')
      || !r.profiles || typeof r.profiles !== 'object' || Array.isArray(r.profiles) || !Object.keys(r.profiles).length
      || Object.keys(r.profiles).length > 10 || Object.entries(r.profiles).some(([key, p]) => !id(key) || !p || !string(p.title)
        || !string(p.description) || !p.maxCalls || Object.keys(p.maxCalls).sort().join(',') !== 'checker,coordinator,worker'
        || Object.values(p.maxCalls).some(n => !Number.isInteger(n) || n < 1 || n > 100)))) throw new Error('invalid_work_catalog')
  if (new Set(c.recipes.map(r => r.id)).size !== c.recipes.length) throw new Error('duplicate_work_recipe')
  return c
}

function availability(brief: ResumeBrief) {
  return section(`${brief.continuation.serviceWindowOpen ? 'The service window is open; this is not a capacity reservation.' : 'The current service window is closed.'}\n${clip(brief.continuation.message, 700)}\nBrowsing and choosing a recipe here starts no work.`)
}
export function workRecipesView(catalog: WorkCatalog, brief: ResumeBrief, requestedPage: number, valueFor: ValueFor) {
  const pages = Math.max(1, Math.ceil(catalog.recipes.length / PAGE_SIZE)), page = Math.min(requestedPage, pages - 1)
  const blocks: Block[] = [section(`${clip(brief.title, 250)}\nRecipe options · page ${page + 1} of ${pages}`), availability(brief),
    section(`Research prerequisite: ${clip(brief.research.message, 700)}\n${clip(catalog.scope, 400)}`)]
  for (const recipe of catalog.recipes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    blocks.push(section(`${clip(recipe.title, 150)}\n${clip(recipe.description, 700)}`), { type: 'actions', elements: [
      button('Inspect recipe', { kind: 'recipe', planeUrl: brief.planeUrl, page, recipeId: recipe.id, digest: recipe.digest }, valueFor)] })
  }
  if (!catalog.recipes.length) blocks.push(section('No recipes are listed in the connected catalog. Your history remains available.'))
  blocks.push({ type: 'actions', elements: [
    ...(page > 0 ? [button('Previous recipes', { kind: 'recipes', planeUrl: brief.planeUrl, page: page - 1 }, valueFor, '_previous')] : []),
    ...(page + 1 < pages ? [button('More recipes', { kind: 'recipes', planeUrl: brief.planeUrl, page: page + 1 }, valueFor, '_next')] : []),
    button('Work overview', { kind: 'overview', planeUrl: brief.planeUrl }, valueFor)] })
  return { type: 'modal', callback_id: 'fabric_work_view', title: plain('Browse recipes'), close: plain('Close'), blocks }
}

export function workRecipeView(recipe: WorkRecipe | undefined, brief: ResumeBrief, selection: Extract<WorkSelection, { kind: 'recipe' }>, valueFor: ValueFor) {
  const blocks: Block[] = recipe && recipe.digest === selection.digest ? [
    section(`${clip(recipe.title, 180)} · ${clip(recipe.version, 40)}\n${clip(recipe.description, 1200)}`),
    section(`For: ${clip(brief.title, 250)}\nTeam: ${recipe.roles.map(r => clip(r, 100)).join(' → ')}`),
    ...Object.values(recipe.profiles).map(p => section(`${clip(p.title, 100)}\n${clip(p.description, 700)}\nCall limits: ${Object.entries(p.maxCalls).map(([role, n]) => `${role} ${n}`).join(' · ')}`)),
    section(recipe.requiresCheckedResearch ? `Requires accepted research for this exact item and channel.\n${clip(brief.research.message, 700)}` : 'This recipe does not declare a checked-research prerequisite. Fresh run setup is still required.'),
    ...(recipe.adapter ? [section('This recipe needs a compatible prepared resource. Current resource readiness and capacity are not verified by this view.')] : []),
    availability(brief)
  ] : [section('This recipe changed or is no longer listed. Browse the current catalog again; no recipe was substituted and nothing started.')]
  blocks.push({ type: 'actions', elements: [button('Back to recipes', { kind: 'recipes', planeUrl: brief.planeUrl, page: selection.page }, valueFor),
    button('Work overview', { kind: 'overview', planeUrl: brief.planeUrl }, valueFor)] })
  return { type: 'modal', callback_id: 'fabric_work_view', title: plain('Recipe preview'), close: plain('Close'), blocks }
}

export function workUnavailableView(planeUrl: string | undefined, valueFor: ValueFor) {
  return { type: 'modal', callback_id: 'fabric_work_view', title: plain('Work unavailable'), close: plain('Close'), blocks: [
    section('This view could not be loaded. Check the exact item link and enabled channel, or try again. Nothing was started.'),
    { type: 'actions', elements: [
      ...(planeUrl ? [button('Try overview again', { kind: 'overview', planeUrl }, valueFor)] : []),
      button('Choose another item', { kind: 'pick' }, valueFor)] }] }
}
