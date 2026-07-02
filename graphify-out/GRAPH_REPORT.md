# Graph Report - .  (2026-06-27)

## Corpus Check
- 90 files · ~91,987 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 524 nodes · 781 edges · 43 communities (32 shown, 11 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.79)
- Token cost: 450 input · 420 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 39|Community 39]]

## God Nodes (most connected - your core abstractions)
1. `liquidGLLens` - 20 edges
2. `getDbPool()` - 17 edges
3. `liquidGLRenderer` - 16 edges
4. `FRICTION System Design` - 12 edges
5. `requireAuth()` - 11 edges
6. `checkConnection()` - 10 edges
7. `analyzeMoments()` - 9 edges
8. `updateAuthUI()` - 9 edges
9. `getBoundingClientRect()` - 9 edges
10. `createApp()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `Friction Web App Entry Point` --references--> `FRICTION System Design`  [INFERRED]
  web/index.html → SYSTEM_DESIGN.md
- `Scheduler Service` --implements--> `Data State Transitions`  [INFERRED]
  ATTRIBUTE_USAGE.md → SYSTEM_DESIGN.md
- `FRICTION README` --references--> `FRICTION System Design`  [EXTRACTED]
  readme.md → SYSTEM_DESIGN.md
- `FRICTION System Design` --references--> `FRICTION Database Schema`  [EXTRACTED]
  SYSTEM_DESIGN.md → SCHEMA.md
- `FRICTION Database Schema` --references--> `FRICTION Attribute Usage Guide`  [EXTRACTED]
  SCHEMA.md → ATTRIBUTE_USAGE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Snapshot Processing Pipeline** — buffer_moments, snapshots, candidate_findings [EXTRACTED 0.95]
- **Learning Confirmation and Consolidation Loop** — candidate_findings, learning_records, consolidation_service [EXTRACTED 0.90]
- **Embedding-Based Search and Matching Ecosystem** — embedding_vector_search, similarity_thresholds, subdomains [INFERRED 0.85]
- **Icon Visual Elements** — extension_icons_icon128, extension_icon_mu_symbol [EXTRACTED 1.00]
- **icon48 Visual Elements** — icon48, mu_symbol [EXTRACTED 1.00]

## Communities (43 total, 11 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (38): requireAuth(), { verifyAccessToken }, express, { getUserLearningRecords }, { requireAuth }, router, express, { requireAuth } (+30 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (43): checkConnection(), generateReport(), getApiBase(), loadFindings(), loadMomentCount(), saveMoment(), updateFinding(), applyTheme() (+35 more)

### Community 2 - "Community 2"
Cohesion: 0.10
Nodes (7): compileShader(), createProgram(), debounce(), effectiveZ(), getBoundingClientRect(), liquidGLLens, liquidGLRenderer

### Community 3 - "Community 3"
Cohesion: 0.09
Nodes (32): allFindings, applyTheme(), connEl, findingsList, generateButton, generateReportHandler(), handleConnectionCheck(), handleUpdateFinding() (+24 more)

### Community 4 - "Community 4"
Cohesion: 0.09
Nodes (27): { randomUUID }, withTransaction(), ALLOWED_STATES, express, findBestTopicMatch(), { getDbPool }, getStopwords(), handleFindingDecision() (+19 more)

### Community 5 - "Community 5"
Cohesion: 0.11
Nodes (28): FRICTION Attribute Usage Guide, Buffer Moments Table, Bug: canonical_topics embedding never generated, Bug: findings.js createdRecordId undefined reference, Candidate Findings Table, Extension Capture vs Web Review Separation, Consolidation Service, Delayed Intelligence Principle (+20 more)

### Community 6 - "Community 6"
Cohesion: 0.08
Nodes (24): action, default_popup, default_title, background, service_worker, description, suggested_key, commands (+16 more)

### Community 7 - "Community 7"
Cohesion: 0.14
Nodes (15): IconCheck, IconCheckCircle, IconClose, IconHome, IconLink, IconList, IconLoader, IconLogin (+7 more)

### Community 8 - "Community 8"
Cohesion: 0.11
Nodes (12): domainCache, getDomainId(), resolveDomainAndSubdomain(), TTLCache, llm, mockConnection, mockPool, queryResponses (+4 more)

### Community 9 - "Community 9"
Cohesion: 0.10
Nodes (20): dependencies, axios, cors, dotenv, express, google-auth-library, jsonwebtoken, morgan (+12 more)

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (19): authRoutes, buildCorsAllowlist(), cors, createApp(), express, findingsRoutes, healthRoutes, { initDbPool } (+11 more)

### Community 11 - "Community 11"
Cohesion: 0.15
Nodes (17): express, { getDbPool }, {
  getGoogleClientId,
  getGoogleCallbackUrl,
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  verifyIdToken,
  upsertUserFromGoogle,
  validateJwtConfig
}, { randomUUID }, router, { signAccessToken }, axios, buildGoogleAuthUrl() (+9 more)

### Community 12 - "Community 12"
Cohesion: 0.11
Nodes (18): dependencies, react, react-dom, devDependencies, autoprefixer, postcss, tailwindcss, @tailwindcss/forms (+10 more)

### Community 13 - "Community 13"
Cohesion: 0.21
Nodes (12): analyzeMoments(), analyzeWithPrompt(), axios, buildPrompt(), extractJson(), getLLMModel(), getMaxRetries(), getTimeoutMs() (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.29
Nodes (8): getDbSslConfig(), initDbPool(), mysql, parseBoolean(), waitForDb(), app, { createApp }, { waitForDb }

### Community 15 - "Community 15"
Cohesion: 0.22
Nodes (8): getDbPool(), express, { getDbPool }, router, backfillEmbeddings(), { embedText, embedAndStore }, { getDbPool }, upsertUserFromGoogle()

### Community 16 - "Community 16"
Cohesion: 0.33
Nodes (4): detectSite(), getSiteConfig(), handleMutation(), startObserving()

### Community 17 - "Community 17"
Cohesion: 0.61
Nodes (7): binarySearchIterative(), binarySearchRecursive(), electionWinner(), main(), merge(), mergeSort(), vector

### Community 18 - "Community 18"
Cohesion: 0.33
Nodes (6): Alpine Terrain, Atmospheric Clouds, Golden Hour Lighting, Hero Background, Mountain Landscape, Sunset Sky

### Community 19 - "Community 19"
Cohesion: 0.38
Nodes (6): backfillFindings(), backfillRecords(), dotenv, { embedBatch }, main(), mysql

### Community 20 - "Community 20"
Cohesion: 0.29
Nodes (5): fs, inputPath, mysql, path, tags

### Community 21 - "Community 21"
Cohesion: 0.33
Nodes (6): CSRF, fetchPage(), fs, main(), path, query

### Community 22 - "Community 22"
Cohesion: 0.50
Nodes (4): CONFIG_BY_ENV, frictionStorage, handleAutoCapture(), showBadge()

### Community 23 - "Community 23"
Cohesion: 0.80
Nodes (4): require_cmd(), require_env(), usage(), migrate_local_to_aiven.sh script

### Community 24 - "Community 24"
Cohesion: 0.40
Nodes (4): cron, { getDbPool }, { runSnapshotsForUser }, startDailySnapshotScheduler()

### Community 25 - "Community 25"
Cohesion: 0.50
Nodes (4): Micro Prefix, Mu Symbol, Orange Brand Color, Favicon SVG

### Community 26 - "Community 26"
Cohesion: 0.50
Nodes (4): Greek Letter Mu Symbol, Mu (μ) Logo Icon, Orange Color Scheme, Stylized Typography Design

## Knowledge Gaps
- **222 isolated node(s):** `$schema`, `plugin`, `name`, `version`, `private` (+217 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getDbPool()` connect `Community 15` to `Community 0`, `Community 4`, `Community 11`, `Community 14`, `Community 24`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `Extension Capture vs Web Review Separation` connect `Community 5` to `Community 1`, `Community 3`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `$schema`, `plugin`, `name` to the rest of the system?**
  _224 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05357142857142857 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.07955596669750231 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09523809523809523 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.09103840682788052 - nodes in this community are weakly interconnected._