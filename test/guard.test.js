'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/store');
const { createMemberJoinedHandler } = require('../src/events');
const { createCommandHandler, parseChannel, parseUser } = require('../src/commands');
const { loadConfig } = require('../src/config');

const identity = { botUserId: 'UBOT' };
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-guard-'));
  return path.join(dir, 'state.json');
}

function makeConfig(overrides = {}) {
  return {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    botAdminIds: ['UBOSS'],
    logChannelId: null,
    dataFile: 'unused',
    kickSelfJoins: false,
    dryRun: false,
    warnings: [],
    ...overrides,
  };
}

function mockClient({ kickError, memberPages = [[]], publicChannels = [], infoError } = {}) {
  const calls = { kick: [], post: [], members: [], info: [] };
  return {
    calls,
    conversations: {
      async kick(args) {
        calls.kick.push(args);
        if (kickError) {
          const err = new Error('An API error occurred: ' + kickError);
          err.data = { ok: false, error: kickError };
          throw err;
        }
        return { ok: true };
      },
      async info(args) {
        calls.info.push(args);
        if (infoError) {
          const err = new Error('An API error occurred: ' + infoError);
          err.data = { ok: false, error: infoError };
          throw err;
        }
        return { ok: true, channel: { id: args.channel, is_private: !publicChannels.includes(args.channel) } };
      },
      async members(args) {
        calls.members.push(args);
        const page = args.cursor ? Number(args.cursor) : 0;
        const next = page + 1 < memberPages.length ? String(page + 1) : '';
        return { ok: true, members: memberPages[page], response_metadata: { next_cursor: next } };
      },
    },
    chat: {
      async postMessage(args) {
        calls.post.push(args);
        return { ok: true };
      },
    },
  };
}

async function setup({ config: cfg, locked = ['GLOCKED'], inviters = [], client: clientOpts } = {}) {
  const store = new Store(tmpFile());
  await store.load();
  for (const ch of locked) await store.lock(ch, 'UBOSS');
  for (const u of inviters) await store.addInviter(u, 'UBOSS');
  const config = makeConfig(cfg);
  const client = mockClient(clientOpts);
  const deps = { store, config, identity, logger: silent };
  return {
    store, config, client,
    onJoin: createMemberJoinedHandler(deps),
    onCommand: createCommandHandler(deps),
  };
}

let ts = 0;
const joinEvent = (fields) => ({ type: 'member_joined_channel', channel: 'GLOCKED', event_ts: String(++ts), ...fields });

async function runCommand(onCommand, client, text, { user = 'UBOSS', channel = 'GLOCKED' } = {}) {
  const replies = [];
  let acked = false;
  await onCommand({
    command: { text, user_id: user, channel_id: channel },
    ack: async () => { acked = true; },
    respond: async (msg) => { replies.push(msg.text); },
    client,
  });
  assert.ok(acked, 'command must be acknowledged');
  return replies.join('\n');
}

test('joins to unlocked channels are ignored', async () => {
  const { onJoin, client } = await setup();
  await onJoin({ event: joinEvent({ channel: 'GOPEN', user: 'UNEW', inviter: 'URANDOM' }), client });
  assert.equal(client.calls.kick.length, 0);
  assert.equal(client.calls.post.length, 0);
});

test('unauthorized invite is kicked with the bot token and the inviter is DMed', async () => {
  const { onJoin, client } = await setup({ inviters: ['UMANAGER'], config: { logChannelId: 'CLOG' } });
  await onJoin({ event: joinEvent({ user: 'UNEW', inviter: 'URANDOM' }), client });

  // No token override: the client's own bot token is used.
  assert.deepEqual(client.calls.kick, [{ channel: 'GLOCKED', user: 'UNEW' }]);
  const audit = client.calls.post.find((p) => p.channel === 'CLOG');
  assert.match(audit.text, /Removed <@UNEW>/);
  const dm = client.calls.post.find((p) => p.channel === 'URANDOM');
  assert.match(dm.text, /restricted/);
  assert.match(dm.text, /<@UBOSS>/);
  assert.match(dm.text, /<@UMANAGER>/);
});

test('join is allowed when the inviter or the joining user is authorized', async () => {
  const { onJoin, client } = await setup({ inviters: ['UMANAGER'] });
  await onJoin({ event: joinEvent({ user: 'UNEW', inviter: 'UMANAGER' }), client });
  await onJoin({ event: joinEvent({ user: 'UNEW2', inviter: 'UBOSS' }), client });
  await onJoin({ event: joinEvent({ user: 'UMANAGER', inviter: 'URANDOM' }), client });
  assert.equal(client.calls.kick.length, 0);
});

test('the bot is never kicked', async () => {
  const { onJoin, client } = await setup();
  await onJoin({ event: joinEvent({ user: 'UBOT', inviter: 'URANDOM' }), client });
  assert.equal(client.calls.kick.length, 0);
});

test('self-joins are ignored by default and kicked when KICK_SELF_JOINS is on', async () => {
  const off = await setup();
  await off.onJoin({ event: joinEvent({ user: 'UNEW' }), client: off.client });
  assert.equal(off.client.calls.kick.length, 0);

  const on = await setup({ config: { kickSelfJoins: true } });
  await on.onJoin({ event: joinEvent({ user: 'UNEW' }), client: on.client });
  assert.equal(on.client.calls.kick.length, 1);
  assert.equal(on.client.calls.post.length, 0, 'no inviter to DM');
});

