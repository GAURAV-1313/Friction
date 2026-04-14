# Render Migration Runbook

This runbook migrates backend hosting from Railway to Render while keeping:
- DB on Railway MySQL
- Web on Netlify
- Extension + web clients pointed to Render API

## 1. Target Architecture
- Backend API: Render Web Service (`backend` root)
- Database: existing Railway MySQL
- Web: Netlify (`web` project)
- Extension: Chrome extension (production config points to Render API)

## 2. Provision Render Service
Create service using [`render.yaml`](/Users/gaurav/Documents/New project/render.yaml):
- `type=web`
- `runtime=node`
- `rootDir=backend`
- `buildCommand=npm install`
- `startCommand=npm start`
- `healthCheckPath=/health`

Use a single instance initially to avoid duplicate in-process cron runs.

## 3. Backend Env Matrix (Render)
Set these env vars in Render:

`NODE_ENV=production`  
`DB_HOST=<railway-db-host>`  
`DB_PORT=<railway-db-port>`  
`DB_USER=<railway-db-user>`  
`DB_PASSWORD=<railway-db-password>`  
`DB_NAME=<railway-db-name>`  
`DB_CONNECT_TIMEOUT_MS=30000`  
`DB_KEEPALIVE_MS=10000`  
`JWT_SECRET=<same-as-current-production>`  
`JWT_ISSUER=<same-as-current-production>`  
`JWT_AUDIENCE=<same-as-current-production>`  
`GOOGLE_CLIENT_ID=<same-as-current-production>`  
`GOOGLE_CLIENT_SECRET=<same-as-current-production>`  
`GOOGLE_CALLBACK_URL=https://friction.onrender.com/auth/google/callback`  
`WEB_APP_URL=https://nofriction.netlify.app`  
`CORS_ORIGINS=http://localhost:3000,https://nofriction.netlify.app`  
`GEMINI_API_KEY=<same-as-current-production>`  
`GEMINI_MODEL=gemini-2.5-flash`  
`GEMINI_TIMEOUT_MS=60000`  
`GEMINI_EMBED_MODEL=gemini-embedding-001`  
`DEBUG_LLM=false`  
`LLM_MAX_MOMENT_CHARS=5000`  
`TOPIC_SIM_THRESHOLD=0.8`  
`TOPIC_STOPWORDS=issue,problem,confusion,error,bug,mistake,case,edge,logic,understanding`  
`SUBDOMAIN_SIM_THRESHOLD=0.82`

Render injects `PORT` automatically.

## 4. OAuth Cutover
In Google Cloud Console -> OAuth Client:
1. Add `https://friction.onrender.com/auth/google/callback`
2. Keep `http://localhost:4000/auth/google/callback` for local dev
3. Keep old Railway callback until rollback window ends

## 5. Client Cutover
### Netlify (web)
Set env:
- `VITE_API_BASE=https://friction.onrender.com`

Redeploy Netlify site.

### Landing page
- Login CTA now routes to `/reports` (no backend hardcode).

### Extension
- Production API default changed to Render URL in [`extension/config.js`](/Users/gaurav/Documents/New project/extension/config.js)
- Host permissions include `https://friction.onrender.com/*` and `http://localhost:4000/*` in [`extension/manifest.json`](/Users/gaurav/Documents/New project/extension/manifest.json)

## 6. Smoke Test Checklist
Run against Render API:

```bash
curl -i https://friction.onrender.com/health
curl -i https://friction.onrender.com/auth/google
```

After OAuth login in browser:
1. Confirm redirect lands at `https://nofriction.netlify.app/reports#token=...`
2. In web app, `GET /api/me` succeeds
3. Create moment and run snapshot:
   - `POST /api/moments` -> 201
   - `POST /api/snapshots/run` -> 200
4. Findings load and actions (`confirm/defer/resolve`) work
5. Extension connect + capture (`Alt+M`) works against Render API

## 7. Staged Rollout
1. Deploy Render backend and validate health/auth first
2. Switch Netlify `VITE_API_BASE` and validate web flows
3. Switch extension production API and validate extension flows
4. Keep Railway backend active for 24-48h as rollback safety
5. Monitor:
   - OAuth callback failures
   - DB connection errors (`PROTOCOL_CONNECTION_LOST`, timeouts)
   - 5xx rate
   - snapshot run failures

## 8. Rollback
1. Netlify: set `VITE_API_BASE` back to Railway backend URL, redeploy
2. Extension: set production API back to Railway URL, reload/republish
3. Google OAuth: set callback back to Railway callback if needed
4. Keep JWT issuer/audience/secret unchanged so user sessions remain valid

## 9. Post-Cutover Hardening
After stability window:
1. Remove Railway backend references from extension/client config
2. Optionally move API to custom domain and update callback/CORS/client base URL again
3. Move scheduler to dedicated worker/cron service before scaling beyond one backend instance
