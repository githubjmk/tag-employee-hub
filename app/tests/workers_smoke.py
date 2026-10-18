"""Workers/Durable Object smoke test (local `wrangler dev` only — nothing deployed).

Checks what the UI suite does not: security headers on static assets, CSRF and
size limits through the Worker, the scheduler alarm, and that data, the demo
clock and the audit hash chain survive a full restart of the local runtime.

Run: python3 tests/workers_smoke.py   (starts and restarts wrangler dev itself)
Env: WRANGLER=path/to/wrangler (default: `wrangler` on PATH)
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error, http.cookiejar
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WR = os.environ.get('WRANGLER', 'wrangler')
BASE = 'http://127.0.0.1:8789'
RESULTS = []


def start():
    p = subprocess.Popen([WR, 'dev', '--port', '8789', '--ip', '127.0.0.1'], cwd=ROOT / 'workers',
                         env={**os.environ, 'WRANGLER_SEND_METRICS': 'false'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(240):
        try:
            urllib.request.urlopen(BASE + '/api/demo/status', timeout=60); return p
        except Exception:
            time.sleep(0.5)
    raise RuntimeError('wrangler dev did not start')


def stop(p):
    p.terminate()
    try: p.wait(10)
    except Exception: p.kill()
    time.sleep(1)


class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def req(self, method, path, body=None, headers=None, raw=None):
        h = {'Content-Type': 'application/json', 'X-Hub-Request': '1', **(headers or {})}
        data = raw if raw is not None else (json.dumps(body or {}).encode() if method == 'POST' else None)
        r = urllib.request.Request(BASE + path, method=method, data=data, headers={k: v for k, v in h.items() if v is not None})
        try:
            with self.op.open(r, timeout=60) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def call(self, action, body=None):
        s, h, b = self.req('POST', '/api/call/' + action, body)
        assert s == 200, (action, s, b[:200])
        return json.loads(b)


def check(name, fn):
    try:
        d = fn(); RESULTS.append({'name': name, 'ok': True, 'detail': d}); print('PASS', name)
    except Exception as e:
        RESULTS.append({'name': name, 'ok': False, 'error': f'{type(e).__name__}: {e}'}); print('FAIL', name, e)


def main():
    p = start()
    state = {}
    try:
        c = Client()
        c.req('POST', '/api/dev/reset', {})

        def headers():
            s, h, _ = c.req('GET', '/')
            h = {k.lower(): v for k, v in h.items()}
            assert s == 200 and "script-src 'self'" in h['content-security-policy'] and h['x-frame-options'] == 'DENY' and h['x-content-type-options'] == 'nosniff'
            s, h, _ = c.req('GET', '/app.js'); h = {k.lower(): v for k, v in h.items()}
            assert 'content-security-policy' in h
            return 'CSP, frame, nosniff present on HTML and JS'
        check('W1 security headers on static assets served by the Worker', headers)

        def csrf_and_limits():
            s, _, _ = c.req('POST', '/api/call/home', {}, headers={'X-Hub-Request': None}); assert s == 403, s
            s, _, _ = c.req('POST', '/api/call/home', raw=b'x' * 70000); assert s == 413, s
            s, _, _ = c.req('POST', '/api/call/home', {}); assert s == 401, s
            return '403 without header, 413 oversize, 401 unauthenticated'
        check('W2 CSRF header, body limit and auth enforced through the Durable Object', csrf_and_limits)

        def flow():
            people = {x['id']: x for x in json.loads(c.req('GET', '/api/demo/people')[2])}
            s, _, b = c.req('POST', '/api/login', {'employeeId': 'E-107', 'pin': people['E-107']['pin'], 'sharedDevice': False}); assert s == 200, b
            a = c.call('home')['surveys'][-1]
            ans = {'q1': 4, 'q2': 5, 'q3': 'no', 'q4': 'no', 's2': 'WORKERS-SMOKE obstacle'}
            r = c.call('survey.submit', {'assignmentId': a['assignmentId'], 'answers': ans, 'signPin': people['E-107']['pin'], 'affirm': True, 'language': 'en', 'idempotencyKey': 'wsmoke-1'})
            r2 = c.call('survey.submit', {'assignmentId': a['assignmentId'], 'answers': ans, 'signPin': people['E-107']['pin'], 'affirm': True, 'language': 'en', 'idempotencyKey': 'wsmoke-1'})
            assert r2['submissionId'] == r['submissionId'] and r2.get('duplicate')
            rec = c.call('survey.record', {'submissionId': r['submissionId']})
            assert rec['original']['integrity'] == 'verified'
            state.update(sub=r['submissionId'], hash=r['hash'], now=c.call('session.me')['now'], cookies=list(c.jar))
            return r['submissionId']
        check('W3 sign and submit through the Durable Object; retry is idempotent', flow)

        def alarm():
            # the alarm ticks every 60 s; the demo-clock tick endpoint drives the same code path deterministically
            s, _, b = c.req('POST', '/api/dev/tick', {'advanceMinutes': 1}); assert s == 200, b
            return json.loads(b)
        check('W4 scheduler tick runs inside the Durable Object', alarm)
    finally:
        stop(p)

    p = start()
    try:
        def persisted():
            c = Client()
            for ck in state.get('cookies', []): c.jar.set_cookie(ck)
            me = c.call('session.me')   # session survived the restart (stored in DO SQLite)
            assert me['employee']['id'] == 'E-107'
            rec = c.call('survey.record', {'submissionId': state['sub']})
            assert rec['original']['hash'] == state['hash'] and rec['original']['integrity'] == 'verified'
            assert me['now'] >= state['now'], (me['now'], state['now'])
            return {'clockBefore': state['now'], 'clockAfter': me['now']}
        check('W5 data, session and demo clock survive a restart of the local runtime', persisted)

        def integrity():
            c = Client()
            people = {x['id']: x for x in json.loads(c.req('GET', '/api/demo/people')[2])}
            s, _, b = c.req('POST', '/api/login', {'employeeId': 'E-101', 'pin': people['E-101']['pin'], 'totp': people['E-101']['totp']}); assert s == 200, b
            r = c.call('audit.verify')
            assert r['ok'], r
            return {'auditEvents': r['auditEvents'], 'signedRecordsChecked': r['signedRecordsChecked']}
        check('W6 audit hash chain and signed records verify after restart', integrity)
    finally:
        stop(p)

    (ROOT / 'tests' / 'workers-smoke-results.json').write_text(json.dumps({'ranAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'results': RESULTS}, indent=2))
    ok = sum(r['ok'] for r in RESULTS)
    print(f'{ok}/{len(RESULTS)} Workers smoke checks passed')
    sys.exit(0 if ok == len(RESULTS) else 1)


if __name__ == '__main__':
    main()
