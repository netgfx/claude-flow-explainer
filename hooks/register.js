// Flow explainer: /flow and /flow-explain turn a scenario, a question or a diff
// into a guided walk through the code, one step at a time. Flows can be saved,
// resumed later with /flow-resume, and jumped into from any call they make.
//
// The flow is built by a normal Claude turn in the main session, so it uses the
// session's model and thinking effort and can read the whole codebase (git, linked
// workspaces, CLAUDE.md, local rules). Claude writes the flow as JSON to a file
// outside the project. When that turn completes, this module reads the file and
// draws it in a pane.

const PANE = 'flow-explainer'
const DEFAULT_PACE = 6 // seconds per step while playing
const CODE_LIMIT = 2000 // characters of code shown per step
const WINDOW = 9 // rows in the vertical step list
const MAX_CALLS = 9 // jump targets per step, one digit key each
const SAVED_FORMAT = 'flow-explainer/1' // marks a file as a saved flow, so listings skip other JSON

const COMMANDS = [
  {
    name: 'flow',
    description: 'Explain a scenario, question or diff as a guided, step-by-step code flow',
    argumentHint: '<scenario> [--lines | --functions] [--pace=N]',
  },
  {
    name: 'flow-explain',
    description: 'Explain a scenario, question or diff as a guided, step-by-step code flow',
    argumentHint: '<scenario> [--lines | --functions] [--pace=N]',
  },
  {
    name: 'flow-resume',
    description: 'Reopen a saved flow at the step you saved it on',
    argumentHint: '[name]',
  },
]

let platform // 'windows' | 'posix', cached until the next reload
let flow = null // { title, request, assumptions, steps: [...] } once a flow is ready
let index = 0 // current step
let playing = true // auto-advance on or off
let elapsed = 0 // seconds spent on the current step
let pace = DEFAULT_PACE
let lineMode = false // build the next flow line by line instead of by function
let pending = null // { id, path, question, lineMode, kind, ... } while Claude builds or updates a flow
let inputMode = null // null | 'new' (a scenario) | 'ask' (a question about this step) | 'open' (saved flows)
let problem = '' // last error, shown in the pane
let notice = '' // last success, shown in the pane
let lastRequest = '' // what 'r' rebuilds
let savedPath = null // where the current flow is saved, so 's' updates the same file
let savedList = [] // saved flows shown in the picker
// Flows this one was jumped from: { flow, index, savedPath }. 'u' pops one.
const stack = []
// A prompt waiting to be sent. A command or press hook can't start a turn itself
// (the host refuses: it would wait on the turn the hook holds), so tick() sends it.
let queued = null // { text, isBuild }

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim()
const baseName = (path) => path.split(/[\\/]/).pop()
const slugOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'flow'

// Top-level, so passing $ to it is allowed
async function detectPlatform($) {
  if (platform) return platform
  const cwd = await $.session.cwd()
  if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')) platform = 'windows'
  else platform = (await $.env.get('OS')) === 'Windows_NT' ? 'windows' : 'posix'
  return platform
}

async function sepOf($) {
  return (await detectPlatform($)) === 'windows' ? '\\' : '/'
}

// ~/.claude/flow-explainer: outside the project, so nothing lands in the repo
async function baseDir($) {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  return [home, '.claude', 'flow-explainer'].join(await sepOf($))
}

async function flowPath($, id) {
  return (await baseDir($)) + (await sepOf($)) + 'flows' + (await sepOf($)) + id + '.json'
}

async function savedDir($) {
  return (await baseDir($)) + (await sepOf($)) + 'saved'
}

const openPane = ($) => $.ui.open({ id: PANE, title: 'Flow explainer', focus: true, closeOnEscape: true })

