# Slack Channel Guard: technical documentation

Last verified: 2026-10-30 (production live, kick with bot token confirmed).

Slack Channel Guard is an internal Slack app that stops regular members of a **locked private
channel** from adding other people. Slack's native "limit channel invitations" setting is
Enterprise-only; this app is for Business+ and lower plans.

**Placeholders.** Environment-specific values are kept out of this repo. Replace them from the
team's private ops notes: `<PROJECT_ID>` (GCP project), `<STATIC_IP>` (VM external IP),
`<APP_ID>` (Slack app), `<BOT_USER_ID>`, `<ADMIN_USER_ID>` (Slack member IDs). Roles: the
**app owner** (Slack Workspace Admin who owns the app and adds token versions) and the
**project owner** (GCP Owner who manages IAM, secrets and firewall).

- [1. How it works](#1-how-it-works)
- [2. Production inventory](#2-production-inventory)
- [3. Security model](#3-security-model)
- [4. Repository layout](#4-repository-layout)
- [5. Configuration](#5-configuration)
- [6. Runbooks](#6-runbooks)
- [7. Troubleshooting](#7-troubleshooting)
- [8. Known limitations](#8-known-limitations)
- [9. Rebuild from scratch](#9-rebuild-from-scratch)
- [10. Open items](#10-open-items)

---

## 1. How it works

```
Slack  --(Socket Mode websocket, outbound only)-->  VM: systemd -> run.sh -> docker container (node)
                                                         |                       |
                                     Secret Manager <----+  tokens at start      +--> /data/state.json (volume)
                                                                                 +--> Cloud Logging (gcplogs)
```

1. The bot receives `member_joined_channel` events in real time over Socket Mode. The connection
   is **outbound** from the VM; nothing listens on a port, so the VM needs no inbound traffic.
2. If the channel is locked, the join is allowed when the **inviter or the joining user** is
   authorized (a `BOT_ADMIN_IDS` entry or someone added with `/channel-guard add`).
3. Otherwise the bot calls `conversations.kick` with its own bot token and DMs the inviter that
   membership is restricted, listing up to 10 people to ask.
4. `/channel-guard` (bot admins only, ephemeral replies) manages locks and the inviter list.
   State is a JSON file on a Docker volume.

Behaviour details:

| Situation | Result |
|---|---|
| Bot itself joins | Never kicked |
| Join with no `inviter` (self-join, e.g. channel browser) | Logged, ignored, unless `KICK_SELF_JOINS=true` |
| Kick fails | Every `BOT_ADMIN_IDS` user gets a DM with the Slack error code and a hint; inviter is not told |
| Same event delivered twice | De-duplicated per `channel:user:event_ts` for 60 s |
| `/channel-guard lock` on a public channel | Refused (`is_private: false`, or `missing_scope` because the bot has no `channels:read`) |
| `/channel-guard lock` where the bot is not a member | Refused (checked with paginated `conversations.members`) |
| Corrupt state file | Startup refuses; a silent reset would unlock every channel |
| Bot token missing a required scope | Startup refuses with a readable error; extra scopes produce a warning |
| `SLACK_ADMIN_USER_TOKEN` still set | Warning only; the variable is ignored |
| Slack Workspace Admins/Owners | **Not** exempt (app owner's decision); add them with `/channel-guard add` |

---

## 2. Production inventory

### Slack

| Item | Value |
|---|---|
| App | Channel Guard, App ID `<APP_ID>` (api.slack.com/apps) |
| Bot user | `channel_guard`, `<BOT_USER_ID>` |
| Bot scopes | `chat:write`, `commands`, `groups:read`, `groups:write`. **No user scopes.** |
| App-level token | name `vm`, scope `connections:write` |
| Event | `member_joined_channel` (Socket Mode) |
| Slash command | `/channel-guard` (`should_escape: true`) |
| App collaborators | App owner + project owner only |
| Bot admin (`BOT_ADMIN_IDS`) | `<ADMIN_USER_ID>` (app owner) |

### GCP (project `<PROJECT_ID>`)

| Resource | Name / value |
|---|---|
| VM | `slack-channel-guard`, zone `us-central1-c`, `e2-micro`, Debian 12, Shielded VM (secure boot, vTPM, integrity monitoring) |
| Static external IP | `slack-channel-guard-ip` = `<STATIC_IP>` (region `us-central1`) |
| Network / tag | network `default`, network tag `slack-channel-guard` |
| Firewall | `slack-channel-guard-allow-iap-ssh`: INGRESS allow tcp:22 from `35.235.240.0/20`, priority 1000, tag `slack-channel-guard` |
| | `slack-channel-guard-deny-all-ingress`: INGRESS deny all from `0.0.0.0/0`, priority 2000, tag `slack-channel-guard` |
| Service account | `slack-channel-guard-vm@<PROJECT_ID>.iam.gserviceaccount.com` |
| SA roles | project: `roles/logging.logWriter`; on the two secrets only: `roles/secretmanager.secretAccessor` |
| Secrets | `slack-bot-token` (`xoxb-`), `slack-app-token` (`xapp-`); app owner has `roles/secretmanager.secretVersionAdder` on both |
| VM metadata | `enable-oslogin=FALSE`, `block-project-ssh-keys=TRUE` (see [3.4](#34-vm-access)) |
| Logs | Cloud Logging, log `gcplogs-docker-driver` |

The project is shared: other VMs, their firewall rules and the auto-created `default-allow-*`
rules belong to other systems. **Do not modify or
delete them.** Our two firewall rules override the defaults for our tagged VM only.

### Files on the VM

| Path | Purpose | Owner / mode |
|---|---|---|
| `/opt/slack-channel-guard/run.sh` | Fetches tokens from Secret Manager, runs the container (copy of `deploy/run.sh`) | root, 0755 |
| `/etc/systemd/system/slack-channel-guard.service` | systemd unit (copy of `deploy/slack-channel-guard.service`) | root, 0644 |
| `/etc/slack-channel-guard/config.env` | Non-secret settings (`BOT_ADMIN_IDS`, `DRY_RUN`, ...). **No tokens.** | root, 0600 |
| Docker volume `slack-channel-guard-data` | `/data/state.json` in the container; on the host: `/var/lib/docker/volumes/slack-channel-guard-data/_data/state.json` | node user in container |
| `~/app` (deploying engineer's home) | Build context (source copy) | that user |
| Docker image `slack-channel-guard:local` | Running image | |

---

## 3. Security model

### 3.1 Tokens

| Token | Where it lives | What it can do |
|---|---|---|
| `xoxb-` bot token | Secret Manager `slack-bot-token` only | Post as the bot, read/kick members **only in private channels the bot is in** |
| `xapp-` app token | Secret Manager `slack-app-token` only | Open a Socket Mode connection (receive events and commands) |
| `xoxp-` user token | **Removed.** Revoked 2026-10-29. | (Previously acted as the app owner everywhere) |

- `run.sh` fetches both tokens at every start with the VM's service account and passes them to
  `docker run` via `-e NAME` (value taken from the environment, so tokens never appear in `ps`).
  No token file exists on disk. `--rm` deletes the container config (which includes env) on stop.
- Nobody except the token owner should ever see a token. **Never paste a token on a command line,
  into chat, or into a screenshot.** Use `--data-file=-` (stdin) to add secret versions.
- A leaked `xapp-` lets an attacker open a second Socket Mode connection; Slack then splits events
  between connections, so some joins would go unchecked. Revoke immediately (runbook 6.5).

### 3.2 Container

`Dockerfile` and `run.sh` enforce:

- Base `node:24.22.1-alpine` (includes the 21 Oct 2026 Node.js security release). Node 20 is EOL.
- `npm ci --omit=dev --ignore-scripts` from `package-lock.json`; npm, npx, corepack and yarn are
  deleted from the image afterwards.
- `.dockerignore` is an allowlist: only `package.json`, `package-lock.json`, `src/` enter the build.
- Runs as the non-root `node` user; app code is root-owned (read-only for the app).
- `--read-only` root filesystem; writable only `/data` (volume) and `/tmp` (tmpfs).
- `--cap-drop ALL`, `--security-opt no-new-privileges`, `--init`, `--memory 256m`, `--cpus 0.5`,
  `--pids-limit 100`.
- Logs go to Cloud Logging (`--log-driver gcplogs`); `docker logs` still works (local cache).

### 3.3 Network

- No inbound traffic except SSH (tcp:22) from Google's IAP range `35.235.240.0/20`. Everything
  else, including traffic from other VMs on `default`, is denied by the
  priority-2000 rule. Outbound is unrestricted (needed for Slack and Google APIs).
- Static IP `<STATIC_IP>` so Slack tokens can be restricted to it (see [10](#10-open-items)).

### 3.4 VM access

- SSH only through IAP: `gcloud compute ssh ... --tunnel-through-iap`. Requires
  `roles/iap.tunnelResourceAccessor`.
- **OS Login is disabled on this VM** (`enable-oslogin=FALSE`). Reason: the app owner's
  Google account belongs to a different Google organization than the project, and OS Login
  for external users needs `roles/compute.osLoginExternalUser` at the organization level.
  Instead, `gcloud compute ssh` adds the engineer's public key to **instance** metadata;
  project-wide keys are blocked (`block-project-ssh-keys=TRUE`).
  - Consequence: removing someone's IAM role does not remove their key. Offboarding must also
    remove their key from the instance metadata (runbook 6.9).
  - To switch back to OS Login later: grant `roles/compute.osLoginExternalUser` on the org (or
    use same-org accounts), then `gcloud compute instances add-metadata slack-channel-guard
    --zone=us-central1-c --metadata=enable-oslogin=TRUE` and remove the `ssh-keys` metadata.
- Don't add users to the `docker` group (equivalent to root). Use `sudo docker`.
- OS security updates: `unattended-upgrades` is on (Debian security origin). Docker CE comes from
  Docker's own apt repo and is **not** auto-updated; update it monthly (runbook 6.8).

### 3.5 GCP IAM

- The VM uses a dedicated service account with only log writing and access to its two secrets.
  The default Compute service account is never used.
- No service account keys exist. Do not create any.
- App owner's project roles: `compute.instanceAdmin` (beta), `compute.osAdminLogin`,
  `iam.serviceAccountUser`, `iap.tunnelResourceAccessor`, `viewer`. The app owner **cannot**
  create service accounts, secrets, firewall rules or IAM bindings; the project owner does those.

---

## 4. Repository layout

```
manifest.yml                     Slack app manifest (source of truth for scopes/events/command)
src/index.js                     Bolt app (Socket Mode), startup auth.test + scope check, wiring, shutdown
src/events.js                    member_joined_channel: allow / kick / DM logic
src/commands.js                  /channel-guard parser and handlers
src/store.js                     State + atomic JSON persistence (temp file + rename, serialized writes)
src/config.js                    Env validation with readable errors
test/guard.test.js               15 offline tests (node:test, mocked Slack clients)
Dockerfile, .dockerignore        Hardened image
deploy/run.sh                    VM start script (Secret Manager -> docker run)
deploy/slack-channel-guard.service   systemd unit
deploy/config.env.example        Template for /etc/slack-channel-guard/config.env
docs/                            This file and the user guide
```

Code style: CommonJS, `'use strict'`, no TypeScript, dependencies limited to `@slack/bolt` and
`dotenv`. Handlers are factories taking `{ store, config, identity, logger }` so tests need no Slack.

Local development:

```bash
npm ci
npm test          # must stay "node --test test/guard.test.js" (directory form fails on Node 22+)
npm start         # reads .env (dotenv)
```

Never commit `.env` or `data/`. `.env.example` must only contain placeholders. **Never run a
second instance against the production app**: Slack splits events between connections, causing
missed joins, double kicks and false failure alerts.

---

## 5. Configuration

`/etc/slack-channel-guard/config.env` on the VM (tokens are **not** here):

| Variable | Default | Meaning |
|---|---|---|
| `BOT_ADMIN_IDS` | (required) | Comma-separated Slack user IDs. Always authorized; only they can run `/channel-guard`. |
| `LOG_CHANNEL_ID` | empty | Channel ID for an audit post on every removal (bot must be a member) |
| `KICK_SELF_JOINS` | `false` | Also remove unauthorized users who join without an inviter |
| `DRY_RUN` | `false` in prod | `true`: log "Would remove ..." instead of kicking |

Set by `run.sh`: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (from Secret Manager), `DATA_FILE=/data/state.json`.

State file format:

```json
{ "lockedChannels":     { "C123": { "lockedBy": "U1", "lockedAt": "2026-10-30T01:14:00.000Z" } },
  "authorizedInviters": { "U2":   { "addedBy":  "U1", "addedAt":  "..." } } }
```

---

## 6. Runbooks

Laptop commands are for the Google Cloud SDK Shell (Windows cmd) unless noted; they also work in
bash. VM commands run in the SSH session.

### 6.1 Get access (new engineer)

Required project roles (granted by the project owner):
`roles/iap.tunnelResourceAccessor` and `roles/compute.instanceAdmin.v1` (to add your SSH key to
the instance metadata), plus `roles/iam.serviceAccountUser` on
`slack-channel-guard-vm@<PROJECT_ID>.iam.gserviceaccount.com`. To add token versions:
`roles/secretmanager.secretVersionAdder` on the two secrets.

```
gcloud auth login
gcloud config set project <PROJECT_ID>
```

### 6.2 Connect to the VM

```
gcloud compute ssh slack-channel-guard --zone=us-central1-c --tunnel-through-iap
```

- First run creates an SSH key (Windows: PuTTY; accept "store key in cache").
- On Windows the SDK Shell window hosts the IAP tunnel; closing it closes the session. The bot
  keeps running regardless.
- In PuTTY, right-click pastes.

### 6.3 Status, logs, restart

```bash
sudo systemctl status slack-channel-guard          # service state
sudo docker logs --tail 50 slack-channel-guard     # recent log
sudo docker logs -f slack-channel-guard            # follow (Ctrl+C stops viewing only)
sudo systemctl restart slack-channel-guard         # restart (re-fetches tokens)
sudo systemctl stop slack-channel-guard            # stop (stays stopped until start)
sudo journalctl -u slack-channel-guard -n 50 --no-pager   # startup failures (run.sh, gcloud)
```

Without SSH (from a laptop with Viewer):

```
gcloud logging read "logName=\"projects/<PROJECT_ID>/logs/gcplogs-docker-driver\"" --freshness=1h --limit=20 --format="value(timestamp,jsonPayload.message)"
```

A healthy start logs `Channel Guard running in <workspace> as bot channel_guard (<BOT_USER_ID>)`,
the number of locked channels/inviters/admins, then `Now connected to Slack`.

### 6.4 Rotate the bot token (`xoxb-`)

Do this on any suspicion of exposure (screenshot, chat, log, laptop loss).

1. api.slack.com/apps -> Channel Guard -> **OAuth & Permissions** -> **Revoke All OAuth Tokens**.
   The old token stops working immediately; the bot goes offline.
2. Same page -> **Install to Workspace** -> Allow. Copy the new **Bot User OAuth Token**.
3. Laptop:
   ```
   gcloud secrets versions add slack-bot-token --data-file=-
   ```
   Paste the token on the empty line, then Enter, Ctrl+Z, Enter (bash: Ctrl+D). Do not put the
   token on the command line. Expect `Created version [N]`.
4. VM: `sudo systemctl restart slack-channel-guard`, then check the log (6.3).
5. In Slack, confirm the bot is still a member of every locked channel (`/channel-guard list`,
   then check each channel's member list); `/invite @Channel Guard` where missing.
6. Optional cleanup (needs `secretmanager.secretVersionManager`, i.e. the project owner):
   `gcloud secrets versions disable <OLD_N> --secret=slack-bot-token`.

Note: reinstalling the app without revoking keeps the same `xoxb-` token. Revoke first.

### 6.5 Rotate the app-level token (`xapp-`)

1. api.slack.com/apps -> Channel Guard -> **Basic Information** -> **App-Level Tokens** ->
   **Generate Token and Scopes**: name e.g. `vm-YYYYMMDD`, scope `connections:write`. Copy it.
   Leave **Token rotation off** (irreversible; the bot does not refresh tokens).
2. Laptop: `gcloud secrets versions add slack-app-token --data-file=-` (paste as in 6.4).
3. VM: `sudo systemctl restart slack-channel-guard`; confirm `Now connected to Slack`.
4. Slack: click the **old** token -> **Revoke**.

### 6.6 Verify the tokens the VM sees (without printing them)

```bash
gcloud secrets versions access latest --secret=slack-bot-token --project=<PROJECT_ID> | head -c 5; echo
gcloud secrets versions access latest --secret=slack-app-token --project=<PROJECT_ID> | head -c 5; echo
```

Expected `xoxb-` and `xapp-`. The VM's service account can read values but not list versions
(`PERMISSION_DENIED` on `versions list` is expected).

### 6.7 Change configuration (admins, dry run, self-joins)

```bash
sudo nano /etc/slack-channel-guard/config.env     # e.g. BOT_ADMIN_IDS=<ADMIN_USER_ID>,U0XXXXXXX
sudo systemctl restart slack-channel-guard
sudo docker logs --tail 10 slack-channel-guard
```

Find a Slack member ID: profile -> ⋮ -> Copy member ID. Inviters are managed in Slack with
`/channel-guard add|remove`, not here.

### 6.8 Deploy a new version / update the base image

Laptop (PowerShell or cmd, repo root):

```
npm test
tar -czf cg.tgz package.json package-lock.json Dockerfile .dockerignore src deploy
gcloud compute scp --zone=us-central1-c --tunnel-through-iap cg.tgz slack-channel-guard:cg.tgz
```

(`gcloud compute scp` with PuTTY can't copy several sources at once; hence the archive. Never
include `.env` or `data/`.)

VM:

```bash
rm -rf ~/app && mkdir ~/app && tar -xzf ~/cg.tgz -C ~/app && rm ~/cg.tgz
cd ~/app
TAG=$(date +%Y%m%d-%H%M)
sudo docker tag slack-channel-guard:local slack-channel-guard:previous 2>/dev/null || true
sudo docker build -t slack-channel-guard:$TAG -t slack-channel-guard:local .
sudo docker run --rm --entrypoint sh slack-channel-guard:local -c 'whoami; ls -A /app; which npm || echo "no npm"'
# expect: node / node_modules package-lock.json package.json src / no npm
# if deploy/ changed:
sudo install -m 0755 deploy/run.sh /opt/slack-channel-guard/run.sh
sudo install -m 0644 deploy/slack-channel-guard.service /etc/systemd/system/slack-channel-guard.service
sudo systemctl daemon-reload
sudo systemctl restart slack-channel-guard
sudo docker logs --tail 20 slack-channel-guard
```

Rollback:

```bash
sudo docker tag slack-channel-guard:previous slack-channel-guard:local
sudo systemctl restart slack-channel-guard
```

Node.js security releases: watch nodejs.org/en/blog/vulnerability. To update, change the `FROM`
tag in `Dockerfile` (same major line, 24.x), run `npm test` locally, deploy as above.

Monthly VM maintenance:

```bash
sudo apt-get update && sudo apt-get -y upgrade     # includes Docker CE
sudo docker image prune -f
sudo reboot                                        # service starts automatically
```

Dependency check (laptop): `npm audit --omit=dev`; fix with `npm audit fix`, re-test, deploy.

### 6.9 Offboard an engineer

1. Project owner removes their IAM roles (IAP, instance admin, secret version adder).
2. Remove their SSH key from the instance (OS Login is off, see 3.4):
   ```
   gcloud compute instances describe slack-channel-guard --zone=us-central1-c --format="value(metadata.items.ssh-keys)"
   ```
   Edit the list without their line and write it back with
   `gcloud compute instances add-metadata slack-channel-guard --zone=us-central1-c --metadata-from-file=ssh-keys=keys.txt`,
   or in the console: Compute Engine -> VM instances -> slack-channel-guard -> Edit -> SSH Keys.
3. If they ever had a token: rotate both (6.4, 6.5).
4. Remove them as a Slack app collaborator and from `BOT_ADMIN_IDS` if present.

### 6.10 Back up and restore state

The state is small (locks + inviters). Back up after larger changes:

```bash
sudo cat /var/lib/docker/volumes/slack-channel-guard-data/_data/state.json
```

Copy the JSON somewhere safe (it contains Slack IDs only, no secrets). Restore:

```bash
sudo systemctl stop slack-channel-guard
sudo nano /var/lib/docker/volumes/slack-channel-guard-data/_data/state.json   # paste, save
sudo systemctl start slack-channel-guard
```

An invalid file makes startup refuse (by design); check `docker logs`.

### 6.11 Emergency stop (kill switch)

Pick the smallest that works:

| Goal | Action |
|---|---|
| Stop kicking now, keep everything | VM: `sudo systemctl stop slack-channel-guard` |
| Watch without kicking | Set `DRY_RUN=true` (6.7) |
| Tokens may be compromised | Slack: OAuth & Permissions -> Revoke All OAuth Tokens; Basic Information -> revoke app-level tokens. Then rotate (6.4, 6.5) |
| Remove the app entirely | Slack: Install App -> Remove/Uninstall |
| Stop the VM | `gcloud compute instances stop slack-channel-guard --zone=us-central1-c` |

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Startup: `SLACK_BOT_TOKEN was rejected by Slack (invalid_auth / token_revoked)` | Token in Secret Manager is old or wrong. Rotate (6.4), check with 6.6. |
| Startup: `missing scope(s) ...` | App installed with an old manifest. Paste `manifest.yml` into App Manifest, Save, reinstall. |
| Startup: `Invalid configuration` | Fix `config.env` (6.7); message lists every problem. |
| Startup: state file `not valid JSON` / `unexpected shape` | Restore from backup (6.10). Do not delete the file blindly: that unlocks every channel. |
| `journalctl` shows `PERMISSION_DENIED` from gcloud | VM SA lost `secretAccessor` on a secret, or secret has no enabled version. Project owner fixes IAM. |
| Admins get DM `restricted_action` | Workspace setting blocks the bot from removing members: Slack admin -> Settings & permissions -> Channel management -> who can remove members from private channels. |
| Admins get DM `not_in_channel` / `channel_not_found` | Bot was removed from the channel. `/invite @Channel Guard` there. |
| Nobody is kicked, no log line | Channel not locked (`/channel-guard status`), bot not in channel, `DRY_RUN=true`, or the joining/inviting user is authorized. |
| Some joins are missed, double DMs, false alerts | A second instance is connected with the same app token (old laptop, test container). Stop it; rotate the app token (6.5) if unknown. |
| `/channel-guard` says "dispatch_failed" / no reply | Bot is offline. Check 6.3. |
| `gcloud compute ssh`: `osLoginExternalUser` error | OS Login got re-enabled on the VM; see 3.4. |
| `gcloud compute ssh` hangs | IAP firewall rule missing/disabled, VM stopped, or missing `iap.tunnelResourceAccessor`. |
| Long commands break in the Windows SDK Shell | Paste wraps into separate lines. Use `^` line continuations or short commands. |

---

## 8. Known limitations

- Slack only reports a join after it happened, so the person is briefly in the channel and may
  see a few seconds of history.
- Joins while the bot is offline are never caught up.
- Events only arrive for channels the bot is in. If someone removes the bot, the channel is unguarded.
- Existing members are not audited when a channel is locked.
- The inviter list is global (all locked channels), not per channel.
- Only one instance may run at a time.

---

## 9. Rebuild from scratch

Use when the VM or project is lost. Steps marked (owner) need project-owner rights.

1. (owner) Enable APIs:
   ```bash
   gcloud services enable compute.googleapis.com secretmanager.googleapis.com iap.googleapis.com logging.googleapis.com oslogin.googleapis.com
   ```
2. (owner) Service account and log writing:
   ```bash
   gcloud iam service-accounts create slack-channel-guard-vm --display-name="Slack Channel Guard VM"
   gcloud projects add-iam-policy-binding <PROJECT_ID> --member="serviceAccount:slack-channel-guard-vm@<PROJECT_ID>.iam.gserviceaccount.com" --role="roles/logging.logWriter" --condition=None
   ```
3. (owner) Secrets:
   ```bash
   for s in slack-bot-token slack-app-token; do
     gcloud secrets create "$s" --replication-policy=automatic
     gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:slack-channel-guard-vm@<PROJECT_ID>.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
     gcloud secrets add-iam-policy-binding "$s" --member="user:<ENGINEER_EMAIL>" --role="roles/secretmanager.secretVersionAdder"
   done
   ```
4. (owner) Static IP and firewall:
   ```bash
   gcloud compute addresses create slack-channel-guard-ip --region=us-central1
   gcloud compute firewall-rules create slack-channel-guard-allow-iap-ssh --network=default --direction=INGRESS --priority=1000 --action=ALLOW --rules=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=slack-channel-guard
   gcloud compute firewall-rules create slack-channel-guard-deny-all-ingress --network=default --direction=INGRESS --priority=2000 --action=DENY --rules=all --source-ranges=0.0.0.0/0 --target-tags=slack-channel-guard
   ```
   A new IP means updating the Slack IP allowlist.
5. Slack tokens: add versions to both secrets (6.4 step 3, 6.5 step 2).
6. Create the VM (Windows cmd; paste all lines at once):
   ```
   gcloud compute instances create slack-channel-guard ^
     --zone=us-central1-c --machine-type=e2-micro ^
     --image-family=debian-12 --image-project=debian-cloud ^
     --boot-disk-size=20GB --boot-disk-type=pd-standard ^
     --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring ^
     --service-account=slack-channel-guard-vm@<PROJECT_ID>.iam.gserviceaccount.com --scopes=cloud-platform ^
     --tags=slack-channel-guard --address=slack-channel-guard-ip ^
     --metadata=enable-oslogin=FALSE,block-project-ssh-keys=TRUE
   ```
   Verify (expect `e2-micro`, the tag and the dedicated SA; if any is wrong, delete and recreate):
   ```
   gcloud compute instances describe slack-channel-guard --zone=us-central1-c --format="value(machineType.basename(),tags.items,serviceAccounts[0].email)"
   ```
   (`--scopes=cloud-platform` is normal; access is limited by the SA's IAM roles.)
7. SSH in (6.2) and install updates and Docker:
   ```bash
   sudo apt-get update && sudo apt-get -y upgrade
   sudo apt-get install -y ca-certificates curl unattended-upgrades
   apt-config dump APT::Periodic::Unattended-Upgrade          # expect "1"
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" | sudo tee /etc/apt/sources.list.d/docker.list
   sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io
   sudo docker run --rm hello-world
   ```
8. Copy and build (6.8, first part), check tokens (6.6), then install:
   ```bash
   cd ~/app
   sudo mkdir -p /opt/slack-channel-guard /etc/slack-channel-guard
   sudo install -m 0755 deploy/run.sh /opt/slack-channel-guard/run.sh
   sudo install -m 0644 deploy/slack-channel-guard.service /etc/systemd/system/slack-channel-guard.service
   sudo install -m 0600 deploy/config.env.example /etc/slack-channel-guard/config.env   # DRY_RUN=true
   sudo systemctl daemon-reload
   sudo systemctl enable --now slack-channel-guard
   sudo docker logs -f slack-channel-guard
   ```
9. Restore state (6.10) or re-lock channels and re-add inviters in Slack. Test in `#guard-test`
   with `DRY_RUN=true`, then set `DRY_RUN=false` (6.7) and test a real kick.

---

## 10. Open items

- [ ] Slack: restrict API token usage to `<STATIC_IP>` (api.slack.com/apps -> OAuth &
      Permissions -> Restrict API Token Usage). Afterwards the bot token works only from the VM.
- [ ] Slack: revoke the old app-level token `socket` (if still listed).
- [ ] Delete `.env` from the app owner's laptop (contains revoked tokens only).
- [ ] Tell the project owner about the OS Login exception (3.4).
- [ ] Optional: pin the base image by digest (`FROM node:24.22.1-alpine@sha256:...`).
- [ ] Future (not requested): scheduled audit of joins missed while offline; per-channel
      allowlists; SQLite instead of JSON.
