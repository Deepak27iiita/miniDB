const fs = require('fs');

/**
 * Heap: simple append-only record store.
 * Format per record: [4-byte uint32 length][JSON utf8 bytes]
 * Returns byte offset of each written record; that offset is what gets
 * stored as the "value" in the primary B-tree index.
 * NOTE: updates/deletes leave old bytes as garbage (no compaction) -
 * a documented simplification, same class of trade-off as needing VACUUM
 * in Postgres or compaction in an LSM tree.
 */
class Heap {
  constructor(filePath) {
    this.filePath = filePath;
    const exists = fs.existsSync(filePath);
    this.fd = fs.openSync(filePath, exists ? 'r+' : 'w+');
    this.size = exists ? fs.fstatSync(this.fd).size : 0;
  }

  append(obj) {
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const buf = Buffer.alloc(4 + json.length);
    buf.writeUInt32LE(json.length, 0);
    json.copy(buf, 4);
    const offset = this.size;
    fs.writeSync(this.fd, buf, 0, buf.length, offset);
    this.size += buf.length;
    return offset;
  }

  read(offset) {
    const lenBuf = Buffer.alloc(4);
    fs.readSync(this.fd, lenBuf, 0, 4, offset);
    const len = lenBuf.readUInt32LE(0);
    const dataBuf = Buffer.alloc(len);
    fs.readSync(this.fd, dataBuf, 0, len, offset + 4);
    return JSON.parse(dataBuf.toString('utf8'));
  }

  flush() {
    fs.fsyncSync(this.fd);
  }

  close() {
    fs.closeSync(this.fd);
  }
}

module.exports = { Heap };