// "--lines" and "--functions" pick the granularity, "--pace=N" the seconds per step.
// Everything else is the scenario.
function parseArgs(raw) {
  let question = String(raw ?? '')
  const flags = { lineMode: null, pace: null }
  question = question.replace(/(^|\s)--(lines|functions)(?=\s|$)/g, (_, lead, which) => {
    flags.lineMode = which === 'lines'
    return ' '
  })
  question = question.replace(/(^|\s)--pace=(\d+)(?=\s|$)/g, (_, lead, n) => {
    flags.pace = Math.max(2, Number(n))
    return ' '
  })
  return { question: question.trim(), ...flags }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// The JSON a flow file must hold. Used for new flows and for updates.
function flowSchema(id) {
  return [
    '{',
    '  "id": "' + id + '",',
    '  "title": "short title for the whole flow",',
    '  "assumptions": ["end point assumed: ...", "..."],',
    '  "steps": [',
    '    {',
    '      "repo": "repo or workspace name, optional",',
    '      "file": "path relative to the repo root",',
    '      "lines": [start, end],',
    '      "symbol": "function or identifier, optional",',
    '      "language": "ts | js | py | cs | ... for highlighting",',
    '      "kind": "entry | input | call | transform | branch | io | db | external | render | output | note",',
    '      "title": "under 60 characters",',
    '      "explain": "1-3 sentences, plain language",',
    '      "technical": "the precise detail",',
    '      "code": "exact lines from the file, up to 12 lines, optional",',
    '      "concern": "optional review note with a short reason",',
    '      "calls": [{"name": "function or method this step calls, defined in this codebase", "file": "its file", "lines": [start, end]}]',
    '    }',
    '  ]',
    '}',
    '"calls" is optional, up to ' + MAX_CALLS + ' per step. Each one becomes a jump target, so list the calls whose definitions are worth opening.',
  ]
}

function buildPrompt(question, byLine, path, id) {
  const granularity = byLine
    ? 'line by line: one step per statement or meaningful line'
    : 'by function: one step per function, or per meaningful block inside a long function'
  return [
    '[flow-explainer] Build a guided flow for the request below. Read-only: do not edit project files and do not run commands that change state.',
    '',
    'Request: ' + question,
    'Granularity: ' + granularity,
    '',
    'How to work:',
    '1. Find the starting point the request names: a file, symbol, endpoint, UI element, scenario, or a diff/MR/PR/branch. For a diff, use git (git diff, git log, git show) to read the change set.',
    '2. Follow the real execution path from the start through calls, data transformations, I/O and branches, in the order the code runs.',
    '3. Stop at the end. If the request names no end point, assume one: in a frontend app the flow ends at the UI element that renders the data; in a backend app it ends at the HTTP response, a database write, or the call that leaves this codebase (an external API, a queue, another service). Write the assumption in "assumptions".',
    '4. If a symlink, linked directory or additional workspace connects to another project (for example a database project linked into the backend), follow it and keep going there. Put the repo name in each step\'s "repo".',
    '5. Check each step against the language\'s best practices and this project\'s own rules: CLAUDE.md files, .claude/ rules and skills, lint and format config. Put real deviations or risks in "concern" with a short reason. Don\'t invent problems.',
    '6. Write for a junior developer: "explain" is plain language about what happens and why; "technical" is the precise detail: what the code does, the data shape, the idiom it uses, and any best-practice note.',
    '',
    'Output: use the Write tool to create the file ' + path + ' (create the parent folder if it is missing). The file must contain only JSON in this shape:',
    ...flowSchema(id),
    'Keep the steps in execution order. Keep "code" to exact text from the file. Aim for at most 80 steps.',
    '',
    'When the file is written, reply with one line: "Flow ' + id + ' written: N steps." Don\'t paste the JSON into the chat.',
  ].join('\n')
}

// Sent before a saved flow is shown, when the code it describes has changed
function buildUpdatePrompt(path, f, changed) {
  const what = changed.untracked
    ? 'This saved flow was made before change tracking existed, so re-check every step against the current code.'
    : 'These files changed since the flow was saved: ' + changed.files.slice(0, 30).join(', ') + '. Re-check the steps that touch them.'
  return [
    '[flow-explainer] Update a saved flow before it is shown. Read-only except for that one file.',
    '',
    'Flow: ' + f.title,
    'Original request: ' + (f.request || '(not recorded)'),
    what,
    '',
    'How to work:',
    '1. Read the saved flow in ' + path + '. It is a saved flow, format "' + SAVED_FORMAT + '", with the steps and the step the user had reached.',
    '2. Re-read the changed files. Update each affected step: new line numbers, changed code, removed logic (remove the step or rewrite it), and new logic on the same path (add a step). Keep the steps that are still correct, with their wording.',
    '3. Keep the execution order, and keep the end point in "assumptions" unless it moved.',
    '4. Always write the file, even when nothing changed.',
    '',
    'Output: use the Write tool to overwrite ' + path + ' with the updated flow in this shape:',
    ...flowSchema(f.id || 'keep'),
    '',
    'When written, reply with one line: "Flow updated: N steps." Don\'t paste the JSON into the chat.',
  ].join('\n')
}

function shorten(text, max = 60) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

// One step from a Claude-written step (repo/file/lines) or a saved step (where, calls)
function toStep(s, i) {
  const lines = Array.isArray(s.lines) ? s.lines.filter((n) => Number.isFinite(n)) : []
  const location = [str(s.file), lines.length ? lines.join('-') : ''].filter(Boolean).join(':')
  const calls = (Array.isArray(s.calls) ? s.calls : [])
    .filter((c) => c && typeof c === 'object' && str(c.name))
    .slice(0, MAX_CALLS)
    .map((c) => {
      const callLines = Array.isArray(c.lines) ? c.lines.filter((n) => Number.isFinite(n)) : []
      return {
        name: str(c.name),
        where: str(c.where) || [str(c.file), callLines.length ? callLines.join('-') : ''].filter(Boolean).join(':'),
      }
    })
  return {
    n: i + 1,
    title: str(s.title),
    kind: str(s.kind) || 'step',
    file: str(s.file),
    where: str(s.where) || [str(s.repo), location].filter(Boolean).join(' · '),
    language: str(s.language),
    explain: str(s.explain),
    technical: str(s.technical),
    code: str(s.code).slice(0, CODE_LIMIT),
    concern: str(s.concern),
    calls,
  }
}

function normalizeFlow(data) {
  const steps = (Array.isArray(data.steps) ? data.steps : []).filter((s) => s && typeof s === 'object').map(toStep)
  return {
    id: str(data.id),
    title: str(data.title) || 'Flow',
    assumptions: Array.isArray(data.assumptions) ? data.assumptions.map(str).filter(Boolean) : [],
    steps,
  }
}

// A saved file: the flow plus the step the user had reached
function flowFromSaved(data) {
  if (data.format !== SAVED_FORMAT) throw new Error('it is not a saved flow')
  const parsed = normalizeFlow(data)
  if (!parsed.steps.length) throw new Error('it has no steps')
  const progress = Number.isInteger(data.progress) ? data.progress : 0
  return {
    ...parsed,
    request: str(data.request),
    savedAt: str(data.savedAt),
    progress: Math.min(Math.max(0, progress), parsed.steps.length - 1),
  }
}

function parseJson(text) {
  return JSON.parse(String(text).replace(/^﻿/, ''))
}

// SHA-256 of a file's text, with line endings normalized so CRLF and LF match
async function digestOf(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.replace(/\r\n/g, '\n')))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The digest of a file under the project root, or null when it doesn't exist
async function fileDigest($, path) {
  try {
    if (!(await $.fs.exists(path))) return null
    return await digestOf(String(await $.fs.read(path)))
  } catch {
    return null
  }
}

