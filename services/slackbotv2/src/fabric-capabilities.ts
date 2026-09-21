/** Read-only capability descriptions. Qualification is never a capacity grant. */
export type CapabilityStatus = 'qualified' | 'needs-qualification' | 'research-only'
export type Capability = {
  id: string
  title: string
  status: CapabilityStatus
  summary: string
  prerequisites: string[]
}
export type CapabilityOverview = {
  schemaVersion: 1
  profiles: Capability[]
  teamSummary?: string
  capacityNote?: string
  requestedProviders?: Array<{ id: string; status: 'research-only'; summary: string }>
}

const labels: Record<CapabilityStatus, string> = {
  qualified: 'Qualified',
  'needs-qualification': 'Needs qualification',
  'research-only': 'Research only',
}
const plain = (text: string) => ({ type: 'plain_text', text })
const section = (text: string) => ({ type: 'section', text: plain(text) })
const header = (text: string) => ({ type: 'header', text: plain(text) })
const clipped = (value: string, length: number) => value.length > length ? value.slice(0, length - 1) + '…' : value
const capacityNote = 'Qualification records what has been tested. Free machines, GPUs, access and approval are checked separately when work is requested.'

export function parseCapabilityOverview(value: unknown): CapabilityOverview {
  const data = value as CapabilityOverview | undefined
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.profiles)
    || data.profiles.some(profile => !profile || typeof profile.id !== 'string'
      || typeof profile.title !== 'string' || !profile.title.trim()
      || !Object.hasOwn(labels, profile.status) || typeof profile.summary !== 'string'
      || !Array.isArray(profile.prerequisites) || profile.prerequisites.some(item => typeof item !== 'string'))
    || (data.teamSummary !== undefined && typeof data.teamSummary !== 'string')
    || (data.capacityNote !== undefined && typeof data.capacityNote !== 'string')
    || (data.requestedProviders !== undefined && (!Array.isArray(data.requestedProviders)
      || data.requestedProviders.some(provider => !provider || typeof provider.id !== 'string'
        || provider.status !== 'research-only' || typeof provider.summary !== 'string')))) {
    throw new Error('invalid_capability_overview')
  }
  return data
}

function card(profile: Capability): string {
  const prerequisites = profile.prerequisites.slice(0, 4).map(item => '• ' + clipped(item, 240))
  if (profile.prerequisites.length > 4) prerequisites.push('• Additional prerequisites remain in the capability record.')
  return [clipped(profile.title, 120), clipped(profile.summary, 600),
    ...(prerequisites.length ? ['Before use:', ...prerequisites] : [])].filter(Boolean).join('\n')
}

export function capabilityMessage(overview: CapabilityOverview) {
  const profiles = overview.profiles.slice(0, 40)
  const blocks = [header('Capabilities'), section(capacityNote)]
  if (overview.capacityNote) blocks.push(section(clipped(overview.capacityNote, 1000)))
  if (overview.teamSummary) blocks.push(section('How the team works\n' + clipped(overview.teamSummary, 1000)))
  for (const status of Object.keys(labels) as CapabilityStatus[]) {
    const group = profiles.filter(profile => profile.status === status)
    if (group.length) blocks.push(header(labels[status]), ...group.map(profile => section(card(profile))))
  }
  const providers = overview.requestedProviders?.slice(0, 6)
    .map(provider => `${clipped(provider.id, 80)}: ${clipped(provider.summary, 300)}`).join('\n')
  if (providers) blocks.push(section('Agent options under research\n' + providers))
  if (!profiles.length) blocks.push(section('No capability descriptions have been published yet.'))
  if (profiles.length < overview.profiles.length) blocks.push(section(`Showing ${profiles.length} of ${overview.profiles.length} capabilities.`))
  blocks.push(section('This overview does not start work. Use the recipe menu for workflows currently enabled to run.'))
  // Explicit fallback includes the same status/prerequisites as the visible cards.
  const text = ['Capabilities', capacityNote, overview.capacityNote && clipped(overview.capacityNote, 1000),
    overview.teamSummary && clipped(overview.teamSummary, 1000),
    ...profiles.map(profile => `${labels[profile.status]}: ${card(profile)}`),
    !profiles.length && 'No capability descriptions have been published yet.',
    providers && 'Agent options under research\n' + providers,
    profiles.length < overview.profiles.length ? `Showing ${profiles.length} of ${overview.profiles.length} capabilities.` : '',
    'This overview does not start work. Use fabric recipes for workflows currently enabled to run.']
    .filter(Boolean).join('\n\n')
  return { text: clipped(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), 39000), blocks }
}

export function capabilityView(overview: CapabilityOverview) {
  return { type: 'modal', title: plain('Capabilities'), close: plain('Close'), blocks: capabilityMessage(overview).blocks }
}
