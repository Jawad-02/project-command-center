// Proof for the session kanban block embedded in desktop/plugin.js. The block is
// not copied here: it is sliced out of the live file, so an edit that leaves it
// dependent on JSX, an import or a renderer global fails this suite.
//
// The block defers lane resolution to the session-lane block above it, which is
// why both are loaded into the same context: the point of the test is that the
// kanban page has no second resolution order of its own.
//
// Run with:
//   node --test tests/sessions_kanban.test.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(resolve(HERE, '..'), 'desktop', 'plugin.js')
const source = readFileSync(PLUGIN, 'utf8')

function slice(begin, end) {
  const at = source.indexOf(begin)
  const to = source.indexOf(end)

  assert.ok(at >= 0, `${begin} missing from desktop/plugin.js`)
  assert.ok(to > at, `${end} missing or before the begin marker`)
  assert.equal(source.indexOf(begin, at + 1), -1, `${begin} appears more than once`)

  const block = source.slice(at, to + end.length)

  assert.doesNotMatch(block, /^\s*import\s/m, 'the block must not import anything')
  assert.doesNotMatch(block, /^\s*export\s/m, 'the block must not export anything')
  assert.doesNotMatch(block, /(?<![\w$])jsx\(/, 'the block must not render')
  assert.doesNotMatch(block, /\u2014/, 'the block must not carry an em dash')

  return block
}

const laneBlock = slice('// session-lane:begin', '// session-lane:end')
const kanbanBlock = slice('// session-kanban:begin', '// session-kanban:end')

vm.runInThisContext(
  `${laneBlock}\n${kanbanBlock}\n;globalThis.__PCC_KANBAN__ = {
    KANBAN_LANES,
    KANBAN_LANE_IDS,
    KANBAN_STALE_MS,
    KANBAN_SOURCE_TEXT,
    kanbanLane,
    normalizeKanbanLanes,
    renameKanbanLane,
    moveKanbanLane,
    kanbanLaneFor,
    kanbanFilterCards,
    kanbanCounts,
    sortKanbanCards,
    kanbanMoveBody
  }`,
  { filename: PLUGIN }
)
const K = globalThis.__PCC_KANBAN__

const DEFAULT_IDS = ['backlog', 'active', 'review', 'blocked', 'done']
const ids = lanes => lanes.map(lane => lane.id)

const mergedPr = { number: 8, state: 'closed', merged: true, draft: false }
const openPr = { number: 6, state: 'open', merged: false, draft: false }
const draftPr = { number: 7, state: 'open', merged: false, draft: true }

const card = (over = {}) => ({
  title: 'Fix the thing',
  projectId: 'p1',
  projectLabel: 'Alpha',
  branch: 'main',
  issue: 0,
  pr: 0,
  lane: 'active',
  source: 'user',
  stale: false,
  lastActivity: 1000,
  ...over
})

test('the default lanes are the store ids in order, with labels and an order each', () => {
  const lanes = K.normalizeKanbanLanes([])

  assert.deepEqual(ids(lanes), DEFAULT_IDS)
  assert.deepEqual(lanes.map(lane => lane.label), ['Backlog', 'Active', 'Review', 'Blocked', 'Done'])
  assert.deepEqual(lanes.map(lane => lane.order), [0, 1, 2, 3, 4])
  assert.deepEqual(K.KANBAN_LANE_IDS, DEFAULT_IDS)
})

test('lane resolution matches the store: session, then PR, then project, then backlog', () => {
  const explicit = K.kanbanLaneFor({ status: 'blocked', status_source: 'agent', note: 'waiting' }, openPr, 'done')

  assert.equal(explicit.lane, 'blocked')
  assert.equal(explicit.source, 'agent')
  assert.equal(explicit.note, 'waiting')

  const merged = K.kanbanLaneFor({}, mergedPr, 'active')

  assert.equal(merged.lane, 'done')
  assert.equal(merged.source, 'pr')

  assert.equal(K.kanbanLaneFor({}, openPr, '').lane, 'review')
  assert.equal(K.kanbanLaneFor({}, draftPr, '').lane, 'review')

  const project = K.kanbanLaneFor(null, null, 'review')

  assert.equal(project.lane, 'review')
  assert.equal(project.source, 'project')

  const empty = K.kanbanLaneFor(null, null, '')

  assert.equal(empty.lane, 'backlog')
  assert.equal(empty.source, 'unset')

  // An unknown explicit value is not a lane: the next rule answers instead.
  assert.equal(K.kanbanLaneFor({ status: 'shipped' }, null, 'blocked').lane, 'blocked')
  // A project id that is not one of the five falls through to backlog.
  assert.equal(K.kanbanLaneFor(null, null, 'someday').lane, 'backlog')
})

test('the provenance words are the four the card promises', () => {
  assert.equal(K.KANBAN_SOURCE_TEXT.user, 'you')
  assert.equal(K.KANBAN_SOURCE_TEXT.agent, 'agent')
  assert.equal(K.KANBAN_SOURCE_TEXT.pr, 'from PR')
  assert.equal(K.KANBAN_SOURCE_TEXT.project, 'unset')
  assert.equal(K.KANBAN_SOURCE_TEXT.unset, 'unset')
})

test('a filter narrows by project, source, staleness and search, and they compose', () => {
  const rows = [
    card({ title: 'Auth token refresh', projectId: 'p1', projectLabel: 'Alpha', source: 'user', lane: 'active', branch: 'feat/auth', issue: 12 }),
    card({ title: 'Billing retries', projectId: 'p2', projectLabel: 'Beta', source: 'agent', lane: 'review', stale: true, branch: 'main', pr: 34 }),
    card({ title: 'Docs sweep', projectId: 'p1', projectLabel: 'Alpha', source: 'pr', lane: 'done', branch: 'docs', pr: 0 })
  ]

  assert.equal(K.kanbanFilterCards(rows, {}).length, 3)
  assert.equal(K.kanbanFilterCards(rows, { projectId: 'p1' }).length, 2)
  assert.equal(K.kanbanFilterCards(rows, { source: 'user' }).length, 1)
  assert.equal(K.kanbanFilterCards(rows, { source: 'agent' }).length, 1)
  assert.equal(K.kanbanFilterCards(rows, { staleOnly: true }).length, 1)
  assert.equal(K.kanbanFilterCards(rows, { staleOnly: true })[0].title, 'Billing retries')

  // Search: case-insensitive substring over title, project, branch and numbers.
  assert.equal(K.kanbanFilterCards(rows, { search: 'AUTH' }).length, 1)
  assert.equal(K.kanbanFilterCards(rows, { search: 'beta' }).length, 1)
  assert.equal(K.kanbanFilterCards(rows, { search: 'main' }).length, 1)
  assert.equal(K.kanbanFilterCards(rows, { search: '34' }).length, 1)
  assert.equal(K.kanbanFilterCards(rows, { search: '#12' }).length, 1)
  assert.equal(K.kanbanFilterCards(rows, { search: 'nothing' }).length, 0)

  // Two filters that cannot both hold empty the list rather than OR together.
  assert.equal(K.kanbanFilterCards(rows, { projectId: 'p1', source: 'agent' }).length, 0)
  assert.equal(K.kanbanFilterCards(rows, { projectId: 'p1', source: 'user', search: '12' }).length, 1)
  assert.equal(K.kanbanFilterCards(rows, { projectId: 'p1', staleOnly: true }).length, 0)
})

test('a stale card is old and not done; an undated card is never stale', () => {
  const now = 10 * K.KANBAN_STALE_MS

  const oldActive = card({ lane: 'active', lastActivity: now - K.KANBAN_STALE_MS - 1, stale: true })
  const oldDone = card({ lane: 'done', lastActivity: now - K.KANBAN_STALE_MS - 1, stale: false })
  const fresh = card({ lane: 'active', lastActivity: now - 1000, stale: false })

  assert.equal(K.kanbanFilterCards([oldActive, oldDone, fresh], { staleOnly: true }).length, 1)
  assert.equal(K.kanbanFilterCards([oldActive, oldDone, fresh], { staleOnly: true })[0], oldActive)
})

test('column counts follow the filtered list, not the raw one', () => {
  const rows = [
    card({ lane: 'active' }),
    card({ lane: 'active', projectId: 'p2' }),
    card({ lane: 'review' })
  ]
  const lanes = K.normalizeKanbanLanes([])

  assert.deepEqual(K.kanbanCounts(rows, lanes), { backlog: 0, active: 2, review: 1, blocked: 0, done: 0 })
  assert.deepEqual(K.kanbanCounts(K.kanbanFilterCards(rows, { projectId: 'p2' }), lanes), {
    backlog: 0,
    active: 1,
    review: 0,
    blocked: 0,
    done: 0
  })
})

test('a rename keeps the order and the ids, and an empty label is refused', () => {
  const lanes = K.normalizeKanbanLanes([])
  const renamed = K.renameKanbanLane(lanes, 'review', 'In review')

  assert.deepEqual(ids(renamed), DEFAULT_IDS)
  assert.equal(renamed[2].label, 'In review')
  assert.deepEqual(renamed.map(lane => lane.order), [0, 1, 2, 3, 4])

  assert.equal(K.renameKanbanLane(renamed, 'review', '   ')[2].label, 'In review')
  assert.equal(K.renameKanbanLane(renamed, 'someday', 'Nope')[2].label, 'In review')
  assert.equal(K.renameKanbanLane(renamed, 'review', '  Shipped  ')[2].label, 'Shipped')
})

test('a move reorders and renumbers without changing an id, and the ends are no-ops', () => {
  const lanes = K.normalizeKanbanLanes([])

  const up = K.moveKanbanLane(lanes, 'review', -1)

  assert.deepEqual(ids(up), ['backlog', 'review', 'active', 'blocked', 'done'])
  assert.deepEqual(up.map(lane => lane.order), [0, 1, 2, 3, 4])
  assert.deepEqual(K.moveKanbanLane(lanes, 'backlog', -1).map(lane => lane.id), DEFAULT_IDS)
  assert.deepEqual(K.moveKanbanLane(lanes, 'done', 1).map(lane => lane.id), DEFAULT_IDS)

  const twice = K.moveKanbanLane(K.moveKanbanLane(lanes, 'blocked', -1), 'blocked', -1)

  assert.deepEqual(ids(twice), ['backlog', 'blocked', 'active', 'review', 'done'])
  // The stored shape stays {id, label, order}, 0..4, labels carried along.
  assert.deepEqual(Object.keys(twice[1]).sort(), ['id', 'label', 'order'])
  assert.equal(twice[1].label, 'Blocked')
})

test('malformed storage falls back to the five default lanes', () => {
  for (const bad of [null, undefined, 'lanes', 42, {}, [{ id: 'review' }], [{ id: 'nope', label: 'X', order: 0 }]]) {
    const lanes = K.normalizeKanbanLanes(bad)

    assert.deepEqual(ids(lanes), DEFAULT_IDS, `input ${JSON.stringify(bad)}`)
    assert.equal(lanes.length, 5)
  }

  // Duplicate orders keep every id and resolve by the default order.
  const duplicate = K.normalizeKanbanLanes([
    { id: 'done', label: 'Shipped', order: 0 },
    { id: 'backlog', label: 'Ideas', order: 0 }
  ])

  assert.deepEqual(ids(duplicate), DEFAULT_IDS)
  assert.equal(duplicate[4].label, 'Shipped')
  assert.deepEqual(duplicate.map(lane => lane.order), [0, 1, 2, 3, 4])
})

test('the table sorts by the edited lane order, newest first inside a lane', () => {
  // Blocked moves one step up, past review: backlog, active, blocked, review, done.
  const lanes = K.moveKanbanLane(K.normalizeKanbanLanes([]), 'blocked', -1)
  const rows = [
    card({ lane: 'active', title: 'old', lastActivity: 10 }),
    card({ lane: 'active', title: 'new', lastActivity: 30 }),
    card({ lane: 'blocked', title: 'stuck', lastActivity: 20 }),
    card({ lane: 'backlog', title: 'later', lastActivity: 40 })
  ]
  const sorted = K.sortKanbanCards(rows, lanes, 1)

  assert.deepEqual(ids(lanes), ['backlog', 'active', 'blocked', 'review', 'done'])
  assert.deepEqual(sorted.map(row => row.title), ['later', 'new', 'old', 'stuck'])
  assert.deepEqual(
    K.sortKanbanCards(rows, lanes, -1).map(row => row.title),
    ['stuck', 'new', 'old', 'later']
  )
  // The input is not mutated.
  assert.equal(rows[0].title, 'old')
})

test('the move itself posts that body through the existing board REST door', () => {
  const start = source.indexOf('function writeSessionLane(')

  assert.ok(start >= 0, 'writeSessionLane missing from desktop/plugin.js')
  const end = source.indexOf('\n}\n', start)

  assert.ok(end > start, 'writeSessionLane has no closing brace')
  const block = source.slice(start, end + 3)

  assert.ok(
    block.includes("boardRest('/board/status', { method: 'POST', body: kanbanMoveBody(projectId, sessionId, lane) })"),
    'the move must post the session body through boardRest'
  )
  assert.match(block, /\$sessionStatus\.set\(/, 'a move must update the local mirror first')
  assert.match(block, /queryClient\.invalidateQueries\(\{ queryKey: \[QUERY_ROOT, 'board'\] \}\)/)
  assert.match(block, /host\.notify\(\{/, 'a refused move must say so')
})

test('a move builds the session-scoped body the store expects', () => {
  assert.deepEqual(K.kanbanMoveBody('p1', 's1', 'review'), {
    project_id: 'p1',
    session_id: 's1',
    status: 'review',
    scope: 'session'
  })
  assert.deepEqual(Object.keys(K.kanbanMoveBody('p1', 's1', 'done')), [
    'project_id',
    'session_id',
    'status',
    'scope'
  ])
})
