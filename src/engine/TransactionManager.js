const crypto = require('crypto');

/**
 * Transaction semantics implemented here:
 *  - Single active writer transaction at a time (simple, easy to reason
 *    about correctness for; documented limitation vs. full MVCC).
 *  - Every op (PUT/DELETE) is WAL-logged at call time, *before* it is
 *    buffered - so the log always reflects intent even if the process
 *    dies mid-transaction.
 *  - Ops are buffered in memory and only actually applied to the B-tree
 *    /heap on commit(). Reads inside the transaction check the buffer
 *    first (read-your-own-writes) then fall through to committed state.
 *  - Recovery (WAL.replay) only re-applies entries belonging to
 *    transactions that have a COMMIT record, so a crash mid-transaction
 *    is equivalent to an automatic rollback -> atomicity across crashes.
 */
class TransactionManager {
  constructor(wal, collections) {
    this.wal = wal;
    this.collections = collections; // Map(name -> StorageEngine)
    this.active = null; // { txnId, ops: [{collection,type,key,doc}] }
  }

  begin() {
    if (this.active) {
      throw new Error('A transaction is already in progress (single-writer engine).');
    }
    const txnId = crypto.randomUUID();
    this.wal.append({ txnId, op: 'BEGIN' });
    this.active = { txnId, ops: [] };
    return txnId;
  }

  _requireActive(txnId) {
    if (!this.active || this.active.txnId !== txnId) {
      throw new Error(`No active transaction with id ${txnId}`);
    }
  }

  stagePut(txnId, collection, key, doc) {
    this._requireActive(txnId);
    this.wal.append({ txnId, op: 'PUT', collection, key, doc });
    this.active.ops.push({ collection, type: 'PUT', key, doc });
  }

  stageDelete(txnId, collection, key) {
    this._requireActive(txnId);
    this.wal.append({ txnId, op: 'DELETE', collection, key });
    this.active.ops.push({ collection, type: 'DELETE', key });
  }

  /** Read-your-own-writes lookup within the active transaction's buffer. */
  peek(txnId, collection, key) {
    if (!this.active || this.active.txnId !== txnId) return undefined;
    let result;
    for (const op of this.active.ops) {
      if (op.collection !== collection || op.key !== key) continue;
      result = op.type === 'PUT' ? { found: true, doc: op.doc } : { found: false };
    }
    return result; // undefined = no pending op for this key
  }

  commit(txnId) {
    this._requireActive(txnId);
    for (const op of this.active.ops) {
      const engine = this.collections.get(op.collection);
      if (op.type === 'PUT') engine._applyPut(op.key, op.doc);
      else engine._applyDelete(op.key);
    }
    this.wal.append({ txnId, op: 'COMMIT' });
    this.active = null;
  }

  rollback(txnId) {
    this._requireActive(txnId);
    this.wal.append({ txnId, op: 'ROLLBACK' });
    this.active = null;
  }

  isActive() {
    return this.active !== null;
  }
}

module.exports = { TransactionManager };
