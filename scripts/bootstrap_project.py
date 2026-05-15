#!/usr/bin/env python3
"""One-click project bootstrap for this VS Code extension.

Usage:
  python scripts/bootstrap_project.py
  python scripts/bootstrap_project.py --with-icon
  python scripts/bootstrap_project.py --skip-compile
"""

from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
from pathlib import Path


def run_cmd(cmd: list[str], cwd: Path) -> None:
    print("$", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def require_tool(name: str, install_hint: str) -> None:
    if shutil.which(name):
        return
    print(f"Error: '{name}' not found. {install_hint}")
    sys.exit(1)


def choose_install_command(repo_root: Path) -> list[str]:
    # Prefer reproducible install when lockfile exists.
    if (repo_root / "package-lock.json").exists():
        return ["npm", "ci"]
    return ["npm", "install"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap this project in one command")
    parser.add_argument(
        "--with-icon",
        action="store_true",
        help="Run icon generation step after compile",
    )
    parser.add_argument(
        "--skip-compile",
        action="store_true",
        help="Skip TypeScript compile step",
    )
    parser.add_argument(
        "--cwd",
        default=".",
        help="Repository root directory (default: current directory)",
    )
    args = parser.parse_args()

    repo_root = Path(args.cwd).resolve()
    if not (repo_root / "package.json").exists():
        print(f"Error: package.json not found under {repo_root}")
        return 1

    require_tool("node", "Please install Node.js 18+ first.")
    require_tool("npm", "Please install npm first.")

    print(f"OS: {platform.system()} {platform.release()}")
    run_cmd(["node", "--version"], repo_root)
    run_cmd(["npm", "--version"], repo_root)

    try:
        run_cmd(choose_install_command(repo_root), repo_root)

        if not args.skip_compile:
            run_cmd(["npm", "run", "compile"], repo_root)

        if args.with_icon:
            run_cmd(["npm", "run", "set-icon"], repo_root)

    except subprocess.CalledProcessError as err:
        print("\nBootstrap failed.")
        return err.returncode or 1

    print("\nDone: project bootstrap completed successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
