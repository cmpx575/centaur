/** `@centaur fabric vm …`: Linux VMs on request from the fabric-vms lane (fabric intake /v1/vms).
 * Typed words only: no free text reaches the fabric, and every decision (catalog, caps, golden digest,
 * Ceph floor, owner) is made by fabric intake. Cards come back through the durable /v1/vms/deliveries outbox.
 */
import { createHash } from 'node:crypto'
import { verifySlackRequest } from './launcher'
import type { SlackbotV2Options } from './types'
import { fabricMessageText, intake, slack, slackText } from './fabric'

export type VmLease = { lease: string; state: string; pending?: string | null; os: string; size: string; hours: number;
  script: string; network: string; vm?: string; from?: string | null; golden?: string | null; expires?: number | null; error?: string | null;
  channelId: string; threadTs: string; owner: string; access?: { vnc: string; ssh?: string; vncGateway?: string };
  profile?: string; export?: { files?: number; parts?: Array<{ key: string }>; ciphertextSha256?: string; verified?: boolean };
  view: { title: string; status: string; nextAction: string; vm?: string; expires?: string | null; network?: string;
    script?: string; accessLines: string[]; actions: string[] } }

export type VmCommand =
  | { verb: 'help' } | { verb: 'list' }
  | { verb: 'request'; os: string; size?: string; hours?: string; script?: string; network?: string; from?: string; profile?: string }
  | { verb: 'from'; save: string; size?: string; hours?: string }
  | { verb: 'resume' | 'stop' | 'discard' | 'save-close'; lease: string; hours?: string }
  | { verb: 'save'; lease: string; name: string }
  | { verb: 'promote'; save: string; name: string } | { verb: 'goldens' }
  | { verb: 'invalid'; reason: string }

const WORD = /^[a-z0-9][a-z0-9._-]{0,40}$/
const LEASE = /^vl-[0-9]{4}-[0-9a-f]{6}$/
const SIZES = new Set(['small', 'medium', 'large'])
/** Pair entries (a Gateway + Workstation): a bare word after the OS is the privacy profile, not a size. */
const PAIRS = new Set(['whonix'])

/** "2h" / "90m" / "0.25h" -> hours as a decimal string; undefined if not a duration. */
export function duration(word: string): string | undefined {
  const m = /^(\d{1,3}(?:\.\d{1,2})?)(h|m)$/.exec(word)
  if (!m) return
  const hours = m[2] === 'h' ? Number(m[1]) : Number(m[1]) / 60
  return String(Math.round(hours * 1000) / 1000)
}

export function parseVmCommand(text: string): VmCommand | undefined {
  const words = fabricMessageText(text).split(/\s+/).filter(Boolean).map(w => w.toLowerCase())
  if (words[0] !== 'fabric' || words[1] !== 'vm') return
  const rest = words.slice(2)
  if (!rest.length || rest[0] === 'help') return { verb: 'help' }
  if (rest.some(w => w.length > 60)) return { verb: 'invalid', reason: 'a word is too long' }
  const [verb, ...args] = rest
  if (verb === 'list') return { verb: 'list' }
  if (verb === 'goldens') return args.length ? { verb: 'invalid', reason: '`goldens` takes no words' } : { verb: 'goldens' }
  if (verb === 'promote') {
    // names are checked again by fabric intake (lowercase, reserved words, existing goldens)
    if (args.length !== 2 || !WORD.test(args[0]!) || !WORD.test(args[1]!)) return { verb: 'invalid', reason: '`promote` needs `<save> <golden-name>`' }
    return { verb: 'promote', save: args[0]!, name: args[1]! }
  }
  if (verb === 'resume' || verb === 'stop' || verb === 'discard' || verb === 'save-close') {
    if (!args[0] || !LEASE.test(args[0])) return { verb: 'invalid', reason: `\`${verb}\` needs a lease id like \`vl-0925-1a2b3c\`` }
    const hours = verb === 'resume' && args[1] ? duration(args[1]) : undefined
    if (args.length > (verb === 'resume' ? 2 : 1) || (args[1] && !hours)) return { verb: 'invalid', reason: 'unexpected words after the lease id' }
    return { verb, lease: args[0], ...(hours ? { hours } : {}) }
  }
  if (verb === 'save') {
    if (args.length !== 2 || !LEASE.test(args[0]!) || !WORD.test(args[1]!)) return { verb: 'invalid', reason: '`save` needs `<lease> <name>`' }
    return { verb: 'save', lease: args[0]!, name: args[1]! }
  }
  if (verb === 'from') {
    if (!args[0] || !WORD.test(args[0])) return { verb: 'invalid', reason: '`from` needs a save name' }
    const out: VmCommand = { verb: 'from', save: args[0] }
    for (const w of args.slice(1)) {
      const d = duration(w)
      if (d) out.hours = d
      else if (WORD.test(w) && !out.size) out.size = w
      else return { verb: 'invalid', reason: `did not understand \`${slackText(w)}\`` }
    }
    return out
  }
  if (!WORD.test(verb!)) return { verb: 'invalid', reason: 'unknown OS name' }
  const out: Extract<VmCommand, { verb: 'request' }> = { verb: 'request', os: verb! }
  for (const w of args) {
    const d = duration(w)
    const kv = /^(script|from|profile)=([a-z0-9][a-z0-9._-]{0,40})$/.exec(w)
    if (d && !out.hours) out.hours = d
    else if (kv) out[kv[1] as 'script' | 'from' | 'profile'] = kv[2]
    else if (PAIRS.has(out.os) && WORD.test(w) && !out.profile) out.profile = w   // profile names are checked by fabric intake
    else if (w === 'isolated' || w === 'internet') out.network = w
    else if (WORD.test(w) && !out.size && !PAIRS.has(out.os)) out.size = w      // unknown sizes are refused by fabric intake
    else return { verb: 'invalid', reason: `did not understand \`${slackText(w)}\`` }
  }
  return out
}

