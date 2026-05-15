#!/usr/bin/env python3
"""One-click update local project to GitHub.

Usage:
  python scripts/update_github.py
  python scripts/update_github.py -m "feat: update something"
  python scripts/update_github.py --branch main --remote origin
"""

from __future__ import annotations

import argparse
import datetime as dt
import shutil
import subprocess
import sys
from pathlib import Path


def run_cmd(cmd: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    print("$", " ".join(cmd))
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=check)


def ensure_git_exists() -> None:
    if shutil.which("git") is None:
        print("Error: git is not installed or not in PATH.")
        sys.exit(1)


def ensure_git_repo(cwd: Path) -> None:
    result = run_cmd(["git", "rev-parse", "--is-inside-work-tree"], cwd, check=False)
    if result.returncode != 0 or result.stdout.strip() != "true":
        print("Error: current directory is not a Git repository.")
        sys.exit(1)


def has_changes(cwd: Path) -> bool:
    result = run_cmd(["git", "status", "--porcelain"], cwd)
    return bool(result.stdout.strip())


def resolve_branch(cwd: Path, branch_arg: str | None) -> str:
    if branch_arg:
        return branch_arg
    result = run_cmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd)
    branch = result.stdout.strip()
    if not branch or branch == "HEAD":
        print("Error: unable to determine current branch. Please use --branch.")
        sys.exit(1)
    return branch


def default_commit_message() -> str:
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return f"chore: update project ({now})"


def main() -> int:
    parser = argparse.ArgumentParser(description="One-click update project to GitHub")
    parser.add_argument("-m", "--message", help="Commit message")
    parser.add_argument("--remote", default="origin", help="Remote name (default: origin)")
    parser.add_argument("--branch", help="Branch name (default: current branch)")
    parser.add_argument(
        "--cwd",
        default=".",
        help="Working directory of the repository (default: current directory)",
    )
    args = parser.parse_args()

    cwd = Path(args.cwd).resolve()

    ensure_git_exists()
    ensure_git_repo(cwd)

    branch = resolve_branch(cwd, args.branch)

    print(f"Using repo: {cwd}")
    print(f"Using remote/branch: {args.remote}/{branch}")

    if not has_changes(cwd):
        print("No local changes detected. Nothing to commit.")
        return 0

    message = args.message or default_commit_message()

    try:
        run_cmd(["git", "add", "-A"], cwd)
        run_cmd(["git", "commit", "-m", message], cwd)

        # Rebase local branch on top of latest remote branch before push.
        run_cmd(["git", "pull", "--rebase", args.remote, branch], cwd)
        run_cmd(["git", "push", args.remote, branch], cwd)
    except subprocess.CalledProcessError as err:
        print("\nCommand failed:")
        print(err.stderr.strip() or err.stdout.strip() or str(err))
        return err.returncode or 1

    print("\nDone: project has been updated to GitHub successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
