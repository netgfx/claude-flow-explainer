import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'flow-explainer-mod',
  component: 'Pane',
  requestId: 'flow-explainer',
  viewport: { columns: 100, rows: 40 },
  props: { title: 'Flow explainer', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const WINDOWS_HOME = 'C:\\Users\\me'

const FLOW = {
  title: 'How POST /orders reaches the database',
  assumptions: ['end point assumed: the INSERT in orders.repo.ts'],
  steps: [
    { repo: 'api', file: 'src/routes/orders.ts', lines: [10, 14], language: 'ts', kind: 'entry', title: 'Route receives the request', explain: 'The router hands the body to the handler.', technical: 'Express route with a typed body.' },
    { repo: 'api', file: 'src/orders.service.ts', lines: [22, 30], kind: 'db', title: 'Service saves the order', explain: 'The order is written to the database.', technical: 'Single INSERT inside a transaction.', concern: 'No retry on deadlock.' },
  ],
}

// Sets up the stubs every test needs: a Windows session, a working command registry, a pane that opens
function setup(on: any, opts: { os?: 'windows' | 'posix'; files?: Map<string, string>; submitted?: string[] } = {}) {
  const windows = (opts.os ?? 'windows') === 'windows'
  const files = opts.files ?? new Map<string, string>()
  const submitted = opts.submitted ?? []
  on('session.start', () => ({ cwd: windows ? 'C:\\work' : '/work' }))
  on('session.cwd', () => ({ value: windows ? 'C:\\work' : '/work' }))
  mock.env(on, windows ? { OS: 'Windows_NT', USERPROFILE: WINDOWS_HOME } : { HOME: '/home/me' })
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    // The text is the argument that isn't the path
    const text = Object.values(e).find((v) => typeof v === 'string' && v !== e.path)
    files.set(e.path, String(text))
    return { value: undefined }
  })
  // Direct children of the folder only, as $.fs.list is not recursive
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter((p) => (p.startsWith(e.path + '\\') || p.startsWith(e.path + '/')) && !p.slice(e.path.length + 1).match(/[\\/]/))
      .map((p) => ({ name: p.split(/[\\/]/).pop(), kind: 'file', size: 1, isLink: false })),
  }))
  return { files, submitted, windows, toasts }
}

const SAVED_DIR = WINDOWS_HOME + '\\.claude\\flow-explainer\\saved\\'
const SAVED_FLOW = JSON.stringify({
  format: 'flow-explainer/1',
  savedAt: '2026-10-10T10:00:00.000Z',
  title: FLOW.title,
  request: 'how does POST /orders reach the database',
  assumptions: FLOW.assumptions,
  progress: 1,
  root: 'C:\\work',
  // Neither step file exists in these tests, so their digests are null, which is what the check computes
  files: { 'src/routes/orders.ts': null, 'src/orders.service.ts': null },
  steps: FLOW.steps,
})

