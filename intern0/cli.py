"""
intern0: moves your Datadog dashboards and monitors to Dash0. One command.

    intern0 migrate              log in, pick, review the plan, import
    intern0 migrate --dry-run    stop after the plan: files and report only
    intern0 logout               forget the saved logins

Logins happen in the browser (OAuth 2.0 with PKCE), the way Dash0's own CLI
and AI tools log in. No keys to create or paste. Datadog is read through
Datadog's MCP server, Dash0 is written through its import API.

The translation is the rule-based converter in converter/: no AI, the same
input always gives the same output, and every item gets a verdict.

Python 3.9 or later, standard library only.
"""

import argparse
import base64
import curses
import hashlib
import http.server
import json
import locale
import os
import re
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(HERE, "converter"))
import datadog_to_perses as dd  # noqa: E402
import monitors_to_dash0 as monitors  # noqa: E402

from intern0 import __version__ as VERSION  # noqa: E402
STATE_FILE = os.path.join(os.path.expanduser("~"), ".intern0", "state.json")
CALLBACK_PORTS = range(8765, 8776)

DATADOG_SITES = [
    ("Europe · datadoghq.eu", "datadoghq.eu"),
    ("US1 · datadoghq.com", "datadoghq.com"),
    ("US3 · us3.datadoghq.com", "us3.datadoghq.com"),
    ("US5 · us5.datadoghq.com", "us5.datadoghq.com"),
    ("AP1 · ap1.datadoghq.com", "ap1.datadoghq.com"),
    ("AP2 · ap2.datadoghq.com", "ap2.datadoghq.com"),
]
DASH0_REGIONS = [
    ("Europe · GCP Netherlands", "https://api.europe-west4.gcp.dash0.com"),
    ("Europe · AWS Ireland", "https://api.eu-west-1.aws.dash0.com"),
    ("Europe · AWS Frankfurt", "https://api.eu-central-1.aws.dash0.com"),
    ("US · AWS Oregon", "https://api.us-west-2.aws.dash0.com"),
    ("US · AWS Virginia", "https://api.us-east-1.aws.dash0.com"),
]
INTENT = {"intent": "intern0: read Datadog dashboards and monitors to migrate them to Dash0"}
COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


class Fail(Exception):
    """A problem the user can act on: printed without a traceback."""


# Dash0's accent red (oklch 0.64 0.215 26 = #F34140); 256-colour fallback for terminals without truecolor
RED = "38;2;243;65;64" if os.environ.get("COLORTERM", "").lower() in ("truecolor", "24bit") else "38;5;203"


def paint(text, code):
    return f"\033[{code}m{text}\033[0m" if COLOR else text


def brand(t):
    return paint(t, RED)


def bold(t):
    return paint(t, "1")


def dim(t):
    return paint(t, "2")


def good(t):
    return paint(t, "32")


def bad(t):
    return paint(t, "1;" + RED)


class Spinner:
    """`with Spinner("Reading…"):` shows a turning Dash0-red dot and the seconds waited (terminals only)."""
    FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

    def __init__(self, text):
        self.text, self.done = text, threading.Event()

    def _run(self):
        start, i = time.time(), 0
        while not self.done.wait(0.1):
            sys.stdout.write(f"\r  {brand(self.FRAMES[i % len(self.FRAMES)])} {self.text} {dim(f'{time.time() - start:.0f}s')}\033[K")
            sys.stdout.flush()
            i += 1

    def __enter__(self):
        self.live = sys.stdout.isatty()
        if self.live:
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
        else:
            say(f"  {self.text}")
        return self

    def __exit__(self, *exc):
        if self.live:
            self.done.set()
            self.thread.join()
            sys.stdout.write("\r\033[K")
            sys.stdout.flush()


def plural(n, word):
    return f"{n} {word}" + ("" if n == 1 else "s")


def step(title, detail=""):
    say(f"{brand('▸')} {bold(title)}  {dim(detail)}".rstrip())


