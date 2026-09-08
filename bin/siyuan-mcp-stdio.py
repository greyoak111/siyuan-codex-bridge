#!/usr/bin/env python3
"""Minimal stdio -> SiYuan official Streamable HTTP MCP bridge.
No third-party packages. Token is read from .env and never logged or emitted.
"""
import json, os, re, sys, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / '.env'
POLICY = ROOT / 'config' / 'siyuan-policy.json'
AUDIT = ROOT / 'audit' / 'operations.jsonl'

def load_env():
    vals = {}
    try:
        for raw in ENV.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line: continue
            k,v = line.split('=',1); vals[k.strip()] = v.strip().strip('"').strip("'")
    except Exception as e:
        print(json.dumps({"jsonrpc":"2.0","error":{"code":-32000,"message":"bridge env unavailable"}}), flush=True)
        raise SystemExit(1)
    token = vals.get('SIYUAN_API_TOKEN','')
    if not token or token == 'PASTE_YOUR_SIYUAN_API_TOKEN_HERE':
        print(json.dumps({"jsonrpc":"2.0","error":{"code":-32000,"message":"SIYUAN_API_TOKEN is not configured in ~/siyuan-codex-bridge/.env"}}), flush=True)
        raise SystemExit(1)
    return vals.get('SIYUAN_MCP_URL','http://127.0.0.1:6806/mcp'), token

URL, TOKEN = load_env()
SESSION = None


def safe_text(value, limit=160):
    """Keep untrusted labels out of logs/errors and remove the live token."""
    text = str(value).replace("\r", "\\r").replace("\n", "\\n")
    if TOKEN:
        text = text.replace(TOKEN, "[redacted]")
    return text[:limit]


def redact_value(value):
    """Defensively remove the live token from any upstream JSON response."""
    if not TOKEN:
        return value
    if isinstance(value, str):
        return value.replace(TOKEN, "[redacted]")
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    if isinstance(value, dict):
        return {key: redact_value(item) for key, item in value.items()}
    return value


READ_ACTIONS = {
    'search': {'fulltext','semantic'},
    'document': {'get','list','search_docs','info'},
    'block': {'get','get_kramdown','get_children','tree_stat','dom','breadcrumb','batch_get','batch_kramdown'},
    'notebook': {'list'}, 'outline': {'get'},
    'ref': {'backlinks','mentions'}, 'attr': {'get','batch-get'},
    'system': {'version','current_time','workspace'}, 'workspace': {'list','info'},
}
PROFILES = ('readonly', 'authoring', 'full')
AUTHORING_ACTIONS = {
    'document': {'create'}, 'block': {'insert','append','prepend','update'},
    'attr': {'set','batch-set'}, 'dailynote': {'create','append','prepend'},
}

def current_profile():
    chosen = os.environ.get('SIYUAN_MCP_PROFILE', '').strip().lower()
    if not chosen:
        try: chosen = json.loads(POLICY.read_text()).get('profile', 'readonly').lower()
        except (OSError, ValueError, AttributeError): chosen = 'readonly'
    chosen = {'read':'readonly', 'edit':'authoring'}.get(chosen, chosen)
    # Fail closed if a policy file is missing or malformed. The checked-in
    # local policy file explicitly selects `full` when that is desired.
    return chosen if chosen in PROFILES else 'readonly'

def action_allowed(tool, action):
    profile = current_profile()
    if profile == 'full': return True
    if action in READ_ACTIONS.get(tool, set()): return True
    return profile == 'authoring' and action in AUTHORING_ACTIONS.get(tool, set())

def err(msg, rid=None, code=-32001):
    out={"jsonrpc":"2.0","error":{"code":code,"message":msg}}
    if rid is not None: out['id']=rid
    return out

def audit(tool, action, decision):
    # Deliberately omit arguments, results, note content, headers, and tokens.
    try:
        AUDIT.parent.mkdir(mode=0o700, exist_ok=True)
        with AUDIT.open('a', encoding='utf-8') as fp:
            fp.write(json.dumps({'ts': datetime.now(timezone.utc).isoformat(),
                                 'client': 'siyuan-mcp-stdio', 'profile': current_profile(),
                                 'tool': safe_text(tool), 'action': safe_text(action or ''),
                                 'decision': decision}, ensure_ascii=True) + '\n')
        os.chmod(AUDIT, 0o600)
    except OSError:
        pass

def allowed_tool(name, desc='', args=None):
    name = str(name)
    action = (args or {}).get('action')
    return current_profile() == 'full' if action is None else action_allowed(name, str(action))

def parse_response(resp):
    ctype = (resp.headers.get('content-type') or '').lower()
    data = resp.read().decode('utf-8','replace')
    sid = resp.headers.get('Mcp-Session-Id')
    if 'text/event-stream' in ctype or data.lstrip().startswith('event:') or data.lstrip().startswith('data:'):
        chunks=[]
        for line in data.splitlines():
            if line.startswith('data:'):
                d=line[5:].strip()
                if d and d != '[DONE]': chunks.append(d)
        data = chunks[-1] if chunks else '{}'
    return sid, data, ctype

def call_upstream(msg):
    global SESSION
    rid = msg.get('id')
    # Enforce the selected operation profile at the protocol boundary.
    if msg.get('method') == 'tools/call':
        p = msg.get('params') or {}; name = p.get('name',''); args = p.get('arguments') or {}
        if not allowed_tool(str(name), '', args):
            audit(name, args.get('action'), 'denied')
            return err(f'tool {safe_text(name)!r} action is disabled by the Siyuan bridge policy profile', rid, -32003)
        audit(name, args.get('action'), 'allowed')
    body=json.dumps(msg,separators=(',',':')).encode()
    req=urllib.request.Request(URL, data=body, method='POST', headers={
        'Content-Type':'application/json', 'Accept':'application/json, text/event-stream',
        'Authorization':'Token '+TOKEN,
        **({'Mcp-Session-Id':SESSION} if SESSION else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            sid,data,_=parse_response(resp)
            if sid: SESSION=sid
            try:
                obj = json.loads(data)
                return redact_value(obj)
            except Exception: return err('invalid MCP response from Siyuan', rid)
    except urllib.error.HTTPError as e:
        # Do not expose response body: it could contain sensitive server details.
        return err(f'Siyuan MCP HTTP {e.code}', rid, -32002)
    except Exception as e:
        return err('Siyuan MCP connection failed', rid, -32002)

def main():
    for line in sys.stdin:
        if not line.strip(): continue
        try: msg=json.loads(line)
        except Exception:
            print(json.dumps(err('invalid JSON request')), flush=True); continue
        # Only policy-check calls; initialize/list are passed to official MCP unchanged.
        out=call_upstream(msg)
        # Notifications have no id and should not produce a response.
        if 'id' in msg: print(json.dumps(out,separators=(',',':')), flush=True)

if __name__=='__main__': main()
