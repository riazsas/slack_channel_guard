'use strict';

const USER_ID = /^[UW][A-Z0-9]+$/;
const CHANNEL_ID = /^[CG][A-Z0-9]+$/;

function parseBool(name, value, errors) {
  const v = (value || '').trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0' || v === 'no') return false;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  errors.push(`${name} must be "true" or "false" (got "${value}")`);
  return false;
}

/**
 * Reads and validates configuration from the environment.
 * Throws a single Error listing every problem so the operator can fix them in one go.
 */
function loadConfig(env = process.env) {
  const errors = [];

  const token = (name, prefix) => {
    const v = (env[name] || '').trim();
    if (!v) errors.push(`${name} is required`);
    else if (!v.startsWith(prefix)) errors.push(`${name} must start with "${prefix}"`);
    return v;
  };

  const botToken = token('SLACK_BOT_TOKEN', 'xoxb-');
  const appToken = token('SLACK_APP_TOKEN', 'xapp-');

  // Non-fatal problems, logged at startup.
  const warnings = [];
  if ((env.SLACK_ADMIN_USER_TOKEN || '').trim()) {
    warnings.push('SLACK_ADMIN_USER_TOKEN is set but no longer used. Revoke that token and delete it from .env.');
  }

  const botAdminIds = [...new Set(
    (env.BOT_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
  )];
  if (botAdminIds.length === 0) {
    errors.push('BOT_ADMIN_IDS must list at least one Slack user ID (e.g. U0123ABCD)');
  }
  for (const id of botAdminIds) {
    if (!USER_ID.test(id)) errors.push(`BOT_ADMIN_IDS contains "${id}", which is not a Slack user ID`);
  }

  const logChannelId = (env.LOG_CHANNEL_ID || '').trim() || null;
  if (logChannelId && !CHANNEL_ID.test(logChannelId)) {
    errors.push(`LOG_CHANNEL_ID "${logChannelId}" is not a Slack channel ID (should start with C or G)`);
  }

  const dataFile = (env.DATA_FILE || '').trim() || './data/state.json';
  const kickSelfJoins = parseBool('KICK_SELF_JOINS', env.KICK_SELF_JOINS, errors);
  const dryRun = parseBool('DRY_RUN', env.DRY_RUN, errors);

  if (errors.length) {
    throw new Error(
      `Invalid configuration:\n  - ${errors.join('\n  - ')}\nCopy .env.example to .env and fill it in.`
    );
  }

  return { botToken, appToken, botAdminIds, logChannelId, dataFile, kickSelfJoins, dryRun, warnings };
}

module.exports = { loadConfig };
