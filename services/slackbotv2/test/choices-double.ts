import type { Choices } from '../src/fabric-choices'

export const answer: Choices = { kind: 'fabric-choices/v1', intention: 'grok and minimax inside windows', outcome: 'choices', question: null, note: null,
  choices: [{ id: 'run:windows-native-edit-grok:focused', recipeId: 'windows-native-edit-grok', recipeVersion: '1.0.0', recipeDigest: 'a'.repeat(64),
    profile: 'focused', shapeId: null, title: 'Edit the Windows fixture with Grok Build', what: 'Grok edits <one> heading', machine: 'windows',
    agent: 'grok', checked: 'byte gated checker readback', availableNow: false, why: ['grok', 'windows'],
    command: 'fabric launch windows-native-edit-grok focused <Plane-item-link>' }] }
