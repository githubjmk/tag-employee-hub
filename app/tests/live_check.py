"""Checks against the deployed TEST COPY (sample data only).

    HUB_LIVE_BASE=https://tag-employee-hub-test.<account>.workers.dev python3 tests/live_check.py

The test copy has no reset or clock endpoints, so these checks only add sample
data (one survey, one urgent sample safety report). The scheduler check waits for
the real Durable Object alarm, so the full run takes about 17 minutes.
"""
import json, os, sys, time, uuid, urllib.request, urllib.error, http.cookiejar, pathlib

BASE = os.environ.get('HUB_LIVE_BASE', '').rstrip('/')
if not BASE.startswith('https://'):
    sys.exit('Set HUB_LIVE_BASE to the https:// address of the test copy')
UA = 'tag-hub-live-check/1.0'   # Cloudflare refuses the default Python user agent
RESULTS = []


class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def req(self, method, path, body=None, headers=None, raw=None):
        h = {'Content-Type': 'application/json', 'X-Hub-Request': '1', 'User-Agent': UA}
        h.update(headers or {})
        h = {k: v for k, v in h.items() if v is not None}
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        r = urllib.request.Request(BASE + path, method=method, data=data, headers=h)
        try:
            with self.op.open(r, timeout=30) as x:
                return x.status, x.headers, x.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read().decode()

    def call(self, action, body=None):
        s, _, b = self.req('POST', '/api/call/' + action, body or {})
        if s != 200:
            raise AssertionError(f'{action} -> {s} {b[:300]}')
        return json.loads(b)


def check(name, fn):
    try:
        d = fn(); RESULTS.append({'name': name, 'ok': True, 'detail': d}); print('PASS', name, '-', d, flush=True)
    except Exception as e:
        RESULTS.append({'name': name, 'ok': False, 'error': f'{type(e).__name__}: {e}'}); print('FAIL', name, e, flush=True)


def people():
    s, _, b = Client().req('GET', '/api/demo/people')
    assert s == 200, s
    return {p['id']: p for p in json.loads(b)}


def login(eid, P, totp=True):
    c = Client()
    body = {'employeeId': eid, 'pin': P[eid]['pin'], 'sharedDevice': False}
    if totp and P[eid].get('totp'):
        body['totp'] = P[eid]['totp']
    s, h, b = c.req('POST', '/api/login', body)
    return c, s, h, b