// Strip a leading "./" or "/" so a step's file joins onto the root
const relativeFile = (file) => file.replace(/^(\.[\\/]|[\\/])+/, '')

// A digest for each file the steps touch, taken now. Saved with the flow so a later
// resume can tell which files changed.
async function fingerprints($, root, steps) {
  const sep = await sepOf($)
  const out = {}
  for (const file of new Set(steps.map((s) => s.file).filter(Boolean))) {
    out[file] = await fileDigest($, root + sep + relativeFile(file))
  }
  return out
}

// Files whose digest differs from the save, including files that appeared or vanished.
// A flow saved before change tracking has no digests, so every step is re-checked.
async function changedSince($, data) {
  if (!data.files || typeof data.files !== 'object') return { untracked: true, files: [] }
  const sep = await sepOf($)
  const root = str(data.root) || (await $.session.cwd())
  const files = []
  for (const file of new Set((Array.isArray(data.steps) ? data.steps : []).map((s) => str(s.file)).filter(Boolean))) {
    const now = await fileDigest($, root + sep + relativeFile(file))
    if (!(file in data.files) || data.files[file] !== now) files.push(file)
  }
  return { untracked: false, files }
}

// Shared by /flow, /flow-explain and the pane's rebuild key. A jump keeps the stack.
async function buildFlow($, question, jump = false) {
  if (!jump) stack.length = 0
  const id = newId()
  const path = await flowPath($, id)
  pending = { id, path, question, lineMode, kind: 'build' }
  lastRequest = question
  flow = null
  index = 0
  playing = true
  elapsed = 0
  problem = ''
  notice = ''
  savedPath = null
  inputMode = null
  await openPane($)
  $.ui.status('Flow explainer: Claude is building the flow in the main chat')
  queued = { text: buildPrompt(question, lineMode, path, id), isBuild: true }
  $.ui.invalidate('ui.render')
}

