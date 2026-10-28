# Company documents (handbook, policies) with signed acknowledgments

Owner, 2026-10-27: "shouldn't the portal also have our onboarding, our handbook, our policies, vacation scheduling, etc?" → "1" (build documents and signed acknowledgments first).

## What it does
- **More → Company documents** for everyone.
- When a document needs a signature, it also shows on Home under "Please read and sign".
- Each document has a kind (Handbook, Policy, Safety, Benefits, Other), a version, an effective date, an English text, and an optional Spanish text. People who use the Hub in Spanish see the Spanish text when there is one.
- **Signing:** the person ticks "I agree to sign this electronically" and signs with Face ID (on their own phone) or their PIN. The Face ID approval covers exactly that version, in that language.
- **What is stored for each signature:** the exact statement they agreed to, the text's fingerprint (SHA-256), the time, how they signed and on which phone. Signatures cannot be changed or deleted (enforced by the database).
- **Writing (full access only):** New document → write or paste the text → Save draft → Preview → Publish (two taps). Drafts are visible only to full-access managers.
- **Versions:** a published version never changes. "Make a new version" copies it into a draft. Publishing that draft retires the old version, everyone is asked to sign again, and earlier signatures are kept.
- **Who has signed:** full access sees everyone; a manager sees their own people. Staff see only their own.
- **Archive:** removes a document from the list and stops asking people to sign it. It can be brought back.
- **Formatting:** "# " heading, "## " smaller heading, "- " bullet, **bold**, blank line between paragraphs. Text pasted from Word works.
- **The default signing statement:** "I received {title} (version {v}, effective {date}). I have read it, and I can ask my supervisor about anything I do not understand." Each document can have its own statement instead.
- **Test copy:** an invented "Sample Employee Handbook (example only)" plus a sample draft. The real handbook is **never** put on the test copy, because its sample sign-ins are public.

## Loading the handbook on the live Hub (after the next live deploy)
1. Sign in → **More → Company documents → New document**.
2. Kind: Handbook. Version: 2022. Effective date: 2022-01-01. Title: The Armored Group, Inc. Employee Handbook.
3. Paste the text from `Armored Group Handbook 2022 - for the Hub (draft).txt` (converted from EMPLOYEEHANDBOOK22.docx, wording unchanged) → **Save draft**.
4. **Do not publish yet.** See the review list sent in chat on 2026-10-27: the phone rules conflict with using the Hub, and several sections look out of date for California. When the updated handbook (English and Spanish) is ready, make it the draft's text and publish.

## Not in this step
- PDF files (text only for now; easier to read on a phone and to translate).
- The onboarding checklist and time off (next steps).
