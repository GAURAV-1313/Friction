# FRICTION System Design (Authoritative)

## 0. Product Philosophy (Non-Negotiable)
- Users do NOT think while confused
- Users capture instantly, analyze later
- System delays intelligence intentionally
- Insights emerge from patterns over time, not single moments
- Extension is frictionless capture
- Web app is reflection + review
- AI is silent analyst, not teacher

Key principle: raw data != interpreted data

## 1. High-Level Architecture
Chrome Extension
  -> Raw Buffer (DB)
  -> (scheduled or manual trigger)
  -> Batch Analyzer (LLM)
  -> Candidate Findings
  -> (user passive/active confirmation)
  -> Learning Records
  -> Periodic Reports (Web)

## 2. Components Overview

### 2.1 Chrome Extension (Capture Layer)
Purpose
- Capture moments at the exact time friction occurs
- ZERO interpretation
- ZERO AI
- ZERO organization

Capabilities
- Keyboard shortcut capture (primary)
- Optional paste input (manual add)
- No report viewing
- No analysis
- No history

User Flow
- User highlights text (optional)
- Presses shortcut
- Moment is saved
- Subtle confirmation shown
- User continues studying

Data Sent
- raw text
- source URL
- source type
- timestamp
- user auth token

### 2.2 Backend API (Express.js)
Purpose
- Authentication (Google OAuth)
- Buffer storage
- Snapshot orchestration
- LLM interaction (Gemini v1)
- State transitions
- No frontend rendering logic

### 2.3 Web App (React)
Purpose
- Review findings
- Confirm/defer/reject
- Show learning records and reports

## 3. Data Models (MySQL)

### 3.1 Raw Buffer (Uninterpreted)
Table: buffer_moments
```
{
  moment_id: CHAR(36),
  user_id: CHAR(36),
  raw_text: TEXT,
  source_type: ENUM('highlight','bulk_paste'),
  source_url: TEXT NULL,
  created_at: TIMESTAMP,
  status: ENUM('pending','processed')
}
```
Rules
- NEVER modified after creation
- Deleted after snapshot processing (v1)
- No confidence, no labels, no AI output here

Indexes
- (user_id, status, created_at)

### 3.2 Snapshot (Batch Boundary)
Table: snapshots
```
{
  snapshot_id: CHAR(36),
  user_id: CHAR(36),
  trigger_type: ENUM('manual','scheduled'),
  created_at: TIMESTAMP,
  moment_count: INT
}
```
Purpose
- Defines which moments were analyzed together
- Enables batching + sequential processing

### 3.3 Candidate Findings (AI Output)
Table: candidate_findings
```
{
  finding_id: CHAR(36),
  snapshot_id: CHAR(36),
  user_id: CHAR(36),
  type: ENUM('confusion','insight','fragile_understanding','pattern'),
  topic: VARCHAR(255),
  summary: TEXT,
  confidence_ai: ENUM('high','medium','low'),
  evidence_moment_ids: JSON,
  state: ENUM('unreviewed','confirmed','deferred','rejected'),
  created_at: TIMESTAMP
}
```
Rules
- AI writes ONLY: type, topic, summary, confidence_ai, evidence indices
- Backend maps indices -> moment IDs
- Users NEVER edit text directly (only state)

Indexes
- (user_id, state, created_at)

### 3.4 Learning Records (Stable Memory)
Table: learning_records
```
{
  record_id: CHAR(36),
  user_id: CHAR(36),
  type: ENUM('confusion','insight','pattern'),
  topic: VARCHAR(255),
  summary: TEXT,
  first_seen_at: TIMESTAMP,
  last_admitted_at: TIMESTAMP,
  occurrence_count: INT,
  ignored_count: INT
}
```
Rules
- Created from confirmed or deferred findings
- Updated over time
- Used by reports

Indexes
- (user_id, type, last_admitted_at)

### 3.5 Users
Table: users
```
{
  user_id: CHAR(36),
  email: VARCHAR(255),
  name: VARCHAR(255),
  google_sub: VARCHAR(255),
  created_at: TIMESTAMP
}
```

