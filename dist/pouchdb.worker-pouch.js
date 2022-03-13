(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.workerPouch = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(_dereq_,module,exports){
'use strict';

const getArguments = _dereq_(11)
const utils = _dereq_(22)
const merge = _dereq_(21)
const inherits = _dereq_(14)
const EE = _dereq_(12).EventEmitter

const { clone } = utils
const { listenerCount } = utils
const { once } = utils
const { guardedConsole } = utils

const { isDeleted } = merge
const { collectLeaves } = merge
const { collectConflicts } = merge

inherits(Changes, EE)

function tryCatchInChangeListener (self, change, pending, lastSeq) {
  // isolate try/catches to avoid V8 deoptimizations
  try {
    self.emit('change', change, pending, lastSeq)
  } catch (e) {
    guardedConsole('error', 'Error in .on("change", function):', e)
  }
}

function Changes (db, opts, callback) {
  EE.call(this)
  const self = this
  this.db = db
  opts = opts ? clone(opts) : {}
  const complete = opts.complete = once((err, resp) => {
    if (err) {
      if (listenerCount(self, 'error') > 0) {
        self.emit('error', err)
      }
    } else {
      self.emit('complete', resp)
    }
    self.removeAllListeners()
    db.removeListener('destroyed', onDestroy)
  })
  if (callback) {
    self.on('complete', resp => {
      callback(null, resp)
    })
    self.on('error', callback)
  }
  function onDestroy () {
    self.cancel()
  }
  db.once('destroyed', onDestroy)

  opts.onChange = function (change, pending, lastSeq) {
    /* istanbul ignore if */
    if (self.isCancelled) {
      return
    }
    tryCatchInChangeListener(self, change, pending, lastSeq)
  }

  const promise = new Promise((fulfill, reject) => {
    opts.complete = function (err, res) {
      if (err) {
        reject(err)
      } else {
        fulfill(res)
      }
    }
  })
  self.once('cancel', () => {
    db.removeListener('destroyed', onDestroy)
    opts.complete(null, { status: 'cancelled' })
  })
  this.then = promise.then.bind(promise)
  this.catch = promise.catch.bind(promise)
  this.then(result => {
    complete(null, result)
  }, complete)


  if (!db.taskqueue.isReady) {
    db.taskqueue.addTask(failed => {
      if (failed) {
        opts.complete(failed)
      } else if (self.isCancelled) {
        self.emit('cancel')
      } else {
        self.validateChanges(opts)
      }
    })
  } else {
    self.validateChanges(opts)
  }
}
Changes.prototype.cancel = function () {
  this.isCancelled = true
  if (this.db.taskqueue.isReady) {
    this.emit('cancel')
  }
}
function processChange (doc, metadata, opts) {
  let changeList = [{ rev: doc._rev }]
  if (opts.style === 'all_docs') {
    changeList = collectLeaves(metadata.rev_tree)
      .map(x => ({ rev: x.rev }))
  }
  const change = {
    id: metadata.id,
    changes: changeList,
    doc
  }

  if (isDeleted(metadata, doc._rev)) {
    change.deleted = true
  }
  if (opts.conflicts) {
    change.doc._conflicts = collectConflicts(metadata)
    if (!change.doc._conflicts.length) {
      delete change.doc._conflicts
    }
  }
  return change
}

Changes.prototype.validateChanges = function (opts) {
  const callback = opts.complete
  const self = this

  self.doChanges(opts)
}

Changes.prototype.doChanges = function (opts) {
  const self = this
  const callback = opts.complete

  opts = clone(opts)
  if ('live' in opts && !('continuous' in opts)) {
    opts.continuous = opts.live
  }
  opts.processChange = processChange

  if (opts.since === 'latest') {
    opts.since = 'now'
  }
  if (!opts.since) {
    opts.since = 0
  }
  if (opts.since === 'now') {
    this.db.info().then(info => {
      /* istanbul ignore if */
      if (self.isCancelled) {
        callback(null, { status: 'cancelled' })
        return
      }
      opts.since = info.update_seq
      self.doChanges(opts)
    }, callback)
    return
  }

  if (!('descending' in opts)) {
    opts.descending = false
  }

  // 0 and 1 should return 1 document
  opts.limit = opts.limit === 0 ? 1 : opts.limit
  opts.complete = callback
  const newPromise = this.db._changes(opts)
  /* istanbul ignore else */
  if (newPromise && typeof newPromise.cancel === 'function') {
    const { cancel } = self
    self.cancel = getArguments(function (args) {
      newPromise.cancel()
      cancel.apply(this, args)
    })
  }
}

exports.Changes = Changes

},{"11":11,"12":12,"14":14,"21":21,"22":22}],2:[function(_dereq_,module,exports){
'use strict';

const utils = _dereq_(8)
const clientUtils = _dereq_(5)
const uuid = _dereq_(9)
const errors = _dereq_(6)
const log = console.debug.bind(console)
const { Changes } = _dereq_(1)

const { preprocessAttachments } = clientUtils
const { encodeArgs } = clientUtils
const { adapterFun } = clientUtils

// Implements the PouchDB API for dealing with PouchDB instances over WW
function WorkerPouch (opts, callback) {
  const api = this

  if (typeof opts === 'string') {
    const slashIdx = utils.lastIndexOf(opts, '/')
    opts = {
      url: opts.substring(0, slashIdx),
      name: opts.substring(slashIdx + 1)
    }
  } else {
    opts = utils.clone(opts)
  }

  if ("production" !== 'production') {
    log('constructor called', opts)
  }

  // Aspirational. once https://github.com/pouchdb/pouchdb/issues/5200
  // is resolved, you'll be able to directly pass in a worker here instead of
  // a function that returns a worker.
  const worker = (opts.worker && typeof opts.worker === 'function') ? opts.worker() : opts.worker
  if (!worker || (!worker.postMessage && (!worker.controller || !worker.controller.postMessage))) {
    const workerOptsErrMessage = 'Error: you must provide a valid `worker` in `new PouchDB()`'
    console.error(workerOptsErrMessage)
    return callback(new Error(workerOptsErrMessage))
  }

  if (!opts.name) {
    const optsErrMessage = 'Error: you must provide a database name.'
    console.error(optsErrMessage)
    return callback(new Error(optsErrMessage))
  }

  function handleUncaughtError (content) {
    try {
      api.emit('error', content)
    } catch (err) {
      // TODO: it's weird that adapters should have to handle this themselves
      console.error(
        'The user\'s map/reduce function threw an uncaught error.\n'
        + 'You can debug this error by doing:\n'
        + 'myDatabase.on(\'error\', function (err) { debugger; });\n'
        + 'Please double-check your map/reduce function.'
      )
      console.error(content)
    }
  }

  function onReceiveMessage (message) {
    const { messageId } = message
    const messageType = message.type
    const { content } = message

    if (messageType === 'uncaughtError') {
      handleUncaughtError(content)
      return
    }

    const cb = api._callbacks[messageId]

    if (!cb) {
      if ("production" !== 'production') {
        log('duplicate message (ignoring)', messageId, messageType, content)
      }
      return
    }

    if ("production" !== 'production') {
      log('receive message', api._instanceId, messageId, messageType, content)
    }

    if (messageType === 'error') {
      delete api._callbacks[messageId]
      cb(content)
    } else if (messageType === 'success') {
      delete api._callbacks[messageId]
      cb(null, content)
    } else { // 'update'
      api._changesListeners[messageId](content)
    }
  }

  function workerListener (e) {
    if (e.data.id === api._instanceId) {
      onReceiveMessage(e.data)
    }
  }

  function postMessage (message) {
    /* istanbul ignore if */
    if (typeof worker.controller !== 'undefined') {
      // service worker, use MessageChannels because e.source is broken in Chrome < 51:
      // https://bugs.chromium.org/p/chromium/issues/detail?id=543198
      const channel = new MessageChannel()
      channel.port1.onmessage = workerListener
      worker.controller.postMessage(message, [channel.port2])
    } else {
      // web worker
      worker.postMessage(message)
    }
  }

  function sendMessage (type, args, callback) {
    if (api._destroyed) {
      return callback(new Error('this db was destroyed'))
    } if (api._closed) {
      return callback(new Error('this db was closed'))
    }
    const messageId = uuid()

    if ("production" !== 'production') {
      log('send message', api._instanceId, messageId, type, args)
    }

    api._callbacks[messageId] = callback
    const encodedArgs = encodeArgs(args)
    postMessage({
      id: api._instanceId,
      type,
      messageId,
      args: encodedArgs
    })

    if ("production" !== 'production') {
      log('message sent', api._instanceId, messageId)
    }
  }

  function sendRawMessage (messageId, type, args) {
    if ("production" !== 'production') {
      log('send message', api._instanceId, messageId, type, args)
    }

    const encodedArgs = encodeArgs(args)
    postMessage({
      id: api._instanceId,
      type,
      messageId,
      args: encodedArgs
    })

    if ("production" !== 'production') {
      log('message sent', api._instanceId, messageId)
    }
  }

  api.type = function () {
    return 'indexeddb'
  }

  api._remote = false

  api._id = adapterFun('id', callback => {
    sendMessage('id', [], callback)
  })
  api.compact = adapterFun('compact', (opts, callback) => {
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    sendMessage('compact', [opts], callback)
  })
  api._info = function (callback) {
    sendMessage('info', [], callback)
  }

  api.get = adapterFun('get', (id, opts, callback) => {
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    sendMessage('get', [id, opts], callback)
  })

  // hacky code necessary due to implicit breaking change in
  // https://github.com/pouchdb/pouchdb/commits/0ddeae6b
  api._get = function (id, opts, callback) {
    api.get(id, opts, (err, doc) => {
      if (err) {
        return callback(err)
      }
      callback(null, { doc })
    })
  }

  api.remove = adapterFun('remove', (docOrId, optsOrRev, opts, callback) => {
    let doc
    if (typeof optsOrRev === 'string') {
      // id, rev, opts, callback style
      doc = {
        _id: docOrId,
        _rev: optsOrRev
      }
      if (typeof opts === 'function') {
        callback = opts
        opts = {}
      }
    } else {
      // doc, opts, callback style
      doc = docOrId
      if (typeof optsOrRev === 'function') {
        callback = optsOrRev
        opts = {}
      } else {
        callback = opts
        opts = optsOrRev
      }
    }
    const rev = (doc._rev || opts.rev)

    sendMessage('remove', [doc._id, rev], callback)
  })
  api.getAttachment = adapterFun('getAttachment', (
    docId,
    attachmentId,
    opts,
    callback
  ) => {
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    sendMessage('getAttachment', [docId, attachmentId, opts], callback)
  })
  api.removeAttachment = adapterFun('removeAttachment', (
    docId,
    attachmentId,
    rev,
    callback
  ) => {
    sendMessage('removeAttachment', [docId, attachmentId, rev], callback)
  })

  // Add the attachment given by blob and its contentType property
  // to the document with the given id, the revision given by rev, and
  // add it to the database given by host.
  api.putAttachment = adapterFun('putAttachment', (
    docId,
    attachmentId,
    rev,
    blob,
    type,
    callback
  ) => {
    if (typeof type === 'function') {
      callback = type
      type = blob
      blob = rev
      rev = null
    }
    if (typeof type === 'undefined') {
      type = blob
      blob = rev
      rev = null
    }

    if (typeof blob === 'string') {
      let binary
      try {
        binary = atob(blob)
      } catch (err) {
        // it's not base64-encoded, so throw error
        return callback(errors.error(
          errors.BAD_ARG,
          'Attachments need to be base64 encoded'
        ))
      }
      blob = utils.createBlob([utils.binaryStringToArrayBuffer(binary)], { type })
    }

    const args = [docId, attachmentId, rev, blob, type]
    sendMessage('putAttachment', args, callback)
  })
  api.put = adapterFun('put', utils.getArguments(args => {
    let temp; let temptype; let
      opts
    let doc = args.shift()
    let id = '_id' in doc
    const callback = args.pop()
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      return callback(errors.error(errors.NOT_AN_OBJECT))
    }

    doc = utils.clone(doc)

    preprocessAttachments(doc).then(() => {
      while (true) {
        temp = args.shift()
        temptype = typeof temp
        if (temptype === 'string' && !id) {
          doc._id = temp
          id = true
        } else if (temptype === 'string' && id && !('_rev' in doc)) {
          doc._rev = temp
        } else if (temptype === 'object') {
          opts = utils.clone(temp)
        }
        if (!args.length) {
          break
        }
      }
      opts = opts || {}

      sendMessage('put', [doc, opts], callback)
    }).catch(callback)
  }))

  api.post = adapterFun('post', (doc, opts, callback) => {
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    opts = utils.clone(opts)

    sendMessage('post', [doc, opts], callback)
  })
  api._bulkDocs = function (req, opts, callback) {
    sendMessage('bulkDocs', [req, opts], callback)
  }

  api.find = adapterFun('find', (opts, callback) => {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {}
    }
    sendMessage('find', [opts], callback)
  })

  api.createIndex = adapterFun('createIndex', (opts, callback) => {
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    sendMessage('createIndex', [opts], callback)
  })

  api._allDocs = function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    sendMessage('allDocs', [opts], callback)
  }

  api._changes = function (opts) {
    opts = utils.clone(opts)

    if (opts.continuous) {
      const messageId = uuid()
      api._changesListeners[messageId] = opts.onChange
      api._callbacks[messageId] = opts.complete
      sendRawMessage(messageId, 'liveChanges', [opts])
      return {
        cancel () {
          sendRawMessage(messageId, 'cancelChanges', [])
        }
      }
    }

    sendMessage('changes', [opts], (err, res) => {
      if (err || res == null) {
        opts.complete(err)
        return callback(err)
      }
      res.results.forEach(change => {
        opts.onChange(change)
      })
      if (opts.returnDocs === false || opts.return_docs === false) {
        res.results = []
      }
      opts.complete(null, res)
    })
  }

  // Given a set of document/revision IDs (given by req), tets the subset of
  // those that do NOT correspond to revisions stored in the database.
  // See http://wiki.apache.org/couchdb/HttpPostRevsDiff
  api.revsDiff = adapterFun('revsDiff', (req, opts, callback) => {
    // If no options were given, set the callback to be the second parameter
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }

    sendMessage('revsDiff', [req, opts], callback)
  })
  api._viewCleanup = adapterFun('viewCleanup', callback => {
    sendMessage('viewCleanup', [], callback)
  })
  api._close = function (callback) {
    api._closed = true
    callback()
  }

  api.destroy = adapterFun('destroy', (opts, callback) => {
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    sendMessage('destroy', [], (err, res) => {
      if (err) {
        api.emit('error', err)
        return callback(err)
      }
      api._destroyed = true
      worker.removeEventListener('message', workerListener)
      api.emit('destroyed')
      callback(null, res)
    })
  })

  // api.name was added in pouchdb 6.0.0
  api._instanceId = api.name || opts.originalName
  api._callbacks = {}
  api._changesListeners = {}

  // TODO: remove this workaround when the changes filter plugin will be
  // removed from core
  api.changes = function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }

    opts = opts || {}

    // By default set return_docs to false if the caller has opts.live = true,
    // this will prevent us from collecting the set of changes indefinitely
    // resulting in growing memory
    opts.return_docs = ('return_docs' in opts) ? opts.return_docs : !opts.live

    return new Changes(this, opts, callback)
  }

  worker.addEventListener('message', workerListener)

  const workerOpts = {
    name: api._instanceId,
    auto_compaction: !!opts.auto_compaction,
    storage: opts.storage,
    adapter: opts.worker_adapter
  }
  if (opts.worker_adapter) {
    workerOpts.worker_adapter = opts.worker_adapter
  }
  if (opts.revs_limit) {
    workerOpts.revs_limit = opts.revs_limit
  }

  sendMessage('createDatabase', [workerOpts], err => {
    if (err) {
      return callback(err)
    }
    callback(null, api)
  })
}

// WorkerPouch is a valid adapter.
WorkerPouch.valid = function () {
  return true
}
WorkerPouch.use_prefix = false

module.exports = WorkerPouch

},{"1":1,"5":5,"6":6,"8":8,"9":9}],3:[function(_dereq_,module,exports){
(function (global){
'use strict';

// main script used with a blob-style worker
const WorkerPouchCore = _dereq_(2)
const isSupportedBrowser = _dereq_(4)
const workerCode = _dereq_(10)

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

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"10":10,"2":2,"4":4}],4:[function(_dereq_,module,exports){
(function (global){
'use strict';

module.exports = function isSupportedBrowser () {
  return Promise.resolve().then(() => {
    // synchronously throws in IE/Edge
    const workerCode = 'self.onmessage = ' + (
      function () {
        function error() {
          self.postMessage({ hasIndexedDB: false })
        }
        function success() {
          self.postMessage({ hasIndexedDB: true })
        }

        // This works on all devices/browsers, and uses IndexedDBShim as a final fallback
        if (typeof indexedDB !== 'undefined') {
          // Open (or create) the database
          const open = indexedDB.open('__my_test_db__', 1);

          // Create the schema
          open.onupgradeneeded = function() {
            const db = open.result
            db.createObjectStore('__store__', { keyPath: 'id' })
            db.onerror = error
          };

          open.onsuccess = function() {
            // Start a new transaction
            const db = open.result
            db.onerror = error
            const tx = db.transaction('__store__', 'readwrite')
            const store = tx.objectStore('__store__')

            // Test read write
            store.put({id: 4269, foo: 'bar'})
            store.get(4269)

            // Close the db when the transaction is done
            tx.oncomplete = function() {
              db.close()
              const del = indexedDB.deleteDatabase('__my_test_db__')
              del.onsuccess = success
              del.onerror = error
            }
            tx.onerror = error
          }

          open.onerror = error
        } else {
          error()
        }
      }
    ).toString()

    const worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' })))

    return new Promise((resolve, reject) => {
      function listener (e) {
        worker.terminate()
        if (e.data.hasIndexedDB) {
          resolve()
          return
        }
        reject()
      }

      function errorListener () {
        worker.terminate()
        reject()
      }

      worker.addEventListener('error', errorListener)
      worker.addEventListener('message', listener)
      worker.postMessage({})
    })
  }).then(() => true, err => {
    if ('console' in global && 'info' in console) {
      console.info('This browser is not supported by WorkerPouch', err)
    }
    return false
  })
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],5:[function(_dereq_,module,exports){
'use strict';

const utils = _dereq_(8)
const log = console.debug.bind(console)

exports.preprocessAttachments = function preprocessAttachments (doc) {
  if (!doc._attachments || !Object.keys(doc._attachments)) {
    return Promise.resolve()
  }

  return Promise.all(Object.keys(doc._attachments).map(key => {
    const attachment = doc._attachments[key]
    if (attachment.data && typeof attachment.data !== 'string') {
      return new Promise(resolve => {
        utils.readAsBinaryString(attachment.data, binary => {
          attachment.data = btoa(binary)
          resolve()
        })
      })
    }
  }))
}

function encodeObjectArg (arg) {
  // these can't be encoded by normal structured cloning
  const funcKeys = ['filter', 'map', 'reduce']
  const keysToRemove = ['onChange', 'processChange', 'complete']
  const clonedArg = {}
  Object.keys(arg).forEach(key => {
    if (keysToRemove.indexOf(key) !== -1) {
      return
    }
    if (funcKeys.indexOf(key) !== -1 && typeof arg[key] === 'function') {
      clonedArg[key] = {
        type: 'func',
        func: arg[key].toString()
      }
    } else {
      clonedArg[key] = arg[key]
    }
  })
  return clonedArg
}

exports.encodeArgs = function encodeArgs (args) {
  const result = []
  args.forEach(arg => {
    if (arg === null || typeof arg !== 'object'
        || Array.isArray(arg) || arg instanceof Blob || arg instanceof Date) {
      result.push(arg)
    } else {
      result.push(encodeObjectArg(arg))
    }
  })
  return result
}

exports.padInt = function padInt (i, len) {
  let res = i.toString()
  while (res.length < len) {
    res = `0${res}`
  }
  return res
}


exports.adapterFun = function adapterFun (name, callback) {
  function logApiCall (self, name, args) {
    // db.name was added in pouch 6.0.0
    const dbName = self.name || self._db_name
    const logArgs = [dbName, name]
    for (let i = 0; i < args.length - 1; i++) {
      logArgs.push(args[i])
    }
    log.apply(null, logArgs)

    // override the callback itself to log the response
    const origCallback = args[args.length - 1]
    args[args.length - 1] = function (err, res) {
      let responseArgs = [dbName, name]
      responseArgs = responseArgs.concat(
        err ? ['error', err] : ['success', res]
      )
      log.apply(null, responseArgs)
      origCallback(err, res)
    }
  }


  return utils.toPromise(utils.getArguments(function (args) {
    if (this._closed) {
      return Promise.reject(new Error('database is closed'))
    }
    const self = this

    if ("production" !== 'production') {
      logApiCall(self, name, args)
    }

    if (!this.taskqueue.isReady) {
      return new Promise((fulfill, reject) => {
        self.taskqueue.addTask(failed => {
          if (failed) {
            reject(failed)
          } else {
            fulfill(self[name].apply(self, args))
          }
        })
      })
    }
    return callback.apply(this, args)
  }))
}

},{"8":8}],6:[function(_dereq_,module,exports){
'use strict';

const inherits = _dereq_(14)

inherits(PouchError, Error)

function PouchError (opts) {
  Error.call(opts.reason)
  this.status = opts.status
  this.name = opts.error
  this.message = opts.reason
  this.error = true
}

PouchError.prototype.toString = function () {
  return JSON.stringify({
    status: this.status,
    name: this.name,
    message: this.message
  })
}

exports.UNAUTHORIZED = new PouchError({
  status: 401,
  error: 'unauthorized',
  reason: 'Name or password is incorrect.'
})

exports.MISSING_BULK_DOCS = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Missing JSON list of \'docs\''
})

exports.MISSING_DOC = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'missing'
})

exports.REV_CONFLICT = new PouchError({
  status: 409,
  error: 'conflict',
  reason: 'Document update conflict'
})

exports.INVALID_ID = new PouchError({
  status: 400,
  error: 'invalid_id',
  reason: '_id field must contain a string'
})

exports.MISSING_ID = new PouchError({
  status: 412,
  error: 'missing_id',
  reason: '_id is required for puts'
})

exports.RESERVED_ID = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Only reserved document ids may start with underscore.'
})

exports.NOT_OPEN = new PouchError({
  status: 412,
  error: 'precondition_failed',
  reason: 'Database not open'
})

exports.UNKNOWN_ERROR = new PouchError({
  status: 500,
  error: 'unknown_error',
  reason: 'Database encountered an unknown error'
})

exports.BAD_ARG = new PouchError({
  status: 500,
  error: 'badarg',
  reason: 'Some query argument is invalid'
})

exports.INVALID_REQUEST = new PouchError({
  status: 400,
  error: 'invalid_request',
  reason: 'Request was invalid'
})

exports.QUERY_PARSE_ERROR = new PouchError({
  status: 400,
  error: 'query_parse_error',
  reason: 'Some query parameter is invalid'
})

exports.DOC_VALIDATION = new PouchError({
  status: 500,
  error: 'doc_validation',
  reason: 'Bad special document member'
})

exports.BAD_REQUEST = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Something wrong with the request'
})

exports.NOT_AN_OBJECT = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Document must be a JSON object'
})

exports.DB_MISSING = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'Database not found'
})

exports.IDB_ERROR = new PouchError({
  status: 500,
  error: 'indexed_db_went_bad',
  reason: 'unknown'
})

exports.WSQ_ERROR = new PouchError({
  status: 500,
  error: 'web_sql_went_bad',
  reason: 'unknown'
})

exports.LDB_ERROR = new PouchError({
  status: 500,
  error: 'levelDB_went_went_bad',
  reason: 'unknown'
})

exports.FORBIDDEN = new PouchError({
  status: 403,
  error: 'forbidden',
  reason: 'Forbidden by design doc validate_doc_update function'
})

exports.INVALID_REV = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Invalid rev format'
})

exports.FILE_EXISTS = new PouchError({
  status: 412,
  error: 'file_exists',
  reason: 'The database could not be created, the file already exists.'
})

exports.MISSING_STUB = new PouchError({
  status: 412,
  error: 'missing_stub'
})

exports.error = function (error, reason, name) {
  function CustomPouchError (reason) {
    // inherit error properties from our parent error manually
    // so as to allow proper JSON parsing.
    /* jshint ignore:start */
    for (const p in error) {
      if (typeof error[p] !== 'function') {
        this[p] = error[p]
      }
    }
    /* jshint ignore:end */
    if (name !== undefined) {
      this.name = name
    }
    if (reason !== undefined) {
      this.reason = reason
    }
  }
  CustomPouchError.prototype = PouchError.prototype
  return new CustomPouchError(reason)
}

// Find one of the errors defined above based on the value
// of the specified property.
// If reason is provided prefer the error matching that reason.
// This is for differentiating between errors with the same name and status,
// eg, bad_request.
exports.getErrorTypeByProp = function (prop, value, reason) {
  const errors = exports
  const keys = Object.keys(errors).filter(key => {
    const error = errors[key]
    return typeof error !== 'function' && error[prop] === value
  })
  const key = reason && keys.filter(key => {
    const error = errors[key]
    return error.message === reason
  })[0] || keys[0]
  return (key) ? errors[key] : null
}

exports.generateErrorFromResponse = function (res) {
  let error; let errName; let errType; let errMsg; let
    errReason
  const errors = exports

  errName = (res.error === true && typeof res.name === 'string')
    ? res.name
    : res.error
  errReason = res.reason
  errType = errors.getErrorTypeByProp('name', errName, errReason)

  if (res.missing
    || errReason === 'missing'
    || errReason === 'deleted'
    || errName === 'not_found') {
    errType = errors.MISSING_DOC
  } else if (errName === 'doc_validation') {
    // doc validation needs special treatment since
    // res.reason depends on the validation error.
    // see utils.js
    errType = errors.DOC_VALIDATION
    errMsg = errReason
  } else if (errName === 'bad_request' && errType.message !== errReason) {
    // if bad_request error already found based on reason don't override.

    // attachment errors.
    if (errReason.indexOf('unknown stub attachment') === 0) {
      errType = errors.MISSING_STUB
      errMsg = errReason
    } else {
      errType = errors.BAD_REQUEST
    }
  }

  // fallback to error by statys or unknown error.
  if (!errType) {
    errType = errors.getErrorTypeByProp('status', res.status, errReason)
    || errors.UNKNOWN_ERROR
  }

  error = errors.error(errType, errReason, errName)

  // Keep custom message.
  if (errMsg) {
    error.message = errMsg
  }

  // Keep helpful response data in our error messages.
  if (res.id) {
    error.id = res.id
  }
  if (res.status) {
    error.status = res.status
  }
  if (res.statusText) {
    error.name = res.statusText
  }
  if (res.missing) {
    error.missing = res.missing
  }

  return error
}

},{"14":14}],7:[function(_dereq_,module,exports){
'use strict';

function isBinaryObject (object) {
  return object instanceof ArrayBuffer
    || (typeof Blob !== 'undefined' && object instanceof Blob)
}

function cloneArrayBuffer (buff) {
  if (typeof buff.slice === 'function') {
    return buff.slice(0)
  }
  // IE10-11 slice() polyfill
  const target = new ArrayBuffer(buff.byteLength)
  const targetArray = new Uint8Array(target)
  const sourceArray = new Uint8Array(buff)
  targetArray.set(sourceArray)
  return target
}

function cloneBinaryObject (object) {
  if (object instanceof ArrayBuffer) {
    return cloneArrayBuffer(object)
  }
  // Blob
  return object.slice(0, object.size, object.type)
}

module.exports = function clone (object) {
  let newObject
  let i
  let len

  if (!object || typeof object !== 'object') {
    return object
  }

  if (Array.isArray(object)) {
    newObject = []
    for (i = 0, len = object.length; i < len; i++) {
      newObject[i] = clone(object[i])
    }
    return newObject
  }

  // special case: to avoid inconsistencies between IndexedDB
  // and other backends, we automatically stringify Dates
  if (object instanceof Date) {
    return object.toISOString()
  }

  if (isBinaryObject(object)) {
    return cloneBinaryObject(object)
  }

  newObject = {}
  for (i in object) {
    if (Object.prototype.hasOwnProperty.call(object, i)) {
      const value = clone(object[i])
      if (typeof value !== 'undefined') {
        newObject[i] = value
      }
    }
  }
  return newObject
}

},{}],8:[function(_dereq_,module,exports){
(function (process,global){
'use strict';

exports.lastIndexOf = function lastIndexOf (str, char) {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str.charAt(i) === char) {
      return i
    }
  }
  return -1
}

exports.clone = _dereq_(7)

/* istanbul ignore next */
exports.once = function once (fun) {
  let called = false
  return exports.getArguments(function (args) {
    if (called) {
      if ('console' in global && 'trace' in console) {
        console.trace()
      }
      throw new Error('once called  more than once')
    } else {
      called = true
      fun.apply(this, args)
    }
  })
}
/* istanbul ignore next */
exports.getArguments = function getArguments (fun) {
  return function () {
    const len = arguments.length
    const args = new Array(len)
    let i = -1
    while (++i < len) {
      args[i] = arguments[i]
    }
    return fun.call(this, args)
  }
}
/* istanbul ignore next */
exports.toPromise = function toPromise (func) {
  // create the function we will be returning
  return exports.getArguments(function (args) {
    const self = this
    const tempCB = (typeof args[args.length - 1] === 'function') ? args.pop() : false
    // if the last argument is a function, assume its a callback
    let usedCB
    if (tempCB) {
      // if it was a callback, create a new callback which calls it,
      // but do so async so we don't trap any errors
      usedCB = function (err, resp) {
        process.nextTick(() => {
          tempCB(err, resp)
        })
      }
    }
    const promise = new Promise((fulfill, reject) => {
      try {
        const callback = exports.once((err, mesg) => {
          if (err) {
            reject(err)
          } else {
            fulfill(mesg)
          }
        })
        // create a callback for this invocation
        // apply the function in the orig context
        args.push(callback)
        func.apply(self, args)
      } catch (e) {
        reject(e)
      }
    })
    // if there is a callback, call it back
    if (usedCB) {
      promise.then(result => {
        usedCB(null, result)
      }, usedCB)
    }
    promise.cancel = function () {
      return this
    }
    return promise
  })
}

exports.inherits = _dereq_(14)

const binUtil = _dereq_(15)

exports.createBlob = data => new Blob(data)
exports.readAsArrayBuffer = binUtil.readAsArrayBuffer
exports.readAsBinaryString = binUtil.readAsBinaryString
exports.binaryStringToArrayBuffer = binUtil.binaryStringToArrayBuffer
exports.arrayBufferToBinaryString = binUtil.arrayBufferToBinaryString

}).call(this,_dereq_(24),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"14":14,"15":15,"24":24,"7":7}],9:[function(_dereq_,module,exports){
'use strict';

// BEGIN Math.uuid.js

/*!
 Math.uuid.js (v1.4)
 http://www.broofa.com
 mailto:robert@broofa.com

 Copyright (c) 2010 Robert Kieffer
 Dual licensed under the MIT and GPL licenses.
 */

/*
 * Generate a random uuid.
 *
 * USAGE: Math.uuid(length, radix)
 *   length - the desired number of characters
 *   radix  - the number of allowable values for each character.
 *
 * EXAMPLES:
 *   // No arguments  - returns RFC4122, version 4 ID
 *   >>> Math.uuid()
 *   "92329D39-6F5C-4520-ABFC-AAB64544E172"
 *
 *   // One argument - returns ID of the specified length
 *   >>> Math.uuid(15)     // 15 character ID (default base=62)
 *   "VcydxgltxrVZSTV"
 *
 *   // Two arguments - returns ID of the specified length, and radix.
 *   // (Radix must be <= 62)
 *   >>> Math.uuid(8, 2)  // 8 character ID (base=2)
 *   "01001010"
 *   >>> Math.uuid(8, 10) // 8 character ID (base=10)
 *   "47473046"
 *   >>> Math.uuid(8, 16) // 8 character ID (base=16)
 *   "098F4D35"
 */
const chars = (
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
+ 'abcdefghijklmnopqrstuvwxyz'
).split('')
function getValue (radix) {
  return 0 | Math.random() * radix
}
function uuid (len, radix) {
  radix = radix || chars.length
  let out = ''
  let i = -1

  if (len) {
    // Compact form
    while (++i < len) {
      out += chars[getValue(radix)]
    }
    return out
  }
  // rfc4122, version 4 form
  // Fill in random data.  At i==19 set the high bits of clock sequence as
  // per rfc4122, sec. 4.1.5
  while (++i < 36) {
    switch (i) {
    case 8:
    case 13:
    case 18:
    case 23:
      out += '-'
      break
    case 19:
      out += chars[(getValue(16) & 0x3) | 0x8]
      break
    default:
      out += chars[getValue(16)]
    }
  }

  return out
}


module.exports = uuid


},{}],10:[function(_dereq_,module,exports){
// this code is automatically generated by bin/build.js
module.exports = "!function r(o,i,a){function s(t,e){if(!i[t]){if(!o[t]){var n=\"function\"==typeof require&&require;if(!e&&n)return n(t,!0);if(u)return u(t,!0);throw(e=new Error(\"Cannot find module '\"+t+\"'\")).code=\"MODULE_NOT_FOUND\",e}n=i[t]={exports:{}},o[t][0].call(n.exports,function(e){return s(o[t][1][e]||e)},n,n.exports,r,o,i,a)}return i[t].exports}for(var u=\"function\"==typeof require&&require,e=0;e<a.length;e++)s(a[e]);return s}({1:[function(e,t,s){\"use strict\";const n=e(10);function o(e){Error.call(e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}n(o,Error),o.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message})},s.UNAUTHORIZED=new o({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),s.MISSING_BULK_DOCS=new o({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),s.MISSING_DOC=new o({status:404,error:\"not_found\",reason:\"missing\"}),s.REV_CONFLICT=new o({status:409,error:\"conflict\",reason:\"Document update conflict\"}),s.INVALID_ID=new o({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),s.MISSING_ID=new o({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),s.RESERVED_ID=new o({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),s.NOT_OPEN=new o({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),s.UNKNOWN_ERROR=new o({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),s.BAD_ARG=new o({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),s.INVALID_REQUEST=new o({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),s.QUERY_PARSE_ERROR=new o({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),s.DOC_VALIDATION=new o({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),s.BAD_REQUEST=new o({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),s.NOT_AN_OBJECT=new o({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),s.DB_MISSING=new o({status:404,error:\"not_found\",reason:\"Database not found\"}),s.IDB_ERROR=new o({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),s.WSQ_ERROR=new o({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),s.LDB_ERROR=new o({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),s.FORBIDDEN=new o({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),s.INVALID_REV=new o({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),s.FILE_EXISTS=new o({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),s.MISSING_STUB=new o({status:412,error:\"missing_stub\"}),s.error=function(n,e,r){function t(e){for(const t in n)\"function\"!=typeof n[t]&&(this[t]=n[t]);void 0!==r&&(this.name=r),void 0!==e&&(this.reason=e)}return t.prototype=o.prototype,new t(e)},s.getErrorTypeByProp=function(t,n,r){const o=s,e=Object.keys(o).filter(e=>{e=o[e];return\"function\"!=typeof e&&e[t]===n});var i=r&&e.filter(e=>{return o[e].message===r})[0]||e[0];return i?o[i]:null},s.generateErrorFromResponse=function(e){let t;var n;let r,o,i;const a=s;return n=!0===e.error&&\"string\"==typeof e.name?e.name:e.error,i=e.reason,r=a.getErrorTypeByProp(\"name\",n,i),e.missing||\"missing\"===i||\"deleted\"===i||\"not_found\"===n?r=a.MISSING_DOC:\"doc_validation\"===n?(r=a.DOC_VALIDATION,o=i):\"bad_request\"===n&&r.message!==i&&(0===i.indexOf(\"unknown stub attachment\")?(r=a.MISSING_STUB,o=i):r=a.BAD_REQUEST),r=r||(a.getErrorTypeByProp(\"status\",e.status,i)||a.UNKNOWN_ERROR),t=a.error(r,i,n),o&&(t.message=o),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.statusText&&(t.name=e.statusText),e.missing&&(t.missing=e.missing),t}},{10:10}],2:[function(e,t,n){\"use strict\";const $=e(1),o=e(5),c=(console.debug.bind(console),o[\"decodeArgs\"]),R={},C={};t.exports=function(n,A){function a(e,t){(\"function\"!=typeof n.postMessage?t.ports[0]:n).postMessage(e)}function s(e,t,n){a({type:\"uncaughtError\",id:e,content:o.createError(t)},n)}function I(e,t,n,r){a({type:\"error\",id:e,messageId:t,content:o.createError(n)},r)}function S(e,t,n,r){a({type:\"success\",id:e,messageId:t,content:n},r)}function x(t,e,n,r,o){const i=R[\"$\"+t];if(!i)return I(t,n,{error:\"db not found\"},o);Promise.resolve().then(()=>i[e].apply(i,r)).then(e=>{S(t,n,e,o)}).catch(e=>{I(t,n,e,o)})}function j(n,r,e,o){const i=R[\"$\"+n];if(!i)return I(n,r,{error:\"db not found\"},o);Promise.resolve().then(()=>{const t=i.changes(e[0]);(C[r]=t).on(\"change\",e=>{a({type:\"update\",id:n,messageId:r,content:e},o)}).on(\"complete\",e=>{t.removeAllListeners(),delete C[r],S(n,r,e,o)}).on(\"error\",e=>{t.removeAllListeners(),delete C[r],I(n,r,e,o)})})}function D(e,t,n){return Promise.resolve().then(()=>{e.on(\"error\",e=>{s(t,e,n)})})}function u(t,e,n,r,o){switch(e){case\"createDatabase\":{var i=t;var a=n;var s=r;var u=o;var c=\"$\"+i;let e=R[c];return e?D(e,i,u).then(()=>S(i,a,{ok:!0,exists:!0},u)):(\"string\"==typeof s[0]?s[0]:s[0].name)?void D(e=R[c]=(()=>{let e={adapter:\"indexeddb\",revs_limit:1};return Object(s[0])===s[0]?e=Object.assign({},s[0],e):e.name=s[0],A(e)})(),i,u).then(()=>{S(i,a,{ok:!0},u)}).catch(e=>{I(i,a,e,u)}):I(i,a,{error:\"you must provide a database name\"},u);return}case\"id\":case\"info\":case\"put\":case\"allDocs\":case\"bulkDocs\":case\"post\":case\"get\":case\"remove\":case\"revsDiff\":case\"compact\":case\"viewCleanup\":case\"removeAttachment\":case\"putAttachment\":case\"query\":case\"createIndex\":case\"find\":return x(t,e,n,r,o);case\"changes\":{c=t;var f=n;var l=r;var d=o;const w=l[0];w&&\"object\"==typeof w&&(w.returnDocs=!0,w.return_docs=!0),x(c,\"changes\",f,l,d);return}case\"getAttachment\":{var p=t;var h=n;var v=r;var y=o;const k=R[\"$\"+p];if(!k)return I(p,h,{error:\"db not found\"},y);Promise.resolve().then(()=>{var e=v[0];const t=v[1];let n=v[2];return\"object\"!=typeof n&&(n={}),k.get(e,n).then(e=>{if(e._attachments&&e._attachments[t])return k.getAttachment.apply(k,v).then(e=>{S(p,h,e,y)});throw $.MISSING_DOC})}).catch(e=>{I(p,h,e,y)});return}case\"liveChanges\":return j(t,n,r,o);case\"cancelChanges\":{f=n;const E=C[f];E&&E.cancel();return}case\"destroy\":{var _=t;var g=n;var m=r;var b=o;l=\"$\"+_;const O=R[l];if(!O)return I(_,g,{error:\"db not found\"},b);delete R[l],Promise.resolve().then(()=>O.destroy.apply(O,m)).then(e=>{S(_,g,e,b)}).catch(e=>{I(_,g,e,b)});return}default:I(t,n,{error:\"unknown API method: \"+e},o)}}n.addEventListener(\"message\",t=>{if(t.data&&t.data.id&&t.data.args&&t.data.type&&t.data.messageId){var e,n,r,o,i=t.data.id;if(\"close\"===t.data.type)delete R[\"$\"+i];else try{e=t.data,n=t,r=e.type,o=e.messageId,u(i,r,o,c(e.args),n)}catch(e){s(i,e,t)}}})}},{1:1,5:5}],3:[function(e,t,n){\"use strict\";const r=e(2);e=e(64).plugin(e(13)).plugin(e(91));r(self,e)},{13:13,2:2,64:64,91:91}],4:[function(_dereq_,module,exports){\"use strict\";module.exports=function safeEval(str){const target={};return eval(`target.target = (${str});`),target.target}},{}],5:[function(e,t,n){\"use strict\";const r=e(4);n.createError=function(e){var t=e.status||500;return e.name&&e.message&&(\"Error\"!==e.name&&\"TypeError\"!==e.name||(-1!==e.message.indexOf(\"Bad special document member\")?e.name=\"doc_validation\":e.name=\"bad_request\"),e={error:e.name,name:e.name,reason:e.message,message:e.message,status:t}),e},n.decodeArgs=function(e){const n=[\"filter\",\"map\",\"reduce\"];return e.forEach(t=>{\"object\"!=typeof t||null===t||Array.isArray(t)||n.forEach(e=>{e in t&&null!==t[e]?\"func\"===t[e].type&&t[e].func&&(t[e]=r(t[e].func)):delete t[e]})}),e}},{4:4}],6:[function(e,t,n){\"use strict\";t.exports=function(r){return function(){var e=arguments.length;if(e){for(var t=[],n=-1;++n<e;)t[n]=arguments[n];return r.call(this,t)}return r.call(this,[])}}},{}],7:[function(e,t,n){},{}],8:[function(e,t,n){var l=Object.create||function(e){function t(){}return t.prototype=e,new t},a=Object.keys||function(e){var t,n=[];for(t in e)Object.prototype.hasOwnProperty.call(e,t)&&n.push(t);return t},r=Function.prototype.bind||function(e){var t=this;return function(){return t.apply(e,arguments)}};function o(){this._events&&Object.prototype.hasOwnProperty.call(this,\"_events\")||(this._events=l(null),this._eventsCount=0),this._maxListeners=this._maxListeners||void 0}((t.exports=o).EventEmitter=o).prototype._events=void 0,o.prototype._maxListeners=void 0;var i,s=10;try{var u={};Object.defineProperty&&Object.defineProperty(u,\"x\",{value:0}),i=0===u.x}catch(e){i=!1}function c(e){return void 0===e._maxListeners?o.defaultMaxListeners:e._maxListeners}function f(e,t,n,r){var o,i;if(\"function\"!=typeof n)throw new TypeError('\"listener\" argument must be a function');return(o=e._events)?(o.newListener&&(e.emit(\"newListener\",t,n.listener||n),o=e._events),i=o[t]):(o=e._events=l(null),e._eventsCount=0),i?(\"function\"==typeof i?i=o[t]=r?[n,i]:[i,n]:r?i.unshift(n):i.push(n),i.warned||(r=c(e))&&0<r&&i.length>r&&(i.warned=!0,(r=new Error(\"Possible EventEmitter memory leak detected. \"+i.length+' \"'+String(t)+'\" listeners added. Use emitter.setMaxListeners() to increase limit.')).name=\"MaxListenersExceededWarning\",r.emitter=e,r.type=t,r.count=i.length,\"object\"==typeof console&&console.warn&&console.warn(\"%s: %s\",r.name,r.message))):(i=o[t]=n,++e._eventsCount),e}function d(){if(!this.fired)switch(this.target.removeListener(this.type,this.wrapFn),this.fired=!0,arguments.length){case 0:return this.listener.call(this.target);case 1:return this.listener.call(this.target,arguments[0]);case 2:return this.listener.call(this.target,arguments[0],arguments[1]);case 3:return this.listener.call(this.target,arguments[0],arguments[1],arguments[2]);default:for(var e=new Array(arguments.length),t=0;t<e.length;++t)e[t]=arguments[t];this.listener.apply(this.target,e)}}function p(e,t,n){e={fired:!1,wrapFn:void 0,target:e,type:t,listener:n},t=r.call(d,e);return t.listener=n,e.wrapFn=t}function h(e,t,n){e=e._events;if(!e)return[];e=e[t];if(e)if(\"function\"==typeof e)return n?[e.listener||e]:[e];else if(n){var r=e;for(var o=new Array(r.length),i=0;i<o.length;++i)o[i]=r[i].listener||r[i];return o;return}else return U(e,e.length);return[]}function v(e){var t=this._events;if(t){t=t[e];if(\"function\"==typeof t)return 1;if(t)return t.length}return 0}function U(e,t){for(var n=new Array(t),r=0;r<t;++r)n[r]=e[r];return n}i?Object.defineProperty(o,\"defaultMaxListeners\",{enumerable:!0,get:function(){return s},set:function(e){if(\"number\"!=typeof e||e<0||e!=e)throw new TypeError('\"defaultMaxListeners\" must be a positive number');s=e}}):o.defaultMaxListeners=s,o.prototype.setMaxListeners=function(e){if(\"number\"!=typeof e||e<0||isNaN(e))throw new TypeError('\"n\" argument must be a positive number');return this._maxListeners=e,this},o.prototype.getMaxListeners=function(){return c(this)},o.prototype.emit=function(e){var t,n,r,o,i=\"error\"===e,a=this._events;if(a)i=i&&null==a.error;else if(!i)return!1;if(i)throw(t=1<arguments.length?arguments[1]:t)instanceof Error?t:((i=new Error('Unhandled \"error\" event. ('+t+\")\")).context=t,i);if(!(n=a[e]))return!1;var s,u=\"function\"==typeof n;switch(s=arguments.length){case 1:var c=n,f=u,l=this;if(f)c.call(l);else for(var d=c.length,B=U(c,d),p=0;p<d;++p)B[p].call(l);break;case 2:var f=n,c=u,h=this,v=arguments[1];if(c)f.call(h,v);else for(var y=f.length,N=U(f,y),_=0;_<y;++_)N[_].call(h,v);break;case 3:var g=n,m=u,b=this,w=arguments[1],k=arguments[2];if(m)g.call(b,w,k);else for(var E=g.length,M=U(g,E),O=0;O<E;++O)M[O].call(b,w,k);break;case 4:var m=n,g=u,A=this,I=arguments[1],S=arguments[2],x=arguments[3];if(g)m.call(A,I,S,x);else for(var j=m.length,P=U(m,j),D=0;D<j;++D)P[D].call(A,I,S,x);break;default:for(r=new Array(s-1),o=1;o<s;o++)r[o-1]=arguments[o];var $=n,L=u,R=this,C=r;if(L)$.apply(R,C);else for(var T=$.length,F=U($,T),q=0;q<T;++q)F[q].apply(R,C)}return!0},o.prototype.on=o.prototype.addListener=function(e,t){return f(this,e,t,!1)},o.prototype.prependListener=function(e,t){return f(this,e,t,!0)},o.prototype.once=function(e,t){if(\"function\"!=typeof t)throw new TypeError('\"listener\" argument must be a function');return this.on(e,p(this,e,t)),this},o.prototype.prependOnceListener=function(e,t){if(\"function\"!=typeof t)throw new TypeError('\"listener\" argument must be a function');return this.prependListener(e,p(this,e,t)),this},o.prototype.removeListener=function(e,t){var n,r,o,i,a;if(\"function\"!=typeof t)throw new TypeError('\"listener\" argument must be a function');if(!(r=this._events))return this;if(!(n=r[e]))return this;if(n===t||n.listener===t)0==--this._eventsCount?this._events=l(null):(delete r[e],r.removeListener&&this.emit(\"removeListener\",e,n.listener||t));else if(\"function\"!=typeof n){for(o=-1,i=n.length-1;0<=i;i--)if(n[i]===t||n[i].listener===t){a=n[i].listener,o=i;break}if(o<0)return this;if(0===o)n.shift();else{for(var s=n,u=o,c=u+1,f=s.length;c<f;u+=1,c+=1)s[u]=s[c];s.pop()}1===n.length&&(r[e]=n[0]),r.removeListener&&this.emit(\"removeListener\",e,a||t)}return this},o.prototype.removeAllListeners=function(e){var t,n=this._events;if(!n)return this;if(!n.removeListener)return 0===arguments.length?(this._events=l(null),this._eventsCount=0):n[e]&&(0==--this._eventsCount?this._events=l(null):delete n[e]),this;if(0===arguments.length){for(var r,o=a(n),i=0;i<o.length;++i)\"removeListener\"!==(r=o[i])&&this.removeAllListeners(r);return this.removeAllListeners(\"removeListener\"),this._events=l(null),this._eventsCount=0,this}if(\"function\"==typeof(t=n[e]))this.removeListener(e,t);else if(t)for(i=t.length-1;0<=i;i--)this.removeListener(e,t[i]);return this},o.prototype.listeners=function(e){return h(this,e,!0)},o.prototype.rawListeners=function(e){return h(this,e,!1)},o.listenerCount=function(e,t){return\"function\"==typeof e.listenerCount?e.listenerCount(t):v.call(e,t)},o.prototype.listenerCount=v,o.prototype.eventNames=function(){return 0<this._eventsCount?Reflect.ownKeys(this._events):[]}},{}],9:[function(e,c,t){!function(t){\"use strict\";var e,n,r,o,i=t.MutationObserver||t.WebKitMutationObserver,a=i?(e=0,i=new i(u),n=t.document.createTextNode(\"\"),i.observe(n,{characterData:!0}),function(){n.data=e=++e%2}):t.setImmediate||void 0===t.MessageChannel?\"document\"in t&&\"onreadystatechange\"in t.document.createElement(\"script\")?function(){var e=t.document.createElement(\"script\");e.onreadystatechange=function(){u(),e.onreadystatechange=null,e.parentNode.removeChild(e),e=null},t.document.documentElement.appendChild(e)}:function(){setTimeout(u,0)}:((r=new t.MessageChannel).port1.onmessage=u,function(){r.port2.postMessage(0)}),s=[];function u(){o=!0;for(var e,t,n=s.length;n;){for(t=s,s=[],e=-1;++e<n;)t[e]();n=s.length}o=!1}c.exports=function(e){1!==s.push(e)||o||a()}}.call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],10:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){t&&(e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}}))}:t.exports=function(e,t){var n;t&&(e.super_=t,(n=function(){}).prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e)}},{}],11:[function(e,t,n){\"use strict\";var O=e(97),f=e(94),A=e(63),o=e(12),I=e(62),S=e(88),x=e(90),j=e(92);function D(){this.promise=new Promise(function(e){e()})}function l(e){if(!e)return\"undefined\";switch(typeof e){case\"function\":case\"string\":return e.toString();default:return JSON.stringify(e)}}function $(r,o,i,a,t,s){e=a;var u,c=l(i)+l(e)+\"undefined\";if(!t&&(u=r._cachedViews=r._cachedViews||{})[c])return u[c];var e=r.info().then(function(e){var n=e.db_name+\"-mrview-\"+(t?\"temp\":f.stringMd5(c));return O.upsert(r,\"_local/\"+s,function(e){e.views=e.views||{};-1===(t=o).indexOf(\"/\")&&(t=o+\"/\"+o);var t=e.views[t]=e.views[t]||{};if(!t[n])return t[n]=!0,e}).then(function(){return r.registerDependentDatabase(n).then(function(e){var e=e.db,t=(e.auto_compaction=!0,{name:n,db:e,sourceDB:r,adapter:r.adapter,mapFun:i,reduceFun:a});return t.db.get(\"_local/lastSeq\").catch(function(e){if(404!==e.status)throw e}).then(function(e){return t.seq=e?e.seq:0,u&&t.db.once(\"destroyed\",function(){delete u[c]}),t})})})});return u&&(u[c]=e),e}D.prototype.add=function(e){return this.promise=this.promise.catch(function(){}).then(function(){return e()}),this.promise},D.prototype.finish=function(){return this.promise};var u={},R=new D;function C(e){return-1===e.indexOf(\"/\")?[e,e]:e.split(\"/\")}function q(e,t){try{e.emit(\"error\",t)}catch(e){O.guardedConsole(\"error\",\"The user's map/reduce function threw an uncaught error.\\nYou can debug this error by doing:\\nmyDatabase.on('error', function (err) { debugger; });\\nPlease double-check your map/reduce function.\"),O.guardedConsole(\"error\",t)}}t.exports=function(_,i,p,g){function l(e,t){var n=I.collate(e.key,t.key);return 0!==n?n:I.collate(e.value,t.value)}function d(e){var t=e.value;return t&&\"object\"==typeof t&&t._id||e.id}function m(t){return function(e){return t.include_docs&&t.attachments&&t.binary&&e.rows.forEach(function(e){var n=e.doc&&e.doc._attachments;n&&Object.keys(n).forEach(function(e){var t=n[e];n[e].data=o.base64StringToBlobOrBuffer(t.data,t.content_type)})}),e}}function b(e,t,n,r){t=t[e];void 0!==t&&(r&&(t=encodeURIComponent(JSON.stringify(t))),n.push(e+\"=\"+t))}function a(e){var t;if(void 0!==e)return t=Number(e),isNaN(t)||t!==parseInt(e,10)?e:t}function w(t,e){var n=t.descending?\"endkey\":\"startkey\",r=t.descending?\"startkey\":\"endkey\";if(void 0!==t[n]&&void 0!==t[r]&&0<I.collate(t[n],t[r]))throw new j.QueryParseError(\"No rows can match your key range, reverse your start_key and end_key or set {descending : true}\");if(e.reduce&&!1!==t.reduce){if(t.include_docs)throw new j.QueryParseError(\"{include_docs:true} is invalid for reduce\");if(t.keys&&1<t.keys.length&&!t.group&&!t.group_level)throw new j.QueryParseError(\"Multi-key fetches for reduce views must use {group: true}\")}[\"group_level\",\"limit\",\"skip\"].forEach(function(e){e=function(e){if(e)return\"number\"!=typeof e?new j.QueryParseError('Invalid value for integer: \"'+e+'\"'):e<0?new j.QueryParseError('Invalid value for positive integer: \"'+e+'\"'):void 0}(t[e]);if(e)throw e})}function h(t){return function(e){if(404===e.status)return t;throw e}}function v(e,t,n){var r=\"_local/doc_\"+e,o={_id:r,keys:[]},n=n.get(e),f=n[0],e=n[1];return(1===(n=e).length&&/^1-/.test(n[0].rev)?Promise.resolve(o):t.db.get(r).catch(h(o))).then(function(c){return((e=c).keys.length?t.db.allDocs({keys:e.keys,include_docs:!0}):Promise.resolve({rows:[]})).then(function(e){for(var t=c,n=e,r=[],o=new A.Set,i=0,a=n.rows.length;i<a;i++){var s,u=n.rows[i].doc;u&&(r.push(u),o.add(u._id),u._deleted=!f.has(u._id),u._deleted||\"value\"in(s=f.get(u._id))&&(u.value=s.value))}e=j.mapToKeysArray(f);return e.forEach(function(e){var t;o.has(e)||(t={_id:e},\"value\"in(e=f.get(e))&&(t.value=e.value),r.push(t))}),t.keys=j.uniq(e.concat(t.keys)),r.push(t),r});var e})}function r(e){e=\"string\"==typeof e?e:e.name;return u[e]||(u[e]=new D)}function k(t){return j.sequentialize(r(t),function(){return c=i((a=t).mapFun,function(e,t){e={id:u._id,key:I.normalizeKey(e)},null!=t&&(e.value=I.normalizeKey(t)),s.push(e)}),f=a.seq||0,o=new D,r().then(function(){return o.finish()}).then(function(){a.seq=f});function n(t,i){return function(){return r=t,o=i,e=\"_local/lastSeq\",(n=a).db.get(e).catch(h({_id:e,seq:0})).then(function(t){var e=j.mapToKeysArray(r);return Promise.all(e.map(function(e){return v(e,n,r)})).then(function(e){e=O.flatten(e);return t.seq=o,e.push(t),n.db.bulkDocs({docs:e})})});var n,r,o,e}}function r(){return a.sourceDB.changes({return_docs:!0,conflicts:!0,include_docs:!0,style:\"all_docs\",since:f,limit:50}).then(e)}function e(e){e=e.results;if(e.length){var t=function(e){for(var t=new A.Map,n=0,r=e.length;n<r;n++){var o,i=e[n];\"_\"!==i.doc._id[0]&&(s=[],(u=i.doc)._deleted||function(t,e,n){try{e(n)}catch(e){q(t,e)}}(a.sourceDB,c,u),s.sort(l),o=function(e){for(var t,n=new A.Map,r=0,o=e.length;r<o;r++){var i=e[r],a=[i.key,i.id];0<r&&0===I.collate(i.key,t)&&a.push(r),n.set(I.toIndexableString(a),i),t=i.key}return n}(s),t.set(i.doc._id,[o,i.changes])),f=i.seq}return t}(e);if(o.add(n(t,f)),!(e.length<50))return r()}}var a,s,u,c,f,o})()}function y(e,t,n){0===n.group_level&&delete n.group_level;var r=n.group||n.group_level,o=p(e.reduceFun),i=[],a=isNaN(n.group_level)?Number.POSITIVE_INFINITY:n.group_level;t.forEach(function(e){var t=i[i.length-1],n=r?e.key:null;if(r&&Array.isArray(n)&&(n=n.slice(0,a)),t&&0===I.collate(t.groupKey,n))return t.keys.push([e.key,e.id]),void t.values.push(e.value);i.push({keys:[[e.key,e.id]],values:[e.value],groupKey:n})}),t=[];for(var s,u,c=0,f=i.length;c<f;c++){var l=i[c],d=function(t,e,n,r,o){try{return{output:e(n,r,o)}}catch(e){return q(t,e),{error:e}}}(e.sourceDB,o,l.keys,l.values,!1);if(d.error&&d.error instanceof j.BuiltInError)throw d.error;t.push({value:d.error?null:d.output,key:l.groupKey})}return{rows:(s=t,u=n.limit,n=(n=n.skip)||0,\"number\"==typeof u?s.slice(n,u+n):0<n?s.slice(n):s)}}function E(f,l){return j.sequentialize(r(f),function(){var n,e,t,r,o=f,i=l,a=o.reduceFun&&!1!==i.reduce,s=i.skip||0;function u(e){return e.include_docs=!0,o.db.allDocs(e).then(function(e){return n=e.total_rows,e.rows.map(function(e){if(\"value\"in e.doc&&\"object\"==typeof e.doc.value&&null!==e.doc.value){var t=Object.keys(e.doc.value).sort(),n=[\"id\",\"key\",\"value\"];if(!(t<n||n<t))return e.doc.value}n=I.parseIndexableString(e.doc._id);return{key:n[0],id:n[1],value:\"value\"in e.doc?e.doc.value:null}})})}function c(t){var e,r=a?y(o,t,i):{total_rows:n,offset:s,rows:t};return i.update_seq&&(r.update_seq=o.seq),i.include_docs?(e=j.uniq(t.map(d)),o.sourceDB.allDocs({keys:e,include_docs:!0,conflicts:i.conflicts,attachments:i.attachments,binary:i.binary}).then(function(e){var n=new A.Map;return e.rows.forEach(function(e){n.set(e.id,e.doc)}),t.forEach(function(e){var t=d(e),t=n.get(t);t&&(e.doc=t)}),r})):r}return void 0===i.keys||i.keys.length||(i.limit=0,delete i.keys),void 0!==i.keys?(e=i.keys.map(function(e){e={startkey:I.toIndexableString([e]),endkey:I.toIndexableString([e,{}])};return i.update_seq&&(e.update_seq=!0),u(e)}),Promise.all(e).then(O.flatten).then(c)):(e={descending:i.descending},i.update_seq&&(e.update_seq=!0),\"start_key\"in i&&(t=i.start_key),\"startkey\"in i&&(t=i.startkey),\"end_key\"in i&&(r=i.end_key),\"endkey\"in i&&(r=i.endkey),void 0!==t&&(e.startkey=i.descending?I.toIndexableString([t,{}]):I.toIndexableString([t])),void 0!==r&&(t=!1!==i.inclusive_end,i.descending&&(t=!t),e.endkey=I.toIndexableString(t?[r,{}]:[r])),void 0!==i.key&&(t=I.toIndexableString([i.key]),r=I.toIndexableString([i.key,{}]),e.descending?(e.endkey=t,e.startkey=r):(e.startkey=t,e.endkey=r)),a||(\"number\"==typeof i.limit&&(e.limit=i.limit),e.skip=s),u(e).then(c))})()}function s(n,e,r){return\"function\"==typeof n._query?(t=n,o=e,i=r,new Promise(function(n,r){t._query(o,i,function(e,t){if(e)return r(e);n(t)})})):O.isRemote(n)?(a=n,s=e,v=\"GET\",b(\"reduce\",u=r,d=[]),b(\"include_docs\",u,d),b(\"attachments\",u,d),b(\"limit\",u,d),b(\"descending\",u,d),b(\"group\",u,d),b(\"group_level\",u,d),b(\"skip\",u,d),b(\"stale\",u,d),b(\"conflicts\",u,d),b(\"startkey\",u,d,!0),b(\"start_key\",u,d,!0),b(\"endkey\",u,d,!0),b(\"end_key\",u,d,!0),b(\"inclusive_end\",u,d),b(\"key\",u,d,!0),b(\"update_seq\",u,d),d=\"\"===(d=d.join(\"&\"))?\"\":\"?\"+d,void 0!==u.keys&&((h=\"keys=\"+encodeURIComponent(JSON.stringify(u.keys))).length+d.length+1<=2e3?d+=(\"?\"===d[0]?\"&\":\"?\")+h:(v=\"POST\",\"string\"==typeof s?c={keys:u.keys}:s.keys=u.keys)),\"string\"==typeof s?(h=C(s),a.fetch(\"_design/\"+h[0]+\"/_view/\"+h[1]+d,{headers:new x.Headers({\"Content-Type\":\"application/json\"}),method:v,body:JSON.stringify(c)}).then(function(e){return f=e.ok,l=e.status,e.json()}).then(function(e){if(f)return e.rows.forEach(function(e){if(e.value&&e.value.error&&\"builtin_reduce_error\"===e.value.error)throw new Error(e.reason)}),e;throw e.status=l,S.generateErrorFromResponse(e)}).then(m(u))):(c=c||{},Object.keys(s).forEach(function(e){Array.isArray(s[e])?c[e]=s[e]:c[e]=s[e].toString()}),a.fetch(\"_temp_view\"+d,{headers:new x.Headers({\"Content-Type\":\"application/json\"}),method:\"POST\",body:JSON.stringify(c)}).then(function(e){return f=e.ok,l=e.status,e.json()}).then(function(e){if(f)return e;throw e.status=l,S.generateErrorFromResponse(e)}).then(m(u)))):\"string\"!=typeof e?(w(r,e),R.add(function(){return $(n,\"temp_view/temp_view\",e.map,e.reduce,!0,_).then(function(e){return j.fin(k(e).then(function(){return E(e,r)}),function(){return e.db.destroy()})})}),R.finish()):(v=(h=C(p=e))[0],y=h[1],n.get(\"_design/\"+v).then(function(e){var t=e.views&&e.views[y];if(t)return g(e,y),w(r,t),$(n,p,t.map,t.reduce,!1,_).then(function(e){return\"ok\"===r.stale||\"update_after\"===r.stale?(\"update_after\"===r.stale&&O.nextTick(function(){k(e)}),E(e,r)):k(e).then(function(){return E(e,r)})});throw new j.NotFoundError(\"ddoc \"+e._id+\" has no view named \"+y)}));var t,o,i,a,s,u,c,f,l,d,p,h,v,y}return{query:function(e,t,n){var r=this,o=(\"function\"==typeof t&&(n=t,t={}),t=t?((o=t).group_level=a(o.group_level),o.limit=a(o.limit),o.skip=a(o.skip),o):{},\"function\"==typeof e&&(e={map:e}),Promise.resolve().then(function(){return s(r,e,t)}));return j.promisedCallback(o,n),o},viewCleanup:j.callbackify(function(){var e,t,n=this;return\"function\"==typeof n._viewCleanup?(e=n,new Promise(function(n,r){e._viewCleanup(function(e,t){if(e)return r(e);n(t)})})):O.isRemote(n)?n.fetch(\"_view_cleanup\",{headers:new x.Headers({\"Content-Type\":\"application/json\"}),method:\"POST\"}).then(function(e){return e.json()}):(t=n).get(\"_local/\"+_).then(function(a){var s=new A.Map,e=(Object.keys(a.views).forEach(function(e){var e=C(e),t=\"_design/\"+e[0],e=e[1],n=s.get(t);n||(n=new A.Set,s.set(t,n)),n.add(e)}),{keys:j.mapToKeysArray(s),include_docs:!0});return t.allDocs(e).then(function(e){var i={};e.rows.forEach(function(r){var o=r.key.substring(8);s.get(r.key).forEach(function(e){var t=o+\"/\"+e,t=(a.views[t]||(t=e),Object.keys(a.views[t])),n=r.doc&&r.doc.views&&r.doc.views[e];t.forEach(function(e){i[e]=i[e]||n})})});e=Object.keys(i).filter(function(e){return!i[e]}).map(function(e){return j.sequentialize(r(e),function(){return new t.constructor(e,t.__opts).destroy()})()});return Promise.all(e).then(function(){return{ok:!0}})})},h({ok:!0}))})}}},{12:12,62:62,63:63,88:88,90:90,92:92,94:94,97:97}],12:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});function r(e){return atob(e)}function o(e){return btoa(e)}function i(t,n){t=t||[],n=n||{};try{return new Blob(t,n)}catch(e){if(\"TypeError\"!==e.name)throw e;for(var r=new(\"undefined\"!=typeof BlobBuilder?BlobBuilder:\"undefined\"!=typeof MSBlobBuilder?MSBlobBuilder:\"undefined\"!=typeof MozBlobBuilder?MozBlobBuilder:WebKitBlobBuilder),o=0;o<t.length;o+=1)r.append(t[o]);return r.getBlob(n.type)}}function a(e){for(var t=e.length,n=new ArrayBuffer(t),r=new Uint8Array(n),o=0;o<t;o++)r[o]=e.charCodeAt(o);return n}function s(e,t){return i([a(e)],{type:t})}function u(e,t){var n=new FileReader,r=\"function\"==typeof n.readAsBinaryString;n.onloadend=function(e){e=e.target.result||\"\";if(r)return t(e);t(function(e){for(var t=\"\",n=new Uint8Array(e),r=n.byteLength,o=0;o<r;o++)t+=String.fromCharCode(n[o]);return t}(e))},r?n.readAsBinaryString(e):n.readAsArrayBuffer(e)}function c(e,t){u(e,function(e){t(e)})}n.atob=r,n.btoa=o,n.base64StringToBlobOrBuffer=function(e,t){return s(r(e),t)},n.binaryStringToArrayBuffer=a,n.binaryStringToBlobOrBuffer=s,n.blob=i,n.blobOrBufferToBase64=function(e,t){c(e,function(e){t(o(e))})},n.blobOrBufferToBinaryString=c,n.readAsArrayBuffer=function(e,t){var n=new FileReader;n.onloadend=function(e){e=e.target.result||new ArrayBuffer(0);t(e)},n.readAsArrayBuffer(e)},n.readAsBinaryString=u,n.typedBuffer=function(){}},{}],13:[function(e,t,N){\"use strict\";var p=e(37),O=e(20),A=e(23),h=e(25),I=e(22),S=e(24),x=Number.MIN_SAFE_INTEGER,j=Number.MIN_SAFE_INTEGER+1,D=Number.MIN_SAFE_INTEGER+2,n=/[^a-zA-Z0-9_$]+|(^[^a-zA-Z_$])/g,r=/(\\\\.)|[^a-zA-Z0-9_$.]+|(^[^a-zA-Z_$])/g,i=\"\\\\\".charCodeAt(0),o=/[^a-zA-Z0-9_$]+|(^[^a-zA-Z_$])/,a=/(\\\\.)|[^a-zA-Z0-9_$.]+|(^[^a-zA-Z_$])/;function $(e,o){function t(e){for(var t=\"\",n=0;n<e.length;n++){var r=e.charCodeAt(n);r===i&&o||(t+=\"_c\"+r+\"_\")}return t}return o?e.replace(r,t):e.replace(n,t)}function R(e){for(var t of Object.keys(e)){if(n=t,(void 0?a:o).test(n))return!0;if(null===e[t]||\"boolean\"==typeof e[t])return!0;if(\"object\"==typeof e[t])return R(e[t])}var n}var C=\"docs\",q=\"meta\";function B(n){return function(e){var t=\"unknown_error\";e.target&&e.target.error&&(t=e.target.error.name||e.target.error.message),n(I.createError(I.IDB_ERROR,t,e.type))}}function k(n,r,o,e){return delete o._attachments[n].stub,e?(o._attachments[n].data=r.attachments[o._attachments[n].digest].data,Promise.resolve()):new Promise(function(t){var e=r.attachments[o._attachments[n].digest].data;p.readAsBinaryString(e,function(e){o._attachments[n].data=p.btoa(e),delete o._attachments[n].length,t()})})}function c(e,t){return(e.views[t].options&&e.views[t].options.def&&e.views[t].options.def.fields||[]).map(function(e){return\"string\"==typeof e?e:Object.keys(e)[0]})}function f(e){return\"_find_idx/\"+e.join(\"/\")}var s=Math.pow(10,13);function u(e,i){var a=e.transaction.objectStore(C);a.getAll(IDBKeyRange.bound(\"_design/\",\"_design/￿\")).onsuccess=function(e){var e=e.target.result,t=Array.from(a.indexNames),n=e.filter(function(e){return 0===e.deleted&&e.revs[e.rev].data.views}).map(function(e){return e.revs[e.rev].data}).reduce(function(e,n){return Object.keys(n.views).reduce(function(e,t){t=c(n,t);return t&&0<t.length&&(e[f(t)]=[\"deleted\"].concat(t.map(function(e){return e in[\"_id\",\"_rev\",\"_deleted\",\"_attachments\"]?e.substr(1):\"data.\"+$(e,!0)}))),e},e)},{}),r=Object.keys(n),o=[\"seq\"],e=(t.forEach(function(e){-1===o.indexOf(e)&&-1===r.indexOf(e)&&a.deleteIndex(e)}),r.filter(function(e){return-1===t.indexOf(e)}));try{e.forEach(function(e){a.createIndex(e,n[e])})}catch(e){i(e)}}}function l(o,e,i,a,n){var r=i.versionchanged?indexedDB.open(i.name):indexedDB.open(i.name,+s+(new Date).getTime());r.onupgradeneeded=function(e){if(0<e.oldVersion&&e.oldVersion<s)throw new Error('Incorrect adapter: you should specify the \"idb\" adapter to open this DB');var t=e.target.result,e=(e=e.oldVersion,Math.floor(e/s));t=t,e<1&&(t.createObjectStore(C,{keyPath:\"id\"}).createIndex(\"seq\",\"seq\",{unique:!0}),t.createObjectStore(q,{keyPath:\"id\"})),u(r,n)},r.onblocked=function(e){console.error(\"onblocked, this should never happen\",e)},r.onsuccess=function(e){var t=e.target.result,n=(t.onabort=function(e){console.error(\"Database has a global failure\",e.target.error),delete o[i.name],t.close()},t.onversionchange=function(){console.log(\"Database was made stale, closing handle\"),o[i.name].versionchanged=!0,t.close()},{id:q}),e=t.transaction([q],\"readwrite\"),r=(e.oncomplete=function(){a({idb:t,metadata:n})},e.objectStore(q));r.get(q).onsuccess=function(e){var t=!1;\"doc_count\"in(n=e.target.result||n)||(t=!0,n.doc_count=0),\"seq\"in n||(t=!0,n.seq=0),\"db_uuid\"in n||(t=!0,n.db_uuid=h.uuid()),t&&r.put(n)}},r.onerror=function(e){n(e.target.error)}}function d(n,e,r){return n[r.name]&&!n[r.name].versionchanged||(r.versionchanged=n[r.name]&&n[r.name].versionchanged,n[r.name]=new Promise(function(e,t){l(n,0,r,e,t)})),n[r.name]}function v(r,e,o,i){if(r.error)return i(r.error);r.txn.objectStore(C).get(e).onsuccess=function(e){var t,e=e.target.result,n=o.rev?o.latest?S.latest(o.rev,e):o.rev:e&&e.rev;e&&(!e.deleted||o.rev)&&n in e.revs?((t=e.revs[n].data)._id=e.id,t._rev=n,i(null,{doc:t,metadata:e,ctx:r})):i(I.createError(I.MISSING_DOC,\"missing\"))}}function y(e,t,n,r,o,i){if(e.error)return i(e.error);var a;e.txn.objectStore(C).get(t).onsuccess=function(e){var e=e.target.result,t=e.revs[o.rev||e.rev].data._attachments[n].digest;a=e.attachments[t].data},e.txn.oncomplete=function(){var e,t;e=a,t=i,o.binary?t(null,e):p.readAsBinaryString(e,function(e){t(null,p.btoa(e))})},e.txn.onabort=i}function _(e,t,h,v,y,n,r){var o,_,g,m=[],i=[],a=y.revs_limit||1e3,b=-1===y.name.indexOf(\"-mrview-\");function w(e){return/^_local/.test(e.id)?1:a}function s(t,n){var r=0,o={};function i(e){var d,p;e.target.result&&(o[e.target.result.id]=e.target.result),++r===n.length&&(d=t,p=o,n.forEach(function(e,t){var n;if(\"was_delete\"in h&&!p.hasOwnProperty(e.id))n=I.createError(I.MISSING_DOC,\"deleted\");else if(h.new_edits&&!p.hasOwnProperty(e.id)&&\"missing\"===e.rev_tree[0].ids[1].status)n=I.createError(I.REV_CONFLICT);else if(p.hasOwnProperty(e.id)){if(0==(n=function(e,t){if(e.rev in t.revs&&!h.new_edits)return!1;var n=/^1-/.test(e.rev);t.deleted&&!e.deleted&&h.new_edits&&n&&((n=e.revs[e.rev].data)._rev=t.rev,n._id=t.id,e=k(O.parseDoc(n,h.new_edits,y)));var n=S.merge(t.rev_tree,e.rev_tree[0],w(e)),r=(e.stemmedRevs=n.stemmedRevs,e.rev_tree=n.tree,t.revs);if(r[e.rev]=e.revs[e.rev],e.revs=r,e.attachments=t.attachments,h.new_edits&&(t.deleted&&e.deleted||!t.deleted&&\"new_leaf\"!==n.conflicts||t.deleted&&!e.deleted&&\"new_branch\"===n.conflicts||t.rev===e.rev))return I.createError(I.REV_CONFLICT);return e.wasDeleted=t.deleted,e}(e,p[e.id])))return}else{var r=S.merge([],e.rev_tree[0],w(e));e.rev_tree=r.tree,e.stemmedRevs=r.stemmedRevs,(n=e).isNewDoc=!0,n.wasDeleted=e.revs[e.rev].deleted?1:0}if(n.error)m[t]=n;else{p[n.id]=n;var o,i=d,a=n,s=g=t,r=S.winningRev(a),u=a.rev,e=/^_local/.test(a.id),c=a.revs[r].data;if(b&&(o=function n(r){if(!R(r))return!1;var o=Array.isArray(r),i=o?[]:{};return Object.keys(r).forEach(function(e){var t=o?e:$(e);null===r[e]?i[t]=x:\"boolean\"==typeof r[e]?i[t]=r[e]?D:j:\"object\"==typeof r[e]?i[t]=n(r[e]):i[t]=r[e]}),i}(c))?(a.data=o,delete a.data._attachments):a.data=c,a.rev=r,a.deleted=a.revs[r].deleted?1:0,e||(a.seq=++v.seq,o=0,a.isNewDoc?o=a.deleted?0:1:a.wasDeleted!==a.deleted&&(o=a.deleted?-1:1),v.doc_count+=o),delete a.isNewDoc,delete a.wasDeleted,a.stemmedRevs&&a.stemmedRevs.forEach(function(e){delete a.revs[e]}),delete a.stemmedRevs,\"attachments\"in a||(a.attachments={}),c._attachments)for(var f in c._attachments){var l=c._attachments[f];if(l.stub){if(!(l.digest in a.attachments))return void(_=I.createError(I.MISSING_STUB),i.abort());a.attachments[l.digest].revs[u]=!0}else a.attachments[l.digest]=l,a.attachments[l.digest].revs={},a.attachments[l.digest].revs[u]=!0,c._attachments[f]={stub:!0,digest:l.digest,content_type:l.content_type,length:l.length,revpos:parseInt(u,10)}}e&&a.deleted?(i.objectStore(C).delete(a.id).onsuccess=function(){m[s]={ok:!0,id:a.id,rev:\"0-0\"}},E(s)):i.objectStore(C).put(a).onsuccess=function(){m[s]={ok:!0,id:a.id,rev:u},E(s)}}}))}n.forEach(function(e){t.objectStore(C).get(e.id).onsuccess=i})}function k(e){var t={id:e.metadata.id,rev:e.metadata.rev,rev_tree:e.metadata.rev_tree,revs:e.metadata.revs||{}};return t.revs[t.rev]={data:e.data,deleted:e.metadata.deleted},t}function E(e){e===g&&o.objectStore(q).put(v)}function u(n){if(n.stub)return Promise.resolve(n);var r;if(\"string\"==typeof n.data){if((r=function(e){try{return atob(e)}catch(e){return{error:I.createError(I.BAD_ARG,\"Attachment is not a valid base64 string\")}}}(n.data)).error)return Promise.reject(r.error);n.data=p.binaryStringToBlobOrBuffer(r,n.content_type)}else r=n.data;return new Promise(function(t){A.binaryMd5(r,function(e){n.digest=\"md5-\"+e,n.length=r.size||r.length||0,t(n)})})}for(var c,f,l=0,d=t.docs.length;l<d;l++){try{c=O.parseDoc(t.docs[l],h.new_edits,y)}catch(e){c=e}if(c.error)return r(c);i.push(k(c))}f=i.map(function(e){var n=e.revs[e.rev].data;if(!n._attachments)return Promise.resolve(n);e=Object.keys(n._attachments).map(function(e){return n._attachments[e].name=e,u(n._attachments[e])});return Promise.all(e).then(function(e){var t={};return e.forEach(function(e){delete(t[e.name]=e).name}),n._attachments=t,n})}),Promise.all(f).then(function(){e._openTransactionSafely([C,q],\"readwrite\",function(e,t){if(e)return r(e);(o=t).onabort=function(){r(_)},o.ontimeout=B(r),o.oncomplete=function(){n.notify(y.name),r(null,m)},s(o,i)})}).catch(function(e){r(e)})}function g(e,t,i,n){if(e.error)return n(e.error);if(0===i.limit)return u={total_rows:t.doc_count,offset:i.skip,rows:[]},i.update_seq&&(u.update_seq=t.seq),n(null,u);var r,o,a=[],s=[],u=\"startkey\"in i&&i.startkey,c=\"endkey\"in i&&i.endkey,f=\"key\"in i&&i.key,l=\"keys\"in i&&i.keys,d=i.skip||0,p=\"number\"==typeof i.limit?i.limit:-1,h=!1!==i.inclusive_end,v=\"descending\"in i&&i.descending?\"prev\":null;if(!l&&((o=function(e,t,n,r,o){try{if(e&&t)return o?IDBKeyRange.bound(t,e,!n,!1):IDBKeyRange.bound(e,t,!1,!n);if(e)return o?IDBKeyRange.upperBound(e):IDBKeyRange.lowerBound(e);if(t)return o?IDBKeyRange.lowerBound(t,!n):IDBKeyRange.upperBound(t,!n);if(r)return IDBKeyRange.only(r)}catch(e){return{error:e}}return null}(u,c,h,f,v))&&o.error))return u=i,c=t,h=o.error,f=n,\"DataError\"===h.name&&0===h.code?(r={total_rows:c.doc_count,offset:u.skip,rows:[]},u.update_seq&&(r.update_seq=c.seq),f(null,r)):void f(I.createError(I.IDB_ERROR,h.name,h.message));var y,_,g,m,b,c=e.txn.objectStore(C);if(e.txn.oncomplete=function(){Promise.all(s).then(function(){var e={total_rows:t.doc_count,offset:0,rows:a};i.update_seq&&(e.update_seq=t.seq),n(null,e)})},l)return y=i.keys,_=c,g=w,m=new Array(y.length),b=0,y.forEach(function(t,n){_.get(t).onsuccess=function(e){e.target.result?m[n]=e.target.result:m[n]={key:t,error:\"not_found\"},++b===y.length&&m.forEach(function(e){g(e)})}});function w(e){if(e.error&&l)return a.push(e),!0;var t={id:e.id,key:e.id,value:{rev:e.rev}};if(e.deleted)l&&(a.push(t),t.value.deleted=!0,t.doc=null);else if(d--<=0){if(a.push(t),i.include_docs){var n=t,r=e,t=r.revs[r.rev].data;if(n.doc=t,n.doc._id=r.id,n.doc._rev=r.rev,!i.conflicts||(e=S.collectConflicts(r)).length&&(n.doc._conflicts=e),i.attachments&&t._attachments)for(var o in t._attachments)s.push(k(o,r,n.doc,i.binary))}if(0==--p)return!1}return!0}(v?c.openCursor(o,v):c.openCursor(o)).onsuccess=function(e){var t=e.target.result&&e.target.result.value;if(t){if(/^_local/.test(t.id))return e.target.result.continue();w(t)&&e.target.result.continue()}}}function M(e,t,n,r,s){if(e.error)return s.complete(e.error);if(s.continuous)return o=r.name+\":\"+h.uuid(),t.addListener(r.name,o,n,s),void t.notify(r.name);var u=\"limit\"in s?s.limit:-1,o=(0===u&&(u=1),e.txn.objectStore(C).index(\"seq\")),c=h.filterChange(s),f=0,l=s.since||0,d=[],p=[];n=s.descending?o.openCursor(null,\"prev\"):o.openCursor(IDBKeyRange.lowerBound(s.since,!0)),e.txn.oncomplete=function(){Promise.all(p).then(function(){s.complete(null,{results:d,last_seq:l})})},n.onsuccess=function(e){if(e.target.result){var e=e.target.result,t=e.value;if(t.data=t.revs[t.rev].data,t.data._id=t.id,t.data._rev=t.rev,t.deleted&&(t.data._deleted=!0),s.doc_ids&&-1===s.doc_ids.indexOf(t.id))return e.continue();var n=s.processChange(t.data,t,s),r=(n.seq=t.seq,l=t.seq,c(n));if(\"object\"==typeof r)return s.complete(r);if(r)if(f++,s.return_docs&&d.push(n),s.include_docs&&s.attachments&&t.data._attachments){var o,i=[];for(o in t.data._attachments){var a=k(o,t,n.doc,s.binary);i.push(a),p.push(a)}Promise.all(i).then(function(){s.onChange(n)})}else s.onChange(n);f!==u&&e.continue()}}}function P(e,t,n){if(e.error)return n(e.error);e.txn.objectStore(C).get(t).onsuccess=function(e){e.target.result?n(null,e.target.result.rev_tree):n(I.createError(I.MISSING_DOC))}}function L(e,t,i,n){if(e.error)return n(e.error);var o=e.txn.objectStore(C);o.get(t).onsuccess=function(e){var n=e.target.result,r=(S.traverseRevTree(n.rev_tree,function(e,t,n,r,o){-1!==i.indexOf(t+\"-\"+n)&&(o.status=\"missing\")}),[]);i.forEach(function(e){if(e in n.revs){if(n.revs[e].data._attachments)for(var t in n.revs[e].data._attachments)r.push(n.revs[e].data._attachments[t].digest);delete n.revs[e]}}),r.forEach(function(t){i.forEach(function(e){delete n.attachments[t].revs[e]}),Object.keys(n.attachments[t].revs).length||delete n.attachments[t]}),o.put(n)},e.txn.oncomplete=function(){n()}}var T=null,F=\"￿\",U=Number.NEGATIVE_INFINITY,V=[[[[[[[[[[[[]]]]]]]]]]]];function K(e,t,s){var r=this,u=t.split(\"/\");return new Promise(function(a,n){r.get(\"_design/\"+u[0]).then(function(e){var t=c(e,u[1]);if(!t)throw new Error(\"ddoc \"+e._id+\" with view \"+u[1]+\" does not have map.options.def.fields defined.\");var o=s.skip,i=Number.isInteger(s.limit)&&s.limit;return function r(o,i,a){var s=f(i);return new Promise(function(n){o._openTransactionSafely([C],\"readonly\",function(e,t){if(e)return B(a)(e);t.onabort=B(a),t.ontimeout=B(a),-1===Array.from(t.objectStore(C).indexNames).indexOf(s)?o._freshen().then(function(){return r(o,i,a)}).then(n):n(t.objectStore(C).index(s))})})}(r,t,n).then(function(e){var t=function(t){function e(e,t){return void 0!==e[t]}function n(e,t){return[0].concat(e).map(function(e){if(null===e&&t)return x;if(!0===e)return D;if(!1===e)return j;if(!t){if(e===T)return U;if(e.hasOwnProperty(F))return V}return e})}var r,o;e(t,\"inclusive_end\")||(t.inclusive_end=!0),e(t,\"inclusive_start\")||(t.inclusive_start=!0),t.descending&&(r=t.startkey,o=t.inclusive_start,t.startkey=t.endkey,t.endkey=r,t.inclusive_start=t.inclusive_end,t.inclusive_end=o);try{return e(t,\"key\")?IDBKeyRange.only(n(t.key,!0)):e(t,\"startkey\")&&!e(t,\"endkey\")?IDBKeyRange.lowerBound(n(t.startkey),!t.inclusive_start):!e(t,\"startkey\")&&e(t,\"endkey\")?IDBKeyRange.upperBound(n(t.endkey),!t.inclusive_end):e(t,\"startkey\")&&e(t,\"endkey\")?IDBKeyRange.bound(n(t.startkey),n(t.endkey),!t.inclusive_start,!t.inclusive_end):IDBKeyRange.only([0])}catch(e){throw console.error(\"Could not generate keyRange\",e,t),Error(\"Could not generate key range with \"+JSON.stringify(t))}}(s),e=e.openCursor(t,s.descending?\"prev\":\"next\"),r=[];e.onerror=B(n),e.onsuccess=function(e){var t,n,e=e.target.result;return e&&0!==i?o?(e.advance(o),void(o=!1)):(i&&(i-=1),r.push({doc:(t=e.value,(n=t.revs[t.rev].data)._id=t.id,n._rev=t.rev,t.deleted&&(n._deleted=!0),n)}),void e.continue()):a({rows:r})}})}).catch(n)})}function z(){return Promise.resolve()}var m=\"indexeddb\",b=new h.changesHandler,w={};function E(a,e){function t(t){return function(){var n=Array.prototype.slice.call(arguments);d(w,0,a).then(function(e){u=e.metadata,n.unshift(e.idb),t.apply(s,n)}).catch(function(e){var t=n.unshift();\"function\"==typeof t?t(e):console.error(e)})}}function n(r){return function(){var n=Array.prototype.slice.call(arguments);return new Promise(function(e,t){d(w,0,a).then(function(e){return u=e.metadata,n.unshift(e.idb),r.apply(s,n)}).then(e).catch(t)})}}function r(r,o,i){return o=o||[C],i=i||\"readonly\",function(){var t=Array.prototype.slice.call(arguments),n={};d(w,0,a).then(function(e){u=e.metadata,n.txn=e.idb.transaction(o,i),t.unshift(n),r.apply(s,t)}).catch(function(e){console.error(\"Failed to establish transaction safely\"),console.error(e),n.error=e})}}var s=this,u={};s._openTransactionSafely=function(e,t,n){r(function(e,t){t(e.error,e.txn)},e,t)(n)},s._remote=!1,s.type=function(){return m},s._id=t(function(e,t){t(null,u.db_uuid)}),s._info=t(function(e,t){t(null,{doc_count:(t=u).doc_count,update_seq:t.seq})}),s._get=r(v),s._bulkDocs=t(function(e,t,n,r){_(s,t,n,u,a,b,r)}),s._allDocs=r(function(e,t,n){g(e,u,t,n)}),s._getAttachment=r(y),s._changes=r(function(e,t){M(e,b,s,a,t)}),s._getRevisionTree=r(P),s._doCompaction=r(L,[C],\"readwrite\"),s._customFindAbstractMapper={query:n(K),viewCleanup:n(z)},s._destroy=function(e,t){return r=a,o=w,i=t,b.removeAllListeners(r.name),void(r.name in o?o[r.name].then(function(e){e.idb.close(),n()}):n());function n(){indexedDB.deleteDatabase(r.name).onsuccess=function(){delete o[r.name],i(null,{ok:!0})}}var r,o,i},s._close=t(function(e,t){delete w[a.name],e.close(),t()}),s._freshen=function(){return new Promise(function(e){s._close(function(){t(e)()})})},setTimeout(function(){e(null,s)})}E.valid=function(){return!0},t.exports=function(e){e.adapter(m,E,!0)}},{20:20,22:22,23:23,24:24,25:25,37:37}],14:[function(e,t,n){\"use strict\";var r,o,i,a=[e(7),e(17),e(16),e(15),e(18),e(19)],s=-1,u=[],c=!1;function f(){r&&o&&(r=!1,o.length?u=o.concat(u):s=-1,u.length&&l())}function l(){if(!r){r=!(c=!1);for(var e=u.length,t=setTimeout(f);e;){for(o=u,u=[];o&&++s<e;)o[s].run();s=-1,e=u.length}o=null,r=!(s=-1),clearTimeout(t)}}for(var d=-1,p=a.length;++d<p;)if(a[d]&&a[d].test&&a[d].test()){i=a[d].install(l);break}function h(e,t){this.fun=e,this.array=t}h.prototype.run=function(){var e=this.fun,t=this.array;switch(t.length){case 0:return e();case 1:return e(t[0]);case 2:return e(t[0],t[1]);case 3:return e(t[0],t[1],t[2]);default:return e.apply(null,t)}},t.exports=function(e){var t=new Array(arguments.length-1);if(1<arguments.length)for(var n=1;n<arguments.length;n++)t[n-1]=arguments[n];u.push(new h(e,t)),c||r||(c=!0,i())}},{15:15,16:16,17:17,18:18,19:19,7:7}],15:[function(e,t,r){!function(n){\"use strict\";r.test=function(){return!n.setImmediate&&void 0!==n.MessageChannel},r.install=function(e){var t=new n.MessageChannel;return t.port1.onmessage=e,function(){t.port2.postMessage(0)}}}.call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],16:[function(e,t,n){!function(r){\"use strict\";var o=r.MutationObserver||r.WebKitMutationObserver;n.test=function(){return o},n.install=function(e){var t=0,e=new o(e),n=r.document.createTextNode(\"\");return e.observe(n,{characterData:!0}),function(){n.data=t=++t%2}}}.call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],17:[function(e,t,n){!function(t){\"use strict\";n.test=function(){return\"function\"==typeof t.queueMicrotask},n.install=function(e){return function(){t.queueMicrotask(e)}}}.call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],18:[function(e,t,r){!function(n){\"use strict\";r.test=function(){return\"document\"in n&&\"onreadystatechange\"in n.document.createElement(\"script\")},r.install=function(t){return function(){var e=n.document.createElement(\"script\");return e.onreadystatechange=function(){t(),e.onreadystatechange=null,e.parentNode.removeChild(e),e=null},n.document.documentElement.appendChild(e),t}}}.call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],19:[function(e,t,n){\"use strict\";n.test=function(){return!0},n.install=function(e){return function(){setTimeout(e,0)}}},{}],20:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var l=e(25),a=e(37),s=e(23),u=e(21),_=e(22),g=e(24);function r(e){return e.reduce(function(e,t){return e[t]=!0,e},{})}var d=r([\"_id\",\"_rev\",\"_attachments\",\"_deleted\",\"_revisions\",\"_revs_info\",\"_conflicts\",\"_deleted_conflicts\",\"_local_seq\",\"_rev_tree\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\",\"_removed\"]),p=r([\"_attachments\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\"]);function h(e){if(!/^\\d+-/.test(e))return _.createError(_.INVALID_REV);var t=e.indexOf(\"-\"),n=e.substring(0,t),e=e.substring(t+1);return{prefix:parseInt(n,10),id:e}}function v(e,t,n){n=n||{deterministic_revs:!0};var r,o,i,a={status:\"available\"};if(e._deleted&&(a.deleted=!0),t)if(e._id||(e._id=l.uuid()),o=l.rev(e,n.deterministic_revs),e._rev){if((i=h(e._rev)).error)return i;e._rev_tree=[{pos:i.prefix,ids:[i.id,{status:\"missing\"},[[o,a,[]]]]}],r=i.prefix+1}else e._rev_tree=[{pos:1,ids:[o,a,[]]}],r=1;else if(e._revisions&&(e._rev_tree=function(e,t){for(var n=e.start-e.ids.length+1,r=e.ids,o=[r[0],t,[]],i=1,a=r.length;i<a;i++)o=[r[i],{status:\"missing\"},[o]];return[{pos:n,ids:o}]}(e._revisions,a),r=e._revisions.start,o=e._revisions.ids[0]),!e._rev_tree){if((i=h(e._rev)).error)return i;r=i.prefix,o=i.id,e._rev_tree=[{pos:r,ids:[o,a,[]]}]}l.invalidIdError(e._id),e._rev=r+\"-\"+o;var s,u={metadata:{},data:{}};for(s in e)if(Object.prototype.hasOwnProperty.call(e,s)){var c,f=\"_\"===s[0];if(f&&!d[s])throw(c=_.createError(_.DOC_VALIDATION,s)).message=_.DOC_VALIDATION.message+\": \"+s,c;f&&!p[s]?u.metadata[s.slice(1)]=e[s]:u.data[s]=e[s]}return u}function c(t,e,n){var r=function(e){try{return a.atob(e)}catch(e){return{error:_.createError(_.BAD_ARG,\"Attachment is not a valid base64 string\")}}}(t.data);if(r.error)return n(r.error);t.length=r.length,t.data=\"blob\"===e?a.binaryStringToBlobOrBuffer(r,t.content_type):\"base64\"===e?a.btoa(r):r,s.binaryMd5(r,function(e){t.digest=\"md5-\"+e,n()})}function f(e,t,n){if(e.stub)return n();var r,o,i;\"string\"==typeof e.data?c(e,t,n):(r=e,o=t,i=n,s.binaryMd5(r.data,function(e){r.digest=\"md5-\"+e,r.length=r.data.size||r.data.length||0,\"binary\"===o?a.blobOrBufferToBinaryString(r.data,function(e){r.data=e,i()}):\"base64\"===o?a.blobOrBufferToBase64(r.data,function(e){r.data=e,i()}):i()}))}function m(e,t,n,r,o,i,a,s){if(g.revExists(t.rev_tree,n.metadata.rev)&&!s)return r[o]=n,i();var u=t.winningRev||g.winningRev(t),c=\"deleted\"in t?t.deleted:g.isDeleted(t,u),f=\"deleted\"in n.metadata?n.metadata.deleted:g.isDeleted(n.metadata),l=/^1-/.test(n.metadata.rev),u=(c&&!f&&s&&l&&((l=n.data)._rev=u,l._id=n.metadata.id,n=v(l,s)),g.merge(t.rev_tree,n.metadata.rev_tree[0],e));if(s&&(c&&f&&\"new_leaf\"!==u.conflicts||!c&&\"new_leaf\"!==u.conflicts||c&&!f&&\"new_branch\"===u.conflicts))return l=_.createError(_.REV_CONFLICT),r[o]=l,i();e=n.metadata.rev,n.metadata.rev_tree=u.tree,n.stemmedRevs=u.stemmedRevs||[],t.rev_map&&(n.metadata.rev_map=t.rev_map),s=g.winningRev(n.metadata),f=g.isDeleted(n.metadata,s),r=c===f?0:c<f?-1:1,l=e===s?f:g.isDeleted(n.metadata,e);a(n,s,f,l,!0,r,o,i)}n.invalidIdError=l.invalidIdError,n.normalizeDdocFunctionName=l.normalizeDdocFunctionName,n.parseDdocFunctionName=l.parseDdocFunctionName,n.isDeleted=g.isDeleted,n.isLocalId=g.isLocalId,n.allDocsKeysQuery=function(e,i){var t=i.keys,a={offset:i.skip};return Promise.all(t.map(function(o){var t=l.assign({key:o,deleted:\"ok\"},i);return[\"limit\",\"skip\",\"keys\"].forEach(function(e){delete t[e]}),new Promise(function(n,r){e._allDocs(t,function(e,t){if(e)return r(e);i.update_seq&&void 0!==t.update_seq&&(a.update_seq=t.update_seq),a.total_rows=t.total_rows,n(t.rows[0]||{key:o,error:\"not_found\"})})})})).then(function(e){return a.rows=e,a})},n.parseDoc=v,n.preprocessAttachments=function(e,i,t){if(!e.length)return t();var a,n=0;function s(){n++,e.length===n&&(a?t(a):t())}e.forEach(function(e){var t,n=e.data&&e.data._attachments?Object.keys(e.data._attachments):[],r=0;if(!n.length)return s();function o(e){a=e,++r===n.length&&s()}for(t in e.data._attachments)e.data._attachments.hasOwnProperty(t)&&f(e.data._attachments[t],i,o)})},n.processDocs=function(f,e,r,l,o,d,p,h,t){f=f||1e3;var v=h.new_edits,i=new u.Map,n=0,a=e.length;function y(){++n===a&&t&&t()}e.forEach(function(e,n){if(e._id&&g.isLocalId(e._id))return t=e._deleted?\"_removeLocal\":\"_putLocal\",void r[t](e,{ctx:o},function(e,t){d[n]=e||t,y()});var t=e.metadata.id;i.has(t)?(a--,i.get(t).push([e,n])):i.set(t,[[e,n]])}),i.forEach(function(a,s){var u=0;function c(){(++u<a.length?e:y)()}function e(){var e,t,n,r,o=a[u],i=o[0],o=o[1];l.has(s)?m(f,l.get(s),i,d,o,c,p,v):(e=g.merge([],i.metadata.rev_tree[0],f),i.metadata.rev_tree=e.tree,i.stemmedRevs=e.stemmedRevs||[],e=i,i=o,o=c,n=g.winningRev(e.metadata),r=g.isDeleted(e.metadata,n),\"was_delete\"in h&&r?(d[i]=_.createError(_.MISSING_DOC,\"deleted\"),o()):v&&\"missing\"===e.metadata.rev_tree[0].ids[1].status?(t=_.createError(_.REV_CONFLICT),d[i]=t,o()):p(e,n,r,r,!1,r?0:1,i,o))}e()})},n.updateDoc=m},{21:21,22:22,23:23,24:24,25:25,37:37}],21:[function(e,t,n){\"use strict\";function r(){this._store={}}function o(e){if(this._store=new r,e&&Array.isArray(e))for(var t=0,n=e.length;t<n;t++)this.add(e[t])}Object.defineProperty(n,\"__esModule\",{value:!0}),r.prototype.get=function(e){return this._store[\"$\"+e]},r.prototype.set=function(e,t){return this._store[\"$\"+e]=t,!0},r.prototype.has=function(e){return\"$\"+e in this._store},r.prototype.delete=function(e){var e=\"$\"+e,t=e in this._store;return delete this._store[e],t},r.prototype.forEach=function(e){for(var t=Object.keys(this._store),n=0,r=t.length;n<r;n++){var o=t[n];e(this._store[o],o.substring(1))}},Object.defineProperty(r.prototype,\"size\",{get:function(){return Object.keys(this._store).length}}),o.prototype.add=function(e){return this._store.set(e,!0)},o.prototype.has=function(e){return this._store.has(e)},o.prototype.forEach=function(n){this._store.forEach(function(e,t){n(t)})},Object.defineProperty(o.prototype,\"size\",{get:function(){return this._store.size}}),!function(){var e;if(\"undefined\"!=typeof Symbol&&\"undefined\"!=typeof Map&&\"undefined\"!=typeof Set)return(e=Object.getOwnPropertyDescriptor(Map,Symbol.species))&&\"get\"in e&&Map[Symbol.species]===Map}()?(n.Set=o,n.Map=r):(n.Set=Set,n.Map=Map)},{}],22:[function(e,t,n){\"use strict\";function r(e,t,n){Error.call(this,n),this.status=e,this.name=t,this.message=n,this.error=!0}Object.defineProperty(n,\"__esModule\",{value:!0}),((e=e(10))&&\"object\"==typeof e&&\"default\"in e?e.default:e)(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var e=new r(401,\"unauthorized\",\"Name or password is incorrect.\"),o=new r(400,\"bad_request\",\"Missing JSON list of 'docs'\"),i=new r(404,\"not_found\",\"missing\"),a=new r(409,\"conflict\",\"Document update conflict\"),s=new r(400,\"bad_request\",\"_id field must contain a string\"),u=new r(412,\"missing_id\",\"_id is required for puts\"),c=new r(400,\"bad_request\",\"Only reserved document ids may start with underscore.\"),f=new r(412,\"precondition_failed\",\"Database not open\"),l=new r(500,\"unknown_error\",\"Database encountered an unknown error\"),d=new r(500,\"badarg\",\"Some query argument is invalid\"),p=new r(400,\"invalid_request\",\"Request was invalid\"),h=new r(400,\"query_parse_error\",\"Some query parameter is invalid\"),v=new r(500,\"doc_validation\",\"Bad special document member\"),y=new r(400,\"bad_request\",\"Something wrong with the request\"),_=new r(400,\"bad_request\",\"Document must be a JSON object\"),g=new r(404,\"not_found\",\"Database not found\"),m=new r(500,\"indexed_db_went_bad\",\"unknown\"),b=new r(500,\"web_sql_went_bad\",\"unknown\"),w=new r(500,\"levelDB_went_went_bad\",\"unknown\"),k=new r(403,\"forbidden\",\"Forbidden by design doc validate_doc_update function\"),E=new r(400,\"bad_request\",\"Invalid rev format\"),O=new r(412,\"file_exists\",\"The database could not be created, the file already exists.\"),A=new r(412,\"missing_stub\",\"A pre-existing attachment stub wasn't found\"),I=new r(413,\"invalid_url\",\"Provided URL is invalid\");n.UNAUTHORIZED=e,n.MISSING_BULK_DOCS=o,n.MISSING_DOC=i,n.REV_CONFLICT=a,n.INVALID_ID=s,n.MISSING_ID=u,n.RESERVED_ID=c,n.NOT_OPEN=f,n.UNKNOWN_ERROR=l,n.BAD_ARG=d,n.INVALID_REQUEST=p,n.QUERY_PARSE_ERROR=h,n.DOC_VALIDATION=v,n.BAD_REQUEST=y,n.NOT_AN_OBJECT=_,n.DB_MISSING=g,n.WSQ_ERROR=b,n.LDB_ERROR=w,n.FORBIDDEN=k,n.INVALID_REV=E,n.FILE_EXISTS=O,n.MISSING_STUB=A,n.IDB_ERROR=m,n.INVALID_URL=I,n.createError=function(o,e){function t(e){for(var t=Object.getOwnPropertyNames(o),n=0,r=t.length;n<r;n++)\"function\"!=typeof o[t[n]]&&(this[t[n]]=o[t[n]]);void 0!==e&&(this.reason=e)}return t.prototype=r.prototype,new t(e)},n.generateErrorFromResponse=function(e){var t;return\"object\"!=typeof e&&(t=e,(e=l).data=t),\"error\"in e&&\"conflict\"===e.error&&(e.name=\"conflict\",e.status=409),\"name\"in e||(e.name=e.error||\"unknown\"),\"status\"in e||(e.status=500),\"message\"in e||(e.message=e.message||e.reason),e}},{10:10}],23:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var d=e(37),p=(e=e(26))&&\"object\"==typeof e&&\"default\"in e?e.default:e,h=self.setImmediate||self.setTimeout;function v(t,e,n,r,o){var i;(0<n||r<e.size)&&(n=n,r=r,e=(i=e).webkitSlice?i.webkitSlice(n,r):i.slice(n,r)),d.readAsArrayBuffer(e,function(e){t.append(e),o()})}function y(e,t,n,r,o){(0<n||r<t.length)&&(t=t.substring(n,r)),e.appendBinary(t),o()}n.binaryMd5=function(n,t){var e=\"string\"==typeof n,r=e?n.length:n.size,o=Math.min(32768,r),i=Math.ceil(r/o),a=0,s=new(e?p:p.ArrayBuffer),u=e?y:v;function c(){h(l)}function f(){var e=s.end(!0),e=d.btoa(e);t(e),s.destroy()}function l(){var e=a*o,t=e+o;u(s,n,e,t,++a<i?c:f)}l()},n.stringMd5=function(e){return p.hash(e)}},{26:26,37:37}],24:[function(e,t,n){\"use strict\";function s(e){for(var t,n,r,o=e.rev_tree.slice();f=o.pop();){var i=f.ids,a=i[2],s=f.pos;if(a.length)for(var u=0,c=a.length;u<c;u++)o.push({pos:s+1,ids:a[u]});else{var f=!!i[1].deleted,i=i[0];t&&!(r!==f?r:n!==s?n<s:t<i)||(t=i,n=s,r=f)}}return n+\"-\"+t}function p(e,t){for(var n,r=e.slice();n=r.pop();)for(var o=n.pos,i=n.ids,a=i[2],s=t(0===a.length,o,i[0],n.ctx,i[1]),u=0,c=a.length;u<c;u++)r.push({pos:o+1,ids:a[u],ctx:s})}function r(e,t){return e.pos-t.pos}function u(e){var i=[];p(e,function(e,t,n,r,o){e&&i.push({rev:t+\"-\"+n,pos:t,opts:o})}),i.sort(r).reverse();for(var t=0,n=i.length;t<n;t++)delete i[t].pos;return i}function h(e){for(var t,n=[],r=e.slice();t=r.pop();){var o=t.pos,i=t.ids,a=i[0],s=i[1],u=i[2],i=0===u.length,c=t.history?t.history.slice():[];c.push({id:a,opts:s}),i&&n.push({pos:o+1-c.length,ids:c});for(var f=0,l=u.length;f<l;f++)r.push({pos:o+1,ids:u[f],history:c})}return n.reverse()}function m(e,t){return e.pos-t.pos}function f(e,t,n){n=function(e,t,n){for(var r,o=0,i=e.length;o<i;)n(e[r=o+i>>>1],t)<0?o=1+r:i=r;return o}(e,t,n);e.splice(n,0,t)}function v(e,t){for(var n,r,o=t,i=e.length;o<i;o++){var a=e[o],a=[a.id,a.opts,[]];r?(r[2].push(a),r=a):n=r=a}return n}function l(e,t){return e[0]<t[0]?-1:1}function b(e,t){for(var n=[{tree1:e,tree2:t}],r=!1;0<n.length;){var o=n.pop(),i=o.tree1,a=o.tree2;(i[1].status||a[1].status)&&(i[1].status=\"available\"===i[1].status||\"available\"===a[1].status?\"available\":\"missing\");for(var s=0;s<a[2].length;s++)if(i[2][0]){for(var u=!1,c=0;c<i[2].length;c++)i[2][c][0]===a[2][s][0]&&(n.push({tree1:i[2][c],tree2:a[2][s]}),u=!0);u||(r=\"new_branch\",f(i[2],a[2][s],l))}else r=\"new_leaf\",i[2][0]=a[2][s]}return{conflicts:r,tree:e}}function y(e,t,n){var r,o=[],i=!1,a=!1;if(!e.length)return{tree:[t],conflicts:\"new_leaf\"};for(var s=0,u=e.length;s<u;s++){var c=e[s];if(c.pos===t.pos&&c.ids[0]===t.ids[0])r=b(c.ids,t.ids),o.push({pos:c.pos,ids:r.tree}),i=i||r.conflicts,a=!0;else if(!0!==n){var f=c.pos<t.pos?c:t,l=c.pos<t.pos?t:c,d=l.pos-f.pos,p=[],h=[];for(h.push({ids:f.ids,diff:d,parent:null,parentIdx:null});0<h.length;){var v=h.pop();if(0===v.diff)v.ids[0]===l.ids[0]&&p.push(v);else for(var y=v.ids[2],_=0,g=y.length;_<g;_++)h.push({ids:y[_],diff:v.diff-1,parent:v.ids,parentIdx:_})}d=p[0];d?(r=b(d.ids,l.ids),d.parent[2][d.parentIdx]=r.tree,o.push({pos:f.pos,ids:f.ids}),i=i||r.conflicts,a=!0):o.push(c)}else o.push(c)}return a||o.push(t),o.sort(m),{tree:o,conflicts:i||\"internal_node\"}}function i(e){return e.ids}Object.defineProperty(n,\"__esModule\",{value:!0}),n.collectConflicts=function(e){for(var t=s(e),n=u(e.rev_tree),r=[],o=0,i=n.length;o<i;o++){var a=n[o];a.rev===t||a.opts.deleted||r.push(a.rev)}return r},n.collectLeaves=u,n.compactTree=function(e){var i=[];return p(e.rev_tree,function(e,t,n,r,o){\"available\"!==o.status||e||(i.push(t+\"-\"+n),o.status=\"missing\")}),i},n.isDeleted=function(e,t){for(var n,r=(t=t||s(e)).substring(t.indexOf(\"-\")+1),o=e.rev_tree.map(i);n=o.pop();){if(n[0]===r)return!!n[1].deleted;o=o.concat(n[2])}},n.isLocalId=function(e){return/^_local/.test(e)},n.merge=function(e,t,n){return e=y(e,t),{tree:(t=function(e,t){for(var n,r=h(e),o=0,i=r.length;o<i;o++){var a=r[o],s=a.ids;if(s.length>t)for(var u=u||{},c=s.length-t,f={pos:a.pos+c,ids:v(s,c)},l=0;l<c;l++){var d=a.pos+l+\"-\"+s[l].id;u[d]=!0}else f={pos:a.pos,ids:v(s,0)};n=n?y(n,f,!0).tree:[f]}return u&&p(n,function(e,t,n){delete u[t+\"-\"+n]}),{tree:n,revs:u?Object.keys(u):[]}}(e.tree,n)).tree,stemmedRevs:t.revs,conflicts:e.conflicts}},n.revExists=function(e,t){for(var n,r=e.slice(),e=t.split(\"-\"),o=parseInt(e[0],10),i=e[1];n=r.pop();){if(n.pos===o&&n.ids[0]===i)return!0;for(var a=n.ids[2],s=0,u=a.length;s<u;s++)r.push({pos:n.pos+1,ids:a[s]})}return!1},n.rootToLeaf=h,n.traverseRevTree=p,n.winningRev=s,n.latest=function(e,t){for(var n,r=t.rev_tree.slice();n=r.pop();){var o=n.pos,i=n.ids,a=i[0],s=i[1],u=i[2],i=0===u.length,c=n.history?n.history.slice():[];if(c.push({id:a,pos:o,opts:s}),i)for(var f=0,l=c.length;f<l;f++){var d=c[f];if(d.pos+\"-\"+d.id===e)return o+\"-\"+a}for(var p=0,h=u.length;p<h;p++)r.push({pos:o+1,ids:u[p],history:c})}throw new Error(\"Unable to resolve latest revision for id \"+t.id+\", rev \"+e)}},{}],25:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}Object.defineProperty(n,\"__esModule\",{value:!0});var o=r(e(6)),i=e(21),a=r(e(10)),s=r(e(14)),u=e(22),c=r(e(8)),f=e(28),l=e(23);function d(e){if(e instanceof ArrayBuffer){if(\"function\"==typeof(r=e).slice)return r.slice(0);var t=new ArrayBuffer(r.byteLength),n=new Uint8Array(t),r=new Uint8Array(r);return n.set(r),t}n=e.size,r=e.type;return\"function\"==typeof e.slice?e.slice(0,n,r):e.webkitSlice(0,n,r)}var p=Function.prototype.toString,h=p.call(Object);function v(e){var t,n,r,o,i;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;n<r;n++)t[n]=v(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o=e,\"undefined\"!=typeof ArrayBuffer&&o instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&o instanceof Blob)return d(e);if(o=e,!(null===(o=Object.getPrototypeOf(o))||\"function\"==typeof(o=o.constructor)&&o instanceof o&&p.call(o)==h))return e;for(n in t={},e)!Object.prototype.hasOwnProperty.call(e,n)||void 0!==(i=v(e[n]))&&(t[n]=i);return t}function y(t){var n=!1;return o(function(e){if(n)throw new Error(\"once called more than once\");n=!0,t.apply(this,e)})}function _(a){return o(function(o){o=v(o);var i=this,t=\"function\"==typeof o[o.length-1]&&o.pop(),e=new Promise(function(n,r){var e;try{var t=y(function(e,t){e?r(e):n(t)});o.push(t),(e=a.apply(i,o))&&\"function\"==typeof e.then&&n(e)}catch(e){r(e)}});return t&&e.then(function(e){t(null,e)},t),e})}function g(e,t){for(var n={},r=0,o=t.length;r<o;r++){var i=t[r];i in e&&(n[i]=e[i])}return n}var m;function b(e){return e}function w(e){return[{ok:e}]}try{localStorage.setItem(\"_pouch_check_localstorage\",1),m=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(e){m=!1}function k(){return m}function E(){var t;c.call(this),this._listeners={},t=this,m&&addEventListener(\"storage\",function(e){t.emit(e.key)})}function O(e){var t;\"undefined\"!=typeof console&&\"function\"==typeof console[e]&&(t=Array.prototype.slice.call(arguments,1),console[e].apply(console,t))}a(E,c),E.prototype.addListener=function(e,t,n,r){var o,i;function a(){var e;o._listeners[t]&&(i?i=\"waiting\":(i=!0,e=g(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\",\"return_docs\"]),n.changes(e).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===i&&s(a),i=!1}).on(\"error\",function(){i=!1})))}this._listeners[t]||(i=!1,(o=this)._listeners[t]=a,this.on(e,a))},E.prototype.removeListener=function(e,t){t in this._listeners&&(c.prototype.removeListener.call(this,e,this._listeners[t]),delete this._listeners[t])},E.prototype.notifyLocalWindows=function(e){m&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},E.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};e=\"function\"==typeof Object.assign?Object.assign:function(e){for(var t=Object(e),n=1;n<arguments.length;n++){var r=arguments[n];if(null!=r)for(var o in r)Object.prototype.hasOwnProperty.call(r,o)&&(t[o]=r[o])}return t};a=function(){}.name?function(e){return e.name}:function(e){e=e.toString().match(/^\\s*function\\s*(?:(\\S+)\\s*)?\\(/);return e&&e[1]?e[1]:\"\"};function A(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}var I=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],S=\"queryKey\",x=/(?:^|&)([^&=]*)=?([^&]*)/g,j=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/;function D(s,u,c){return new Promise(function(i,a){s.get(u,function(e,t){if(e){if(404!==e.status)return a(e);t={}}var n,r,o,e=t._rev,t=c(t);if(!t)return i({updated:!1,rev:e});t._id=u,t._rev=e,i((r=t,o=c,(n=s).put(r).then(function(e){return{updated:!0,rev:e.rev}},function(e){if(409!==e.status)throw e;return D(n,r._id,o)})))})})}var $=f.v4;n.adapterFun=function(u,c){return _(o(function(r){if(this._closed)return Promise.reject(new Error(\"database is closed\"));if(this._destroyed)return Promise.reject(new Error(\"database is destroyed\"));var o=this,i=o,a=u,e=r;if(i.constructor.listeners(\"debug\").length){for(var t=[\"api\",i.name,a],n=0;n<e.length-1;n++)t.push(e[n]);i.constructor.emit(\"debug\",t);var s=e[e.length-1];e[e.length-1]=function(e,t){var n=(n=[\"api\",i.name,a]).concat(e?[\"error\",e]:[\"success\",t]);i.constructor.emit(\"debug\",n),s(e,t)}}return this.taskqueue.isReady?c.apply(this,r):new Promise(function(t,n){o.taskqueue.addTask(function(e){e?n(e):t(o[u].apply(o,r))})})}))},n.assign=e,n.bulkGetShim=function(a,s,e){var t=s.docs,u=new i.Map,r=(t.forEach(function(e){u.has(e.id)?u.get(e.id).push(e):u.set(e.id,[e])}),u.size),o=0,c=new Array(r);function f(){var n;++o===r&&(n=[],c.forEach(function(t){t.docs.forEach(function(e){n.push({id:t.id,docs:[e]})})}),e(null,{results:n}))}var n=[],l=(u.forEach(function(e,t){n.push(t)}),0);function d(){var e,i;l>=n.length||(e=Math.min(l+6,n.length),e=n.slice(l,e),i=l,e.forEach(function(n,e){var r=i+e,e=u.get(n),t=g(e[0],[\"atts_since\",\"attachments\"]),o=(t.open_revs=e.map(function(e){return e.rev}),t.open_revs=t.open_revs.filter(b),b);0===t.open_revs.length&&(delete t.open_revs,o=w),[\"revs\",\"attachments\",\"binary\",\"ajax\",\"latest\"].forEach(function(e){e in s&&(t[e]=s[e])}),a.get(n,t,function(e,t){e=e?[{error:e}]:o(t);t=e,c[r]={id:n,docs:t},f(),d()})}),l+=e.length)}d()},n.changesHandler=E,n.clone=v,n.defaultBackOff=function(e){var t,n;return t=(e=e)?0:2e3,e=parseInt(e,10)||0,(t=parseInt(t,10))!=t||t<=e?t=(e||1)<<1:t+=1,6e5<t&&(e=3e5,t=6e5),n=Math.random(),~~((t-e)*n+e)},n.explainError=function(e,t){O(\"info\",\"The above \"+e+\" is totally normal. \"+t)},n.filterChange=function(r){var o={},i=r.filter&&\"function\"==typeof r.filter;return o.query=r.query_params,function(e){e.doc||(e.doc={});var t=i&&function(t,e,n){try{return!t(e,n)}catch(e){t=\"Filter function threw: \"+e.toString();return u.createError(u.BAD_REQUEST,t)}}(r.filter,e.doc,o);if(\"object\"==typeof t)return t;if(t)return!1;if(r.include_docs){if(!r.attachments)for(var n in e.doc._attachments)e.doc._attachments.hasOwnProperty(n)&&(e.doc._attachments[n].stub=!0)}else delete e.doc;return!0}},n.flatten=function(e){for(var t=[],n=0,r=e.length;n<r;n++)t=t.concat(e[n]);return t},n.functionName=a,n.guardedConsole=O,n.hasLocalStorage=k,n.invalidIdError=function(e){var t;if(e?\"string\"!=typeof e?t=u.createError(u.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=u.createError(u.RESERVED_ID)):t=u.createError(u.MISSING_ID),t)throw t},n.isRemote=function(e){return\"boolean\"==typeof e._remote?e._remote:\"function\"==typeof e.type&&(O(\"warn\",\"db.type() is deprecated and will be removed in a future version of PouchDB\"),\"http\"===e.type())},n.listenerCount=function(e,t){return\"listenerCount\"in e?e.listenerCount(t):c.listenerCount(e,t)},n.nextTick=s,n.normalizeDdocFunctionName=function(e){return(e=A(e))?e.join(\"/\"):null},n.once=y,n.parseDdocFunctionName=A,n.parseUri=function(e){for(var t=j.exec(e),r={},n=14;n--;){var o=I[n],i=t[n]||\"\",a=-1!==[\"user\",\"password\"].indexOf(o);r[o]=a?decodeURIComponent(i):i}return r[S]={},r[I[12]].replace(x,function(e,t,n){t&&(r[S][t]=n)}),r},n.pick=g,n.rev=function(e,t){return e=v(e),t?(delete e._rev_tree,l.stringMd5(JSON.stringify(e))):f.v4().replace(/-/g,\"\").toLowerCase()},n.scopeEval=function(e,t){var n,r=[],o=[];for(n in t)t.hasOwnProperty(n)&&(r.push(n),o.push(t[n]));return r.push(e),Function.apply(null,r).apply(null,o)},n.toPromise=_,n.upsert=D,n.uuid=$},{10:10,14:14,21:21,22:22,23:23,28:28,6:6,8:8}],26:[function(e,t,n){function r(o){\"use strict\";var r=[\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"];function u(e,t){var n=e[0],r=e[1],o=e[2],i=e[3],r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[0]-680876936|0)<<7|n>>>25)+r|0)&r|~n&o)+t[1]-389564586|0)<<12|i>>>20)+n|0)&n|~i&r)+t[2]+606105819|0)<<17|o>>>15)+i|0)&i|~o&n)+t[3]-1044525330|0)<<22|r>>>10)+o|0;r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[4]-176418897|0)<<7|n>>>25)+r|0)&r|~n&o)+t[5]+1200080426|0)<<12|i>>>20)+n|0)&n|~i&r)+t[6]-1473231341|0)<<17|o>>>15)+i|0)&i|~o&n)+t[7]-45705983|0)<<22|r>>>10)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[8]+1770035416|0)<<7|n>>>25)+r|0)&r|~n&o)+t[9]-1958414417|0)<<12|i>>>20)+n|0)&n|~i&r)+t[10]-42063|0)<<17|o>>>15)+i|0)&i|~o&n)+t[11]-1990404162|0)<<22|r>>>10)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[12]+1804603682|0)<<7|n>>>25)+r|0)&r|~n&o)+t[13]-40341101|0)<<12|i>>>20)+n|0)&n|~i&r)+t[14]-1502002290|0)<<17|o>>>15)+i|0)&i|~o&n)+t[15]+1236535329|0)<<22|r>>>10)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[1]-165796510|0)<<5|n>>>27)+r|0)&o|r&~o)+t[6]-1069501632|0)<<9|i>>>23)+n|0)&r|n&~r)+t[11]+643717713|0)<<14|o>>>18)+i|0)&n|i&~n)+t[0]-373897302|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[5]-701558691|0)<<5|n>>>27)+r|0)&o|r&~o)+t[10]+38016083|0)<<9|i>>>23)+n|0)&r|n&~r)+t[15]-660478335|0)<<14|o>>>18)+i|0)&n|i&~n)+t[4]-405537848|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[9]+568446438|0)<<5|n>>>27)+r|0)&o|r&~o)+t[14]-1019803690|0)<<9|i>>>23)+n|0)&r|n&~r)+t[3]-187363961|0)<<14|o>>>18)+i|0)&n|i&~n)+t[8]+1163531501|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[13]-1444681467|0)<<5|n>>>27)+r|0)&o|r&~o)+t[2]-51403784|0)<<9|i>>>23)+n|0)&r|n&~r)+t[7]+1735328473|0)<<14|o>>>18)+i|0)&n|i&~n)+t[12]-1926607734|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[5]-378558|0)<<4|n>>>28)+r|0)^r^o)+t[8]-2022574463|0)<<11|i>>>21)+n|0)^n^r)+t[11]+1839030562|0)<<16|o>>>16)+i|0)^i^n)+t[14]-35309556|0)<<23|r>>>9)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[1]-1530992060|0)<<4|n>>>28)+r|0)^r^o)+t[4]+1272893353|0)<<11|i>>>21)+n|0)^n^r)+t[7]-155497632|0)<<16|o>>>16)+i|0)^i^n)+t[10]-1094730640|0)<<23|r>>>9)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[13]+681279174|0)<<4|n>>>28)+r|0)^r^o)+t[0]-358537222|0)<<11|i>>>21)+n|0)^n^r)+t[3]-722521979|0)<<16|o>>>16)+i|0)^i^n)+t[6]+76029189|0)<<23|r>>>9)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[9]-640364487|0)<<4|n>>>28)+r|0)^r^o)+t[12]-421815835|0)<<11|i>>>21)+n|0)^n^r)+t[15]+530742520|0)<<16|o>>>16)+i|0)^i^n)+t[2]-995338651|0)<<23|r>>>9)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[0]-198630844|0)<<6|n>>>26)+r|0)|~o))+t[7]+1126891415|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[14]-1416354905|0)<<15|o>>>17)+i|0)|~n))+t[5]-57434055|0)<<21|r>>>11)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[12]+1700485571|0)<<6|n>>>26)+r|0)|~o))+t[3]-1894986606|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[10]-1051523|0)<<15|o>>>17)+i|0)|~n))+t[1]-2054922799|0)<<21|r>>>11)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[8]+1873313359|0)<<6|n>>>26)+r|0)|~o))+t[15]-30611744|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[6]-1560198380|0)<<15|o>>>17)+i|0)|~n))+t[13]+1309151649|0)<<21|r>>>11)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[4]-145523070|0)<<6|n>>>26)+r|0)|~o))+t[11]-1120210379|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[2]+718787259|0)<<15|o>>>17)+i|0)|~n))+t[9]-343485551|0)<<21|r>>>11)+o|0,e[0]=n+e[0]|0,e[1]=r+e[1]|0,e[2]=o+e[2]|0,e[3]=i+e[3]|0}function c(e){for(var t=[],n=0;n<64;n+=4)t[n>>2]=e.charCodeAt(n)+(e.charCodeAt(n+1)<<8)+(e.charCodeAt(n+2)<<16)+(e.charCodeAt(n+3)<<24);return t}function f(e){for(var t=[],n=0;n<64;n+=4)t[n>>2]=e[n]+(e[n+1]<<8)+(e[n+2]<<16)+(e[n+3]<<24);return t}function n(e){for(var t,n,r,o,i=e.length,a=[1732584193,-271733879,-1732584194,271733878],s=64;s<=i;s+=64)u(a,c(e.substring(s-64,s)));for(t=(e=e.substring(s-64)).length,n=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],s=0;s<t;s+=1)n[s>>2]|=e.charCodeAt(s)<<(s%4<<3);if(n[s>>2]|=128<<(s%4<<3),55<s)for(u(a,n),s=0;s<16;s+=1)n[s]=0;return o=(o=8*i).toString(16).match(/(.*?)(.{0,8})$/),r=parseInt(o[2],16),o=parseInt(o[1],16)||0,n[14]=r,n[15]=o,u(a,n),a}function a(e){for(var t=0;t<e.length;t+=1)e[t]=function(e){for(var t=\"\",n=0;n<4;n+=1)t+=r[e>>8*n+4&15]+r[e>>8*n&15];return t}(e[t]);return e.join(\"\")}function i(e,t){return(e=0|e||0)<0?Math.max(e+t,0):Math.min(e,t)}function s(e){return e=/[\\u0080-\\uFFFF]/.test(e)?unescape(encodeURIComponent(e)):e}function l(e){for(var t=[],n=e.length,r=0;r<n-1;r+=2)t.push(parseInt(e.substr(r,2),16));return String.fromCharCode.apply(String,t)}function d(){this.reset()}return\"5d41402abc4b2a76b9719d911017c592\"!==a(n(\"hello\"))&&0,\"undefined\"==typeof ArrayBuffer||ArrayBuffer.prototype.slice||(ArrayBuffer.prototype.slice=function(e,t){var n=this.byteLength,e=i(e,n),r=n;return(r=t!==o?i(t,n):r)<e?new ArrayBuffer(0):(t=r-e,n=new ArrayBuffer(t),r=new Uint8Array(n),e=new Uint8Array(this,e,t),r.set(e),n)}),d.prototype.append=function(e){return this.appendBinary(s(e)),this},d.prototype.appendBinary=function(e){this._buff+=e,this._length+=e.length;for(var t=this._buff.length,n=64;n<=t;n+=64)u(this._hash,c(this._buff.substring(n-64,n)));return this._buff=this._buff.substring(n-64),this},d.prototype.end=function(e){for(var t,n=this._buff,r=n.length,o=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],i=0;i<r;i+=1)o[i>>2]|=n.charCodeAt(i)<<(i%4<<3);return this._finish(o,r),t=a(this._hash),e&&(t=l(t)),this.reset(),t},d.prototype.reset=function(){return this._buff=\"\",this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},d.prototype.getState=function(){return{buff:this._buff,length:this._length,hash:this._hash.slice()}},d.prototype.setState=function(e){return this._buff=e.buff,this._length=e.length,this._hash=e.hash,this},d.prototype.destroy=function(){delete this._hash,delete this._buff,delete this._length},d.prototype._finish=function(e,t){var n,r=t;if(e[r>>2]|=128<<(r%4<<3),55<r)for(u(this._hash,e),r=0;r<16;r+=1)e[r]=0;t=(t=8*this._length).toString(16).match(/(.*?)(.{0,8})$/),n=parseInt(t[2],16),t=parseInt(t[1],16)||0,e[14]=n,e[15]=t,u(this._hash,e)},d.hash=function(e,t){return d.hashBinary(s(e),t)},d.hashBinary=function(e,t){e=a(n(e));return t?l(e):e},(d.ArrayBuffer=function(){this.reset()}).prototype.append=function(e){n=this._buff.buffer,r=e,o=!0,(i=new Uint8Array(n.byteLength+r.byteLength)).set(new Uint8Array(n)),i.set(new Uint8Array(r),n.byteLength);var t,n,r,o,i,a=o?i:i.buffer,s=a.length;for(this._length+=e.byteLength,t=64;t<=s;t+=64)u(this._hash,f(a.subarray(t-64,t)));return this._buff=t-64<s?new Uint8Array(a.buffer.slice(t-64)):new Uint8Array(0),this},d.ArrayBuffer.prototype.end=function(e){for(var t,n=this._buff,r=n.length,o=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],i=0;i<r;i+=1)o[i>>2]|=n[i]<<(i%4<<3);return this._finish(o,r),t=a(this._hash),e&&(t=l(t)),this.reset(),t},d.ArrayBuffer.prototype.reset=function(){return this._buff=new Uint8Array(0),this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},d.ArrayBuffer.prototype.getState=function(){var e,t=d.prototype.getState.call(this);return t.buff=(e=t.buff,String.fromCharCode.apply(null,new Uint8Array(e))),t},d.ArrayBuffer.prototype.setState=function(e){return e.buff=function(e,t){for(var n=e.length,r=new ArrayBuffer(n),o=new Uint8Array(r),i=0;i<n;i+=1)o[i]=e.charCodeAt(i);return t?o:r}(e.buff,!0),d.prototype.setState.call(this,e)},d.ArrayBuffer.prototype.destroy=d.prototype.destroy,d.ArrayBuffer.prototype._finish=d.prototype._finish,d.ArrayBuffer.hash=function(e,t){e=a(function(e){for(var t,n,r,o,i=e.length,a=[1732584193,-271733879,-1732584194,271733878],s=64;s<=i;s+=64)u(a,f(e.subarray(s-64,s)));for(t=(e=s-64<i?e.subarray(s-64):new Uint8Array(0)).length,n=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],s=0;s<t;s+=1)n[s>>2]|=e[s]<<(s%4<<3);if(n[s>>2]|=128<<(s%4<<3),55<s)for(u(a,n),s=0;s<16;s+=1)n[s]=0;return o=(o=8*i).toString(16).match(/(.*?)(.{0,8})$/),r=parseInt(o[2],16),o=parseInt(o[1],16)||0,n[14]=r,n[15]=o,u(a,n),a}(new Uint8Array(e)));return t?l(e):e},d}var o;if(\"object\"==typeof n)t.exports=r();else if(\"function\"==typeof define&&define.amd)define(r);else{try{o=window}catch(e){o=self}o.SparkMD5=r()}},{}],27:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0;const r=[];for(let e=0;e<256;++e)r.push((e+256).toString(16).substr(1));n.default=function(e,t){var t=t||0,n=r;return(n[e[t+0]]+n[e[t+1]]+n[e[t+2]]+n[e[t+3]]+\"-\"+n[e[t+4]]+n[e[t+5]]+\"-\"+n[e[t+6]]+n[e[t+7]]+\"-\"+n[e[t+8]]+n[e[t+9]]+\"-\"+n[e[t+10]]+n[e[t+11]]+n[e[t+12]]+n[e[t+13]]+n[e[t+14]]+n[e[t+15]]).toLowerCase()}},{}],28:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),Object.defineProperty(n,\"v1\",{enumerable:!0,get:function(){return r.default}}),Object.defineProperty(n,\"v3\",{enumerable:!0,get:function(){return o.default}}),Object.defineProperty(n,\"v4\",{enumerable:!0,get:function(){return i.default}}),Object.defineProperty(n,\"v5\",{enumerable:!0,get:function(){return a.default}});var r=s(e(32)),o=s(e(33)),i=s(e(35)),a=s(e(36));function s(e){return e&&e.__esModule?e:{default:e}}},{32:32,33:33,35:35,36:36}],29:[function(e,t,n){\"use strict\";function f(e){return 14+(e+64>>>9<<4)+1}function l(e,t){var n=(65535&e)+(65535&t);return(e>>16)+(t>>16)+(n>>16)<<16|65535&n}function s(e,t,n,r,o,i){return l((t=l(l(t,e),l(r,i)))<<o|t>>>32-o,n)}function d(e,t,n,r,o,i,a){return s(t&n|~t&r,e,t,o,i,a)}function p(e,t,n,r,o,i,a){return s(t&r|n&~r,e,t,o,i,a)}function h(e,t,n,r,o,i,a){return s(t^n^r,e,t,o,i,a)}function v(e,t,n,r,o,i,a){return s(n^(t|~r),e,t,o,i,a)}Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0,n.default=function(t){if(\"string\"==typeof t){const o=unescape(encodeURIComponent(t));t=new Uint8Array(o.length);for(let e=0;e<o.length;++e)t[e]=o.charCodeAt(e)}{var n=function(t,e){t[e>>5]|=128<<e%32,t[f(e)-1]=e;let n=1732584193,r=-271733879,o=-1732584194,i=271733878;for(let e=0;e<t.length;e+=16){var a=n,s=r,u=o,c=i;n=d(n,r,o,i,t[e],7,-680876936),i=d(i,n,r,o,t[e+1],12,-389564586),o=d(o,i,n,r,t[e+2],17,606105819),r=d(r,o,i,n,t[e+3],22,-1044525330),n=d(n,r,o,i,t[e+4],7,-176418897),i=d(i,n,r,o,t[e+5],12,1200080426),o=d(o,i,n,r,t[e+6],17,-1473231341),r=d(r,o,i,n,t[e+7],22,-45705983),n=d(n,r,o,i,t[e+8],7,1770035416),i=d(i,n,r,o,t[e+9],12,-1958414417),o=d(o,i,n,r,t[e+10],17,-42063),r=d(r,o,i,n,t[e+11],22,-1990404162),n=d(n,r,o,i,t[e+12],7,1804603682),i=d(i,n,r,o,t[e+13],12,-40341101),o=d(o,i,n,r,t[e+14],17,-1502002290),r=d(r,o,i,n,t[e+15],22,1236535329),n=p(n,r,o,i,t[e+1],5,-165796510),i=p(i,n,r,o,t[e+6],9,-1069501632),o=p(o,i,n,r,t[e+11],14,643717713),r=p(r,o,i,n,t[e],20,-373897302),n=p(n,r,o,i,t[e+5],5,-701558691),i=p(i,n,r,o,t[e+10],9,38016083),o=p(o,i,n,r,t[e+15],14,-660478335),r=p(r,o,i,n,t[e+4],20,-405537848),n=p(n,r,o,i,t[e+9],5,568446438),i=p(i,n,r,o,t[e+14],9,-1019803690),o=p(o,i,n,r,t[e+3],14,-187363961),r=p(r,o,i,n,t[e+8],20,1163531501),n=p(n,r,o,i,t[e+13],5,-1444681467),i=p(i,n,r,o,t[e+2],9,-51403784),o=p(o,i,n,r,t[e+7],14,1735328473),r=p(r,o,i,n,t[e+12],20,-1926607734),n=h(n,r,o,i,t[e+5],4,-378558),i=h(i,n,r,o,t[e+8],11,-2022574463),o=h(o,i,n,r,t[e+11],16,1839030562),r=h(r,o,i,n,t[e+14],23,-35309556),n=h(n,r,o,i,t[e+1],4,-1530992060),i=h(i,n,r,o,t[e+4],11,1272893353),o=h(o,i,n,r,t[e+7],16,-155497632),r=h(r,o,i,n,t[e+10],23,-1094730640),n=h(n,r,o,i,t[e+13],4,681279174),i=h(i,n,r,o,t[e],11,-358537222),o=h(o,i,n,r,t[e+3],16,-722521979),r=h(r,o,i,n,t[e+6],23,76029189),n=h(n,r,o,i,t[e+9],4,-640364487),i=h(i,n,r,o,t[e+12],11,-421815835),o=h(o,i,n,r,t[e+15],16,530742520),r=h(r,o,i,n,t[e+2],23,-995338651),n=v(n,r,o,i,t[e],6,-198630844),i=v(i,n,r,o,t[e+7],10,1126891415),o=v(o,i,n,r,t[e+14],15,-1416354905),r=v(r,o,i,n,t[e+5],21,-57434055),n=v(n,r,o,i,t[e+12],6,1700485571),i=v(i,n,r,o,t[e+3],10,-1894986606),o=v(o,i,n,r,t[e+10],15,-1051523),r=v(r,o,i,n,t[e+1],21,-2054922799),n=v(n,r,o,i,t[e+8],6,1873313359),i=v(i,n,r,o,t[e+15],10,-30611744),o=v(o,i,n,r,t[e+6],15,-1560198380),r=v(r,o,i,n,t[e+13],21,1309151649),n=v(n,r,o,i,t[e+4],6,-145523070),i=v(i,n,r,o,t[e+11],10,-1120210379),o=v(o,i,n,r,t[e+2],15,718787259),r=v(r,o,i,n,t[e+9],21,-343485551),n=l(n,a),r=l(r,s),o=l(o,u),i=l(i,c)}return[n,r,o,i]}(function(t){if(0===t.length)return[];const n=8*t.length,r=new Uint32Array(f(n));for(let e=0;e<n;e+=8)r[e>>5]|=(255&t[e/8])<<e%32;return r}(t),8*t.length);const i=[],a=32*n.length,s=\"0123456789abcdef\";for(let e=0;e<a;e+=8){var r=n[e>>5]>>>e%32&255,r=parseInt(s.charAt(r>>>4&15)+s.charAt(15&r),16);i.push(r)}return i}}},{}],30:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=function(){if(r)return r(o);throw new Error(\"crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported\")};const r=\"undefined\"!=typeof crypto&&crypto.getRandomValues&&crypto.getRandomValues.bind(crypto)||\"undefined\"!=typeof msCrypto&&\"function\"==typeof msCrypto.getRandomValues&&msCrypto.getRandomValues.bind(msCrypto),o=new Uint8Array(16)},{}],31:[function(e,t,n){\"use strict\";function l(e,t){return e<<t|e>>>32-t}Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0,n.default=function(n){var s=[1518500249,1859775393,2400959708,3395469782];const e=[1732584193,4023233417,2562383102,271733878,3285377520];if(\"string\"==typeof n){const o=unescape(encodeURIComponent(n));n=[];for(let e=0;e<o.length;++e)n.push(o.charCodeAt(e))}n.push(128);var t=n.length/4+2,r=Math.ceil(t/16);const u=new Array(r);for(let t=0;t<r;++t){const i=new Uint32Array(16);for(let e=0;e<16;++e)i[e]=n[64*t+4*e]<<24|n[64*t+4*e+1]<<16|n[64*t+4*e+2]<<8|n[64*t+4*e+3];u[t]=i}u[r-1][14]=8*(n.length-1)/Math.pow(2,32),u[r-1][14]=Math.floor(u[r-1][14]),u[r-1][15]=8*(n.length-1)&4294967295;for(let a=0;a<r;++a){const f=new Uint32Array(80);for(let e=0;e<16;++e)f[e]=u[a][e];for(let e=16;e<80;++e)f[e]=l(f[e-3]^f[e-8]^f[e-14]^f[e-16],1);let t=e[0],n=e[1],r=e[2],o=e[3],i=e[4];for(let e=0;e<80;++e){var c=Math.floor(e/20),c=l(t,5)+function(e,t,n,r){switch(e){case 0:return t&n^~t&r;case 1:return t^n^r;case 2:return t&n^t&r^n&r;case 3:return t^n^r}}(c,n,r,o)+i+s[c]+f[e]>>>0;i=o,o=r,r=l(n,30)>>>0,n=t,t=c}e[0]=e[0]+t>>>0,e[1]=e[1]+n>>>0,e[2]=e[2]+r>>>0,e[3]=e[3]+o>>>0,e[4]=e[4]+i>>>0}return[e[0]>>24&255,e[0]>>16&255,e[0]>>8&255,255&e[0],e[1]>>24&255,e[1]>>16&255,e[1]>>8&255,255&e[1],e[2]>>24&255,e[2]>>16&255,e[2]>>8&255,255&e[2],e[3]>>24&255,e[3]>>16&255,e[3]>>8&255,255&e[3],e[4]>>24&255,e[4]>>16&255,e[4]>>8&255,255&e[4]]}},{}],32:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0;var c=r(e(30)),f=r(e(27));function r(e){return e&&e.__esModule?e:{default:e}}let l,d,p=0,h=0;n.default=function(e,t,n){var r=t&&n||0;const o=t||[];let i=(e=e||{}).node||l,a=void 0!==e.clockseq?e.clockseq:d,s=(null!=i&&null!=a||(n=e.random||(e.rng||c.default)(),null==i&&(i=l=[1|n[0],n[1],n[2],n[3],n[4],n[5]]),null==a&&(a=d=16383&(n[6]<<8|n[7]))),void 0!==e.msecs?e.msecs:Date.now()),u=void 0!==e.nsecs?e.nsecs:h+1;if((n=s-p+(u-h)/1e4)<0&&void 0===e.clockseq&&(a=a+1&16383),1e4<=(u=(n<0||s>p)&&void 0===e.nsecs?0:u))throw new Error(\"uuid.v1(): Can't create more than 10M uuids/sec\");p=s,h=u,d=a,n=(1e4*(268435455&(s+=122192928e5))+u)%4294967296,o[r++]=n>>>24&255,o[r++]=n>>>16&255,o[r++]=n>>>8&255,o[r++]=255&n,e=s/4294967296*1e4&268435455,o[r++]=e>>>8&255,o[r++]=255&e,o[r++]=e>>>24&15|16,o[r++]=e>>>16&255,o[r++]=a>>>8|128,o[r++]=255&a;for(let e=0;e<6;++e)o[r+e]=i[e];return t||(0,f.default)(o)}},{27:27,30:30}],33:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0;var r=o(e(34)),e=o(e(29));function o(e){return e&&e.__esModule?e:{default:e}}r=(0,r.default)(\"v3\",48,e.default);n.default=r},{29:29,34:34}],34:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=function(e,a,s){function t(e,t,n,r){var o=n&&r||0;if(\"string\"==typeof e&&(e=function(t){t=unescape(encodeURIComponent(t));const n=[];for(let e=0;e<t.length;++e)n.push(t.charCodeAt(e));return n}(e)),\"string\"==typeof t&&(t=function(e){const t=[];return e.replace(/[a-fA-F0-9]{2}/g,function(e){t.push(parseInt(e,16))}),t}(t)),!Array.isArray(e))throw TypeError(\"value must be an array of bytes\");if(!Array.isArray(t)||16!==t.length)throw TypeError(\"namespace must be uuid string or an Array of 16 byte values\");const i=s(t.concat(e));if(i[6]=15&i[6]|a,i[8]=63&i[8]|128,n)for(let e=0;e<16;++e)n[o+e]=i[e];return n||(0,u.default)(i)}try{t.name=e}catch(e){}return t.DNS=r,t.URL=o,t},n.URL=n.DNS=void 0;var u=(e=e(27))&&e.__esModule?e:{default:e};const r=\"6ba7b810-9dad-11d1-80b4-00c04fd430c8\",o=(n.DNS=r,\"6ba7b811-9dad-11d1-80b4-00c04fd430c8\");n.URL=o},{27:27}],35:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0;var i=r(e(30)),a=r(e(27));function r(e){return e&&e.__esModule?e:{default:e}}n.default=function(e,t,n){\"string\"==typeof e&&(t=\"binary\"===e?new Uint8Array(16):null,e=null);const r=(e=e||{}).random||(e.rng||i.default)();if(r[6]=15&r[6]|64,r[8]=63&r[8]|128,t){var o=n||0;for(let e=0;e<16;++e)t[o+e]=r[e];return t}return(0,a.default)(r)}},{27:27,30:30}],36:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0;var r=o(e(34)),e=o(e(31));function o(e){return e&&e.__esModule?e:{default:e}}r=(0,r.default)(\"v5\",80,e.default);n.default=r},{31:31,34:34}],37:[function(e,t,n){arguments[4][12][0].apply(n,arguments)},{12:12}],38:[function(e,t,n){\"use strict\";var s=e(47),u=e(49),c=e(50);function r(e,t){if(e.selector&&(e.filter&&\"_selector\"!==e.filter))return e=\"string\"==typeof e.filter?e.filter:\"function\",t(new Error('selector invalid for filter \"'+e+'\"'));t()}function o(e){e.view&&!e.filter&&(e.filter=\"_view\"),e.selector&&!e.filter&&(e.filter=\"_selector\"),e.filter&&\"string\"==typeof e.filter&&(\"_view\"===e.filter?e.view=c.normalizeDdocFunctionName(e.view):e.filter=c.normalizeDdocFunctionName(e.filter))}function i(e,t){return t.filter&&\"string\"==typeof t.filter&&!t.doc_ids&&!c.isRemote(e.db)}function a(n,r){var e,o,i=r.complete;if(\"_view\"===r.filter){if(!r.view||\"string\"!=typeof r.view)return e=s.createError(s.BAD_REQUEST,\"`view` filter parameter not found or invalid.\"),i(e);var a=c.parseDdocFunctionName(r.view);n.db.get(\"_design/\"+a[0],function(e,t){return n.isCancelled?i(null,{status:\"cancelled\"}):e?i(s.generateErrorFromResponse(e)):(e=t&&t.views&&t.views[a[1]]&&t.views[a[1]].map)?(r.filter=(e=[\"return function(doc) {\",'  \"use strict\";',\"  var emitted = false;\",\"  var emit = function (a, b) {\",\"    emitted = true;\",\"  };\",\"  var view = \"+(e=e)+\";\",\"  view(doc);\",\"  if (emitted) {\",\"    return true;\",\"  }\",\"};\"].join(\"\\n\"),c.scopeEval(e,{})),void n.doChanges(r)):i(s.createError(s.MISSING_DOC,t.views?\"missing json key: \"+a[1]:\"missing json key: views\"))})}else r.selector?(r.filter=function(e){return u.matchesSelector(e,r.selector)},n.doChanges(r)):(o=c.parseDdocFunctionName(r.filter),n.db.get(\"_design/\"+o[0],function(e,t){return n.isCancelled?i(null,{status:\"cancelled\"}):e?i(s.generateErrorFromResponse(e)):(e=t&&t.filters&&t.filters[o[1]])?(r.filter=c.scopeEval('\"use strict\";\\nreturn '+e+\";\",{}),void n.doChanges(r)):i(s.createError(s.MISSING_DOC,t&&t.filters?\"missing json key: \"+o[1]:\"missing json key: filters\"))}))}t.exports=function(e){e._changesFilterPlugin={validate:r,normalize:o,shouldFilter:i,filter:a}}},{47:47,49:49,50:50}],39:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14,40:40,41:41,42:42,43:43,44:44,7:7}],40:[function(e,t,n){arguments[4][15][0].apply(n,arguments)},{15:15}],41:[function(e,t,n){arguments[4][16][0].apply(n,arguments)},{16:16}],42:[function(e,t,n){arguments[4][17][0].apply(n,arguments)},{17:17}],43:[function(e,t,n){arguments[4][18][0].apply(n,arguments)},{18:18}],44:[function(e,t,n){arguments[4][19][0].apply(n,arguments)},{19:19}],45:[function(e,t,n){\"use strict\";function f(e,t,n){return function(e,t,n){for(var r=\"\",o=n-e.length;r.length<o;)r+=t;return r}(e,t,n)+e}Object.defineProperty(n,\"__esModule\",{value:!0});var p=-324,h=3,l=\"\";function s(e,t){if(e===t)return 0;e=a(e),t=a(t);var n,r,o=u(e),i=u(t);if(o-i!=0)return o-i;switch(typeof e){case\"number\":return e-t;case\"boolean\":return e<t?-1:1;case\"string\":return(n=e)===(r=t)?0:r<n?1:-1}return(Array.isArray(e)?function(e,t){for(var n=Math.min(e.length,t.length),r=0;r<n;r++){var o=s(e[r],t[r]);if(0!==o)return o}return e.length===t.length?0:e.length>t.length?1:-1}:function(e,t){for(var n=Object.keys(e),r=Object.keys(t),o=Math.min(n.length,r.length),i=0;i<o;i++){var a=s(n[i],r[i]);if(0!==a)return a;if(0!==(a=s(e[n[i]],t[r[i]])))return a}return n.length===r.length?0:n.length>r.length?1:-1})(e,t)}function a(e){switch(typeof e){case\"undefined\":return null;case\"number\":return e===1/0||e===-1/0||isNaN(e)?null:e;case\"object\":var t,n=e;if(Array.isArray(e)){var r=e.length;e=new Array(r);for(var o=0;o<r;o++)e[o]=a(n[o])}else{if(e instanceof Date)return e.toJSON();if(null!==e)for(var i in e={},n)!n.hasOwnProperty(i)||void 0!==(t=n[i])&&(e[i]=a(t))}}return e}function r(e){if(null!==e)switch(typeof e){case\"boolean\":return e?1:0;case\"number\":var t=e;if(0===t)return\"1\";var n=t.toExponential().split(/e\\+?/),r=parseInt(n[1],10),o=(t=t<0)?\"0\":\"2\",r=f(((t?-r:r)-p).toString(),\"0\",h),r=(o+=l+r,Math.abs(parseFloat(n[0])));return n=(n=(r=t?10-r:r).toFixed(20)).replace(/\\.?0+$/,\"\"),o+=l+n;case\"string\":return e.replace(/\\u0002/g,\"\u0002\u0002\").replace(/\\u0001/g,\"\u0001\u0002\").replace(/\\u0000/g,\"\u0001\u0001\");case\"object\":var t=Array.isArray(e),i=t?e:Object.keys(e),a=-1,s=i.length,u=\"\";if(t)for(;++a<s;)u+=d(i[a]);else for(;++a<s;){var c=i[a];u+=d(c)+d(e[c])}return u}return\"\"}function d(e){return u(e=a(e))+l+r(e)+\"\\0\"}function u(e){var t=[\"boolean\",\"number\",\"string\",\"object\"].indexOf(typeof e);return~t?null===e?1:Array.isArray(e)?5:t<3?t+2:t+3:Array.isArray(e)?5:void 0}n.collate=s,n.normalizeKey=a,n.toIndexableString=d,n.parseIndexableString=function(e){for(var t,n,r,o,i=[],a=[],s=0;;){var u=e[s++];if(\"\\0\"===u){if(1===i.length)return i.pop();n=a,o=r=void 0,o=(t=i).pop(),n.length&&(o===(r=n[n.length-1]).element&&(n.pop(),r=n[n.length-1]),n=r.element,r=r.index,Array.isArray(n)?n.push(o):r===t.length-2?n[t.pop()]=o:t.push(o))}else switch(u){case\"1\":i.push(null);break;case\"2\":i.push(\"1\"===e[s]),s++;break;case\"3\":var c=function(e,t){var n,r=t;if(\"1\"===e[t])n=0,t++;else{var o=\"0\"===e[t],i=\"\",a=e.substring(++t,t+h),a=parseInt(a,10)+p;for(o&&(a=-a),t+=h;;){var s=e[t];if(\"\\0\"===s)break;i+=s,t++}n=1===(i=i.split(\".\")).length?parseInt(i,10):parseFloat(i[0]+\".\"+i[1]),o&&(n-=10),0!==a&&(n=parseFloat(n+\"e\"+a))}return{num:n,length:t-r}}(e,s);i.push(c.num),s+=c.length;break;case\"4\":for(var f=\"\";;){var l=e[s];if(\"\\0\"===l)break;f+=l,s++}f=f.replace(/\\u0001\\u0001/g,\"\\0\").replace(/\\u0001\\u0002/g,\"\u0001\").replace(/\\u0002\\u0002/g,\"\u0002\"),i.push(f);break;case\"5\":c={element:[],index:i.length};i.push(c.element),a.push(c);break;case\"6\":var d={element:{},index:i.length};i.push(d.element),a.push(d);break;default:throw new Error(\"bad collationIndex or unexpectedly reached end of input: \"+u)}}}},{}],46:[function(e,t,n){arguments[4][21][0].apply(n,arguments)},{21:21}],47:[function(e,t,n){arguments[4][22][0].apply(n,arguments)},{10:10,22:22}],48:[function(e,t,n){arguments[4][23][0].apply(n,arguments)},{23:23,37:37,51:51}],49:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var s=e(50),i=e(45);function u(e,t){for(var n=e,r=0,o=t.length;r<o&&(n=n[t[r]]);r++);return n}function a(e,t){return e<t?-1:t<e?1:0}function c(e){for(var t=[],n=\"\",r=0,o=e.length;r<o;r++){var i=e[r];\".\"===i?n=0<r&&\"\\\\\"===e[r-1]?n.substring(0,n.length-1)+\".\":(t.push(n),\"\"):n+=i}return t.push(n),t}var r=[\"$or\",\"$nor\",\"$not\"];function f(e){return-1<r.indexOf(e)}function l(e){return Object.keys(e)[0]}function d(e){return e[l(e)]}function p(e){var n={};return e.forEach(function(t){Object.keys(t).forEach(function(e){var s,u=t[e];\"object\"!=typeof u&&(u={$eq:u}),f(e)?u instanceof Array?n[e]=u.map(function(e){return p([e])}):n[e]=p([u]):(s=n[e]=n[e]||{},Object.keys(u).forEach(function(e){var t,n,r,o,i,a=u[e];return\"$gt\"===e||\"$gte\"===e?(r=e,o=a,void(void 0===(i=s).$eq&&(void 0!==i.$gte?\"$gte\"===r?o>i.$gte&&(i.$gte=o):o>=i.$gte&&(delete i.$gte,i.$gt=o):void 0!==i.$gt?\"$gte\"===r?o>i.$gt&&(delete i.$gt,i.$gte=o):o>i.$gt&&(i.$gt=o):i[r]=o))):\"$lt\"===e||\"$lte\"===e?(i=e,r=a,void(void 0===(o=s).$eq&&(void 0!==o.$lte?\"$lte\"===i?r<o.$lte&&(o.$lte=r):r<=o.$lte&&(delete o.$lte,o.$lt=r):void 0!==o.$lt?\"$lte\"===i?r<o.$lt&&(delete o.$lt,o.$lte=r):r<o.$lt&&(o.$lt=r):o[i]=r))):\"$ne\"===e?(t=a,void(\"$ne\"in(n=s)?n.$ne.push(t):n.$ne=[t])):\"$eq\"===e?(n=a,delete(t=s).$gt,delete t.$gte,delete t.$lt,delete t.$lte,delete t.$ne,void(t.$eq=n)):void(s[e]=a)}))})}),n}function o(e){for(var t=s.clone(e),n=!1,r=(!function e(t,n){for(var r in t)\"$and\"===r&&(n=!0),\"object\"==typeof(r=t[r])&&(n=e(r,n));return n}(t,!1)||(\"$and\"in(t=function e(t){for(var n in t){if(Array.isArray(t))for(var r in t)t[r].$and&&(t[r]=p(t[r].$and));\"object\"==typeof(n=t[n])&&e(n)}return t}(t))&&(t=p(t.$and)),n=!0),[\"$or\",\"$nor\"].forEach(function(e){e in t&&t[e].forEach(function(e){for(var t=Object.keys(e),n=0;n<t.length;n++){var r=t[n],o=e[r];\"object\"==typeof o&&null!==o||(e[r]={$eq:o})}})}),\"$not\"in t&&(t.$not=p([t.$not])),Object.keys(t)),o=0;o<r.length;o++){var i=r[o],a=t[i];\"object\"!=typeof a||null===a?a={$eq:a}:\"$ne\"in a&&!n&&(a.$ne=[a.$ne]),t[i]=a}return t}function h(e){function o(t){return e.map(function(e){e=c(l(e));return u(t,e)})}return function(e,t){var n=o(e.doc),r=o(t.doc),n=i.collate(n,r);return 0!==n?n:a(e.doc._id,t.doc._id)}}function v(e,t,n){var r,o;return e=e.filter(function(e){return y(e.doc,t.selector,n)}),t.sort&&(r=h(t.sort),e=e.sort(r),\"string\"!=typeof t.sort[0]&&\"desc\"===d(t.sort[0])&&(e=e.reverse())),(\"limit\"in t||\"skip\"in t)&&(r=t.skip||0,o=(\"limit\"in t?t.limit:e.length)+r,e=e.slice(r,o)),e}function y(a,s,e){return e.every(function(e){var t,n,r=s[e],o=c(e),i=u(a,o);return f(e)?(t=r,n=a,\"$or\"!==(e=e)?\"$not\"!==e?!t.find(function(e){return y(n,e,Object.keys(e))}):!y(n,t,Object.keys(t)):t.some(function(e){return y(n,e,Object.keys(e))})):_(r,a,o,i)})}function _(i,a,s,u){return!i||(\"object\"==typeof i?Object.keys(i).every(function(e){var t=i[e],n=a,r=s,o=u;if(w[e])return w[e](n,t,r,o);throw new Error('unknown operator \"'+e+'\" - should be one of $eq, $lte, $lt, $gt, $gte, $exists, $ne, $in, $nin, $size, $mod, $regex, $elemMatch, $type, $allMatch or $all')}):i===u)}function g(e){return null!=e}function m(e){return void 0!==e}function b(t,e){return e.some(function(e){return t instanceof Array?-1<t.indexOf(e):t===e})}var w={$elemMatch:function(t,n,r,e){return!!Array.isArray(e)&&(0!==e.length&&(\"object\"==typeof e[0]?e.some(function(e){return y(e,n,Object.keys(n))}):e.some(function(e){return _(n,t,r,e)})))},$allMatch:function(t,n,r,e){return!!Array.isArray(e)&&(0!==e.length&&(\"object\"==typeof e[0]?e.every(function(e){return y(e,n,Object.keys(n))}):e.every(function(e){return _(n,t,r,e)})))},$eq:function(e,t,n,r){return m(r)&&0===i.collate(r,t)},$gte:function(e,t,n,r){return m(r)&&0<=i.collate(r,t)},$gt:function(e,t,n,r){return m(r)&&0<i.collate(r,t)},$lte:function(e,t,n,r){return m(r)&&i.collate(r,t)<=0},$lt:function(e,t,n,r){return m(r)&&i.collate(r,t)<0},$exists:function(e,t,n,r){return t?m(r):!m(r)},$mod:function(e,t,n,r){return g(r)&&function(e,t){var n=t[0],t=t[1];if(0===n)throw new Error(\"Bad divisor, cannot divide by zero\");if(parseInt(n,10)!==n)throw new Error(\"Divisor is not an integer\");if(parseInt(t,10)!==t)throw new Error(\"Modulus is not an integer\");return parseInt(e,10)===e&&e%n===t}(r,t)},$ne:function(e,t,n,r){return t.every(function(e){return 0!==i.collate(r,e)})},$in:function(e,t,n,r){return g(r)&&b(r,t)},$nin:function(e,t,n,r){return g(r)&&!b(r,t)},$size:function(e,t,n,r){return g(r)&&r.length===t},$all:function(e,t,n,r){return Array.isArray(r)&&(o=r,t.every(function(e){return-1<o.indexOf(e)}));var o},$regex:function(e,t,n,r){return g(r)&&(r=r,new RegExp(t).test(r))},$type:function(e,t,n,r){var o=r,r=t;switch(r){case\"null\":return null===o;case\"boolean\":return\"boolean\"==typeof o;case\"number\":return\"number\"==typeof o;case\"string\":return\"string\"==typeof o;case\"array\":return o instanceof Array;case\"object\":return\"[object Object]\"==={}.toString.call(o)}throw new Error(r+\" not supported as a type.Please use one of object, string, array, number, boolean or null.\")}};n.massageSelector=o,n.matchesSelector=function(e,t){if(\"object\"!=typeof t)throw new Error(\"Selector error: expected a JSON object\");return(e=v([{doc:e}],{selector:t=o(t)},Object.keys(t)))&&1===e.length},n.filterInMemoryFields=v,n.createFieldSorter=h,n.rowFilter=y,n.isCombinationalField=f,n.getKey=l,n.getValue=d,n.getFieldFromDoc=u,n.setFieldInDoc=function(e,t,n){for(var r=0,o=t.length;r<o-1;r++){var i=t[r];e=e[i]=e[i]||{}}e[t[o-1]]=n},n.compare=a,n.parseField=c},{45:45,50:50}],50:[function(e,t,n){arguments[4][25][0].apply(n,arguments)},{10:10,25:25,39:39,46:46,47:47,48:48,53:53,6:6,8:8}],51:[function(e,t,n){arguments[4][26][0].apply(n,arguments)},{26:26}],52:[function(e,t,n){arguments[4][27][0].apply(n,arguments)},{27:27}],53:[function(e,t,n){arguments[4][28][0].apply(n,arguments)},{28:28,57:57,58:58,60:60,61:61}],54:[function(e,t,n){arguments[4][29][0].apply(n,arguments)},{29:29}],55:[function(e,t,n){arguments[4][30][0].apply(n,arguments)},{30:30}],56:[function(e,t,n){arguments[4][31][0].apply(n,arguments)},{31:31}],57:[function(e,t,n){arguments[4][32][0].apply(n,arguments)},{32:32,52:52,55:55}],58:[function(e,t,n){arguments[4][33][0].apply(n,arguments)},{33:33,54:54,59:59}],59:[function(e,t,n){arguments[4][34][0].apply(n,arguments)},{34:34,52:52}],60:[function(e,t,n){arguments[4][35][0].apply(n,arguments)},{35:35,52:52,55:55}],61:[function(e,t,n){arguments[4][36][0].apply(n,arguments)},{36:36,56:56,59:59}],62:[function(e,t,n){arguments[4][45][0].apply(n,arguments)},{45:45}],63:[function(e,t,n){arguments[4][21][0].apply(n,arguments)},{21:21}],64:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}var i=e(71),a=r(e(6)),b=e(75),p=e(72),h=e(76),o=r(e(10)),s=r(e(8)),u=e(73),e=r(e(38));function c(n,t,r){s.call(this);var o=this,i=(this.db=n,(t=t?h.clone(t):{}).complete=h.once(function(e,t){e?0<h.listenerCount(o,\"error\")&&o.emit(\"error\",e):o.emit(\"complete\",t),o.removeAllListeners(),n.removeListener(\"destroyed\",a)}));function a(){o.cancel()}r&&(o.on(\"complete\",function(e){r(null,e)}),o.on(\"error\",r)),n.once(\"destroyed\",a),t.onChange=function(e,t,n){if(!o.isCancelled){var r=o;try{r.emit(\"change\",e,t,n)}catch(e){h.guardedConsole(\"error\",'Error in .on(\"change\", function):',e)}}};var e=new Promise(function(n,r){t.complete=function(e,t){e?r(e):n(t)}});o.once(\"cancel\",function(){n.removeListener(\"destroyed\",a),t.complete(null,{status:\"cancelled\"})}),this.then=e.then.bind(e),this.catch=e.catch.bind(e),this.then(function(e){i(null,e)},i),n.taskqueue.isReady?o.validateChanges(t):n.taskqueue.addTask(function(e){e?t.complete(e):o.isCancelled?o.emit(\"cancel\"):o.validateChanges(t)})}function f(e,t,n){var r=[{rev:e._rev}],r=(\"all_docs\"===n.style&&(r=b.collectLeaves(t.rev_tree).map(function(e){return{rev:e.rev}})),{id:t.id,changes:r,doc:e});return b.isDeleted(t,e._rev)&&(r.deleted=!0),n.conflicts&&(r.doc._conflicts=b.collectConflicts(t),r.doc._conflicts.length||delete r.doc._conflicts),r}function l(e,t){return e<t?-1:t<e?1:0}function d(n,r){return function(e,t){e||t[0]&&t[0].error?((e=e||t[0]).docId=r,n(e)):n(null,t.length?t[0]:t)}}function v(e,t){var n=l(e._id,t._id);return 0!==n?n:l(e._revisions?e._revisions.start:0,t._revisions?t._revisions.start:0)}function y(){for(var e in s.call(this),y.prototype)\"function\"==typeof this[e]&&(this[e]=this[e].bind(this))}function _(){this.isReady=!1,this.failed=!1,this.queue=[]}function g(e,t){if(!(this instanceof g))return new g(e,t);var o=this;if(t=t||{},e&&\"object\"==typeof e&&(e=(t=e).name,delete t.name),void 0===t.deterministic_revs&&(t.deterministic_revs=!0),this.__opts=t=h.clone(t),o.auto_compaction=t.auto_compaction,o.prefix=g.prefix,\"string\"!=typeof e)throw new Error(\"Missing/invalid DB name\");var n=function(e,t){var n=e.match(/([a-z-]*):\\/\\/(.*)/);if(n)return{name:/https?/.test(n[1])?n[1]+\"://\"+n[2]:n[2],adapter:n[1]};var r=g.adapters,o=g.preferredAdapters,i=g.prefix,a=t.adapter;if(!a)for(var s=0;s<o.length&&(\"idb\"===(a=o[s])&&\"websql\"in r&&h.hasLocalStorage()&&localStorage[\"_pouch__websqldb_\"+i+e]);++s)h.guardedConsole(\"log\",'PouchDB is downgrading \"'+e+'\" to WebSQL to avoid data loss, because it was already opened with WebSQL.');return{name:!((n=r[a])&&\"use_prefix\"in n)||n.use_prefix?i+e:e,adapter:a}}((t.prefix||\"\")+e,t);if(t.name=n.name,t.adapter=t.adapter||n.adapter,o.name=e,o._adapter=t.adapter,g.emit(\"debug\",[\"adapter\",\"Picked adapter: \",t.adapter]),!g.adapters[t.adapter]||!g.adapters[t.adapter].valid())throw new Error(\"Invalid Adapter: \"+t.adapter);y.call(o),o.taskqueue=new _,o.adapter=t.adapter,g.adapters[t.adapter].call(o,t,function(e){if(e)return o.taskqueue.fail(e);function t(e){r.removeListener(\"closed\",n),e||r.constructor.emit(\"destroyed\",r.name)}function n(){r.removeListener(\"destroyed\",t),r.constructor.emit(\"unref\",r)}var r;(r=o).once(\"destroyed\",t),r.once(\"closed\",n),r.constructor.emit(\"ref\",r),o.emit(\"created\",o),g.emit(\"created\",o.name),o.taskqueue.ready(o)})}o(c,s),c.prototype.cancel=function(){this.isCancelled=!0,this.db.taskqueue.isReady&&this.emit(\"cancel\")},c.prototype.validateChanges=function(t){var n=t.complete,r=this;g._changesFilterPlugin?g._changesFilterPlugin.validate(t,function(e){if(e)return n(e);r.doChanges(t)}):r.doChanges(t)},c.prototype.doChanges=function(t){var n=this,r=t.complete;if(\"live\"in(t=h.clone(t))&&!(\"continuous\"in t)&&(t.continuous=t.live),t.processChange=f,\"latest\"===t.since&&(t.since=\"now\"),t.since||(t.since=0),\"now\"===t.since)this.db.info().then(function(e){n.isCancelled?r(null,{status:\"cancelled\"}):(t.since=e.update_seq,n.doChanges(t))},r);else{if(g._changesFilterPlugin){if(g._changesFilterPlugin.normalize(t),g._changesFilterPlugin.shouldFilter(this,t))return g._changesFilterPlugin.filter(this,t)}else[\"doc_ids\",\"filter\",\"selector\",\"view\"].forEach(function(e){e in t&&h.guardedConsole(\"warn\",'The \"'+e+'\" option was passed in to changes/replicate, but pouchdb-changes-filter plugin is not installed, so it was ignored. Please install the plugin to enable filtering.')});\"descending\"in t||(t.descending=!1),t.limit=0===t.limit?1:t.limit,t.complete=r;var o,i=this.db._changes(t);i&&\"function\"==typeof i.cancel&&(o=n.cancel,n.cancel=a(function(e){i.cancel(),o.apply(this,e)}))}},o(y,s),y.prototype.post=h.adapterFun(\"post\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e))return n(p.createError(p.NOT_AN_OBJECT));this.bulkDocs({docs:[e]},t,d(n,e._id))}),y.prototype.put=h.adapterFun(\"put\",function(n,t,r){if(\"function\"==typeof t&&(r=t,t={}),\"object\"!=typeof n||Array.isArray(n))return r(p.createError(p.NOT_AN_OBJECT));if(h.invalidIdError(n._id),b.isLocalId(n._id)&&\"function\"==typeof this._putLocal)return n._deleted?this._removeLocal(n,r):this._putLocal(n,r);var e,o,i,a=this;function s(e){\"function\"==typeof a._put&&!1!==t.new_edits?a._put(n,t,e):a.bulkDocs({docs:[n]},t,d(e,n._id))}t.force&&n._rev?(e=n._rev.split(\"-\"),o=e[1],e=parseInt(e[0],10)+1,i=h.rev(),n._revisions={start:e,ids:[i,o]},n._rev=e+\"-\"+i,t.new_edits=!1,s(function(e){var t=e?null:{ok:!0,id:n._id,rev:n._rev};r(e,t)})):s(r)}),y.prototype.putAttachment=h.adapterFun(\"putAttachment\",function(t,n,r,o,i){var a=this;function s(e){var t=\"_rev\"in e?parseInt(e._rev,10):0;return e._attachments=e._attachments||{},e._attachments[n]={content_type:i,data:o,revpos:++t},a.put(e)}return\"function\"==typeof i&&(i=o,o=r,r=null),void 0===i&&(i=o,o=r,r=null),i||h.guardedConsole(\"warn\",\"Attachment\",n,\"on document\",t,\"is missing content_type\"),a.get(t).then(function(e){if(e._rev!==r)throw p.createError(p.REV_CONFLICT);return s(e)},function(e){if(e.reason===p.MISSING_DOC.message)return s({_id:t});throw e})}),y.prototype.removeAttachment=h.adapterFun(\"removeAttachment\",function(e,n,r,o){var i=this;i.get(e,function(e,t){if(e)o(e);else if(t._rev!==r)o(p.createError(p.REV_CONFLICT));else{if(!t._attachments)return o();delete t._attachments[n],0===Object.keys(t._attachments).length&&delete t._attachments,i.put(t,o)}})}),y.prototype.remove=h.adapterFun(\"remove\",function(e,t,n,r){\"string\"==typeof t?(o={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(o=e,n=\"function\"==typeof t?(r=t,{}):(r=n,t)),(n=n||{}).was_delete=!0;var o,e={_id:o._id,_rev:o._rev||n.rev};if(e._deleted=!0,b.isLocalId(e._id)&&\"function\"==typeof this._removeLocal)return this._removeLocal(o,r);this.bulkDocs({docs:[e]},n,d(r,e._id))}),y.prototype.revsDiff=h.adapterFun(\"revsDiff\",function(o,e,s){\"function\"==typeof e&&(s=e,e={});var u=Object.keys(o);if(!u.length)return s(null,{});var c=0,f=new i.Map;function l(e,t){f.has(e)||f.set(e,{missing:[]}),f.get(e).missing.push(t)}u.map(function(r){this._getRevisionTree(r,function(e,t){if(e&&404===e.status&&\"missing\"===e.message)f.set(r,{missing:o[r]});else{if(e)return s(e);e=t,a=o[i=r].slice(0),b.traverseRevTree(e,function(e,t,n,r,o){t=t+\"-\"+n,n=a.indexOf(t);-1!==n&&(a.splice(n,1),\"available\"!==o.status&&l(i,t))}),a.forEach(function(e){l(i,e)})}var i,a,n;if(++c===u.length)return n={},f.forEach(function(e,t){n[t]=e}),s(null,n)})},this)}),y.prototype.bulkGet=h.adapterFun(\"bulkGet\",function(e,t){h.bulkGetShim(this,e,t)}),y.prototype.compactDocument=h.adapterFun(\"compactDocument\",function(r,u,c){var f=this;this._getRevisionTree(r,function(e,t){if(e)return c(e);o={},i=[],b.traverseRevTree(t,function(e,t,n,r){t=t+\"-\"+n;return e&&(o[t]=0),void 0!==r&&i.push({from:r,to:t}),t}),i.reverse(),i.forEach(function(e){void 0===o[e.from]?o[e.from]=1+o[e.to]:o[e.from]=Math.min(o[e.from],1+o[e.to])});var o,i,n=o,a=[],s=[];Object.keys(n).forEach(function(e){n[e]>u&&a.push(e)}),b.traverseRevTree(t,function(e,t,n,r,o){t=t+\"-\"+n;\"available\"===o.status&&-1!==a.indexOf(t)&&s.push(t)}),f._doCompaction(r,s,c)})}),y.prototype.compact=h.adapterFun(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={});var n=this;e=e||{},n._compactionQueue=n._compactionQueue||[],n._compactionQueue.push({opts:e,callback:t}),1===n._compactionQueue.length&&function n(r){var e=r._compactionQueue[0],t=e.opts,o=e.callback;r.get(\"_local/compaction\").catch(function(){return!1}).then(function(e){e&&e.last_seq&&(t.last_seq=e.last_seq),r._compact(t,function(e,t){e?o(e):o(null,t),h.nextTick(function(){r._compactionQueue.shift(),r._compactionQueue.length&&n(r)})})})}(n)}),y.prototype._compact=function(e,n){var r=this,e={return_docs:!1,last_seq:e.last_seq||0},o=[];r.changes(e).on(\"change\",function(e){o.push(r.compactDocument(e.id,0))}).on(\"complete\",function(e){var t=e.last_seq;Promise.all(o).then(function(){return h.upsert(r,\"_local/compaction\",function(e){return(!e.last_seq||e.last_seq<t)&&(e.last_seq=t,e)})}).then(function(){n(null,{ok:!0})}).catch(n)}).on(\"error\",n)},y.prototype.get=h.adapterFun(\"get\",function(y,_,g){if(\"function\"==typeof _&&(g=_,_={}),\"string\"!=typeof y)return g(p.createError(p.INVALID_ID));if(b.isLocalId(y)&&\"function\"==typeof this._getLocal)return this._getLocal(y,g);var n=[],m=this;function r(){var a=[],s=n.length;if(!s)return g(null,a);n.forEach(function(i){m.get(y,{rev:i,revs:_.revs,latest:_.latest,attachments:_.attachments,binary:_.binary},function(e,t){if(e)a.push({missing:i});else{for(var n,r=0,o=a.length;r<o;r++)if(a[r].ok&&a[r].ok._rev===t._rev){n=!0;break}n||a.push({ok:t})}--s||g(null,a)})})}if(!_.open_revs)return this._get(y,_,function(e,t){if(e)return e.docId=y,g(e);var o=t.doc,n=t.metadata,i=t.ctx;if(!_.conflicts||(t=b.collectConflicts(n)).length&&(o._conflicts=t),b.isDeleted(n,o._rev)&&(o._deleted=!0),_.revs||_.revs_info){for(var t=o._rev.split(\"-\"),r=parseInt(t[0],10),a=t[1],s=b.rootToLeaf(n.rev_tree),u=null,c=0;c<s.length;c++){var f=s[c],l=f.ids.map(function(e){return e.id}).indexOf(a);(l===r-1||!u&&-1!==l)&&(u=f)}if(!u)return(e=new Error(\"invalid rev tree\")).docId=y,g(e);var d,t=u.ids.map(function(e){return e.id}).indexOf(o._rev.split(\"-\")[1])+1,n=u.ids.length-t;u.ids.splice(t,n),u.ids.reverse(),_.revs&&(o._revisions={start:u.pos+u.ids.length-1,ids:u.ids.map(function(e){return e.id})}),_.revs_info&&(d=u.pos+u.ids.length,o._revs_info=u.ids.map(function(e){return{rev:--d+\"-\"+e.id,status:e.opts.status}}))}if(_.attachments&&o._attachments){var p=o._attachments,h=Object.keys(p).length;if(0===h)return g(null,o);Object.keys(p).forEach(function(r){this._getAttachment(o._id,r,p[r],{rev:o._rev,binary:_.binary,ctx:i},function(e,t){var n=o._attachments[r];n.data=t,delete n.stub,delete n.length,--h||g(null,o)})},m)}else{if(o._attachments)for(var v in o._attachments)o._attachments.hasOwnProperty(v)&&(o._attachments[v].stub=!0);g(null,o)}});if(\"all\"===_.open_revs)this._getRevisionTree(y,function(e,t){if(e)return g(e);n=b.collectLeaves(t).map(function(e){return e.rev}),r()});else{if(!Array.isArray(_.open_revs))return g(p.createError(p.UNKNOWN_ERROR,\"function_clause\"));for(var n=_.open_revs,e=0;e<n.length;e++){var t=n[e];if(\"string\"!=typeof t||!/^\\d+-/.test(t))return g(p.createError(p.INVALID_REV))}r()}}),y.prototype.getAttachment=h.adapterFun(\"getAttachment\",function(n,r,o,i){var a=this;o instanceof Function&&(i=o,o={}),this._get(n,o,function(e,t){return e?i(e):t.doc._attachments&&t.doc._attachments[r]?(o.ctx=t.ctx,o.binary=!0,void a._getAttachment(n,r,t.doc._attachments[r],o,i)):i(p.createError(p.MISSING_DOC))})}),y.prototype.allDocs=h.adapterFun(\"allDocs\",function(t,e){if(\"function\"==typeof t&&(e=t,t={}),t.skip=void 0!==t.skip?t.skip:0,t.start_key&&(t.startkey=t.start_key),t.end_key&&(t.endkey=t.end_key),\"keys\"in t){if(!Array.isArray(t.keys))return e(new TypeError(\"options.keys must be an array\"));var n=[\"startkey\",\"endkey\",\"key\"].filter(function(e){return e in t})[0];if(n)return void e(p.createError(p.QUERY_PARSE_ERROR,\"Query parameter `\"+n+\"` is not compatible with multi-get\"));if(!h.isRemote(this)&&(r=\"limit\"in(n=t)?n.keys.slice(n.skip,n.limit+n.skip):0<n.skip?n.keys.slice(n.skip):n.keys,n.keys=r,n.skip=0,delete n.limit,n.descending&&(r.reverse(),n.descending=!1),0===t.keys.length))return this._allDocs({limit:0},e)}var r;return this._allDocs(t,e)}),y.prototype.changes=function(e,t){return\"function\"==typeof e&&(t=e,e={}),(e=e||{}).return_docs=\"return_docs\"in e?e.return_docs:!e.live,new c(this,e,t)},y.prototype.close=h.adapterFun(\"close\",function(e){return this._closed=!0,this.emit(\"closed\"),this._close(e)}),y.prototype.info=h.adapterFun(\"info\",function(n){var r=this;this._info(function(e,t){if(e)return n(e);t.db_name=t.db_name||r.name,t.auto_compaction=!(!r.auto_compaction||h.isRemote(r)),t.adapter=r.adapter,n(null,t)})}),y.prototype.id=h.adapterFun(\"id\",function(e){return this._id(e)}),y.prototype.type=function(){return\"function\"==typeof this._type?this._type():this.adapter},y.prototype.bulkDocs=h.adapterFun(\"bulkDocs\",function(e,o,i){if(\"function\"==typeof o&&(i=o,o={}),o=o||{},!(e=Array.isArray(e)?{docs:e}:e)||!e.docs||!Array.isArray(e.docs))return i(p.createError(p.MISSING_BULK_DOCS));for(var r,t=0;t<e.docs.length;++t)if(\"object\"!=typeof e.docs[t]||Array.isArray(e.docs[t]))return i(p.createError(p.NOT_AN_OBJECT));if(e.docs.forEach(function(n){n._attachments&&Object.keys(n._attachments).forEach(function(e){var t;r=r||\"_\"===(t=e).charAt(0)&&t+\" is not a valid attachment name, attachment names cannot start with '_'\",n._attachments[e].content_type||h.guardedConsole(\"warn\",\"Attachment\",e,\"on document\",n._id,\"is missing content_type\")})}),r)return i(p.createError(p.BAD_REQUEST,r));\"new_edits\"in o||(\"new_edits\"in e?o.new_edits=e.new_edits:o.new_edits=!0);for(var a=this,n=(o.new_edits||h.isRemote(a)||e.docs.sort(v),e.docs),s=0;s<n.length;s++){var u=n[s];if(u._deleted)delete u._attachments;else if(u._attachments)for(var c=Object.keys(u._attachments),f=0;f<c.length;f++){var l=c[f];u._attachments[l]=h.pick(u._attachments[l],[\"data\",\"digest\",\"content_type\",\"length\",\"revpos\",\"stub\"])}}var d=e.docs.map(function(e){return e._id});return this._bulkDocs(e,o,function(e,t){if(e)return i(e);if(o.new_edits||(t=t.filter(function(e){return e.error})),!h.isRemote(a))for(var n=0,r=t.length;n<r;n++)t[n].id=t[n].id||d[n];i(null,t)})}),y.prototype.registerDependentDatabase=h.adapterFun(\"registerDependentDatabase\",function(t,e){var n=new this.constructor(t,this.__opts);h.upsert(this,\"_local/_pouch_dependentDbs\",function(e){return e.dependentDbs=e.dependentDbs||{},!e.dependentDbs[t]&&(e.dependentDbs[t]=!0,e)}).then(function(){e(null,{db:n})}).catch(e)}),y.prototype.destroy=h.adapterFun(\"destroy\",function(e,r){\"function\"==typeof e&&(r=e,e={});var o=this,i=!(\"use_prefix\"in o)||o.use_prefix;function a(){o._destroy(e,function(e,t){if(e)return r(e);o._destroyed=!0,o.emit(\"destroyed\"),r(null,t||{ok:!0})})}if(h.isRemote(o))return a();o.get(\"_local/_pouch_dependentDbs\",function(e,t){if(e)return 404!==e.status?r(e):a();var e=t.dependentDbs,n=o.constructor,t=Object.keys(e).map(function(e){e=i?e.replace(new RegExp(\"^\"+n.prefix),\"\"):e;return new n(e,o.__opts).destroy()});Promise.all(t).then(a,r)})}),_.prototype.execute=function(){var e;if(this.failed)for(;e=this.queue.shift();)e(this.failed);else for(;e=this.queue.shift();)e()},_.prototype.fail=function(e){this.failed=e,this.execute()},_.prototype.ready=function(e){this.isReady=!0,this.db=e,this.execute()},_.prototype.addTask=function(e){this.queue.push(e),this.failed&&this.execute()},o(g,y),g.adapters={},g.preferredAdapters=[],g.prefix=\"_pouch_\";var m,w,k=new s;m=g,Object.keys(s.prototype).forEach(function(e){\"function\"==typeof s.prototype[e]&&(m[e]=k[e].bind(k))}),w=m._destructionListeners=new i.Map,m.on(\"ref\",function(e){w.has(e.name)||w.set(e.name,[]),w.get(e.name).push(e)}),m.on(\"unref\",function(e){var t,n;!w.has(e.name)||(n=(t=w.get(e.name)).indexOf(e))<0||(t.splice(n,1),1<t.length?w.set(e.name,t):w.delete(e.name))}),m.on(\"destroyed\",function(e){var t;w.has(e)&&(t=w.get(e),w.delete(e),t.forEach(function(e){e.emit(\"destroyed\",!0)}))}),g.adapter=function(e,t,n){t.valid()&&(g.adapters[e]=t,n&&g.preferredAdapters.push(e))},g.plugin=function(t){if(\"function\"==typeof t)t(g);else{if(\"object\"!=typeof t||0===Object.keys(t).length)throw new Error('Invalid plugin: got \"'+t+'\", expected an object or a function');Object.keys(t).forEach(function(e){g.prototype[e]=t[e]})}return this.__defaults&&(g.__defaults=h.assign({},this.__defaults)),g},g.defaults=function(e){function n(e,t){if(!(this instanceof n))return new n(e,t);t=t||{},e&&\"object\"==typeof e&&(e=(t=e).name,delete t.name),t=h.assign({},n.__defaults,t),g.call(this,e,t)}return o(n,g),n.preferredAdapters=g.preferredAdapters.slice(),Object.keys(g).forEach(function(e){e in n||(n[e]=g[e])}),n.__defaults=h.assign({},this.__defaults,e),n},g.fetch=function(e,t){return u.fetch(e,t)};g.plugin(e),g.version=\"7.2.2\",t.exports=g},{10:10,38:38,6:6,71:71,72:72,73:73,75:75,76:76,8:8}],65:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14,66:66,67:67,68:68,69:69,7:7,70:70}],66:[function(e,t,n){arguments[4][15][0].apply(n,arguments)},{15:15}],67:[function(e,t,n){arguments[4][16][0].apply(n,arguments)},{16:16}],68:[function(e,t,n){arguments[4][17][0].apply(n,arguments)},{17:17}],69:[function(e,t,n){arguments[4][18][0].apply(n,arguments)},{18:18}],70:[function(e,t,n){arguments[4][19][0].apply(n,arguments)},{19:19}],71:[function(e,t,n){arguments[4][21][0].apply(n,arguments)},{21:21}],72:[function(e,t,n){arguments[4][22][0].apply(n,arguments)},{10:10,22:22}],73:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var r=\"undefined\"!=typeof AbortController?AbortController:function(){return{abort:function(){}}},o=fetch,i=Headers;n.fetch=o,n.Headers=i,n.AbortController=r},{}],74:[function(e,t,n){arguments[4][23][0].apply(n,arguments)},{23:23,37:37,77:77}],75:[function(e,t,n){arguments[4][24][0].apply(n,arguments)},{24:24}],76:[function(e,t,n){arguments[4][25][0].apply(n,arguments)},{10:10,25:25,6:6,65:65,71:71,72:72,74:74,79:79,8:8}],77:[function(e,t,n){arguments[4][26][0].apply(n,arguments)},{26:26}],78:[function(e,t,n){arguments[4][27][0].apply(n,arguments)},{27:27}],79:[function(e,t,n){arguments[4][28][0].apply(n,arguments)},{28:28,83:83,84:84,86:86,87:87}],80:[function(e,t,n){arguments[4][29][0].apply(n,arguments)},{29:29}],81:[function(e,t,n){arguments[4][30][0].apply(n,arguments)},{30:30}],82:[function(e,t,n){arguments[4][31][0].apply(n,arguments)},{31:31}],83:[function(e,t,n){arguments[4][32][0].apply(n,arguments)},{32:32,78:78,81:81}],84:[function(e,t,n){arguments[4][33][0].apply(n,arguments)},{33:33,80:80,85:85}],85:[function(e,t,n){arguments[4][34][0].apply(n,arguments)},{34:34,78:78}],86:[function(e,t,n){arguments[4][35][0].apply(n,arguments)},{35:35,78:78,81:81}],87:[function(e,t,n){arguments[4][36][0].apply(n,arguments)},{36:36,82:82,85:85}],88:[function(e,t,n){\"use strict\";function r(e,t,n){Error.call(this,n),this.status=e,this.name=t,this.message=n,this.error=!0}Object.defineProperty(n,\"__esModule\",{value:!0}),((e=e(89))&&\"object\"==typeof e&&\"default\"in e?e.default:e)(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var e=new r(401,\"unauthorized\",\"Name or password is incorrect.\"),o=new r(400,\"bad_request\",\"Missing JSON list of 'docs'\"),i=new r(404,\"not_found\",\"missing\"),a=new r(409,\"conflict\",\"Document update conflict\"),s=new r(400,\"bad_request\",\"_id field must contain a string\"),u=new r(412,\"missing_id\",\"_id is required for puts\"),c=new r(400,\"bad_request\",\"Only reserved document ids may start with underscore.\"),f=new r(412,\"precondition_failed\",\"Database not open\"),l=new r(500,\"unknown_error\",\"Database encountered an unknown error\"),d=new r(500,\"badarg\",\"Some query argument is invalid\"),p=new r(400,\"invalid_request\",\"Request was invalid\"),h=new r(400,\"query_parse_error\",\"Some query parameter is invalid\"),v=new r(500,\"doc_validation\",\"Bad special document member\"),y=new r(400,\"bad_request\",\"Something wrong with the request\"),_=new r(400,\"bad_request\",\"Document must be a JSON object\"),g=new r(404,\"not_found\",\"Database not found\"),m=new r(500,\"indexed_db_went_bad\",\"unknown\"),b=new r(500,\"web_sql_went_bad\",\"unknown\"),w=new r(500,\"levelDB_went_went_bad\",\"unknown\"),k=new r(403,\"forbidden\",\"Forbidden by design doc validate_doc_update function\"),E=new r(400,\"bad_request\",\"Invalid rev format\"),O=new r(412,\"file_exists\",\"The database could not be created, the file already exists.\"),A=new r(412,\"missing_stub\",\"A pre-existing attachment stub wasn't found\"),I=new r(413,\"invalid_url\",\"Provided URL is invalid\");n.UNAUTHORIZED=e,n.MISSING_BULK_DOCS=o,n.MISSING_DOC=i,n.REV_CONFLICT=a,n.INVALID_ID=s,n.MISSING_ID=u,n.RESERVED_ID=c,n.NOT_OPEN=f,n.UNKNOWN_ERROR=l,n.BAD_ARG=d,n.INVALID_REQUEST=p,n.QUERY_PARSE_ERROR=h,n.DOC_VALIDATION=v,n.BAD_REQUEST=y,n.NOT_AN_OBJECT=_,n.DB_MISSING=g,n.WSQ_ERROR=b,n.LDB_ERROR=w,n.FORBIDDEN=k,n.INVALID_REV=E,n.FILE_EXISTS=O,n.MISSING_STUB=A,n.IDB_ERROR=m,n.INVALID_URL=I,n.createError=function(n,e){function t(e){for(var t in n)\"function\"!=typeof n[t]&&(this[t]=n[t]);void 0!==e&&(this.reason=e)}return t.prototype=r.prototype,new t(e)},n.generateErrorFromResponse=function(e){var t;return\"object\"!=typeof e&&(t=e,(e=l).data=t),\"error\"in e&&\"conflict\"===e.error&&(e.name=\"conflict\",e.status=409),\"name\"in e||(e.name=e.error||\"unknown\"),\"status\"in e||(e.status=500),\"message\"in e||(e.message=e.message||e.reason),e}},{89:89}],89:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}})}:t.exports=function(e,t){e.super_=t;function n(){}n.prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e}},{}],90:[function(e,t,n){arguments[4][73][0].apply(n,arguments)},{73:73}],91:[function(e,t,N){\"use strict\";var d=e(97),a=e(88),s=e(90),m=e(96),n=(n=e(11))&&\"object\"==typeof n&&\"default\"in n?n.default:n,c=e(62),p=e(94);function h(t){return(t=d.clone(t)).index||(t.index={}),[\"type\",\"name\",\"ddoc\"].forEach(function(e){t.index[e]&&(t[e]=t.index[e],delete t.index[e])}),t.fields&&(t.index.fields=t.fields,delete t.fields),t.type||(t.type=\"json\"),t}function i(e,t,n,r){var o,i;n.headers=new s.Headers({\"Content-type\":\"application/json\"}),e.fetch(t,n).then(function(e){return o=e.status,i=e.ok,e.json()}).then(function(e){i?r(null,e):(e.status=o,e=a.generateErrorFromResponse(e),r(e))}).catch(r)}function r(e,t,n){t=h(t),i(e,\"_index\",{method:\"POST\",body:JSON.stringify(t)},n)}function o(e,t,n){i(e,\"_find\",{method:\"POST\",body:JSON.stringify(t)},n)}function u(e,t,n){i(e,\"_explain\",{method:\"POST\",body:JSON.stringify(t)},n)}function f(e,t){i(e,\"_index\",{method:\"GET\"},t)}function l(e,t,n){var r=t.ddoc,o=t.type||\"json\",t=t.name;return r?t?void i(e,\"_index/\"+[r,o,t].map(encodeURIComponent).join(\"/\"),{method:\"DELETE\"},n):n(new Error(\"you must provide an index's name\")):n(new Error(\"you must provide an index's ddoc\"))}function v(r){return function(){for(var e=arguments.length,t=new Array(e),n=-1;++n<e;)t[n]=arguments[n];return r.call(this,t)}}function y(r){return v(function(e){var t,n=e.pop(),e=r.apply(this,e);return t=n,e.then(function(e){d.nextTick(function(){t(null,e)})},function(e){d.nextTick(function(){t(e)})}),e})}var _=v(function(e){for(var t=[],n=0,r=e.length;n<r;n++){var o=e[n];Array.isArray(o)?t=t.concat(_.apply(null,o)):t.push(o)}return t});function b(e){for(var t={},n=0,r=e.length;n<r;n++)t=d.assign(t,e[n]);return t}function g(e,t){for(var n=0,r=Math.min(e.length,t.length);n<r;n++)if(e[n]!==t[n])return!1;return!0}function w(e,t){if(e.length!==t.length)return!1;for(var n=0,r=e.length;n<r;n++)if(e[n]!==t[n])return!1;return!0}function k(e,t){var u,c,o,i,a,s,n,r,f=function(e){for(var t=0,n=e.length;t<n;t++)if(-1!==e[t].indexOf(\".\"))return!1;return!0}(e),l=1===e.length;return f?l?(n=e[0],r=t,function(e){r(e[n])}):(a=e,s=t,function(e){for(var t=[],n=0,r=a.length;n<r;n++)t.push(e[a[n]]);s(t)}):l?(f=e[0],o=t,i=m.parseField(f),function(e){for(var t=e,n=0,r=i.length;n<r;n++)if(void 0===(t=t[i[n]]))return;o(t)}):(u=e,c=t,function(e){for(var t=[],n=0,r=u.length;n<r;n++){for(var o=m.parseField(u[n]),i=e,a=0,s=o.length;a<s;a++)if(void 0===(i=i[o[a]]))return;t.push(i)}c(t)})}var E=n(\"indexes\",function(e,t){return k(Object.keys(e.fields),t)},function(){throw new Error(\"reduce not supported\")},function(e,t){var n=e.views[t];if(!n.map||!n.map.fields)throw new Error(\"ddoc \"+e._id+\" with view \"+t+\" doesn't have map.fields defined. maybe it wasn't created by this plugin?\")});function O(e){return e.fields=e.fields.map(function(e){var t;return\"string\"==typeof e?((t={})[e]=\"asc\",t):e}),e}function A(e,t,n){for(var r=n.def.fields,o=0,i=e.length;o<i;o++){var a=function(e,t){for(var n=[],r=0;r<t.def.fields.length;r++){var o=m.getKey(t.def.fields[r]);n.push(e[o])}return n}(e[o].doc,n);if(1===r.length)a=a[0];else for(;a.length>t.length;)a.pop();if(0<Math.abs(c.collate(a,t)))break}return 0<o?e.slice(o):e}function I(e){return e.allDocs({startkey:\"_design/\",endkey:\"_design/￿\",include_docs:!0}).then(function(e){var t={indexes:[{ddoc:null,name:\"_all_docs\",type:\"special\",def:{fields:[{_id:\"asc\"}]}}]};return t.indexes=_(t.indexes,e.rows.filter(function(e){return\"query\"===e.doc.language}).map(function(n){return(void 0!==n.doc.views?Object.keys(n.doc.views):[]).map(function(e){var t=n.doc.views[e];return{ddoc:n.id,name:e,type:\"json\",def:O(t.options.def)}})})),t.indexes.sort(function(e,t){return m.compare(e.name,t.name)}),t.total_rows=t.indexes.length,t})}var S={\"￿\":{}};function x(e,t){var n=t.def.fields.map(m.getKey);return e.slice().sort(function(e,t){e=n.indexOf(e),t=n.indexOf(t);return-1===e&&(e=Number.MAX_VALUE),-1===t&&(t=Number.MAX_VALUE),m.compare(e,t)})}function j(e,t,n){for(var r,o=!1,i=0,a=(n=x(n,e)).length;i<a;i++){var s=n[i];if(o||!function(e,t){for(var n=e.def.fields.map(m.getKey),r=0,o=n.length;r<o;r++)if(t===n[r])return 1}(e,s))return n.slice(i);i<a-1&&(r=(r=t)[s],\"$eq\"!==m.getKey(r))&&(o=!0)}return[]}function D(e,t,n,r){var o,i;return x(function(e){for(var t={},n=0;n<e.length;n++)t[\"$\"+e[n]]=!0;return Object.keys(t).map(function(e){return e.substring(1)})}(_(e,j(t,n,r),(o=n,i=[],Object.keys(o).forEach(function(t){var e=o[t];Object.keys(e).forEach(function(e){\"$ne\"===e&&i.push(t)})}),i))),t)}function $(e,t,n){var r;if(t)return r=e,t=!((t=t).length>r.length)&&g(t,r),r=g(n,e),t&&r;var o=n,i=e;o=o.slice();for(var a=0,s=i.length;a<s;a++){var u=i[a];if(!o.length)break;u=o.indexOf(u);if(-1===u)return!1;o.splice(u,1)}return!0}var R=[\"$eq\",\"$gt\",\"$gte\",\"$lt\",\"$lte\"];function C(e){return-1===R.indexOf(e)}function q(e,t,n,r){e=e.def.fields.map(m.getKey);return!!$(e,t,n)&&(void 0===(t=(t=r)[e[0]])||!!Object.keys(t).some(function(e){return!C(e)})&&!(1===Object.keys(t).length&&\"$ne\"===m.getKey(t)))}function M(e,t,n,r,o){i=e,a=t,s=n;var i,a,s,e=r.reduce(function(e,t){return q(t,s,a,i)&&e.push(t),e},[]);if(0===e.length){if(o)throw{error:\"no_usable_index\",message:\"There is no index available for this selector.\"};n=r[0];return n.defaultUsed=!0,n}if(1===e.length&&!o)return e[0];var u=function(e){for(var t={},n=0,r=e.length;n<r;n++)t[e[n]]=!0;return t}(t);if(o){var c=\"_design/\"+o[0],f=2===o.length&&o[1],r=e.find(function(e){return!(!f||e.ddoc!==c||f!==e.name)||e.ddoc===c});if(r)return r;throw{error:\"unknown_error\",message:\"Could not find that index or could not use that index for the query\"}}for(var l=e,d=function(e){for(var t=e.def.fields.map(m.getKey),n=0,r=0,o=t.length;r<o;r++){var i=t[r];u[i]&&n++}return n},p=null,h=-1,v=0,y=l.length;v<y;v++){var _=l[v],g=d(_);h<g&&(h=g,p=_)}return p}function P(e,t){var n,r=m.getKey(t.def.fields[0]),o=e[r]||{},i=[];return Object.keys(o).forEach(function(e){C(e)?i.push(r):(e=function(e,t){switch(e){case\"$eq\":return{key:t};case\"$lte\":return{endkey:t};case\"$gte\":return{startkey:t};case\"$lt\":return{endkey:t,inclusive_end:!1};case\"$gt\":return{startkey:t,inclusive_start:!1}}}(e,o[e]),n=n?b([n,e]):e)}),{queryOpts:n,inMemoryFields:i}}function L(e,t){var n,r,o=t.def.fields.map(m.getKey),i=[],a=[],s=[];function u(e){!1!==n&&a.push(null),!1!==r&&s.push(S),i=o.slice(e)}for(var c=0,f=o.length;c<f;c++){var l=e[o[c]];if(!l||!Object.keys(l).length){u(c);break}if(0<c){if(Object.keys(l).some(C)){u(c);break}var d=\"$gt\"in l||\"$gte\"in l||\"$lt\"in l||\"$lte\"in l,p=Object.keys(e[o[c-1]]),h=w(p,[\"$eq\"]),p=w(p,Object.keys(l));if(d&&!h&&!p){u(c);break}}for(var v=Object.keys(l),y=null,_=0;_<v.length;_++)var g=v[_],g=function(e,t){switch(e){case\"$eq\":return{startkey:t,endkey:t};case\"$lte\":return{endkey:t};case\"$gte\":return{startkey:t};case\"$lt\":return{endkey:t,inclusive_end:!1};case\"$gt\":return{startkey:t,inclusive_start:!1}}}(g,l[g]),y=y?b([y,g]):g;a.push(\"startkey\"in y?y.startkey:null),s.push(\"endkey\"in y?y.endkey:S),\"inclusive_start\"in y&&(n=y.inclusive_start),\"inclusive_end\"in y&&(r=y.inclusive_end)}t={startkey:a,endkey:s};return void 0!==n&&(t.inclusive_start=n),void 0!==r&&(t.inclusive_end=r),{queryOpts:t,inMemoryFields:i}}function T(e,t){return t.defaultUsed?{queryOpts:{startkey:null},inMemoryFields:[Object.keys(e)]}:(1===t.def.fields.length?P:L)(e,t)}function F(e,t){var n,r=e.selector,o=e.sort,i=(i=r,o=o,i=Object.keys(i),n=o?o.map(m.getKey):[],i=i.length>=n.length?i:n,0===n.length?{fields:i}:{fields:i=i.sort(function(e,t){e=n.indexOf(e),-1===e&&(e=Number.MAX_VALUE),t=n.indexOf(t);return e<(t=-1===t?Number.MAX_VALUE:t)?-1:t<e?1:0}),sortOrder:o.map(m.getKey)}),o=i.fields,i=M(r,o,i.sortOrder,t,e.use_index),t=T(r,i);return{queryOpts:t.queryOpts,index:i,inMemoryFields:D(t.inMemoryFields,i,r,o)}}function B(i,u,a){var e,t;if(u.selector&&(u.selector=m.massageSelector(u.selector)),u.sort&&(u.sort=function(e){if(Array.isArray(e))return e.map(function(e){var t;return\"string\"==typeof e?((t={})[e]=\"asc\",t):e});throw new Error(\"invalid sort json - should be an array\")}(u.sort)),u.use_index&&(u.use_index=(e=u.use_index,t=[],\"string\"==typeof e?t.push(e):t=e,t.map(function(e){return e.replace(\"_design/\",\"\")}))),\"object\"!=typeof u.selector)throw new Error(\"you must provide a selector when you find()\");return I(i).then(function(e){i.constructor.emit(\"debug\",[\"find\",\"planning query\",u]);var t=F(u,e.indexes),n=(i.constructor.emit(\"debug\",[\"find\",\"query plan\",t]),t.index),e=u,r=n;if(r.defaultUsed&&e.sort){e=e.sort.filter(function(e){return\"_id\"!==Object.keys(e)[0]}).map(function(e){return Object.keys(e)[0]});if(0<e.length)throw new Error('Cannot sort on field(s) \"'+e.join(\",\")+'\" when using the default index')}r.defaultUsed;var o=d.assign({include_docs:!0,reduce:!1},t.queryOpts);return\"startkey\"in o&&\"endkey\"in o&&0<c.collate(o.startkey,o.endkey)?{docs:[]}:(u.sort&&\"string\"!=typeof u.sort[0]&&\"desc\"===m.getValue(u.sort[0])&&(o.descending=!0,e=o,delete(r=d.clone(e)).startkey,delete r.endkey,delete r.inclusive_start,delete r.inclusive_end,\"endkey\"in e&&(r.startkey=e.endkey),\"startkey\"in e&&(r.endkey=e.startkey),\"inclusive_start\"in e&&(r.inclusive_end=e.inclusive_start),\"inclusive_end\"in e&&(r.inclusive_start=e.inclusive_end),o=r),t.inMemoryFields.length||(\"limit\"in u&&(o.limit=u.limit),\"skip\"in u&&(o.skip=u.skip)),a?Promise.resolve(t,o):Promise.resolve().then(function(){var e,t;return\"_all_docs\"===n.name?(e=i,t=o,(t=d.clone(t)).descending?(\"endkey\"in t&&\"string\"!=typeof t.endkey&&(t.endkey=\"\"),\"startkey\"in t&&\"string\"!=typeof t.startkey&&(t.limit=0)):(\"startkey\"in t&&\"string\"!=typeof t.startkey&&(t.startkey=\"\"),\"endkey\"in t&&\"string\"!=typeof t.endkey&&(t.limit=0)),\"key\"in t&&\"string\"!=typeof t.key&&(t.limit=0),e.allDocs(t).then(function(e){return e.rows=e.rows.filter(function(e){return!/^_design\\//.test(e.id)}),e})):(t=(e=n).ddoc.substring(8)+\"/\"+e.name,E.query.call(i,t,o))}).then(function(e){!1===o.inclusive_start&&(e.rows=A(e.rows,o.startkey,n)),t.inMemoryFields.length&&(e.rows=m.filterInMemoryFields(e.rows,u,t.inMemoryFields));e={docs:e.rows.map(function(e){e=e.doc;if(u.fields){for(var t=e,n=u.fields,r={},o=0,i=n.length;o<i;o++){var a=m.parseField(n[o]),s=m.getFieldFromDoc(t,a);void 0!==s&&m.setFieldInDoc(r,a,s)}return r}return e})};return n.defaultUsed&&(e.warning=\"no matching index found, create an index to optimize query time\"),e}))})}var U=y(function(e,t){t=h(t);var n,r=d.clone(t.index),o=(t.index=O(t.index),t.index),i=o.fields.filter(function(e){return\"asc\"===m.getValue(e)});if(0!==i.length&&i.length!==o.fields.length)throw new Error(\"unsupported mixed sorting\");function a(){return n=n||p.stringMd5(JSON.stringify(t))}var s=t.name||\"idx-\"+a(),u=t.ddoc||\"idx-\"+a(),c=\"_design/\"+u,f=!1,l=!1;return e.constructor.emit(\"debug\",[\"find\",\"creating index\",c]),d.upsert(e,c,function(e){return e._rev&&\"query\"!==e.language&&(f=!0),e.language=\"query\",e.views=e.views||{},!(l=!!e.views[s])&&(e.views[s]={map:{fields:b(t.index.fields)},reduce:\"_count\",options:{def:r}},e)}).then(function(){if(f)throw new Error('invalid language for ddoc with id \"'+c+'\" (should be \"query\")')}).then(function(){return E.query.call(e,u+\"/\"+s,{limit:0,reduce:!1}).then(function(){return{id:c,name:s,result:l?\"exists\":\"created\"}})})}),V=y(B),K=y(function(t,n){return B(t,n,!0).then(function(e){return{dbname:t.name,index:e.index,selector:n.selector,range:{start_key:e.queryOpts.startkey,end_key:e.queryOpts.endkey},opts:{use_index:n.use_index||[],bookmark:\"nil\",limit:n.limit,skip:n.skip,sort:n.sort||{},fields:n.fields,conflicts:!1,r:[49]},limit:n.limit,skip:n.skip||0,fields:n.fields}})}),z=y(I),G=y(function(e,t){if(!t.ddoc)throw new Error(\"you must supply an index.ddoc when deleting\");if(!t.name)throw new Error(\"you must supply an index.name when deleting\");var n=t.ddoc,r=t.name;return d.upsert(e,n,function(e){return 1===Object.keys(e.views).length&&e.views[r]?{_id:n,_deleted:!0}:(delete e.views[r],e)}).then(function(){return E.viewCleanup.apply(e)}).then(function(){return{ok:!0}})}),e={};e.createIndex=d.toPromise(function(e,t){if(\"object\"!=typeof e)return t(new Error(\"you must provide an index to create\"));(d.isRemote(this)?r:U)(this,e,t)}),e.find=d.toPromise(function(e,t){if(void 0===t&&(t=e,e=void 0),\"object\"!=typeof e)return t(new Error(\"you must provide search parameters to find()\"));(d.isRemote(this)?o:V)(this,e,t)}),e.explain=d.toPromise(function(e,t){if(void 0===t&&(t=e,e=void 0),\"object\"!=typeof e)return t(new Error(\"you must provide search parameters to explain()\"));(d.isRemote(this)?u:K)(this,e,t)}),e.getIndexes=d.toPromise(function(e){(d.isRemote(this)?f:z)(this,e)}),e.deleteIndex=d.toPromise(function(e,t){if(\"object\"!=typeof e)return t(new Error(\"you must provide an index to delete\"));(d.isRemote(this)?l:G)(this,e,t)}),t.exports=e},{11:11,62:62,88:88,90:90,94:94,96:96,97:97}],92:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}Object.defineProperty(n,\"__esModule\",{value:!0});var o=r(e(93)),i=e(63),a=r(e(6)),s=e(97);function u(e){this.status=400,this.name=\"query_parse_error\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,u)}catch(e){}}function c(e){this.status=404,this.name=\"not_found\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,c)}catch(e){}}function f(e){this.status=500,this.name=\"invalid_value\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,f)}catch(e){}}function l(e,t){return t&&e.then(function(e){s.nextTick(function(){t(null,e)})},function(e){s.nextTick(function(){t(e)})}),e}o(u,Error),o(c,Error),o(f,Error),n.uniq=function(e){var e=new i.Set(e),t=new Array(e.size),n=-1;return e.forEach(function(e){t[++n]=e}),t},n.sequentialize=function(n,r){return function(){var e=arguments,t=this;return n.add(function(){return r.apply(t,e)})}},n.fin=function(e,t){return e.then(function(e){return t().then(function(){return e})},function(e){return t().then(function(){throw e})})},n.callbackify=function(n){return a(function(e){var t=e.pop(),e=n.apply(this,e);return\"function\"==typeof t&&l(e,t),e})},n.promisedCallback=l,n.mapToKeysArray=function(e){var n=new Array(e.size),r=-1;return e.forEach(function(e,t){n[++r]=t}),n},n.QueryParseError=u,n.NotFoundError=c,n.BuiltInError=f},{6:6,63:63,93:93,97:97}],93:[function(e,t,n){arguments[4][89][0].apply(n,arguments)},{89:89}],94:[function(n,e,r){!function(e){\"use strict\";Object.defineProperty(r,\"__esModule\",{value:!0});var t,d=n(95),p=(t=n(99))&&\"object\"==typeof t&&\"default\"in t?t.default:t,h=e.setImmediate||e.setTimeout;function v(t,e,n,r,o){var i;(0<n||r<e.size)&&(n=n,r=r,e=(i=e).webkitSlice?i.webkitSlice(n,r):i.slice(n,r)),d.readAsArrayBuffer(e,function(e){t.append(e),o()})}function y(e,t,n,r,o){(0<n||r<t.length)&&(t=t.substring(n,r)),e.appendBinary(t),o()}r.binaryMd5=function(n,t){var e=\"string\"==typeof n,r=e?n.length:n.size,o=Math.min(32768,r),i=Math.ceil(r/o),a=0,s=new(e?p:p.ArrayBuffer),u=e?y:v;function c(){h(l)}function f(){var e=s.end(!0),e=d.btoa(e);t(e),s.destroy()}function l(){var e=a*o,t=e+o;u(s,n,e,t,++a<i?c:f)}l()},r.stringMd5=function(e){return p.hash(e)}}.call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{95:95,99:99}],95:[function(e,t,n){arguments[4][12][0].apply(n,arguments)},{12:12}],96:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var s=e(97),i=e(62);function u(e,t){for(var n=e,r=0,o=t.length;r<o&&(n=n[t[r]]);r++);return n}function a(e,t){return e<t?-1:t<e?1:0}function c(e){for(var t=[],n=\"\",r=0,o=e.length;r<o;r++){var i=e[r];\".\"===i?n=0<r&&\"\\\\\"===e[r-1]?n.substring(0,n.length-1)+\".\":(t.push(n),\"\"):n+=i}return t.push(n),t}var r=[\"$or\",\"$nor\",\"$not\"];function f(e){return-1<r.indexOf(e)}function l(e){return Object.keys(e)[0]}function d(e){return e[l(e)]}function p(e){var n={};return e.forEach(function(t){Object.keys(t).forEach(function(e){var s,u=t[e];\"object\"!=typeof u&&(u={$eq:u}),f(e)?u instanceof Array?n[e]=u.map(function(e){return p([e])}):n[e]=p([u]):(s=n[e]=n[e]||{},Object.keys(u).forEach(function(e){var t,n,r,o,i,a=u[e];return\"$gt\"===e||\"$gte\"===e?(r=e,o=a,void(void 0===(i=s).$eq&&(void 0!==i.$gte?\"$gte\"===r?o>i.$gte&&(i.$gte=o):o>=i.$gte&&(delete i.$gte,i.$gt=o):void 0!==i.$gt?\"$gte\"===r?o>i.$gt&&(delete i.$gt,i.$gte=o):o>i.$gt&&(i.$gt=o):i[r]=o))):\"$lt\"===e||\"$lte\"===e?(i=e,r=a,void(void 0===(o=s).$eq&&(void 0!==o.$lte?\"$lte\"===i?r<o.$lte&&(o.$lte=r):r<=o.$lte&&(delete o.$lte,o.$lt=r):void 0!==o.$lt?\"$lte\"===i?r<o.$lt&&(delete o.$lt,o.$lte=r):r<o.$lt&&(o.$lt=r):o[i]=r))):\"$ne\"===e?(t=a,void(\"$ne\"in(n=s)?n.$ne.push(t):n.$ne=[t])):\"$eq\"===e?(n=a,delete(t=s).$gt,delete t.$gte,delete t.$lt,delete t.$lte,delete t.$ne,void(t.$eq=n)):void(s[e]=a)}))})}),n}function o(e){for(var t=s.clone(e),n=!1,r=(\"$and\"in t&&(t=p(t.$and),n=!0),[\"$or\",\"$nor\"].forEach(function(e){e in t&&t[e].forEach(function(e){for(var t=Object.keys(e),n=0;n<t.length;n++){var r=t[n],o=e[r];\"object\"==typeof o&&null!==o||(e[r]={$eq:o})}})}),\"$not\"in t&&(t.$not=p([t.$not])),Object.keys(t)),o=0;o<r.length;o++){var i=r[o],a=t[i];\"object\"!=typeof a||null===a?a={$eq:a}:\"$ne\"in a&&!n&&(a.$ne=[a.$ne]),t[i]=a}return t}function h(e){function o(t){return e.map(function(e){e=c(l(e));return u(t,e)})}return function(e,t){var n=o(e.doc),r=o(t.doc),n=i.collate(n,r);return 0!==n?n:a(e.doc._id,t.doc._id)}}function v(e,t,n){var r,o;return e=e.filter(function(e){return y(e.doc,t.selector,n)}),t.sort&&(r=h(t.sort),e=e.sort(r),\"string\"!=typeof t.sort[0]&&\"desc\"===d(t.sort[0])&&(e=e.reverse())),(\"limit\"in t||\"skip\"in t)&&(r=t.skip||0,o=(\"limit\"in t?t.limit:e.length)+r,e=e.slice(r,o)),e}function y(a,s,e){return e.every(function(e){var t,n,r=s[e],o=c(e),i=u(a,o);return f(e)?(t=r,n=a,\"$or\"!==(e=e)?\"$not\"!==e?!t.find(function(e){return y(n,e,Object.keys(e))}):!y(n,t,Object.keys(t)):t.some(function(e){return y(n,e,Object.keys(e))})):_(r,a,o,i)})}function _(i,a,s,u){return!i||Object.keys(i).every(function(e){var t=i[e],n=a,r=s,o=u;if(w[e])return w[e](n,t,r,o);throw new Error('unknown operator \"'+e+'\" - should be one of $eq, $lte, $lt, $gt, $gte, $exists, $ne, $in, $nin, $size, $mod, $regex, $elemMatch, $type, $allMatch or $all')})}function g(e){return null!=e}function m(e){return void 0!==e}function b(t,e){return e.some(function(e){return t instanceof Array?-1<t.indexOf(e):t===e})}var w={$elemMatch:function(t,n,r,e){return!!Array.isArray(e)&&(0!==e.length&&(\"object\"==typeof e[0]?e.some(function(e){return y(e,n,Object.keys(n))}):e.some(function(e){return _(n,t,r,e)})))},$allMatch:function(t,n,r,e){return!!Array.isArray(e)&&(0!==e.length&&(\"object\"==typeof e[0]?e.every(function(e){return y(e,n,Object.keys(n))}):e.every(function(e){return _(n,t,r,e)})))},$eq:function(e,t,n,r){return m(r)&&0===i.collate(r,t)},$gte:function(e,t,n,r){return m(r)&&0<=i.collate(r,t)},$gt:function(e,t,n,r){return m(r)&&0<i.collate(r,t)},$lte:function(e,t,n,r){return m(r)&&i.collate(r,t)<=0},$lt:function(e,t,n,r){return m(r)&&i.collate(r,t)<0},$exists:function(e,t,n,r){return t?m(r):!m(r)},$mod:function(e,t,n,r){return g(r)&&function(e,t){var n=t[0],t=t[1];if(0===n)throw new Error(\"Bad divisor, cannot divide by zero\");if(parseInt(n,10)!==n)throw new Error(\"Divisor is not an integer\");if(parseInt(t,10)!==t)throw new Error(\"Modulus is not an integer\");return parseInt(e,10)===e&&e%n===t}(r,t)},$ne:function(e,t,n,r){return t.every(function(e){return 0!==i.collate(r,e)})},$in:function(e,t,n,r){return g(r)&&b(r,t)},$nin:function(e,t,n,r){return g(r)&&!b(r,t)},$size:function(e,t,n,r){return g(r)&&r.length===t},$all:function(e,t,n,r){return Array.isArray(r)&&(o=r,t.every(function(e){return-1<o.indexOf(e)}));var o},$regex:function(e,t,n,r){return g(r)&&(r=r,new RegExp(t).test(r))},$type:function(e,t,n,r){var o=r,r=t;switch(r){case\"null\":return null===o;case\"boolean\":return\"boolean\"==typeof o;case\"number\":return\"number\"==typeof o;case\"string\":return\"string\"==typeof o;case\"array\":return o instanceof Array;case\"object\":return\"[object Object]\"==={}.toString.call(o)}throw new Error(r+\" not supported as a type.Please use one of object, string, array, number, boolean or null.\")}};n.massageSelector=o,n.matchesSelector=function(e,t){if(\"object\"!=typeof t)throw new Error(\"Selector error: expected a JSON object\");return(e=v([{doc:e}],{selector:t=o(t)},Object.keys(t)))&&1===e.length},n.filterInMemoryFields=v,n.createFieldSorter=h,n.rowFilter=y,n.isCombinationalField=f,n.getKey=l,n.getValue=d,n.getFieldFromDoc=u,n.setFieldInDoc=function(e,t,n){for(var r=0,o=t.length;r<o-1;r++)e=e[t[r]]={};e[t[o-1]]=n},n.compare=a,n.parseField=c},{62:62,97:97}],97:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}Object.defineProperty(n,\"__esModule\",{value:!0});var o=r(e(6)),i=e(63),s=r(e(9)),a=e(8),u=r(e(98)),c=e(88),f=r(e(100)),l=e(94),d=e(97);function p(e){if(e instanceof ArrayBuffer){if(\"function\"==typeof(r=e).slice)return r.slice(0);var t=new ArrayBuffer(r.byteLength),n=new Uint8Array(t),r=new Uint8Array(r);return n.set(r),t}n=e.size,r=e.type;return\"function\"==typeof e.slice?e.slice(0,n,r):e.webkitSlice(0,n,r)}var h=Function.prototype.toString,v=h.call(Object);function y(e){var t,n,r,o,i;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;n<r;n++)t[n]=y(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o=e,\"undefined\"!=typeof ArrayBuffer&&o instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&o instanceof Blob)return p(e);if(o=e,!(null===(o=Object.getPrototypeOf(o))||\"function\"==typeof(o=o.constructor)&&o instanceof o&&h.call(o)==v))return e;for(n in t={},e)!Object.prototype.hasOwnProperty.call(e,n)||void 0!==(i=y(e[n]))&&(t[n]=i);return t}function _(t){var n=!1;return o(function(e){if(n)throw new Error(\"once called more than once\");n=!0,t.apply(this,e)})}function g(a){return o(function(o){o=y(o);var i=this,t=\"function\"==typeof o[o.length-1]&&o.pop(),e=new Promise(function(n,r){var e;try{var t=_(function(e,t){e?r(e):n(t)});o.push(t),(e=a.apply(i,o))&&\"function\"==typeof e.then&&n(e)}catch(e){r(e)}});return t&&e.then(function(e){t(null,e)},t),e})}function m(e,t){for(var n={},r=0,o=t.length;r<o;r++){var i=t[r];i in e&&(n[i]=e[i])}return n}var b;function w(e){return e}function k(e){return[{ok:e}]}try{localStorage.setItem(\"_pouch_check_localstorage\",1),b=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(e){b=!1}function E(){return b}function O(){var t;a.EventEmitter.call(this),this._listeners={},t=this,b&&addEventListener(\"storage\",function(e){t.emit(e.key)})}function A(e){var t;\"undefined\"!=typeof console&&\"function\"==typeof console[e]&&(t=Array.prototype.slice.call(arguments,1),console[e].apply(console,t))}u(O,a.EventEmitter),O.prototype.addListener=function(e,t,n,r){var o,i;function a(){var e;o._listeners[t]&&(i?i=\"waiting\":(i=!0,e=m(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\",\"return_docs\"]),n.changes(e).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===i&&s(a),i=!1}).on(\"error\",function(){i=!1})))}this._listeners[t]||(i=!1,(o=this)._listeners[t]=a,this.on(e,a))},O.prototype.removeListener=function(e,t){t in this._listeners&&(a.EventEmitter.prototype.removeListener.call(this,e,this._listeners[t]),delete this._listeners[t])},O.prototype.notifyLocalWindows=function(e){b&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},O.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};e=\"function\"==typeof Object.assign?Object.assign:function(e){for(var t=Object(e),n=1;n<arguments.length;n++){var r=arguments[n];if(null!=r)for(var o in r)Object.prototype.hasOwnProperty.call(r,o)&&(t[o]=r[o])}return t};u=function(){}.name?function(e){return e.name}:function(e){e=e.toString().match(/^\\s*function\\s*(?:(\\S+)\\s*)?\\(/);return e&&e[1]?e[1]:\"\"};function I(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}var S=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],x=/(?:^|&)([^&=]*)=?([^&]*)/g,j=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/;function D(s,u,c){return new Promise(function(i,a){s.get(u,function(e,t){if(e){if(404!==e.status)return a(e);t={}}var n,r,o,e=t._rev,t=c(t);if(!t)return i({updated:!1,rev:e});t._id=u,t._rev=e,i((r=t,o=c,(n=s).put(r).then(function(e){return{updated:!0,rev:e.rev}},function(e){if(409!==e.status)throw e;return D(n,r._id,o)})))})})}var $=f.v4;n.adapterFun=function(u,c){return g(o(function(r){if(this._closed)return Promise.reject(new Error(\"database is closed\"));if(this._destroyed)return Promise.reject(new Error(\"database is destroyed\"));var o=this,i=o,a=u,e=r;if(i.constructor.listeners(\"debug\").length){for(var t=[\"api\",i.name,a],n=0;n<e.length-1;n++)t.push(e[n]);i.constructor.emit(\"debug\",t);var s=e[e.length-1];e[e.length-1]=function(e,t){var n=(n=[\"api\",i.name,a]).concat(e?[\"error\",e]:[\"success\",t]);i.constructor.emit(\"debug\",n),s(e,t)}}return this.taskqueue.isReady?c.apply(this,r):new Promise(function(t,n){o.taskqueue.addTask(function(e){e?n(e):t(o[u].apply(o,r))})})}))},n.assign=e,n.bulkGetShim=function(a,s,e){var t=s.docs,u=new i.Map,r=(t.forEach(function(e){u.has(e.id)?u.get(e.id).push(e):u.set(e.id,[e])}),u.size),o=0,c=new Array(r);function f(){var n;++o===r&&(n=[],c.forEach(function(t){t.docs.forEach(function(e){n.push({id:t.id,docs:[e]})})}),e(null,{results:n}))}var n=[],l=(u.forEach(function(e,t){n.push(t)}),0);function d(){var e,i;l>=n.length||(e=Math.min(l+6,n.length),e=n.slice(l,e),i=l,e.forEach(function(n,e){var r=i+e,e=u.get(n),t=m(e[0],[\"atts_since\",\"attachments\"]),o=(t.open_revs=e.map(function(e){return e.rev}),t.open_revs=t.open_revs.filter(w),w);0===t.open_revs.length&&(delete t.open_revs,o=k),[\"revs\",\"attachments\",\"binary\",\"ajax\",\"latest\"].forEach(function(e){e in s&&(t[e]=s[e])}),a.get(n,t,function(e,t){e=e?[{error:e}]:o(t);t=e,c[r]={id:n,docs:t},f(),d()})}),l+=e.length)}d()},n.changesHandler=O,n.clone=y,n.defaultBackOff=function(e){var t,n;return t=(e=e)?0:2e3,e=parseInt(e,10)||0,(t=parseInt(t,10))!=t||t<=e?t=(e||1)<<1:t+=1,6e5<t&&(e=3e5,t=6e5),n=Math.random(),~~((t-e)*n+e)},n.explainError=function(e,t){A(\"info\",\"The above \"+e+\" is totally normal. \"+t)},n.filterChange=function(r){var o={},i=r.filter&&\"function\"==typeof r.filter;return o.query=r.query_params,function(e){e.doc||(e.doc={});var t=i&&function(t,e,n){try{return!t(e,n)}catch(e){t=\"Filter function threw: \"+e.toString();return c.createError(c.BAD_REQUEST,t)}}(r.filter,e.doc,o);if(\"object\"==typeof t)return t;if(t)return!1;if(r.include_docs){if(!r.attachments)for(var n in e.doc._attachments)e.doc._attachments.hasOwnProperty(n)&&(e.doc._attachments[n].stub=!0)}else delete e.doc;return!0}},n.flatten=function(e){for(var t=[],n=0,r=e.length;n<r;n++)t=t.concat(e[n]);return t},n.functionName=u,n.guardedConsole=A,n.hasLocalStorage=E,n.invalidIdError=function(e){var t;if(e?\"string\"!=typeof e?t=c.createError(c.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=c.createError(c.RESERVED_ID)):t=c.createError(c.MISSING_ID),t)throw t},n.isRemote=function(e){return\"boolean\"==typeof e._remote?e._remote:\"function\"==typeof e.type&&(A(\"warn\",\"db.type() is deprecated and will be removed in a future version of PouchDB\"),\"http\"===e.type())},n.listenerCount=function(e,t){return\"listenerCount\"in e?e.listenerCount(t):a.EventEmitter.listenerCount(e,t)},n.nextTick=s,n.normalizeDdocFunctionName=function(e){return(e=I(e))?e.join(\"/\"):null},n.once=_,n.parseDdocFunctionName=I,n.parseUri=function(e){for(var t=j.exec(e),r={},n=14;n--;){var o=S[n],i=t[n]||\"\",a=-1!==[\"user\",\"password\"].indexOf(o);r[o]=a?decodeURIComponent(i):i}return r.queryKey={},r[S[12]].replace(x,function(e,t,n){t&&(r.queryKey[t]=n)}),r},n.pick=m,n.rev=function(e,t){return e=d.clone(e),t?(delete e._rev_tree,l.stringMd5(JSON.stringify(e))):f.v4().replace(/-/g,\"\").toLowerCase()},n.scopeEval=function(e,t){var n,r=[],o=[];for(n in t)t.hasOwnProperty(n)&&(r.push(n),o.push(t[n]));return r.push(e),Function.apply(null,r).apply(null,o)},n.toPromise=g,n.upsert=D,n.uuid=$},{100:100,6:6,63:63,8:8,88:88,9:9,94:94,97:97,98:98}],98:[function(e,t,n){arguments[4][89][0].apply(n,arguments)},{89:89}],99:[function(e,t,n){function r(o){\"use strict\";var r=[\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"];function u(e,t){var n=e[0],r=e[1],o=e[2],i=e[3],r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[0]-680876936|0)<<7|n>>>25)+r|0)&r|~n&o)+t[1]-389564586|0)<<12|i>>>20)+n|0)&n|~i&r)+t[2]+606105819|0)<<17|o>>>15)+i|0)&i|~o&n)+t[3]-1044525330|0)<<22|r>>>10)+o|0;r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[4]-176418897|0)<<7|n>>>25)+r|0)&r|~n&o)+t[5]+1200080426|0)<<12|i>>>20)+n|0)&n|~i&r)+t[6]-1473231341|0)<<17|o>>>15)+i|0)&i|~o&n)+t[7]-45705983|0)<<22|r>>>10)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[8]+1770035416|0)<<7|n>>>25)+r|0)&r|~n&o)+t[9]-1958414417|0)<<12|i>>>20)+n|0)&n|~i&r)+t[10]-42063|0)<<17|o>>>15)+i|0)&i|~o&n)+t[11]-1990404162|0)<<22|r>>>10)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[12]+1804603682|0)<<7|n>>>25)+r|0)&r|~n&o)+t[13]-40341101|0)<<12|i>>>20)+n|0)&n|~i&r)+t[14]-1502002290|0)<<17|o>>>15)+i|0)&i|~o&n)+t[15]+1236535329|0)<<22|r>>>10)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[1]-165796510|0)<<5|n>>>27)+r|0)&o|r&~o)+t[6]-1069501632|0)<<9|i>>>23)+n|0)&r|n&~r)+t[11]+643717713|0)<<14|o>>>18)+i|0)&n|i&~n)+t[0]-373897302|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[5]-701558691|0)<<5|n>>>27)+r|0)&o|r&~o)+t[10]+38016083|0)<<9|i>>>23)+n|0)&r|n&~r)+t[15]-660478335|0)<<14|o>>>18)+i|0)&n|i&~n)+t[4]-405537848|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[9]+568446438|0)<<5|n>>>27)+r|0)&o|r&~o)+t[14]-1019803690|0)<<9|i>>>23)+n|0)&r|n&~r)+t[3]-187363961|0)<<14|o>>>18)+i|0)&n|i&~n)+t[8]+1163531501|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[13]-1444681467|0)<<5|n>>>27)+r|0)&o|r&~o)+t[2]-51403784|0)<<9|i>>>23)+n|0)&r|n&~r)+t[7]+1735328473|0)<<14|o>>>18)+i|0)&n|i&~n)+t[12]-1926607734|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[5]-378558|0)<<4|n>>>28)+r|0)^r^o)+t[8]-2022574463|0)<<11|i>>>21)+n|0)^n^r)+t[11]+1839030562|0)<<16|o>>>16)+i|0)^i^n)+t[14]-35309556|0)<<23|r>>>9)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[1]-1530992060|0)<<4|n>>>28)+r|0)^r^o)+t[4]+1272893353|0)<<11|i>>>21)+n|0)^n^r)+t[7]-155497632|0)<<16|o>>>16)+i|0)^i^n)+t[10]-1094730640|0)<<23|r>>>9)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[13]+681279174|0)<<4|n>>>28)+r|0)^r^o)+t[0]-358537222|0)<<11|i>>>21)+n|0)^n^r)+t[3]-722521979|0)<<16|o>>>16)+i|0)^i^n)+t[6]+76029189|0)<<23|r>>>9)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[9]-640364487|0)<<4|n>>>28)+r|0)^r^o)+t[12]-421815835|0)<<11|i>>>21)+n|0)^n^r)+t[15]+530742520|0)<<16|o>>>16)+i|0)^i^n)+t[2]-995338651|0)<<23|r>>>9)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[0]-198630844|0)<<6|n>>>26)+r|0)|~o))+t[7]+1126891415|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[14]-1416354905|0)<<15|o>>>17)+i|0)|~n))+t[5]-57434055|0)<<21|r>>>11)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[12]+1700485571|0)<<6|n>>>26)+r|0)|~o))+t[3]-1894986606|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[10]-1051523|0)<<15|o>>>17)+i|0)|~n))+t[1]-2054922799|0)<<21|r>>>11)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[8]+1873313359|0)<<6|n>>>26)+r|0)|~o))+t[15]-30611744|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[6]-1560198380|0)<<15|o>>>17)+i|0)|~n))+t[13]+1309151649|0)<<21|r>>>11)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[4]-145523070|0)<<6|n>>>26)+r|0)|~o))+t[11]-1120210379|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[2]+718787259|0)<<15|o>>>17)+i|0)|~n))+t[9]-343485551|0)<<21|r>>>11)+o|0,e[0]=n+e[0]|0,e[1]=r+e[1]|0,e[2]=o+e[2]|0,e[3]=i+e[3]|0}function c(e){for(var t=[],n=0;n<64;n+=4)t[n>>2]=e.charCodeAt(n)+(e.charCodeAt(n+1)<<8)+(e.charCodeAt(n+2)<<16)+(e.charCodeAt(n+3)<<24);return t}function f(e){for(var t=[],n=0;n<64;n+=4)t[n>>2]=e[n]+(e[n+1]<<8)+(e[n+2]<<16)+(e[n+3]<<24);return t}function n(e){for(var t,n,r,o,i=e.length,a=[1732584193,-271733879,-1732584194,271733878],s=64;s<=i;s+=64)u(a,c(e.substring(s-64,s)));for(t=(e=e.substring(s-64)).length,n=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],s=0;s<t;s+=1)n[s>>2]|=e.charCodeAt(s)<<(s%4<<3);if(n[s>>2]|=128<<(s%4<<3),55<s)for(u(a,n),s=0;s<16;s+=1)n[s]=0;return o=(o=8*i).toString(16).match(/(.*?)(.{0,8})$/),r=parseInt(o[2],16),o=parseInt(o[1],16)||0,n[14]=r,n[15]=o,u(a,n),a}function a(e){for(var t=0;t<e.length;t+=1)e[t]=function(e){for(var t=\"\",n=0;n<4;n+=1)t+=r[e>>8*n+4&15]+r[e>>8*n&15];return t}(e[t]);return e.join(\"\")}function i(e,t){return(e=0|e||0)<0?Math.max(e+t,0):Math.min(e,t)}function s(e){return e=/[\\u0080-\\uFFFF]/.test(e)?unescape(encodeURIComponent(e)):e}function l(e){for(var t=[],n=e.length,r=0;r<n-1;r+=2)t.push(parseInt(e.substr(r,2),16));return String.fromCharCode.apply(String,t)}function d(){this.reset()}return\"5d41402abc4b2a76b9719d911017c592\"!==a(n(\"hello\"))&&0,\"undefined\"==typeof ArrayBuffer||ArrayBuffer.prototype.slice||(ArrayBuffer.prototype.slice=function(e,t){var n=this.byteLength,e=i(e,n),r=n;return(r=t!==o?i(t,n):r)<e?new ArrayBuffer(0):(t=r-e,n=new ArrayBuffer(t),r=new Uint8Array(n),e=new Uint8Array(this,e,t),r.set(e),n)}),d.prototype.append=function(e){return this.appendBinary(s(e)),this},d.prototype.appendBinary=function(e){this._buff+=e,this._length+=e.length;for(var t=this._buff.length,n=64;n<=t;n+=64)u(this._hash,c(this._buff.substring(n-64,n)));return this._buff=this._buff.substring(n-64),this},d.prototype.end=function(e){for(var t,n=this._buff,r=n.length,o=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],i=0;i<r;i+=1)o[i>>2]|=n.charCodeAt(i)<<(i%4<<3);return this._finish(o,r),t=a(this._hash),e&&(t=l(t)),this.reset(),t},d.prototype.reset=function(){return this._buff=\"\",this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},d.prototype.getState=function(){return{buff:this._buff,length:this._length,hash:this._hash}},d.prototype.setState=function(e){return this._buff=e.buff,this._length=e.length,this._hash=e.hash,this},d.prototype.destroy=function(){delete this._hash,delete this._buff,delete this._length},d.prototype._finish=function(e,t){var n,r=t;if(e[r>>2]|=128<<(r%4<<3),55<r)for(u(this._hash,e),r=0;r<16;r+=1)e[r]=0;t=(t=8*this._length).toString(16).match(/(.*?)(.{0,8})$/),n=parseInt(t[2],16),t=parseInt(t[1],16)||0,e[14]=n,e[15]=t,u(this._hash,e)},d.hash=function(e,t){return d.hashBinary(s(e),t)},d.hashBinary=function(e,t){e=a(n(e));return t?l(e):e},(d.ArrayBuffer=function(){this.reset()}).prototype.append=function(e){n=this._buff.buffer,r=e,o=!0,(i=new Uint8Array(n.byteLength+r.byteLength)).set(new Uint8Array(n)),i.set(new Uint8Array(r),n.byteLength);var t,n,r,o,i,a=o?i:i.buffer,s=a.length;for(this._length+=e.byteLength,t=64;t<=s;t+=64)u(this._hash,f(a.subarray(t-64,t)));return this._buff=t-64<s?new Uint8Array(a.buffer.slice(t-64)):new Uint8Array(0),this},d.ArrayBuffer.prototype.end=function(e){for(var t,n=this._buff,r=n.length,o=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],i=0;i<r;i+=1)o[i>>2]|=n[i]<<(i%4<<3);return this._finish(o,r),t=a(this._hash),e&&(t=l(t)),this.reset(),t},d.ArrayBuffer.prototype.reset=function(){return this._buff=new Uint8Array(0),this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},d.ArrayBuffer.prototype.getState=function(){var e,t=d.prototype.getState.call(this);return t.buff=(e=t.buff,String.fromCharCode.apply(null,new Uint8Array(e))),t},d.ArrayBuffer.prototype.setState=function(e){return e.buff=function(e,t){for(var n=e.length,r=new ArrayBuffer(n),o=new Uint8Array(r),i=0;i<n;i+=1)o[i]=e.charCodeAt(i);return t?o:r}(e.buff,!0),d.prototype.setState.call(this,e)},d.ArrayBuffer.prototype.destroy=d.prototype.destroy,d.ArrayBuffer.prototype._finish=d.prototype._finish,d.ArrayBuffer.hash=function(e,t){e=a(function(e){for(var t,n,r,o,i=e.length,a=[1732584193,-271733879,-1732584194,271733878],s=64;s<=i;s+=64)u(a,f(e.subarray(s-64,s)));for(t=(e=s-64<i?e.subarray(s-64):new Uint8Array(0)).length,n=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],s=0;s<t;s+=1)n[s>>2]|=e[s]<<(s%4<<3);if(n[s>>2]|=128<<(s%4<<3),55<s)for(u(a,n),s=0;s<16;s+=1)n[s]=0;return o=(o=8*i).toString(16).match(/(.*?)(.{0,8})$/),r=parseInt(o[2],16),o=parseInt(o[1],16)||0,n[14]=r,n[15]=o,u(a,n),a}(new Uint8Array(e)));return t?l(e):e},d}var o;if(\"object\"==typeof n)t.exports=r();else if(\"function\"==typeof define&&define.amd)define(r);else{try{o=window}catch(e){o=self}o.SparkMD5=r()}},{}],100:[function(e,t,n){var r=e(103),e=e(104),o=e;o.v1=r,o.v4=e,t.exports=o},{103:103,104:104}],101:[function(e,t,n){for(var r=[],o=0;o<256;++o)r[o]=(o+256).toString(16).substr(1);t.exports=function(e,t){return t=t||0,r[e[t++]]+r[e[t++]]+r[e[t++]]+r[e[t++]]+\"-\"+r[e[t++]]+r[e[t++]]+\"-\"+r[e[t++]]+r[e[t++]]+\"-\"+r[e[t++]]+r[e[t++]]+\"-\"+r[e[t++]]+r[e[t++]]+r[e[t++]]+r[e[t++]]+r[e[t++]]+r[e[+t]]}},{}],102:[function(e,t,n){var r,o,i=\"undefined\"!=typeof crypto&&crypto.getRandomValues.bind(crypto)||\"undefined\"!=typeof msCrypto&&msCrypto.getRandomValues.bind(msCrypto);i?(r=new Uint8Array(16),t.exports=function(){return i(r),r}):(o=new Array(16),t.exports=function(){for(var e,t=0;t<16;t++)0==(3&t)&&(e=4294967296*Math.random()),o[t]=e>>>((3&t)<<3)&255;return o})},{}],103:[function(e,t,n){var f,l,d=e(102),p=e(101),h=0,v=0;t.exports=function(e,t,n){var r=t&&n||0,o=t||[],i=(e=e||{}).node||f,n=void 0!==e.clockseq?e.clockseq:l,a=(null!=i&&null!=n||(a=d(),null==i&&(i=f=[1|a[0],a[1],a[2],a[3],a[4],a[5]]),null==n&&(n=l=16383&(a[6]<<8|a[7]))),void 0!==e.msecs?e.msecs:(new Date).getTime()),s=void 0!==e.nsecs?e.nsecs:v+1,u=a-h+(s-v)/1e4;if(u<0&&void 0===e.clockseq&&(n=n+1&16383),1e4<=(s=(u<0||h<a)&&void 0===e.nsecs?0:s))throw new Error(\"uuid.v1(): Can't create more than 10M uuids/sec\");h=a,l=n,u=(1e4*(268435455&(a+=122192928e5))+(v=s))%4294967296,o[r++]=u>>>24&255,o[r++]=u>>>16&255,o[r++]=u>>>8&255,o[r++]=255&u,e=a/4294967296*1e4&268435455,o[r++]=e>>>8&255,o[r++]=255&e,o[r++]=e>>>24&15|16,o[r++]=e>>>16&255,o[r++]=n>>>8|128,o[r++]=255&n;for(var c=0;c<6;++c)o[r+c]=i[c];return t||p(o)}},{101:101,102:102}],104:[function(e,t,n){var a=e(102),s=e(101);t.exports=function(e,t,n){var r=t&&n||0,o=(\"string\"==typeof e&&(t=\"binary\"===e?new Array(16):null,e=null),(e=e||{}).random||(e.rng||a)());if(o[6]=15&o[6]|64,o[8]=63&o[8]|128,t)for(var i=0;i<16;++i)t[r+i]=o[i];return t||s(o)}},{101:101,102:102}]},{},[3]);";
},{}],11:[function(_dereq_,module,exports){
'use strict';

module.exports = argsArray;

function argsArray(fun) {
  return function () {
    var len = arguments.length;
    if (len) {
      var args = [];
      var i = -1;
      while (++i < len) {
        args[i] = arguments[i];
      }
      return fun.call(this, args);
    } else {
      return fun.call(this, []);
    }
  };
}
},{}],12:[function(_dereq_,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var objectCreate = Object.create || objectCreatePolyfill
var objectKeys = Object.keys || objectKeysPolyfill
var bind = Function.prototype.bind || functionBindPolyfill

function EventEmitter() {
  if (!this._events || !Object.prototype.hasOwnProperty.call(this, '_events')) {
    this._events = objectCreate(null);
    this._eventsCount = 0;
  }

  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
var defaultMaxListeners = 10;

var hasDefineProperty;
try {
  var o = {};
  if (Object.defineProperty) Object.defineProperty(o, 'x', { value: 0 });
  hasDefineProperty = o.x === 0;
} catch (err) { hasDefineProperty = false }
if (hasDefineProperty) {
  Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
    enumerable: true,
    get: function() {
      return defaultMaxListeners;
    },
    set: function(arg) {
      // check whether the input is a positive number (whose value is zero or
      // greater and not a NaN).
      if (typeof arg !== 'number' || arg < 0 || arg !== arg)
        throw new TypeError('"defaultMaxListeners" must be a positive number');
      defaultMaxListeners = arg;
    }
  });
} else {
  EventEmitter.defaultMaxListeners = defaultMaxListeners;
}

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  if (typeof n !== 'number' || n < 0 || isNaN(n))
    throw new TypeError('"n" argument must be a positive number');
  this._maxListeners = n;
  return this;
};

function $getMaxListeners(that) {
  if (that._maxListeners === undefined)
    return EventEmitter.defaultMaxListeners;
  return that._maxListeners;
}

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  return $getMaxListeners(this);
};

// These standalone emit* functions are used to optimize calling of event
// handlers for fast cases because emit() itself often has a variable number of
// arguments and can be deoptimized because of that. These functions always have
// the same number of arguments and thus do not get deoptimized, so the code
// inside them can execute faster.
function emitNone(handler, isFn, self) {
  if (isFn)
    handler.call(self);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self);
  }
}
function emitOne(handler, isFn, self, arg1) {
  if (isFn)
    handler.call(self, arg1);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1);
  }
}
function emitTwo(handler, isFn, self, arg1, arg2) {
  if (isFn)
    handler.call(self, arg1, arg2);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1, arg2);
  }
}
function emitThree(handler, isFn, self, arg1, arg2, arg3) {
  if (isFn)
    handler.call(self, arg1, arg2, arg3);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1, arg2, arg3);
  }
}

function emitMany(handler, isFn, self, args) {
  if (isFn)
    handler.apply(self, args);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].apply(self, args);
  }
}

EventEmitter.prototype.emit = function emit(type) {
  var er, handler, len, args, i, events;
  var doError = (type === 'error');

  events = this._events;
  if (events)
    doError = (doError && events.error == null);
  else if (!doError)
    return false;

  // If there is no 'error' event listener then throw.
  if (doError) {
    if (arguments.length > 1)
      er = arguments[1];
    if (er instanceof Error) {
      throw er; // Unhandled 'error' event
    } else {
      // At least give some kind of context to the user
      var err = new Error('Unhandled "error" event. (' + er + ')');
      err.context = er;
      throw err;
    }
    return false;
  }

  handler = events[type];

  if (!handler)
    return false;

  var isFn = typeof handler === 'function';
  len = arguments.length;
  switch (len) {
      // fast cases
    case 1:
      emitNone(handler, isFn, this);
      break;
    case 2:
      emitOne(handler, isFn, this, arguments[1]);
      break;
    case 3:
      emitTwo(handler, isFn, this, arguments[1], arguments[2]);
      break;
    case 4:
      emitThree(handler, isFn, this, arguments[1], arguments[2], arguments[3]);
      break;
      // slower
    default:
      args = new Array(len - 1);
      for (i = 1; i < len; i++)
        args[i - 1] = arguments[i];
      emitMany(handler, isFn, this, args);
  }

  return true;
};

function _addListener(target, type, listener, prepend) {
  var m;
  var events;
  var existing;

  if (typeof listener !== 'function')
    throw new TypeError('"listener" argument must be a function');

  events = target._events;
  if (!events) {
    events = target._events = objectCreate(null);
    target._eventsCount = 0;
  } else {
    // To avoid recursion in the case that type === "newListener"! Before
    // adding it to the listeners, first emit "newListener".
    if (events.newListener) {
      target.emit('newListener', type,
          listener.listener ? listener.listener : listener);

      // Re-assign `events` because a newListener handler could have caused the
      // this._events to be assigned to a new object
      events = target._events;
    }
    existing = events[type];
  }

  if (!existing) {
    // Optimize the case of one listener. Don't need the extra array object.
    existing = events[type] = listener;
    ++target._eventsCount;
  } else {
    if (typeof existing === 'function') {
      // Adding the second element, need to change to array.
      existing = events[type] =
          prepend ? [listener, existing] : [existing, listener];
    } else {
      // If we've already got an array, just append.
      if (prepend) {
        existing.unshift(listener);
      } else {
        existing.push(listener);
      }
    }

    // Check for listener leak
    if (!existing.warned) {
      m = $getMaxListeners(target);
      if (m && m > 0 && existing.length > m) {
        existing.warned = true;
        var w = new Error('Possible EventEmitter memory leak detected. ' +
            existing.length + ' "' + String(type) + '" listeners ' +
            'added. Use emitter.setMaxListeners() to ' +
            'increase limit.');
        w.name = 'MaxListenersExceededWarning';
        w.emitter = target;
        w.type = type;
        w.count = existing.length;
        if (typeof console === 'object' && console.warn) {
          console.warn('%s: %s', w.name, w.message);
        }
      }
    }
  }

  return target;
}

EventEmitter.prototype.addListener = function addListener(type, listener) {
  return _addListener(this, type, listener, false);
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.prependListener =
    function prependListener(type, listener) {
      return _addListener(this, type, listener, true);
    };

function onceWrapper() {
  if (!this.fired) {
    this.target.removeListener(this.type, this.wrapFn);
    this.fired = true;
    switch (arguments.length) {
      case 0:
        return this.listener.call(this.target);
      case 1:
        return this.listener.call(this.target, arguments[0]);
      case 2:
        return this.listener.call(this.target, arguments[0], arguments[1]);
      case 3:
        return this.listener.call(this.target, arguments[0], arguments[1],
            arguments[2]);
      default:
        var args = new Array(arguments.length);
        for (var i = 0; i < args.length; ++i)
          args[i] = arguments[i];
        this.listener.apply(this.target, args);
    }
  }
}

function _onceWrap(target, type, listener) {
  var state = { fired: false, wrapFn: undefined, target: target, type: type, listener: listener };
  var wrapped = bind.call(onceWrapper, state);
  wrapped.listener = listener;
  state.wrapFn = wrapped;
  return wrapped;
}

EventEmitter.prototype.once = function once(type, listener) {
  if (typeof listener !== 'function')
    throw new TypeError('"listener" argument must be a function');
  this.on(type, _onceWrap(this, type, listener));
  return this;
};

EventEmitter.prototype.prependOnceListener =
    function prependOnceListener(type, listener) {
      if (typeof listener !== 'function')
        throw new TypeError('"listener" argument must be a function');
      this.prependListener(type, _onceWrap(this, type, listener));
      return this;
    };

// Emits a 'removeListener' event if and only if the listener was removed.
EventEmitter.prototype.removeListener =
    function removeListener(type, listener) {
      var list, events, position, i, originalListener;

      if (typeof listener !== 'function')
        throw new TypeError('"listener" argument must be a function');

      events = this._events;
      if (!events)
        return this;

      list = events[type];
      if (!list)
        return this;

      if (list === listener || list.listener === listener) {
        if (--this._eventsCount === 0)
          this._events = objectCreate(null);
        else {
          delete events[type];
          if (events.removeListener)
            this.emit('removeListener', type, list.listener || listener);
        }
      } else if (typeof list !== 'function') {
        position = -1;

        for (i = list.length - 1; i >= 0; i--) {
          if (list[i] === listener || list[i].listener === listener) {
            originalListener = list[i].listener;
            position = i;
            break;
          }
        }

        if (position < 0)
          return this;

        if (position === 0)
          list.shift();
        else
          spliceOne(list, position);

        if (list.length === 1)
          events[type] = list[0];

        if (events.removeListener)
          this.emit('removeListener', type, originalListener || listener);
      }

      return this;
    };

EventEmitter.prototype.removeAllListeners =
    function removeAllListeners(type) {
      var listeners, events, i;

      events = this._events;
      if (!events)
        return this;

      // not listening for removeListener, no need to emit
      if (!events.removeListener) {
        if (arguments.length === 0) {
          this._events = objectCreate(null);
          this._eventsCount = 0;
        } else if (events[type]) {
          if (--this._eventsCount === 0)
            this._events = objectCreate(null);
          else
            delete events[type];
        }
        return this;
      }

      // emit removeListener for all listeners on all events
      if (arguments.length === 0) {
        var keys = objectKeys(events);
        var key;
        for (i = 0; i < keys.length; ++i) {
          key = keys[i];
          if (key === 'removeListener') continue;
          this.removeAllListeners(key);
        }
        this.removeAllListeners('removeListener');
        this._events = objectCreate(null);
        this._eventsCount = 0;
        return this;
      }

      listeners = events[type];

      if (typeof listeners === 'function') {
        this.removeListener(type, listeners);
      } else if (listeners) {
        // LIFO order
        for (i = listeners.length - 1; i >= 0; i--) {
          this.removeListener(type, listeners[i]);
        }
      }

      return this;
    };

function _listeners(target, type, unwrap) {
  var events = target._events;

  if (!events)
    return [];

  var evlistener = events[type];
  if (!evlistener)
    return [];

  if (typeof evlistener === 'function')
    return unwrap ? [evlistener.listener || evlistener] : [evlistener];

  return unwrap ? unwrapListeners(evlistener) : arrayClone(evlistener, evlistener.length);
}

EventEmitter.prototype.listeners = function listeners(type) {
  return _listeners(this, type, true);
};

EventEmitter.prototype.rawListeners = function rawListeners(type) {
  return _listeners(this, type, false);
};

EventEmitter.listenerCount = function(emitter, type) {
  if (typeof emitter.listenerCount === 'function') {
    return emitter.listenerCount(type);
  } else {
    return listenerCount.call(emitter, type);
  }
};

EventEmitter.prototype.listenerCount = listenerCount;
function listenerCount(type) {
  var events = this._events;

  if (events) {
    var evlistener = events[type];

    if (typeof evlistener === 'function') {
      return 1;
    } else if (evlistener) {
      return evlistener.length;
    }
  }

  return 0;
}

EventEmitter.prototype.eventNames = function eventNames() {
  return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
};

// About 1.5x faster than the two-arg version of Array#splice().
function spliceOne(list, index) {
  for (var i = index, k = i + 1, n = list.length; k < n; i += 1, k += 1)
    list[i] = list[k];
  list.pop();
}

function arrayClone(arr, n) {
  var copy = new Array(n);
  for (var i = 0; i < n; ++i)
    copy[i] = arr[i];
  return copy;
}

function unwrapListeners(arr) {
  var ret = new Array(arr.length);
  for (var i = 0; i < ret.length; ++i) {
    ret[i] = arr[i].listener || arr[i];
  }
  return ret;
}

function objectCreatePolyfill(proto) {
  var F = function() {};
  F.prototype = proto;
  return new F;
}
function objectKeysPolyfill(obj) {
  var keys = [];
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
    keys.push(k);
  }
  return k;
}
function functionBindPolyfill(context) {
  var fn = this;
  return function () {
    return fn.apply(context, arguments);
  };
}

},{}],13:[function(_dereq_,module,exports){
(function (global){
'use strict';
var Mutation = global.MutationObserver || global.WebKitMutationObserver;

var scheduleDrain;

{
  if (Mutation) {
    var called = 0;
    var observer = new Mutation(nextTick);
    var element = global.document.createTextNode('');
    observer.observe(element, {
      characterData: true
    });
    scheduleDrain = function () {
      element.data = (called = ++called % 2);
    };
  } else if (!global.setImmediate && typeof global.MessageChannel !== 'undefined') {
    var channel = new global.MessageChannel();
    channel.port1.onmessage = nextTick;
    scheduleDrain = function () {
      channel.port2.postMessage(0);
    };
  } else if ('document' in global && 'onreadystatechange' in global.document.createElement('script')) {
    scheduleDrain = function () {

      // Create a <script> element; its readystatechange event will be fired asynchronously once it is inserted
      // into the document. Do so, thus queuing up the task. Remember to clean up once it's been called.
      var scriptEl = global.document.createElement('script');
      scriptEl.onreadystatechange = function () {
        nextTick();

        scriptEl.onreadystatechange = null;
        scriptEl.parentNode.removeChild(scriptEl);
        scriptEl = null;
      };
      global.document.documentElement.appendChild(scriptEl);
    };
  } else {
    scheduleDrain = function () {
      setTimeout(nextTick, 0);
    };
  }
}

var draining;
var queue = [];
//named nextTick for less confusing stack traces
function nextTick() {
  draining = true;
  var i, oldQueue;
  var len = queue.length;
  while (len) {
    oldQueue = queue;
    queue = [];
    i = -1;
    while (++i < len) {
      oldQueue[i]();
    }
    len = queue.length;
  }
  draining = false;
}

module.exports = immediate;
function immediate(task) {
  if (queue.push(task) === 1 && !draining) {
    scheduleDrain();
  }
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],14:[function(_dereq_,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    if (superCtor) {
      ctor.super_ = superCtor
      ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
          value: ctor,
          enumerable: false,
          writable: true,
          configurable: true
        }
      })
    }
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    if (superCtor) {
      ctor.super_ = superCtor
      var TempCtor = function () {}
      TempCtor.prototype = superCtor.prototype
      ctor.prototype = new TempCtor()
      ctor.prototype.constructor = ctor
    }
  }
}

},{}],15:[function(_dereq_,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var thisAtob = function (str) {
  return atob(str);
};

var thisBtoa = function (str) {
  return btoa(str);
};

// Abstracts constructing a Blob object, so it also works in older
// browsers that don't support the native Blob constructor (e.g.
// old QtWebKit versions, Android < 4.4).
function createBlob(parts, properties) {
  /* global BlobBuilder,MSBlobBuilder,MozBlobBuilder,WebKitBlobBuilder */
  parts = parts || [];
  properties = properties || {};
  try {
    return new Blob(parts, properties);
  } catch (e) {
    if (e.name !== "TypeError") {
      throw e;
    }
    var Builder = typeof BlobBuilder !== 'undefined' ? BlobBuilder :
                  typeof MSBlobBuilder !== 'undefined' ? MSBlobBuilder :
                  typeof MozBlobBuilder !== 'undefined' ? MozBlobBuilder :
                  WebKitBlobBuilder;
    var builder = new Builder();
    for (var i = 0; i < parts.length; i += 1) {
      builder.append(parts[i]);
    }
    return builder.getBlob(properties.type);
  }
}

// From http://stackoverflow.com/questions/14967647/ (continues on next line)
// encode-decode-image-with-base64-breaks-image (2013-04-21)
function binaryStringToArrayBuffer(bin) {
  var length = bin.length;
  var buf = new ArrayBuffer(length);
  var arr = new Uint8Array(buf);
  for (var i = 0; i < length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return buf;
}

function binStringToBluffer(binString, type) {
  return createBlob([binaryStringToArrayBuffer(binString)], {type: type});
}

function b64ToBluffer(b64, type) {
  return binStringToBluffer(thisAtob(b64), type);
}

//Can't find original post, but this is close
//http://stackoverflow.com/questions/6965107/ (continues on next line)
//converting-between-strings-and-arraybuffers
function arrayBufferToBinaryString(buffer) {
  var binary = '';
  var bytes = new Uint8Array(buffer);
  var length = bytes.byteLength;
  for (var i = 0; i < length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

// shim for browsers that don't support it
function readAsBinaryString(blob, callback) {
  var reader = new FileReader();
  var hasBinaryString = typeof reader.readAsBinaryString === 'function';
  reader.onloadend = function (e) {
    var result = e.target.result || '';
    if (hasBinaryString) {
      return callback(result);
    }
    callback(arrayBufferToBinaryString(result));
  };
  if (hasBinaryString) {
    reader.readAsBinaryString(blob);
  } else {
    reader.readAsArrayBuffer(blob);
  }
}

function blobToBinaryString(blobOrBuffer, callback) {
  readAsBinaryString(blobOrBuffer, function (bin) {
    callback(bin);
  });
}

function blobToBase64(blobOrBuffer, callback) {
  blobToBinaryString(blobOrBuffer, function (base64) {
    callback(thisBtoa(base64));
  });
}

// simplified API. universal browser support is assumed
function readAsArrayBuffer(blob, callback) {
  var reader = new FileReader();
  reader.onloadend = function (e) {
    var result = e.target.result || new ArrayBuffer(0);
    callback(result);
  };
  reader.readAsArrayBuffer(blob);
}

// this is not used in the browser
function typedBuffer() {
}

exports.atob = thisAtob;
exports.btoa = thisBtoa;
exports.base64StringToBlobOrBuffer = b64ToBluffer;
exports.binaryStringToArrayBuffer = binaryStringToArrayBuffer;
exports.binaryStringToBlobOrBuffer = binStringToBluffer;
exports.blob = createBlob;
exports.blobOrBufferToBase64 = blobToBase64;
exports.blobOrBufferToBinaryString = blobToBinaryString;
exports.readAsArrayBuffer = readAsArrayBuffer;
exports.readAsBinaryString = readAsBinaryString;
exports.typedBuffer = typedBuffer;

},{}],16:[function(_dereq_,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function mangle(key) {
  return '$' + key;
}
function unmangle(key) {
  return key.substring(1);
}
function Map$1() {
  this._store = {};
}
Map$1.prototype.get = function (key) {
  var mangled = mangle(key);
  return this._store[mangled];
};
Map$1.prototype.set = function (key, value) {
  var mangled = mangle(key);
  this._store[mangled] = value;
  return true;
};
Map$1.prototype.has = function (key) {
  var mangled = mangle(key);
  return mangled in this._store;
};
Map$1.prototype.delete = function (key) {
  var mangled = mangle(key);
  var res = mangled in this._store;
  delete this._store[mangled];
  return res;
};
Map$1.prototype.forEach = function (cb) {
  var keys = Object.keys(this._store);
  for (var i = 0, len = keys.length; i < len; i++) {
    var key = keys[i];
    var value = this._store[key];
    key = unmangle(key);
    cb(value, key);
  }
};
Object.defineProperty(Map$1.prototype, 'size', {
  get: function () {
    return Object.keys(this._store).length;
  }
});

function Set$1(array) {
  this._store = new Map$1();

  // init with an array
  if (array && Array.isArray(array)) {
    for (var i = 0, len = array.length; i < len; i++) {
      this.add(array[i]);
    }
  }
}
Set$1.prototype.add = function (key) {
  return this._store.set(key, true);
};
Set$1.prototype.has = function (key) {
  return this._store.has(key);
};
Set$1.prototype.forEach = function (cb) {
  this._store.forEach(function (value, key) {
    cb(key);
  });
};
Object.defineProperty(Set$1.prototype, 'size', {
  get: function () {
    return this._store.size;
  }
});

/* global Map,Set,Symbol */
// Based on https://kangax.github.io/compat-table/es6/ we can sniff out
// incomplete Map/Set implementations which would otherwise cause our tests to fail.
// Notably they fail in IE11 and iOS 8.4, which this prevents.
function supportsMapAndSet() {
  if (typeof Symbol === 'undefined' || typeof Map === 'undefined' || typeof Set === 'undefined') {
    return false;
  }
  var prop = Object.getOwnPropertyDescriptor(Map, Symbol.species);
  return prop && 'get' in prop && Map[Symbol.species] === Map;
}

// based on https://github.com/montagejs/collections




{
  if (supportsMapAndSet()) { // prefer built-in Map/Set
    exports.Set = Set;
    exports.Map = Map;
  } else { // fall back to our polyfill
    exports.Set = Set$1;
    exports.Map = Map$1;
  }
}

},{}],17:[function(_dereq_,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var inherits = _interopDefault(_dereq_(18));

inherits(PouchError, Error);

function PouchError(status, error, reason) {
  Error.call(this, reason);
  this.status = status;
  this.name = error;
  this.message = reason;
  this.error = true;
}

PouchError.prototype.toString = function () {
  return JSON.stringify({
    status: this.status,
    name: this.name,
    message: this.message,
    reason: this.reason
  });
};

var UNAUTHORIZED = new PouchError(401, 'unauthorized', "Name or password is incorrect.");
var MISSING_BULK_DOCS = new PouchError(400, 'bad_request', "Missing JSON list of 'docs'");
var MISSING_DOC = new PouchError(404, 'not_found', 'missing');
var REV_CONFLICT = new PouchError(409, 'conflict', 'Document update conflict');
var INVALID_ID = new PouchError(400, 'bad_request', '_id field must contain a string');
var MISSING_ID = new PouchError(412, 'missing_id', '_id is required for puts');
var RESERVED_ID = new PouchError(400, 'bad_request', 'Only reserved document ids may start with underscore.');
var NOT_OPEN = new PouchError(412, 'precondition_failed', 'Database not open');
var UNKNOWN_ERROR = new PouchError(500, 'unknown_error', 'Database encountered an unknown error');
var BAD_ARG = new PouchError(500, 'badarg', 'Some query argument is invalid');
var INVALID_REQUEST = new PouchError(400, 'invalid_request', 'Request was invalid');
var QUERY_PARSE_ERROR = new PouchError(400, 'query_parse_error', 'Some query parameter is invalid');
var DOC_VALIDATION = new PouchError(500, 'doc_validation', 'Bad special document member');
var BAD_REQUEST = new PouchError(400, 'bad_request', 'Something wrong with the request');
var NOT_AN_OBJECT = new PouchError(400, 'bad_request', 'Document must be a JSON object');
var DB_MISSING = new PouchError(404, 'not_found', 'Database not found');
var IDB_ERROR = new PouchError(500, 'indexed_db_went_bad', 'unknown');
var WSQ_ERROR = new PouchError(500, 'web_sql_went_bad', 'unknown');
var LDB_ERROR = new PouchError(500, 'levelDB_went_went_bad', 'unknown');
var FORBIDDEN = new PouchError(403, 'forbidden', 'Forbidden by design doc validate_doc_update function');
var INVALID_REV = new PouchError(400, 'bad_request', 'Invalid rev format');
var FILE_EXISTS = new PouchError(412, 'file_exists', 'The database could not be created, the file already exists.');
var MISSING_STUB = new PouchError(412, 'missing_stub', 'A pre-existing attachment stub wasn\'t found');
var INVALID_URL = new PouchError(413, 'invalid_url', 'Provided URL is invalid');

function createError(error, reason) {
  function CustomPouchError(reason) {
    // inherit error properties from our parent error manually
    // so as to allow proper JSON parsing.
    /* jshint ignore:start */
    for (var p in error) {
      if (typeof error[p] !== 'function') {
        this[p] = error[p];
      }
    }
    /* jshint ignore:end */
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
  CustomPouchError.prototype = PouchError.prototype;
  return new CustomPouchError(reason);
}

function generateErrorFromResponse(err) {

  if (typeof err !== 'object') {
    var data = err;
    err = UNKNOWN_ERROR;
    err.data = data;
  }

  if ('error' in err && err.error === 'conflict') {
    err.name = 'conflict';
    err.status = 409;
  }

  if (!('name' in err)) {
    err.name = err.error || 'unknown';
  }

  if (!('status' in err)) {
    err.status = 500;
  }

  if (!('message' in err)) {
    err.message = err.message || err.reason;
  }

  return err;
}

exports.UNAUTHORIZED = UNAUTHORIZED;
exports.MISSING_BULK_DOCS = MISSING_BULK_DOCS;
exports.MISSING_DOC = MISSING_DOC;
exports.REV_CONFLICT = REV_CONFLICT;
exports.INVALID_ID = INVALID_ID;
exports.MISSING_ID = MISSING_ID;
exports.RESERVED_ID = RESERVED_ID;
exports.NOT_OPEN = NOT_OPEN;
exports.UNKNOWN_ERROR = UNKNOWN_ERROR;
exports.BAD_ARG = BAD_ARG;
exports.INVALID_REQUEST = INVALID_REQUEST;
exports.QUERY_PARSE_ERROR = QUERY_PARSE_ERROR;
exports.DOC_VALIDATION = DOC_VALIDATION;
exports.BAD_REQUEST = BAD_REQUEST;
exports.NOT_AN_OBJECT = NOT_AN_OBJECT;
exports.DB_MISSING = DB_MISSING;
exports.WSQ_ERROR = WSQ_ERROR;
exports.LDB_ERROR = LDB_ERROR;
exports.FORBIDDEN = FORBIDDEN;
exports.INVALID_REV = INVALID_REV;
exports.FILE_EXISTS = FILE_EXISTS;
exports.MISSING_STUB = MISSING_STUB;
exports.IDB_ERROR = IDB_ERROR;
exports.INVALID_URL = INVALID_URL;
exports.createError = createError;
exports.generateErrorFromResponse = generateErrorFromResponse;

},{"18":18}],18:[function(_dereq_,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],19:[function(_dereq_,module,exports){
(function (global){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var pouchdbBinaryUtils = _dereq_(20);
var Md5 = _interopDefault(_dereq_(25));

var setImmediateShim = global.setImmediate || global.setTimeout;
var MD5_CHUNK_SIZE = 32768;

function rawToBase64(raw) {
  return pouchdbBinaryUtils.btoa(raw);
}

function sliceBlob(blob, start, end) {
  if (blob.webkitSlice) {
    return blob.webkitSlice(start, end);
  }
  return blob.slice(start, end);
}

function appendBlob(buffer, blob, start, end, callback) {
  if (start > 0 || end < blob.size) {
    // only slice blob if we really need to
    blob = sliceBlob(blob, start, end);
  }
  pouchdbBinaryUtils.readAsArrayBuffer(blob, function (arrayBuffer) {
    buffer.append(arrayBuffer);
    callback();
  });
}

function appendString(buffer, string, start, end, callback) {
  if (start > 0 || end < string.length) {
    // only create a substring if we really need to
    string = string.substring(start, end);
  }
  buffer.appendBinary(string);
  callback();
}

function binaryMd5(data, callback) {
  var inputIsString = typeof data === 'string';
  var len = inputIsString ? data.length : data.size;
  var chunkSize = Math.min(MD5_CHUNK_SIZE, len);
  var chunks = Math.ceil(len / chunkSize);
  var currentChunk = 0;
  var buffer = inputIsString ? new Md5() : new Md5.ArrayBuffer();

  var append = inputIsString ? appendString : appendBlob;

  function next() {
    setImmediateShim(loadNextChunk);
  }

  function done() {
    var raw = buffer.end(true);
    var base64 = rawToBase64(raw);
    callback(base64);
    buffer.destroy();
  }

  function loadNextChunk() {
    var start = currentChunk * chunkSize;
    var end = start + chunkSize;
    currentChunk++;
    if (currentChunk < chunks) {
      append(buffer, data, start, end, next);
    } else {
      append(buffer, data, start, end, done);
    }
  }
  loadNextChunk();
}

function stringMd5(string) {
  return Md5.hash(string);
}

exports.binaryMd5 = binaryMd5;
exports.stringMd5 = stringMd5;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"20":20,"25":25}],20:[function(_dereq_,module,exports){
arguments[4][15][0].apply(exports,arguments)
},{"15":15}],21:[function(_dereq_,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

// We fetch all leafs of the revision tree, and sort them based on tree length
// and whether they were deleted, undeleted documents with the longest revision
// tree (most edits) win
// The final sort algorithm is slightly documented in a sidebar here:
// http://guide.couchdb.org/draft/conflicts.html
function winningRev(metadata) {
  var winningId;
  var winningPos;
  var winningDeleted;
  var toVisit = metadata.rev_tree.slice();
  var node;
  while ((node = toVisit.pop())) {
    var tree = node.ids;
    var branches = tree[2];
    var pos = node.pos;
    if (branches.length) { // non-leaf
      for (var i = 0, len = branches.length; i < len; i++) {
        toVisit.push({pos: pos + 1, ids: branches[i]});
      }
      continue;
    }
    var deleted = !!tree[1].deleted;
    var id = tree[0];
    // sort by deleted, then pos, then id
    if (!winningId || (winningDeleted !== deleted ? winningDeleted :
        winningPos !== pos ? winningPos < pos : winningId < id)) {
      winningId = id;
      winningPos = pos;
      winningDeleted = deleted;
    }
  }

  return winningPos + '-' + winningId;
}

// Pretty much all below can be combined into a higher order function to
// traverse revisions
// The return value from the callback will be passed as context to all
// children of that node
function traverseRevTree(revs, callback) {
  var toVisit = revs.slice();

  var node;
  while ((node = toVisit.pop())) {
    var pos = node.pos;
    var tree = node.ids;
    var branches = tree[2];
    var newCtx =
      callback(branches.length === 0, pos, tree[0], node.ctx, tree[1]);
    for (var i = 0, len = branches.length; i < len; i++) {
      toVisit.push({pos: pos + 1, ids: branches[i], ctx: newCtx});
    }
  }
}

function sortByPos(a, b) {
  return a.pos - b.pos;
}

function collectLeaves(revs) {
  var leaves = [];
  traverseRevTree(revs, function (isLeaf, pos, id, acc, opts) {
    if (isLeaf) {
      leaves.push({rev: pos + "-" + id, pos: pos, opts: opts});
    }
  });
  leaves.sort(sortByPos).reverse();
  for (var i = 0, len = leaves.length; i < len; i++) {
    delete leaves[i].pos;
  }
  return leaves;
}

// returns revs of all conflicts that is leaves such that
// 1. are not deleted and
// 2. are different than winning revision
function collectConflicts(metadata) {
  var win = winningRev(metadata);
  var leaves = collectLeaves(metadata.rev_tree);
  var conflicts = [];
  for (var i = 0, len = leaves.length; i < len; i++) {
    var leaf = leaves[i];
    if (leaf.rev !== win && !leaf.opts.deleted) {
      conflicts.push(leaf.rev);
    }
  }
  return conflicts;
}

// compact a tree by marking its non-leafs as missing,
// and return a list of revs to delete
function compactTree(metadata) {
  var revs = [];
  traverseRevTree(metadata.rev_tree, function (isLeaf, pos,
                                               revHash, ctx, opts) {
    if (opts.status === 'available' && !isLeaf) {
      revs.push(pos + '-' + revHash);
      opts.status = 'missing';
    }
  });
  return revs;
}

// build up a list of all the paths to the leafs in this revision tree
function rootToLeaf(revs) {
  var paths = [];
  var toVisit = revs.slice();
  var node;
  while ((node = toVisit.pop())) {
    var pos = node.pos;
    var tree = node.ids;
    var id = tree[0];
    var opts = tree[1];
    var branches = tree[2];
    var isLeaf = branches.length === 0;

    var history = node.history ? node.history.slice() : [];
    history.push({id: id, opts: opts});
    if (isLeaf) {
      paths.push({pos: (pos + 1 - history.length), ids: history});
    }
    for (var i = 0, len = branches.length; i < len; i++) {
      toVisit.push({pos: pos + 1, ids: branches[i], history: history});
    }
  }
  return paths.reverse();
}

// for a better overview of what this is doing, read:

function sortByPos$1(a, b) {
  return a.pos - b.pos;
}

// classic binary search
function binarySearch(arr, item, comparator) {
  var low = 0;
  var high = arr.length;
  var mid;
  while (low < high) {
    mid = (low + high) >>> 1;
    if (comparator(arr[mid], item) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

// assuming the arr is sorted, insert the item in the proper place
function insertSorted(arr, item, comparator) {
  var idx = binarySearch(arr, item, comparator);
  arr.splice(idx, 0, item);
}

// Turn a path as a flat array into a tree with a single branch.
// If any should be stemmed from the beginning of the array, that's passed
// in as the second argument
function pathToTree(path, numStemmed) {
  var root;
  var leaf;
  for (var i = numStemmed, len = path.length; i < len; i++) {
    var node = path[i];
    var currentLeaf = [node.id, node.opts, []];
    if (leaf) {
      leaf[2].push(currentLeaf);
      leaf = currentLeaf;
    } else {
      root = leaf = currentLeaf;
    }
  }
  return root;
}

// compare the IDs of two trees
function compareTree(a, b) {
  return a[0] < b[0] ? -1 : 1;
}

// Merge two trees together
// The roots of tree1 and tree2 must be the same revision
function mergeTree(in_tree1, in_tree2) {
  var queue = [{tree1: in_tree1, tree2: in_tree2}];
  var conflicts = false;
  while (queue.length > 0) {
    var item = queue.pop();
    var tree1 = item.tree1;
    var tree2 = item.tree2;

    if (tree1[1].status || tree2[1].status) {
      tree1[1].status =
        (tree1[1].status ===  'available' ||
        tree2[1].status === 'available') ? 'available' : 'missing';
    }

    for (var i = 0; i < tree2[2].length; i++) {
      if (!tree1[2][0]) {
        conflicts = 'new_leaf';
        tree1[2][0] = tree2[2][i];
        continue;
      }

      var merged = false;
      for (var j = 0; j < tree1[2].length; j++) {
        if (tree1[2][j][0] === tree2[2][i][0]) {
          queue.push({tree1: tree1[2][j], tree2: tree2[2][i]});
          merged = true;
        }
      }
      if (!merged) {
        conflicts = 'new_branch';
        insertSorted(tree1[2], tree2[2][i], compareTree);
      }
    }
  }
  return {conflicts: conflicts, tree: in_tree1};
}

function doMerge(tree, path, dontExpand) {
  var restree = [];
  var conflicts = false;
  var merged = false;
  var res;

  if (!tree.length) {
    return {tree: [path], conflicts: 'new_leaf'};
  }

  for (var i = 0, len = tree.length; i < len; i++) {
    var branch = tree[i];
    if (branch.pos === path.pos && branch.ids[0] === path.ids[0]) {
      // Paths start at the same position and have the same root, so they need
      // merged
      res = mergeTree(branch.ids, path.ids);
      restree.push({pos: branch.pos, ids: res.tree});
      conflicts = conflicts || res.conflicts;
      merged = true;
    } else if (dontExpand !== true) {
      // The paths start at a different position, take the earliest path and
      // traverse up until it as at the same point from root as the path we
      // want to merge.  If the keys match we return the longer path with the
      // other merged After stemming we dont want to expand the trees

      var t1 = branch.pos < path.pos ? branch : path;
      var t2 = branch.pos < path.pos ? path : branch;
      var diff = t2.pos - t1.pos;

      var candidateParents = [];

      var trees = [];
      trees.push({ids: t1.ids, diff: diff, parent: null, parentIdx: null});
      while (trees.length > 0) {
        var item = trees.pop();
        if (item.diff === 0) {
          if (item.ids[0] === t2.ids[0]) {
            candidateParents.push(item);
          }
          continue;
        }
        var elements = item.ids[2];
        for (var j = 0, elementsLen = elements.length; j < elementsLen; j++) {
          trees.push({
            ids: elements[j],
            diff: item.diff - 1,
            parent: item.ids,
            parentIdx: j
          });
        }
      }

      var el = candidateParents[0];

      if (!el) {
        restree.push(branch);
      } else {
        res = mergeTree(el.ids, t2.ids);
        el.parent[2][el.parentIdx] = res.tree;
        restree.push({pos: t1.pos, ids: t1.ids});
        conflicts = conflicts || res.conflicts;
        merged = true;
      }
    } else {
      restree.push(branch);
    }
  }

  // We didnt find
  if (!merged) {
    restree.push(path);
  }

  restree.sort(sortByPos$1);

  return {
    tree: restree,
    conflicts: conflicts || 'internal_node'
  };
}

// To ensure we dont grow the revision tree infinitely, we stem old revisions
function stem(tree, depth) {
  // First we break out the tree into a complete list of root to leaf paths
  var paths = rootToLeaf(tree);
  var stemmedRevs;

  var result;
  for (var i = 0, len = paths.length; i < len; i++) {
    // Then for each path, we cut off the start of the path based on the
    // `depth` to stem to, and generate a new set of flat trees
    var path = paths[i];
    var stemmed = path.ids;
    var node;
    if (stemmed.length > depth) {
      // only do the stemming work if we actually need to stem
      if (!stemmedRevs) {
        stemmedRevs = {}; // avoid allocating this object unnecessarily
      }
      var numStemmed = stemmed.length - depth;
      node = {
        pos: path.pos + numStemmed,
        ids: pathToTree(stemmed, numStemmed)
      };

      for (var s = 0; s < numStemmed; s++) {
        var rev = (path.pos + s) + '-' + stemmed[s].id;
        stemmedRevs[rev] = true;
      }
    } else { // no need to actually stem
      node = {
        pos: path.pos,
        ids: pathToTree(stemmed, 0)
      };
    }

    // Then we remerge all those flat trees together, ensuring that we dont
    // connect trees that would go beyond the depth limit
    if (result) {
      result = doMerge(result, node, true).tree;
    } else {
      result = [node];
    }
  }

  // this is memory-heavy per Chrome profiler, avoid unless we actually stemmed
  if (stemmedRevs) {
    traverseRevTree(result, function (isLeaf, pos, revHash) {
      // some revisions may have been removed in a branch but not in another
      delete stemmedRevs[pos + '-' + revHash];
    });
  }

  return {
    tree: result,
    revs: stemmedRevs ? Object.keys(stemmedRevs) : []
  };
}

function merge(tree, path, depth) {
  var newTree = doMerge(tree, path);
  var stemmed = stem(newTree.tree, depth);
  return {
    tree: stemmed.tree,
    stemmedRevs: stemmed.revs,
    conflicts: newTree.conflicts
  };
}

// return true if a rev exists in the rev tree, false otherwise
function revExists(revs, rev) {
  var toVisit = revs.slice();
  var splitRev = rev.split('-');
  var targetPos = parseInt(splitRev[0], 10);
  var targetId = splitRev[1];

  var node;
  while ((node = toVisit.pop())) {
    if (node.pos === targetPos && node.ids[0] === targetId) {
      return true;
    }
    var branches = node.ids[2];
    for (var i = 0, len = branches.length; i < len; i++) {
      toVisit.push({pos: node.pos + 1, ids: branches[i]});
    }
  }
  return false;
}

function getTrees(node) {
  return node.ids;
}

// check if a specific revision of a doc has been deleted
//  - metadata: the metadata object from the doc store
//  - rev: (optional) the revision to check. defaults to winning revision
function isDeleted(metadata, rev) {
  if (!rev) {
    rev = winningRev(metadata);
  }
  var id = rev.substring(rev.indexOf('-') + 1);
  var toVisit = metadata.rev_tree.map(getTrees);

  var tree;
  while ((tree = toVisit.pop())) {
    if (tree[0] === id) {
      return !!tree[1].deleted;
    }
    toVisit = toVisit.concat(tree[2]);
  }
}

function isLocalId(id) {
  return (/^_local/).test(id);
}

// returns the current leaf node for a given revision
function latest(rev, metadata) {
  var toVisit = metadata.rev_tree.slice();
  var node;
  while ((node = toVisit.pop())) {
    var pos = node.pos;
    var tree = node.ids;
    var id = tree[0];
    var opts = tree[1];
    var branches = tree[2];
    var isLeaf = branches.length === 0;

    var history = node.history ? node.history.slice() : [];
    history.push({id: id, pos: pos, opts: opts});

    if (isLeaf) {
      for (var i = 0, len = history.length; i < len; i++) {
        var historyNode = history[i];
        var historyRev = historyNode.pos + '-' + historyNode.id;

        if (historyRev === rev) {
          // return the rev of this leaf
          return pos + '-' + id;
        }
      }
    }

    for (var j = 0, l = branches.length; j < l; j++) {
      toVisit.push({pos: pos + 1, ids: branches[j], history: history});
    }
  }

  /* istanbul ignore next */
  throw new Error('Unable to resolve latest revision for id ' + metadata.id + ', rev ' + rev);
}

exports.collectConflicts = collectConflicts;
exports.collectLeaves = collectLeaves;
exports.compactTree = compactTree;
exports.isDeleted = isDeleted;
exports.isLocalId = isLocalId;
exports.merge = merge;
exports.revExists = revExists;
exports.rootToLeaf = rootToLeaf;
exports.traverseRevTree = traverseRevTree;
exports.winningRev = winningRev;
exports.latest = latest;

},{}],22:[function(_dereq_,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var getArguments = _interopDefault(_dereq_(11));
var pouchdbCollections = _dereq_(16);
var immediate = _interopDefault(_dereq_(13));
var events = _dereq_(12);
var inherits = _interopDefault(_dereq_(23));
var pouchdbErrors = _dereq_(17);
var uuidV4 = _interopDefault(_dereq_(26));
var pouchdbMd5 = _dereq_(19);
var pouchdbUtils = _dereq_(22);

function isBinaryObject(object) {
  return (typeof ArrayBuffer !== 'undefined' && object instanceof ArrayBuffer) ||
    (typeof Blob !== 'undefined' && object instanceof Blob);
}

function cloneArrayBuffer(buff) {
  if (typeof buff.slice === 'function') {
    return buff.slice(0);
  }
  // IE10-11 slice() polyfill
  var target = new ArrayBuffer(buff.byteLength);
  var targetArray = new Uint8Array(target);
  var sourceArray = new Uint8Array(buff);
  targetArray.set(sourceArray);
  return target;
}

function cloneBinaryObject(object) {
  if (object instanceof ArrayBuffer) {
    return cloneArrayBuffer(object);
  }
  var size = object.size;
  var type = object.type;
  // Blob
  if (typeof object.slice === 'function') {
    return object.slice(0, size, type);
  }
  // PhantomJS slice() replacement
  return object.webkitSlice(0, size, type);
}

// most of this is borrowed from lodash.isPlainObject:
// https://github.com/fis-components/lodash.isplainobject/
// blob/29c358140a74f252aeb08c9eb28bef86f2217d4a/index.js

var funcToString = Function.prototype.toString;
var objectCtorString = funcToString.call(Object);

function isPlainObject(value) {
  var proto = Object.getPrototypeOf(value);
  /* istanbul ignore if */
  if (proto === null) { // not sure when this happens, but I guess it can
    return true;
  }
  var Ctor = proto.constructor;
  return (typeof Ctor == 'function' &&
    Ctor instanceof Ctor && funcToString.call(Ctor) == objectCtorString);
}

function clone(object) {
  var newObject;
  var i;
  var len;

  if (!object || typeof object !== 'object') {
    return object;
  }

  if (Array.isArray(object)) {
    newObject = [];
    for (i = 0, len = object.length; i < len; i++) {
      newObject[i] = clone(object[i]);
    }
    return newObject;
  }

  // special case: to avoid inconsistencies between IndexedDB
  // and other backends, we automatically stringify Dates
  if (object instanceof Date) {
    return object.toISOString();
  }

  if (isBinaryObject(object)) {
    return cloneBinaryObject(object);
  }

  if (!isPlainObject(object)) {
    return object; // don't clone objects like Workers
  }

  newObject = {};
  for (i in object) {
    /* istanbul ignore else */
    if (Object.prototype.hasOwnProperty.call(object, i)) {
      var value = clone(object[i]);
      if (typeof value !== 'undefined') {
        newObject[i] = value;
      }
    }
  }
  return newObject;
}

function once(fun) {
  var called = false;
  return getArguments(function (args) {
    /* istanbul ignore if */
    if (called) {
      // this is a smoke test and should never actually happen
      throw new Error('once called more than once');
    } else {
      called = true;
      fun.apply(this, args);
    }
  });
}

function toPromise(func) {
  //create the function we will be returning
  return getArguments(function (args) {
    // Clone arguments
    args = clone(args);
    var self = this;
    // if the last argument is a function, assume its a callback
    var usedCB = (typeof args[args.length - 1] === 'function') ? args.pop() : false;
    var promise = new Promise(function (fulfill, reject) {
      var resp;
      try {
        var callback = once(function (err, mesg) {
          if (err) {
            reject(err);
          } else {
            fulfill(mesg);
          }
        });
        // create a callback for this invocation
        // apply the function in the orig context
        args.push(callback);
        resp = func.apply(self, args);
        if (resp && typeof resp.then === 'function') {
          fulfill(resp);
        }
      } catch (e) {
        reject(e);
      }
    });
    // if there is a callback, call it back
    if (usedCB) {
      promise.then(function (result) {
        usedCB(null, result);
      }, usedCB);
    }
    return promise;
  });
}

function logApiCall(self, name, args) {
  /* istanbul ignore if */
  if (self.constructor.listeners('debug').length) {
    var logArgs = ['api', self.name, name];
    for (var i = 0; i < args.length - 1; i++) {
      logArgs.push(args[i]);
    }
    self.constructor.emit('debug', logArgs);

    // override the callback itself to log the response
    var origCallback = args[args.length - 1];
    args[args.length - 1] = function (err, res) {
      var responseArgs = ['api', self.name, name];
      responseArgs = responseArgs.concat(
        err ? ['error', err] : ['success', res]
      );
      self.constructor.emit('debug', responseArgs);
      origCallback(err, res);
    };
  }
}

function adapterFun(name, callback) {
  return toPromise(getArguments(function (args) {
    if (this._closed) {
      return Promise.reject(new Error('database is closed'));
    }
    if (this._destroyed) {
      return Promise.reject(new Error('database is destroyed'));
    }
    var self = this;
    logApiCall(self, name, args);
    if (!this.taskqueue.isReady) {
      return new Promise(function (fulfill, reject) {
        self.taskqueue.addTask(function (failed) {
          if (failed) {
            reject(failed);
          } else {
            fulfill(self[name].apply(self, args));
          }
        });
      });
    }
    return callback.apply(this, args);
  }));
}

// like underscore/lodash _.pick()
function pick(obj, arr) {
  var res = {};
  for (var i = 0, len = arr.length; i < len; i++) {
    var prop = arr[i];
    if (prop in obj) {
      res[prop] = obj[prop];
    }
  }
  return res;
}

// Most browsers throttle concurrent requests at 6, so it's silly
// to shim _bulk_get by trying to launch potentially hundreds of requests
// and then letting the majority time out. We can handle this ourselves.
var MAX_NUM_CONCURRENT_REQUESTS = 6;

function identityFunction(x) {
  return x;
}

function formatResultForOpenRevsGet(result) {
  return [{
    ok: result
  }];
}

// shim for P/CouchDB adapters that don't directly implement _bulk_get
function bulkGet(db, opts, callback) {
  var requests = opts.docs;

  // consolidate into one request per doc if possible
  var requestsById = new pouchdbCollections.Map();
  requests.forEach(function (request) {
    if (requestsById.has(request.id)) {
      requestsById.get(request.id).push(request);
    } else {
      requestsById.set(request.id, [request]);
    }
  });

  var numDocs = requestsById.size;
  var numDone = 0;
  var perDocResults = new Array(numDocs);

  function collapseResultsAndFinish() {
    var results = [];
    perDocResults.forEach(function (res) {
      res.docs.forEach(function (info) {
        results.push({
          id: res.id,
          docs: [info]
        });
      });
    });
    callback(null, {results: results});
  }

  function checkDone() {
    if (++numDone === numDocs) {
      collapseResultsAndFinish();
    }
  }

  function gotResult(docIndex, id, docs) {
    perDocResults[docIndex] = {id: id, docs: docs};
    checkDone();
  }

  var allRequests = [];
  requestsById.forEach(function (value, key) {
    allRequests.push(key);
  });

  var i = 0;

  function nextBatch() {

    if (i >= allRequests.length) {
      return;
    }

    var upTo = Math.min(i + MAX_NUM_CONCURRENT_REQUESTS, allRequests.length);
    var batch = allRequests.slice(i, upTo);
    processBatch(batch, i);
    i += batch.length;
  }

  function processBatch(batch, offset) {
    batch.forEach(function (docId, j) {
      var docIdx = offset + j;
      var docRequests = requestsById.get(docId);

      // just use the first request as the "template"
      // TODO: The _bulk_get API allows for more subtle use cases than this,
      // but for now it is unlikely that there will be a mix of different
      // "atts_since" or "attachments" in the same request, since it's just
      // replicate.js that is using this for the moment.
      // Also, atts_since is aspirational, since we don't support it yet.
      var docOpts = pick(docRequests[0], ['atts_since', 'attachments']);
      docOpts.open_revs = docRequests.map(function (request) {
        // rev is optional, open_revs disallowed
        return request.rev;
      });

      // remove falsey / undefined revisions
      docOpts.open_revs = docOpts.open_revs.filter(identityFunction);

      var formatResult = identityFunction;

      if (docOpts.open_revs.length === 0) {
        delete docOpts.open_revs;

        // when fetching only the "winning" leaf,
        // transform the result so it looks like an open_revs
        // request
        formatResult = formatResultForOpenRevsGet;
      }

      // globally-supplied options
      ['revs', 'attachments', 'binary', 'ajax', 'latest'].forEach(function (param) {
        if (param in opts) {
          docOpts[param] = opts[param];
        }
      });
      db.get(docId, docOpts, function (err, res) {
        var result;
        /* istanbul ignore if */
        if (err) {
          result = [{error: err}];
        } else {
          result = formatResult(res);
        }
        gotResult(docIdx, docId, result);
        nextBatch();
      });
    });
  }

  nextBatch();

}

var hasLocal;

try {
  localStorage.setItem('_pouch_check_localstorage', 1);
  hasLocal = !!localStorage.getItem('_pouch_check_localstorage');
} catch (e) {
  hasLocal = false;
}

function hasLocalStorage() {
  return hasLocal;
}

// Custom nextTick() shim for browsers. In node, this will just be process.nextTick(). We

inherits(Changes, events.EventEmitter);

/* istanbul ignore next */
function attachBrowserEvents(self) {
  if (hasLocalStorage()) {
    addEventListener("storage", function (e) {
      self.emit(e.key);
    });
  }
}

function Changes() {
  events.EventEmitter.call(this);
  this._listeners = {};

  attachBrowserEvents(this);
}
Changes.prototype.addListener = function (dbName, id, db, opts) {
  /* istanbul ignore if */
  if (this._listeners[id]) {
    return;
  }
  var self = this;
  var inprogress = false;
  function eventFunction() {
    /* istanbul ignore if */
    if (!self._listeners[id]) {
      return;
    }
    if (inprogress) {
      inprogress = 'waiting';
      return;
    }
    inprogress = true;
    var changesOpts = pick(opts, [
      'style', 'include_docs', 'attachments', 'conflicts', 'filter',
      'doc_ids', 'view', 'since', 'query_params', 'binary', 'return_docs'
    ]);

    /* istanbul ignore next */
    function onError() {
      inprogress = false;
    }

    db.changes(changesOpts).on('change', function (c) {
      if (c.seq > opts.since && !opts.cancelled) {
        opts.since = c.seq;
        opts.onChange(c);
      }
    }).on('complete', function () {
      if (inprogress === 'waiting') {
        immediate(eventFunction);
      }
      inprogress = false;
    }).on('error', onError);
  }
  this._listeners[id] = eventFunction;
  this.on(dbName, eventFunction);
};

Changes.prototype.removeListener = function (dbName, id) {
  /* istanbul ignore if */
  if (!(id in this._listeners)) {
    return;
  }
  events.EventEmitter.prototype.removeListener.call(this, dbName,
    this._listeners[id]);
  delete this._listeners[id];
};


/* istanbul ignore next */
Changes.prototype.notifyLocalWindows = function (dbName) {
  //do a useless change on a storage thing
  //in order to get other windows's listeners to activate
  if (hasLocalStorage()) {
    localStorage[dbName] = (localStorage[dbName] === "a") ? "b" : "a";
  }
};

Changes.prototype.notify = function (dbName) {
  this.emit(dbName);
  this.notifyLocalWindows(dbName);
};

function guardedConsole(method) {
  /* istanbul ignore else */
  if (typeof console !== 'undefined' && typeof console[method] === 'function') {
    var args = Array.prototype.slice.call(arguments, 1);
    console[method].apply(console, args);
  }
}

function randomNumber(min, max) {
  var maxTimeout = 600000; // Hard-coded default of 10 minutes
  min = parseInt(min, 10) || 0;
  max = parseInt(max, 10);
  if (max !== max || max <= min) {
    max = (min || 1) << 1; //doubling
  } else {
    max = max + 1;
  }
  // In order to not exceed maxTimeout, pick a random value between half of maxTimeout and maxTimeout
  if (max > maxTimeout) {
    min = maxTimeout >> 1; // divide by two
    max = maxTimeout;
  }
  var ratio = Math.random();
  var range = max - min;

  return ~~(range * ratio + min); // ~~ coerces to an int, but fast.
}

function defaultBackOff(min) {
  var max = 0;
  if (!min) {
    max = 2000;
  }
  return randomNumber(min, max);
}

// designed to give info to browser users, who are disturbed
// when they see http errors in the console
function explainError(status, str) {
  guardedConsole('info', 'The above ' + status + ' is totally normal. ' + str);
}

var assign;
{
  if (typeof Object.assign === 'function') {
    assign = Object.assign;
  } else {
    // lite Object.assign polyfill based on
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign
    assign = function (target) {
      var to = Object(target);

      for (var index = 1; index < arguments.length; index++) {
        var nextSource = arguments[index];

        if (nextSource != null) { // Skip over if undefined or null
          for (var nextKey in nextSource) {
            // Avoid bugs when hasOwnProperty is shadowed
            if (Object.prototype.hasOwnProperty.call(nextSource, nextKey)) {
              to[nextKey] = nextSource[nextKey];
            }
          }
        }
      }
      return to;
    };
  }
}

var assign$1 = assign;

function tryFilter(filter, doc, req) {
  try {
    return !filter(doc, req);
  } catch (err) {
    var msg = 'Filter function threw: ' + err.toString();
    return pouchdbErrors.createError(pouchdbErrors.BAD_REQUEST, msg);
  }
}

function filterChange(opts) {
  var req = {};
  var hasFilter = opts.filter && typeof opts.filter === 'function';
  req.query = opts.query_params;

  return function filter(change) {
    if (!change.doc) {
      // CSG sends events on the changes feed that don't have documents,
      // this hack makes a whole lot of existing code robust.
      change.doc = {};
    }

    var filterReturn = hasFilter && tryFilter(opts.filter, change.doc, req);

    if (typeof filterReturn === 'object') {
      return filterReturn;
    }

    if (filterReturn) {
      return false;
    }

    if (!opts.include_docs) {
      delete change.doc;
    } else if (!opts.attachments) {
      for (var att in change.doc._attachments) {
        /* istanbul ignore else */
        if (change.doc._attachments.hasOwnProperty(att)) {
          change.doc._attachments[att].stub = true;
        }
      }
    }
    return true;
  };
}

function flatten(arrs) {
  var res = [];
  for (var i = 0, len = arrs.length; i < len; i++) {
    res = res.concat(arrs[i]);
  }
  return res;
}

// shim for Function.prototype.name,
// for browsers that don't support it like IE

/* istanbul ignore next */
function f() {}

var hasName = f.name;
var res;

// We dont run coverage in IE
/* istanbul ignore else */
if (hasName) {
  res = function (fun) {
    return fun.name;
  };
} else {
  res = function (fun) {
    var match = fun.toString().match(/^\s*function\s*(?:(\S+)\s*)?\(/);
    if (match && match[1]) {
      return match[1];
    }
    else {
      return '';
    }
  };
}

var res$1 = res;

// Determine id an ID is valid
//   - invalid IDs begin with an underescore that does not begin '_design' or
//     '_local'
//   - any other string value is a valid id
// Returns the specific error object for each case
function invalidIdError(id) {
  var err;
  if (!id) {
    err = pouchdbErrors.createError(pouchdbErrors.MISSING_ID);
  } else if (typeof id !== 'string') {
    err = pouchdbErrors.createError(pouchdbErrors.INVALID_ID);
  } else if (/^_/.test(id) && !(/^_(design|local)/).test(id)) {
    err = pouchdbErrors.createError(pouchdbErrors.RESERVED_ID);
  }
  if (err) {
    throw err;
  }
}

// Checks if a PouchDB object is "remote" or not. This is

function isRemote(db) {
  if (typeof db._remote === 'boolean') {
    return db._remote;
  }
  /* istanbul ignore next */
  if (typeof db.type === 'function') {
    guardedConsole('warn',
      'db.type() is deprecated and will be removed in ' +
      'a future version of PouchDB');
    return db.type() === 'http';
  }
  /* istanbul ignore next */
  return false;
}

function listenerCount(ee, type) {
  return 'listenerCount' in ee ? ee.listenerCount(type) :
                                 events.EventEmitter.listenerCount(ee, type);
}

function parseDesignDocFunctionName(s) {
  if (!s) {
    return null;
  }
  var parts = s.split('/');
  if (parts.length === 2) {
    return parts;
  }
  if (parts.length === 1) {
    return [s, s];
  }
  return null;
}

function normalizeDesignDocFunctionName(s) {
  var normalized = parseDesignDocFunctionName(s);
  return normalized ? normalized.join('/') : null;
}

// originally parseUri 1.2.2, now patched by us
// (c) Steven Levithan <stevenlevithan.com>
// MIT License
var keys = ["source", "protocol", "authority", "userInfo", "user", "password",
    "host", "port", "relative", "path", "directory", "file", "query", "anchor"];
var qName ="queryKey";
var qParser = /(?:^|&)([^&=]*)=?([^&]*)/g;

// use the "loose" parser
/* eslint maxlen: 0, no-useless-escape: 0 */
var parser = /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/;

function parseUri(str) {
  var m = parser.exec(str);
  var uri = {};
  var i = 14;

  while (i--) {
    var key = keys[i];
    var value = m[i] || "";
    var encoded = ['user', 'password'].indexOf(key) !== -1;
    uri[key] = encoded ? decodeURIComponent(value) : value;
  }

  uri[qName] = {};
  uri[keys[12]].replace(qParser, function ($0, $1, $2) {
    if ($1) {
      uri[qName][$1] = $2;
    }
  });

  return uri;
}

// Based on https://github.com/alexdavid/scope-eval v0.0.3
// (source: https://unpkg.com/scope-eval@0.0.3/scope_eval.js)
// This is basically just a wrapper around new Function()

function scopeEval(source, scope) {
  var keys = [];
  var values = [];
  for (var key in scope) {
    if (scope.hasOwnProperty(key)) {
      keys.push(key);
      values.push(scope[key]);
    }
  }
  keys.push(source);
  return Function.apply(null, keys).apply(null, values);
}

// this is essentially the "update sugar" function from daleharvey/pouchdb#1388
// the diffFun tells us what delta to apply to the doc.  it either returns
// the doc, or false if it doesn't need to do an update after all
function upsert(db, docId, diffFun) {
  return new Promise(function (fulfill, reject) {
    db.get(docId, function (err, doc) {
      if (err) {
        /* istanbul ignore next */
        if (err.status !== 404) {
          return reject(err);
        }
        doc = {};
      }

      // the user might change the _rev, so save it for posterity
      var docRev = doc._rev;
      var newDoc = diffFun(doc);

      if (!newDoc) {
        // if the diffFun returns falsy, we short-circuit as
        // an optimization
        return fulfill({updated: false, rev: docRev});
      }

      // users aren't allowed to modify these values,
      // so reset them here
      newDoc._id = docId;
      newDoc._rev = docRev;
      fulfill(tryAndPut(db, newDoc, diffFun));
    });
  });
}

function tryAndPut(db, doc, diffFun) {
  return db.put(doc).then(function (res) {
    return {
      updated: true,
      rev: res.rev
    };
  }, function (err) {
    /* istanbul ignore next */
    if (err.status !== 409) {
      throw err;
    }
    return upsert(db, doc._id, diffFun);
  });
}

function rev(doc, deterministic_revs) {
  var clonedDoc = pouchdbUtils.clone(doc);
  if (!deterministic_revs) {
    return uuidV4.v4().replace(/-/g, '').toLowerCase();
  }

  delete clonedDoc._rev_tree;
  return pouchdbMd5.stringMd5(JSON.stringify(clonedDoc));
}

var uuid = uuidV4.v4;

exports.adapterFun = adapterFun;
exports.assign = assign$1;
exports.bulkGetShim = bulkGet;
exports.changesHandler = Changes;
exports.clone = clone;
exports.defaultBackOff = defaultBackOff;
exports.explainError = explainError;
exports.filterChange = filterChange;
exports.flatten = flatten;
exports.functionName = res$1;
exports.guardedConsole = guardedConsole;
exports.hasLocalStorage = hasLocalStorage;
exports.invalidIdError = invalidIdError;
exports.isRemote = isRemote;
exports.listenerCount = listenerCount;
exports.nextTick = immediate;
exports.normalizeDdocFunctionName = normalizeDesignDocFunctionName;
exports.once = once;
exports.parseDdocFunctionName = parseDesignDocFunctionName;
exports.parseUri = parseUri;
exports.pick = pick;
exports.rev = rev;
exports.scopeEval = scopeEval;
exports.toPromise = toPromise;
exports.upsert = upsert;
exports.uuid = uuid;

},{"11":11,"12":12,"13":13,"16":16,"17":17,"19":19,"22":22,"23":23,"26":26}],23:[function(_dereq_,module,exports){
arguments[4][18][0].apply(exports,arguments)
},{"18":18}],24:[function(_dereq_,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],25:[function(_dereq_,module,exports){
(function (factory) {
    if (typeof exports === 'object') {
        // Node/CommonJS
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        // AMD
        define(factory);
    } else {
        // Browser globals (with support for web workers)
        var glob;

        try {
            glob = window;
        } catch (e) {
            glob = self;
        }

        glob.SparkMD5 = factory();
    }
}(function (undefined) {

    'use strict';

    /*
     * Fastest md5 implementation around (JKM md5).
     * Credits: Joseph Myers
     *
     * @see http://www.myersdaily.org/joseph/javascript/md5-text.html
     * @see http://jsperf.com/md5-shootout/7
     */

    /* this function is much faster,
      so if possible we use it. Some IEs
      are the only ones I know of that
      need the idiotic second function,
      generated by an if clause.  */
    var add32 = function (a, b) {
        return (a + b) & 0xFFFFFFFF;
    },
        hex_chr = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];


    function cmn(q, a, b, x, s, t) {
        a = add32(add32(a, q), add32(x, t));
        return add32((a << s) | (a >>> (32 - s)), b);
    }

    function md5cycle(x, k) {
        var a = x[0],
            b = x[1],
            c = x[2],
            d = x[3];

        a += (b & c | ~b & d) + k[0] - 680876936 | 0;
        a  = (a << 7 | a >>> 25) + b | 0;
        d += (a & b | ~a & c) + k[1] - 389564586 | 0;
        d  = (d << 12 | d >>> 20) + a | 0;
        c += (d & a | ~d & b) + k[2] + 606105819 | 0;
        c  = (c << 17 | c >>> 15) + d | 0;
        b += (c & d | ~c & a) + k[3] - 1044525330 | 0;
        b  = (b << 22 | b >>> 10) + c | 0;
        a += (b & c | ~b & d) + k[4] - 176418897 | 0;
        a  = (a << 7 | a >>> 25) + b | 0;
        d += (a & b | ~a & c) + k[5] + 1200080426 | 0;
        d  = (d << 12 | d >>> 20) + a | 0;
        c += (d & a | ~d & b) + k[6] - 1473231341 | 0;
        c  = (c << 17 | c >>> 15) + d | 0;
        b += (c & d | ~c & a) + k[7] - 45705983 | 0;
        b  = (b << 22 | b >>> 10) + c | 0;
        a += (b & c | ~b & d) + k[8] + 1770035416 | 0;
        a  = (a << 7 | a >>> 25) + b | 0;
        d += (a & b | ~a & c) + k[9] - 1958414417 | 0;
        d  = (d << 12 | d >>> 20) + a | 0;
        c += (d & a | ~d & b) + k[10] - 42063 | 0;
        c  = (c << 17 | c >>> 15) + d | 0;
        b += (c & d | ~c & a) + k[11] - 1990404162 | 0;
        b  = (b << 22 | b >>> 10) + c | 0;
        a += (b & c | ~b & d) + k[12] + 1804603682 | 0;
        a  = (a << 7 | a >>> 25) + b | 0;
        d += (a & b | ~a & c) + k[13] - 40341101 | 0;
        d  = (d << 12 | d >>> 20) + a | 0;
        c += (d & a | ~d & b) + k[14] - 1502002290 | 0;
        c  = (c << 17 | c >>> 15) + d | 0;
        b += (c & d | ~c & a) + k[15] + 1236535329 | 0;
        b  = (b << 22 | b >>> 10) + c | 0;

        a += (b & d | c & ~d) + k[1] - 165796510 | 0;
        a  = (a << 5 | a >>> 27) + b | 0;
        d += (a & c | b & ~c) + k[6] - 1069501632 | 0;
        d  = (d << 9 | d >>> 23) + a | 0;
        c += (d & b | a & ~b) + k[11] + 643717713 | 0;
        c  = (c << 14 | c >>> 18) + d | 0;
        b += (c & a | d & ~a) + k[0] - 373897302 | 0;
        b  = (b << 20 | b >>> 12) + c | 0;
        a += (b & d | c & ~d) + k[5] - 701558691 | 0;
        a  = (a << 5 | a >>> 27) + b | 0;
        d += (a & c | b & ~c) + k[10] + 38016083 | 0;
        d  = (d << 9 | d >>> 23) + a | 0;
        c += (d & b | a & ~b) + k[15] - 660478335 | 0;
        c  = (c << 14 | c >>> 18) + d | 0;
        b += (c & a | d & ~a) + k[4] - 405537848 | 0;
        b  = (b << 20 | b >>> 12) + c | 0;
        a += (b & d | c & ~d) + k[9] + 568446438 | 0;
        a  = (a << 5 | a >>> 27) + b | 0;
        d += (a & c | b & ~c) + k[14] - 1019803690 | 0;
        d  = (d << 9 | d >>> 23) + a | 0;
        c += (d & b | a & ~b) + k[3] - 187363961 | 0;
        c  = (c << 14 | c >>> 18) + d | 0;
        b += (c & a | d & ~a) + k[8] + 1163531501 | 0;
        b  = (b << 20 | b >>> 12) + c | 0;
        a += (b & d | c & ~d) + k[13] - 1444681467 | 0;
        a  = (a << 5 | a >>> 27) + b | 0;
        d += (a & c | b & ~c) + k[2] - 51403784 | 0;
        d  = (d << 9 | d >>> 23) + a | 0;
        c += (d & b | a & ~b) + k[7] + 1735328473 | 0;
        c  = (c << 14 | c >>> 18) + d | 0;
        b += (c & a | d & ~a) + k[12] - 1926607734 | 0;
        b  = (b << 20 | b >>> 12) + c | 0;

        a += (b ^ c ^ d) + k[5] - 378558 | 0;
        a  = (a << 4 | a >>> 28) + b | 0;
        d += (a ^ b ^ c) + k[8] - 2022574463 | 0;
        d  = (d << 11 | d >>> 21) + a | 0;
        c += (d ^ a ^ b) + k[11] + 1839030562 | 0;
        c  = (c << 16 | c >>> 16) + d | 0;
        b += (c ^ d ^ a) + k[14] - 35309556 | 0;
        b  = (b << 23 | b >>> 9) + c | 0;
        a += (b ^ c ^ d) + k[1] - 1530992060 | 0;
        a  = (a << 4 | a >>> 28) + b | 0;
        d += (a ^ b ^ c) + k[4] + 1272893353 | 0;
        d  = (d << 11 | d >>> 21) + a | 0;
        c += (d ^ a ^ b) + k[7] - 155497632 | 0;
        c  = (c << 16 | c >>> 16) + d | 0;
        b += (c ^ d ^ a) + k[10] - 1094730640 | 0;
        b  = (b << 23 | b >>> 9) + c | 0;
        a += (b ^ c ^ d) + k[13] + 681279174 | 0;
        a  = (a << 4 | a >>> 28) + b | 0;
        d += (a ^ b ^ c) + k[0] - 358537222 | 0;
        d  = (d << 11 | d >>> 21) + a | 0;
        c += (d ^ a ^ b) + k[3] - 722521979 | 0;
        c  = (c << 16 | c >>> 16) + d | 0;
        b += (c ^ d ^ a) + k[6] + 76029189 | 0;
        b  = (b << 23 | b >>> 9) + c | 0;
        a += (b ^ c ^ d) + k[9] - 640364487 | 0;
        a  = (a << 4 | a >>> 28) + b | 0;
        d += (a ^ b ^ c) + k[12] - 421815835 | 0;
        d  = (d << 11 | d >>> 21) + a | 0;
        c += (d ^ a ^ b) + k[15] + 530742520 | 0;
        c  = (c << 16 | c >>> 16) + d | 0;
        b += (c ^ d ^ a) + k[2] - 995338651 | 0;
        b  = (b << 23 | b >>> 9) + c | 0;

        a += (c ^ (b | ~d)) + k[0] - 198630844 | 0;
        a  = (a << 6 | a >>> 26) + b | 0;
        d += (b ^ (a | ~c)) + k[7] + 1126891415 | 0;
        d  = (d << 10 | d >>> 22) + a | 0;
        c += (a ^ (d | ~b)) + k[14] - 1416354905 | 0;
        c  = (c << 15 | c >>> 17) + d | 0;
        b += (d ^ (c | ~a)) + k[5] - 57434055 | 0;
        b  = (b << 21 |b >>> 11) + c | 0;
        a += (c ^ (b | ~d)) + k[12] + 1700485571 | 0;
        a  = (a << 6 | a >>> 26) + b | 0;
        d += (b ^ (a | ~c)) + k[3] - 1894986606 | 0;
        d  = (d << 10 | d >>> 22) + a | 0;
        c += (a ^ (d | ~b)) + k[10] - 1051523 | 0;
        c  = (c << 15 | c >>> 17) + d | 0;
        b += (d ^ (c | ~a)) + k[1] - 2054922799 | 0;
        b  = (b << 21 |b >>> 11) + c | 0;
        a += (c ^ (b | ~d)) + k[8] + 1873313359 | 0;
        a  = (a << 6 | a >>> 26) + b | 0;
        d += (b ^ (a | ~c)) + k[15] - 30611744 | 0;
        d  = (d << 10 | d >>> 22) + a | 0;
        c += (a ^ (d | ~b)) + k[6] - 1560198380 | 0;
        c  = (c << 15 | c >>> 17) + d | 0;
        b += (d ^ (c | ~a)) + k[13] + 1309151649 | 0;
        b  = (b << 21 |b >>> 11) + c | 0;
        a += (c ^ (b | ~d)) + k[4] - 145523070 | 0;
        a  = (a << 6 | a >>> 26) + b | 0;
        d += (b ^ (a | ~c)) + k[11] - 1120210379 | 0;
        d  = (d << 10 | d >>> 22) + a | 0;
        c += (a ^ (d | ~b)) + k[2] + 718787259 | 0;
        c  = (c << 15 | c >>> 17) + d | 0;
        b += (d ^ (c | ~a)) + k[9] - 343485551 | 0;
        b  = (b << 21 | b >>> 11) + c | 0;

        x[0] = a + x[0] | 0;
        x[1] = b + x[1] | 0;
        x[2] = c + x[2] | 0;
        x[3] = d + x[3] | 0;
    }

    function md5blk(s) {
        var md5blks = [],
            i; /* Andy King said do it this way. */

        for (i = 0; i < 64; i += 4) {
            md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
        }
        return md5blks;
    }

    function md5blk_array(a) {
        var md5blks = [],
            i; /* Andy King said do it this way. */

        for (i = 0; i < 64; i += 4) {
            md5blks[i >> 2] = a[i] + (a[i + 1] << 8) + (a[i + 2] << 16) + (a[i + 3] << 24);
        }
        return md5blks;
    }

    function md51(s) {
        var n = s.length,
            state = [1732584193, -271733879, -1732584194, 271733878],
            i,
            length,
            tail,
            tmp,
            lo,
            hi;

        for (i = 64; i <= n; i += 64) {
            md5cycle(state, md5blk(s.substring(i - 64, i)));
        }
        s = s.substring(i - 64);
        length = s.length;
        tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (i = 0; i < length; i += 1) {
            tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
        }
        tail[i >> 2] |= 0x80 << ((i % 4) << 3);
        if (i > 55) {
            md5cycle(state, tail);
            for (i = 0; i < 16; i += 1) {
                tail[i] = 0;
            }
        }

        // Beware that the final length might not fit in 32 bits so we take care of that
        tmp = n * 8;
        tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
        lo = parseInt(tmp[2], 16);
        hi = parseInt(tmp[1], 16) || 0;

        tail[14] = lo;
        tail[15] = hi;

        md5cycle(state, tail);
        return state;
    }

    function md51_array(a) {
        var n = a.length,
            state = [1732584193, -271733879, -1732584194, 271733878],
            i,
            length,
            tail,
            tmp,
            lo,
            hi;

        for (i = 64; i <= n; i += 64) {
            md5cycle(state, md5blk_array(a.subarray(i - 64, i)));
        }

        // Not sure if it is a bug, however IE10 will always produce a sub array of length 1
        // containing the last element of the parent array if the sub array specified starts
        // beyond the length of the parent array - weird.
        // https://connect.microsoft.com/IE/feedback/details/771452/typed-array-subarray-issue
        a = (i - 64) < n ? a.subarray(i - 64) : new Uint8Array(0);

        length = a.length;
        tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (i = 0; i < length; i += 1) {
            tail[i >> 2] |= a[i] << ((i % 4) << 3);
        }

        tail[i >> 2] |= 0x80 << ((i % 4) << 3);
        if (i > 55) {
            md5cycle(state, tail);
            for (i = 0; i < 16; i += 1) {
                tail[i] = 0;
            }
        }

        // Beware that the final length might not fit in 32 bits so we take care of that
        tmp = n * 8;
        tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
        lo = parseInt(tmp[2], 16);
        hi = parseInt(tmp[1], 16) || 0;

        tail[14] = lo;
        tail[15] = hi;

        md5cycle(state, tail);

        return state;
    }

    function rhex(n) {
        var s = '',
            j;
        for (j = 0; j < 4; j += 1) {
            s += hex_chr[(n >> (j * 8 + 4)) & 0x0F] + hex_chr[(n >> (j * 8)) & 0x0F];
        }
        return s;
    }

    function hex(x) {
        var i;
        for (i = 0; i < x.length; i += 1) {
            x[i] = rhex(x[i]);
        }
        return x.join('');
    }

    // In some cases the fast add32 function cannot be used..
    if (hex(md51('hello')) !== '5d41402abc4b2a76b9719d911017c592') {
        add32 = function (x, y) {
            var lsw = (x & 0xFFFF) + (y & 0xFFFF),
                msw = (x >> 16) + (y >> 16) + (lsw >> 16);
            return (msw << 16) | (lsw & 0xFFFF);
        };
    }

    // ---------------------------------------------------

    /**
     * ArrayBuffer slice polyfill.
     *
     * @see https://github.com/ttaubert/node-arraybuffer-slice
     */

    if (typeof ArrayBuffer !== 'undefined' && !ArrayBuffer.prototype.slice) {
        (function () {
            function clamp(val, length) {
                val = (val | 0) || 0;

                if (val < 0) {
                    return Math.max(val + length, 0);
                }

                return Math.min(val, length);
            }

            ArrayBuffer.prototype.slice = function (from, to) {
                var length = this.byteLength,
                    begin = clamp(from, length),
                    end = length,
                    num,
                    target,
                    targetArray,
                    sourceArray;

                if (to !== undefined) {
                    end = clamp(to, length);
                }

                if (begin > end) {
                    return new ArrayBuffer(0);
                }

                num = end - begin;
                target = new ArrayBuffer(num);
                targetArray = new Uint8Array(target);

                sourceArray = new Uint8Array(this, begin, num);
                targetArray.set(sourceArray);

                return target;
            };
        })();
    }

    // ---------------------------------------------------

    /**
     * Helpers.
     */

    function toUtf8(str) {
        if (/[\u0080-\uFFFF]/.test(str)) {
            str = unescape(encodeURIComponent(str));
        }

        return str;
    }

    function utf8Str2ArrayBuffer(str, returnUInt8Array) {
        var length = str.length,
           buff = new ArrayBuffer(length),
           arr = new Uint8Array(buff),
           i;

        for (i = 0; i < length; i += 1) {
            arr[i] = str.charCodeAt(i);
        }

        return returnUInt8Array ? arr : buff;
    }

    function arrayBuffer2Utf8Str(buff) {
        return String.fromCharCode.apply(null, new Uint8Array(buff));
    }

    function concatenateArrayBuffers(first, second, returnUInt8Array) {
        var result = new Uint8Array(first.byteLength + second.byteLength);

        result.set(new Uint8Array(first));
        result.set(new Uint8Array(second), first.byteLength);

        return returnUInt8Array ? result : result.buffer;
    }

    function hexToBinaryString(hex) {
        var bytes = [],
            length = hex.length,
            x;

        for (x = 0; x < length - 1; x += 2) {
            bytes.push(parseInt(hex.substr(x, 2), 16));
        }

        return String.fromCharCode.apply(String, bytes);
    }

    // ---------------------------------------------------

    /**
     * SparkMD5 OOP implementation.
     *
     * Use this class to perform an incremental md5, otherwise use the
     * static methods instead.
     */

    function SparkMD5() {
        // call reset to init the instance
        this.reset();
    }

    /**
     * Appends a string.
     * A conversion will be applied if an utf8 string is detected.
     *
     * @param {String} str The string to be appended
     *
     * @return {SparkMD5} The instance itself
     */
    SparkMD5.prototype.append = function (str) {
        // Converts the string to utf8 bytes if necessary
        // Then append as binary
        this.appendBinary(toUtf8(str));

        return this;
    };

    /**
     * Appends a binary string.
     *
     * @param {String} contents The binary string to be appended
     *
     * @return {SparkMD5} The instance itself
     */
    SparkMD5.prototype.appendBinary = function (contents) {
        this._buff += contents;
        this._length += contents.length;

        var length = this._buff.length,
            i;

        for (i = 64; i <= length; i += 64) {
            md5cycle(this._hash, md5blk(this._buff.substring(i - 64, i)));
        }

        this._buff = this._buff.substring(i - 64);

        return this;
    };

    /**
     * Finishes the incremental computation, reseting the internal state and
     * returning the result.
     *
     * @param {Boolean} raw True to get the raw string, false to get the hex string
     *
     * @return {String} The result
     */
    SparkMD5.prototype.end = function (raw) {
        var buff = this._buff,
            length = buff.length,
            i,
            tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            ret;

        for (i = 0; i < length; i += 1) {
            tail[i >> 2] |= buff.charCodeAt(i) << ((i % 4) << 3);
        }

        this._finish(tail, length);
        ret = hex(this._hash);

        if (raw) {
            ret = hexToBinaryString(ret);
        }

        this.reset();

        return ret;
    };

    /**
     * Resets the internal state of the computation.
     *
     * @return {SparkMD5} The instance itself
     */
    SparkMD5.prototype.reset = function () {
        this._buff = '';
        this._length = 0;
        this._hash = [1732584193, -271733879, -1732584194, 271733878];

        return this;
    };

    /**
     * Gets the internal state of the computation.
     *
     * @return {Object} The state
     */
    SparkMD5.prototype.getState = function () {
        return {
            buff: this._buff,
            length: this._length,
            hash: this._hash
        };
    };

    /**
     * Gets the internal state of the computation.
     *
     * @param {Object} state The state
     *
     * @return {SparkMD5} The instance itself
     */
    SparkMD5.prototype.setState = function (state) {
        this._buff = state.buff;
        this._length = state.length;
        this._hash = state.hash;

        return this;
    };

    /**
     * Releases memory used by the incremental buffer and other additional
     * resources. If you plan to use the instance again, use reset instead.
     */
    SparkMD5.prototype.destroy = function () {
        delete this._hash;
        delete this._buff;
        delete this._length;
    };

    /**
     * Finish the final calculation based on the tail.
     *
     * @param {Array}  tail   The tail (will be modified)
     * @param {Number} length The length of the remaining buffer
     */
    SparkMD5.prototype._finish = function (tail, length) {
        var i = length,
            tmp,
            lo,
            hi;

        tail[i >> 2] |= 0x80 << ((i % 4) << 3);
        if (i > 55) {
            md5cycle(this._hash, tail);
            for (i = 0; i < 16; i += 1) {
                tail[i] = 0;
            }
        }

        // Do the final computation based on the tail and length
        // Beware that the final length may not fit in 32 bits so we take care of that
        tmp = this._length * 8;
        tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
        lo = parseInt(tmp[2], 16);
        hi = parseInt(tmp[1], 16) || 0;

        tail[14] = lo;
        tail[15] = hi;
        md5cycle(this._hash, tail);
    };

    /**
     * Performs the md5 hash on a string.
     * A conversion will be applied if utf8 string is detected.
     *
     * @param {String}  str The string
     * @param {Boolean} raw True to get the raw string, false to get the hex string
     *
     * @return {String} The result
     */
    SparkMD5.hash = function (str, raw) {
        // Converts the string to utf8 bytes if necessary
        // Then compute it using the binary function
        return SparkMD5.hashBinary(toUtf8(str), raw);
    };

    /**
     * Performs the md5 hash on a binary string.
     *
     * @param {String}  content The binary string
     * @param {Boolean} raw     True to get the raw string, false to get the hex string
     *
     * @return {String} The result
     */
    SparkMD5.hashBinary = function (content, raw) {
        var hash = md51(content),
            ret = hex(hash);

        return raw ? hexToBinaryString(ret) : ret;
    };

    // ---------------------------------------------------

    /**
     * SparkMD5 OOP implementation for array buffers.
     *
     * Use this class to perform an incremental md5 ONLY for array buffers.
     */
    SparkMD5.ArrayBuffer = function () {
        // call reset to init the instance
        this.reset();
    };

    /**
     * Appends an array buffer.
     *
     * @param {ArrayBuffer} arr The array to be appended
     *
     * @return {SparkMD5.ArrayBuffer} The instance itself
     */
    SparkMD5.ArrayBuffer.prototype.append = function (arr) {
        var buff = concatenateArrayBuffers(this._buff.buffer, arr, true),
            length = buff.length,
            i;

        this._length += arr.byteLength;

        for (i = 64; i <= length; i += 64) {
            md5cycle(this._hash, md5blk_array(buff.subarray(i - 64, i)));
        }

        this._buff = (i - 64) < length ? new Uint8Array(buff.buffer.slice(i - 64)) : new Uint8Array(0);

        return this;
    };

    /**
     * Finishes the incremental computation, reseting the internal state and
     * returning the result.
     *
     * @param {Boolean} raw True to get the raw string, false to get the hex string
     *
     * @return {String} The result
     */
    SparkMD5.ArrayBuffer.prototype.end = function (raw) {
        var buff = this._buff,
            length = buff.length,
            tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            i,
            ret;

        for (i = 0; i < length; i += 1) {
            tail[i >> 2] |= buff[i] << ((i % 4) << 3);
        }

        this._finish(tail, length);
        ret = hex(this._hash);

        if (raw) {
            ret = hexToBinaryString(ret);
        }

        this.reset();

        return ret;
    };

    /**
     * Resets the internal state of the computation.
     *
     * @return {SparkMD5.ArrayBuffer} The instance itself
     */
    SparkMD5.ArrayBuffer.prototype.reset = function () {
        this._buff = new Uint8Array(0);
        this._length = 0;
        this._hash = [1732584193, -271733879, -1732584194, 271733878];

        return this;
    };

    /**
     * Gets the internal state of the computation.
     *
     * @return {Object} The state
     */
    SparkMD5.ArrayBuffer.prototype.getState = function () {
        var state = SparkMD5.prototype.getState.call(this);

        // Convert buffer to a string
        state.buff = arrayBuffer2Utf8Str(state.buff);

        return state;
    };

    /**
     * Gets the internal state of the computation.
     *
     * @param {Object} state The state
     *
     * @return {SparkMD5.ArrayBuffer} The instance itself
     */
    SparkMD5.ArrayBuffer.prototype.setState = function (state) {
        // Convert string to buffer
        state.buff = utf8Str2ArrayBuffer(state.buff, true);

        return SparkMD5.prototype.setState.call(this, state);
    };

    SparkMD5.ArrayBuffer.prototype.destroy = SparkMD5.prototype.destroy;

    SparkMD5.ArrayBuffer.prototype._finish = SparkMD5.prototype._finish;

    /**
     * Performs the md5 hash on an array buffer.
     *
     * @param {ArrayBuffer} arr The array buffer
     * @param {Boolean}     raw True to get the raw string, false to get the hex one
     *
     * @return {String} The result
     */
    SparkMD5.ArrayBuffer.hash = function (arr, raw) {
        var hash = md51_array(new Uint8Array(arr)),
            ret = hex(hash);

        return raw ? hexToBinaryString(ret) : ret;
    };

    return SparkMD5;
}));

},{}],26:[function(_dereq_,module,exports){
var v1 = _dereq_(29);
var v4 = _dereq_(30);

var uuid = v4;
uuid.v1 = v1;
uuid.v4 = v4;

module.exports = uuid;

},{"29":29,"30":30}],27:[function(_dereq_,module,exports){
/**
 * Convert array of 16 byte values to UUID string format of the form:
 * XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
 */
var byteToHex = [];
for (var i = 0; i < 256; ++i) {
  byteToHex[i] = (i + 0x100).toString(16).substr(1);
}

function bytesToUuid(buf, offset) {
  var i = offset || 0;
  var bth = byteToHex;
  return bth[buf[i++]] + bth[buf[i++]] +
          bth[buf[i++]] + bth[buf[i++]] + '-' +
          bth[buf[i++]] + bth[buf[i++]] + '-' +
          bth[buf[i++]] + bth[buf[i++]] + '-' +
          bth[buf[i++]] + bth[buf[i++]] + '-' +
          bth[buf[i++]] + bth[buf[i++]] +
          bth[buf[i++]] + bth[buf[i++]] +
          bth[buf[i++]] + bth[buf[i++]];
}

module.exports = bytesToUuid;

},{}],28:[function(_dereq_,module,exports){
// Unique ID creation requires a high quality random # generator.  In the
// browser this is a little complicated due to unknown quality of Math.random()
// and inconsistent support for the `crypto` API.  We do the best we can via
// feature-detection

// getRandomValues needs to be invoked in a context where "this" is a Crypto implementation.
var getRandomValues = (typeof(crypto) != 'undefined' && crypto.getRandomValues.bind(crypto)) ||
                      (typeof(msCrypto) != 'undefined' && msCrypto.getRandomValues.bind(msCrypto));
if (getRandomValues) {
  // WHATWG crypto RNG - http://wiki.whatwg.org/wiki/Crypto
  var rnds8 = new Uint8Array(16); // eslint-disable-line no-undef

  module.exports = function whatwgRNG() {
    getRandomValues(rnds8);
    return rnds8;
  };
} else {
  // Math.random()-based (RNG)
  //
  // If all else fails, use Math.random().  It's fast, but is of unspecified
  // quality.
  var rnds = new Array(16);

  module.exports = function mathRNG() {
    for (var i = 0, r; i < 16; i++) {
      if ((i & 0x03) === 0) r = Math.random() * 0x100000000;
      rnds[i] = r >>> ((i & 0x03) << 3) & 0xff;
    }

    return rnds;
  };
}

},{}],29:[function(_dereq_,module,exports){
var rng = _dereq_(28);
var bytesToUuid = _dereq_(27);

// **`v1()` - Generate time-based UUID**
//
// Inspired by https://github.com/LiosK/UUID.js
// and http://docs.python.org/library/uuid.html

var _nodeId;
var _clockseq;

// Previous uuid creation time
var _lastMSecs = 0;
var _lastNSecs = 0;

// See https://github.com/broofa/node-uuid for API details
function v1(options, buf, offset) {
  var i = buf && offset || 0;
  var b = buf || [];

  options = options || {};
  var node = options.node || _nodeId;
  var clockseq = options.clockseq !== undefined ? options.clockseq : _clockseq;

  // node and clockseq need to be initialized to random values if they're not
  // specified.  We do this lazily to minimize issues related to insufficient
  // system entropy.  See #189
  if (node == null || clockseq == null) {
    var seedBytes = rng();
    if (node == null) {
      // Per 4.5, create and 48-bit node id, (47 random bits + multicast bit = 1)
      node = _nodeId = [
        seedBytes[0] | 0x01,
        seedBytes[1], seedBytes[2], seedBytes[3], seedBytes[4], seedBytes[5]
      ];
    }
    if (clockseq == null) {
      // Per 4.2.2, randomize (14 bit) clockseq
      clockseq = _clockseq = (seedBytes[6] << 8 | seedBytes[7]) & 0x3fff;
    }
  }

  // UUID timestamps are 100 nano-second units since the Gregorian epoch,
  // (1582-10-15 00:00).  JSNumbers aren't precise enough for this, so
  // time is handled internally as 'msecs' (integer milliseconds) and 'nsecs'
  // (100-nanoseconds offset from msecs) since unix epoch, 1970-01-01 00:00.
  var msecs = options.msecs !== undefined ? options.msecs : new Date().getTime();

  // Per 4.2.1.2, use count of uuid's generated during the current clock
  // cycle to simulate higher resolution clock
  var nsecs = options.nsecs !== undefined ? options.nsecs : _lastNSecs + 1;

  // Time since last uuid creation (in msecs)
  var dt = (msecs - _lastMSecs) + (nsecs - _lastNSecs)/10000;

  // Per 4.2.1.2, Bump clockseq on clock regression
  if (dt < 0 && options.clockseq === undefined) {
    clockseq = clockseq + 1 & 0x3fff;
  }

  // Reset nsecs if clock regresses (new clockseq) or we've moved onto a new
  // time interval
  if ((dt < 0 || msecs > _lastMSecs) && options.nsecs === undefined) {
    nsecs = 0;
  }

  // Per 4.2.1.2 Throw error if too many uuids are requested
  if (nsecs >= 10000) {
    throw new Error('uuid.v1(): Can\'t create more than 10M uuids/sec');
  }

  _lastMSecs = msecs;
  _lastNSecs = nsecs;
  _clockseq = clockseq;

  // Per 4.1.4 - Convert from unix epoch to Gregorian epoch
  msecs += 12219292800000;

  // `time_low`
  var tl = ((msecs & 0xfffffff) * 10000 + nsecs) % 0x100000000;
  b[i++] = tl >>> 24 & 0xff;
  b[i++] = tl >>> 16 & 0xff;
  b[i++] = tl >>> 8 & 0xff;
  b[i++] = tl & 0xff;

  // `time_mid`
  var tmh = (msecs / 0x100000000 * 10000) & 0xfffffff;
  b[i++] = tmh >>> 8 & 0xff;
  b[i++] = tmh & 0xff;

  // `time_high_and_version`
  b[i++] = tmh >>> 24 & 0xf | 0x10; // include version
  b[i++] = tmh >>> 16 & 0xff;

  // `clock_seq_hi_and_reserved` (Per 4.2.2 - include variant)
  b[i++] = clockseq >>> 8 | 0x80;

  // `clock_seq_low`
  b[i++] = clockseq & 0xff;

  // `node`
  for (var n = 0; n < 6; ++n) {
    b[i + n] = node[n];
  }

  return buf ? buf : bytesToUuid(b);
}

module.exports = v1;

},{"27":27,"28":28}],30:[function(_dereq_,module,exports){
var rng = _dereq_(28);
var bytesToUuid = _dereq_(27);

function v4(options, buf, offset) {
  var i = buf && offset || 0;

  if (typeof(options) == 'string') {
    buf = options === 'binary' ? new Array(16) : null;
    options = null;
  }
  options = options || {};

  var rnds = options.random || (options.rng || rng)();

  // Per 4.4, set bits for version and `clock_seq_hi_and_reserved`
  rnds[6] = (rnds[6] & 0x0f) | 0x40;
  rnds[8] = (rnds[8] & 0x3f) | 0x80;

  // Copy bytes to buffer, if provided
  if (buf) {
    for (var ii = 0; ii < 16; ++ii) {
      buf[i + ii] = rnds[ii];
    }
  }

  return buf || bytesToUuid(rnds);
}

module.exports = v4;

},{"27":27,"28":28}]},{},[3])(3)
});