// The flow path is the one printed in the prompt Claude receives
function pathFrom(prompt: string): string {
  const m = prompt.match(/create the file (.+?) \(create/)
  if (!m) throw new Error('no path in prompt')
  return m[1]
}

test('/flow sends a build prompt that writes the flow outside the project', async ($, on) => {
  const { submitted } = setup(on)
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' } as any)
  await $.command.run({ command: 'flow', args: 'how does POST /orders reach the database' } as any)
  await clock.advance(1000) // the timer sends the queued prompt

  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('Request: how does POST /orders reach the database')
  expect(submitted[0]).toContain('by function')
  expect(pathFrom(submitted[0]).startsWith(WINDOWS_HOME + '\\.claude\\flow-explainer\\flows\\')).toBe(true)
})

test('/flow-explain --lines switches the build to line by line', async ($, on) => {
  const { submitted } = setup(on)
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' } as any)
  await $.command.run({ command: 'flow-explain', args: '--lines explain the diff of this MR' } as any)
  await clock.advance(1000) // the timer sends the queued prompt

  expect(submitted[0]).toContain('line by line')
  expect(submitted[0]).toContain('Request: explain the diff of this MR')
  expect(submitted[0]).not.toContain('--lines')
})

test('posix sessions write the flow under the home folder with forward slashes', async ($, on) => {
  const { submitted } = setup(on, { os: 'posix' })
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await $.command.run({ command: 'flow', args: 'trace the login flow' } as any)
  await clock.advance(1000) // the timer sends the queued prompt

  expect(pathFrom(submitted[0])).toMatch(/^\/home\/me\/\.claude\/flow-explainer\/flows\/[a-z0-9]+\.json$/)
})

test('a finished flow file is drawn on both surfaces', async ($, on) => {
  const files = new Map<string, string>()
  const { submitted } = setup(on, { files })
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' } as any)
  await $.command.run({ command: 'flow', args: 'how does POST /orders reach the database' } as any)
  await clock.advance(1000) // the timer sends the queued prompt

  files.set(pathFrom(submitted[0]), '\uFEFF' + JSON.stringify(FLOW))
  await $.turn.complete({ turnId: 't1', answer: 'Flow written: 2 steps.', durationMs: 1000, isAborted: false, usage: null } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ type: 'Text', text: FLOW.title })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Step 1 of 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Route receives the request/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Assumed: end point assumed/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the timer walks the steps and stops on the last one', async ($, on) => {
  const files = new Map<string, string>()
  const { submitted } = setup(on, { files })
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' } as any)
  await $.command.run({ command: 'flow', args: 'walk me through it --pace=2' } as any)
  await clock.advance(1000) // the timer sends the queued prompt
  files.set(pathFrom(submitted[0]), JSON.stringify(FLOW))
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, usage: null } as any)

  // Flows start in manual mode, so switch auto progress on first
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /^manual/ })).toBeDefined()
  await ui.press({ key: 'play' })
  await ui.unmount()

  await clock.advance(2000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /^Step 2 of 2/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(10000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /manual/ })).toBeDefined()
  await ui.unmount()
})

test('an aborted flow turn says so and offers a rebuild', async ($, on) => {
  setup(on)
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' } as any)
  await $.command.run({ command: 'flow', args: 'how does checkout work' } as any)
  await clock.advance(1000) // the timer sends the queued prompt
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, usage: null } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /stopped before Claude wrote it/ })).toBeDefined()
  await ui.unmount()
})

test('a bare /flow opens the pane with a scenario field and no build', async ($, on) => {
  const { submitted } = setup(on)
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' } as any)
  await $.command.run({ command: 'flow', args: '' } as any)
  await clock.advance(1000) // the timer sends the queued prompt

  expect(submitted.length).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Input', key: 'flow-input' })).toBeDefined()
  await ui.unmount()
})

test('s saves the flow with the step reached, into the saved folder', async ($, on) => {
  const files = new Map<string, string>()
  const { submitted } = setup(on, { files })
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' } as any)
  await $.command.run({ command: 'flow', args: 'how does POST /orders reach the database --pace=2' } as any)
  await clock.advance(1000) // the timer sends the queued prompt
  files.set(pathFrom(submitted[0]), JSON.stringify(FLOW))
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, usage: null } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'next' }) // step 2, by hand
  await ui.press({ key: 'save' })
  await ui.unmount()

  const saved = [...files.entries()].filter(([path]) => path.startsWith(SAVED_DIR))
  expect(saved.length).toBe(1)
  const data = JSON.parse(saved[0][1])
  expect(data.format).toBe('flow-explainer/1')
  expect(data.title).toBe(FLOW.title)
  expect(data.progress).toBe(1)
  expect(data.root).toBe('C:\\work')
  expect(Object.keys(data.files)).toEqual(['src/routes/orders.ts', 'src/orders.service.ts'])
})

test('/flow-resume <name> reopens a saved flow paused on its step', async ($, on) => {
  const files = new Map<string, string>([[SAVED_DIR + 'orders-x.json', SAVED_FLOW]])
  setup(on, { files })
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' } as any)
  await $.command.run({ command: 'flow-resume', args: 'orders' } as any)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /^Step 2 of 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^manual/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Resumed at step 2 of 2/ })).toBeDefined()
  await ui.unmount()
})

