const fs = require('fs');
const path = require('path');
const { StorageEngine } = require('../storage/StorageEngine');
const { WAL } = require('../storage/WAL');
const { TransactionManager } = require('./TransactionManager');
const { Collection } = require('./Collection');

class Database {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.wal = new WAL(path.join(dataDir, 'db.wal'));
    this.engines = new Map(); // name -> StorageEngine
    this.collections = new Map(); // name -> Collection
    this.txnManager = new TransactionManager(this.wal, this.engines);

    this._loadExistingCollections();
    this._recover();
  }

  _loadExistingCollections() {
    if (!fs.existsSync(this.dataDir)) return;
    for (const entry of fs.readdirSync(this.dataDir, { withFileTypes: true })) {
      if (entry.isDirectory()) this._openCollection(entry.name);
    }
  }

  _openCollection(name) {
    if (this.engines.has(name)) return;
    const engine = new StorageEngine(this.dataDir, name);
    this.engines.set(name, engine);
    this.collections.set(name, new Collection(name, engine, this.txnManager));
  }

  /** Crash recovery: replay committed WAL entries, then checkpoint (truncate log). */
  _recover() {
    const replayed = this.wal.replay((entry) => {
      this._openCollection(entry.collection);
      const engine = this.engines.get(entry.collection);
      if (entry.op === 'PUT') engine._applyPut(entry.key, entry.doc);
      else if (entry.op === 'DELETE') engine._applyDelete(entry.key);
    });
    if (replayed > 0) {
      this.flush();
    }
    this.wal.checkpoint();
  }

  collection(name) {
    if (!this.collections.has(name)) this._openCollection(name);
    return this.collections.get(name);
  }

  listCollections() {
    return [...this.collections.keys()];
  }

  // ---------- transactions ----------
  beginTransaction() {
    return this.txnManager.begin();
  }
  commitTransaction(txnId) {
    this.txnManager.commit(txnId);
    this.flush();
  }
  rollbackTransaction(txnId) {
    this.txnManager.rollback(txnId);
  }

  flush() {
    for (const engine of this.engines.values()) engine.flush();
    this.wal.checkpoint();
  }

  close() {
    this.flush();
    for (const engine of this.engines.values()) engine.close();
    this.wal.close();
  }
}

module.exports = { Database };
