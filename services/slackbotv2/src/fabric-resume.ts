/** Read-only views over the fabric's receipt-derived work history. */
import { createHash } from 'node:crypto'

export const ARTIFACT_KINDS = ['report', 'gpuResult', 'softwareSource', 'softwareHtml', 'softwareResult'] as const
type ArtifactKind = typeof ARTIFACT_KINDS[number]
export type ArtifactRef = { runId: string; requestId: string; generation: string; kind: ArtifactKind;
  sha256: string; byteLength: number; mediaType: string }
export type ResumeAttempt = { runId: string; requestId: string; generation: string; created: number; state: string;
  recipe: { id: string; title: string; profile: string } | null;
  status: 'ACTIVE' | 'ACCEPTED' | 'REJECTED' | 'STOPPED' | 'UNKNOWN'; label: string; taskOutcome: string | null;
  closure: { authorityClosed: boolean | null; disposalVerified: boolean | null; label: string };
  checker: { accepted: boolean; reason: string } | null; archiveSha256: string | null; evidence: ArtifactRef[] }
export type ResumeBrief = { schemaVersion: 1; observedAt: number; planeUrl: string; title: string;
  objective: { sourceRunId: string | null; updatedAt: string | null; basis: string };
  scope: { complete: true; attemptCount: number; identity: 'exact-plane-url-and-channel' };
  summary: string; attempts: ResumeAttempt[]; latestRunId: string | null; acceptedRunIds: string[];
  research: { status: 'ACCEPTED' | 'BLOCKED' | 'UNKNOWN'; code: string; runId?: string; message: string };
  continuation: { enabled: false; code: 'FRESH_AUTHORITY_REQUIRED'; message: string; serviceWindowOpen: boolean };
  limits: string[] }
export type ResumeSelection = { kind: 'history' | 'plane'; planeUrl: string; page: number }
  | { kind: 'artifact'; planeUrl: string; page: number; reference: ArtifactRef }
  | { kind: 'feedback'; planeUrl: string; page: number; runId: string; generation: string }
export type ResumeArtifact = { reference: ArtifactRef; content: string; basis: string; accepted: boolean }
type ValueFor = (selection: ResumeSelection) => string
type Block = Record<string, unknown>
const PAGE_SIZE = 6
const TEXT_PAGE_SIZE = 18000
const prefix = 'fabric_resume_'
const plain = (text: string) => ({ type: 'plain_text', text })
const clip = (text: string, max: number) => text.length > max ? text.slice(0, max - 1) + '…' : text
const section = (text: string): Block => ({ type: 'section', text: plain(clip(text || 'No information recorded.', 2900)) })
const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const string = (value: unknown): value is string => typeof value === 'string'
const nullableString = (value: unknown) => value === null || string(value)
const nullableBool = (value: unknown) => value === null || typeof value === 'boolean'
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const sha = (value: unknown) => string(value) && /^[a-f0-9]{64}$/.test(value)
const softwareArtifacts = {
  softwareSource: { label: 'Source', mediaType: 'text/x-python; charset=utf-8' },
  softwareHtml: { label: 'HTML', mediaType: 'text/html; charset=utf-8' },
  softwareResult: { label: 'Execution receipt', mediaType: 'application/json' },
} as const
const softwareArtifact = (kind: ArtifactKind) => kind in softwareArtifacts
  ? softwareArtifacts[kind as keyof typeof softwareArtifacts] : undefined
const validRef = (r: ArtifactRef) => r && string(r.runId) && string(r.requestId) && string(r.generation)
  && ARTIFACT_KINDS.includes(r.kind) && sha(r.sha256)
  && Number.isInteger(r.byteLength) && r.byteLength >= 0 && r.byteLength <= 128 * 1024 && string(r.mediaType)
  && (!softwareArtifact(r.kind) || r.mediaType === softwareArtifact(r.kind)!.mediaType)
const chunks = (text: string, limit: number) => {
  const result: string[] = []
  let part = ''
  for (const character of text) {
    if (part.length + character.length > limit) { result.push(part); part = '' }
    part += character
  }
  if (part) result.push(part)
  return result
}

export function exactResumeUrl(value: unknown): string {
  if (!string(value) || value.length > 500 || /[\s<>|]/.test(value)) throw new Error('invalid_resume_url')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('invalid_resume_url')
  return value // Never normalize the URL used by the backend's exact-item identity.
}

