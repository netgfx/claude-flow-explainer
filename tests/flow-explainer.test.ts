import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'powermods-flow-explainer',
  component: 'Pane',
  requestId: 'flow-explainer',
  viewport: { columns: 100, rows: 40 },
  props: { title: 'Flow explainer', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Os = 'windows' | 'posix'

// The fixtures for each kind of session: its working folder, home folder and path separator
const OS = {
  windows: { cwd: 'C:\\work', home: 'C:\\Users\\me', sep: '\\' },
  posix: { cwd: '/work', home: '/home/me', sep: '/' },
} as const

// The runtime resolves a path before an fs stub sees it, and a path from the other OS
// is not absolute there: on a POSIX host C:\work\x arrives as /<cwd>/C:\work\x, and on a
// Windows host /work/x arrives with a drive letter, such as D:\work\x. keyOf undoes that,
// so the stubs find each fixture by the path the mod meant, and every test runs with
// both the Windows and the POSIX fixtures on every host. Windows treats / and \ alike,
// so a Windows key also gets one kind of separator.
function keyOf(os: Os, path: string): string {
  if (os === 'windows') {
    const drive = path.lastIndexOf(':\\')
    return (drive > 0 ? path.slice(drive - 1) : path).replace(/\//g, '\\')
  }
  return path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
}

// Registers the test once with Windows fixtures and once with POSIX ones
function osTest(name: string, body: (os: Os, $: any, on: any) => Promise<void>) {
  for (const os of ['windows', 'posix'] as const) test(name + ' (' + os + ')', ($, on) => body(os, $, on))
}

const join = (os: Os, ...parts: string[]) => parts.join(OS[os].sep)
const savedDir = (os: Os) => join(os, OS[os].home, '.claude', 'flow-explainer', 'saved') + OS[os].sep
const flowsDir = (os: Os) => join(os, OS[os].home, '.claude', 'flow-explainer', 'flows') + OS[os].sep

const FLOW = {
  title: 'How POST /orders reaches the database',
  assumptions: ['end point assumed: the INSERT in orders.repo.ts'],
  steps: [
    { repo: 'api', file: 'src/routes/orders.ts', lines: [10, 14], language: 'ts', kind: 'entry', title: 'Route receives the request', explain: 'The router hands the body to the handler.', technical: 'Express route with a typed body.' },
    { repo: 'api', file: 'src/orders.service.ts', lines: [22, 30], kind: 'db', title: 'Service saves the order', explain: 'The order is written to the database.', technical: 'Single INSERT inside a transaction.', concern: 'No retry on deadlock.' },
  ],
}

// Sets up the stubs every test needs: a session on the given OS, a working command registry, a pane that opens
function setup(on: any, os: Os, opts: { files?: Map<string, string>; submitted?: string[] } = {}) {
  const windows = os === 'windows'
  const files = opts.files ?? new Map<string, string>()
  const submitted = opts.submitted ?? []
  on('session.start', () => ({ cwd: OS[os].cwd }))
  on('session.cwd', () => ({ value: OS[os].cwd }))
  mock.env(on, windows ? { OS: 'Windows_NT', USERPROFILE: OS.windows.home } : { HOME: OS.posix.home })
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('fs.exists', ($: any, e: any) => ({ value: files.has(keyOf(os, e.path)) }))
  on('fs.read', ($: any, e: any) => ({ value: files.get(keyOf(os, e.path)) ?? '' }))
  on('fs.write', ($: any, e: any) => {
    // The text is the argument that isn't the path
    const text = Object.values(e).find((v) => typeof v === 'string' && v !== e.path)
    files.set(keyOf(os, e.path), String(text))
    return { value: undefined }
  })
  // Direct children of the folder only, as $.fs.list is not recursive
  on('fs.list', ($: any, e: any) => {
    const dir = keyOf(os, e.path)
    return {
      value: [...files.keys()]
        .filter((p) => (p.startsWith(dir + '\\') || p.startsWith(dir + '/')) && !p.slice(dir.length + 1).match(/[\\/]/))
        .map((p) => ({ name: p.split(/[\\/]/).pop(), kind: 'file', size: 1, isLink: false })),
    }
  })
  return { files, submitted, toasts }
}

const start = ($: any, os: Os) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: OS[os].cwd } as any)