def main():
    P = people()
    state = {}

    def headers():
        c = Client()
        for path in ['/', '/app.js']:
            s, h, _ = c.req('GET', path)
            assert s == 200, (path, s)
            assert "script-src 'self'" in h['content-security-policy'] and h['x-frame-options'] == 'DENY' and h['x-content-type-options'] == 'nosniff', path
        return 'CSP, frame and nosniff headers on the page and script, served over HTTPS'
    check('L1 security headers on the live address', headers)

    def limits():
        c = Client()
        s, _, _ = c.req('POST', '/api/call/home', {}, headers={'X-Hub-Request': None}); assert s == 403, s
        s, _, _ = c.req('POST', '/api/call/home', raw=b'x' * 70000); assert s == 413, s
        s, _, _ = c.req('POST', '/api/call/home', {}); assert s == 401, s
        return '403 without the request header, 413 oversize, 401 when not signed in'
    check('L2 request checks enforced', limits)

    def dev_off():
        c = Client()
        out = {}
        for p in ['/api/dev/reset', '/api/dev/tick']:
            s, _, _ = c.req('POST', p, {}); out[p] = s
            assert s != 200, (p, s)
        return out
    check('L3 reset and clock endpoints are switched off', dev_off)

    def cookie_flags():
        c, s, h, b = login('E-107', P)
        assert s == 200, b
        sc = h.get('Set-Cookie', '')
        for flag in ['HttpOnly', 'Secure', 'SameSite=Strict']:
            assert flag in sc, (flag, sc[:80])
        state['staff'] = c
        return 'session cookie is HttpOnly, Secure, SameSite=Strict'
    check('L4 staff sign-in with ID + PIN; cookie flags', cookie_flags)

    def submit():
        c = state['staff']
        me = c.call('session.me')
        assert me['surveyWindow']['openNow'], me['surveyWindow']
        home = c.call('home')
        a = next((x for x in reversed(home['surveys']) if x.get('state') == 'open'), None)
        if a is None:
            return 'no open survey this week for the sample user (already submitted in an earlier run)'
        ans = {'q1': 4, 'q2': 5, 'q3': 'no', 'q4': 'no', 's2': 'LIVE-CHECK sample answer'}
        key = 'live-' + uuid.uuid4().hex[:12]
        body = {'assignmentId': a['assignmentId'], 'answers': ans, 'signPin': P['E-107']['pin'], 'affirm': True, 'language': 'en', 'idempotencyKey': key, 'esignConsent': True}
        r = c.call('survey.submit', body)
        r2 = c.call('survey.submit', body)
        assert r2['submissionId'] == r['submissionId'] and r2.get('duplicate'), r2
        rec = c.call('survey.record', {'submissionId': r['submissionId']})
        assert rec['original']['integrity'] == 'verified', rec['original'].get('integrity')
        return {'submission': r['submissionId'], 'retrySameRecord': True, 'integrity': 'verified'}
    check('L5 sign and submit the weekly report; retry is idempotent; record verifies', submit)

    def staff_boundary():
        s, _, _ = state['staff'].req('POST', '/api/call/accounts.list', {})
        assert s == 403, s
        return 'staff get 403 on Employee Accounts'
    check('L6 staff cannot open management screens', staff_boundary)

    def wrong_pin():
        c = Client()
        s, _, b = c.req('POST', '/api/login', {'employeeId': 'E-106', 'pin': '000000'})
        assert s == 401, (s, b)
        c, s, _, b = login('E-106', P)   # a correct sign-in clears the failure count
        assert s == 200, b
        return 'wrong PIN refused (401); correct PIN then accepted'
    check('L7 wrong PIN refused', wrong_pin)

    def mgmt_mfa():
        c, s0, _, b = login('E-101', P, totp=False)
        assert s0 != 200, 'management signed in without authenticator code'
        c, s, _, b = login('E-101', P)
        assert s == 200, b
        state['mgr'] = c
        return f'without authenticator code: refused ({s0}); with code: signed in'
    check('L8 management sign-in requires the authenticator code', mgmt_mfa)

    def audit():
        r = state['mgr'].call('audit.verify')
        assert r['ok'], r
        return {'auditEvents': r['auditEvents'], 'signedRecordsChecked': r['signedRecordsChecked']}
    check('L9 audit hash chain and signed records verify on the live copy', audit)

    def scheduler():
        # File an urgent SAMPLE report as a staff account and do not acknowledge it.
        # Only the Durable Object alarm creates ESCALATION notifications (15 minutes after
        # the report), so seeing one proves the scheduler runs in Cloudflare on its own.
        c, s, _, b = login('E-104', P); assert s == 200, b
        r = c.call('safety.report', {'type': 'injury', 'description': 'LIVE-CHECK sample report (test copy, not real)', 'area': None})
        rid = r['reportId']
        print('   filed sample urgent report', rid, '- waiting for the alarm to escalate it', flush=True)
        t0 = time.time()
        while time.time() - t0 < 22 * 60:
            time.sleep(60)
            log = state['mgr'].call('notifications.log')
            esc = [n for n in log if n['ref'] == rid and n['subject'].startswith('ESCALATION')]
            if esc:
                return {'report': rid, 'escalationsQueued': len(esc), 'minutesWaited': round((time.time() - t0) / 60, 1),
                        'firstEscalationAt': min(n['created_at'] for n in esc)}
        raise AssertionError('no escalation within 22 minutes: the alarm may not be running')
    check('L10 scheduler runs on its own in Cloudflare (urgent report escalates when unacknowledged)', scheduler)

    out = pathlib.Path(__file__).with_name('live-check-results.json')
    out.write_text(json.dumps({'base': BASE, 'ranAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'results': RESULTS}, indent=2))
    ok = sum(r['ok'] for r in RESULTS)
    print(f'{ok}/{len(RESULTS)} live checks passed')
    sys.exit(0 if ok == len(RESULTS) else 1)


if __name__ == '__main__':
    main()
