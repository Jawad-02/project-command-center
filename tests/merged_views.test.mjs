// Proof for the merged page and the server-owned lane table. The blocks are not
// copied here: they are sliced out of desktop/plugin.js, so a change that leaves
// them dependent on JSX, an import or a renderer global fails this suite.
//
// Three blocks are loaded into one context, in file order: the lane resolution
// order, the kanban table helpers, then the merged-view helpers. The kanban
// block defers to the lane block, and the merged-view helpers are pure.
//
// Run with:
//   node --test tests/merged_views.test.mjs

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
const viewsBlock = slice('// merged-views:begin', '// merged-views:end')

vm.runInThisContext(
  `${laneBlock}\n${kanbanBlock}\n${viewsBlock}\n;globalThis.__PCC_MERGED__ = {
    VIEWS,
    DEFAULT_VIEW,
    VIEW_IDS,
    normalizeView,
    sortViewCards,
    kanbanBranchGroups,
    ISSUE_STATES,
    kanbanIssueState,
    kanbanIssueGroups,
    cardAsSession,
    cardLane,
    KANBAN_LANES,
    normalizeKanbanLanes,
    normalizeLaneTable,
    laneTableOrDefaults,
    laneIds,
    lanePlace,
    kanbanPlaceCards,
    laneSlug,
    laneCreateBody,
    laneRenameBody,
    laneDeleteBody,
    laneOrderBody,
    addKanbanLane,
    mergeKanbanOrder,
    laneColor,
    laneLabel,
    laneUseCount,
    laneRowsFromResponse,
    kanbanLaneFor,
    kanbanCounts
  }`,
  { filename: PLUGIN }
)
const M = globalThis.__PCC_MERGED__

const card = (over = {}) => ({
  id: 's1',
  sessionId: 's1',
  title: 'Fix the thing',
  projectId: 'p1',
  projectLabel: 'Alpha',
  branch: 'main',
  issue: 0,
  pr: 0,
  prState: null,
  lane: 'active',
  laneSource: 'user',
  laneNote: '',
  lastActivity: 1000,
  ...over
})

// ── view switching state ────────────────────────────────────────────────────

test('the one page has four views, Status first, and an unknown id lands there', () => {
  assert.deepEqual(M.VIEW_IDS, ['status', 'projects', 'branches', 'issues'])
  assert.deepEqual(M.VIEWS.map(view => view.label), ['Status', 'Projects', 'Branches', 'Issues'])
  assert.equal(M.DEFAULT_VIEW, 'status')

  assert.equal(M.normalizeView(' STATUS '), 'status')
  assert.equal(M.normalizeView('Branches'), 'branches')
  assert.equal(M.normalizeView('issues'), 'issues')
  assert.equal(M.normalizeView('sessions'), 'status')
  assert.equal(M.normalizeView(''), 'status')
  assert.equal(M.normalizeView(null), 'status')
  assert.equal(M.normalizeView(42), 'status')
})

