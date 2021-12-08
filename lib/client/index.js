'use strict';

// main script used with a blob-style worker
const WorkerPouchCore = require('./core')
const isSupportedBrowser = require('./is-supported-browser')
const workerCode = require('../workerified')

const dbNameToWorkerKey = () => 'root-worker'
const getWorkerKey = dbName => {
  if (typeof dbName === 'string' && dbName) {
    return dbNameToWorkerKey(dbName) || 'root-worker'
  }
  return 'root-worker'
}

function WorkerPouch (opts, callback) {
  const workerKey = getWorkerKey(opts.name)
  let worker = WorkerPouch.__pouchdb_global_workers[workerKey] // cache so there's only one
  if (!worker) {
    try {
      worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' })))
      worker.addEventListener('error', e => {
        if ('console' in global && 'warn' in console) {
          console.warn('worker threw an error', e.error)
        }
      })
      WorkerPouch.__pouchdb_global_workers[workerKey] = worker
    } catch (e) {
      if ('console' in global && 'info' in console) {
        console.info('This browser is not supported by WorkerPouch. '
          + 'Please use isSupportedBrowser() to check.', e)
      }
      throw new Error('browser unsupported by worker-pouch')
    }
  }

  const _opts = Object.assign({}, opts, {
    worker: function () { return worker; }
  });

  WorkerPouchCore.call(this, _opts, callback);
}
WorkerPouch.__pouchdb_global_workers = {}

WorkerPouch.valid = function () {
  return true
}
WorkerPouch.use_prefix = false


module.exports = funcOrPouchDB => {
  if (!funcOrPouchDB || funcOrPouchDB.plugin) {
    funcOrPouchDB.adapter('worker', WorkerPouch)
  } else {
    return PouchDB => PouchDB.adapter('worker', WorkerPouch)
  }
}

module.exports.isSupportedBrowser = isSupportedBrowser
