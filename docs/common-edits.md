# Common edits - recipes (Ontario Retirement Planner)

Edit only the block named; find it with `grep -n` or `docs/code-map.md`. Then run
`python3 scripts/check_planner.py` (or let the Checks workflow run). Commit to main; Pages redeploys.

## 1. Yearly tax update (every January)
1. `getDefaultTaxRules()`: federal and Ontario brackets, basic amounts, age and pension credits, and
   `verifiedDate`. Source: Canada Revenue Agency and the provincial tax authority tables for the new year.
2. `TFSA_ANNUAL_LIMIT` (the new year's limit).
3. Government pension defaults: the maximum CPP and OAS monthly amounts in the input defaults
   (`cppMonthlyAmt`, `oasMonthlyAmt` and the spouse versions). OAS maximum changes each quarter.
4. `APP_VERSION` and `<title>` say "2026 rules": update the year. 5. Run the check and one plan.
Users who customised rules on screen keep their own (`onrp_tax_rules_v1`); that is expected.

## 2. Change wording of a label or note
grep the English text in `index.html`, change it in the HTML. Do not touch ids.
- English only: there is no French layer in this app.

## 3. Add a question (field) to the form
1. Add the `<input id="newField">` in the right `data-step` block (grep `data-step="2"`).
2. Money field: add its id to `MONEY_FIELDS` if it also appears in results rows.
3. Save/load: add it to `getProfileData()` and `populateForm()`.
4. Use it in `runSimulation()`. 5. If it is shown in results, add it to `yearCardsHtml()`.
6. Keep the invariant: money in = spending + tax + clawback + reinvested.

## 4. Change a hard-coded rule (e.g. RRIF minimum, 50% inclusion)
grep the constant (see CLAUDE.md "Hard-coded"), change it, and test a plan before and after.

## 5. Mobile layout or colours
CSS is one `<style>` block at the top (see `docs/code-map.md` for its line). Change the one class.
Test on a narrow phone width. The app is phone-first.

## 6. Disclaimers, independence notice, contact details
The app has NO visible disclaimer today (only the PDF guides carry an independence notice). Add one
before the address goes public: a short footer or a first-screen note saying results are estimates,
not tax, legal or investment advice, and the tool is independent of any government or employer.
Put it in the HTML near the end of `data-step="4"` and on step 1.

## 7. Add a new province (new repo)
Copy this repo, rename storage keys to a new prefix, then replace the provincial parts: the credits and
tax function (`calculateTax` and the helpers named in the AI MAP), `federalLifMaxPct` or the provincial
LIF table, withholding, and the labels. Check against an independent calculation (the Ontario app was
checked on 84 cases).

## 8. Something broke after an edit
Run `python3 scripts/check_planner.py`: it names a syntax error or duplicate id. Otherwise
`git log -p -3 -- index.html` and revert the last change.

## 9. Add a minor feature (a button, a line in the results, a new note)
1. Say what the user sees and where. Find the nearest similar thing in `docs/code-map.md` and copy its pattern.
2. Work only in `index.html`. New field: recipe 3 (it must be saved by `getProfileData` and loaded by `populateForm`
   so saved plans include it automatically). New result line: add it in `renderResultsUi`.
3. Do not call the network, add libraries, or rename ids/`onrp_*` keys.
4. Run `python3 scripts/check_planner.py`, then press "Show my plan" and confirm money in = money out.
5. Quebec only: add the French text (recipe 2). Update `APP_VERSION`.

## 10. Change the sign-in screen, welcome banner or saved plans
Edit `account.js` only (texts are in `T`, English and French). Keep: encryption before upload, no secret keys,
no innerHTML. Run `python3 scripts/test_account.py`. The guide is `guide.pdf` in the repo root (replace the file to update it; `CFG.docs` points at it).
The same change usually belongs in the other planner's `account.js` too.

## 11. Government statements (CPP Statement of Contributions)
`statements.js` reads the PDF on the device (pdf.js is self-hosted in `vendor/pdfjs/`). Part 1 is the parser
(`parseCppStatement`: rows `{year, contributions, pensionableEarnings, rawCode, isMaximum, isQPP, isPostRetirement, isPending}`,
`YMPE` 1966-2026, `YAMPE` 2024-2026; "M" resolves to the YMPE). Part 2 is the page (Preview, then Apply).
- Only the statement's own estimate at 65 is applied (to `cppMonthlyAmt` or `spouseCppMonthlyAmt`). A history is shown, never turned into a pension.
- New year: add the YMPE (and YAMPE) to the two tables at the top of `statements.js` (CRA "CPP contribution rates, maximums and exemptions").
- A real statement that is not read: add its layout quirk to `parseCppStatement`, add a FAKE fixture in `scripts/make_fake_statements.py`
  (never a real statement: this repo is public), and run `python3 scripts/test_statements.py`.
- Keep it free of network calls and web addresses: `scripts/check_planner.py` fails otherwise.

## 12. The tax check (scripts/test_tax.py) went red
It compares the planner's tax engine and yearly plan with a SEPARATE calculation using its own copy of the official numbers
(the "2026 PARAMETERS" block at the top of the script). The Actions run prints lines starting FAIL.
- You just changed tax numbers (new year, or an edit in `getDefaultTaxRules`): update the PARAMETERS block to the same official figures. Two copies on purpose: if they disagree, one has a typo. Find which by checking the official table (canada.ca, Revenu Québec or Ontario), not by copying one into the other.
- You did not touch tax numbers: a code change broke a calculation. Revert it or fix it, then run `python3 scripts/test_tax.py`.
- The check does not block the site (Pages deploys on its own); it only alerts you.

## 13. The optional expense list (Step 2 spending)
Under the spending field a link opens "Your expenses": a list of name + amount, monthly or weekly (default monthly). "Use this list" fills `spendAmount` and `spendFrequency` with the total and greys both out; "Edit expense list" or "Stop using the list" are the only ways to change them. Code: the block that starts `// ---- Optional expense list` in `index.html` (`EXP`, `expSync`, `openExpenses`, `expCommit`, `expStop`). It is saved with the plan as `expenseOn`, `expenseFreq`, `expenseItems` (read in `populateForm` via `expLoad`, written in `getProfileData`). The plan itself still just reads `spendAmount` and `spendFrequency`, so nothing else changes.
- Wording: edit the strings inside `buildExpSheet()` and the three lines under `spendFrequencyNote` and add the French to the `Object.assign(EXACT, {...})` block right after `P.push(["· not adding"...` (and the two `Your expenses add up to` patterns).
- Test: `python3 scripts/test_expenses.py` (runs in Checks).