function savedFlow(os: Os) {
  return JSON.stringify({
    format: 'flow-explainer/1',
    savedAt: '2026-10-10T10:00:00.000Z',
    title: FLOW.title,
    request: 'how does POST /orders reach the database',
    assumptions: FLOW.assumptions,
    progress: 1,
    root: OS[os].cwd,
    // Neither step file exists in these tests, so their digests are null, which is what the check computes
    files: { 'src/routes/orders.ts': null, 'src/orders.service.ts': null },
    steps: FLOW.steps,
  })
}

// The flow path is the one printed in the prompt Claude receives
function pathFrom(prompt: string): string {
  const m = prompt.match(/create the file (.+?) \(create/)
  if (!m) throw new Error('no path in prompt')
  return m[1]
}

osTest('/flow sends a build prompt that writes the flow outside the project', async (os, $, on) => {
  const { submitted } = setup(on, os)
  const clock = mock.clock(on)
  await start($, os)
  await $.command.run({ command: 'flow', args: 'how does POST /orders reach the database' } as any)
  await clock.advance(1000) // the timer sends the queued prompt

  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('Request: how does POST /orders reach the database')
  expect(submitted[0]).toContain('by function')
  expect(pathFrom(submitted[0]).startsWith(flowsDir(os))).toBe(true)
})

osTest('/flow-explain --lines switches the build to line by line', async (os, $, on) => {
  const { submitted } = setup(on, os)
  const clock = mock.clock(on)
  await start($, os)
  await $.command.run({ command: 'flow-explain', args: '--lines explain the diff of this MR' } as any)
  await clock.advance(1000) // the timer sends the queued prompt

  expect(submitted[0]).toContain('line by line')
  expect(submitted[0]).toContain('Request: explain the diff of this MR')
  expect(submitted[0]).not.toContain('--lines')
})

test('posix sessions write the flow under the home folder with forward slashes', async ($, on) => {
  const { submitted } = setup(on, 'posix')
  const clock = mock.clock(on)
  await start($, 'posix')
  await $.command.run({ command: 'flow', args: 'trace the login flow' } as any)
  await clock.advance(1000) // the timer sends the queued prompt

  expect(pathFrom(submitted[0])).toMatch(/^\/home\/me\/\.claude\/flow-explainer\/flows\/[a-z0-9]+\.json$/)
})

osTest('a finished flow file is drawn on both surfaces', async (os, $, on) => {
  const files = new Map<string, string>()
  const { submitted } = setup(on, os, { files })
  const clock = mock.clock(on)
  await start($, os)
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

osTest('the timer walks the steps and stops on the last one', async (os, $, on) => {
  const files = new Map<string, string>()
  const { submitted } = setup(on, os, { files })
  const clock = mock.clock(on)
  await start($, os)
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

osTest('an aborted flow turn says so and offers a rebuild', async (os, $, on) => {
  setup(on, os)
  const clock = mock.clock(on)
  await start($, os)
  await $.command.run({ command: 'flow', args: 'how does checkout work' } as any)
  await clock.advance(1000) // the timer sends the queued prompt
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, usage: null } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /stopped before Claude wrote it/ })).toBeDefined()
  await ui.unmount()
})

osTest('a bare /flow opens the pane with a scenario field and no build', async (os, $, on) => {
  const { submitted } = setup(on, os)
  const clock = mock.clock(on)
  await start($, os)
  await $.command.run({ command: 'flow', args: '' } as any)
  await clock.advance(1000) // the timer sends the queued prompt

  expect(submitted.length).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Input', key: 'flow-input' })).toBeDefined()
  await ui.unmount()
})

osTest('s saves the flow with the step reached, into the saved folder', async (os, $, on) => {
  const files = new Map<string, string>()
  const { submitted } = setup(on, os, { files })
  const clock = mock.clock(on)
  await start($, os)
  await $.command.run({ command: 'flow', args: 'how does POST /orders reach the database --pace=2' } as any)
  await clock.advance(1000) // the timer sends the queued prompt
  files.set(pathFrom(submitted[0]), JSON.stringify(FLOW))
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, usage: null } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'next' }) // step 2, by hand
  await ui.press({ key: 'save' })
  await ui.unmount()

  const saved = [...files.entries()].filter(([path]) => path.startsWith(savedDir(os)))
  expect(saved.length).toBe(1)
  const data = JSON.parse(saved[0][1])
  expect(data.format).toBe('flow-explainer/1')
  expect(data.title).toBe(FLOW.title)
  expect(data.progress).toBe(1)
  expect(data.root).toBe(OS[os].cwd)
  expect(Object.keys(data.files)).toEqual(['src/routes/orders.ts', 'src/orders.service.ts'])
})

