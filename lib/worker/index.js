'use strict';

/* jshint worker:true */

// This file gets workerified. It's the main worker script used in blob URLs.
const registerWorkerPouch = require('./core')
const PouchDB = require('pouchdb-core')
    .plugin(require('pouchdb-adapter-indexeddb'))
    .plugin(require('pouchdb-find'))

registerWorkerPouch(self, PouchDB)
