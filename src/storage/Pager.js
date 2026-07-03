const fs = require('fs');

const PAGE_SIZE = 8192;
const HEADER_MAGIC = 'MDBP';

/**
 * Pager: manages fixed-size pages on disk for a single storage file.
 * Page 0 is reserved as the header page: magic, pageCount, freeListHead, rootPage.
 * Every other page holds a JSON-serialized B-tree node, padded/truncated to PAGE_SIZE.
 */
class Pager {
  constructor(filePath) {
    this.filePath = filePath;
    this.pageSize = PAGE_SIZE;
    this._openOrCreate();
  }

  _openOrCreate() {
    const exists = fs.existsSync(this.filePath);
    this.fd = fs.openSync(this.filePath, exists ? 'r+' : 'w+');
    if (!exists) {
      this.pageCount = 1; // page 0 is header
      this.freeListHead = -1;
      this.rootPage = -1;
      this._writeHeader();
    } else {
      this._readHeader();
    }
  }

  _readHeader() {
    const buf = Buffer.alloc(this.pageSize);
    fs.readSync(this.fd, buf, 0, this.pageSize, 0);
    const magic = buf.toString('utf8', 0, 4);
    if (magic !== HEADER_MAGIC) {
      throw new Error(`Corrupt storage file: bad magic in ${this.filePath}`);
    }
    this.pageCount = buf.readUInt32LE(4);
    this.freeListHead = buf.readInt32LE(8);
    this.rootPage = buf.readInt32LE(12);
  }

  _writeHeader() {
    const buf = Buffer.alloc(this.pageSize);
    buf.write(HEADER_MAGIC, 0, 'utf8');
    buf.writeUInt32LE(this.pageCount, 4);
    buf.writeInt32LE(this.freeListHead, 8);
    buf.writeInt32LE(this.rootPage, 12);
    fs.writeSync(this.fd, buf, 0, this.pageSize, 0);
  }

  setRootPage(pageNum) {
    this.rootPage = pageNum;
    this._writeHeader();
  }

  getRootPage() {
    return this.rootPage;
  }

  allocatePage() {
    let pageNum;
    if (this.freeListHead !== -1) {
      pageNum = this.freeListHead;
      const freed = this.readRaw(pageNum);
      this.freeListHead = freed.readInt32LE(0);
    } else {
      pageNum = this.pageCount;
      this.pageCount += 1;
    }
    this._writeHeader();
    return pageNum;
  }

  freePage(pageNum) {
    const buf = Buffer.alloc(this.pageSize);
    buf.writeInt32LE(this.freeListHead, 0);
    fs.writeSync(this.fd, buf, 0, this.pageSize, pageNum * this.pageSize);
    this.freeListHead = pageNum;
    this._writeHeader();
  }

  readRaw(pageNum) {
    const buf = Buffer.alloc(this.pageSize);
    fs.readSync(this.fd, buf, 0, this.pageSize, pageNum * this.pageSize);
    return buf;
  }

  readPage(pageNum) {
    const buf = this.readRaw(pageNum);
    const len = buf.readUInt32LE(0);
    if (len === 0) return null;
    const json = buf.toString('utf8', 4, 4 + len);
    return JSON.parse(json);
  }

  writePage(pageNum, obj) {
    const json = JSON.stringify(obj);
    const jsonBuf = Buffer.from(json, 'utf8');
    if (jsonBuf.length + 4 > this.pageSize) {
      throw new Error(
        `Node too large for page size (${jsonBuf.length + 4} > ${this.pageSize}). Reduce B-tree order or key size.`
      );
    }
    const buf = Buffer.alloc(this.pageSize);
    buf.writeUInt32LE(jsonBuf.length, 0);
    jsonBuf.copy(buf, 4);
    fs.writeSync(this.fd, buf, 0, this.pageSize, pageNum * this.pageSize);
  }

  flush() {
    fs.fsyncSync(this.fd);
  }

  close() {
    fs.closeSync(this.fd);
  }
}

module.exports = { Pager, PAGE_SIZE };
