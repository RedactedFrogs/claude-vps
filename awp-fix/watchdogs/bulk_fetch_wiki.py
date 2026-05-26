#!/usr/bin/env python3
"""Bulk fetch Wikipedia via API with proxy rotation (250 AWP proxies).
Appends to article_pool_v2.jsonl. Dedup by page_id via used_articles.txt and SEEN file.

Usage: bulk_fetch_wiki.py <target_total_pool_size>
Pool target is TOTAL pool size including existing — fetcher exits when pool reaches it.
"""
import os, sys, json, time, random, threading, urllib.request, urllib.parse
import concurrent.futures as cf

TARGET = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
POOL = os.environ.get('POOL_OUT', '/root/.awp-mining/article_pool_v2.jsonl')
SEEN_FILE = '/root/.awp-mining/state/seen_pageids.txt'
STATUS = '/root/.awp-mining/state/v3_fetch_status.json'
PROXIES_F = '/root/.awp-mining/proxies.txt'
CONCURRENCY = 30
PER_REQ = 30

# load proxies
proxies = []
for line in open(PROXIES_F):
    p = line.strip().split(':')
    if len(p) == 4:
        proxies.append(f'http://{p[2]}:{p[3]}@{p[0]}:{p[1]}')
print(f'loaded {len(proxies)} proxies', flush=True)

# load seen ids from pool+used+seen-file (dedup)
seen = set()
if os.path.exists(POOL):
    for line in open(POOL):
        try:
            d = json.loads(line)
            pid = d.get('structured_data',{}).get('page_id')
            if pid: seen.add(str(pid))
        except: pass
if os.path.exists(SEEN_FILE):
    seen |= set(open(SEEN_FILE).read().split())
used_f = '/root/.awp-mining/used_articles.txt'
if os.path.exists(used_f):
    seen |= set(open(used_f).read().split())
print(f'seen page_ids: {len(seen)}', flush=True)

existing = sum(1 for _ in open(POOL)) if os.path.exists(POOL) else 0
print(f'pool start: existing={existing} target={TARGET}', flush=True)
write_lock = threading.Lock()
seen_lock = threading.Lock()

def fetch_batch(_):
    proxy = random.choice(proxies)
    url = ('https://en.wikipedia.org/w/api.php?'
           f'action=query&format=json&generator=random&grnnamespace=0&grnlimit={PER_REQ}'
           '&prop=extracts|info&explaintext=true&exsectionformat=plain&inprop=url')
    handler = urllib.request.ProxyHandler({'http': proxy, 'https': proxy})
    opener = urllib.request.build_opener(handler)
    opener.addheaders = [('User-Agent','Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 AWP-Builder/1.0')]
    try:
        with opener.open(url, timeout=20) as r:
            d = json.load(r)
    except Exception as e:
        return ('err', str(e)[:80])
    pages = (d.get('query') or {}).get('pages') or {}
    out = []
    for pid, p in pages.items():
        pid = str(p.get('pageid', pid))
        with seen_lock:
            if pid in seen: continue
            seen.add(pid)
        title = p.get('title','')
        canon = p.get('canonicalurl') or p.get('fullurl') or f'https://en.wikipedia.org/?curid={pid}'
        extract = p.get('extract','') or ''
        if not title or not canon or len(extract) < 50: continue
        rec = {
            'url': canon, 'cleaned_data': extract[:8000],
            'structured_data': {
                'page_id': int(pid), 'title': title, 'language': 'en',
                'dedup_key': canon, 'canonical_url': canon,
                'article_summary': extract[:300], 'raw_text': extract[:8000],
                'URL': canon, 'entity_type': 'wikipedia_article',
            },
            'crawl_timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        out.append(rec)
    return ('ok', out)

errors = 0; last_log = time.time()
with open(POOL, 'a') as fp, open(SEEN_FILE, 'a') as fs:
    while existing < TARGET:
        with cf.ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
            for tag, payload in ex.map(fetch_batch, range(CONCURRENCY)):
                if tag == 'err':
                    errors += 1; continue
                with write_lock:
                    for rec in payload:
                        fp.write(json.dumps(rec, ensure_ascii=False) + '\n')
                        fs.write(str(rec['structured_data']['page_id']) + '\n')
                        existing += 1
                if existing >= TARGET: break
        fp.flush(); fs.flush()
        if time.time() - last_log > 20:
            print(f'  pool={existing}/{TARGET} errors={errors}', flush=True)
            last_log = time.time()
        if errors > 500:
            print('many errors, sleeping 60s'); time.sleep(60); errors = 0

print(f'DONE: pool={existing}', flush=True)
with open(STATUS,'w') as st:
    json.dump({'count': existing, 'target': TARGET, 'done': True, 'ts': int(time.time())}, st)
