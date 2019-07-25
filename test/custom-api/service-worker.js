'use strict';

var registerWorkerPouch = require('../../worker');
// using in-memory so it will work in PhantomJS
var PouchDB = require('pouchdb-core')
  .plugin(require('pouchdb-adapter-memory'))
  .plugin(require('pouchdb-adapter-http'))
  .plugin(require('pouchdb-mapreduce'))
  .plugin(require('pouchdb-replication'))
  .plugin(require('pouchdb-find'));
var pouchCreator = function (opts) {
  opts.adapter = 'memory';
  return new PouchDB(opts);
};
registerWorkerPouch(self, pouchCreator);

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim()); // activate right now
});