async function startFlow($, raw) {
  const args = parseArgs(raw)
  if (args.lineMode !== null) lineMode = args.lineMode
  if (args.pace !== null) pace = args.pace
  if (!args.question) {
    // A bare /flow opens the pane and asks for the scenario there
    inputMode = 'new'
    await openPane($)
    $.ui.invalidate('ui.render')
    return
  }
  await buildFlow($, args.question)
}

// Ask about the step the user paused on. The answer comes back in the main chat.
async function askAboutStep($, question) {
  if (!flow) return
  const step = flow.steps[index]
  const text = [
    '[flow-explainer] The user paused the flow "' + flow.title + '" at step ' + step.n + ' of ' + flow.steps.length + ': ' + step.title + (step.where ? ' (' + step.where + ')' : '') + '.',
    'The flow explained it as: ' + step.explain,
    'Question: ' + question,
    'Answer as a tutor for this codebase. Check the code at that location, keep the answer short, and don\'t edit anything.',
  ].join('\n')
  queued = { text, isBuild: false }
  $.ui.invalidate('ui.render')
}

// Jump into a call from the current step: a sub-flow that starts at its definition
async function jumpTo($, call) {
  if (!flow) return
  stack.push({ flow, index, savedPath })
  const where = call.where ? ' (' + call.where + ')' : ''
  await buildFlow(
    $,
    'Explain what happens from ' + call.name + where + ' onward, starting at its definition. This is a sub-flow of "' + flow.title + '", opened from step ' + (index + 1) + '. Use the same format.',
    true,
  )
}

// Return to the flow the jump came from, paused where it was
function backToParent() {
  const top = stack.pop()
  if (!top) return
  if (queued && queued.isBuild) queued = null
  pending = null
  flow = top.flow
  index = top.index
  savedPath = top.savedPath
  playing = false
  elapsed = 0
  problem = ''
  notice = 'Back to ' + flow.title
  inputMode = null
}

// Writes the current flow and the step reached. Saving again updates the same file.
// Also records a digest of each step's file, for the change check on resume.
async function saveFlow($) {
  if (!flow) return
  const sep = await sepOf($)
  const path = savedPath ?? (await savedDir($)) + sep + slugOf(flow.title) + '-' + Date.now().toString(36) + '.json'
  const root = await $.session.cwd()
  try {
    const data = {
      format: SAVED_FORMAT,
      savedAt: new Date().toISOString(),
      title: flow.title,
      request: flow.request,
      assumptions: flow.assumptions,
      progress: index,
      root,
      files: await fingerprints($, root, flow.steps),
      steps: flow.steps,
    }
    await $.fs.write(path, JSON.stringify(data, null, 2))
    savedPath = path
    problem = ''
    notice = 'Saved at step ' + (index + 1) + ' of ' + flow.steps.length + ' · ' + baseName(path)
  } catch (err) {
    problem = 'Could not save the flow to ' + path + ': ' + err.message
  }
}

// The saved flows, newest first. A missing folder means nothing has been saved yet.
async function listSaved($) {
  const dir = await savedDir($)
  const sep = await sepOf($)
  let entries = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const saved = []
  for (const entry of entries) {
    if (!/\.json$/i.test(entry.name)) continue
    const path = dir + sep + entry.name
    try {
      const f = flowFromSaved(parseJson(await $.fs.read(path)))
      saved.push({
        name: entry.name,
        path,
        title: f.title,
        savedAt: f.savedAt,
        label: f.title + '  ·  step ' + (f.progress + 1) + '/' + f.steps.length + '  ·  ' + f.savedAt.slice(0, 10),
      })
    } catch {
      // Not a saved flow: skip it
    }
  }
  return saved.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
}

