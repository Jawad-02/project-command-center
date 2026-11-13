/**
 * Project Command Center.
 * A titlebar button, a board page (one horizontally scrolling column per
 * Hermes project with its recent sessions, and a live sessions strip below)
 * and a full project detail page at /project-command-center/project.
 * Everything is read from the gateway (projects.tree, projects.project_sessions,
 * session.active_list) plus the app's own busy atom. Project status is the only
 * state we own, and it lives behind readStatuses/writeStatus: ctx.storage is the
 * offline mirror, the backend's /board is the shared copy.
 *
 * Layout uses inline styles and one scoped <style> block with theme variables,
 * because a runtime plugin cannot rely on the app's compiled utility classes.
 */

import {
  Badge,
  Blobatar,
  Button,
  Codicon,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  MessageTextContent,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ROUTES_AREA,
  RowButton,
  SearchField,
  SegmentedControl,
  Separator,
  SIDEBAR_NAV_AREA,
  Skeleton,
  StatusDot,
  Textarea,
  Tip,
  atom,
  fmtDateTime,
  host,
  queryClient,
  useMutation,
  useQuery,
  useValue,
  writeClipboardText
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'project-command-center'
const ROUTE = '/project-command-center'
// The SDK routes carry no params, so the detail page is its own path and reads
// the selected project id out of an atom persisted in ctx.storage.
const PROJECT_ROUTE = `${ROUTE}/project`
const QUERY_ROOT = 'project-command-center'
// The one page has four views; the chosen one is the only route state we keep,
// because a reload should land where the user left the board.
const VIEW_KEY = 'ccView.v1'
const TREE_MS = 15000
const LIVE_MS = 5000
const STATUS_KEY = 'projectStatus.v1'
// Lane labels and order for the session kanban, kept apart from the store's ids.
const LANES_KEY = 'sessionLanes.v1'
const SORT_KEY = 'projectSort.v1'
const OPEN_KEY = 'openProject.v1'
const BOARD_CARD_LIMIT = 5
const COLUMN_WIDTH = 340
const COLUMN_GAP = 12
// /board is the backend copy of the status map plus the session→issue/PR links.
// The poll is slow on purpose: writes are optimistic and an event invalidates it.
const BOARD_MS = 15000
const BOARD_SYNC_DEBOUNCE_MS = 900
// A status we just posted wins over a poll that started before it landed.
const BOARD_WRITE_GRACE_MS = 8000
// The draft is a set of entry points, not a summary: where the issue lives and
// one line of context, small enough that the agent reads the issue itself.
// The composer only answers once the new session has painted, so the draft is
// written on this bounded retry schedule instead of once.
const DRAFT_RETRY_MS = [120, 300, 600, 1000, 2000]

const STATUSES = [
  { id: 'backlog', label: 'Backlog', variant: 'muted' },
  { id: 'active', label: 'Active', variant: 'default' },
  { id: 'review', label: 'Review', variant: 'warn' },
  { id: 'blocked', label: 'Blocked', variant: 'destructive' },
  { id: 'done', label: 'Done', variant: 'success' }
]
const DEFAULT_STATUS = 'active'

// Order matters: 'status' sorts by this list's index, so backlog sits left and
// done sits right, with the unfinished middle in between.
const SORTS = [
  { id: 'recent', label: 'Last active', icon: 'history' },
  { id: 'name', label: 'Name', icon: 'symbol-class' },
  { id: 'sessions', label: 'Most sessions', icon: 'comment-discussion' },
  { id: 'tokens', label: 'Most tokens', icon: 'pulse' },
  { id: 'status', label: 'Status', icon: 'circle-outline' }
]
const DEFAULT_SORT = 'recent'
const STATUS_RANK = { backlog: 0, active: 1, review: 2, blocked: 3, done: 4 }
const STATUS_BY_ID = Object.fromEntries(STATUSES.map(s => [s.id, s]))
// How far the badge's PR refinement reaches. Matches the backend's MAX_REFS.
const REF_BATCH_MAX = 50

// session-lane:begin
// One resolution order for every surface that shows a session's lane: an
// explicit per-session status first, then the linked pull request, then the
// project lane, then nothing. /board rows from a backend that predates the
// per-session lane carry no status fields at all, and a missing field reads
// exactly like an unset one here, so the older process still renders the PR
// and project fallbacks instead of an error or a placeholder.
const SESSION_LANE_LABELS = {
  backlog: 'Backlog',
  active: 'Active',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done'
}
// Theme variables the plugin already paints with, so a badge follows the theme.
const SESSION_LANE_VARS = {
  backlog: 'var(--ui-text-quaternary)',
  active: 'var(--ui-accent)',
  review: 'var(--ui-purple)',
  blocked: 'var(--ui-red)',
  done: 'var(--ui-green)'
}
const SESSION_LANE_SOURCE_TEXT = {
  user: 'set by you',
  agent: 'set by the agent',
  auto: 'set automatically',
  pr: 'from its pull request',
  project: 'from the project'
}
// Signal first: what a glance at the column should surface.
const SESSION_LANE_TALLY_ORDER = ['blocked', 'review', 'done', 'active', 'backlog']

function sessionLaneId(value, allowed) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : ''

  if (Object.prototype.hasOwnProperty.call(SESSION_LANE_LABELS, id)) return id
  // The server owns the lane table now, so a caller that read it can name ids
  // the five constants never had. Without that list the check stays the old
  // closed set, which is what every older caller passes.
  if (Array.isArray(allowed) && allowed.includes(id)) return id

  return ''
}

// A PR row from /github/refs or /github/pr/{n}. Merged is done, open or draft
// is review, closed without a merge proves nothing and leaves the lane alone.
function sessionPrLane(pr) {
  if (!pr || typeof pr !== 'object') return ''
  const state = String(pr.state || '').trim().toLowerCase()

  if (pr.merged === true || state === 'merged') return 'done'
  if (state === 'open' || pr.draft === true) return 'review'

  return ''
}

function resolveSessionLane(link, pr, projectLane, allowed) {
  const explicit = sessionLaneId(link && link.status, allowed)

  if (explicit) {
    const raw = String((link && link.status_source) || '').trim().toLowerCase()
    const source = raw === 'agent' || raw === 'auto' ? raw : 'user'
    const note = typeof link.note === 'string' ? link.note.trim() : ''

    return { lane: explicit, note, source }
  }

  const refined = sessionPrLane(pr)

  if (refined) return { lane: refined, note: '', source: 'pr' }

  const project = sessionLaneId(projectLane, allowed)

  if (project) return { lane: project, note: '', source: 'project' }

  return null
}

function sessionLaneTitle(lane) {
  if (!lane) return ''
  const label = SESSION_LANE_LABELS[lane.lane] || String(lane.lane || '')
  const source = SESSION_LANE_SOURCE_TEXT[lane.source] || SESSION_LANE_SOURCE_TEXT.project

  return lane.note ? `${label} lane, ${source}: ${lane.note}` : `${label} lane, ${source}`
}

// The lookup every surface shares: a link row plus the project's ref map.
function laneForLink(link, refs, projectLane, allowed) {
  const number = Number(link && link.pr)
  const pr = Number.isFinite(number) && number > 0 && refs ? refs.get(number) : null

  return resolveSessionLane(link, pr, projectLane, allowed)
}

// Every session in a project, counted per lane. Linked rows resolve through the
// helper; the sessions the links do not name still sit on the project lane, so
// the tally covers the whole column rather than the visible cards only.
function sessionLaneTally(sessionCount, links, refs, projectLane) {
  const counts = { backlog: 0, active: 0, review: 0, blocked: 0, done: 0 }
  let linked = 0

  for (const link of links || []) {
    if (!link || !link.session_id) continue
    linked += 1
    const lane = laneForLink(link, refs, projectLane)

    if (lane) counts[lane.lane] += 1
  }

  const rest = Math.max(0, (Number(sessionCount) || 0) - linked)
  const unnamed = rest > 0 ? resolveSessionLane(null, null, projectLane) : null

  if (unnamed) counts[unnamed.lane] += rest

  return counts
}

// One short line: the total, then at most two lane counts in signal order. The
// project's own lane is left out, so the line names the sessions that differ
// from the column rather than repeating its default.
function sessionLaneSummary(sessionCount, counts, projectLane) {
  const total = Number(sessionCount) || 0
  const parts = total > 0 ? [`${total} ${total === 1 ? 'session' : 'sessions'}`] : []
  const own = sessionLaneId(projectLane)

  for (const lane of SESSION_LANE_TALLY_ORDER) {
    if (lane === own) continue
    if (parts.length >= 3) break
    const n = counts && Number(counts[lane])
    if (Number.isFinite(n) && n > 0) parts.push(`${n} ${lane}`)
  }

  return parts.join(' \u00b7 ')
}
// session-lane:end

// session-kanban:begin
// The session kanban's pure half: the lane defaults and their stored shape, the
// filter rule, the column counts, the table order and the move body. No imports,
// no JSX and no storage here, so the node suite can slice this block out of the
// live file and run it. `kanbanLaneFor` defers to resolveSessionLane above, so
// the plugin keeps one resolution order rather than a second one for this page;
// the suite loads the session-lane block first.

const KANBAN_LANES = [
  { id: 'backlog', label: 'Backlog', order: 0 },
  { id: 'active', label: 'Active', order: 1 },
  { id: 'review', label: 'Review', order: 2 },
  { id: 'blocked', label: 'Blocked', order: 3 },
  { id: 'done', label: 'Done', order: 4 }
]
const KANBAN_LANE_IDS = KANBAN_LANES.map(lane => lane.id)
// A card untouched for three days is stale, unless it already landed in done.
const KANBAN_STALE_MS = 3 * 24 * 60 * 60 * 1000
// The four words a card's provenance dot can show. A session with no lane of its
// own reads as unset even when the project lane carries the card, because the dot
// answers "who set this lane", not "which lane is this in".
const KANBAN_SOURCE_TEXT = {
  user: 'you',
  agent: 'agent',
  auto: 'agent',
  pr: 'from PR',
  project: 'unset',
  unset: 'unset'
}

function kanbanLane(id) {
  const value = typeof id === 'string' ? id.trim().toLowerCase() : ''

  return KANBAN_LANE_IDS.includes(value) ? value : ''
}

// ── the lane table (server owned) ───────────────────────────────────────────
// /board/lanes answers the whole table as { id, label, order, custom }. The ids
// are no longer a closed set of five, so this reader keeps whatever the server
// names, in the order it names it. The five defaults are only the fallback an
// older backend (a 404) leaves behind.
function normalizeLaneTable(raw) {
  const rows = (Array.isArray(raw) ? raw : []).filter(row => row && typeof row.id === 'string' && row.id.trim())
  const listed = rows.map((row, index) => {
    const order = Number(row.order)

    return { row, index, order: Number.isFinite(order) ? order : index }
  })

  listed.sort((a, b) => a.order - b.order || a.index - b.index)
  const seen = new Set()
  const out = []

  for (const entry of listed) {
    const id = entry.row.id.trim().toLowerCase()

    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = typeof entry.row.label === 'string' ? entry.row.label.trim() : ''
    const lane = { id, label: label || SESSION_LANE_LABELS[id] || id, order: out.length }

    if (entry.row.custom === true) lane.custom = true
    out.push(lane)
  }

  return out
}

function laneTableOrDefaults(lanes) {
  const rows = normalizeLaneTable(lanes)

  return rows.length > 0 ? rows : normalizeKanbanLanes(KANBAN_LANES)
}

// The server's lane read. Anything that is not the documented shape (a 404
// body, an older process, an error) yields null, which every caller reads as
// "no server table, keep the stored copy".
function laneRowsFromResponse(payload) {
  if (!payload || typeof payload !== 'object' || payload.ok === false) return null
  const rows = normalizeLaneTable(payload.lanes)

  return rows.length > 0 ? rows : null
}

function laneIds(lanes) {
  return normalizeLaneTable(lanes).map(lane => lane.id)
}

// A card in a lane the table no longer lists sits in the first lane: a column
// that exists beats a card that renders nowhere.
function lanePlace(lanes, id) {
  const rows = normalizeLaneTable(lanes)
  const value = typeof id === 'string' ? id.trim().toLowerCase() : ''

  if (rows.some(lane => lane.id === value)) return value

  return rows.length > 0 ? rows[0].id : 'backlog'
}

// The list-level form of the rule above, applied after the filters so a placed
// card still counts in its column.
function kanbanPlaceCards(cards, lanes) {
  return (cards || []).map(card => {
    if (!card) return card
    const lane = lanePlace(lanes, card.lane)

    return lane === card.lane ? card : { ...card, lane }
  })
}

// What the create route would slug the label into; the optimistic column has to
// carry the same key a reload will show.
function laneSlug(label) {
  return String(label == null ? '' : label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

// Request bodies, in one place so the suite can assert them without a request.
function laneCreateBody(label) {
  return { label: String(label == null ? '' : label).trim() }
}

function laneRenameBody(id, label) {
  return { id: String(id), label: String(label == null ? '' : label).trim() }
}

function laneDeleteBody(id, reassign) {
  const body = { id: String(id) }
  const target = typeof reassign === 'string' ? reassign.trim() : ''

  if (target) body.reassign = target

  return body
}

function laneOrderBody(lanes) {
  return { ids: laneIds(lanes) }
}

// Optimistic create: the server owns the id, so the local copy mirrors its slug
// rule and a collision gets the same numeric suffix a second create would.
function addKanbanLane(lanes, label) {
  const text = String(label == null ? '' : label).trim()
  const rows = laneTableOrDefaults(lanes)
  const base = laneSlug(text)

  if (!text || !base) return rows

  let id = base
  let n = 2

  while (rows.some(lane => lane.id === id)) {
    id = `${base}-${n}`
    n += 1
  }

  return [...rows, { id, label: text, order: rows.length, custom: true }]
}

// The order route answers ids; the local table reorders by them, keeping every
// lane it did not hear about at the end.
function mergeKanbanOrder(lanes, ids) {
  const rows = laneTableOrDefaults(lanes)
  const wanted = Array.isArray(ids) ? ids.map(id => String(id)) : []
  const out = []

  for (const id of wanted) {
    const row = rows.find(lane => lane.id === id)

    if (row && !out.includes(row)) out.push(row)
  }

  for (const row of rows) if (!out.includes(row)) out.push(row)

  return out.map((row, index) => ({ ...row, order: index }))
}

// The five default lanes keep their theme colour; a custom lane cycles the same
// palette by its position, so every column has a dot.
const KANBAN_CUSTOM_VARS = [
  'var(--ui-accent)',
  'var(--ui-purple)',
  'var(--ui-green)',
  'var(--ui-red)',
  'var(--ui-text-quaternary)'
]

function laneColor(id, lanes) {
  if (SESSION_LANE_VARS[id]) return SESSION_LANE_VARS[id]
  const index = laneIds(lanes).indexOf(String(id))

  return index >= 0 ? KANBAN_CUSTOM_VARS[index % KANBAN_CUSTOM_VARS.length] : 'var(--ui-text-quaternary)'
}

function laneLabel(id, lanes) {
  const row = normalizeLaneTable(lanes).find(lane => lane.id === id)

  if (row) return row.label

  return SESSION_LANE_LABELS[id] || (id ? String(id) : '')
}

// The lane_in_use refusal carries how many cards sit in the lane. The key has
// moved shape once, so a bare number, a per-lane map and a totals object all
// read here.
function laneUseCount(counts, id) {
  if (counts == null) return 0
  if (Number.isFinite(Number(counts)) && typeof counts !== 'object') return Number(counts)
  if (typeof counts !== 'object') return 0
  const row = counts[id]

  if (Number.isFinite(Number(row)) && typeof row !== 'object') return Number(row)
  if (row && typeof row === 'object') {
    const n = Number(row.count ?? row.sessions ?? row.total)

    if (Number.isFinite(n)) return n
  }

  const total = Number(counts.total ?? counts.count ?? counts.sessions)

  return Number.isFinite(total) ? total : 0
}

// The five defaults, and the shape a stored copy had before the server owned the
// table. Unknown ids are dropped, missing labels take the default, duplicate or
// absent orders are renumbered by the default order, and any input that is not a
// list falls back to the default list, so the fallback can never leave the board
// without its five lanes.
function normalizeKanbanLanes(raw) {
  const rows = Array.isArray(raw) ? raw : []
  const out = []

  for (const lane of KANBAN_LANES) {
    const row = rows.find(item => item && item.id === lane.id) || {}
    const label = typeof row.label === 'string' ? row.label.trim() : ''
    const order = Number(row.order)

    out.push({ id: lane.id, label: label || lane.label, order: Number.isFinite(order) ? order : lane.order })
  }

  // A stored order is only trusted when it is a permutation of 0..4. Duplicates
  // (a hand edit, a half-written row) would otherwise slide one lane across the
  // board, so that case keeps the default order and the stored labels.
  const orders = out.map(row => row.order)
  const valid =
    orders.every(order => Number.isInteger(order) && order >= 0 && order < KANBAN_LANES.length) &&
    new Set(orders).size === orders.length

  if (!valid) out.forEach(row => (row.order = KANBAN_LANE_IDS.indexOf(row.id)))

  out.sort((a, b) => a.order - b.order)

  return out.map((row, index) => ({ id: row.id, label: row.label, order: index }))
}

// A rename keeps the lane where it is; an empty label keeps the old one.
function renameKanbanLane(lanes, id, label) {
  const text = typeof label === 'string' ? label.trim() : ''
  const rows = laneTableOrDefaults(lanes)
  const lane = typeof id === 'string' ? id.trim().toLowerCase() : ''

  if (!text || !lane || !rows.some(row => row.id === lane)) return rows

  return rows.map(row => (row.id === lane ? { ...row, label: text } : row))
}

// One step up (delta < 0) or down; a move past either end is a no-op.
function moveKanbanLane(lanes, id, delta) {
  const list = laneTableOrDefaults(lanes)
  const lane = typeof id === 'string' ? id.trim().toLowerCase() : ''
  const from = list.findIndex(row => row.id === lane)
  const step = Number(delta) < 0 ? -1 : 1
  const to = from + step

  if (from < 0 || to < 0 || to >= list.length) return list
  const next = list.slice()

  next.splice(to, 0, next.splice(from, 1)[0])

  return next.map((row, index) => ({ ...row, order: index }))
}

// The page's one lane lookup. A card with nothing set anywhere still has to sit
// in a column, so it lands in the first lane and reads as unset. An explicit
// lane id that the server table no longer lists lands in the first lane too,
// which is the whole point of resolving against the table and not a constant.
function kanbanLaneFor(link, pr, projectLane, lanes) {
  const rows = normalizeLaneTable(lanes)
  const ids = rows.map(row => row.id)
  const resolved = resolveSessionLane(link, pr, projectLane, ids)

  if (!resolved) return { lane: ids[0] || 'backlog', note: '', source: 'unset' }
  if (ids.length > 0 && !ids.includes(resolved.lane)) return { ...resolved, lane: ids[0] }

  return resolved
}

// Filters compose: project, source, stale and search all have to pass. Search is
// case-insensitive substring over the title, project label, branch and both
// reference numbers, which is what a card shows.
function kanbanFilterCards(cards, filters) {
  const f = filters || {}
  const q = String(f.search || '').trim().toLowerCase()
  const source = f.source === 'user' || f.source === 'agent' ? f.source : ''

  return (cards || []).filter(card => {
    if (!card) return false
    if (f.projectId && card.projectId !== f.projectId) return false
    if (source === 'user' && card.source !== 'user') return false
    if (source === 'agent' && card.source !== 'agent' && card.source !== 'auto') return false
    if (f.staleOnly && !card.stale) return false
    if (!q) return true
    const hay = [
      card.title,
      card.projectLabel,
      card.branch,
      card.issue ? `#${card.issue}` : '',
      card.pr ? `#${card.pr}` : '',
      card.issue,
      card.pr
    ]

    return hay.some(value => value != null && String(value).toLowerCase().includes(q))
  })
}

// Column counts come from the filtered list, so a chip and the cards under it
// never disagree.
function kanbanCounts(cards, lanes) {
  const counts = {}

  for (const lane of normalizeLaneTable(lanes)) counts[lane.id] = 0
  for (const card of cards || []) if (card && counts[card.lane] != null) counts[card.lane] += 1

  return counts
}

// The table is grouped by the user's lane order, newest first inside a lane.
function sortKanbanCards(cards, lanes, direction) {
  const rank = new Map(normalizeLaneTable(lanes).map((row, index) => [row.id, index]))
  const dir = Number(direction) < 0 ? -1 : 1

  return (cards || []).slice().sort((a, b) => {
    const byLane = (rank.get(a && a.lane) ?? 99) - (rank.get(b && b.lane) ?? 99)

    if (byLane !== 0) return byLane * dir

    return (Number(b && b.lastActivity) || 0) - (Number(a && a.lastActivity) || 0)
  })
}

// The one write a move makes. Scope is explicit: without it the store would move
// the project's lane instead of this session's card.
function kanbanMoveBody(projectId, sessionId, status) {
  return { project_id: projectId, session_id: sessionId, status, scope: 'session' }
}
// session-kanban:end

// merged-views:begin
// The plugin's one page renders four views over the same session cards. This is
// the pure half: the view ids and their storage value, the branch and issue
// groupings, and the row shape the project page's session list already renders.
// No imports, no JSX and no storage, so the node suite can slice it out.

const VIEWS = [
  { id: 'status', label: 'Status' },
  { id: 'projects', label: 'Projects' },
  { id: 'branches', label: 'Branches' },
  { id: 'issues', label: 'Issues' }
]
const DEFAULT_VIEW = 'status'
const VIEW_IDS = VIEWS.map(view => view.id)

function normalizeView(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : ''

  return VIEW_IDS.includes(id) ? id : DEFAULT_VIEW
}

// Newest first inside a group, the same order the project page's lane rows use.
function sortViewCards(cards) {
  return (cards || [])
    .slice()
    .sort((a, b) => (Number(b && b.lastActivity) || 0) - (Number(a && a.lastActivity) || 0))
}

// Branches span projects, so the group is the branch name alone; the biggest
// group leads, and a tie falls back to the name.
function kanbanBranchGroups(cards) {
  const map = new Map()

  for (const card of cards || []) {
    if (!card) continue
    const branch = String(card.branch || '').trim() || 'main'
    const rows = map.get(branch) || []

    rows.push(card)
    map.set(branch, rows)
  }

  return Array.from(map.entries())
    .map(([branch, rows]) => ({ key: `branch:${branch}`, id: branch, label: branch, cards: sortViewCards(rows) }))
    .sort((a, b) => b.cards.length - a.cards.length || a.label.localeCompare(b.label))
}

// The five buckets a session's refs can land in. A merged PR outranks its closed
// state, an open PR is in review, an issue with no PR is open, and a session
// with neither is unlinked. The order is the display order.
const ISSUE_STATES = [
  { id: 'open', label: 'Open', icon: 'issues' },
  { id: 'review', label: 'In review', icon: 'git-pull-request' },
  { id: 'merged', label: 'Merged', icon: 'git-merge' },
  { id: 'closed', label: 'Closed', icon: 'circle-slash' },
  { id: 'unlinked', label: 'Unlinked', icon: 'link' }
]

function kanbanIssueState(card) {
  if (!card) return 'unlinked'
  const pr = card.prState && typeof card.prState === 'object' ? card.prState : null

  if (pr) {
    const state = String(pr.state || '').trim().toLowerCase()

    if (pr.merged === true || state === 'merged') return 'merged'
    if (state === 'open') return 'review'
    if (state === 'closed') return 'closed'
  }

  if (Number(card.pr) > 0) return 'review'
  if (Number(card.issue) > 0) return 'open'

  return 'unlinked'
}

function kanbanIssueGroups(cards) {
  const rows = cards || []

  return ISSUE_STATES.map(state => ({
    key: `issue:${state.id}`,
    id: state.id,
    label: state.label,
    icon: state.icon,
    cards: sortViewCards(rows.filter(card => card && kanbanIssueState(card) === state.id))
  }))
}

// The project page's session row reads a gateway session; a kanban card carries
// the same title, id and activity stamp under other names, so the merged views
// hand it one without a second fetch.
function cardAsSession(card) {
  const row = card || {}

  return {
    id: String(row.sessionId || row.id || ''),
    title: String(row.title || ''),
    last_active: Number(row.lastActivity) || 0
  }
}

function cardLane(card) {
  const row = card || {}

  return { lane: row.lane, note: row.laneNote || '', source: row.laneSource || 'unset' }
}
// merged-views:end

const LIVE_LABELS = {
  idle: 'Idle',
  starting: 'Starting',
  waiting: 'Waiting',
  working: 'Working',
  streaming: 'Streaming',
  resuming: 'Resuming'
}

// A turn is running in these states; `waiting` is an open turn that wants the
// user (amber dot, no arc) and `idle` paints nothing at all.
const RUNNING = new Set(['working', 'streaming', 'starting', 'resuming'])

function liveTone(status) {
  if (RUNNING.has(status)) return 'good'
  if (status === 'waiting') return 'warn'

  return 'muted'
}

// The gateway poll lags the app's own busy flag by up to one tick, and a session
// running in another window only ever shows up in the poll. So busy wins when it
// says "mid-turn" and never overrides a running status or `waiting` with idle.
//
// Neither source is enough on its own: a turn that resumed after an approval can
// report `idle` in the poll while it streams, and the busy flag drops the moment
// a turn parks on a tool. So the third input is the gateway event stream itself:
// any event for that runtime id inside the watchdog window means the session is
// producing right now.
function liveState(item, busy, recentlyActive) {
  const status = (item && item.status) || 'idle'

  if (status === 'waiting') return status
  if (RUNNING.has(status)) return status
  if (busy || recentlyActive) return 'working'

  return 'idle'
}

// ── activity watchdog ────────────────────────────────────────────────────────
// Keyed by RUNTIME id (the envelope's session_id), because that is what the
// event stream carries; the hook maps it to stored ids once active_list answers.
// Writes are throttled per session so a token stream cannot re-render the board.

const ACTIVITY_TTL_MS = 90000
const ACTIVITY_WRITE_MS = 2000
const ACTIVITY_TYPES = new Set([
  'message.start',
  'message.delta',
  'message.interim',
  'reasoning.delta',
  'reasoning.available',
  'thinking.delta',
  'tool.start',
  'tool.complete',
  'tool.generating',
  'tool.progress',
  'status.update',
  'session.usage',
  'agent.terminal.output'
])

const $activity = atom({})
// Bumped on a timer so the TTL can expire without waiting for another event.
const $activityClock = atom(0)
const lastActivityWrite = new Map()

function noteActivity(runtimeId, at) {
  if (!runtimeId) return
  const now = Date.now()
  const previous = lastActivityWrite.get(runtimeId) || 0

  if (now - previous < ACTIVITY_WRITE_MS) return
  lastActivityWrite.set(runtimeId, now)
  $activity.set({ ...$activity.get(), [runtimeId]: at })
}

function clearActivity(runtimeId) {
  if (!runtimeId) return
  const current = $activity.get()

  if (!(runtimeId in current)) return
  lastActivityWrite.delete(runtimeId)
  const next = { ...current }

  delete next[runtimeId]
  $activity.set(next)
}

// ── status storage: one optimistic copy, one server copy ─────────────────────
// The backend owns the status map (/board, POST /board/status, /board/seed).
// ctx.storage is the offline mirror and the restart copy: every local write lands
// there first, every applied server value is written back, and a failing read
// leaves the storage copy in charge exactly as it was.

let pluginCtx = null
// ctx timers die with the plugin, but a composer verb or a REST call can settle
// after unload; a promise-chained ctx.setTimeout would then write into a
// lifetime set that is already retired. Scheduling goes through one gate, and
// register() arms it again for a reload.
let pluginDisposed = false
const $statuses = atom({})
// True when the last /board read answered with the board shape.
const $boardLive = atom(false)
// project id → { at, status } for the last status this client posted.
const statusPostedAt = new Map()
// The session kanban's editable lane table, and the moves this client posted.
const $lanes = atom(KANBAN_LANES)
// session id → { project_id, status, at } for a session lane posted just now.
const $sessionStatus = atom({})
// A board poll that started before a move landed still carries the old lane, so
// an override outlives the POST for one bounded window and dies on its echo.
const SESSION_POST_TTL_MS = 30000

function readStatuses() {
  const raw = pluginCtx ? pluginCtx.storage.get(STATUS_KEY, {}) : {}
  const out = {}

  if (raw && typeof raw === 'object') {
    for (const [id, status] of Object.entries(raw)) {
      if (STATUS_BY_ID[status]) out[id] = status
    }
  }

  return out
}

// ctx.rest rejects when the gateway has no router for this plugin, which is the
// "backend not enabled yet" signal. Keeping it a rejected promise (rather than a
// throw at call time) means every caller can branch the same way ghRest does.
function boardRest(path, opts) {
  if (!pluginCtx || typeof pluginCtx.rest !== 'function') {
    return Promise.reject(new Error('This Desktop build has no plugin REST door.'))
  }

  return pluginCtx.rest(path, opts)
}

// The only door to a ctx timer after registration: a plugin that has been
// disposed (or not registered yet) drops the callback instead of scheduling
// into a retired lifetime.
function schedule(fn, ms) {
  if (pluginDisposed || !pluginCtx) return null

  return pluginCtx.setTimeout(fn, ms)
}

function saveStatuses(next) {
  if (!pluginDisposed && pluginCtx) pluginCtx.storage.set(STATUS_KEY, next)
}

function writeStatus(projectId, status) {
  if (!STATUS_BY_ID[status]) return
  const next = { ...$statuses.get(), [projectId]: status }

  $statuses.set(next)
  saveStatuses(next)
  // Optimistic on the server too. A 404 (old process) is swallowed: the storage
  // copy above already carries the change, so the picker never blocks on it.
  statusPostedAt.set(projectId, { at: Date.now(), status })
  boardRest('/board/status', { method: 'POST', body: { project_id: projectId, status } }).catch(() => {})
}

// The lane table is server owned now (/board/lanes), so the stored copy is a
// read-through cache: it answers while the read is in flight and it is what an
// older backend (a 404) leaves in charge. A stored table with any lane in it is
// kept as-is, custom ids included; a missing or unreadable one is the five
// defaults.
function readLanes() {
  const raw = pluginCtx ? pluginCtx.storage.get(LANES_KEY, null) : null
  const rows = normalizeLaneTable(raw)

  return rows.length > 0 ? rows : normalizeKanbanLanes(KANBAN_LANES)
}

function saveLanes(next) {
  if (!pluginDisposed && pluginCtx) pluginCtx.storage.set(LANES_KEY, next)
}

function writeLanes(next) {
  const rows = normalizeLaneTable(next)
  const value = rows.length > 0 ? rows : normalizeKanbanLanes(KANBAN_LANES)

  $lanes.set(value)
  saveLanes(value)
}

// One lane read shared by the status page and the project detail page. A 404
// (or any failure) leaves the stored copy in charge, which is exactly the older
// backend's five defaults; the page never blocks on the route.
function useLaneTable() {
  const query = useQuery({
    queryFn: () => boardRest('/board/lanes'),
    queryKey: [QUERY_ROOT, 'lanes'],
    refetchInterval: BOARD_MS,
    retry: false,
    staleTime: 10000
  })

  const local = useValue($lanes)
  const serverRows = useMemo(() => laneRowsFromResponse(query.data), [query.data])

  // Server truth is this machine's restart copy too, so the next launch (or an
  // offline read) starts from the table the server last named.
  useEffect(() => {
    if (!serverRows) return
    if (JSON.stringify($lanes.get()) === JSON.stringify(serverRows)) return

    $lanes.set(serverRows)
    saveLanes(serverRows)
  }, [serverRows])

  return { live: Boolean(serverRows), query, rows: serverRows || local }
}

// A failed lane write and its reason. `code` is the route's own code, and
// `counts` only rides a lane_in_use refusal.
function laneFailure(res) {
  const code = String((res && res.code) || '')
  const text =
    res && typeof res.error === 'string' && res.error.trim()
      ? res.error.trim()
      : {
          bad_label: 'Give the lane a name.',
          lane_exists: 'A lane with that name already exists.',
          unknown_lane: 'That lane is no longer on the board.',
          bad_order: 'The board refused that lane order.',
          lane_in_use: 'That lane still has sessions.',
          last_lane: 'The board needs at least one lane.'
        }[code] || 'The board refused the lane change.'
  const err = new Error(text)

  err.code = code
  err.counts = res && res.counts

  return err
}

function lanePost(path, body) {
  return boardRest(path, { method: 'POST', body }).then(res => {
    if (!res || res.ok === false) throw laneFailure(res)

    return res
  })
}

function laneRefresh() {
  queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, 'lanes'] })
}

// A local override that names a lane the server just removed would outlive the
// board answer for its TTL and hide the cards' new lane, so the delete clears
// those overrides and lets the reread place every card.
function forgetSessionLane(laneId) {
  const rows = $sessionStatus.get()
  const next = {}
  let changed = false

  for (const [id, row] of Object.entries(rows)) {
    if (row && row.status === laneId) {
      changed = true

      continue
    }

    next[id] = row
  }

  if (changed) $sessionStatus.set(next)
}

// Deleting a lane moves its cards on the server, so the board has to be reread
// the moment the request settles: the lanes query alone would leave the cards
// on a column that is gone.
function laneRefreshBoard() {
  laneRefresh()
  queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, 'board'] })
}

function laneToast(err, action) {
  host.notify({
    kind: 'warning',
    message: `Could not ${action}: ${(err && err.message) || 'the board did not answer'}`
  })
}

// Create: the column appears before the POST is answered. A refusal puts the
// table back and says why, and the caller may also show the reason inline.
function createLane(label) {
  const text = String(label == null ? '' : label).trim()

  if (!text) return Promise.reject(laneFailure({ code: 'bad_label' }))
  const snapshot = $lanes.get()

  writeLanes(addKanbanLane(snapshot, text))

  return lanePost('/board/lanes', laneCreateBody(text))
    .then(res => {
      laneRefresh()

      return res
    })
    .catch(err => {
      writeLanes(snapshot)
      laneRefresh()
      laneToast(err, `add the ${text} lane`)
      throw err
    })
}

function renameLane(laneId, label) {
  const text = String(label == null ? '' : label).trim()
  const snapshot = $lanes.get()
  const next = renameKanbanLane(snapshot, laneId, text)

  if (!text || JSON.stringify(next) === JSON.stringify(normalizeLaneTable(snapshot))) return Promise.resolve()

  writeLanes(next)

  return lanePost('/board/lanes', laneRenameBody(laneId, text))
    .then(res => {
      laneRefresh()

      return res
    })
    .catch(err => {
      writeLanes(snapshot)
      laneRefresh()
      laneToast(err, 'rename that lane')
      throw err
    })
}

function reorderLanes(lanes) {
  const snapshot = $lanes.get()
  const next = normalizeLaneTable(lanes)

  writeLanes(next)

  return lanePost('/board/lanes/order', laneOrderBody(next))
    .then(res => {
      laneRefresh()

      return res
    })
    .catch(err => {
      writeLanes(snapshot)
      laneRefresh()
      laneToast(err, 'reorder the lanes')
      throw err
    })
}

// Delete, with the lane_in_use retry: without `reassign` the server refuses and
// reports the card counts; the popover then asks where the cards should go and
// calls this again with the chosen lane.
function deleteLane(laneId, reassign) {
  const snapshot = $lanes.get()
  const target = typeof reassign === 'string' ? reassign.trim() : ''

  if (!target) writeLanes(normalizeLaneTable(snapshot).filter(row => row.id !== laneId))

  return lanePost('/board/lanes/delete', laneDeleteBody(laneId, target))
    .then(res => {
      forgetSessionLane(laneId)
      laneRefreshBoard()

      return res
    })
    .catch(err => {
      writeLanes(snapshot)
      laneRefreshBoard()
      if (!err || err.code !== 'lane_in_use') laneToast(err, 'remove that lane')
      throw err
    })
}

// A card moves before the POST is answered; a refusal puts it back and says why.
// The board read is invalidated either way, so the server copy wins as soon as
// it lands.
function writeSessionLane(projectId, sessionId, status) {
  // The lane must be one the table currently lists; a custom lane is as real as
  // a default one, and a lane that was just deleted is refused here the same way
  // the server would refuse it.
  const lane = laneIdIn($lanes.get(), status)

  if (!projectId || !sessionId || !lane) return
  const at = Date.now()

  $sessionStatus.set({ ...$sessionStatus.get(), [sessionId]: { project_id: projectId, status: lane, at } })
  boardRest('/board/status', { method: 'POST', body: kanbanMoveBody(projectId, sessionId, lane) })
    .then(res => {
      if (res && res.ok === false) throw new Error(String(res.error || 'The board refused the move.'))
      queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, 'board'] })
    })
    .catch(err => {
      const current = $sessionStatus.get()

      if (current[sessionId] && current[sessionId].at === at) {
        const back = { ...current }

        delete back[sessionId]
        $sessionStatus.set(back)
      }

      // Resync either way: a refusal means this client's copy is the one that
      // was wrong, and the poll is the cheapest way back to the store's answer.
      queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, 'board'] })
      host.notify({
        kind: 'warning',
        message: `Could not move this session to ${laneLabel(lane, $lanes.get())}: ${(err && err.message) || 'the board did not answer'}`
      })
    })
}

// The board wins once it echoes the move, or after the grace window; without this
// an override would outlive the poll that already carries the answer.
function reconcileSessionLanes(links) {
  const rows = $sessionStatus.get()
  const ids = Object.keys(rows)

  if (ids.length === 0) return
  const byId = new Map((links || []).filter(Boolean).map(link => [link.session_id, link]))
  const now = Date.now()
  const next = { ...rows }
  let changed = false

  for (const id of ids) {
    const link = byId.get(id)

    if ((link && link.status === rows[id].status) || now - rows[id].at >= SESSION_POST_TTL_MS) {
      delete next[id]
      changed = true
    }
  }

  if (changed) $sessionStatus.set(next)
}

// A payload that is not the board shape (a 404 body, an older process) yields
// null, which every consumer reads as "no server statuses, use storage".
// `statuses` is a list of rows on the current store and was an id-keyed map on
// older builds; both are read here, so one payload shape change never costs the
// board its links.
function boardStatusMap(payload) {
  const rows = payload && payload.statuses

  if (!rows || typeof rows !== 'object') return null
  const entries = Array.isArray(rows)
    ? rows.map(row => [row && row.project_id, row])
    : Object.entries(rows)
  const out = {}

  for (const [id, row] of entries) {
    const value = typeof row === 'string' ? row : row && row.status

    if (id && STATUS_BY_ID[value]) out[id] = value
  }

  return out
}

// One read feeds the status picker, the board chips and the project sync. Both
// pages mount it; the queryKey is shared, so it stays one request.
let boardSeedTried = false

function useBoard() {
  const query = useQuery({
    queryFn: () => boardRest('/board'),
    queryKey: [QUERY_ROOT, 'board'],
    refetchInterval: BOARD_MS,
    retry: false,
    staleTime: 8000
  })

  const statuses = useMemo(() => boardStatusMap(query.data), [query.data])
  const data = statuses ? query.data : null
  const links = useMemo(() => (data && Array.isArray(data.links) ? data.links : []), [data])

  useEffect(() => {
    $boardLive.set(Boolean(data))
  }, [data])

  // The server wins, except for a project changed moments ago: the POST may
  // still be in flight, and reverting a picker under the cursor is worse than a
  // tick of stale data. react-query's structural sharing hands back the SAME
  // data object across identical polls, so the effect also depends on
  // dataUpdatedAt: a value skipped inside the grace window is re-examined on
  // every later read instead of waiting for some other board field to change.
  useEffect(() => {
    if (!statuses) return

    const now = Date.now()
    const next = { ...$statuses.get() }
    let changed = false

    for (const [id, value] of Object.entries(statuses)) {
      const posted = statusPostedAt.get(id)

      if (posted) {
        // The echo of what we posted ends the grace window, so a newer server
        // value for this project is applied the moment it lands.
        if (posted.status === value || now - posted.at >= BOARD_WRITE_GRACE_MS) statusPostedAt.delete(id)
        else continue
      }

      if (next[id] !== value) {
        next[id] = value
        changed = true
      }
    }

    if (changed) {
      $statuses.set(next)
      // Server truth is this machine's restart copy too, so a relaunch or an
      // offline read shows what the board showed.
      saveStatuses(next)
    }
  }, [statuses, query.dataUpdatedAt])

  // First live read against a fresh backend: it has no statuses but this machine
  // has some, so hand them over once. Once the server answers with ANY row it is
  // authoritative, and a project only this machine knows goes over one
  // POST /board/status at a time (there is no bulk seed for a non-empty map). A
  // failed seed clears the flag and the next board tick tries again.
  useEffect(() => {
    if (!statuses || boardSeedTried) return

    const local = readStatuses()

    boardSeedTried = true

    if (Object.keys(statuses).length === 0) {
      if (Object.keys(local).length === 0) return

      boardRest('/board/seed', { method: 'POST', body: { statuses: local } }).catch(() => {
        boardSeedTried = false
      })

      return
    }

    for (const [id, status] of Object.entries(local)) {
      if (statuses[id]) continue

      boardRest('/board/status', { method: 'POST', body: { project_id: id, status } }).catch(() => {})
    }
  }, [statuses, query.dataUpdatedAt])

  return { data, links, live: Boolean(data), query }
}

// The Link to session menu needs the links only: the same query key serves it
// from an open board's cache, and the board's seeding and polling effects are
// not mounted a second time by a modal.
function useBoardLinks() {
  const query = useQuery({
    queryFn: () => boardRest('/board'),
    queryKey: [QUERY_ROOT, 'board'],
    retry: false,
    staleTime: 8000
  })

  return useMemo(() => (query.data && Array.isArray(query.data.links) ? query.data.links : []), [query.data])
}

// project id → the issue and PR numbers a session is linked to, newest link last.
function linksByProject(links) {
  const map = new Map()

  for (const link of links || []) {
    if (!link || !link.project_id) continue

    const row = map.get(link.project_id) || { issues: [], prs: [] }
    const issue = Number(link.issue)
    const pr = Number(link.pr)

    if (Number.isFinite(issue) && issue > 0 && !row.issues.includes(issue)) row.issues.push(issue)
    if (Number.isFinite(pr) && pr > 0 && !row.prs.includes(pr)) row.prs.push(pr)
    map.set(link.project_id, row)
  }

  return map
}

// Session id → its link row. One row per session by construction, and the badge
// only ever needs the newest link the board reports for it.
function linksBySession(links) {
  const map = new Map()

  for (const link of links || []) {
    if (!link || !link.session_id || map.has(link.session_id)) continue
    map.set(link.session_id, link)
  }

  return map
}

// Project id → every link row, for the column tally whose total is the whole
// project, not the five cards a column draws.
function linkRowsByProject(links) {
  const map = new Map()

  for (const link of links || []) {
    if (!link || !link.project_id) continue
    const rows = map.get(link.project_id) || []

    rows.push(link)
    map.set(link.project_id, rows)
  }

  return map
}

// PR number → { state, merged, draft } in at most REF_BATCH_MAX per call, which
// is the backend's own limit. A failed chunk (no route, no token, a rate limit)
// is an empty map: the refinement simply does not happen and the project lane
// answers instead.
async function prStatesFor(folder, numbers) {
  const out = new Map()

  for (let i = 0; i < numbers.length; i += REF_BATCH_MAX) {
    const slice = numbers.slice(i, i + REF_BATCH_MAX)
    const query = `path=${encodeURIComponent(folder)}&numbers=${slice.join(',')}`
    const data = await ghRest(`/github/refs?${query}`).catch(() => null)
    const refs = data && data.ok && data.refs && typeof data.refs === 'object' ? data.refs : null

    if (!refs) continue
    for (const number of slice) {
      const row = refs[String(number)]

      if (row && typeof row === 'object') out.set(number, row)
    }
  }

  return out
}

// One query for every project on the page: each project's linked PR numbers in
// one batched refs read. Projects with no linked PR cost nothing, and the whole
// map is empty until the backend answers.
function useProjectRefs(projects, links) {
  const plan = useMemo(() => {
    const rows = linkRowsByProject(links)
    const out = []

    for (const project of projects || []) {
      if (!project || !project.id) continue
      const folder = primaryPath(project)
      const numbers = []

      for (const link of rows.get(project.id) || []) {
        const number = Number(link.pr)

        if (Number.isFinite(number) && number > 0 && !numbers.includes(number)) numbers.push(number)
      }

      if (folder && numbers.length > 0) out.push({ folder, id: project.id, numbers })
    }

    return out
  }, [projects, links])

  const sig = useMemo(() => plan.map(row => `${row.id}:${row.folder}:${row.numbers.join(',')}`).join('|'), [plan])

  const query = useQuery({
    enabled: plan.length > 0,
    queryFn: () =>
      Promise.all(plan.map(row => prStatesFor(row.folder, row.numbers))).then(list => {
        const out = new Map()

        for (let i = 0; i < plan.length; i += 1) out.set(plan[i].id, list[i])

        return out
      }),
    queryKey: [QUERY_ROOT, 'github', 'lane-refs', sig],
    retry: false,
    staleTime: 60000
  })

  return useMemo(() => query.data || new Map(), [query.data])
}

// The tree changes rarely, so a debounce absorbs a burst of 15s polls. The
// signature is the payload itself: an identical id/label/path set posts once, and
// a failed post retries when the board comes back ($boardLive flips or the tree
// changes).
let projectSyncSig = ''

function projectSyncRows(projects) {
  return (projects || [])
    .filter(p => p && p.id)
    .map(p => ({ id: String(p.id), label: String(p.label || ''), paths: folderList(p) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function useProjectSync(projects) {
  const live = useValue($boardLive)
  const rows = useMemo(() => projectSyncRows(projects), [projects])
  const sig = useMemo(() => JSON.stringify(rows), [rows])

  useEffect(() => {
    if (rows.length === 0 || projectSyncSig === sig) return undefined

    const timer = schedule(() => {
      boardRest('/board/projects', { method: 'POST', body: { projects: rows } })
        .then(() => {
          projectSyncSig = sig
        })
        .catch(() => {})
    }, BOARD_SYNC_DEBOUNCE_MS)

    return () => {
      if (typeof timer === 'function') timer()
    }
    // `rows` travels in the payload but not in the deps: `sig` is its
    // serialization, so a tree poll with the same set must not reset the timer.
  }, [sig, live])
}

// ── sort storage ─────────────────────────────────────────────────────────────

const $sort = atom(DEFAULT_SORT)

function readSort() {
  const raw = pluginCtx ? pluginCtx.storage.get(SORT_KEY, DEFAULT_SORT) : DEFAULT_SORT

  return SORTS.some(s => s.id === raw) ? raw : DEFAULT_SORT
}

function writeSort(sortId) {
  if (!SORTS.some(s => s.id === sortId)) return
  $sort.set(sortId)
  if (pluginCtx) pluginCtx.storage.set(SORT_KEY, sortId)
}

// ── view storage ─────────────────────────────────────────────────────────────
// One page, four views. The atom is the render path and storage is the durable
// copy, so a reload (or a revisit from the sidebar) lands on the last view.

const $view = atom(DEFAULT_VIEW)

function readView() {
  const raw = pluginCtx ? pluginCtx.storage.get(VIEW_KEY, DEFAULT_VIEW) : DEFAULT_VIEW

  return normalizeView(raw)
}

function writeView(viewId) {
  const id = normalizeView(viewId)

  $view.set(id)
  if (pluginCtx) pluginCtx.storage.set(VIEW_KEY, id)
}

// A palette entry and a nav click both land here: pick the view, then make sure
// the single route is the one showing it.
function openView(viewId) {
  writeView(viewId)
  host.navigate(ROUTE)
}

// ── open project storage ─────────────────────────────────────────────────────
// Same discipline as status/sort: the atom is the render path, storage is the
// durable copy. The detail route has no params, so it reads this on mount.

const $openProject = atom('')

function readOpenProject() {
  const raw = pluginCtx ? pluginCtx.storage.get(OPEN_KEY, '') : ''

  return typeof raw === 'string' ? raw : ''
}

function openProject(projectId) {
  if (!projectId) return
  $openProject.set(projectId)
  if (pluginCtx) pluginCtx.storage.set(OPEN_KEY, projectId)
  host.navigate(PROJECT_ROUTE)
}

// ── formatting helpers ───────────────────────────────────────────────────────

// Gateway timestamps are epoch seconds; tolerate milliseconds too.
function toMs(value) {
  if (!value || !Number.isFinite(Number(value))) return 0
  const n = Number(value)

  return n < 1e12 ? n * 1000 : n
}

// One reader for every stamp the plugin prints: epoch seconds and milliseconds
// from the gateway, ISO 8601 from GitHub and `git log --iso-strict`.
function stampMs(value) {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return toMs(value)
  const str = String(value).trim()

  if (/^\d+(\.\d+)?$/.test(str)) return toMs(str)
  const parsed = Date.parse(str)

  return Number.isFinite(parsed) ? parsed : 0
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

// Short absolute date for anything a year or older, so `opened Mar 4, 2025`
// still reads right.
const fmtShortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

// The one relative age the UI prints. Floored, English, singular forms kept.
// Ages refresh only when the view re-renders, which the existing 5 s activity
// tick ($activityClock, below) already drives. Never wrap a call site in
// React.memo or the text will freeze at mount time.
function ageText(value, now = Date.now()) {
  const ms = stampMs(value)

  if (!ms) return ''
  const diff = now - ms

  // A stamp in the future is clock skew, not history.
  if (diff < MINUTE_MS) return 'just now'
  if (diff < HOUR_MS) {
    const n = Math.floor(diff / MINUTE_MS)

    return `${n} ${n === 1 ? 'min' : 'mins'} ago`
  }
  if (diff < DAY_MS) {
    const n = Math.floor(diff / HOUR_MS)

    return `${n} ${n === 1 ? 'hour' : 'hours'} ago`
  }
  if (diff < MONTH_MS) {
    const n = Math.floor(diff / DAY_MS)

    return `${n} ${n === 1 ? 'day' : 'days'} ago`
  }
  if (diff < YEAR_MS) {
    const n = Math.min(11, Math.max(1, Math.floor(diff / MONTH_MS)))

    return `${n} ${n === 1 ? 'month' : 'months'} ago`
  }

  return fmtShortDate.format(new Date(ms))
}

// `state.db` has no `last_active` column (started_at, ended_at,
// last_activity_at), and the gateway derives last_active from the newest of them
// with started_at as the floor. So a finished session arrives reading as its
// creation time; take the newest stamp the row actually carries.
function sessionStamp(s) {
  if (!s) return 0

  return Math.max(toMs(s.last_active), toMs(s.ended_at), toMs(s.started_at))
}

function stampTip(ms) {
  if (!ms) return 'No activity yet'

  return `Last updated ${fmtDateTime.format(new Date(ms))}`
}

function formatTokens(n) {
  if (!n || n < 0) return '0'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`

  return String(Math.round(n))
}

function formatCost(n) {
  if (!n || n <= 0) return ''
  if (n >= 10) return `$${n.toFixed(0)}`
  if (n >= 0.1) return `$${n.toFixed(2)}`

  return `$${n.toFixed(3)}`
}

// Keeps the head and the tail of a path, since the folder name is the part that matters.
function middleTruncate(path, max = 40) {
  const p = String(path || '').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~')

  if (p.length <= max) return p
  const tail = Math.ceil((max - 1) * 0.62)
  const head = max - 1 - tail

  return `${p.slice(0, head)}\u2026${p.slice(p.length - tail)}`
}

function sessionTitle(s) {
  return String(s.title || '').trim() || String(s.preview || '').trim() || 'Untitled session'
}

function shortModel(model) {
  return String(model || '').split('/').pop()
}

// `lastActive` on the tree node is not always populated, so take the newest
// session stamp we can see in the lanes and previews as well. A project with no
// sessions lands at 0 and sorts to the end of the board, which is the point.
function projectRecency(project) {
  let newest = toMs(project.lastActive)

  for (const repo of project.repos || []) {
    for (const lane of repo.groups || []) {
      for (const s of lane.sessions || []) newest = Math.max(newest, sessionStamp(s))
    }
  }

  for (const s of project.previewSessions || []) newest = Math.max(newest, sessionStamp(s))

  return newest
}

function sortProjects(list, sortId, statuses) {
  const byName = (a, b) => String(a.label || '').localeCompare(String(b.label || ''), undefined, { numeric: true })
  const ranked = [...list]

  if (sortId === 'name') {
    ranked.sort(byName)
  } else if (sortId === 'sessions') {
    ranked.sort((a, b) => (b.sessionCount || 0) - (a.sessionCount || 0) || byName(a, b))
  } else if (sortId === 'tokens') {
    ranked.sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0) || byName(a, b))
  } else if (sortId === 'status') {
    const rank = p => STATUS_RANK[statuses[p.id] || DEFAULT_STATUS] ?? 99

    ranked.sort((a, b) => rank(a) - rank(b) || projectRecency(b) - projectRecency(a) || byName(a, b))
  } else {
    ranked.sort((a, b) => projectRecency(b) - projectRecency(a) || byName(a, b))
  }

  return ranked
}

function primaryPath(project) {
  return project.path || (project.repos && project.repos[0] && project.repos[0].path) || ''
}

function validColor(color) {
  if (!color || typeof color !== 'string') return null
  if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('color', color)) return null

  return color
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// Every project RPC is profile-scoped; under a multiplexed gateway the request
// must name the profile or it reads the wrong store.
function profileParam() {
  try {
    const name = host.state.profile.get()

    return name ? { profile: name } : {}
  } catch {
    return {}
  }
}

// The app's own session tab: an existing session (a board card, a live strip
// row) opens as a tab, and a failure is reported instead of vanishing.
function openSession(id) {
  Promise.resolve(host.openSession(id, { intent: 'tab' })).catch(err => {
    host.notify({ kind: 'error', message: `Could not open session: ${err && err.message ? err.message : err}` })
  })
}

// An existing session already has a tab to open; the text goes in after it
// paints, through the same bounded retry every other seeded composer uses. No
// turn is sent: the text is the user's to edit.
function openLinkedSession(sessionId, text) {
  openSession(sessionId)

  return seedSessionDraft(sessionId, text)
}

// ── styles ───────────────────────────────────────────────────────────────────
const CSS_TEXT = `
.pcc-col { animation: pcc-in 260ms cubic-bezier(0.22, 1, 0.36, 1) both; animation-delay: calc(min(var(--pcc-i, 0), 8) * 28ms); }
@keyframes pcc-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .pcc-col { animation: none !important; }
}
.pcc-scroller { scrollbar-width: thin; scroll-snap-type: x proximity; }
.pcc-col { scroll-snap-align: start; }
.pcc-card { transition: background-color 120ms ease, border-color 120ms ease; }
.pcc-card:hover, .pcc-card:focus-visible { background: var(--chrome-action-hover); border-color: var(--ui-stroke-secondary); outline: none; }
.pcc-link { transition: color 120ms ease; }
.pcc-link:hover, .pcc-link:focus-visible { color: var(--ui-accent); outline: none; }
.pcc-more:hover, .pcc-more:focus-visible { color: var(--ui-text-primary); background: var(--chrome-action-hover); outline: none; }
.pcc-live-row:hover, .pcc-live-row:focus-visible { background: var(--chrome-action-hover); outline: none; }
.pcc-status-btn:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: 2px; }
.pcc-crumb { transition: color 120ms ease; }
.pcc-crumb:hover, .pcc-crumb:focus-visible { color: var(--ui-text-primary); outline: none; }
.pcc-detail-row { transition: background-color 120ms ease; }
.pcc-detail-row:hover, .pcc-detail-row:focus-visible { background: var(--chrome-action-hover); outline: none; }
.pcc-gh-row + .pcc-gh-row { border-top: 1px solid color-mix(in srgb, var(--ui-stroke-secondary) 30%, transparent); }
.pcc-gh-row:hover { background: color-mix(in srgb, var(--chrome-action-hover) 70%, transparent); }
.pcc-gh-reaction { transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease; }
.pcc-gh-reaction:hover:not(:disabled), .pcc-gh-reaction:focus-visible { border-color: var(--ui-stroke-secondary); color: var(--ui-text-primary); outline: none; }
.pcc-gh-reaction:disabled { opacity: 0.55; cursor: default; }
.pcc-gh-reaction-add:hover:not(:disabled) { color: var(--ui-text-primary); }
.pcc-gh-title:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: 2px; border-radius: 3px; }
.pcc-gh-chip { transition: color 120ms ease, background-color 120ms ease; }
.pcc-gh-chip:hover, .pcc-gh-chip:focus-visible { color: var(--ui-text-primary); background: var(--chrome-action-hover); outline: none; }
.pcc-gh-ref { transition: color 120ms ease, background-color 120ms ease; }
.pcc-gh-ref:hover, .pcc-gh-ref:focus-visible { color: var(--ui-text-primary); background: color-mix(in srgb, var(--ui-stroke-secondary) 65%, transparent); outline: 1px solid var(--ui-accent); outline-offset: 1px; }
.pcc-gh-back:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: 2px; }
.pcc-branch-menu { opacity: 0.5; transition: opacity 120ms ease; }
.pcc-gh-row:hover .pcc-branch-menu, .pcc-branch-menu:focus-visible, .pcc-branch-menu[data-state="open"] { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .pcc-branch-menu { transition: none; } }
.pcc-gh-sub-btn:hover, .pcc-gh-sub-btn:focus-visible { background: var(--chrome-action-hover); outline: none; }
.pcc-gh-linkbtn:hover, .pcc-gh-linkbtn:focus-visible { color: var(--ui-text-secondary); outline: none; }
@keyframes pcc-gh-flash { from { background: color-mix(in srgb, var(--ui-accent) 14%, transparent); } to { background: transparent; } }
.pcc-gh-focus { animation: pcc-gh-flash 1400ms ease-out 1 both; }
@media (prefers-reduced-motion: reduce) { .pcc-gh-focus { animation: none !important; } }
.pcc-gh-error > div:first-child { gap: 6px; }
.pcc-graph-row { border: 0; background: transparent; transition: background-color 100ms ease; }
.pcc-graph-row:hover { background: color-mix(in srgb, var(--chrome-action-hover) 70%, transparent); }
.pcc-graph-row:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: -2px; }
.pcc-graph-scroll { scrollbar-width: thin; }
.pcc-diff-scroll { scrollbar-width: thin; }
.pcc-kcard { transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease; }
.pcc-kcard:hover, .pcc-kcard:focus-visible { background: var(--chrome-action-hover); border-color: var(--ui-stroke-secondary); outline: none; }
.pcc-kcard[data-dragging="true"] { opacity: 0.5; }
.pcc-kcol[data-drop="true"] { border-color: var(--ui-accent); background: color-mix(in srgb, var(--ui-accent) 6%, transparent); }
.pcc-kempty { border: 1px dashed color-mix(in srgb, var(--ui-stroke-secondary) 70%, transparent); border-radius: 8px; padding: 10px; font-size: 0.6875rem; color: var(--ui-text-quaternary); text-align: center; }
.pcc-ktable th { text-align: left; font-weight: 500; font-size: 0.6875rem; color: var(--ui-text-quaternary); padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, var(--ui-stroke-secondary) 70%, transparent); position: sticky; top: 0; background: var(--ui-bg-elevated); }
.pcc-ktable td { padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, var(--ui-stroke-secondary) 28%, transparent); vertical-align: middle; }
.pcc-ktable tbody tr:hover { background: color-mix(in srgb, var(--chrome-action-hover) 70%, transparent); }
.pcc-ksort { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 0; }
.pcc-ksort:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: 2px; border-radius: 3px; }
`

const S = {
  page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px 10px', flex: 'none', flexWrap: 'wrap' },
  // The merged page renders the chosen view under one header: the view keeps
  // its own toolbar row, but not its own page frame or title.
  viewBody: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, minWidth: 0, overflow: 'hidden' },
  viewBar: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 20px 10px', flex: 'none', flexWrap: 'wrap' },
  viewSwitch: { display: 'inline-flex', flex: 'none' },
  groupList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '0 20px 16px',
    overflow: 'auto',
    flex: '1 1 0',
    minHeight: 0
  },
  panelBoard: { display: 'flex', flex: '1 1 0', minHeight: 240, maxHeight: 520, minWidth: 0 },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  titleIcon: { color: 'var(--ui-text-secondary)', flex: 'none' },
  title: { margin: 0, fontSize: '1rem', fontWeight: 600, color: 'var(--ui-text-primary)', lineHeight: 1.2 },
  count: { fontSize: '0.75rem', color: 'var(--ui-text-quaternary)', fontVariantNumeric: 'tabular-nums' },
  grow: { flex: '1 1 0', minWidth: 0 },
  searchWrap: { width: 300, maxWidth: '100%', flex: '0 1 300px' },
  boardWrap: { position: 'relative', flex: '1 1 0', minHeight: 0, display: 'flex' },
  scroller: {
    display: 'flex',
    gap: COLUMN_GAP,
    alignItems: 'stretch',
    overflowX: 'auto',
    overflowY: 'hidden',
    padding: '4px 20px 12px',
    width: '100%',
    height: '100%',
    boxSizing: 'border-box'
  },
  column: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    width: COLUMN_WIDTH,
    flex: `0 0 ${COLUMN_WIDTH}px`,
    minHeight: 0,
    borderRadius: 12,
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 70%, transparent)',
    background: 'color-mix(in srgb, var(--ui-bg-elevated) 55%, transparent)',
    overflow: 'hidden'
  },
  colHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '12px 14px 10px',
    borderBottom: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 70%, transparent)',
    background: 'color-mix(in srgb, var(--ui-bg-elevated) 90%, transparent)',
    flex: 'none'
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  nameBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    flex: '1 1 0',
    padding: 0,
    border: 0,
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    color: 'var(--ui-text-primary)'
  },
  name: { fontSize: '0.875rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  path: { fontSize: '0.6875rem', color: 'var(--ui-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, display: 'block' },
  metrics: { display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.6875rem', color: 'var(--ui-text-secondary)', minWidth: 0, flexWrap: 'wrap' },
  metricMono: { fontVariantNumeric: 'tabular-nums', color: 'var(--ui-text-secondary)' },
  // The identifier row under the path: icon + number pairs, no words. Same size and
  // muted tone as the chips; the pair is borderless so a column header stays sleek.
  idRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, minWidth: 0, flexWrap: 'wrap' },
  idPair: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    fontSize: '0.6875rem',
    lineHeight: 1.4,
    color: 'var(--ui-text-secondary)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap'
  },
  body: { display: 'flex', flexDirection: 'column', gap: 6, padding: 8 },
  card: {
    position: 'relative',
    overflow: 'hidden',
    '--arc-radius': '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    width: '100%',
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 55%, transparent)',
    background: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    color: 'var(--ui-text-primary)',
    minWidth: 0
  },
  cardTitle: {
    fontSize: '0.75rem',
    lineHeight: 1.35,
    fontWeight: 500,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    wordBreak: 'break-word',
    minWidth: 0
  },
  cardMeta: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.6875rem', color: 'var(--ui-text-quaternary)', minWidth: 0 },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    maxWidth: 150,
    padding: '1px 6px',
    borderRadius: 999,
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 70%, transparent)',
    color: 'var(--ui-text-secondary)',
    fontSize: '0.6875rem',
    lineHeight: 1.4,
    minWidth: 0
  },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  // The session lane badge: one 16px line box, so it sits inside a title line
  // whose own line-height already clears 16px and never grows the row it is in.
  laneBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    flex: 'none',
    height: 16,
    padding: '0 6px',
    borderRadius: 999,
    background: 'color-mix(in srgb, var(--ui-stroke-secondary) 22%, transparent)',
    color: 'var(--ui-text-secondary)',
    fontSize: '0.625rem',
    fontWeight: 500,
    lineHeight: 1,
    whiteSpace: 'nowrap'
  },
  laneDot: { width: 5, height: 5, borderRadius: 999, flex: 'none', background: 'var(--ui-text-quaternary)' },
  more: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '5px 8px',
    border: 0,
    borderRadius: 8,
    background: 'transparent',
    color: 'var(--ui-text-tertiary)',
    fontSize: '0.6875rem',
    cursor: 'pointer'
  },
  quiet: { fontSize: '0.75rem', color: 'var(--ui-text-quaternary)', padding: '10px 8px', textAlign: 'center' },
  strip: { flex: 'none', padding: '0 20px 14px', display: 'flex', flexDirection: 'column', gap: 6 },
  stripHead: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 10 },
  stripTitle: { fontSize: '0.75rem', fontWeight: 600, color: 'var(--ui-text-secondary)', letterSpacing: '0.02em' },
  stripList: { display: 'flex', flexDirection: 'column', maxHeight: 156, overflowY: 'auto' },
  liveRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '5px 8px',
    border: 0,
    borderRadius: 6,
    background: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    color: 'var(--ui-text-primary)',
    fontSize: '0.75rem',
    minWidth: 0
  },
  edge: { position: 'absolute', top: 4, bottom: 12, width: 28, pointerEvents: 'none', zIndex: 2 },
  edgeBtn: { position: 'absolute', top: '50%', transform: 'translateY(-50%)', zIndex: 3, borderRadius: 999 },
  crumbs: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '12px 20px 0',
    flex: 'none',
    fontSize: '0.75rem',
    color: 'var(--ui-text-quaternary)'
  },
  crumbBtn: {
    border: 0,
    padding: 0,
    background: 'transparent',
    color: 'var(--ui-text-tertiary)',
    fontSize: 'inherit',
    cursor: 'pointer'
  },
  detailHead: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px 12px', flex: 'none', flexWrap: 'wrap' },
  detailTitle: {
    margin: 0,
    fontSize: '1.25rem',
    fontWeight: 600,
    lineHeight: 1.15,
    color: 'var(--ui-text-primary)',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  detailBody: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    scrollbarWidth: 'thin',
    padding: '0 20px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16
  },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))',
    gap: 1,
    borderRadius: 10,
    overflow: 'hidden',
    // A flex child shrinks to nothing before its parent scrolls, and this grid's
    // overflow:hidden lets that shrink collapse it. Pin its height so a long tab
    // list scrolls underneath instead of eating the summary block.
    flex: 'none',
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 70%, transparent)',
    background: 'color-mix(in srgb, var(--ui-stroke-secondary) 70%, transparent)'
  },
  statCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
    padding: '10px 14px',
    background: 'var(--ui-bg-elevated)'
  },
  lane: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    borderRadius: 10,
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 55%, transparent)',
    overflow: 'hidden'
  },
  laneHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    padding: '8px 12px',
    background: 'color-mix(in srgb, var(--ui-bg-elevated) 70%, transparent)',
    fontSize: '0.75rem',
    color: 'var(--ui-text-secondary)'
  },
  laneRow: {
    position: 'relative',
    overflow: 'hidden',
    '--arc-radius': '0',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    width: '100%',
    minWidth: 0,
    padding: '8px 12px',
    border: 0,
    borderTop: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 35%, transparent)',
    background: 'transparent',
    textAlign: 'left',
    color: 'var(--ui-text-primary)',
    cursor: 'pointer'
  },
  laneRowTitle: { fontSize: '0.8125rem', lineHeight: 1.35, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  laneRowMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    fontSize: '0.6875rem',
    color: 'var(--ui-text-quaternary)',
    minWidth: 0
  },
  laneQuiet: { padding: '8px 12px', fontSize: '0.75rem', color: 'var(--ui-text-quaternary)' },
  // The GitHub surface: one accent at most per row, separators between rows and
  // nothing else. Everything here is small type over tabular numerals.
  ghSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    minWidth: 0,
    paddingTop: 12,
    borderTop: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 45%, transparent)'
  },
  ghHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
  ghToolbar: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 0 2px', minWidth: 0 },
  // The status filter row: text-only toggles, one size down from the tab strip,
  // colour only on the ones that are on.
  ghFilters: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '4px 0 2px', minWidth: 0 },
  ghFilterBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 18,
    padding: '0 6px',
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 55%, transparent)',
    borderRadius: 4,
    background: 'transparent',
    color: 'var(--ui-text-quaternary)',
    fontSize: '0.625rem',
    lineHeight: 1,
    cursor: 'pointer'
  },
  ghFilterOn: {
    background: 'color-mix(in srgb, currentColor 14%, transparent)',
    border: '1px solid color-mix(in srgb, currentColor 45%, transparent)',
    fontWeight: 600
  },
  ghFilterCount: {
    fontSize: '0.625rem',
    color: 'var(--ui-text-quaternary)',
    fontVariantNumeric: 'tabular-nums'
  },
  ghTotals: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    fontSize: '0.6875rem',
    color: 'var(--ui-text-quaternary)',
    fontVariantNumeric: 'tabular-nums'
  },
  ghTotal: { display: 'inline-flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap' },
  ghTotalValue: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: 'var(--ui-text-secondary)',
    fontVariantNumeric: 'tabular-nums'
  },
  ghList: { display: 'flex', flexDirection: 'column', minWidth: 0, paddingTop: 4 },
  ghRow: {
    position: 'relative',
    overflow: 'hidden',
    '--arc-radius': '0',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
    padding: '7px 4px 7px 4px'
  },
  ghLine: { display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 },
  ghTitleBtn: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 7,
    flex: '1 1 0',
    minWidth: 0,
    padding: 0,
    border: 0,
    borderRadius: 3,
    background: 'transparent',
    color: 'var(--ui-text-primary)',
    textAlign: 'left',
    cursor: 'pointer',
    font: 'inherit'
  },
  ghTitle: {
    flex: '1 1 auto',
    minWidth: 0,
    fontSize: '0.75rem',
    lineHeight: 1.35,
    fontWeight: 500,
    color: 'var(--ui-text-primary)',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    wordBreak: 'break-word'
  },
  ghNum: {
    flex: 'none',
    fontSize: '0.6875rem',
    lineHeight: 1.6,
    color: 'var(--ui-text-quaternary)',
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)'
  },
  ghAge: {
    flex: 'none',
    fontSize: '0.6875rem',
    lineHeight: 1.6,
    color: 'var(--ui-text-quaternary)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap'
  },
  ghMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    minWidth: 0,
    paddingLeft: 21,
    fontSize: '0.6875rem',
    color: 'var(--ui-text-quaternary)'
  },
  ghChipBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    flex: 'none',
    height: 16,
    padding: '0 5px',
    border: 0,
    borderRadius: 3,
    background: 'color-mix(in srgb, var(--ui-stroke-secondary) 40%, transparent)',
    color: 'var(--ui-text-tertiary)',
    fontSize: '0.625rem',
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    cursor: 'pointer'
  },
  ghChipTag: {
    display: 'inline-flex',
    alignItems: 'center',
    flex: 'none',
    height: 16,
    padding: '0 5px',
    borderRadius: 3,
    background: 'color-mix(in srgb, var(--ui-stroke-secondary) 30%, transparent)',
    color: 'var(--ui-text-quaternary)',
    fontSize: '0.625rem',
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)'
  },
  ghLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    maxWidth: 110,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '0 5px',
    borderRadius: 3,
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 55%, transparent)',
    color: 'var(--ui-text-tertiary)',
    fontSize: '0.625rem',
    lineHeight: '14px'
  },
  ghInitials: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    flex: 'none',
    borderRadius: 999,
    background: 'color-mix(in srgb, var(--ui-stroke-secondary) 45%, transparent)',
    color: 'var(--ui-text-tertiary)',
    fontSize: '0.5625rem',
    fontWeight: 600,
    letterSpacing: '0.02em'
  },
  ghTiny: { fontSize: '0.625rem', color: 'var(--ui-text-quaternary)' },
  ghBranchName: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.75rem',
    fontWeight: 500,
    color: 'var(--ui-text-primary)',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)'
  },
  ghCurrent: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    flex: 'none',
    fontSize: '0.5625rem',
    lineHeight: 1,
    letterSpacing: '0.02em',
    color: 'var(--ui-text-tertiary)'
  },
  ghCurrentDot: { width: 5, height: 5, borderRadius: 999, background: 'var(--ui-accent)' },
  ghSessionBtn: {
    flex: 'none',
    height: 20,
    padding: '0 4px',
    gap: 3,
    fontSize: '0.6875rem',
    color: 'var(--ui-text-tertiary)'
  },
  ghSubject: {
    flex: '0 1 320px',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--ui-text-quaternary)'
  },
  ghSubBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    minWidth: 0,
    padding: '3px 4px 3px 21px',
    border: 0,
    borderRadius: 3,
    background: 'transparent',
    color: 'var(--ui-text-primary)',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: '0.6875rem'
  },
  ghSubTitle: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--ui-text-secondary)'
  },
  // Issue/PR chips on a board column header, sourced from /board's link rows.
  boardChips: { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, flexWrap: 'wrap' },
  ghFiles: { display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 },
  ghFile: {
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '0 4px',
    borderRadius: 3,
    background: 'color-mix(in srgb, var(--ui-stroke-secondary) 28%, transparent)',
    color: 'var(--ui-text-tertiary)',
    fontSize: '0.625rem',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)'
  },
  // ── detail modal ───────────────────────────────────────────────────────────
  // Same vocabulary as the rows, one step roomier: the dialog already supplies
  // the surface, the padding and the scroll, so these only lay out content.
  ghModalHead: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, textAlign: 'left' },
  ghModalTitleRow: { display: 'flex', alignItems: 'flex-start', gap: 7, minWidth: 0 },
  ghModalNum: {
    flex: 'none',
    fontSize: '0.75rem',
    lineHeight: 1.5,
    color: 'var(--ui-text-quaternary)',
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)'
  },
  ghModalTitle: {
    flex: '1 1 0',
    minWidth: 0,
    fontSize: '0.875rem',
    fontWeight: 600,
    lineHeight: 1.35,
    color: 'var(--ui-text-primary)',
    wordBreak: 'break-word'
  },
  ghModalMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    minWidth: 0,
    fontSize: '0.6875rem',
    color: 'var(--ui-text-tertiary)'
  },
  ghBackBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    width: 18,
    height: 18,
    padding: 0,
    border: 0,
    borderRadius: 4,
    background: 'transparent',
    color: 'var(--ui-text-secondary)',
    cursor: 'pointer'
  },
  ghActorRow: { display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none', minWidth: 0 },
  ghActor: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 500,
    color: 'var(--ui-text-secondary)'
  },
  ghDiff: { display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none', fontVariantNumeric: 'tabular-nums' },
  ghThread: { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 },
  ghSection: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
  ghSectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: '0.6875rem',
    fontWeight: 600,
    letterSpacing: '0.02em',
    color: 'var(--ui-text-tertiary)'
  },
  // MessageTextContent owns the prose; this only bounds and scales the box.
  ghProse: { minWidth: 0, fontSize: '0.8125rem' },
  ghComment: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
    padding: '8px 10px',
    borderRadius: 8,
    background: 'color-mix(in srgb, var(--ui-stroke-secondary) 16%, transparent)'
  },
  ghCommentHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    minWidth: 0,
    fontSize: '0.6875rem',
    color: 'var(--ui-text-tertiary)'
  },
  // The reaction row: one line of chips at the modal's width, wrapping only when
  // a thread carries more than the five the row draws.
  ghReactions: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 },
  ghReactionChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 20,
    padding: '0 6px',
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 60%, transparent)',
    borderRadius: 999,
    background: 'transparent',
    color: 'var(--ui-text-secondary)',
    font: 'inherit',
    fontSize: '0.6875rem',
    lineHeight: 1,
    cursor: 'pointer'
  },
  ghReactionMine: {
    borderColor: 'color-mix(in srgb, var(--ui-accent) 55%, transparent)',
    background: 'color-mix(in srgb, var(--ui-accent) 14%, transparent)',
    color: 'var(--ui-text-primary)'
  },
  ghReactionGlyph: {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.625rem',
    lineHeight: 1,
    letterSpacing: '-0.02em'
  },
  ghReactionAdd: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    padding: 0,
    border: '1px dashed color-mix(in srgb, var(--ui-stroke-secondary) 70%, transparent)',
    borderRadius: 999,
    background: 'transparent',
    color: 'var(--ui-text-quaternary)',
    font: 'inherit',
    fontSize: '0.75rem',
    lineHeight: 1,
    cursor: 'pointer'
  },
  ghLinkGroup: {
    padding: '6px 8px 2px',
    fontSize: '0.625rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--ui-text-quaternary)'
  },
  ghLinkRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, width: '100%' },
  ghLinkText: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  ghLinkTitle: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  ghLinkEmpty: { padding: '2px 8px 6px', fontSize: '0.75rem', color: 'var(--ui-text-quaternary)' },
  ghComposer: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minWidth: 0,
    paddingTop: 10,
    borderTop: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 45%, transparent)'
  },
  ghComposerRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
  ghComposerError: { fontSize: '0.75rem', lineHeight: 1.45, color: 'var(--dt-destructive)' },
  branchField: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
  branchLabel: { fontSize: '0.6875rem', fontWeight: 600, letterSpacing: '0.02em', color: 'var(--ui-text-tertiary)' },
  branchInput: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    border: '1px solid var(--ui-stroke-secondary)',
    borderRadius: 5,
    outline: 'none',
    background: 'var(--ui-bg-primary)',
    color: 'var(--ui-text-primary)',
    font: 'inherit',
    fontSize: '0.8125rem'
  },
  branchNote: { fontSize: '0.75rem', lineHeight: 1.45, color: 'var(--ui-text-quaternary)' },
  branchError: { fontSize: '0.75rem', lineHeight: 1.45, color: 'var(--dt-destructive)' },
  branchActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingTop: 4 },
  ghRefChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    maxWidth: 280,
    padding: '0 4px',
    border: 0,
    borderRadius: 3,
    background: 'color-mix(in srgb, var(--ui-stroke-secondary) 40%, transparent)',
    color: 'var(--ui-text-secondary)',
    lineHeight: 1.4,
    verticalAlign: 'baseline',
    cursor: 'pointer',
    font: 'inherit'
  },
  ghRefText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  ghPop: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, fontSize: '0.75rem', color: 'var(--ui-text-secondary)' },
  ghPopHead: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, color: 'var(--ui-text-tertiary)' },
  ghPopKind: { textTransform: 'capitalize' },
  ghPopNum: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontVariantNumeric: 'tabular-nums' },
  ghPopTitle: { fontWeight: 600, color: 'var(--ui-text-primary)', wordBreak: 'break-word' },
  ghPopMeta: { display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: '0.6875rem', color: 'var(--ui-text-quaternary)' },
  ghPopBody: { color: 'var(--ui-text-tertiary)', lineHeight: 1.45, wordBreak: 'break-word' },
  ghGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 0 3px',
    fontSize: '0.6875rem',
    fontWeight: 600,
    letterSpacing: '0.02em',
    color: 'var(--ui-text-tertiary)'
  },
  ghQuiet: { padding: '8px 0', fontSize: '0.75rem', color: 'var(--ui-text-quaternary)' },
  ghErrorWrap: { display: 'flex', justifyContent: 'center', padding: '16px 0 8px' },
  // The diagnose panel is inline and quiet: key/value rows in small type, no
  // card chrome beyond one hairline.
  ghDiag: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    margin: '2px 0 8px',
    padding: '8px 10px',
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 45%, transparent)',
    borderRadius: 6,
    fontSize: '0.6875rem',
    minWidth: 0
  },
  ghDiagHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    paddingBottom: 4,
    fontWeight: 600,
    color: 'var(--ui-text-tertiary)'
  },
  ghDiagRow: {
    display: 'grid',
    gridTemplateColumns: '128px minmax(0, 1fr)',
    gap: 10,
    alignItems: 'baseline',
    minWidth: 0
  },
  ghDiagKey: { color: 'var(--ui-text-quaternary)' },
  ghDiagValue: {
    color: 'var(--ui-text-secondary)',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.625rem',
    overflowWrap: 'anywhere'
  },
  ghDiagNote: { color: 'var(--ui-text-quaternary)', lineHeight: 1.5, paddingTop: 3 },
  ghLinkBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: 0,
    border: 0,
    background: 'transparent',
    color: 'var(--ui-text-quaternary)',
    fontSize: '0.75rem',
    cursor: 'pointer'
  },
  ghRepoBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxWidth: 260,
    padding: '1px 6px',
    border: 0,
    borderRadius: 999,
    background: 'color-mix(in srgb, var(--ui-stroke-secondary) 35%, transparent)',
    color: 'var(--ui-text-tertiary)',
    fontSize: '0.6875rem',
    lineHeight: 1.5,
    cursor: 'pointer'
  },
  ghRepoText: {
    maxWidth: 260,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.6875rem',
    color: 'var(--ui-text-tertiary)'
  },
  // The graph: fixed pixel rows over one SVG, so a lane crossing the 200th row
  // still lands on the centre of its dot. Nothing here draws a border.
  graphWrap: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  graphScroll: { maxHeight: 520, overflow: 'auto', position: 'relative', minWidth: 0 },
  graphHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    height: 22,
    flex: 'none',
    background: 'var(--ui-bg-editor)',
    borderBottom: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 35%, transparent)',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.625rem',
    color: 'var(--ui-text-quaternary)'
  },
  graphHeadCell: { flex: 'none', paddingLeft: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  graphRows: { position: 'relative', minWidth: 0 },
  graphRowShape: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    height: 26,
    flex: 'none',
    width: '100%',
    minWidth: 0,
    padding: 0,
    font: 'inherit',
    textAlign: 'left',
    color: 'inherit',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden'
  },
  graphGutter: {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    paddingRight: 2,
    minWidth: 0,
    overflow: 'hidden'
  },
  graphLanes: { flex: 'none' },
  graphSubject: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.75rem',
    color: 'var(--ui-text-primary)'
  },
  graphDate: {
    flex: 'none',
    // 86 keeps `Sep 30, 2026` (the year fallback for old commits) inside the
    // column at 0.6875rem with the 8px right padding.
    width: 86,
    paddingRight: 8,
    textAlign: 'right',
    fontSize: '0.6875rem',
    color: 'var(--ui-text-quaternary)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap'
  },
  graphAuthor: {
    flex: 'none',
    width: 120,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
    overflow: 'hidden',
    fontSize: '0.6875rem',
    color: 'var(--ui-text-tertiary)'
  },
  graphAuthorName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  graphHash: {
    flex: 'none',
    width: 62,
    textAlign: 'right',
    fontSize: '0.6875rem',
    color: 'var(--ui-text-quaternary)',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontVariantNumeric: 'tabular-nums'
  },
  graphPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    flex: 'none',
    height: 16,
    maxWidth: 140,
    padding: '0 6px',
    border: '1px solid',
    borderRadius: 999,
    background: 'transparent',
    fontSize: '0.6875rem',
    lineHeight: 1,
    minWidth: 0
  },
  graphPillText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  graphBadge: { flex: 'none', fontSize: '0.625rem', fontVariantNumeric: 'tabular-nums', lineHeight: 1 },
  graphNote: { padding: '6px 2px', fontSize: '0.6875rem', color: 'var(--ui-text-quaternary)' },
  // Diff: three columns per line, theme tints per op, one scroll box per file.
  diffFileHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    minWidth: 0,
    height: 24,
    padding: '0 4px',
    border: 0,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer'
  },
  diffStatus: {
    flex: 'none',
    width: 12,
    textAlign: 'center',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.6875rem',
    fontWeight: 600
  },
  diffPath: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.6875rem',
    color: 'var(--ui-text-secondary)'
  },
  diffCount: {
    flex: 'none',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.625rem',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap'
  },
  diffBox: {
    margin: '0 0 6px 18px',
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 40%, transparent)',
    borderRadius: 4,
    overflow: 'hidden'
  },
  diffScroll: { maxHeight: 360, overflow: 'auto' },
  diffHunk: {
    padding: '2px 8px',
    background: 'color-mix(in srgb, var(--ui-bg-quaternary) 55%, transparent)',
    color: 'var(--ui-text-quaternary)',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.6875rem',
    whiteSpace: 'pre'
  },
  diffLine: {
    display: 'grid',
    gridTemplateColumns: '40px 40px 1fr',
    width: 'max-content',
    minWidth: '100%',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.75rem',
    lineHeight: '18px',
    whiteSpace: 'pre'
  },
  diffNo: {
    paddingRight: 8,
    textAlign: 'right',
    color: 'var(--ui-text-quaternary)',
    fontVariantNumeric: 'tabular-nums',
    userSelect: 'none'
  },
  diffText: { paddingRight: 12, paddingLeft: 8 },
  // ── session kanban ─────────────────────────────────────────────────────
  filters: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 20px 10px', flex: 'none', flexWrap: 'wrap' },
  select: {
    height: 28,
    padding: '0 8px',
    borderRadius: 8,
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 70%, transparent)',
    background: 'color-mix(in srgb, var(--ui-bg-elevated) 80%, transparent)',
    color: 'var(--ui-text-secondary)',
    fontSize: '0.75rem',
    maxWidth: 220
  },
  kcolBody: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: '8px 10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    borderRadius: '0 0 12px 12px'
  },
  kcard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 55%, transparent)',
    background: 'transparent',
    color: 'var(--ui-text-primary)',
    minWidth: 0,
    cursor: 'grab'
  },
  kcardHead: { display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 },
  kcardTitle: {
    flex: '1 1 0',
    fontSize: '0.75rem',
    lineHeight: 1.35,
    fontWeight: 500,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    wordBreak: 'break-word',
    minWidth: 0
  },
  kdot: { width: 7, height: 7, borderRadius: 999, flex: 'none', marginTop: 5 },
  kcardMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    fontSize: '0.6875rem',
    color: 'var(--ui-text-quaternary)',
    minWidth: 0
  },
  kmenuBtn: {
    border: 0,
    background: 'transparent',
    color: 'var(--ui-text-quaternary)',
    cursor: 'pointer',
    borderRadius: 4,
    padding: 2,
    display: 'inline-flex',
    flex: 'none'
  },
  kmenuHead: { padding: '4px 8px', fontSize: '0.6875rem', color: 'var(--ui-text-quaternary)' },
  kmenuNote: { padding: '4px 8px', fontSize: '0.6875rem', color: 'var(--ui-text-quaternary)', maxWidth: 240, lineHeight: 1.4 },
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    margin: '0 20px 10px',
    padding: '6px 10px',
    borderRadius: 8,
    fontSize: '0.75rem',
    color: 'var(--ui-text-secondary)',
    background: 'color-mix(in srgb, var(--ui-purple) 10%, transparent)',
    border: '1px solid color-mix(in srgb, var(--ui-purple) 35%, transparent)'
  },
  lanesPop: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 250 },
  laneCol: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  laneError: { fontSize: '0.6875rem', lineHeight: 1.4, color: 'var(--ui-red)', padding: '2px 2px 0' },
  laneRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  laneInput: {
    flex: '1 1 0',
    minWidth: 0,
    height: 26,
    padding: '0 7px',
    borderRadius: 6,
    border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 70%, transparent)',
    background: 'transparent',
    color: 'var(--ui-text-primary)',
    fontSize: '0.75rem'
  },
  ktableWrap: { flex: '1 1 0', minHeight: 0, overflow: 'auto', margin: '0 20px 12px', border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 55%, transparent)', borderRadius: 10 },
  ktable: { borderCollapse: 'collapse', width: '100%', fontSize: '0.75rem', color: 'var(--ui-text-secondary)' }
}

// ── small pieces ─────────────────────────────────────────────────────────────

// The best mark the backend can find for a project folder, asked once per folder
// and shared between every card that shows it. The stack keys are the backend's
// contract; the glyph names live here so a wrong name can never break a render.
const STACK_GLYPH = {
  laravel: 'server-process',
  nuxt: 'package',
  node: 'package',
  python: 'beaker',
  rust: 'gear',
  go: 'rocket',
  nix: 'file-code',
  obsidian: 'book',
  docker: 'layers',
  docs: 'book',
  git: 'git-branch'
}

function useProjectIcon(folder) {
  const query = useQuery({
    enabled: Boolean(folder),
    queryFn: () => ghRest(`/icon?path=${encodeURIComponent(folder)}`).catch(() => null),
    queryKey: [QUERY_ROOT, 'icon', folder],
    retry: false,
    staleTime: 300000
  })

  return query.data && query.data.ok ? query.data : null
}

// Layered: the project's own image, then the glyph for what the project is, then
// the initial block. A loading icon keeps the initial so nothing flashes empty.
function Avatar({ project, size = 24 }) {
  const color = validColor(project.color)
  const initial = (String(project.label || '?').trim()[0] || '?').toUpperCase()
  const icon = useProjectIcon(primaryPath(project))
  const box = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    width: size,
    height: size,
    borderRadius: 7,
    overflow: 'hidden'
  }

  if (icon && icon.kind === 'image' && icon.data_url) {
    return jsx('span', {
      'aria-hidden': 'true',
      style: { ...box, background: 'var(--ui-bg-quaternary)', border: '1px solid var(--ui-stroke-secondary)' },
      children: jsx('img', {
        alt: '',
        decoding: 'async',
        src: icon.data_url,
        style: { height: '100%', width: '100%', objectFit: 'contain' }
      })
    })
  }

  const glyph = icon && icon.kind === 'glyph' ? STACK_GLYPH[String(icon.stack || '')] : ''

  if (glyph) {
    return jsx('span', {
      'aria-hidden': 'true',
      style: { ...box, color: color || 'var(--ui-text-secondary)' },
      children: jsx(Codicon, { name: glyph, size: `${Math.round(size * 0.64)}px` })
    })
  }

  return jsx('span', {
    'aria-hidden': 'true',
    style: {
      ...box,
      fontSize: size * 0.46,
      fontWeight: 600,
      color: 'var(--ui-text-primary)',
      background: color ? `color-mix(in srgb, ${color} 26%, transparent)` : 'var(--ui-bg-quaternary)',
      border: `1px solid ${color ? `color-mix(in srgb, ${color} 60%, transparent)` : 'var(--ui-stroke-secondary)'}`
    },
    children: initial
  })
}

function BranchChip({ branch, title }) {
  return jsxs('span', {
    style: S.chip,
    title,
    children: [
      jsx(Codicon, { name: 'git-branch', size: '0.75rem', style: { flex: 'none' } }),
      jsx('span', { style: S.ellipsis, children: branch })
    ]
  })
}

function PathLine({ path, inside }) {
  if (!path) return null
  // A vault subfolder resolves to a bigger work tree. Naming that root next to
  // the path stops the page from looking like it read the wrong repository.
  const rootName = inside ? String(inside).split('/').filter(Boolean).pop() : ''

  return jsxs('span', {
    style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 },
    children: [
      jsx(Tip, { label: path, children: jsx('span', { style: S.path, children: middleTruncate(path) }) }),
      rootName
        ? jsx(Tip, {
            label: `This folder is inside the work tree at ${inside}`,
            children: jsx('span', { style: S.ghChipTag, children: `inside ${rootName}` })
          })
        : null
    ]
  })
}

// The app's own running-session ring (apps/desktop/src/app/chat/sidebar/
// session-row.tsx renders the same span). `.arc-border` carries the travelling
// gradient, the theme vars and the reduced-motion pause in the renderer's global
// stylesheet, so nothing is redeclared here; the host only has to be
// `position: relative` and own a radius.
function ArcRing({ radius, zIndex = 0 }) {
  return jsx('span', {
    'aria-hidden': 'true',
    className: 'arc-border arc-row',
    style: { '--arc-radius': radius, zIndex }
  })
}

// Arc and dot never disagree: both read the same resolved state.
function LiveDot({ state }) {
  if (!state || state === 'idle') return null

  return jsx(Tip, {
    label: LIVE_LABELS[state] || 'Live',
    children: jsx(StatusDot, { tone: liveTone(state) })
  })
}

// Read-only on purpose: the plugin owns no per-session status control, so the
// badge names the lane and where it came from instead of opening an editor.
function LaneBadge({ lane, lanes }) {
  if (!lane) return null
  const label = laneLabel(lane.lane, lanes)

  if (!label) return null
  const title = sessionLaneTitle(lane)

  return jsx(Tip, {
    label: title,
    children: jsxs('span', {
      'aria-label': title,
      className: 'pcc-lane',
      style: S.laneBadge,
      children: [
        jsx('span', { 'aria-hidden': 'true', style: { ...S.laneDot, background: laneColor(lane.lane, lanes) } }),
        label
      ]
    })
  })
}

function StatusPicker({ projectId, status }) {
  const current = STATUS_BY_ID[status] || STATUS_BY_ID[DEFAULT_STATUS]

  return jsxs(DropdownMenu, {
    children: [
      jsx(DropdownMenuTrigger, {
        asChild: true,
        children: jsx('button', {
          'aria-label': `Project status: ${current.label}. Change`,
          className: 'pcc-status-btn',
          style: { border: 0, padding: 0, background: 'transparent', cursor: 'pointer', borderRadius: 3, display: 'inline-flex' },
          type: 'button',
          children: jsxs(Badge, {
            variant: current.variant,
            children: [current.label, jsx(Codicon, { name: 'chevron-down', size: '0.625rem' })]
          })
        })
      }),
      jsx(DropdownMenuContent, {
        align: 'start',
        children: STATUSES.map(s =>
          jsxs(
            DropdownMenuItem,
            {
              onSelect: () => writeStatus(projectId, s.id),
              children: [
                jsx(Codicon, { name: 'check', size: '0.75rem', style: { visibility: s.id === current.id ? 'visible' : 'hidden' } }),
                s.label
              ]
            },
            s.id
          )
        )
      })
    ]
  })
}

function SortPicker({ sort }) {
  const current = SORTS.find(s => s.id === sort) || SORTS[0]

  return jsxs(DropdownMenu, {
    children: [
      jsx(DropdownMenuTrigger, {
        asChild: true,
        children: jsxs(Button, {
          'aria-label': `Sort projects by ${current.label}. Change`,
          size: 'sm',
          variant: 'ghost',
          children: [
            jsx(Codicon, { name: 'list-ordered', size: '0.875rem' }),
            jsx('span', { children: current.label }),
            jsx(Codicon, { name: 'chevron-down', size: '0.625rem' })
          ]
        })
      }),
      jsx(DropdownMenuContent, {
        align: 'end',
        children: SORTS.map(s =>
          jsxs(
            DropdownMenuItem,
            {
              onSelect: () => writeSort(s.id),
              children: [
                jsx(Codicon, { name: 'check', size: '0.75rem', style: { visibility: s.id === current.id ? 'visible' : 'hidden' } }),
                jsx(Codicon, { name: s.icon, size: '0.75rem' }),
                s.label
              ]
            },
            s.id
          )
        )
      })
    ]
  })
}

function SessionCard({ session, state, showProject, onOpen, lane }) {
  const ms = sessionStamp(session)
  const model = shortModel(session.model)
  const running = RUNNING.has(state)

  return jsxs(RowButton, {
    className: 'pcc-card',
    onClick: () => onOpen(session.id),
    style: S.card,
    title: sessionTitle(session),
    children: [
      running ? jsx(ArcRing, { radius: '8px' }) : null,
      jsxs('span', {
        style: { display: 'flex', alignItems: 'flex-start', gap: 7, minWidth: 0 },
        children: [
          state && state !== 'idle' ? jsx('span', { style: { display: 'inline-flex', paddingTop: 5, flex: 'none' }, children: jsx(LiveDot, { state }) }) : null,
          jsx('span', { style: S.cardTitle, children: sessionTitle(session) }),
          lane ? jsx('span', { style: { display: 'inline-flex', flex: 'none', marginLeft: 'auto' }, children: jsx(LaneBadge, { lane }) }) : null
        ]
      }),
      jsxs('span', {
        style: S.cardMeta,
        children: [
          session.git_branch ? jsx(BranchChip, { branch: session.git_branch }) : null,
          showProject ? jsx('span', { style: S.ellipsis, children: showProject }) : null,
          ms ? jsx(Tip, { label: stampTip(ms), children: jsx('span', { children: ageText(ms) }) }) : null,
          model ? jsx('span', { style: { ...S.ellipsis, maxWidth: 120 }, children: model }) : null
        ]
      })
    ]
  })
}

function recentSessions(project) {
  const rows = [...(project.previewSessions || [])]

  rows.sort((a, b) => sessionStamp(b) - sessionStamp(a))

  return rows
}

// ── column ───────────────────────────────────────────────────────────────────

// What the board knows about a project beyond its sessions: the issues and pull
// requests a session was started from or linked to. Read-only tags — the detail
// page is where the rows themselves open.
function BoardLinkChips({ links }) {
  if (!links || (links.issues.length === 0 && links.prs.length === 0)) return null

  const rows = [
    ...links.prs.map(number => ({ key: `pr-${number}`, kind: 'pr', number })),
    ...links.issues.map(number => ({ key: `issue-${number}`, kind: 'issue', number }))
  ]
  const shown = rows.slice(0, 2)
  const rest = rows.length - shown.length

  return jsxs('span', {
    style: S.boardChips,
    children: [
      ...shown.map(row =>
        jsx(
          Tip,
          {
            label: `${row.kind === 'pr' ? 'Pull request' : 'Issue'} #${row.number}`,
            children: jsxs('span', {
              style: S.ghChipTag,
              children: [
                jsx(Codicon, { name: row.kind === 'pr' ? 'git-pull-request' : 'issues', size: '0.625rem' }),
                `#${row.number}`
              ]
            })
          },
          row.key
        )
      ),
      rest > 0 ? jsx('span', { style: { color: 'var(--ui-text-quaternary)' }, children: `+${rest}` }) : null
    ]
  })
}

const NO_COUNTS = {}
const NO_LINKS = []
const COUNTS_PATH_LIMIT = 50

// ONE batched read for the whole board: every project's folder, a single
// /github/counts call. A missing route, a failure or ok:false all collapse to an
// empty map, so a column simply has no identifier row. The backend caches too.
function useRepoCounts(projects) {
  const key = useMemo(() => {
    const seen = new Set()

    for (const p of projects || []) {
      const folder = primaryPath(p)

      if (folder) seen.add(folder)
      if (seen.size >= COUNTS_PATH_LIMIT) break
    }

    return Array.from(seen).join('\n')
  }, [projects])

  const query = useQuery({
    enabled: key !== '',
    queryFn: () =>
      ghRest(`/github/counts?${key.split('\n').map(p => `path=${encodeURIComponent(p)}`).join('&')}`).catch(() => null),
    queryKey: [QUERY_ROOT, 'gh-counts', key],
    refetchInterval: 60000,
    retry: false,
    staleTime: 60000
  })
  const data = query.data

  return data && data.ok && data.counts && typeof data.counts === 'object' ? data.counts : NO_COUNTS
}

function countOf(value) {
  const n = Number(value)

  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function idCount(n) {
  return n > 999 ? '999+' : String(n)
}

// Icon + number pairs: open issues, open PRs and, when there is room, the live
// sessions. A pair with 0 or an unknown count is left out; with nothing to show
// the whole row is null (live alone never makes a row, it only joins one).
function ProjectIdRow({ counts, liveCount }) {
  if (!counts) return null
  const pairs = [
    { icon: 'issues', label: 'open', noun: 'issue', value: countOf(counts.issues_open) },
    { icon: 'git-pull-request', label: 'open', noun: 'pull request', value: countOf(counts.prs_open) }
  ].filter(pair => pair.value > 0)

  if (pairs.length === 0) return null

  return jsxs('span', {
    style: S.idRow,
    children: [
      ...pairs.map(pair =>
        jsx(
          Tip,
          {
            label: `${pair.value} ${pair.label} ${pair.noun}${pair.value === 1 ? '' : 's'}`,
            children: jsxs('span', {
              style: S.idPair,
              children: [jsx(Codicon, { name: pair.icon, size: '0.75rem', style: { flex: 'none' } }), idCount(pair.value)]
            })
          },
          pair.icon
        )
      ),
      liveCount > 0
        ? jsx(Tip, {
            label: `${liveCount} live ${liveCount === 1 ? 'session' : 'sessions'}`,
            children: jsxs('span', { style: { ...S.idPair, color: 'var(--ui-accent)' }, children: [jsx(StatusDot, { tone: 'good' }), idCount(liveCount)] })
          })
        : null
    ]
  })
}

function ProjectColumn({ project, index, status, lane, linkRows, refs, liveByStored, onOpenProject, onOpenSession, links, counts }) {
  const recent = recentSessions(project)
  const shown = recent.slice(0, BOARD_CARD_LIMIT)
  const hidden = Math.max(0, (project.sessionCount || 0) - shown.length)
  const cost = formatCost(project.totalCostUsd)
  // The badge for every row in this column, and the header line, come from the
  // same resolver: explicit session status, then its PR, then the project lane.
  const rowLinks = useMemo(() => linksBySession(linkRows), [linkRows])
  const laneOf = useCallback(id => laneForLink(rowLinks.get(id), refs, lane), [rowLinks, refs, lane])
  const tally = useMemo(
    () => sessionLaneTally(project.sessionCount, linkRows, refs, lane),
    [project.sessionCount, linkRows, refs, lane]
  )
  const summary =
    sessionLaneSummary(project.sessionCount, tally, lane) ||
    `${project.sessionCount || 0} ${project.sessionCount === 1 ? 'session' : 'sessions'}`
  const liveCount = useMemo(() => {
    let n = 0

    for (const id of project.sessionIds || []) if (RUNNING.has(liveByStored.get(id))) n += 1

    return n
  }, [project.sessionIds, liveByStored])

  return jsxs('section', {
    'aria-label': project.label,
    className: 'pcc-col',
    style: { ...S.column, '--pcc-i': index },
    children: [
      liveCount > 0 ? jsx(ArcRing, { radius: '12px', zIndex: 2 }) : null,
      jsxs('header', {
        style: S.colHeader,
        children: [
          jsxs('div', {
            style: S.row,
            children: [
              jsxs('button', {
                className: 'pcc-link',
                onClick: () => onOpenProject(project.id),
                style: S.nameBtn,
                title: `Open ${project.label}`,
                type: 'button',
                children: [
                  jsx(Avatar, { project, size: 32 }),
                  jsxs('span', {
                    style: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1 },
                    children: [
                      jsx('span', { style: S.name, children: project.label }),
                      jsx(PathLine, { path: primaryPath(project) }),
                      jsx(ProjectIdRow, { counts, liveCount })
                    ]
                  })
                ]
              }),
              jsx(Tip, {
                label: 'Open project',
                children: jsx(Button, {
                  'aria-label': `Open ${project.label}`,
                  onClick: () => onOpenProject(project.id),
                  size: 'icon-xs',
                  variant: 'ghost',
                  children: jsx(Codicon, { name: 'chevron-right', size: '0.875rem' })
                })
              })
            ]
          }),
          jsxs('div', {
            style: S.metrics,
            children: [
              jsx(StatusPicker, { projectId: project.id, status }),
              jsx(BoardLinkChips, { links }),
              summary
                ? jsx(Tip, {
                    label: 'Sessions per lane, the whole project',
                    children: jsx('span', { style: S.metricMono, children: summary })
                  })
                : null,
              liveCount > 0
                ? jsxs('span', {
                    style: { display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--ui-accent)' },
                    children: [jsx(StatusDot, { tone: 'good' }), `${liveCount} live`]
                  })
                : null,
              jsx('span', { style: S.grow }),
              project.totalTokens > 0
                ? jsx(Tip, {
                    label: `${(project.totalTokens || 0).toLocaleString()} tokens`,
                    children: jsx('span', { style: S.metricMono, children: `${formatTokens(project.totalTokens)} tok` })
                  })
                : null,
              cost ? jsx('span', { style: S.metricMono, children: cost }) : null
            ]
          })
        ]
      }),
      jsx(ColumnBody, { project, shown, hidden, laneOf, liveByStored, onOpenProject, onOpenSession })
    ]
  })
}

function ColumnBody({ project, shown, hidden, laneOf, liveByStored, onOpenProject, onOpenSession }) {
  return jsx('div', {
    style: { flex: '1 1 0', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'thin' },
    children: jsxs('div', {
      style: S.body,
      children: [
        shown.length === 0
          ? jsx('div', { style: S.quiet, children: 'No sessions yet' })
          : shown.map(s =>
              jsx(
                SessionCard,
                { lane: laneOf(s.id), onOpen: onOpenSession, session: s, state: liveByStored.get(s.id) },
                s.id
              )
            ),
        hidden > 0
          ? jsxs('button', {
              className: 'pcc-more',
              onClick: () => onOpenProject(project.id),
              style: S.more,
              type: 'button',
              children: [`+${hidden} more`, jsx(Codicon, { name: 'arrow-right', size: '0.75rem' })]
            })
          : null
      ]
    })
  })
}

// ── board with edge affordances ──────────────────────────────────────────────

function Board({ count, children }) {
  const ref = useRef(null)
  const [edge, setEdge] = useState({ left: false, right: false })

  const update = useCallback(() => {
    const el = ref.current

    if (!el) return
    const left = el.scrollLeft > 2
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2

    setEdge(prev => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])

  useEffect(() => {
    update()
    const el = ref.current

    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(update)

    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)

    return () => ro.disconnect()
  }, [update, count])

  const scrollBy = dir => {
    const el = ref.current

    if (!el) return
    el.scrollBy({ left: dir * (COLUMN_WIDTH + COLUMN_GAP) * 1.5, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  const fade = side => ({
    ...S.edge,
    [side]: 0,
    background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, color-mix(in srgb, var(--ui-stroke-secondary) 60%, transparent), transparent)`
  })

  return jsxs('div', {
    style: S.boardWrap,
    children: [
      jsx('div', { className: 'pcc-scroller', onScroll: update, ref, style: S.scroller, children }),
      edge.left ? jsx('div', { 'aria-hidden': 'true', style: fade('left') }) : null,
      edge.right ? jsx('div', { 'aria-hidden': 'true', style: fade('right') }) : null,
      edge.left
        ? jsx(Button, {
            'aria-label': 'Scroll projects left',
            onClick: () => scrollBy(-1),
            size: 'icon-sm',
            style: { ...S.edgeBtn, left: 8 },
            variant: 'floating',
            children: jsx(Codicon, { name: 'chevron-left', size: '1rem' })
          })
        : null,
      edge.right
        ? jsx(Button, {
            'aria-label': 'Scroll projects right',
            onClick: () => scrollBy(1),
            size: 'icon-sm',
            style: { ...S.edgeBtn, right: 8 },
            variant: 'floating',
            children: jsx(Codicon, { name: 'chevron-right', size: '1rem' })
          })
        : null
    ]
  })
}

function BoardSkeleton() {
  return jsx('div', {
    style: S.boardWrap,
    children: jsx('div', {
      'aria-busy': 'true',
      style: S.scroller,
      children: [0, 1, 2].map(i =>
        jsxs(
          'div',
          {
            style: { ...S.column, padding: 14, gap: 10 },
            children: [
              jsx(Skeleton, { style: { height: 24, width: '60%' } }),
              jsx(Skeleton, { style: { height: 14, width: '80%' } }),
              jsx(Skeleton, { style: { height: 54 } }),
              jsx(Skeleton, { style: { height: 54 } }),
              jsx(Skeleton, { style: { height: 54 } })
            ]
          },
          i
        )
      )
    })
  })
}

// ── live strip ───────────────────────────────────────────────────────────────

function LiveStrip({ items, projectBySession, onOpenSession, loading, laneFor }) {
  return jsxs('section', {
    'aria-label': 'Live sessions',
    style: S.strip,
    children: [
      jsx(Separator, {}),
      jsxs('div', {
        style: S.stripHead,
        children: [
          jsx('span', { style: S.stripTitle, children: 'Live sessions' }),
          items.length > 0 ? jsx('span', { style: S.count, children: items.length }) : null
        ]
      }),
      items.length === 0
        ? jsx('div', {
            style: { fontSize: '0.75rem', color: 'var(--ui-text-quaternary)', padding: '2px 0' },
            children: loading ? 'Checking for live sessions\u2026' : 'No live sessions right now.'
          })
        : jsx('div', {
            style: S.stripList,
            children: items.map(item => {
              const project = projectBySession.get(item.session_key)
              const model = shortModel(item.model)
              const ms = sessionStamp(item)
              const state = item.state || 'idle'

              return jsxs(
                RowButton,
                {
                  className: 'pcc-live-row',
                  onClick: () => onOpenSession(item.session_key),
                  style: S.liveRow,
                  children: [
                    jsx('span', { style: { display: 'inline-flex', flex: 'none' }, children: jsx(LiveDot, { state }) }),
                    jsx('span', { style: { ...S.ellipsis, flex: '1 1 0', fontWeight: 500 }, children: sessionTitle(item) }),
                    laneFor
                      ? jsx('span', {
                          style: { display: 'inline-flex', flex: 'none' },
                          children: jsx(LaneBadge, { lane: laneFor(item.session_key) })
                        })
                      : null,
                    project ? jsx('span', { style: { ...S.ellipsis, flex: '0 1 140px', color: 'var(--ui-text-secondary)' }, children: project }) : null,
                    model ? jsx('span', { style: { ...S.ellipsis, flex: '0 1 120px', color: 'var(--ui-text-quaternary)' }, children: model }) : null,
                    jsx('span', { style: { flex: 'none', width: 64, color: 'var(--ui-text-secondary)' }, children: LIVE_LABELS[state] || state }),
                    jsx('span', {
                      style: { flex: 'none', width: 84, textAlign: 'right', whiteSpace: 'nowrap', color: 'var(--ui-text-quaternary)' },
                      children: ms ? jsx(Tip, { label: stampTip(ms), children: jsx('span', { children: ageText(ms) }) }) : null
                    })
                  ]
                },
                item.session_key
              )
            })
          })
    ]
  })
}

// ── live state ───────────────────────────────────────────────────────────────

const $noBusy = atom({})

// One poll, one mapping. `busyBySession` is keyed by RUNTIME id and updates in
// real time, so it leads the 5s gateway poll; byStored is the stored-id view
// every card, row and column count paints from.
function useLiveSessions() {
  const query = useQuery({
    queryFn: () => host.request('session.active_list', profileParam()),
    queryKey: [QUERY_ROOT, 'live'],
    refetchInterval: LIVE_MS,
    staleTime: 2500
  })

  const busyByRuntime = useValue((host.state && host.state.busyBySession) || $noBusy)
  const activity = useValue($activity)
  const clock = useValue($activityClock)

  const items = useMemo(() => {
    const rows = ((query.data && query.data.sessions) || []).filter(s => s.session_key && s.id)

    return rows
      .map(s => {
        const at = activity[s.id] || 0
        // clock is 0 until the first tick, so fall back to the wall clock then.
        const recentlyActive = at > 0 && (clock || Date.now()) - at < ACTIVITY_TTL_MS

        return { ...s, state: liveState(s, Boolean(busyByRuntime && busyByRuntime[s.id]), recentlyActive) }
      })
      .sort((a, b) => sessionStamp(b) - sessionStamp(a))
  }, [query.data, busyByRuntime, activity, clock])

  const byStored = useMemo(() => new Map(items.map(s => [s.session_key, s.state])), [items])

  return { byStored, items, query }
}

// ── git graph layout ────────────────────────────────────────────────────────
// The graph tab draws local history, so this block knows nothing about GitHub.
// Input is the server's raw window (newest first, children before parents);
// output is render-ready rows, band edges and SVG path strings.
//
// graph-layout:begin
// Pure lane layout for the Git graph tab. No imports and no DOM, so the node
// test can lift this block straight out of this file and run it as is.
// Color keys are ref names or shas, never allocation order, so a refresh that
// adds commits on top does not repaint the branches below it.

const GRAPH_ROW_H = 26
const GRAPH_LANE_W = 14
const GRAPH_DOT_R = 3.5
const GRAPH_STROKE = 1.75
const GRAPH_MAX_LANES = 16
const GRAPH_LANE_COLORS = [
  'var(--ui-accent)',
  'var(--ui-orange)',
  'var(--ui-purple)',
  'var(--ui-cyan)',
  'var(--ui-green)',
  'var(--ui-yellow)',
  'var(--ui-red)',
  'var(--ui-blue)'
]

function graphNumber(value, fallback) {
  return typeof value === 'number' && isFinite(value) ? value : fallback
}

function graphRound(value) {
  const n = Math.round(value * 1000) / 1000

  return Object.is(n, -0) ? 0 : n
}

function graphHash(key) {
  let h = 0x811c9dc5

  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }

  return h >>> 0
}

function graphRefKind(ref) {
  const name = String((ref && ref.name) || '')

  if (name.indexOf('refs/heads/') === 0) return 'local'
  if (name.indexOf('refs/remotes/') === 0) return 'remote'
  if (name.indexOf('refs/tags/') === 0) return 'tag'
  if (ref && ref.kind) return String(ref.kind)

  return ''
}

function graphRefShort(ref) {
  return String((ref && ref.short) || (ref && ref.name) || '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/tags\//, '')
}

function graphRefTarget(refs) {
  const list = Array.isArray(refs) ? refs : []

  for (const ref of list) {
    const name = String((ref && ref.name) || '')
    const target = String((ref && (ref.symref || ref.target)) || '')
    if (name.endsWith('/HEAD') && target) return target.replace(/^refs\/remotes\//, '')
  }

  return null
}

function graphBasename(name) {
  const parts = String(name || '').split('/')

  return parts[parts.length - 1] || ''
}

// Local branch first, then remote, both sorted so two refs on one commit cannot
// race. Tags are labels, never lane keys.
function graphBestRefName(list) {
  if (!Array.isArray(list) || !list.length) return null

  const local = list
    .filter(ref => graphRefKind(ref) === 'local')
    .map(graphRefShort)
    .filter(short => short && !short.endsWith('/HEAD'))
    .sort()
  if (local.length) return local[0]

  const remote = list
    .filter(ref => graphRefKind(ref) === 'remote')
    .map(graphRefShort)
    .filter(short => short && !short.endsWith('/HEAD'))
    .sort()
  if (remote.length) return remote[0]

  return null
}

// Trunk is the default branch's first parent chain. Prefer the local branch
// when it sits on that chain, otherwise the remote tip, because the server's
// default branch is usually origin/main and one straight line should cover both.
function graphPickTrunkTip(refs, refsByName, head, defaultBranch, commits, index) {
  const def = String(defaultBranch || graphRefTarget(refs) || '')
  const remoteName = def && !def.startsWith('refs/') ? def.replace(/^refs\/remotes\//, '') : ''
  const base = def ? graphBasename(remoteName || def) : ''
  const candidates = []

  if (base) candidates.push(base)
  if (base !== 'main') candidates.push('main')
  candidates.push('master')

  let local = null
  for (const name of candidates) {
    const ref = refsByName.get(`refs/heads/${name}`)
    if (ref && index.has(String(ref.sha))) {
      local = ref
      break
    }
  }

  let remote = null
  if (def) {
    const names = def.startsWith('refs/') ? [def] : [`refs/remotes/${def}`]
    if (!def.startsWith('refs/') && def.indexOf('/') === -1) names.push(`refs/remotes/origin/${def}`)
    for (const name of names) {
      const ref = refsByName.get(name)
      if (ref && index.has(String(ref.sha))) {
        remote = ref
        break
      }
    }
  }

  if (local && remote && local.sha !== remote.sha) {
    let cursor = String(remote.sha)
    const seen = new Set()
    while (cursor && index.has(cursor) && !seen.has(cursor)) {
      if (cursor === String(local.sha)) return String(remote.sha)
      seen.add(cursor)
      const commit = commits[index.get(cursor)]
      const parents = commit && Array.isArray(commit.parents) ? commit.parents : []
      cursor = parents[0] != null ? String(parents[0]) : ''
    }
  }

  if (local) return String(local.sha)
  if (remote) return String(remote.sha)
  if (head && index.has(String(head.sha))) return String(head.sha)

  return null
}

// Base colour from the key, then step off a colour already worn by the lane on
// either side. Colour 0 is the trunk and is never handed to a side track.
function graphTrackColor(key, slots, lane) {
  const base = 1 + (graphHash(String(key)) % 7)
  let color = base

  for (let step = 0; step < 7; step += 1) {
    const left = lane > 0 && slots[lane - 1] && slots[lane - 1].track ? slots[lane - 1].track.color : -1
    const right = slots[lane + 1] && slots[lane + 1].track ? slots[lane + 1].track.color : -1
    if (color !== left && color !== right) return color
    color = color === 7 ? 1 : color + 1
  }

  return base
}

function pccGraphLayout(input) {
  const payload = input && typeof input === 'object' ? input : {}
  const source = Array.isArray(payload.commits) ? payload.commits : []
  const commits = source.map(commit => ({
    ...commit,
    parents: Array.isArray(commit && commit.parents) ? commit.parents.filter(parent => parent != null && parent !== '') : [],
    sha: String((commit && commit.sha) || '')
  }))
  const count = commits.length
  const index = new Map()

  commits.forEach((commit, i) => {
    if (commit.sha) index.set(commit.sha, i)
  })

  const refs = (Array.isArray(payload.refs) ? payload.refs : [])
    .map(ref => ({
      ...ref,
      kind: graphRefKind(ref),
      name: String((ref && ref.name) || ''),
      sha: String((ref && ref.sha) || ''),
      short: graphRefShort(ref)
    }))
    .filter(ref => {
      if (!ref.sha || !index.has(ref.sha)) return false
      if (ref.name.endsWith('/HEAD')) return false
      return graphRefKind(ref) !== ''
    })
  // A symref HEAD is dropped from the drawable refs, so read its target from the
  // raw payload before that filter runs.
  const refTarget = graphRefTarget(Array.isArray(payload.refs) ? payload.refs : [])
  const refsByName = new Map(refs.map(ref => [ref.name, ref]))
  const refsBySha = new Map()
  refs.forEach(ref => {
    const list = refsBySha.get(ref.sha) || []
    list.push(ref)
    refsBySha.set(ref.sha, list)
  })

  const head = payload.head && typeof payload.head === 'object' ? payload.head : null
  const trunkTip = graphPickTrunkTip(refs, refsByName, head, payload.default_branch || refTarget, commits, index)
  const trunk = new Set()
  const trunkSeen = new Set()
  let cursor = trunkTip

  while (cursor && index.has(cursor) && !trunkSeen.has(cursor)) {
    trunkSeen.add(cursor)
    trunk.add(cursor)
    const commit = commits[index.get(cursor)]
    cursor = commit.parents[0] != null ? String(commit.parents[0]) : ''
  }

  const slots = []
  const rows = []
  const bands = []
  const freedThisRow = new Set()
  const reserveZero = trunk.size > 0
  const anomalies = []
  let maxLanes = 0

  const alloc = minIndex => {
    let k = Math.max(0, minIndex)
    for (; k < slots.length; k += 1) {
      if (slots[k] == null && !freedThisRow.has(k)) return k
    }
    while (freedThisRow.has(k)) k += 1
    return k
  }

  const allocRightOf = lane => {
    let k = lane + 1
    for (; k < slots.length; k += 1) {
      if (slots[k] == null && !freedThisRow.has(k)) return k
    }
    while (freedThisRow.has(k)) k += 1
    return k
  }

  for (let i = 0; i < count; i += 1) {
    const commit = commits[i]
    const sha = commit.sha
    const parents = []
    const seenParents = new Set()

    for (const parent of commit.parents) {
      const parentSha = String(parent)
      if (!parentSha || seenParents.has(parentSha)) continue
      const parentRow = index.get(parentSha)
      if (parentRow != null && parentRow <= i) {
        anomalies.push({ child: sha, childRow: i, parent: parentSha, parentRow, reason: 'parent_not_after_child' })
        continue
      }
      seenParents.add(parentSha)
      parents.push(parentSha)
    }

    const incoming = []
    for (let k = 0; k < slots.length; k += 1) {
      if (slots[k] && slots[k].sha === sha) incoming.push(k)
    }

    const born = new Set()
    let lane

    if (trunk.has(sha)) lane = 0
    else if (incoming.length) {
      lane = incoming.find(k => slots[k].firstParent)
      if (lane == null) lane = incoming[0]
    } else lane = alloc(reserveZero ? 1 : 0)

    let track
    if (incoming.indexOf(lane) !== -1 && slots[lane]) track = slots[lane].track
    else if (lane === 0 && trunk.has(sha)) track = { color: 0, key: 'trunk' }
    else {
      const key = graphBestRefName(refsBySha.get(sha)) || sha
      track = { color: graphTrackColor(key, slots, lane), key }
    }

    // Every other lane waiting for this commit is a fork converging from below.
    const converging = incoming.filter(k => k !== lane)
    for (const k of converging) {
      slots[k] = null
      freedThisRow.add(k)
    }

    const joins = []
    if (parents.length) {
      slots[lane] = { sha: parents[0], track, firstParent: true }
      born.add(lane)
    } else {
      slots[lane] = null
      freedThisRow.add(lane)
    }

    for (let p = 1; p < parents.length; p += 1) {
      const parentSha = parents[p]
      let existing = -1
      for (let k = 0; k < slots.length; k += 1) {
        if (slots[k] && slots[k].sha === parentSha) {
          existing = k
          break
        }
      }
      if (existing !== -1) {
        joins.push(existing)
        continue
      }
      let slot = allocRightOf(lane)
      if (reserveZero && slot === 0) slot = allocRightOf(0)
      slots[slot] = {
        sha: parentSha,
        track: { color: graphTrackColor(parentSha, slots, slot), key: parentSha },
        firstParent: false
      }
      born.add(slot)
    }

    while (slots.length && slots[slots.length - 1] == null) slots.pop()
    maxLanes = Math.max(maxLanes, slots.length, lane + 1)

    const rowRefs = (refsBySha.get(sha) || []).map(ref => ref.short)
    rows.push({
      after: slots.slice(),
      born,
      color: track.color,
      converging,
      freed: converging.concat(parents.length ? [] : [lane]),
      isHead: Boolean(head && String(head.sha) === sha),
      joins,
      key: track.key,
      lane,
      refs: rowRefs,
      sha
    })
    freedThisRow.clear()
  }

  // One band per row. The last one runs to the bottom edge, so an open parent
  // becomes a fading stub instead of a false dot.
  for (let i = 0; i < count; i += 1) {
    const row = rows[i]
    const next = i + 1 < count ? rows[i + 1] : null
    const band = []

    for (let k = 0; k < row.after.length; k += 1) {
      const slot = row.after[k]
      if (!slot) continue
      const from = row.born.has(k) ? row.lane : k
      const to = next && slot.sha === next.sha ? next.lane : k
      band.push({ color: slot.track.color, from, sha: slot.sha, slot: k, stub: !next, to })
    }
    for (const m of row.joins) {
      const slot = row.after[m]
      if (!slot) continue
      const to = next && slot.sha === next.sha ? next.lane : m
      band.push({ color: slot.track.color, from: row.lane, join: true, sha: slot.sha, slot: m, stub: !next, to })
    }
    bands.push(band)
  }

  return { anomalies: anomalies.length, anomalyList: anomalies, bands, maxLanes, rows, trunkSize: trunk.size }
}

// Geometry: symmetric cubics with vertical tangents at both dots, one row pitch
// per band. A lane index past the limit pins to the right edge; its dot is
// returned separately so the view can draw it hollow.
function pccGraphPaths(layout, geometry) {
  const rows = layout && Array.isArray(layout.rows) ? layout.rows : []
  const bands = layout && Array.isArray(layout.bands) ? layout.bands : []
  const geom = geometry && typeof geometry === 'object' ? geometry : {}
  const rowH = graphNumber(geom.rowH, GRAPH_ROW_H)
  const laneW = graphNumber(geom.laneW, GRAPH_LANE_W)
  const dotR = graphNumber(geom.dotR, GRAPH_DOT_R)
  const labelGutter = graphNumber(geom.labelGutter, 0)
  const requested = graphNumber(geom.maxLanes, graphNumber(layout && layout.maxLanes, 1))
  const limit = Math.max(1, Math.min(requested, GRAPH_MAX_LANES))
  const gutter = labelGutter > 0 ? labelGutter + 8 : 0
  const width = gutter + limit * laneW + 8
  const height = rows.length * rowH
  const x = k => gutter + Math.min(Math.max(k, 0), limit - 1) * laneW + laneW / 2
  const y = i => i * rowH + rowH / 2
  const byColor = {}
  const dotsByColor = {}
  let headRing = ''
  let leaders = ''
  let clippedDots = ''

  const add = (bucket, key, d) => {
    const name = String(key)
    bucket[name] = bucket[name] ? `${bucket[name]} ${d}` : d
  }

  bands.forEach((band, i) => {
    const y0 = y(i)
    const y1 = i + 1 < rows.length ? y(i + 1) : height
    for (const edge of band || []) {
      const x0 = graphRound(x(edge.from))
      const x1 = graphRound(x(edge.to))
      const d =
        x0 === x1
          ? `M ${x0} ${graphRound(y0)} V ${graphRound(y1)}`
          : `M ${x0} ${graphRound(y0)} C ${x0} ${graphRound((y0 + y1) / 2)}, ${x1} ${graphRound((y0 + y1) / 2)}, ${x1} ${graphRound(y1)}`
      add(byColor, edge.color, d)
    }
  })

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const cx = graphRound(x(row.lane))
    const cy = graphRound(y(i))
    const circle = graphCircle(cx, cy, dotR)
    if (row.lane < limit) add(dotsByColor, row.color, circle)
    else clippedDots = clippedDots ? `${clippedDots} ${circle}` : circle
    if (row.isHead && !headRing) headRing = graphCircle(cx, cy, dotR + 1)
  }

  if (labelGutter > 0) {
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      if (!row.refs || !row.refs.length) continue
      const cy = graphRound(y(i))
      const x1 = graphRound(x(row.lane) - dotR - 1)
      const x0 = graphRound(labelGutter)
      if (x1 > x0) leaders = leaders ? `${leaders} M ${x0} ${cy} H ${x1}` : `M ${x0} ${cy} H ${x1}`
    }
  }

  return {
    byColor,
    clippedDots,
    dotsByColor,
    headRing,
    height: graphRound(height),
    leaders,
    maxLanes: limit,
    width: graphRound(width)
  }
}

function graphCircle(cx, cy, r) {
  const left = graphRound(cx - r)
  const right = graphRound(cx + r)
  const radius = graphRound(r)
  const center = graphRound(cy)

  return `M ${left} ${center} A ${radius} ${radius} 0 1 0 ${right} ${center} A ${radius} ${radius} 0 1 0 ${left} ${center} Z`
}
// graph-layout:end

// ── github section ───────────────────────────────────────────────────────────
// One read for one project folder: /github with state=all carries the open and
// the closed half together, so every tab filter is a local cut of the same
// payload. It is joined against the sessions the detail page already loaded (by
// git_branch) and against /repo's branch list.
//
// A payload can carry `error` (no remote, no auth, a rate limit): that renders as
// a quiet line. Only a THROWN request means the backend is not mounted yet, and
// that is the one case that gets the error row. Nothing here writes.

const GH_PRESET_KEY = 'githubPreset.v2'
// v1 stored the pre-rename ids. The three that were renamed map across so an
// upgrade keeps the reader on the tab they were on; anything else falls back.
const LEGACY_GH_PRESET_KEY = 'githubPreset.v1'
const GH_PRESET_ALIASES = { flight: 'prs', issue: 'issues', branch: 'branches' }
const DEFAULT_GH_PRESET = 'prs'
const GH_PRESETS = [
  { id: 'issues', label: 'Issues' },
  { id: 'prs', label: 'Pull Requests' },
  { id: 'branches', label: 'Branches' },
  { id: 'graph', label: 'Graph' },
  { id: 'unlinked', label: 'Unlinked' }
]
const GH_LIMIT = 50
const BRANCH_CAP = 25
const PR_FILES_SHOWN = 8
// #123 references: a chip is only ever drawn for a number /github/refs resolved,
// so an unresolvable number stays the writer's plain text.
const GH_REF_RE = /(?<![\w/])#(\d{1,7})\b/g
const GH_REF_CHARS = 200
// The backend resolves at most this many numbers per /github/refs read.
const GH_REF_MAX = 50
const GH_LABEL_CHIPS = 5
const CHECKS_TONE = { success: 'good', failure: 'bad', pending: 'warn', none: 'muted' }
const CHECKS_TEXT = { success: 'all checks passing', failure: 'checks failing', pending: 'checks running', none: 'no checks reported' }
const REVIEW_BADGES = {
  APPROVED: { label: 'approved', title: 'Approved', variant: 'success' },
  CHANGES_REQUESTED: { label: 'changes', title: 'Changes requested', variant: 'destructive' },
  REVIEW_REQUIRED: { label: 'review', title: 'Review required', variant: 'muted' }
}

const $ghPreset = atom(DEFAULT_GH_PRESET)
// A board.changed event that names a pull request pokes the GitHub section:
// `{ project_id, pr, at }`. `at` makes two pokes for the same PR distinct.
const $ghPoke = atom(null)

function readGhPreset() {
  if (!pluginCtx) return DEFAULT_GH_PRESET
  const raw = pluginCtx.storage.get(GH_PRESET_KEY, '')
  if (GH_PRESETS.some(p => p.id === raw)) return raw
  // Unlinked and Graph kept their ids, so a v1 value may still name a live tab.
  const legacy = pluginCtx.storage.get(LEGACY_GH_PRESET_KEY, '')
  if (GH_PRESETS.some(p => p.id === legacy)) return legacy
  const migrated = GH_PRESET_ALIASES[legacy]

  return GH_PRESETS.some(p => p.id === migrated) ? migrated : DEFAULT_GH_PRESET
}

function writeGhPreset(presetId) {
  if (!GH_PRESETS.some(p => p.id === presetId)) return
  $ghPreset.set(presetId)
  if (pluginCtx) pluginCtx.storage.set(GH_PRESET_KEY, presetId)
}

// ctx.rest rejects when the gateway has no router for this plugin, which is the
// "backend not enabled yet" signal the section renders. Guarding here keeps the
// failure a rejected promise instead of a render crash on an older host.
function ghRest(path, opts) {
  if (!pluginCtx || typeof pluginCtx.rest !== 'function') {
    return Promise.reject(new Error('This Desktop build has no plugin REST door.'))
  }

  return pluginCtx.rest(path, opts)
}

// A failure is a code, not a status line. Each normal condition gets one small
// muted sentence; the endpoint and status travel in a Tip so the line stays one
// line. Only a THROWN request is the red-ish ErrorState elsewhere.
function ghFailureText(data, folder) {
  const code = String((data && data.code) || '')
  const err = String((data && data.error) || '').trim()
  const detail = String((data && data.detail) || '').trim()
  const account = String((data && data.auth_account) || '').trim()

  if (code === 'folder_missing') return { text: `Folder not found: ${(data && data.path) || folder || ''}` }
  if (code === 'not_a_repo') return { text: 'Not a git repository' }
  if (code === 'empty_repo') return { text: 'No commits yet' }
  if (code === 'no_remote') return { text: 'No GitHub remote' }
  if (code === 'repo_not_found') {
    const named = account && err && !err.includes(account) ? `${err} (as ${account})` : err
    return { text: named || `GitHub could not read this repo as ${account || 'the configured credential'}.`, detail }
  }
  if (code === 'no_auth') return { text: 'GitHub not authenticated. Set GITHUB_TOKEN or run gh auth login.', detail }
  if (code === 'rate_limited') return { text: 'GitHub rate limit reached, retrying later', detail }
  if (code === 'network' || code === 'upstream_error') return { text: detail || err || 'GitHub could not be reached.', detail }
  return { text: err || 'GitHub is not available for this folder right now.', detail }
}

function GhFailure({ data, folder }) {
  const { text, detail } = ghFailureText(data, folder)
  const line = jsx('span', {
    style: { ...S.ghQuiet, display: 'block' },
    children: text
  })

  return detail ? jsx(Tip, { label: detail, children: line }) : line
}

function ghNumber(n) {
  return `#${Number(n) || 0}`
}

// One section head for every modal (thread and commit): glyph, label, optional
// count. Same markup the thread closure used, lifted so both dialogs read alike.
function ghHead(icon, text, count) {
  return jsxs('div', {
    style: S.ghSectionHead,
    children: [
      jsx(Codicon, { name: icon, size: '0.75rem', style: { flex: 'none' } }),
      jsx('span', { children: text }),
      count != null ? jsx('span', { style: S.count, children: count }) : null
    ]
  })
}

// `stampMs` and `ageText` above read GitHub's ISO 8601 as well as the gateway's
// epoch seconds, so the GitHub side needs no helper of its own.

function ghInitials(login) {
  const parts = String(login || '').split(/[-_. ]+/).filter(Boolean)

  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()

  return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
}

function ghChecksTip(checks) {
  const total = (checks && checks.total) || 0
  const failing = (checks && checks.failing) || 0

  if (!total) return CHECKS_TEXT.none

  return `${failing} failing of ${total} checks`
}

// github-status:begin
// One place for GitHub's status vocabulary, shared by every glyph (row, ref
// pill, modal header) and by the tab filter rows. GitHub's dark palette, named
// once: open green, merged or closed as completed purple, closed as not planned
// or duplicate red, draft grey. The app exposes no theme variable for these, so
// these are the values.
const GH_STATUS_COLORS = {
  open: '#3fb950',
  merged: '#a371f7',
  closed: '#a371f7',
  not_planned: '#f85149',
  duplicate: '#f85149',
  draft: '#8b949e',
  unknown: '#8b949e'
}

const GH_STATUS_LABELS = {
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
  not_planned: 'Closed as not planned',
  duplicate: 'Closed as duplicate',
  draft: 'Draft',
  unknown: 'Unknown'
}

// issue: Open, Closed. pr: Open, Merged, Closed, Draft. `closed` on a pull
// request includes merged rows, as GitHub's own Closed filter does.
const GH_STATUS_FILTERS = {
  issue: [{ id: 'open', label: 'Open' }, { id: 'closed', label: 'Closed' }],
  pr: [
    { id: 'open', label: 'Open' },
    { id: 'merged', label: 'Merged' },
    { id: 'closed', label: 'Closed' },
    { id: 'draft', label: 'Draft' }
  ]
}

function ghStatusKind(kind) {
  return kind === 'pr' ? 'pr' : 'issue'
}

// The colour bucket. A draft PR is grey while it is open, and a closed one
// reads as closed; a merged PR is always purple whichever half it came from.
function ghStatusKey(kind, row) {
  const item = row || {}
  const state = String(item.state || '').toLowerCase()
  if (ghStatusKind(kind) === 'pr') {
    if (item.merged === true || state === 'merged') return 'merged'
    if (state === 'closed') return 'closed'
    if (item.draft === true) return 'draft'
    if (state === 'open') return 'open'

    return 'unknown'
  }
  if (state === 'closed') {
    const reason = String(item.state_reason || '').toLowerCase().replace(/[\s-]+/g, '_')
    if (reason === 'duplicate') return 'duplicate'
    if (reason === 'not_planned' || reason === 'notplanned') return 'not_planned'

    return 'closed'
  }
  if (state === 'open') return 'open'

  return 'unknown'
}

function ghStatusColor(kind, row) {
  return GH_STATUS_COLORS[ghStatusKey(kind, row)]
}

function ghStatusLabel(kind, row) {
  return GH_STATUS_LABELS[ghStatusKey(kind, row)]
}

// The Badge variant that pairs with the colour, for the places a badge sits
// beside a glyph. The glyph colour stays the precise signal.
function ghStatusVariant(kind, row) {
  const key = ghStatusKey(kind, row)
  if (key === 'open') return 'success'
  if (key === 'not_planned' || key === 'duplicate') return 'destructive'

  return 'muted'
}

// The glyph and its colour: one call site shape for every icon in the section.
// The issue glyph never changes, only its colour; a PR swaps glyph by state the
// way GitHub does.
function ghStatusLook(kind, row) {
  const key = ghStatusKey(kind, row)
  const glyph =
    ghStatusKind(kind) === 'pr'
      ? key === 'merged'
        ? 'git-merge'
        : key === 'closed'
          ? 'git-pull-request-closed'
          : key === 'draft'
            ? 'git-pull-request-draft'
            : 'git-pull-request'
      : 'issues'

  return { key, name: glyph, color: GH_STATUS_COLORS[key], label: GH_STATUS_LABELS[key] }
}

// Which filter ticks a row answers to. A merged PR answers Merged and Closed; an
// open draft answers Open and Draft, so the default (Open) view still shows
// drafts exactly as it did before. A row that cannot be classified answers Open,
// so it is never silently dropped.
function ghStatusBuckets(kind, row) {
  const item = row || {}
  const state = String(item.state || '').toLowerCase()
  if (ghStatusKind(kind) === 'pr') {
    if (item.merged === true || state === 'merged') return ['merged', 'closed']
    if (state === 'closed') return ['closed']
    if (item.draft === true) return ['open', 'draft']
    if (state === 'open') return ['open']

    return ['open']
  }

  return [state === 'closed' ? 'closed' : 'open']
}

// The union the filter row promises: a row is shown when ANY ticked status
// names it. No ticks means no filter at all, never an empty list.
function ghFilterRows(kind, rows, selected) {
  const ticks = selected instanceof Set ? selected : new Set(selected || [])
  const list = Array.isArray(rows) ? rows : []
  if (ticks.size === 0) return list

  return list.filter(row => ghStatusBuckets(kind, row).some(bucket => ticks.has(bucket)))
}
// github-status:end

// Inverted prs[].linked_issues: one pass per board read, used by every preset.
function ghLinkedPrMap(prs) {
  const map = new Map()

  for (const pr of prs || []) {
    for (const n of pr.linked_issues || []) {
      const list = map.get(n) || []

      list.push(pr)
      map.set(n, list)
    }
  }

  return map
}

// The join the whole section rests on: branch name to how many of this project's
// sessions sit on it and how many of those are running right now.
function branchSessionMap(lanes, liveByStored) {
  const map = new Map()

  for (const lane of lanes || []) {
    for (const s of lane.sessions || []) {
      const name = String(s.git_branch || '').trim()

      if (!name) continue
      const row = map.get(name) || { count: 0, live: 0 }

      row.count += 1
      if (RUNNING.has(liveByStored.get(s.id))) row.live += 1
      map.set(name, row)
    }
  }

  return map
}

// Branch union: what /repo knows, what an open PR names, what a session sits on.
// A branch row can therefore be backed by any one of the three.
function ghBranchRows({ branches, prs, sessionsByBranch }) {
  const rows = new Map()
  const ensure = name => {
    const key = String(name || '').trim()

    if (!key) return null
    let row = rows.get(key)

    if (!row) {
      row = { name: key, local: null, pr: null, sessions: null, stamp: 0 }
      rows.set(key, row)
    }

    return row
  }

  for (const branch of branches || []) {
    const row = ensure(branch.name)

    if (!row) continue
    row.local = branch
    row.stamp = Math.max(row.stamp, stampMs(branch.last_commit_at))
  }

  for (const pr of prs || []) {
    const row = ensure(pr.head_ref)

    if (!row) continue
    if (!row.pr || stampMs(pr.updated_at) > stampMs(row.pr.updated_at)) row.pr = pr
    row.stamp = Math.max(row.stamp, stampMs(pr.updated_at))
  }

  for (const [name, sessions] of sessionsByBranch) {
    const row = ensure(name)

    if (row) row.sessions = sessions
  }

  const live = row => (row.sessions && row.sessions.live > 0 ? 1 : 0)
  const list = [...rows.values()]

  list.sort(
    (a, b) =>
      live(b) - live(a) ||
      (b.pr ? 1 : 0) - (a.pr ? 1 : 0) ||
      b.stamp - a.stamp ||
      a.name.localeCompare(b.name)
  )

  return list
}

// ── github pieces ────────────────────────────────────────────────────────────

function GhChecks({ checks }) {
  if (!checks) return null

  return jsx(Tip, {
    label: ghChecksTip(checks),
    children: jsx(StatusDot, { tone: CHECKS_TONE[checks.state] || 'muted' })
  })
}

function GhReview({ decision }) {
  const view = REVIEW_BADGES[decision]

  if (!view) return null

  return jsx(Badge, { size: 'xs', title: view.title, variant: view.variant, children: view.label })
}

function GhSessions({ row }) {
  if (!row || !row.count) return null

  return jsxs('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      flex: 'none',
      color: row.live > 0 ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)'
    },
    children: [
      row.live > 0 ? jsx(StatusDot, { tone: 'good' }) : null,
      jsx('span', { children: `${row.count} ${row.count === 1 ? 'session' : 'sessions'}` })
    ]
  })
}

// Interactive when the caller can navigate and the target is in the loaded
// board (open or closed), a plain tag when the preset cannot reach it. No dead
// buttons either way.
function GhIssueChips({ numbers, onIssue, limit = 3 }) {
  const list = numbers || []

  if (list.length === 0) return null
  const shown = list.slice(0, limit)
  const rest = list.length - shown.length

  return jsxs('span', {
    style: { display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' },
    children: [
      ...shown.map(n =>
        onIssue
          ? jsx(
              'button',
              {
                className: 'pcc-gh-chip',
                onClick: event => {
                  event.stopPropagation()
                  onIssue(n)
                },
                style: S.ghChipBtn,
                title: `Go to issue ${ghNumber(n)}`,
                type: 'button',
                children: ghNumber(n)
              },
              n
            )
          : jsx('span', { style: S.ghChipTag, title: `Issue ${ghNumber(n)}`, children: ghNumber(n) }, n)
      ),
      rest > 0 ? jsx('span', { style: { color: 'var(--ui-text-quaternary)' }, children: `+${rest}` }) : null
    ]
  })
}

function GhTotals({ counts }) {
  const rows = [
    ['open PRs', counts.prs_open],
    ['open issues', counts.issues_open],
    ['review ready', counts.review_ready],
    ['checks failing', counts.checks_failing],
    ['drafts', counts.drafts]
  ]

  return jsx('div', {
    style: S.ghTotals,
    children: rows.map(([label, value]) =>
      jsxs(
        'span',
        {
          style: S.ghTotal,
          children: [
            jsx('span', {
              style:
                label === 'checks failing' && value > 0
                  ? { ...S.ghTotalValue, color: 'var(--dt-destructive)' }
                  : S.ghTotalValue,
              children: value || 0
            }),
            label
          ]
        },
        label
      )
    )
  })
}

function GhSkeleton() {
  return jsx('div', {
    'aria-busy': 'true',
    style: { display: 'flex', flexDirection: 'column', paddingTop: 2 },
    children: [0, 1, 2].map(i =>
      jsxs(
        'div',
        {
          style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '9px 0' },
          children: [
            jsx(Skeleton, { style: { height: 12, width: `${74 - i * 14}%` } }),
            jsx(Skeleton, { style: { height: 10, width: `${42 - i * 7}%` } })
          ]
        },
        i
      )
    )
  })
}

function GhFileChips({ files }) {
  if (!files || files.length === 0) return null
  const shown = files.slice(0, PR_FILES_SHOWN)

  return jsxs('span', {
    style: S.ghFiles,
    children: [
      ...shown.map(name =>
        jsx('span', { style: S.ghFile, title: name, children: String(name).split('/').pop() }, name)
      ),
      files.length > shown.length
        ? jsx('span', { style: { color: 'var(--ui-text-quaternary)' }, children: `+${files.length - shown.length} more` })
        : null
    ]
  })
}

// ── the issue / PR detail modal ─────────────────────────────────────────────
// A row is the summary; the modal is the conversation. Body, comments and review
// bodies all go through MessageTextContent, so fences, tables and images render
// with the app's own pipeline instead of a text approximation. #123 references
// are resolved in ONE batched /github/refs read per view and decorated into
// chips that push the next item onto the same stack, so Back is a pop and never
// a browser back.
//
// Every route here can 404 (the Python half may not be running yet): a missing
// refs route means plain text, a missing write route means the sentence it
// returned sits above the composer, and the thread still renders from the
// detail route alone.

const REVIEW_STATES = {
  APPROVED: { label: 'approved', variant: 'success' },
  CHANGES_REQUESTED: { label: 'changes requested', variant: 'destructive' },
  COMMENTED: { label: 'commented', variant: 'muted' },
  DISMISSED: { label: 'dismissed', variant: 'muted' }
}

function ghKindWord(kind) {
  return kind === 'pr' ? 'pull request' : 'issue'
}

function ghWhen(value) {
  const ms = stampMs(value)

  return ms ? fmtDateTime.format(new Date(ms)) : ''
}

function ghReviewView(state) {
  const key = String(state || '').toUpperCase()

  return REVIEW_STATES[key] || { label: key ? key.toLowerCase() : 'reviewed', variant: 'muted' }
}

// One scan of a body: a fresh regex per call, because a shared /g regex carries
// `lastIndex` as state and a view scans several bodies inside one render.
function ghRefScan(text) {
  const source = String(text || '')
  const re = new RegExp(GH_REF_RE.source, 'g')
  const out = []
  let hit = re.exec(source)

  while (hit) {
    out.push({ end: re.lastIndex, index: hit.index, number: Number(hit[1]) })
    hit = re.exec(source)
  }

  return out
}

// Every #number in a body, oldest sort first, de-duplicated: one `numbers=` for
// the whole view, so the modal makes one refs request and not one per body.
// Capped at the backend's own refs limit so the query string stays bounded.
function ghRefNumbers(texts) {
  const seen = new Set()

  for (const text of texts || []) {
    for (const hit of ghRefScan(text)) {
      if (hit.number > 0) seen.add(hit.number)
    }
  }

  return [...seen].sort((a, b) => a - b).slice(0, GH_REF_MAX)
}

function ghFlat(text, limit = GH_REF_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()

  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat
}

// decorateText hands back the rendered inline children of p/li/td, so a code
// span or a fenced block arrives already built and is passed through untouched.
// Only a string child is split, and only a number refs resolved becomes a chip.
function ghDecorateRefs(children, refs, onOpen, folder) {
  const split = text => {
    const out = []
    let last = 0

    for (const hit of ghRefScan(text)) {
      const entry = refs ? refs[String(hit.number)] : null

      if (!entry) continue
      if (hit.index > last) out.push(text.slice(last, hit.index))
      out.push(jsx(GhRefChip, { entry, folder, onOpen }, `ref-${hit.number}-${hit.index}`))
      last = hit.end
    }

    if (last === 0) return text
    if (last < text.length) out.push(text.slice(last))

    return out
  }

  const walk = node => {
    if (typeof node === 'string') return split(node)
    if (Array.isArray(node)) return node.map(child => walk(child))

    return node
  }

  return walk(children)
}

// A write route answers {ok:false, code, error}; a rejected request is folded
// into the same shape so the composer has exactly one sentence to show.
function ghWriteFailure(res, fallback) {
  const sentence = String((res && (res.error || res.detail)) || '').trim()

  return sentence || fallback
}

function ghReason(res) {
  const err = res && res.error

  return err && err.message ? err.message : String(err || 'the request failed')
}

// One chip: '#123 · Title', a state dot and an issue/PR glyph. Hover opens a
// popover (the pointer needs a grace period to cross the gap to it), and a click
// pushes that item onto the modal's stack.
function GhRefChip({ entry, folder, onOpen }) {
  const [open, setOpen] = useState(false)
  const grace = useRef(0)
  const kind = entry.kind === 'pr' ? 'pr' : 'issue'
  const number = Number(entry.number) || 0
  const title = String(entry.title || '')
  // The refs payload carries no body, so the hover card reads the same detail
  // endpoint the modal does — only while it is open, and cached with it.
  const query = useQuery({
    enabled: open && Boolean(folder) && number > 0,
    queryKey: [QUERY_ROOT, 'github', kind, folder, number],
    queryFn: () => ghRest(`/github/${kind}/${number}?path=${encodeURIComponent(folder)}`),
    retry: false,
    staleTime: 60000
  })
  const body = query.data && !query.data.error ? ghFlat(query.data.body) : ''
  const enter = () => {
    grace.current += 1
    setOpen(true)
  }
  const leave = () => {
    const at = grace.current + 1

    grace.current = at
    schedule(() => {
      if (grace.current === at) setOpen(false)
    }, 160)
  }

  return jsxs(Popover, {
    onOpenChange: next => (next ? enter() : setOpen(false)),
    open,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsxs('button', {
          className: 'pcc-gh-ref',
          onClick: event => {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
            onOpen(kind, number)
          },
          onMouseEnter: enter,
          onMouseLeave: leave,
          style: S.ghRefChip,
          title: `${ghNumber(number)} ${title}`,
          type: 'button',
          children: [
            jsx(Codicon, {
              name: ghStatusLook(kind, entry).name,
              size: '0.625rem',
              style: { color: ghStatusLook(kind, entry).color, flex: 'none' }
            }),
            jsx('span', { style: S.ghRefText, children: `${ghNumber(number)} · ${title || ghKindWord(kind)}` })
          ]
        })
      }),
      jsx(PopoverContent, {
        align: 'start',
        side: 'top',
        children: jsxs('div', {
          onMouseEnter: enter,
          onMouseLeave: leave,
          style: S.ghPop,
          children: [
            jsxs('div', {
              style: S.ghPopHead,
              children: [
                jsx(Codicon, {
                  name: ghStatusLook(kind, entry).name,
                  size: '0.6875rem',
                  style: { color: ghStatusLook(kind, entry).color, flex: 'none' }
                }),
                jsx('span', { style: S.ghPopKind, children: ghKindWord(kind) }),
                jsx('span', { style: S.ghPopNum, children: ghNumber(number) }),
                jsx(Badge, {
                  children: ghStatusLabel(kind, entry),
                  size: 'xs',
                  variant: ghStatusVariant(kind, entry)
                })
              ]
            }),
            jsx('div', { style: S.ghPopTitle, children: title || 'Untitled' }),
            jsxs('div', {
              style: S.ghPopMeta,
              children: [
                entry.author
                  ? jsxs('span', {
                      style: S.ghActorRow,
                      children: [
                        jsx(GhMiniAvatar, { bot: entry.author_bot, login: entry.author, size: 14, src: entry.author_avatar }),
                        jsx('span', { children: entry.author })
                      ]
                    })
                  : null,
                entry.updated_at ? jsx('span', { title: ghWhen(entry.updated_at), children: `updated ${ageText(entry.updated_at)}` }) : null
              ]
            }),
            body ? jsx('div', { style: S.ghPopBody, children: body }) : null,
            jsx(Button, {
              onClick: () => {
                setOpen(false)
                onOpen(kind, number)
              },
              size: 'xs',
              variant: 'outline',
              children: 'Open'
            })
          ]
        })
      })
    ]
  })
}

// GitHub serves avatars from one host with one size (s=48), so the renderer
// loads them directly, the way the app's own CatalogImage does. A URL that
// failed once is remembered for the rest of the session: a remount must not
// flash a broken box or retry a dead image.
const failedAvatars = new Set()

function GhMiniAvatar({ bot, fallback = 'blob', login, size = 16, src }) {
  const name = String(login || 'ghost')
  const url = typeof src === 'string' ? src : ''
  const [failed, setFailed] = useState(false)
  const box = { flex: 'none', height: size, width: size }

  // An assignee cell kept initials before avatars existed, so it keeps them when
  // there is nothing to load.
  if (!url || failed || failedAvatars.has(url)) {
    return fallback === 'initials'
      ? jsx('span', { style: S.ghInitials, title: name, children: ghInitials(name) })
      : jsx(Blobatar, { name, size, title: name })
  }

  return jsx('img', {
    alt: name,
    decoding: 'async',
    height: size,
    loading: 'lazy',
    // Humans keep the circle Blobatar draws; a bot's app logo is a rounded square.
    onError: () => {
      failedAvatars.add(url)
      setFailed(true)
    },
    referrerPolicy: 'no-referrer',
    src: url,
    style: {
      ...box,
      background: 'var(--ui-bg-quaternary)',
      borderRadius: bot ? 4 : '50%',
      display: 'block',
      objectFit: 'cover'
    },
    title: name,
    width: size
  })
}

// github-reactions:begin
// Reactions are GitHub's eight contents, in GitHub's own order, and every chip
// is drawn with a text glyph: a plugin cannot assume an emoji font is installed,
// so `heart` is U+2665 and `rocket` is a caret, not an emoji codepoint.
const GH_REACTION_ORDER = ['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes']
const GH_REACTION_GLYPHS = {
  '+1': '+1',
  '-1': '\u22121',
  laugh: ':D',
  hooray: '\\o/',
  confused: ':/',
  heart: '\u2665',
  rocket: '^',
  eyes: 'oo'
}
const GH_REACTION_LABELS = {
  '+1': 'Thumbs up',
  '-1': 'Thumbs down',
  laugh: 'Laugh',
  hooray: 'Hooray',
  confused: 'Confused',
  heart: 'Heart',
  rocket: 'Rocket',
  eyes: 'Eyes'
}
// Five chips fit one line at the modal's width; the picker carries all eight.
const GH_REACTION_CHIPS = 5
// One quoted line, not the comment: the agent reads the thread itself.
const GH_DRAFT_QUOTE_MAX = 140

function ghReactionGlyph(content) {
  return GH_REACTION_GLYPHS[content] || String(content || '')
}

function ghReactionLabel(content) {
  return GH_REACTION_LABELS[content] || String(content || '')
}

// The chip row: only reactions that exist, most used first, canonical order
// breaking a tie, at most GH_REACTION_CHIPS. A content this build does not know
// is dropped rather than drawn without a glyph.
function ghReactionModel(reactions) {
  const rows = []

  for (const row of Array.isArray(reactions) ? reactions : []) {
    if (!row || typeof row !== 'object') continue

    const content = String(row.content || '')
    const order = GH_REACTION_ORDER.indexOf(content)
    const count = Number(row.count)

    if (order < 0 || !Number.isFinite(count) || count <= 0) continue

    rows.push({ content, count, glyph: ghReactionGlyph(content), label: ghReactionLabel(content), mine: row.mine === true, order })
  }

  rows.sort((a, b) => b.count - a.count || a.order - b.order)

  return rows.slice(0, GH_REACTION_CHIPS).map(({ order, ...row }) => row)
}

// The full picker, in GitHub's order.
function ghReactionPicker() {
  return GH_REACTION_ORDER.map(content => ({
    content,
    glyph: ghReactionGlyph(content),
    label: ghReactionLabel(content)
  }))
}

// One toggle applied locally, so the chip row answers the click before the
// server does. Removing the last reaction drops the row entirely.
function ghReactionToggle(reactions, content) {
  const rows = (Array.isArray(reactions) ? reactions : [])
    .filter(row => row && typeof row === 'object')
    .map(row => ({ ...row }))
  const index = rows.findIndex(row => String(row.content) === content)

  if (index < 0) return [...rows, { content, count: 1, mine: true }]

  const count = Number(rows[index].count) || 0

  if (rows[index].mine === true) {
    if (count <= 1) {
      rows.splice(index, 1)

      return rows
    }
    rows[index] = { content, count: count - 1, mine: false }

    return rows
  }

  rows[index] = { content, count: count + 1, mine: true }

  return rows
}

// The Link to session draft: where the thread lives, who wrote it, one quoted
// line of it, then a blank line for the user's question. Entry points only —
// the agent reads the thread with its own tools, and the body never travels
// into the composer. Nothing here is submitted.
function ghCommentDraftText({ author, body, number, owner, repo }) {
  const n = Number(number)
  const place = owner && repo ? `${owner}/${repo}` : ''
  const head = [`#${Number.isFinite(n) && n > 0 ? n : 0}`, place].filter(Boolean).join(' \u00b7 ')
  const first = String(body || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || ''
  const flat = first.replace(/\s+/g, ' ')
  const quote = flat.length > GH_DRAFT_QUOTE_MAX
    ? `${flat.slice(0, GH_DRAFT_QUOTE_MAX).trimEnd()}\u2026`
    : flat
  const lines = [head]

  if (author) lines.push(`${author} wrote:`)
  if (quote) lines.push(`> ${quote}`)

  return `${lines.join('\n')}\n\n`
}

// The session links already attached to this issue or PR. The board links a
// session to one number, so the kind decides which column is compared.
function ghLinkedSessions(links, kind, number) {
  const n = Number(number) || 0

  if (n <= 0) return []

  return (Array.isArray(links) ? links : []).filter(link => {
    if (!link || !link.session_id) return false

    const value = kind === 'pr' ? Number(link.pr) : Number(link.issue)

    return value === n
  })
}
// github-reactions:end

function GhReactionChip({ busy, onToggle, row }) {
  return jsx('button', {
    'aria-label': `${row.label} ${row.count}${row.mine ? ', you reacted' : ''}`,
    'aria-pressed': row.mine ? 'true' : 'false',
    className: 'pcc-gh-reaction',
    disabled: busy,
    onClick: event => {
      if (event && event.stopPropagation) event.stopPropagation()
      onToggle(row.content)
    },
    style: row.mine ? { ...S.ghReactionChip, ...S.ghReactionMine } : S.ghReactionChip,
    title: row.mine ? `${row.label} · click to remove your reaction` : `${row.label} · click to react`,
    type: 'button',
    children: [
      jsx('span', { 'aria-hidden': 'true', style: S.ghReactionGlyph, children: row.glyph }),
      jsx('span', { children: String(row.count) })
    ]
  })
}

// One object's reactions: the body of the issue/PR, or one comment. The row is
// optimistic — the click repaints first, the server's answer replaces the whole
// row on settle, and a refusal reverts and says so in a toast.
function GhReactions({ commentId, folder, kind, number, reactions }) {
  const server = Array.isArray(reactions) ? reactions : []
  const signature = useMemo(() => JSON.stringify(server), [server])
  const [rows, setRows] = useState(server)
  const [busy, setBusy] = useState(false)
  const model = useMemo(() => ghReactionModel(rows), [rows])
  const picker = useMemo(() => ghReactionPicker(), [])
  const mine = useMemo(() => new Set(model.filter(row => row.mine).map(row => row.content)), [model])

  useEffect(() => {
    setRows(server)
  }, [signature])

  const toggle = content => {
    if (busy || !pluginCtx) return

    const before = rows
    const target = kind === 'pr' ? 'pr' : kind === 'review_comment' ? 'review_comment' : kind === 'issue_comment' ? 'issue_comment' : 'issue'

    setRows(ghReactionToggle(before, content))
    setBusy(true)
    ghRest('/github/reaction', {
      method: 'POST',
      body: {
        kind: target,
        content,
        ...(commentId ? { comment_id: Number(commentId) } : { number: Number(number) }),
        path: folder
      }
    })
      .then(res => {
        if (res && res.ok === true && Array.isArray(res.reactions)) {
          setRows(res.reactions)

          return
        }
        setRows(before)
        host.notify({ kind: 'error', message: ghWriteFailure(res, 'The reaction did not change.') })
      })
      .catch(err => {
        setRows(before)
        host.notify({ kind: 'error', message: `The reaction did not change: ${ghReason(err)}` })
      })
      .then(() => setBusy(false))
  }

  return jsxs('div', {
    style: S.ghReactions,
    children: [
      ...model.map(row => jsx(GhReactionChip, { busy, onToggle: toggle, row }, row.content)),
      jsxs(DropdownMenu, {
        children: [
          jsx(DropdownMenuTrigger, {
            asChild: true,
            children: jsx('button', {
              'aria-label': 'Add a reaction',
              className: 'pcc-gh-reaction pcc-gh-reaction-add',
              disabled: busy,
              style: S.ghReactionAdd,
              title: 'Add a reaction',
              type: 'button',
              children: '+'
            })
          }),
          jsx(DropdownMenuContent, {
            align: 'start',
            children: picker.map(item =>
              jsx(DropdownMenuItem, {
                onSelect: () => toggle(item.content),
                children: [
                  jsx('span', { style: S.ghReactionGlyph, children: item.glyph }),
                  jsx('span', { children: item.label }),
                  mine.has(item.content)
                    ? jsx(Codicon, { name: 'check', size: '0.75rem', style: { marginLeft: 'auto' } })
                    : null
                ]
              }, item.content)
            )
          })
        ]
      })
    ]
  })
}

// The modal's Link to session door: the sessions the board already links to
// this number, then the option to start one in the project folder. It opens or
// seeds a composer; it never sends a turn.
function GhLinkSessionMenu({ detail, folder, kind, number, owner, repo }) {
  const links = useBoardLinks()
  const lanes = useValue($lanes)
  const statuses = useValue($statuses)
  const matched = useMemo(() => ghLinkedSessions(links, kind, number), [links, kind, number])
  const text = useMemo(
    () => ghCommentDraftText({ author: detail && detail.author, body: detail && detail.body, number, owner, repo }),
    [detail, number, owner, repo]
  )
  const path = String(folder || '').trim()
  const [busy, setBusy] = useState(false)

  const laneFor = link => {
    const projectLane = statuses ? statuses[link.project_id] : ''

    return resolveSessionLane(link, null, projectLane, laneIds(lanes))
  }

  const settle = (promise, failure) => {
    if (busy) return
    setBusy(true)
    promise
      .then(ok => {
        if (!ok) host.notify({ kind: 'info', message: 'The session opened, but the thread text did not reach the composer.' })
      })
      .catch(err => host.notify({ kind: 'error', message: `${failure}: ${err && err.message ? err.message : err}` }))
      .then(() => setBusy(false))
  }

  const openExisting = link => {
    if (!link || !link.session_id) return
    settle(openLinkedSession(link.session_id, text), 'Could not open the session')
  }

  const startNew = () => {
    if (!path || busy) return
    settle(openSessionInFolder(path, text), 'Could not open a session')
  }

  return jsxs(DropdownMenu, {
    children: [
      jsx(DropdownMenuTrigger, {
        asChild: true,
        children: jsxs(Button, {
          'aria-label': 'Link to session',
          disabled: busy,
          size: 'xs',
          title: path ? 'Open a session about this thread' : 'No project folder to open a session in',
          variant: 'outline',
          children: [
            jsx(Codicon, { name: busy ? 'loading' : 'comment-discussion', size: '0.75rem', spinning: busy }),
            busy ? 'Opening' : 'Link to session'
          ]
        })
      }),
      jsx(DropdownMenuContent, {
        align: 'end',
        children: [
          jsx('div', { style: S.ghLinkGroup, children: 'Linked sessions' }),
          matched.length > 0
            ? matched.map(link => {
                const lane = laneFor(link)

                return jsx(DropdownMenuItem, {
                  onSelect: () => openExisting(link),
                  children: jsxs('span', {
                    style: S.ghLinkRow,
                    children: [
                      jsxs('span', {
                        style: S.ghLinkText,
                        children: [
                          jsx('span', { style: S.ghLinkTitle, children: link.title || link.session_id }),
                          lane ? jsx(LaneBadge, { lane, lanes }) : null
                        ]
                      }),
                      jsx(Codicon, { name: 'arrow-right', size: '0.75rem', style: { marginLeft: 'auto', flex: 'none' } })
                    ]
                  })
                }, link.session_id)
              })
            : jsx('div', {
                style: S.ghLinkEmpty,
                children: kind === 'pr'
                  ? 'No session is linked to this pull request yet.'
                  : 'No session is linked to this issue yet.'
              }),
          jsx(Separator, {}),
          jsx('div', { style: S.ghLinkGroup, children: 'Start one' }),
          jsx(DropdownMenuItem, {
            disabled: !path || busy,
            onSelect: startNew,
            children: [
              jsx(Codicon, { name: 'add', size: '0.75rem' }),
              path
                ? 'Open new session'
                : 'No project folder for this repo — cannot open a session.'
            ]
          })
        ]
      })
    ]
  })
}

function GhComment({ comment, decorate, folder, kind, number, refKey }) {
  const at = ageText(comment.created_at)

  return jsxs('div', {
    style: S.ghComment,
    children: [
      jsxs('div', {
        style: S.ghCommentHead,
        children: [
          jsx(GhMiniAvatar, { bot: comment.author_bot, login: comment.author, src: comment.author_avatar }),
          jsx('span', { style: S.ghActor, children: comment.author || 'ghost' }),
          at ? jsx('span', { style: S.ghTiny, title: ghWhen(comment.created_at), children: at }) : null
        ]
      }),
      comment.body
        ? jsx('div', {
            key: `prose-${refKey || 'none'}`,
            style: S.ghProse,
            children: jsx(MessageTextContent, { decorateText: decorate, media: true, text: String(comment.body) })
          })
        : jsx('div', { style: S.ghQuiet, children: 'No comment text.' }),
      jsx(GhReactions, {
        commentId: comment.id,
        folder,
        kind,
        number,
        reactions: comment.reactions
      })
    ]
  })
}

function GhReviewEntry({ decorate, refKey, review }) {
  const view = ghReviewView(review.state)
  const at = ageText(review.submitted_at)

  return jsxs('div', {
    style: S.ghComment,
    children: [
      jsxs('div', {
        style: S.ghCommentHead,
        children: [
          jsx(GhMiniAvatar, { bot: review.author_bot, login: review.author, src: review.author_avatar }),
          jsx('span', { style: S.ghActor, children: review.author || 'ghost' }),
          jsx(Badge, { size: 'xs', variant: view.variant, children: view.label }),
          at ? jsx('span', { style: S.ghTiny, title: ghWhen(review.submitted_at), children: at }) : null
        ]
      }),
      review.body
        ? jsx('div', {
            key: `prose-${refKey || 'none'}`,
            style: S.ghProse,
            children: jsx(MessageTextContent, { decorateText: decorate, media: true, text: String(review.body) })
          })
        : null
    ]
  })
}

function GhDiffStat({ detail }) {
  const parts = []
  const files = Number(detail.changed_files) || 0

  if (files) parts.push(`${files} ${files === 1 ? 'file' : 'files'}`)

  return jsxs('span', {
    style: S.ghDiff,
    children: [
      jsx('span', { style: { color: 'var(--ui-accent)' }, children: `+${Number(detail.additions) || 0}` }),
      jsx('span', { style: { color: 'var(--dt-destructive)' }, children: `-${Number(detail.deletions) || 0}` }),
      parts.length ? jsx('span', { children: parts.join(' · ') }) : null
    ]
  })
}

// The modal's meta line: who opened it, when it moved, labels, assignees, and —
// for a PR — refs, the diff size, checks and the review decision.
function GhModalMeta({ detail, kind, onOpen }) {
  const labels = Array.isArray(detail.labels) ? detail.labels : []
  const shown = labels.slice(0, GH_LABEL_CHIPS)
  const assignees = Array.isArray(detail.assignees) ? detail.assignees : []
  const assigneeAvatars = detail.assignee_avatars && typeof detail.assignee_avatars === 'object' ? detail.assignee_avatars : {}
  const createdMs = stampMs(detail.created_at)
  const updatedMs = stampMs(detail.updated_at)
  const created = createdMs ? ageText(createdMs) : ''
  const updated = updatedMs ? ageText(updatedMs) : ''
  const checks = detail.checks
  const linked = kind === 'pr' ? detail.linked_issues || [] : detail.linked_prs || []
  const other = kind === 'pr' ? 'issue' : 'pr'

  return jsxs('div', {
    style: S.ghModalMeta,
    children: [
      jsx('span', { style: S.ghTiny, children: ghKindWord(kind) }),
      detail.author
        ? jsxs('span', {
            style: S.ghActorRow,
            children: [
              jsx(GhMiniAvatar, { bot: detail.author_bot, login: detail.author, src: detail.author_avatar }),
              jsx('span', { style: S.ghActor, children: detail.author })
            ]
          })
        : null,
      created ? jsx('span', { style: S.ghTiny, title: ghWhen(detail.created_at), children: `opened ${created}` }) : null,
      updated ? jsx('span', { style: S.ghTiny, title: ghWhen(detail.updated_at), children: `updated ${updated}` }) : null,
      ...shown.map((label, i) => jsx('span', { style: S.ghLabel, children: String(label) }, `${label}-${i}`)),
      labels.length > shown.length ? jsx('span', { style: S.ghTiny, children: `+${labels.length - shown.length}` }) : null,
      assignees.length > 0
        ? jsxs('span', {
            style: S.ghActorRow,
            title: assignees.join(', '),
            children: [
              ...assignees.slice(0, 3).map(login =>
                jsx(GhMiniAvatar, { login, src: assigneeAvatars[login] }, `assignee-${login}`)
              ),
              jsx('span', { style: S.ghActor, children: assignees.join(', ') })
            ]
          })
        : null,
      kind === 'pr'
        ? jsxs('span', {
            style: S.ghActorRow,
            children: [
              jsx(BranchChip, { branch: detail.head_ref || 'head' }),
              jsx('span', { style: S.ghTiny, children: '→' }),
              jsx('span', { style: S.ghTiny, children: detail.base_ref || 'base' }),
              jsx(GhDiffStat, { detail })
            ]
          })
        : null,
      kind === 'pr' && (detail.files_changed || []).length > 0 ? jsx(GhFileChips, { files: detail.files_changed }) : null,
      kind === 'pr' && checks ? jsx('span', { style: S.ghTiny, children: CHECKS_TEXT[checks.state] || 'checks reported' }) : null,
      kind === 'pr' ? jsx(GhChecks, { checks }) : null,
      kind === 'pr' ? jsx(GhReview, { decision: detail.review_decision }) : null,
      linked.length > 0
        ? jsx(GhIssueChips, { numbers: linked, onIssue: number => (onOpen ? onOpen(other, number) : null) })
        : null
    ]
  })
}

// The loaded thread. Its own component so the refs query, the composer state and
// the mutations only exist once there is a detail to talk about — no hook is
// ever called conditionally.
function GhDetailThread({ detail, folder, kind, number, onOpen, owner, repo }) {
  const comments = Array.isArray(detail.comments) ? detail.comments : []
  const reviews = kind === 'pr' && Array.isArray(detail.reviews) ? detail.reviews : []
  const numbers = useMemo(
    () => ghRefNumbers([detail.body, ...comments.map(c => c.body), ...reviews.map(r => r.body)]),
    [detail]
  )
  const refQuery = useQuery({
    enabled: Boolean(folder) && numbers.length > 0,
    queryKey: [QUERY_ROOT, 'github', 'refs', folder, numbers.join(',')],
    // A missing route, a 404 or a refusal all mean the same thing here: no
    // chips, and the number stays the plain text the writer typed.
    queryFn: () =>
      ghRest(`/github/refs?path=${encodeURIComponent(folder)}&numbers=${numbers.join(',')}`).catch(() => null),
    retry: false,
    staleTime: 60000
  })
  const refsData = refQuery.data
  const refs = useMemo(() => (refsData && refsData.ok && refsData.refs ? refsData.refs : {}), [refsData])
  const decorate = useCallback(children => ghDecorateRefs(children, refs, onOpen, folder), [refs, onOpen, folder])
  // The markdown surface renders decorateText at parse time, so a body that
  // painted before the refs landed never re-parses on its own. Keying each prose
  // block on the resolved set forces exactly one remount when the answer arrives.
  const refKey = useMemo(() => Object.keys(refs).sort().join(','), [refs])

  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const closed = String(detail.state || '').toLowerCase() !== 'open'
  const detailKey = [QUERY_ROOT, 'github', kind, folder, number]
  const path = `path=${encodeURIComponent(folder)}`

  const post = useMutation({
    mutationFn: text =>
      ghRest(`/github/${kind}/${number}/comment?${path}`, { body: { body: text }, method: 'POST' }).catch(error => ({
        error: ghReason(error),
        ok: false
      })),
    onSuccess: res => {
      if (res && res.ok) {
        setDraft('')
        setNote('')
        queryClient.invalidateQueries({ queryKey: detailKey })
        // The new comment may reference a number this view already asked about,
        // and a refs payload cached before the write would keep that chip missing
        // for its whole staleTime. Drop the refs reads with the thread.
        queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, 'github', 'refs'] })

        return
      }
      setNote(ghWriteFailure(res, 'The comment did not post.'))
    }
  })

  const flip = useMutation({
    mutationFn: state =>
      ghRest(`/github/${kind}/${number}/state?${path}`, { body: { state }, method: 'POST' }).catch(error => ({
        error: ghReason(error),
        ok: false
      })),
    onSuccess: res => {
      setConfirming(false)
      if (res && res.ok) {
        setNote('')
        queryClient.invalidateQueries({ queryKey: detailKey })
        queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, 'github', 'open', folder] })

        return
      }
      setNote(ghWriteFailure(res, 'The state did not change.'))
    }
  })

  const head = ghHead

  return jsxs('div', {
    style: S.ghThread,
    children: [
      jsxs('div', {
        style: S.ghSection,
        children: [
          head('book', 'Description'),
          detail.body
            ? jsx('div', {
                key: `prose-${refKey || 'none'}`,
                style: S.ghProse,
                children: jsx(MessageTextContent, { decorateText: decorate, media: true, text: String(detail.body) })
              })
            : jsx('div', { style: S.ghQuiet, children: 'No description.' }),
          jsx(GhReactions, {
            folder,
            kind,
            number,
            reactions: detail.reactions
          })
        ]
      }),
      reviews.length > 0
        ? jsxs('div', {
            style: S.ghSection,
            children: [
              head('comment-discussion', 'Reviews', reviews.length),
              ...reviews.map((review, i) =>
                jsx(GhReviewEntry, { decorate, refKey, review }, `${review.author || 'x'}-${review.submitted_at || i}`)
              )
            ]
          })
        : null,
      jsxs('div', {
        style: S.ghSection,
        children: [
          head('comment', 'Comments', comments.length),
          comments.length > 0
            ? comments.map((comment, i) =>
                jsx(GhComment, { comment, decorate, folder, kind, number, refKey }, `${comment.id || comment.author || 'c'}-${comment.created_at || i}`)
              )
            : jsx('div', { style: S.ghQuiet, children: 'No comments yet.' })
        ]
      }),
      jsxs('div', {
        style: S.ghComposer,
        children: [
          note ? jsx('div', { role: 'alert', style: S.ghComposerError, children: note }) : null,
          jsx(Textarea, {
            'aria-label': `Comment on ${ghNumber(number)}`,
            disabled: post.isPending,
            onChange: event => setDraft(event.target.value),
            placeholder: `Leave a comment on ${ghNumber(number)}…`,
            rows: 3,
            value: draft
          }),
          jsxs('div', {
            style: S.ghComposerRow,
            children: [
              jsx(Button, {
                disabled: !draft.trim() || post.isPending,
                onClick: () => {
                  if (draft.trim()) post.mutate(draft)
                },
                size: 'xs',
                children: post.isPending ? 'Posting…' : 'Comment'
              }),
              confirming
                ? jsxs('span', {
                    style: S.ghComposerRow,
                    children: [
                      jsx(Button, {
                        disabled: flip.isPending,
                        onClick: () => flip.mutate('closed'),
                        size: 'xs',
                        variant: 'destructive',
                        children: flip.isPending ? 'Closing…' : 'Confirm close'
                      }),
                      jsx(Button, {
                        onClick: () => setConfirming(false),
                        size: 'xs',
                        variant: 'ghost',
                        children: 'Cancel'
                      })
                    ]
                  })
                : jsx(Button, {
                    disabled: flip.isPending || post.isPending,
                    onClick: () => {
                      if (closed) flip.mutate('open')
                      else setConfirming(true)
                    },
                    size: 'xs',
                    variant: 'outline',
                    children: flip.isPending ? 'Working…' : closed ? 'Reopen' : 'Close'
                  }),
              jsx('span', { style: S.grow }),
              jsx(StartSessionButton, {
                folder,
                issue: { ...detail, html_url: detail.url },
                owner,
                repo
              })
            ]
          })
        ]
      })
    ]
  })
}

function GhDetailModal({ depth, entry, folder, onBack, onClose, onOpen, owner, repo }) {
  const kind = entry.kind === 'pr' ? 'pr' : 'issue'
  const number = Number(entry.number) || 0
  const query = useQuery({
    enabled: Boolean(folder) && number > 0,
    queryKey: [QUERY_ROOT, 'github', kind, folder, number],
    queryFn: () => ghRest(`/github/${kind}/${number}?path=${encodeURIComponent(folder)}`),
    retry: false,
    staleTime: 60000
  })
  const payload = query.data || null
  const failed = payload && ((payload.code && payload.code !== 'ok') || payload.error) ? payload : null
  const detail = payload && !failed ? payload : null
  const title = (detail && detail.title) || `${ghKindWord(kind)} ${ghNumber(number)}`
  const url = detail && detail.url ? String(detail.url) : ''
  const canOpenExternal = Boolean(pluginCtx && pluginCtx.os && typeof pluginCtx.os.openExternal === 'function')
  const openExternal = () => {
    if (!url || !canOpenExternal) return
    Promise.resolve(pluginCtx.os.openExternal(url)).then(ok => {
      if (ok === false) host.notify({ kind: 'warning', message: 'Could not open the browser.' })
    })
  }

  return jsxs(Dialog, {
    onOpenChange: next => {
      if (!next) onClose()
    },
    open: true,
    children: [
      jsxs(DialogContent, {
        className: 'max-w-3xl',
        children: [
          jsxs(DialogHeader, {
            style: S.ghModalHead,
            children: [
              jsxs('div', {
                style: S.ghModalTitleRow,
                children: [
                  depth > 1 && onBack
                    ? jsx('button', {
                        'aria-label': 'Back',
                        className: 'pcc-gh-back',
                        onClick: onBack,
                        style: S.ghBackBtn,
                        title: 'Back',
                        type: 'button',
                        children: jsx(Codicon, { name: 'chevron-left', size: '0.875rem' })
                      })
                    : null,
                  jsx(Codicon, {
                    name: ghStatusLook(kind, detail || {}).name,
                    size: '0.875rem',
                    style: { flex: 'none', color: ghStatusLook(kind, detail || {}).color, paddingTop: 2 }
                  }),
                  jsx('span', { style: S.ghModalNum, children: ghNumber(number) }),
                  jsx(DialogTitle, { style: S.ghModalTitle, children: title }),
                  detail
                    ? jsx(Badge, {
                        children: ghStatusLabel(kind, detail),
                        size: 'xs',
                        variant: ghStatusVariant(kind, detail)
                      })
                    : null,
                  url && canOpenExternal
                    ? jsxs('button', {
                        className: 'pcc-gh-chip',
                        onClick: openExternal,
                        style: S.ghChipBtn,
                        title: 'View on GitHub',
                        type: 'button',
                        children: ['View on GitHub', jsx(Codicon, { name: 'link-external', size: '0.6875rem' })]
                      })
                    : null,
                  detail
                    ? jsx(GhLinkSessionMenu, { detail, folder, kind, number, owner, repo })
                    : null
                ]
              }),
              detail ? jsx(GhModalMeta, { detail, kind, onOpen }) : null
            ]
          }),
          query.isLoading && !detail
            ? jsxs('div', {
                style: S.ghSection,
                children: [
                  jsx(Skeleton, { style: { height: 12, width: '82%' } }),
                  jsx(Skeleton, { style: { height: 12, width: '64%' } }),
                  jsx(Skeleton, { style: { height: 12, width: '48%' } })
                ]
              })
            : null,
          query.isError && !detail ? jsx('div', { style: S.ghQuiet, children: `Could not load this ${ghKindWord(kind)}.` }) : null,
          failed ? jsx(GhFailure, { data: failed, folder }) : null,
          detail ? jsx(GhDetailThread, { detail, folder, kind, number, onOpen, owner, repo }) : null
        ]
      })
    ]
  })
}

const GRAPH_COMMIT_LOCK_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|flake\.lock|[^/]+\.lock)$/

function graphFileLines(file) {
  let n = 0

  for (const hunk of (file && file.hunks) || []) n += ((hunk && hunk.lines) || []).length

  return n
}

// Collapsed by default when the text carries no signal worth the scroll: binary,
// a lockfile, or a file past 400 lines. Clicking the header still opens it.
function graphFileCollapsed(file) {
  if (!file) return true
  if (file.binary) return true
  if (GRAPH_COMMIT_LOCK_RE.test(String(file.path || ''))) return true

  return graphFileLines(file) > 400
}

function graphCommitFailure(data, folder) {
  const code = String((data && data.code) || '')

  if (code === 'bad_sha') return { detail: '', text: 'Not a valid commit hash' }
  if (code === 'not_found') return { detail: '', text: 'No such commit in this repository' }

  return ghFailureText(data, folder)
}

function graphStatusTone(status) {
  if (status === 'A') return 'var(--ui-diff-add-foreground)'
  if (status === 'D') return 'var(--ui-diff-remove-foreground)'
  if (status === 'R' || status === 'C') return 'var(--ui-accent)'
  if (status === 'T') return 'var(--ui-orange)'

  return 'var(--ui-text-secondary)'
}

function graphTruncatedText(detail) {
  const reason = String((detail && detail.truncated_reason) || '')
  const total = Number((detail && detail.stats && detail.stats.files) || 0) || 0
  const shown = Array.isArray(detail && detail.files) ? detail.files.length : 0
  const hidden = Math.max(0, total - shown)
  const cut =
    reason === 'bytes'
      ? 'Diff cut at 512 KB.'
      : reason === 'lines'
        ? 'Diff cut at 6,000 lines.'
        : reason === 'files'
          ? `Only the first ${shown} files are shown.`
          : 'Diff cut.'

  return hidden > 0 ? `${cut} ${hidden} more ${hidden === 1 ? 'file' : 'files'} not shown.` : cut
}

function GitDiffFile({ file }) {
  const [open, setOpen] = useState(() => !graphFileCollapsed(file))
  const additions = Number(file.additions) || 0
  const deletions = Number(file.deletions) || 0
  const status = String(file.status || 'M').slice(0, 1) || 'M'
  const renamed = file.old_path && file.old_path !== file.path
  // Line numbers are derived here, per hunk, because the payload only carries
  // the hunk starts. A "\ No newline" line belongs to neither side.
  const hunks = (Array.isArray(file.hunks) ? file.hunks : []).map(hunk => {
    let oldNo = Number(hunk.old_start) || 1
    let newNo = Number(hunk.new_start) || 1
    const rows = ((hunk && hunk.lines) || []).map(line => {
      const op = line[0]
      const text = String(line[1] == null ? '' : line[1])
      let old = ''
      let lineNew = ''

      if (op === '+') {
        lineNew = newNo
        newNo += 1
      } else if (op === '-') {
        old = oldNo
        oldNo += 1
      } else if (op === ' ') {
        old = oldNo
        lineNew = newNo
        oldNo += 1
        newNo += 1
      }

      return { new: lineNew, old, op, text }
    })

    return { header: String((hunk && hunk.header) || ''), rows }
  })

  return jsxs('div', {
    children: [
      jsxs('button', {
        className: 'pcc-gh-chip',
        onClick: () => setOpen(value => !value),
        style: S.diffFileHead,
        title: open ? 'Collapse this file' : 'Expand this file',
        type: 'button',
        children: [
          jsx(Codicon, {
            name: open ? 'chevron-down' : 'chevron-right',
            size: '0.75rem',
            style: { flex: 'none', color: 'var(--ui-text-quaternary)' }
          }),
          jsx('span', { style: { ...S.diffStatus, color: graphStatusTone(status) }, children: status }),
          renamed
            ? jsxs('span', {
                style: S.diffPath,
                children: [
                  jsx('span', { style: { color: 'var(--ui-text-quaternary)' }, children: String(file.old_path) }),
                  ' → ',
                  jsx('span', { children: String(file.path || '') })
                ]
              })
            : jsx('span', { style: S.diffPath, title: String(file.path || ''), children: String(file.path || '') }),
          file.binary ? jsx('span', { style: S.diffCount, children: 'binary' }) : null,
          file.truncated && !file.binary ? jsx('span', { style: S.diffCount, children: 'cut' }) : null,
          jsx('span', { style: { ...S.diffCount, color: 'var(--ui-diff-add-foreground)' }, children: `+${additions}` }),
          jsx('span', { style: { ...S.diffCount, color: 'var(--ui-diff-remove-foreground)' }, children: `-${deletions}` })
        ]
      }),
      open
        ? jsx('div', {
            style: S.diffBox,
            children:
              hunks.length === 0
                ? jsx('div', { style: { ...S.graphNote, padding: '4px 8px' }, children: file.binary ? 'Binary file, no text diff' : 'No text diff in this payload' })
                : jsx('div', {
                    className: 'pcc-diff-scroll',
                    style: S.diffScroll,
                    children: hunks.map((hunk, h) =>
                      jsxs(
                        'div',
                        {
                          children: [
                            jsx('div', { style: S.diffHunk, children: hunk.header }),
                            hunk.rows.map((line, i) => {
                              const tone =
                                line.op === '+'
                                  ? {
                                      background: 'var(--ui-diff-add-background)',
                                      borderLeft: '2px solid var(--ui-diff-add-border)',
                                      color: 'var(--ui-diff-add-foreground)'
                                    }
                                  : line.op === '-'
                                    ? {
                                        background: 'var(--ui-diff-remove-background)',
                                        borderLeft: '2px solid var(--ui-diff-remove-border)',
                                        color: 'var(--ui-diff-remove-foreground)'
                                      }
                                    : line.op === '\\'
                                      ? { borderLeft: '2px solid transparent', color: 'var(--ui-text-quaternary)' }
                                      : { borderLeft: '2px solid transparent', color: 'var(--ui-text-secondary)' }

                              return jsxs(
                                'div',
                                {
                                  style: { ...S.diffLine, ...tone },
                                  children: [
                                    jsx('span', {
                                      style: { ...S.diffNo, color: 'inherit', opacity: 0.7 },
                                      children: line.old === '' ? '' : String(line.old)
                                    }),
                                    jsx('span', {
                                      style: { ...S.diffNo, color: 'inherit', opacity: 0.7 },
                                      children: line.new === '' ? '' : String(line.new)
                                    }),
                                    jsx('span', { style: S.diffText, children: line.text === '' ? ' ' : line.text })
                                  ]
                                },
                                `${h}-${i}`
                              )
                            })
                          ]
                        },
                        `hunk-${h}`
                      )
                    )
                  })
          })
        : null
    ]
  })
}

function GitCommitBody({ detail, folder, onOpen }) {
  const numbers = useMemo(() => ghRefNumbers([detail && detail.body]), [detail])
  const refQuery = useQuery({
    enabled: Boolean(folder) && numbers.length > 0,
    queryKey: [QUERY_ROOT, 'github', 'refs', folder, numbers.join(',')],
    queryFn: () =>
      ghRest(`/github/refs?path=${encodeURIComponent(folder)}&numbers=${numbers.join(',')}`).catch(() => null),
    retry: false,
    staleTime: 60000
  })
  const refsData = refQuery.data
  const refs = refsData && refsData.ok && refsData.refs ? refsData.refs : {}
  const decorate = useCallback(children => ghDecorateRefs(children, refs, onOpen, folder), [refs, onOpen, folder])
  const refKey = useMemo(() => Object.keys(refs).sort().join(','), [refs])
  const files = Array.isArray(detail.files) ? detail.files : []
  const stats = detail.stats || {}
  const total = Number(stats.files) || files.length
  const additions = Number(stats.additions) || 0
  const deletions = Number(stats.deletions) || 0
  const parents = Array.isArray(detail.parents) ? detail.parents : []

  return jsxs('div', {
    style: S.ghThread,
    children: [
      jsxs('div', {
        style: S.ghSection,
        children: [
          ghHead('comment', 'Message'),
          detail.body
            ? jsx('div', {
                key: `prose-${refKey || 'none'}`,
                style: S.ghProse,
                children: jsx(MessageTextContent, { decorateText: decorate, media: false, text: String(detail.body) })
              })
            : jsx('div', { style: S.ghQuiet, children: 'No message body.' })
        ]
      }),
      parents.length > 1
        ? jsx('div', { style: S.graphNote, children: 'Changes against the first parent.' })
        : null,
      jsxs('div', {
        style: S.ghSection,
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
            children: [
              ghHead('diff', 'Files changed', total),
              jsx('span', { style: { flex: '1 1 0' } }),
              jsxs('span', {
                style: { ...S.diffCount, fontSize: '0.6875rem', color: 'var(--ui-text-quaternary)' },
                children: [
                  jsx('span', { style: { color: 'var(--ui-diff-add-foreground)' }, children: `+${additions}` }),
                  ' ',
                  jsx('span', { style: { color: 'var(--ui-diff-remove-foreground)' }, children: `-${deletions}` })
                ]
              })
            ]
          }),
          files.length === 0
            ? jsx('div', { style: S.ghQuiet, children: 'No changed files against the first parent.' })
            : files.map((file, i) => jsx(GitDiffFile, { file }, `${file.path || 'file'}-${i}`)),
          detail.truncated ? jsx('div', { style: S.graphNote, children: graphTruncatedText(detail) }) : null
        ]
      })
    ]
  })
}

function GitCommitModal({ depth, entry, folder, onBack, onClose, onOpen, onOpenCommit, owner, repo }) {
  const sha = String(entry.sha || '')
  const query = useQuery({
    enabled: Boolean(folder) && Boolean(sha),
    queryKey: [QUERY_ROOT, 'git', 'commit', folder, sha],
    queryFn: () => ghRest(`/git/commit/${encodeURIComponent(sha)}?path=${encodeURIComponent(folder)}`),
    retry: false,
    staleTime: Infinity,
    gcTime: 300000
  })
  const payload = query.data || null
  const failed = payload && ((payload.code && payload.code !== 'ok') || payload.error) ? payload : null
  const detail = payload && !failed ? payload : null
  const failure = failed ? graphCommitFailure(failed, folder) : null
  const author = (detail && detail.author) || {}
  const committer = (detail && detail.committer) || null
  const authorName = String(author.name || 'unknown')
  const url = detail && detail.on_remote && owner && repo ? `https://github.com/${owner}/${repo}/commit/${detail.sha}` : ''
  const canOpenExternal = Boolean(pluginCtx && pluginCtx.os && typeof pluginCtx.os.openExternal === 'function')
  const copySha = () => {
    if (!detail) return
    Promise.resolve(writeClipboardText(detail.sha)).then(ok => {
      host.notify(ok === false ? { kind: 'warning', message: 'Could not copy the commit hash.' } : { kind: 'success', message: 'Commit hash copied' })
    })
  }
  const openExternal = () => {
    if (!url || !canOpenExternal) return
    Promise.resolve(pluginCtx.os.openExternal(url)).then(ok => {
      if (ok === false) host.notify({ kind: 'warning', message: 'Could not open the browser.' })
    })
  }

  return jsxs(Dialog, {
    onOpenChange: next => {
      if (!next) onClose()
    },
    open: true,
    children: [
      jsxs(DialogContent, {
        style: { maxWidth: 'min(1100px, 94vw)' },
        children: [
          jsxs(DialogHeader, {
            style: S.ghModalHead,
            children: [
              jsxs('div', {
                style: S.ghModalTitleRow,
                children: [
                  depth > 1 && onBack
                    ? jsx('button', {
                        'aria-label': 'Back',
                        className: 'pcc-gh-back',
                        onClick: onBack,
                        style: S.ghBackBtn,
                        title: 'Back',
                        type: 'button',
                        children: jsx(Codicon, { name: 'chevron-left', size: '0.875rem' })
                      })
                    : jsx(Codicon, {
                        name: 'git-commit',
                        size: '0.875rem',
                        style: { flex: 'none', color: 'var(--ui-text-secondary)', paddingTop: 2 }
                      }),
                  jsx('span', { style: S.ghModalNum, children: (detail && detail.short) || sha.slice(0, 7) }),
                  jsx(DialogTitle, { style: S.ghModalTitle, children: (detail && detail.subject) || 'Commit' }),
                  detail && (detail.parents || []).length > 1
                    ? jsx(Badge, { size: 'xs', variant: 'muted', children: 'merge' })
                    : null,
                  detail
                    ? jsxs('button', {
                        className: 'pcc-gh-chip',
                        onClick: copySha,
                        style: S.ghChipBtn,
                        title: 'Copy the full hash',
                        type: 'button',
                        children: ['Copy hash', jsx(Codicon, { name: 'copy', size: '0.6875rem' })]
                      })
                    : null,
                  url && canOpenExternal
                    ? jsxs('button', {
                        className: 'pcc-gh-chip',
                        onClick: openExternal,
                        style: S.ghChipBtn,
                        title: 'View on GitHub',
                        type: 'button',
                        children: ['View on GitHub', jsx(Codicon, { name: 'link-external', size: '0.6875rem' })]
                      })
                    : null
                ]
              }),
              detail
                ? jsxs('div', {
                    style: S.ghModalMeta,
                    children: [
                      jsxs('span', {
                        style: S.ghActorRow,
                        title: `${authorName} <${author.email || ''}>`,
                        children: [
                          jsx(GhMiniAvatar, { login: authorName, size: 16 }),
                          jsx('span', { style: S.ghActor, children: authorName })
                        ]
                      }),
                      jsx('span', {
                        style: S.ghTiny,
                        title: ghWhen(detail.authored_at),
                        children: `authored ${ageText(detail.authored_at)}`
                      }),
                      committer && committer.name !== author.name
                        ? jsx('span', {
                            style: S.ghTiny,
                            title: `${committer.name} <${committer.email}> · ${ghWhen(detail.committed_at)}`,
                            children: `committed by ${committer.name} ${ageText(detail.committed_at)}`
                          })
                        : null,
                      (detail.parents || []).length > 0
                        ? jsxs('span', {
                            style: { display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 },
                            children: [
                              jsx('span', { style: S.ghTiny, children: (detail.parents || []).length === 1 ? 'parent' : 'parents' }),
                              ...(detail.parents || []).map(parent =>
                                jsx(
                                  'button',
                                  {
                                    className: 'pcc-gh-chip',
                                    onClick: () => onOpenCommit && onOpenCommit(String(parent)),
                                    style: {
                                      ...S.ghChipBtn,
                                      fontFamily: 'var(--font-mono, ui-monospace, monospace)'
                                    },
                                    title: String(parent),
                                    type: 'button',
                                    children: String(parent).slice(0, 7)
                                  },
                                  String(parent)
                                )
                              )
                            ]
                          })
                        : null,
                      jsxs('span', {
                        style: S.ghDiff,
                        children: [
                          jsx('span', { style: { color: 'var(--ui-diff-add-foreground)' }, children: `+${Number(detail.stats && detail.stats.additions) || 0}` }),
                          jsx('span', { style: { color: 'var(--ui-diff-remove-foreground)' }, children: `-${Number(detail.stats && detail.stats.deletions) || 0}` }),
                          jsx('span', { children: `in ${Number(detail.stats && detail.stats.files) || 0} files` })
                        ]
                      })
                    ]
                  })
                : null
            ]
          }),
          query.isLoading && !detail
            ? jsxs('div', {
                style: S.ghSection,
                children: [
                  jsx(Skeleton, { style: { height: 12, width: '82%' } }),
                  jsx(Skeleton, { style: { height: 12, width: '64%' } }),
                  jsx(Skeleton, { style: { height: 12, width: '48%' } })
                ]
              })
            : null,
          query.isError && !detail ? jsx('div', { style: S.ghQuiet, children: 'Could not load this commit.' }) : null,
          failed
            ? jsx('div', {
                style: S.ghQuiet,
                title: failure.detail || '',
                children: failure.text
              })
            : null,
          detail ? jsx(GitCommitBody, { detail, folder, onOpen }) : null
        ]
      })
    ]
  })
}

function GhPrRow({ pr, sessions, onIssue, onOpen, flash }) {
  const linked = pr.linked_issues || []
  const look = ghStatusLook('pr', pr)

  return jsxs('div', {
    'data-pr': pr.number,
    className: `pcc-gh-row${flash ? ' pcc-gh-focus' : ''}`,
    style: S.ghRow,
    children: [
      jsxs('div', {
        style: S.ghLine,
        children: [
          jsxs('button', {
            className: 'pcc-gh-title',
            onClick: onOpen,
            style: S.ghTitleBtn,
            title: 'Open the pull request thread',
            type: 'button',
            children: [
              jsx(Codicon, {
                name: look.name,
                size: '0.875rem',
                style: { color: look.color, flex: 'none', paddingTop: 2 }
              }),
              jsx('span', { style: S.ghNum, children: ghNumber(pr.number) }),
              jsx('span', { style: S.ghTitle, children: pr.title || 'Untitled pull request' }),
              jsx(Codicon, {
                name: 'chevron-right',
                size: '0.75rem',
                style: { flex: 'none', color: 'var(--ui-text-quaternary)', paddingTop: 2 }
              })
            ]
          }),
          jsx('span', { style: S.ghAge, title: ghWhen(pr.updated_at), children: ageText(pr.updated_at) })
        ]
      }),
      jsxs('div', {
        style: S.ghMeta,
        children: [
          pr.head_ref ? jsx(BranchChip, { branch: pr.head_ref }) : null,
          pr.draft ? jsx(Badge, { size: 'xs', variant: 'muted', children: 'draft' }) : null,
          jsx(GhChecks, { checks: pr.checks }),
          jsx(GhReview, { decision: pr.review_decision }),
          linked.length > 0 ? jsx(GhIssueChips, { numbers: linked, onIssue }) : null,
          jsx(GhSessions, { row: sessions }),
          jsx('span', { style: S.grow }),
          pr.additions || pr.deletions
            ? jsx('span', {
                style: { fontVariantNumeric: 'tabular-nums' },
                children: `+${pr.additions || 0} -${pr.deletions || 0}`
              })
            : null
        ]
      })
    ]
  })
}

function GhPrSubRow({ pr, sessions, onOpen }) {
  const look = ghStatusLook('pr', pr)

  return jsxs('button', {
    className: 'pcc-gh-sub-btn',
    onClick: onOpen,
    style: S.ghSubBtn,
    title: pr.title,
    type: 'button',
    children: [
      jsx(Codicon, { name: look.name, size: '0.75rem', style: { color: look.color, flex: 'none' } }),
      jsx('span', { style: S.ghNum, children: ghNumber(pr.number) }),
      jsx('span', { style: S.ghSubTitle, children: pr.title || 'Untitled pull request' }),
      jsx(GhSessions, { row: sessions }),
      jsx(GhChecks, { checks: pr.checks }),
      jsx(GhReview, { decision: pr.review_decision })
    ]
  })
}

// ── a session about an issue ─────────────────────────────────────────────────
// The GitHub read is the only surface that knows an issue's repo and number, so
// a click here is the shortest path from "issue" to "a session about it": the
// app opens a fresh session DRAFT, the issue lands in that composer as ordinary,
// editable text, and the caret sits on the blank line underneath it. This path
// sends no turn and writes no board link — there is no stored id at click time,
// so the link row belongs to the hooks on the first turn. Nothing is submitted:
// the user writes the question and presses Enter.

function issueUrl(owner, repo, number) {
  if (!owner || !repo) return ''

  return `https://github.com/${owner}/${repo}/issues/${number}`
}

// Entry points only. The agent reads the issue and its pull requests with its own
// tools, so a truncated body here would only invite it to answer from the
// truncation. Header, one context line, one instruction, then two newlines so
// the caret lands on an empty last line waiting for the user's question.
function issueDraftText({ labels, number, owner, repo, state, title, url }) {
  const link = url || issueUrl(owner, repo, number)
  const name = String(title || '').trim().slice(0, 120)
  const tags = (Array.isArray(labels) ? labels : [])
    .map(label => (typeof label === 'string' ? label : (label && label.name) || ''))
    .filter(Boolean)
    .slice(0, 3)
  const meta = [state ? `state: ${state}` : '', tags.length ? `labels: ${tags.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ')
  const lines = [`#${number} ${name}`.trim(), link, owner && repo ? `repo: ${owner}/${repo}` : '', meta].filter(Boolean)

  return `${lines.join('\n')}\n\nRead this issue and its linked pull requests with gh before you start. Move this card with pcc_set_status.\n\n`
}

// The app's own "new chat" door: a fresh draft in this profile with no session
// id yet. `host.newChat` is the documented verb; the `session.new` app action is
// the fallback for a build that predates it. Used only when a folder is missing.
function openNewChat() {
  const profile = profileParam().profile || null

  if (host && typeof host.newChat === 'function') {
    host.newChat(profile)

    return
  }

  if (pluginCtx && typeof pluginCtx.runAction === 'function') pluginCtx.runAction('session.new')
}

// Write the issue into the fresh session's composer. `'new'` is the draft that
// has no session id yet, answered only by the primary pane while it shows no
// session; `null` is the composer the user is typing in. Both fail closed until
// the new session has painted, so the write runs on a bounded retry schedule and
// the first address that answers true wins. submit() is never called: the text
// is the user's to edit.
function seedDraftText(text) {
  if (!pluginCtx || !host.composer || typeof host.composer.setDraft !== 'function') return Promise.resolve(false)

  const write = () =>
    Promise.resolve(host.composer.setDraft('new', text))
      .then(ok => (ok ? true : host.composer.setDraft(null, text)))
      .catch(() => host.composer.setDraft(null, text))
      .catch(() => false)

  return new Promise(resolve => {
    let attempt = 0

    const run = () => {
      if (pluginDisposed) {
        resolve(false)

        return
      }

      write().then(ok => {
        if (ok) {
          // The caret belongs in the input, on the blank line waiting under the
          // issue: that is where the user's question goes.
          if (typeof host.composer.focus === 'function') host.composer.focus(null)
          resolve(true)

          return
        }

        if (attempt >= DRAFT_RETRY_MS.length) {
          resolve(false)

          return
        }

        // A disposed plugin drops the timer; the caller must still hear back.
        if (!schedule(run, DRAFT_RETRY_MS[attempt])) {
          resolve(false)

          return
        }

        attempt += 1
      })
    }

    run()
  })
}

// Write text into a composer addressed by session id. `openSession` returns
// before the tab has painted its composer, and setDraft fails closed on an
// address no surface answers yet, so the write runs on the bounded retry
// schedule. submit() is never called: the text is the user's to edit.
function seedSessionDraft(sessionId, text) {
  if (!pluginCtx || !host.composer || typeof host.composer.setDraft !== 'function') return Promise.resolve(false)

  return new Promise(resolve => {
    let attempt = 0

    const run = () => {
      if (pluginDisposed) {
        resolve(false)

        return
      }

      Promise.resolve(host.composer.setDraft(sessionId, text))
        .catch(() => false)
        .then(ok => {
          if (ok) {
            if (typeof host.composer.focus === 'function') host.composer.focus(sessionId)
            resolve(true)

            return
          }

          if (attempt >= DRAFT_RETRY_MS.length) {
            resolve(false)

            return
          }

          if (!schedule(run, DRAFT_RETRY_MS[attempt])) {
            resolve(false)

            return
          }

          attempt += 1
        })
    }

    run()
  })
}

// The stock session door: one session.create with an explicit cwd, the app's
// own tab for the returned stored id, then the draft in that session's
// composer. This is the same request core's startSessionInWorkspace makes, so
// it works on a stock Desktop with no SDK patch and no extra install step.
function openSessionInFolder(folder, text) {
  const path = String(folder || '').trim()

  if (!path) return Promise.reject(new Error('No folder to open a session in.'))
  if (!host || typeof host.request !== 'function' || typeof host.openSession !== 'function') {
    return Promise.reject(new Error('This Desktop build cannot open a session in a folder.'))
  }

  let id = ''

  // A session minted over `host.request` rides the ambient gateway, so it carries
  // no owner stamp, and openSession refuses to guess which backend holds it
  // ("Session owner could not be resolved"). Handing the active connection and
  // profile over as an explicit owner route is the exact hint that resolution
  // needs; without it the tab lands on an error screen.
  const ownerRoute = () => {
    let connectionId = ''
    let profile = ''

    try {
      connectionId = String((host.state && host.state.connectionId && host.state.connectionId.get()) || '')
    } catch {
      connectionId = ''
    }

    try {
      profile = String((host.state && host.state.profile && host.state.profile.get()) || '')
    } catch {
      profile = ''
    }

    return connectionId ? { connectionId, profile: profile || 'default' } : null
  }

  return Promise.resolve(
    host.request('session.create', { cwd: path, source: 'gui', cols: 96, cwd_explicit: true, ...profileParam() })
  )
    .then(res => {
      id = String((res && res.stored_session_id) || '').trim()
      if (!id) throw new Error('The new session came back without an id.')

      const route = ownerRoute()
      const options = { intent: 'tab' }

      if (route) options.route = route

      return host.openSession(id, options)
    })
    .then(() => seedSessionDraft(id, text))
    .catch(err => {
      // A created session whose tab or draft failed must not open a second one,
      // and there is no second door to try: this is the only session path the
      // plugin has, and it needs no local Desktop patch.
      throw err
    })
}

// Where a session lands, named the way the user reads it: owner/repo when the
// remote said so, else the folder's own name.
function shortRepoName(owner, name, folder) {
  if (owner && name) return `${owner}/${name}`
  const parts = String(folder || '').split('/').filter(Boolean)

  return parts.length ? parts[parts.length - 1] : ''
}

// One small header and one instruction. The agent reads the branch and the PR
// with its own tools, so nothing here summarizes them.
function branchSessionDraft({ branch, folder, owner, pr, repo, where }) {
  const lines = [`Branch: ${branch}`]
  const repoText = shortRepoName(owner, repo, folder)

  if (repoText) lines.push(`Repo: ${repoText}`)
  if (pr && Number(pr.number)) {
    const title = String(pr.title || '').trim().slice(0, 100)
    lines.push(`PR: #${Number(pr.number)}${title ? ` ${title}` : ''}`)
  }

  return `${lines.join('\n')}\n\n${where}\n\n`
}

// The project header's door: the primary folder, the branch it is on right now,
// and one line of context. It never moves the checkout.
function continueSessionDraft({ branch, folder, owner, repo }) {
  const repoText = shortRepoName(owner, repo, folder)
  const where = [repoText, branch ? `on ${branch}` : ''].filter(Boolean).join(' ')

  return `Continue where we left off${where ? ` in ${where}` : ''}.\n\n`
}

// Both worktree calls are this plugin's own routes on the dashboard backend, the
// same place /branch/switch lives: the renderer needs no Desktop preload bridge,
// only ctx.rest. `null` means "this build cannot list worktrees", which is
// different from an empty list: only an empty list means no worktree exists for
// the branch.
function listWorktrees(folder) {
  if (!pluginCtx || typeof pluginCtx.rest !== 'function') return Promise.resolve(null)

  return boardRest(`/worktrees?path=${encodeURIComponent(folder)}`, { method: 'GET' })
    .then(res => (res && Array.isArray(res.worktrees) ? res.worktrees : []))
}

// The backend's refusal sentence wins: it is the same wording the other git
// states carry, and the dialog shows it as it stands.
function createWorktree(folder, options) {
  return boardRest('/worktree', { method: 'POST', body: { path: folder, ...options } }).then(res => {
    if (!res || res.ok !== true) {
      throw new Error(String((res && res.error) || 'The backend could not create the worktree.'))
    }

    return { branch: String(res.branch || ''), path: String(res.path || '') }
  })
}

function openIssueDraft({ folder, issue, owner, repo }) {
  const text = issueDraftText({
    labels: issue.labels,
    number: Number(issue.number) || 0,
    owner,
    repo,
    state: issue.state,
    title: issue.title,
    url: issue.html_url
  })

  // The anchored door: a session whose cwd is this project's folder, with the
  // text already in its composer. No folder means the board has no anchor to
  // offer, so the detached draft is the only honest door left.
  if (folder) return openSessionInFolder(folder, text)

  openNewChat()

  return seedDraftText(text)
}

function StartSessionButton({ folder, issue, owner, repo }) {
  const [busy, setBusy] = useState(false)

  if (!folder || !issue || !Number(issue.number)) return null

  const start = event => {
    if (event && event.stopPropagation) event.stopPropagation()
    if (busy) return
    setBusy(true)
    openIssueDraft({ folder, issue, owner, repo })
      .then(ok => {
        // The session is open either way; one quiet note only when the text
        // never reached the composer, so the click is never a silent no-op.
        if (!ok) host.notify({ kind: 'info', message: 'New session opened, but the issue text did not reach the composer.' })
      })
      .catch(err =>
        host.notify({
          kind: 'error',
          message: `Could not open a session: ${err && err.message ? err.message : err}`
        })
      )
      .then(() => setBusy(false))
  }

  return jsxs(Button, {
    'aria-label': `Start a new session about issue ${issue.number}`,
    disabled: busy,
    onClick: start,
    size: 'xs',
    title: 'Open a new session with this issue in the composer',
    variant: 'outline',
    children: [
      jsx(Codicon, { name: busy ? 'loading' : 'comment-discussion', size: '0.75rem', spinning: busy }),
      busy ? 'Opening' : 'New session'
    ]
  })
}

function NewSessionButton({ branch, folder, owner, repo }) {
  const [busy, setBusy] = useState(false)
  const draft = continueSessionDraft({ branch, folder, owner, repo })
  const start = () => {
    if (busy || !folder) return
    setBusy(true)
    openSessionInFolder(folder, draft)
      .then(ok => {
        if (!ok) host.notify({ kind: 'info', message: 'The session opened, but the draft did not reach the composer.' })
      })
      .catch(err =>
        host.notify({
          kind: 'error',
          message: `Could not open a session: ${err && err.message ? err.message : err}`
        })
      )
      .then(() => setBusy(false))
  }

  return jsxs(Button, {
    'aria-label': folder ? 'New session in this project folder' : 'New session unavailable',
    disabled: busy || !folder,
    onClick: start,
    size: 'xs',
    title: folder ? `New session in ${folder}` : 'No folder to start a session in.',
    variant: 'outline',
    children: [
      jsx(Codicon, { name: busy ? 'loading' : 'add', size: '0.75rem', spinning: busy }),
      busy ? 'Opening' : 'New session'
    ]
  })
}

function GhIssueRow({ folder, issue, prs, sessionsByBranch, onOpen, onOpenPr, flash, owner, repo }) {
  const labels = issue.labels || []
  const shownLabels = labels.slice(0, 3)
  const restLabels = labels.length - shownLabels.length
  const assignees = issue.assignees || []
  const look = ghStatusLook('issue', issue)

  return jsxs('div', {
    'data-issue': issue.number,
    className: `pcc-gh-row${flash ? ' pcc-gh-focus' : ''}`,
    style: S.ghRow,
    children: [
      jsxs('div', {
        style: S.ghLine,
        children: [
          jsxs('button', {
            className: 'pcc-gh-title',
            onClick: onOpen,
            style: S.ghTitleBtn,
            title: 'Open the issue thread',
            type: 'button',
            children: [
              jsx(Codicon, {
                name: look.name,
                size: '0.875rem',
                style: { color: look.color, flex: 'none', paddingTop: 2 }
              }),
              jsx('span', { style: S.ghNum, children: ghNumber(issue.number) }),
              jsx('span', { style: S.ghTitle, children: issue.title || 'Untitled issue' }),
              jsx(Codicon, {
                name: 'chevron-right',
                size: '0.75rem',
                style: { flex: 'none', color: 'var(--ui-text-quaternary)', paddingTop: 2 }
              })
            ]
          }),
          jsx('span', { style: S.ghAge, title: ghWhen(issue.updated_at), children: ageText(issue.updated_at) })
        ]
      }),
      jsxs('div', {
        style: S.ghMeta,
        children: [
          shownLabels.map((label, i) => jsx('span', { style: S.ghLabel, children: label }, `${label}-${i}`)),
          restLabels > 0 ? jsx('span', { style: { color: 'var(--ui-text-quaternary)' }, children: `+${restLabels}` }) : null,
          assignees.length > 0
            ? jsx(Tip, {
                label: assignees.join(', '),
                children: jsx('span', {
                  style: { display: 'inline-flex' },
                  children: jsx(GhMiniAvatar, {
                    fallback: 'initials',
                    login: assignees[0],
                    src: (issue.assignee_avatars && issue.assignee_avatars[assignees[0]]) || ''
                  })
                })
              })
            : null,
          issue.comments
            ? jsxs('span', {
                style: { display: 'inline-flex', alignItems: 'center', gap: 3 },
                children: [jsx(Codicon, { name: 'comment', size: '0.6875rem' }), issue.comments]
              })
            : null,
          jsx('span', { style: S.grow }),
          // The same action sits in the modal footer, so it is always the same
          // one click from either place.
          jsx(StartSessionButton, { folder, issue, owner, repo }),
          prs.length > 0
            ? jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: `${prs.length} ${prs.length === 1 ? 'PR' : 'PRs'}` })
            : jsx('span', { children: 'no PR' })
        ]
      }),
      prs.length > 0
        ? jsx('div', {
            style: { display: 'flex', flexDirection: 'column' },
            children: prs
              .slice(0, 3)
              .map(pr =>
                jsx(
                  GhPrSubRow,
                  { onOpen: () => onOpenPr(pr.number), pr, sessions: sessionsByBranch.get(pr.head_ref) },
                  pr.number
                )
              )
          })
        : null
    ]
  })
}

function GhBranchRow({ row, currentBranch, onOpenPr, onIssue, onOpenWorktree, onSessionWorktree, onSwitch, onCheckout, onOpenSessionHere }) {
  const local = row.local
  const pr = row.pr
  const running = row.sessions && row.sessions.live > 0
  const current = Boolean(currentBranch) && row.name === currentBranch

  return jsxs('div', {
    className: 'pcc-gh-row',
    style: S.ghRow,
    children: [
      running ? jsx(ArcRing, { radius: '0' }) : null,
      jsxs('div', {
        style: S.ghLine,
        children: [
          jsxs('span', {
            style: { display: 'flex', alignItems: 'center', gap: 7, flex: '1 1 0', minWidth: 0, paddingTop: 1 },
            children: [
              jsx(Codicon, {
                name: 'git-branch',
                size: '0.875rem',
                style: { flex: 'none', color: running ? 'var(--ui-accent)' : 'var(--ui-text-secondary)' }
              }),
              jsx('span', { style: S.ghBranchName, title: row.name, children: row.name }),
              current
                ? jsxs('span', {
                    style: S.ghCurrent,
                    title: 'The main folder is on this branch',
                    children: [jsx('span', { 'aria-hidden': 'true', style: S.ghCurrentDot }), 'current']
                  })
                : null
            ]
          }),
          jsx(GhSessions, { row: row.sessions }),
          // A session door next to the ellipsis: both menus overlap on purpose.
          // The ellipsis stays git actions; this one only ever opens a session.
          jsxs(DropdownMenu, {
            children: [
              jsx(DropdownMenuTrigger, {
                asChild: true,
                children: jsx(Button, {
                  'aria-label': `New session for ${row.name}`,
                  className: 'pcc-branch-session',
                  size: 'xs',
                  style: S.ghSessionBtn,
                  title: current
                    ? `Open a session in the main folder, which is already on ${row.name}`
                    : `Open a session for ${row.name}`,
                  variant: 'ghost',
                  children: [
                    jsx(Codicon, { name: 'add', size: '0.75rem' }),
                    'New session',
                    jsx(Codicon, { name: 'chevron-down', size: '0.625rem' })
                  ]
                })
              }),
              jsx(DropdownMenuContent, {
                align: 'end',
                children: current
                  ? jsx(DropdownMenuItem, {
                      onSelect: () => onOpenSessionHere(row),
                      children: [jsx(Codicon, { name: 'comment-discussion', size: '0.75rem' }), 'Open session on this branch']
                    })
                  : [
                      jsxs(DropdownMenuItem, {
                        onSelect: () => onSessionWorktree(row),
                        children: [jsx(Codicon, { name: 'git-branch', size: '0.75rem' }), 'Open session in a worktree']
                      }),
                      jsxs(DropdownMenuItem, {
                        onSelect: () => onCheckout(row),
                        children: [jsx(Codicon, { name: 'arrow-swap', size: '0.75rem' }), 'Check out here and open a session']
                      })
                    ]
              })
            ]
          }),
          jsxs(DropdownMenu, {
            children: [
              jsx(DropdownMenuTrigger, {
                asChild: true,
                children: jsx(Button, {
                  'aria-label': `Branch actions for ${row.name}`,
                  className: 'pcc-branch-menu',
                  size: 'icon-xs',
                  variant: 'ghost',
                  children: jsx(Codicon, { name: 'ellipsis', size: '0.75rem' })
                })
              }),
              jsx(DropdownMenuContent, {
                align: 'end',
                children: [
                  jsxs(DropdownMenuItem, {
                    onSelect: () => onOpenWorktree(row),
                    children: [jsx(Codicon, { name: 'git-branch', size: '0.75rem' }), 'Open worktree']
                  }),
                  jsxs(DropdownMenuItem, {
                    onSelect: () => onSwitch(row),
                    children: [jsx(Codicon, { name: 'arrow-swap', size: '0.75rem' }), 'Switch branch on the main folder']
                  })
                ]
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        style: { ...S.ghMeta, paddingLeft: 21 },
        children: [
          local && local.upstream ? jsx('span', { style: S.ghTiny, children: local.upstream }) : null,
          local && local.ahead ? jsx('span', { style: S.ghTiny, title: `${local.ahead} commits ahead of upstream`, children: `ahead ${local.ahead}` }) : null,
          local && local.behind ? jsx('span', { style: S.ghTiny, title: `${local.behind} commits behind upstream`, children: `behind ${local.behind}` }) : null,
          pr
            ? jsx('button', {
                className: 'pcc-gh-chip',
                onClick: () => onOpenPr(pr.number),
                style: S.ghChipBtn,
                title: pr.title,
                type: 'button',
                children: `${ghNumber(pr.number)} PR`
              })
            : jsx('span', { style: S.ghTiny, children: 'no PR' }),
          pr && (pr.linked_issues || []).length > 0 ? jsx(GhIssueChips, { numbers: pr.linked_issues, onIssue }) : null,
          local && local.subject ? jsx('span', { style: S.ghSubject, title: local.subject, children: local.subject }) : null,
          local && local.last_commit_at ? jsx('span', { style: S.ghAge, title: ghWhen(local.last_commit_at), children: ageText(local.last_commit_at) }) : null
        ]
      })
    ]
  })
}

const GRAPH_WINDOW_LIMIT = 200
const GRAPH_WIDE_MIN = 760
const GRAPH_LABEL_GUTTER = 148

function graphRefRank(ref) {
  const kind = ref.kind || (ref.is_remote ? 'remote' : ref.is_head ? 'local' : 'local')

  if (kind === 'local') return ref.is_head ? 0 : 1
  if (kind === 'remote') return 2

  return 3
}

function graphSortRefs(list) {
  return [...list].sort(
    (a, b) => graphRefRank(a) - graphRefRank(b) || String(a.short || '').localeCompare(String(b.short || ''))
  )
}

// A local branch and the remote it tracks on the same sha are one fact, so the
// remote pill folds into the local one (which carries the cloud mark).
function graphVisibleRefs(list) {
  const tracked = new Set(
    list.filter(ref => ref.kind === 'local' && ref.upstream).map(ref => String(ref.upstream))
  )

  return list.filter(ref => !(ref.kind === 'remote' && tracked.has(String(ref.short || ''))))
}

function GraphRefPill({ color, compact, ref }) {
  const kind = ref.kind || (ref.is_remote ? 'remote' : 'local')
  const ahead = Number(ref.ahead) || 0
  const behind = Number(ref.behind) || 0
  const upstream = String(ref.upstream || '')
  const icon = kind === 'tag' ? 'tag' : kind === 'remote' ? 'cloud' : ref.is_head ? 'check' : 'git-branch'
  const title = [`${kind} ref ${ref.short || ''}`]

  if (upstream) title.push(`tracks ${upstream}`)
  if (ahead) title.push(`${ahead} ahead`)
  if (behind) title.push(`${behind} behind`)
  if (ref.gone) title.push('upstream gone')
  if (ref.is_head) title.push('HEAD')

  return jsxs('span', {
    style: {
      ...S.graphPill,
      maxWidth: compact ? 112 : 140,
      color: kind === 'tag' || kind === 'remote' ? 'var(--ui-text-tertiary)' : 'var(--ui-text-secondary)',
      borderColor: `color-mix(in srgb, ${color} 55%, transparent)`
    },
    title: title.join(', '),
    children: [
      jsx(Codicon, { name: icon, size: '0.625rem', style: { flex: 'none' } }),
      jsx('span', { style: S.graphPillText, children: String(ref.short || '') }),
      ahead > 0
        ? jsx('span', {
            style: { ...S.graphBadge, color: 'var(--ui-diff-add-foreground)' },
            title: `${ahead} ${ahead === 1 ? 'commit' : 'commits'} ahead of ${upstream || 'upstream'}`,
            children: `↑${ahead}`
          })
        : null,
      behind > 0
        ? jsx('span', {
            style: { ...S.graphBadge, color: 'var(--ui-diff-remove-foreground)' },
            title: `${behind} ${behind === 1 ? 'commit' : 'commits'} behind ${upstream || 'upstream'}`,
            children: `↓${behind}`
          })
        : null,
      ref.gone ? jsx('span', { style: { ...S.graphBadge, color: 'var(--ui-text-quaternary)' }, children: 'gone' }) : null,
      kind === 'local' && upstream && !ref.is_remote
        ? jsx(Codicon, { name: 'cloud', size: '0.5625rem', style: { flex: 'none', opacity: 0.7 } })
        : null
    ]
  })
}

function GitGraphView({ data, error, folder, loading, onOpenCommit }) {
  const boxRef = useRef(null)
  const [wide, setWide] = useState(true)
  const commits = data && Array.isArray(data.commits) ? data.commits : []
  const refs = data && Array.isArray(data.refs) ? data.refs : []

  useEffect(() => {
    const el = boxRef.current

    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(entries => {
      const width = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0
      setWide(width >= GRAPH_WIDE_MIN)
    })
    ro.observe(el)

    return () => ro.disconnect()
  }, [])

  // Layout memoizes on the payload object, which the query replaces only when
  // the fingerprint or the window changed. One pass per fetch, never per render.
  const layout = useMemo(() => {
    if (!commits.length) return null
    try {
      return pccGraphLayout({
        commits,
        default_branch: (data && data.default_branch) || null,
        head: (data && data.head) || null,
        refs
      })
    } catch {
      return null
    }
  }, [data])

  const gutter = wide ? GRAPH_LABEL_GUTTER : 0
  const paths = useMemo(() => {
    if (!layout) return null
    try {
      return pccGraphPaths(layout, { labelGutter: gutter, maxLanes: layout.maxLanes })
    } catch {
      return null
    }
  }, [layout, gutter])

  const refsBySha = useMemo(() => {
    const map = new Map()

    for (const ref of refs) {
      const sha = String(ref.sha || '')
      if (!sha) continue
      const list = map.get(sha) || []
      list.push(ref)
      map.set(sha, list)
    }
    for (const [sha, list] of map) map.set(sha, graphSortRefs(list))

    return map
  }, [data])

  const graphWidth = paths ? paths.width : gutter + 8 + GRAPH_LANE_W * 4
  const laneWidth = graphWidth - gutter
  const failed = data && ((data.code && data.code !== 'ok') || data.error) ? data : null
  const drawn = Boolean(paths) && Boolean(layout) && layout.anomalies === 0

  if (error) {
    const message = String((error && error.message) || error)
    const unloaded = /404|no route|not found|not available/i.test(message)

    return jsx('div', {
      style: S.ghQuiet,
      children: unloaded
        ? 'The graph needs the updated backend. Restart hermes-serve to load it.'
        : 'Could not read the git history for this folder.'
    })
  }

  if (loading) {
    return jsxs('div', {
      style: { ...S.ghSection, paddingTop: 10 },
      children: [
        jsx(Skeleton, { style: { height: 12, width: '82%' } }),
        jsx(Skeleton, { style: { height: 12, width: '64%' } }),
        jsx(Skeleton, { style: { height: 12, width: '48%' } })
      ]
    })
  }

  if (failed) return jsx(GhFailure, { data: failed, folder })
  if (commits.length === 0) return jsx('div', { style: S.ghQuiet, children: 'No commits yet' })

  const rowRefs = commit => {
    const list = graphVisibleRefs(refsBySha.get(String(commit.sha || '')) || [])

    if (list.length === 0 && commit.is_head && data && data.head && data.head.detached) {
      return [{ kind: 'local', short: 'HEAD', is_head: true }]
    }

    return list
  }

  const pills = (list, shown, color) => {
    const visible = list.slice(0, shown)
    const hidden = list.length - visible.length

    return visible
      .map((ref, i) => jsx(GraphRefPill, { color, compact: shown === 1 && list.length > 1, ref }, `${ref.name || ref.short}-${i}`))
      .concat(
        hidden > 0
          ? [
              jsx(
                Tip,
                {
                  label: list
                    .slice(shown)
                    .map(ref => String(ref.short || ''))
                    .join(', '),
                  children: jsx('span', { style: { ...S.graphBadge, color: 'var(--ui-text-quaternary)' }, children: `+${hidden}` })
                },
                `more-${shown}`
              )
            ]
          : []
      )
  }

  return jsxs('div', {
    ref: boxRef,
    style: S.graphWrap,
    children: [
      jsxs('div', {
        className: 'pcc-graph-scroll',
        style: S.graphScroll,
        children: [
          jsxs('div', {
            style: S.graphHeader,
            children: [
              jsx('span', { style: { ...S.graphHeadCell, width: graphWidth }, children: 'Graph' }),
              jsx('span', { style: { ...S.graphHeadCell, flex: '1 1 0' }, children: 'Description' }),
              jsx('span', { style: { ...S.graphHeadCell, width: 86, textAlign: 'right' }, children: 'Date' }),
              wide ? jsx('span', { style: { ...S.graphHeadCell, width: 120 }, children: 'Author' }) : null,
              jsx('span', { style: { ...S.graphHeadCell, width: 62, textAlign: 'right' }, children: 'Commit' })
            ]
          }),
          jsxs('div', {
            style: S.graphRows,
            children: [
              drawn
                ? jsxs('svg', {
                    'aria-hidden': true,
                    style: {
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: graphWidth,
                      height: paths.height,
                      pointerEvents: 'none',
                      overflow: 'visible'
                    },
                    children: [
                      paths.leaders
                        ? jsx('path', {
                            d: paths.leaders,
                            fill: 'none',
                            stroke: 'var(--ui-text-quaternary)',
                            strokeDasharray: '2 3',
                            strokeWidth: 1,
                            style: { stroke: 'var(--ui-text-quaternary)' }
                          })
                        : null,
                      ...Object.entries(paths.byColor).map(([color, d]) =>
                        jsx(
                          'path',
                          {
                            d,
                            fill: 'none',
                            strokeLinecap: 'round',
                            strokeWidth: GRAPH_STROKE,
                            style: { stroke: GRAPH_LANE_COLORS[Number(color)] || 'var(--ui-text-tertiary)' }
                          },
                          `edge-${color}`
                        )
                      ),
                      ...Object.entries(paths.dotsByColor).map(([color, d]) =>
                        jsx(
                          'path',
                          {
                            d,
                            stroke: 'var(--ui-surface-background, var(--ui-bg-editor))',
                            strokeWidth: 1.5,
                            style: { fill: GRAPH_LANE_COLORS[Number(color)] || 'var(--ui-text-tertiary)' }
                          },
                          `dot-${color}`
                        )
                      ),
                      paths.clippedDots
                        ? jsx('path', {
                            d: paths.clippedDots,
                            fill: 'var(--ui-bg-editor)',
                            stroke: 'var(--ui-text-quaternary)',
                            strokeWidth: 1
                          })
                        : null,
                      paths.headRing
                        ? jsx('path', {
                            d: paths.headRing,
                            fill: 'none',
                            strokeWidth: 1,
                            style: { stroke: 'var(--ui-accent)' }
                          })
                        : null
                    ]
                  })
                : null,
              commits.map((commit, i) => {
                const row = layout && layout.rows[i] ? layout.rows[i] : null
                const list = rowRefs(commit)
                const short = String(commit.short || commit.sha || '').slice(0, 7)
                const color = row ? GRAPH_LANE_COLORS[row.color] || 'var(--ui-text-tertiary)' : 'var(--ui-text-tertiary)'

                return jsxs(
                  'button',
                  {
                    'aria-label': `Open commit ${short}`,
                    className: 'pcc-graph-row',
                    onClick: () => onOpenCommit(commit.sha),
                    style: S.graphRowShape,
                    type: 'button',
                    children: [
                      wide
                        ? jsx('span', {
                            style: { ...S.graphGutter, width: gutter },
                            children: pills(list, 1, color)
                          })
                        : null,
                      jsx('span', { style: { ...S.graphLanes, width: laneWidth } }),
                      !wide && list.length
                        ? jsxs('span', {
                            style: { display: 'flex', alignItems: 'center', gap: 3, flex: 'none', maxWidth: '45%', overflow: 'hidden' },
                            children: pills(list, 2, color)
                          })
                        : null,
                      jsx('span', {
                        style: { ...S.graphSubject, fontWeight: commit.is_head ? 500 : 400 },
                        title: commit.subject || '',
                        children: commit.subject || ''
                      }),
                      jsx('span', {
                        style: S.graphDate,
                        title: ghWhen(commit.authored_at),
                        children: ageText(commit.authored_at)
                      }),
                      wide
                        ? jsxs('span', {
                            style: S.graphAuthor,
                            title: `${(commit.author && commit.author.name) || ''} <${(commit.author && commit.author.email) || ''}>`,
                            children: [
                              jsx(GhMiniAvatar, {
                                login: String((commit.author && commit.author.name) || 'unknown'),
                                size: 16
                              }),
                              jsx('span', { style: S.graphAuthorName, children: String((commit.author && commit.author.name) || '') })
                            ]
                          })
                        : jsx('span', {
                            style: { ...S.graphAuthor, width: 26 },
                            title: `${(commit.author && commit.author.name) || ''} <${(commit.author && commit.author.email) || ''}>`,
                            children: jsx(GhMiniAvatar, {
                              login: String((commit.author && commit.author.name) || 'unknown'),
                              size: 16
                            })
                          }),
                      jsx('span', { style: S.graphHash, title: commit.sha, children: short })
                    ]
                  },
                  commit.sha
                )
              })
            ]
          })
        ]
      }),
      layout && layout.anomalies > 0
        ? jsx('div', {
            style: S.graphNote,
            children: `Graph could not be drawn for this history (${layout.anomalies} ${layout.anomalies === 1 ? 'join' : 'joins'} out of order).`
          })
        : null,
      !drawn && (!layout || layout.anomalies === 0)
        ? jsx('div', { style: S.graphNote, children: 'Graph could not be drawn for this history.' })
        : null
    ]
  })
}

// The worktree step shared by both menus: the git action stops at a created
// checkout, the session door carries on into a new session there. A prefilled
// name and base are enough, since worktrees are the dashboard backend's `git
// worktree add -b` under `<mainRoot>/.worktrees/`, not something this renderer
// reimplements. An existing branch is checked out as it is; a branch the clone
// does not have starts from the base shown here.
function WorktreeDialog({ folder, row, onClose, onCreated }) {
  const exists = Boolean(row.local)
  const [name, setName] = useState(row.name)
  // A branch the clone does not have locally still exists on the remote, so the
  // base must name that remote ref. Prefilling the repository name made git
  // answer "invalid reference" for every PR-only branch.
  const [base, setBase] = useState(exists ? row.name : `origin/${row.name}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = () => {
    const clean = name.trim()

    if (busy || !clean) return
    setBusy(true)
    setError('')

    const options = { base: base.trim() || undefined, branch: clean, name: clean }

    createWorktree(folder, options)
      .then(res => {
        const target = String((res && res.path) || '')
        if (!target) throw new Error('git did not return a worktree path.')

        return onCreated(target, res)
      })
      .then(() => onClose())
      .catch(err => setError(String(err && err.message ? err.message : err)))
      .then(() => setBusy(false))
  }

  const enter = event => {
    if (event && event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  return jsx(Dialog, {
    onOpenChange: next => {
      if (!next && !busy) onClose()
    },
    open: true,
    children: jsxs(DialogContent, {
      className: 'max-w-md',
      children: [
        jsxs(DialogHeader, {
          children: [
            jsx(DialogTitle, { children: 'Open worktree' }),
            jsx('div', {
              style: S.branchNote,
              children: `Creates a checkout for ${row.name} under ${folder}/.worktrees.`
            })
          ]
        }),
        jsxs('div', {
          style: S.branchField,
          children: [
            jsx('label', { style: S.branchLabel, children: 'Worktree name' }),
            jsx('input', {
              'aria-label': 'Worktree name',
              autoFocus: true,
              disabled: busy,
              onChange: event => setName(event.target.value),
              onKeyDown: enter,
              style: S.branchInput,
              value: name
            })
          ]
        }),
        jsxs('div', {
          style: S.branchField,
          children: [
            jsx('label', { style: S.branchLabel, children: 'Base branch' }),
            jsx('input', {
              'aria-label': 'Base branch',
              disabled: busy || exists,
              onChange: event => setBase(event.target.value),
              onKeyDown: enter,
              style: S.branchInput,
              title: exists ? 'The branch exists, so the worktree checks it out as it is.' : undefined,
              value: base
            })
          ]
        }),
        jsx('div', {
          style: S.branchNote,
          children: exists
            ? 'This branch exists, so the worktree checks it out as it is.'
            : `A new branch ${name.trim() || row.name} starts from the base branch.`
        }),
        error ? jsx('div', { role: 'alert', style: S.branchError, children: error }) : null,
        jsxs('div', {
          style: S.branchActions,
          children: [
            jsx(Button, { disabled: busy, onClick: onClose, size: 'xs', variant: 'ghost', children: 'Cancel' }),
            jsx(Button, {
              disabled: busy || !name.trim(),
              onClick: submit,
              size: 'xs',
              variant: 'default',
              children: busy ? 'Creating' : 'Open worktree'
            })
          ]
        })
      ]
    })
  })
}

// A switch moves the checkout underneath whatever is open in that folder, so an
// idle session asks first. A running session is blocked before this dialog.
function SwitchBranchDialog({ idle, onClose, onConfirm, row }) {
  return jsx(Dialog, {
    onOpenChange: next => {
      if (!next) onClose()
    },
    open: true,
    children: jsxs(DialogContent, {
      className: 'max-w-md',
      children: [
        jsx(DialogHeader, { children: jsx(DialogTitle, { children: 'Switch branch?' }) }),
        jsx('div', {
          style: S.branchNote,
          children: `${idle} idle ${idle === 1 ? 'session is' : 'sessions are'} open in this folder. Switching moves the checkout underneath ${idle === 1 ? 'it' : 'them'}.`
        }),
        jsxs('div', {
          style: S.branchActions,
          children: [
            jsx(Button, { onClick: onClose, size: 'xs', variant: 'ghost', children: 'Cancel' }),
            jsx(Button, {
              onClick: () => onConfirm(row),
              size: 'xs',
              variant: 'default',
              children: `Switch to ${row.name}`
            })
          ]
        })
      ]
    })
  })
}

function GithubSection({ folder, mainSessions = [], projectId, sessionsByBranch }) {
  const preset = useValue($ghPreset)
  // The detail modal's navigation stack: issue and PR entries carry {kind,
  // number}; a commit entry carries {kind:'commit', sha}. Last entry on screen.
  // A #123 chip pushes, Back pops, closing empties it, and the whole thing lives
  // here so a row, a chip and a review all reach the same door.
  const [stack, setStack] = useState([])
  const [focus, setFocus] = useState(null)
  const [flash, setFlash] = useState(null)
  const [spin, setSpin] = useState(false)
  const [diagOpen, setDiagOpen] = useState(false)
  // Branch row actions: one worktree modal, one switch confirmation. Both live
  // here so every row reaches the same instance.
  const [worktreeRow, setWorktreeRow] = useState(null)
  const [worktreeOpensSession, setWorktreeOpensSession] = useState(false)
  const [switchRow, setSwitchRow] = useState(null)
  const [switchIdle, setSwitchIdle] = useState(0)
  const [switchOpensSession, setSwitchOpensSession] = useState(false)
  // One tick set per tab, cumulative by union: Open only by default, and a
  // second tick ADDS its rows to the same list instead of replacing them.
  const [statusTicks, setStatusTicks] = useState({ issue: ['open'], pr: ['open'] })
  const forceRef = useRef(0)
  const rootRef = useRef(null)
  // A poke is an atom, not an event: a section that mounts after one (navigating
  // into the project page) must not replay that poke's forced read on mount.
  const mountedAt = useRef(Date.now())
  const path = `path=${encodeURIComponent(folder || '')}`
  const fresh = () => (forceRef.current ? '&refresh=1' : '')
  const toggleStatus = (kind, id) =>
    setStatusTicks(prev => {
      const current = prev[kind] || []
      const next = current.includes(id) ? current.filter(tick => tick !== id) : [...current, id]

      return { ...prev, [kind]: next }
    })

  const repoQuery = useQuery({
    enabled: Boolean(folder),
    queryKey: [QUERY_ROOT, 'repo', folder],
    queryFn: () => ghRest(`/repo?${path}`),
    retry: false,
    staleTime: 20000
  })

  const boardQuery = useQuery({
    enabled: Boolean(folder),
    queryKey: [QUERY_ROOT, 'github', 'all', folder],
    queryFn: () => ghRest(`/github?${path}&state=all&limit=${GH_LIMIT}${fresh()}`),
    retry: false,
    staleTime: 30000
  })

  // Local git, not GitHub: this query is the tab's only dependency, which is why
  // the graph body renders before the GitHub gates below. It is enabled only on
  // the Graph preset, and a forced refresh asks git to skip its fingerprint hit.
  const graphQuery = useQuery({
    enabled: Boolean(folder) && preset === 'graph',
    queryKey: [QUERY_ROOT, 'git', 'graph', folder],
    queryFn: () => ghRest(`/git/graph?${path}&limit=${GRAPH_WINDOW_LIMIT}${fresh()}`),
    retry: false,
    staleTime: 15000
  })

  // Only runs when the panel is open: /diagnose probes GitHub once per available
  // credential, so it is not something a passing board read should pay for.
  const diagQuery = useQuery({
    enabled: Boolean(folder) && diagOpen,
    queryKey: [QUERY_ROOT, 'diagnose', folder],
    queryFn: () => ghRest(`/diagnose?path=${encodeURIComponent(folder || '')}`),
    retry: false,
    staleTime: 5000
  })

  const data = boardQuery.data || null
  const repo = repoQuery.data || null
  const issues = useMemo(() => (data && data.issues) || [], [data])
  const prs = useMemo(() => (data && data.prs) || [], [data])
  const linkedPrs = useMemo(() => ghLinkedPrMap(prs), [prs])
  const branchRows = useMemo(
    () => ghBranchRows({ branches: (repo && repo.branches) || [], prs, sessionsByBranch }),
    [repo, prs, sessionsByBranch]
  )
  // The main folder's checked-out branch. A detached HEAD reports its sha as
  // `branch`, so nothing may claim to be current there.
  const currentBranch = repo && !repo.detached ? String(repo.branch || '') : ''

  // Scroll the requested issue or pull request into view once the preset that
  // renders it has painted, then flash it so the jump is legible.
  useEffect(() => {
    if (!focus) return undefined
    const root = rootRef.current
    const selector =
      focus.kind === 'issue' ? `[data-issue="${Number(focus.number) || 0}"]` : `[data-pr="${Number(focus.number) || 0}"]`
    const el = root && root.querySelector(selector)

    if (!el) return undefined
    if (el.scrollIntoView) {
      el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    }

    setFlash({ kind: focus.kind, number: focus.number })
    schedule(() => setFlash(null), 1500)

    return undefined
  }, [focus, preset])

  const refresh = () => {
    forceRef.current = 1
    setSpin(true)
    // One request per press: the graph does not need a GitHub read, and the
    // GitHub list does not need git.
    if (preset === 'graph') {
      graphQuery.refetch()
    } else {
      boardQuery.refetch()
    }
    schedule(() => {
      forceRef.current = 0
      setSpin(false)
    }, 1200)
  }

  // A board.changed event naming a pull request for THIS project: the same
  // forced read the refresh button does, plus the flash the issue/PR jumps
  // already use. `poke.at` makes two pokes for the same row distinct, and a poke
  // older than this mount is history — the atom outlives the section.
  const poke = useValue($ghPoke)
  const pokeAt = poke && poke.at

  useEffect(() => {
    if (!pokeAt || !poke || !projectId || poke.project_id !== projectId) return undefined
    if (pokeAt <= mountedAt.current) return undefined

    forceRef.current = 1
    setSpin(true)
    if (preset === 'graph') {
      graphQuery.refetch()
    } else {
      boardQuery.refetch()
    }
    setFlash({ kind: 'pr', number: poke.pr })

    schedule(() => {
      forceRef.current = 0
      setSpin(false)
    }, 1200)
    schedule(() => setFlash(null), 2000)

    return undefined
  }, [pokeAt])

  const openEntry = useCallback((kind, number) => {
    const entry = { kind: kind === 'pr' ? 'pr' : 'issue', number: Number(number) || 0 }

    if (!entry.number) return
    setStack(prev => {
      const last = prev[prev.length - 1]

      return last && last.kind === entry.kind && last.number === entry.number ? prev : [...prev, entry]
    })
  }, [])
  const backEntry = useCallback(() => setStack(prev => prev.slice(0, -1)), [])
  const closeEntry = useCallback(() => setStack([]), [])
  // A commit entry is its own shape: {kind:'commit', sha}. Issue and PR entries
  // keep {kind, number} exactly as they were, so their modal is untouched.
  const openCommit = useCallback(sha => {
    const id = String(sha || '')

    if (!/^[0-9a-fA-F]{7,40}$/.test(id)) return
    setStack(prev => {
      const last = prev[prev.length - 1]

      return last && last.kind === 'commit' && last.sha === id ? prev : [...prev, { kind: 'commit', sha: id }]
    })
  }, [])
  const currentEntry = stack.length > 0 ? stack[stack.length - 1] : null

  // Jumps from a row's linked chips stay list jumps (they also retarget the
  // preset); only the modal's own chips push onto its stack.
  // A jump has to land: tick the status the target carries so it is on screen,
  // keeping whatever was already ticked (the union only grows).
  const revealStatus = (kind, row) => {
    if (!row) return
    const bucket = ghStatusBuckets(kind, row)[0]
    setStatusTicks(prev =>
      (prev[kind] || []).includes(bucket) ? prev : { ...prev, [kind]: [...(prev[kind] || []), bucket] }
    )
  }

  const goIssue = number => {
    revealStatus('issue', issues.find(issue => issue.number === number))
    writeGhPreset('issues')
    setFocus({ kind: 'issue', number, at: Date.now() })
  }

  const goPr = number => {
    revealStatus('pr', prs.find(pr => pr.number === number))
    writeGhPreset('prs')
    setFocus({ kind: 'pr', number, at: Date.now() })
  }

  const flashFor = (kind, number) => Boolean(flash && flash.kind === kind && flash.number === number)

  const ownerRepo = data && data.owner && data.repo ? `${data.owner}/${data.repo}` : repo && repo.owner && repo.repo ? `${repo.owner}/${repo.repo}` : ''
  // The issue rows need the two halves separately to build a URL and a link row.
  const ownerName = (data && data.owner) || (repo && repo.owner) || ''
  const repoName = (data && data.repo) || (repo && repo.repo) || ''
  const repoUrl = (data && data.url) || (ownerRepo ? `https://github.com/${ownerRepo}` : '')
  const canOpenExternal = Boolean(pluginCtx && pluginCtx.os && typeof pluginCtx.os.openExternal === 'function')
  const openRepo = () => {
    if (!repoUrl) return
    Promise.resolve(pluginCtx.os.openExternal(repoUrl)).then(ok => {
      if (ok === false) host.notify({ kind: 'warning', message: 'Could not open the browser.' })
    })
  }

  // Every branch action ends in the same door: a session in a folder, with a
  // draft that names the branch. Failures are one toast, never a silent click.
  const startBranchSession = (target, draft) =>
    openSessionInFolder(target, draft)
      .then(ok => {
        if (!ok) host.notify({ kind: 'info', message: 'The session opened, but the draft did not reach the composer.' })

        return ok
      })
      .catch(err => {
        host.notify({
          kind: 'error',
          message: `Could not open a session: ${err && err.message ? err.message : err}`
        })

        return false
      })

  const branchDraft = (row, where, target) =>
    branchSessionDraft({
      branch: row.name,
      folder: target || folder,
      owner: ownerName,
      pr: row.pr,
      repo: repoName,
      where
    })

  // A branch already checked out here has no worktree to make: the main folder
  // IS that checkout, so the session opens where the work already is.
  const openSessionOnMain = row => {
    if (!folder) return Promise.resolve(false)

    return startBranchSession(folder, branchDraft(row, 'Continue on this branch in the main folder.'))
  }

  // The session door's worktree choice: an existing checkout is reused, a new
  // one is created through the dialog, and both end in an opened session.
  const openWorktreeFor = row => {
    if (!folder) return
    if (currentBranch && row.name === currentBranch) {
      openSessionOnMain(row)

      return
    }

    listWorktrees(folder)
      .catch(() => null)
      .then(rows => {
        const existing = (rows || []).find(tree => tree && tree.branch === row.name && tree.path)

        if (existing) {
          return startBranchSession(existing.path, branchDraft(row, 'Continue on this branch in the worktree.', existing.path))
        }

        setWorktreeOpensSession(true)
        setWorktreeRow(row)

        return null
      })
  }

  // The ellipsis stays a git action: it makes the checkout and says so, but it
  // never opens a session. The session door beside it owns that job.
  const openWorktreeHere = row => {
    if (!folder) return
    if (currentBranch && row.name === currentBranch) {
      host.notify({ kind: 'info', message: 'That branch is already checked out in the main folder.' })

      return
    }

    listWorktrees(folder)
      .catch(() => null)
      .then(rows => {
        const existing = (rows || []).find(tree => tree && tree.branch === row.name && tree.path)

        if (existing) {
          host.notify({ kind: 'info', message: `A worktree for ${row.name} already exists at ${existing.path}.` })

          return null
        }

        setWorktreeOpensSession(false)
        setWorktreeRow(row)

        return null
      })
  }

  const runSwitch = (row, openSession) => {
    setSwitchRow(null)
    ghRest('/branch/switch', { method: 'POST', body: { branch: row.name, path: folder } })
      .then(res => {
        if (!res || res.ok !== true) {
          // The route's own sentence, never a second wording for the same state.
          host.notify({ kind: 'error', message: String((res && res.error) || 'Could not switch branch.') })

          return false
        }

        if (res.warning) host.notify({ kind: 'warning', message: String(res.warning) })
        queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, 'repo', folder] })

        if (!openSession) {
          host.notify({ kind: 'success', message: `Switched to ${String(res.branch || row.name)}.` })

          return true
        }

        return startBranchSession(folder, branchDraft(row, 'Continue on this branch in the main folder.'))
      })
      .catch(err =>
        host.notify({
          kind: 'error',
          message: `Could not switch branch: ${err && err.message ? err.message : err}`
        })
      )
  }

  // A running turn in this folder is a hard stop: the checkout would move under
  // a live agent. An idle session still asks, since its tab is on the old
  // branch. No live session at all switches straight away.
  const switchBranch = (row, openSession) => {
    if (!folder) return
    if ((mainSessions || []).some(s => s && s.running)) {
      host.notify({
        kind: 'warning',
        message: 'A session is running in this folder. Wait for it to finish before switching branches.'
      })

      return
    }

    const idle = (mainSessions || []).length

    if (idle > 0) {
      setSwitchIdle(idle)
      setSwitchOpensSession(Boolean(openSession))
      setSwitchRow(row)

      return
    }

    runSwitch(row, Boolean(openSession))
  }

  const boardFailed = Boolean(boardQuery.error) && !data
  const loading = boardQuery.isLoading && !data
  // An older backend reports only `error`; a current one adds a code. Either way
  // a normal condition renders one quiet line, never the error box.
  const boardFailure = data && ((data.code && data.code !== 'ok') || data.error) ? data : null
  // Open issues with no PR: unchanged meaning after the closed half arrived, so
  // the count is taken over open rows only.
  const withoutPr = issues.filter(i => String(i.state || 'open').toLowerCase() === 'open' && !linkedPrs.has(i.number)).length

  const groupLabel = (text, count) =>
    jsxs('div', {
      style: S.ghGroup,
      children: [jsx('span', { children: text }), count != null ? jsx('span', { style: S.count, children: count }) : null]
    })

  // The filter row: one dense line of toggles under the tab strip, on the two
  // tabs a status can cut. Cumulative by union, never a request.
  const statusRow = kind => {
    const options = GH_STATUS_FILTERS[kind] || []
    const ticks = statusTicks[kind] || []
    const shown = ghFilterRows(kind, kind === 'pr' ? prs : issues, ticks).length
    const all = (kind === 'pr' ? prs : issues).length

    return jsxs('div', {
      'aria-label': kind === 'pr' ? 'Pull request status filters' : 'Issue status filters',
      role: 'group',
      style: S.ghFilters,
      children: [
        ...options.map(option =>
          jsxs(
            'button',
            {
              'aria-pressed': ticks.includes(option.id),
              className: `pcc-gh-filter${ticks.includes(option.id) ? ' is-on' : ''}`,
              onClick: () => toggleStatus(kind, option.id),
              style: ticks.includes(option.id)
                ? { ...S.ghFilterBtn, ...S.ghFilterOn, color: GH_STATUS_COLORS[option.id] || 'var(--ui-text-secondary)' }
                : S.ghFilterBtn,
              title: `${ticks.includes(option.id) ? 'Hide' : 'Show'} ${option.label.toLowerCase()}`,
              type: 'button',
              children: option.label
            },
            `${kind}-${option.id}`
          )
        ),
        jsx('span', { style: S.grow }),
        jsx('span', {
          style: S.ghFilterCount,
          children: shown === all ? `${all}` : `${shown} of ${all}`
        })
      ]
    })
  }

  const prView = () => {
    const rows = ghFilterRows('pr', prs, statusTicks.pr).sort(
      (a, b) => stampMs(b.updated_at) - stampMs(a.updated_at)
    )
    const empty =
      (statusTicks.pr || []).length === 0
        ? 'No pull requests'
        : `No ${(statusTicks.pr || [])
            .map(id => (GH_STATUS_FILTERS.pr.find(option => option.id === id) || {}).label || id)
            .join(' or ')
            .toLowerCase()} pull requests`

    return jsxs('div', {
      style: S.ghList,
      children: [
        rows.length === 0
          ? jsx('div', { style: S.ghQuiet, children: empty })
          : rows.map(pr =>
              jsx(
                GhPrRow,
                {
                  flash: flashFor('pr', pr.number),
                  onIssue: goIssue,
                  onOpen: () => openEntry('pr', pr.number),
                  pr,
                  sessions: sessionsByBranch.get(pr.head_ref)
                },
                pr.number
              )
            ),
        withoutPr > 0
          ? jsx('div', {
              style: { paddingTop: 6 },
              children: jsxs('button', {
                className: 'pcc-gh-linkbtn',
                onClick: () => writeGhPreset('issues'),
                style: S.ghLinkBtn,
                type: 'button',
                children: [
                  `${withoutPr} open ${withoutPr === 1 ? 'issue' : 'issues'} with no pull request`,
                  jsx(Codicon, { name: 'arrow-right', size: '0.75rem' })
                ]
              })
            })
          : null
      ]
    })
  }

  const issueView = () => {
    const rows = ghFilterRows('issue', issues, statusTicks.issue).sort(
      (a, b) =>
        (linkedPrs.has(b.number) ? 1 : 0) - (linkedPrs.has(a.number) ? 1 : 0) || stampMs(b.updated_at) - stampMs(a.updated_at)
    )
    const empty =
      (statusTicks.issue || []).length === 0
        ? 'No issues'
        : `No ${(statusTicks.issue || [])
            .map(id => (GH_STATUS_FILTERS.issue.find(option => option.id === id) || {}).label || id)
            .join(' or ')
            .toLowerCase()} issues`

    return jsxs('div', {
      style: S.ghList,
      children: [
        rows.length === 0
          ? jsx('div', { style: S.ghQuiet, children: empty })
          : rows.map(issue =>
              jsx(
                GhIssueRow,
                {
                  flash: flashFor('issue', issue.number),
                  folder,
                  issue,
                  onOpen: () => openEntry('issue', issue.number),
                  onOpenPr: goPr,
                  owner: ownerName,
                  prs: linkedPrs.get(issue.number) || [],
                  repo: repoName,
                  sessionsByBranch
                },
                issue.number
              )
            )
      ]
    })
  }

  const branchView = () => {
    const rows = branchRows.slice(0, BRANCH_CAP)
    const hidden = branchRows.length - rows.length

    return jsxs('div', {
      style: S.ghList,
      children: [
        rows.length === 0
          ? jsx('div', { style: S.ghQuiet, children: 'No branches to join against yet' })
          : rows.map(row =>
              jsx(
                GhBranchRow,
                {
                  currentBranch,
                  onCheckout: row => switchBranch(row, true),
                  onIssue: goIssue,
                  onOpenPr: goPr,
                  onOpenSessionHere: openSessionOnMain,
                  onOpenWorktree: openWorktreeHere,
                  onSessionWorktree: openWorktreeFor,
                  onSwitch: row => switchBranch(row, false),
                  row
                },
                row.name
              )
            ),
        hidden > 0 ? jsx('div', { style: S.ghQuiet, children: `${hidden} more branches` }) : null
      ]
    })
  }

  const unlinkedView = () => {
    const branchEntries = [...sessionsByBranch.entries()]
      .filter(([name]) => !prs.some(pr => pr.head_ref === name))
      .sort(
        (a, b) =>
          (b[1].live > 0 ? 1 : 0) - (a[1].live > 0 ? 1 : 0) || b[1].count - a[1].count || a[0].localeCompare(b[0])
      )
    const prsNoIssue = prs.filter(
      pr => String(pr.state || 'open').toLowerCase() === 'open' && (pr.linked_issues || []).length === 0
    )

    return jsxs('div', {
      style: S.ghList,
      children: [
        groupLabel('Sessions with no pull request', branchEntries.length),
        branchEntries.length === 0
          ? jsx('div', { style: S.ghQuiet, children: 'Every branch with sessions has a pull request' })
          : branchEntries.map(([name, row]) =>
              jsxs(
                'div',
                {
                  style: S.ghRow,
                  children: [
                    jsxs('div', {
                      style: { ...S.ghLine, padding: '2px 0' },
                      children: [
                        jsx(Codicon, {
                          name: 'git-branch',
                          size: '0.8125rem',
                          style: { flex: 'none', color: 'var(--ui-text-secondary)' }
                        }),
                        jsx('span', { style: S.ghBranchName, title: name, children: name }),
                        jsx(GhSessions, { row }),
                        jsx('span', { style: S.grow }),
                        jsx('span', { style: S.ghTiny, children: 'no PR' })
                      ]
                    })
                  ]
                },
                name
              )
            ),
        groupLabel('Pull requests with no issue', prsNoIssue.length),
        prsNoIssue.length === 0
          ? jsx('div', { style: S.ghQuiet, children: 'Every open pull request names an issue' })
          : prsNoIssue.map(pr =>
              jsx(
                GhPrRow,
                {
                  flash: flashFor('pr', pr.number),
                  onIssue: goIssue,
                  onOpen: () => openEntry('pr', pr.number),
                  pr,
                  sessions: sessionsByBranch.get(pr.head_ref)
                },
                pr.number
              )
            )
      ]
    })
  }

  const diagnoseView = () => {
    if (!diagOpen) return null
    const head = text =>
      jsxs('div', {
        style: S.ghDiagHead,
        children: [jsx(Codicon, { name: 'pulse', size: '0.75rem' }), text]
      })

    if (diagQuery.isLoading && !diagQuery.data) {
      return jsxs('div', {
        style: S.ghDiag,
        children: [head('Diagnose'), jsx('span', { style: S.ghDiagNote, children: 'Reading the folder, git and both credentials...' })]
      })
    }
    if (diagQuery.error && !diagQuery.data) {
      const message = diagQuery.error.message || String(diagQuery.error)

      return jsxs('div', {
        style: S.ghDiag,
        children: [head('Diagnose'), jsx('span', { style: S.ghDiagNote, children: `Could not diagnose this folder: ${message}` })]
      })
    }

    const info = diagQuery.data || {}
    const folderInfo = info.folder || {}
    const git = info.git || {}
    const token = info.token || {}
    const ghInfo = info.gh || {}
    const probe = info.probe || {}
    const rows = []
    const add = (key, value) => {
      if (value != null && value !== '') rows.push([key, String(value)])
    }

    add('Folder', folderInfo.exists ? (folderInfo.is_dir ? 'exists' : 'not a directory') : 'missing')
    add('Git root', git.root || 'none')
    add('Root matches path', git.matches ? 'yes' : 'no')
    add('Branch', git.branch || '-')
    add('Remote', git.remote || 'none')
    add('Token', token.present ? `present, length ${token.length_bucket}` : 'absent')
    add('gh user', ghInfo.authenticated ? ghInfo.user : ghInfo.available ? 'installed, not signed in' : 'not installed')
    if (git.error) add('Git error', git.error)
    if (ghInfo.error) add('gh error', ghInfo.error)
    add(
      'Probe',
      probe.code === 'ok'
        ? `HTTP ${probe.status} via ${probe.via}`
        : `${probe.code || 'no probe'}${probe.status ? `, HTTP ${probe.status}` : ''}`
    )
    for (const attempt of probe.attempts || []) {
      add(
        `Probe via ${attempt.via}`,
        attempt.code === 'ok'
          ? `HTTP ${attempt.status}, reachable`
          : `${attempt.message}${attempt.status ? ` (HTTP ${attempt.status})` : ''}`
      )
    }

    return jsxs('div', {
      style: S.ghDiag,
      children: [
        head('Diagnose'),
        rows.map(([key, value]) =>
          jsxs(
            'div',
            {
              style: S.ghDiagRow,
              children: [
                jsx('span', { style: S.ghDiagKey, children: key }),
                jsx('span', { style: S.ghDiagValue, children: value })
              ]
            },
            key
          )
        ),
        probe.message ? jsx('span', { style: S.ghDiagNote, children: probe.message }) : null
      ]
    })
  }

  // Local git only: this branch is chosen before the backend, loading and
  // board-failure gates, because none of those should be able to hide history
  // that `git` can read without GitHub.
  const graphView = () =>
    jsx(GitGraphView, {
      data: graphQuery.data || null,
      error: graphQuery.error,
      folder,
      loading: graphQuery.isLoading && !graphQuery.data,
      onOpenCommit: openCommit
    })

  let body

  if (preset === 'graph') {
    body = graphView()
  } else if (boardFailed) {
    body = jsx('div', {
      style: S.ghErrorWrap,
      children: jsx(ErrorState, {
        className: 'pcc-gh-error',
        description: jsx('span', {
          style: { fontSize: '0.75rem', color: 'var(--ui-text-quaternary)', maxWidth: 520 },
          children:
            'This section reads /github and /repo under /api/plugins/project-command-center. The rest of the page keeps working.'
        }),
        icon: jsx(Codicon, { name: 'error', size: '1rem', style: { color: 'var(--ui-text-quaternary)' } }),
        title: jsx('span', {
          style: { fontSize: '0.8125rem', fontWeight: 600, color: 'var(--ui-text-secondary)' },
          children: 'GitHub backend not available yet'
        })
      })
    })
  } else if (loading) {
    body = jsx(GhSkeleton, {})
  } else if (boardFailure) {
    body = jsx(GhFailure, { data: boardFailure, folder })
  } else if (preset === 'issues') {
    body = issueView()
  } else if (preset === 'branches') {
    body = branchView()
  } else if (preset === 'unlinked') {
    body = unlinkedView()
  } else {
    body = prView()
  }

  return jsxs('section', {
    'aria-label': 'On GitHub',
    ref: rootRef,
    style: S.ghSection,
    children: [
      jsxs('div', {
        style: S.ghHead,
        children: [
          jsx('span', { style: S.stripTitle, children: 'On GitHub' }),
          ownerRepo
            ? canOpenExternal
              ? jsxs('button', {
                  className: 'pcc-gh-chip',
                  onClick: openRepo,
                  style: S.ghRepoBtn,
                  title: `Open ${ownerRepo} on GitHub`,
                  type: 'button',
                  children: [ownerRepo, jsx(Codicon, { name: 'link-external', size: '0.6875rem' })]
                })
              : jsx('span', { style: S.ghRepoText, children: ownerRepo })
            : null,
          data && data.auth === 'none'
            ? jsx(Tip, {
                label: 'No token and no signed in gh CLI. Only public reads work.',
                children: jsx(Badge, { size: 'xs', variant: 'warn', children: 'unauthenticated' })
              })
            : null,
          jsx('span', { style: S.grow }),
          jsx(Tip, {
            label: preset === 'graph' ? 'Refresh history' : 'Refresh GitHub',
            children: jsx(Button, {
              'aria-label': preset === 'graph' ? 'Refresh history' : 'Refresh GitHub',
              disabled: spin,
              onClick: refresh,
              size: 'icon-xs',
              variant: 'ghost',
              children: jsx(Codicon, { name: 'refresh', size: '0.8125rem', spinning: spin })
            })
          }),
          jsxs(DropdownMenu, {
            children: [
              jsx(DropdownMenuTrigger, {
                asChild: true,
                children: jsx(Button, {
                  'aria-label': 'GitHub section actions',
                  size: 'icon-xs',
                  variant: 'ghost',
                  children: jsx(Codicon, { name: 'ellipsis', size: '0.875rem' })
                })
              }),
              jsx(DropdownMenuContent, {
                align: 'end',
                children: jsx(DropdownMenuItem, {
                  onSelect: () => setDiagOpen(open => !open),
                  children: [
                    jsx(Codicon, { name: 'pulse', size: '0.75rem' }),
                    diagOpen ? 'Hide diagnose' : 'Diagnose'
                  ]
                })
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        style: S.ghToolbar,
        children: [
          jsx(SegmentedControl, {
            onChange: writeGhPreset,
            options: GH_PRESETS,
            sizing: 'content',
            value: preset
          }),
          jsx('span', { style: S.grow }),
          preset === 'graph'
            ? graphQuery.data && graphQuery.data.ok !== false && Array.isArray(graphQuery.data.commits)
              ? jsx('span', {
                  style: S.count,
                  children: `${graphQuery.data.commits.length} commits${graphQuery.data.truncated ? ', more history' : ''}`
                })
              : null
            : data && data.counts
              ? jsx(GhTotals, { counts: data.counts })
              : null
        ]
      }),
      preset === 'issues' || preset === 'prs'
        ? data && !boardFailure
          ? statusRow(preset === 'issues' ? 'issue' : 'pr')
          : null
        : null,
      diagnoseView(),
      body,
      currentEntry
        ? currentEntry.kind === 'commit'
          ? jsx(
              GitCommitModal,
              {
                depth: stack.length,
                entry: currentEntry,
                folder,
                onBack: backEntry,
                onClose: closeEntry,
                onOpen: openEntry,
                onOpenCommit: openCommit,
                owner: ownerName,
                repo: repoName
              },
              `commit-${currentEntry.sha}`
            )
          : jsx(
              GhDetailModal,
              {
                depth: stack.length,
                entry: currentEntry,
                folder,
                onBack: backEntry,
                onClose: closeEntry,
                onOpen: openEntry,
                owner: ownerName,
                repo: repoName
              },
              `${currentEntry.kind}-${currentEntry.number}`
            )
        : null,
      worktreeRow
        ? jsx(WorktreeDialog, {
            folder,
            onClose: () => setWorktreeRow(null),
            onCreated: (target, res) => {
              if (!worktreeOpensSession) {
                host.notify({ kind: 'success', message: `Worktree created at ${target}` })

                return target
              }

              return startBranchSession(
                target,
                branchSessionDraft({
                  branch: String((res && res.branch) || worktreeRow.name),
                  folder: target,
                  owner: ownerName,
                  pr: worktreeRow.pr,
                  repo: repoName,
                  where: 'Continue on this branch in the new worktree.'
                })
              )
            },
            row: worktreeRow
          })
        : null,
      switchRow
        ? jsx(SwitchBranchDialog, {
            idle: switchIdle,
            onClose: () => setSwitchRow(null),
            onConfirm: () => runSwitch(switchRow, switchOpensSession),
            row: switchRow
          })
        : null
    ]
  })
}

// ── project detail page ──────────────────────────────────────────────────────

function Stat({ label, value, tip }) {
  const body = jsx('span', {
    style: {
      fontSize: '0.8125rem',
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
      color: 'var(--ui-text-primary)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    },
    children: value
  })

  return jsxs('div', {
    style: S.statCell,
    children: [
      jsx('span', { style: { fontSize: '0.6875rem', color: 'var(--ui-text-quaternary)' }, children: label }),
      tip ? jsx(Tip, { label: tip, children: body }) : body
    ]
  })
}

function folderList(project) {
  const seen = new Set()
  const out = []
  const add = p => {
    if (p && !seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }

  add(project.path)
  for (const repo of project.repos || []) add(repo.path)

  return out
}

// Lanes arrive fully hydrated from projects.project_sessions, in the same
// grouping the sidebar tree uses. A lane with no sessions is kept: it is
// information, not absence.
function laneGroups(node) {
  const multiRepo = (node.repos || []).length > 1
  const out = []

  for (const repo of node.repos || []) {
    for (const lane of repo.groups || []) {
      const sessions = [...(lane.sessions || [])].sort((a, b) => sessionStamp(b) - sessionStamp(a))

      out.push({ key: `${repo.id}:${lane.id}`, label: multiRepo ? repo.label : '', lane, sessions })
    }
  }

  return out
}

function DetailSessionRow({ session, state, onOpen, lane, lanes, projectLabel }) {
  const ms = sessionStamp(session)
  const model = shortModel(session.model)
  const running = RUNNING.has(state)
  const tokens = (session.input_tokens || 0) + (session.output_tokens || 0)
  const messages = session.message_count || 0

  return jsxs(RowButton, {
    className: 'pcc-detail-row',
    onClick: () => onOpen(session.id),
    style: S.laneRow,
    title: sessionTitle(session),
    children: [
      running ? jsx(ArcRing, { radius: '0' }) : null,
      jsxs('span', {
        style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
        children: [
          state && state !== 'idle' ? jsx('span', { style: { display: 'inline-flex', flex: 'none' }, children: jsx(LiveDot, { state }) }) : null,
          jsx('span', { style: S.laneRowTitle, children: sessionTitle(session) }),
          lane ? jsx('span', { style: { display: 'inline-flex', flex: 'none', marginLeft: 'auto' }, children: jsx(LaneBadge, { lane, lanes }) }) : null
        ]
      }),
      jsxs('span', {
        style: S.laneRowMeta,
        children: [
          projectLabel ? jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: projectLabel }) : null,
          ms ? jsx(Tip, { label: stampTip(ms), children: jsx('span', { children: ageText(ms) }) }) : null,
          model ? jsx('span', { children: model }) : null,
          messages ? jsx('span', { children: `${messages} ${messages === 1 ? 'message' : 'messages'}` }) : null,
          tokens
            ? jsx(Tip, {
                label: `${(session.input_tokens || 0).toLocaleString()} in / ${(session.output_tokens || 0).toLocaleString()} out`,
                children: jsx('span', { children: `${formatTokens(tokens)} tok` })
              })
            : null
        ]
      })
    ]
  })
}

function DetailEmpty({ description, title }) {
  return jsxs('div', {
    style: S.page,
    children: [
      jsx('style', { children: CSS_TEXT }),
      jsxs('div', {
        style: { flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 20 },
        children: [
          jsx(EmptyState, { description, title }),
          jsx(Button, { onClick: () => host.navigate(ROUTE), size: 'sm', variant: 'outline', children: 'Back to projects' })
        ]
      })
    ]
  })
}

function ProjectDetailPage() {
  const projectId = useValue($openProject)
  const statuses = useValue($statuses)
  const [spin, setSpin] = useState(false)
  // The session panel groups by branch (its original layout) or by the kanban's
  // lane columns, scoped to this project.
  const [panelMode, setPanelMode] = useState('branch')
  const [panelDrag, setPanelDrag] = useState(null)
  const [panelDropLane, setPanelDropLane] = useState('')

  const tree = useQuery({
    queryFn: () => host.request('projects.tree', { preview_limit: 5, ...profileParam() }),
    queryKey: [QUERY_ROOT, 'tree'],
    refetchInterval: TREE_MS,
    staleTime: 4000
  })

  const node = useMemo(() => {
    const list = (tree.data && tree.data.projects) || []

    return list.find(p => p.id === projectId) || null
  }, [tree.data, projectId])

  const detail = useQuery({
    enabled: Boolean(projectId && node),
    queryFn: () => host.request('projects.project_sessions', { project_id: projectId, ...profileParam() }),
    queryKey: [QUERY_ROOT, 'project', projectId],
    refetchInterval: projectId && node ? TREE_MS : false,
    staleTime: 4000
  })

  const live = useLiveSessions()
  const project = (detail.data && detail.data.project) || node
  // Mounting the same /board read here keeps the header's status picker on the
  // server copy even when the detail page is opened first (a tab or deep link),
  // and the project sync keeps the backend's cwd index fresh either way. The
  // same read carries each session's link row, which the lane badge resolves
  // from, so the page never asks for it twice.
  const boardState = useBoard()
  const treeProjects = useMemo(() => (tree.data && tree.data.projects) || [], [tree.data])

  useProjectSync(treeProjects)
  const lanes = useMemo(() => (project ? laneGroups(project) : []), [project])
  const folderPath = useMemo(() => (project ? primaryPath(project) : ''), [project])
  const pageProjects = useMemo(() => (project ? [project] : []), [project])
  const linkBySession = useMemo(() => linksBySession(boardState.links), [boardState.links])
  const refsByProject = useProjectRefs(pageProjects, boardState.links)
  const projectLane = project ? statuses[project.id] : ''
  const projectRefs = project ? refsByProject.get(project.id) : null
  const laneOf = useCallback(
    id => laneForLink(linkBySession.get(id), projectRefs, projectLane),
    [linkBySession, projectRefs, projectLane]
  )

  // The lane mode of the panel: the same kanban the Status view renders, but
  // built from this project's session rows instead of session.list, and scoped
  // to the project's id so a move posts the right scope.
  const laneState = useLaneTable()
  const laneRows = useMemo(() => laneTableOrDefaults(laneState.rows), [laneState.rows])
  const panelCards = useMemo(() => {
    const now = Date.now()
    const out = []
    const seen = new Set()

    for (const group of lanes) {
      for (const s of group.sessions || []) {
        if (!s || !s.id || seen.has(s.id)) continue
        seen.add(s.id)
        const link = linkBySession.get(s.id) || null
        const number = Number(link && link.pr)
        const pr = projectRefs && Number.isFinite(number) && number > 0 ? projectRefs.get(number) || null : null

        out.push(
          buildKanbanCard({
            session: s,
            link,
            project,
            projectId: project ? project.id : projectId,
            pr,
            projectLane,
            branch: String(s.git_branch || '').trim() || 'main',
            now,
            lanes: laneRows
          })
        )
      }
    }

    return kanbanPlaceCards(out, laneRows)
  }, [lanes, linkBySession, projectRefs, project, projectId, projectLane, laneRows])
  const panelCounts = useMemo(() => kanbanCounts(panelCards, laneRows), [panelCards, laneRows])
  const panelByLane = useMemo(() => {
    const map = new Map(laneRows.map(lane => [lane.id, []]))

    for (const card of panelCards) {
      const list = map.get(card.lane)

      if (list) list.push(card)
    }

    for (const list of map.values()) list.sort((a, b) => b.lastActivity - a.lastActivity)

    return map
  }, [panelCards, laneRows])
  const panelMove = (card, status) => {
    if (!card || !card.projectId || !card.sessionId || card.lane === status) return
    writeSessionLane(card.projectId, card.sessionId, status)
  }
  const panelDrop = laneId => {
    const card = panelDrag

    setPanelDrag(null)
    setPanelDropLane('')
    if (card && laneId) panelMove(card, laneId)
  }

  // The header names the work tree a vault subfolder really belongs to. Same
  // queryKey as the GitHub section's read, so react-query answers both with one
  // request instead of two.
  const repoInfo = useQuery({
    enabled: Boolean(folderPath),
    queryKey: [QUERY_ROOT, 'repo', folderPath],
    queryFn: () => ghRest(`/repo?path=${encodeURIComponent(folderPath)}`),
    retry: false,
    staleTime: 20000
  })

  const loadedCount = useMemo(() => lanes.reduce((n, l) => n + l.sessions.length, 0), [lanes])
  const liveCount = useMemo(() => {
    let n = 0

    for (const lane of lanes) for (const s of lane.sessions) if (RUNNING.has(live.byStored.get(s.id))) n += 1

    return n
  }, [lanes, live.byStored])

  const sessionsByBranch = useMemo(() => branchSessionMap(lanes, live.byStored), [lanes, live.byStored])

  // Sessions the project query places in the header folder, plus whether each
  // is mid-turn. `session.active_list` is the only SDK read of live state, and
  // it carries no cwd, so the folder comes from each lane's checkout path (or
  // the session's own cwd) and the two are joined by stored id.
  const folderSessions = useMemo(() => {
    const key = String(folderPath || '').replace(/\/+$/, '')
    const out = []

    if (!key) return out
    for (const group of lanes) {
      for (const s of group.sessions || []) {
        const lanePath = String((group.lane && group.lane.path) || '').replace(/\/+$/, '')
        const cwd = String(s.cwd || '').replace(/\/+$/, '')
        const inside = lanePath === key || cwd === key || (cwd ? cwd.startsWith(`${key}/`) : false)

        if (!inside) continue
        const state = live.byStored.get(s.id)

        if (!state) continue
        // A waiting turn is an open turn asking for the user; moving the
        // checkout under it is as wrong as moving it under a running one.
        out.push({ id: s.id, running: RUNNING.has(state) || state === 'waiting' })
      }
    }

    return out
  }, [folderPath, lanes, live.byStored])

  const refresh = () => {
    setSpin(true)
    schedule(() => setSpin(false), 700)
    queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] })
  }

  const copyPath = target => {
    Promise.resolve(writeClipboardText(target)).then(ok => {
      host.notify(ok === false ? { kind: 'warning', message: 'Could not copy the path.' } : { kind: 'success', message: 'Path copied' })
    })
  }

  if (!projectId) {
    return jsx(DetailEmpty, {
      description: 'Open a project from the board to see its lanes, sessions and totals.',
      title: 'No project selected'
    })
  }

  // The stored id can outlive the project (renamed, moved, another profile), so
  // a settled tree with no match is a real answer, not a loading state.
  if (!project) {
    if (tree.isLoading) {
      return jsxs('div', {
        style: S.page,
        children: [
          jsx('style', { children: CSS_TEXT }),
          jsx('div', {
            style: { padding: 20, display: 'flex', flexDirection: 'column', gap: 10 },
            children: [jsx(Skeleton, { style: { height: 28, width: '40%' } }), jsx(Skeleton, { style: { height: 64 } }), jsx(Skeleton, { style: { height: 120 } })]
          })
        ]
      })
    }

    return jsx(DetailEmpty, {
      description: 'It is not in the project tree for this profile any more.',
      title: 'That project is gone'
    })
  }

  const folderPaths = folderList(project)
  const path = primaryPath(project)
  const updatedMs = projectRecency(project)
  // The header's New session folder: the primary folder while /repo can read
  // it, else the first other repo folder the project records. Existence is
  // verified only for the primary (the /repo read above), never assumed for a
  // path the backend did not answer for.
  const repoData = repoInfo.data || null
  const sessionFolder = (() => {
    const missing = Boolean(repoData && repoData.code === 'folder_missing')

    if (path && !missing) return path
    const alt = (project.repos || [])
      .map(repo => String((repo && repo.path) || '').trim())
      .find(folder => folder && folder !== path)

    return alt || ''
  })()

  return jsxs('div', {
    style: S.page,
    children: [
      jsx('style', { children: CSS_TEXT }),
      jsxs('nav', {
        'aria-label': 'Breadcrumb',
        style: S.crumbs,
        children: [
          jsx('button', { className: 'pcc-crumb', onClick: () => host.navigate(ROUTE), style: S.crumbBtn, type: 'button', children: 'Projects' }),
          jsx(Codicon, { name: 'chevron-right', size: '0.75rem' }),
          jsx('span', { style: { ...S.ellipsis, color: 'var(--ui-text-secondary)' }, children: project.label })
        ]
      }),
      jsxs('header', {
        style: S.detailHead,
        children: [
          jsx(Avatar, { project, size: 30 }),
          jsxs('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 200px' },
            children: [
              jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' },
                children: [
                  jsx('h1', { style: S.detailTitle, children: project.label }),
                  repoData && (repoData.detached || repoData.branch)
                    ? jsx(BranchChip, {
                        branch: repoData.detached ? 'detached' : String(repoData.branch),
                        title: repoData.detached
                          ? 'The main folder is on a detached HEAD'
                          : 'The main folder is on this branch'
                      })
                    : null,
                  jsx(NewSessionButton, {
                    branch: repoData && !repoData.detached ? repoData.branch || '' : '',
                    folder: sessionFolder,
                    owner: (repoData && repoData.owner) || '',
                    repo: (repoData && repoData.repo) || ''
                  })
                ]
              }),
              jsx(PathLine, {
                path,
                inside: (repoInfo.data && repoInfo.data.inside_root) || null
              })
            ]
          }),
          jsx(StatusPicker, { projectId: project.id, status: statuses[project.id] || DEFAULT_STATUS }),
          jsxs(DropdownMenu, {
            children: [
              jsx(DropdownMenuTrigger, {
                asChild: true,
                children: jsx(Button, {
                  'aria-label': 'Project actions',
                  size: 'icon-xs',
                  variant: 'ghost',
                  children: jsx(Codicon, { name: 'ellipsis', size: '0.875rem' })
                })
              }),
              jsx(DropdownMenuContent, {
                align: 'end',
                children: [
                  jsx(DropdownMenuItem, {
                    onSelect: refresh,
                    children: [jsx(Codicon, { name: 'refresh', size: '0.75rem', spinning: spin }), 'Refresh']
                  }),
                  path
                    ? jsx(DropdownMenuItem, {
                        onSelect: () => copyPath(path),
                        children: [jsx(Codicon, { name: 'copy', size: '0.75rem' }), 'Copy path']
                      })
                    : null
                ]
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        style: S.detailBody,
        children: [
          jsxs('div', {
            style: S.stats,
            children: [
              jsx(Stat, { label: 'Sessions', value: project.sessionCount || loadedCount }),
              jsx(Stat, { label: 'Live now', value: liveCount }),
              jsx(Stat, { label: 'Tokens', tip: `${(project.totalTokens || 0).toLocaleString()} tokens`, value: formatTokens(project.totalTokens) }),
              jsx(Stat, { label: 'Cost', value: formatCost(project.totalCostUsd) || '-' }),
              jsx(Stat, { label: 'Folders', tip: folderPaths.join('\n') || undefined, value: folderPaths.length }),
              jsx(Stat, { label: 'Last updated', tip: stampTip(updatedMs), value: updatedMs ? ageText(updatedMs) : 'No activity' })
            ]
          }),
          path ? jsx(GithubSection, { folder: path, mainSessions: folderSessions, projectId: project.id, sessionsByBranch }) : null,
          jsxs('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
            children: [
              jsxs('div', {
                style: { ...S.stripHead, paddingTop: 0 },
                children: [
                  jsx('span', { style: S.stripTitle, children: 'Sessions by lane' }),
                  detail.isFetching ? jsx(Codicon, { name: 'loading', size: '0.75rem', spinning: true }) : null,
                  jsx('span', { style: S.grow }),
                  jsx(SegmentedControl, { onChange: setPanelMode, options: PANEL_MODES, sizing: 'content', value: panelMode }),
                  jsx('span', { style: S.count, children: loadedCount })
                ]
              }),
              panelMode === 'lane'
                ? jsx('div', {
                    style: S.panelBoard,
                    children: jsx(KanbanViews, {
                      byLane: panelByLane,
                      counts: panelCounts,
                      direction: 1,
                      dragCard: panelDrag,
                      dropLane: panelDropLane,
                      lanes: laneRows,
                      onDragEnd: () => {
                        setPanelDrag(null)
                        setPanelDropLane('')
                      },
                      onDragOver: setPanelDropLane,
                      onDragStart: setPanelDrag,
                      onDrop: panelDrop,
                      onMove: panelMove,
                      onOpenProject: openProject,
                      onOpenSession: openSession,
                      onSortLane: () => {},
                      states: live.byStored,
                      view: 'kanban'
                    })
                  })
                : lanes.length === 0
                ? jsx('div', { style: S.quiet, children: detail.isLoading ? 'Loading sessions...' : 'No sessions in this project yet' })
                : lanes.map(group => {
                    const branch =
                      group.lane.isGit === false
                        ? ''
                        : ((group.sessions.find(s => s.git_branch && s.git_branch !== group.lane.label) || {}).git_branch || '')

                    return jsxs(
                      'section',
                      {
                        'aria-label': group.lane.label,
                        style: S.lane,
                        children: [
                          jsxs('div', {
                            style: S.laneHead,
                            children: [
                              jsx(Codicon, { name: group.lane.isKanban ? 'project' : 'git-branch', size: '0.8125rem', style: { flex: 'none' } }),
                              jsx('span', { style: { ...S.ellipsis, fontWeight: 600 }, children: group.lane.label }),
                              group.lane.isMain ? jsx(Badge, { variant: 'muted', children: 'main lane' }) : null,
                              group.lane.isKanban ? jsx(Badge, { variant: 'outline', children: 'kanban' }) : null,
                              branch ? jsx(BranchChip, { branch }) : null,
                              group.label ? jsx('span', { style: { ...S.ellipsis, color: 'var(--ui-text-quaternary)' }, children: group.label }) : null,
                              jsx('span', { style: S.grow }),
                              jsx('span', { style: S.count, children: group.sessions.length })
                            ]
                          }),
                          group.sessions.length === 0
                            ? jsx('div', { style: S.laneQuiet, children: 'No sessions on this lane' })
                            : group.sessions.map(s =>
                                jsx(
                                  DetailSessionRow,
                                  { lane: laneOf(s.id), onOpen: openSession, session: s, state: live.byStored.get(s.id) },
                                  s.id
                                )
                              )
                        ]
                      },
                      group.key
                    )
                  })
            ]
          })
        ]
      })
    ]
  })
}

// ── page ─────────────────────────────────────────────────────────────────────

function matchesQuery(project, q) {
  const hay = [project.label, project.path]

  for (const repo of project.repos || []) {
    hay.push(repo.label, repo.path)
    for (const lane of repo.groups || []) {
      hay.push(lane.label, lane.path)
      for (const s of lane.sessions || []) hay.push(s.git_branch)
    }
  }

  for (const s of project.previewSessions || []) hay.push(s.git_branch)

  return hay.some(v => v && String(v).toLowerCase().includes(q))
}

function ProjectsPage({ embedded }) {
  const [search, setSearch] = useState('')
  const statuses = useValue($statuses)

  const tree = useQuery({
    queryFn: () =>
      host.request('projects.tree', { preview_limit: 5, ...profileParam() }),
    queryKey: [QUERY_ROOT, 'tree'],
    refetchInterval: TREE_MS,
    staleTime: 4000
  })

  // session.active_list.id is the runtime id; session_key is the stored id used
  // everywhere else. useLiveSessions maps one to the other and resolves state.
  const live = useLiveSessions()
  const projects = useMemo(() => (tree.data && tree.data.projects) || [], [tree.data])
  // /board: the server copy of the status map plus the session→issue/PR links the
  // column headers chip. Both degrade to the old storage-only behaviour when the
  // route is not mounted yet. Project sync rides the same read.
  const boardState = useBoard()
  const linksForProject = useMemo(() => linksByProject(boardState.links), [boardState.links])
  const linkRowsForProject = useMemo(() => linkRowsByProject(boardState.links), [boardState.links])
  const linkBySession = useMemo(() => linksBySession(boardState.links), [boardState.links])
  // PR state for every linked pull request on the page, so a session with no
  // explicit status can still read as review or done. Empty before the restart:
  // the project lane answers instead.
  const refsByProject = useProjectRefs(projects, boardState.links)
  // One /github/counts read for every column; a column takes its own folder's entry.
  const repoCounts = useRepoCounts(projects)

  useProjectSync(projects)
  const projectBySession = useMemo(() => {
    const map = new Map()

    for (const p of projects) {
      for (const id of p.sessionIds || []) if (!map.has(id)) map.set(id, p.label)
    }

    return map
  }, [projects])
  // The same three inputs the badge resolves with, for the live strip whose
  // rows are sessions from any project on the board.
  const projectByStored = useMemo(() => {
    const map = new Map()

    for (const p of projects) {
      for (const id of p.sessionIds || []) if (!map.has(id)) map.set(id, p.id)
    }

    return map
  }, [projects])
  const laneForSession = useCallback(
    key => {
      const projectId = projectByStored.get(key)

      return laneForLink(linkBySession.get(key), refsByProject.get(projectId), projectId ? statuses[projectId] : '')
    },
    [projectByStored, linkBySession, refsByProject, statuses]
  )

  const q = search.trim().toLowerCase()
  const sortId = useValue($sort)
  const filtered = useMemo(() => (q ? projects.filter(p => matchesQuery(p, q)) : projects), [projects, q])
  const visible = useMemo(() => sortProjects(filtered, sortId, statuses), [filtered, sortId, statuses])

  // The 15s background poll also sets isFetching, so the glyph would spin on its
  // own. Spin only for a click.
  const [spin, setSpin] = useState(false)

  const refresh = () => {
    setSpin(true)
    schedule(() => setSpin(false), 700)
    queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] })
  }

  const fetching = spin
  const countLabel = q ? `${visible.length} of ${projects.length}` : String(projects.length)

  let board

  if (tree.isLoading) {
    board = jsx(BoardSkeleton, {})
  } else if (tree.isError && !tree.data) {
    board = jsx('div', {
      style: { flex: '1 1 0', display: 'grid', placeItems: 'center', padding: 20 },
      children: jsx(ErrorState, {
        description: String((tree.error && tree.error.message) || 'The gateway did not return the project list.'),
        title: 'Could not load projects',
        children: jsx(Button, { onClick: () => tree.refetch(), size: 'sm', variant: 'outline', children: 'Try again' })
      })
    })
  } else if (visible.length === 0) {
    board = jsx('div', {
      style: { flex: '1 1 0', display: 'grid', placeItems: 'center' },
      children: jsx(EmptyState, {
        description: q ? 'Try a different name, folder or branch.' : 'Projects appear here once a session runs inside a folder.',
        title: q ? `No projects match \u201c${search.trim()}\u201d` : 'No projects yet'
      })
    })
  } else {
    board = jsx(Board, {
      count: visible.length,
      children: visible.map((p, i) =>
        jsx(
          ProjectColumn,
          {
            index: i,
            counts: Object.prototype.hasOwnProperty.call(repoCounts, primaryPath(p)) ? repoCounts[primaryPath(p)] : null,
            lane: statuses[p.id],
            linkRows: linkRowsForProject.get(p.id) || NO_LINKS,
            links: linksForProject.get(p.id),
            liveByStored: live.byStored,
            onOpenProject: openProject,
            onOpenSession: openSession,
            project: p,
            refs: refsByProject.get(p.id),
            status: statuses[p.id] || DEFAULT_STATUS
          },
          p.id
        )
      )
    })
  }

  return jsxs('div', {
    style: embedded ? S.viewBody : S.page,
    children: [
      embedded ? null : jsx('style', { children: CSS_TEXT }),
      jsxs(embedded ? 'div' : 'header', {
        style: embedded ? S.viewBar : S.header,
        children: [
          embedded ? null : jsx('h1', { style: S.title, children: 'Projects' }),
          jsx('span', { style: S.count, children: tree.data ? `${countLabel} ${projects.length === 1 && !q ? 'project' : 'projects'}` : '' }),
          jsx('span', { style: S.grow }),
          jsx(SortPicker, { sort: sortId }),
          jsx('div', {
            style: S.searchWrap,
            children: jsx(SearchField, {
              'aria-label': 'Search projects',
              onChange: setSearch,
              placeholder: 'Search name or folder',
              value: search
            })
          }),
          jsx(Tip, {
            label: 'Refresh',
            children: jsx(Button, {
              'aria-label': 'Refresh projects',
              disabled: fetching,
              onClick: refresh,
              size: 'icon-xs',
              variant: 'ghost',
              children: jsx(Codicon, { name: 'refresh', size: '0.875rem', spinning: fetching })
            })
          })
        ]
      }),
      board,
      jsx(LiveStrip, {
        items: live.items,
        laneFor: laneForSession,
        loading: live.query.isLoading,
        onOpenSession: openSession,
        projectBySession
      })
    ]
  })
}

// ── session kanban ───────────────────────────────────────────────────────────
// One page over every project's sessions: the board's link rows joined to the
// gateway's session list, with the store's lane ids as columns. Lane labels and
// order are the user's (see $lanes); the ids never change, because every write
// names one of the five and the backend validates it.

const EMPTY_BRANCHES = {}
const KANBAN_VIEWS = [
  { id: 'kanban', label: 'Kanban' },
  { id: 'table', label: 'Table' }
]
// The project page's session panel: its own grouping, or the kanban columns.
const PANEL_MODES = [
  { id: 'branch', label: 'By branch' },
  { id: 'lane', label: 'By lane' }
]
const KANBAN_SOURCE_FILTERS = [
  { value: '', label: 'Any source' },
  { value: 'user', label: 'Set by you' },
  { value: 'agent', label: 'Set by agent' }
]

// Branches are read the way the project detail header reads them: one /repo call
// per folder, batched into a single query so N projects share one cache entry
// and a folder with no answer simply falls back to `main` on the card.
function useProjectBranches(projects) {
  const folders = useMemo(() => {
    const seen = new Set()

    for (const project of projects || []) {
      const folder = primaryPath(project)

      if (folder) seen.add(folder)
      if (seen.size >= COUNTS_PATH_LIMIT) break
    }

    return Array.from(seen)
  }, [projects])

  const key = folders.join('\n')
  const query = useQuery({
    enabled: folders.length > 0,
    queryFn: () =>
      Promise.all(
        folders.map(folder =>
          ghRest(`/repo?path=${encodeURIComponent(folder)}`)
            .then(res => [folder, res && res.ok !== false && !res.detached ? String(res.branch || '') : ''])
            .catch(() => [folder, ''])
        )
      ).then(rows => Object.fromEntries(rows)),
    queryKey: [QUERY_ROOT, 'repo-branches', key],
    refetchInterval: 60000,
    retry: false,
    staleTime: 30000
  })

  return query.data && typeof query.data === 'object' ? query.data : EMPTY_BRANCHES
}

// The card the filters, the columns and the table all read. Every field is a
// plain value so the page never reaches back into three different payloads while
// rendering one row.
function buildKanbanCard(input) {
  const source = input || {}
  const session = source.session || {}
  const link = source.link || null
  const project = source.project || null
  const projectId = String(source.projectId || (link && link.project_id) || '')
  const rawIssue = Number(link && link.issue)
  const rawPr = Number(link && link.pr)
  const lane = kanbanLaneFor(link, source.pr || null, source.projectLane, source.lanes)
  const started = stampMs(session.started_at)
  const updated = stampMs(link && link.status_updated_at)
  const lastActivity = Math.max(started, updated)
  const now = Number(source.now) || Date.now()
  const title =
    String(session.title || '').trim() ||
    String((link && link.title) || '').trim() ||
    String(session.preview || '').trim() ||
    'Untitled session'

  return {
    id: String(session.id || (link && link.session_id) || ''),
    sessionId: String(session.id || ''),
    title,
    projectId,
    projectLabel: projectId ? String((project && project.label) || projectId) : 'No project',
    branch: String(source.branch || '').trim() || 'main',
    issue: Number.isFinite(rawIssue) && rawIssue > 0 ? rawIssue : 0,
    pr: Number.isFinite(rawPr) && rawPr > 0 ? rawPr : 0,
    prState: source.pr || null,
    lane: lane.lane,
    laneSource: lane.source,
    laneNote: lane.note || '',
    lastActivity,
    stale: lane.lane !== 'done' && lastActivity > 0 && now - lastActivity > KANBAN_STALE_MS,
    linked: Boolean(link)
  }
}

function KanbanSelect({ ariaLabel, disabled, onChange, options, style, value }) {
  return jsx('select', {
    'aria-label': ariaLabel,
    disabled: Boolean(disabled),
    onChange: event => onChange(event.target.value),
    style: { ...S.select, ...style, ...(disabled ? { opacity: 0.55, cursor: 'not-allowed' } : null) },
    value,
    children: options.map(option => jsx('option', { value: option.value, children: option.label }, option.value))
  })
}

function LaneEditorRow({ index, lanes, lane, live, onRemove, total }) {
  const [draft, setDraft] = useState(lane.label)

  useEffect(() => setDraft(lane.label), [lane.label])

  const commit = () => {
    const text = draft.trim()

    if (!text) {
      setDraft(lane.label)

      return
    }

    if (text === lane.label) return

    if (live) renameLane(lane.id, text).catch(() => {})
    else writeLanes(renameKanbanLane(lanes, lane.id, text))
  }

  const move = delta => {
    const next = moveKanbanLane(lanes, lane.id, delta)

    if (live) reorderLanes(next).catch(() => {})
    else writeLanes(next)
  }

  return jsxs('div', {
    style: S.laneRow,
    children: [
      jsx('span', { 'aria-hidden': 'true', style: { ...S.kdot, marginTop: 0, background: laneColor(lane.id, lanes) } }),
      jsx('input', {
        'aria-label': `${lane.label} lane label`,
        onBlur: commit,
        onChange: event => setDraft(event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
            event.currentTarget.blur()
          }
          if (event.key === 'Escape') {
            setDraft(lane.label)
            event.currentTarget.blur()
          }
        },
        style: S.laneInput,
        value: draft
      }),
      lane.custom ? jsx(Badge, { size: 'xs', variant: 'outline', children: 'custom' }) : null,
      jsx(Tip, {
        label: `Move ${lane.label} up`,
        children: jsx(Button, {
          'aria-label': `Move ${lane.label} lane up`,
          disabled: index === 0,
          onClick: () => move(-1),
          size: 'icon-xs',
          variant: 'ghost',
          children: jsx(Codicon, { name: 'arrow-up', size: '0.75rem' })
        })
      }),
      jsx(Tip, {
        label: `Move ${lane.label} down`,
        children: jsx(Button, {
          'aria-label': `Move ${lane.label} lane down`,
          disabled: index === total - 1,
          onClick: () => move(1),
          size: 'icon-xs',
          variant: 'ghost',
          children: jsx(Codicon, { name: 'arrow-down', size: '0.75rem' })
        })
      }),
      jsx(Tip, {
        label: total <= 1 ? 'The board needs at least one lane' : `Remove ${lane.label}`,
        children: jsx(Button, {
          'aria-label': `Remove ${lane.label} lane`,
          disabled: !live || total <= 1,
          onClick: () => onRemove(lane),
          size: 'icon-xs',
          variant: 'ghost',
          children: jsx(Codicon, { name: 'trash', size: '0.75rem' })
        })
      })
    ]
  })
}

// The lane table's one editor: rename, reorder, add and remove. Every write is
// optimistic through the helpers above and comes back to the server copy
// (invalidate lanes, and the board when a delete moves cards). With no lane
// route answering, the controls keep the old local-only behaviour.
function LanesPopover({ lanes, live }) {
  const rows = laneTableOrDefaults(lanes)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(null)
  const [target, setTarget] = useState('')

  const add = () => {
    const text = draft.trim()

    if (!text || !live) return
    setDraft('')
    setError('')
    createLane(text).catch(err => setError(String((err && err.message) || 'The board refused the lane.')))
  }

  const remove = lane => {
    if (!live) return
    setError('')
    setPending(null)
    deleteLane(lane.id).catch(err => {
      if (err && err.code === 'lane_in_use') {
        const counts = laneUseCount(err.counts, lane.id)
        const rest = rows.filter(row => row.id !== lane.id)

        setPending({ counts, id: lane.id, label: lane.label })
        setTarget(rest.length > 0 ? rest[0].id : '')

        return
      }

      setError(String((err && err.message) || 'The board refused the removal.'))
    })
  }

  const confirmRemove = () => {
    if (!pending || !target) return
    setError('')
    deleteLane(pending.id, target)
      .then(() => setPending(null))
      .catch(err => setError(String((err && err.message) || 'The board refused the removal.')))
  }

  const options = rows.filter(row => !pending || row.id !== pending.id)

  return jsxs(Popover, {
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsxs(Button, {
          'aria-label': 'Edit lanes',
          size: 'sm',
          variant: 'outline',
          children: [jsx(Codicon, { name: 'settings-gear', size: '0.875rem' }), 'Lanes']
        })
      }),
      jsx(PopoverContent, {
        align: 'end',
        children: jsxs('div', {
          style: S.lanesPop,
          children: [
            jsx('div', { style: S.kmenuHead, children: 'Rename, reorder, add or remove' }),
            ...rows.map((lane, index) =>
              jsx(
                LaneEditorRow,
                { index, lane, lanes: rows, live, onRemove: remove, total: rows.length },
                lane.id
              )
            ),
            live
              ? jsxs('div', {
                  style: S.laneRow,
                  children: [
                    jsx('input', {
                      'aria-label': 'New lane name',
                      onChange: event => setDraft(event.target.value),
                      onKeyDown: event => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        add()
                      },
                      placeholder: 'New lane name',
                      style: S.laneInput,
                      value: draft
                    }),
                    jsx(Button, {
                      disabled: !draft.trim(),
                      onClick: add,
                      size: 'sm',
                      variant: 'outline',
                      children: 'Add lane'
                    })
                  ]
                })
              : jsx('div', {
                  style: S.kmenuNote,
                  children: 'The board backend is not answering, so lanes stay local to this machine.'
                }),
            pending
              ? jsxs('div', {
                  style: { ...S.laneCol, paddingTop: 4 },
                  children: [
                    jsx('div', {
                      style: S.kmenuNote,
                      children: `${pending.counts > 0 ? `${pending.counts} ${pending.counts === 1 ? 'session sits' : 'sessions sit'} in ${pending.label}.` : `${pending.label} still has sessions.`} Move them to:`
                    }),
                    jsxs('div', {
                      style: S.laneRow,
                      children: [
                        jsx(KanbanSelect, {
                          ariaLabel: 'Move sessions to a lane',
                          onChange: setTarget,
                          options: options.map(row => ({ value: row.id, label: row.label })),
                          value: target
                        }),
                        jsx(Button, {
                          disabled: !target,
                          onClick: confirmRemove,
                          size: 'sm',
                          variant: 'default',
                          children: 'Move and remove'
                        }),
                        jsx(Button, {
                          onClick: () => setPending(null),
                          size: 'sm',
                          variant: 'ghost',
                          children: 'Cancel'
                        })
                      ]
                    })
                  ]
                })
              : null,
            error ? jsx('div', { style: S.laneError, children: error }) : null
          ]
        })
      })
    ]
  })
}

function KanbanProvenance({ card, lanes }) {
  const text = KANBAN_SOURCE_TEXT[card.laneSource] || 'unset'
  const label = text === 'unset' ? 'Lane unset' : `Lane from ${text}`
  const title = card.laneNote ? `${label}: ${card.laneNote}` : label

  return jsx(Tip, {
    label: title,
    children: jsx('span', {
      'aria-label': title,
      style: { ...S.kdot, background: laneColor(card.lane, lanes) }
    })
  })
}

function KanbanRefChip({ card }) {
  const chips = []

  if (card.issue) {
    chips.push(
      jsx(
        Tip,
        {
          label: `Issue #${card.issue}`,
          children: jsxs('span', {
            style: S.chip,
            children: [jsx(Codicon, { name: 'issues', size: '0.625rem', style: { flex: 'none' } }), `#${card.issue}`]
          })
        },
        'issue'
      )
    )
  }

  if (card.pr) {
    const look = ghStatusLook('pr', card.prState || {})

    chips.push(
      jsx(
        Tip,
        {
          label: `Pull request #${card.pr}${look.label ? `, ${look.label}` : ''}`,
          children: jsxs('span', {
            style: { ...S.chip, color: look.color },
            children: [
              jsx(Codicon, { name: look.name, size: '0.625rem', style: { flex: 'none', color: look.color } }),
              `#${card.pr}`
            ]
          })
        },
        'pr'
      )
    )
  }

  return chips.length ? jsx('span', { style: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' }, children: chips }) : null
}

function KanbanCardMenu({ card, lanes, onMove, onOpenProject, onOpenSession }) {
  const canMove = Boolean(card.projectId && card.sessionId)
  const sessionItem = jsx(
    DropdownMenuItem,
    {
      onSelect: () => onOpenSession(card.sessionId),
      children: [jsx(Codicon, { name: 'comment-discussion', size: '0.75rem' }, 'icon'), 'Open session']
    },
    'session'
  )

  return jsxs(DropdownMenu, {
    children: [
      jsx(DropdownMenuTrigger, {
        asChild: true,
        children: jsx('button', {
          'aria-label': `Actions for ${card.title}`,
          className: 'pcc-more',
          onClick: event => event.stopPropagation(),
          style: S.kmenuBtn,
          type: 'button',
          children: jsx(Codicon, { name: 'ellipsis', size: '0.875rem' })
        })
      }),
      jsx(DropdownMenuContent, {
        align: 'end',
        children: canMove
          ? [
              jsx('div', { style: S.kmenuHead, children: 'Move to' }, 'move-head'),
              ...lanes.map(lane =>
                jsxs(
                  DropdownMenuItem,
                  {
                    onSelect: () => onMove(card, lane.id),
                    children: [
                      jsx(
                        Codicon,
                        {
                          name: 'check',
                          size: '0.75rem',
                          style: { visibility: lane.id === card.lane ? 'visible' : 'hidden' }
                        },
                        'check'
                      ),
                      jsx(
                        'span',
                        {
                          style: { display: 'inline-flex', alignItems: 'center', gap: 6 },
                          children: [
                            jsx('span', {
                              'aria-hidden': 'true',
                              style: { ...S.kdot, marginTop: 0, background: laneColor(lane.id, lanes) }
                            }),
                            lane.label
                          ]
                        },
                        'label'
                      )
                    ]
                  },
                  lane.id
                )
              ),
              jsx(Separator, {}, 'sep'),
              sessionItem,
              jsx(
                DropdownMenuItem,
                {
                  onSelect: () => onOpenProject(card.projectId),
                  children: [jsx(Codicon, { name: 'project', size: '0.75rem' }), 'Open project']
                },
                'project'
              )
            ]
          : [
              jsx(
                'div',
                { style: S.kmenuNote, children: 'No project is linked to this session, so it cannot be moved.' },
                'why'
              ),
              sessionItem
            ]
      })
    ]
  })
}

function KanbanCard({ card, dragId, lanes, onDragEnd, onDragStart, onMove, onOpenProject, onOpenSession, state }) {
  return jsxs('div', {
    'aria-label': `${card.title}. ${laneLabel(card.lane, lanes)} lane.`,
    className: 'pcc-kcard',
    'data-dragging': dragId === card.id ? 'true' : 'false',
    draggable: true,
    onClick: () => onOpenSession(card.sessionId),
    onDragEnd,
    onDragStart: event => {
      event.dataTransfer.setData('text/plain', card.id)
      event.dataTransfer.effectAllowed = 'move'
      onDragStart(card)
    },
    onKeyDown: event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onOpenSession(card.sessionId)
      }
    },
    role: 'button',
    style: S.kcard,
    tabIndex: 0,
    children: [
      jsxs('div', {
        style: S.kcardHead,
        children: [
          jsx('span', { style: S.kcardTitle, children: card.title }, 'title'),
          state && state !== 'idle' ? jsx(LiveDot, { state }, 'live') : null,
          jsx(KanbanProvenance, { card, lanes }, 'provenance'),
          jsx(KanbanCardMenu, { card, lanes, onMove, onOpenProject, onOpenSession }, 'menu')
        ]
      }),
      jsxs('div', {
        style: S.kcardMeta,
        children: [
          jsx('span', { style: S.ellipsis, children: card.projectLabel }, 'project'),
          jsx(BranchChip, { branch: card.branch, title: `Branch ${card.branch}` }, 'branch'),
          jsx(KanbanRefChip, { card }, 'refs'),
          card.linked
            ? null
            : jsx('span', { style: { ...S.chip, color: 'var(--ui-text-quaternary)' }, children: 'Unlinked' }, 'unlinked'),
          card.lastActivity
            ? jsx(
                Tip,
                {
                  label: stampTip(card.lastActivity),
                  children: jsx('span', { children: ageText(card.lastActivity) })
                },
                'age'
              )
            : null
        ]
      })
    ]
  })
}

function KanbanColumn({ cards, count, dropLane, dragId, lanes, lane, onDragEnd, onDragOver, onDragStart, onDrop, onMove, onOpenProject, onOpenSession, states }) {
  const over = dropLane === lane.id

  return jsxs('div', {
    className: 'pcc-kcol',
    'data-drop': over ? 'true' : 'false',
    style: S.column,
    children: [
      jsx('div', {
        style: S.colHeader,
        children: jsxs('div', {
          style: S.row,
          children: [
            jsx('span', {
              'aria-hidden': 'true',
              style: { ...S.kdot, marginTop: 0, background: laneColor(lane.id, lanes) }
            }),
            jsx('span', {
              style: { fontSize: '0.8125rem', fontWeight: 500, color: 'var(--ui-text-secondary)' },
              children: lane.label
            }),
            lane.custom ? jsx(Badge, { size: 'xs', variant: 'outline', children: 'custom' }) : null,
            jsx('span', { style: { ...S.count, marginLeft: 'auto' }, children: count })
          ]
        })
      }),
      jsxs('div', {
        onDragLeave: event => {
          if (!event.currentTarget.contains(event.relatedTarget)) onDragOver('')
        },
        onDragOver: event => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          if (!over) onDragOver(lane.id)
        },
        onDrop: event => {
          event.preventDefault()
          onDrop(lane.id)
        },
        style: S.kcolBody,
        children: cards.length
          ? cards.map(card =>
              jsx(
                KanbanCard,
                {
                  card,
                  dragId,
                  lanes,
                  onDragEnd,
                  onDragStart,
                  onMove,
                  onOpenProject,
                  onOpenSession,
                  state: states.get(card.sessionId)
                },
                card.id
              )
            )
          : jsx('div', { className: 'pcc-kempty', children: 'No sessions' })
      })
    ]
  })
}

function KanbanTable({ cards, direction, lanes, onMove, onOpenProject, onOpenSession, onSortLane }) {
  const rows = sortKanbanCards(cards, lanes, direction)

  return jsx('div', {
    style: S.ktableWrap,
    children: jsxs('table', {
      className: 'pcc-ktable',
      style: S.ktable,
      children: [
        jsx('thead', {
          children: jsx('tr', {
            children: [
              jsx('th', { children: 'Session' }, 'session'),
              jsx('th', { children: 'Project' }, 'project'),
              jsx(
                'th',
                {
                  children: jsx('button', {
                    className: 'pcc-ksort',
                    onClick: onSortLane,
                    type: 'button',
                    children: [
                      'Lane',
                      jsx(Codicon, { name: direction < 0 ? 'arrow-down' : 'arrow-up', size: '0.625rem' })
                    ]
                  })
                },
                'lane'
              ),
              jsx('th', { children: 'Branch' }, 'branch'),
              jsx('th', { children: 'Refs' }, 'refs'),
              jsx('th', { children: 'Last activity' }, 'age')
            ]
          })
        }),
        jsx('tbody', {
          children: rows.map(card =>
            jsxs(
              'tr',
              {
                children: [
                  jsx('td', {
                    children: jsx('button', {
                      className: 'pcc-link',
                      onClick: () => onOpenSession(card.sessionId),
                      style: {
                        border: 0,
                        background: 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        font: 'inherit',
                        padding: 0,
                        textAlign: 'left'
                      },
                      type: 'button',
                      children: card.title
                    })
                  }),
                  jsx('td', {
                    children: card.projectId
                      ? jsx('button', {
                          className: 'pcc-link',
                          onClick: () => onOpenProject(card.projectId),
                          style: {
                            border: 0,
                            background: 'transparent',
                            color: 'inherit',
                            cursor: 'pointer',
                            font: 'inherit',
                            padding: 0,
                            textAlign: 'left'
                          },
                          type: 'button',
                          children: card.projectLabel
                        })
                      : jsx('span', { style: { color: 'var(--ui-text-quaternary)' }, children: 'No project' })
                  }),
                  jsx('td', {
                    children: jsx(KanbanSelect, {
                      ariaLabel: `Lane for ${card.title}`,
                      disabled: !card.projectId,
                      onChange: value => onMove(card, value),
                      options: lanes.map(lane => ({ value: lane.id, label: lane.label })),
                      style: { maxWidth: 150, height: 26 },
                      value: card.lane
                    })
                  }),
                  jsx('td', { children: jsx(BranchChip, { branch: card.branch, title: `Branch ${card.branch}` }) }),
                  jsx('td', { children: jsx(KanbanRefChip, { card }) }),
                  jsx('td', {
                    style: { color: 'var(--ui-text-quaternary)', whiteSpace: 'nowrap' },
                    children: card.lastActivity ? ageText(card.lastActivity) : ''
                  })
                ]
              },
              card.id
            )
          )
        })
      ]
    })
  })
}

// Both views take the same filtered list and the same move handler; only the
// arrangement changes.
function KanbanViews({ byLane, counts, direction, dragCard, dropLane, lanes, onDragEnd, onDragOver, onDragStart, onDrop, onMove, onOpenProject, onOpenSession, onSortLane, states, view }) {
  if (view === 'table') {
    const all = []

    for (const lane of lanes) for (const card of byLane.get(lane.id) || []) all.push(card)

    return jsx(KanbanTable, {
      cards: all,
      direction,
      lanes,
      onMove,
      onOpenProject,
      onOpenSession,
      onSortLane
    })
  }

  return jsx(Board, {
    count: lanes.length,
    children: lanes.map(lane =>
      jsx(
        KanbanColumn,
        {
          cards: byLane.get(lane.id) || [],
          count: counts[lane.id] || 0,
          dragId: dragCard ? dragCard.id : '',
          dropLane,
          lanes,
          lane,
          onDragEnd,
          onDragOver,
          onDragStart,
          onDrop,
          onMove,
          onOpenProject,
          onOpenSession,
          states
        },
        lane.id
      )
    )
  })
}

// The reads and the card shape every session view shares: the tree (labels and
// folders), the gateway's session list, /board's links and the PR refs the lane
// rule reads. One hook, so Branches and Issues cost no extra network calls.
function useSessionCards(lanes) {
  const statuses = useValue($statuses)
  const overrides = useValue($sessionStatus)

  const tree = useQuery({
    queryFn: () => host.request('projects.tree', { preview_limit: 5, ...profileParam() }),
    queryKey: [QUERY_ROOT, 'tree'],
    refetchInterval: TREE_MS,
    staleTime: 4000
  })

  const sessionsQuery = useQuery({
    queryFn: () => host.request('session.list', { limit: 200, ...profileParam() }),
    queryKey: [QUERY_ROOT, 'sessions'],
    refetchInterval: TREE_MS,
    staleTime: 4000
  })

  const boardState = useBoard()
  const live = useLiveSessions()

  // A move this client posted is dropped as soon as the board echoes it, so a
  // card never sits on a lane the store already disagrees with.
  useEffect(() => {
    reconcileSessionLanes(boardState.links)
  }, [boardState.links])

  const treeProjects = useMemo(() => (tree.data && tree.data.projects) || [], [tree.data])
  const boardProjects = useMemo(
    () => (boardState.data && Array.isArray(boardState.data.projects) ? boardState.data.projects : []),
    [boardState.data]
  )
  // The tree knows labels and folders; the store may know a project the tree no
  // longer lists, and its id is still what a link row names.
  const projects = useMemo(() => {
    const out = treeProjects.map(project => ({ ...project }))
    const seen = new Set(out.map(project => project.id))

    for (const row of boardProjects) {
      if (!row || !row.project_id || seen.has(row.project_id)) continue
      out.push({ id: row.project_id, label: row.label, path: (row.paths && row.paths[0]) || '' })
      seen.add(row.project_id)
    }

    return out
  }, [treeProjects, boardProjects])
  const projectById = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects])
  const linkBySession = useMemo(() => linksBySession(boardState.links), [boardState.links])
  const refsByProject = useProjectRefs(projects, boardState.links)
  const branches = useProjectBranches(projects)

  const cards = useMemo(() => {
    const rows = (
      sessionsQuery.data && Array.isArray(sessionsQuery.data.sessions) ? sessionsQuery.data.sessions : []
    ).filter(session => session && session.id)
    const now = Date.now()

    return rows.map(session => {
      const link = linkBySession.get(session.id) || null
      const projectId = String((link && link.project_id) || '')
      const project = projectId ? projectById.get(projectId) : null
      const folder = project ? primaryPath(project) : ''
      const refs = projectId ? refsByProject.get(projectId) : null
      const number = Number(link && link.pr)
      const pr = refs && Number.isFinite(number) && number > 0 ? refs.get(number) || null : null
      const card = buildKanbanCard({
        session,
        link,
        project,
        pr,
        projectLane: projectId ? statuses[projectId] : '',
        // A session that knows its own checkout branch groups by that; the
        // folder's checked-out branch is the fallback the card already shows.
        branch: String(session.git_branch || '').trim() || (folder ? branches[folder] : ''),
        now,
        lanes
      })
      const override = overrides[session.id]

      return override ? { ...card, lane: override.status, laneSource: 'user', laneNote: '' } : card
    })
  }, [sessionsQuery.data, linkBySession, projectById, refsByProject, statuses, branches, overrides, lanes])

  return { boardState, cards, live, projectById, projects, sessionsQuery, tree }
}

// The Status view. It renders one filtered card list two ways: the kanban and
// the table, so a filter can never apply to one and not the other. Embedded in
// the merged page it drops the page chrome and keeps a toolbar.
function SessionsKanbanPage({ embedded }) {
  const [view, setView] = useState('kanban')
  const [search, setSearch] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [staleOnly, setStaleOnly] = useState(false)
  const [laneDirection, setLaneDirection] = useState(1)
  const [dragCard, setDragCard] = useState(null)
  const [dropLane, setDropLane] = useState('')
  const [spin, setSpin] = useState(false)
  const laneState = useLaneTable()
  const ordered = useMemo(() => laneTableOrDefaults(laneState.rows), [laneState.rows])
  const { boardState, cards, live, projects, sessionsQuery } = useSessionCards(ordered)

  // A lane deleted while this tab was open leaves cards pointing at it; the
  // filter list is placed on the live table, so those cards surface in the first
  // lane instead of disappearing.
  const filtered = useMemo(
    () =>
      kanbanPlaceCards(
        kanbanFilterCards(cards, { projectId: projectFilter, search, source: sourceFilter, staleOnly }),
        ordered
      ),
    [cards, projectFilter, search, sourceFilter, staleOnly, ordered]
  )
  const counts = useMemo(() => kanbanCounts(filtered, ordered), [filtered, ordered])
  const byLane = useMemo(() => {
    const map = new Map(ordered.map(lane => [lane.id, []]))

    for (const card of filtered) {
      const list = map.get(card.lane)

      if (list) list.push(card)
    }

    for (const list of map.values()) list.sort((a, b) => b.lastActivity - a.lastActivity)

    return map
  }, [filtered, ordered])

  const move = (card, status) => {
    if (!card || !card.projectId || !card.sessionId || card.lane === status) return
    writeSessionLane(card.projectId, card.sessionId, status)
  }

  const drop = laneId => {
    const card = dragCard

    setDragCard(null)
    setDropLane('')
    if (card && laneId) move(card, laneId)
  }

  const refresh = () => {
    setSpin(true)
    schedule(() => setSpin(false), 700)
    queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] })
  }

  const total = cards.length
  const shown = filtered.length
  const countLabel =
    total === 0 ? '' : shown === total ? `${total} ${total === 1 ? 'session' : 'sessions'}` : `${shown} of ${total} sessions`
  const projectOptions = [
    { value: '', label: 'All projects' },
    ...projects.map(project => ({ value: project.id, label: project.label || project.id }))
  ]
  const boardDown = total > 0 && boardState.query.isFetched && !boardState.live
  let body

  if (sessionsQuery.isLoading) {
    body = jsx(BoardSkeleton, {})
  } else if (sessionsQuery.isError && !sessionsQuery.data) {
    body = jsx('div', {
      style: { flex: '1 1 0', display: 'grid', placeItems: 'center', padding: 20 },
      children: jsx(ErrorState, {
        description: String((sessionsQuery.error && sessionsQuery.error.message) || 'The gateway did not return the session list.'),
        title: 'Could not load sessions',
        children: jsx(Button, { onClick: () => sessionsQuery.refetch(), size: 'sm', variant: 'outline', children: 'Try again' })
      })
    })
  } else if (total === 0) {
    body = jsx('div', {
      style: { flex: '1 1 0', display: 'grid', placeItems: 'center' },
      children: jsx(EmptyState, {
        description: 'Sessions appear here once the gateway has one to list.',
        title: 'No sessions yet'
      })
    })
  } else if (shown === 0) {
    body = jsx('div', {
      style: { flex: '1 1 0', display: 'grid', placeItems: 'center' },
      children: jsx(EmptyState, {
        description: 'Clear a filter or try a different search.',
        title: search.trim() ? `No sessions match "${search.trim()}"` : 'No sessions match these filters'
      })
    })
  } else {
    body = jsx(KanbanViews, {
      byLane,
      counts,
      direction: laneDirection,
      dragCard,
      dropLane,
      lanes: ordered,
      onDragEnd: () => {
        setDragCard(null)
        setDropLane('')
      },
      onDragOver: setDropLane,
      onDragStart: setDragCard,
      onDrop: drop,
      onMove: move,
      onOpenProject: openProject,
      onOpenSession: openSession,
      onSortLane: () => setLaneDirection(dir => -dir),
      states: live.byStored,
      view
    })
  }

  return jsxs('div', {
    style: embedded ? S.viewBody : S.page,
    children: [
      embedded ? null : jsx('style', { children: CSS_TEXT }),
      jsxs(embedded ? 'div' : 'header', {
        style: embedded ? S.viewBar : S.header,
        children: [
          embedded ? null : jsx('h1', { style: S.title, children: 'Sessions' }),
          jsx('span', { style: S.count, children: countLabel }),
          jsx('span', { style: S.grow }),
          jsx(SegmentedControl, { onChange: setView, options: KANBAN_VIEWS, sizing: 'content', value: view }),
          jsx(LanesPopover, { lanes: ordered, live: laneState.live }),
          jsx(Tip, {
            label: 'Refresh',
            children: jsx(Button, {
              'aria-label': 'Refresh sessions',
              disabled: spin,
              onClick: refresh,
              size: 'icon-xs',
              variant: 'ghost',
              children: jsx(Codicon, { name: 'refresh', size: '0.875rem', spinning: spin })
            })
          })
        ]
      }),
      jsxs('div', {
        style: S.filters,
        children: [
          jsx(KanbanSelect, {
            ariaLabel: 'Filter by project',
            onChange: setProjectFilter,
            options: projectOptions,
            value: projectFilter
          }),
          jsx(KanbanSelect, {
            ariaLabel: 'Filter by lane source',
            onChange: setSourceFilter,
            options: KANBAN_SOURCE_FILTERS,
            value: sourceFilter
          }),
          jsx(Tip, {
            label: 'Only sessions not in done, untouched for three days',
            children: jsx(Button, {
              'aria-pressed': staleOnly,
              onClick: () => setStaleOnly(value => !value),
              size: 'sm',
              variant: staleOnly ? 'default' : 'outline',
              children: [
                jsx(Codicon, { name: 'clock', size: '0.875rem' }),
                'Stale only'
              ]
            })
          }),
          jsx('span', { style: S.grow }),
          jsx('div', {
            style: S.searchWrap,
            children: jsx(SearchField, {
              'aria-label': 'Search sessions',
              onChange: setSearch,
              placeholder: 'Search title, project, branch or number',
              value: search
            })
          })
        ]
      }),
      boardDown
        ? jsxs('div', {
            style: S.notice,
            children: [
              jsx(Codicon, { name: 'warning', size: '0.875rem' }),
              jsx('span', {
                children: 'The board backend is not answering, so lanes fall back to each project lane.'
              })
            ]
          })
        : null,
      !laneState.live && laneState.query.isFetched
        ? jsxs('div', {
            style: S.notice,
            children: [
              jsx(Codicon, { name: 'warning', size: '0.875rem' }),
              jsx('span', {
                children: 'No lane route on this backend, so the five default lanes are local to this machine.'
              })
            ]
          })
        : null,
      body
    ]
  })
}

// ── the merged page ──────────────────────────────────────────────────────────
// One route, four views. The switcher has four fixed options, so its width never
// depends on the data behind it and the header does not shift between views.

function ViewSwitcher() {
  const view = useValue($view)

  return jsx('span', {
    style: S.viewSwitch,
    children: jsx(SegmentedControl, { onChange: writeView, options: VIEWS, sizing: 'content', value: view })
  })
}

// The project page's session row, fed from a kanban card: one row component for
// Branches and Issues, and one lane badge for both.
function GroupedSessions({ groups, icon, lanes, live, onOpenSession, quiet }) {
  return jsx('div', {
    style: S.groupList,
    children: groups.map(group =>
      jsxs(
        'section',
        {
          'aria-label': group.label,
          style: S.lane,
          children: [
            jsxs('div', {
              style: S.laneHead,
              children: [
                jsx(Codicon, { name: group.icon || icon, size: '0.8125rem', style: { flex: 'none' } }),
                jsx('span', { style: { ...S.ellipsis, fontWeight: 600 }, children: group.label }),
                jsx('span', { style: S.grow }),
                jsx('span', { style: S.count, children: group.cards.length })
              ]
            }),
            group.cards.length === 0
              ? jsx('div', { style: S.quiet, children: quiet })
              : group.cards.map(card =>
                  jsx(
                    DetailSessionRow,
                    {
                      lane: cardLane(card),
                      lanes,
                      onOpen: onOpenSession,
                      projectLabel: card.projectLabel,
                      session: cardAsSession(card),
                      state: live.get(card.sessionId)
                    },
                    card.id
                  )
                )
          ]
        },
        group.key
      )
    )
  })
}

const GROUP_VIEWS = {
  branches: { empty: 'No sessions to group by branch yet.', icon: 'git-branch', quiet: 'No sessions on this branch', title: 'Branches' },
  issues: { empty: 'No sessions to group by issue or pull request yet.', icon: 'issues', quiet: 'No sessions in this group', title: 'Issues' }
}

// Branches and Issues read the same cards as Status with a cheap subset of its
// filters (project and search), then group them with the pure helpers. Nothing
// here adds a request: useSessionCards is the same three reads.
function SessionGroupView({ embedded, mode }) {
  const copy = GROUP_VIEWS[mode] || GROUP_VIEWS.branches
  const [search, setSearch] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const laneState = useLaneTable()
  const ordered = useMemo(() => laneTableOrDefaults(laneState.rows), [laneState.rows])
  const { cards, live, projects } = useSessionCards(ordered)
  const filtered = useMemo(
    () => kanbanPlaceCards(kanbanFilterCards(cards, { projectId: projectFilter, search }), ordered),
    [cards, projectFilter, search, ordered]
  )
  const groups = useMemo(
    () => (mode === 'issues' ? kanbanIssueGroups(filtered) : kanbanBranchGroups(filtered)),
    [mode, filtered]
  )
  const projectOptions = [
    { value: '', label: 'All projects' },
    ...projects.map(project => ({ value: project.id, label: project.label || project.id }))
  ]
  const countLabel = `${filtered.length} ${filtered.length === 1 ? 'session' : 'sessions'}`

  return jsxs('div', {
    style: embedded ? S.viewBody : S.page,
    children: [
      embedded ? null : jsx('style', { children: CSS_TEXT }),
      jsxs(embedded ? 'div' : 'header', {
        style: embedded ? S.viewBar : S.header,
        children: [
          embedded ? null : jsx('h1', { style: S.title, children: copy.title }),
          jsx('span', { style: S.count, children: cards.length > 0 ? countLabel : '' }),
          jsx('span', { style: S.grow }),
          jsx(KanbanSelect, {
            ariaLabel: 'Filter by project',
            onChange: setProjectFilter,
            options: projectOptions,
            value: projectFilter
          }),
          jsx('div', {
            style: S.searchWrap,
            children: jsx(SearchField, {
              'aria-label': 'Search sessions',
              onChange: setSearch,
              placeholder: 'Search title, project, branch or number',
              value: search
            })
          })
        ]
      }),
      cards.length === 0
        ? jsx('div', {
            style: { flex: '1 1 0', display: 'grid', placeItems: 'center' },
            children: jsx(EmptyState, {
              description: 'Sessions appear here once the gateway has one to list.',
              title: copy.empty
            })
          })
        : jsx(GroupedSessions, {
            groups,
            icon: copy.icon,
            lanes: ordered,
            live: live.byStored,
            onOpenSession: openSession,
            quiet: copy.quiet
          })
    ]
  })
}

// The one page the sidebar and the palette open. The view is storage-backed, so
// a reload lands where the user left it; a route visit without a stored view
// opens Status first.
function ProjectCommandCenterPage() {
  const view = useValue($view)
  let body

  if (view === 'projects') body = jsx(ProjectsPage, { embedded: true })
  else if (view === 'branches') body = jsx(SessionGroupView, { embedded: true, mode: 'branches' })
  else if (view === 'issues') body = jsx(SessionGroupView, { embedded: true, mode: 'issues' })
  else body = jsx(SessionsKanbanPage, { embedded: true })

  return jsxs('div', {
    style: S.page,
    children: [
      jsx('style', { children: CSS_TEXT }),
      jsxs('header', {
        style: S.header,
        children: [
          jsxs('div', {
            style: S.titleRow,
            children: [
              jsx(Codicon, { name: 'inbox', size: '18px', style: S.titleIcon }),
              jsx('h1', { style: S.title, children: 'Project Command Center' })
            ]
          }),
          jsx('span', { style: S.grow }),
          jsx(ViewSwitcher, {})
        ]
      }),
      body
    ]
  })
}

// ── titlebar ─────────────────────────────────────────────────────────────────

// The `titleBar.left/center/right` areas are render SLOTS for page-owned chrome:
// anything registered there makes the app treat the route as chrome-owning and
// drop its own fixed right-hand tools. A persistent toolbar button belongs in
// the tool registry instead, which is where core pages put their own tools
// (app/contrib/panes.tsx `setTitlebarToolGroup`). There is no SDK constant for
// it yet, so the area name is written out.
const TITLEBAR_TOOL_AREA = 'titleBar.tools.right'

function titlebarTool() {
  return {
    id: 'pcc-open',
    label: 'Projects',
    title: 'Projects',
    icon: jsx(Codicon, { name: 'inbox', size: '13.9px' }),
    to: ROUTE
  }
}

// ── registration ─────────────────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,
  name: 'Project Command Center',
  register(ctx) {
    pluginCtx = ctx
    // A reload re-registers this module: scheduling is armed again here, and a
    // promise that settles after teardown (a composer verb, a REST read) drops
    // its timer instead of writing into a retired lifetime set.
    pluginDisposed = false
    if (typeof ctx.onDispose === 'function') {
      ctx.onDispose(() => {
        pluginDisposed = true
      })
    }
    $statuses.set(readStatuses())
    $lanes.set(readLanes())
    $sort.set(readSort())
    $view.set(readView())
    $ghPreset.set(readGhPreset())
    $openProject.set(readOpenProject())

    ctx.registerMany([
      { id: 'titlebar', area: TITLEBAR_TOOL_AREA, order: 40, data: titlebarTool() },
      // One page. The view switcher inside it picks Status, Projects, Branches
      // or Issues, so the sidebar keeps a single entry and the route stays put.
      { id: 'page', area: ROUTES_AREA, title: 'Projects', data: { path: ROUTE }, render: () => jsx(ProjectCommandCenterPage, {}) },
      // A second page, not a drawer: the board stays the board, and a project
      // gets a page of its own that a tab can hold.
      { id: 'project-page', area: ROUTES_AREA, title: 'Project', data: { path: PROJECT_ROUTE }, render: () => jsx(ProjectDetailPage, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: ROUTE, label: 'Projects', codicon: 'inbox' } },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.open`,
          label: 'Open Projects',
          keywords: ['projects', 'project', 'board', 'command center'],
          run: () => openView('projects')
        }
      },
      {
        id: 'open-sessions',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.sessions`,
          label: 'Open Sessions board',
          keywords: ['sessions', 'kanban', 'lanes', 'status', 'board', 'project', 'command center'],
          run: () => openView('status')
        }
      },
      {
        id: 'open-issues',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.issues`,
          label: 'Open Issues',
          keywords: ['issues', 'pull requests', 'merged', 'review', 'sessions', 'command center'],
          run: () => openView('issues')
        }
      }
    ])

    // The poll tells us which sessions exist and what the gateway thinks they are
    // doing; the event stream tells us which ones are actually producing right
    // now. `event.session_id` is the runtime id, which is the key we keep.
    ctx.onEvent('*', event => {
      const id = event && event.session_id

      if (!id) return

      if (event.type === 'message.complete') {
        clearActivity(id)

        return
      }

      if (ACTIVITY_TYPES.has(event.type)) noteActivity(id, Date.now())
    })
    ctx.setInterval(() => $activityClock.set(Date.now()), 5000)

    // Gateway events can arrive in bursts; coalesce them into one refetch.
    let pending = false
    const invalidate = () => {
      if (pending) return
      pending = true
      ctx.setTimeout(() => {
        pending = false
        queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] })
      }, 400)
    }

    ctx.onEvent('projects.changed', invalidate)
    ctx.onEvent('sessions.changed', invalidate)

    // The backend tells us when a status or a session→issue/PR link moved (a
    // click in another window, or its own cwd matcher). The board poll is always
    // stale after that; a PR number is also a cue for the GitHub section to take
    // a forced read and flash the row it names.
    ctx.onEvent('plugin.project-command-center.board.changed', event => {
      const payload = (event && event.payload) || {}

      queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, 'board'] })

      const pr = Number(payload.pr)

      if (payload.project_id && Number.isFinite(pr) && pr > 0) {
        $ghPoke.set({ at: Date.now(), pr, project_id: payload.project_id })
      }
    })
  }
}
