'use strict';

// no need for WebSQL when running in a worker
module.exports = require('pouchdb-core').plugin(require('pouchdb-adapter-indexeddb'))
