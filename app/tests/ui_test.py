"""R1.2 browser acceptance tests (Playwright + Chromium + axe-core).

Each test starts its own prototype server (fresh synthetic seed), so state
never leaks between tests. Writes tests/ui-results.json and screenshots to
tests/screens/.

Run:  python3 tests/ui_test.py            (Node server)
      HUB_BASE=http://127.0.0.1:8787/ python3 tests/ui_test.py   (an already
      running server, e.g. `wrangler dev`; tests then share one state and the
      per-test reset endpoint /api/dev/reset is used)
"""
import json, os, re, subprocess, sys, time, socket, traceback, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
AXE = (ROOT / 'tests' / 'vendor' / 'axe.min.js').read_text()
SHOTS = ROOT / 'tests' / 'screens'
SHOTS.mkdir(exist_ok=True)
RESULTS = []
PAGES = []
LAST_TOTP = {}
EXTERNAL = os.environ.get('HUB_BASE')
ONLY = set(sys.argv[1:])

PHONE = {'width': 390, 'height': 844}
TABLET = {'width': 820, 'height': 1180}
NARROW = {'width': 320, 'height': 640}


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def http(base, method, path, body=None):
    req = urllib.request.Request(base.rstrip('/') + path, method=method, data=json.dumps(body or {}).encode() if method == 'POST' else None,
                                 headers={'Content-Type': 'application/json', 'X-Hub-Request': '1'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


class Server:
    def __enter__(self):
        if EXTERNAL:
            self.base = EXTERNAL
            http(self.base, 'POST', '/api/dev/reset', {})
            return self
        self.port = free_port()
        self.proc = subprocess.Popen(['node', '--no-warnings', 'server/server.js'], cwd=ROOT,
                                     env={**os.environ, 'PORT': str(self.port), 'HUB_DEV_RESET': '1'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.base = f'http://127.0.0.1:{self.port}/'
        for _ in range(240):
            try:
                urllib.request.urlopen(self.base + 'api/demo/status', timeout=1); break
            except Exception:
                time.sleep(0.25)
        return self

    def __exit__(self, *a):
        if not EXTERNAL:
            self.proc.terminate(); self.proc.wait()

    def person(self, eid):
        return next(p for p in http(self.base, 'GET', '/api/demo/people') if p['id'] == eid)




IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'


def new_page(browser, viewport, errors, user_agent=None):
    ctx = browser.new_context(viewport=viewport, accept_downloads=True, has_touch=viewport['width'] < 900, **({'user_agent': user_agent} if user_agent else {}))
    pg = ctx.new_page()
    PAGES.append(pg)
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    return ctx, pg


def login(pg, srv, eid, keypad=False, shared=True, pin=None):
    """Employee ID + PIN from any browser (no device registration). Management also gets the authenticator step."""
    pg.goto(srv.base + '#/login')
    pg.wait_for_selector('form[data-form=login]')
    p = srv.person(eid)
    pg.fill('input[name=employeeId]', eid)
    secret = pin or p['pin'] or p.get('tempPin')
    if keypad:
        for d in secret:
            pg.click(f'.keypad .key[data-key="{d}"][data-target="pin"]')
    else:
        pg.fill('#pin', secret)
    box = pg.locator('input[name=sharedDevice]')
    if box.is_checked() != shared:
        box.set_checked(shared)
    pg.click('form[data-form=login] button[type=submit]')
    if p.get('totp'):
        pg.wait_for_selector('input[name=totp]')
        code = srv.person(eid)['totp']
        while LAST_TOTP.get((srv.base, eid)) == code:   # codes are single-use (replay protection): wait for the next one
            time.sleep(1); code = srv.person(eid)['totp']
        LAST_TOTP[(srv.base, eid)] = code
        pg.fill('input[name=totp]', code)
        pg.click('form[data-form=login] button[type=submit]')
    pg.wait_for_selector('.topbar')
    pg.wait_for_selector('main h1')


def signout(pg):
    pg.click('.topbar [data-act=signout]')
    pg.wait_for_selector('.portal-public, .login-card')


def open_survey(pg):
    """Staff land on this week's survey right after sign-in; otherwise use the big button on Home."""
    if not pg.locator('#q-q1').count():
        if not pg.locator('.big-action.primary').count():
            pg.goto(pg.url.split('#')[0] + '#/home'); pg.wait_for_selector('.big-actions')
        pg.click('.big-action.primary')
    pg.wait_for_selector('#q-q1')


def fill_survey(pg, pin, *, s1='', s2='', q4='no', keypad=False, comment='PRIVATE-COMMENT'):
    open_survey(pg)
    # One question per screen: tapping an answer moves on by itself.
    pg.click('label.opt:has(input[name=q1][value="4"])'); pg.wait_for_selector('#q-q2')
    pg.click('label.opt:has(input[name=q2][value="5"])'); pg.wait_for_selector('#q-q3')
    pg.click('label.opt:has(input[name=q3][value=yes])'); pg.wait_for_selector('#q-q4')
    pg.click(f'label.opt:has(input[name=q4][value={q4}])')
    pg.wait_for_selector('textarea[name=s1]')
    if s1: pg.fill('textarea[name=s1]', s1)
    if s2: pg.fill('textarea[name=s2]', s2)
    if comment: pg.fill('textarea[name=s3]', comment)
    pg.click('[data-act=survey-next]')
    pg.wait_for_selector('form[data-form=sign]')
    pg.check('input[name=affirm]')
    if keypad:
        for d in pin:
            pg.click(f'.keypad .key[data-key="{d}"][data-target="signpin"]')
    else:
        pg.fill('#signpin', pin)


def signoff(pg, srv, mgr_id):
    pg.check('form[data-form=signoff] input[name=affirm]')
    pg.fill('form[data-form=signoff] input[name=signPin]', srv.person(mgr_id)['pin'])
    pg.click('form[data-form=signoff] button[type=submit]')
    pg.wait_for_selector('text=Signed off.')


def axe(pg, label):
    if not pg.evaluate('typeof window.axe === "object"'):
        pg.evaluate(AXE + '\n;0')  # DevTools evaluation: the page CSP stays fully enforced
    res = pg.evaluate("""async () => { const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } });
        return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0] && v.nodes[0].target.join(' ') })); }""")
    assert not res, f'axe violations on {label}: {res}'
    return label


def no_hscroll(pg, label):
    w = pg.evaluate('document.documentElement.scrollWidth - window.innerWidth')
    assert w <= 1, f'horizontal scroll {w}px on {label}'


def shot(pg, name):
    pg.screenshot(path=str(SHOTS / f'{name}.png'), full_page=True)


def test(name):
    def deco(fn):
        def run(browser):
            if ONLY and name.split(' ')[0] not in ONLY:
                return
            errors, t0 = [], time.time()
            try:
                detail = fn(browser, errors)
                assert not errors, f'browser errors: {errors[:5]}'
                RESULTS.append({'name': name, 'ok': True, 'ms': int((time.time() - t0) * 1000), 'detail': detail})
                print(f'PASS {name}')
            except Exception as e:
                RESULTS.append({'name': name, 'ok': False, 'error': f'{type(e).__name__}: {e}', 'trace': traceback.format_exc()[-1500:]})
                print(f'FAIL {name}: {e}')
                try:
                    PAGES[-1].screenshot(path=str(SHOTS / f'FAIL-{name.split(" ")[0]}.png'), full_page=True)
                except Exception:
                    pass
        run.__name__ = name
        TESTS.append(run)
        return run
    return deco


TESTS = []


# ---------------------------------------------------------------------------
@test('U1 end-to-end success flow (shared tablet staff -> management review -> safety -> verification -> employee record)')
def t_e2e(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, TABLET, errors)
        jordan = srv.person('E-107')
        t0 = time.time()
        login(pg, srv, 'E-107', keypad=True, shared=True)
        assert '#/checkin/' in pg.url, 'staff land straight on the weekly survey'
        expect(pg.locator('.shared-strip')).to_contain_text('Jordan Demo')
        shot(pg, 'u1-01-tablet-lands-on-survey')
        fill_survey(pg, jordan['pin'], s1='UI-TEST coolant leaking under CNC 2', s2='UI-TEST waiting on foam inserts', keypad=True, comment='')
        expect(pg.locator('form[data-form=sign]')).to_contain_text('Signing as')
        expect(pg.locator('input[name=typedName]')).to_have_count(0)
        shot(pg, 'u1-02-tablet-sign')
        pg.click('button[data-submit]')
        pg.wait_for_selector('.success h1')
        elapsed = round(time.time() - t0, 1)
        expect(pg.locator('.sig-block')).to_contain_text('Jordan Demo')
        expect(pg.locator('.sig-block')).to_contain_text('Unchanged since signing')
        expect(pg.locator('#countdown')).to_be_visible()
        shot(pg, 'u1-03-tablet-confirmation')
        sub_id = pg.url.split('/record/')[1].split('?')[0]
        pg.click('.success [data-act=signout]')
        pg.wait_for_selector('.portal-public, .login-card')
        ctx.close(); ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-102', shared=False)
        assert '#/home' in pg.url, 'management land on their Home (owner 2026-10-27)'
        pg.goto(srv.base + '#/team?tab=awaiting'); pg.wait_for_selector('main h1')
        pg.click(f'a[href="#/record/{sub_id}"]')
        pg.wait_for_selector('#review-panel')
        expect(pg.locator('main')).to_contain_text('UI-TEST coolant')
        pg.click('#review-panel summary:has-text("Create a corrective action")')
        expect(pg.locator('#review-panel select[data-emp-select] option').first).to_be_attached()
        pg.fill('#review-panel form[data-form=ca] input[name=title]', 'UI-TEST order foam inserts earlier')
        pg.select_option('#review-panel form[data-form=ca] select[name=assignedTo]', 'E-102')
        pg.click('#review-panel form[data-form=ca] button[type=submit]')
        pg.wait_for_selector('text=Corrective actions from this report')
        pg.fill('form[data-form=signoff] textarea[name=comments]', 'UI-TEST thanks Jordan, safety contact has the coolant leak.')
        pg.click('form[data-form=signoff] label.opt:has(input[value=action_assigned])')
        signoff(pg, srv, 'E-102')
        expect(pg.locator('main')).to_contain_text('Closed — corrective action assigned')
        shot(pg, 'u1-04-management-signed')
        signout(pg)
        login(pg, srv, 'E-103', shared=False)
        pg.goto(srv.base + '#/safety?status=open'); pg.wait_for_selector('main h1')
        pg.click('a.safety-item:has-text("UI-TEST coolant")')
        pg.wait_for_selector('form[data-form=sack]')
        pg.fill('form[data-form=sack] input[name=note]', 'Put drip tray down, maintenance called')
        pg.click('form[data-form=sack] button[type=submit]')
        pg.wait_for_selector('summary:has-text("Propose the fix is done")')
        pg.click('summary:has-text("Propose the fix is done")')
        pg.fill('form[data-form=propose] textarea[name=resolution]', 'UI-TEST replaced coolant line fitting')
        pg.click('form[data-form=propose] button[type=submit]')
        pg.wait_for_selector('text=You proposed this fix')
        report_url = pg.url
        shot(pg, 'u1-05-safety-proposed')
        signout(pg)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(report_url); pg.wait_for_selector('form[data-form=sverify]')
        pg.fill('form[data-form=sverify] input[name=note]', 'Checked the line, dry')
        pg.click('form[data-form=sverify] button[value=close]')
        pg.wait_for_selector('text=Verified and closed')
        pg.goto(srv.base + '#/dash'); pg.wait_for_selector('#dash-table')
        expect(pg.locator('#dash-table')).to_contain_text('Jordan Demo')
        shot(pg, 'u1-06-dashboard')
        signout(pg)
        ctx.close(); ctx, pg = new_page(browser, PHONE, errors)
        login(pg, srv, 'E-107', shared=False)          # own phone, any browser
        pg.goto(srv.base + f'#/record/{sub_id}'); pg.wait_for_selector('.sig-block')
        expect(pg.locator('main')).to_contain_text('UI-TEST thanks Jordan')
        pg.click('[data-act=seen]')
        pg.wait_for_selector('.success-inline')
        with pg.expect_download() as dl:
            pg.click('[data-act=download][data-fmt=json]')
        data = json.loads(Path(dl.value.path()).read_text())
        sig = data['original']['payload']['signature']
        assert sig['signerName'] == 'Jordan Demo' and 'acknowledgment' in sig['method'] and 'typedName' not in sig
        assert any(a['answer'] == 4 for a in data['original']['payload']['answers'])
        pg.goto(srv.base + '#/safety'); pg.wait_for_selector('main h1')
        expect(pg.locator('main')).to_contain_text('Resolved')
        no_hscroll(pg, 'phone safety')
        shot(pg, 'u1-07-phone-record')
        ctx.close()
        return {'submission': sub_id, 'tabletSignInToSubmittedSeconds': elapsed}


@test('U2 shared tablet: auto sign-out after submit, idle sign-out, nothing private left behind')
def t_shared(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, TABLET, errors)
        jordan = srv.person('E-107')
        login(pg, srv, 'E-107', shared=True)
        fill_survey(pg, jordan['pin'], keypad=True)
        pg.click('button[data-submit]')
        pg.wait_for_selector('#countdown')
        pg.wait_for_selector('.portal-public, .login-card', timeout=26000)
        pg.goto(srv.base + '#/checkin')
        pg.wait_for_selector('.login-card')
        assert 'PRIVATE-COMMENT' not in pg.content()
        storage = pg.evaluate('JSON.stringify(localStorage) + JSON.stringify(sessionStorage)')
        assert 'PRIVATE' not in storage and 'hub_session' not in storage and len(storage) < 40, storage
        cookies = {c['name']: c for c in ctx.cookies()}
        assert 'hub_session' not in cookies or not cookies['hub_session']['value'], cookies
        r = pg.request.post(srv.base + 'api/call/survey.mine', headers={'X-Hub-Request': '1'}, data='{}')
        assert r.status == 401
        pg.clock.install()
        login(pg, srv, 'E-104', shared=True)
        pg.clock.run_for(4 * 60 * 1000 + 5000)
        expect(pg.locator('#idle')).to_be_visible()
        pg.clock.run_for(70 * 1000)
        pg.wait_for_selector('.portal-public, .login-card')
        ctx.close()
        return 'auto sign-out + idle sign-out verified'


@test('U3 Spanish employee on a 320px phone: full report, no horizontal scroll, axe clean')
def t_spanish(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, NARROW, errors)
        maria = srv.person('E-104')
        login(pg, srv, 'E-104', shared=False)
        assert pg.evaluate('document.documentElement.lang') == 'es'
        expect(pg.locator('#q-q1 legend')).to_contain_text('productividad')
        no_hscroll(pg, 'es step1'); axe(pg, 'es step1')
        shot(pg, 'u3-01-es-320-step1')
        pg.click('[data-act=survey-next]')
        expect(pg.locator('#err-q1')).to_be_visible()
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.big-actions')
        no_hscroll(pg, 'es home'); axe(pg, 'es home')
        shot(pg, 'u3-02-es-320-home')
        fill_survey(pg, maria['pin'], keypad=False)
        no_hscroll(pg, 'es sign'); axe(pg, 'es sign')
        pg.click('button[data-submit]')
        pg.wait_for_selector('.success h1')
        no_hscroll(pg, 'es confirmation'); axe(pg, 'es confirmation')
        pg.goto(srv.base + '#/safety/new'); pg.wait_for_selector('form[data-form=safety]')
        no_hscroll(pg, 'es safety'); axe(pg, 'es safety')
        ctx.close()
        return 'es @320px ok'


@test('U4 accessibility: axe on every main screen (light + dark), phone and tablet')
def t_axe(browser, errors):
    checked = []
    with Server() as srv:
        for vp_name, vp in [('phone', PHONE), ('tablet', TABLET)]:
            for scheme in ['light', 'dark']:
                ctx = browser.new_context(viewport=vp, color_scheme=scheme)
                pg = ctx.new_page(); PAGES.append(pg)
                pg.on('pageerror', lambda e: errors.append(str(e)))
                pg.goto(srv.base); pg.wait_for_selector('.portal-public')
                checked.append(axe(pg, f'open portal {vp_name} {scheme}'))
                pg.goto(srv.base + '#/login'); pg.wait_for_selector('.login-card')
                checked.append(axe(pg, f'login {vp_name} {scheme}'))
                login(pg, srv, 'E-101', shared=False)
                for h in ['#/dash', '#/dash?view=month', '#/dash?view=history', '#/team', '#/team?tab=missing', '#/safety', '#/actions', '#/safety/new',
                          '#/accounts', '#/alerts', '#/more', '#/admin', '#/admin?tab=delivery', '#/checkin']:
                    pg.goto(srv.base + h); pg.wait_for_selector('main h1'); pg.wait_for_timeout(150)
                    no_hscroll(pg, f'{h} {vp_name}')
                    checked.append(axe(pg, f'{h} {vp_name} {scheme}'))
                pg.goto(srv.base + '#/accounts'); pg.wait_for_selector('main h1')
                pg.click('#new-account summary'); checked.append(axe(pg, f'new account form {vp_name} {scheme}'))
                pg.goto(srv.base + '#/safety?status=all'); pg.wait_for_selector('main h1')
                pg.click('a.safety-item >> nth=0'); pg.wait_for_selector('text=Who was alerted')
                checked.append(axe(pg, f'safety detail {vp_name} {scheme}'))
                pg.goto(srv.base + '#/dash'); pg.wait_for_selector('#dash-table')
                pg.click('#dash-table a >> nth=0'); pg.wait_for_selector('.sig-block')
                checked.append(axe(pg, f'record {vp_name} {scheme}'))
                if vp_name == 'tablet' and scheme == 'light':
                    shot(pg, 'u4-record-management')
                signout(pg)
                login(pg, srv, 'E-106', shared=False)
                for h in ['#/home', '#/checkin', '#/safety', '#/more']:
                    pg.goto(srv.base + h); pg.wait_for_selector('main h1'); pg.wait_for_timeout(150)
                    no_hscroll(pg, f'staff {h} {vp_name}')
                    checked.append(axe(pg, f'staff {h} {vp_name} {scheme}'))
                if vp_name == 'phone' and scheme == 'light':
                    pg.goto(srv.base + '#/home'); pg.wait_for_selector('.big-actions'); shot(pg, 'u4-staff-home-phone')
                ctx.close()
    return f'{len(checked)} screen checks'


@test('U5 keyboard only: sign in, complete, sign and submit without a pointer')
def t_keyboard(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, TABLET, errors)
        pg.goto(srv.base + '#/login'); pg.wait_for_selector('form[data-form=login]')
        p = srv.person('E-105')
        pg.focus('input[name=employeeId]'); pg.keyboard.type('E-105')
        pg.keyboard.press('Tab'); pg.keyboard.type(p['pin']); pg.keyboard.press('Enter')
        pg.wait_for_selector('#q-q1')
        assert pg.evaluate("document.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex=\"-1\"])').className") == 'skip'
        def choose(name, value):
            pg.focus(f'input[name={name}] >> nth=0')
            pg.keyboard.press('Space')
            while pg.evaluate(f"document.querySelector('input[name={name}]:checked')?.value") != str(value):
                pg.keyboard.press('ArrowDown')
        choose('q1', 3)
        pg.focus('[data-act=survey-next]'); pg.keyboard.press('Enter')
        pg.wait_for_selector('#q-q2')
        for name, value, nxt in (('q2', 4, '#q-q3'), ('q3', 'no', '#q-q4'), ('q4', 'no', 'textarea[name=s1]')):
            choose(name, value)                       # keyboard: no automatic jump; Next moves on
            assert pg.locator(f'input[name={name}]').count(), 'keyboard choice must not skip ahead'
            pg.focus('[data-act=survey-next]'); pg.keyboard.press('Enter')
            pg.wait_for_selector(nxt)
        pg.focus('[data-act=survey-next]'); pg.keyboard.press('Enter')
        pg.wait_for_selector('form[data-form=sign]')
        pg.focus('input[name=affirm]'); pg.keyboard.press('Space')
        pg.keyboard.press('Tab'); pg.keyboard.type(p['pin'])
        pg.keyboard.press('Enter')
        pg.wait_for_selector('.success h1')
        assert pg.evaluate('document.activeElement.tagName') in ('H1', 'MAIN')
        ctx.close()
        return 'keyboard completion ok'


@test('U6 network failure during submit keeps the answers; retry is idempotent (one record)')
def t_network(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, PHONE, errors)
        p = srv.person('E-107')
        login(pg, srv, 'E-107', shared=False)
        fill_survey(pg, p['pin'], s2='UI-TEST obstacle')
        state = {'n': 0}

        def flaky(route):
            state['n'] += 1
            if state['n'] == 1:
                return route.abort('internetdisconnected')
            if state['n'] == 2:
                route.fetch(); return route.abort('connectionreset')
            return route.continue_()
        pg.route('**/api/call/survey.submit', flaky)

        def attempt(n):
            pg.click('button[data-submit]')
            while state['n'] < n:
                pg.wait_for_timeout(50)
        attempt(1)
        expect(pg.locator('button[data-submit]')).to_be_enabled()
        expect(pg.locator('form[data-form=sign] .alert')).to_be_visible()
        expect(pg.locator('dl.review')).to_contain_text('PRIVATE-COMMENT')
        assert pg.is_checked('input[name=affirm]')
        assert pg.input_value('#signpin') == ''
        pg.fill('#signpin', p['pin'])
        attempt(2)
        expect(pg.locator('button[data-submit]')).to_be_enabled()
        expect(pg.locator('form[data-form=sign] .alert')).to_be_visible()
        pg.fill('#signpin', p['pin'])
        attempt(3)
        pg.wait_for_selector('.success h1')
        assert state['n'] == 3
        mine = pg.evaluate("fetch('/api/call/survey.mine',{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Request':'1'},body:'{}'}).then(r=>r.json())")
        weeks = [m['weekId'] for m in mine if m.get('submissionId')]
        assert len(weeks) == len(set(weeks)), weeks
        ctx.close()
        return {'attempts': state['n']}


@test('U7 temporary PIN first sign-in, PIN change, and wrong-PIN lockout message')
def t_setup(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, PHONE, errors)
        nina = srv.person('E-110')
        assert re.fullmatch(r'\d{8}', nina['tempPin'])
        pg.goto(srv.base + '#/login'); pg.wait_for_selector('form[data-form=login]')
        pg.fill('input[name=employeeId]', 'E-110'); pg.fill('#pin', nina['tempPin'])     # temporary PIN goes in the normal PIN field
        pg.locator('input[name=sharedDevice]').set_checked(False)
        pg.click('form[data-form=login] button[type=submit]')
        pg.wait_for_selector('form[data-form=setpin]')
        axe(pg, 'set PIN')
        pg.fill('#np', '123456'); pg.fill('#cp', '123456'); pg.click('form[data-form=setpin] button[type=submit]')
        expect(pg.locator('.alert')).to_be_visible()
        pg.fill('#np', '73024185'); pg.fill('#cp', '73024185'); pg.click('form[data-form=setpin] button[type=submit]')
        pg.wait_for_selector('.big-actions')      # her first week is a partial week, so she lands on Home
        signout(pg)
        login(pg, srv, 'E-110', pin='73024185', shared=False)      # the new PIN works
        signout(pg)
        pg.goto(srv.base + '#/login'); pg.wait_for_selector('form[data-form=login]')
        for i in range(5):
            pg.fill('input[name=employeeId]', 'E-108'); pg.fill('#pin', '000000')
            with pg.expect_response('**/api/login'):
                pg.click('form[data-form=login] button[type=submit]')
            pg.wait_for_selector('.alert')
        txt = pg.inner_text('.alert')
        assert re.search(r'too many|demasiad|15', txt, re.I), txt
        ctx.close()
        return 'temporary PIN + lockout ok'


@test('U8 clarification loop: employee answers the question, management signs off, employee marks it seen')
def t_clarify(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-104', shared=True)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.big-actions')
        pg.click('a.todo.urgent[href^="#/record/"]')
        pg.wait_for_selector('form[data-form=respond]')
        sub = pg.url.split('/record/')[1].split('?')[0]
        pg.fill('form[data-form=respond] >> nth=0 >> textarea', 'UI-TEST fue el lunes, ya está bien')
        pg.click('form[data-form=respond] >> nth=0 >> button[type=submit]')
        pg.wait_for_selector('.timeline')
        expect(pg.locator('.timeline')).to_contain_text('UI-TEST fue el lunes')
        signout(pg)
        login(pg, srv, 'E-102', shared=False)
        pg.goto(srv.base + '#/team?tab=needsResponse'); pg.wait_for_selector('main h1')
        pg.click('a.link-row:has-text("Maria Sample")')
        pg.wait_for_selector('form[data-form=signoff]')
        signoff(pg, srv, 'E-102')
        signout(pg)
        login(pg, srv, 'E-104', shared=True)
        pg.goto(srv.base + '#/record/' + sub); pg.wait_for_selector('.seen-box')
        expect(pg.locator('.seen-box')).to_contain_text('no significa')
        pg.click('[data-act=seen]'); pg.wait_for_selector('.success-inline')
        ctx.close()
        return 'clarification loop ok'


@test('U9 management adds an employee; the new person signs in on a phone with the temporary PIN, sets a PIN and signs the survey')
def t_accounts(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + '#/accounts'); pg.wait_for_selector('main h1')
        pg.click('#new-account summary')
        pg.fill('form[data-form=acreate] input[name=name]', 'Uma Newstart')
        pg.fill('form[data-form=acreate] input[name=startDate]', '2026-10-01')
        pg.select_option('form[data-form=acreate] select[name=reportsTo]', 'E-102')
        pg.click('form[data-form=acreate] button[type=submit]')
        pg.wait_for_selector('.acct-out .code')
        temp = pg.inner_text('.acct-out .code').strip()
        assert re.fullmatch(r'\d{8}', temp), temp
        new_id = pg.locator('.acct-out .code').locator('xpath=ancestor::article').get_attribute('id').replace('acct-', '')
        shot(pg, 'u9-01-account-created')
        pg.fill('form[data-form=regdevice] input[name=label]', 'UI-TEST tablet')      # optional shop-tablet registration
        pg.click('form[data-form=regdevice] button[type=submit]')
        expect(pg.locator('#tablets')).to_contain_text('UI-TEST tablet')
        signout(pg)
        ctx.close(); ctx, pg = new_page(browser, PHONE, errors)
        t0 = time.time()
        pg.goto(srv.base + '#/login'); pg.wait_for_selector('form[data-form=login]')
        pg.fill('input[name=employeeId]', new_id); pg.fill('#pin', temp)
        pg.locator('input[name=sharedDevice]').set_checked(False)
        pg.click('form[data-form=login] button[type=submit]')
        pg.wait_for_selector('form[data-form=setpin]')
        pg.fill('#np', '58302719'); pg.fill('#cp', '58302719'); pg.click('form[data-form=setpin] button[type=submit]')
        pg.wait_for_selector('#q-q1')
        fill_survey(pg, '58302719', comment='')
        expect(pg.locator('form[data-form=sign]')).to_contain_text('agree to sign electronically')
        expect(pg.locator('.consent-text')).to_contain_text('Choosing paper will not affect your job')   # the exact versioned consent text
        expect(pg.locator('.consent-text')).to_contain_text('esign-consent-2')
        pg.click('button[data-submit]')
        pg.wait_for_selector('.success h1')
        secs = round(time.time() - t0, 1)
        shot(pg, 'u9-02-new-person-signed')
        ctx.close()
        return {'newEmployeeId': new_id, 'firstSignInToSignedSeconds': secs}


@test('U10 outside work hours: the weekly report waits for the next shift; safety reports still work')
def t_closed(browser, errors):
    with Server() as srv:
        http(srv.base, 'POST', '/api/dev/tick', {'advanceMinutes': 360})      # Friday 10:30 -> 16:30, after the shift
        ctx, pg = new_page(browser, PHONE, errors)
        login(pg, srv, 'E-107', shared=False)
        pg.wait_for_selector('.big-action.waiting')
        assert '#/home' in pg.url
        expect(pg.locator('.big-action.waiting')).to_contain_text('Available during work hours'); expect(pg.locator('.big-action.waiting')).to_contain_text(' in ')
        no_hscroll(pg, 'closed home'); axe(pg, 'closed home')
        shot(pg, 'u10-01-after-hours-home')
        pg.goto(srv.base + '#/checkin'); pg.wait_for_selector('main h1')
        pg.click('a.btn.primary[href^="#/checkin/"]') if pg.locator('a.btn.primary[href^="#/checkin/"]').count() else None
        pg.wait_for_selector('.closed-note')
        expect(pg.locator('.closed-note')).to_contain_text('paid time')
        expect(pg.locator('form[data-form=survey-step]')).to_have_count(0)
        pg.goto(srv.base + '#/safety/new'); pg.wait_for_selector('form[data-form=safety]')
        pg.click('label.opt:has(input[name=type][value=hazard])')
        pg.fill('textarea[name=description]', 'UI-TEST after-hours hazard')
        pg.click('form[data-form=safety] button[type=submit]')
        pg.wait_for_selector('.success h1')
        ctx.close()
        return 'closed window + safety report ok'



@test('U11 full-access manager: Restore & backup page; backup downloads a complete copy without sign-in secrets')
def t_restore_backup(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + '#/admin?tab=restore'); pg.wait_for_selector('button[data-act=backup]')
        on_cloudflare = pg.locator('form[data-form=restore]').count() == 1
        if not on_cloudflare:
            expect(pg.locator('.alert-soft')).to_contain_text('only on Cloudflare')
        axe(pg, 'restore page'); no_hscroll(pg, 'restore page')
        shot(pg, 'u11-01-restore-backup')
        with pg.expect_download() as d:
            pg.click('button[data-act=backup]')
        path = d.value.path()
        body = open(path, encoding='utf-8').read()
        b = json.loads(body)
        assert b['format'] == 'tag-employee-hub-backup-1' and b['counts']['survey_submissions'] > 0
        assert 'pin_hash' not in body and 'totp_secret' not in body and 'enc1:' not in body
        expect(pg.locator('#backup-out')).to_contain_text('signed reports')
        ctx.close()
        # Management without full access does not get the page.
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-102', shared=False)
        pg.goto(srv.base + '#/admin?tab=restore'); pg.wait_for_selector('nav.subtabs')
        expect(pg.locator('nav.subtabs a[href="#/admin?tab=restore"]')).to_have_count(0)
        expect(pg.locator('button[data-act=backup]')).to_have_count(0)
        ctx.close()
        return {'restoreForm': 'shown (Cloudflare runtime)' if on_cloudflare else 'unavailable note (Node)', 'backupSubmissions': b['counts']['survey_submissions']}


def quick_answer_all(pg):
    """Open-portal report: answer every question with the first option, then go to the sign step."""
    for _ in range(10):
        pg.wait_for_selector('form[data-form=survey-step], form[data-form=qsign]')
        if pg.locator('form[data-form=qsign]').count():
            return
        before = pg.inner_text('.stepper')
        if pg.locator('form.one-q').count():
            pg.locator('form.one-q label.opt').last.click()   # last option: lowest rating / "No"; moves on by itself
        else:
            pg.click('[data-act=survey-next]')
        pg.wait_for_function('b => (document.querySelector(".stepper") || {}).innerText !== b || !!document.querySelector("form[data-form=qsign]")', arg=before)
    raise AssertionError('did not reach the sign step')


@test('U12 open portal: no sign-in screen; the weekly report asks for the PIN once, at signing; phone remembers the ID; shop tablet shows names')
def t_open_portal(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, PHONE, errors)
        pg.goto(srv.base); pg.wait_for_selector('.portal-public')
        names = [srv.person(e)['name'] for e in ('E-104', 'E-107')]
        # (the demo copy lists its invented people in a labelled demo panel; production has no such panel)
        outside_demo = pg.evaluate("(() => { const c = document.querySelector('.portal-public').cloneNode(true); c.querySelectorAll('.demo-panel').forEach(d => d.remove()); return c.innerText; })()")
        assert not any(n in outside_demo for n in names), 'portal must not list employees on the open web'
        axe(pg, 'open portal'); no_hscroll(pg, 'open portal'); shot(pg, 'u12-01-open-portal')
        # Weekly report: ID -> questions -> PIN once.
        pg.click('a.big-action.primary'); pg.wait_for_selector('form[data-form=who]')
        pg.fill('input[name=employeeId]', 'e-107'); pg.click('form[data-form=who] button[type=submit]')
        quick_answer_all(pg)
        axe(pg, 'quick sign step'); shot(pg, 'u12-02-quick-sign')
        jordan = srv.person('E-107')
        # Wrong PIN: refused, nothing signed, the person can try again.
        pg.check('form[data-form=qsign] input[name=affirm]'); pg.fill('#signpin', '000000'); pg.click('button[data-submit]')
        pg.wait_for_selector('form[data-form=qsign] .alert')
        assert '#/record/' not in pg.url
        pg.check('form[data-form=qsign] input[name=affirm]')
        for d in jordan['pin']:
            pg.click(f'.keypad .key[data-key="{d}"][data-target="signpin"]')
        pg.click('button[data-submit]')
        pg.wait_for_url('**/#/record/**', timeout=15000)
        pg.wait_for_selector('.sig-block')
        expect(pg.locator('.sig-block')).to_contain_text(jordan['name'])
        expect(pg.locator('.sig-block')).to_contain_text('Unchanged since signing')
        assert pg.evaluate("localStorage.getItem('hub_last_id')") == 'E-107'
        # Signed in only for this report on a shared basis: signing out returns to the open portal.
        pg.click('.topbar [data-act=signout]'); pg.wait_for_selector('.portal-public')
        r = pg.request.post(srv.base + 'api/call/survey.mine', headers={'X-Hub-Request': '1'}, data='{}')
        assert r.status == 401
        # Next time the phone already knows the ID.
        pg.goto(srv.base + '#/r'); pg.wait_for_selector('form[data-form=who]')
        assert pg.input_value('input[name=employeeId]') == 'E-107'
        ctx.close()
        # Registered shop tablet: tap your name instead of typing an ID.
        ctx, pg = new_page(browser, TABLET, errors)
        pg.goto(srv.base); pg.wait_for_selector('.portal-public')
        rr = pg.request.post(srv.base + 'api/demo/kiosk', headers={'X-Hub-Request': '1'}, data=json.dumps({'on': True}))
        assert rr.status == 200, rr.status
        pg.goto(srv.base + '#/r'); pg.reload(); pg.wait_for_selector('.name-grid .name-btn')
        maria = srv.person('E-104')
        axe(pg, 'tablet name grid'); shot(pg, 'u12-03-tablet-names')
        pg.click(f'.name-btn[data-id="E-104"]')
        quick_answer_all(pg)
        expect(pg.locator('.signing-as')).to_contain_text(maria['name'])
        pg.check('form[data-form=qsign] input[name=affirm]'); pg.fill('#signpin', maria['pin']); pg.click('button[data-submit]')
        pg.wait_for_url('**/#/record/**', timeout=15000)
        expect(pg.locator('#countdown')).to_be_visible()       # shared tablet: signs itself out
        assert pg.evaluate("localStorage.getItem('hub_last_id')") is None, 'tablets must not remember who signed last'
        ctx.close()
        return 'phone (typed ID, remembered) and shop tablet (name grid) both sign with one PIN entry'

def virtual_authenticator(ctx, pg):
    """Chromium's built-in virtual authenticator: a phone with Face ID that always approves."""
    cdp = ctx.new_cdp_session(pg)
    cdp.send('WebAuthn.enable', {'enableUI': False})
    a = cdp.send('WebAuthn.addVirtualAuthenticator', {'options': {'protocol': 'ctap2', 'transport': 'internal', 'hasResidentKey': True,
                                                                   'hasUserVerification': True, 'isUserVerified': True, 'automaticPresenceSimulation': True}})
    return cdp, a['authenticatorId']


class LocalhostView:
    """Passkeys need a real host name (not 127.0.0.1): same server, opened as http://localhost."""
    def __init__(self, srv):
        self.srv = srv; self.base = srv.base.replace('127.0.0.1', 'localhost')

    def person(self, eid):
        return self.srv.person(eid)


@test('U13 Face ID: offered after signing with the PIN; portal greets the person and signs in with Face ID; the weekly report is signed with Face ID (no PIN); More lists phones; management removes them')
def t_passkeys(browser, errors):
    with Server() as srv0:
        if EXTERNAL and '127.0.0.1' not in srv0.base and 'localhost' not in srv0.base:
            return 'skipped: needs a local server'
        srv = LocalhostView(srv0)
        # --- Jordan: PIN signing on his iPhone, then the offer
        ctx, pg = new_page(browser, PHONE, errors, user_agent=IPHONE_UA)
        cdp, auth = virtual_authenticator(ctx, pg)
        jordan = srv.person('E-107')
        pg.goto(srv.base + '#/r'); pg.wait_for_selector('form[data-form=who]')
        pg.fill('input[name=employeeId]', 'E-107'); pg.click('form[data-form=who] button[type=submit]')
        quick_answer_all(pg)
        expect(pg.locator('[data-act=pk-sign]')).to_have_count(0)        # nothing set up yet: PIN form
        pg.check('form[data-form=qsign] input[name=affirm]'); pg.fill('#signpin', jordan['pin']); pg.click('button[data-submit]')
        pg.wait_for_url('**/#/record/**', timeout=15000)
        pg.wait_for_selector('#pk-offer')
        axe(pg, 'face id offer'); no_hscroll(pg, 'face id offer'); shot(pg, 'u13-01-offer')
        expect(pg.locator('#pk-offer')).to_contain_text('Face ID')
        # Step 1: PIN again (a wrong PIN is refused), step 2: approve with Face ID
        pg.fill('#pk-setup input[name=signPin]', '000000'); pg.click('#pk-setup form button[type=submit]')
        expect(pg.locator('#pk-setup .pk-out')).to_contain_text('PIN')
        pg.fill('#pk-setup input[name=signPin]', jordan['pin']); pg.click('#pk-setup form button[type=submit]')
        pg.click('#pk-setup [data-act=pk-create]')
        pg.wait_for_selector('#pk-offer .success-inline')
        hint = json.loads(pg.evaluate("localStorage.getItem('hub_pk')"))
        assert hint['id'] == 'E-107', hint
        creds = cdp.send('WebAuthn.getCredentials', {'authenticatorId': auth})['credentials']
        assert len(creds) == 1 and creds[0]['isResidentCredential'], creds
        expect(pg.locator('#countdown')).to_have_count(0)                 # own phone: no auto sign-out countdown
        signout(pg)
        # Portal greets him; one tap signs in (no ID, no PIN)
        pg.wait_for_selector('.pk-card'); expect(pg.locator('.pk-card')).to_contain_text(jordan['name'])
        axe(pg, 'portal with face id'); shot(pg, 'u13-02-portal-greeting')
        pg.click('.pk-card [data-act=pk-login]')
        pg.wait_for_selector('.portal-public', state='detached'); pg.wait_for_selector('main h1')
        expect(pg.locator('main h1')).to_contain_text(jordan['name'].split()[0])
        r = pg.request.post(srv.base + 'api/call/session.me', headers={'X-Hub-Request': '1'}, data='{}')
        me = r.json(); assert me.get('employee', {}).get('id') == 'E-107' and me['sharedDevice'] is False, (me, pg.url, pg.inner_text('main')[:300])
        signout(pg)
        ctx.close()

        # --- Maria: sets up Face ID under More, then signs this week's report with Face ID only
        ctx, pg = new_page(browser, PHONE, errors, user_agent=IPHONE_UA)
        cdp, auth = virtual_authenticator(ctx, pg)
        maria = srv.person('E-104')
        # Signed in as a shared device: the page says why Face ID can't be added and offers to sign in again
        login(pg, srv, 'E-104', shared=True)
        pg.goto(srv.base + '#/more'); pg.wait_for_selector('#pk-list [data-act=pk-relogin]')
        expect(pg.locator('#pk-list details.pk-add')).to_have_count(0)
        pg.click('[data-act=pk-relogin]'); pg.wait_for_selector('form[data-form=login]')
        assert not pg.locator('input[name=sharedDevice]').is_checked(), 'shared box unticked after "sign in again as my own phone"'
        login(pg, srv, 'E-104', shared=False)
        pg.goto(srv.base + '#/more'); pg.wait_for_selector('#pk-list details.pk-add')
        pg.click('#pk-list details.pk-add summary')
        pg.fill('#pk-setup input[name=signPin]', maria['pin']); pg.click('#pk-setup form button[type=submit]')
        pg.click('#pk-setup [data-act=pk-create]')
        pg.wait_for_selector('#pk-list li')
        axe(pg, 'more face id'); shot(pg, 'u13-03-more-phones')
        signout(pg)
        pg.goto(srv.base + '#/r')
        quick_answer_all(pg)                                              # "who are you" skipped: the phone knows her
        expect(pg.locator('.signing-as')).to_contain_text(maria['name'])
        expect(pg.locator('#signpin')).to_have_count(0)
        axe(pg, 'sign with face id'); shot(pg, 'u13-04-sign-with-face-id')
        pg.click('[data-act=pk-sign]')                                     # box not ticked yet: refused
        pg.wait_for_selector('form[data-form=qsign] .alert')
        assert '#/record/' not in pg.url
        pg.check('form[data-form=qsign] input[name=affirm]')
        pg.click('[data-act=pk-sign]')
        pg.wait_for_url('**/#/record/**', timeout=15000)
        pg.wait_for_selector('.sig-block')
        expect(pg.locator('.sig-block')).to_contain_text('passkey')
        expect(pg.locator('.sig-block')).to_contain_text(maria['name'])
        expect(pg.locator('#pk-offer')).to_have_count(0)                  # already set up: no offer
        shot(pg, 'u13-05-signed-with-face-id')
        # "Use my PIN instead" is always there
        ctx2, pg2 = new_page(browser, PHONE, errors, user_agent=IPHONE_UA)
        cdp2, auth2 = virtual_authenticator(ctx2, pg2)
        pg2.goto(srv.base); pg2.evaluate("localStorage.setItem('hub_pk', JSON.stringify({id:'E-106', name:'Kim Testwell'}))")
        pg2.goto(srv.base + '#/r'); pg2.reload()
        quick_answer_all(pg2)
        pg2.click('[data-act=pk-usepin]'); pg2.wait_for_selector('#signpin')
        ctx2.close()

        # --- Management sees the phone and removes it (lost phone)
        ctx3, pg3 = new_page(browser, TABLET, errors)
        login(pg3, srv, 'E-101', shared=False)
        pg3.goto(srv.base + '#/accounts'); pg3.wait_for_selector('#acct-E-104')
        expect(pg3.locator('#acct-E-104')).to_contain_text('Face ID on 1 phone')
        pg3.click('#acct-E-104 form[data-form=pkremoveall] button')
        expect(pg3.locator('#acct-E-104 .acct-out')).to_contain_text('Removed 1 phone')
        ctx3.close()
        # Maria's phone: Face ID no longer works; she is told to use the PIN
        pg.goto(srv.base + '#/home'); pg.reload(); pg.wait_for_selector('.pk-card')
        pg.click('.pk-card [data-act=pk-login]')
        pg.wait_for_selector('.portal-public .alert')
        expect(pg.locator('.portal-public .alert')).to_contain_text('PIN')
        assert pg.evaluate("localStorage.getItem('hub_pk')") is None
        ctx.close()
        return 'offer after PIN signing, portal Face ID sign-in, report signed with Face ID (record says passkey), PIN fallback, removal by management'


@test('U14 everyday polish: no browser translation; home-screen tip on phones; My weekly reports card; calmer badges; reminders on More; Admin switch')
def t_polish(browser, errors):
    with Server() as srv:
        # Phone, signed out: the page asks browsers not to machine-translate it; the home-screen tip shows once.
        ctx, pg = new_page(browser, PHONE, errors, user_agent=IPHONE_UA)
        pg.goto(srv.base); pg.wait_for_selector('.portal-public')
        assert pg.evaluate("document.documentElement.getAttribute('translate')") == 'no'
        assert pg.evaluate("document.querySelector('meta[name=google]').content") == 'notranslate'
        assert pg.evaluate("document.querySelector('link[rel=manifest]').href").endswith('/manifest.webmanifest')
        r = pg.request.get(srv.base + 'manifest.webmanifest'); assert r.status == 200 and r.json()['display'] == 'standalone'
        assert pg.request.get(srv.base + 'icon-192.png').status == 200 and pg.request.get(srv.base + 'sw.js').status == 200
        pg.wait_for_selector('.install-tip'); expect(pg.locator('.install-tip')).to_contain_text('Add to Home Screen')
        axe(pg, 'install tip'); shot(pg, 'u14-01-install-tip')
        pg.click('[data-act=install-later]'); expect(pg.locator('.install-tip')).to_have_count(0)
        pg.reload(); pg.wait_for_selector('.portal-public'); expect(pg.locator('.install-tip')).to_have_count(0)
        # Staff home: My weekly reports card, no count badge.
        login(pg, srv, 'E-106', shared=False)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.my-week')
        expect(pg.locator('.my-week')).to_contain_text('Signed')
        expect(pg.locator('.my-week')).to_contain_text('review')
        expect(pg.locator('.tabbar .badge')).to_have_count(0)
        axe(pg, 'home my week'); no_hscroll(pg, 'home my week'); shot(pg, 'u14-02-my-week')
        pg.goto(srv.base + '#/more'); pg.wait_for_selector('#rem-section')
        expect(pg.locator('#rem-box')).not_to_contain_text('Loading')
        shot(pg, 'u14-03-reminders')
        ctx.close()
        # Full access: Admin → Reminders switch (off by default), management keeps the badge.
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + '#/admin?tab=reminders'); pg.wait_for_selector('[data-act=push-switch]')
        expect(pg.locator('main')).to_contain_text('Reminders are OFF')
        axe(pg, 'admin reminders')
        pg.click('[data-act=push-switch]'); pg.wait_for_selector('text=Reminders are ON')
        pg.click('[data-act=push-switch]'); pg.wait_for_selector('text=Reminders are OFF')
        ctx.close()
        return 'translate off, manifest/icons/worker served, install tip + dismiss, My week card, no staff badge, reminders section, admin switch'


@test('U15 QuickBooks Time: full access links an account (suggestion needs a click); the person sees My hours on Home (sample hours in the test copy)')
def t_qbt(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + '#/admin?tab=qbt'); pg.wait_for_selector('form[data-form=qbtlink][data-id="E-104"]')
        expect(pg.locator('main')).to_contain_text('Sample data (test copy)')
        axe(pg, 'admin qbt'); shot(pg, 'u15-01-admin-qbt')
        expect(pg.locator('main')).to_contain_text('card for staff: OFF')
        pg.click('[data-act=qbt-show]'); pg.wait_for_selector('text=card for staff: ON')
        pg.wait_for_selector('form[data-form=qbtlink][data-id="E-104"]')
        pg.click('form[data-form=qbtlink][data-id="E-104"] button[name=suggest]')
        pg.wait_for_selector('form[data-form=qbtlink][data-id="E-104"] .success-inline')
        ctx.close()
        ctx, pg = new_page(browser, PHONE, errors)
        login(pg, srv, 'E-104', shared=False)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.my-hours')
        expect(pg.locator('.my-hours')).to_contain_text(re.compile('Sample hours|Horas de muestra'))   # Maria uses Spanish
        assert pg.locator('.hours-days li').count() == 7
        axe(pg, 'home my hours'); no_hscroll(pg, 'home my hours'); shot(pg, 'u15-02-my-hours')
        ctx.close()
        # Someone not linked sees no hours card.
        ctx, pg = new_page(browser, PHONE, errors)
        login(pg, srv, 'E-105', shared=False)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.my-week')
        pg.wait_for_timeout(500); expect(pg.locator('.my-hours')).to_have_count(0)
        ctx.close()
        return 'linking via suggestion, My hours card (7 days, sample label), hidden when not linked'


@test('U16 guided phone setup: Home card -> home-screen step (moving picture) -> Face ID step (PIN, then approve) -> reminders step -> all set')
def t_guide(browser, errors):
    with Server() as srv0:
        if EXTERNAL and '127.0.0.1' not in srv0.base and 'localhost' not in srv0.base:
            return 'skipped: needs a local server'
        srv = LocalhostView(srv0)
        ctx, pg = new_page(browser, PHONE, errors, user_agent=IPHONE_UA)
        virtual_authenticator(ctx, pg)
        maria = srv.person('E-104')
        login(pg, srv, 'E-104', shared=False)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.guide-card')
        shot(pg, 'u16-00-home-card')
        pg.click('.guide-card a.btn.primary')
        pg.wait_for_selector('.demo-phone.ios')
        expect(pg.locator('.guide .stepper')).to_contain_text('1')
        axe(pg, 'guide home step'); no_hscroll(pg, 'guide home step'); shot(pg, 'u16-01-home-step')
        pg.click('[data-act=gs-next]')
        pg.wait_for_selector('.demo-phone.face')
        axe(pg, 'guide faceid step'); shot(pg, 'u16-02-face-step')
        pg.fill('#pk-setup input[name=signPin]', maria['pin']); pg.click('#pk-setup form button[type=submit]')
        pg.click('#pk-setup [data-act=pk-create]')
        pg.wait_for_selector('.demo-phone.bell')
        axe(pg, 'guide reminders step'); shot(pg, 'u16-03-remind-step')
        pg.click('[data-act=gs-skip]')
        pg.wait_for_selector('.guide-done')
        expect(pg.locator('.guide-check')).to_contain_text('✓')
        shot(pg, 'u16-04-done')
        pg.click('[data-act=gs-finish]'); pg.wait_for_selector('.my-week')
        expect(pg.locator('.guide-card')).to_have_count(0)
        assert json.loads(pg.evaluate("localStorage.getItem('hub_pk')"))['id'] == 'E-104'
        ctx.close()
        return 'card -> 3 steps with moving pictures -> Face ID set up inside the guide -> all set; card gone afterwards'



@test('U17 onboarding email: manager adds a person with an email -> email preview (test copy sends nothing) -> link on a phone -> choose PIN -> guided setup; setup list updates')
def t_invite(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + '#/accounts'); pg.wait_for_selector('main h1')
        pg.click('#new-account summary')
        f = 'form[data-form=acreate] '
        pg.fill(f + 'input[name=name]', 'Uma Newstart')
        pg.fill(f + 'input[name=email]', 'uma.newstart@example.com')
        pg.select_option(f + 'select[name=reportsTo]', 'E-102')
        assert pg.locator(f + 'input[name=sendInvite]').is_checked()
        pg.click(f + 'button[type=submit]')
        pg.wait_for_selector('.acct-out .invite-box')
        expect(pg.locator('.acct-out .invite-box')).to_contain_text('no email was sent')
        frame = pg.frame_locator('.email-preview iframe')
        expect(frame.locator('a', has_text='Set up my account')).to_be_visible()
        pad = frame.locator('td[style*="padding:24px"]').first.evaluate("e => getComputedStyle(e).paddingTop")
        assert pad == '24px', 'the email\'s own styles apply in the preview: ' + pad
        link = pg.inner_text('.acct-out .invite-box .code').strip()
        assert re.search(r'/#/join/[a-f0-9]{64}$', link), link
        expect(pg.locator('.acct-out > details > summary')).to_contain_text('Backup: temporary PIN')
        axe(pg, 'invite result'); shot(pg, 'u17-01-invite-preview')
        new_id = pg.locator('.acct-out:has(.invite-box)').locator('xpath=ancestor::article').get_attribute('id').replace('acct-', '')
        phone, ph = new_page(browser, PHONE, errors, user_agent=IPHONE_UA)   # a new person's iPhone
        if not EXTERNAL or '127.0.0.1' in srv.base:
            virtual_authenticator(phone, ph); link = link.replace('127.0.0.1', 'localhost')
        ph.goto(link)
        ph.wait_for_selector('form[data-form=join]')
        assert ph.url.endswith('#/join'), 'the link code is taken out of the address bar: ' + ph.url
        expect(ph.locator('h1')).to_contain_text('Uma')
        axe(ph, 'join page'); no_hscroll(ph, 'join page'); shot(ph, 'u17-02-join')
        expect(ph.locator('.join-steps li')).to_have_count(3)                       # PIN, home screen, Face ID
        expect(ph.locator('.join-steps li.now')).to_contain_text('Choose a PIN')
        ph.fill('input[name=newPin]', '58302719'); ph.fill('input[name=confirmPin]', '58302710')
        expect(ph.locator('[data-ck=len]')).to_have_class(re.compile('ok'))
        expect(ph.locator('[data-ck=match]')).not_to_have_class(re.compile('ok'))
        ph.click('form[data-form=join] button[type=submit]')                        # caught on the phone, nothing sent
        expect(ph.locator('[data-ck=match]')).to_have_class(re.compile('miss'))
        expect(ph.locator('input[name=confirmPin]')).to_be_focused()
        ph.click('[data-act=join-show]'); expect(ph.locator('input[name=newPin]')).to_have_attribute('type', 'text')
        ph.fill('input[name=confirmPin]', '5830271a9')                              # letters are dropped
        expect(ph.locator('input[name=confirmPin]')).to_have_value('58302719')
        expect(ph.locator('[data-ck=match]')).to_have_class(re.compile('ok'))
        shot(ph, 'u17-02b-join-ready')
        ph.click('form[data-form=join] button[type=submit]')
        ph.wait_for_selector('.demo-phone.ios')   # step 1 of the guide: add to home screen, with the moving picture
        assert '#/getstarted' in ph.url
        expect(ph.locator('.guide .stepper')).to_contain_text('1')
        shot(ph, 'u17-03-guide')
        ph.click('[data-act=gs-next]'); ph.wait_for_selector('.demo-phone.face')
        shot(ph, 'u17-04-guide-faceid')
        ph.goto(link); ph.wait_for_selector('.join-card h1')
        expect(ph.locator('form[data-form=join]')).to_have_count(0)
        phone.close()
        pg.goto(srv.base + '#/home'); pg.goto(srv.base + '#/accounts'); pg.wait_for_selector('#acct-' + new_id)
        row = pg.locator('#acct-' + new_id + ' .setup-row')
        expect(row).to_contain_text('invite used')
        expect(row.locator('.setup-step.ok')).to_have_count(2)   # Invited, PIN
        ctx.close()
        return {'newEmployeeId': new_id, 'flow': 'add with email -> preview -> link -> PIN -> guided setup; link works once'}



@test('U18 InnerPoints: full access links a person in Admin -> InnerPoints (suggestion needs a click) -> the person sees My InnerPoints on Home')
def t_points(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + '#/admin?tab=ip'); pg.wait_for_selector('form[data-form=iplink]')
        expect(pg.locator('main')).to_contain_text('Sample points (test copy)')
        row = pg.locator('form[data-form=iplink][data-id=E-106]')
        row.locator('button[name=suggest]').click()
        pg.wait_for_selector('form[data-form=iplink][data-id=E-106] .success-inline')
        axe(pg, 'admin innerpoints'); shot(pg, 'u18-01-admin-link')
        ctx.close()
        ctx, pg = new_page(browser, PHONE, errors)
        login(pg, srv, 'E-106', shared=False)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.my-points .ip-big strong')
        expect(pg.locator('.my-points h2')).to_have_text('My InnerPoints')
        assert int(pg.inner_text('.my-points .ip-big strong').replace(',', '')) > 0
        expect(pg.locator('.my-points .ip-recent li').first).to_contain_text('+')
        box_pts = pg.locator('.my-points').bounding_box(); box_week = pg.locator('.my-week').bounding_box()
        assert box_pts['y'] < box_week['y'], 'points sit above My weekly reports'
        axe(pg, 'home with points'); no_hscroll(pg, 'home with points'); shot(pg, 'u18-02-home-points')
        ctx.close()
        ctx, pg = new_page(browser, PHONE, errors)
        login(pg, srv, 'E-107', shared=False)                       # not linked: no card, no error
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.my-week')
        pg.wait_for_timeout(800)
        expect(pg.locator('.my-points')).to_have_count(0)
        ctx.close()
        return 'linked by a click in Admin; card on Home above My weekly reports; unlinked people see nothing'



@test('U19 management Home: managers land on Home with their own report, a Your team summary and the way into the dashboard')
def t_mgr_home(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, PHONE, errors)
        login(pg, srv, 'E-102', shared=False)
        assert pg.url.endswith('#/home') or '#/checkin' in pg.url, pg.url
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.team-card .tiles')
        expect(pg.locator('nav.tabbar a[href="#/home"]')).to_be_visible()
        expect(pg.locator('.team-card h2')).to_have_text('Your team')
        expect(pg.locator('.big-actions')).to_be_visible()                          # their own weekly report + safety
        expect(pg.locator('.my-week')).to_be_visible()
        axe(pg, 'manager home'); no_hscroll(pg, 'manager home'); shot(pg, 'u19-01-manager-home')
        pg.click('.team-card a.btn.primary'); pg.wait_for_selector('main h1:has-text("Weekly completion")')
        ctx.close()
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.team-card')
        expect(pg.locator('.team-card')).to_contain_text('Everyone')
        pg.click('.team-card a[href="#/accounts"]'); pg.wait_for_selector('main h1:has-text("Employee accounts")')
        ctx.close()
        return 'managers: Home (own report, points, team summary) -> dashboard / accounts'



@test('U20 test copy: a full-access manager starts the sample data over from More (two taps); others cannot')
def t_demo_reset(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, PHONE, errors)
        login(pg, srv, 'E-104', shared=False)
        r = pg.request.post(srv.base + 'api/demo/reset', headers={'X-Hub-Request': '1'}, data='{}')
        assert r.status == 403, r.status
        ctx.close()
        http(srv.base, 'POST', '/api/dev/tick', {'advanceMinutes': 1440})           # the clock moves on a day
        ctx, pg = new_page(browser, PHONE, errors)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + '#/more'); pg.wait_for_selector('[data-act=demo-reset]')
        pg.click('[data-act=demo-reset]'); expect(pg.locator('[data-act=demo-reset]')).to_have_text('Tap again to start over')
        pg.click('[data-act=demo-reset]')
        pg.wait_for_selector('.portal-public, .login-card')
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.portal-hero')
        expect(pg.locator('.portal-hero')).to_contain_text('October 16')                 # back to the sample start
        ctx.close()
        return 'staff refused; full access resets with two taps; clock back to Oct 16'



@test('U21 company documents: staff see "Please read and sign" on Home, read the handbook and sign with the PIN; full access writes, previews and publishes a policy and sees who signed')
def t_docs(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, PHONE, errors)
        kim = srv.person('E-106')
        login(pg, srv, 'E-106', shared=False)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.attention a[href^="#/docs/"]')
        pg.click('.attention a[href^="#/docs/"]'); pg.wait_for_selector('article.doc h1')
        expect(pg.locator('article.doc h1')).to_contain_text('Sample Employee Handbook')
        expect(pg.locator('.doc-body h2').first).to_be_visible()
        axe(pg, 'document reader'); no_hscroll(pg, 'document reader'); shot(pg, 'u21-01-read')
        pg.click('form[data-form=docack] button[type=submit]')                      # no box, no PIN
        expect(pg.locator('form[data-form=docack] .alert')).to_be_visible()
        pg.check('form[data-form=docack] input[name=affirm]'); pg.fill('#docpin', kim['pin'])
        pg.click('form[data-form=docack] button[type=submit]')
        pg.wait_for_selector('.doc-signed'); shot(pg, 'u21-02-signed')
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.big-actions')
        expect(pg.locator('.attention a[href^="#/docs/"]')).to_have_count(0)
        ctx.close()
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + '#/docs'); pg.wait_for_selector('.doc-row')
        expect(pg.locator('.doc-row')).to_have_count(2)                           # published sample + draft
        pg.click('a[href="#/docs/edit/new"]'); pg.wait_for_selector('form[data-form=docsave]')
        pg.fill('input[name=titleEn]', 'Phones at work'); pg.fill('input[name=titleEs]', 'Telefonos en el trabajo')
        pg.fill('textarea[name=bodyEn]', '# Phones\n- Company apps are allowed on your own phone.\n- **Safety first.**')
        pg.click('form[data-form=docsave] button[type=submit]'); pg.wait_for_selector('[data-act=doc-publish]')
        axe(pg, 'document editor'); shot(pg, 'u21-03-editor')
        pg.click('[data-act=doc-publish]'); expect(pg.locator('[data-act=doc-publish]')).to_have_text('Tap again to publish')
        pg.click('[data-act=doc-publish]'); pg.wait_for_selector('article.doc h1:has-text("Phones at work")')
        expect(pg.locator('.doc-body li strong')).to_have_text('Safety first.')
        pg.click('a[href^="#/docs/status/"]'); pg.wait_for_selector('main h1:has-text("Who has signed")')
        expect(pg.locator('main')).to_contain_text('Not signed yet')
        shot(pg, 'u21-04-status')
        ctx.close()
        return 'Home to-do -> read -> sign with PIN; manager: new -> save -> publish (two taps) -> who signed'



@test('U22 time off: staff request from Home (workdays and the 60-day hint shown), the manager sees it on Home, approves with who-else-is-off shown, the person sees Approved; My time has the team calendar')
def t_timeoff(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, PHONE, errors)
        login(pg, srv, 'E-106', shared=False)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.my-time-card')
        pg.click('.my-time-card a[href="#/time/request"]'); pg.wait_for_selector('form[data-form=toreq]')
        pg.fill('input[name=startDate]', '2026-11-02'); pg.dispatch_event('input[name=startDate]', 'input')
        pg.fill('input[name=endDate]', '2026-11-04'); pg.dispatch_event('input[name=endDate]', 'input')
        expect(pg.locator('#to-hint')).to_contain_text('3 workdays')
        expect(pg.locator('#to-hint')).to_contain_text('60 days ahead')
        pg.fill('input[name=note]', 'Family wedding')
        axe(pg, 'time off request'); no_hscroll(pg, 'time off request'); shot(pg, 'u22-01-request')
        pg.click('form[data-form=toreq] button[type=submit]'); pg.wait_for_selector('main h1:has-text("My time")')
        expect(pg.locator('.to-item').first).to_contain_text('Waiting')
        ctx.close()
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-102', shared=False)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector('.attention a[href="#/time/team"]')
        pg.click('.attention a[href="#/time/team"]'); pg.wait_for_selector('.to-decide')
        card = pg.locator('.to-decide', has_text='Kim Testwell')
        expect(card).to_contain_text('Family wedding')
        axe(pg, 'time off approvals'); shot(pg, 'u22-02-approve')
        card.locator('button[value=approve]').click()
        pg.wait_for_function("() => !document.body.innerText.includes('Family wedding') || document.querySelectorAll('.to-decide').length === 0 || true")
        pg.wait_for_selector('h2:has-text("Approved and coming up")')
        expect(pg.locator('.card', has_text='Approved and coming up')).to_contain_text('Kim Testwell')
        ctx.close()
        ctx, pg = new_page(browser, PHONE, errors)
        login(pg, srv, 'E-106', shared=False)
        pg.goto(srv.base + '#/time?m=2026-11'); pg.wait_for_selector('.to-cal, .card h2:has-text("Team calendar")')
        expect(pg.locator('.to-item').first).to_contain_text('Approved')
        expect(pg.locator('.to-cal li.mine')).to_contain_text('Kim Testwell')
        shot(pg, 'u22-03-mytime')
        ctx.close()
        return 'request (3 workdays, 60-day hint) -> manager Home to-do -> approve -> Approved + calendar'



@test('U23 onboarding: a new hire who joins from the welcome link sees "Your first week" on Home; their supervisor gets a to-do and ticks the safety walk-through; the office ticks the I-9')
def t_onboard(browser, errors):
    with Server() as srv:
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + '#/accounts'); pg.wait_for_selector('main h1')
        pg.click('#new-account summary')
        f = 'form[data-form=acreate] '
        pg.fill(f + 'input[name=name]', 'Ona Firstweek'); pg.fill(f + 'input[name=email]', 'ona@example.com')
        pg.select_option(f + 'select[name=reportsTo]', 'E-102')
        pg.click(f + 'button[type=submit]'); pg.wait_for_selector('.acct-out .invite-box')
        link = pg.inner_text('.acct-out .invite-box .code').strip()
        new_id = pg.locator('.acct-out:has(.invite-box)').locator('xpath=ancestor::article').get_attribute('id').replace('acct-', '')
        ctx.close()
        ph_ctx, ph = new_page(browser, PHONE, errors)
        ph.goto(link); ph.wait_for_selector('form[data-form=join]')
        ph.fill('input[name=newPin]', '58302719'); ph.fill('input[name=confirmPin]', '58302719')
        ph.click('form[data-form=join] button[type=submit]'); ph.wait_for_selector('.guide')
        ph.goto(srv.base + '#/home'); ph.wait_for_selector('.ob-card')
        expect(ph.locator('.ob-card h2')).to_have_text('Your first week')
        expect(ph.locator('.ob-card')).to_contain_text('Finish your payroll setup in QuickBooks Workforce')
        expect(ph.locator('.ob-card')).not_to_contain_text('Form I-9 completed')                       # office items are not shown to her
        ph.locator('.ob-card [data-task=e_i9docs]').click(); ph.wait_for_selector('main h1')
        axe(ph, 'new hire home'); no_hscroll(ph, 'new hire home'); shot(ph, 'u23-01-first-week')
        ph_ctx.close()
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-102', shared=False)
        pg.goto(srv.base + '#/home'); pg.wait_for_selector(f'.attention a[href="#/onboard/{new_id}"]')
        pg.click(f'.attention a[href="#/onboard/{new_id}"]'); pg.wait_for_selector('.ob-list')
        expect(pg.locator('main h1')).to_have_text('Ona Firstweek')
        expect(pg.locator('[data-task=o_i9]')).to_have_count(0)                                       # office item: not Dana's
        pg.click('[data-task=s_safety][data-status=done]'); pg.wait_for_selector('.ob-item.done:has-text("Safety walk-through done")')
        axe(pg, 'onboarding checklist'); shot(pg, 'u23-02-checklist')
        ctx.close()
        ctx, pg = new_page(browser, TABLET, errors)
        login(pg, srv, 'E-101', shared=False)
        pg.goto(srv.base + f'#/onboard/{new_id}'); pg.wait_for_selector('.ob-list')
        pg.click('[data-task=o_i9][data-status=done]'); pg.wait_for_selector('.ob-item.done:has-text("Form I-9 completed")')
        expect(pg.locator('main')).to_contain_text('never in the Hub')
        ctx.close()
        return 'join -> Your first week; supervisor to-do -> safety walk-through; office -> I-9 tick'


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for t in TESTS:
            t(browser)
        browser.close()
    out = ROOT / 'tests' / ('ui-results-workers.json' if EXTERNAL else 'ui-results.json')
    out.write_text(json.dumps({'ranAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'base': EXTERNAL or 'node server/server.js', 'results': RESULTS}, indent=2))
    ok = sum(r['ok'] for r in RESULTS)
    print(f'{ok}/{len(RESULTS)} UI tests passed')
    sys.exit(0 if ok == len(RESULTS) else 1)
