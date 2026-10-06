#!/usr/bin/env python3
"""Streaming Chromium trace analyzer for the UI-freeze acceptance (task 5.2).

Reads a standard Chrome/DevTools trace JSON in a streaming fashion so a
100-200 MB recording does not need to be materialised as one Python object.

Outputs a JSON report with the metrics used by the acceptance document:
long tasks, style/layout/commit/prepaint, mounted DOM (UpdateCounters),
interactions (EventTiming), geometry-forcing stacks during history replay,
resource requests, and CPU-profile inclusive time for the replay functions.
"""
import json
import sys
import collections
import bisect

CHUNK = 1 << 20


def iter_events(path):
    dec = json.JSONDecoder()
    with open(path, 'r', encoding='utf-8') as fh:
        buf = fh.read(CHUNK)
        key = '"traceEvents"'
        idx = buf.find(key)
        while idx == -1:
            more = fh.read(CHUNK)
            if not more:
                return
            buf += more
            idx = buf.find(key)
        buf = buf[idx + len(key):]
        # skip to '['
        while True:
            buf = buf.lstrip()
            if buf.startswith(':'):
                buf = buf[1:].lstrip()
            if buf.startswith('['):
                buf = buf[1:]
                break
            more = fh.read(CHUNK)
            if not more:
                return
            buf += more
        while True:
            buf = buf.lstrip()
            if not buf:
                more = fh.read(CHUNK)
                if not more:
                    return
                buf += more
                continue
            if buf[0] == ']':
                return
            if buf[0] == ',':
                buf = buf[1:]
                continue
            try:
                obj, end = dec.raw_decode(buf)
            except ValueError:
                more = fh.read(CHUNK)
                if not more:
                    raise
                buf += more
                continue
            yield obj
            buf = buf[end:]
            if len(buf) < 4096:
                more = fh.read(CHUNK)
                if more:
                    buf += more


def label(frame):
    fn = frame.get('functionName', '') or '(anonymous)'
    url = (frame.get('url', '') or '').replace('webpack-internal:///./', '')
    line = frame.get('lineNumber', -1)
    return '%s @ %s:%d' % (fn, url, line + 1)


