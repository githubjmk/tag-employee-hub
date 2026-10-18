# 7. Check against the paper source you supplied (2026-10-14)

**Files:**
- `Weekly Report.docx`: the master template. Created in 2015; the version you sent was last saved on 2023-08-23.
- `Weekly Report_8-12-22.pdf`: the print batch for the week of 8/12/2022.

## Result: the digital form matches word for word

`app/tests/verify_paper.mjs` compares every paper string in the prototype with both files:
- the intro;
- "Circle Your Answers Please / Marcar su respuestas por favor";
- Q1–Q4 in English and Spanish;
- every answer option.

All match. The output is in `evidence/paper-verification-vs-source-docx.txt` and `evidence/paper-verification-vs-batch-2022-08-12.txt`. This is the same result as the earlier check against the 8/19/2022 batch on Drive. Active version `WR-1.0` shows Q1–Q4 exactly as printed. The only difference is that the "before Monday morning" sentence is withheld, pending the legal question G1.

## What the files show about how the paper process works

| Observation | What R1.2 does with it |
|---|---|
| Each page is headed **"Weekly Report <date> for <name>"**, and the date is the **Friday** of the week (8/12/2022 and 8/19/2022 were both Fridays) | The form already opens on Friday. **Changed now:** the printable or downloadable signed record uses the same heading, "Weekly Report 10/16/2026 for Maria Sample", so digital copies file alongside the paper ones. API test 23 checks it. |
| The template has no merge fields. The name and date were added per print, with names joined as "FirstLast", which suggests a mail merge from a list | The Hub keeps the name and stable employee ID on the account, so there is nothing to merge |
| English and Spanish appear together on every page | The digital form shows one language at a time, with a one-tap EN/ES switch. Showing both at once is possible if you prefer it. |
| The same 13 people appear in both batches, one page each | That fits a 20-account pilot. Names were **not** copied anywhere; the evidence files are redacted. |
| Signature and date lines only. No supervisor line, comment space or escalation path. | Unchanged from the R1.1 finding: supervisor sign-off, comments and safety escalation are new in the Hub |

## About "executed copies"

The 8/12/2022 PDF is the **printed blank batch**: a Word print-to-PDF made on 8/19/2022, before anyone filled it in. It has no circled answers, signatures or dates; the only image in it is the logo. If you want the prototype checked against how people actually fill the form in (for example, whether they write notes in the margins, skip the date, or answer both Yes and No), scanned signed pages would show that. They would contain employee answers, so they would be handled the same way: read, not copied, and redacted in any evidence.
