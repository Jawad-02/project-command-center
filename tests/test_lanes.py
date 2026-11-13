#!/usr/bin/env python3
"""Lane definitions are data: schema, migration, validation and the lane routes' store calls.

Plain Python like tests/test_session_status.py, no pytest. It builds a scratch home, opens the
store (which creates and seeds the ``lanes`` table), and exercises the five seeds, custom lanes,
reordering, deletion with reassignment, and the read fallback for an id that is no longer live.

    python3 tests/test_lanes.py

No network, no real plugin data: ``PCC_LANES_SCRATCH`` (default
``~/.hermes/cache/scratch/pcc-lanes``) is wiped and rebuilt on every run.
"""

from __future__ import annotations

import sys as _sys

_sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

import _bootstrap  # noqa: E402,F401  finds the Hermes tree and a sandbox home

import importlib.util
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any

PLUGIN = Path(__file__).resolve().parent.parent
SCRATCH = Path(os.environ.get("PCC_LANES_SCRATCH",
                              Path.home() / ".hermes" / "cache" / "scratch" / "pcc-lanes"))
FAILURES: list[str] = []
DEFAULT_IDS = ["backlog", "active", "review", "blocked", "done"]
DEFAULT_LABELS = ["Backlog", "Active", "Review", "Blocked", "Done"]


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if condition else 'FAIL'} {name}{f' :: {detail}' if detail else ''}")
    if not condition:
        FAILURES.append(name)


def section(title: str) -> None:
    print(f"\n== {title} ".ljust(78, "="))