def analyze(path):
    # Pass 1: renderer main thread = (pid,tid) with the largest total RunTask
    # wall time (a blocked renderer main thread dominates the IO/browser threads).
    run_task_ms = collections.Counter()
    min_ts = None
    browser_started = None
    thread_names = {}
    for e in iter_events(path):
        ts = e.get('ts')
        if ts is not None and (min_ts is None or ts < min_ts):
            min_ts = ts
        name = e.get('name')
        if name == 'TracingStartedInBrowser' and browser_started is None:
            browser_started = ts
        if name == 'thread_name':
            thread_names[(e.get('pid'), e.get('tid'))] = (e.get('args') or {}).get('name')
        if name == 'RunTask' and e.get('ph') == 'X':
            run_task_ms[(e.get('pid'), e.get('tid'))] += e.get('dur', 0)
    if not run_task_ms:
        raise SystemExit('no RunTask events found')
    # Prefer a thread explicitly named CrRendererMain; otherwise biggest total.
    candidates = [(k, v) for k, v in run_task_ms.items()]
    named = [(k, v) for k, v in candidates if thread_names.get(k) == 'CrRendererMain']
    pool = named or candidates
    main_pid, main_tid = max(pool, key=lambda kv: kv[1])[0]
    thread_names['_pool'] = 'named=%d total_threads=%d' % (len(named), len(candidates))
    base = browser_started if browser_started is not None else min_ts
    end = base

    durations = collections.Counter()
    counts = collections.Counter()
    longs = []
    counters = []  # (rel_s, data)
    interactions = {}  # id -> dict
    layout_stacks = collections.defaultdict(lambda: [0, 0, 0])
    requests = {}
    profile_meta = {}  # (pid,id) -> pid/id
    profile_nodes = {}
    profile_samples = []  # (ts_us, dt_us, node_id)
    profile_start = None

    for e in iter_events(path):
        ts = e.get('ts')
        dur = e.get('dur')
        if ts is not None and dur is not None and ts + dur > end:
            end = ts + dur
        name = e.get('name')
        if name == 'Profile' and e.get('ph') == 'P':
            d = (e.get('args') or {}).get('data') or {}
            profile_meta[(e.get('pid'), e.get('id'))] = d.get('startTime')
        # only main renderer thread for the main-thread aggregates
        if e.get('pid') != main_pid or e.get('tid') != main_tid:
            if name == 'ProfileChunk' and e.get('pid') is not None:
                pass
            else:
                continue
        if e.get('ph') == 'X' and dur is not None:
            durations[name] += dur
            counts[name] += 1
            if name == 'RunTask' and dur > 50000:
                longs.append((ts, dur))
            if name in ('UpdateLayoutTree', 'Layout', 'RecalculateStyles', 'ParseHTML'):
                b = (e.get('args') or {}).get('beginData') or {}
                st = b.get('stackTrace') or []
                key = ' > '.join((x.get('functionName') or '?') for x in st[:6]) or '(no JS stack)'
                g = layout_stacks[name + '|' + key]
                g[0] += 1
                g[1] += dur
                g[2] = max(g[2], dur)
        if name == 'UpdateCounters':
            d = (e.get('args') or {}).get('data') or {}
            counters.append(((ts - base) / 1e6, {
                'nodes': d.get('nodes'),
                'documents': d.get('documents'),
                'jsEventListeners': d.get('jsEventListeners'),
                'jsHeapSizeUsed': d.get('jsHeapSizeUsed'),
                'layoutObjects': d.get('layoutObjects'),
            }))
        if name == 'EventTiming' and e.get('ph') == 'b':
            d = (e.get('args') or {}).get('data') or {}
            iid = d.get('interactionId')
            if iid:
                v = interactions.setdefault(iid, {'t': (ts - base) / 1e6, 'max_duration_ms': 0, 'max_queue_ms': 0, 'types': []})
                v['max_duration_ms'] = max(v['max_duration_ms'], d.get('duration', 0))
                v['max_queue_ms'] = max(v['max_queue_ms'], (d.get('processingStart', 0) or 0) - (d.get('timeStamp', 0) or 0))
                v['types'].append(d.get('type'))
        if name == 'ResourceSendRequest':
            d = (e.get('args') or {}).get('data') or {}
            requests[d.get('requestId')] = {'t': (ts - base) / 1e6, 'url': d.get('url')}
        if name == 'ResourceFinish':
            d = (e.get('args') or {}).get('data') or {}
            r = requests.get(d.get('requestId'))
            if r:
                r['finish_t'] = (ts - base) / 1e6
                r['bytes'] = d.get('decodedBodyLength')

    # Profile chunks live on the renderer process, any tid, matched by (pid, id).
    now = None
    nodes = {}
    for e in iter_events(path):
        if e.get('name') != 'ProfileChunk' or e.get('pid') != main_pid:
            continue
        d = (e.get('args') or {}).get('data') or {}
        cp = d.get('cpuProfile') or {}
        for n in cp.get('nodes', []):
            nodes[n['id']] = n
        ss = cp.get('samples') or []
        ds = d.get('timeDeltas') or []
        if not ss:
            continue
        if now is None:
            now = profile_meta.get((main_pid, e.get('id')))
        if now is None:
            now = profile_meta.get((e.get('pid'), e.get('id')))
        for s, dt in zip(ss, ds):
            now += dt
            profile_samples.append((now, dt, s))
    for n in nodes.values():
        for c in n.get('children', []):
            if c in nodes:
                nodes[c].setdefault('parent', n['id'])

    chains = {}

    def chain(nid):
        if nid in chains:
            return chains[nid]
        ids = []
        cur = nid
        while cur in nodes and cur not in ids:
            ids.append(cur)
            cur = nodes[cur].get('parent')
        chains[nid] = ids
        return ids

    self_c = collections.Counter()
    incl = collections.Counter()
    for ts, dt, nid in profile_samples:
        self_c[nid] += dt
        for a in chain(nid):
            incl[a] += dt
    key_funcs = ('replayHistoryRecordsChunkedImpl', 'applyHistoryRecord', 'runViewApplyWithOrder',
                 'captureInsertScroll', 'isScrollableNearBottom', 'applySdkEventCore', 'renderMarkdown',
                 'renderDelegationCard', 'renderMailboxCard', 'scheduleSidebar', 'sidebar', 'replayHistoryRecords')
    func_stats = []
    for nid, total in incl.most_common():
        lbl = label(nodes[nid]['callFrame'])
        if any(k.lower() in lbl.lower() for k in key_funcs):
            func_stats.append({'ms_incl': round(total / 1000, 3), 'ms_self': round(self_c[nid] / 1000, 3), 'fn': lbl})
        if len(func_stats) >= 40:
            break

    long_ms = sum(d for _, d in longs) / 1000.0

    def call_clusters(name_part, gap_us=2500):
        """Group CPU samples inside `name_part` into contiguous call clusters."""
        targets = set(nid for nid in nodes if name_part.lower() in label(nodes[nid]['callFrame']).lower())
        if not targets:
            return []
        hits = []
        for ts, dt, nid in profile_samples:
            for a in chain(nid):
                if a in targets:
                    hits.append((ts, dt))
                    break
        hits.sort()
        clusters = []
        cur = None
        for ts, dt in hits:
            if cur is not None and ts - cur['end'] <= gap_us:
                cur['end'] = ts
                cur['ms'] += dt
                cur['n'] += 1
            else:
                if cur:
                    clusters.append(cur)
                cur = {'start': ts, 'end': ts, 'ms': dt, 'n': 1}
        if cur:
            clusters.append(cur)
        clusters.sort(key=lambda c: -c['ms'])
        return [{'start_s': round((c['start'] - base) / 1e6, 3), 'ms': round(c['ms'] / 1000.0, 3), 'samples': c['n']} for c in clusters[:10]]

    return {
        'path': path,
        'main_pid': main_pid,
        'main_tid': main_tid,
        'main_thread_name': thread_names.get((main_pid, main_tid)),
        'thread_pool': thread_names.get('_pool'),
        'base_ts': base,
        'duration_s': round((end - base) / 1e6, 3),
        'long_tasks': len(longs),
        'long_tasks_ms': round(long_ms, 3),
        'long_tasks_blocking_ms': round(sum(d - 50000 for _, d in longs) / 1000.0, 3),
        'longest_task_ms': round(max((d for _, d in longs), default=0) / 1000.0, 3),
        'event_durations': [[n, counts[n], round(t / 1000.0, 3)] for n, t in durations.most_common(30)],
        'long_task_timeline': [[round((ts - base) / 1e6, 3), round(d / 1000.0, 1)] for ts, d in longs],
        'counters_first': counters[0][1] if counters else None,
        'counters_last': counters[-1][1] if counters else None,
        'counters_max': {k: max((c[1].get(k) or 0) for c in counters) for k in ('nodes', 'documents', 'jsEventListeners', 'jsHeapSizeUsed', 'layoutObjects')} if counters else None,
        'interactions': sorted(interactions.values(), key=lambda v: -v['max_duration_ms'])[:25],
        'max_interaction_ms': round(max((v['max_duration_ms'] for v in interactions.values()), default=0), 3),
        'max_interaction_queue_ms': round(max((v['max_queue_ms'] for v in interactions.values()), default=0), 3),
        'layout_by_stack': sorted(
            [[k.split('|', 1)[0], k.split('|', 1)[1], v[0], round(v[1] / 1000.0, 3), round(v[2] / 1000.0, 3)] for k, v in layout_stacks.items()],
            key=lambda r: -r[3])[:25],
        'requests': [r for r in requests.values() if r.get('url') and '/api/' in r['url']][:60],
        'profile_samples': len(profile_samples),
        'profile_nodes': len(nodes),
        'key_functions': func_stats,
        'replay_clusters': call_clusters('applyHistoryRecord'),
        'capture_clusters': call_clusters('captureInsertScroll'),
        'scroll_bottom_clusters': call_clusters('isScrollableNearBottom'),
    }


if __name__ == '__main__':
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    report = analyze(src)
    text = json.dumps(report, indent=1, ensure_ascii=False)
    if out:
        with open(out, 'w', encoding='utf-8') as fh:
            fh.write(text)
    print(text)
