'use strict';

const utils = require('../shared/utils')
const clientUtils = require('./utils')
const uuid = require('../shared/uuid')
const errors = require('../shared/errors')
const log = console.debug.bind(console)
const { Changes } = require('./changes')

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

  if (process.env.NODE_ENV !== 'production') {
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
      if (process.env.NODE_ENV !== 'production') {
        log('duplicate message (ignoring)', messageId, messageType, content)
      }
      return
    }

    if (process.env.NODE_ENV !== 'production') {
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

    if (process.env.NODE_ENV !== 'production') {
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

    if (process.env.NODE_ENV !== 'production') {
      log('message sent', api._instanceId, messageId)
    }
  }

  function sendRawMessage (messageId, type, args) {
    if (process.env.NODE_ENV !== 'production') {
      log('send message', api._instanceId, messageId, type, args)
    }

    const encodedArgs = encodeArgs(args)
    postMessage({
      id: api._instanceId,
      type,
      messageId,
      args: encodedArgs
    })

    if (process.env.NODE_ENV !== 'production') {
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
