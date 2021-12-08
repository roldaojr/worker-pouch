(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.workerPouch = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(_dereq_,module,exports){
'use strict';

const getArguments = _dereq_(11)
const utils = _dereq_(20)
const merge = _dereq_(19)
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

},{"11":11,"12":12,"14":14,"19":19,"20":20}],2:[function(_dereq_,module,exports){
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
(function (global){(function (){
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

}).call(this)}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"10":10,"2":2,"4":4}],4:[function(_dereq_,module,exports){
(function (global){(function (){
'use strict';

module.exports = function isSupportedBrowser () {
  return Promise.resolve().then(() => {
    let self = {}
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

}).call(this)}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
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
(function (process,global){(function (){
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

}).call(this)}).call(this,_dereq_(28),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"14":14,"15":15,"28":28,"7":7}],9:[function(_dereq_,module,exports){
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
module.exports = "!function r(o,i,a){function s(t,e){if(!i[t]){if(!o[t]){var n=\"function\"==typeof require&&require;if(!e&&n)return n(t,!0);if(u)return u(t,!0);throw(n=new Error(\"Cannot find module '\"+t+\"'\")).code=\"MODULE_NOT_FOUND\",n}n=i[t]={exports:{}},o[t][0].call(n.exports,function(e){return s(o[t][1][e]||e)},n,n.exports,r,o,i,a)}return i[t].exports}for(var u=\"function\"==typeof require&&require,e=0;e<a.length;e++)s(a[e]);return s}({1:[function(e,t,s){\"use strict\";const n=e(9);function o(e){Error.call(e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}n(o,Error),o.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message})},s.UNAUTHORIZED=new o({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),s.MISSING_BULK_DOCS=new o({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),s.MISSING_DOC=new o({status:404,error:\"not_found\",reason:\"missing\"}),s.REV_CONFLICT=new o({status:409,error:\"conflict\",reason:\"Document update conflict\"}),s.INVALID_ID=new o({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),s.MISSING_ID=new o({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),s.RESERVED_ID=new o({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),s.NOT_OPEN=new o({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),s.UNKNOWN_ERROR=new o({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),s.BAD_ARG=new o({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),s.INVALID_REQUEST=new o({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),s.QUERY_PARSE_ERROR=new o({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),s.DOC_VALIDATION=new o({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),s.BAD_REQUEST=new o({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),s.NOT_AN_OBJECT=new o({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),s.DB_MISSING=new o({status:404,error:\"not_found\",reason:\"Database not found\"}),s.IDB_ERROR=new o({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),s.WSQ_ERROR=new o({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),s.LDB_ERROR=new o({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),s.FORBIDDEN=new o({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),s.INVALID_REV=new o({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),s.FILE_EXISTS=new o({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),s.MISSING_STUB=new o({status:412,error:\"missing_stub\"}),s.error=function(n,e,r){function t(e){for(const t in n)\"function\"!=typeof n[t]&&(this[t]=n[t]);void 0!==r&&(this.name=r),void 0!==e&&(this.reason=e)}return t.prototype=o.prototype,new t(e)},s.getErrorTypeByProp=function(t,n,r){const o=s,e=Object.keys(o).filter(e=>{e=o[e];return\"function\"!=typeof e&&e[t]===n});var i=r&&e.filter(e=>{return o[e].message===r})[0]||e[0];return i?o[i]:null},s.generateErrorFromResponse=function(e){let t;var n;let r,o,i;const a=s;return n=!0===e.error&&\"string\"==typeof e.name?e.name:e.error,i=e.reason,r=a.getErrorTypeByProp(\"name\",n,i),e.missing||\"missing\"===i||\"deleted\"===i||\"not_found\"===n?r=a.MISSING_DOC:\"doc_validation\"===n?(r=a.DOC_VALIDATION,o=i):\"bad_request\"===n&&r.message!==i&&(0===i.indexOf(\"unknown stub attachment\")?(r=a.MISSING_STUB,o=i):r=a.BAD_REQUEST),r=r||(a.getErrorTypeByProp(\"status\",e.status,i)||a.UNKNOWN_ERROR),t=a.error(r,i,n),o&&(t.message=o),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.statusText&&(t.name=e.statusText),e.missing&&(t.missing=e.missing),t}},{9:9}],2:[function(e,t,n){\"use strict\";const h=e(1),o=e(5),v=(console.debug.bind(console),o[\"decodeArgs\"]),y={},_={};t.exports=function(n,a){function s(e,t){(\"function\"!=typeof n.postMessage?t.ports[0]:n).postMessage(e)}function u(e,t,n){s({type:\"uncaughtError\",id:e,content:o.createError(t)},n)}function c(e,t,n,r){s({type:\"error\",id:e,messageId:t,content:o.createError(n)},r)}function f(e,t,n,r){s({type:\"success\",id:e,messageId:t,content:n},r)}function i(t,e,n,r,o){const i=y[\"$\"+t];if(!i)return c(t,n,{error:\"db not found\"},o);Promise.resolve().then(()=>i[e].apply(i,r)).then(e=>{f(t,n,e,o)}).catch(e=>{c(t,n,e,o)})}function l(n,r,e,o){const i=y[\"$\"+n];if(!i)return c(n,r,{error:\"db not found\"},o);Promise.resolve().then(()=>{const t=i.changes(e[0]);_[r]=t,t.on(\"change\",e=>{s({type:\"update\",id:n,messageId:r,content:e},o)}).on(\"complete\",e=>{t.removeAllListeners(),delete _[r],f(n,r,e,o)}).on(\"error\",e=>{t.removeAllListeners(),delete _[r],c(n,r,e,o)})})}function d(e,t,n){return Promise.resolve().then(()=>{e.on(\"error\",e=>{u(t,e,n)})})}function p(e,t,n,r,o){switch(0,t){case\"createDatabase\":return function(t,n,r,o){var e=\"$\"+t;let i=y[e];return i?d(i,t,o).then(()=>f(t,n,{ok:!0,exists:!0},o)):(\"string\"==typeof r[0]?r[0]:r[0].name)?(i=y[e]=(()=>{let e={adapter:\"indexeddb\",revs_limit:1};return Object(r[0])===r[0]?e=Object.assign({},r[0],e):e.name=r[0],a(e)})(),void d(i,t,o).then(()=>{f(t,n,{ok:!0},o)}).catch(e=>{c(t,n,e,o)})):c(t,n,{error:\"you must provide a database name\"},o)}(e,n,r,o);case\"id\":case\"info\":case\"put\":case\"allDocs\":case\"bulkDocs\":case\"post\":case\"get\":case\"remove\":case\"revsDiff\":case\"compact\":case\"viewCleanup\":case\"removeAttachment\":case\"putAttachment\":case\"query\":return i(e,t,n,r,o),0;case\"changes\":return function(e,t,n,r){const o=n[0];o&&\"object\"==typeof o&&(o.returnDocs=!0,o.return_docs=!0),i(e,\"changes\",t,n,r)}(e,n,r,o),0;case\"getAttachment\":return function(r,o,i,a){const s=y[\"$\"+r];if(!s)return c(r,o,{error:\"db not found\"},a);Promise.resolve().then(()=>{var e=i[0];const t=i[1];let n=i[2];return\"object\"!=typeof n&&(n={}),s.get(e,n).then(e=>{if(!e._attachments||!e._attachments[t])throw h.MISSING_DOC;return s.getAttachment.apply(s,i).then(e=>{f(r,o,e,a)})})}).catch(e=>{c(r,o,e,a)})}(e,n,r,o),0;case\"liveChanges\":return l(e,n,r,o),0;case\"cancelChanges\":return function(e){const t=_[e];t&&t.cancel()}(n),0;case\"destroy\":return function(t,n,e,r){var o=\"$\"+t;const i=y[o];if(!i)return c(t,n,{error:\"db not found\"},r);delete y[o],Promise.resolve().then(()=>i.destroy.apply(i,e)).then(e=>{f(t,n,e,r)}).catch(e=>{c(t,n,e,r)})}(e,n,r,o),0;default:return c(e,n,{error:\"unknown API method: \"+t},o),0}}n.addEventListener(\"message\",t=>{if(t.data&&t.data.id&&t.data.args&&t.data.type&&t.data.messageId){var e,n,r,o,i=t.data.id;if(\"close\"===t.data.type)delete y[\"$\"+i];else try{e=t.data,n=t,r=e.type,o=e.messageId,p(i,r,o,v(e.args),n)}catch(e){u(i,e,t)}}})}},{1:1,5:5}],3:[function(e,t,n){\"use strict\";const r=e(2);e=e(74).plugin(e(10));r(self,e)},{10:10,2:2,74:74}],4:[function(_dereq_,module,exports){\"use strict\";module.exports=function safeEval(str){const target={};return eval(`target.target = (${str});`),target.target}},{}],5:[function(e,t,n){\"use strict\";const r=e(4);n.createError=function(e){var t=e.status||500;return e.name&&e.message&&(\"Error\"!==e.name&&\"TypeError\"!==e.name||(-1!==e.message.indexOf(\"Bad special document member\")?e.name=\"doc_validation\":e.name=\"bad_request\"),e={error:e.name,name:e.name,reason:e.message,message:e.message,status:t}),e},n.decodeArgs=function(e){const n=[\"filter\",\"map\",\"reduce\"];return e.forEach(t=>{\"object\"!=typeof t||null===t||Array.isArray(t)||n.forEach(e=>{e in t&&null!==t[e]?\"func\"===t[e].type&&t[e].func&&(t[e]=r(t[e].func)):delete t[e]})}),e}},{4:4}],6:[function(e,t,n){\"use strict\";t.exports=function(r){return function(){var e=arguments.length;if(e){for(var t=[],n=-1;++n<e;)t[n]=arguments[n];return r.call(this,t)}return r.call(this,[])}}},{}],7:[function(e,t,n){},{}],8:[function(e,t,n){var s=Object.create||function(e){function t(){}return t.prototype=e,new t},a=Object.keys||function(e){var t,n=[];for(t in e)Object.prototype.hasOwnProperty.call(e,t)&&n.push(t);return t},r=Function.prototype.bind||function(e){var t=this;return function(){return t.apply(e,arguments)}};function o(){this._events&&Object.prototype.hasOwnProperty.call(this,\"_events\")||(this._events=s(null),this._eventsCount=0),this._maxListeners=this._maxListeners||void 0}((t.exports=o).EventEmitter=o).prototype._events=void 0,o.prototype._maxListeners=void 0;var i,u=10;try{var c={};Object.defineProperty&&Object.defineProperty(c,\"x\",{value:0}),i=0===c.x}catch(e){i=!1}function f(e){return void 0===e._maxListeners?o.defaultMaxListeners:e._maxListeners}function l(e,t,n,r){var o,i;if(\"function\"!=typeof n)throw new TypeError('\"listener\" argument must be a function');return(o=e._events)?(o.newListener&&(e.emit(\"newListener\",t,n.listener||n),o=e._events),i=o[t]):(o=e._events=s(null),e._eventsCount=0),i?(\"function\"==typeof i?i=o[t]=r?[n,i]:[i,n]:r?i.unshift(n):i.push(n),i.warned||(r=f(e))&&0<r&&i.length>r&&(i.warned=!0,(r=new Error(\"Possible EventEmitter memory leak detected. \"+i.length+' \"'+String(t)+'\" listeners added. Use emitter.setMaxListeners() to increase limit.')).name=\"MaxListenersExceededWarning\",r.emitter=e,r.type=t,r.count=i.length,\"object\"==typeof console&&console.warn&&console.warn(\"%s: %s\",r.name,r.message))):(i=o[t]=n,++e._eventsCount),e}function d(){if(!this.fired)switch(this.target.removeListener(this.type,this.wrapFn),this.fired=!0,arguments.length){case 0:return this.listener.call(this.target);case 1:return this.listener.call(this.target,arguments[0]);case 2:return this.listener.call(this.target,arguments[0],arguments[1]);case 3:return this.listener.call(this.target,arguments[0],arguments[1],arguments[2]);default:for(var e=new Array(arguments.length),t=0;t<e.length;++t)e[t]=arguments[t];this.listener.apply(this.target,e)}}function p(e,t,n){e={fired:!1,wrapFn:void 0,target:e,type:t,listener:n},t=r.call(d,e);return t.listener=n,e.wrapFn=t}function h(e,t,n){e=e._events;if(!e)return[];t=e[t];return t?\"function\"==typeof t?n?[t.listener||t]:[t]:n?function(e){for(var t=new Array(e.length),n=0;n<t.length;++n)t[n]=e[n].listener||e[n];return t}(t):y(t,t.length):[]}function v(e){var t=this._events;if(t){e=t[e];if(\"function\"==typeof e)return 1;if(e)return e.length}return 0}function y(e,t){for(var n=new Array(t),r=0;r<t;++r)n[r]=e[r];return n}i?Object.defineProperty(o,\"defaultMaxListeners\",{enumerable:!0,get:function(){return u},set:function(e){if(\"number\"!=typeof e||e<0||e!=e)throw new TypeError('\"defaultMaxListeners\" must be a positive number');u=e}}):o.defaultMaxListeners=u,o.prototype.setMaxListeners=function(e){if(\"number\"!=typeof e||e<0||isNaN(e))throw new TypeError('\"n\" argument must be a positive number');return this._maxListeners=e,this},o.prototype.getMaxListeners=function(){return f(this)},o.prototype.emit=function(e){var t,n,r,o,i=\"error\"===e,a=this._events;if(a)i=i&&null==a.error;else if(!i)return!1;if(i){if((t=1<arguments.length?arguments[1]:t)instanceof Error)throw t;i=new Error('Unhandled \"error\" event. ('+t+\")\");throw i.context=t,i}if(!(n=a[e]))return!1;var s,u=\"function\"==typeof n;switch(s=arguments.length){case 1:!function(e,t,n){if(t)e.call(n);else for(var r=e.length,o=y(e,r),i=0;i<r;++i)o[i].call(n)}(n,u,this);break;case 2:!function(e,t,n,r){if(t)e.call(n,r);else for(var o=e.length,i=y(e,o),a=0;a<o;++a)i[a].call(n,r)}(n,u,this,arguments[1]);break;case 3:!function(e,t,n,r,o){if(t)e.call(n,r,o);else for(var i=e.length,a=y(e,i),s=0;s<i;++s)a[s].call(n,r,o)}(n,u,this,arguments[1],arguments[2]);break;case 4:!function(e,t,n,r,o,i){if(t)e.call(n,r,o,i);else for(var a=e.length,s=y(e,a),u=0;u<a;++u)s[u].call(n,r,o,i)}(n,u,this,arguments[1],arguments[2],arguments[3]);break;default:for(r=new Array(s-1),o=1;o<s;o++)r[o-1]=arguments[o];!function(e,t,n,r){if(t)e.apply(n,r);else for(var o=e.length,i=y(e,o),a=0;a<o;++a)i[a].apply(n,r)}(n,u,this,r)}return!0},o.prototype.on=o.prototype.addListener=function(e,t){return l(this,e,t,!1)},o.prototype.prependListener=function(e,t){return l(this,e,t,!0)},o.prototype.once=function(e,t){if(\"function\"!=typeof t)throw new TypeError('\"listener\" argument must be a function');return this.on(e,p(this,e,t)),this},o.prototype.prependOnceListener=function(e,t){if(\"function\"!=typeof t)throw new TypeError('\"listener\" argument must be a function');return this.prependListener(e,p(this,e,t)),this},o.prototype.removeListener=function(e,t){var n,r,o,i,a;if(\"function\"!=typeof t)throw new TypeError('\"listener\" argument must be a function');if(!(r=this._events))return this;if(!(n=r[e]))return this;if(n===t||n.listener===t)0==--this._eventsCount?this._events=s(null):(delete r[e],r.removeListener&&this.emit(\"removeListener\",e,n.listener||t));else if(\"function\"!=typeof n){for(o=-1,i=n.length-1;0<=i;i--)if(n[i]===t||n[i].listener===t){a=n[i].listener,o=i;break}if(o<0)return this;0===o?n.shift():function(e,t){for(var n=t,r=n+1,o=e.length;r<o;n+=1,r+=1)e[n]=e[r];e.pop()}(n,o),1===n.length&&(r[e]=n[0]),r.removeListener&&this.emit(\"removeListener\",e,a||t)}return this},o.prototype.removeAllListeners=function(e){var t,n=this._events;if(!n)return this;if(!n.removeListener)return 0===arguments.length?(this._events=s(null),this._eventsCount=0):n[e]&&(0==--this._eventsCount?this._events=s(null):delete n[e]),this;if(0===arguments.length){for(var r,o=a(n),i=0;i<o.length;++i)\"removeListener\"!==(r=o[i])&&this.removeAllListeners(r);return this.removeAllListeners(\"removeListener\"),this._events=s(null),this._eventsCount=0,this}if(\"function\"==typeof(t=n[e]))this.removeListener(e,t);else if(t)for(i=t.length-1;0<=i;i--)this.removeListener(e,t[i]);return this},o.prototype.listeners=function(e){return h(this,e,!0)},o.prototype.rawListeners=function(e){return h(this,e,!1)},o.listenerCount=function(e,t){return\"function\"==typeof e.listenerCount?e.listenerCount(t):v.call(e,t)},o.prototype.listenerCount=v,o.prototype.eventNames=function(){return 0<this._eventsCount?Reflect.ownKeys(this._events):[]}},{}],9:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){t&&(e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}}))}:t.exports=function(e,t){var n;t&&(e.super_=t,(n=function(){}).prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e)}},{}],10:[function(e,t,n){\"use strict\";var A=e(52),O=e(31),I=e(18),h=e(19),k=e(96),D=e(97),S=Number.MIN_SAFE_INTEGER,R=Number.MIN_SAFE_INTEGER+1,j=Number.MIN_SAFE_INTEGER+2,r=/[^a-zA-Z0-9_$]+|(^[^a-zA-Z_$])/g,i=/(\\\\.)|[^a-zA-Z0-9_$.]+|(^[^a-zA-Z_$])/g,a=\"\\\\\".charCodeAt(0),o=/[^a-zA-Z0-9_$]+|(^[^a-zA-Z_$])/,s=/(\\\\.)|[^a-zA-Z0-9_$.]+|(^[^a-zA-Z_$])/;function x(e,o){function t(e){for(var t=\"\",n=0;n<e.length;n++){var r=e.charCodeAt(n);r===a&&o||(t+=\"_c\"+r+\"_\")}return t}return o?e.replace(i,t):e.replace(r,t)}function C(e){for(var t of Object.keys(e)){if(n=t,(void 0?s:o).test(n))return!0;if(null===e[t]||\"boolean\"==typeof e[t])return!0;if(\"object\"==typeof e[t])return C(e[t])}var n}var B=\"docs\",N=\"meta\";function L(n){return function(e){var t=\"unknown_error\";e.target&&e.target.error&&(t=e.target.error.name||e.target.error.message),n(k.createError(k.IDB_ERROR,t,e.type))}}function w(n,r,o,e){return delete o._attachments[n].stub,e?(o._attachments[n].data=r.attachments[o._attachments[n].digest].data,Promise.resolve()):new Promise(function(t){var e=r.attachments[o._attachments[n].digest].data;A.readAsBinaryString(e,function(e){o._attachments[n].data=A.btoa(e),delete o._attachments[n].length,t()})})}function c(e,t){return(e.views[t].options&&e.views[t].options.def&&e.views[t].options.def.fields||[]).map(function(e){return\"string\"==typeof e?e:Object.keys(e)[0]})}function f(e){return\"_find_idx/\"+e.join(\"/\")}var u=Math.pow(10,13);function l(e,i){var a=e.transaction.objectStore(B);a.getAll(IDBKeyRange.bound(\"_design/\",\"_design/￿\")).onsuccess=function(e){var e=e.target.result,t=Array.from(a.indexNames),n=e.filter(function(e){return 0===e.deleted&&e.revs[e.rev].data.views}).map(function(e){return e.revs[e.rev].data}).reduce(function(e,n){return Object.keys(n.views).reduce(function(e,t){t=c(n,t);return t&&0<t.length&&(e[f(t)]=[\"deleted\"].concat(t.map(function(e){return e in[\"_id\",\"_rev\",\"_deleted\",\"_attachments\"]?e.substr(1):\"data.\"+x(e,!0)}))),e},e)},{}),r=Object.keys(n),o=[\"seq\"];t.forEach(function(e){-1===o.indexOf(e)&&-1===r.indexOf(e)&&a.deleteIndex(e)});e=r.filter(function(e){return-1===t.indexOf(e)});try{e.forEach(function(e){a.createIndex(e,n[e])})}catch(e){i(e)}}}function d(o,e,i,a,n){var r=i.versionchanged?indexedDB.open(i.name):indexedDB.open(i.name,+u+(new Date).getTime());r.onupgradeneeded=function(e){if(0<e.oldVersion&&e.oldVersion<u)throw new Error('Incorrect adapter: you should specify the \"idb\" adapter to open this DB');var t=e.target.result,e=(e=e.oldVersion,Math.floor(e/u));t=t,e<1&&(t.createObjectStore(B,{keyPath:\"id\"}).createIndex(\"seq\",\"seq\",{unique:!0}),t.createObjectStore(N,{keyPath:\"id\"})),l(r,n)},r.onblocked=function(e){console.error(\"onblocked, this should never happen\",e)},r.onsuccess=function(e){var t=e.target.result;t.onabort=function(e){console.error(\"Database has a global failure\",e.target.error),delete o[i.name],t.close()},t.onversionchange=function(){console.log(\"Database was made stale, closing handle\"),o[i.name].versionchanged=!0,t.close()};var n={id:N},e=t.transaction([N],\"readwrite\");e.oncomplete=function(){a({idb:t,metadata:n})};var r=e.objectStore(N);r.get(N).onsuccess=function(e){var t=!1;\"doc_count\"in(n=e.target.result||n)||(t=!0,n.doc_count=0),\"seq\"in n||(t=!0,n.seq=0),\"db_uuid\"in n||(t=!0,n.db_uuid=h.uuid()),t&&r.put(n)}},r.onerror=function(e){n(e.target.error)}}function p(n,e,r){return n[r.name]&&!n[r.name].versionchanged||(r.versionchanged=n[r.name]&&n[r.name].versionchanged,n[r.name]=new Promise(function(e,t){d(n,0,r,e,t)})),n[r.name]}function v(r,e,o,i){if(r.error)return i(r.error);r.txn.objectStore(B).get(e).onsuccess=function(e){var t=e.target.result,n=o.rev?o.latest?D.latest(o.rev,t):o.rev:t&&t.rev;t&&(!t.deleted||o.rev)&&n in t.revs?((e=t.revs[n].data)._id=t.id,e._rev=n,i(null,{doc:e,metadata:t,ctx:r})):i(k.createError(k.MISSING_DOC,\"missing\"))}}function y(e,t,n,r,o,i){if(e.error)return i(e.error);var a;e.txn.objectStore(B).get(t).onsuccess=function(e){var t=e.target.result,e=t.revs[o.rev||t.rev].data._attachments[n].digest;a=t.attachments[e].data},e.txn.oncomplete=function(){!function(e,t,n){if(t.binary)return n(null,e);A.readAsBinaryString(e,function(e){n(null,A.btoa(e))})}(a,o,i)},e.txn.onabort=i}function _(e,t,s,f,u,n,r){var o,l,c,d=[],i=[],a=u.revs_limit||1e3,p=-1===u.name.indexOf(\"-mrview-\");function h(e){return/^_local/.test(e.id)?1:a}function v(t,n){var r=0,a={};function o(e){var o,i;e.target.result&&(a[e.target.result.id]=e.target.result),++r===n.length&&(o=t,i=a,n.forEach(function(e,t){var n;if(\"was_delete\"in s&&!i.hasOwnProperty(e.id))n=k.createError(k.MISSING_DOC,\"deleted\");else if(s.new_edits&&!i.hasOwnProperty(e.id)&&\"missing\"===e.rev_tree[0].ids[1].status)n=k.createError(k.REV_CONFLICT);else if(i.hasOwnProperty(e.id)){if(0==(n=function(e,t){if(e.rev in t.revs&&!s.new_edits)return!1;var n=/^1-/.test(e.rev);t.deleted&&!e.deleted&&s.new_edits&&n&&((r=e.revs[e.rev].data)._rev=t.rev,r._id=t.id,e=y(O.parseDoc(r,s.new_edits,u)));n=D.merge(t.rev_tree,e.rev_tree[0],h(e));e.stemmedRevs=n.stemmedRevs,e.rev_tree=n.tree;var r=t.revs;if(r[e.rev]=e.revs[e.rev],e.revs=r,e.attachments=t.attachments,s.new_edits&&(t.deleted&&e.deleted||!t.deleted&&\"new_leaf\"!==n.conflicts||t.deleted&&!e.deleted&&\"new_branch\"===n.conflicts||t.rev===e.rev))return k.createError(k.REV_CONFLICT);return e.wasDeleted=t.deleted,e}(e,i[e.id])))return}else{var r=D.merge([],e.rev_tree[0],h(e));e.rev_tree=r.tree,e.stemmedRevs=r.stemmedRevs,(n=e).isNewDoc=!0,n.wasDeleted=e.revs[e.rev].deleted?1:0}n.error?d[t]=n:(i[n.id]=n,function(e,t,n){var r=D.winningRev(t),o=t.rev,i=/^_local/.test(t.id),a=t.revs[r].data;{var s;p&&(s=function n(r){if(!C(r))return!1;var o=Array.isArray(r),i=o?[]:{};return Object.keys(r).forEach(function(e){var t=o?e:x(e);null===r[e]?i[t]=S:\"boolean\"==typeof r[e]?i[t]=r[e]?j:R:\"object\"==typeof r[e]?i[t]=n(r[e]):i[t]=r[e]}),i}(a))?(t.data=s,delete t.data._attachments):t.data=a}t.rev=r,t.deleted=t.revs[r].deleted?1:0,i||(t.seq=++f.seq,r=0,t.isNewDoc?r=t.deleted?0:1:t.wasDeleted!==t.deleted&&(r=t.deleted?-1:1),f.doc_count+=r);delete t.isNewDoc,delete t.wasDeleted,t.stemmedRevs&&t.stemmedRevs.forEach(function(e){delete t.revs[e]});delete t.stemmedRevs,\"attachments\"in t||(t.attachments={});if(a._attachments)for(var u in a._attachments){var c=a._attachments[u];if(c.stub){if(!(c.digest in t.attachments))return l=k.createError(k.MISSING_STUB),e.abort();t.attachments[c.digest].revs[o]=!0}else t.attachments[c.digest]=c,t.attachments[c.digest].revs={},t.attachments[c.digest].revs[o]=!0,a._attachments[u]={stub:!0,digest:c.digest,content_type:c.content_type,length:c.length,revpos:parseInt(o,10)}}i&&t.deleted?(e.objectStore(B).delete(t.id).onsuccess=function(){d[n]={ok:!0,id:t.id,rev:\"0-0\"}},_(n)):e.objectStore(B).put(t).onsuccess=function(){d[n]={ok:!0,id:t.id,rev:o},_(n)}}(o,n,c=t))}))}n.forEach(function(e){t.objectStore(B).get(e.id).onsuccess=o})}function y(e){var t={id:e.metadata.id,rev:e.metadata.rev,rev_tree:e.metadata.rev_tree,revs:e.metadata.revs||{}};return t.revs[t.rev]={data:e.data,deleted:e.metadata.deleted},t}function _(e){e===c&&o.objectStore(N).put(f)}function m(n){if(n.stub)return Promise.resolve(n);var r;if(\"string\"==typeof n.data){if((r=function(e){try{return atob(e)}catch(e){return{error:k.createError(k.BAD_ARG,\"Attachment is not a valid base64 string\")}}}(n.data)).error)return Promise.reject(r.error);n.data=A.binaryStringToBlobOrBuffer(r,n.content_type)}else r=n.data;return new Promise(function(t){I.binaryMd5(r,function(e){n.digest=\"md5-\"+e,n.length=r.size||r.length||0,t(n)})})}for(var g,b,w=0,E=t.docs.length;w<E;w++){try{g=O.parseDoc(t.docs[w],s.new_edits,u)}catch(e){g=e}if(g.error)return r(g);i.push(y(g))}b=i.map(function(e){var n=e.revs[e.rev].data;if(!n._attachments)return Promise.resolve(n);e=Object.keys(n._attachments).map(function(e){return n._attachments[e].name=e,m(n._attachments[e])});return Promise.all(e).then(function(e){var t={};return e.forEach(function(e){delete(t[e.name]=e).name}),n._attachments=t,n})}),Promise.all(b).then(function(){e._openTransactionSafely([B,N],\"readwrite\",function(e,t){return e?r(e):((o=t).onabort=function(){r(l)},o.ontimeout=L(r),o.oncomplete=function(){n.notify(u.name),r(null,d)},void v(o,i))})}).catch(function(e){r(e)})}function m(e,t,i,n){if(e.error)return n(e.error);if(0===i.limit){var r={total_rows:t.doc_count,offset:i.skip,rows:[]};return i.update_seq&&(r.update_seq=t.seq),n(null,r)}var o,a=[],s=[],u=\"startkey\"in i&&i.startkey,c=\"endkey\"in i&&i.endkey,f=\"key\"in i&&i.key,l=\"keys\"in i&&i.keys,d=i.skip||0,p=\"number\"==typeof i.limit?i.limit:-1,h=!1!==i.inclusive_end,r=\"descending\"in i&&i.descending?\"prev\":null;if(!l&&(o=function(e,t,n,r,o){try{if(e&&t)return o?IDBKeyRange.bound(t,e,!n,!1):IDBKeyRange.bound(e,t,!1,!n);if(e)return o?IDBKeyRange.upperBound(e):IDBKeyRange.lowerBound(e);if(t)return o?IDBKeyRange.lowerBound(t,!n):IDBKeyRange.upperBound(t,!n);if(r)return IDBKeyRange.only(r)}catch(e){return{error:e}}return null}(u,c,h,f,r))&&o.error)return function(e,t,n,r){if(\"DataError\"===n.name&&0===n.code){var o={total_rows:t.doc_count,offset:e.skip,rows:[]};return e.update_seq&&(o.update_seq=t.seq),r(null,o)}r(k.createError(k.IDB_ERROR,n.name,n.message))}(i,t,o.error,n);var v,y,_,m,g,f=e.txn.objectStore(B);if(e.txn.oncomplete=function(){Promise.all(s).then(function(){var e={total_rows:t.doc_count,offset:0,rows:a};i.update_seq&&(e.update_seq=t.seq),n(null,e)})},l)return v=i.keys,y=f,_=b,m=new Array(v.length),g=0,v.forEach(function(t,n){y.get(t).onsuccess=function(e){e.target.result?m[n]=e.target.result:m[n]={key:t,error:\"not_found\"},++g===v.length&&m.forEach(function(e){_(e)})}}),0;function b(e){if(e.error&&l)return a.push(e),!0;var t={id:e.id,key:e.id,value:{rev:e.rev}};if(e.deleted)l&&(a.push(t),t.value.deleted=!0,t.doc=null);else if(d--<=0&&(a.push(t),i.include_docs&&function(e,t){var n,r=t.revs[t.rev].data;if(e.doc=r,e.doc._id=t.id,e.doc._rev=t.rev,!i.conflicts||(n=D.collectConflicts(t)).length&&(e.doc._conflicts=n),i.attachments&&r._attachments)for(var o in r._attachments)s.push(w(o,t,e.doc,i.binary))}(t,e),0==--p))return!1;return!0}(r?f.openCursor(o,r):f.openCursor(o)).onsuccess=function(e){var t=e.target.result&&e.target.result.value;if(t){if(/^_local/.test(t.id))return e.target.result.continue();b(t)&&e.target.result.continue()}}}function g(e,t,n,r,s){if(e.error)return s.complete(e.error);if(s.continuous){var o=r.name+\":\"+h.uuid();return t.addListener(r.name,o,n,s),t.notify(r.name),1}var u=\"limit\"in s?s.limit:-1;0===u&&(u=1);var r=e.txn.objectStore(B).index(\"seq\"),c=h.filterChange(s),f=0,l=s.since||0,d=[],p=[];r=s.descending?r.openCursor(null,\"prev\"):r.openCursor(IDBKeyRange.lowerBound(s.since,!0)),e.txn.oncomplete=function(){Promise.all(p).then(function(){s.complete(null,{results:d,last_seq:l})})},r.onsuccess=function(e){if(e.target.result){var t=e.target.result,n=t.value;if(n.data=n.revs[n.rev].data,n.data._id=n.id,n.data._rev=n.rev,n.deleted&&(n.data._deleted=!0),s.doc_ids&&-1===s.doc_ids.indexOf(n.id))return t.continue();var r=s.processChange(n.data,n,s);r.seq=n.seq,l=n.seq;e=c(r);if(\"object\"==typeof e)return s.complete(e);if(e)if(f++,s.return_docs&&d.push(r),s.include_docs&&s.attachments&&n.data._attachments){var o,i=[];for(o in n.data._attachments){var a=w(o,n,r.doc,s.binary);i.push(a),p.push(a)}Promise.all(i).then(function(){s.onChange(r)})}else s.onChange(r);f!==u&&t.continue()}}}function b(e,t,n){if(e.error)return n(e.error);e.txn.objectStore(B).get(t).onsuccess=function(e){e.target.result?n(null,e.target.result.rev_tree):n(k.createError(k.MISSING_DOC))}}function E(e,t,i,n){if(e.error)return n(e.error);var o=e.txn.objectStore(B);o.get(t).onsuccess=function(e){var n=e.target.result;D.traverseRevTree(n.rev_tree,function(e,t,n,r,o){-1!==i.indexOf(t+\"-\"+n)&&(o.status=\"missing\")});var r=[];i.forEach(function(e){if(e in n.revs){if(n.revs[e].data._attachments)for(var t in n.revs[e].data._attachments)r.push(n.revs[e].data._attachments[t].digest);delete n.revs[e]}}),r.forEach(function(t){i.forEach(function(e){delete n.attachments[t].revs[e]}),Object.keys(n.attachments[t].revs).length||delete n.attachments[t]}),o.put(n)},e.txn.oncomplete=function(){n()}}var $=null,M=\"￿\",q=Number.NEGATIVE_INFINITY,P=[[[[[[[[[[[[]]]]]]]]]]]];function T(e,t,s){var r=this,u=t.split(\"/\");return new Promise(function(a,n){r.get(\"_design/\"+u[0]).then(function(e){var t=c(e,u[1]);if(!t)throw new Error(\"ddoc \"+e._id+\" with view \"+u[1]+\" does not have map.options.def.fields defined.\");var o=s.skip,i=Number.isInteger(s.limit)&&s.limit;return function r(o,i,a){var s=f(i);return new Promise(function(n){o._openTransactionSafely([B],\"readonly\",function(e,t){return e?L(a)(e):(t.onabort=L(a),t.ontimeout=L(a),void(-1===Array.from(t.objectStore(B).indexNames).indexOf(s)?o._freshen().then(function(){return r(o,i,a)}).then(n):n(t.objectStore(B).index(s))))})})}(r,t,n).then(function(e){var t=function(t){function e(e,t){return void 0!==e[t]}function n(e,t){return[0].concat(e).map(function(e){if(null===e&&t)return S;if(!0===e)return j;if(!1===e)return R;if(!t){if(e===$)return q;if(e.hasOwnProperty(M))return P}return e})}var r,o;e(t,\"inclusive_end\")||(t.inclusive_end=!0),e(t,\"inclusive_start\")||(t.inclusive_start=!0),t.descending&&(r=t.startkey,o=t.inclusive_start,t.startkey=t.endkey,t.endkey=r,t.inclusive_start=t.inclusive_end,t.inclusive_end=o);try{return e(t,\"key\")?IDBKeyRange.only(n(t.key,!0)):e(t,\"startkey\")&&!e(t,\"endkey\")?IDBKeyRange.lowerBound(n(t.startkey),!t.inclusive_start):!e(t,\"startkey\")&&e(t,\"endkey\")?IDBKeyRange.upperBound(n(t.endkey),!t.inclusive_end):e(t,\"startkey\")&&e(t,\"endkey\")?IDBKeyRange.bound(n(t.startkey),n(t.endkey),!t.inclusive_start,!t.inclusive_end):IDBKeyRange.only([0])}catch(e){throw console.error(\"Could not generate keyRange\",e,t),Error(\"Could not generate key range with \"+JSON.stringify(t))}}(s),t=e.openCursor(t,s.descending?\"prev\":\"next\"),r=[];t.onerror=L(n),t.onsuccess=function(e){var t,n=e.target.result;return n&&0!==i?o?(n.advance(o),void(o=!1)):(i&&(i-=1),r.push({doc:(t=n.value,(e=t.revs[t.rev].data)._id=t.id,e._rev=t.rev,t.deleted&&(e._deleted=!0),e)}),void n.continue()):a({rows:r})}})}).catch(n)})}function F(){return Promise.resolve()}var U=\"indexeddb\",V=new h.changesHandler,G={};function z(a,e){function t(t){return function(){var n=Array.prototype.slice.call(arguments);p(G,0,a).then(function(e){u=e.metadata,n.unshift(e.idb),t.apply(s,n)}).catch(function(e){var t=n.unshift();\"function\"==typeof t?t(e):console.error(e)})}}function n(r){return function(){var n=Array.prototype.slice.call(arguments);return new Promise(function(e,t){p(G,0,a).then(function(e){return u=e.metadata,n.unshift(e.idb),r.apply(s,n)}).then(e).catch(t)})}}function r(r,o,i){return o=o||[B],i=i||\"readonly\",function(){var t=Array.prototype.slice.call(arguments),n={};p(G,0,a).then(function(e){u=e.metadata,n.txn=e.idb.transaction(o,i),t.unshift(n),r.apply(s,t)}).catch(function(e){console.error(\"Failed to establish transaction safely\"),console.error(e),n.error=e})}}var s=this,u={};s._openTransactionSafely=function(e,t,n){r(function(e,t){t(e.error,e.txn)},e,t)(n)},s._remote=!1,s.type=function(){return U},s._id=t(function(e,t){t(null,u.db_uuid)}),s._info=t(function(e,t){t(null,{doc_count:(t=u).doc_count,update_seq:t.seq})}),s._get=r(v),s._bulkDocs=t(function(e,t,n,r){_(s,t,n,u,a,V,r)}),s._allDocs=r(function(e,t,n){m(e,u,t,n)}),s._getAttachment=r(y),s._changes=r(function(e,t){g(e,V,s,a,t)}),s._getRevisionTree=r(b),s._doCompaction=r(E,[B],\"readwrite\"),s._customFindAbstractMapper={query:n(T),viewCleanup:n(F)},s._destroy=function(e,t){return r=a,o=G,i=t,V.removeAllListeners(r.name),void(r.name in o?o[r.name].then(function(e){e.idb.close(),n()}):n());function n(){indexedDB.deleteDatabase(r.name).onsuccess=function(){delete o[r.name],i(null,{ok:!0})}}var r,o,i},s._close=t(function(e,t){delete G[a.name],e.close(),t()}),s._freshen=function(){return new Promise(function(e){s._close(function(){t(e)()})})},setTimeout(function(){e(null,s)})}z.valid=function(){return!0},t.exports=function(e){e.adapter(U,z,!0)}},{18:18,19:19,31:31,52:52,96:96,97:97}],11:[function(e,t,n){\"use strict\";var r,o,i,a=[e(7),e(14),e(13),e(12),e(15),e(16)],s=-1,u=[],c=!1;function f(){r&&o&&(r=!1,o.length?u=o.concat(u):s=-1,u.length&&l())}function l(){if(!r){r=!(c=!1);for(var e=u.length,t=setTimeout(f);e;){for(o=u,u=[];o&&++s<e;)o[s].run();s=-1,e=u.length}o=null,r=!(s=-1),clearTimeout(t)}}for(var d=-1,p=a.length;++d<p;)if(a[d]&&a[d].test&&a[d].test()){i=a[d].install(l);break}function h(e,t){this.fun=e,this.array=t}h.prototype.run=function(){var e=this.fun,t=this.array;switch(t.length){case 0:return e();case 1:return e(t[0]);case 2:return e(t[0],t[1]);case 3:return e(t[0],t[1],t[2]);default:return e.apply(null,t)}},t.exports=function(e){var t=new Array(arguments.length-1);if(1<arguments.length)for(var n=1;n<arguments.length;n++)t[n-1]=arguments[n];u.push(new h(e,t)),c||r||(c=!0,i())}},{12:12,13:13,14:14,15:15,16:16,7:7}],12:[function(e,t,r){!function(n){!function(){\"use strict\";r.test=function(){return!n.setImmediate&&void 0!==n.MessageChannel},r.install=function(e){var t=new n.MessageChannel;return t.port1.onmessage=e,function(){t.port2.postMessage(0)}}}.call(this)}.call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],13:[function(e,t,n){!function(o){!function(){\"use strict\";var r=o.MutationObserver||o.WebKitMutationObserver;n.test=function(){return r},n.install=function(e){var t=0,e=new r(e),n=o.document.createTextNode(\"\");return e.observe(n,{characterData:!0}),function(){n.data=t=++t%2}}}.call(this)}.call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],14:[function(e,t,n){!function(t){!function(){\"use strict\";n.test=function(){return\"function\"==typeof t.queueMicrotask},n.install=function(e){return function(){t.queueMicrotask(e)}}}.call(this)}.call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],15:[function(e,t,r){!function(n){!function(){\"use strict\";r.test=function(){return\"document\"in n&&\"onreadystatechange\"in n.document.createElement(\"script\")},r.install=function(t){return function(){var e=n.document.createElement(\"script\");return e.onreadystatechange=function(){t(),e.onreadystatechange=null,e.parentNode.removeChild(e),e=null},n.document.documentElement.appendChild(e),t}}}.call(this)}.call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],16:[function(e,t,n){\"use strict\";n.test=function(){return!0},n.install=function(e){return function(){setTimeout(e,0)}}},{}],17:[function(e,t,n){\"use strict\";function r(){this._store={}}function o(e){if(this._store=new r,e&&Array.isArray(e))for(var t=0,n=e.length;t<n;t++)this.add(e[t])}Object.defineProperty(n,\"__esModule\",{value:!0}),r.prototype.get=function(e){return this._store[\"$\"+e]},r.prototype.set=function(e,t){return this._store[\"$\"+e]=t,!0},r.prototype.has=function(e){return\"$\"+e in this._store},r.prototype.delete=function(e){var t=\"$\"+e,e=t in this._store;return delete this._store[t],e},r.prototype.forEach=function(e){for(var t=Object.keys(this._store),n=0,r=t.length;n<r;n++){var o=t[n];e(this._store[o],o=o.substring(1))}},Object.defineProperty(r.prototype,\"size\",{get:function(){return Object.keys(this._store).length}}),o.prototype.add=function(e){return this._store.set(e,!0)},o.prototype.has=function(e){return this._store.has(e)},o.prototype.forEach=function(n){this._store.forEach(function(e,t){n(t)})},Object.defineProperty(o.prototype,\"size\",{get:function(){return this._store.size}}),!function(){if(\"undefined\"!=typeof Symbol&&\"undefined\"!=typeof Map&&\"undefined\"!=typeof Set){var e=Object.getOwnPropertyDescriptor(Map,Symbol.species);return e&&\"get\"in e&&Map[Symbol.species]===Map}}()?(n.Set=o,n.Map=r):(n.Set=Set,n.Map=Map)},{}],18:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var d=e(52),p=(e=e(20))&&\"object\"==typeof e&&\"default\"in e?e.default:e,h=self.setImmediate||self.setTimeout;function v(t,e,n,r,o){var i;(0<n||r<e.size)&&(i=n,n=r,e=(r=e).webkitSlice?r.webkitSlice(i,n):r.slice(i,n)),d.readAsArrayBuffer(e,function(e){t.append(e),o()})}function y(e,t,n,r,o){(0<n||r<t.length)&&(t=t.substring(n,r)),e.appendBinary(t),o()}n.binaryMd5=function(n,t){var e=\"string\"==typeof n,r=e?n.length:n.size,o=Math.min(32768,r),i=Math.ceil(r/o),a=0,s=new(e?p:p.ArrayBuffer),u=e?y:v;function c(){h(l)}function f(){var e=s.end(!0),e=d.btoa(e);t(e),s.destroy()}function l(){var e=a*o,t=e+o;u(s,n,e,t,++a<i?c:f)}l()},n.stringMd5=function(e){return p.hash(e)}},{20:20,52:52}],19:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}Object.defineProperty(n,\"__esModule\",{value:!0});var o=r(e(6)),i=e(17),a=r(e(9)),s=r(e(11)),u=e(96),c=r(e(8)),f=e(22),l=e(18);function d(e){if(e instanceof ArrayBuffer)return function(e){if(\"function\"==typeof e.slice)return e.slice(0);var t=new ArrayBuffer(e.byteLength),n=new Uint8Array(t),e=new Uint8Array(e);return n.set(e),t}(e);var t=e.size,n=e.type;return\"function\"==typeof e.slice?e.slice(0,t,n):e.webkitSlice(0,t,n)}var p=Function.prototype.toString,h=p.call(Object);function v(e){var t,n,r,o,i;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;n<r;n++)t[n]=v(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o=e,\"undefined\"!=typeof ArrayBuffer&&o instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&o instanceof Blob)return d(e);if(o=e,!(null===(o=Object.getPrototypeOf(o))||\"function\"==typeof(o=o.constructor)&&o instanceof o&&p.call(o)==h))return e;for(n in t={},e)!Object.prototype.hasOwnProperty.call(e,n)||void 0!==(i=v(e[n]))&&(t[n]=i);return t}function y(t){var n=!1;return o(function(e){if(n)throw new Error(\"once called more than once\");n=!0,t.apply(this,e)})}function _(a){return o(function(o){o=v(o);var i=this,t=\"function\"==typeof o[o.length-1]&&o.pop(),e=new Promise(function(n,r){var e;try{var t=y(function(e,t){e?r(e):n(t)});o.push(t),(e=a.apply(i,o))&&\"function\"==typeof e.then&&n(e)}catch(e){r(e)}});return t&&e.then(function(e){t(null,e)},t),e})}function m(e,t){for(var n={},r=0,o=t.length;r<o;r++){var i=t[r];i in e&&(n[i]=e[i])}return n}var g;function b(e){return e}function w(e){return[{ok:e}]}try{localStorage.setItem(\"_pouch_check_localstorage\",1),g=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(e){g=!1}function E(){return g}function A(){var t;c.call(this),this._listeners={},t=this,g&&addEventListener(\"storage\",function(e){t.emit(e.key)})}function O(e){var t;\"undefined\"!=typeof console&&\"function\"==typeof console[e]&&(t=Array.prototype.slice.call(arguments,1),console[e].apply(console,t))}a(A,c),A.prototype.addListener=function(e,t,n,r){var o,i;function a(){var e;o._listeners[t]&&(i?i=\"waiting\":(i=!0,e=m(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\",\"return_docs\"]),n.changes(e).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===i&&s(a),i=!1}).on(\"error\",function(){i=!1})))}this._listeners[t]||(i=!1,(o=this)._listeners[t]=a,this.on(e,a))},A.prototype.removeListener=function(e,t){t in this._listeners&&(c.prototype.removeListener.call(this,e,this._listeners[t]),delete this._listeners[t])},A.prototype.notifyLocalWindows=function(e){g&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},A.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};var I=\"function\"==typeof Object.assign?Object.assign:function(e){for(var t=Object(e),n=1;n<arguments.length;n++){var r=arguments[n];if(null!=r)for(var o in r)Object.prototype.hasOwnProperty.call(r,o)&&(t[o]=r[o])}return t};e=function(){}.name?function(e){return e.name}:function(e){e=e.toString().match(/^\\s*function\\s*(?:(\\S+)\\s*)?\\(/);return e&&e[1]?e[1]:\"\"},a=e;function k(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}var D=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],S=\"queryKey\",R=/(?:^|&)([^&=]*)=?([^&]*)/g,j=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/;function x(s,u,c){return new Promise(function(i,a){s.get(u,function(e,t){if(e){if(404!==e.status)return a(e);t={}}var n,r,o,e=t._rev,t=c(t);if(!t)return i({updated:!1,rev:e});t._id=u,t._rev=e,i((r=t,o=c,(n=s).put(r).then(function(e){return{updated:!0,rev:e.rev}},function(e){if(409!==e.status)throw e;return x(n,r._id,o)})))})})}e=f.v4;n.adapterFun=function(i,e){return _(o(function(r){if(this._closed)return Promise.reject(new Error(\"database is closed\"));if(this._destroyed)return Promise.reject(new Error(\"database is destroyed\"));var o=this;return function(r,o,e){if(r.constructor.listeners(\"debug\").length){for(var t=[\"api\",r.name,o],n=0;n<e.length-1;n++)t.push(e[n]);r.constructor.emit(\"debug\",t);var i=e[e.length-1];e[e.length-1]=function(e,t){var n=(n=[\"api\",r.name,o]).concat(e?[\"error\",e]:[\"success\",t]);r.constructor.emit(\"debug\",n),i(e,t)}}}(o,i,r),this.taskqueue.isReady?e.apply(this,r):new Promise(function(t,n){o.taskqueue.addTask(function(e){e?n(e):t(o[i].apply(o,r))})})}))},n.assign=I,n.bulkGetShim=function(a,s,e){var t=s.docs,u=new i.Map;t.forEach(function(e){u.has(e.id)?u.get(e.id).push(e):u.set(e.id,[e])});var r=u.size,o=0,c=new Array(r);function f(){var n;++o===r&&(n=[],c.forEach(function(t){t.docs.forEach(function(e){n.push({id:t.id,docs:[e]})})}),e(null,{results:n}))}var n=[];u.forEach(function(e,t){n.push(t)});var l=0;function d(){var e,i;l>=n.length||(e=Math.min(l+6,n.length),e=n.slice(l,e),i=l,e.forEach(function(n,e){var r=i+e,e=u.get(n),t=m(e[0],[\"atts_since\",\"attachments\"]);t.open_revs=e.map(function(e){return e.rev}),t.open_revs=t.open_revs.filter(b);var o=b;0===t.open_revs.length&&(delete t.open_revs,o=w),[\"revs\",\"attachments\",\"binary\",\"ajax\",\"latest\"].forEach(function(e){e in s&&(t[e]=s[e])}),a.get(n,t,function(e,t){var t=e?[{error:e}]:o(t);t=t,c[r]={id:n,docs:t},f(),d()})}),l+=e.length)}d()},n.changesHandler=A,n.clone=v,n.defaultBackOff=function(e){var t;return e=(t=e)?0:2e3,t=parseInt(t,10)||0,(e=parseInt(e,10))!=e||e<=t?e=(t||1)<<1:e+=1,6e5<e&&(t=3e5,e=6e5),~~((e-t)*Math.random()+t)},n.explainError=function(e,t){O(\"info\",\"The above \"+e+\" is totally normal. \"+t)},n.filterChange=function(r){var o={},i=r.filter&&\"function\"==typeof r.filter;return o.query=r.query_params,function(e){e.doc||(e.doc={});var t=i&&function(e,t,n){try{return!e(t,n)}catch(e){n=\"Filter function threw: \"+e.toString();return u.createError(u.BAD_REQUEST,n)}}(r.filter,e.doc,o);if(\"object\"==typeof t)return t;if(t)return!1;if(r.include_docs){if(!r.attachments)for(var n in e.doc._attachments)e.doc._attachments.hasOwnProperty(n)&&(e.doc._attachments[n].stub=!0)}else delete e.doc;return!0}},n.flatten=function(e){for(var t=[],n=0,r=e.length;n<r;n++)t=t.concat(e[n]);return t},n.functionName=a,n.guardedConsole=O,n.hasLocalStorage=E,n.invalidIdError=function(e){var t;if(e?\"string\"!=typeof e?t=u.createError(u.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=u.createError(u.RESERVED_ID)):t=u.createError(u.MISSING_ID),t)throw t},n.isRemote=function(e){return\"boolean\"==typeof e._remote?e._remote:\"function\"==typeof e.type&&(O(\"warn\",\"db.type() is deprecated and will be removed in a future version of PouchDB\"),\"http\"===e.type())},n.listenerCount=function(e,t){return\"listenerCount\"in e?e.listenerCount(t):c.listenerCount(e,t)},n.nextTick=s,n.normalizeDdocFunctionName=function(e){return(e=k(e))?e.join(\"/\"):null},n.once=y,n.parseDdocFunctionName=k,n.parseUri=function(e){for(var t=j.exec(e),r={},n=14;n--;){var o=D[n],i=t[n]||\"\",a=-1!==[\"user\",\"password\"].indexOf(o);r[o]=a?decodeURIComponent(i):i}return r[S]={},r[D[12]].replace(R,function(e,t,n){t&&(r[S][t]=n)}),r},n.pick=m,n.rev=function(e,t){return e=v(e),t?(delete e._rev_tree,l.stringMd5(JSON.stringify(e))):f.v4().replace(/-/g,\"\").toLowerCase()},n.scopeEval=function(e,t){var n,r=[],o=[];for(n in t)t.hasOwnProperty(n)&&(r.push(n),o.push(t[n]));return r.push(e),Function.apply(null,r).apply(null,o)},n.toPromise=_,n.upsert=x,n.uuid=e},{11:11,17:17,18:18,22:22,6:6,8:8,9:9,96:96}],20:[function(e,n,r){!function(e){if(\"object\"==typeof r)n.exports=e();else if(\"function\"==typeof define&&define.amd)define(e);else{var t;try{t=window}catch(e){t=self}t.SparkMD5=e()}}(function(o){\"use strict\";var r=[\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"];function u(e,t){var n=e[0],r=e[1],o=e[2],i=e[3],r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[0]-680876936|0)<<7|n>>>25)+r|0)&r|~n&o)+t[1]-389564586|0)<<12|i>>>20)+n|0)&n|~i&r)+t[2]+606105819|0)<<17|o>>>15)+i|0)&i|~o&n)+t[3]-1044525330|0)<<22|r>>>10)+o|0;r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[4]-176418897|0)<<7|n>>>25)+r|0)&r|~n&o)+t[5]+1200080426|0)<<12|i>>>20)+n|0)&n|~i&r)+t[6]-1473231341|0)<<17|o>>>15)+i|0)&i|~o&n)+t[7]-45705983|0)<<22|r>>>10)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[8]+1770035416|0)<<7|n>>>25)+r|0)&r|~n&o)+t[9]-1958414417|0)<<12|i>>>20)+n|0)&n|~i&r)+t[10]-42063|0)<<17|o>>>15)+i|0)&i|~o&n)+t[11]-1990404162|0)<<22|r>>>10)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&o|~r&i)+t[12]+1804603682|0)<<7|n>>>25)+r|0)&r|~n&o)+t[13]-40341101|0)<<12|i>>>20)+n|0)&n|~i&r)+t[14]-1502002290|0)<<17|o>>>15)+i|0)&i|~o&n)+t[15]+1236535329|0)<<22|r>>>10)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[1]-165796510|0)<<5|n>>>27)+r|0)&o|r&~o)+t[6]-1069501632|0)<<9|i>>>23)+n|0)&r|n&~r)+t[11]+643717713|0)<<14|o>>>18)+i|0)&n|i&~n)+t[0]-373897302|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[5]-701558691|0)<<5|n>>>27)+r|0)&o|r&~o)+t[10]+38016083|0)<<9|i>>>23)+n|0)&r|n&~r)+t[15]-660478335|0)<<14|o>>>18)+i|0)&n|i&~n)+t[4]-405537848|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[9]+568446438|0)<<5|n>>>27)+r|0)&o|r&~o)+t[14]-1019803690|0)<<9|i>>>23)+n|0)&r|n&~r)+t[3]-187363961|0)<<14|o>>>18)+i|0)&n|i&~n)+t[8]+1163531501|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r&i|o&~i)+t[13]-1444681467|0)<<5|n>>>27)+r|0)&o|r&~o)+t[2]-51403784|0)<<9|i>>>23)+n|0)&r|n&~r)+t[7]+1735328473|0)<<14|o>>>18)+i|0)&n|i&~n)+t[12]-1926607734|0)<<20|r>>>12)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[5]-378558|0)<<4|n>>>28)+r|0)^r^o)+t[8]-2022574463|0)<<11|i>>>21)+n|0)^n^r)+t[11]+1839030562|0)<<16|o>>>16)+i|0)^i^n)+t[14]-35309556|0)<<23|r>>>9)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[1]-1530992060|0)<<4|n>>>28)+r|0)^r^o)+t[4]+1272893353|0)<<11|i>>>21)+n|0)^n^r)+t[7]-155497632|0)<<16|o>>>16)+i|0)^i^n)+t[10]-1094730640|0)<<23|r>>>9)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[13]+681279174|0)<<4|n>>>28)+r|0)^r^o)+t[0]-358537222|0)<<11|i>>>21)+n|0)^n^r)+t[3]-722521979|0)<<16|o>>>16)+i|0)^i^n)+t[6]+76029189|0)<<23|r>>>9)+o|0,r=((r+=((o=((o+=((i=((i+=((n=((n+=(r^o^i)+t[9]-640364487|0)<<4|n>>>28)+r|0)^r^o)+t[12]-421815835|0)<<11|i>>>21)+n|0)^n^r)+t[15]+530742520|0)<<16|o>>>16)+i|0)^i^n)+t[2]-995338651|0)<<23|r>>>9)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[0]-198630844|0)<<6|n>>>26)+r|0)|~o))+t[7]+1126891415|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[14]-1416354905|0)<<15|o>>>17)+i|0)|~n))+t[5]-57434055|0)<<21|r>>>11)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[12]+1700485571|0)<<6|n>>>26)+r|0)|~o))+t[3]-1894986606|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[10]-1051523|0)<<15|o>>>17)+i|0)|~n))+t[1]-2054922799|0)<<21|r>>>11)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[8]+1873313359|0)<<6|n>>>26)+r|0)|~o))+t[15]-30611744|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[6]-1560198380|0)<<15|o>>>17)+i|0)|~n))+t[13]+1309151649|0)<<21|r>>>11)+o|0,r=((r+=((i=((i+=(r^((n=((n+=(o^(r|~i))+t[4]-145523070|0)<<6|n>>>26)+r|0)|~o))+t[11]-1120210379|0)<<10|i>>>22)+n|0)^((o=((o+=(n^(i|~r))+t[2]+718787259|0)<<15|o>>>17)+i|0)|~n))+t[9]-343485551|0)<<21|r>>>11)+o|0,e[0]=n+e[0]|0,e[1]=r+e[1]|0,e[2]=o+e[2]|0,e[3]=i+e[3]|0}function c(e){for(var t=[],n=0;n<64;n+=4)t[n>>2]=e.charCodeAt(n)+(e.charCodeAt(n+1)<<8)+(e.charCodeAt(n+2)<<16)+(e.charCodeAt(n+3)<<24);return t}function f(e){for(var t=[],n=0;n<64;n+=4)t[n>>2]=e[n]+(e[n+1]<<8)+(e[n+2]<<16)+(e[n+3]<<24);return t}function n(e){for(var t,n,r,o,i=e.length,a=[1732584193,-271733879,-1732584194,271733878],s=64;s<=i;s+=64)u(a,c(e.substring(s-64,s)));for(t=(e=e.substring(s-64)).length,n=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],s=0;s<t;s+=1)n[s>>2]|=e.charCodeAt(s)<<(s%4<<3);if(n[s>>2]|=128<<(s%4<<3),55<s)for(u(a,n),s=0;s<16;s+=1)n[s]=0;return o=(o=8*i).toString(16).match(/(.*?)(.{0,8})$/),r=parseInt(o[2],16),o=parseInt(o[1],16)||0,n[14]=r,n[15]=o,u(a,n),a}function a(e){for(var t=0;t<e.length;t+=1)e[t]=function(e){for(var t=\"\",n=0;n<4;n+=1)t+=r[e>>8*n+4&15]+r[e>>8*n&15];return t}(e[t]);return e.join(\"\")}function i(e,t){return(e=0|e||0)<0?Math.max(e+t,0):Math.min(e,t)}function s(e){return e=/[\\u0080-\\uFFFF]/.test(e)?unescape(encodeURIComponent(e)):e}function l(e){for(var t=[],n=e.length,r=0;r<n-1;r+=2)t.push(parseInt(e.substr(r,2),16));return String.fromCharCode.apply(String,t)}function d(){this.reset()}return\"5d41402abc4b2a76b9719d911017c592\"!==a(n(\"hello\"))&&0,\"undefined\"==typeof ArrayBuffer||ArrayBuffer.prototype.slice||(ArrayBuffer.prototype.slice=function(e,t){var n=this.byteLength,r=i(e,n),e=n;return(e=t!==o?i(t,n):e)<r?new ArrayBuffer(0):(t=e-r,n=new ArrayBuffer(t),e=new Uint8Array(n),t=new Uint8Array(this,r,t),e.set(t),n)}),d.prototype.append=function(e){return this.appendBinary(s(e)),this},d.prototype.appendBinary=function(e){this._buff+=e,this._length+=e.length;for(var t=this._buff.length,n=64;n<=t;n+=64)u(this._hash,c(this._buff.substring(n-64,n)));return this._buff=this._buff.substring(n-64),this},d.prototype.end=function(e){for(var t,n=this._buff,r=n.length,o=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],i=0;i<r;i+=1)o[i>>2]|=n.charCodeAt(i)<<(i%4<<3);return this._finish(o,r),t=a(this._hash),e&&(t=l(t)),this.reset(),t},d.prototype.reset=function(){return this._buff=\"\",this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},d.prototype.getState=function(){return{buff:this._buff,length:this._length,hash:this._hash.slice()}},d.prototype.setState=function(e){return this._buff=e.buff,this._length=e.length,this._hash=e.hash,this},d.prototype.destroy=function(){delete this._hash,delete this._buff,delete this._length},d.prototype._finish=function(e,t){var n,r=t;if(e[r>>2]|=128<<(r%4<<3),55<r)for(u(this._hash,e),r=0;r<16;r+=1)e[r]=0;n=(n=8*this._length).toString(16).match(/(.*?)(.{0,8})$/),t=parseInt(n[2],16),n=parseInt(n[1],16)||0,e[14]=t,e[15]=n,u(this._hash,e)},d.hash=function(e,t){return d.hashBinary(s(e),t)},d.hashBinary=function(e,t){e=a(n(e));return t?l(e):e},(d.ArrayBuffer=function(){this.reset()}).prototype.append=function(e){var t,n,r,o,i,a=(n=this._buff.buffer,r=e,o=!0,(i=new Uint8Array(n.byteLength+r.byteLength)).set(new Uint8Array(n)),i.set(new Uint8Array(r),n.byteLength),o?i:i.buffer),s=a.length;for(this._length+=e.byteLength,t=64;t<=s;t+=64)u(this._hash,f(a.subarray(t-64,t)));return this._buff=t-64<s?new Uint8Array(a.buffer.slice(t-64)):new Uint8Array(0),this},d.ArrayBuffer.prototype.end=function(e){for(var t,n=this._buff,r=n.length,o=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],i=0;i<r;i+=1)o[i>>2]|=n[i]<<(i%4<<3);return this._finish(o,r),t=a(this._hash),e&&(t=l(t)),this.reset(),t},d.ArrayBuffer.prototype.reset=function(){return this._buff=new Uint8Array(0),this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},d.ArrayBuffer.prototype.getState=function(){var e,t=d.prototype.getState.call(this);return t.buff=(e=t.buff,String.fromCharCode.apply(null,new Uint8Array(e))),t},d.ArrayBuffer.prototype.setState=function(e){return e.buff=function(e,t){for(var n=e.length,r=new ArrayBuffer(n),o=new Uint8Array(r),i=0;i<n;i+=1)o[i]=e.charCodeAt(i);return t?o:r}(e.buff,!0),d.prototype.setState.call(this,e)},d.ArrayBuffer.prototype.destroy=d.prototype.destroy,d.ArrayBuffer.prototype._finish=d.prototype._finish,d.ArrayBuffer.hash=function(e,t){e=a(function(e){for(var t,n,r,o,i=e.length,a=[1732584193,-271733879,-1732584194,271733878],s=64;s<=i;s+=64)u(a,f(e.subarray(s-64,s)));for(t=(e=s-64<i?e.subarray(s-64):new Uint8Array(0)).length,n=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],s=0;s<t;s+=1)n[s>>2]|=e[s]<<(s%4<<3);if(n[s>>2]|=128<<(s%4<<3),55<s)for(u(a,n),s=0;s<16;s+=1)n[s]=0;return o=(o=8*i).toString(16).match(/(.*?)(.{0,8})$/),r=parseInt(o[2],16),o=parseInt(o[1],16)||0,n[14]=r,n[15]=o,u(a,n),a}(new Uint8Array(e)));return t?l(e):e},d})},{}],21:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0;const r=[];for(let e=0;e<256;++e)r.push((e+256).toString(16).substr(1));n.default=function(e,t){var n=t||0;return((t=r)[e[n+0]]+t[e[n+1]]+t[e[n+2]]+t[e[n+3]]+\"-\"+t[e[n+4]]+t[e[n+5]]+\"-\"+t[e[n+6]]+t[e[n+7]]+\"-\"+t[e[n+8]]+t[e[n+9]]+\"-\"+t[e[n+10]]+t[e[n+11]]+t[e[n+12]]+t[e[n+13]]+t[e[n+14]]+t[e[n+15]]).toLowerCase()}},{}],22:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),Object.defineProperty(n,\"v1\",{enumerable:!0,get:function(){return r.default}}),Object.defineProperty(n,\"v3\",{enumerable:!0,get:function(){return o.default}}),Object.defineProperty(n,\"v4\",{enumerable:!0,get:function(){return i.default}}),Object.defineProperty(n,\"v5\",{enumerable:!0,get:function(){return a.default}});var r=s(e(26)),o=s(e(27)),i=s(e(29)),a=s(e(30));function s(e){return e&&e.__esModule?e:{default:e}}},{26:26,27:27,29:29,30:30}],23:[function(e,t,n){\"use strict\";function f(e){return 14+(e+64>>>9<<4)+1}function l(e,t){var n=(65535&e)+(65535&t);return(e>>16)+(t>>16)+(n>>16)<<16|65535&n}function s(e,t,n,r,o,i){return l((i=l(l(t,e),l(r,i)))<<o|i>>>32-o,n)}function d(e,t,n,r,o,i,a){return s(t&n|~t&r,e,t,o,i,a)}function p(e,t,n,r,o,i,a){return s(t&r|n&~r,e,t,o,i,a)}function h(e,t,n,r,o,i,a){return s(t^n^r,e,t,o,i,a)}function v(e,t,n,r,o,i,a){return s(n^(t|~r),e,t,o,i,a)}Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0,n.default=function(t){if(\"string\"==typeof t){const n=unescape(encodeURIComponent(t));t=new Uint8Array(n.length);for(let e=0;e<n.length;++e)t[e]=n.charCodeAt(e)}return function(t){const n=[],r=32*t.length,o=\"0123456789abcdef\";for(let e=0;e<r;e+=8){var i=t[e>>5]>>>e%32&255,i=parseInt(o.charAt(i>>>4&15)+o.charAt(15&i),16);n.push(i)}return n}(function(t,e){t[e>>5]|=128<<e%32,t[f(e)-1]=e;let n=1732584193,r=-271733879,o=-1732584194,i=271733878;for(let e=0;e<t.length;e+=16){var a=n,s=r,u=o,c=i;n=d(n,r,o,i,t[e],7,-680876936),i=d(i,n,r,o,t[e+1],12,-389564586),o=d(o,i,n,r,t[e+2],17,606105819),r=d(r,o,i,n,t[e+3],22,-1044525330),n=d(n,r,o,i,t[e+4],7,-176418897),i=d(i,n,r,o,t[e+5],12,1200080426),o=d(o,i,n,r,t[e+6],17,-1473231341),r=d(r,o,i,n,t[e+7],22,-45705983),n=d(n,r,o,i,t[e+8],7,1770035416),i=d(i,n,r,o,t[e+9],12,-1958414417),o=d(o,i,n,r,t[e+10],17,-42063),r=d(r,o,i,n,t[e+11],22,-1990404162),n=d(n,r,o,i,t[e+12],7,1804603682),i=d(i,n,r,o,t[e+13],12,-40341101),o=d(o,i,n,r,t[e+14],17,-1502002290),r=d(r,o,i,n,t[e+15],22,1236535329),n=p(n,r,o,i,t[e+1],5,-165796510),i=p(i,n,r,o,t[e+6],9,-1069501632),o=p(o,i,n,r,t[e+11],14,643717713),r=p(r,o,i,n,t[e],20,-373897302),n=p(n,r,o,i,t[e+5],5,-701558691),i=p(i,n,r,o,t[e+10],9,38016083),o=p(o,i,n,r,t[e+15],14,-660478335),r=p(r,o,i,n,t[e+4],20,-405537848),n=p(n,r,o,i,t[e+9],5,568446438),i=p(i,n,r,o,t[e+14],9,-1019803690),o=p(o,i,n,r,t[e+3],14,-187363961),r=p(r,o,i,n,t[e+8],20,1163531501),n=p(n,r,o,i,t[e+13],5,-1444681467),i=p(i,n,r,o,t[e+2],9,-51403784),o=p(o,i,n,r,t[e+7],14,1735328473),r=p(r,o,i,n,t[e+12],20,-1926607734),n=h(n,r,o,i,t[e+5],4,-378558),i=h(i,n,r,o,t[e+8],11,-2022574463),o=h(o,i,n,r,t[e+11],16,1839030562),r=h(r,o,i,n,t[e+14],23,-35309556),n=h(n,r,o,i,t[e+1],4,-1530992060),i=h(i,n,r,o,t[e+4],11,1272893353),o=h(o,i,n,r,t[e+7],16,-155497632),r=h(r,o,i,n,t[e+10],23,-1094730640),n=h(n,r,o,i,t[e+13],4,681279174),i=h(i,n,r,o,t[e],11,-358537222),o=h(o,i,n,r,t[e+3],16,-722521979),r=h(r,o,i,n,t[e+6],23,76029189),n=h(n,r,o,i,t[e+9],4,-640364487),i=h(i,n,r,o,t[e+12],11,-421815835),o=h(o,i,n,r,t[e+15],16,530742520),r=h(r,o,i,n,t[e+2],23,-995338651),n=v(n,r,o,i,t[e],6,-198630844),i=v(i,n,r,o,t[e+7],10,1126891415),o=v(o,i,n,r,t[e+14],15,-1416354905),r=v(r,o,i,n,t[e+5],21,-57434055),n=v(n,r,o,i,t[e+12],6,1700485571),i=v(i,n,r,o,t[e+3],10,-1894986606),o=v(o,i,n,r,t[e+10],15,-1051523),r=v(r,o,i,n,t[e+1],21,-2054922799),n=v(n,r,o,i,t[e+8],6,1873313359),i=v(i,n,r,o,t[e+15],10,-30611744),o=v(o,i,n,r,t[e+6],15,-1560198380),r=v(r,o,i,n,t[e+13],21,1309151649),n=v(n,r,o,i,t[e+4],6,-145523070),i=v(i,n,r,o,t[e+11],10,-1120210379),o=v(o,i,n,r,t[e+2],15,718787259),r=v(r,o,i,n,t[e+9],21,-343485551),n=l(n,a),r=l(r,s),o=l(o,u),i=l(i,c)}return[n,r,o,i]}(function(t){if(0===t.length)return[];const n=8*t.length,r=new Uint32Array(f(n));for(let e=0;e<n;e+=8)r[e>>5]|=(255&t[e/8])<<e%32;return r}(t),8*t.length))}},{}],24:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=function(){if(r)return r(o);throw new Error(\"crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported\")};const r=\"undefined\"!=typeof crypto&&crypto.getRandomValues&&crypto.getRandomValues.bind(crypto)||\"undefined\"!=typeof msCrypto&&\"function\"==typeof msCrypto.getRandomValues&&msCrypto.getRandomValues.bind(msCrypto),o=new Uint8Array(16)},{}],25:[function(e,t,n){\"use strict\";function l(e,t){return e<<t|e>>>32-t}Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0,n.default=function(n){var s=[1518500249,1859775393,2400959708,3395469782];const e=[1732584193,4023233417,2562383102,271733878,3285377520];if(\"string\"==typeof n){const o=unescape(encodeURIComponent(n));n=[];for(let e=0;e<o.length;++e)n.push(o.charCodeAt(e))}n.push(128);var t=n.length/4+2,r=Math.ceil(t/16);const u=new Array(r);for(let t=0;t<r;++t){const i=new Uint32Array(16);for(let e=0;e<16;++e)i[e]=n[64*t+4*e]<<24|n[64*t+4*e+1]<<16|n[64*t+4*e+2]<<8|n[64*t+4*e+3];u[t]=i}u[r-1][14]=8*(n.length-1)/Math.pow(2,32),u[r-1][14]=Math.floor(u[r-1][14]),u[r-1][15]=8*(n.length-1)&4294967295;for(let a=0;a<r;++a){const f=new Uint32Array(80);for(let e=0;e<16;++e)f[e]=u[a][e];for(let e=16;e<80;++e)f[e]=l(f[e-3]^f[e-8]^f[e-14]^f[e-16],1);let t=e[0],n=e[1],r=e[2],o=e[3],i=e[4];for(let e=0;e<80;++e){var c=Math.floor(e/20),c=l(t,5)+function(e,t,n,r){switch(e){case 0:return t&n^~t&r;case 1:return t^n^r;case 2:return t&n^t&r^n&r;case 3:return t^n^r}}(c,n,r,o)+i+s[c]+f[e]>>>0;i=o,o=r,r=l(n,30)>>>0,n=t,t=c}e[0]=e[0]+t>>>0,e[1]=e[1]+n>>>0,e[2]=e[2]+r>>>0,e[3]=e[3]+o>>>0,e[4]=e[4]+i>>>0}return[e[0]>>24&255,e[0]>>16&255,e[0]>>8&255,255&e[0],e[1]>>24&255,e[1]>>16&255,e[1]>>8&255,255&e[1],e[2]>>24&255,e[2]>>16&255,e[2]>>8&255,255&e[2],e[3]>>24&255,e[3]>>16&255,e[3]>>8&255,255&e[3],e[4]>>24&255,e[4]>>16&255,e[4]>>8&255,255&e[4]]}},{}],26:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0;var f=r(e(24)),l=r(e(21));function r(e){return e&&e.__esModule?e:{default:e}}let d,p,h=0,v=0;n.default=function(e,t,n){var r=t&&n||0;const o=t||[];let i=(e=e||{}).node||d,a=void 0!==e.clockseq?e.clockseq:p;null!=i&&null!=a||(c=e.random||(e.rng||f.default)(),null==i&&(i=d=[1|c[0],c[1],c[2],c[3],c[4],c[5]]),null==a&&(a=p=16383&(c[6]<<8|c[7])));let s=void 0!==e.msecs?e.msecs:Date.now(),u=void 0!==e.nsecs?e.nsecs:v+1;var c=s-h+(u-v)/1e4;if(c<0&&void 0===e.clockseq&&(a=a+1&16383),(c<0||s>h)&&void 0===e.nsecs&&(u=0),1e4<=u)throw new Error(\"uuid.v1(): Can't create more than 10M uuids/sec\");h=s,v=u,p=a,s+=122192928e5,e=(1e4*(268435455&s)+u)%4294967296,o[r++]=e>>>24&255,o[r++]=e>>>16&255,o[r++]=e>>>8&255,o[r++]=255&e,e=s/4294967296*1e4&268435455,o[r++]=e>>>8&255,o[r++]=255&e,o[r++]=e>>>24&15|16,o[r++]=e>>>16&255,o[r++]=a>>>8|128,o[r++]=255&a;for(let e=0;e<6;++e)o[r+e]=i[e];return t||(0,l.default)(o)}},{21:21,24:24}],27:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0;var r=o(e(28)),e=o(e(23));function o(e){return e&&e.__esModule?e:{default:e}}e=(0,r.default)(\"v3\",48,e.default);n.default=e},{23:23,28:28}],28:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=function(e,a,s){function t(e,t,n,r){var o=n&&r||0;if(\"string\"==typeof e&&(e=function(t){t=unescape(encodeURIComponent(t));const n=[];for(let e=0;e<t.length;++e)n.push(t.charCodeAt(e));return n}(e)),\"string\"==typeof t&&(t=function(e){const t=[];return e.replace(/[a-fA-F0-9]{2}/g,function(e){t.push(parseInt(e,16))}),t}(t)),!Array.isArray(e))throw TypeError(\"value must be an array of bytes\");if(!Array.isArray(t)||16!==t.length)throw TypeError(\"namespace must be uuid string or an Array of 16 byte values\");const i=s(t.concat(e));if(i[6]=15&i[6]|a,i[8]=63&i[8]|128,n)for(let e=0;e<16;++e)n[o+e]=i[e];return n||(0,u.default)(i)}try{t.name=e}catch(e){}return t.DNS=r,t.URL=o,t},n.URL=n.DNS=void 0;var u=(e=e(21))&&e.__esModule?e:{default:e};const r=\"6ba7b810-9dad-11d1-80b4-00c04fd430c8\";n.DNS=r;const o=\"6ba7b811-9dad-11d1-80b4-00c04fd430c8\";n.URL=o},{21:21}],29:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0;var i=r(e(24)),a=r(e(21));function r(e){return e&&e.__esModule?e:{default:e}}n.default=function(e,t,n){\"string\"==typeof e&&(t=\"binary\"===e?new Uint8Array(16):null,e=null);const r=(e=e||{}).random||(e.rng||i.default)();if(r[6]=15&r[6]|64,r[8]=63&r[8]|128,t){var o=n||0;for(let e=0;e<16;++e)t[o+e]=r[e];return t}return(0,a.default)(r)}},{21:21,24:24}],30:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0}),n.default=void 0;var r=o(e(28)),e=o(e(25));function o(e){return e&&e.__esModule?e:{default:e}}e=(0,r.default)(\"v5\",80,e.default);n.default=e},{25:25,28:28}],31:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var l=e(40),a=e(52),s=e(39),h=e(38),v=e(96),y=e(97);function r(e){return e.reduce(function(e,t){return e[t]=!0,e},{})}var d=r([\"_id\",\"_rev\",\"_attachments\",\"_deleted\",\"_revisions\",\"_revs_info\",\"_conflicts\",\"_deleted_conflicts\",\"_local_seq\",\"_rev_tree\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\",\"_removed\"]),p=r([\"_attachments\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\"]);function _(e){if(!/^\\d+-/.test(e))return v.createError(v.INVALID_REV);var t=e.indexOf(\"-\"),n=e.substring(0,t),t=e.substring(t+1);return{prefix:parseInt(n,10),id:t}}function m(e,t,n){var r,o,i;n=n||{deterministic_revs:!0};var a={status:\"available\"};if(e._deleted&&(a.deleted=!0),t)if(e._id||(e._id=l.uuid()),o=l.rev(e,n.deterministic_revs),e._rev){if((i=_(e._rev)).error)return i;e._rev_tree=[{pos:i.prefix,ids:[i.id,{status:\"missing\"},[[o,a,[]]]]}],r=i.prefix+1}else e._rev_tree=[{pos:1,ids:[o,a,[]]}],r=1;else if(e._revisions&&(e._rev_tree=function(e,t){for(var n=e.start-e.ids.length+1,r=e.ids,o=[r[0],t,[]],i=1,a=r.length;i<a;i++)o=[r[i],{status:\"missing\"},[o]];return[{pos:n,ids:o}]}(e._revisions,a),r=e._revisions.start,o=e._revisions.ids[0]),!e._rev_tree){if((i=_(e._rev)).error)return i;r=i.prefix,o=i.id,e._rev_tree=[{pos:r,ids:[o,a,[]]}]}l.invalidIdError(e._id),e._rev=r+\"-\"+o;var s,u={metadata:{},data:{}};for(s in e)if(Object.prototype.hasOwnProperty.call(e,s)){var c=\"_\"===s[0];if(c&&!d[s]){var f=v.createError(v.DOC_VALIDATION,s);throw f.message=v.DOC_VALIDATION.message+\": \"+s,f}c&&!p[s]?u.metadata[s.slice(1)]=e[s]:u.data[s]=e[s]}return u}function u(t,e,n){var r=function(e){try{return a.atob(e)}catch(e){return{error:v.createError(v.BAD_ARG,\"Attachment is not a valid base64 string\")}}}(t.data);if(r.error)return n(r.error);t.length=r.length,t.data=\"blob\"===e?a.binaryStringToBlobOrBuffer(r,t.content_type):\"base64\"===e?a.btoa(r):r,s.binaryMd5(r,function(e){t.digest=\"md5-\"+e,n()})}function c(e,t,n){if(e.stub)return n();var r,o,i;\"string\"==typeof e.data?u(e,t,n):(r=e,o=t,i=n,s.binaryMd5(r.data,function(e){r.digest=\"md5-\"+e,r.length=r.data.size||r.data.length||0,\"binary\"===o?a.blobOrBufferToBinaryString(r.data,function(e){r.data=e,i()}):\"base64\"===o?a.blobOrBufferToBase64(r.data,function(e){r.data=e,i()}):i()}))}function g(e,t,n,r,o,i,a,s){if(y.revExists(t.rev_tree,n.metadata.rev)&&!s)return r[o]=n,i();var u=t.winningRev||y.winningRev(t),c=\"deleted\"in t?t.deleted:y.isDeleted(t,u),f=\"deleted\"in n.metadata?n.metadata.deleted:y.isDeleted(n.metadata),l=/^1-/.test(n.metadata.rev);c&&!f&&s&&l&&((l=n.data)._rev=u,l._id=n.metadata.id,n=m(l,s));e=y.merge(t.rev_tree,n.metadata.rev_tree[0],e);if(s&&(c&&f&&\"new_leaf\"!==e.conflicts||!c&&\"new_leaf\"!==e.conflicts||c&&!f&&\"new_branch\"===e.conflicts)){var d=v.createError(v.REV_CONFLICT);return r[o]=d,i()}var d=n.metadata.rev;n.metadata.rev_tree=e.tree,n.stemmedRevs=e.stemmedRevs||[],t.rev_map&&(n.metadata.rev_map=t.rev_map);e=y.winningRev(n.metadata),t=y.isDeleted(n.metadata,e),c=c===t?0:c<t?-1:1,d=d===e?t:y.isDeleted(n.metadata,d);a(n,e,t,d,!0,c,o,i)}n.invalidIdError=l.invalidIdError,n.normalizeDdocFunctionName=l.normalizeDdocFunctionName,n.parseDdocFunctionName=l.parseDdocFunctionName,n.isDeleted=y.isDeleted,n.isLocalId=y.isLocalId,n.allDocsKeysQuery=function(e,i){var t=i.keys,a={offset:i.skip};return Promise.all(t.map(function(o){var t=l.assign({key:o,deleted:\"ok\"},i);return[\"limit\",\"skip\",\"keys\"].forEach(function(e){delete t[e]}),new Promise(function(n,r){e._allDocs(t,function(e,t){return e?r(e):(i.update_seq&&void 0!==t.update_seq&&(a.update_seq=t.update_seq),a.total_rows=t.total_rows,void n(t.rows[0]||{key:o,error:\"not_found\"}))})})})).then(function(e){return a.rows=e,a})},n.parseDoc=m,n.preprocessAttachments=function(e,i,t){if(!e.length)return t();var a,n=0;function s(){n++,e.length===n&&(a?t(a):t())}e.forEach(function(e){var t,n=e.data&&e.data._attachments?Object.keys(e.data._attachments):[],r=0;if(!n.length)return s();function o(e){a=e,++r===n.length&&s()}for(t in e.data._attachments)e.data._attachments.hasOwnProperty(t)&&c(e.data._attachments[t],i,o)})},n.processDocs=function(s,e,r,u,o,c,f,l,t){s=s||1e3;var d=l.new_edits,i=new h.Map,n=0,a=e.length;function p(){++n===a&&t&&t()}e.forEach(function(e,n){var t;e._id&&y.isLocalId(e._id)?(t=e._deleted?\"_removeLocal\":\"_putLocal\",r[t](e,{ctx:o},function(e,t){c[n]=e||t,p()})):(t=e.metadata.id,i.has(t)?(a--,i.get(t).push([e,n])):i.set(t,[[e,n]]))}),i.forEach(function(r,o){var i=0;function a(){(++i<r.length?e:p)()}function e(){var e=r[i],t=e[0],n=e[1];u.has(o)?g(s,u.get(o),t,c,n,a,f,d):(e=y.merge([],t.metadata.rev_tree[0],s),t.metadata.rev_tree=e.tree,t.stemmedRevs=e.stemmedRevs||[],function(e,t,n){var r=y.winningRev(e.metadata),o=y.isDeleted(e.metadata,r);if(\"was_delete\"in l&&o)return c[t]=v.createError(v.MISSING_DOC,\"deleted\"),n();if(d&&\"missing\"===e.metadata.rev_tree[0].ids[1].status){var i=v.createError(v.REV_CONFLICT);return c[t]=i,n()}f(e,r,o,o,!1,o?0:1,t,n)}(t,n,a))}e()})},n.updateDoc=g},{38:38,39:39,40:40,52:52,96:96,97:97}],32:[function(e,t,n){arguments[4][11][0].apply(n,arguments)},{11:11,33:33,34:34,35:35,36:36,37:37,7:7}],33:[function(e,t,n){arguments[4][12][0].apply(n,arguments)},{12:12}],34:[function(e,t,n){arguments[4][13][0].apply(n,arguments)},{13:13}],35:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14}],36:[function(e,t,n){arguments[4][15][0].apply(n,arguments)},{15:15}],37:[function(e,t,n){arguments[4][16][0].apply(n,arguments)},{16:16}],38:[function(e,t,n){arguments[4][17][0].apply(n,arguments)},{17:17}],39:[function(e,t,n){arguments[4][18][0].apply(n,arguments)},{18:18,41:41,52:52}],40:[function(e,t,n){arguments[4][19][0].apply(n,arguments)},{19:19,32:32,38:38,39:39,43:43,6:6,8:8,9:9,96:96}],41:[function(e,t,n){arguments[4][20][0].apply(n,arguments)},{20:20}],42:[function(e,t,n){arguments[4][21][0].apply(n,arguments)},{21:21}],43:[function(e,t,n){arguments[4][22][0].apply(n,arguments)},{22:22,47:47,48:48,50:50,51:51}],44:[function(e,t,n){arguments[4][23][0].apply(n,arguments)},{23:23}],45:[function(e,t,n){arguments[4][24][0].apply(n,arguments)},{24:24}],46:[function(e,t,n){arguments[4][25][0].apply(n,arguments)},{25:25}],47:[function(e,t,n){arguments[4][26][0].apply(n,arguments)},{26:26,42:42,45:45}],48:[function(e,t,n){arguments[4][27][0].apply(n,arguments)},{27:27,44:44,49:49}],49:[function(e,t,n){arguments[4][28][0].apply(n,arguments)},{28:28,42:42}],50:[function(e,t,n){arguments[4][29][0].apply(n,arguments)},{29:29,42:42,45:45}],51:[function(e,t,n){arguments[4][30][0].apply(n,arguments)},{30:30,46:46,49:49}],52:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});function r(e){return atob(e)}function o(e){return btoa(e)}function i(t,n){t=t||[],n=n||{};try{return new Blob(t,n)}catch(e){if(\"TypeError\"!==e.name)throw e;for(var r=new(\"undefined\"!=typeof BlobBuilder?BlobBuilder:\"undefined\"!=typeof MSBlobBuilder?MSBlobBuilder:\"undefined\"!=typeof MozBlobBuilder?MozBlobBuilder:WebKitBlobBuilder),o=0;o<t.length;o+=1)r.append(t[o]);return r.getBlob(n.type)}}function a(e){for(var t=e.length,n=new ArrayBuffer(t),r=new Uint8Array(n),o=0;o<t;o++)r[o]=e.charCodeAt(o);return n}function s(e,t){return i([a(e)],{type:t})}function u(e,t){var n=new FileReader,r=\"function\"==typeof n.readAsBinaryString;n.onloadend=function(e){e=e.target.result||\"\";if(r)return t(e);t(function(e){for(var t=\"\",n=new Uint8Array(e),r=n.byteLength,o=0;o<r;o++)t+=String.fromCharCode(n[o]);return t}(e))},r?n.readAsBinaryString(e):n.readAsArrayBuffer(e)}function c(e,t){u(e,function(e){t(e)})}n.atob=r,n.btoa=o,n.base64StringToBlobOrBuffer=function(e,t){return s(r(e),t)},n.binaryStringToArrayBuffer=a,n.binaryStringToBlobOrBuffer=s,n.blob=i,n.blobOrBufferToBase64=function(e,t){c(e,function(e){t(o(e))})},n.blobOrBufferToBinaryString=c,n.readAsArrayBuffer=function(e,t){var n=new FileReader;n.onloadend=function(e){e=e.target.result||new ArrayBuffer(0);t(e)},n.readAsArrayBuffer(e)},n.readAsBinaryString=u,n.typedBuffer=function(){}},{}],53:[function(e,t,n){\"use strict\";var s=e(96),u=e(98),c=e(62);function r(e,t){if(e.selector&&e.filter&&\"_selector\"!==e.filter){e=\"string\"==typeof e.filter?e.filter:\"function\";return t(new Error('selector invalid for filter \"'+e+'\"'))}t()}function o(e){e.view&&!e.filter&&(e.filter=\"_view\"),e.selector&&!e.filter&&(e.filter=\"_selector\"),e.filter&&\"string\"==typeof e.filter&&(\"_view\"===e.filter?e.view=c.normalizeDdocFunctionName(e.view):e.filter=c.normalizeDdocFunctionName(e.filter))}function i(e,t){return t.filter&&\"string\"==typeof t.filter&&!t.doc_ids&&!c.isRemote(e.db)}function a(n,r){var o,i=r.complete;if(\"_view\"===r.filter){if(!r.view||\"string\"!=typeof r.view){var e=s.createError(s.BAD_REQUEST,\"`view` filter parameter not found or invalid.\");return i(e)}var a=c.parseDdocFunctionName(r.view);n.db.get(\"_design/\"+a[0],function(e,t){if(n.isCancelled)return i(null,{status:\"cancelled\"});if(e)return i(s.generateErrorFromResponse(e));var e=t&&t.views&&t.views[a[1]]&&t.views[a[1]].map;if(!e)return i(s.createError(s.MISSING_DOC,t.views?\"missing json key: \"+a[1]:\"missing json key: views\"));r.filter=(e=[\"return function(doc) {\",'  \"use strict\";',\"  var emitted = false;\",\"  var emit = function (a, b) {\",\"    emitted = true;\",\"  };\",\"  var view = \"+(e=e)+\";\",\"  view(doc);\",\"  if (emitted) {\",\"    return true;\",\"  }\",\"};\"].join(\"\\n\"),c.scopeEval(e,{})),n.doChanges(r)})}else r.selector?(r.filter=function(e){return u.matchesSelector(e,r.selector)},n.doChanges(r)):(o=c.parseDdocFunctionName(r.filter),n.db.get(\"_design/\"+o[0],function(e,t){if(n.isCancelled)return i(null,{status:\"cancelled\"});if(e)return i(s.generateErrorFromResponse(e));e=t&&t.filters&&t.filters[o[1]];if(!e)return i(s.createError(s.MISSING_DOC,t&&t.filters?\"missing json key: \"+o[1]:\"missing json key: filters\"));r.filter=c.scopeEval('\"use strict\";\\nreturn '+e+\";\",{}),n.doChanges(r)}))}t.exports=function(e){e._changesFilterPlugin={validate:r,normalize:o,shouldFilter:i,filter:a}}},{62:62,96:96,98:98}],54:[function(e,t,n){arguments[4][11][0].apply(n,arguments)},{11:11,55:55,56:56,57:57,58:58,59:59,7:7}],55:[function(e,t,n){arguments[4][12][0].apply(n,arguments)},{12:12}],56:[function(e,t,n){arguments[4][13][0].apply(n,arguments)},{13:13}],57:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14}],58:[function(e,t,n){arguments[4][15][0].apply(n,arguments)},{15:15}],59:[function(e,t,n){arguments[4][16][0].apply(n,arguments)},{16:16}],60:[function(e,t,n){arguments[4][17][0].apply(n,arguments)},{17:17}],61:[function(e,t,n){arguments[4][18][0].apply(n,arguments)},{18:18,52:52,63:63}],62:[function(e,t,n){arguments[4][19][0].apply(n,arguments)},{19:19,54:54,6:6,60:60,61:61,65:65,8:8,9:9,96:96}],63:[function(e,t,n){arguments[4][20][0].apply(n,arguments)},{20:20}],64:[function(e,t,n){arguments[4][21][0].apply(n,arguments)},{21:21}],65:[function(e,t,n){arguments[4][22][0].apply(n,arguments)},{22:22,69:69,70:70,72:72,73:73}],66:[function(e,t,n){arguments[4][23][0].apply(n,arguments)},{23:23}],67:[function(e,t,n){arguments[4][24][0].apply(n,arguments)},{24:24}],68:[function(e,t,n){arguments[4][25][0].apply(n,arguments)},{25:25}],69:[function(e,t,n){arguments[4][26][0].apply(n,arguments)},{26:26,64:64,67:67}],70:[function(e,t,n){arguments[4][27][0].apply(n,arguments)},{27:27,66:66,71:71}],71:[function(e,t,n){arguments[4][28][0].apply(n,arguments)},{28:28,64:64}],72:[function(e,t,n){arguments[4][29][0].apply(n,arguments)},{29:29,64:64,67:67}],73:[function(e,t,n){arguments[4][30][0].apply(n,arguments)},{30:30,68:68,71:71}],74:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}var i=e(81),a=r(e(6)),w=e(97),u=e(96),c=e(84),o=r(e(9)),s=r(e(8)),f=e(82),e=r(e(53));function l(n,t,r){s.call(this);var o=this;this.db=n;var i=(t=t?c.clone(t):{}).complete=c.once(function(e,t){e?0<c.listenerCount(o,\"error\")&&o.emit(\"error\",e):o.emit(\"complete\",t),o.removeAllListeners(),n.removeListener(\"destroyed\",a)});function a(){o.cancel()}r&&(o.on(\"complete\",function(e){r(null,e)}),o.on(\"error\",r)),n.once(\"destroyed\",a),t.onChange=function(e,t,n){o.isCancelled||function(e,t,n,r){try{e.emit(\"change\",t,n,r)}catch(e){c.guardedConsole(\"error\",'Error in .on(\"change\", function):',e)}}(o,e,t,n)};var e=new Promise(function(n,r){t.complete=function(e,t){e?r(e):n(t)}});o.once(\"cancel\",function(){n.removeListener(\"destroyed\",a),t.complete(null,{status:\"cancelled\"})}),this.then=e.then.bind(e),this.catch=e.catch.bind(e),this.then(function(e){i(null,e)},i),n.taskqueue.isReady?o.validateChanges(t):n.taskqueue.addTask(function(e){e?t.complete(e):o.isCancelled?o.emit(\"cancel\"):o.validateChanges(t)})}function d(e,t,n){var r=[{rev:e._rev}];\"all_docs\"===n.style&&(r=w.collectLeaves(t.rev_tree).map(function(e){return{rev:e.rev}}));r={id:t.id,changes:r,doc:e};return w.isDeleted(t,e._rev)&&(r.deleted=!0),n.conflicts&&(r.doc._conflicts=w.collectConflicts(t),r.doc._conflicts.length||delete r.doc._conflicts),r}function p(e,t){return e<t?-1:t<e?1:0}function h(n,r){return function(e,t){e||t[0]&&t[0].error?((e=e||t[0]).docId=r,n(e)):n(null,t.length?t[0]:t)}}function v(e,t){var n=p(e._id,t._id);return 0!==n?n:p(e._revisions?e._revisions.start:0,t._revisions?t._revisions.start:0)}function y(){for(var e in s.call(this),y.prototype)\"function\"==typeof this[e]&&(this[e]=this[e].bind(this))}function _(){this.isReady=!1,this.failed=!1,this.queue=[]}function m(e,t){if(!(this instanceof m))return new m(e,t);var o=this;if(t=t||{},e&&\"object\"==typeof e&&(e=(t=e).name,delete t.name),void 0===t.deterministic_revs&&(t.deterministic_revs=!0),this.__opts=t=c.clone(t),o.auto_compaction=t.auto_compaction,o.prefix=m.prefix,\"string\"!=typeof e)throw new Error(\"Missing/invalid DB name\");var n=function(e,t){var n=e.match(/([a-z-]*):\\/\\/(.*)/);if(n)return{name:/https?/.test(n[1])?n[1]+\"://\"+n[2]:n[2],adapter:n[1]};var r=m.adapters,o=m.preferredAdapters,i=m.prefix,a=t.adapter;if(!a)for(var s=0;s<o.length&&(\"idb\"===(a=o[s])&&\"websql\"in r&&c.hasLocalStorage()&&localStorage[\"_pouch__websqldb_\"+i+e]);++s)c.guardedConsole(\"log\",'PouchDB is downgrading \"'+e+'\" to WebSQL to avoid data loss, because it was already opened with WebSQL.');return{name:!((t=r[a])&&\"use_prefix\"in t)||t.use_prefix?i+e:e,adapter:a}}((t.prefix||\"\")+e,t);if(t.name=n.name,t.adapter=t.adapter||n.adapter,o.name=e,o._adapter=t.adapter,m.emit(\"debug\",[\"adapter\",\"Picked adapter: \",t.adapter]),!m.adapters[t.adapter]||!m.adapters[t.adapter].valid())throw new Error(\"Invalid Adapter: \"+t.adapter);y.call(o),o.taskqueue=new _,o.adapter=t.adapter,m.adapters[t.adapter].call(o,t,function(e){return e?o.taskqueue.fail(e):((r=o).once(\"destroyed\",t),r.once(\"closed\",n),r.constructor.emit(\"ref\",r),o.emit(\"created\",o),m.emit(\"created\",o.name),void o.taskqueue.ready(o));function t(e){r.removeListener(\"closed\",n),e||r.constructor.emit(\"destroyed\",r.name)}function n(){r.removeListener(\"destroyed\",t),r.constructor.emit(\"unref\",r)}var r})}o(l,s),l.prototype.cancel=function(){this.isCancelled=!0,this.db.taskqueue.isReady&&this.emit(\"cancel\")},l.prototype.validateChanges=function(t){var n=t.complete,r=this;m._changesFilterPlugin?m._changesFilterPlugin.validate(t,function(e){return e?n(e):void r.doChanges(t)}):r.doChanges(t)},l.prototype.doChanges=function(t){var n=this,r=t.complete;if(\"live\"in(t=c.clone(t))&&!(\"continuous\"in t)&&(t.continuous=t.live),t.processChange=d,\"latest\"===t.since&&(t.since=\"now\"),t.since||(t.since=0),\"now\"!==t.since){if(m._changesFilterPlugin){if(m._changesFilterPlugin.normalize(t),m._changesFilterPlugin.shouldFilter(this,t))return m._changesFilterPlugin.filter(this,t)}else[\"doc_ids\",\"filter\",\"selector\",\"view\"].forEach(function(e){e in t&&c.guardedConsole(\"warn\",'The \"'+e+'\" option was passed in to changes/replicate, but pouchdb-changes-filter plugin is not installed, so it was ignored. Please install the plugin to enable filtering.')});\"descending\"in t||(t.descending=!1),t.limit=0===t.limit?1:t.limit,t.complete=r;var o,i=this.db._changes(t);i&&\"function\"==typeof i.cancel&&(o=n.cancel,n.cancel=a(function(e){i.cancel(),o.apply(this,e)}))}else this.db.info().then(function(e){n.isCancelled?r(null,{status:\"cancelled\"}):(t.since=e.update_seq,n.doChanges(t))},r)},o(y,s),y.prototype.post=c.adapterFun(\"post\",function(e,t,n){return\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e)?n(u.createError(u.NOT_AN_OBJECT)):void this.bulkDocs({docs:[e]},t,h(n,e._id))}),y.prototype.put=c.adapterFun(\"put\",function(n,t,r){if(\"function\"==typeof t&&(r=t,t={}),\"object\"!=typeof n||Array.isArray(n))return r(u.createError(u.NOT_AN_OBJECT));if(c.invalidIdError(n._id),w.isLocalId(n._id)&&\"function\"==typeof this._putLocal)return n._deleted?this._removeLocal(n,r):this._putLocal(n,r);var e,o,i,a=this;function s(e){\"function\"==typeof a._put&&!1!==t.new_edits?a._put(n,t,e):a.bulkDocs({docs:[n]},t,h(e,n._id))}t.force&&n._rev?(e=n._rev.split(\"-\"),o=e[1],i=parseInt(e[0],10)+1,e=c.rev(),n._revisions={start:i,ids:[e,o]},n._rev=i+\"-\"+e,t.new_edits=!1,s(function(e){var t=e?null:{ok:!0,id:n._id,rev:n._rev};r(e,t)})):s(r)}),y.prototype.putAttachment=c.adapterFun(\"putAttachment\",function(t,n,r,o,i){var a=this;function s(e){var t=\"_rev\"in e?parseInt(e._rev,10):0;return e._attachments=e._attachments||{},e._attachments[n]={content_type:i,data:o,revpos:++t},a.put(e)}return\"function\"==typeof i&&(i=o,o=r,r=null),void 0===i&&(i=o,o=r,r=null),i||c.guardedConsole(\"warn\",\"Attachment\",n,\"on document\",t,\"is missing content_type\"),a.get(t).then(function(e){if(e._rev!==r)throw u.createError(u.REV_CONFLICT);return s(e)},function(e){if(e.reason===u.MISSING_DOC.message)return s({_id:t});throw e})}),y.prototype.removeAttachment=c.adapterFun(\"removeAttachment\",function(e,n,r,o){var i=this;i.get(e,function(e,t){if(e)o(e);else if(t._rev===r){if(!t._attachments)return o();delete t._attachments[n],0===Object.keys(t._attachments).length&&delete t._attachments,i.put(t,o)}else o(u.createError(u.REV_CONFLICT))})}),y.prototype.remove=c.adapterFun(\"remove\",function(e,t,n,r){var o;\"string\"==typeof t?(o={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(o=e,n=\"function\"==typeof t?(r=t,{}):(r=n,t)),(n=n||{}).was_delete=!0;t={_id:o._id,_rev:o._rev||n.rev,_deleted:!0};if(w.isLocalId(t._id)&&\"function\"==typeof this._removeLocal)return this._removeLocal(o,r);this.bulkDocs({docs:[t]},n,h(r,t._id))}),y.prototype.revsDiff=c.adapterFun(\"revsDiff\",function(o,e,s){\"function\"==typeof e&&(s=e,e={});var u=Object.keys(o);if(!u.length)return s(null,{});var c=0,f=new i.Map;function l(e,t){f.has(e)||f.set(e,{missing:[]}),f.get(e).missing.push(t)}u.map(function(r){this._getRevisionTree(r,function(e,t){if(e&&404===e.status&&\"missing\"===e.message)f.set(r,{missing:o[r]});else{if(e)return s(e);t=t,a=o[i=r].slice(0),w.traverseRevTree(t,function(e,t,n,r,o){t=t+\"-\"+n,n=a.indexOf(t);-1!==n&&(a.splice(n,1),\"available\"!==o.status&&l(i,t))}),a.forEach(function(e){l(i,e)})}var i,a;if(++c===u.length){var n={};return f.forEach(function(e,t){n[t]=e}),s(null,n)}})},this)}),y.prototype.bulkGet=c.adapterFun(\"bulkGet\",function(e,t){c.bulkGetShim(this,e,t)}),y.prototype.compactDocument=c.adapterFun(\"compactDocument\",function(r,u,c){var f=this;this._getRevisionTree(r,function(e,t){if(e)return c(e);var o,i,n=(o={},i=[],w.traverseRevTree(t,function(e,t,n,r){n=t+\"-\"+n;return e&&(o[n]=0),void 0!==r&&i.push({from:r,to:n}),n}),i.reverse(),i.forEach(function(e){void 0===o[e.from]?o[e.from]=1+o[e.to]:o[e.from]=Math.min(o[e.from],1+o[e.to])}),o),a=[],s=[];Object.keys(n).forEach(function(e){n[e]>u&&a.push(e)}),w.traverseRevTree(t,function(e,t,n,r,o){n=t+\"-\"+n;\"available\"===o.status&&-1!==a.indexOf(n)&&s.push(n)}),f._doCompaction(r,s,c)})}),y.prototype.compact=c.adapterFun(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={});var n=this;e=e||{},n._compactionQueue=n._compactionQueue||[],n._compactionQueue.push({opts:e,callback:t}),1===n._compactionQueue.length&&function n(r){var e=r._compactionQueue[0],t=e.opts,o=e.callback;r.get(\"_local/compaction\").catch(function(){return!1}).then(function(e){e&&e.last_seq&&(t.last_seq=e.last_seq),r._compact(t,function(e,t){e?o(e):o(null,t),c.nextTick(function(){r._compactionQueue.shift(),r._compactionQueue.length&&n(r)})})})}(n)}),y.prototype._compact=function(e,n){var r=this,e={return_docs:!1,last_seq:e.last_seq||0},o=[];r.changes(e).on(\"change\",function(e){o.push(r.compactDocument(e.id,0))}).on(\"complete\",function(e){var t=e.last_seq;Promise.all(o).then(function(){return c.upsert(r,\"_local/compaction\",function(e){return(!e.last_seq||e.last_seq<t)&&(e.last_seq=t,e)})}).then(function(){n(null,{ok:!0})}).catch(n)}).on(\"error\",n)},y.prototype.get=c.adapterFun(\"get\",function(_,m,g){if(\"function\"==typeof m&&(g=m,m={}),\"string\"!=typeof _)return g(u.createError(u.INVALID_ID));if(w.isLocalId(_)&&\"function\"==typeof this._getLocal)return this._getLocal(_,g);var n=[],b=this;function r(){var a=[],s=n.length;if(!s)return g(null,a);n.forEach(function(i){b.get(_,{rev:i,revs:m.revs,latest:m.latest,attachments:m.attachments,binary:m.binary},function(e,t){if(e)a.push({missing:i});else{for(var n,r=0,o=a.length;r<o;r++)if(a[r].ok&&a[r].ok._rev===t._rev){n=!0;break}n||a.push({ok:t})}--s||g(null,a)})})}if(!m.open_revs)return this._get(_,m,function(e,t){if(e)return e.docId=_,g(e);var o=t.doc,n=t.metadata,i=t.ctx;if(!m.conflicts||(r=w.collectConflicts(n)).length&&(o._conflicts=r),w.isDeleted(n,o._rev)&&(o._deleted=!0),m.revs||m.revs_info){for(var r=o._rev.split(\"-\"),a=parseInt(r[0],10),s=r[1],u=w.rootToLeaf(n.rev_tree),c=null,f=0;f<u.length;f++){var l=u[f],d=l.ids.map(function(e){return e.id}).indexOf(s);(d===a-1||!c&&-1!==d)&&(c=l)}if(!c)return(e=new Error(\"invalid rev tree\")).docId=_,g(e);var p,n=c.ids.map(function(e){return e.id}).indexOf(o._rev.split(\"-\")[1])+1,e=c.ids.length-n;c.ids.splice(n,e),c.ids.reverse(),m.revs&&(o._revisions={start:c.pos+c.ids.length-1,ids:c.ids.map(function(e){return e.id})}),m.revs_info&&(p=c.pos+c.ids.length,o._revs_info=c.ids.map(function(e){return{rev:--p+\"-\"+e.id,status:e.opts.status}}))}if(m.attachments&&o._attachments){var h=o._attachments,v=Object.keys(h).length;if(0===v)return g(null,o);Object.keys(h).forEach(function(r){this._getAttachment(o._id,r,h[r],{rev:o._rev,binary:m.binary,ctx:i},function(e,t){var n=o._attachments[r];n.data=t,delete n.stub,delete n.length,--v||g(null,o)})},b)}else{if(o._attachments)for(var y in o._attachments)o._attachments.hasOwnProperty(y)&&(o._attachments[y].stub=!0);g(null,o)}});if(\"all\"===m.open_revs)this._getRevisionTree(_,function(e,t){return e?g(e):(n=w.collectLeaves(t).map(function(e){return e.rev}),void r())});else{if(!Array.isArray(m.open_revs))return g(u.createError(u.UNKNOWN_ERROR,\"function_clause\"));for(var n=m.open_revs,e=0;e<n.length;e++){var t=n[e];if(\"string\"!=typeof t||!/^\\d+-/.test(t))return g(u.createError(u.INVALID_REV))}r()}}),y.prototype.getAttachment=c.adapterFun(\"getAttachment\",function(n,r,o,i){var a=this;o instanceof Function&&(i=o,o={}),this._get(n,o,function(e,t){return e?i(e):t.doc._attachments&&t.doc._attachments[r]?(o.ctx=t.ctx,o.binary=!0,void a._getAttachment(n,r,t.doc._attachments[r],o,i)):i(u.createError(u.MISSING_DOC))})}),y.prototype.allDocs=c.adapterFun(\"allDocs\",function(t,e){if(\"function\"==typeof t&&(e=t,t={}),t.skip=void 0!==t.skip?t.skip:0,t.start_key&&(t.startkey=t.start_key),t.end_key&&(t.endkey=t.end_key),\"keys\"in t){if(!Array.isArray(t.keys))return e(new TypeError(\"options.keys must be an array\"));var n=[\"startkey\",\"endkey\",\"key\"].filter(function(e){return e in t})[0];if(n)return void e(u.createError(u.QUERY_PARSE_ERROR,\"Query parameter `\"+n+\"` is not compatible with multi-get\"));if(!c.isRemote(this)&&(n=\"limit\"in(r=t)?r.keys.slice(r.skip,r.limit+r.skip):0<r.skip?r.keys.slice(r.skip):r.keys,r.keys=n,r.skip=0,delete r.limit,r.descending&&(n.reverse(),r.descending=!1),0===t.keys.length))return this._allDocs({limit:0},e)}var r;return this._allDocs(t,e)}),y.prototype.changes=function(e,t){return\"function\"==typeof e&&(t=e,e={}),(e=e||{}).return_docs=\"return_docs\"in e?e.return_docs:!e.live,new l(this,e,t)},y.prototype.close=c.adapterFun(\"close\",function(e){return this._closed=!0,this.emit(\"closed\"),this._close(e)}),y.prototype.info=c.adapterFun(\"info\",function(n){var r=this;this._info(function(e,t){return e?n(e):(t.db_name=t.db_name||r.name,t.auto_compaction=!(!r.auto_compaction||c.isRemote(r)),t.adapter=r.adapter,void n(null,t))})}),y.prototype.id=c.adapterFun(\"id\",function(e){return this._id(e)}),y.prototype.type=function(){return\"function\"==typeof this._type?this._type():this.adapter},y.prototype.bulkDocs=c.adapterFun(\"bulkDocs\",function(e,o,i){if(\"function\"==typeof o&&(i=o,o={}),o=o||{},!(e=Array.isArray(e)?{docs:e}:e)||!e.docs||!Array.isArray(e.docs))return i(u.createError(u.MISSING_BULK_DOCS));for(var r,t=0;t<e.docs.length;++t)if(\"object\"!=typeof e.docs[t]||Array.isArray(e.docs[t]))return i(u.createError(u.NOT_AN_OBJECT));if(e.docs.forEach(function(n){n._attachments&&Object.keys(n._attachments).forEach(function(e){var t;r=r||\"_\"===(t=e).charAt(0)&&t+\" is not a valid attachment name, attachment names cannot start with '_'\",n._attachments[e].content_type||c.guardedConsole(\"warn\",\"Attachment\",e,\"on document\",n._id,\"is missing content_type\")})}),r)return i(u.createError(u.BAD_REQUEST,r));\"new_edits\"in o||(\"new_edits\"in e?o.new_edits=e.new_edits:o.new_edits=!0);var a=this;o.new_edits||c.isRemote(a)||e.docs.sort(v),function(e){for(var t=0;t<e.length;t++){var n=e[t];if(n._deleted)delete n._attachments;else if(n._attachments)for(var r=Object.keys(n._attachments),o=0;o<r.length;o++){var i=r[o];n._attachments[i]=c.pick(n._attachments[i],[\"data\",\"digest\",\"content_type\",\"length\",\"revpos\",\"stub\"])}}}(e.docs);var s=e.docs.map(function(e){return e._id});return this._bulkDocs(e,o,function(e,t){if(e)return i(e);if(o.new_edits||(t=t.filter(function(e){return e.error})),!c.isRemote(a))for(var n=0,r=t.length;n<r;n++)t[n].id=t[n].id||s[n];i(null,t)})}),y.prototype.registerDependentDatabase=c.adapterFun(\"registerDependentDatabase\",function(t,e){var n=new this.constructor(t,this.__opts);c.upsert(this,\"_local/_pouch_dependentDbs\",function(e){return e.dependentDbs=e.dependentDbs||{},!e.dependentDbs[t]&&(e.dependentDbs[t]=!0,e)}).then(function(){e(null,{db:n})}).catch(e)}),y.prototype.destroy=c.adapterFun(\"destroy\",function(e,r){\"function\"==typeof e&&(r=e,e={});var o=this,i=!(\"use_prefix\"in o)||o.use_prefix;function a(){o._destroy(e,function(e,t){return e?r(e):(o._destroyed=!0,o.emit(\"destroyed\"),void r(null,t||{ok:!0}))})}if(c.isRemote(o))return a();o.get(\"_local/_pouch_dependentDbs\",function(e,t){if(e)return 404!==e.status?r(e):a();var t=t.dependentDbs,n=o.constructor,t=Object.keys(t).map(function(e){e=i?e.replace(new RegExp(\"^\"+n.prefix),\"\"):e;return new n(e,o.__opts).destroy()});Promise.all(t).then(a,r)})}),_.prototype.execute=function(){var e;if(this.failed)for(;e=this.queue.shift();)e(this.failed);else for(;e=this.queue.shift();)e()},_.prototype.fail=function(e){this.failed=e,this.execute()},_.prototype.ready=function(e){this.isReady=!0,this.db=e,this.execute()},_.prototype.addTask=function(e){this.queue.push(e),this.failed&&this.execute()},o(m,y),m.adapters={},m.preferredAdapters=[],m.prefix=\"_pouch_\";var g=new s;!function(t){Object.keys(s.prototype).forEach(function(e){\"function\"==typeof s.prototype[e]&&(t[e]=g[e].bind(g))});var r=t._destructionListeners=new i.Map;t.on(\"ref\",function(e){r.has(e.name)||r.set(e.name,[]),r.get(e.name).push(e)}),t.on(\"unref\",function(e){var t,n;r.has(e.name)&&((n=(t=r.get(e.name)).indexOf(e))<0||(t.splice(n,1),1<t.length?r.set(e.name,t):r.delete(e.name)))}),t.on(\"destroyed\",function(e){var t;r.has(e)&&(t=r.get(e),r.delete(e),t.forEach(function(e){e.emit(\"destroyed\",!0)}))})}(m),m.adapter=function(e,t,n){t.valid()&&(m.adapters[e]=t,n&&m.preferredAdapters.push(e))},m.plugin=function(t){if(\"function\"==typeof t)t(m);else{if(\"object\"!=typeof t||0===Object.keys(t).length)throw new Error('Invalid plugin: got \"'+t+'\", expected an object or a function');Object.keys(t).forEach(function(e){m.prototype[e]=t[e]})}return this.__defaults&&(m.__defaults=c.assign({},this.__defaults)),m},m.defaults=function(e){function n(e,t){if(!(this instanceof n))return new n(e,t);t=t||{},e&&\"object\"==typeof e&&(e=(t=e).name,delete t.name),t=c.assign({},n.__defaults,t),m.call(this,e,t)}return o(n,m),n.preferredAdapters=m.preferredAdapters.slice(),Object.keys(m).forEach(function(e){e in n||(n[e]=m[e])}),n.__defaults=c.assign({},this.__defaults,e),n},m.fetch=function(e,t){return f.fetch(e,t)};m.plugin(e),m.version=\"7.2.2\",t.exports=m},{53:53,6:6,8:8,81:81,82:82,84:84,9:9,96:96,97:97}],75:[function(e,t,n){arguments[4][11][0].apply(n,arguments)},{11:11,7:7,76:76,77:77,78:78,79:79,80:80}],76:[function(e,t,n){arguments[4][12][0].apply(n,arguments)},{12:12}],77:[function(e,t,n){arguments[4][13][0].apply(n,arguments)},{13:13}],78:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14}],79:[function(e,t,n){arguments[4][15][0].apply(n,arguments)},{15:15}],80:[function(e,t,n){arguments[4][16][0].apply(n,arguments)},{16:16}],81:[function(e,t,n){arguments[4][17][0].apply(n,arguments)},{17:17}],82:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var r=\"undefined\"!=typeof AbortController?AbortController:function(){return{abort:function(){}}},o=fetch,i=Headers;n.fetch=o,n.Headers=i,n.AbortController=r},{}],83:[function(e,t,n){arguments[4][18][0].apply(n,arguments)},{18:18,52:52,85:85}],84:[function(e,t,n){arguments[4][19][0].apply(n,arguments)},{19:19,6:6,75:75,8:8,81:81,83:83,87:87,9:9,96:96}],85:[function(e,t,n){arguments[4][20][0].apply(n,arguments)},{20:20}],86:[function(e,t,n){arguments[4][21][0].apply(n,arguments)},{21:21}],87:[function(e,t,n){arguments[4][22][0].apply(n,arguments)},{22:22,91:91,92:92,94:94,95:95}],88:[function(e,t,n){arguments[4][23][0].apply(n,arguments)},{23:23}],89:[function(e,t,n){arguments[4][24][0].apply(n,arguments)},{24:24}],90:[function(e,t,n){arguments[4][25][0].apply(n,arguments)},{25:25}],91:[function(e,t,n){arguments[4][26][0].apply(n,arguments)},{26:26,86:86,89:89}],92:[function(e,t,n){arguments[4][27][0].apply(n,arguments)},{27:27,88:88,93:93}],93:[function(e,t,n){arguments[4][28][0].apply(n,arguments)},{28:28,86:86}],94:[function(e,t,n){arguments[4][29][0].apply(n,arguments)},{29:29,86:86,89:89}],95:[function(e,t,n){arguments[4][30][0].apply(n,arguments)},{30:30,90:90,93:93}],96:[function(e,t,n){\"use strict\";function r(e,t,n){Error.call(this,n),this.status=e,this.name=t,this.message=n,this.error=!0}Object.defineProperty(n,\"__esModule\",{value:!0}),((k=e(9))&&\"object\"==typeof k&&\"default\"in k?k.default:k)(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var o=new r(401,\"unauthorized\",\"Name or password is incorrect.\"),i=new r(400,\"bad_request\",\"Missing JSON list of 'docs'\"),a=new r(404,\"not_found\",\"missing\"),s=new r(409,\"conflict\",\"Document update conflict\"),u=new r(400,\"bad_request\",\"_id field must contain a string\"),c=new r(412,\"missing_id\",\"_id is required for puts\"),f=new r(400,\"bad_request\",\"Only reserved document ids may start with underscore.\"),l=new r(412,\"precondition_failed\",\"Database not open\"),d=new r(500,\"unknown_error\",\"Database encountered an unknown error\"),p=new r(500,\"badarg\",\"Some query argument is invalid\"),h=new r(400,\"invalid_request\",\"Request was invalid\"),v=new r(400,\"query_parse_error\",\"Some query parameter is invalid\"),y=new r(500,\"doc_validation\",\"Bad special document member\"),_=new r(400,\"bad_request\",\"Something wrong with the request\"),m=new r(400,\"bad_request\",\"Document must be a JSON object\"),g=new r(404,\"not_found\",\"Database not found\"),b=new r(500,\"indexed_db_went_bad\",\"unknown\"),w=new r(500,\"web_sql_went_bad\",\"unknown\"),E=new r(500,\"levelDB_went_went_bad\",\"unknown\"),A=new r(403,\"forbidden\",\"Forbidden by design doc validate_doc_update function\"),O=new r(400,\"bad_request\",\"Invalid rev format\"),I=new r(412,\"file_exists\",\"The database could not be created, the file already exists.\"),e=new r(412,\"missing_stub\",\"A pre-existing attachment stub wasn't found\"),k=new r(413,\"invalid_url\",\"Provided URL is invalid\");n.UNAUTHORIZED=o,n.MISSING_BULK_DOCS=i,n.MISSING_DOC=a,n.REV_CONFLICT=s,n.INVALID_ID=u,n.MISSING_ID=c,n.RESERVED_ID=f,n.NOT_OPEN=l,n.UNKNOWN_ERROR=d,n.BAD_ARG=p,n.INVALID_REQUEST=h,n.QUERY_PARSE_ERROR=v,n.DOC_VALIDATION=y,n.BAD_REQUEST=_,n.NOT_AN_OBJECT=m,n.DB_MISSING=g,n.WSQ_ERROR=w,n.LDB_ERROR=E,n.FORBIDDEN=A,n.INVALID_REV=O,n.FILE_EXISTS=I,n.MISSING_STUB=e,n.IDB_ERROR=b,n.INVALID_URL=k,n.createError=function(o,e){function t(e){for(var t=Object.getOwnPropertyNames(o),n=0,r=t.length;n<r;n++)\"function\"!=typeof o[t[n]]&&(this[t[n]]=o[t[n]]);void 0!==e&&(this.reason=e)}return t.prototype=r.prototype,new t(e)},n.generateErrorFromResponse=function(e){var t;return\"object\"!=typeof e&&(t=e,(e=d).data=t),\"error\"in e&&\"conflict\"===e.error&&(e.name=\"conflict\",e.status=409),\"name\"in e||(e.name=e.error||\"unknown\"),\"status\"in e||(e.status=500),\"message\"in e||(e.message=e.message||e.reason),e}},{9:9}],97:[function(e,t,n){\"use strict\";function s(e){for(var t,n,r,o=e.rev_tree.slice();f=o.pop();){var i=f.ids,a=i[2],s=f.pos;if(a.length)for(var u=0,c=a.length;u<c;u++)o.push({pos:s+1,ids:a[u]});else{var f=!!i[1].deleted,i=i[0];t&&!(r!==f?r:n!==s?n<s:t<i)||(t=i,n=s,r=f)}}return n+\"-\"+t}function p(e,t){for(var n,r=e.slice();n=r.pop();)for(var o=n.pos,i=n.ids,a=i[2],s=t(0===a.length,o,i[0],n.ctx,i[1]),u=0,c=a.length;u<c;u++)r.push({pos:o+1,ids:a[u],ctx:s})}function r(e,t){return e.pos-t.pos}function u(e){var i=[];p(e,function(e,t,n,r,o){e&&i.push({rev:t+\"-\"+n,pos:t,opts:o})}),i.sort(r).reverse();for(var t=0,n=i.length;t<n;t++)delete i[t].pos;return i}function h(e){for(var t,n=[],r=e.slice();t=r.pop();){var o=t.pos,i=t.ids,a=i[0],s=i[1],u=i[2],i=0===u.length,c=t.history?t.history.slice():[];c.push({id:a,opts:s}),i&&n.push({pos:o+1-c.length,ids:c});for(var f=0,l=u.length;f<l;f++)r.push({pos:o+1,ids:u[f],history:c})}return n.reverse()}function g(e,t){return e.pos-t.pos}function f(e,t,n){n=function(e,t,n){for(var r,o=0,i=e.length;o<i;)n(e[r=o+i>>>1],t)<0?o=1+r:i=r;return o}(e,t,n);e.splice(n,0,t)}function v(e,t){for(var n,r,o=t,i=e.length;o<i;o++){var a=e[o],a=[a.id,a.opts,[]];r?(r[2].push(a),r=a):n=r=a}return n}function l(e,t){return e[0]<t[0]?-1:1}function b(e,t){for(var n=[{tree1:e,tree2:t}],r=!1;0<n.length;){var o=n.pop(),i=o.tree1,a=o.tree2;(i[1].status||a[1].status)&&(i[1].status=\"available\"===i[1].status||\"available\"===a[1].status?\"available\":\"missing\");for(var s=0;s<a[2].length;s++)if(i[2][0]){for(var u=!1,c=0;c<i[2].length;c++)i[2][c][0]===a[2][s][0]&&(n.push({tree1:i[2][c],tree2:a[2][s]}),u=!0);u||(r=\"new_branch\",f(i[2],a[2][s],l))}else r=\"new_leaf\",i[2][0]=a[2][s]}return{conflicts:r,tree:e}}function y(e,t,n){var r,o=[],i=!1,a=!1;if(!e.length)return{tree:[t],conflicts:\"new_leaf\"};for(var s=0,u=e.length;s<u;s++){var c=e[s];if(c.pos===t.pos&&c.ids[0]===t.ids[0])r=b(c.ids,t.ids),o.push({pos:c.pos,ids:r.tree}),i=i||r.conflicts,a=!0;else if(!0!==n){var f=c.pos<t.pos?c:t,l=c.pos<t.pos?t:c,d=l.pos-f.pos,p=[],h=[];for(h.push({ids:f.ids,diff:d,parent:null,parentIdx:null});0<h.length;){var v=h.pop();if(0!==v.diff)for(var y=v.ids[2],_=0,m=y.length;_<m;_++)h.push({ids:y[_],diff:v.diff-1,parent:v.ids,parentIdx:_});else v.ids[0]===l.ids[0]&&p.push(v)}d=p[0];d?(r=b(d.ids,l.ids),d.parent[2][d.parentIdx]=r.tree,o.push({pos:f.pos,ids:f.ids}),i=i||r.conflicts,a=!0):o.push(c)}else o.push(c)}return a||o.push(t),o.sort(g),{tree:o,conflicts:i||\"internal_node\"}}function i(e){return e.ids}Object.defineProperty(n,\"__esModule\",{value:!0}),n.collectConflicts=function(e){for(var t=s(e),n=u(e.rev_tree),r=[],o=0,i=n.length;o<i;o++){var a=n[o];a.rev===t||a.opts.deleted||r.push(a.rev)}return r},n.collectLeaves=u,n.compactTree=function(e){var i=[];return p(e.rev_tree,function(e,t,n,r,o){\"available\"!==o.status||e||(i.push(t+\"-\"+n),o.status=\"missing\")}),i},n.isDeleted=function(e,t){for(var n,r=(t=t||s(e)).substring(t.indexOf(\"-\")+1),o=e.rev_tree.map(i);n=o.pop();){if(n[0]===r)return!!n[1].deleted;o=o.concat(n[2])}},n.isLocalId=function(e){return/^_local/.test(e)},n.merge=function(e,t,n){return t=y(e,t),{tree:(n=function(e,t){for(var n,r=h(e),o=0,i=r.length;o<i;o++){var a=r[o],s=a.ids;if(s.length>t)for(var u=u||{},c=s.length-t,f={pos:a.pos+c,ids:v(s,c)},l=0;l<c;l++){var d=a.pos+l+\"-\"+s[l].id;u[d]=!0}else f={pos:a.pos,ids:v(s,0)};n=n?y(n,f,!0).tree:[f]}return u&&p(n,function(e,t,n){delete u[t+\"-\"+n]}),{tree:n,revs:u?Object.keys(u):[]}}(t.tree,n)).tree,stemmedRevs:n.revs,conflicts:t.conflicts}},n.revExists=function(e,t){for(var n,r=e.slice(),t=t.split(\"-\"),o=parseInt(t[0],10),i=t[1];n=r.pop();){if(n.pos===o&&n.ids[0]===i)return!0;for(var a=n.ids[2],s=0,u=a.length;s<u;s++)r.push({pos:n.pos+1,ids:a[s]})}return!1},n.rootToLeaf=h,n.traverseRevTree=p,n.winningRev=s,n.latest=function(e,t){for(var n,r=t.rev_tree.slice();n=r.pop();){var o=n.pos,i=n.ids,a=i[0],s=i[1],u=i[2],i=0===u.length,c=n.history?n.history.slice():[];if(c.push({id:a,pos:o,opts:s}),i)for(var f=0,l=c.length;f<l;f++){var d=c[f];if(d.pos+\"-\"+d.id===e)return o+\"-\"+a}for(var p=0,h=u.length;p<h;p++)r.push({pos:o+1,ids:u[p],history:c})}throw new Error(\"Unable to resolve latest revision for id \"+t.id+\", rev \"+e)}},{}],98:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var s=e(108),i=e(105);function u(e,t){for(var n=e,r=0,o=t.length;r<o;r++)if(!(n=n[t[r]]))break;return n}function a(e,t){return e<t?-1:t<e?1:0}function c(e){for(var t=[],n=\"\",r=0,o=e.length;r<o;r++){var i=e[r];\".\"===i?n=0<r&&\"\\\\\"===e[r-1]?n.substring(0,n.length-1)+\".\":(t.push(n),\"\"):n+=i}return t.push(n),t}var r=[\"$or\",\"$nor\",\"$not\"];function f(e){return-1<r.indexOf(e)}function l(e){return Object.keys(e)[0]}function d(e){return e[l(e)]}function p(e){var n={};return e.forEach(function(t){Object.keys(t).forEach(function(e){var s,u=t[e];\"object\"!=typeof u&&(u={$eq:u}),f(e)?u instanceof Array?n[e]=u.map(function(e){return p([e])}):n[e]=p([u]):(s=n[e]=n[e]||{},Object.keys(u).forEach(function(e){var t,n,r,o,i,a=u[e];return\"$gt\"===e||\"$gte\"===e?(r=e,o=a,void(void 0===(i=s).$eq&&(void 0!==i.$gte?\"$gte\"===r?o>i.$gte&&(i.$gte=o):o>=i.$gte&&(delete i.$gte,i.$gt=o):void 0!==i.$gt?\"$gte\"===r?o>i.$gt&&(delete i.$gt,i.$gte=o):o>i.$gt&&(i.$gt=o):i[r]=o))):\"$lt\"===e||\"$lte\"===e?(i=e,r=a,void(void 0===(o=s).$eq&&(void 0!==o.$lte?\"$lte\"===i?r<o.$lte&&(o.$lte=r):r<=o.$lte&&(delete o.$lte,o.$lt=r):void 0!==o.$lt?\"$lte\"===i?r<o.$lt&&(delete o.$lt,o.$lte=r):r<o.$lt&&(o.$lt=r):o[i]=r))):\"$ne\"===e?(t=a,void(\"$ne\"in(n=s)?n.$ne.push(t):n.$ne=[t])):\"$eq\"===e?(n=a,delete(t=s).$gt,delete t.$gte,delete t.$lt,delete t.$lte,delete t.$ne,void(t.$eq=n)):void(s[e]=a)}))})}),n}function o(e){var t=s.clone(e),n=!1;!function e(t,n){for(var r in t)\"$and\"===r&&(n=!0),\"object\"==typeof(r=t[r])&&(n=e(r,n));return n}(t,!1)||(\"$and\"in(t=function e(t){for(var n in t){if(Array.isArray(t))for(var r in t)t[r].$and&&(t[r]=p(t[r].$and));\"object\"==typeof(n=t[n])&&e(n)}return t}(t))&&(t=p(t.$and)),n=!0),[\"$or\",\"$nor\"].forEach(function(e){e in t&&t[e].forEach(function(e){for(var t=Object.keys(e),n=0;n<t.length;n++){var r=t[n],o=e[r];\"object\"==typeof o&&null!==o||(e[r]={$eq:o})}})}),\"$not\"in t&&(t.$not=p([t.$not]));for(var r=Object.keys(t),o=0;o<r.length;o++){var i=r[o],a=t[i];\"object\"!=typeof a||null===a?a={$eq:a}:\"$ne\"in a&&!n&&(a.$ne=[a.$ne]),t[i]=a}return t}function h(e){function o(t){return e.map(function(e){e=c(l(e));return u(t,e)})}return function(e,t){var n=o(e.doc),r=o(t.doc),r=i.collate(n,r);return 0!==r?r:a(e.doc._id,t.doc._id)}}function v(e,t,n){var r,o;return e=e.filter(function(e){return y(e.doc,t.selector,n)}),t.sort&&(o=h(t.sort),e=e.sort(o),\"string\"!=typeof t.sort[0]&&\"desc\"===d(t.sort[0])&&(e=e.reverse())),(\"limit\"in t||\"skip\"in t)&&(r=t.skip||0,o=(\"limit\"in t?t.limit:e.length)+r,e=e.slice(r,o)),e}function y(a,s,e){return e.every(function(e){var t,n,r=s[e],o=c(e),i=u(a,o);return f(e)?(t=r,n=a,\"$or\"!==(e=e)?\"$not\"!==e?!t.find(function(e){return y(n,e,Object.keys(e))}):!y(n,t,Object.keys(t)):t.some(function(e){return y(n,e,Object.keys(e))})):_(r,a,o,i)})}function _(n,r,o,i){return!n||(\"object\"==typeof n?Object.keys(n).every(function(e){var t=n[e];return function(e,t,n,r,o){if(w[e])return w[e](t,n,r,o);throw new Error('unknown operator \"'+e+'\" - should be one of $eq, $lte, $lt, $gt, $gte, $exists, $ne, $in, $nin, $size, $mod, $regex, $elemMatch, $type, $allMatch or $all')}(e,r,t,o,i)}):n===i)}function m(e){return null!=e}function g(e){return void 0!==e}function b(t,e){return e.some(function(e){return t instanceof Array?-1<t.indexOf(e):t===e})}var w={$elemMatch:function(t,n,r,e){return!!Array.isArray(e)&&(0!==e.length&&(\"object\"==typeof e[0]?e.some(function(e){return y(e,n,Object.keys(n))}):e.some(function(e){return _(n,t,r,e)})))},$allMatch:function(t,n,r,e){return!!Array.isArray(e)&&(0!==e.length&&(\"object\"==typeof e[0]?e.every(function(e){return y(e,n,Object.keys(n))}):e.every(function(e){return _(n,t,r,e)})))},$eq:function(e,t,n,r){return g(r)&&0===i.collate(r,t)},$gte:function(e,t,n,r){return g(r)&&0<=i.collate(r,t)},$gt:function(e,t,n,r){return g(r)&&0<i.collate(r,t)},$lte:function(e,t,n,r){return g(r)&&i.collate(r,t)<=0},$lt:function(e,t,n,r){return g(r)&&i.collate(r,t)<0},$exists:function(e,t,n,r){return t?g(r):!g(r)},$mod:function(e,t,n,r){return m(r)&&function(e,t){var n=t[0],t=t[1];if(0===n)throw new Error(\"Bad divisor, cannot divide by zero\");if(parseInt(n,10)!==n)throw new Error(\"Divisor is not an integer\");if(parseInt(t,10)!==t)throw new Error(\"Modulus is not an integer\");return parseInt(e,10)===e&&e%n===t}(r,t)},$ne:function(e,t,n,r){return t.every(function(e){return 0!==i.collate(r,e)})},$in:function(e,t,n,r){return m(r)&&b(r,t)},$nin:function(e,t,n,r){return m(r)&&!b(r,t)},$size:function(e,t,n,r){return m(r)&&r.length===t},$all:function(e,t,n,r){return Array.isArray(r)&&(o=r,t.every(function(e){return-1<o.indexOf(e)}));var o},$regex:function(e,t,n,r){return m(r)&&(r=r,new RegExp(t).test(r))},$type:function(e,t,n,r){return function(e,t){switch(t){case\"null\":return null===e;case\"boolean\":return\"boolean\"==typeof e;case\"number\":return\"number\"==typeof e;case\"string\":return\"string\"==typeof e;case\"array\":return e instanceof Array;case\"object\":return\"[object Object]\"==={}.toString.call(e)}throw new Error(t+\" not supported as a type.Please use one of object, string, array, number, boolean or null.\")}(r,t)}};n.massageSelector=o,n.matchesSelector=function(e,t){if(\"object\"!=typeof t)throw new Error(\"Selector error: expected a JSON object\");return(t=v([{doc:e}],{selector:t=o(t)},Object.keys(t)))&&1===t.length},n.filterInMemoryFields=v,n.createFieldSorter=h,n.rowFilter=y,n.isCombinationalField=f,n.getKey=l,n.getValue=d,n.getFieldFromDoc=u,n.setFieldInDoc=function(e,t,n){for(var r=0,o=t.length;r<o-1;r++){var i=t[r];e=e[i]=e[i]||{}}e[t[o-1]]=n},n.compare=a,n.parseField=c},{105:105,108:108}],99:[function(e,t,n){arguments[4][11][0].apply(n,arguments)},{100:100,101:101,102:102,103:103,104:104,11:11,7:7}],100:[function(e,t,n){arguments[4][12][0].apply(n,arguments)},{12:12}],101:[function(e,t,n){arguments[4][13][0].apply(n,arguments)},{13:13}],102:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14}],103:[function(e,t,n){arguments[4][15][0].apply(n,arguments)},{15:15}],104:[function(e,t,n){arguments[4][16][0].apply(n,arguments)},{16:16}],105:[function(e,t,n){\"use strict\";function s(e,t,n){return function(e,t,n){for(var r=\"\",o=n-e.length;r.length<o;)r+=t;return r}(e,t,n)+e}Object.defineProperty(n,\"__esModule\",{value:!0});var p=-324,h=3,u=\"\";function c(e,t){if(e===t)return 0;e=a(e),t=a(t);var n,r,o=l(e),i=l(t);if(o-i!=0)return o-i;switch(typeof e){case\"number\":return e-t;case\"boolean\":return e<t?-1:1;case\"string\":return(n=e)===(r=t)?0:r<n?1:-1}return(Array.isArray(e)?function(e,t){for(var n=Math.min(e.length,t.length),r=0;r<n;r++){var o=c(e[r],t[r]);if(0!==o)return o}return e.length===t.length?0:e.length>t.length?1:-1}:function(e,t){for(var n=Object.keys(e),r=Object.keys(t),o=Math.min(n.length,r.length),i=0;i<o;i++){var a=c(n[i],r[i]);if(0!==a)return a;if(0!==(a=c(e[n[i]],t[r[i]])))return a}return n.length===r.length?0:n.length>r.length?1:-1})(e,t)}function a(e){switch(typeof e){case\"undefined\":return null;case\"number\":return e===1/0||e===-1/0||isNaN(e)?null:e;case\"object\":var t,n=e;if(Array.isArray(e)){var r=e.length;e=new Array(r);for(var o=0;o<r;o++)e[o]=a(n[o])}else{if(e instanceof Date)return e.toJSON();if(null!==e)for(var i in e={},n)!n.hasOwnProperty(i)||void 0!==(t=n[i])&&(e[i]=a(t))}}return e}function r(e){if(null!==e)switch(typeof e){case\"boolean\":return e?1:0;case\"number\":return function(e){if(0===e)return\"1\";var t=e.toExponential().split(/e\\+?/),n=parseInt(t[1],10),r=e<0,e=r?\"0\":\"2\",n=s(((r?-n:n)-p).toString(),\"0\",h);e+=u+n;t=Math.abs(parseFloat(t[0]));r&&(t=10-t);t=t.toFixed(20);return t=t.replace(/\\.?0+$/,\"\"),e+=u+t}(e);case\"string\":return e.replace(/\\u0002/g,\"\u0002\u0002\").replace(/\\u0001/g,\"\u0001\u0002\").replace(/\\u0000/g,\"\u0001\u0001\");case\"object\":var t=Array.isArray(e),n=t?e:Object.keys(e),r=-1,o=n.length,i=\"\";if(t)for(;++r<o;)i+=f(n[r]);else for(;++r<o;){var a=n[r];i+=f(a)+f(e[a])}return i}return\"\"}function f(e){return l(e=a(e))+u+r(e)+\"\\0\"}function l(e){var t=[\"boolean\",\"number\",\"string\",\"object\"].indexOf(typeof e);return~t?null===e?1:Array.isArray(e)?5:t<3?t+2:t+3:Array.isArray(e)?5:void 0}n.collate=c,n.normalizeKey=a,n.toIndexableString=f,n.parseIndexableString=function(e){for(var t,n,r,o,i=[],a=[],s=0;;){var u=e[s++];if(\"\\0\"!==u)switch(u){case\"1\":i.push(null);break;case\"2\":i.push(\"1\"===e[s]),s++;break;case\"3\":var c=function(e,t){var n,r=t;if(\"1\"===e[t])n=0,t++;else{var o=\"0\"===e[t],i=\"\",a=e.substring(++t,t+h),a=parseInt(a,10)+p;for(o&&(a=-a),t+=h;;){var s=e[t];if(\"\\0\"===s)break;i+=s,t++}n=1===(i=i.split(\".\")).length?parseInt(i,10):parseFloat(i[0]+\".\"+i[1]),o&&(n-=10),0!==a&&(n=parseFloat(n+\"e\"+a))}return{num:n,length:t-r}}(e,s);i.push(c.num),s+=c.length;break;case\"4\":for(var f=\"\";;){var l=e[s];if(\"\\0\"===l)break;f+=l,s++}f=f.replace(/\\u0001\\u0001/g,\"\\0\").replace(/\\u0001\\u0002/g,\"\u0001\").replace(/\\u0002\\u0002/g,\"\u0002\"),i.push(f);break;case\"5\":var d={element:[],index:i.length};i.push(d.element),a.push(d);break;case\"6\":d={element:{},index:i.length};i.push(d.element),a.push(d);break;default:throw new Error(\"bad collationIndex or unexpectedly reached end of input: \"+u)}else{if(1===i.length)return i.pop();n=a,o=r=void 0,o=(t=i).pop(),n.length&&(o===(r=n[n.length-1]).element&&(n.pop(),r=n[n.length-1]),n=r.element,r=r.index,Array.isArray(n)?n.push(o):r===t.length-2?n[t.pop()]=o:t.push(o))}}}},{}],106:[function(e,t,n){arguments[4][17][0].apply(n,arguments)},{17:17}],107:[function(e,t,n){arguments[4][18][0].apply(n,arguments)},{109:109,18:18,52:52}],108:[function(e,t,n){arguments[4][19][0].apply(n,arguments)},{106:106,107:107,111:111,19:19,6:6,8:8,9:9,96:96,99:99}],109:[function(e,t,n){arguments[4][20][0].apply(n,arguments)},{20:20}],110:[function(e,t,n){arguments[4][21][0].apply(n,arguments)},{21:21}],111:[function(e,t,n){arguments[4][22][0].apply(n,arguments)},{115:115,116:116,118:118,119:119,22:22}],112:[function(e,t,n){arguments[4][23][0].apply(n,arguments)},{23:23}],113:[function(e,t,n){arguments[4][24][0].apply(n,arguments)},{24:24}],114:[function(e,t,n){arguments[4][25][0].apply(n,arguments)},{25:25}],115:[function(e,t,n){arguments[4][26][0].apply(n,arguments)},{110:110,113:113,26:26}],116:[function(e,t,n){arguments[4][27][0].apply(n,arguments)},{112:112,117:117,27:27}],117:[function(e,t,n){arguments[4][28][0].apply(n,arguments)},{110:110,28:28}],118:[function(e,t,n){arguments[4][29][0].apply(n,arguments)},{110:110,113:113,29:29}],119:[function(e,t,n){arguments[4][30][0].apply(n,arguments)},{114:114,117:117,30:30}]},{},[3]);";
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
(function (global){(function (){
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

}).call(this)}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
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
(function (global){(function (){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var pouchdbBinaryUtils = _dereq_(18);
var Md5 = _interopDefault(_dereq_(29));

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

}).call(this)}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"18":18,"29":29}],18:[function(_dereq_,module,exports){
arguments[4][15][0].apply(exports,arguments)
},{"15":15}],19:[function(_dereq_,module,exports){
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

},{}],20:[function(_dereq_,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var getArguments = _interopDefault(_dereq_(11));
var pouchdbCollections = _dereq_(16);
var immediate = _interopDefault(_dereq_(13));
var events = _dereq_(12);
var inherits = _interopDefault(_dereq_(21));
var pouchdbErrors = _dereq_(22);
var uuidV4 = _interopDefault(_dereq_(23));
var pouchdbMd5 = _dereq_(17);
var pouchdbUtils = _dereq_(20);

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

},{"11":11,"12":12,"13":13,"16":16,"17":17,"20":20,"21":21,"22":22,"23":23}],21:[function(_dereq_,module,exports){
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

},{}],22:[function(_dereq_,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var inherits = _interopDefault(_dereq_(21));

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

},{"21":21}],23:[function(_dereq_,module,exports){
var v1 = _dereq_(26);
var v4 = _dereq_(27);

var uuid = v4;
uuid.v1 = v1;
uuid.v4 = v4;

module.exports = uuid;

},{"26":26,"27":27}],24:[function(_dereq_,module,exports){
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

},{}],25:[function(_dereq_,module,exports){
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

},{}],26:[function(_dereq_,module,exports){
var rng = _dereq_(25);
var bytesToUuid = _dereq_(24);

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

},{"24":24,"25":25}],27:[function(_dereq_,module,exports){
var rng = _dereq_(25);
var bytesToUuid = _dereq_(24);

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

},{"24":24,"25":25}],28:[function(_dereq_,module,exports){
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

},{}],29:[function(_dereq_,module,exports){
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

},{}]},{},[3])(3)
});