test('/flow-resume with no name opens the saved-flow picker', async ($, on) => {
  const files = new Map<string, string>([[SAVED_DIR + 'orders-x.json', SAVED_FLOW]])
  setup(on, { files })
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' } as any)
  await $.command.run({ command: 'flow-resume', args: '' } as any)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Select', key: 'saved-picker' })).toBeDefined()
  await ui.unmount()
})

test('/flow-resume with no match says so and opens nothing', async ($, on) => {
  const files = new Map<string, string>([[SAVED_DIR + 'orders-x.json', SAVED_FLOW]])
  const { toasts } = setup(on, { files })
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' } as any)
  await $.command.run({ command: 'flow-resume', args: 'checkout' } as any)
  await clock.settle()

  expect(toasts.join(' | ')).toContain('No saved flow matches "checkout"')
})

test('resume updates the saved flow first when its code changed, then shows it at the same step', async ($, on) => {
  const stale = JSON.parse(SAVED_FLOW)
  stale.files = { 'src/routes/orders.ts': 'not-the-current-digest', 'src/orders.service.ts': null }
  const savedPath = SAVED_DIR + 'orders-x.json'
  const files = new Map<string, string>([[savedPath, JSON.stringify(stale)], ['C:\work\src\routes\orders.ts', 'changed code']])
  const { submitted } = setup(on, { files })
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' } as any)
  await $.command.run({ command: 'flow-resume', args: 'orders' } as any)
  await clock.advance(1000) // the timer sends the update prompt

  expect(submitted[0]).toContain('These files changed since the flow was saved: src/routes/orders.ts')
  const path = submitted[0].match(/overwrite (.+?) with the updated/)![1]
  expect(path).toBe(savedPath)

  // Claude rewrites the file in the plain flow shape, then the turn ends
  files.set(path, JSON.stringify(FLOW))
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: false, usage: null } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /^Step 2 of 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Updated to match the current code/ })).toBeDefined()
  await ui.unmount()

  // The file is saved again in the saved format, with a digest for the new code
  const resaved = JSON.parse(files.get(savedPath)!)
  expect(resaved.format).toBe('flow-explainer/1')
  expect(resaved.progress).toBe(1)
  expect(resaved.files['src/routes/orders.ts']).not.toBe('not-the-current-digest')
})

test('resume with unchanged files shows the flow straight away, with no update turn', async ($, on) => {
  const files = new Map<string, string>([[SAVED_DIR + 'orders-x.json', SAVED_FLOW]])
  const { submitted } = setup(on, { files })
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' } as any)
  await $.command.run({ command: 'flow-resume', args: 'orders' } as any)
  await clock.advance(1000)

  expect(submitted.length).toBe(0)
})

const WITH_CALLS = {
  ...FLOW,
  steps: [
    { ...FLOW.steps[0], calls: [{ name: 'createOrder', file: 'src/orders.service.ts', lines: [22, 30] }] },
    FLOW.steps[1],
  ],
}

test('a digit jumps into a call as a sub-flow, and u returns to the parent', async ($, on) => {
  const files = new Map<string, string>()
  const { submitted } = setup(on, { files })
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' } as any)
  await $.command.run({ command: 'flow', args: 'how does POST /orders reach the database' } as any)
  await clock.advance(1000)
  files.set(pathFrom(submitted[0]), JSON.stringify(WITH_CALLS))
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, usage: null } as any)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /Jump into/ })).toBeDefined()
  await ui.press({ key: 'jump-0-0' }) // the button for the first call, also the digit 1
  await ui.unmount()

  await clock.advance(1000) // the timer sends the sub-flow prompt
  expect(submitted[1]).toContain('Explain what happens from createOrder (src/orders.service.ts:22-30) onward')

  const child = { ...FLOW, title: 'From createOrder' }
  files.set(pathFrom(submitted[1]), JSON.stringify(child))
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: false, usage: null } as any)

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: 'From createOrder' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Jumped from: How POST/ })).toBeDefined()
  await ui.press({ key: 'back-parent' })
  expect(await ui.find({ type: 'Text', text: FLOW.title })).toBeDefined()
  await ui.unmount()
})
