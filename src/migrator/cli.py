"""Single entry point for every project command: ``uv run migrator <command>``.

Commands:
  convert    offline Datadog -> Perses conversion (exit 0 / 2 / 1)
  test       run the test suite (extra arguments go to pytest)
  typecheck  run mypy over src and tests
  lint       run ruff over src and tests
  check      lint + typecheck + test
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from migrator.input import InputError

_REPO = Path(__file__).resolve().parents[2]


def _cmd_convert(args: argparse.Namespace) -> int:
    from migrator.convert import ConvertOptions, run_convert
    from migrator.report import format_summary

    try:
        result = run_convert(
            ConvertOptions(
                source=args.source,
                inputs=args.input,
                mapping=args.mapping or [str(_REPO / "mappings" / args.source)],
                out=args.out,
                format=args.format,
                project=args.project,
            )
        )
    except InputError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    print(format_summary(result.report, result.slugs))
    return result.exit_code


def _cmd_fetch(args: argparse.Namespace) -> int:
    import os

    from migrator.fetch import run_fetch
    from migrator.source.asset import FetchSelection, SourceFetchError

    sel = FetchSelection(tuple(args.dashboard_id or ()), tuple(args.monitor_id or ()))
    try:
        written = run_fetch(args.source, sel, args.out, os.environ)
    except (InputError, SourceFetchError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    for rel in written:
        print(f"FETCHED {rel}")
    return 0


def _cmd_publish(args: argparse.Namespace) -> int:
    import os

    from migrator.publish import PublishOptions, run_publish

    try:
        run = run_publish(
            PublishOptions(
                source_dir=args.source_dir,
                dry_run=args.dry_run,
                allow_partial=args.allow_partial,
                name_prefix=args.name_prefix,
            ),
            os.environ,
        )
    except InputError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    for line in run.lines:
        print(line)
    return run.exit_code


def _run_tool(argv: list[str]) -> int:
    return subprocess.call([sys.executable, "-m", *argv])


def _cmd_test(args: argparse.Namespace, extra: list[str]) -> int:
    return _run_tool(["pytest", *extra])


def _cmd_typecheck(args: argparse.Namespace, extra: list[str]) -> int:
    return _run_tool(["mypy", "src", "tests", *extra])


def _cmd_lint(args: argparse.Namespace, extra: list[str]) -> int:
    return _run_tool(["ruff", "check", "src", "tests", *extra])


def _cmd_check(args: argparse.Namespace, extra: list[str]) -> int:
    for step in (_cmd_lint, _cmd_typecheck, _cmd_test):
        code = step(args, [])
        if code != 0:
            return code
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="migrator", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    conv = sub.add_parser("convert", help="convert source dashboards to Perses (offline)")
    conv.add_argument("--source", required=True, help="source provider id, e.g. datadog")
    conv.add_argument("--input", required=True, nargs="+", help="input files or folders")
    conv.add_argument(
        "--mapping",
        action="append",
        help="mapping file (JSON) or a directory of them; repeatable "
        "(default: the repository's mappings/<source> folder)",
    )
    conv.add_argument("--out", required=True, help="output directory (must be empty)")
    conv.add_argument("--format", choices=["json", "yaml"], default="json")
    conv.add_argument("--project", default="datadog-migration", help="Perses project name")

    fet = sub.add_parser("fetch", help="download selected source assets by ID (read-only)")
    fet.add_argument("--source", required=True, help="source provider id, e.g. datadog")
    fet.add_argument("--dashboard-id", action="append", help="dashboard ID (repeatable)")
    fet.add_argument("--monitor-id", action="append", help="monitor ID (repeatable)")
    fet.add_argument("--out", required=True, help="output directory (must be empty)")

    pub = sub.add_parser("publish", help="import converted artifacts into Dash0 (create-only)")
    pub.add_argument("--from", dest="source_dir", required=True, help="a convert output directory")
    pub.add_argument("--dry-run", action="store_true", help="print the plan; send nothing")
    pub.add_argument(
        "--allow-partial", action="store_true", help="also publish partially translated dashboards"
    )
    pub.add_argument(
        "--name-prefix",
        metavar="PREFIX",
        help="prepend PREFIX (a-z, 0-9, '-'; e.g. demo-) to every published name",
    )

    sub.add_parser("test", help="run the test suite; extra args go to pytest")
    sub.add_parser("typecheck", help="run mypy")
    sub.add_parser("lint", help="run ruff")
    sub.add_parser("check", help="lint, typecheck and test")
    return parser


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    parser = build_parser()
    passthrough = {
        "test": _cmd_test,
        "typecheck": _cmd_typecheck,
        "lint": _cmd_lint,
        "check": _cmd_check,
    }
    if argv and argv[0] in passthrough:
        args, extra = parser.parse_known_args(argv[:1])
        return passthrough[argv[0]](args, argv[1:])
    args = parser.parse_args(argv)
    if args.command == "fetch":
        return _cmd_fetch(args)
    if args.command == "publish":
        return _cmd_publish(args)
    return _cmd_convert(args)


if __name__ == "__main__":
    sys.exit(main())
