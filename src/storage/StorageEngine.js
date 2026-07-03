const fs = require('fs');
const path = require('path');
const { BTree } = require('./BTree');
const { Heap } = require('./Heap');

/**
 * StorageEngine owns the on-disk state for ONE collection:
 *  - heap:          append-only document bodies
 *  - primaryIndex:  B+Tree  _id -> heap offset
 *  - secondaryIndexes: Map(field -> B+Tree  fieldValue -> [ids...])
 *
 * It exposes _applyPut/_applyDelete which are the single choke point for
 * mutating on-disk state - both normal writes and WAL replay during
 * crash recovery go through these, so behavior is identical either way.
 */
class StorageEngine {
  constructor(baseDir, name) {
    this.name = name;
    this.dir = path.join(baseDir, name);
    fs.mkdirSync(this.dir, { recursive: true });
    this.metaPath = path.join(this.dir, 'meta.json');
    this.heap = new Heap(path.join(this.dir, 'data.heap'));
    this.primaryIndex = new BTree(path.join(this.dir, 'id.idx'), { order: 32 });
    this.secondaryIndexes = new Map();
    this._loadMeta();
  }

  _loadMeta() {
    if (fs.existsSync(this.metaPath)) {
      this.meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    } else {
      this.meta = { indexes: [] };
      this._saveMeta();
    }
    for (const field of this.meta.indexes) {
      this.secondaryIndexes.set(
        field,
        new BTree(path.join(this.dir, `idx_${field}.idx`), { order: 16 })
      );
    }
  }

  _saveMeta() {
    fs.writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2));
  }

  // ---------- index management ----------

  hasIndex(field) {
    return this.secondaryIndexes.has(field);
  }

  createIndex(field) {
    if (this.hasIndex(field)) return;
    const tree = new BTree(path.join(this.dir, `idx_${field}.idx`), { order: 16 });
    for (const [, offset] of this.primaryIndex.scanAll()) {
      const doc = this.heap.read(offset);
      if (Object.prototype.hasOwnProperty.call(doc, field)) {
        this._indexAdd(tree, doc[field], doc._id);
      }
    }
    this.secondaryIndexes.set(field, tree);
    this.meta.indexes.push(field);
    this._saveMeta();
  }

  listIndexes() {
    return [...this.meta.indexes];
  }

  _indexAdd(tree, value, id) {
    const existing = tree.search(value) || [];
    if (!existing.includes(id)) {
      existing.push(id);
      tree.insert(value, existing);
    }
  }

  _indexRemove(tree, value, id) {
    const existing = tree.search(value);
    if (!existing) return;
    const filtered = existing.filter((x) => x !== id);
    if (filtered.length === 0) tree.delete(value);
    else tree.insert(value, filtered);
  }

  // ---------- core mutation (used by direct writes AND WAL replay) ----------

  _applyPut(id, doc) {
    const oldOffset = this.primaryIndex.search(id);
    const oldDoc = oldOffset !== undefined ? this.heap.read(oldOffset) : null;

    const offset = this.heap.append(doc);
    this.primaryIndex.insert(id, offset);

    for (const [field, tree] of this.secondaryIndexes) {
      if (oldDoc && Object.prototype.hasOwnProperty.call(oldDoc, field)) {
        this._indexRemove(tree, oldDoc[field], id);
      }
      if (Object.prototype.hasOwnProperty.call(doc, field)) {
        this._indexAdd(tree, doc[field], id);
      }
    }
  }

  _applyDelete(id) {
    const offset = this.primaryIndex.search(id);
    if (offset === undefined) return false;
    const doc = this.heap.read(offset);
    this.primaryIndex.delete(id);
    for (const [field, tree] of this.secondaryIndexes) {
      if (Object.prototype.hasOwnProperty.call(doc, field)) {
        this._indexRemove(tree, doc[field], id);
      }
    }
    return true;
  }

  // ---------- reads ----------

  getById(id) {
    const offset = this.primaryIndex.search(id);
    if (offset === undefined) return undefined;
    return this.heap.read(offset);
  }

  *scanAll() {
    for (const [, offset] of this.primaryIndex.scanAll()) {
      yield this.heap.read(offset);
    }
  }

  findIdsByIndex(field, value) {
    const tree = this.secondaryIndexes.get(field);
    if (!tree) return null; // no such index
    return tree.search(value) || [];
  }

  count() {
    let n = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _ of this.primaryIndex.scanAll()) n++;
    return n;
  }

  flush() {
    this.heap.flush();
    this.primaryIndex.flush();
    for (const tree of this.secondaryIndexes.values()) tree.flush();
  }

  close() {
    this.heap.close();
    this.primaryIndex.close();
    for (const tree of this.secondaryIndexes.values()) tree.close();
  }
}

module.exports = { StorageEngine };
