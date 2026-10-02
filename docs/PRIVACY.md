# Heed — Privacy Design (V1)

Status: Draft for sign-off. This document is both the **engineering contract** for privacy behavior and the **source text** for the public privacy policy and the in-product consent screens. Where it makes a factual claim about the system, the claim is backed by a design element in DATA_MODEL, SECURITY, or AI and by a test (see section 11). Third-party terms (Google, Gemini, Neon) are described as of the date above and **must be re-verified before beta launch** (DECISIONS free-tier assumptions table).

## 1. Principles

1. **Read only what we need, store less than we read, send the least to AI.** Gmail is read-only; a deterministic filter decides which few messages are even looked at closely; full email bodies are never stored; AI receives a short redacted excerpt.
2. **No surprises.** Every detected item shows exactly why it exists. The product states plainly what is read, stored, and sent to a third party.
3. **Your data, your switch.** Pause, disconnect, export, and delete are always available in the product, with immediate effect.
4. **No secondary use.** Data is used only to detect and remind about your tasks. No ads, no selling, no sharing, no human review, no model training.

## 2. What Heed accesses

| Source | Permission requested | What Heed reads | Purpose |
|---|---|---|---|
| Google account | `openid email profile` | Your Google account ID and email address | Sign-in and identifying your account |
| Google Calendar | `calendar.events.readonly` (read-only) | Events on your primary calendar from yesterday to 30 days ahead: title, times, status, who is invited, and the description text | Linking tasks to events and finding tasks in event descriptions |
| Gmail | `gmail.readonly` (read-only) | Message **headers** (sender, recipients, subject, date, labels, list headers) for new messages in your Inbox; the **body** of messages that pass the header checks, **transiently in server memory**. **Only if you separately opt in:** headers and bodies of messages you **sent**, to find commitments you made | Finding tasks you are asked to do and commitments you made |

Heed cannot send, delete, modify, label, or archive anything in Gmail or Calendar. It never opens attachments. It does not access your contacts.

Messages in Spam, Trash, Drafts, Promotions, Social, and Forums are skipped. Bulk mail with unsubscribe headers is skipped. Senders you mute are skipped.

## 3. What Heed stores

| Data | Stored? | Detail |
|---|---|---|
| Email bodies | **No** | Read in memory, then discarded. Messages deferred for retry are re-fetched from Gmail, not stored |
| Email attachments | **No** | Never downloaded |
| Email recipients, CC lists | **No** | Not stored |
| Detected task (title, deadline, status, notes you add) | Yes | Visible to you; plaintext in the database |
| Evidence for each task: one verbatim sentence or two (at most 300 characters), the email subject, the sender, the received date, which signals fired, the AI's one-sentence explanation | Yes | **Encrypted** in the database. Shown only to you in the "Why" panel |
| Link to the email in Gmail | Yes (message and thread IDs) | Opens in your own Gmail session; Heed does not fetch it |
| A log of messages whose body was examined | Yes (IDs and outcome only) | Message ID, thread ID, date, outcome (e.g. "no task found"), scores, rule IDs. No sender, subject, or content. Messages dropped by header checks alone are only **counted**, not logged. Kept 30 days |
| People and organizations behind your items ("Jane, recruiter at Acme") | Yes (minimal) | Display name and organization **encrypted**; a one-way hash of the email address for matching; the domain. Removed 30 days after nothing references them |
| Notifications Heed prepared for you | Yes | The reminder text you see (task and event titles you already see in Heed), delivery status, timestamps. Kept 14 days |
| AI request records | Yes (no content) | Which model was used, an estimate of tokens, outcome, counts. Never the text sent or received. Kept 30 days |
| Sender learning counters | Yes (hash-only) | How many times you confirmed, completed, or dismissed items from a sender, keyed by a one-way hash. Clearable in Settings |
| Calendar events | Yes (minimal) | Title, start/end, status, and one-way hashes of invitees' emails plus their domains (used to recognize "sender is invited to this event"). **Not stored:** description, location, attendee names or addresses, meeting links. Kept until 14 days after the event |
| Google refresh tokens | Yes | **Encrypted**, server-side only, used to read Gmail/Calendar on your behalf; deleted on disconnect or account deletion. Never sent to your browser |
| Heed session token | Yes (hash on server; token in your browser) | Lets the extension talk to Heed; revocable from Settings |
| Settings (timezone, quiet hours, caps, muted senders) | Yes | |
| Hash-only "do not re-detect" markers | Yes | Created when you delete or dismiss a task, so it does not reappear. No readable content. Clearable in Settings |
| Security/audit events | Yes (no content) | Sign-ins, connects, disconnects, pause/resume, exports, deletions. Kept 90 days |
| Operational logs | Yes (no content) | Request IDs and error codes, 30 days. Never email text, subjects, addresses, or tokens |