const HELP = [
  '*Linux VMs on request* (fabric-vms lane, k3s002/gujranwala, internet-only by default)',
  '`@centaur fabric vm ubuntu-desktop [small|medium|large] [2h|8h|24h] [script=none|dev-tools|browser] [isolated]`',
  '`@centaur fabric vm list` · `… vm stop <lease>` · `… vm resume <lease> [8h]` · `… vm save <lease> <name>` · `… vm from <name> [size]` · `… vm discard <lease>`',
  '*Goldens*: `… vm promote <save> <golden-name>` turns one of your saves into a golden on the menu (the save is kept); `… vm goldens` lists them; `@centaur fabric vm <golden-name> [size] [2h]` boots a fresh VM from one.',
  'Sizes: small 2 vCPU/8 GiB · medium 4/16 (default) · large 8/32. Hold 8 h by default, 24 h max; on expiry the VM shuts down and the disk is kept until you `discard` it.',
  '*Whonix* (Tor only): `@centaur fabric vm whonix [profile] [2h|8h]` starts a Gateway + a fresh Workstation (profile `default` if omitted; each profile keeps its own Gateway and Tor guards). Keep files in `~/Export`; `… vm save-close <lease>` (or expiry) encrypts them to Noor\'s key, stores them, and closes both VMs.',
].join('\n')

export function vmCardText(lease: VmLease, event?: string): string {
  const v = lease.view
  const lines = [`*${slackText(v.title)}* · *${slackText(v.status)}*${event?.startsWith('saved:') ? ` · saved as \`${slackText(event.slice(6))}\`` : ''}`,
    slackText(v.nextAction)]
  const facts = [v.vm ? `VM \`${v.vm}\`` : '', v.expires ? `until ${v.expires}` : '', v.network ? `network ${v.network}` : '',
    v.script && v.script !== 'none' ? `script ${v.script}` : '', lease.from ? `from save \`${slackText(lease.from)}\`` : '',
    lease.golden && !lease.lease.startsWith('golden:') ? `from golden \`${slackText(lease.golden)}\`` : ''].filter(Boolean)
  if (facts.length) lines.push(facts.join(' · '))
  if (v.accessLines.length) lines.push('```' + v.accessLines.join('\n') + '```')
  if (lease.export?.parts?.length) lines.push('Stored objects: ' + lease.export.parts.map(p => `\`${slackText(p.key)}\``).join(' '))
  if (v.actions.length) lines.push('Next: ' + v.actions.map(a => `\`@centaur fabric vm ${a} ${lease.lease}${a === 'save' ? ' <name>' : ''}\``).join(' · '))
  return lines.join('\n')
}

