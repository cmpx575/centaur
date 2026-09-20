import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { fabricCommand, formatRun, handleFabricWebhook, drainFabricDeliveries } from '../src/fabric'

describe('typed fabric transport', () => {
  const payload = { type: 'event_callback', team_id: 'T1', event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1789846137.000001', text: '<@UBOT> fabric review first' } }
  test('existing non-fabric commands stay on Centaur', () => {
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT> reply PONG' } }))).toBeUndefined()
  })
  test('typed request and unsupported task separation', () => {
    expect(fabricCommand(JSON.stringify(payload))?.requestId).toBe('first')
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT> fabric review first *Sent using* ChatGPT' } }))?.requestId).toBe('first')
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT> fabric review first\u2063' } }))?.requestId).toBe('first')
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT> fabric review ' + 'x'.repeat(65) } }))?.command).toBe('unsupported')
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT> fabric deploy production' } }))?.command).toBe('unsupported')
  })
  test('connector attribution cannot turn into task instructions', () => {
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT|centaur> fabric review first\n\n*Sent using* <@UCHATGPT>' } }))?.requestId).toBe('first')
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT> fabric review first *Sent using* ChatGPT' } }))?.requestId).toBe('first')
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT> fabric review first\u2063' } }))?.requestId).toBe('first')
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT> fabric review ' + 'x'.repeat(65) } }))?.command).toBe('unsupported')
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT> fabric deploy prod\n\nfabric review first' } }))?.command).toBe('unsupported')
  })
  test('unsigned callback never reaches intake', async () => {
    const raw = JSON.stringify(payload)
    const response = await handleFabricWebhook(new Request('https://example.test'), raw,
      { apiUrl: '', fabricIntakeUrl: 'http://unused', botToken: 'test', signingSecret: 'test' }, () => { throw new Error('side effect') })
    expect(response?.status).toBe(401)
  })
  test('signed but unauthorized user never reaches intake', async () => {
    const raw = JSON.stringify(payload), stamp = String(Math.floor(Date.now()/1000))
    const signature = 'v0=' + createHmac('sha256','test').update(`v0:${stamp}:${raw}`).digest('hex')
    const req = new Request('https://example.test', { headers: { 'x-slack-signature': signature, 'x-slack-request-timestamp': stamp } })
    const response = await handleFabricWebhook(req, raw, { apiUrl: '', fabricIntakeUrl: 'http://unused', botToken: 'test', signingSecret: 'test', launcherAllowedTeamIds: ['T1'], launcherAllowedChannelIds: ['C1'], launcherAllowedUserIds: ['U2'] }, () => { throw new Error('side effect') })
    expect(response?.status).toBe(403)
  })
  test('failed closure cannot be presented as completed', () => {
    const text = formatRun({ requestId: 'x', runId: 'r', state: 'FAILED', channelId: 'C1', threadTs: '1', result: { terminal: { taskOutcome: 'COMPLETED', artifactVerified: true, authorityClosed: false, disposalVerified: false } } })
    expect(text).toContain('— FAILED')
    expect(text).toContain('Access closed: false')
  })
})


test('Plane links are preserved without allowing footer instructions', () => {
  const raw = JSON.stringify({type:'event_callback', event:{type:'app_mention',text:'<@UBOT> fabric review next <https://plane.example.test/w/projects/p/issues/i/|work item>\nhttps://evil.test/'}})
  expect(fabricCommand(raw)?.planeUrl).toBe('https://plane.example.test/w/projects/p/issues/i/')
})

test('a fresh consumer drains retained output and acknowledges only after Slack accepts it', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(tmpdir() + '/fabric-outbox-')
  writeFileSync(dir + '/token', 'test-identity')
  let sent = false, acknowledged = false
  const delivery = {id:'run:result:slack',run:{requestId:'request',runId:'run',state:'COMPLETED',channelId:'C1',threadTs:'1',result:{report:'Useful checked answer'}}}
  const options = { apiUrl:'',botToken:'test',signingSecret:'test',fabricIntakeUrl:'http://intake',fabricTokenPath:dir+'/token',launcherAllowedChannelIds:['C1'],
    fetch: (async (url: any, init: any) => {
      if (String(url).endsWith('/v1/deliveries')) return Response.json({deliveries:[delivery]})
      if (String(url).endsWith('/chat.postMessage')) {sent=true;expect(JSON.parse(init.body).text).toContain('Useful checked answer');return Response.json({ok:true,ts:'2'})}
      if (String(url).endsWith('/v1/deliveries/ack')) {expect(sent).toBe(true);acknowledged=true;return Response.json({ok:true})}
      throw new Error('unexpected request')
    }) as typeof fetch }
  try { await drainFabricDeliveries(options);expect(acknowledged).toBe(true) }
  finally {rmSync(dir,{recursive:true,force:true})}
})