def say(text=""):
    print(text, flush=True)


# --------------------------------------------------------------------------- HTTP

def request(method, url, body=None, form=None, headers=None, timeout=120):
    h = {"User-Agent": f"intern0/{VERSION}"}
    h.update(headers or {})
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        raise Fail(f"Could not reach {urllib.parse.urlsplit(url).netloc}: {e.reason}")
    except (TimeoutError, socket.timeout):
        raise Fail(f"{urllib.parse.urlsplit(url).netloc} did not answer within {timeout} seconds. Try again in a moment.")


def error_text(status, text):
    try:
        j = json.loads(text)
        msg = (j.get("error") or {}).get("message") if isinstance(j.get("error"), dict) else None
        return msg or j.get("error_description") or j.get("error") or text[:300]
    except (ValueError, AttributeError):
        return text[:300] or f"HTTP {status}"


# --------------------------------------------------------------------------- saved state

def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"clients": {}, "tokens": {}}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), mode=0o700, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)


# --------------------------------------------------------------------------- OAuth 2.0 + PKCE

def b64url(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


class Callback:
    """Tiny local receiver for the browser redirect, on 127.0.0.1 and ::1 (same port)."""

    def __init__(self):
        self.result = None
        self.servers = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                parsed = urllib.parse.urlsplit(self.path)
                if parsed.path != "/callback":
                    self.send_response(404)
                    self.end_headers()
                    return
                outer.result = dict(urllib.parse.parse_qsl(parsed.query))
                ok = "code" in outer.result
                page = ("<h2>intern0: logged in.</h2><p>You can close this tab and go back to the terminal.</p>"
                        if ok else "<h2>intern0: login failed.</h2><p>Go back to the terminal for details.</p>")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(f"<html><body style='font-family:sans-serif;margin:3em'>{page}</body></html>".encode())

            def log_message(self, *args):
                pass

        for port in CALLBACK_PORTS:
            servers = []
            try:
                servers.append(http.server.HTTPServer(("127.0.0.1", port), Handler))
                try:
                    class V6(http.server.HTTPServer):
                        address_family = socket.AF_INET6
                    servers.append(V6(("::1", port), Handler))
                except OSError:
                    pass  # no IPv6 loopback: 127.0.0.1 is enough
            except OSError:
                for s in servers:
                    s.server_close()
                continue
            self.servers, self.port = servers, port
            break
        else:
            raise Fail(f"No free local port for the login callback ({CALLBACK_PORTS.start}-{CALLBACK_PORTS.stop - 1}).")
        for s in self.servers:
            threading.Thread(target=s.serve_forever, daemon=True).start()

    def wait(self, timeout):
        end = time.time() + timeout
        while self.result is None and time.time() < end:
            time.sleep(0.2)
        for s in self.servers:
            s.shutdown()
            s.server_close()
        if self.result is None:
            raise Fail("Login timed out. Run the command again and finish the login in the browser.")
        return self.result


class OAuth:
    """Browser login for one service. Tokens are saved in ~/.intern0/state.json (owner-only)."""

    def __init__(self, name, metadata_url, scope, resource=None):
        self.name, self.scope, self.resource = name, scope, resource
        status, _, text = request("GET", metadata_url)
        if status != 200:
            raise Fail(f"{name}: could not read its login settings ({metadata_url}, HTTP {status}).")
        self.meta = json.loads(text)
        self.key = self.meta["issuer"]

    def _client_id(self, redirect, state):
        cache = f"{self.key} {redirect}"
        if cache in state["clients"]:
            return state["clients"][cache]
        status, _, text = request("POST", self.meta["registration_endpoint"], body={
            "client_name": "intern0 (Datadog to Dash0 migrator)",
            "redirect_uris": [redirect],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        })
        if status not in (200, 201):
            raise Fail(f"{self.name}: could not register intern0 for login: {error_text(status, text)}")
        state["clients"][cache] = json.loads(text)["client_id"]
        save_state(state)
        return state["clients"][cache]

    def _store(self, state, j, client_id, redirect):
        old = state["tokens"].get(self.key, {})
        state["tokens"][self.key] = {
            "access_token": j["access_token"],
            "refresh_token": j.get("refresh_token") or old.get("refresh_token"),
            "expires_at": time.time() + int(j.get("expires_in", 3600)),
            "client_id": client_id,
            "redirect": redirect,
        }
        save_state(state)
        return j["access_token"]

    def _token_request(self, form):
        if self.resource:
            form["resource"] = self.resource
        status, _, text = request("POST", self.meta["token_endpoint"], form=form)
        return status, text

    def login(self):
        state = load_state()
        cb = Callback()
        redirect = f"http://localhost:{cb.port}/callback"
        client_id = self._client_id(redirect, state)
        verifier = b64url(secrets.token_bytes(32))
        expected = secrets.token_urlsafe(16)
        params = {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect,
            "code_challenge": b64url(hashlib.sha256(verifier.encode()).digest()),
            "code_challenge_method": "S256",
            "state": expected,
            "scope": self.scope,
        }
        if self.resource:
            params["resource"] = self.resource
        url = self.meta["authorization_endpoint"] + "?" + urllib.parse.urlencode(params)
        say(f"  Opening your browser to log in to {bold(self.name)}. Click {brand('Allow')} there.")
        say(dim(f"  If no browser opens, visit: {url}"))
        webbrowser.open(url)
        result = cb.wait(timeout=300)
        if result.get("state") != expected:
            raise Fail(f"{self.name}: login answer did not match this login attempt. Try again.")
        if "code" not in result:
            raise Fail(f"{self.name}: login was not approved ({result.get('error_description') or result.get('error')}).")
        status, text = self._token_request({
            "grant_type": "authorization_code",
            "code": result["code"],
            "redirect_uri": redirect,
            "client_id": client_id,
            "code_verifier": verifier,
        })
        if status != 200:
            raise Fail(f"{self.name}: login failed: {error_text(status, text)}")
        say(good(f"  ✓ Logged in to {self.name}"))
        return self._store(state, json.loads(text), client_id, redirect)

    def token(self):
        state = load_state()
        t = state["tokens"].get(self.key)
        if t and t["expires_at"] > time.time() + 60:
            return t["access_token"]
        if t and t.get("refresh_token"):
            status, text = self._token_request({
                "grant_type": "refresh_token",
                "refresh_token": t["refresh_token"],
                "client_id": t["client_id"],
            })
            if status == 200:
                return self._store(state, json.loads(text), t["client_id"], t["redirect"])
        return self.login()

    def expire(self):
        """The service rejected the token: make the next call refresh it (or log in again)."""
        state = load_state()
        if self.key in state["tokens"]:
            state["tokens"][self.key]["expires_at"] = 0
            save_state(state)


# --------------------------------------------------------------------------- Datadog (MCP)

class DatadogMCP:
    """Reads Datadog through its MCP server (Streamable HTTP, JSON-RPC)."""

    def __init__(self, site):
        self.url = f"https://mcp.{site}/v1/mcp"
        meta = f"https://mcp.{site}/.well-known/oauth-authorization-server/v1/mcp"
        self.oauth = OAuth(f"Datadog ({site})", meta, "mcp_all", resource=self.url)
        self.session, self.next_id = None, 0
        self.lock = threading.Lock()  # one request at a time per session id update
        self.oauth.token()  # browser login first (if needed), outside the spinner
        with Spinner("Connecting to Datadog…"):
            self._initialize()

    def _initialize(self):
        self._send("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "intern0", "version": VERSION},
        })
        self._send("notifications/initialized", {}, notify=True)

    def _send(self, method, params, notify=False):
        msg = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notify:
            with self.lock:  # the two readers run in parallel: unique request ids
                self.next_id += 1
                msg["id"] = self.next_id
        for attempt in (1, 2):
            with self.lock:  # at most one token refresh or login at a time
                token = self.oauth.token()
            h = {"Accept": "application/json, text/event-stream",
                 "Authorization": "Bearer " + token}
            if self.session:
                h["Mcp-Session-Id"] = self.session
                h["MCP-Protocol-Version"] = "2025-06-18"
            status, headers, text = request("POST", self.url, body=msg, headers=h, timeout=60)
            if status == 401 and attempt == 1:
                self.oauth.expire()
                continue
            break
        if status >= 400:
            raise Fail(f"Datadog: {method} failed: {error_text(status, text)}")
        self.session = headers.get("Mcp-Session-Id") or self.session
        if notify:
            return None
        reply = None
        if "text/event-stream" in (headers.get("Content-Type") or ""):
            for line in text.splitlines():
                if line.startswith("data:"):
                    try:
                        j = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if j.get("id") == msg["id"]:
                        reply = j
        else:
            reply = json.loads(text)
        if not reply:
            raise Fail(f"Datadog: no answer to {method}.")
        if "error" in reply:
            raise Fail(f"Datadog: {method}: {reply['error'].get('message')}")
        return reply["result"]

    def tool(self, name, **args):
        result = self._send("tools/call", {"name": name, "arguments": dict(args, telemetry=INTENT)})
        text = "".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        if result.get("isError"):
            raise Fail(f"Datadog: {name}: {text[:300]}")
        if "No data returned" in text[:300]:  # Datadog's way of saying "empty" (e.g. past the last page)
            return []
        try:
            return json.loads(text)
        except ValueError:
            raise Fail(f"Datadog: {name} returned something that is not JSON: {text[:200]}")

    def paged(self, name, key, **args):
        seen, items, start = set(), [], 0
        while True:
            page = self.tool(name, start_at=start, max_tokens=60000, **args)
            if not isinstance(page, list):
                page = page.get("results") or page.get("dashboards") or page.get("monitors") or []
            new = [p for p in page if p.get(key) not in seen]
            if not new:
                return items
            seen.update(p.get(key) for p in new)
            items += new
            start += len(page)

    def dashboards(self):
        return self.paged("search_datadog_dashboards", "dashboard_id", sort="title")

    def dashboard(self, dashboard_id):
        return self.tool("get_datadog_dashboard", dashboard_id=str(dashboard_id))

    def monitors(self):
        return self.paged("search_datadog_monitors", "id", include_tags=["*"], sort="title")