def load(name: str, path: Path):
    """Import a plugin module the way the plugin loader does: as a package with a search path."""
    spec = importlib.util.spec_from_file_location(
        name, path, submodule_search_locations=[str(path.parent)])
    if spec is None or spec.loader is None:
        sys.exit(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    module.__path__ = [str(path.parent)]
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def ids_of(rows: list[dict[str, Any]]) -> list[str]:
    return [row["id"] for row in rows]


def by_id(rows: list[dict[str, Any]], lane_id: str) -> dict[str, Any]:
    return next((row for row in rows if row["id"] == lane_id), {})


def positions(rows: list[dict[str, Any]]) -> list[int]:
    return [row["order"] for row in rows]


def main() -> int:
    home = (SCRATCH / "home").resolve()
    if home == (Path.home() / ".hermes").resolve():
        sys.exit("refusing to run against the real ~/.hermes; point PCC_LANES_SCRATCH elsewhere")
    shutil.rmtree(SCRATCH, ignore_errors=True)
    home.mkdir(parents=True)
    data = home / "plugin-data" / "project-command-center"
    data.mkdir(parents=True)
    outside = SCRATCH / "outside"
    outside.mkdir()
    os.environ["HERMES_HOME"] = str(home)
    os.environ["TERMINAL_CWD"] = str(outside)
    print(f"HERMES_HOME={home}")

    store = load("pcc_lanes_store", PLUGIN / "board_store.py")
    db = data / "board.db"

    # --- seed ----------------------------------------------------------------
    section("seed / a fresh database starts with the five default lanes")
    opened = store.board()
    check("a fresh board opens", opened.get("ok") is True, str(opened.get("code")))
    rows = store.lanes()
    print(f"  lanes: {json.dumps(rows, default=str)}")
    check("the seed ids are the five defaults, in order", ids_of(rows) == DEFAULT_IDS,
          str(ids_of(rows)))
    check("the seed labels are the five defaults", [row["label"] for row in rows] == DEFAULT_LABELS,
          str([row["label"] for row in rows]))
    check("positions are 0..4", positions(rows) == [0, 1, 2, 3, 4], str(positions(rows)))
    check("seeded lanes are not custom", all(row["custom"] == 0 for row in rows),
          str([row["custom"] for row in rows]))
    check("lane_ids() reads the same order", store.lane_ids() == DEFAULT_IDS, str(store.lane_ids()))

    section("seed / a second open does not duplicate the seed")
    store._schema_ready.discard(store._db_path())
    conn = store._connect()
    try:
        count = conn.execute("SELECT count(*) FROM lanes").fetchone()[0]
    finally:
        conn.close()
    check("the lanes table still holds exactly five rows", count == 5, str(count))
    check("the ids did not move on the second open", store.lane_ids() == DEFAULT_IDS,
          str(store.lane_ids()))

    synced = store.set_projects([{"id": "pcc", "label": "Project Command Center",
                                  "paths": [str(PLUGIN)]}])
    check("a project is synced for the write cases", synced.get("ok") is True, str(synced.get("code")))

    section("writes / the five seed ids keep working")
    for lane in DEFAULT_IDS:
        wrote = store.set_status("pcc", lane, None, "user", scope="project")
        read_back = (store.get_status("pcc") or {}).get("status")
        check(f"a project write to {lane!r} succeeds and reads back",
              wrote.get("ok") is True and read_back == lane,
              f"{wrote.get('code')} / {read_back!r}")

    # --- create, rename, reorder --------------------------------------------
    section("lanes / create, rename and reorder")
    made = store.save_lane(None, "QA Pending")
    print(f"  create: {json.dumps(made, default=str)}")
    check("a created lane is ok and slugs its label",
          made.get("ok") is True and made.get("lane") == "qa-pending", str(made.get("code")))
    entry = by_id(made.get("lanes") or [], "qa-pending")
    check("the new lane is custom, labelled and appended",
          entry.get("custom") == 1 and entry.get("label") == "QA Pending" and entry.get("order") == 5,
          str(entry))
    check("the live ids now end with the custom lane",
          store.lane_ids() == DEFAULT_IDS + ["qa-pending"], str(store.lane_ids()))

    renamed = store.save_lane("qa-pending", "QA Queue")
    check("a rename keeps the id and changes the label",
          renamed.get("ok") is True and by_id(renamed.get("lanes") or [], "qa-pending")
          .get("label") == "QA Queue", str(renamed.get("code")))

    moved = store.save_lane("qa-pending", None, 1)
    check("a reorder moves the lane to the requested position",
          moved.get("ok") is True and by_id(moved.get("lanes") or [], "qa-pending")
          .get("order") == 1, str(moved.get("code")))
    check("a move renumbers every position 0..n-1",
          ids_of(moved.get("lanes") or []) == ["backlog", "qa-pending", "active", "review",
                                               "blocked", "done"],
          str(ids_of(moved.get("lanes") or [])))
    restored = store.save_lane("qa-pending", None, 5)
    check("moving it back restores the seed order",
          ids_of(restored.get("lanes") or []) == DEFAULT_IDS + ["qa-pending"],
          str(ids_of(restored.get("lanes") or [])))

    duplicate = store.save_lane(None, "QA Pending")
    check("a duplicate slug is refused with lane_exists",
          duplicate.get("ok") is False and duplicate.get("code") == "lane_exists",
          str(duplicate.get("code")))
    dup_label = store.save_lane(None, "QA   pending!")
    check("a differently spelled label with the same slug is the same duplicate",
          dup_label.get("code") == "lane_exists", str(dup_label.get("code")))
    empty = store.save_lane(None, "!!!")
    check("a label that slugs to nothing is bad_label", empty.get("code") == "bad_label",
          str(empty.get("code")))

    bad_order = store.reorder_lanes(["backlog", "active"])
    check("an order that is not a permutation is refused",
          bad_order.get("ok") is False and bad_order.get("code") == "bad_order",
          str(bad_order.get("code")))
    extra = store.reorder_lanes(store.lane_ids() + ["ghost"])
    check("an order with an unknown id is refused", extra.get("code") == "bad_order",
          str(extra.get("code")))
    check("a refused order left the lanes where they were",
          store.lane_ids() == DEFAULT_IDS + ["qa-pending"], str(store.lane_ids()))

    # --- custom id writes ----------------------------------------------------
    section("writes / a custom lane id works on projects and sessions")
    project_write = store.set_status("pcc", "qa-pending", "waiting on QA", "user", scope="project")
    print(f"  project: {json.dumps(project_write, default=str)}")
    check("a project status write to a custom lane succeeds",
          project_write.get("ok") is True
          and (store.get_status("pcc") or {}).get("status") == "qa-pending",
          str(project_write.get("code")))
    session_write = store.set_status("pcc", "QA-PENDING ", "session waiting", "agent",
                                     session_id="s-qa")
    check("a session status write to a custom lane trims and lowercases",
          session_write.get("ok") is True
          and (store.get_link("s-qa") or {}).get("status") == "qa-pending",
          str(session_write.get("code")))
    card = store.session_card("s-qa")
    check("the session card resolves the custom lane",
          (card.get("lane") or {}).get("status") == "qa-pending",
          str((card.get("lane") or {}).get("status")))

    # --- delete --------------------------------------------------------------
    section("lanes / delete in use is refused, then reassign moves the rows")
    refused = store.delete_lane("qa-pending")
    print(f"  refused: {json.dumps(refused, default=str)}")
    check("a lane rows still hold is lane_in_use with the counts",
          refused.get("ok") is False and refused.get("code") == "lane_in_use"
          and refused.get("project_status") == 1 and refused.get("links") == 1,
          json.dumps(refused, default=str))
    check("the refused delete kept the lane", "qa-pending" in store.lane_ids(),
          str(store.lane_ids()))

    deleted = store.delete_lane("qa-pending", "active")
    print(f"  deleted: {json.dumps(deleted, default=str)}")
    check("a delete with reassign succeeds and reports what it moved",
          deleted.get("ok") is True and deleted.get("project_status") == 1
          and deleted.get("links") == 1, str(deleted.get("code")))
    check("the project row actually moved", (store.get_status("pcc") or {}).get("status") == "active",
          str((store.get_status("pcc") or {}).get("status")))
    check("the session row actually moved", (store.get_link("s-qa") or {}).get("status") == "active",
          str((store.get_link("s-qa") or {}).get("status")))
    check("the deleted lane is gone", "qa-pending" not in store.lane_ids(), str(store.lane_ids()))
    check("the survivors are renumbered 0..n-1", positions(store.lanes()) == [0, 1, 2, 3, 4],
          str(positions(store.lanes())))

    section("lanes / unknown ids and bad shapes")
    unknown_rename = store.save_lane("ghost", "Ghost")
    check("renaming an unknown lane is unknown_lane", unknown_rename.get("code") == "unknown_lane",
          str(unknown_rename.get("code")))
    unknown_delete = store.delete_lane("ghost")
    check("deleting an unknown lane is unknown_lane", unknown_delete.get("code") == "unknown_lane",
          str(unknown_delete.get("code")))
    bad_write = store.set_status("pcc", "shipped", None, "user", scope="project")
    check("a status write naming an unknown lane is bad_status",
          bad_write.get("ok") is False and bad_write.get("code") == "bad_status",
          str(bad_write.get("code")))
    check("the refusal message names the live lanes",
          all(lane in str(bad_write.get("error")) for lane in store.lane_ids()), str(bad_write))
    bad_shape = store.set_status("pcc", "no spaces!", None, "user", scope="project")
    check("a status that cannot be an id is refused before the lookup",
          bad_shape.get("code") == "bad_status" and (store.get_status("pcc") or {})
          .get("status") == "active", str(bad_shape.get("code")))

    # --- a stored id that is no longer live ---------------------------------
    section("reads / a stored lane id that no longer exists degrades to the first lane")
    raw = sqlite3.connect(db)
    try:
        raw.execute("UPDATE link SET status = 'ghost-lane' WHERE session_id = 's-qa'")
        raw.commit()
    finally:
        raw.close()
    first = store.lane_ids()[0]
    ghost_card = store.session_card("s-qa")
    print(f"  ghost session lane: {json.dumps(ghost_card.get('lane'), default=str)}")
    check("the session card shows the first lane instead of blank",
          (ghost_card.get("lane") or {}).get("status") == first
          and (ghost_card.get("lane") or {}).get("scope") == "session",
          str(ghost_card.get("lane")))
    store.set_status("pcc", "active", "back to live", "user", session_id="s-qa")

    raw = sqlite3.connect(db)
    try:
        raw.execute("UPDATE status SET status = 'ghost-lane' WHERE project_id = 'pcc'")
        raw.commit()
    finally:
        raw.close()
    ghost_project = store.card_for_project("pcc")
    check("a project card with a stale lane also degrades to the first lane",
          (ghost_project.get("lane") or {}).get("status") == first
          and (ghost_project.get("lane") or {}).get("scope") == "project",
          str(ghost_project.get("lane")))
    store.set_status("pcc", "active", None, "user", scope="project")

    # --- last lane -----------------------------------------------------------
    section("lanes / the last lane cannot be deleted")
    for lane in ("backlog", "review", "blocked", "done"):
        gone = store.delete_lane(lane)
        check(f"deleting unused default lane {lane!r} is allowed", gone.get("ok") is True,
              str(gone.get("code")))
    check("only one lane is left", store.lane_ids() == ["active"], str(store.lane_ids()))
    last = store.delete_lane("active")
    check("deleting the last lane is last_lane",
          last.get("ok") is False and last.get("code") == "last_lane", str(last.get("code")))
    check("the last lane survived", store.lane_ids() == ["active"], str(store.lane_ids()))

    # --- routes --------------------------------------------------------------
    section("routes / lanes routes keep the board conventions: HTTP 200 with a code")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    # Capture broadcasts instead of reaching a gateway that is not running here.
    events: list[tuple[str, str, Any]] = []
    try:
        import hermes_cli.plugin_events as plugin_events
        plugin_events.broadcast_plugin_event = (
            lambda name, event, payload: events.append((name, event, payload)) or 1)
    except Exception:
        pass

    api = load("pcc_lanes_api", PLUGIN / "dashboard" / "plugin_api.py")
    app = FastAPI()
    app.include_router(api.router)
    client = TestClient(app)

    def call(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
        response = getattr(client, method)(path, json=body) if body is not None else \
            getattr(client, method)(path)
        try:
            return response.status_code, response.json()
        except ValueError:
            return response.status_code, {"code": "not_json", "error": response.text[:200]}

    code, listed = call("get", "/board/lanes")
    print(f"  GET:  HTTP {code} {json.dumps(listed, default=str)}")
    check("GET /board/lanes answers the one remaining lane",
          code == 200 and listed.get("ok") is True and ids_of(listed.get("lanes") or []) == ["active"],
          f"HTTP {code} {listed.get('code')}")

    code, created = call("post", "/board/lanes", {"label": "Route Lane"})
    check("POST /board/lanes creates a slugged custom lane",
          code == 200 and created.get("ok") is True and created.get("lane") == "route-lane"
          and by_id(created.get("lanes") or [], "route-lane").get("custom") == 1,
          f"HTTP {code} {created.get('code')}")

    code, dupe = call("post", "/board/lanes", {"label": "Route Lane"})
    check("a duplicate create is HTTP 200 lane_exists",
          code == 200 and dupe.get("ok") is False and dupe.get("code") == "lane_exists",
          f"HTTP {code} {dupe.get('code')}")

    code, renamed = call("post", "/board/lanes", {"id": "route-lane", "label": "Route Renamed"})
    check("a rename by id works through the route",
          code == 200 and renamed.get("ok") is True
          and by_id(renamed.get("lanes") or [], "route-lane").get("label") == "Route Renamed",
          f"HTTP {code} {renamed.get('code')}")

    code, ordered = call("post", "/board/lanes/order", {"ids": ["route-lane", "active"]})
    check("an order permutation is accepted",
          code == 200 and ordered.get("ok") is True
          and ids_of(ordered.get("lanes") or []) == ["route-lane", "active"],
          f"HTTP {code} {ordered.get('code')}")

    code, bad = call("post", "/board/lanes/order", {"ids": ["route-lane"]})
    check("a non permutation is HTTP 200 bad_order",
          code == 200 and bad.get("ok") is False and bad.get("code") == "bad_order",
          f"HTTP {code} {bad.get('code')}")
    code, back = call("post", "/board/lanes/order", {"ids": ["active", "route-lane"]})
    check("the order can be restored", code == 200 and back.get("ok") is True,
          f"HTTP {code} {back.get('code')}")

    code, gone = call("post", "/board/lanes/delete", {"id": "route-lane"})
    check("an unused lane deletes through the route",
          code == 200 and gone.get("ok") is True and store.lane_ids() == ["active"],
          f"HTTP {code} {gone.get('code')}")
    code, unknown = call("post", "/board/lanes/delete", {"id": "route-lane"})
    check("deleting an unknown lane is HTTP 200 unknown_lane",
          code == 200 and unknown.get("code") == "unknown_lane",
          f"HTTP {code} {unknown.get('code')}")
    code, last = call("post", "/board/lanes/delete", {"id": "active"})
    check("deleting the last lane through the route is last_lane",
          code == 200 and last.get("code") == "last_lane", f"HTTP {code} {last.get('code')}")

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} check(s): " + ", ".join(FAILURES))
        return 1
    print("all checks ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