export function vmListText(value: Record<string, any>): string {
  const leases = (value.leases ?? []) as VmLease[]
  const saves = (value.saves ?? []) as Array<{ name: string; lease: string; os: string; state: string }>
  const r = value.readiness ?? {}
  const lines = ['*Your VMs*']
  if (!leases.length) lines.push('No VMs.')
  for (const l of leases) lines.push(`• \`${l.lease}\` ${slackText(l.os)} ${l.size} · *${slackText(l.view.status)}*${l.view.expires ? ' · until ' + l.view.expires : ''}`)
  if (saves.length) lines.push('*Saved disks*', ...saves.map(s => `• \`${slackText(s.name)}\` (${slackText(s.os)}, from \`${s.lease}\`) · ${s.state}`))
  const profiles = (value.profiles ?? []) as Array<{ profile: string; os: string; lease?: string | null; sessions: number }>
  if (profiles.length) lines.push('*Privacy profiles* (kept Gateway disks)', ...profiles.map(p => `• \`${slackText(p.profile)}\` (${slackText(p.os)}) · ${p.sessions} session(s)${p.lease ? ` · in use by \`${p.lease}\`` : ''}`))
  const goldens = (value.goldens ?? []) as Array<{ golden: string; os: string; state: string }>
  if (goldens.length) lines.push(`*Goldens* (promoted saves): ${goldens.map(g => `\`${slackText(g.golden)}\` ${g.state === 'READY' ? '' : '· ' + g.state}`.trim()).join(' · ')} · \`@centaur fabric vm goldens\``)
  lines.push(`Ceph block free ≈ ${r.cephBlockMaxAvailGiB ?? '?'} GiB (floor ${r.floorGiB ?? '?'} GiB): ${r.decision ?? 'unknown'}`)
  return lines.join('\n')
}

/** The VM menu: catalog OS entries plus promoted goldens (shared by every allowlisted user). */
export function vmGoldensText(value: Record<string, any>): string {
  const os = (value.catalog?.os ?? {}) as Record<string, string>
  const goldens = (value.goldens ?? []) as Array<{ golden: string; title: string; state: string; save: string; view?: { status: string } }>
  const lines = ['*VM menu*', ...Object.entries(os).map(([k, title]) => `• \`${slackText(k)}\` ${slackText(title)} · \`@centaur fabric vm ${slackText(k)}\``)]
  lines.push('*Goldens from saves*')
  if (!goldens.length) lines.push('None yet. Turn a save into one: `@centaur fabric vm promote <save> <golden-name>`.')
  for (const g of goldens) lines.push(`• \`${slackText(g.golden)}\` ${slackText(g.title)} · *${slackText(g.view?.status ?? g.state)}*`
    + (g.state === 'READY' ? ` · \`@centaur fabric vm ${slackText(g.golden)} [small|medium|large] [2h]\`` : ''))
  const cap = value.catalog?.maxSavedGoldens
  if (cap) lines.push(`Up to ${cap} goldens from saves; each is a 32 GiB Ceph disk kept (Retain) until an operator removes it.`)
  return lines.join('\n')
}