// Has the code changed since this flow was saved? If so, Claude updates the saved file
// first, and the flow is shown once that turn finishes.
async function startUpdate($, path, raw, f, changed) {
  pending = { id: newId(), path, question: f.request || f.title, lineMode, kind: 'update', before: raw, progress: f.progress }
  flow = null
  index = 0
  playing = false
  elapsed = 0
  savedPath = path
  problem = ''
  notice = ''
  inputMode = null
  await openPane($)
  $.ui.status('Flow explainer: updating the flow for code that changed since it was saved')
  queued = { text: buildUpdatePrompt(path, { ...f, id: '' }, changed), isBuild: true }
  $.ui.invalidate('ui.render')
}

// Opens a saved flow paused on the step it was saved at, updating it first if the code moved
async function loadSaved($, path) {
  const raw = await $.fs.read(path)
  const data = parseJson(raw)
  const f = flowFromSaved(data)
  stack.length = 0
  lastRequest = f.request || lastRequest
  const changed = await changedSince($, data)
  if (changed.untracked || changed.files.length) {
    await startUpdate($, path, raw, f, changed)
    return
  }
  flow = f
  index = f.progress
  playing = false
  elapsed = 0
  savedPath = path
  pending = null
  problem = ''
  notice = 'Resumed at step ' + (index + 1) + ' of ' + f.steps.length + ' · ' + baseName(path)
  inputMode = null
  await openPane($)
  $.ui.invalidate('ui.render')
}

// /flow-resume with no name opens the picker. With a name, it loads the first match.
async function startResume($, raw) {
  const query = String(raw ?? '').trim().toLowerCase()
  if (!query) {
    savedList = await listSaved($)
    inputMode = 'open'
    await openPane($)
    $.ui.invalidate('ui.render')
    return
  }
  const hit = (await listSaved($)).find((s) => s.name.toLowerCase().includes(query) || s.title.toLowerCase().includes(query))
  if (!hit) {
    $.ui.toast('No saved flow matches "' + query + '".')
    return
  }
  await loadSaved($, hit.path)
}

// Runs once a second from session.start. Sends a queued prompt, then moves to the
// next step when the pace is up.
function tick($) {
  if (queued) {
    const { text, isBuild } = queued
    queued = null
    Promise.resolve($.prompt.submit({ text })).catch((err) => {
      if (isBuild) pending = null
      problem = 'Could not send to the chat: ' + err.message
      $.ui.status('')
      $.ui.invalidate('ui.render')
    })
  }
  if (!flow || !playing || inputMode) return
  elapsed += 1
  if (elapsed >= pace) {
    elapsed = 0
    if (index < flow.steps.length - 1) index += 1
    else playing = false // stop on the last step so it stays on screen
  }
  $.ui.invalidate('ui.render')
}

