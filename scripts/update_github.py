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
import re
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


def staged_files(cwd: Path) -> list[str]:
    result = run_cmd(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"], cwd)
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def find_secret_issues(cwd: Path) -> list[str]:
    issues: list[str] = []
    files = staged_files(cwd)
    if not files:
        return issues

    sensitive_file_re = [
        re.compile(r"(^|/)\.env(\.|$)", re.IGNORECASE),
        re.compile(r"(^|/)id_rsa(\.pub)?$", re.IGNORECASE),
        re.compile(r"\.(pem|p12|pfx|key)$", re.IGNORECASE),
    ]

    secret_re = [
        re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*[\"'][^\"']{8,}[\"']"),
        re.compile(r"sk-[A-Za-z0-9]{20,}"),
        re.compile(r"ghp_[A-Za-z0-9]{30,}"),
        re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
        re.compile(r"AIza[0-9A-Za-z\-_]{35}"),
    ]

    for rel in files:
        if any(p.search(rel) for p in sensitive_file_re):
            issues.append(f"Sensitive filename staged: {rel}")

        abs_path = cwd / rel
        if not abs_path.exists() or not abs_path.is_file():
            continue

        try:
            content = abs_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue

        if any(p.search(content) for p in secret_re):
            issues.append(f"Possible secret detected in file: {rel}")

    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description="One-click update project to GitHub")
    parser.add_argument("-m", "--message", help="Commit message")
    parser.add_argument("--remote", default="origin", help="Remote name (default: origin)")
    parser.add_argument("--branch", help="Branch name (default: current branch)")
    parser.add_argument(
        "--allow-secrets",
        action="store_true",
        help="Bypass secret detection (NOT recommended)",
    )
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

        if not args.allow_secrets:
            issues = find_secret_issues(cwd)
            if issues:
                print("\nSafety check failed. Possible secrets detected in staged changes:")
                for item in issues:
                    print(f"- {item}")
                print("\nPlease remove secrets, update .gitignore, or use --allow-secrets if you are sure.")
                return 1

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
