'use strict';

const utils = require('../shared/utils')
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

    if (process.env.NODE_ENV !== 'production') {
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
