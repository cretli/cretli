#!/usr/bin/env python3
"""Per-phase long-task attribution for the 5.2 acceptance traces.

Streams a trace twice: first to find the renderer main thread, the base
timestamp and all `performance.mark()` marks; second to collect main-thread
complete events and attribute each RunTask > 50 ms to its sub-events and to the
nearest preceding mark.
"""
import json
import sys
import collections
from analyze_trace import iter_events


def run(path):
    base = None
    run_ms = collections.Counter()
    marks = []
    names = {}
    for e in iter_events(path):
        ts = e.get('ts')
        if base is None and e.get('name') == 'TracingStartedInBrowser':
            base = ts
        if e.get('name') == 'RunTask' and e.get('ph') == 'X':
            run_ms[(e.get('pid'), e.get('tid'))] += e.get('dur', 0)
        cat = e.get('cat') or ''
        if 'blink.user_timing' in cat and e.get('name') and e.get('name') != 'TracingStartedInBrowser':
            marks.append((ts, e.get('name')))
    main = max(run_ms.items(), key=lambda kv: kv[1])[0]
    events = []
    for e in iter_events(path):
        if e.get('pid') != main[0] or e.get('tid') != main[1]:
            continue
        if e.get('ph') != 'X' or e.get('dur') is None:
            continue
        events.append((e.get('ts'), e.get('dur'), e.get('name'), (e.get('cat') or '')))
    longs = sorted([ev for ev in events if ev[2] == 'RunTask' and ev[1] > 50000])
    marks.sort()
    out = []
    for ts, dur, _name, _cat in longs:
        children = collections.defaultdict(lambda: [0, 0.0, 0.0])
        for cts, cdur, cname, ccat in events:
            if cname == 'RunTask':
                continue
            if cts >= ts and cts + cdur <= ts + dur and cdur >= 1000:
                g = children[cname]
                g[0] += 1
                g[1] += cdur
                g[2] = max(g[2], cdur)
        top = sorted(([k, v[0], round(v[1] / 1000.0, 2), round(v[2] / 1000.0, 2)] for k, v in children.items()), key=lambda r: -r[2])[:10]
        label = '(none)'
        for mts, mname in marks:
            if mts <= ts:
                label = mname
            else:
                break
        out.append({'t': round((ts - base) / 1e6, 3), 'ms': round(dur / 1000.0, 2), 'phase': label, 'sub': top})
    # Intervals between explicit user marks A-* .. H-*: max RunTask + long tasks.
    user_marks = [(ts, n) for ts, n in marks if len(n) > 2 and n[1] == '-' and n[0] in 'ABCDEFGH']
    intervals = []
    for i in range(0, len(user_marks) - 1):
        start_ts, start_name = user_marks[i]
        end_ts, _ = user_marks[i + 1]
        inside = [ev for ev in events if ev[2] == 'RunTask' and start_ts <= ev[0] < end_ts]
        if not inside:
            continue
        durations = [ev[1] for ev in inside]
        intervals.append({
            'from': start_name,
            'window_s': [round((start_ts - base) / 1e6, 3), round((end_ts - base) / 1e6, 3)],
            'max_task_ms': round(max(durations) / 1000.0, 2),
            'tasks_gt50': sum(1 for d in durations if d > 50000),
            'total_task_ms': round(sum(durations) / 1000.0, 2),
        })
    return {'main': main, 'base': base, 'marks': [[round((ts - base) / 1e6, 3), n] for ts, n in marks], 'long_tasks': out, 'intervals': intervals}


if __name__ == '__main__':
    print(json.dumps(run(sys.argv[1]), indent=1, ensure_ascii=False))