THRESHOLD = re.compile(r"(?:>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$")


def from_mcp_monitor(m):
    """The MCP answer has no options.thresholds: the critical level is the number in the query."""
    m = dict(m)
    options = dict(m.get("options") or {})
    if options.get("thresholds"):
        return m, None
    found = THRESHOLD.search(m.get("query", ""))
    if not found:
        return m, None
    options["thresholds"] = {"critical": float(found.group(1))}
    m["options"] = options
    return m, "warning threshold is not readable through Datadog's MCP server: only the critical level was migrated"


# --------------------------------------------------------------------------- Dash0 (REST)

class Dash0:
    def __init__(self, api_url):
        self.api = api_url
        self.oauth = OAuth("Dash0", f"{api_url}/.well-known/oauth-authorization-server", "*")
        self.oauth.token()

    def call(self, method, path, body=None):
        for attempt in (1, 2):
            status, _, text = request(method, self.api + path, body=body,
                                      headers={"Authorization": "Bearer " + self.oauth.token()})
            if status == 401 and attempt == 1:
                self.oauth.expire()
                continue
            return status, text

    def datasets(self):
        status, text = self.call("GET", "/api/datasets")
        if status != 200:
            raise Fail(f"Dash0: could not list datasets: {error_text(status, text)}")
        body = json.loads(text)
        out = []
        for d in body if isinstance(body, list) else body.get("items", []):
            meta = d.get("metadata") or {}
            ds = (meta.get("labels") or {}).get("dash0.com/id") or meta.get("name")
            if ds:
                out.append((meta.get("name") or ds, ds))
        return out


