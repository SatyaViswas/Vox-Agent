import asyncio
import hashlib
import io
import json
import logging
import os
import re
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.services.git_engine import (
    discover_local_repos,
    git_status,
    resolve_repo_path,
)
from app.services.vault import get_app_credentials, save_app_credentials

logger = logging.getLogger(__name__)

SUPPORTED_PLATFORMS = {"vercel", "render", "netlify"}

_PLATFORM_DISPLAY_NAMES = {
    "vercel": "Vercel",
    "render": "Render",
    "netlify": "Netlify",
}

_PLATFORM_TOKEN_HINTS = {
    "vercel": "https://vercel.com/account/tokens",
    "render": "https://dashboard.render.com/u/settings#api-keys",
    "netlify": "https://app.netlify.com/user/applications#personal-access-tokens",
}

_SKIP_UPLOAD_DIRS = {
    ".git",
    "node_modules",
    "venv",
    ".venv",
    "__pycache__",
    ".next",
    ".vercel",
    ".netlify",
    ".cache",
}

_SENSITIVE_FILENAMES = {".env", ".env.local", ".env.production", ".env.development", "id_rsa", "id_ed25519"}


def normalize_platform_name(raw_platform: Optional[str]) -> Optional[str]:
    """Normalizes user/planner platform string to 'vercel', 'render', or 'netlify'."""
    val = (raw_platform or "").strip().lower()
    for p in SUPPORTED_PLATFORMS:
        if p in val:
            return p
    return None


def _detect_single_dir(target_dir: Path) -> Dict[str, Any]:
    """Detects framework, build/start commands, and best cloud target for one directory."""
    pkg_path = target_dir / "package.json"
    req_path = target_dir / "requirements.txt"
    pyproj_path = target_dir / "pyproject.toml"
    docker_path = target_dir / "Dockerfile"
    index_html = target_dir / "index.html"

    info: Dict[str, Any] = {
        "directory": target_dir.name,
        "path": str(target_dir),
        "kind": "unknown",
        "framework": "Unknown",
        "build_command": None,
        "start_command": None,
        "output_dir": ".",
        "recommended_platform": "vercel",
        "has_env_file": (target_dir / ".env").exists() or (target_dir / ".env.production").exists(),
    }

    if pkg_path.exists():
        try:
            pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
        except Exception:
            pkg = {}
        deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
        scripts = pkg.get("scripts") or {}

        if "next" in deps:
            info.update({
                "kind": "frontend",
                "framework": "Next.js",
                "build_command": scripts.get("build") and "npm run build" or "next build",
                "start_command": "npm start",
                "output_dir": ".next",
                "recommended_platform": "vercel",
            })
        elif "vite" in deps:
            info.update({
                "kind": "frontend",
                "framework": "Vite",
                "build_command": "npm run build" if "build" in scripts else "vite build",
                "output_dir": "dist",
                "recommended_platform": "vercel",
            })
        elif "react-scripts" in deps:
            info.update({
                "kind": "frontend",
                "framework": "Create React App",
                "build_command": "npm run build",
                "output_dir": "build",
                "recommended_platform": "netlify",
            })
        elif any(k in deps for k in ("express", "fastify", "koa", "nestjs", "@nestjs/core")):
            info.update({
                "kind": "backend",
                "framework": "Node.js API",
                "build_command": "npm install" + (" && npm run build" if "build" in scripts else ""),
                "start_command": "npm start" if "start" in scripts else "node index.js",
                "output_dir": ".",
                "recommended_platform": "render",
            })
        else:
            info.update({
                "kind": "frontend",
                "framework": "Node / Web",
                "build_command": "npm run build" if "build" in scripts else None,
                "start_command": "npm start" if "start" in scripts else None,
                "output_dir": "dist" if (target_dir / "dist").exists() else ".",
                "recommended_platform": "vercel",
            })
        return info

    if req_path.exists() or pyproj_path.exists():
        req_text = ""
        if req_path.exists():
            try:
                req_text = req_path.read_text(encoding="utf-8").lower()
            except Exception:
                pass
        elif pyproj_path.exists():
            try:
                req_text = pyproj_path.read_text(encoding="utf-8").lower()
            except Exception:
                pass

        if "fastapi" in req_text or "uvicorn" in req_text:
            entry = "main:app" if (target_dir / "main.py").exists() else "app:app"
            info.update({
                "kind": "backend",
                "framework": "FastAPI",
                "build_command": "pip install -r requirements.txt" if req_path.exists() else "pip install .",
                "start_command": f"uvicorn {entry} --host 0.0.0.0 --port $PORT",
                "recommended_platform": "render",
            })
        elif "flask" in req_text:
            info.update({
                "kind": "backend",
                "framework": "Flask",
                "build_command": "pip install -r requirements.txt",
                "start_command": "gunicorn app:app --bind 0.0.0.0:$PORT",
                "recommended_platform": "render",
            })
        elif "django" in req_text:
            info.update({
                "kind": "backend",
                "framework": "Django",
                "build_command": "pip install -r requirements.txt",
                "start_command": "gunicorn config.wsgi:application --bind 0.0.0.0:$PORT",
                "recommended_platform": "render",
            })
        else:
            info.update({
                "kind": "backend",
                "framework": "Python",
                "build_command": "pip install -r requirements.txt" if req_path.exists() else None,
                "start_command": "python main.py" if (target_dir / "main.py").exists() else "python app.py",
                "recommended_platform": "render",
            })
        return info

    if docker_path.exists():
        info.update({
            "kind": "backend",
            "framework": "Docker",
            "recommended_platform": "render",
        })
        return info

    if index_html.exists():
        info.update({
            "kind": "frontend",
            "framework": "Static HTML",
            "output_dir": ".",
            "recommended_platform": "netlify",
        })
        return info

    return info


