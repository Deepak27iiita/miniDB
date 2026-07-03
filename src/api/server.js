const express = require('express');
const path = require('path');
const { Database } = require('../engine/Database');

function createServer(dataDir) {
  const db = new Database(dataDir);
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'web', 'public')));

  const wrap = (fn) => (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  };

  app.get('/api/collections', wrap((req, res) => {
    res.json({ collections: db.listCollections() });
  }));

  app.post('/api/:coll/insert', wrap((req, res) => {
    const coll = db.collection(req.params.coll);
    const body = req.body;
    const result = Array.isArray(body) ? coll.insertMany(body) : coll.insertOne(body);
    res.json({ result });
  }));

  app.post('/api/:coll/find', wrap((req, res) => {
    const coll = db.collection(req.params.coll);
    const { filter = {}, sort, limit, skip, projection } = req.body || {};
    res.json({ documents: coll.find(filter, { sort, limit, skip, projection }) });
  }));

  app.post('/api/:coll/findOne', wrap((req, res) => {
    const coll = db.collection(req.params.coll);
    res.json({ document: coll.findOne((req.body && req.body.filter) || {}) });
  }));

  app.post('/api/:coll/count', wrap((req, res) => {
    const coll = db.collection(req.params.coll);
    res.json({ count: coll.countDocuments((req.body && req.body.filter) || {}) });
  }));

  app.patch('/api/:coll/updateOne', wrap((req, res) => {
    const coll = db.collection(req.params.coll);
    const { filter = {}, update = {} } = req.body || {};
    res.json(coll.updateOne(filter, update));
  }));

  app.patch('/api/:coll/updateMany', wrap((req, res) => {
    const coll = db.collection(req.params.coll);
    const { filter = {}, update = {} } = req.body || {};
    res.json(coll.updateMany(filter, update));
  }));

  app.delete('/api/:coll/deleteOne', wrap((req, res) => {
    const coll = db.collection(req.params.coll);
    res.json(coll.deleteOne((req.body && req.body.filter) || {}));
  }));

  app.delete('/api/:coll/deleteMany', wrap((req, res) => {
    const coll = db.collection(req.params.coll);
    res.json(coll.deleteMany((req.body && req.body.filter) || {}));
  }));

  app.post('/api/:coll/index', wrap((req, res) => {
    const coll = db.collection(req.params.coll);
    res.json(coll.createIndex(req.body.field));
  }));

  app.get('/api/:coll/indexes', wrap((req, res) => {
    const coll = db.collection(req.params.coll);
    res.json({ indexes: coll.listIndexes() });
  }));

  // ---- transactions ----
  app.post('/api/tx/begin', wrap((req, res) => {
    res.json({ txnId: db.beginTransaction() });
  }));
  app.post('/api/tx/:id/commit', wrap((req, res) => {
    db.commitTransaction(req.params.id);
    res.json({ ok: true });
  }));
  app.post('/api/tx/:id/rollback', wrap((req, res) => {
    db.rollbackTransaction(req.params.id);
    res.json({ ok: true });
  }));
  app.post('/api/:coll/insert/tx/:id', wrap((req, res) => {
    const coll = db.collection(req.params.coll);
    res.json({ result: coll.insertOne(req.body, { txnId: req.params.id }) });
  }));

  app.get('/api/health', (req, res) => res.json({ status: 'ok', collections: db.listCollections() }));

  return { app, db };
}

if (require.main === module) {
  const dataDir = process.argv[2] || path.join(__dirname, '..', '..', 'data');
  const port = process.env.PORT || 4000;
  const { app, db } = createServer(dataDir);
  const server = app.listen(port, () => {
    console.log(`MiniDB REST API + web UI listening on http://localhost:${port}`);
    console.log(`Data directory: ${dataDir}`);
  });
  const shutdown = () => {
    console.log('\nShutting down, flushing database...');
    db.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer };
