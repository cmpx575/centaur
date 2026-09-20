import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { fabricCommand, formatRun, handleFabricWebhook } from '../src/fabric'

describe('typed fabric transport', () => {
  const payload = { type: 'event_callback', team_id: 'T1', event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1789846137.000001', text: '<@UBOT> fabric review first' } }
  test('existing non-fabric commands stay on Centaur', () => {
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT> reply PONG' } }))).toBeUndefined()
  })
  test('typed request and unsupported task separation', () => {
    expect(fabricCommand(JSON.stringify(payload))?.requestId).toBe('first')
    expect(fabricCommand(JSON.stringify({ ...payload, event: { ...payload.event, text: '<@UBOT> fabric deploy production' } }))?.command).toBe('unsupported')
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