def detect_project_stack(repo_path: Path) -> Dict[str, Any]:
    """Scans a local repository (and monorepo frontend/backend subfolders) to detect stack & build config."""
    root_info = _detect_single_dir(repo_path)

    frontend_info = None
    backend_info = None
    for sub in ("frontend", "client", "web"):
        sub_dir = repo_path / sub
        if sub_dir.is_dir():
            cand = _detect_single_dir(sub_dir)
            if cand["framework"] != "Unknown":
                cand["subdir"] = sub
                frontend_info = cand
                break

    for sub in ("backend", "server", "api"):
        sub_dir = repo_path / sub
        if sub_dir.is_dir():
            cand = _detect_single_dir(sub_dir)
            if cand["framework"] != "Unknown":
                cand["subdir"] = sub
                backend_info = cand
                break

    is_monorepo = bool(frontend_info and backend_info)
    if is_monorepo:
        human_lines = [
            f"Repository: {repo_path.name} (Fullstack Monorepo)",
            f"• Frontend ({frontend_info['subdir']}/): {frontend_info['framework']} -> Recommended: Vercel or Netlify",
            f"• Backend ({backend_info['subdir']}/): {backend_info['framework']} -> Recommended: Render",
        ]
    else:
        primary = frontend_info or backend_info or root_info
        human_lines = [
            f"Repository: {repo_path.name}",
            f"• Framework: {primary['framework']} ({primary['kind']})",
            f"• Recommended Platform: {_PLATFORM_DISPLAY_NAMES.get(primary['recommended_platform'], primary['recommended_platform'])}",
            f"• Build Command: {primary.get('build_command') or 'None (static/direct)'}",
        ]
        if primary.get("start_command"):
            human_lines.append(f"• Start Command: {primary['start_command']}")

    return {
        "repository": repo_path.name,
        "repo_path": str(repo_path),
        "is_monorepo": is_monorepo,
        "root": root_info,
        "frontend": frontend_info,
        "backend": backend_info,
        "recommended_platform": "render+vercel" if is_monorepo else (frontend_info or backend_info or root_info)["recommended_platform"],
        "human_summary": "\n".join(human_lines),
        "message": f"Detected stack for '{repo_path.name}': " + (
            f"Monorepo ({frontend_info['framework']} + {backend_info['framework']})"
            if is_monorepo
            else f"{(frontend_info or backend_info or root_info)['framework']}"
        ),
    }


def parse_env_file(repo_path: Path, subdir: Optional[str] = None) -> Dict[str, str]:
    """Safely parses .env / .env.production key-value pairs in memory without exposing them to Git."""
    search_dirs = []
    if subdir and (repo_path / subdir).is_dir():
        search_dirs.append(repo_path / subdir)
    search_dirs.append(repo_path)

    env_vars: Dict[str, str] = {}
    for directory in search_dirs:
        for fname in (".env", ".env.production"):
            fpath = directory / fname
            if not fpath.is_file():
                continue
            try:
                for raw_line in fpath.read_text(encoding="utf-8").splitlines():
                    line = raw_line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if line.startswith("export "):
                        line = line[7:].strip()
                    if "=" not in line:
                        continue
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip()
                    if len(val) >= 2 and ((val[0] == '"' and val[-1] == '"') or (val[0] == "'" and val[-1] == "'")):
                        val = val[1:-1]
                    if key:
                        env_vars[key] = val
            except Exception as e:
                logger.warning(f"[deploy_engine] Failed parsing {fpath}: {e}")
    return env_vars


def _extract_token_from_creds(creds: Optional[Dict[str, Any]]) -> Optional[str]:
    if not creds or not isinstance(creds, dict):
        return None
    for k in ("api_key", "token", "access_token", "api_token", "personal_access_token", "key", "password"):
        val = creds.get(k)
        if val and isinstance(val, str) and val.strip():
            return val.strip()
    return None


