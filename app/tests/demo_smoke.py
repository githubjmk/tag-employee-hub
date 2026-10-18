"""Smoke test for the single-file R1.1 browser demo.
Usage: python3 tests/demo_smoke.py <path to sql.js 1.10.3 sql-wasm.js>
Blocks every network request except the pinned sql.js script (served locally)."""
import re, sys, time, json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
SQLJS = open(sys.argv[1]).read()
html = (ROOT / 'demo' / 'dist' / 'tag-weekly-report-r12-demo.html').read_text()
page_html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>' + html + '</body></html>'
other, errs, steps = [], [], []


def cred(pg, eid):
    txt = pg.inner_text(f'button.person[data-id="{eid}"] .pcred')
    pin = re.search(r'PIN (\d{6})', txt); code = re.search(r'code (\d{6})', txt)
    return pin.group(1) if pin else None, code.group(1) if code else None


with sync_playwright() as p:
    b = p.chromium.launch()
    for vp in [{'width': 390, 'height': 844}, {'width': 820, 'height': 1180}]:
        pg = b.new_page(viewport=vp)

        def handle(route):
            u = route.request.url
            if u.startswith('https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js'): route.fulfill(body=SQLJS, content_type='text/javascript')
            elif u == 'https://demo.test/': route.fulfill(body=page_html, content_type='text/html')
            elif u.startswith('data:') or u.startswith('blob:'): route.continue_()
            else: other.append(u); route.abort()
        pg.route('**/*', handle)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        t = time.time(); pg.goto('https://demo.test/#/login'); pg.wait_for_selector('form[data-form=login]', timeout=120000); boot = time.time() - t
        steps.append(f'{vp["width"]}px boot {boot:.1f}s')
        # employee on the shop tablet
        pg.click('button.person[data-id="E-107"]'); pin, _ = cred(pg, 'E-107')
        for d in pin: pg.click(f'.keypad .key[data-key="{d}"][data-target="pin"]')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('#q-q1')   # staff land on the survey
        pg.click('label.opt:has(input[name=q1][value="4"])'); pg.click('[data-act=survey-next]')
        pg.click('label.opt:has(input[name=q2][value="5"])'); pg.click('label.opt:has(input[name=q3][value=no])'); pg.click('label.opt:has(input[name=q4][value=no])')
        pg.click('[data-act=survey-next]'); pg.fill('textarea[name=s1]', 'DEMO-SMOKE loose guard on band saw'); pg.click('[data-act=survey-next]')
        pg.check('input[name=affirm]')
        for d in pin: pg.click(f'.keypad .key[data-key="{d}"][data-target="signpin"]')
        pg.click('button[data-submit]'); pg.wait_for_selector('.success h1')
        pg.click('[data-act=download][data-fmt=html]'); pg.wait_for_selector('#record-overlay')
        expect(pg.locator('#record-overlay')).to_contain_text('Jordan Demo')
        pg.click('#record-overlay .record-bar button')
        steps.append('employee signed + copy opened')
        pg.click('.success [data-act=signout]'); pg.wait_for_selector('.portal-public')
        pg.goto('https://demo.test/#/login'); pg.wait_for_selector('form[data-form=login]')
        # supervisor with authenticator code
        pg.click('button.person[data-id="E-102"]'); pin, code = cred(pg, 'E-102')
        pg.fill('#pin', pin); pg.click('form[data-form=login] button[type=submit]')
        pg.wait_for_selector('input[name=totp]'); pg.fill('input[name=totp]', cred(pg, 'E-102')[1]); pg.click('form[data-form=login] button[type=submit]')
        pg.wait_for_selector('#dash-table')            # management land on the dashboard
        pg.goto('https://demo.test/#/team?tab=awaiting'); pg.wait_for_selector('main h1')
        try:
            pg.click('a.link-row:has-text("Jordan Demo")', timeout=15000)
        except Exception:
            pg.screenshot(path=str(ROOT / 'tests' / 'screens' / 'FAIL-demo.png'), full_page=True); raise
        pg.wait_for_selector('#review-panel')
        pg.fill('form[data-form=signoff] input[name=signPin]', pin)
        pg.check('form[data-form=signoff] input[name=affirm]'); pg.click('form[data-form=signoff] button[type=submit]')
        pg.wait_for_selector('text=Signed off.')
        steps.append('supervisor signed off')
        w = pg.evaluate('document.documentElement.scrollWidth - window.innerWidth'); assert w <= 1, w
        pg.screenshot(path=str(ROOT / 'tests' / 'screens' / f'demo-{vp["width"]}.png'))
        pg.close()
    b.close()

ok = not errs and not other
result = {'ok': ok, 'steps': steps, 'pageErrors': errs, 'blockedRequests': other}
(ROOT / 'tests' / 'demo-smoke-results.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
sys.exit(0 if ok else 1)
