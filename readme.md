FRICTION"Users do NOT think while confused.
"FRICTION is a minimalist productivity ecosystem designed to bridge the gap between raw information capture and meaningful insight. It operates on the principle of delayed intelligence: capturing "friction moments" (confusions, sparks, or patterns) instantly without interrupting your flow, then using AI to analyze those patterns in deliberate batches.0. Product PhilosophyCapture Instantly, Analyze Later: Zero-friction capture during study/work.Systemic Silence: AI acts as a silent analyst, not a proactive teacher or distractor.Patterns Over Moments: Insights emerge from the aggregation of data over time, not isolated events.Logical Boundary: $Raw Data \neq Interpreted Data$. We preserve context until you are ready to reflect.1. High-Level ArchitectureFRICTION follows a Capture-Process-Review lifecycle:Capture (Extension): Buffers raw text and URLs via keyboard shortcuts.Orchestrate (Backend): Manages the buffer and triggers snapshots (manual or scheduled).Analyze (LLM): Gemini v1 processes batches of moments to identify "Candidate Findings."Review (Web App): Users confirm, defer, or reject AI-generated insights.Persist (Stable Memory): Validated findings become permanent "Learning Records."2. Component OverviewComponentResponsibilityTech StackChrome ExtensionCapture Layer: Keyboard-driven raw text buffering. Zero interpretation.Manifest v3Backend APILogic Layer: Google OAuth, snapshot orchestration, and LLM prompt management.Express.js, Node-cronWeb AppReflection Layer: Dashboard for reviewing findings and trend reports.React, Tailwind CSSDatabasePersistence Layer: Relational storage for moments and records.MySQLAI LayerAnalysis Layer: Batch processing of text into categorized patterns.Gemini v13. Data SchemaRaw Buffer (Uninterpreted)SQL{
  moment_id: CHAR(36),
  user_id: CHAR(36),
  raw_text: TEXT,
  source_type: ENUM('highlight','bulk_paste'),
  source_url: TEXT NULL,
  status: ENUM('pending','processed'),
  created_at: TIMESTAMP
}
Candidate Findings (AI Output)SQL{
  finding_id: CHAR(36),
  snapshot_id: CHAR(36),
  type: ENUM('confusion','insight','fragile_understanding','pattern'),
  topic: VARCHAR(255),
  evidence_moment_ids: JSON,
  state: ENUM('unreviewed','confirmed','deferred','rejected')
}
4. State TransitionsThe system treats data as a stream that gains stability as it moves through the pipeline:Buffer Moments: pending $\rightarrow$ processed (Deleted after snapshot).Findings: unreviewed $\rightarrow$ confirmed | deferred | rejected.Records: Created/updated only upon confirmation or deferral.5. API ContractExtensionPOST /api/moments: Send raw text and metadata.Snapshot LogicPOST /api/snapshots/run: Trigger LLM batch analysis (Max 30 moments per call).Web InteractionGET /api/findings?state=unreviewed: Fetch findings for dashboard.POST /api/findings/:id/confirm: Strengthen a Learning Record.DELETE /api/findings/:id: Permanently reject/delete a finding.6. Development Constraints (V1)No RAG: Pure batch analysis for V1.No Auto-Teaching: The system identifies what you are struggling with, not the solution.No Anonymity: Google OAuth is required for all capture events.7. Success MetricV1 is successful if a user says:"This surfaced a pattern I didn't realize."Since you've defined the system as "Authoritative" with non-negotiable data models, do you want me to generate the specific SQL migration scripts or the Sequelize/TypeORM models to match this schema?