export async function handleVmWebhook(request: Request, raw: string, options: SlackbotV2Options,
  waitUntil: (promise: Promise<unknown>) => void): Promise<Response | undefined> {
  if (!options.fabricIntakeUrl) return
  let payload: any
  try { payload = JSON.parse(raw) } catch { return }
  const event = payload.event
  if (payload.type !== 'event_callback' || event?.type !== 'app_mention' || event.bot_id || event.subtype) return
  const command = parseVmCommand(event.text)
  if (!command) return
  const signed = verifySlackRequest({ nowMs: Date.now(), rawBody: raw, signingSecret: options.signingSecret,
    signature: request.headers.get('x-slack-signature') ?? undefined, timestamp: request.headers.get('x-slack-request-timestamp') ?? undefined })
  if (!signed.ok) return new Response('invalid request', { status: 401 })
  if (!options.launcherAllowedTeamIds?.includes(payload.team_id) || !options.launcherAllowedChannelIds?.includes(event.channel)
      || !options.launcherAllowedUserIds?.includes(event.user)) return new Response('not allowed', { status: 403 })
  const threadTs = event.thread_ts || event.ts
  const reply = (text: string) => slack(options, 'chat.postMessage', { channel: event.channel, thread_ts: threadTs, text,
    unfurl_links: false, unfurl_media: false })
  const who = { teamId: payload.team_id, channelId: event.channel, userId: event.user }
  if (command.verb === 'help') { waitUntil(reply(HELP)); return new Response('ok') }
  if (command.verb === 'invalid') { waitUntil(reply(`Not a VM command: ${command.reason}.\n${HELP}`)); return new Response('ok') }
  const query = '/v1/vms?' + new URLSearchParams(who)
  if (command.verb === 'list' || command.verb === 'goldens') {
    const listed = await intake(options, query)
    if (!listed.ok) {
      if (listed.status >= 500) return new Response('retry', { status: 503 })
      waitUntil(reply(`VM list refused: ${String(listed.value.error ?? 'unavailable')}.`)); return new Response('ok')
    }
    waitUntil(reply(command.verb === 'list' ? vmListText(listed.value) : vmGoldensText(listed.value)))
    return new Response('ok')
  }
  const base = { requestId: String(payload.event_id ?? event.ts), threadTs, ...who }
  let body: Record<string, unknown>
  if (command.verb === 'request') {
    const { verb: _v, ...rest } = command
    body = { ...base, action: 'request', ...rest }
  } else if (command.verb === 'from') {
    // A save restores into the OS it was taken from; the fabric checks owner and state again.
    const listed = await intake(options, query)
    if (!listed.ok) return new Response('retry', { status: 503 })
    const save = (listed.value.saves ?? []).find((s: any) => s.name === command.save)
    if (!save) { waitUntil(reply(`No saved disk \`${slackText(command.save)}\` of yours.`)); return new Response('ok') }
    body = { ...base, action: 'request', os: save.os, from: command.save,
      ...(command.size ? { size: command.size } : {}), ...(command.hours ? { hours: command.hours } : {}) }
  } else if (command.verb === 'save') {
    body = { ...base, action: 'save', lease: command.lease, name: command.name }
  } else if (command.verb === 'promote') {
    body = { ...base, action: 'promote', save: command.save, name: command.name }
  } else {
    body = { ...base, action: command.verb, lease: command.lease, ...('hours' in command && command.hours ? { hours: command.hours } : {}) }
  }
  const result = await intake(options, '/v1/vms', body)
  if (!result.ok) {
    if (result.status >= 500) return new Response('retry', { status: 503 })
    waitUntil(reply(`VM request refused: \`${String(result.value.error ?? 'unavailable')}\`. Nothing was created.`))
    return new Response('ok')
  }
  const lease = result.value as VmLease & { created?: boolean }
  // New leases and state changes are rendered by the outbox consumer; a replay shows the current card.
  if (!lease.created) waitUntil(reply(vmCardText(lease)))
  else if (command.verb === 'stop' || command.verb === 'save' || command.verb === 'save-close' || command.verb === 'promote') waitUntil(reply(vmCardText(lease)))
  return new Response('ok')
}

/** Drains fabric's VM card outbox: post in the request thread, then ack with the Slack ts. */
export async function drainVmDeliveries(options: SlackbotV2Options): Promise<void> {
  const pending = await intake(options, '/v1/vms/deliveries')
  if (!pending.ok) {
    if (pending.status === 503 && pending.value?.error === 'VM_LANE_DISABLED') return
    throw new Error('fabric_vm_outbox_unavailable')
  }
  for (const delivery of pending.value.deliveries as Array<{ id: string; event: string; lease: VmLease }>) {
    const lease = delivery.lease
    if (!options.launcherAllowedChannelIds?.includes(lease.channelId)) throw new Error('fabric_vm_delivery_outside_allowlist')
    const text = vmCardText(lease, delivery.event)
    const hash = createHash('sha256').update('vm:' + delivery.id).digest('hex')
    const clientMessageId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
    const sent = await slack(options, 'chat.postMessage', { channel: lease.channelId, thread_ts: lease.threadTs, text,
      client_msg_id: clientMessageId, unfurl_links: false, unfurl_media: false })
    if (!sent.ts) throw new Error('fabric_vm_delivery_unverified')
    const ack = await intake(options, '/v1/vms/deliveries/ack', { id: delivery.id, receipt: sent.ts })
    if (!ack.ok) throw new Error('fabric_vm_delivery_ack_pending')
  }
}

export function startVmDelivery(options: SlackbotV2Options, everyMs = 5000): () => void {
  if (!options.fabricIntakeUrl) return () => {}
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    try { await drainVmDeliveries(options) }
    catch { options.logger?.warn('fabric_vm_delivery_pending') }
    if (!stopped) { timer = setTimeout(tick, everyMs); timer.unref?.() }
  }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
