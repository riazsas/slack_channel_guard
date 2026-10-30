'use strict';

require('dotenv').config();

const { loadConfig } = require('./config');
const { Store } = require('./store');
const { createMemberJoinedHandler } = require('./events');
const { createCommandHandler } = require('./commands');

// The bot needs exactly these scopes (see manifest.yml). Private channels only, no user token.
const REQUIRED_SCOPES = ['chat:write', 'commands', 'groups:read', 'groups:write'];

async function authTest(client, token, envName) {
  try {
    return await client.auth.test({ token });
  } catch (err) {
    const code = (err.data && err.data.error) || err.message;
    throw new Error(`${envName} was rejected by Slack (${code}). Check the token in .env.`);
  }
}

// Slack returns the token's scopes in a response header; skip the check if it is absent.
function checkScopes(authResponse, logger) {
  const scopes = authResponse.response_metadata && authResponse.response_metadata.scopes;
  if (!Array.isArray(scopes)) return;
  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  if (missing.length) {
    throw new Error(`SLACK_BOT_TOKEN is missing scope(s) ${missing.join(', ')}. Update the app from manifest.yml and reinstall it.`);
  }
  const extra = scopes.filter((s) => !REQUIRED_SCOPES.includes(s));
  if (extra.length) {
    logger.warn(`SLACK_BOT_TOKEN has scope(s) it does not need: ${extra.join(', ')}. Remove them and reinstall the app.`);
  }
}

async function main() {
  const config = loadConfig();

  const store = new Store(config.dataFile);
  await store.load();

  // Loaded after config validation so a missing .env fails with a readable message first.
  const { App, LogLevel } = require('@slack/bolt');
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
    // Without this Bolt verifies the token inside the constructor and a bad token
    // becomes an unhandled rejection instead of a readable startup error.
    deferInitialization: true,
  });
  const logger = app.logger;

  const bot = await authTest(app.client, config.botToken, 'SLACK_BOT_TOKEN');
  checkScopes(bot, logger);
  await app.init();
  const identity = { botUserId: bot.user_id };

  const deps = { store, config, identity, logger };
  app.event('member_joined_channel', createMemberJoinedHandler(deps));
  app.command('/channel-guard', createCommandHandler(deps));
  app.error(async (err) => logger.error(`Unhandled error: ${err.stack || err.message}`));

  await app.start();

  logger.info(`Channel Guard running in ${bot.team} as bot ${bot.user} (${identity.botUserId})`);
  for (const w of config.warnings) logger.warn(w);
  logger.info(`${store.lockedChannelIds().length} locked channel(s), ${store.inviterIds().length} authorized inviter(s), ` +
    `${config.botAdminIds.length} bot admin(s)`);
  if (config.dryRun) logger.warn('DRY_RUN is on: nobody will actually be removed');

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, shutting down`);
    try {
      await store.flush();
      await app.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`Channel Guard failed to start:\n${err.message}`);
  process.exit(1);
});
