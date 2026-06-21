# AGENTS.md

This project uses production-grade engineering skills from addyosmani/agent-skills.
Skills encode workflows, quality gates, and best practices that senior engineers use.

## Core Rules

- If a task matches a skill, you MUST invoke it via the `skill` tool
- Skills are located at `agent-skills/skills/<skill-name>/SKILL.md`
- Never implement directly if a skill applies
- Always follow the skill instructions exactly (do not partially apply them)
- Do not skip required workflows (spec, plan, test, review, etc.)

## All Available Skills

### Meta
- `using-agent-skills` — Maps incoming work to the right skill workflow

### Define (clarify what to build)
- `interview-me` — One-question-at-a-time interview to extract requirements
- `idea-refine` — Turn vague ideas into concrete proposals
- `spec-driven-development` — Write a PRD before any code

### Plan (break it down)
- `planning-and-task-breakdown` — Decompose specs into verifiable tasks

### Build (write the code)
- `incremental-implementation` — Thin vertical slices, implement/test/verify/commit
- `test-driven-development` — Red-Green-Refactor workflow
- `context-engineering` — Feed agents the right information at the right time
- `source-driven-development` — Ground decisions in official documentation
- `doubt-driven-development` — Adversarial review of non-trivial decisions
- `frontend-ui-engineering` — Component architecture, design systems, accessibility
- `api-and-interface-design` — Contract-first API design

### Verify (prove it works)
- `browser-testing-with-devtools` — Chrome DevTools for live runtime data
- `debugging-and-error-recovery` — Five-step triage: reproduce, localize, reduce, fix, guard

### Review (quality gates)
- `code-review-and-quality` — Five-axis structured review
- `code-simplification` — Reduce complexity while preserving behavior
- `security-and-hardening` — OWASP Top 10, auth patterns, secrets management
- `performance-optimization` — Measure-first approach, Core Web Vitals

### Ship (deploy with confidence)
- `git-workflow-and-versioning` — Trunk-based development, atomic commits
- `ci-cd-and-automation` — Shift Left, feature flags, quality gates
- `deprecation-and-migration` — Code removal and migration patterns
- `documentation-and-adrs` — Architecture Decision Records, API docs
- `observability-and-instrumentation` — Structured logging, RED metrics, tracing
- `shipping-and-launch` — Pre-launch checklists, staged rollouts, rollback

## Intent → Skill Mapping

| User intent | Skills invoked |
|---|---|
| Feature / new functionality | `spec-driven-development` → `planning-and-task-breakdown` → `incremental-implementation` + `test-driven-development` |
| Planning / breakdown | `planning-and-task-breakdown` |
| Bug / failure / unexpected behavior | `debugging-and-error-recovery` |
| Code review | `code-review-and-quality` |
| Refactoring / simplification | `code-simplification` |
| API or interface design | `api-and-interface-design` |
| UI / frontend work | `frontend-ui-engineering` |
| Security review | `security-and-hardening` |
| Performance review | `performance-optimization` |
| Web performance audit | `performance-optimization` |
| Shipping / deployment | `shipping-and-launch` + `ci-cd-and-automation` |
| Documentation / ADRs | `documentation-and-adrs` |
| Underspecified request | `interview-me` |
| Rough concept | `idea-refine` |
| High stakes / production / security | `doubt-driven-development` |

## Agent Behavior

1. **Evaluate** — Does the user request match any skill?
2. **Invoke** — If yes, call the `skill` tool with the skill name
3. **Follow** — Execute the skill's workflow exactly as specified
4. **Verify** — Complete all verification gates before considering the task done

## References

Additional checklists used by skills are in `agent-skills/references/`:
- `testing-patterns.md` — Test structure, naming, mocking
- `security-checklist.md` — Auth, input validation, OWASP Top 10
- `performance-checklist.md` — Core Web Vitals, measurement
- `accessibility-checklist.md` — Keyboard nav, screen readers, ARIA
- `observability-checklist.md` — Logging, metrics, tracing

## Agent Personas

Specialist personas in `agent-skills/agents/`:
- `code-reviewer` — Senior Staff Engineer perspective
- `test-engineer` — QA Specialist perspective
- `security-auditor` — Security Engineer perspective
- `web-performance-auditor` — Performance Engineer perspective
