const { generateId } = require('./generateId');
const QueryEngine = require('./QueryEngine');

class Collection {
  constructor(name, storageEngine, txnManager) {
    this.name = name;
    this.storage = storageEngine;
    this.txnManager = txnManager;
  }

  // ---------- internal: run one write op, either inside an existing txn or auto-commit ----------
  _writePut(id, doc, txnId) {
    if (txnId) {
      this.txnManager.stagePut(txnId, this.name, id, doc);
    } else {
      const t = this.txnManager.begin();
      try {
        this.txnManager.stagePut(t, this.name, id, doc);
        this.txnManager.commit(t);
      } catch (e) {
        this.txnManager.rollback(t);
        throw e;
      }
    }
  }

  _writeDelete(id, txnId) {
    if (txnId) {
      this.txnManager.stageDelete(txnId, this.name, id);
    } else {
      const t = this.txnManager.begin();
      try {
        this.txnManager.stageDelete(t, this.name, id);
        this.txnManager.commit(t);
      } catch (e) {
        this.txnManager.rollback(t);
        throw e;
      }
    }
  }

  _readById(id, txnId) {
    if (txnId) {
      const pending = this.txnManager.peek(txnId, this.name, id);
      if (pending) return pending.found ? pending.doc : undefined;
    }
    return this.storage.getById(id);
  }

  // ---------- public API ----------

  insertOne(doc, { txnId } = {}) {
    if (doc._id !== undefined && this._readById(doc._id, txnId) !== undefined) {
      throw new Error(`Duplicate _id: ${doc._id}`);
    }
    const _id = doc._id !== undefined ? doc._id : generateId();
    const record = { ...doc, _id };
    this._writePut(_id, record, txnId);
    return record;
  }

  insertMany(docs, { txnId } = {}) {
    const useOwnTxn = !txnId;
    const t = useOwnTxn ? this.txnManager.begin() : txnId;
    try {
      const results = docs.map((d) => this.insertOne(d, { txnId: t }));
      if (useOwnTxn) this.txnManager.commit(t);
      return results;
    } catch (e) {
      if (useOwnTxn) this.txnManager.rollback(t);
      throw e;
    }
  }

  findOne(filter = {}, { txnId } = {}) {
    for (const doc of this._candidateScan(filter)) {
      const live = this._liveView(doc, txnId);
      if (live && QueryEngine.matches(live, filter)) return live;
    }
    return null;
  }

  find(filter = {}, options = {}) {
    const { sort, limit, skip = 0, projection, txnId } = options;
    let results = [];
    for (const doc of this._candidateScan(filter)) {
      const live = this._liveView(doc, txnId);
      if (live && QueryEngine.matches(live, filter)) results.push(live);
    }
    if (sort) results = QueryEngine.applySort(results, sort);
    if (skip) results = results.slice(skip);
    if (limit !== undefined) results = results.slice(0, limit);
    if (projection) results = results.map((d) => QueryEngine.applyProjection(d, projection));
    return results;
  }

  countDocuments(filter = {}) {
    return this.find(filter).length;
  }

  updateOne(filter, update, { txnId } = {}) {
    const doc = this.findOne(filter, { txnId });
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    const updated = applyUpdate(doc, update);
    this._writePut(doc._id, updated, txnId);
    return { matchedCount: 1, modifiedCount: 1, doc: updated };
  }

  updateMany(filter, update, { txnId } = {}) {
    const useOwnTxn = !txnId;
    const t = useOwnTxn ? this.txnManager.begin() : txnId;
    try {
      const docs = this.find(filter, { txnId: t });
      for (const doc of docs) {
        const updated = applyUpdate(doc, update);
        this._writePut(doc._id, updated, t);
      }
      if (useOwnTxn) this.txnManager.commit(t);
      return { matchedCount: docs.length, modifiedCount: docs.length };
    } catch (e) {
      if (useOwnTxn) this.txnManager.rollback(t);
      throw e;
    }
  }

  deleteOne(filter, { txnId } = {}) {
    const doc = this.findOne(filter, { txnId });
    if (!doc) return { deletedCount: 0 };
    this._writeDelete(doc._id, txnId);
    return { deletedCount: 1 };
  }

  deleteMany(filter, { txnId } = {}) {
    const useOwnTxn = !txnId;
    const t = useOwnTxn ? this.txnManager.begin() : txnId;
    try {
      const docs = this.find(filter, { txnId: t });
      for (const doc of docs) this._writeDelete(doc._id, t);
      if (useOwnTxn) this.txnManager.commit(t);
      return { deletedCount: docs.length };
    } catch (e) {
      if (useOwnTxn) this.txnManager.rollback(t);
      throw e;
    }
  }

  createIndex(field) {
    this.storage.createIndex(field);
    return { field, indexed: true };
  }

  listIndexes() {
    return this.storage.listIndexes();
  }

  count() {
    return this.storage.count();
  }

  // ---------- helpers ----------

  /** Picks the cheapest access path: equality on an indexed field, else full scan. */
  *_candidateScan(filter) {
    const eqField = Object.keys(filter || {}).find(
      (k) => this.storage.hasIndex(k) && (typeof filter[k] !== 'object' || filter[k] === null)
    );
    if (eqField) {
      const ids = this.storage.findIdsByIndex(eqField, filter[eqField]) || [];
      for (const id of ids) {
        const doc = this.storage.getById(id);
        if (doc) yield doc;
      }
      return;
    }
    yield* this.storage.scanAll();
  }

  /** Overlay committed doc with any pending write from the given transaction. */
  _liveView(doc, txnId) {
    if (!txnId) return doc;
    const pending = this.txnManager.peek(txnId, this.name, doc._id);
    if (!pending) return doc;
    return pending.found ? pending.doc : null;
  }
}

function applyUpdate(doc, update) {
  let result = { ...doc };
  const hasOperators = Object.keys(update).some((k) => k.startsWith('$'));
  if (!hasOperators) {
    return { ...update, _id: doc._id };
  }
  if (update.$set) Object.assign(result, update.$set);
  if (update.$unset) for (const k of Object.keys(update.$unset)) delete result[k];
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) {
      result[k] = (result[k] || 0) + v;
    }
  }
  if (update.$push) {
    for (const [k, v] of Object.entries(update.$push)) {
      result[k] = Array.isArray(result[k]) ? [...result[k], v] : [v];
    }
  }
  result._id = doc._id;
  return result;
}

module.exports = { Collection };