def stable_id(kind, datadog_id):
    """Same Datadog item -> same Dash0 id, so a second run updates instead of duplicating."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"intern0:datadog:{kind}:{datadog_id}"))


def check_rule_items(rules_doc, ids):
    """PrometheusRule (converter output) -> items for POST /api/import/check-rules."""
    items = []
    for group in rules_doc["spec"]["groups"]:
        for rule in group["rules"]:
            a = rule.get("annotations", {})
            thresholds = {}
            if "dash0-threshold-degraded" in a:
                thresholds["degraded"] = float(a["dash0-threshold-degraded"])
            if "dash0-threshold-critical" in a:
                thresholds["failed"] = float(a["dash0-threshold-critical"])
            items.append({
                "id": ids.get(rule["alert"]),
                "name": rule["alert"],
                "expression": rule["expr"],
                "thresholds": thresholds,
                "interval": group.get("interval", "1m"),
                "for": rule.get("for", "0s"),
                "labels": rule.get("labels", {}),
                "annotations": {k: v for k, v in a.items() if not k.startswith("dash0-threshold-")},
                "enabled": True,
            })
    return items


# --------------------------------------------------------------------------- terminal UI

def pick(title, rows, multi=True):
    """Arrow-key list. Returns the chosen indexes, or None when the user quits."""
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise Fail("This step needs an interactive terminal. Use --all (and the --datadog-site, "
                   "--dash0-region and --dataset flags) to run without one.")
    locale.setlocale(locale.LC_ALL, "")
    return curses.wrapper(_pick, title, rows, multi)


def _pick(scr, title, rows, multi):
    curses.curs_set(0)
    accent, bar = curses.A_BOLD, curses.A_REVERSE
    if curses.has_colors():  # Dash0 red: title and checkmarks in red, the current row as a red bar
        curses.start_color()
        curses.use_default_colors()
        red = 203 if curses.COLORS >= 256 else curses.COLOR_RED
        curses.init_pair(1, red, -1)
        curses.init_pair(2, curses.COLOR_WHITE if curses.COLORS < 256 else 231, red)
        accent, bar = curses.color_pair(1) | curses.A_BOLD, curses.color_pair(2) | curses.A_BOLD
    chosen, pos, top = set(), 0, 0
    keys = ("↑↓ move · space select · a all/none · enter continue · q quit" if multi
            else "↑↓ move · enter choose · q quit")
    while True:
        scr.erase()
        h, w = scr.getmaxyx()
        scr.addnstr(0, 0, "▸ " + title, w - 1, accent)
        scr.addnstr(1, 0, keys + (f"   {len(chosen)} selected" if multi else ""), w - 1, curses.A_DIM)
        view = max(1, h - 3)
        top = min(max(top, pos - view + 1), pos)
        for i in range(top, min(len(rows), top + view)):
            mark = ("[x] " if i in chosen else "[ ] ") if multi else ""
            attr = bar if i == pos else (accent if i in chosen else 0)
            scr.addnstr(3 + i - top, 0, (" " + mark + rows[i]).ljust(w - 1), w - 1, attr)
        k = scr.getch()
        if k in (curses.KEY_UP, ord("k")):
            pos = max(0, pos - 1)
        elif k in (curses.KEY_DOWN, ord("j")):
            pos = min(len(rows) - 1, pos + 1)
        elif k == curses.KEY_NPAGE:
            pos = min(len(rows) - 1, pos + view)
        elif k == curses.KEY_PPAGE:
            pos = max(0, pos - view)
        elif multi and k == ord(" "):
            chosen ^= {pos}
        elif multi and k in (ord("a"), ord("A")):
            chosen = set() if len(chosen) == len(rows) else set(range(len(rows)))
        elif k in (10, 13, curses.KEY_ENTER):
            if not multi:
                return [pos]
            if chosen:
                return sorted(chosen)
        elif k in (ord("q"), 27):
            return None


def choose_one(title, options, given=None, flag=""):
    """options: [(label, value)]. A flag value wins; otherwise ask."""
    if given:
        for label, value in options:
            if given in (label, value):
                return label, value
        raise Fail(f"{flag} '{given}' is not one of: {', '.join(v for _, v in options)}")
    picked = pick(title, [label for label, _ in options], multi=False)
    if picked is None:
        raise Fail("Stopped. Nothing was changed.")
    return options[picked[0]]


def confirm(question, assume_yes):
    if assume_yes:
        return True
    if not sys.stdin.isatty():
        raise Fail("Needs a yes/no answer: add --yes to run without a terminal.")
    return input(f"  {question} [y/N] ").strip().lower() in ("y", "yes")


ICON = {"OK": "✅", "WARN": "⚠️ ", "FAIL": "❌"}


# --------------------------------------------------------------------------- migrate

def migrate(args):
    say()
    say(f"  {brand('●')} {bold('intern0')}   Datadog {brand('→')} Dash0   {dim('v' + VERSION)}")
    say(dim("    Rule-based translation. No AI, same input, same output."))
    say()

    # 1. Datadog
    site_label, site = choose_one("Which Datadog site is your account on?", DATADOG_SITES,
                                  args.datadog_site, "--datadog-site")
    step("Datadog", site_label)
    datadog = DatadogMCP(site)
    found, errors = {}, []

    def read(kind, fn):
        try:
            found[kind] = fn()
        except Exception as e:  # reported below, after both reads finished
            errors.append(e)

    with Spinner("Reading your dashboards and monitors…"):
        readers = [threading.Thread(target=read, args=("dashboards", datadog.dashboards)),
                   threading.Thread(target=read, args=("monitors", datadog.monitors))]
        for t in readers:
            t.start()
        for t in readers:
            t.join()
    if errors:
        raise errors[0] if isinstance(errors[0], Fail) else Fail(f"Datadog: {errors[0]}")
    dashboards, mons = found["dashboards"], found["monitors"]
    say(f"  Found {plural(len(dashboards), 'dashboard')} and {plural(len(mons), 'monitor')}.")
    if not dashboards and not mons:
        raise Fail("Nothing to migrate in this Datadog account.")

    # 2. Pick
    rows = [("dashboard", d) for d in dashboards] + [("monitor", m) for m in mons]
    labels = [(f"Dashboard  {d.get('dashboard_title') or d['dashboard_id']}"
               + ("  (built-in)" if str(d["dashboard_id"]).isdigit() else ""))
              if kind == "dashboard" else f"Monitor    {d.get('name')}" for kind, d in rows]
    if args.all or args.match:
        terms = [t.lower() for t in args.match or []]
        picked = [i for i, label in enumerate(labels) if not terms or any(t in label.lower() for t in terms)]
        if not picked:
            raise Fail(f"Nothing matches {', '.join(args.match)}.")
    else:
        picked = pick("What should move to Dash0?", labels)
        if picked is None:
            raise Fail("Stopped. Nothing was changed.")
    chosen_dash = [rows[i][1] for i in picked if rows[i][0] == "dashboard"]
    chosen_mons = [rows[i][1] for i in picked if rows[i][0] == "monitor"]

    # 3. Plan: translate locally, write files, show verdicts
    say()
    step("Plan")
    out = os.path.abspath(args.out)
    os.makedirs(os.path.join(out, "dashboards"), exist_ok=True)
    report_lines, perses_list = [], []
    for d in chosen_dash:
        title = d.get("dashboard_title") or d["dashboard_id"]
        try:
            with Spinner(f"Translating {title}…"):
                source = datadog.dashboard(d["dashboard_id"])
                perses, rep = dd.convert(source)
        except (Exception, SystemExit) as e:  # one bad dashboard must not stop the others
            report_lines.append(("dashboard", title, "FAIL", [f"not translated: {e}"]))
            continue
        perses["metadata"]["dash0Extensions"] = {"id": stable_id("dashboard", d["dashboard_id"])}
        name = perses["metadata"]["name"]
        with open(os.path.join(out, "dashboards", f"{name}.json"), "w", encoding="utf-8") as f:
            f.write(json.dumps(perses, indent=2, ensure_ascii=False) + "\n")
        fails = sum(s == "FAIL" for s, _, _ in rep.lines)
        warns = sum(s == "WARN" for s, _, _ in rep.lines)
        status = "FAIL" if fails == len(rep.lines) and fails else ("WARN" if fails or warns else "OK")
        detail = [f"{len(rep.lines)} widgets: {len(rep.lines) - fails - warns} ✅  {warns} ⚠️  {fails} ❌"]
        detail += [f"{ICON[s].strip()} {item}: {'; '.join(msgs)}" for s, item, msgs in rep.lines if s != "OK"]
        report_lines.append(("dashboard", title, status, detail))
        perses_list.append(perses)

    rules_doc, rule_ids = None, {}
    if chosen_mons:
        adapted, notes = zip(*(from_mcp_monitor(m) for m in chosen_mons)) if chosen_mons else ((), ())
        rules_doc, rep = monitors.convert(list(adapted))
        for m, note, (s, item, msgs) in zip(chosen_mons, notes, rep.lines):
            if note and s != "FAIL":
                s, msgs = "WARN", msgs + [note]
            report_lines.append(("monitor", item, s, msgs))
            rule_ids[m.get("name")] = stable_id("monitor", m.get("id"))
        with open(os.path.join(out, "check-rules.json"), "w", encoding="utf-8") as f:
            f.write(json.dumps(rules_doc, indent=2, ensure_ascii=False) + "\n")

    counts = {s: sum(1 for _, _, st, _ in report_lines if st == s) for s in ICON}
    for kind, item, s, msgs in report_lines:
        say(f"  {ICON[s]} {kind:9} {item}")
        for m in msgs[:3]:
            say(dim(f"       {m}"))
        if len(msgs) > 3:
            say(dim(f"       … {len(msgs) - 3} more in report.md"))
    with open(os.path.join(out, "report.md"), "w", encoding="utf-8") as f:
        f.write("# intern0 migration report\n\n")
        f.write(f"✅ {counts['OK']} · ⚠️ {counts['WARN']} · ❌ {counts['FAIL']}\n\n")
        for kind, item, s, msgs in report_lines:
            f.write(f"- {ICON[s].strip()} **{kind}** {item}\n")
            f.writelines(f"  - {m}\n" for m in msgs)
    say()
    say(f"  {counts['OK']} ✅   {counts['WARN']} ⚠️    {counts['FAIL']} ❌   Files and report: {bold(out)}")

    items = check_rule_items(rules_doc, rule_ids) if rules_doc else []
    if not perses_list and not items:
        raise Fail("Nothing could be translated, so there is nothing to import.")
    if args.dry_run:
        say("  Dry run: nothing was sent to Dash0.")
        return
    say()
    if not confirm("Import into Dash0 now?", args.yes):
        say("  Nothing was sent. The files stay in the folder above.")
        return

    # 4. Dash0
    region_label, api = choose_one("Which Dash0 region is your organization in?", DASH0_REGIONS,
                                   args.dash0_region, "--dash0-region")
    step("Dash0", region_label)
    dash0 = Dash0(api)
    with Spinner("Reading your Dash0 datasets…"):
        sets = dash0.datasets()
    if not sets:
        raise Fail("Dash0: this login sees no datasets.")
    ds_label, dataset = choose_one("Which dataset should the dashboards and alerts go to?",
                                   [(f"{n} ({i})" if n != i else i, i) for n, i in sets],
                                   args.dataset, "--dataset")
    what = f"{plural(len(perses_list), 'dashboard')} and {plural(len(items), 'alert')}"
    if not confirm(f"Import {what} into dataset '{dataset}'?", args.yes):
        say("  Nothing was sent. The files stay in the folder above.")
        return

    q = "?dataset=" + urllib.parse.quote(dataset)
    ok = True
    for perses in perses_list:
        body = {"kind": "Dashboard", "metadata": {"name": perses["metadata"]["name"],
                                                  "dash0Extensions": perses["metadata"]["dash0Extensions"]},
                "spec": perses["spec"]}
        title = perses["spec"].get("display", {}).get("name", perses["metadata"]["name"])
        with Spinner(f"Importing {title}…"):
            status, text = dash0.call("POST", "/api/import/dashboard" + q, body)
        if status in (200, 201):
            say(good(f"  ✓ dashboard {title}"))
        else:
            ok = False
            say(bad(f"  ✗ dashboard {title}: {error_text(status, text)}"))
    # Alerts from an earlier run are updated in place; the import endpoint only creates.
    new_items = []
    for item in items:  # quick checks; the spinner below covers the bulk import
        path = f"/api/alerting/check-rules/{item['id']}{q}"
        if dash0.call("GET", path)[0] != 200:
            new_items.append(item)
            continue
        status, text = dash0.call("PUT", path, {k: v for k, v in item.items() if k != "id"})
        if status in (200, 201):
            say(good(f"  ✓ alert {item['name']} (updated)"))
        else:
            ok = False
            say(bad(f"  ✗ alert {item['name']}: {error_text(status, text)}"))
    if new_items:
        with Spinner(f"Importing {plural(len(new_items), 'alert')}…"):
            status, text = dash0.call("POST", "/api/import/check-rules" + q, {"items": new_items})
        if status in (200, 201):
            say(good(f"  ✓ {plural(len(new_items), 'alert')} created"))
        else:
            ok = False
            say(bad(f"  ✗ alerts: {error_text(status, text)}. None of the new alerts was written."))
    say()
    say(brand("● ") + ("Done. " if ok else "Done, with errors above. ")
        + f"Open Dash0: https://app.dash0.com  (dataset '{dataset}'). Running again updates instead of duplicating.")


def logout(_args):
    state = load_state()
    state["tokens"] = {}
    save_state(state)
    say("Logged out: saved logins removed. To also revoke access, see Dash0: User Settings → Applications.")


def main():
    ap = argparse.ArgumentParser(prog="intern0", description="Move Datadog dashboards and monitors to Dash0.")
    ap.add_argument("--version", action="version", version=f"intern0 {VERSION}")
    sub = ap.add_subparsers(dest="command", required=True)
    m = sub.add_parser("migrate", help="log in, pick, review the plan, import")
    m.add_argument("--dry-run", action="store_true", help="stop after the plan: write files and report only")
    m.add_argument("--all", action="store_true", help="take every dashboard and monitor (no picking)")
    m.add_argument("--match", action="append", metavar="TEXT",
                   help="take items whose title contains TEXT (repeatable; no picking)")
    m.add_argument("--yes", action="store_true", help="answer yes to the import questions")
    m.add_argument("--out", default="intern0-out", help="folder for the translated files (default: intern0-out)")
    m.add_argument("--datadog-site", help="e.g. datadoghq.eu")
    m.add_argument("--dash0-region", help="Dash0 API URL, e.g. https://api.europe-west4.gcp.dash0.com")
    m.add_argument("--dataset", help="Dash0 dataset id")
    m.set_defaults(run=migrate)
    sub.add_parser("logout", help="forget the saved logins").set_defaults(run=logout)
    args = ap.parse_args()
    try:
        args.run(args)
    except Fail as e:
        say(bad(f"intern0: {e}"))
        sys.exit(1)
    except KeyboardInterrupt:
        say("\nStopped.")
        sys.exit(130)


if __name__ == "__main__":
    main()
