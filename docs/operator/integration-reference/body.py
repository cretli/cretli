# usage: python3 body.py <todo8> [append-file] — prints full body; with append-file, appends its text and saves via todo_update
import json, subprocess, sys, re
OP = '$SCRATCH/op.sh'
def call(tool, args):
    out = subprocess.run(['bash', OP, tool, json.dumps(args)], capture_output=True, text=True, timeout=120).stdout
    return out[:-1] if out.endswith('\n') else out
tid = sys.argv[1]
out = call('todo_show', {'todo_id': tid})
updated = re.search(r'updated: (\S+)', out).group(1)
full_id = re.search(r'\(([0-9a-f-]{36})\)', out.splitlines()[0]).group(1)
def page_body(text):
    part = text.split('\nfield: body\n', 1)[1] if '\nfield: body\n' in text else ''
    m = re.match(r'truncated=true next_cursor=(\S+)\n', part)
    cursor = m.group(1) if m else None
    if m: part = part[m.end():]
    return part, cursor
body, cursor = page_body(out)
while cursor:
    nxt = call('todo_show', {'todo_id': tid, 'cursor': cursor})
    part, cursor = page_body(nxt)
    body += part
body = re.sub(r'\nWhen the user requests execution of this parent.*$', '', body, flags=re.S).rstrip('\n')
if len(sys.argv) < 3:
    print(body); sys.exit(0)
add = open(sys.argv[2]).read().strip()
new = body + '\n\n' + add + '\n'
res = call('todo_update', {'todo_id': full_id, 'expected_updated_at': updated, 'patch': {'body': new}})
print(res[:160])
