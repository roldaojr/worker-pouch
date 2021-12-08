'use strict';

const getArguments = require('argsarray')
const utils = require('pouchdb-utils')
const merge = require('pouchdb-merge')
const inherits = require('inherits')
const EE = require('events').EventEmitter

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
