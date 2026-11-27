import asyncio
import fnmatch
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Default repository directory: workspace root of Vox-Agent
DEFAULT_REPO_PATH = str(Path(__file__).resolve().parents[3])

# Strict blacklist patterns for sensitive files that must NEVER be staged or committed
SENSITIVE_PATTERNS = [
    "*.env",
    "*.env.*",
    ".env*",
    "*id_rsa*",
    "*id_ed25519*",
    "*.pem",
    "*.key",
    "*.pfx",
    "*.pkcs12",
    "*credentials*.json",
    "*secret*.json",
    "*token*.json",
    "serviceAccountKey*.json",
]


_MULTI_REPO_KEYWORDS = {"local", "all", "all_local", "all_repos", "all local", "all local repos", "*"}
_SKIP_SCAN_DIRS = {"node_modules", "venv", ".venv", "__pycache__", "library", "dist", "build", ".git", ".cache"}


def discover_local_repos(include_downloads: bool = False) -> List[Dict[str, Any]]:
    """Fast scan of standard developer directories to find local Git repositories."""
    home = Path.home()
    primary_roots = [
        Path(DEFAULT_REPO_PATH).parent,
        home / "Documents",
        home / "Projects",
        home / "Developer",
        home / "Desktop",
        home / "code",
        home / "workspace",
        home / "repos",
        home / "src",
        home / "GitHub",
    ]
    if include_downloads:
        primary_roots.append(home / "Downloads")

    found_by_path: Dict[str, Dict[str, Any]] = {}
    seen_names: set[str] = set()

    def _register(repo_dir: Path, is_secondary: bool = False):
        resolved = str(repo_dir.resolve())
        if resolved in found_by_path:
            return
        name_lower = repo_dir.name.lower()
        # Avoid shadowing a primary workspace repo with a Downloads copy of the same name
        if is_secondary and name_lower in seen_names:
            return
        seen_names.add(name_lower)
        found_by_path[resolved] = {
            "name": repo_dir.name,
            "path": resolved,
            "is_default": resolved == str(Path(DEFAULT_REPO_PATH).resolve()),
        }

    # Always ensure DEFAULT_REPO_PATH is first if it's a git repo
    default_dir = Path(DEFAULT_REPO_PATH)
    if (default_dir / ".git").exists():
        _register(default_dir)

    seen_roots = set()
    for root in primary_roots:
        try:
            if not root.exists() or not root.is_dir():
                continue
            resolved_root = str(root.resolve())
            if resolved_root in seen_roots:
                continue
            seen_roots.add(resolved_root)
            is_downloads = root.name.lower() == "downloads"

            if (root / ".git").exists():
                _register(root, is_secondary=is_downloads)

            # Scan depth 1 (and depth 2 for nested workspace folders)
            for child in root.iterdir():
                if not child.is_dir():
                    continue
                cname = child.name.lower()
                if cname.startswith(".") or cname in _SKIP_SCAN_DIRS:
                    continue
                if (child / ".git").exists():
                    _register(child, is_secondary=is_downloads)
                else:
                    # Depth 2 check (skipping heavy folders)
                    try:
                        for grandchild in child.iterdir():
                            if (
                                grandchild.is_dir()
                                and not grandchild.name.startswith(".")
                                and grandchild.name.lower() not in _SKIP_SCAN_DIRS
                                and (grandchild / ".git").exists()
                            ):
                                _register(grandchild, is_secondary=is_downloads)
                    except PermissionError:
                        continue
        except Exception:
            continue

    repos = list(found_by_path.values())
    repos.sort(key=lambda r: (not r["is_default"], r["name"].lower()))
    return repos


def resolve_repo_path(custom_path: Optional[str] = None) -> Path:
    """Resolves and validates the target Git repository path by path or repository name."""
    raw = (custom_path or "").strip()
    if not raw or raw.lower() in ("auto", "default", "current", "this", "this repo"):
        return Path(DEFAULT_REPO_PATH)

    # Reject placeholder templates if any slipped through
    if "{" in raw or "}" in raw:
        return Path(DEFAULT_REPO_PATH)

    # 1. Direct filesystem path check
    direct = Path(raw).expanduser()
    if direct.is_absolute() and direct.exists() and direct.is_dir():
        return direct.resolve()
    if not direct.is_absolute():
        rel = Path(DEFAULT_REPO_PATH) / raw
        if rel.exists() and rel.is_dir() and (rel / ".git").exists():
            return rel.resolve()

    # 2. Match by repository name against discovered local repositories
    repos = discover_local_repos(include_downloads=True)
    raw_lower = raw.lower().removesuffix(".git")
    raw_norm = re.sub(r"[\s_\-]+", "", raw_lower)

    # Exact case-insensitive match first
    for r in repos:
        if r["name"].lower() == raw_lower:
            return Path(r["path"])

    # Normalized match (e.g. "sift recovery engine" -> "sift-recovery-engine")
    for r in repos:
        if re.sub(r"[\s_\-]+", "", r["name"].lower()) == raw_norm:
            return Path(r["path"])

    # Partial substring match
    for r in repos:
        if raw_lower in r["name"].lower() or raw_norm in re.sub(r"[\s_\-]+", "", r["name"].lower()):
            return Path(r["path"])

    available = ", ".join(r["name"] for r in repos[:12]) or "none found"
    raise ValueError(f"Repository '{custom_path}' was not found locally. Available local repositories: {available}")


