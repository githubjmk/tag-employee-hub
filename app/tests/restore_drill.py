"""Restore drill against the deployed TEST COPY (sample data only).

    HUB_LIVE_BASE=https://tag-employee-hub-test.<account>.workers.dev python3 tests/restore_drill.py

1. Note the time T0, wait just over a minute, then add a sample account (the "mistake").
2. Restore to T0 as a full-access manager (PIN + authenticator code + RESTORE).
3. Check the sample account is gone and the restore is in the audit chain.
4. Undo the restore and check the sample account is back.
"""
import json, os, sys, time, uuid, pathlib
from datetime import datetime, timezone
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from live_check import Client, BASE  # noqa: E402

STEPS = []
LAST = {}


def step(name, detail):
    STEPS.append({'step': name, 'detail': detail}); print('OK  ', name, '-', detail, flush=True)


def people():
    s, _, b = Client().req('GET', '/api/demo/people'); assert s == 200, s
    return {p['id']: p for p in json.loads(b)}


def fresh_totp(eid):
    # Codes are single use: wait for the next 30-second code.
    for _ in range(40):
        code = people()[eid]['totp']
        if code != LAST.get(eid):
            LAST[eid] = code; return code
        time.sleep(2)
    raise AssertionError('no new authenticator code')


def manager():
    P = people()
    c = Client()
    s, _, b = c.req('POST', '/api/login', {'employeeId': 'E-101', 'pin': P['E-101']['pin'], 'totp': fresh_totp('E-101'), 'sharedDevice': False})
    assert s == 200, b
    return c, P['E-101']['pin']


def wait_back(c_factory, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(5)
        try:
            s, _, b = Client().req('GET', '/api/config')
            if s == 200:
                return round(time.time() - t0, 1)
        except Exception:
            pass
    raise AssertionError('Hub did not come back after the restore')


def ids(c):
    return {a['id'] for a in c.call('accounts.list')}


def main():
    c, pin = manager()
    st = c.call('admin.restoreStatus')
    assert st['available'], 'restore not available: is the RESTORE_LOG binding deployed?'
    step('restore available on the live copy', {'pastRestores': len(st['log'])})

    t0 = datetime.now(timezone.utc).replace(microsecond=0)
    step('noted T0', t0.isoformat())
    time.sleep(70)
    drill_id = 'DRILL-' + uuid.uuid4().hex[:6].upper()
    c.call('accounts.create', {'name': 'Restore Drill Sample', 'role': 'staff', 'employeeId': drill_id, 'startDate': '2026-10-01'})
    assert drill_id in ids(c)
    step('sample change made after T0', drill_id)

    r = c.call('admin.restore', {'toTime': t0.isoformat(), 'signPin': pin, 'totp': fresh_totp('E-101'), 'confirm': 'RESTORE'})
    step('restore requested', {'restoreId': r['restoreId'], 'bookmark': r.get('bookmark', '')[:20] + '…'})
    back = wait_back(None)
    step('Hub back after restart', f'{back} s')

    c, pin = manager()
    assert drill_id not in ids(c), 'sample account still present after restore'
    step('sample change is gone', drill_id + ' absent')
    a = c.call('audit.verify')
    assert a['ok'], a
    st = c.call('admin.restoreStatus')
    assert st['log'] and st['log'][0]['id'] == r['restoreId'], st['log'][:1]
    step('restore logged and audit chain verifies', {'auditEvents': a['auditEvents'], 'latestRestore': st['log'][0]['id']})

    u = c.call('admin.restore', {'undoId': r['restoreId'], 'signPin': pin, 'totp': fresh_totp('E-101'), 'confirm': 'RESTORE'})
    step('undo requested', u['restoreId'])
    back = wait_back(None)
    c, pin = manager()
    assert drill_id in ids(c), 'sample account not back after undo'
    a = c.call('audit.verify'); assert a['ok'], a
    st = c.call('admin.restoreStatus')
    step('undo worked: sample change is back; chain verifies', {'restartSeconds': back, 'restoresLogged': [x['id'] for x in st['log'][:2]]})

    out = pathlib.Path(__file__).with_name('restore-drill-results.json')
    out.write_text(json.dumps({'base': BASE, 'ranAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'steps': STEPS}, indent=2))
    print('Restore drill passed')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('FAIL', type(e).__name__, e); sys.exit(1)
