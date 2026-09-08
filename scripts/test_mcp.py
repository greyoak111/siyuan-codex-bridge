#!/usr/bin/env python3
import json, os, re, sys, urllib.request, urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
vals={}
for line in (ROOT/'.env').read_text().splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  k,v=line.split('=',1); vals[k.strip()]=v.strip().strip('"').strip("'")
token=vals.get('SIYUAN_API_TOKEN','')
if not token or token=='PASTE_YOUR_SIYUAN_API_TOKEN_HERE':
 print('FAIL: SIYUAN_API_TOKEN is not configured in '+str(ROOT/'.env')); sys.exit(2)
url=vals.get('SIYUAN_MCP_URL','http://127.0.0.1:6806/mcp'); sid=None; seq=0

def post(method, params=None, notify=False):
 global sid,seq
 seq+=1; m={'jsonrpc':'2.0','method':method}
 if not notify: m['id']=seq
 if params is not None:m['params']=params
 req=urllib.request.Request(url,data=json.dumps(m).encode(),method='POST',headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream','Authorization':'Token '+token,**({'Mcp-Session-Id':sid} if sid else {})})
 try:
  with urllib.request.urlopen(req,timeout=30) as r:
   sid=r.headers.get('Mcp-Session-Id') or sid; raw=r.read().decode('utf-8','replace')
  if notify:return {}
  if 'data:' in raw: raw=[x[5:].strip() for x in raw.splitlines() if x.startswith('data:')][-1]
  return json.loads(raw)
 except urllib.error.HTTPError as e: return {'error':{'message':f'HTTP {e.code}'}}
 except Exception as e: return {'error':{'message':'connection failed'}}

def call(name,args): return post('tools/call',{'name':name,'arguments':args})
def result_text(r):
 try:
  c=r['result']['content']; return '\n'.join(x.get('text','') for x in c if isinstance(x,dict))
 except Exception:return ''
def pick_obj(text):
 try:return json.loads(text)
 except Exception:
  m=re.search(r'\{.*\}',text,re.S)
  try:return json.loads(m.group(0)) if m else None
  except Exception:return None

def parse_notebook_list(text):
 # SiYuan's official MCP returns a human-readable list rather than JSON.
 out=[]
 for name, ident in re.findall(r'^-\s+(.+?)\s+\(id:\s*([0-9A-Za-z-]+),', text, re.M):
  out.append({'name':name.strip(), 'id':ident})
 return out

def parse_document_list(text):
 # Example: - title (id: 202...)
 out=[]
 for title, ident in re.findall(r'^-\s+(.+?)\s+\(id:\s*([0-9A-Za-z-]+)(?:,|\))', text, re.M):
  out.append({'title':title.strip(), 'id':ident})
 return out

def parse_child_id(text):
 m=re.search(r'\(([0-9A-Za-z-]{10,})\)\s*$', text.strip(), re.M)
 return m.group(1) if m else None

def report(label,r):
 if 'error' in r: print(f'{label}: FAIL ({r["error"].get("message","error")})'); return False
 print(f'{label}: PASS'); return True

def check_write_approval():
 # Keep the complete official catalog visible while requiring Codex approval
 # for mutating calls. Read only the relevant server section; never print the
 # config contents or any environment values.
 config = Path.home()/'.codex'/'config.toml'
 try:
  text = config.read_text()
 except OSError:
  print('write tools approval: FAIL (Codex config is unreadable)')
  return False
 section = re.search(r'(?ms)^\[mcp_servers\.siyuan\]\s*(.*?)(?=^\[|\Z)', text)
 if not section:
  print('write tools approval: FAIL (siyuan MCP section is missing)')
  return False
 mode = re.search(r'(?m)^\s*default_tools_approval_mode\s*=\s*["\']writes["\']\s*$', section.group(1))
 if not mode:
  print('write tools approval: FAIL (default_tools_approval_mode is not writes)')
  return False
 print('write tools approval: PASS (default_tools_approval_mode = writes)')
 return True

r=post('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'siyuan-codex-bridge-test','version':'1.0'}})
if not report('MCP initialize',r):sys.exit(3)
post('notifications/initialized',{},True)
r=post('tools/list',{})
if not report('tools/list',r):sys.exit(3)
tools=r.get('result',{}).get('tools',[]); print('tools ('+str(len(tools))+'): '+', '.join(t.get('name','') for t in tools))
expected={'asset','attr','block','bookmark','dailynote','database','document','export','file','history','http_request','image','import','inbox','notebook','outline','ref','repo','search','skill','sql','sync','system','tag','template','unzip','web_fetch','web_search','workspace'}
seen={t.get('name') for t in tools}
if not expected.issubset(seen):
 print('official catalog: FAIL (full catalog is not visible)'); sys.exit(3)
print('official catalog: PASS (all expected native tool groups visible)')
# Locate the explicitly requested test notebook.
nr=call('notebook',{'action':'list'}); report('notebook.list',nr)
notebooks=pick_obj(result_text(nr)) or {}
if not notebooks: notebooks=parse_notebook_list(result_text(nr))
items=(notebooks if isinstance(notebooks,list) else
       notebooks.get('notebooks',notebooks.get('data',[])))
if isinstance(items,dict): items=items.get('notebooks',[])
nb=next((x for x in items if isinstance(x,dict) and x.get('name')=='Codex测试'),None)
if not nb:
 print('Codex测试 notebook: FAIL (not found; no other notebook will be read)'); sys.exit(4)
nbid=nb.get('id'); print('Codex测试 notebook: PASS (id hidden only by policy)')
sr=call('search',{'action':'fulltext','query':'Codex测试','notebook':nbid,'page':1,'pageSize':20}); report('search “Codex测试”',sr)
# list documents in that notebook, then read only the first returned document.
dr=call('document',{'action':'list','notebook':nbid,'path':'/'}); report('document.list (Codex测试)',dr)
dobj=pick_obj(result_text(dr)) or {}; docs=dobj.get('files',dobj.get('documents',dobj.get('data',[])))
if not docs: docs=parse_document_list(result_text(dr))
if isinstance(docs,dict): docs=docs.get('files',docs.get('documents',[]))
doc=next((x for x in docs if isinstance(x,dict) and x.get('id')),None)
if not doc: print('test document read: FAIL (no document returned)')
else:
 did=doc['id']; gr=call('document',{'action':'get','id':did}); report('document.get',gr)
 br=call('block',{'action':'get_children','id':did}); report('block.get_children',br)
 bobj=pick_obj(result_text(br)) or {}; children=bobj.get('children',bobj.get('data',[])); child=children[0] if isinstance(children,list) and children else {'id':parse_child_id(result_text(br)) or did}
 bid=child.get('id',did) if isinstance(child,dict) else did
 kr=call('block',{'action':'get_kramdown','id':bid}); report('block.get_kramdown',kr)
 txt=result_text(kr).replace('\n',' ')
 # Fetch and validate content without printing note text into the terminal or chat.
 if token in txt: print('block content safety: FAIL (token-like value found in response)'); sys.exit(5)
 print('block id/path/content: '+str(bid)+' / '+str(doc.get('path',doc.get('hPath','')))+' / '+('returned ('+str(len(txt))+' chars)' if txt else '<empty>'))
 rr=call('ref',{'action':'backlinks','id':did}); report('ref.backlinks',rr)
if not check_write_approval(): sys.exit(6)
print('official MCP read checks: PASS (no write call was sent)')