export function parseResumeBrief(value: unknown, planeUrl: string): ResumeBrief {
  const b = value as ResumeBrief
  if (!b || b.schemaVersion !== 1 || !finite(b.observedAt) || b.planeUrl !== exactResumeUrl(planeUrl)
    || !string(b.title) || !string(b.summary) || !b.objective || !nullableString(b.objective.sourceRunId)
    || !nullableString(b.objective.updatedAt) || !string(b.objective.basis)
    || b.scope?.complete !== true || b.scope.identity !== 'exact-plane-url-and-channel'
    || !Array.isArray(b.attempts) || b.attempts.length > 50 || b.scope.attemptCount !== b.attempts.length
    || b.attempts.some(a => !a || !string(a.runId) || !string(a.requestId) || !string(a.generation) || !finite(a.created) || a.created > 8.64e12
      || !string(a.state) || !['ACTIVE', 'ACCEPTED', 'REJECTED', 'STOPPED', 'UNKNOWN'].includes(a.status)
      || !string(a.label) || !nullableString(a.taskOutcome)
      || (a.recipe !== null && (!a.recipe || !string(a.recipe.id) || !string(a.recipe.title) || !string(a.recipe.profile)))
      || !a.closure || !nullableBool(a.closure.authorityClosed) || !nullableBool(a.closure.disposalVerified) || !string(a.closure.label)
      || (a.checker !== null && (!a.checker || typeof a.checker.accepted !== 'boolean' || !string(a.checker.reason)))
      || (a.archiveSha256 !== null && !sha(a.archiveSha256)) || !Array.isArray(a.evidence) || a.evidence.length > ARTIFACT_KINDS.length
      || (a.status === 'ACCEPTED' && (a.checker?.accepted !== true || a.closure.authorityClosed !== true
        || a.closure.disposalVerified !== true || a.taskOutcome !== 'COMPLETED' || !sha(a.archiveSha256)))
      || new Set(a.evidence.map(r => r.kind)).size !== a.evidence.length
      || a.evidence.some(r => !validRef(r) || r.runId !== a.runId || r.requestId !== a.requestId || r.generation !== a.generation))
    || new Set(b.attempts.map(a => a.runId)).size !== b.attempts.length
    || b.attempts.some((a, i) => i > 0 && a.created < b.attempts[i - 1]!.created)
    || b.latestRunId !== (b.attempts.at(-1)?.runId ?? null) || !Array.isArray(b.acceptedRunIds)
    || new Set(b.acceptedRunIds).size !== b.acceptedRunIds.length
    || b.acceptedRunIds.length !== b.attempts.filter(a => a.status === 'ACCEPTED').length
    || b.acceptedRunIds.some(id => !b.attempts.some(a => a.runId === id && a.status === 'ACCEPTED'))
    || !b.research || !['ACCEPTED', 'BLOCKED', 'UNKNOWN'].includes(b.research.status)
    || !string(b.research.code) || !string(b.research.message) || (b.research.runId !== undefined && !string(b.research.runId))
    || b.continuation?.enabled !== false || b.continuation.code !== 'FRESH_AUTHORITY_REQUIRED'
    || !string(b.continuation.message) || typeof b.continuation.serviceWindowOpen !== 'boolean'
    || !Array.isArray(b.limits) || b.limits.some(item => !string(item))) throw new Error('invalid_resume_brief')
  return b
}

export function parseResumeSelection(value: unknown): ResumeSelection {
  const s = value as ResumeSelection
  if (!s || !['history', 'artifact', 'feedback', 'plane'].includes(s.kind) || exactResumeUrl(s.planeUrl) !== s.planeUrl
    || !Number.isInteger(s.page) || s.page < 0 || s.page > 50
    || (s.kind === 'artifact' && !validRef(s.reference))
    || (s.kind === 'feedback' && (!string(s.runId) || !sha(s.generation)))) throw new Error('invalid_resume_selection')
  return s
}

export function parseResumeArtifact(value: unknown, expected: ArtifactRef): ResumeArtifact {
  const a = value as ResumeArtifact
  if (!a || !validRef(a.reference) || !string(a.content) || !string(a.basis) || typeof a.accepted !== 'boolean'
    || (Object.keys(expected) as Array<keyof ArtifactRef>).some(key => a.reference[key] !== expected[key])
    || Buffer.byteLength(a.content, 'utf8') !== expected.byteLength
    || createHash('sha256').update(a.content, 'utf8').digest('hex') !== expected.sha256) throw new Error('invalid_resume_artifact')
  return a
}