function go($, delta) {
  if (!flow) return
  index = Math.min(flow.steps.length - 1, Math.max(0, index + delta))
  elapsed = 0
  $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    for (const command of COMMANDS) {
      try {
        await $.command.register({ ...command, immediate: true })
      } catch (err) {
        $.ui.log('could not register /' + command.name + ': ' + err.message, { to: 'debug' })
      }
    }
    $.clock.every(1000, () => tick($))
    return next(e)
  })

  on('command.run', { command: 'flow' }, async ($, e) => {
    await startFlow($, e.args)
    return {}
  }).catch(async () => ({ text: 'The flow could not start. Run with --debug to see why.' }))

  on('command.run', { command: 'flow-explain' }, async ($, e) => {
    await startFlow($, e.args)
    return {}
  }).catch(async () => ({ text: 'The flow could not start. Run with --debug to see why.' }))

  on('command.run', { command: 'flow-resume' }, async ($, e) => {
    await startResume($, e.args)
    return {}
  }).catch(async () => ({ text: 'The saved flow could not be opened. Run with --debug to see why.' }))

  // The flow turn is done. Its file is there if Claude wrote it; otherwise keep waiting.
  on('turn.complete', async ($, e, next) => {
    if (!pending) return next(e)
    const job = pending
    let raw = null
    let readError = ''
    try {
      if (await $.fs.exists(job.path)) raw = await $.fs.read(job.path)
    } catch (err) {
      readError = err.message
    }
    // An update starts from the saved file, so only a changed file counts as Claude's answer
    const written = raw !== null && (job.kind !== 'update' || raw !== job.before)
    if (!written) {
      if (e.isAborted || readError) {
        pending = null
        problem = 'The flow was stopped before Claude wrote it' + (readError ? ' (' + readError + ')' : '') + '. Press r to rebuild.'
        $.ui.status('')
        $.ui.invalidate('ui.render')
      }
      return next(e)
    }

    pending = null
    $.ui.status('')
    try {
      const parsed = normalizeFlow(parseJson(raw))
      if (!parsed.steps.length) throw new Error('it has no steps')
      flow = { ...parsed, request: job.question }
      problem = ''
      if (job.kind === 'update') {
        // Keep the step the user had reached, and save again to record the new digests
        index = Math.min(Math.max(0, job.progress), parsed.steps.length - 1)
        playing = false
        elapsed = 0
        savedPath = job.path
        await saveFlow($)
        if (!problem) notice = 'Updated to match the current code · ' + baseName(job.path)
      } else {
        index = 0
        elapsed = 0
        playing = true
      }
    } catch (err) {
      flow = null
      problem = 'Claude wrote ' + job.path + ' but it is not a usable flow: ' + err.message + '. Press r to rebuild.'
    }
    $.ui.invalidate('ui.render')
    const opened = await openPane($)
    if (!opened.isPlaced) $.ui.toast('Flow ready. Type /flow to open it.')
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input, Select, Code } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')
    const press = (key, label, hotkey, action) =>
      Button({
        key,
        label,
        hotkey,
        plain: true,
        onPress: async () => {
          await action()
          redraw()
        },
      })

    const children = []
    children.push(Text({ bold: true, children: [flow ? flow.title : pending ? 'Building: ' + shorten(pending.question) : 'Flow explainer'] }))

    if (stack.length) children.push(Text({ dimColor: true, children: ['Jumped from: ' + stack[stack.length - 1].flow.title] }))
    if (flow) for (const a of flow.assumptions) children.push(Text({ dimColor: true, children: ['Assumed: ' + a] }))
    if (flow && savedPath) children.push(Text({ dimColor: true, children: ['Saved: ' + baseName(savedPath)] }))
    if (notice) children.push(Text({ color: 'green', children: [notice] }))
    if (problem) children.push(Text({ color: 'red', children: [problem] }))
    if (pending) {
      const text = pending.kind === 'update'
        ? 'Claude is updating this saved flow for code that changed. It appears when the update is done.'
        : 'Claude is exploring the code in the main chat. This pane fills in when the flow is ready.'
      children.push(Text({ color: 'cyan', children: [text] }))
    }

    // The saved-flow picker on 'o' or /flow-resume; otherwise an input for a new scenario
    // (when there's nothing to show, or on 'f') or a question about the step (on 'a')
    const mode = inputMode ?? (flow || pending ? null : 'new')
    if (inputMode === 'open') {
      children.push(Text({ bold: true, children: ['Saved flows: pick one to resume it, or press q to go back'] }))
      if (savedList.length) {
        children.push(
          Select({
            key: 'saved-picker',
            label: 'Saved flow',
            options: savedList.map((s) => ({ value: s.path, label: s.label })),
            autoFocus: true,
            onSelect: async (value) => {
              try {
                await loadSaved($, value)
              } catch (err) {
                problem = 'Could not open that flow: ' + err.message
              }
              redraw()
            },
          }),
        )
      } else {
        children.push(Text({ dimColor: true, children: ['No saved flows yet. Press s on a flow to save it.'] }))
      }
    } else if (mode) {
      const asking = mode === 'ask'
      children.push(
        Input({
          key: 'flow-input',
          label: asking ? 'Ask about this step' : 'Scenario, question, or diff to explain',
          placeholder: asking ? 'empty = cancel' : 'e.g. how does POST /orders reach the database? (empty = cancel)',
          value: '',
          submitLabel: 'go',
          autoFocus: true,
          onSubmit: async (value) => {
            const text = value.trim()
            const wasAsking = inputMode === 'ask'
            inputMode = null
            if (text && wasAsking) await askAboutStep($, text)
            else if (text) await buildFlow($, text)
            redraw()
          },
        }),
      )
    }

    children.push(
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          press('play', playing ? 'p: pause' : 'p: play', 'p', () => {
            if (!flow) return
            if (index === flow.steps.length - 1 && !playing) index = 0
            playing = !playing
            elapsed = 0
          }),
          press('next', 'n: next', 'n', () => go($, 1)),
          press('back', 'b: back', 'b', () => go($, -1)),
          press('ask', 'a: ask', 'a', () => {
            if (flow) inputMode = 'ask'
          }),
        ],
      }),
    )
    children.push(
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          press('new', 'f: new flow', 'f', () => {
            inputMode = 'new'
          }),
          press('rebuild', 'r: rebuild', 'r', async () => {
            if (lastRequest && !pending) await buildFlow($, lastRequest)
          }),
          press('mode', 'l: next = ' + (lineMode ? 'line by line' : 'by function'), 'l', () => {
            lineMode = !lineMode
          }),
          ...(pending
            ? [
                press('cancel', 'c: cancel', 'c', () => {
                  pending = null
                  problem = 'Cancelled. If the flow turn finishes later, its result is ignored.'
                  $.ui.status('')
                }),
              ]
            : []),
        ],
      }),
    )
    children.push(
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          ...(flow ? [press('save', 's: save', 's', () => saveFlow($))] : []),
          press('open', 'o: saved flows', 'o', async () => {
            savedList = await listSaved($)
            inputMode = 'open'
          }),
          ...(stack.length ? [press('back-parent', 'u: back to parent', 'u', () => backToParent())] : []),
          ...(inputMode === 'open'
            ? [
                press('close-open', 'q: back', 'q', () => {
                  inputMode = null
                }),
              ]
            : []),
        ],
      }),
    )

    if (flow) {
      const n = flow.steps.length
      const step = flow.steps[index]
      const filled = Math.round((index + 1) * 20 / n)
      const bar = '█'.repeat(filled) + '·'.repeat(20 - filled)
      const status = playing ? 'playing, next in ' + (pace - elapsed) + 's' : 'paused'
      children.push(Text({ dimColor: true, children: [status + '   ' + (index + 1) + '/' + n + '   ' + bar] }))

      // The whole flow as a vertical list, with a window around the current step
      const start = Math.max(0, Math.min(index - 4, n - WINDOW))
      for (let i = start; i < Math.min(n, start + WINDOW); i += 1) {
        const st = flow.steps[i]
        const mark = i < index ? '✓' : i === index ? '●' : '○'
        children.push(
          Text({
            key: 'row-' + i,
            wrap: 'truncate-end',
            bold: i === index,
            dimColor: i > index,
            children: [mark + ' ' + String(st.n).padStart(3) + '  ' + st.kind.padEnd(9) + ' ' + st.title],
          }),
        )
      }

      // The current step in detail
      const detail = [
        Text({ dimColor: true, children: ['Step ' + step.n + ' of ' + n + ' · ' + step.kind + (step.where ? ' · ' + step.where : '')] }),
        Text({ bold: true, children: [step.title] }),
        Text({ children: [step.explain] }),
      ]
      if (step.technical) detail.push(Text({ dimColor: true, children: ['Technically: ' + step.technical] }))
      if (step.code) {
        detail.push(Code({ key: 'code-' + index, source: step.code, ...(step.language ? { language: step.language } : {}) }))
      }
      if (step.concern) detail.push(Text({ color: 'yellow', children: ['Review note: ' + step.concern] }))
      if (step.calls.length) {
        // Each call is a button (click), and digits 1-9 press them (keypress)
        detail.push(Text({ dimColor: true, children: ['Jump into (click, or press the number):'] }))
        detail.push(
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: step.calls.map((c, k) =>
              press('jump-' + index + '-' + k, (k + 1) + ': ' + c.name, String(k + 1), () => jumpTo($, c)),
            ),
          }),
        )
      }
      children.push(Box({ flexDirection: 'column', borderStyle: 'round', paddingX: 1, children: detail }))
      children.push(Text({ dimColor: true, children: ['p pause · n/b step · 1-9 jump · a ask · s save · o saved · u back · Esc closes'] }))
    }

    return Box({ flexDirection: 'column', children })
  })
}