Your browser also keeps a local copy of your tasks, events, and reminder schedule so the extension works instantly and offline. It is cleared when you sign out or delete your data.

## 4. What is sent to the AI provider

For each message that survives the deterministic filters (typically about 3% of inbox mail), Heed sends **one request** to Google's Gemini API containing:

- A short **redacted excerpt** of the message: only the sentences that look like requests or deadlines plus neighboring context, at most 1,500 characters. Email addresses, phone numbers, long numbers, card-like numbers, links, and secret-like strings are replaced with placeholders such as `[email]` before sending.
- The message subject (redacted, at most 120 characters), the sender's **display name and domain** (not the address), and the message date.
- The **titles and start times** of up to 5 of your upcoming calendar events, labeled with anonymous references, so the model can say which event a task belongs to. No invitee, location, or description data.
- Your timezone and the current time.

Not sent: your other emails, attachments, recipients, your email address, event invitees, Google tokens, or your name beyond what appears in the excerpt itself.

Heed does not use AI for anything else in V1 (no summaries, no replies, no training).

### Data-use terms of the AI provider

The disclosure shown depends on the tier of the Gemini API configured for the service:

- **Variant A (paid-tier terms; required before any public launch or verification submission).** Under Google's published paid-service terms, Google does not use prompts and responses to improve its products; it may retain them for a limited period for abuse monitoring and legal compliance. In this mode the server uses only pool entries whose terms prohibit training and the consent text matches. Which variant applies is a configuration state that the server checks at boot and per user (the tier guard in AI.md section 5); it never silently falls back to a different variant.
- **Variant B (free-tier mode; the Stage 0 owner decision for the closed beta, see DECISIONS D-18):** under Google's free-tier terms, prompts and responses **may be used to improve Google's products and may be reviewed by humans.** Every beta user is told this in plain words on the consent screen **before** connecting Gmail and can decline (declining means Heed will not run AI analysis for them; calendar-only use remains possible). Because the provider's terms (as summarized by secondary sources) only allow free services for users **outside the EEA, Switzerland, and the UK**, free-tier mode also requires each user's region attestation, and the server refuses AI analysis without it. This variant is in tension with Google's Limited Use rules for Gmail data, which is why it is limited to a closed beta, why the tier guard fails closed, and why it must end (switching to Variant A by configuration) before any verification submission or public launch. The excerpts may also contain other people's words (for example a recruiter's message); Variant B text says so.

The consent record stores which variant the user accepted (`Consent.variant`) together with the text version; if the configured tier changes, previous consents become stale and the user is asked again (`CONSENT_VARIANT_STALE`).

## 5. Data subjects' controls (all in the product)

| Control | Where | Effect |
|---|---|---|
| See why an item exists | Task, "Why" panel | Shows source, quote, signals, AI step, link reasoning |
| Dismiss, snooze, complete, edit, delete | Task actions | See PRODUCT 6.1 |
| Mute a sender or domain | Dismiss dialog, Settings | Never examined again |
| Pause processing | Popup, Settings | No Gmail, Calendar, or AI activity until resumed; paused-period mail is skipped on resume |
| Disconnect Gmail or Calendar | Settings, Connections | Revokes access at Google (best effort) and deletes the stored token; you choose whether to also delete data derived from that source |
| Export my data | Settings, Data & privacy | JSON file of everything Heed holds about you (tokens and internal hashes excluded) |
| Delete my data | Settings, Data & privacy | Erases tasks, evidence, events, message log, reminders, markers; keeps your account and connections |
| Delete my account | Settings, Data & privacy | Revokes Google access and erases everything, including the account |
| Withdraw AI consent | Settings, Data & privacy | AI calls stop immediately; no new tasks are detected (existing tasks remain) |
| Review and revoke devices | Settings, Sessions | Sign out any browser |
| Revoke at Google | myaccount.google.com/permissions | Independent of Heed; Heed will show "needs reconnect" |

Deletion is immediate in Heed's database. The database provider keeps a short point-in-time recovery history (up to 6 hours on the plan in use), so erased rows can persist in provider history for up to that window and are then gone. Heed makes no other backups.

## 6. Retention summary

| Data | Kept for |
|---|---|
| Open and suggested tasks | Until you act (unreviewed suggestions auto-dismiss after 14 days) |
| Completed and dismissed tasks | 90 days, then deleted |
| Calendar events | 14 days after they end |
| Message examination log | 30 days |
| "Do not re-detect" markers | 365 days or until you clear them |
| Reminder records | 14 days after delivery |
| Audit events / operational AI call metadata | 90 days / 30 days |
| Server logs | 30 days |
| Google tokens | Until you disconnect, revoke, or delete your account |
| Everything, on account deletion | Deleted immediately (provider history window above); a counts-only deletion receipt with no identifiers is kept 365 days |

## 7. Who processes your data (subprocessors)

| Provider | Role | Data |
|---|---|---|
| Google (Gmail and Calendar APIs) | Source of your data; you authorize access | All of section 2 |
| Google Cloud (Cloud Run, Secret Manager, Cloud Logging, Cloud Scheduler) | Hosts the Heed API and secrets | Data in transit/memory; logs without content |
| Neon | Hosts the PostgreSQL database | Section 3 data (sensitive fields encrypted before storage) |
| Google (Gemini API) | AI extraction | Section 4 data only |
| GitHub | Source code and CI | No user data |

Heed does not sell data, share it for advertising, or give it to anyone else. No human at Heed reads your messages or evidence; production database access is break-glass only and is recorded. Exceptions: you ask for support and explicitly consent, a security investigation, or a legal requirement.

## 8. Consent and onboarding text (source for UI copy)

Shown before any Google connection; versioned and recorded (`Consent` table); each item revocable.

**Screen 1: What Heed does.** "Heed reads your calendar and, if you allow it, your Gmail Inbox (read-only) to find things you need to do and remind you when it matters. It never sends, deletes, or changes anything."

**Screen 2: What happens with your data.**
- "Most emails are skipped by simple filters, never read closely: promotions, social, bulk mail, spam."
- "For the rest, Heed reads the message on its server **only in memory**. Full emails are never stored."
- "For the few that look like requests, a short redacted excerpt is sent to Google's Gemini AI to find the task. [Variant A: Under Google's paid-service terms this data is not used to improve Google's products. | Variant B: ...]"
- "We store the task and one short quote from the email, encrypted, so you can always see why Heed created it."
- "No one at Heed reads your data. You can pause, export, or delete everything at any time."

**Screen 3: Beta notes.** "Heed is in private beta. Google will show an 'unverified app' warning because verification is not complete; you can see exactly what you are granting. Reminders appear only while Chrome is running."

Checkboxes (the first two are required to proceed to Gmail): "I agree to Heed processing my Google data as described" (`GOOGLE_DATA_PROCESSING`) and "I understand a redacted excerpt of some emails is sent to Google's Gemini API, as described above" (`AI_PROCESSING`, recorded with the disclosure variant shown). In free-tier mode a third required attestation, "I am not located in the EEA, Switzerland, or the UK" (`REGION_ATTESTATION`), is shown. An **optional, unticked** choice, "Let Heed also read emails I send to find things I promised to do" (`SENT_MAIL_COMMITMENTS`), controls sent-mail processing. Calendar-only use requires the first; AI consent is needed for detection from calendar descriptions as well. Each is revocable in Settings.

## 9. Regulatory and platform alignment

- **Google API Services User Data Policy, Limited Use:** see SECURITY.md section 11. The in-product and policy text carries the required affirmation: *"Heed's use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements."*
- **Chrome Web Store User Data Policy:** single purpose (task detection and reminders from your Gmail and Calendar), limited use, no remote code, accurate permission justifications. Data disclosure categories to declare: *personally identifiable information* (email address), *authentication information* (Heed session token), *personal communications* (email content processed transiently, evidence snippets), *website content* (none). Certifications: data not sold, not used for unrelated purposes, not used for creditworthiness.
- **GDPR/UK GDPR-style rights** (access, rectification, erasure, restriction, portability, objection) are implemented as product features (export, edit, delete, pause, withdraw consent). The lawful basis is consent. Beta users are informed of the controller (the project owner) and a contact address. If any beta user is in the EU or UK, transfers to US subprocessors rely on those providers' standard contractual mechanisms; this must be reviewed before the beta starts (DECISIONS unresolved #11) and again before any public launch.
- **Children:** Heed is not directed to children and requires a Google account with the sign-in age restrictions that implies.
- **Breach notification:** affected beta users are notified within 72 hours of a confirmed breach affecting their data (SECURITY.md section 14).

## 10. Privacy risks and mitigations (DPIA-lite)

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Sensitive email content leaves the user's control via AI | Possible / high | Deterministic pre-filter (about 3% reach AI), redaction, 1,500-char cap, tier guard that fails closed, per-user consent in the matching disclosure variant, region attestation, pause and withdraw, and a no-training tier available by configuration (mandatory before public launch). In free-tier mode this risk is **accepted and disclosed**, not eliminated |
| Over-collection from Gmail | Possible / high | Read-only scope; headers first; bodies transient; Spam/Promotions/Social excluded; mute rules; bounded backfill (default 14 days) |
| Server reads bodies of non-bulk mail that is later dropped | Certain / medium | Disclosed; in-memory only; never logged or stored; (alternative designs considered: DECISIONS D-05) |
| Re-identification via stored evidence | Possible / medium | Encrypted; minimal; retention caps; no developer read access |
| User cannot tell why something was detected | Possible / medium | Mandatory evidence and the "Why" panel; verbatim-quote validator |
| Data persists after "delete" | Possible / medium | Hard delete plus verification tests; provider history window disclosed |
| Third-party terms change | Possible / high | Terms re-verified before launch and quarterly; tier guard fails closed; provider abstraction |
| Incorrect detection causes harm (missed deadline or a false alarm) | Likely / low-medium | Precision-first thresholds; review tray; "never auto-complete"; clear beta caveats; Heed is an aid, not a guarantee |

## 11. How these claims are verified (tests and gates)

| Claim | Verification |
|---|---|
| Bodies never stored | Integration test runs the pipeline on canary bodies and asserts canary strings appear in no DB column, log line, or job payload |
| Evidence is at most 300 chars and encrypted | Schema constraint plus ciphertext-at-rest test |
| Redaction before AI | Unit tests over PII patterns; eval metric "zero PII patterns in excerpts"; adapter test asserts the request contains only the redacted excerpt and permitted fields |
| Only permitted fields sent to AI | Contract test snapshots the serialized provider request |
| Delete/export completeness | Test creates data in every table, then asserts zero rows after delete and complete coverage in export |
| Disconnect revokes and deletes tokens | Integration test with a fake Google revoke endpoint |
| No secrets in extension | CI bundle scan (SECURITY.md section 3) |
| Pause stops all activity | Test asserts zero Gmail/Calendar/AI calls while paused |
| AI tier guard | Config test: prod config with `AI_DATA_TIER=free` and no acknowledgment fails to boot |

## 12. Public privacy policy outline (to be published before beta)

1. Who we are and how to contact us. 2. What we collect (section 3). 3. How we use it (section 1.4). 4. AI processing (section 4). 5. Who we share with (section 7). 6. Retention (section 6). 7. Your rights and controls (section 5). 8. Security (summary of SECURITY.md). 9. Google Limited Use statement (section 9). 10. Beta limitations. 11. Changes to this policy (notified in-product; material changes require renewed consent and a consent-version bump). 12. Effective date and version.

Hosting: a static page (GitHub Pages or the API's static route) linked from the OAuth consent screen, the Web Store listing, and the extension's Options page.
