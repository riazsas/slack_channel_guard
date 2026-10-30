# Channel Guard

Slack bot (Bolt + Socket Mode) that stops unauthorized members from adding people to **locked** private channels on non-Enterprise plans.

- **Production, security model, runbooks (VM access, token rotation, deploy, recovery):** [docs/TECHNICAL.md](docs/TECHNICAL.md)
- **For admins, inviters and members:** [docs/USER_GUIDE.md](docs/USER_GUIDE.md)

This README covers local development and the original setup.

## How it works

1. Listens for `member_joined_channel` (Slack includes the `inviter` user ID in the payload).
2. If the channel is locked, it allows the join when the **inviter** or the **joining user** is an authorized inviter / bot admin.
3. Otherwise the bot removes the user with `conversations.kick` (bot token, `groups:write`), then DMs the inviter explaining why.
4. `/channel-guard` manages locks and the allowlist. State is saved to a JSON file (atomic writes).

Edge-case behaviour:

- The bot is never removed.
- Private channels only: `/channel-guard lock` refuses public channels. The app has no user token and no public-channel scopes.
- No `inviter` in the event (self-join or channel creation): ignored and logged, unless `KICK_SELF_JOINS=true`.
- If a kick fails (e.g. bot not in channel, or `restricted_action` from workspace settings), the inviter is **not** told the user was removed; all `BOT_ADMIN_IDS` get a DM with the Slack error and a hint.
- Duplicate event deliveries are de-duplicated for 60 seconds.
- A corrupt state file stops startup rather than silently unlocking every channel.
- `DRY_RUN=true` logs what would happen without removing anyone. Use it for the first test.

## Setup checklist

### 1. Create the Slack app
- [ ] api.slack.com/apps -> **Create New App -> From an app manifest** -> pick the workspace -> paste `manifest.yml`.
- [ ] **Basic Information -> App-Level Tokens -> Generate** with scope `connections:write`. Copy the `xapp-` token.
- [ ] **Install App** to the workspace.
  - Bot User OAuth Token (`xoxb-`) is on the OAuth & Permissions page.
- [ ] Check **Settings & permissions -> Channel management**: the bot must be allowed to remove members from private channels, otherwise kicks fail with `restricted_action`.

### 2. Configure
- [ ] `cp .env.example .env` and fill in the two tokens.
- [ ] `BOT_ADMIN_IDS`: user IDs (Profile -> three dots -> Copy member ID) of people who may run `/channel-guard`.
- [ ] Optional: `LOG_CHANNEL_ID` for an audit trail (bot must be a member).

### 3. Run
```bash
npm install
npm test            # 15 offline tests, no Slack needed
DRY_RUN=true npm start
```
Startup logs the bot user and how many channels are locked, and refuses to start if the bot token lacks a required scope.

Docker (hardened run flags):
```bash
docker build -t slack-channel-guard .
docker run -d --name slack-channel-guard --env-file .env -e DATA_FILE=/data/state.json \
  -v slack-channel-guard-data:/data --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges --init \
  --memory 256m --cpus 0.5 --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=3 slack-channel-guard
```

> Persistence: mount `DATA_FILE`'s folder on a persistent volume. On hosts with ephemeral disks (Heroku, some PaaS) the JSON file is wiped on restart and all locks are lost.

### 4. Guard a channel
- [ ] In the private channel: `/invite @Channel Guard` 
- [ ] Run `/channel-guard lock`. It refuses with instructions if the bot isn't in the channel or the channel is public.
- [ ] `/channel-guard add @manager` for each person allowed to add people.

### 5. Smoke test (with `DRY_RUN=false`)
- [ ] As an unauthorized member, add a test user to the locked channel -> test user is removed within a second or two, you get a DM.
- [ ] As an authorized inviter, add the same user -> they stay.

## Commands (bot admins only; replies are visible only to you)

| Command | Effect |
|---|---|
| `/channel-guard lock [#channel]` | Guard the channel (default: current) |
| `/channel-guard unlock [#channel]` | Stop guarding |
| `/channel-guard add @user` / `remove @user` | Manage authorized inviters |
| `/channel-guard list` | Locked channels, admins, inviters |
| `/channel-guard status [#channel]` | Is it locked? |

Pick users/channels from Slack's autocomplete; the manifest enables `should_escape` so they arrive as IDs. Plain text like `@alice` is rejected.

## Known limitations

- Slack removes the person only after they've joined, so they briefly appear in the channel and may see a few seconds of history.
- Slack only sends the event for channels the bot is in, so a locked channel the bot has been removed from is unguarded.
- Already-present members aren't audited when you lock a channel; only new joins are checked.
- If the app is uninstalled or the bot token is revoked, kicks fail. Admins get a DM alert (if DMs still work).
- Treat both tokens like passwords: the bot token can remove people from every private channel the bot is in.

## Layout
```
manifest.yml        Slack app manifest
src/index.js        Bolt app, startup, wiring
src/events.js       member_joined_channel logic
src/commands.js     /channel-guard parser and handlers
src/store.js        JSON persistence
src/config.js       env validation
test/guard.test.js  offline tests with mocked Slack clients
```
