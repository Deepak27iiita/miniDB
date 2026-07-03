#!/usr/bin/env node
const readline = require('readline');
const path = require('path');
const vm = require('vm');
const { Database } = require('../engine/Database');

const dataDir = process.argv[2] || path.join(__dirname, '..', '..', 'data');
const db = new Database(dataDir);

console.log('MiniDB shell (Node.js + B-tree + WAL storage engine)');
console.log(`Data directory: ${dataDir}`);
console.log('Type JS-style commands, e.g.:');
console.log('  db.users.insertOne({ name: "Deepak", age: 21 })');
console.log('  db.users.find({ age: { $gt: 18 } })');
console.log('  db.users.createIndex("age")');
console.log('  show collections');
console.log('  help');
console.log('  exit\n');

// Proxy that lazily creates a collection accessor: db.<name>.<method>(...)
const dbProxy = new Proxy(
  {},
  {
    get(_target, collName) {
      return db.collection(String(collName));
    },
  }
);

let activeTxn = null;
const context = vm.createContext({
  db: dbProxy,
  console,
  beginTransaction: () => {
    activeTxn = db.beginTransaction();
    return activeTxn;
  },
  commitTransaction: () => {
    db.commitTransaction(activeTxn);
    activeTxn = null;
    return 'committed';
  },
  rollbackTransaction: () => {
    db.rollbackTransaction(activeTxn);
    activeTxn = null;
    return 'rolled back';
  },
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'minidb> ' });
rl.prompt();

rl.on('line', (line) => {
  const cmd = line.trim();
  if (!cmd) return rl.prompt();

  if (cmd === 'exit' || cmd === 'quit') {
    db.close();
    console.log('Database flushed and closed. Bye!');
    process.exit(0);
  }

  if (cmd === 'help') {
    console.log(`
Commands:
  show collections                 list all collections
  db.<coll>.insertOne({...})
  db.<coll>.insertMany([{...}, ...])
  db.<coll>.find({...}, {sort:{field:1}, limit:10})
  db.<coll>.findOne({...})
  db.<coll>.updateOne({filter}, {$set:{...}})
  db.<coll>.deleteOne({filter})
  db.<coll>.createIndex("field")
  db.<coll>.count()
  beginTransaction() / commitTransaction() / rollbackTransaction()
  exit
`);
    return rl.prompt();
  }

  if (cmd === 'show collections') {
    console.log(db.listCollections());
    return rl.prompt();
  }

  try {
    const result = vm.runInContext(cmd, context, { timeout: 5000 });
    if (result !== undefined) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
  rl.prompt();
});

rl.on('close', () => {
  db.close();
  process.exit(0);
});