osTest('/flow-resume <name> reopens a saved flow paused on its step', async (os, $, on) => {
  const files = new Map<string, string>([[savedDir(os) + 'orders-x.json', savedFlow(os)]])
  setup(on, os, { files })
  const clock = mock.clock(on)
  await start($, os)
  await $.command.run({ command: 'flow-resume', args: 'orders' } as any)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /^Step 2 of 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^manual/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Resumed at step 2 of 2/ })).toBeDefined()
  await ui.unmount()
})

osTest('/flow-resume with no name opens the saved-flow picker', async (os, $, on) => {
  const files = new Map<string, string>([[savedDir(os) + 'orders-x.json', savedFlow(os)]])
  setup(on, os, { files })
  const clock = mock.clock(on)
  await start($, os)
  await $.command.run({ command: 'flow-resume', args: '' } as any)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Select', key: 'saved-picker' })).toBeDefined()
  await ui.unmount()
})

osTest('/flow-resume with no match says so and opens nothing', async (os, $, on) => {
  const files = new Map<string, string>([[savedDir(os) + 'orders-x.json', savedFlow(os)]])
  const { toasts } = setup(on, os, { files })
  const clock = mock.clock(on)
  await start($, os)
  await $.command.run({ command: 'flow-resume', args: 'checkout' } as any)
  await clock.settle()

  expect(toasts.join(' | ')).toContain('No saved flow matches "checkout"')
})

osTest('resume updates the saved flow first when its code changed, then shows it at the same step', async (os, $, on) => {
  const stale = JSON.parse(savedFlow(os))
  stale.files = { 'src/routes/orders.ts': 'not-the-current-digest', 'src/orders.service.ts': null }
  const savedPath = savedDir(os) + 'orders-x.json'
  const files = new Map<string, string>([
    [savedPath, JSON.stringify(stale)],
    [join(os, OS[os].cwd, 'src', 'routes', 'orders.ts'), 'changed code'],
  ])
  const { submitted } = setup(on, os, { files })
  const clock = mock.clock(on)
  await start($, os)
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

  // The file is saved again in the saved format, with the digest of the code as it is now
  const resaved = JSON.parse(files.get(savedPath)!)
  expect(resaved.format).toBe('flow-explainer/1')
  expect(resaved.progress).toBe(1)
  expect(resaved.files['src/routes/orders.ts']).toMatch(/^[0-9a-f]{64}$/)
})

osTest('resume with unchanged files shows the flow straight away, with no update turn', async (os, $, on) => {
  const files = new Map<string, string>([[savedDir(os) + 'orders-x.json', savedFlow(os)]])
  const { submitted } = setup(on, os, { files })
  const clock = mock.clock(on)
  await start($, os)
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

osTest('a digit jumps into a call as a sub-flow, and u returns to the parent', async (os, $, on) => {
  const files = new Map<string, string>()
  const { submitted } = setup(on, os, { files })
  const clock = mock.clock(on)
  await start($, os)
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
