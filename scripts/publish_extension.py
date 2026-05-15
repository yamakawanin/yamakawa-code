#!/usr/bin/env python3
"""Publish VS Code extension with one command.

Examples:
  python scripts/publish_extension.py
  python scripts/publish_extension.py --bump minor
  python scripts/publish_extension.py --check-only
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def run_cmd(cmd: list[str], cwd: Path) -> None:
    print("$", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def ensure_tool_exists(tool: str, hint: str) -> None:
    if shutil.which(tool) is None:
        print(f"Error: '{tool}' not found. {hint}")
        sys.exit(1)


def ensure_pat_when_publish(check_only: bool) -> None:
    if check_only:
        return
    if not os.environ.get("VSCE_PAT"):
        print("Error: VSCE_PAT is not set.")
        print("Please run: export VSCE_PAT=your_marketplace_pat")
        sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish VS Code extension")
    parser.add_argument(
        "--bump",
        choices=["patch", "minor", "major"],
        default="patch",
        help="Version bump type when publishing (default: patch)",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Only build and package, do not publish",
    )
    parser.add_argument(
        "--no-compile",
        action="store_true",
        help="Skip TypeScript compile step",
    )
    parser.add_argument(
        "--cwd",
        default=".",
        help="Repository root directory (default: current directory)",
    )
    args = parser.parse_args()

    cwd = Path(args.cwd).resolve()
    if not (cwd / "package.json").exists():
        print(f"Error: package.json not found under {cwd}")
        return 1

    ensure_tool_exists("npm", "Install Node.js and npm first.")
    ensure_tool_exists("npx", "Install Node.js and npm first.")
    ensure_pat_when_publish(args.check_only)

    try:
        if not args.no_compile:
            run_cmd(["npm", "run", "compile"], cwd)

        if args.check_only:
            run_cmd(["npx", "@vscode/vsce", "package"], cwd)
            print("\nDone: package check completed.")
            return 0

        run_cmd(["npx", "@vscode/vsce", "publish", args.bump], cwd)
        print("\nDone: extension published successfully.")
        return 0
    except subprocess.CalledProcessError as err:
        print("\nPublish failed.")
        return err.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
