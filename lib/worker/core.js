'use strict';

/* jshint worker:true */

const errors = require('../shared/errors')
const workerUtils = require('./utils')
const log = console.debug.bind(console)

const { decodeArgs } = workerUtils
const dbs = {}
const allChanges = {}

function registerWorkerPouch (self, pouchCreator) {
  function postMessage (msg, event) {
    if (typeof self.postMessage !== 'function') { // service worker
      event.ports[0].postMessage(msg)
    } else { // web worker
      self.postMessage(msg)
    }
  }

  function sendUncaughtError (clientId, data, event) {
    if (process.env.NODE_ENV !== 'production') {
      log(' -> sendUncaughtError', clientId, data)
    }
    postMessage({
      type: 'uncaughtError',
      id: clientId,
      content: workerUtils.createError(data)
    }, event)
  }

  function sendError (clientId, messageId, data, event) {
    if (process.env.NODE_ENV !== 'production') {
      log(' -> sendError', clientId, messageId, data)
    }
    postMessage({
      type: 'error',
      id: clientId,
      messageId,
      content: workerUtils.createError(data)
    }, event)
  }

  function sendSuccess (clientId, messageId, data, event) {
    if (process.env.NODE_ENV !== 'production') {
      log(' -> sendSuccess', clientId, messageId)
    }
    postMessage({
      type: 'success',
      id: clientId,
      messageId,
      content: data
    }, event)
  }

  function sendUpdate (clientId, messageId, data, event) {
    if (process.env.NODE_ENV !== 'production') {
      log(' -> sendUpdate', clientId, messageId)
    }
    postMessage({
      type: 'update',
      id: clientId,
      messageId,
      content: data
    }, event)
  }

  function dbMethod (clientId, methodName, messageId, args, event) {
    const db = dbs[`$${clientId}`]
    if (!db) {
      return sendError(clientId, messageId, { error: 'db not found' }, event)
    }
    Promise.resolve().then(() => db[methodName].apply(db, args)).then(res => {
      sendSuccess(clientId, messageId, res, event)
    }).catch(err => {
      sendError(clientId, messageId, err, event)
    })
  }

  function changes (clientId, messageId, args, event) {
    const opts = args[0]
    if (opts && typeof opts === 'object') {
      // just send all the docs anyway because we need to emit change events
      // TODO: be smarter about emitting changes without building up an array
      opts.returnDocs = true
      opts.return_docs = true
    }
    dbMethod(clientId, 'changes', messageId, args, event)
  }

  function getAttachment (clientId, messageId, args, event) {
    const db = dbs[`$${clientId}`]
    if (!db) {
      return sendError(clientId, messageId, { error: 'db not found' }, event)
    }

    Promise.resolve().then(() => {
      const docId = args[0]
      const attId = args[1]
      let opts = args[2]
      if (typeof opts !== 'object') {
        opts = {}
      }
      return db.get(docId, opts).then(doc => {
        if (!doc._attachments || !doc._attachments[attId]) {
          throw errors.MISSING_DOC
        }
        return db.getAttachment.apply(db, args).then(buff => {
          sendSuccess(clientId, messageId, buff, event)
        })
      })
    }).catch(err => {
      sendError(clientId, messageId, err, event)
    })
  }

  function destroy (clientId, messageId, args, event) {
    const key = `$${clientId}`
    const db = dbs[key]
    if (!db) {
      return sendError(clientId, messageId, { error: 'db not found' }, event)
    }
    delete dbs[key]
    Promise.resolve().then(() => db.destroy.apply(db, args)).then(res => {
      sendSuccess(clientId, messageId, res, event)
    }).catch(err => {
      sendError(clientId, messageId, err, event)
    })
  }

  function liveChanges (clientId, messageId, args, event) {
    const db = dbs[`$${clientId}`]
    if (!db) {
      return sendError(clientId, messageId, { error: 'db not found' }, event)
    }
    Promise.resolve().then(() => {
      const changes = db.changes(args[0])
      allChanges[messageId] = changes
      changes.on('change', change => {
        sendUpdate(clientId, messageId, change, event)
      }).on('complete', change => {
        changes.removeAllListeners()
        delete allChanges[messageId]
        sendSuccess(clientId, messageId, change, event)
      }).on('error', change => {
        changes.removeAllListeners()
        delete allChanges[messageId]
        sendError(clientId, messageId, change, event)
      })
    })
  }

  function cancelChanges (messageId) {
    const changes = allChanges[messageId]
    if (changes) {
      changes.cancel()
    }
  }

  function addUncaughtErrorHandler (db, clientId, event) {
    return Promise.resolve().then(() => {
      db.on('error', err => {
        sendUncaughtError(clientId, err, event)
      })
    })
  }

  function createDatabase (clientId, messageId, args, event) {
    const key = `$${clientId}`
    let db = dbs[key]
    if (db) {
      return addUncaughtErrorHandler(db, clientId, event).then(() => sendSuccess(clientId, messageId, { ok: true, exists: true }, event))
    }

    const name = typeof args[0] === 'string' ? args[0] : args[0].name

    if (!name) {
      return sendError(clientId, messageId, {
        error: 'you must provide a database name'
      }, event)
    }

    db = dbs[key] = (() => {
      let options = { adapter: 'indexeddb', revs_limit: 1 }
      if (Object(args[0]) === args[0]) {
        options = Object.assign({}, args[0], options)
      } else {
        options.name = args[0]
      }
      return pouchCreator(options)
    })()
    addUncaughtErrorHandler(db, clientId, event).then(() => {
      sendSuccess(clientId, messageId, { ok: true }, event)
    }).catch(err => {
      sendError(clientId, messageId, err, event)
    })
  }

  function onReceiveMessage (clientId, type, messageId, args, event) {
    if (process.env.NODE_ENV !== 'production') {
      log('onReceiveMessage', type, clientId, messageId, args, event)
    }

    switch (type) {
    case 'createDatabase':
      return createDatabase(clientId, messageId, args, event)
    case 'id':
    case 'info':
    case 'put':
    case 'allDocs':
    case 'bulkDocs':
    case 'post':
    case 'get':
    case 'remove':
    case 'revsDiff':
    case 'compact':
    case 'viewCleanup':
    case 'removeAttachment':
    case 'putAttachment':
    case 'query':
    case 'createIndex':
    case 'find':
      return dbMethod(clientId, type, messageId, args, event)
    case 'changes':
      return changes(clientId, messageId, args, event)
    case 'getAttachment':
      return getAttachment(clientId, messageId, args, event)
    case 'liveChanges':
      return liveChanges(clientId, messageId, args, event)
    case 'cancelChanges':
      return cancelChanges(messageId)
    case 'destroy':
      return destroy(clientId, messageId, args, event)
    default:
      return sendError(clientId, messageId, { error: `unknown API method: ${type}` }, event)
    }
  }

  function handleMessage (message, clientId, event) {
    const { type } = message
    const { messageId } = message
    const args = decodeArgs(message.args)
    onReceiveMessage(clientId, type, messageId, args, event)
  }

  self.addEventListener('message', event => {
    if (!event.data || !event.data.id || !event.data.args
        || !event.data.type || !event.data.messageId) {
      // assume this is not a message from worker-pouch
      // (e.g. the user is using the custom API instead)
      return
    }
    const clientId = event.data.id
    if (event.data.type === 'close') {
      if (process.env.NODE_ENV !== 'production') {
        log('closing worker', clientId)
      }
      delete dbs[`$${clientId}`]
    } else {
      try {
        handleMessage(event.data, clientId, event)
      } catch (err) {
        sendUncaughtError(clientId, err, event)
      }
    }
  })
}

module.exports = registerWorkerPouch