def parse_github_remote(remote_url: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """Extracts (owner, repo) from HTTPS or SSH GitHub remote URLs."""
    if not remote_url:
        return None, None
    m = re.search(r"github\.com[:/]([\w\.\-]+)/([\w\.\-]+?)(?:\.git)?/?$", remote_url.strip())
    if m:
        return m.group(1), m.group(2).removesuffix(".git")
    return None, None


def is_sensitive_file(file_path: str) -> bool:
    """Checks if a file matches sensitive credential / secret patterns."""
    basename = os.path.basename(file_path)
    for pattern in SENSITIVE_PATTERNS:
        if fnmatch.fnmatch(basename.lower(), pattern.lower()) or fnmatch.fnmatch(file_path.lower(), pattern.lower()):
            return True
    return False


def ensure_gitignore_secrets(repo_path: Path, blocked_files: List[str]) -> bool:
    """Ensures blocked secret files are safely added to .gitignore if not already ignored."""
    gitignore_path = repo_path / ".gitignore"
    existing_content = ""
    if gitignore_path.exists():
        try:
            existing_content = gitignore_path.read_text(encoding="utf-8")
        except Exception as e:
            logger.warning(f"[git_engine] Failed to read .gitignore: {e}")

    lines_to_add = []
    # Always ensure standard .env patterns exist
    for rule in [".env", ".env.*", "*.pem", "*.key"]:
        if rule not in existing_content:
            lines_to_add.append(rule)

    for f in blocked_files:
        clean_name = os.path.basename(f)
        if clean_name not in existing_content and clean_name not in lines_to_add:
            lines_to_add.append(clean_name)

    if lines_to_add:
        try:
            prefix = "\n# Auto-added by VoxAgent Security Guard\n" if "\n" in existing_content or existing_content else "# Auto-added by VoxAgent Security Guard\n"
            append_block = prefix + "\n".join(lines_to_add) + "\n"
            with open(gitignore_path, "a", encoding="utf-8") as gf:
                gf.write(append_block)
            logger.info(f"[git_engine] Updated .gitignore with rules: {lines_to_add}")
            return True
        except Exception as e:
            logger.warning(f"[git_engine] Could not append to .gitignore: {e}")
    return False


async def run_git_command(args: List[str], repo_path: Path, timeout: float = 30.0) -> Tuple[int, str, str]:
    """Safely executes a git CLI command in the specified repo path with timeout."""
    cmd = ["git"] + args
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(repo_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        out_str = stdout.decode("utf-8", errors="replace").strip()
        err_str = stderr.decode("utf-8", errors="replace").strip()
        return proc.returncode, out_str, err_str
    except asyncio.TimeoutError:
        return -1, "", f"Git command timed out after {timeout} seconds: {' '.join(cmd)}"
    except Exception as e:
        return -1, "", f"Git command failed: {e}"


async def git_status(repo_path: Path) -> Dict[str, Any]:
    """Returns structured status of the local Git repository."""
    code, out, err = await run_git_command(["status", "--porcelain=v1", "-b"], repo_path)
    if code != 0:
        raise RuntimeError(f"git status failed: {err}")

    lines = out.split("\n") if out else []
    branch_line = lines[0] if lines and lines[0].startswith("##") else "## (detached)"
    file_lines = lines[1:] if len(lines) > 1 else []

    # Parse branch information e.g. ## main...origin/main [ahead 1] or ## No commits yet on main
    branch_clean = branch_line.replace("##", "").strip()
    upstream_remote = None
    tracking_status = ""
    current_branch = "main"

    if branch_clean.startswith("No commits yet on "):
        current_branch = branch_clean.replace("No commits yet on ", "").strip()
    elif branch_clean.startswith("Initial commit on "):
        current_branch = branch_clean.replace("Initial commit on ", "").strip()
    else:
        branch_match = re.match(r"^([\w\.\/\-]+)(?:\.\.\.([\w\.\/\-]+))?(?:\s+\[(.*)\])?", branch_clean)
        if branch_match:
            current_branch = branch_match.group(1)
            upstream_remote = branch_match.group(2)
            tracking_status = branch_match.group(3) or ""

    staged_files = []
    unstaged_files = []
    untracked_files = []

    for line in file_lines:
        if len(line) < 3:
            continue
        index_status = line[0]
        worktree_status = line[1]
        file_name = line[3:].strip()

        if index_status in ("M", "A", "D", "R", "C"):
            staged_files.append(file_name)
        if worktree_status in ("M", "D"):
            unstaged_files.append(file_name)
        if index_status == "?" and worktree_status == "?":
            untracked_files.append(file_name)

    # Check for remote URL and parse GitHub owner/repo
    _, remote_url, _ = await run_git_command(["config", "--get", "remote.origin.url"], repo_path)
    gh_owner, gh_repo = parse_github_remote(remote_url)

    # Detect default base branch (origin/HEAD -> main/master)
    default_branch = "main"
    _, head_ref, _ = await run_git_command(["symbolic-ref", "refs/remotes/origin/HEAD"], repo_path)
    if head_ref and "/" in head_ref:
        default_branch = head_ref.rsplit("/", 1)[-1].strip()
    elif current_branch == "master":
        default_branch = "master"

    # Optionally include unstaged diff preview if unstaged changes exist
    unstaged_diff_preview = ""
    if unstaged_files:
        _, raw_diff, _ = await run_git_command(["diff"], repo_path)
        if raw_diff:
            unstaged_diff_preview = raw_diff[:2500] + ("\n... [diff truncated]" if len(raw_diff) > 2500 else "")

    is_clean = len(file_lines) == 0
    summary_parts = [f"Repo: {repo_path.name} (branch: {current_branch})"]
    if is_clean:
        summary_parts.append("Working tree is clean.")
    else:
        if staged_files:
            summary_parts.append(f"Staged ({len(staged_files)}): {', '.join(staged_files[:10])}")
        if unstaged_files:
            summary_parts.append(f"Unstaged ({len(unstaged_files)}): {', '.join(unstaged_files[:10])}")
        if untracked_files:
            summary_parts.append(f"Untracked ({len(untracked_files)}): {', '.join(untracked_files[:10])}")

    total_pending = len(staged_files) + len(unstaged_files) + len(untracked_files)
    remote_display = f"{gh_owner}/{gh_repo}" if gh_owner and gh_repo else (remote_url or "Not connected")
    human_lines = [
        f"Repository: {repo_path.name}",
        f"Current Branch: {current_branch}",
        f"GitHub Remote: {remote_display}",
        "",
    ]
    if is_clean:
        human_lines.append("Status: Clean — no uncommitted changes.")
    else:
        human_lines.append(f"Status: {total_pending} file(s) with pending changes")
        if staged_files:
            human_lines.append(f"• Ready to commit (Staged): {', '.join(staged_files)}")
        if unstaged_files:
            human_lines.append(f"• Modified (Unstaged): {', '.join(unstaged_files)}")
        if untracked_files:
            human_lines.append(f"• New untracked files: {', '.join(untracked_files)}")
        if unstaged_diff_preview:
            human_lines.extend(["", "Code Changes Preview:", unstaged_diff_preview])

    return {
        "repository": repo_path.name,
        "repo_path": str(repo_path),
        "branch": current_branch,
        "default_branch": default_branch,
        "upstream": upstream_remote,
        "tracking_status": tracking_status,
        "remote_url": remote_url or None,
        "owner": gh_owner,
        "repo": gh_repo,
        "is_clean": is_clean,
        "staged_count": len(staged_files),
        "unstaged_count": len(unstaged_files),
        "untracked_count": len(untracked_files),
        "staged_files": staged_files,
        "unstaged_files": unstaged_files,
        "untracked_files": untracked_files,
        "unstaged_diff_preview": unstaged_diff_preview or None,
        "human_summary": "\n".join(human_lines),
        "message": " | ".join(summary_parts),
    }


async def git_diff(repo_path: Path, staged_only: bool = False, max_chars: int = 5000) -> Dict[str, Any]:
    """Returns unified diff of staged or unstaged working tree changes."""
    args = ["diff", "--cached"] if staged_only else ["diff"]
    code, out, err = await run_git_command(args, repo_path)
    if code != 0:
        raise RuntimeError(f"git diff failed: {err}")

    # Also check stat
    stat_args = args + ["--stat"]
    _, stat_out, _ = await run_git_command(stat_args, repo_path)

    diff_text = out
    truncated = False
    if len(diff_text) > max_chars:
        diff_text = diff_text[:max_chars] + f"\n\n... [Diff truncated: {len(out)} total characters]"
        truncated = True

    diff_label = "staged" if staged_only else "unstaged"
    human_summary = (
        f"Repository: {repo_path.name} ({diff_label} changes)\n\n"
        + (f"No {diff_label} modifications found." if not out.strip() else f"Files Changed:\n{stat_out.strip()}\n\nDiff:\n{diff_text.strip()}")
    )

    return {
        "staged_only": staged_only,
        "has_changes": bool(out.strip()),
        "summary_stat": stat_out.strip(),
        "diff": diff_text.strip(),
        "is_truncated": truncated,
        "total_chars": len(out),
        "human_summary": human_summary,
    }


async def git_add(repo_path: Path, files: Optional[List[str]] = None) -> Dict[str, Any]:
    """Stages files for commit, automatically intercepting and blocking secret files."""
    status = await git_status(repo_path)
    candidate_files = files if files else (status["unstaged_files"] + status["untracked_files"])

    safe_files_to_stage = []
    blocked_secrets = []

    for f in candidate_files:
        if is_sensitive_file(f):
            blocked_secrets.append(f)
        else:
            safe_files_to_stage.append(f)

    if blocked_secrets:
        ensure_gitignore_secrets(repo_path, blocked_secrets)

    if not safe_files_to_stage:
        return {
            "staged": False,
            "message": "No non-sensitive files to stage.",
            "blocked_secrets": blocked_secrets,
            "staged_files": [],
        }

    # Stage safe files
    code, _, err = await run_git_command(["add"] + safe_files_to_stage, repo_path)
    if code != 0:
        raise RuntimeError(f"git add failed: {err}")

    return {
        "staged": True,
        "staged_files": safe_files_to_stage,
        "blocked_secrets": blocked_secrets,
        "message": f"Successfully staged {len(safe_files_to_stage)} safe file(s)." + (
            f" Blocked {len(blocked_secrets)} sensitive file(s) from staging." if blocked_secrets else ""
        ),
    }


async def git_commit(repo_path: Path, message: str) -> Dict[str, Any]:
    """Creates a commit with the specified message."""
    clean_msg = (message or "").strip()
    if not clean_msg:
        raise ValueError("Commit message cannot be empty.")

    code, out, err = await run_git_command(["commit", "-m", clean_msg], repo_path)
    if code != 0:
        # Check if nothing was staged
        if "nothing to commit" in out.lower() or "nothing to commit" in err.lower():
            return {"committed": False, "message": "Nothing to commit, working tree clean."}
        raise RuntimeError(f"git commit failed: {err or out}")

    # Get last commit SHA and details
    _, log_out, _ = await run_git_command(["log", "-1", "--format=%h %s (%an)"], repo_path)

    return {
        "committed": True,
        "commit_summary": log_out.strip(),
        "commit_message": clean_msg,
        "output": out.strip(),
    }


async def git_push(
    repo_path: Path,
    branch: Optional[str] = None,
    remote: str = "origin",
    remote_url: Optional[str] = None,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Pushes to remote origin with automatic upstream tracking setup."""
    status = await git_status(repo_path)
    target_branch = branch or status["branch"]

    if remote_url:
        configured = await configure_remote_origin(repo_path, remote_url, user_id=user_id)
        if configured == "local_only":
            return {
                "pushed": False,
                "branch": target_branch,
                "remote": remote,
                "message": "Push skipped (local-only mode selected).",
            }
        status = await git_status(repo_path)
    elif remote == "origin" and not status.get("remote_url"):
        return {
            "status": "needs_input",
            "missing_field": "remote_url",
            "question": (
                f"Repository '{repo_path.name}' doesn't have a GitHub 'origin' remote configured yet. "
                f"Paste your GitHub repo URL (e.g. https://github.com/username/{repo_path.name}.git), "
                f"type 'create' to auto-create it on your connected GitHub account, or type 'skip' to skip remote push:"
            ),
        }

    # Run push with -u to guarantee upstream tracking
    code, out, err = await run_git_command(["push", "-u", remote, target_branch], repo_path, timeout=60.0)
    if code != 0:
        raise RuntimeError(f"git push failed: {err or out}")

    # Generate web URL if GitHub remote
    web_url = None
    remote_url = status.get("remote_url") or ""
    if "github.com" in remote_url:
        m = re.search(r"github\.com[:/]([\w\.\-]+)/([\w\.\-]+)(?:\.git)?", remote_url)
        if m:
            owner, repo_name = m.group(1), m.group(2).removesuffix(".git")
            web_url = f"https://github.com/{owner}/{repo_name}/tree/{target_branch}"

    return {
        "pushed": True,
        "branch": target_branch,
        "remote": remote,
        "remote_branch_url": web_url,
        "output": out or err,
        "message": f"Successfully pushed branch '{target_branch}' to {remote}."
    }


async def git_checkout(repo_path: Path, branch: str, create: bool = False) -> Dict[str, Any]:
    """Switches to or creates a new branch."""
    clean_branch = branch.strip()
    if not clean_branch:
        raise ValueError("Branch name cannot be empty.")

    args = ["checkout", "-b", clean_branch] if create else ["checkout", clean_branch]
    code, out, err = await run_git_command(args, repo_path)

    # If simple checkout failed because branch doesn't exist, try creating it
    if code != 0 and not create and ("did not match any file" in err or "pathspec" in err):
        code, out, err = await run_git_command(["checkout", "-b", clean_branch], repo_path)

    if code != 0:
        raise RuntimeError(f"git checkout failed: {err or out}")

    return {
        "switched": True,
        "branch": clean_branch,
        "created_new": create or ("Switched to a new branch" in (out + err)),
        "message": f"Switched to branch '{clean_branch}'.",
    }


async def git_log(repo_path: Path, limit: int = 5, since: Optional[str] = None) -> Dict[str, Any]:
    """Fetches recent commits formatted for daily standups and reports."""
    args = ["log", f"-n{max(1, min(20, limit))}", '--pretty=format:{"hash":"%h","author":"%an","date":"%ar","message":"%s"}']
    if since:
        args.append(f"--since={since}")

    code, out, err = await run_git_command(args, repo_path)
    if code != 0:
        # Handle brand-new repo with zero commits cleanly
        if "does not have any commits yet" in (err or "").lower():
            return {
                "repository": repo_path.name,
                "count": 0,
                "commits": [],
                "since": since,
                "message": f"Repository '{repo_path.name}' has no commits yet.",
            }
        raise RuntimeError(f"git log failed: {err}")

    def _parse_commits(raw_out: str) -> List[Dict[str, Any]]:
        parsed = []
        for line in raw_out.split("\n"):
            if line.strip():
                try:
                    import json
                    parsed.append(json.loads(line.strip()))
                except Exception:
                    parsed.append({"raw": line.strip()})
        return parsed

    commits = _parse_commits(out)
    recent_fallback = []
    if not commits and since:
        # Provide recent commits for context when nothing matched the narrow timeframe
        fb_args = ["log", "-n3", '--pretty=format:{"hash":"%h","author":"%an","date":"%ar","message":"%s"}']
        fb_code, fb_out, _ = await run_git_command(fb_args, repo_path)
        if fb_code == 0 and fb_out:
            recent_fallback = _parse_commits(fb_out)

    if commits:
        summary_msg = f"Found {len(commits)} commit(s) in '{repo_path.name}'" + (f" since {since}." if since else ".")
    elif recent_fallback:
        summary_msg = f"No commits in '{repo_path.name}' since '{since}'. Latest {len(recent_fallback)} prior commit(s) included for reference."
    else:
        summary_msg = f"No commits found in '{repo_path.name}'" + (f" since '{since}'." if since else ".")

    return {
        "repository": repo_path.name,
        "count": len(commits),
        "commits": commits,
        "recent_commits_fallback": recent_fallback if recent_fallback else None,
        "since": since,
        "message": summary_msg,
    }


async def ensure_remote_base_branch(repo_path: Path, base_branch: str, target_branch: str) -> None:
    """Guarantees base_branch (e.g. 'main') exists on origin with a valid merge base for PRs."""
    if not target_branch or target_branch == base_branch:
        return

    _, ls_out, _ = await run_git_command(["ls-remote", "--heads", "origin", base_branch], repo_path)
    if ls_out and ls_out.strip():
        return  # Base branch already exists on GitHub/origin

    # Case 1: Local base branch exists -> push it to origin
    ref_code, _, _ = await run_git_command(["show-ref", "--verify", "--quiet", f"refs/heads/{base_branch}"], repo_path)
    if ref_code == 0:
        await run_git_command(["push", "-u", "origin", base_branch], repo_path, timeout=60.0)
        return

    # Case 2: Repo jumped straight to feature branch; derive base_branch cleanly
    parent_code, _, _ = await run_git_command(["rev-parse", "--verify", "HEAD^"], repo_path)
    if parent_code == 0:
        await run_git_command(["branch", base_branch, "HEAD^"], repo_path)
        await run_git_command(["push", "-u", "origin", base_branch], repo_path, timeout=60.0)
        return

    # Case 3: Single root commit on target_branch -> create empty root commit on base_branch and rebase target_branch onto it
    tree_proc = await asyncio.create_subprocess_exec(
        "git", "mktree",
        cwd=str(repo_path),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    tree_out, _ = await tree_proc.communicate(input=b"")
    empty_tree = tree_out.decode("utf-8").strip()
    if tree_proc.returncode == 0 and empty_tree:
        rc, root_sha, _ = await run_git_command(
            ["commit-tree", empty_tree, "-m", "chore: initial repository base"], repo_path
        )
        if rc == 0 and root_sha:
            await run_git_command(["branch", base_branch, root_sha.strip()], repo_path)
            await run_git_command(["push", "-u", "origin", base_branch], repo_path, timeout=60.0)
            reb_rc, _, _ = await run_git_command(
                ["rebase", "--onto", base_branch, "--root", target_branch], repo_path
            )
            if reb_rc == 0:
                await run_git_command(
                    ["push", "-u", "--force-with-lease", "origin", target_branch], repo_path, timeout=60.0
                )


async def ensure_git_identity(repo_path: Path) -> None:
    """Ensures git user.name and user.email exist locally so commits never fail."""
    _, uname, _ = await run_git_command(["config", "user.name"], repo_path)
    _, uemail, _ = await run_git_command(["config", "user.email"], repo_path)
    if not uname:
        await run_git_command(["config", "user.name", "VoxAgent Developer"], repo_path)
    if not uemail:
        await run_git_command(["config", "user.email", "dev@voxagent.local"], repo_path)


async def configure_remote_origin(
    repo_path: Path,
    remote_url: str,
    user_id: Optional[str] = None,
) -> str:
    """Configures git remote 'origin' from a URL or auto-creates a GitHub repo via Composio."""
    clean_url = (remote_url or "").strip().strip('"').strip("'")
    lowered = clean_url.lower()

    if lowered in ("local", "none", "skip", "local_only", "no"):
        return "local_only"

    if lowered in ("create", "auto", "new", "github", "create repo"):
        try:
            from app.services.composio_engine import execute_composio_action
            gh_res = await execute_composio_action(
                app="GitHub",
                action="GITHUB_CREATE_REPOSITORY_FOR_THE_AUTHENTICATED_USER",
                parameters={"name": repo_path.name, "private": False},
                entity_id=user_id,
            )
            if gh_res.get("status") != "success":
                raise RuntimeError(gh_res.get("error") or gh_res.get("message") or "GitHub repo creation failed")
            out = gh_res.get("output") or {}
            data_obj = out.get("data", out) if isinstance(out, dict) else {}
            clone_url = None
            if isinstance(data_obj, dict):
                clone_url = data_obj.get("clone_url") or data_obj.get("html_url")
            if not clone_url:
                raise RuntimeError("GitHub created repository but did not return clone_url.")
            clean_url = clone_url if clone_url.endswith(".git") else f"{clone_url.rstrip('/')}.git"
        except Exception as gh_err:
            raise ValueError(
                f"Could not auto-create GitHub repository ({gh_err}). "
                f"Please paste your GitHub repository URL directly (e.g. https://github.com/username/{repo_path.name}.git)."
            )

    if not re.match(r"^(https?://|git@|ssh://)", clean_url):
        raise ValueError(
            f"Invalid Git remote URL: '{clean_url}'. Expected a GitHub URL like "
            f"'https://github.com/username/{repo_path.name}.git', or type 'create' / 'skip'."
        )

    code, existing, _ = await run_git_command(["remote", "get-url", "origin"], repo_path)
    cmd = ["remote", "set-url", "origin", clean_url] if code == 0 and existing else ["remote", "add", "origin", clean_url]
    rc, out, err = await run_git_command(cmd, repo_path)
    if rc != 0:
        raise RuntimeError(f"Failed to configure remote origin: {err or out}")
    return clean_url


async def git_smart_push(
    repo_path: Path,
    branch: Optional[str] = None,
    commit_message: Optional[str] = None,
    user_id: Optional[str] = None,
    remote_url: Optional[str] = None,
) -> Dict[str, Any]:
    """Composite action: Validates remote origin, checks status, generates AI commit message, stages, commits, and pushes."""
    # 1. Status check
    status = await git_status(repo_path)

    # Determine if there are unpushed local commits even when working tree is clean
    has_unpushed_commits = False
    if status["is_clean"]:
        _, rev_cnt, _ = await run_git_command(["rev-list", "--count", "HEAD"], repo_path)
        has_commits = rev_cnt.isdigit() and int(rev_cnt) > 0
        if has_commits and ("ahead" in (status.get("tracking_status") or "") or not status.get("upstream")):
            has_unpushed_commits = True

    if status["is_clean"] and not has_unpushed_commits:
        return {
            "status": "success",
            "message": "Working tree is completely clean and up to date with origin. Nothing to commit or push.",
            "repository": status["repository"],
            "owner": status.get("owner"),
            "repo": status.get("repo"),
            "branch": status["branch"],
            "default_branch": status.get("default_branch") or "main",
            "committed": False,
            "pushed": False,
        }

    # 2. Configure remote origin if supplied via parameter/resume, or pause cleanly to ask if missing
    local_only = False
    if remote_url:
        configured = await configure_remote_origin(repo_path, remote_url, user_id=user_id)
        if configured == "local_only":
            local_only = True
        else:
            status = await git_status(repo_path)
    elif not status.get("remote_url"):
        return {
            "status": "needs_input",
            "missing_field": "remote_url",
            "question": (
                f"Repository '{repo_path.name}' doesn't have a GitHub 'origin' remote configured yet. "
                f"Paste your GitHub repo URL (e.g. https://github.com/username/{repo_path.name}.git), "
                f"type 'create' to auto-create it on your connected GitHub account, or type 'skip' to commit locally only:"
            ),
        }

    await ensure_git_identity(repo_path)

    # 3. Switch branch if requested
    target_branch = branch.strip() if branch else status["branch"]
    if target_branch != status["branch"]:
        # Ensure current branch has at least one commit before branching if needed
        _, head_cnt, _ = await run_git_command(["rev-list", "--count", "HEAD"], repo_path)
        if not (head_cnt.isdigit() and int(head_cnt) > 0) and not status["is_clean"]:
            # Stage & commit base state on default branch first so main exists for PRs
            base_add = await git_add(repo_path)
            if base_add["staged"]:
                await git_commit(repo_path, "chore: initial commit")
                if not local_only:
                    await git_push(repo_path, branch=status["branch"])
        await git_checkout(repo_path, target_branch)

    # 4. Stage & commit working tree changes if not clean
    final_msg = (commit_message or "").strip()
    add_result = {"staged": False, "staged_files": [], "blocked_secrets": []}
    commit_res = {}

    if not status["is_clean"]:
        add_result = await git_add(repo_path)
        if not add_result["staged"] and not has_unpushed_commits:
            return {
                "status": "warning",
                "message": "No non-sensitive files could be staged. Check blocked secrets.",
                "blocked_secrets": add_result["blocked_secrets"],
            }

        if add_result["staged"]:
            if not final_msg:
                diff_info = await git_diff(repo_path, staged_only=True, max_chars=3000)
                diff_text = diff_info.get("diff", "")
                stat_text = diff_info.get("summary_stat", "")

                try:
                    from app.services.planner import generate_ai_content
                    prompt = (
                        f"You are an expert software engineer. Analyze this git diff and output ONLY a single-line "
                        f"Conventional Commit message adhering to standard format (e.g. feat(scope): concise description, "
                        f"or fix(scope): concise description). Do not include quotes, markdown backticks, or extra text.\n\n"
                        f"Changed files summary:\n{stat_text}\n\nDiff snippet:\n{diff_text[:2000]}"
                    )
                    ai_msg = await asyncio.to_thread(generate_ai_content, prompt, user_id=user_id)
                    clean_ai_msg = ai_msg.strip().strip('"').strip("'").strip("`")
                    if clean_ai_msg and len(clean_ai_msg) < 120:
                        final_msg = clean_ai_msg
                except Exception as _ai_err:
                    logger.warning(f"[git_engine] AI commit generation failed: {_ai_err}")

            if not final_msg:
                final_msg = f"chore: update {len(add_result['staged_files'])} file(s)"

            commit_res = await git_commit(repo_path, final_msg)
    elif not final_msg:
        _, last_subj, _ = await run_git_command(["log", "-1", "--pretty=%s"], repo_path)
        final_msg = last_subj.strip() or f"feat: updates on {target_branch}"

    # 5. Push (unless user explicitly asked for local-only)
    push_res = {}
    base_branch = status.get("default_branch") or "main"
    if not local_only:
        await ensure_remote_base_branch(repo_path, base_branch, target_branch)
        push_res = await git_push(repo_path, branch=target_branch)

    # Refresh status after push to pick up final owner/repo
    final_status = await git_status(repo_path)

    # 6. Build structured PR metadata for downstream GitHub PR creation
    staged_list_md = "\n".join(f"- `{f}`" for f in add_result["staged_files"][:25])
    if len(add_result["staged_files"]) > 25:
        staged_list_md += f"\n- ... and {len(add_result['staged_files']) - 25} more file(s)"
    pr_body = (
        f"## Summary\n{final_msg}\n\n"
        + (f"## Changed Files ({len(add_result['staged_files'])})\n{staged_list_md}\n\n" if add_result["staged_files"] else "")
        + f"## Security Guard\n- Secret scan passed ({len(add_result['blocked_secrets'])} sensitive file(s) shielded)\n\n"
        f"*Automated via VoxAgent Developer Suite*"
    )

    return {
        "status": "success",
        "action": "GIT_SMART_PUSH",
        "repository": final_status["repository"],
        "repo_path": final_status["repo_path"],
        "owner": final_status.get("owner"),
        "repo": final_status.get("repo"),
        "branch": target_branch,
        "default_branch": final_status.get("default_branch") or "main",
        "commit_message": final_msg,
        "pr_title": final_msg,
        "pr_body": pr_body,
        "commit_summary": commit_res.get("commit_summary"),
        "staged_files": add_result["staged_files"],
        "blocked_secrets": add_result["blocked_secrets"],
        "remote_branch_url": push_res.get("remote_branch_url"),
        "pushed": not local_only,
        "message": (
            f"Committed locally to '{target_branch}' (remote skipped): {final_msg}"
            if local_only
            else f"Successfully committed and pushed to '{target_branch}'! Commit: {final_msg}"
        ),
    }


async def git_init_repo(
    repo_path: Path,
    readme_title: Optional[str] = None,
    remote_url: Optional[str] = None,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Scaffolds a safe Git repository with .gitignore, README.md, initial commit, and optional origin remote."""
    repo_path.mkdir(parents=True, exist_ok=True)
    already_git = (repo_path / ".git").exists()
    if not already_git:
        code, out, err = await run_git_command(["init", "-b", "main"], repo_path)
        if code != 0:
            raise RuntimeError(f"git init failed: {err or out}")

    await ensure_git_identity(repo_path)
    ensure_gitignore_secrets(repo_path, [])
    created_files = []
    gitignore_path = repo_path / ".gitignore"
    if gitignore_path.exists():
        created_files.append(".gitignore")

    readme_path = repo_path / "README.md"
    if not readme_path.exists():
        title = (readme_title or repo_path.name).strip()
        readme_path.write_text(f"# {title}\n\nInitialized with VoxAgent Developer Suite.\n", encoding="utf-8")
        created_files.append("README.md")

    # Ensure root commit exists on main so branching/pushing works immediately
    _, rev_cnt, _ = await run_git_command(["rev-list", "--count", "HEAD"], repo_path)
    initial_committed = False
    if not (rev_cnt.isdigit() and int(rev_cnt) > 0):
        await git_add(repo_path)
        await git_commit(repo_path, "chore: initial repository scaffolding")
        initial_committed = True

    configured_remote = None
    pushed_remote = False
    if remote_url:
        res_url = await configure_remote_origin(repo_path, remote_url, user_id=user_id)
        if res_url != "local_only":
            configured_remote = res_url
            await git_push(repo_path, branch="main")
            pushed_remote = True

    return {
        "initialized": True,
        "already_existed": already_git,
        "initial_committed": initial_committed,
        "remote_url": configured_remote,
        "pushed": pushed_remote,
        "repository": repo_path.name,
        "repo_path": str(repo_path),
        "branch": "main",
        "files_ready": created_files,
        "message": (
            f"Initialized '{repo_path.name}', made initial commit on 'main', linked origin ({configured_remote}), and pushed!"
            if pushed_remote
            else f"Git repository '{repo_path.name}' initialized on 'main' with initial commit and .gitignore secret guard."
        ),
    }


async def _execute_multi_repo_action(
    act: str,
    params: Dict[str, Any],
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Executes supported Git actions across all discovered primary local repositories."""
    repos = discover_local_repos(include_downloads=False)
    if not repos:
        return {"status": "error", "error": "No local Git repositories found on this machine."}

    async def _run_one(repo_info: Dict[str, Any]) -> Dict[str, Any]:
        rpath = Path(repo_info["path"])
        try:
            if act in ("GIT_STATUS", "STATUS"):
                return await git_status(rpath)
            if act in ("GIT_DIFF", "DIFF"):
                staged_only = bool(params.get("staged_only") or params.get("staged"))
                return await git_diff(rpath, staged_only=staged_only, max_chars=2500)
            if act in ("GIT_LOG", "LOG", "STANDUP_LOG"):
                limit = int(params.get("limit", 5))
                since = params.get("since") or params.get("timeframe")
                return await git_log(rpath, limit=limit, since=since)
            if act in ("GIT_SMART_PUSH", "SMART_PUSH", "COMMIT_AND_PUSH", "GIT_COMMIT_AND_PUSH"):
                status = await git_status(rpath)
                if status["is_clean"]:
                    return {"repository": rpath.name, "skipped": True, "message": "Clean (no changes)"}
                return await git_smart_push(
                    rpath,
                    branch=params.get("branch"),
                    commit_message=params.get("commit_message") or params.get("message"),
                    user_id=user_id,
                )
            return {"repository": rpath.name, "error": f"Multi-repo mode ('local') does not support action '{act}'."}
        except Exception as err:
            return {"repository": rpath.name, "error": str(err)}

    results = await asyncio.gather(*[_run_one(r) for r in repos])

    if act in ("GIT_LOG", "LOG", "STANDUP_LOG"):
        all_commits = []
        summaries = []
        for r in results:
            rname = r.get("repository", "repo")
            for c in r.get("commits") or []:
                all_commits.append({"repository": rname, **c})
            if r.get("message"):
                summaries.append(r["message"])
        return {
            "status": "success",
            "result": {
                "multi_repo": True,
                "repository": "All Local Repos",
                "repositories_scanned": [r["name"] for r in repos],
                "count": len(all_commits),
                "commits": all_commits,
                "per_repo": results,
                "message": f"Scanned {len(repos)} local repo(s): found {len(all_commits)} total commit(s).\n" + "\n".join(summaries),
            },
        }

    if act in ("GIT_STATUS", "STATUS"):
        dirty = [r for r in results if not r.get("is_clean") and not r.get("error")]
        clean = [r for r in results if r.get("is_clean") and not r.get("error")]
        lines = [r.get("message") or f"{r.get('repository')}: error" for r in results]
        human_lines = [
            f"Scanned {len(repos)} local repositories:",
            f"• {len(dirty)} repo(s) have uncommitted changes",
            f"• {len(clean)} repo(s) are completely clean",
            "",
        ]
        if dirty:
            human_lines.append("Repositories with pending changes:")
            for r in dirty:
                pending = r.get("staged_count", 0) + r.get("unstaged_count", 0) + r.get("untracked_count", 0)
                human_lines.append(f"• {r.get('repository')} (branch: {r.get('branch')}) — {pending} file(s) changed")
        return {
            "status": "success",
            "result": {
                "multi_repo": True,
                "repository": "All Local Repos",
                "repositories_scanned": [r["name"] for r in repos],
                "dirty_count": len(dirty),
                "per_repo": results,
                "human_summary": "\n".join(human_lines),
                "message": f"Checked {len(repos)} local repo(s) ({len(dirty)} with uncommitted changes):\n" + "\n".join(lines),
            },
        }

    lines = [f"{r.get('repository')}: {r.get('message') or r.get('error') or 'done'}" for r in results]
    return {
        "status": "success",
        "result": {
            "multi_repo": True,
            "repository": "All Local Repos",
            "repositories_scanned": [r["name"] for r in repos],
            "per_repo": results,
            "message": f"Executed {act} across {len(repos)} local repo(s):\n" + "\n".join(lines),
        },
    }


_MUTATING_GIT_ACTIONS = {
    "GIT_SMART_PUSH", "SMART_PUSH", "COMMIT_AND_PUSH", "GIT_COMMIT_AND_PUSH",
    "GIT_COMMIT", "COMMIT",
    "GIT_PUSH", "PUSH",
    "GIT_CHECKOUT", "GIT_BRANCH", "CHECKOUT_BRANCH",
    "GIT_ADD", "STAGE",
}


async def execute_git_action(
    action: str,
    parameters: Optional[Dict[str, Any]] = None,
    user_id: Optional[str] = None
) -> Dict[str, Any]:
    """Unified entrypoint for orchestrator to execute local Git actions."""
    params = parameters or {}
    custom_repo_path = (
        params.get("repo_path")
        or params.get("workspace_path")
        or params.get("repo")
        or params.get("repository")
        or params.get("repo_name")
        or params.get("project")
    )

    act = (action or "").upper().strip()

    # Safety Guard: NEVER silently commit/push/checkout Vox-Agent (DEFAULT_REPO_PATH)
    # when the user didn't explicitly pick or name a repository!
    raw_repo_str = str(custom_repo_path or "").strip()
    is_unspecified_repo = (
        not raw_repo_str
        or raw_repo_str.lower() in ("auto", "default", "current", "this", "this repo")
        or "{" in raw_repo_str
        or "}" in raw_repo_str
    )
    if act in _MUTATING_GIT_ACTIONS and is_unspecified_repo:
        discovered = discover_local_repos(include_downloads=False)
        # Put non-default demo/user repos ahead of Vox-Agent so user doesn't pick Vox-Agent by accident
        ordered = [r["name"] for r in discovered if not r.get("is_default")] + [
            r["name"] for r in discovered if r.get("is_default")
        ]
        return {
            "status": "needs_input",
            "missing_field": "repository",
            "options": ordered[:25] if ordered else None,
            "question": (
                f"Safety Check: Which repository should I run `{act}` on? "
                f"To protect your active codebase from accidental commits, please select or enter the repository name:"
            ),
        }

    if isinstance(custom_repo_path, str) and custom_repo_path.strip().lower() in _MULTI_REPO_KEYWORDS:
        return await _execute_multi_repo_action(act, params, user_id=user_id)

    if act in ("GIT_INIT", "INIT", "SCAFFOLD", "GIT_SCAFFOLD"):
        if custom_repo_path and str(custom_repo_path).strip():
            raw_init = Path(str(custom_repo_path).strip()).expanduser()
            init_path = raw_init.resolve() if raw_init.is_absolute() else (Path(DEFAULT_REPO_PATH).parent / raw_init).resolve()
        else:
            init_path = Path(DEFAULT_REPO_PATH)
        title = params.get("title") or params.get("readme_title")
        remote_url = params.get("remote_url") or params.get("github_url")
        try:
            res = await git_init_repo(init_path, readme_title=title, remote_url=remote_url, user_id=user_id)
            return {"status": "success", "result": res}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    try:
        repo_path = resolve_repo_path(custom_repo_path)
    except Exception as e:
        return {"status": "error", "error": f"Invalid repository path: {e}"}

    try:
        if act in ("GIT_STATUS", "STATUS"):
            res = await git_status(repo_path)
            return {"status": "success", "result": res}

        if act in ("GIT_DIFF", "DIFF"):
            staged_only = bool(params.get("staged_only") or params.get("staged"))
            max_chars = int(params.get("max_chars", 5000))
            res = await git_diff(repo_path, staged_only=staged_only, max_chars=max_chars)
            return {"status": "success", "result": res}

        if act in ("GIT_ADD", "STAGE"):
            files = params.get("files")
            if isinstance(files, str):
                files = [f.strip() for f in files.split(",") if f.strip()]
            res = await git_add(repo_path, files=files)
            return {"status": "success", "result": res}

        if act in ("GIT_COMMIT", "COMMIT"):
            msg = params.get("message") or params.get("commit_message") or params.get("text") or "chore: updates"
            res = await git_commit(repo_path, message=msg)
            return {"status": "success", "result": res}

        if act in ("GIT_PUSH", "PUSH"):
            branch = params.get("branch")
            remote = params.get("remote") or "origin"
            remote_url = params.get("remote_url") or params.get("github_url")
            res = await git_push(repo_path, branch=branch, remote=remote, remote_url=remote_url, user_id=user_id)
            if isinstance(res, dict) and res.get("status") == "needs_input":
                return res
            return {"status": "success", "result": res}

        if act in ("GIT_CHECKOUT", "GIT_BRANCH", "CHECKOUT_BRANCH"):
            branch = params.get("branch") or params.get("branch_name") or params.get("name")
            create = bool(params.get("create") or params.get("new_branch"))
            res = await git_checkout(repo_path, branch=branch, create=create)
            return {"status": "success", "result": res}

        if act in ("GIT_LOG", "LOG", "STANDUP_LOG"):
            limit = int(params.get("limit", 5))
            since = params.get("since") or params.get("timeframe")
            res = await git_log(repo_path, limit=limit, since=since)
            return {"status": "success", "result": res}

        if act in ("GIT_SMART_PUSH", "SMART_PUSH", "COMMIT_AND_PUSH", "GIT_COMMIT_AND_PUSH"):
            branch = params.get("branch")
            msg = params.get("commit_message") or params.get("message")
            remote_url = params.get("remote_url") or params.get("github_url")
            res = await git_smart_push(
                repo_path,
                branch=branch,
                commit_message=msg,
                user_id=user_id,
                remote_url=remote_url,
            )
            if isinstance(res, dict) and res.get("status") == "needs_input":
                return res
            return {"status": "success", "result": res}

        if act in ("GIT_INIT", "INIT", "SCAFFOLD", "GIT_SCAFFOLD"):
            title = params.get("title") or params.get("readme_title")
            res = await git_init_repo(repo_path, readme_title=title)
            return {"status": "success", "result": res}

        return {
            "status": "error",
            "error": f"Unknown Git action: '{action}'. Supported actions: GIT_STATUS, GIT_DIFF, GIT_ADD, GIT_COMMIT, GIT_PUSH, GIT_CHECKOUT, GIT_LOG, GIT_SMART_PUSH, GIT_INIT."
        }
    except Exception as e:
        logger.error(f"[git_engine] Action '{action}' failed: {e}", exc_info=True)
        return {"status": "error", "error": str(e)}