function button(text: string, selection: ResumeSelection, valueFor: ValueFor, suffix = '') {
  return { type: 'button', action_id: prefix + selection.kind + suffix, text: plain(text), value: valueFor(selection),
    ...(selection.kind === 'plane' ? { url: selection.planeUrl } : {}) }
}
function navigation(planeUrl: string, valueFor: ValueFor): Block {
  return { type: 'actions', elements: [button('History and results', { kind: 'history', planeUrl, page: 0 }, valueFor),
    button('Open in Plane', { kind: 'plane', planeUrl, page: 0 }, valueFor)] }
}
function attemptTitle(a: ResumeAttempt) { return clip(a.recipe?.title ?? 'Work attempt', 180) }
function summaryLines(b: ResumeBrief) {
  const latest = b.attempts.at(-1)
  const accepted = b.attempts.filter(a => a.status === 'ACCEPTED')
  return [clip(b.summary, 380),
    `Latest attempt: ${latest ? attemptTitle(latest) + ' — ' + clip(latest.label, 160) : 'No recorded attempts.'}`,
    `Accepted results: ${accepted.length ? accepted.slice(-3).map(attemptTitle).join(' · ') + (accepted.length > 3 ? ` (${accepted.length} total)` : '') : 'None yet.'}`,
    `Research prerequisite: ${clip(b.research.message, 300)}`,
    `Next: ${clip(b.continuation.message, 320)}`]
}

export function resumeMessage(b: ResumeBrief, valueFor: ValueFor) {
  const lines = summaryLines(b)
  return { text: escaped(clip([b.title, ...lines].join('\n'), 2000)), blocks: [
    { type: 'header', text: plain(clip(b.title || 'Resume work', 150)) },
    ...lines.map(section), navigation(b.planeUrl, valueFor)] }
}

export function resumeHistoryView(b: ResumeBrief, requestedPage: number, valueFor: ValueFor) {
  const pages = Math.max(1, Math.ceil(b.attempts.length / PAGE_SIZE)), page = Math.min(requestedPage, pages - 1)
  const attempts = [...b.attempts].reverse().slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const blocks: Block[] = [section(`${clip(b.title, 200)}\n${b.attempts.length} attempts · newest first · page ${page + 1} of ${pages}`),
    section(`Research prerequisite: ${clip(b.research.message, 600)}\nNext: ${clip(b.continuation.message, 600)}`)]
  for (const a of attempts) {
    blocks.push(section([`${attemptTitle(a)} — ${clip(a.label, 250)}`, `Run: ${a.runId}`,
      `Recorded: ${new Date(a.created * 1000).toISOString()}`, clip(a.closure.label, 300),
      a.checker ? `Checker ${a.checker.accepted ? 'accepted' : 'rejected'}: ${clip(a.checker.reason, 1400)}` : 'No checker verdict recorded.',
      a.archiveSha256 ? `Recorded archive: ${a.archiveSha256}` : 'No verified archive reference recorded.'].join('\n')))
    const actions = a.evidence.map(r => button(
      r.kind === 'report' ? (a.status === 'ACCEPTED' ? 'Read checked report' : 'Read unaccepted draft')
        : softwareArtifact(r.kind)?.label ?? 'Inspect CUDA receipt',
      { kind: 'artifact', planeUrl: b.planeUrl, page: 0, reference: r }, valueFor, '_' + r.kind))
    if (a.checker) actions.push(button('Read checker feedback', {
      kind: 'feedback', planeUrl: b.planeUrl, page: 0, runId: a.runId, generation: a.generation }, valueFor))
    if (actions.length) blocks.push({ type: 'actions', elements: actions })
  }
  if (!attempts.length) blocks.push(section('No attempts are recorded for this exact work-item link in this channel.'))
  const paging = [
    ...(page > 0 ? [button('Newer attempts', { kind: 'history', planeUrl: b.planeUrl, page: page - 1 }, valueFor, '_newer')] : []),
    ...(page + 1 < pages ? [button('Older attempts', { kind: 'history', planeUrl: b.planeUrl, page: page + 1 }, valueFor, '_older')] : []),
    button('Open in Plane', { kind: 'plane', planeUrl: b.planeUrl, page: 0 }, valueFor)]
  blocks.push(section(`Objective source: ${clip(b.objective.basis, 600)}${b.objective.updatedAt ? '\nCaptured item update: ' + clip(b.objective.updatedAt, 100) : ''}`))
  if (b.limits.length) blocks.push(section(b.limits.map(l => clip(l, 350)).slice(0, 6).join('\n')))
  blocks.push({ type: 'actions', elements: paging })
  return { type: 'modal', callback_id: 'fabric_resume_view', title: plain('Work history'), close: plain('Close'), blocks }
}

