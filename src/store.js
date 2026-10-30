'use strict';

const fs = require('fs');
const path = require('path');

function emptyState() {
  return { lockedChannels: {}, authorizedInviters: {} };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * In-memory state backed by a JSON file.
 * Writes go to a temp file that is renamed over the real one, and are serialized
 * so two quick commands can never interleave and corrupt the file.
 */
class Store {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.state = emptyState();
    this.writeChain = Promise.resolve();
  }

  async load() {
    let raw;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.state = emptyState();
        return;
      }
      throw err;
    }

    // Never fall back to empty state on a bad file: that would silently unlock every channel.
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `State file ${this.filePath} is not valid JSON (${err.message}). ` +
        'Fix or restore it before starting; refusing to start with empty state.'
      );
    }
    if (!isPlainObject(parsed) ||
        (parsed.lockedChannels !== undefined && !isPlainObject(parsed.lockedChannels)) ||
        (parsed.authorizedInviters !== undefined && !isPlainObject(parsed.authorizedInviters))) {
      throw new Error(
        `State file ${this.filePath} has an unexpected shape. ` +
        'Expected { "lockedChannels": {...}, "authorizedInviters": {...} }.'
      );
    }
    this.state = {
      lockedChannels: parsed.lockedChannels || {},
      authorizedInviters: parsed.authorizedInviters || {},
    };
  }

  save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const file = this.filePath;
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tmp, snapshot, 'utf8');
        await fs.promises.rename(tmp, file);
      });
    return this.writeChain;
  }

  /** Resolves once all pending writes have finished (used on shutdown). */
  flush() {
    return this.writeChain.catch(() => {});
  }

  isLocked(channelId) {
    return Object.prototype.hasOwnProperty.call(this.state.lockedChannels, channelId);
  }

  getLock(channelId) {
    return this.isLocked(channelId) ? this.state.lockedChannels[channelId] : null;
  }

  async lock(channelId, lockedBy) {
    if (this.isLocked(channelId)) return false;
    this.state.lockedChannels[channelId] = { lockedBy, lockedAt: new Date().toISOString() };
    await this.save();
    return true;
  }

  async unlock(channelId) {
    if (!this.isLocked(channelId)) return false;
    delete this.state.lockedChannels[channelId];
    await this.save();
    return true;
  }

  isInviter(userId) {
    return Object.prototype.hasOwnProperty.call(this.state.authorizedInviters, userId);
  }

  async addInviter(userId, addedBy) {
    if (this.isInviter(userId)) return false;
    this.state.authorizedInviters[userId] = { addedBy, addedAt: new Date().toISOString() };
    await this.save();
    return true;
  }

  async removeInviter(userId) {
    if (!this.isInviter(userId)) return false;
    delete this.state.authorizedInviters[userId];
    await this.save();
    return true;
  }

  lockedChannelIds() {
    return Object.keys(this.state.lockedChannels);
  }

  inviterIds() {
    return Object.keys(this.state.authorizedInviters);
  }
}

module.exports = { Store };
