# FRICTION

> **"Users do NOT think while confused."**

**FRICTION** is a minimalist AI-powered productivity ecosystem designed to bridge the gap between **raw information capture** and **meaningful insights**.

Instead of interrupting your workflow with AI suggestions, FRICTION captures your moments of confusion, curiosity, and realization instantly. AI analyzes them later in batches, helping you discover learning patterns you would otherwise miss.

---

## ✨ Product Philosophy

### ⚡ Capture Instantly, Analyze Later
Capture thoughts without breaking focus. Reflection happens later.

### 🤫 Systemic Silence
AI acts as a silent analyst—not a tutor, chatbot, or distraction.

### 📈 Patterns Over Moments
One moment rarely matters. Meaning emerges from hundreds of moments over time.

### 🧠 Preserve Context
Raw data should remain untouched until reflection.

> **Raw Data ≠ Interpreted Data**

---

# 🚀 Features

- ⚡ Instant keyboard-driven capture
- 📝 Capture highlights, notes, and learning moments
- 🤖 AI-generated learning insights
- 🔍 Detect recurring confusions and knowledge gaps
- 📊 Weekly & long-term learning pattern analysis
- 🧠 Persistent Learning Records
- 📚 Searchable personal knowledge base
- 🔒 Google OAuth authentication
- 🎯 Zero-friction workflow with delayed intelligence

---

# 🏗️ Architecture

FRICTION follows a simple **Capture → Process → Review** lifecycle.

```text
Chrome Extension
        │
        ▼
 Capture Raw Moments
        │
        ▼
 Backend Snapshot Service
        │
        ▼
 Gemini Batch Analysis
        │
        ▼
 Candidate Findings
        │
        ▼
 Review Dashboard
        │
        ▼
 Stable Learning Records
```

---

# 🧩 Components

| Component | Responsibility | Tech Stack |
|-----------|---------------|------------|
| Chrome Extension | Keyboard-driven raw capture | Manifest V3 |
| Backend API | Authentication, orchestration, snapshot pipeline | Node.js, Express |
| Web Dashboard | Review findings and visualize trends | React, Tailwind CSS |
| Database | Store moments, findings, learning records | MySQL |
| AI Layer | Batch analysis and pattern detection | Gemini |

---

# 📦 Data Flow

```
Raw Moments
      │
      ▼
Snapshot Created
      │
      ▼
Gemini Batch Analysis
      │
      ▼
Candidate Findings
      │
      ▼
User Review
      │
      ├── Confirm
      ├── Defer
      └── Reject
      │
      ▼
Learning Records
```

---

# 🗄️ Data Models

## Buffer Moments

```sql
moment_id      CHAR(36)
user_id        CHAR(36)
raw_text       TEXT
source_type    ENUM('highlight','bulk_paste')
source_url     TEXT
status         ENUM('pending','processed')
created_at     TIMESTAMP
```

---

## Candidate Findings

```sql
finding_id            CHAR(36)
snapshot_id           CHAR(36)
type                  ENUM(
    'confusion',
    'insight',
    'fragile_understanding',
    'pattern'
)
topic                 VARCHAR(255)
evidence_moment_ids   JSON
state                 ENUM(
    'unreviewed',
    'confirmed',
    'deferred',
    'rejected'
)
```

---

# 🔄 State Transitions

## Buffer Moments

```
pending
    │
    ▼
processed
    │
    ▼
deleted
```

---

## Findings

```
unreviewed
      │
      ├────────► confirmed
      │
      ├────────► deferred
      │
      └────────► rejected
```

---

## Learning Records

Learning Records are created or updated **only** after a finding has been:

- ✅ Confirmed
- ⏳ Deferred

Rejected findings are permanently discarded.

---

# 🌐 API

## Capture

```
POST /api/moments
```

Capture raw text with metadata.

---

## Snapshot

```
POST /api/snapshots/run
```

Trigger batch AI analysis.

Maximum:
- 30 moments per snapshot

---

## Review

```
GET /api/findings?state=unreviewed
```

Fetch pending findings.

```
POST /api/findings/:id/confirm
```

Confirm a finding.

```
DELETE /api/findings/:id
```

Reject a finding permanently.

---

# ⚙️ Tech Stack

### Frontend
- React
- Tailwind CSS

### Backend
- Node.js
- Express

### AI
- Gemini

### Database
- MySQL

### Authentication
- Google OAuth

### Browser
- Chrome Extension (Manifest V3)

---

# 🎯 Version 1 Constraints

- ❌ No RAG
- ❌ No vector database
- ❌ No auto-teaching
- ❌ No AI chat
- ✅ Batch-only AI analysis
- ✅ Google OAuth authentication
- ✅ Human-in-the-loop validation

---

# 📌 Vision

Most note-taking apps remember **what you learned**.

FRICTION remembers **how you learn.**

Instead of storing information, it uncovers recurring mistakes, fragile understanding, and hidden learning patterns—helping you build lasting knowledge over time.

---

# 📈 Success Metric

> **"This surfaced a pattern I didn't realize."**