export function resumeArtifactView(a: ResumeArtifact, s: Extract<ResumeSelection, { kind: 'artifact' }>, valueFor: ValueFor) {
  const textPages = chunks(a.content, TEXT_PAGE_SIZE), pages = Math.max(1, textPages.length), page = Math.min(s.page, pages - 1)
  const content = textPages[page] ?? ''
  const software = softwareArtifact(s.reference.kind)
  const label = software?.label ?? (s.reference.kind === 'report' ? (a.accepted ? 'Checked report' : 'Unaccepted draft') : (a.accepted ? 'Checked CUDA receipt' : 'Unaccepted CUDA receipt'))
  const acceptance = software ? `\n${a.accepted ? 'Checked result.' : 'Acceptance is not established.'}` : ''
  const display = s.reference.kind === 'softwareHtml' ? '\nHTML is shown as plain text.' : ''
  const blocks: Block[] = [section(`${label}${acceptance}${display}\nRun: ${s.reference.runId}\nPage ${page + 1} of ${pages}\n${clip(a.basis, 600)}`)]
  for (const part of chunks(content, 2800)) blocks.push(section(part))
  if (!content.length) blocks.push(section('This retained artifact is empty.'))
  blocks.push(section(`Exact content verified: ${s.reference.byteLength} UTF-8 bytes\nSHA-256: ${s.reference.sha256}`))
  blocks.push({ type: 'actions', elements: [
    ...(page > 0 ? [button('Previous page', { ...s, page: page - 1 }, valueFor, '_previous')] : []),
    ...(page + 1 < pages ? [button('Next page', { ...s, page: page + 1 }, valueFor, '_next')] : []),
    button('Back to history', { kind: 'history', planeUrl: s.planeUrl, page: 0 }, valueFor)] })
  return { type: 'modal', callback_id: 'fabric_resume_view', title: plain(label), close: plain('Close'), blocks }
}

export function resumeFeedbackView(b: ResumeBrief, s: Extract<ResumeSelection, { kind: 'feedback' }>, valueFor: ValueFor) {
  const attempt = b.attempts.find(a => a.runId === s.runId && a.generation === s.generation)
  if (!attempt) throw new Error('resume_feedback_identity_changed')
  const textPages = chunks(attempt.checker?.reason ?? '', TEXT_PAGE_SIZE)
  const pages = Math.max(1, textPages.length), page = Math.min(s.page, pages - 1)
  const content = textPages[page] ?? ''
  const blocks: Block[] = [section(`${attemptTitle(attempt)}\nRun: ${attempt.runId}\nCurrent state: ${clip(attempt.label, 300)}\n${clip(attempt.closure.label, 300)}`),
    section(attempt.checker ? `Checker ${attempt.checker.accepted ? 'accepted' : 'rejected'} the report · page ${page + 1} of ${pages}` : 'No checker verdict is currently available.')]
  for (const part of chunks(content, 2800)) blocks.push(section(part))
  blocks.push({ type: 'actions', elements: [
    ...(page > 0 ? [button('Previous page', { ...s, page: page - 1 }, valueFor, '_previous')] : []),
    ...(page + 1 < pages ? [button('Next page', { ...s, page: page + 1 }, valueFor, '_next')] : []),
    button('Back to history', { kind: 'history', planeUrl: s.planeUrl, page: 0 }, valueFor)] })
  return { type: 'modal', callback_id: 'fabric_resume_view', title: plain('Checker feedback'), close: plain('Close'), blocks }
}

export function isResumeAction(value: unknown): boolean {
  return string(value) && /^(fabric_resume_history(?:_newer|_older)?|fabric_resume_artifact(?:_report|_gpuResult|_softwareSource|_softwareHtml|_softwareResult|_previous|_next)?|fabric_resume_feedback(?:_previous|_next)?|fabric_resume_plane)$/.test(value)
}
