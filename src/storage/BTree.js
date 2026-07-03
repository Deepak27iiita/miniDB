const { Pager } = require('./Pager');

/**
 * Generic on-disk B+Tree.
 *  - Internal nodes: { leaf:false, keys:[k0..kn-1], children:[p0..pn] }
 *  - Leaf nodes:      { leaf:true, keys:[k0..kn-1], values:[v0..vn-1], next:pageNum|-1 }
 *  - Leaves are linked for fast range scans / full scans.
 *
 * Insert uses the classic bottom-up recursive approach: recurse to the
 * target leaf, insert, then split on the way back up if a node overflows.
 *
 * Delete is intentionally simple ("lazy delete"): the key/value pair is
 * removed from its leaf, but underflowing nodes are NOT merged or
 * rebalanced. This trades some space efficiency after heavy deletion for
 * a much smaller, easier-to-verify implementation - a common, documented
 * simplification in teaching/portfolio B-tree implementations.
 */
class BTree {
  constructor(filePath, { order = 5, compare = defaultCompare } = {}) {
    this.pager = new Pager(filePath);
    this.minDegree = order; // t
    this.maxKeys = 2 * order - 1;
    this.compare = compare;
  }

  // ---------- public API ----------

  search(key) {
    const rootPage = this.pager.getRootPage();
    if (rootPage === -1) return undefined;
    let node = this.pager.readPage(rootPage);
    while (!node.leaf) {
      const idx = this._findChildIndex(node, key);
      node = this.pager.readPage(node.children[idx]);
    }
    const pos = this._findKeyIndex(node.keys, key);
    if (pos < node.keys.length && this.compare(node.keys[pos], key) === 0) {
      return node.values[pos];
    }
    return undefined;
  }

  insert(key, value) {
    const rootPage = this.pager.getRootPage();
    if (rootPage === -1) {
      const leafPage = this.pager.allocatePage();
      this.pager.writePage(leafPage, { leaf: true, keys: [key], values: [value], next: -1 });
      this.pager.setRootPage(leafPage);
      return;
    }
    const result = this._insertRecursive(rootPage, key, value);
    if (result) {
      // root split: create new root
      const newRootPage = this.pager.allocatePage();
      this.pager.writePage(newRootPage, {
        leaf: false,
        keys: [result.promoteKey],
        children: [result.leftPage, result.rightPage],
      });
      this.pager.setRootPage(newRootPage);
    }
  }

  delete(key) {
    const rootPage = this.pager.getRootPage();
    if (rootPage === -1) return false;
    return this._deleteRecursive(rootPage, key);
  }

  /** Full ordered scan of all [key, value] pairs. */
  *scanAll() {
    yield* this.scanRange(undefined, undefined);
  }

  /** Ordered scan of [key, value] pairs with optional inclusive bounds. */
  *scanRange(minKey, maxKey) {
    const rootPage = this.pager.getRootPage();
    if (rootPage === -1) return;
    let node = this.pager.readPage(rootPage);
    while (!node.leaf) {
      const idx = minKey === undefined ? 0 : this._findChildIndex(node, minKey);
      node = this.pager.readPage(node.children[idx]);
    }
    while (node) {
      for (let i = 0; i < node.keys.length; i++) {
        const k = node.keys[i];
        if (minKey !== undefined && this.compare(k, minKey) < 0) continue;
        if (maxKey !== undefined && this.compare(k, maxKey) > 0) return;
        yield [k, node.values[i]];
      }
      node = node.next !== -1 ? this.pager.readPage(node.next) : null;
    }
  }

  flush() {
    this.pager.flush();
  }

  close() {
    this.pager.close();
  }

  // ---------- internals ----------

  _findKeyIndex(keys, key) {
    // first index i such that keys[i] >= key
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.compare(keys[mid], key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _findChildIndex(node, key) {
    let lo = 0, hi = node.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.compare(node.keys[mid], key) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _insertRecursive(pageNum, key, value) {
    const node = this.pager.readPage(pageNum);

    if (node.leaf) {
      const pos = this._findKeyIndex(node.keys, key);
      if (pos < node.keys.length && this.compare(node.keys[pos], key) === 0) {
        node.values[pos] = value; // overwrite existing key
        this.pager.writePage(pageNum, node);
        return null;
      }
      node.keys.splice(pos, 0, key);
      node.values.splice(pos, 0, value);

      if (node.keys.length <= this.maxKeys) {
        this.pager.writePage(pageNum, node);
        return null;
      }
      return this._splitLeaf(pageNum, node);
    }

    const idx = this._findChildIndex(node, key);
    const result = this._insertRecursive(node.children[idx], key, value);
    if (!result) return null;

    node.keys.splice(idx, 0, result.promoteKey);
    node.children.splice(idx + 1, 0, result.rightPage);

    if (node.keys.length <= this.maxKeys) {
      this.pager.writePage(pageNum, node);
      return null;
    }
    return this._splitInternal(pageNum, node);
  }

  _splitLeaf(pageNum, node) {
    const mid = Math.ceil(node.keys.length / 2);
    const rightKeys = node.keys.splice(mid);
    const rightValues = node.values.splice(mid);
    const rightPage = this.pager.allocatePage();
    const rightNode = { leaf: true, keys: rightKeys, values: rightValues, next: node.next };
    node.next = rightPage;
    this.pager.writePage(pageNum, node);
    this.pager.writePage(rightPage, rightNode);
    return { promoteKey: rightKeys[0], leftPage: pageNum, rightPage };
  }

  _splitInternal(pageNum, node) {
    const mid = Math.floor(node.keys.length / 2);
    const promoteKey = node.keys[mid];
    const rightKeys = node.keys.splice(mid + 1);
    const rightChildren = node.children.splice(mid + 1);
    node.keys.splice(mid); // drop promoted key from left
    const rightPage = this.pager.allocatePage();
    this.pager.writePage(pageNum, node);
    this.pager.writePage(rightPage, { leaf: false, keys: rightKeys, children: rightChildren });
    return { promoteKey, leftPage: pageNum, rightPage };
  }

  _deleteRecursive(pageNum, key) {
    const node = this.pager.readPage(pageNum);
    if (node.leaf) {
      const pos = this._findKeyIndex(node.keys, key);
      if (pos >= node.keys.length || this.compare(node.keys[pos], key) !== 0) {
        return false; // not found
      }
      node.keys.splice(pos, 1);
      node.values.splice(pos, 1);
      this.pager.writePage(pageNum, node);
      return true;
    }
    const idx = this._findChildIndex(node, key);
    return this._deleteRecursive(node.children[idx], key);
  }
}

function defaultCompare(a, b) {
  if (typeof a === typeof b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  // stable ordering across mixed types: numbers < strings < booleans < other
  const rank = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3);
  return rank(a) - rank(b);
}

module.exports = { BTree, defaultCompare };
