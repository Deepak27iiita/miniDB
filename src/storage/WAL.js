const fs = require('fs');
const readline = require('readline');

/**
 * Write-Ahead Log.
 * Every mutating operation is appended here (and fsync'd) BEFORE it is
 * applied to the B-tree pages. On startup, replay() reads the log and
 * re-applies any operations belonging to committed transactions that
 * were not yet checkpointed - this is how the engine survives a crash
 * between "operation applied in memory" and "pages flushed to disk".
 *
 * Log line format: JSON per line, e.g.
 *   {"lsn":1,"txnId":"t1","op":"BEGIN"}
 *   {"lsn":2,"txnId":"t1","op":"PUT","collection":"users","key":"...","doc":{...}}
 *   {"lsn":3,"txnId":"t1","op":"COMMIT"}
 */
class WAL {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, fs.existsSync(filePath) ? 'r+' : 'w+');
    this.lsn = this._recoverLsn();
  }

  _recoverLsn() {
    if (!fs.existsSync(this.filePath)) return 0;
    const content = fs.readFileSync(this.filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return 0;
    try {
      return JSON.parse(lines[lines.length - 1]).lsn;
    } catch {
      return lines.length;
    }
  }

  append(entry) {
    this.lsn += 1;
    const record = { lsn: this.lsn, ts: Date.now(), ...entry };
    const line = JSON.stringify(record) + '\n';
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd); // durability: entry is on disk before we return
    return record;
  }

  /** Read all entries currently in the log (for recovery / inspection). */
  readAll() {
    if (!fs.existsSync(this.filePath)) return [];
    const content = fs.readFileSync(this.filePath, 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  /**
   * Recovery: group entries by txnId, replay only fully-committed
   * transactions in order via applyFn(entry). Uncommitted ("in-flight at
   * crash time") transactions are discarded, giving atomicity across a
   * crash.
   */
  replay(applyFn) {
    const entries = this.readAll();
    const byTxn = new Map();
    for (const e of entries) {
      if (!byTxn.has(e.txnId)) byTxn.set(e.txnId, []);
      byTxn.get(e.txnId).push(e);
    }
    let replayed = 0;
    for (const [, txnEntries] of byTxn) {
      const committed = txnEntries.some((e) => e.op === 'COMMIT');
      if (!committed) continue;
      for (const e of txnEntries) {
        if (e.op === 'PUT' || e.op === 'DELETE') {
          applyFn(e);
          replayed++;
        }
      }
    }
    return replayed;
  }

  /** Truncate the log after a checkpoint (all pages safely flushed). */
  checkpoint() {
    fs.ftruncateSync(this.fd, 0);
    this.lsn = 0;
  }

  close() {
    fs.closeSync(this.fd);
  }
}

module.exports = { WAL };
