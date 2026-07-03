const crypto = require('crypto');

/** 12-byte hex id: 4-byte timestamp + 8 random bytes, sorts roughly by creation time. */
function generateId() {
  const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  const random = crypto.randomBytes(8).toString('hex');
  return timestamp + random;
}

module.exports = { generateId };
