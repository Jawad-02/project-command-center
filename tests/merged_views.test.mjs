// Proof for the merged page and the server-owned lane table. The blocks are not
// copied here: they are sliced out of desktop/plugin.js, so a change that leaves
// them dependent on JSX, an import or a renderer global fails this suite.
//
// Three blocks are loaded into one context, in file order: the lane resolution
// order, the kanban table helpers, then the merged-view helpers. The kanban
// block defers to the lane block, and the merged-view helpers are pure.
//
// The page has two views now. Branches and Issues were folded into Projects, so
// this suite proves the removed components are gone and a stored legacy value
// opens Projects instead.
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

const DEFAULT_IDS = ['unfiled', 'backlog', 'active', 'review', 'blocked', 'done', 'canceled']

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

test('the one page has two views, Projects first, and a legacy value migrates', () => {
  assert.deepEqual(M.VIEW_IDS, ['status', 'projects'])
  assert.deepEqual(M.VIEWS.map(view => view.label), ['Status', 'Projects'])
  assert.equal(M.DEFAULT_VIEW, 'projects')

  assert.equal(M.normalizeView(' STATUS '), 'status')
  assert.equal(M.normalizeView('Projects'), 'projects')
  assert.equal(M.normalizeView('branches'), 'projects')
  assert.equal(M.normalizeView('issues'), 'projects')
  assert.equal(M.normalizeView('sessions'), 'projects')
  assert.equal(M.normalizeView(''), 'projects')
  assert.equal(M.normalizeView(null), 'projects')
  assert.equal(M.normalizeView(42), 'projects')
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

test('the merged page renders one switcher over the two views', () => {
  const begin = source.indexOf('function ProjectCommandCenterPage()')
  const end = source.indexOf('\n}\n', begin)

  assert.ok(begin >= 0, 'the merged page is missing')
  const block = source.slice(begin, end + 3)

  assert.match(block, /useValue\(\$view\)/, 'the page must read the view atom')
  assert.match(block, /jsx\(ViewSwitcher, \{\}\)/, 'the page must render the switcher')
  assert.match(block, /view === 'status'/, 'the page must branch to Status')
  assert.match(block, /jsx\(ProjectsPage, \{ embedded: true \}\)/, 'everything else is the Projects board')
  assert.doesNotMatch(block, /branches|issues/, 'no view may still branch on the removed ids')

  const switcher = source.slice(source.indexOf('function ViewSwitcher()'), source.indexOf('\n}\n', source.indexOf('function ViewSwitcher()')) + 3)

  assert.match(switcher, /options: VIEWS/, 'the switcher options are the constant list, so the width never moves')
  assert.match(switcher, /style: S\.viewSwitch/, 'the switcher sits in a fixed, non-growing wrapper')
  assert.match(source, /viewSwitch: \{ display: 'inline-flex', flex: 'none' \}/, 'the wrapper must not grow')
})

test('the removed grouped views and their helpers are gone', () => {
  for (const gone of [
    'SessionGroupView',
    'GroupedSessions',
    'GROUP_VIEWS',
    'kanbanBranchGroups',
    'kanbanIssueGroups',
    'kanbanIssueState',
    'ISSUE_STATES',
    'cardAsSession',
    'cardLane'
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${gone}\\b`), `${gone} must be deleted, not left dead`)
  }
  // DetailSessionRow is still the project page's session row, so it stays.
  assert.match(source, /function DetailSessionRow\(/, 'the project detail page still renders its row')
})

test('the separate sessions route, page and nav entry are gone', () => {
  assert.doesNotMatch(source, /SESSIONS_ROUTE/, 'no page may still point at /sessions')
  assert.doesNotMatch(source, /sessions-page/, 'the second page registration must be gone')
  assert.doesNotMatch(source, /sessions-nav/, 'the second sidebar entry must be gone')
  assert.equal((source.match(/area: SIDEBAR_NAV_AREA/g) || []).length, 1, 'the sidebar keeps one entry')
})

test('the palette opens the two named views and no Issues view', () => {
  const begin = source.indexOf("label: 'Open Projects'")
  const end = source.indexOf(']\n    ])', begin)
  const block = source.slice(begin, end > begin ? end : begin + 2000)

  assert.match(block, /label: 'Open Projects'[\s\S]*run: \(\) => openView\('projects'\)/)
  assert.match(block, /label: 'Open Sessions board'[\s\S]*run: \(\) => openView\('status'\)/)
  assert.doesNotMatch(source, /label: 'Open Issues'/, 'the Issues palette entry is gone')
  assert.doesNotMatch(source, /openView\('issues'\)/, 'nothing may open the removed view')
})

// ── lanes: the server read and the fallback ────────────────────────────────

test('a server lane payload is kept as-is: custom ids, labels, order and system', () => {
  const rows = M.laneRowsFromResponse({
    ok: true,
    lanes: [
      { id: 'ideas', label: 'Ideas', order: 0, custom: true },
      { id: 'active', label: 'Building', order: 1, custom: false, system: 1 },
      { id: 'done', label: 'Shipped', order: 2, custom: false }
    ]
  })

  assert.deepEqual(M.laneIds(rows), ['ideas', 'active', 'done'])
  assert.deepEqual(rows.map(row => row.label), ['Ideas', 'Building', 'Shipped'])
  assert.equal(rows[0].custom, true)
  assert.equal(rows[1].custom, undefined)
  assert.equal(rows[1].system, true, 'a system lane keeps the flag the route sent')
  assert.equal(rows[0].system, undefined)

  // Anything that is not the documented shape reads as "no server table".
  assert.equal(M.laneRowsFromResponse(null), null)
  assert.equal(M.laneRowsFromResponse({ ok: false, code: 'unknown_lane' }), null)
  assert.equal(M.laneRowsFromResponse({ ok: true, lanes: [] }), null)
  assert.equal(M.laneRowsFromResponse({ ok: true }), null)
})

test('a missing lane route falls back to the seven default lanes', () => {
  // The page keeps rendering from ctx.storage, so the fallback table is the same
  // seven ids the store seeds, unfiled first and canceled last.
  const stored = M.laneTableOrDefaults(null)

  assert.deepEqual(M.laneIds(stored), DEFAULT_IDS)
  assert.deepEqual(M.laneIds(M.laneTableOrDefaults(M.KANBAN_LANES)), DEFAULT_IDS)
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
  assert.equal(M.lanePlace(M.laneTableOrDefaults(null), 'someday'), 'unfiled')

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

test('a system lane offers no delete control, only rename and reorder', () => {
  const begin = source.indexOf('function LaneEditorRow(')
  const end = source.indexOf('\n}\n', begin)
  const block = source.slice(begin, end + 3)

  assert.match(block, /lane\.system/, 'the row knows which lanes are system')
  assert.match(block, /disabled: !live \|\| total <= 1 \|\| Boolean\(lane\.system\)/, 'a system lane cannot be removed')
  assert.match(block, /children: 'system'/, 'the row labels the system lanes')
})

test('lane_in_use counts read from any of the shapes the route may carry', () => {
  assert.equal(M.laneUseCount(4, 'done'), 4)
  assert.equal(M.laneUseCount({ done: 3 }, 'done'), 3)
  assert.equal(M.laneUseCount({ done: { count: 2 } }, 'done'), 2)
  assert.equal(M.laneUseCount({ done: { sessions: 5 } }, 'done'), 5)
  assert.equal(M.laneUseCount({ total: 6 }, 'done'), 6)
  assert.equal(M.laneUseCount(null, 'done'), 0)
})

// ── the projects view's session rendering ──────────────────────────────────

test('the projects view renders every session and no longer truncates a column', () => {
  assert.doesNotMatch(source, /BOARD_CARD_LIMIT/, 'the card limit constant is gone')
  assert.doesNotMatch(source, /S\.more\b/, 'the "+N more" button style is gone')
  const body = source.slice(source.indexOf('function ColumnBody('), source.indexOf('\n}\n', source.indexOf('function ColumnBody(')))
  assert.doesNotMatch(body, /hidden > 0|\+\$\{hidden\}|S\.more/, 'the column body has no truncation branch')
  assert.match(source, /preview_limit: TREE_PREVIEW_LIMIT/, 'the tree read asks for a window wide enough to show them all')
  assert.match(source, /overflowY: 'auto'/, 'the column body scrolls instead of truncating')
})

test('the projects view carries the lane filter button, the visible count and storage', () => {
  assert.match(source, /name: 'filter', size: '0\.875rem' \}\), 'Filter'/, 'the button is labelled Filter')
  assert.match(source, /function SessionLaneFilter\(/, 'the popover is its own component')
  assert.match(source, /type: 'checkbox'/, 'one checkbox per lane')
  assert.match(source, /const LANE_FILTER_KEY = 'projectLaneFilter\.v1'/, 'the filter has a stable storage key')
  assert.match(source, /storage\.get\(LANE_FILTER_KEY/, 'the filter is read from ctx.storage')
  assert.match(source, /storage\.set\(LANE_FILTER_KEY/, 'a toggle writes ctx.storage')
  assert.match(source, /of \$\{sessionCounts\.total\} sessions/, 'the page counts what is visible')
})

// ── row geometry ───────────────────────────────────────────────────────────

test('project rows and detail rows are 60px tall with 8px vertical padding', () => {
  const style = name => {
    const begin = source.indexOf(`\n  ${name}: {`)
    const end = source.indexOf('\n  },', begin)

    assert.ok(begin >= 0, `S.${name} missing`)
    const block = source.slice(begin, end)

    assert.match(block, /minHeight: 60/, `S.${name} must be 60px tall`)
    assert.match(block, /padding: '8px (10|12)px'/, `S.${name} needs 8px vertical padding`)
    assert.match(block, /boxSizing: 'border-box'/, `S.${name} must count the padding inside the 60px`)
  }

  style('card')
  style('sessionRow')

  // One line with an ellipsis, and a badge that cannot wrap.
  const title = source.slice(source.indexOf('\n  cardTitle: {'), source.indexOf('\n  },', source.indexOf('\n  cardTitle: {')))

  assert.match(title, /whiteSpace: 'nowrap'/)
  assert.match(title, /textOverflow: 'ellipsis'/)
  assert.doesNotMatch(title, /WebkitLineClamp/, 'the title is one line, not two')
  assert.match(source, /laneBadge: \{[^}]*whiteSpace: 'nowrap'/, 'the lane badge never wraps')
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
