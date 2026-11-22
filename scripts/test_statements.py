#!/usr/bin/env python3
"""Browser test for statements.js (CPP statement reader). Needs: pip install playwright.
Serves the repo locally, blanks account.js (the sign-in gate has its own test), uploads FAKE PDFs from
tests/fixtures and checks: history summary, Preview before Apply, only the statement's own estimate
at 65 is applied, spouse rule, history-only file, wrong file, no-text file, nothing leaves the page.
Run: python3 scripts/test_statements.py"""
import os, sys, http.server, threading, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
FIX = os.path.join(ROOT, 'tests', 'fixtures')
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
ORIGIN = 'http://127.0.0.1:%d' % srv.server_address[1]

with sync_playwright() as pw:
    try: br = pw.chromium.launch(channel='chrome')
    except Exception: br = pw.chromium.launch()
    page = br.new_context(viewport={'width': 420, 'height': 900}).new_page()
    errors, requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: requests.append(r.url))
    page.route('**/account.js', lambda route: route.fulfill(body='', content_type='application/javascript'))
    def fresh():
        page.goto(ORIGIN + '/index.html')
        page.evaluate("document.documentElement.classList.remove('awr-locked')")
        page.wait_for_selector('#stmtFile', state='attached')
        page.evaluate("document.getElementById('stmtShortcut').open = true")
    def upload(name): page.set_input_files('#stmtFile', os.path.join(FIX, name))
    def out_text(): return page.text_content('#stmtOut') or ''
    def val(i): return page.evaluate("document.getElementById('%s').value" % i)

    fresh(); before = val('cppMonthlyAmt'); upload('fake-cpp-with-estimate.pdf')
    page.wait_for_selector('#stmtApply')
    t = out_text()
    check('Found 8 years' in t and '1998 to 2026' in t, 'history summary: 8 years, 1998 to 2026')
    check('3 at the maximum' in t, 'three "M" years counted')
    check('1 in the Quebec Pension Plan' in t, 'the Q year is counted')
    check('1 not yet available' in t, '"Not yet available" year counted')
    check('2026-11-04' in t, 'statement date read')
    check('$640.1' in t, 'estimate at 65 shown ($640.10)')
    check('$410' not in t and '$909' not in t, 'age 60 and 70 amounts are not offered (planner adjusts for start age)')
    check(val('cppMonthlyAmt') == before, 'nothing is filled before Apply (Preview step)')
    page.click('#stmtApply')
    check(val('cppMonthlyAmt') == '640.1', 'Apply fills CPP per month at 65 with 640.1')
    check('Applied' in out_text(), 'confirmation shown')

    fresh(); upload('fake-cpp-with-estimate.pdf'); page.wait_for_selector('#stmtApply')
    page.check('input[name=stmtWho][value=spouse]')
    check('couple' in out_text().lower() and not page.query_selector('#stmtApply'), 'spouse: asks for couple mode first, no Apply button')
    page.select_option('#calcMode', 'couple'); page.wait_for_selector('#stmtApply'); page.click('#stmtApply')
    check(val('spouseCppMonthlyAmt') == '640.1', 'spouse Apply fills the spouse CPP field')

    fresh(); before = val('cppMonthlyAmt'); upload('fake-cpp-history-only.pdf')
    page.wait_for_selector('#stmtOut :text("Found 8 years")')
    check(not page.query_selector('#stmtApply'), 'history-only statement: no Apply button')
    check('no pension estimate' in out_text(), 'history-only statement: explains why nothing is filled')
    check(val('cppMonthlyAmt') == before, 'history-only statement: planner field unchanged')

    fresh(); upload('fake-other-document.pdf')
    page.wait_for_selector('#stmtOut .ai-msg.bad')
    check('could not recognise' in out_text().lower(), 'unrelated PDF: nothing recognised, nothing filled')
    fresh(); upload('fake-no-text.pdf')
    page.wait_for_selector('#stmtOut .ai-msg.bad')
    check('no readable text' in out_text().lower(), 'scan without text: clear message')
    fresh()
    page.set_input_files('#stmtFile', files=[{'name': 'photo.png', 'mimeType': 'image/png', 'buffer': b'x'}])
    page.wait_for_selector('#stmtOut .ai-msg.bad')
    check('not a pdf' in out_text().lower(), 'non-PDF file: clear message')

    outside = [u for u in requests if not u.startswith(ORIGIN) and not u.startswith('data:') and not u.startswith('blob:') and 'fonts.g' not in u]
    check(not outside, 'nothing requested from outside the site (%s)' % outside[:3])
    check(not errors, 'no page errors (%s)' % errors[:2])
    br.close()

if fails:
    sys.exit('%d check(s) failed' % len(fails))
print('all statement-reader checks passed')