test('DRY_RUN never calls conversations.kick', async () => {
  const { onJoin, client } = await setup({ config: { dryRun: true } });
  await onJoin({ event: joinEvent({ user: 'UNEW', inviter: 'URANDOM' }), client });
  assert.equal(client.calls.kick.length, 0);
  assert.equal(client.calls.post.length, 0);
});

test('kick failure alerts every bot admin with the error and hint, inviter is not told', async () => {
  const { onJoin, client } = await setup({
    config: { botAdminIds: ['UBOSS', 'UBOSS2'] },
    client: { kickError: 'not_in_channel' },
  });
  await onJoin({ event: joinEvent({ user: 'UNEW', inviter: 'URANDOM' }), client });

  assert.deepEqual(client.calls.post.map((p) => p.channel).sort(), ['UBOSS', 'UBOSS2']);
  for (const p of client.calls.post) {
    assert.match(p.text, /not_in_channel/);
    assert.match(p.text, /not in this channel/);
  }
});

test('a duplicate delivery of the same event is handled once', async () => {
  const { onJoin, client } = await setup();
  const event = joinEvent({ user: 'UNEW', inviter: 'URANDOM' });
  await onJoin({ event, client });
  await onJoin({ event: { ...event }, client });
  assert.equal(client.calls.kick.length, 1);

  // A new join (new event_ts) of the same person is still checked.
  await onJoin({ event: joinEvent({ user: 'UNEW', inviter: 'URANDOM' }), client });
  assert.equal(client.calls.kick.length, 2);
});

test('/channel-guard is rejected for non-admins', async () => {
  const { onCommand, client, store } = await setup({ locked: [] });
  const reply = await runCommand(onCommand, client, 'lock', { user: 'URANDOM' });
  assert.match(reply, /Only Channel Guard admins/);
  assert.equal(store.isLocked('GLOCKED'), false);
});

test('lock refuses unless the bot is a member (paginated check)', async () => {
  const missing = await setup({ locked: [], client: { memberPages: [['UX'], ['UY']] } });
  const r1 = await runCommand(missing.onCommand, missing.client, 'lock');
  assert.match(r1, /Not locked/);
  assert.match(r1, /UBOT/);
  assert.equal(missing.client.calls.members.length, 2, 'all pages fetched');
  assert.equal(missing.store.isLocked('GLOCKED'), false);

  const ok = await setup({ locked: [], client: { memberPages: [['UX'], ['UBOT']] } });
  const r2 = await runCommand(ok.onCommand, ok.client, 'lock <#GOTHER|secret>');
  assert.match(r2, /now locked/);
  assert.equal(ok.store.isLocked('GOTHER'), true);
});

test('lock refuses public channels', async () => {
  // Bot has channels:read: Slack reports is_private: false.
  const visible = await setup({ locked: [], client: { publicChannels: ['CPUBLIC'], memberPages: [['UBOT']] } });
  assert.match(await runCommand(visible.onCommand, visible.client, 'lock <#CPUBLIC|general>'), /only guards \*private\* channels/);

  // Bot has no channels:read (the intended setup): Slack answers missing_scope.
  const hidden = await setup({ locked: [], client: { infoError: 'missing_scope', memberPages: [['UBOT']] } });
  assert.match(await runCommand(hidden.onCommand, hidden.client, 'lock <#CPUBLIC|general>'), /only guards \*private\* channels/);

  for (const { store, client } of [visible, hidden]) {
    assert.equal(store.isLocked('CPUBLIC'), false);
    assert.equal(client.calls.members.length, 0);
  }
});

test('config needs no admin user token and warns if one is left in .env', () => {
  const env = { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', BOT_ADMIN_IDS: 'U0123ABCD' };
  const cfg = loadConfig(env);
  assert.equal('adminUserToken' in cfg, false);
  assert.deepEqual(cfg.warnings, []);

  const leftover = loadConfig({ ...env, SLACK_ADMIN_USER_TOKEN: 'xoxp-old' });
  assert.match(leftover.warnings.join(' '), /SLACK_ADMIN_USER_TOKEN .*no longer used/);
});

test('add / remove / unlock persist to the JSON file', async () => {
  const { onCommand, client, store } = await setup();
  await runCommand(onCommand, client, 'add <@UMANAGER|manager>');
  await runCommand(onCommand, client, 'add <@UTEMP>');
  await runCommand(onCommand, client, 'remove <@UTEMP>');
  await runCommand(onCommand, client, 'unlock');

  const reloaded = new Store(store.filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.inviterIds(), ['UMANAGER']);
  assert.equal(reloaded.state.authorizedInviters.UMANAGER.addedBy, 'UBOSS');
  assert.equal(reloaded.isLocked('GLOCKED'), false);
});

test('plain-text names are rejected and DMs cannot be locked', async () => {
  assert.equal(parseChannel('<#C123ABC|general>'), 'C123ABC');
  assert.equal(parseChannel('#general'), null);
  assert.equal(parseUser('<@U123ABC|alice>'), 'U123ABC');
  assert.equal(parseUser('@alice'), null);

  const { onCommand, client, store } = await setup({ locked: [] });
  assert.match(await runCommand(onCommand, client, 'add @alice'), /Usage/);
  assert.match(await runCommand(onCommand, client, 'lock #general'), /not a channel/);
  assert.match(await runCommand(onCommand, client, 'lock', { channel: 'D123' }), /not a DM/);
  assert.equal(store.lockedChannelIds().length, 0);
});

test('a corrupt state file makes load() throw instead of resetting', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ "lockedChannels": { "G1": ');
  await assert.rejects(new Store(file).load(), /not valid JSON/);

  fs.writeFileSync(file, '[]');
  await assert.rejects(new Store(file).load(), /unexpected shape/);
});