### 3.6 User Settings
Table: user_settings
```
{
  user_id: CHAR(36),
  output_language: ENUM('hinglish','english'),
  updated_at: TIMESTAMP
}
```
Rules
- output_language changes the LLM prompt

### 3.7 Prompts
Table: prompts
```
{
  prompt_id: CHAR(36),
  name: VARCHAR(255),
  body: TEXT,
  is_active: TINYINT(1),
  created_at: TIMESTAMP,
  updated_at: TIMESTAMP
}
```
Rules
- Only one active prompt for v1

## 4. Snapshot & Batching Logic
Trigger
- User clicks "Generate Report" OR scheduled weekly cron

Batch Rules
- Max 30 buffer moments per LLM call
- If >30:
  - Create multiple sequential snapshots
  - Process one by one
  - Merge findings
- If 0 moments:
  - Snapshot skipped
  - UI shows "No activity this period"

## 5. LLM Processing Layer (Gemini v1)
Input
- Array of raw_text from buffer moments
- Ordered chronologically
- Indexed (0-based)

Output
- JSON array of findings
- Each with evidence_indices

Prompting
- Canonical prompt stored in DB
- output_language from user_settings controls Hinglish vs English
- No teaching, no solutions, no questions

LLM Mode
- Single mode for v1 (Gemini)
- Refactor later for OpenAI

## 6. Evidence Mapping
Example
Input moments
- 0 -> array reverse confusion
- 1 -> runtime error
- 2 -> same array confusion

LLM Output
```
{
  topic: "Subarray reversal boundaries",
  evidence_indices: [0, 2]
}
```
Backend mapping
- [0,2] -> [moment_uuid_1, moment_uuid_3]

Stored in candidate_findings.evidence_moment_ids

## 7. User Interaction Model
- Users are NOT forced to review immediately
- Default behavior:
  - AI confidence is initial ordering

User actions in dashboard
- Confirm -> strengthens record
- Defer -> kept, counted, revisited
- Reject -> deleted permanently

No blocking modal. No interruption.

## 8. Reports System (Web)
- Timeline based
- Grouped by topic
- Shows:
  - recurrence
  - trend (up/down)
  - ignored vs confirmed

No PDF generation in v1

## 9. Auth (Google OAuth)
- JWT issued by backend after Google OAuth
- Extension stores access token
- Backend validates token on every call
- No anonymous capture (v1)

## 10. Scheduling
- Server cron (node-cron) runs weekly
- Cron triggers snapshot creation for each active user
- Same batching logic as manual trigger

## 11. What Is Explicitly NOT in V1
- RAG
- Cross-user insights
- Recommendations
- Flashcards
- Reminders
- AI explanations
- Auto-teaching

## 12. Success Metric (Very Important)
V1 is successful if a user says:
"This surfaced a pattern I didn't realize."

## 13. Final Instruction
Implement this system exactly as specified.
Do not simplify data models.
Do not merge buffer and findings.
Do not add features not listed.
Preserve delayed analysis architecture.

## 14. Initial API Contract (Draft)

Extension
- POST /api/moments
  - body: { raw_text, source_type, source_url, created_at }
  - auth: Bearer token

Web
- POST /api/snapshots/run
  - body: { trigger_type: 'manual' }

- GET /api/findings?state=unreviewed
- POST /api/findings/:id/confirm
- POST /api/findings/:id/defer
- DELETE /api/findings/:id (reject)

- GET /api/learning-records
- GET /api/reports/summary

Auth
- GET /auth/google
- GET /auth/google/callback
- POST /auth/token (exchange Google user for JWT)

Admin
- GET /api/prompts/active
- PUT /api/prompts/active

## 15. State Transitions (Core)
- buffer_moments.status: pending -> processed
- candidate_findings.state: unreviewed -> confirmed | deferred | rejected
- learning_records updated on confirmed/deferred

## 16. Deletions
- buffer_moments deleted after snapshot processing (v1 decision)
- rejected findings deleted permanently

