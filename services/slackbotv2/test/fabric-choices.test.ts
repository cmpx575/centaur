import { test, expect } from 'bun:test'
import { askWords, choicesMessage, parseChoices } from '../src/fabric-choices'
import { answer } from './choices-double'

test('only `fabric ask` is an ask; words are trimmed and capped', () => {
  expect(askWords('fabric ask  grok   in windows ')).toBe('grok in windows')
  expect(askWords('fabric ask')).toBe('')
  expect(askWords('fabric asking for trouble')).toBeUndefined()
  expect(askWords('fabric recipes')).toBeUndefined()
  expect(askWords('fabric ask ' + 'x'.repeat(900))!.length).toBe(500)
})

test('each choice opens the usual form by recipe id; text is escaped; capacity is said', () => {
  const message = choicesMessage(parseChoices(answer))
  const buttons = message.blocks.filter((b: any) => b.type === 'actions').flatMap((b: any) => b.elements)
  expect(buttons).toEqual([{ type: 'button', action_id: 'fabric_recipe_open', text: { type: 'plain_text', text: 'Choose how to run' },
    value: 'windows-native-edit-grok' }])
  const shown = JSON.stringify(message.blocks)
  expect(shown).toContain('&lt;one&gt;'); expect(shown).not.toContain('<one>')
  expect(shown).toContain('needs capacity first'); expect(shown).toContain('Nothing starts before Launch')
  expect(message.text).toBe('Fabric choices: Edit the Windows fixture with Grok Build')
})

test('clarify asks the question; nothing-fits has no buttons and shows the note', () => {
  const clarify = choicesMessage({ ...answer, outcome: 'clarify', question: 'Which machine: Linux, Mac, Windows?' })
  expect(JSON.stringify(clarify.blocks[0])).toContain('Which machine: Linux, Mac, Windows?')
  const none = choicesMessage({ ...answer, outcome: 'nothing-fits', choices: [], note: 'For a machine of your own, say `fabric vm`.' })
  expect(none.blocks.filter((b: any) => b.type === 'actions')).toHaveLength(0)
  expect(JSON.stringify(none.blocks)).toContain('fabric vm')
})

test('a shaped choice says how to start it', () => {
  const shaped = choicesMessage({ ...answer, choices: [{ ...answer.choices[0]!, shapeId: 'handoff-then' }] })
  expect(JSON.stringify(shaped.blocks)).toContain('hands the checked file to the next machine')
})

test('a malformed answer is refused', () => {
  for (const bad of [null, {}, { ...answer, kind: 'x' }, { ...answer, outcome: 'maybe' },
    { ...answer, choices: [{ ...answer.choices[0], recipeId: '../x' }] }, { ...answer, choices: Array(6).fill(answer.choices[0]) }]) {
    expect(() => parseChoices(bad)).toThrow()
  }
})
