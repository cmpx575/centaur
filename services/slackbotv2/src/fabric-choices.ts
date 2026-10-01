/** `@centaur fabric ask <what you want>`: the fabric's choices for an intention (fabric `POST /v1/choices`).
 * The fabric decides what fits; this file only renders. Each run choice carries the existing "Choose how to run"
 * button (`fabric_recipe_open`), so picking one opens the same Plane-item form, review and Launch as `fabric recipes`.
 * Nothing starts here. Kept free of other imports so it is tested on its own. */

export type Choice = { id: string; recipeId: string; recipeVersion: string; recipeDigest: string; profile: string;
  shapeId: string | null; title: string; what: string; machine: string | null; agent: string | null; checked: string;
  availableNow: boolean; why: string[]; command: string }
export type Choices = { kind: 'fabric-choices/v1'; intention: string; outcome: 'choices' | 'clarify' | 'nothing-fits';
  question: string | null; choices: Choice[]; note: string | null }

const text = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const plain = (value: string) => ({ type: 'plain_text', text: value })
const section = (value: string) => ({ type: 'section', text: { type: 'mrkdwn', text: value } })
const NAMES: Record<string, string> = { windows: 'Windows', linux: 'Linux', mac: 'Mac', claude: 'Claude', codex: 'Codex',
  grok: 'Grok', minimax: 'MiniMax' }
const SHAPES: Record<string, string> = { 'retry-until-accepted': 'tries again until the checker accepts',
  'handoff-then': 'hands the checked file to the next machine' }

const ASK = /^fabric\s+ask(?:\s+([\s\S]*))?$/i
/** The words after `fabric ask`, or undefined when the text is not an ask. An empty ask gives ''. */
export function askWords(message: string): string | undefined {
  const m = ASK.exec(message.trim())
  return m ? (m[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) : undefined
}

export function parseChoices(value: any): Choices {
  if (!value || value.kind !== 'fabric-choices/v1' || !['choices', 'clarify', 'nothing-fits'].includes(value.outcome)
    || !Array.isArray(value.choices) || value.choices.length > 5) throw new Error('invalid_choices')
  for (const c of value.choices) {
    if (!c || typeof c.recipeId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(c.recipeId) || typeof c.title !== 'string'
      || typeof c.command !== 'string' || typeof c.availableNow !== 'boolean') throw new Error('invalid_choices')
  }
  return value as Choices
}

export function choicesMessage(answer: Choices) {
  const head = answer.outcome === 'nothing-fits' ? '*Nothing in the menu fits that yet.*'
    : answer.outcome === 'clarify' ? `*${text(answer.question ?? 'Which one?')}* These fit equally:`
    : answer.choices.length === 1 ? '*This fits:*' : '*These fit:*'
  const blocks: Record<string, unknown>[] = [section(`${head}\n_You asked:_ ${text(answer.intention)}`)]
  for (const c of answer.choices) {
    const who = [c.agent && NAMES[c.agent], c.machine && 'in ' + (NAMES[c.machine] ?? c.machine)].filter(Boolean).join(' ')
    const lines = [`*${text(c.title)}*${who ? ' · ' + text(who) : ''}${c.availableNow ? '' : ' · _needs capacity first_'}`,
      text(c.what), ...(c.checked ? ['Checked: ' + text(c.checked)] : []),
      ...(c.shapeId ? [`Shape: ${text(SHAPES[c.shapeId] ?? c.shapeId)}. Start it with \`${text(c.command)}\`.`] : [])]
    blocks.push(section(lines.join('\n').slice(0, 2900)))
    blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'fabric_recipe_open', text: plain('Choose how to run'),
      value: c.recipeId }] })
  }
  if (answer.note) blocks.push(section(text(answer.note)))
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn',
    text: 'Choosing opens the usual form: pick the Plane item, review the model, limits and checks, then Launch. Nothing starts before Launch.' }] })
  const fallback = answer.outcome === 'nothing-fits' ? 'Nothing in the fabric menu fits that yet.'
    : 'Fabric choices: ' + answer.choices.map(c => c.title).join('; ')
  return { text: fallback.slice(0, 3000), blocks }
}
