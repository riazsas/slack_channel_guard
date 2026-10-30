'use strict';

// With should_escape: true Slack sends <#C123|name> and <@U123|name>.
const CHANNEL_REF = /^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/;
const USER_REF = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/;

function parseChannel(text) {
  const m = CHANNEL_REF.exec((text || '').trim());
  return m ? m[1] : null;
}

function parseUser(text) {
  const m = USER_REF.exec((text || '').trim());
  return m ? m[1] : null;
}

const HELP = [
  '*Channel Guard* (bot admins only)',
  '`/channel-guard lock [#channel]` - guard a private channel (default: this one; public channels are refused)',
  '`/channel-guard unlock [#channel]` - stop guarding it',
  '`/channel-guard add @user` - allow someone to add people to locked channels',
  '`/channel-guard remove @user` - revoke that permission',
  '`/channel-guard list` - show locked channels, admins and inviters',
  '`/channel-guard status [#channel]` - is a channel locked?',
  'Pick channels and people from the autocomplete; typed text like `@alice` is not accepted.',
].join('\n');

const PUBLIC_CHANNEL_REFUSAL =
  'Not locked. Channel Guard only guards *private* channels; this one is public (anyone can join it).';

async function fetchAllMembers(client, channel) {
  const members = new Set();
  let cursor;
  do {
    const res = await client.conversations.members({ channel, cursor, limit: 1000 });
    for (const id of res.members || []) members.add(id);
    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor);
  return members;
}

/**
 * Builds the /channel-guard handler.
 * deps: { store, config, identity: { botUserId }, logger }
 */
function createCommandHandler({ store, config, identity, logger }) {
  // Resolves the channel argument; null arg means "the channel the command was run in".
  function resolveChannel(arg, command) {
    if (!arg) return { id: command.channel_id };
    const id = parseChannel(arg);
    return id ? { id } : { error: `"${arg}" is not a channel. Pick it from the autocomplete, e.g. \`/channel-guard lock #my-channel\`.` };
  }

  async function lock(arg, command, client) {
    const ch = resolveChannel(arg, command);
    if (ch.error) return ch.error;
    if (!/^[CG]/.test(ch.id)) return 'Channels can only be locked from inside a channel (not a DM), or by naming one.';
    if (store.isLocked(ch.id)) return `<#${ch.id}> is already locked.`;

    // Private channels only. The bot has no channels:read scope, so Slack answers
    // missing_scope for a public channel; channel_not_found means a private channel
    // the bot is not in.
    let info;
    try {
      info = await client.conversations.info({ channel: ch.id });
    } catch (err) {
      const code = (err.data && err.data.error) || err.message;
      logger.warn(`lock ${ch.id}: conversations.info failed: ${code}`);
      if (code === 'missing_scope') return PUBLIC_CHANNEL_REFUSAL;
      return `I can't see <#${ch.id}> (\`${code}\`). If it is a private channel, run \`/invite @Channel Guard\` in it first.`;
    }
    if (!info.channel || !info.channel.is_private) return PUBLIC_CHANNEL_REFUSAL;

    let members;
    try {
      members = await fetchAllMembers(client, ch.id);
    } catch (err) {
      const code = (err.data && err.data.error) || err.message;
      logger.warn(`lock ${ch.id}: conversations.members failed: ${code}`);
      return `I can't see the members of <#${ch.id}> (\`${code}\`). Run \`/invite @Channel Guard\` in that channel first.`;
    }

    if (!members.has(identity.botUserId)) {
      return `Not locked. The bot (<@${identity.botUserId}>) is not in <#${ch.id}>. Run \`/invite @Channel Guard\` there, then run the command again.`;
    }

    await store.lock(ch.id, command.user_id);
    logger.info(`${command.user_id} locked ${ch.id}`);
    return `:lock: <#${ch.id}> is now locked. Only bot admins and authorized inviters can add people.`;
  }

  async function unlock(arg, command) {
    const ch = resolveChannel(arg, command);
    if (ch.error) return ch.error;
    if (!(await store.unlock(ch.id))) return `<#${ch.id}> was not locked.`;
    logger.info(`${command.user_id} unlocked ${ch.id}`);
    return `:unlock: <#${ch.id}> is unlocked.`;
  }

  async function add(arg, command) {
    const userId = parseUser(arg);
    if (!userId) return 'Usage: `/channel-guard add @user` (pick the person from the autocomplete).';
    if (config.botAdminIds.includes(userId)) return `<@${userId}> is a bot admin and is always authorized.`;
    if (!(await store.addInviter(userId, command.user_id))) return `<@${userId}> is already an authorized inviter.`;
    logger.info(`${command.user_id} added inviter ${userId}`);
    return `<@${userId}> can now add people to locked channels.`;
  }

  async function remove(arg, command) {
    const userId = parseUser(arg);
    if (!userId) return 'Usage: `/channel-guard remove @user` (pick the person from the autocomplete).';
    if (config.botAdminIds.includes(userId)) {
      return `<@${userId}> is a bot admin (set in BOT_ADMIN_IDS) and can't be removed with this command.`;
    }
    if (!(await store.removeInviter(userId))) return `<@${userId}> was not an authorized inviter.`;
    logger.info(`${command.user_id} removed inviter ${userId}`);
    return `<@${userId}> can no longer add people to locked channels.`;
  }

  function list() {
    const locked = store.lockedChannelIds();
    const inviters = store.inviterIds();
    return [
      `*Locked channels (${locked.length}):* ${locked.length ? locked.map((id) => `<#${id}>`).join(', ') : 'none'}`,
      `*Bot admins:* ${config.botAdminIds.map((id) => `<@${id}>`).join(', ')}`,
      `*Authorized inviters (${inviters.length}):* ${inviters.length ? inviters.map((id) => `<@${id}>`).join(', ') : 'none'}`,
      ...(config.dryRun ? ['_DRY_RUN is on: nobody is actually removed_'] : []),
    ].join('\n');
  }

  function status(arg, command) {
    const ch = resolveChannel(arg, command);
    if (ch.error) return ch.error;
    const lockInfo = store.getLock(ch.id);
    return lockInfo
      ? `:lock: <#${ch.id}> is locked (by <@${lockInfo.lockedBy}> at ${lockInfo.lockedAt}).`
      : `<#${ch.id}> is not locked.`;
  }

  return async function onCommand({ command, ack, respond, client }) {
    await ack();

    const reply = (text) => respond({ response_type: 'ephemeral', text });

    if (!config.botAdminIds.includes(command.user_id)) {
      await reply('Only Channel Guard admins can use this command.');
      return;
    }

    const [sub = 'help', arg, ...extra] = (command.text || '').trim().split(/\s+/).filter(Boolean);
    if (extra.length) {
      await reply(`Too many arguments.\n\n${HELP}`);
      return;
    }

    try {
      switch (sub.toLowerCase()) {
        case 'lock': await reply(await lock(arg, command, client)); break;
        case 'unlock': await reply(await unlock(arg, command)); break;
        case 'add': await reply(await add(arg, command)); break;
        case 'remove': await reply(await remove(arg, command)); break;
        case 'list': await reply(list()); break;
        case 'status': await reply(status(arg, command)); break;
        case 'help': await reply(HELP); break;
        default: await reply(`Unknown command "${sub}".\n\n${HELP}`);
      }
    } catch (err) {
      logger.error(`/channel-guard ${sub} failed: ${err.stack || err.message}`);
      await reply(`Something went wrong: ${err.message}`);
    }
  };
}

module.exports = { createCommandHandler, parseChannel, parseUser };
