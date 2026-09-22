/** Frozen setup descriptions and choices; no tool installation or authority here. */
import { createHash } from 'node:crypto'

export type WorkSetupRef = { id: string; version: string; digest: string }
export type WorkSetup = WorkSetupRef & { title: string; description: string;
  status: 'qualified' | 'needs-qualification' | 'research-only'; method: string; stages: string[];
  skills: string[]; tools: string[]; mcpServers: string[]; runtime: string; limitations: string[] }
export type RecipeSetups = { defaultWorkSetup?: WorkSetupRef; workSetups?: WorkSetup[] }
export type SetupChoice = { selected: WorkSetupRef; catalogDigest: string; editing?: boolean }
const plain = (text: string) => ({ type: 'plain_text', text })
const clip = (text: string, limit: number) => text.length > limit ? text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : text
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit
const strings = (value: unknown, size = 20) => Array.isArray(value) && value.length <= size && value.every(v => text(v, 200))
const section = (value: string) => ({ type: 'section', text: plain(clip(value, 2900)) })

export function parseWorkSetupRef(value: unknown): WorkSetupRef {
  const s = value as WorkSetupRef
  if (!s || !text(s.id, 80) || !/^[a-z0-9][a-z0-9._-]*$/.test(s.id) || !text(s.version, 40)
    || typeof s.digest !== 'string' || !/^[a-f0-9]{64}$/.test(s.digest)) throw new Error('invalid_work_setup_reference')
  return { id: s.id, version: s.version, digest: s.digest }
}
export function parseWorkSetup(value: unknown): WorkSetup {
  const s = value as WorkSetup
  parseWorkSetupRef(s)
  if (!text(s.title, 180) || !text(s.description, 1200) || !text(s.method, 500) || !text(s.runtime, 500)
    || !['qualified', 'needs-qualification', 'research-only'].includes(s.status)
    || !strings(s.stages, 12) || !s.stages.length || !strings(s.skills) || !strings(s.tools) || !strings(s.mcpServers) || !strings(s.limitations, 12)) {
    throw new Error('invalid_work_setup')
  }
  return s
}
export function setupRef(setup: WorkSetupRef): WorkSetupRef { return parseWorkSetupRef(setup) }
export function sameSetup(a: WorkSetupRef, b: WorkSetupRef) {
  return a.id === b.id && a.version === b.version && a.digest === b.digest
}
export function recipeSetups(recipe: RecipeSetups): { selected: WorkSetup; setups: WorkSetup[] } | undefined {
  if (recipe.defaultWorkSetup === undefined && recipe.workSetups === undefined) return
  const ref = parseWorkSetupRef(recipe.defaultWorkSetup)
  if (!Array.isArray(recipe.workSetups) || !recipe.workSetups.length || recipe.workSetups.length > 50) throw new Error('invalid_work_setup_catalog')
  const setups = recipe.workSetups.map(parseWorkSetup)
  if (new Set(setups.map(s => s.id)).size !== setups.length) throw new Error('duplicate_work_setup')
  const selected = setups.find(s => sameSetup(s, ref))
  if (!selected || selected.status !== 'qualified') throw new Error('default_work_setup_unavailable')
  return { selected, setups }
}
export function setupCatalogDigest(recipe: RecipeSetups): string {
  const catalog = recipeSetups(recipe)
  if (!catalog) throw new Error('work_setup_not_supported')
  return hash(JSON.stringify({ default: setupRef(catalog.selected), setups: catalog.setups.map(s => ({
    ...setupRef(s), title: s.title, description: s.description, status: s.status, method: s.method,
    stages: s.stages, skills: s.skills, tools: s.tools, mcpServers: s.mcpServers, runtime: s.runtime, limitations: s.limitations })) }))
}
export function setupOptionValue(setup: WorkSetupRef) { return hash(JSON.stringify(setupRef(setup))) }
export function resolveSetup(recipe: RecipeSetups, selected?: WorkSetupRef, catalogDigest?: string): WorkSetup | undefined {
  const catalog = recipeSetups(recipe)
  if (!catalog) {
    if (selected !== undefined || catalogDigest !== undefined) throw new Error('work_setup_changed')
    return
  }
  if (catalogDigest !== undefined && setupCatalogDigest(recipe) !== catalogDigest) throw new Error('work_setup_changed')
  const ref = selected === undefined ? setupRef(catalog.selected) : parseWorkSetupRef(selected)
  const result = catalog.setups.find(s => sameSetup(s, ref))
  if (!result || result.status !== 'qualified') throw new Error('work_setup_unavailable')
  return result
}
export function setupChoiceFor(recipe: RecipeSetups, selected?: WorkSetupRef): SetupChoice | undefined {
  const resolved = resolveSetup(recipe, selected)
  return resolved ? { selected: setupRef(resolved), catalogDigest: setupCatalogDigest(recipe) } : undefined
}
export function setupRequestFields(setup?: WorkSetupRef) {
  if (!setup) return {}
  const ref = parseWorkSetupRef(setup)
  return { workSetupId: ref.id, workSetupVersion: ref.version, workSetupDigest: ref.digest }
}
export function setupRuntimeTitle(runtime: string) { return runtime === 'qualified-linux-hermes' ? 'Hermes on isolated Linux' : runtime }
const stageTitle = (value: string) => (({ 'research-plan': 'Research and plan', 'independent-plan-review': 'Independent plan review',
  implement: 'Implement', 'independent-verify': 'Independent verification' } as Record<string, string>)[value] ?? value)
const toolTitle = (value: string) => (({ delegate_review: 'Delegate work', submit_verdict: 'Record independent verdict', read_review_inputs: 'Read task inputs', submit_software_plan: 'Submit implementation plan',
  submit_plan_review: 'Review implementation plan', submit_software_source: 'Submit source for isolated execution',
  submit_review: 'Publish worker report' } as Record<string, string>)[value] ?? value)
export function workSetupBlocks(setup: WorkSetup) {
  parseWorkSetup(setup)
  const list = (label: string, values: string[]) => {
    const chunks = [`${label}: `]
    for (const value of values.length ? values : ['None declared']) {
      const last = chunks.length - 1
      if (chunks[last]!.length + value.length + 3 > 2500) chunks.push(`${label} (continued): ${value}`)
      else chunks[last] += (chunks[last]!.endsWith(': ') ? '' : ' · ') + value
    }
    return chunks.map(section)
  }
  return [section(`Work setup: ${setup.title}\n${setup.description}`),
    section(`Method: ${setup.method}`), ...list('Stages', setup.stages.map(stageTitle)), ...list('Skills', setup.skills),
    ...list('Tools', setup.tools.map(toolTitle)), ...list('MCP servers', setup.mcpServers), section(`Runtime: ${setupRuntimeTitle(setup.runtime)}`),
    ...(setup.limitations.length ? [section(setup.limitations.join('\n'))] : [])]
}
export function setupPickerBlock(recipe: RecipeSetups, selected: WorkSetupRef) {
  const catalog = recipeSetups(recipe)!
  const options = catalog.setups.filter(s => s.status === 'qualified').map(s => ({ text: plain(clip(s.title, 75)),
    value: setupOptionValue(s), description: plain(clip(s.method, 75)) }))
  return { type: 'input', block_id: 'work_setup', label: plain('Change setup'),
    hint: plain('Type to search available setups. Use setup returns to the preview; it does not start work.'),
    element: { type: 'static_select', action_id: 'choice', placeholder: plain('Search work setups'), options,
      initial_option: options.find(o => o.value === setupOptionValue(selected)) } }
}
