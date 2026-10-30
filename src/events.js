'use strict';

const DEDUPE_WINDOW_MS = 60 * 1000;
const MAX_CONTACTS = 10;

const KICK_ERROR_HINTS = {
  not_in_channel: 'The bot is not in this channel. Run `/invite @Channel Guard` in it.',
  channel_not_found: 'The bot cannot see this channel. Run `/invite @Channel Guard` in it.',
  restricted_action: 'Workspace settings stop the bot from removing members. Check Settings & permissions -> Channel management -> who can remove members from private channels.',
  missing_scope: 'The bot token is missing groups:write. Update the app from manifest.yml and reinstall it.',
  cant_kick_self: 'Slack refused to let the bot remove itself. This should not happen; please report it.',
  invalid_auth: 'The bot token is invalid. Reinstall the app and update SLACK_BOT_TOKEN.',
  token_revoked: 'The bot token was revoked. Reinstall the app and update SLACK_BOT_TOKEN.',
  account_inactive: 'The app has been uninstalled or deactivated. Reinstall it and update SLACK_BOT_TOKEN.',
};

function slackErrorCode(err) {
  return (err && err.data && err.data.error) || (err && err.code) || (err && err.message) || 'unknown_error';
}

/**
 * Builds the member_joined_channel handler.
 * deps: { store, config, identity: { botUserId }, logger }
 */
function createMemberJoinedHandler({ store, config, identity, logger }) {
  const recent = new Map();

  const isAuthorized = (userId) =>
    Boolean(userId) && (config.botAdminIds.includes(userId) || store.isInviter(userId));

  function seenRecently(key) {
    const now = Date.now();
    for (const [k, t] of recent) {
      if (now - t > DEDUPE_WINDOW_MS) recent.delete(k);
    }
    if (recent.has(key)) return true;
    recent.set(key, now);
    return false;
  }

  function contactList() {
    const ids = [...new Set([...config.botAdminIds, ...store.inviterIds()])];
    const shown = ids.slice(0, MAX_CONTACTS).map((id) => `<@${id}>`).join(', ');
    const more = ids.length > MAX_CONTACTS ? ` and ${ids.length - MAX_CONTACTS} more` : '';
    return shown + more;
  }

  async function dm(client, userId, text) {
    try {
      await client.chat.postMessage({ channel: userId, text });
    } catch (err) {
      logger.error(`Could not DM ${userId}: ${slackErrorCode(err)}`);
    }
  }

  return async function onMemberJoined({ event, client }) {
    const { channel, user, inviter } = event;

    if (!store.isLocked(channel)) return;
    if (user === identity.botUserId) return;

    if (isAuthorized(user)) {
      logger.info(`Allowed ${user} in ${channel}: user is authorized`);
      return;
    }
    if (inviter && isAuthorized(inviter)) {
      logger.info(`Allowed ${user} in ${channel}: invited by authorized ${inviter}`);
      return;
    }
    if (!inviter && !config.kickSelfJoins) {
      logger.info(`Ignored self-join of ${user} in locked ${channel} (no inviter; KICK_SELF_JOINS=false)`);
      return;
    }

    // Slack can deliver the same event more than once. event_ts identifies one join,
    // so a genuinely new join of the same person is still checked.
    if (seenRecently(`${channel}:${user}:${event.event_ts || ''}`)) {
      logger.debug(`Duplicate event for ${user} in ${channel}, skipping`);
      return;
    }

    const who = inviter ? `added by ${inviter}` : 'self-join';
    if (config.dryRun) {
      logger.info(`[DRY_RUN] Would remove ${user} from ${channel} (${who})`);
      return;
    }

    try {
      // Uses the bot token (groups:write); the bot can only act in channels it is in.
      await client.conversations.kick({ channel, user });
    } catch (err) {
      const code = slackErrorCode(err);
      const hint = KICK_ERROR_HINTS[code] || 'See https://api.slack.com/methods/conversations.kick for this error.';
      logger.error(`Failed to remove ${user} from ${channel} (${who}): ${code}`);
      const text =
        `:warning: Channel Guard could not remove <@${user}> from <#${channel}>` +
        `${inviter ? ` (added by <@${inviter}>)` : ''}.\nSlack error: \`${code}\`\n${hint}`;
      await Promise.all(config.botAdminIds.map((id) => dm(client, id, text)));
      return;
    }

    logger.info(`Removed ${user} from ${channel} (${who})`);

    if (config.logChannelId) {
      try {
        await client.chat.postMessage({
          channel: config.logChannelId,
          text: `Removed <@${user}> from <#${channel}> ${inviter ? `(added by <@${inviter}>)` : '(joined without an invite)'}.`,
        });
      } catch (err) {
        logger.error(`Could not post to LOG_CHANNEL_ID ${config.logChannelId}: ${slackErrorCode(err)}`);
      }
    }

    if (inviter) {
      await dm(
        client,
        inviter,
        `<@${user}> was removed from <#${channel}> because membership of that channel is restricted. ` +
        `To add someone, ask one of: ${contactList()}.`
      );
    }
  };
}

module.exports = { createMemberJoinedHandler, KICK_ERROR_HINTS };
