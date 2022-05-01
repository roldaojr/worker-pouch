'use strict';

exports.lastIndexOf = function lastIndexOf (str, char) {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str.charAt(i) === char) {
      return i
    }
  }
  return -1
}

exports.clone = require('./pouchdb-clone')

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
        // if nextTick is avaliable use it
        if(process && process.nextTick) {
          process.nextTick(() => {
            tempCB(err, resp)
          })
        } else {
          tempCB(err, resp)
        }
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

exports.inherits = require('inherits')

const binUtil = require('pouchdb-binary-utils')

exports.createBlob = data => new Blob(data)
exports.readAsArrayBuffer = binUtil.readAsArrayBuffer
exports.readAsBinaryString = binUtil.readAsBinaryString
exports.binaryStringToArrayBuffer = binUtil.binaryStringToArrayBuffer
exports.arrayBufferToBinaryString = binUtil.arrayBufferToBinaryString
