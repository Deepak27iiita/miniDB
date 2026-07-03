const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Database } = require('../src/engine/Database');
const { BTree } = require('../src/storage/BTree');

const TMP = path.join(__dirname, '..', '.test-data');
if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
    passed++;
  } catch (e) {
    console.error(`FAIL  - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

console.log('B-Tree');
test('insert/search/split/delete correctness at scale', () => {
  const file = path.join(TMP, 'bt.idx');
  fs.mkdirSync(TMP, { recursive: true });
  const tree = new BTree(file, { order: 3 });
  const N = 300;
  const keys = Array.from({ length: N }, (_, i) => i).sort(() => Math.random() - 0.5);
  for (const k of keys) tree.insert(k, `v${k}`);
  for (let i = 0; i < N; i++) assert.strictEqual(tree.search(i), `v${i}`);
  const scanned = [...tree.scanAll()].map(([k]) => k);
  assert.strictEqual(scanned.length, N);
  for (let i = 1; i < scanned.length; i++) assert.ok(scanned[i] > scanned[i - 1]);
  for (let i = 0; i < 50; i++) tree.delete(i);
  for (let i = 0; i < 50; i++) assert.strictEqual(tree.search(i), undefined);
  tree.close();
});

console.log('Collection CRUD + query engine');
test('insert/find/update/delete + operators', () => {
  const db = new Database(path.join(TMP, 'db1'));
  const c = db.collection('items');
  c.insertMany([{ sku: 'A', price: 10 }, { sku: 'B', price: 25 }, { sku: 'C', price: 5 }]);
  assert.strictEqual(c.count(), 3);
  assert.strictEqual(c.find({ price: { $gte: 10 } }).length, 2);
  assert.strictEqual(c.find({ $or: [{ sku: 'A' }, { sku: 'C' }] }).length, 2);
  const upd = c.updateOne({ sku: 'B' }, { $inc: { price: 5 } });
  assert.strictEqual(upd.modifiedCount, 1);
  assert.strictEqual(c.findOne({ sku: 'B' }).price, 30);
  const del = c.deleteOne({ sku: 'C' });
  assert.strictEqual(del.deletedCount, 1);
  assert.strictEqual(c.count(), 2);
  db.close();
});

test('secondary index returns same results as full scan', () => {
  const db = new Database(path.join(TMP, 'db2'));
  const c = db.collection('people');
  c.createIndex('city');
  c.insertMany([
    { name: 'A', city: 'Lucknow' },
    { name: 'B', city: 'Delhi' },
    { name: 'C', city: 'Lucknow' },
  ]);
  const indexed = c.find({ city: 'Lucknow' }).map((d) => d.name).sort();
  assert.deepStrictEqual(indexed, ['A', 'C']);
  db.close();
});

console.log('Transactions');
test('commit makes writes visible, rollback discards them', () => {
  const db = new Database(path.join(TMP, 'db3'));
  const c = db.collection('acct');
  c.insertOne({ _id: 'x', balance: 100 });

  const t1 = db.beginTransaction();
  c.updateOne({ _id: 'x' }, { $set: { balance: 50 } }, { txnId: t1 });
  assert.strictEqual(c.findOne({ _id: 'x' }).balance, 100, 'uncommitted write must not be visible outside the txn');
  db.commitTransaction(t1);
  assert.strictEqual(c.findOne({ _id: 'x' }).balance, 50);

  const t2 = db.beginTransaction();
  c.updateOne({ _id: 'x' }, { $set: { balance: 999 } }, { txnId: t2 });
  db.rollbackTransaction(t2);
  assert.strictEqual(c.findOne({ _id: 'x' }).balance, 50);
  db.close();
});

console.log('Durability / crash recovery');
test('committed data survives process restart; uncommitted data does not', () => {
  const dir = path.join(TMP, 'db4');

  const dbPath = path.join(__dirname, '..', 'src/engine/Database').replace(/\\/g, '/');
  const dirEscaped = dir.replace(/\\/g, '/');

  const scriptPath = path.join(TMP, 'script.js');
  fs.writeFileSync(scriptPath, `
    const { Database } = require('${dbPath}');
    const db = new Database('${dirEscaped}');
    const c = db.collection('logs');
    c.insertOne({ _id: 'committed-1', msg: 'safe' });
    const t = db.beginTransaction();
    c.insertOne({ _id: 'ghost-1', msg: 'should vanish' }, { txnId: t });
    process.exit(0);
  `);
  
  execSync('node "' + scriptPath + '"');

  const db = new Database(dirEscaped);
  const c = db.collection('logs');
  
  const doc = c.findOne({ _id: 'committed-1' });
  
  assert.ok(doc, 'committed doc should survive restart');
  assert.strictEqual(c.findOne({ _id: 'ghost-1' }), null, 'uncommitted doc must not survive restart');
  db.close();
});

console.log(`\n${passed} test(s) passed.`);
fs.rmSync(TMP, { recursive: true, force: true });