def resolve_platform_token(
    user_id: Optional[str],
    platform: str,
    supplied_token: Optional[str] = None,
) -> Optional[str]:
    """Resolves platform API token from explicit parameter or encrypted App Vault (persisting newly supplied tokens)."""
    display_name = _PLATFORM_DISPLAY_NAMES.get(platform, platform.capitalize())

    clean_supplied = (supplied_token or "").strip()
    if clean_supplied and "{" not in clean_supplied:
        if user_id:
            try:
                save_app_credentials(user_id, display_name, "api_key", {"api_key": clean_supplied})
            except Exception as e:
                logger.warning(f"[deploy_engine] Could not persist {display_name} token to Vault: {e}")
        return clean_supplied

    if user_id:
        for candidate in (display_name, platform.lower(), platform.upper()):
            try:
                creds = get_app_credentials(user_id, candidate)
                tok = _extract_token_from_creds(creds)
                if tok:
                    return tok
            except Exception:
                continue

    return None


async def _run_local_build_if_needed(target_dir: Path, stack_info: Dict[str, Any]) -> Tuple[Path, Optional[str]]:
    """For static/direct uploads (Netlify/Vercel local upload), builds dist/build if missing."""
    output_dir_name = stack_info.get("output_dir") or "."
    out_path = (target_dir / output_dir_name).resolve() if output_dir_name != "." else target_dir.resolve()
    build_cmd = stack_info.get("build_command")

    if output_dir_name != "." and not out_path.exists() and build_cmd and (target_dir / "package.json").exists():
        if not (target_dir / "node_modules").exists():
            proc_inst = await asyncio.create_subprocess_shell(
                "npm install",
                cwd=str(target_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc_inst.communicate(), timeout=180.0)

        proc_build = await asyncio.create_subprocess_shell(
            build_cmd,
            cwd=str(target_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, b_err = await asyncio.wait_for(proc_build.communicate(), timeout=180.0)
        if proc_build.returncode != 0:
            err_msg = b_err.decode("utf-8", errors="replace").strip()
            return out_path, f"Local build `{build_cmd}` failed: {err_msg[:600]}"

    if not out_path.exists():
        out_path = target_dir.resolve()
    return out_path, None


def _collect_upload_files(source_dir: Path) -> List[Tuple[str, bytes]]:
    """Collects non-sensitive project/build files for direct API upload."""
    collected: List[Tuple[str, bytes]] = []
    for root, dirs, files in os.walk(source_dir):
        dirs[:] = [d for d in dirs if d not in _SKIP_UPLOAD_DIRS and not d.startswith(".git")]
        for fname in files:
            low = fname.lower()
            if low in _SENSITIVE_FILENAMES or low.startswith(".env") or low.endswith((".pem", ".key", ".pfx")):
                continue
            full_path = Path(root) / fname
            rel_path = full_path.relative_to(source_dir).as_posix()
            try:
                data = full_path.read_bytes()
                collected.append((rel_path, data))
            except Exception:
                continue
    return collected


def _build_zip_archive(files: List[Tuple[str, bytes]]) -> bytes:
    """Packs collected files into an in-memory ZIP buffer."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel_path, data in files:
            zf.writestr(rel_path, data)
    return buf.getvalue()


async def verify_live_url(url: str) -> Dict[str, Any]:
    """Performs an async HTTP GET health check on the deployed live URL."""
    if not url:
        return {"healthy": False, "status_code": None}
    full_url = url if url.startswith("http") else f"https://{url}"
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(full_url)
            return {
                "healthy": resp.status_code < 500,
                "status_code": resp.status_code,
                "checked_url": str(resp.url),
            }
    except Exception as e:
        return {"healthy": False, "status_code": None, "error": str(e)}


async def analyze_deploy_error(platform: str, error_logs: str, user_id: Optional[str] = None) -> str:
    """Uses AI to summarize raw build/deploy failure logs into an actionable fix."""
    snippet = (error_logs or "").strip()[-2500:]
    if not snippet:
        return f"{platform.capitalize()} deployment failed with no error logs returned."
    try:
        from app.services.planner import generate_ai_content
        prompt = (
            f"You are a senior DevOps engineer. A deployment to {platform.capitalize()} failed.\n"
            f"Read this error log snippet and respond in 2-3 concise sentences explaining the exact root cause "
            f"and how the developer should fix it:\n\n{snippet}"
        )
        diagnosis = await asyncio.to_thread(generate_ai_content, prompt, user_id=user_id)
        if diagnosis and diagnosis.strip():
            return diagnosis.strip()
    except Exception:
        pass
    return snippet[:600]


async def _api_json(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    headers: Dict[str, str],
    json_body: Any = None,
    params: Optional[Dict[str, Any]] = None,
) -> Tuple[int, Any]:
    resp = await client.request(method, url, headers=headers, json=json_body, params=params)
    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text}
    return resp.status_code, data


# ---------------------------------------------------------------------------
# Platform Adapter 1: Vercel REST API
# ---------------------------------------------------------------------------

async def _deploy_vercel(
    token: str,
    repo_path: Path,
    stack_info: Dict[str, Any],
    subdir: Optional[str],
    project_name: str,
    env_vars: Dict[str, str],
    user_id: Optional[str],
    github_owner: Optional[str] = None,
    github_repo: Optional[str] = None,
    branch: Optional[str] = None,
) -> Dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    safe_name = re.sub(r"[^a-z0-9\-]+", "-", project_name.lower()).strip("-")[:52] or "voxagent-app"
    target_dir = (repo_path / subdir) if (subdir and (repo_path / subdir).is_dir()) else repo_path

    async with httpx.AsyncClient(timeout=45.0) as client:
        # 1. Verify token & ensure project exists
        st_code, proj_data = await _api_json(client, "GET", f"https://api.vercel.com/v9/projects/{safe_name}", headers)
        if st_code == 401 or st_code == 403:
            raise PermissionError("Vercel API token is invalid or expired. Please reconnect Vercel in App Vault.")

        project_id = proj_data.get("id") if st_code == 200 else None
        if not project_id:
            create_payload: Dict[str, Any] = {"name": safe_name}
            fw = (stack_info.get("framework") or "").lower()
            if "next" in fw:
                create_payload["framework"] = "nextjs"
            elif "vite" in fw:
                create_payload["framework"] = "vite"
            elif "create react" in fw:
                create_payload["framework"] = "create-react-app"

            c_code, c_data = await _api_json(client, "POST", "https://api.vercel.com/v9/projects", headers, create_payload)
            if c_code not in (200, 201):
                err_msg = (c_data.get("error") or {}).get("message") if isinstance(c_data, dict) else str(c_data)
                raise RuntimeError(f"Vercel project creation failed ({c_code}): {err_msg}")
            project_id = c_data.get("id")

        # 2. Sync environment variables cleanly if requested
        synced_keys: List[str] = []
        if env_vars and project_id:
            env_payload = [
                {
                    "key": k,
                    "value": v,
                    "type": "encrypted",
                    "target": ["production", "preview", "development"],
                }
                for k, v in env_vars.items()
            ]
            e_code, _ = await _api_json(
                client,
                "POST",
                f"https://api.vercel.com/v10/projects/{project_id}/env?upsert=true",
                headers,
                env_payload,
            )
            if e_code in (200, 201):
                synced_keys = list(env_vars.keys())

        # 3. Upload local files directly so deployments work even without GitHub repo linking
        upload_source, build_err = await _run_local_build_if_needed(target_dir, stack_info)
        if build_err:
            raise RuntimeError(build_err)

        files = _collect_upload_files(upload_source)
        if not files:
            raise RuntimeError(f"No deployable files found in {upload_source}")

        vercel_files = []
        for rel_path, content in files:
            sha = hashlib.sha1(content).hexdigest()
            u_resp = await client.post(
                "https://api.vercel.com/v2/files",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/octet-stream",
                    "x-vercel-digest": sha,
                    "Content-Length": str(len(content)),
                },
                content=content,
            )
            if u_resp.status_code not in (200, 201):
                raise RuntimeError(f"Vercel file upload failed for {rel_path}: {u_resp.text[:300]}")
            vercel_files.append({"file": rel_path, "sha": sha, "size": len(content)})

        deploy_payload: Dict[str, Any] = {
            "name": safe_name,
            "project": project_id,
            "target": "production",
            "files": vercel_files,
        }
        if upload_source == target_dir and stack_info.get("build_command"):
            deploy_payload["projectSettings"] = {
                "buildCommand": stack_info.get("build_command"),
                "outputDirectory": stack_info.get("output_dir") if stack_info.get("output_dir") != "." else None,
            }

        d_code, d_data = await _api_json(client, "POST", "https://api.vercel.com/v13/deployments", headers, deploy_payload)
        if d_code not in (200, 201):
            err_msg = (d_data.get("error") or {}).get("message") if isinstance(d_data, dict) else str(d_data)
            raise RuntimeError(f"Vercel deployment trigger failed ({d_code}): {err_msg}")

        deploy_id = d_data.get("id")
        live_host = d_data.get("url")
        ready_state = d_data.get("readyState") or "QUEUED"
        alias_list = d_data.get("alias") or []

        # 4. Poll deployment state
        for _ in range(36):
            if ready_state in ("READY", "ERROR", "CANCELED"):
                if ready_state == "READY" and not alias_list:
                    p_code, p_data = await _api_json(client, "GET", f"https://api.vercel.com/v13/deployments/{deploy_id}", headers)
                    if p_code == 200 and isinstance(p_data, dict):
                        alias_list = p_data.get("alias") or []
                        live_host = p_data.get("url") or live_host
                break
            await asyncio.sleep(3)
            p_code, p_data = await _api_json(client, "GET", f"https://api.vercel.com/v13/deployments/{deploy_id}", headers)
            if p_code == 200 and isinstance(p_data, dict):
                ready_state = p_data.get("readyState", ready_state)
                live_host = p_data.get("url") or live_host
                alias_list = p_data.get("alias") or alias_list

        # Prefer clean canonical production domain alias (e.g. calculator-demo-chi.vercel.app) over hash preview URL
        if alias_list and isinstance(alias_list, list):
            live_host = alias_list[0]
        elif isinstance(proj_data, dict):
            prod_aliases = ((proj_data.get("targets") or {}).get("production") or {}).get("alias") or []
            if prod_aliases:
                live_host = prod_aliases[0]

        if ready_state in ("ERROR", "CANCELED"):
            _, ev_data = await _api_json(client, "GET", f"https://api.vercel.com/v2/deployments/{deploy_id}/events", headers)
            raw_logs = json.dumps(ev_data)[-2500:] if ev_data else ready_state
            diagnosis = await analyze_deploy_error("vercel", raw_logs, user_id=user_id)
            raise RuntimeError(f"Vercel deployment {ready_state}: {diagnosis}")

        live_url = f"https://{live_host}" if live_host and not str(live_host).startswith("http") else (live_host or "")
        health = await verify_live_url(live_url)

        return {
            "platform": "vercel",
            "project_name": safe_name,
            "deployment_id": deploy_id,
            "state": ready_state,
            "live_url": live_url,
            "health": health,
            "env_vars_synced": synced_keys,
            "message": f"Successfully deployed '{safe_name}' to Vercel: {live_url}",
        }


# ---------------------------------------------------------------------------
# Platform Adapter 2: Netlify REST API
# ---------------------------------------------------------------------------

async def _deploy_netlify(
    token: str,
    repo_path: Path,
    stack_info: Dict[str, Any],
    subdir: Optional[str],
    site_name: str,
    env_vars: Dict[str, str],
    user_id: Optional[str],
) -> Dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    safe_name = re.sub(r"[^a-z0-9\-]+", "-", site_name.lower()).strip("-")[:50] or "voxagent-site"
    target_dir = (repo_path / subdir) if (subdir and (repo_path / subdir).is_dir()) else repo_path

    async with httpx.AsyncClient(timeout=60.0) as client:
        # 1. Lookup or create Netlify site
        s_code, sites_data = await _api_json(client, "GET", "https://api.netlify.com/api/v1/sites", headers, params={"name": safe_name})
        if s_code == 401 or s_code == 403:
            raise PermissionError("Netlify Personal Access Token is invalid or expired. Please reconnect Netlify in App Vault.")

        site = None
        if s_code == 200 and isinstance(sites_data, list):
            for s in sites_data:
                if (s.get("name") or "").lower() == safe_name:
                    site = s
                    break

        if not site:
            c_code, c_data = await _api_json(
                client,
                "POST",
                "https://api.netlify.com/api/v1/sites",
                {**headers, "Content-Type": "application/json"},
                {"name": safe_name},
            )
            if c_code not in (200, 201):
                # Retry letting Netlify pick a unique suffix if site name is globally taken
                c_code, c_data = await _api_json(
                    client,
                    "POST",
                    "https://api.netlify.com/api/v1/sites",
                    {**headers, "Content-Type": "application/json"},
                    {},
                )
            if c_code not in (200, 201):
                raise RuntimeError(f"Netlify site creation failed ({c_code}): {c_data}")
            site = c_data

        site_id = site.get("id")
        account_slug = site.get("account_slug")

        # 2. Sync environment variables if requested & account_slug available
        synced_keys: List[str] = []
        if env_vars and account_slug and site_id:
            env_payload = [
                {"key": k, "values": [{"value": v, "context": "all"}]}
                for k, v in env_vars.items()
            ]
            e_code, _ = await _api_json(
                client,
                "POST",
                f"https://api.netlify.com/api/v1/accounts/{account_slug}/env?site_id={site_id}",
                {**headers, "Content-Type": "application/json"},
                env_payload,
            )
            if e_code in (200, 201):
                synced_keys = list(env_vars.keys())

        # 3. Build output if needed and upload ZIP bundle
        upload_source, build_err = await _run_local_build_if_needed(target_dir, stack_info)
        if build_err:
            raise RuntimeError(build_err)

        files = _collect_upload_files(upload_source)
        if not files:
            raise RuntimeError(f"No deployable files found in {upload_source}")
        zip_bytes = _build_zip_archive(files)

        d_resp = await client.post(
            f"https://api.netlify.com/api/v1/sites/{site_id}/deploys",
            headers={**headers, "Content-Type": "application/zip"},
            content=zip_bytes,
        )
        if d_resp.status_code not in (200, 201):
            raise RuntimeError(f"Netlify deploy upload failed ({d_resp.status_code}): {d_resp.text[:300]}")
        d_data = d_resp.json()
        deploy_id = d_data.get("id")
        state = d_data.get("state") or "uploading"
        live_url = d_data.get("ssl_url") or d_data.get("url") or site.get("ssl_url") or site.get("url") or ""

        # 4. Poll until ready/error
        for _ in range(30):
            if state in ("ready", "error"):
                break
            await asyncio.sleep(2)
            p_code, p_data = await _api_json(client, "GET", f"https://api.netlify.com/api/v1/deploys/{deploy_id}", headers)
            if p_code == 200:
                state = p_data.get("state", state)
                live_url = p_data.get("ssl_url") or p_data.get("url") or live_url
                if state == "error":
                    err_msg = p_data.get("error_message") or "Netlify deploy error"
                    diagnosis = await analyze_deploy_error("netlify", err_msg, user_id=user_id)
                    raise RuntimeError(f"Netlify deploy failed: {diagnosis}")

        health = await verify_live_url(live_url)
        return {
            "platform": "netlify",
            "site_name": site.get("name") or safe_name,
            "deployment_id": deploy_id,
            "state": state,
            "live_url": live_url,
            "health": health,
            "env_vars_synced": synced_keys,
            "message": f"Successfully deployed '{site.get('name') or safe_name}' to Netlify: {live_url}",
        }


# ---------------------------------------------------------------------------
# Platform Adapter 3: Render REST API
# ---------------------------------------------------------------------------

async def _deploy_render(
    token: str,
    repo_path: Path,
    stack_info: Dict[str, Any],
    subdir: Optional[str],
    service_name: str,
    env_vars: Dict[str, str],
    user_id: Optional[str],
    branch: Optional[str] = None,
) -> Dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    safe_name = re.sub(r"[^a-z0-9\-]+", "-", service_name.lower()).strip("-")[:50] or "voxagent-service"

    # Render builds directly from GitHub/Git remote URL
    g_status = await git_status(repo_path)
    remote_url = g_status.get("remote_url")
    target_branch = branch or g_status.get("branch") or "main"
    if not remote_url:
        raise ValueError(
            f"Render deploys from a Git repository URL, and '{repo_path.name}' has no remote origin configured yet. "
            f"Run Smart Git Push first to connect GitHub."
        )
    # Normalize SSH remote to HTTPS for Render API
    if remote_url.startswith("git@github.com:"):
        remote_url = "https://github.com/" + remote_url.split("git@github.com:", 1)[1]
    remote_url = remote_url.removesuffix(".git")

    async with httpx.AsyncClient(timeout=45.0) as client:
        # 1. Lookup owner ID & existing service
        o_code, owners_data = await _api_json(client, "GET", "https://api.render.com/v1/owners", headers)
        if o_code == 401 or o_code == 403:
            raise PermissionError("Render API Key is invalid or expired. Please reconnect Render in App Vault.")

        owner_id = None
        if o_code == 200 and isinstance(owners_data, list) and owners_data:
            first = owners_data[0]
            owner_id = (first.get("owner") or first).get("id")

        s_code, services_data = await _api_json(client, "GET", "https://api.render.com/v1/services", headers, params={"name": safe_name})
        service_obj = None
        if s_code == 200 and isinstance(services_data, list) and services_data:
            for item in services_data:
                svc = item.get("service") or item
                if (svc.get("name") or "").lower() == safe_name:
                    service_obj = svc
                    break

        if not service_obj:
            if not owner_id:
                raise RuntimeError("Could not determine Render owner ID from Render API.")
            is_static = stack_info.get("kind") == "frontend" and "next" not in (stack_info.get("framework") or "").lower()
            svc_type = "static_site" if is_static else "web_service"

            service_details: Dict[str, Any] = {}
            if is_static:
                service_details = {
                    "buildCommand": stack_info.get("build_command") or "npm run build",
                    "publishPath": stack_info.get("output_dir") or "dist",
                }
            else:
                fw = (stack_info.get("framework") or "").lower()
                runtime = "node" if "node" in fw else ("docker" if "docker" in fw else "python")
                service_details = {
                    "env": runtime,
                    "plan": "free",
                    "envSpecificDetails": {
                        "buildCommand": stack_info.get("build_command") or "pip install -r requirements.txt",
                        "startCommand": stack_info.get("start_command") or "uvicorn main:app --host 0.0.0.0 --port $PORT",
                    },
                }

            create_payload: Dict[str, Any] = {
                "type": svc_type,
                "name": safe_name,
                "ownerId": owner_id,
                "repo": remote_url,
                "branch": target_branch,
                "autoDeploy": "yes",
                "serviceDetails": service_details,
            }
            if subdir:
                create_payload["rootDir"] = subdir

            c_code, c_data = await _api_json(client, "POST", "https://api.render.com/v1/services", headers, create_payload)
            if c_code not in (200, 201):
                raise RuntimeError(f"Render service creation failed ({c_code}): {c_data}")
            service_obj = c_data.get("service") or c_data

        service_id = service_obj.get("id")
        live_url = (service_obj.get("serviceDetails") or {}).get("url") or f"https://{safe_name}.onrender.com"

        # 2. Sync environment variables safely
        synced_keys: List[str] = []
        if env_vars and service_id:
            env_payload = [{"key": k, "value": v} for k, v in env_vars.items()]
            e_code, _ = await _api_json(
                client,
                "PUT",
                f"https://api.render.com/v1/services/{service_id}/env-vars",
                headers,
                env_payload,
            )
            if e_code in (200, 201):
                synced_keys = list(env_vars.keys())

        # 3. Trigger deploy
        d_code, d_data = await _api_json(
            client,
            "POST",
            f"https://api.render.com/v1/services/{service_id}/deploys",
            headers,
            {"clearCache": "do_not_clear"},
        )
        if d_code not in (200, 201):
            raise RuntimeError(f"Render deploy trigger failed ({d_code}): {d_data}")

        deploy_id = d_data.get("id")
        deploy_status = d_data.get("status") or "created"

        # 4. Poll deploy status
        for _ in range(45):
            if deploy_status in ("live", "build_failed", "update_failed", "canceled", "deactivated"):
                break
            await asyncio.sleep(4)
            p_code, p_data = await _api_json(
                client,
                "GET",
                f"https://api.render.com/v1/services/{service_id}/deploys/{deploy_id}",
                headers,
            )
            if p_code == 200:
                deploy_status = p_data.get("status", deploy_status)

        if deploy_status in ("build_failed", "update_failed", "canceled"):
            _, l_data = await _api_json(client, "GET", f"https://api.render.com/v1/services/{service_id}/events", headers)
            diagnosis = await analyze_deploy_error("render", json.dumps(l_data)[-2500:] if l_data else deploy_status, user_id=user_id)
            raise RuntimeError(f"Render deploy {deploy_status}: {diagnosis}")

        health = await verify_live_url(live_url)
        return {
            "platform": "render",
            "service_name": safe_name,
            "service_id": service_id,
            "deployment_id": deploy_id,
            "state": deploy_status,
            "live_url": live_url,
            "health": health,
            "env_vars_synced": synced_keys,
            "message": f"Successfully deployed '{safe_name}' to Render: {live_url}",
        }


# ---------------------------------------------------------------------------
# Unified Orchestrator Entrypoint
# ---------------------------------------------------------------------------

async def execute_deploy_action(
    action: str,
    parameters: Optional[Dict[str, Any]] = None,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Unified entrypoint for orchestrator to run stack detection, env sync, and multi-platform deploys."""
    params = parameters or {}
    act = (action or "").upper().strip()

    custom_repo = (
        params.get("repo_path")
        or params.get("workspace_path")
        or params.get("repo")
        or params.get("repository")
        or params.get("repo_name")
        or params.get("project")
    )
    raw_repo_str = str(custom_repo or "").strip()
    is_unspecified_repo = (
        not raw_repo_str
        or raw_repo_str.lower() in ("auto", "default", "current", "this", "this repo")
        or "{" in raw_repo_str
        or "}" in raw_repo_str
    )

    if act in ("DEPLOY_DETECT_STACK", "DETECT_STACK", "ANALYZE_PROJECT"):
        try:
            repo_path = resolve_repo_path(None if is_unspecified_repo else raw_repo_str)
            stack = detect_project_stack(repo_path)
            return {"status": "success", "result": stack}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    if is_unspecified_repo:
        discovered = discover_local_repos(include_downloads=False)
        ordered = [r["name"] for r in discovered if not r.get("is_default")] + [
            r["name"] for r in discovered if r.get("is_default")
        ]
        return {
            "status": "needs_input",
            "missing_field": "repository",
            "options": ordered[:25] if ordered else None,
            "question": (
                f"Which local repository would you like to deploy? "
                f"Please select or type the repository name:"
            ),
        }

    try:
        repo_path = resolve_repo_path(raw_repo_str)
    except Exception as e:
        return {"status": "error", "error": f"Invalid repository path: {e}"}

    stack_analysis = detect_project_stack(repo_path)
    platform = normalize_platform_name(params.get("platform") or params.get("provider"))
    if not platform:
        rec = stack_analysis.get("recommended_platform", "vercel")
        platform = "render" if rec == "render+vercel" else rec

    supplied_token = params.get("api_token") or params.get("token") or params.get("api_key")
    token = resolve_platform_token(user_id, platform, supplied_token=supplied_token)
    if not token:
        disp = _PLATFORM_DISPLAY_NAMES.get(platform, platform.capitalize())
        hint_url = _PLATFORM_TOKEN_HINTS.get(platform, "")
        return {
            "status": "needs_input",
            "missing_field": "api_token",
            "question": (
                f"{disp} API Token is required to deploy '{repo_path.name}'. "
                f"Paste your {disp} API Token (generate at {hint_url}) — it will be saved encrypted in App Vault for future runs:"
            ),
        }

    subdir = params.get("subdir") or params.get("root_dir")
    if not subdir:
        if platform == "render" and stack_analysis.get("backend"):
            subdir = stack_analysis["backend"].get("subdir")
        elif platform in ("vercel", "netlify") and stack_analysis.get("frontend"):
            subdir = stack_analysis["frontend"].get("subdir")

    target_stack = (
        stack_analysis.get("backend")
        if (subdir and stack_analysis.get("backend") and subdir == stack_analysis["backend"].get("subdir"))
        else stack_analysis.get("frontend")
        if (subdir and stack_analysis.get("frontend") and subdir == stack_analysis["frontend"].get("subdir"))
        else (stack_analysis.get("frontend") or stack_analysis.get("backend") or stack_analysis["root"])
    )

    # Merge optional local .env + explicit runtime env_vars (e.g. injected backend live_url)
    env_vars: Dict[str, str] = {}
    if bool(params.get("sync_env", True)):
        env_vars.update(parse_env_file(repo_path, subdir=subdir))
    extra_env = params.get("env_vars")
    if isinstance(extra_env, dict):
        env_vars.update({str(k): str(v) for k, v in extra_env.items() if v is not None})

    project_name = params.get("project_name") or params.get("service_name") or (
        f"{repo_path.name}-{subdir}" if subdir else repo_path.name
    )

    try:
        if act in ("DEPLOY_PROJECT", "DEPLOY", "DEPLOY_APP"):
            if platform == "vercel":
                res = await _deploy_vercel(
                    token=token,
                    repo_path=repo_path,
                    stack_info=target_stack,
                    subdir=subdir,
                    project_name=project_name,
                    env_vars=env_vars,
                    user_id=user_id,
                    branch=params.get("branch"),
                )
            elif platform == "netlify":
                res = await _deploy_netlify(
                    token=token,
                    repo_path=repo_path,
                    stack_info=target_stack,
                    subdir=subdir,
                    site_name=project_name,
                    env_vars=env_vars,
                    user_id=user_id,
                )
            elif platform == "render":
                res = await _deploy_render(
                    token=token,
                    repo_path=repo_path,
                    stack_info=target_stack,
                    subdir=subdir,
                    service_name=project_name,
                    env_vars=env_vars,
                    user_id=user_id,
                    branch=params.get("branch"),
                )
            else:
                return {"status": "error", "error": f"Unsupported deployment platform: '{platform}'."}

            res["human_summary"] = (
                f"Deployment Complete on {_PLATFORM_DISPLAY_NAMES.get(platform, platform)}!\n"
                f"Project: {project_name}\n"
                f"Live URL: {res.get('live_url')}\n"
                f"Health Check: {'Healthy (HTTP ' + str(res['health'].get('status_code')) + ')' if (res.get('health') or {}).get('healthy') else 'Pending warm-up'}\n"
                + (f"Env Vars Synced: {', '.join(res['env_vars_synced'])}\n" if res.get("env_vars_synced") else "")
            )
            return {"status": "success", "result": res}

        if act in ("DEPLOY_SYNC_ENV", "SYNC_ENV"):
            if not env_vars:
                return {"status": "success", "result": {"synced": [], "message": "No .env variables found to sync."}}
            # Reuse deployment adapters' env sync or project lookup
            return {
                "status": "success",
                "result": {
                    "platform": platform,
                    "repository": repo_path.name,
                    "env_keys_detected": list(env_vars.keys()),
                    "count": len(env_vars),
                    "message": f"Parsed {len(env_vars)} environment variable(s) ready for {platform.capitalize()}.",
                },
            }

        return {
            "status": "error",
            "error": f"Unknown deploy action: '{action}'. Supported: DEPLOY_DETECT_STACK, DEPLOY_PROJECT, DEPLOY_SYNC_ENV.",
        }
    except Exception as e:
        logger.error(f"[deploy_engine] Action '{action}' on '{platform}' failed: {e}", exc_info=True)
        return {"status": "error", "error": str(e)}
