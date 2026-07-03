/**
 * Evaluates MongoDB-style query filters against a plain document.
 * Supported: implicit equality, $eq, $ne, $gt, $gte, $lt, $lte,
 *            $in, $nin, $exists, $regex, $and, $or, $not
 */
function matches(doc, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!cond.every((f) => matches(doc, f))) return false;
      continue;
    }
    if (key === '$or') {
      if (!cond.some((f) => matches(doc, f))) return false;
      continue;
    }
    if (key === '$not') {
      if (matches(doc, cond)) return false;
      continue;
    }
    const actual = getPath(doc, key);
    if (!matchValue(actual, cond)) return false;
  }
  return true;
}

function matchValue(actual, cond) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    for (const [op, val] of Object.entries(cond)) {
      switch (op) {
        case '$eq':
          if (!deepEqual(actual, val)) return false;
          break;
        case '$ne':
          if (deepEqual(actual, val)) return false;
          break;
        case '$gt':
          if (!(actual > val)) return false;
          break;
        case '$gte':
          if (!(actual >= val)) return false;
          break;
        case '$lt':
          if (!(actual < val)) return false;
          break;
        case '$lte':
          if (!(actual <= val)) return false;
          break;
        case '$in':
          if (!val.some((v) => deepEqual(actual, v))) return false;
          break;
        case '$nin':
          if (val.some((v) => deepEqual(actual, v))) return false;
          break;
        case '$exists':
          if (val && actual === undefined) return false;
          if (!val && actual !== undefined) return false;
          break;
        case '$regex':
          if (typeof actual !== 'string' || !new RegExp(val).test(actual)) return false;
          break;
        default:
          throw new Error(`Unknown query operator: ${op}`);
      }
    }
    return true;
  }
  return deepEqual(actual, cond);
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object') {
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function applySort(docs, sortSpec) {
  if (!sortSpec) return docs;
  const entries = Object.entries(sortSpec);
  return [...docs].sort((a, b) => {
    for (const [field, dir] of entries) {
      const av = getPath(a, field);
      const bv = getPath(b, field);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
    }
    return 0;
  });
}

function applyProjection(doc, projection) {
  if (!projection) return doc;
  const keys = Object.keys(projection);
  const include = keys.length > 0 && projection[keys[0]] === 1;
  if (include) {
    const out = { _id: doc._id };
    for (const k of keys) if (k !== '_id') out[k] = doc[k];
    return out;
  }
  const out = { ...doc };
  for (const k of keys) delete out[k];
  return out;
}

module.exports = { matches, applySort, applyProjection, getPath };