test('the view is the one route state kept, in ctx.storage', () => {
  const begin = source.indexOf('function readView(')
  const end = source.indexOf('\n}\n', begin)

  assert.ok(begin >= 0, 'readView missing from desktop/plugin.js')
  const block = source.slice(begin, end + 3)

  assert.match(block, /storage\.get\(VIEW_KEY/, 'the view must read the stored key')
  assert.match(block, /normalizeView\(/, 'a stored view must be normalized')

  const write = source.slice(source.indexOf('function writeView('), source.indexOf('\n}\n', source.indexOf('function writeView(')) + 3)

  assert.match(write, /storage\.set\(VIEW_KEY/, 'the view must be written back to storage')
  assert.match(write, /\$view\.set\(/, 'the render atom must be set too')
  assert.match(source, /const VIEW_KEY = 'ccView\.v1'/, 'the view key must be stable')
  assert.match(source, /\$view\.set\(readView\(\)\)/, 'register must seed the atom from storage')
})

test('the merged page renders one switcher over the four views', () => {
  const begin = source.indexOf('function ProjectCommandCenterPage()')
  const end = source.indexOf('\n}\n', begin)

  assert.ok(begin >= 0, 'the merged page is missing')
  const block = source.slice(begin, end + 3)

  assert.match(block, /useValue\(\$view\)/, 'the page must read the view atom')
  assert.match(block, /jsx\(ViewSwitcher, \{\}\)/, 'the page must render the switcher')
  for (const view of ['projects', 'branches', 'issues']) {
    assert.match(block, new RegExp(`view === '${view}'`), `the page must branch to ${view}`)
  }
  assert.match(block, /jsx\(SessionsKanbanPage, \{ embedded: true \}\)/, 'Status is the fallback view')

  const switcher = source.slice(source.indexOf('function ViewSwitcher()'), source.indexOf('\n}\n', source.indexOf('function ViewSwitcher()')) + 3)

  assert.match(switcher, /options: VIEWS/, 'the switcher options are the constant list, so the width never moves')
  assert.match(switcher, /style: S\.viewSwitch/, 'the switcher sits in a fixed, non-growing wrapper')
  assert.match(source, /viewSwitch: \{ display: 'inline-flex', flex: 'none' \}/, 'the wrapper must not grow')
})

test('the separate sessions route, page and nav entry are gone', () => {
  assert.doesNotMatch(source, /SESSIONS_ROUTE/, 'no page may still point at /sessions')
  assert.doesNotMatch(source, /sessions-page/, 'the second page registration must be gone')
  assert.doesNotMatch(source, /sessions-nav/, 'the second sidebar entry must be gone')
  assert.equal((source.match(/area: SIDEBAR_NAV_AREA/g) || []).length, 1, 'the sidebar keeps one entry')
})

test('the palette opens the three named views', () => {
  const begin = source.indexOf("label: 'Open Projects'")
  const end = source.indexOf(']\n    ])', begin)
  const block = source.slice(begin, end > begin ? end : begin + 2000)

  assert.match(block, /label: 'Open Projects'[\s\S]*run: \(\) => openView\('projects'\)/)
  assert.match(block, /label: 'Open Sessions board'[\s\S]*run: \(\) => openView\('status'\)/)
  assert.match(block, /label: 'Open Issues'[\s\S]*run: \(\) => openView\('issues'\)/)
})

// ── Branches view ──────────────────────────────────────────────────────────

test('branches group across projects, newest first inside a group, biggest group first', () => {
  const rows = [
    card({ id: 'a', projectId: 'p1', branch: 'main', lastActivity: 10 }),
    card({ id: 'b', projectId: 'p2', branch: 'feat/x', lastActivity: 30 }),
    card({ id: 'c', projectId: 'p2', branch: 'main', lastActivity: 50 }),
    card({ id: 'd', projectId: 'p1', branch: 'feat/x', lastActivity: 20 }),
    card({ id: 'e', projectId: 'p3', branch: '', lastActivity: 5 })
  ]
  const groups = M.kanbanBranchGroups(rows)

  // main (3, the empty branch folds into it), then feat/x (2).
  assert.deepEqual(groups.map(group => group.label), ['main', 'feat/x'])
  assert.deepEqual(groups[0].cards.map(row => row.id), ['c', 'a', 'e'])
  assert.deepEqual(groups[1].cards.map(row => row.id), ['b', 'd'])
  assert.equal(groups[0].key, 'branch:main')
})

test('the branch view reuses the project page row shape and its lane badge', () => {
  const session = M.cardAsSession(card({ sessionId: 's9', title: 'Ship it', lastActivity: 1234 }))

  assert.deepEqual(session, { id: 's9', title: 'Ship it', last_active: 1234 })
  assert.deepEqual(M.cardLane(card({ lane: 'review', laneSource: 'pr' })), {
    lane: 'review',
    note: '',
    source: 'pr'
  })

  const begin = source.indexOf('function GroupedSessions(')
  const end = source.indexOf('\n}\n', begin)
  const block = source.slice(begin, end + 3)

  assert.match(block, /jsx\(\s*DetailSessionRow/, 'the rows are the project page row component')
  assert.match(block, /lane: cardLane\(card\)/, 'the lane badge is fed from the card lane')
  assert.match(block, /lanes,/, 'the badge can label a custom lane')
})

// ── Issues view ────────────────────────────────────────────────────────────

test('the issue buckets are the five the view promises, in order', () => {
  assert.deepEqual(M.ISSUE_STATES.map(state => state.label), ['Open', 'In review', 'Merged', 'Closed', 'Unlinked'])

  assert.equal(M.kanbanIssueState(card({ prState: { state: 'open', merged: false } })), 'review')
  assert.equal(M.kanbanIssueState(card({ prState: { state: 'open', merged: false, draft: true } })), 'review')
  assert.equal(M.kanbanIssueState(card({ prState: { state: 'closed', merged: true } })), 'merged')
  assert.equal(M.kanbanIssueState(card({ prState: { state: 'closed', merged: false } })), 'closed')
  assert.equal(M.kanbanIssueState(card({ pr: 12 })), 'review')
  assert.equal(M.kanbanIssueState(card({ issue: 7 })), 'open')
  assert.equal(M.kanbanIssueState(card({})), 'unlinked')
  assert.equal(M.kanbanIssueState(null), 'unlinked')
})

test('issue groups keep all five buckets and sort newest first', () => {
  const rows = [
    card({ id: 'a', issue: 7, lastActivity: 10 }),
    card({ id: 'b', pr: 12, prState: { state: 'open', merged: false }, lastActivity: 20 }),
    card({ id: 'c', pr: 13, prState: { state: 'closed', merged: true }, lastActivity: 30 }),
    card({ id: 'd', pr: 14, prState: { state: 'closed', merged: false }, lastActivity: 40 }),
    card({ id: 'e', lastActivity: 50 })
  ]
  const groups = M.kanbanIssueGroups(rows)

  assert.deepEqual(groups.map(group => group.id), ['open', 'review', 'merged', 'closed', 'unlinked'])
  assert.deepEqual(groups.map(group => group.cards.length), [1, 1, 1, 1, 1])

  const twoOpen = M.kanbanIssueGroups([
    card({ id: 'old', issue: 1, lastActivity: 1 }),
    card({ id: 'new', issue: 2, lastActivity: 9 })
  ])

  assert.deepEqual(twoOpen[0].cards.map(row => row.id), ['new', 'old'])
})

// ── lanes: the server read and the fallback ────────────────────────────────

test('a server lane payload is kept as-is: custom ids, labels and order', () => {
  const rows = M.laneRowsFromResponse({
    ok: true,
    lanes: [
      { id: 'ideas', label: 'Ideas', order: 0, custom: true },
      { id: 'active', label: 'Building', order: 1, custom: false },
      { id: 'done', label: 'Shipped', order: 2, custom: false }
    ]
  })

  assert.deepEqual(M.laneIds(rows), ['ideas', 'active', 'done'])
  assert.deepEqual(rows.map(row => row.label), ['Ideas', 'Building', 'Shipped'])
  assert.equal(rows[0].custom, true)
  assert.equal(rows[1].custom, undefined)

  // Anything that is not the documented shape reads as "no server table".
  assert.equal(M.laneRowsFromResponse(null), null)
  assert.equal(M.laneRowsFromResponse({ ok: false, code: 'unknown_lane' }), null)
  assert.equal(M.laneRowsFromResponse({ ok: true, lanes: [] }), null)
  assert.equal(M.laneRowsFromResponse({ ok: true }), null)
})

test('a missing lane route falls back to the five defaults', () => {
  // The page keeps rendering from ctx.storage, so the fallback table is the same
  // five ids the old build seeded.
  const stored = M.laneTableOrDefaults(null)

  assert.deepEqual(M.laneIds(stored), ['backlog', 'active', 'review', 'blocked', 'done'])
  assert.deepEqual(M.laneIds(M.laneTableOrDefaults(M.KANBAN_LANES)), ['backlog', 'active', 'review', 'blocked', 'done'])
})

test('an unknown lane id renders in the first lane, not nowhere', () => {
  const table = M.laneRowsFromResponse({
    ok: true,
    lanes: [
      { id: 'triage', label: 'Triage', order: 0, custom: true },
      { id: 'active', label: 'Active', order: 1 }
    ]
  })

  assert.equal(M.lanePlace(table, 'done'), 'triage')
  assert.equal(M.lanePlace(table, 'active'), 'active')
  assert.equal(M.lanePlace(M.laneTableOrDefaults(null), 'someday'), 'backlog')

  const placed = M.kanbanPlaceCards([card({ id: 'x', lane: 'done' })], table)

  assert.equal(placed[0].lane, 'triage')

  const resolved = M.kanbanLaneFor({ status: 'done' }, null, '', table)

  assert.equal(resolved.lane, 'triage', 'a session left in a deleted lane lands in the first column')
})

test('a custom lane is a real lane for resolution and counting', () => {
  const table = M.laneRowsFromResponse({
    ok: true,
    lanes: [
      { id: 'backlog', label: 'Backlog', order: 0 },
      { id: 'triage', label: 'Triage', order: 1, custom: true }
    ]
  })

  assert.equal(M.kanbanLaneFor({ status: 'triage', status_source: 'user' }, null, '', table).lane, 'triage')
  assert.deepEqual(M.kanbanCounts([card({ lane: 'triage' })], table), { backlog: 0, triage: 1 })
  assert.match(M.laneColor('triage', table), /^var\(--ui-/)
})

// ── lanes: the write bodies ────────────────────────────────────────────────

test('create, rename, order and delete build the bodies the routes document', () => {
  const table = M.laneTableOrDefaults(null)
  const renamed = M.addKanbanLane(table, 'Needs design')
  const id = renamed[renamed.length - 1].id

  assert.equal(id, 'needs-design', 'a label is slugged into an id')
  assert.equal(renamed[renamed.length - 1].custom, true, 'a created lane carries the custom marker')
  assert.deepEqual(M.laneCreateBody('  Needs design  '), { label: 'Needs design' })
  assert.deepEqual(M.laneRenameBody('review', ' In review '), { id: 'review', label: 'In review' })
  assert.deepEqual(M.laneOrderBody(renamed), { ids: M.laneIds(renamed) })
  assert.deepEqual(M.laneDeleteBody('blocked'), { id: 'blocked' })
})

test('adding twice keeps both columns: the slug gets a numeric suffix', () => {
  const once = M.addKanbanLane(M.laneTableOrDefaults(null), 'Needs design')
  const twice = M.addKanbanLane(once, 'Needs design')

  assert.deepEqual(M.laneIds(twice).slice(-2), ['needs-design', 'needs-design-2'])
})

test('the reassign retry ride on the delete body', () => {
  assert.deepEqual(M.laneDeleteBody('done', 'backlog'), { id: 'done', reassign: 'backlog' })
  assert.deepEqual(M.laneDeleteBody('done', '  active '), { id: 'done', reassign: 'active' })
  // No target yet means the first delete attempt, which asks rather than moves.
  assert.deepEqual(Object.keys(M.laneDeleteBody('done', '')), ['id'])
})

test('the CRUD calls go through the documented routes and revert on failure', () => {
  const grab = name => {
    const begin = source.indexOf(`function ${name}(`)
    const end = source.indexOf('\n}\n', begin)

    assert.ok(begin >= 0, `${name} missing from desktop/plugin.js`)

    return source.slice(begin, end + 3)
  }

  const create = grab('createLane')

  assert.match(create, /lanePost\('\/board\/lanes', laneCreateBody\(text\)\)/)
  assert.match(create, /writeLanes\(snapshot\)/, 'a refused create reverts the optimistic table')
  assert.match(create, /laneToast\(/, 'a refused create says so')

  const reorder = grab('reorderLanes')

  assert.match(reorder, /lanePost\('\/board\/lanes\/order', laneOrderBody\(next\)\)/)
  assert.match(reorder, /writeLanes\(snapshot\)/)

  const remove = grab('deleteLane')

  assert.match(remove, /lanePost\('\/board\/lanes\/delete', laneDeleteBody\(laneId, target\)\)/)
  assert.match(remove, /laneRefreshBoard\(/, 'a delete invalidates the board, not only the lanes')
  assert.match(remove, /writeLanes\(snapshot\)/, 'a refused delete reverts')
  assert.match(remove, /err\.code !== 'lane_in_use'/, 'lane_in_use is asked, not toasted')
})

test('the popover asks lane_in_use for a target and retries with reassign', () => {
  const begin = source.indexOf('function LanesPopover(')
  const end = source.indexOf('\n}\n', begin)
  const block = source.slice(begin, end + 3)

  assert.match(block, /err\.code === 'lane_in_use'/, 'the refusal is recognised')
  assert.match(block, /setPending\(\{ counts, id: lane\.id, label: lane\.label \}\)/, 'the pending delete keeps the lane and its counts')
  assert.match(block, /deleteLane\(pending\.id, target\)/, 'the retry carries the chosen lane')
  assert.match(block, /ariaLabel: 'Move sessions to a lane'/, 'the target comes from a select')
  assert.match(block, /children: 'Add lane'/, 'the create control is in the popover')
  assert.match(block, /children: 'Move and remove'/, 'the reassign retry is one click')
})

test('lane_in_use counts read from any of the shapes the route may carry', () => {
  assert.equal(M.laneUseCount(4, 'done'), 4)
  assert.equal(M.laneUseCount({ done: 3 }, 'done'), 3)
  assert.equal(M.laneUseCount({ done: { count: 2 } }, 'done'), 2)
  assert.equal(M.laneUseCount({ done: { sessions: 5 } }, 'done'), 5)
  assert.equal(M.laneUseCount({ total: 6 }, 'done'), 6)
  assert.equal(M.laneUseCount(null, 'done'), 0)
})

// ── the project page toggle ────────────────────────────────────────────────

test('the project page session panel offers By branch and By lane', () => {
  assert.deepEqual(source.match(/const PANEL_MODES = \[[\s\S]*?\]/)[0].match(/label: '[^']+'/g), ["label: 'By branch'", "label: 'By lane'"])

  const begin = source.indexOf("children: 'Sessions by lane'")
  const block = source.slice(begin, begin + 2600)

  assert.match(block, /SegmentedControl, \{ onChange: setPanelMode, options: PANEL_MODES/, 'the toggle is in the panel header')
  assert.match(block, /panelMode === 'lane'/, 'the panel branches on the mode')
  assert.match(block, /jsx\(KanbanViews, \{/, 'the lane mode renders the kanban')
  assert.match(block, /lanes: laneRows/, 'the columns are the server lane table')
  assert.match(block, /onMove: panelMove/, 'a move in the panel is a real move')
})
