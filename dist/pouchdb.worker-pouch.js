(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.workerPouch = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(_dereq_,module,exports){
'use strict';

var getArguments = _dereq_(12);
var utils = _dereq_(27);
var merge = _dereq_(26);
var inherits = _dereq_(17);
var EE = _dereq_(15).EventEmitter;

var clone = utils.clone;
var listenerCount = utils.listenerCount;
var once = utils.once;
var guardedConsole = utils.guardedConsole;

var isDeleted = merge.isDeleted;
var collectLeaves = merge.collectLeaves;
var collectConflicts = merge.collectConflicts;

inherits(Changes, EE);

function tryCatchInChangeListener(self, change, pending, lastSeq) {
  // isolate try/catches to avoid V8 deoptimizations
  try {
    self.emit('change', change, pending, lastSeq);
  } catch (e) {
    guardedConsole('error', 'Error in .on("change", function):', e);
  }
}

function Changes(db, opts, callback) {
  EE.call(this);
  var self = this;
  this.db = db;
  opts = opts ? clone(opts) : {};
  var complete = opts.complete = once(function (err, resp) {
    if (err) {
      if (listenerCount(self, 'error') > 0) {
        self.emit('error', err);
      }
    } else {
      self.emit('complete', resp);
    }
    self.removeAllListeners();
    db.removeListener('destroyed', onDestroy);
  });
  if (callback) {
    self.on('complete', function (resp) {
      callback(null, resp);
    });
    self.on('error', callback);
  }
  function onDestroy() {
    self.cancel();
  }
  db.once('destroyed', onDestroy);

  opts.onChange = function (change, pending, lastSeq) {
    /* istanbul ignore if */
    if (self.isCancelled) {
      return;
    }
    tryCatchInChangeListener(self, change, pending, lastSeq);
  };

  var promise = new Promise(function (fulfill, reject) {
    opts.complete = function (err, res) {
      if (err) {
        reject(err);
      } else {
        fulfill(res);
      }
    };
  });
  self.once('cancel', function () {
    db.removeListener('destroyed', onDestroy);
    opts.complete(null, {status: 'cancelled'});
  });
  this.then = promise.then.bind(promise);
  this['catch'] = promise['catch'].bind(promise);
  this.then(function (result) {
    complete(null, result);
  }, complete);



  if (!db.taskqueue.isReady) {
    db.taskqueue.addTask(function (failed) {
      if (failed) {
        opts.complete(failed);
      } else if (self.isCancelled) {
        self.emit('cancel');
      } else {
        self.validateChanges(opts);
      }
    });
  } else {
    self.validateChanges(opts);
  }
}
Changes.prototype.cancel = function () {
  this.isCancelled = true;
  if (this.db.taskqueue.isReady) {
    this.emit('cancel');
  }
};
function processChange(doc, metadata, opts) {
  var changeList = [{rev: doc._rev}];
  if (opts.style === 'all_docs') {
    changeList = collectLeaves(metadata.rev_tree)
    .map(function (x) { return {rev: x.rev}; });
  }
  var change = {
    id: metadata.id,
    changes: changeList,
    doc: doc
  };

  if (isDeleted(metadata, doc._rev)) {
    change.deleted = true;
  }
  if (opts.conflicts) {
    change.doc._conflicts = collectConflicts(metadata);
    if (!change.doc._conflicts.length) {
      delete change.doc._conflicts;
    }
  }
  return change;
}

Changes.prototype.validateChanges = function (opts) {
  var callback = opts.complete;
  var self = this;

  self.doChanges(opts);
};

Changes.prototype.doChanges = function (opts) {
  var self = this;
  var callback = opts.complete;

  opts = clone(opts);
  if ('live' in opts && !('continuous' in opts)) {
    opts.continuous = opts.live;
  }
  opts.processChange = processChange;

  if (opts.since === 'latest') {
    opts.since = 'now';
  }
  if (!opts.since) {
    opts.since = 0;
  }
  if (opts.since === 'now') {
    this.db.info().then(function (info) {
      /* istanbul ignore if */
      if (self.isCancelled) {
        callback(null, {status: 'cancelled'});
        return;
      }
      opts.since = info.update_seq;
      self.doChanges(opts);
    }, callback);
    return;
  }

  if (!('descending' in opts)) {
    opts.descending = false;
  }

  // 0 and 1 should return 1 document
  opts.limit = opts.limit === 0 ? 1 : opts.limit;
  opts.complete = callback;
  var newPromise = this.db._changes(opts);
  /* istanbul ignore else */
  if (newPromise && typeof newPromise.cancel === 'function') {
    var cancel = self.cancel;
    self.cancel = getArguments(function (args) {
      newPromise.cancel();
      cancel.apply(this, args);
    });
  }
};

exports.Changes = Changes;

},{"12":12,"15":15,"17":17,"26":26,"27":27}],2:[function(_dereq_,module,exports){
'use strict';

var utils = _dereq_(9);
var clientUtils = _dereq_(6);
var uuid = _dereq_(10);
var errors = _dereq_(7);
var log = _dereq_(13)('pouchdb:worker:client');
var Changes = _dereq_(1).Changes;
var preprocessAttachments = clientUtils.preprocessAttachments;
var encodeArgs = clientUtils.encodeArgs;
var adapterFun = clientUtils.adapterFun;

// Implements the PouchDB API for dealing with PouchDB instances over WW
function WorkerPouch(opts, callback) {
  var api = this;

  if (typeof opts === 'string') {
    var slashIdx = utils.lastIndexOf(opts, '/');
    opts = {
      url: opts.substring(0, slashIdx),
      name: opts.substring(slashIdx + 1)
    };
  } else {
    opts = utils.clone(opts);
  }

  log('constructor called', opts);

  // Aspirational. once https://github.com/pouchdb/pouchdb/issues/5200
  // is resolved, you'll be able to directly pass in a worker here instead of
  // a function that returns a worker.
  var worker = (opts.worker && typeof opts.worker === 'function') ?
    opts.worker() : opts.worker;
  if (!worker || (!worker.postMessage && (!worker.controller || !worker.controller.postMessage))) {
    var workerOptsErrMessage =
      'Error: you must provide a valid `worker` in `new PouchDB()`';
    console.error(workerOptsErrMessage);
    return callback(new Error(workerOptsErrMessage));
  }

  if (!opts.name) {
    var optsErrMessage = 'Error: you must provide a database name.';
    console.error(optsErrMessage);
    return callback(new Error(optsErrMessage));
  }

  function handleUncaughtError(content) {
    try {
      api.emit('error', content);
    } catch (err) {
      // TODO: it's weird that adapters should have to handle this themselves
      console.error(
        'The user\'s map/reduce function threw an uncaught error.\n' +
        'You can debug this error by doing:\n' +
        'myDatabase.on(\'error\', function (err) { debugger; });\n' +
        'Please double-check your map/reduce function.');
      console.error(content);
    }
  }

  function onReceiveMessage(message) {
    var messageId = message.messageId;
    var messageType = message.type;
    var content = message.content;

    if (messageType === 'uncaughtError') {
      handleUncaughtError(content);
      return;
    }

    var cb = api._callbacks[messageId];

    if (!cb) {
      log('duplicate message (ignoring)', messageId, messageType, content);
      return;
    }

    log('receive message', api._instanceId, messageId, messageType, content);

    if (messageType === 'error') {
      delete api._callbacks[messageId];
      cb(content);
    } else if (messageType === 'success') {
      delete api._callbacks[messageId];
      cb(null, content);
    } else { // 'update'
      api._changesListeners[messageId](content);
    }
  }

  function workerListener(e) {
    if (e.data.id === api._instanceId) {
      onReceiveMessage(e.data);
    }
  }

  function postMessage(message) {
    /* istanbul ignore if */
    if (typeof worker.controller !== 'undefined') {
      // service worker, use MessageChannels because e.source is broken in Chrome < 51:
      // https://bugs.chromium.org/p/chromium/issues/detail?id=543198
      var channel = new MessageChannel();
      channel.port1.onmessage = workerListener;
      worker.controller.postMessage(message, [channel.port2]);
    } else {
      // web worker
      worker.postMessage(message);
    }
  }

  function sendMessage(type, args, callback) {
    if (api._destroyed) {
      return callback(new Error('this db was destroyed'));
    } else if (api._closed) {
      return callback(new Error('this db was closed'));
    }
    var messageId = uuid();
    log('send message', api._instanceId, messageId, type, args);
    api._callbacks[messageId] = callback;
    var encodedArgs = encodeArgs(args);
    postMessage({
      id: api._instanceId,
      type: type,
      messageId: messageId,
      args: encodedArgs
    });
    log('message sent', api._instanceId, messageId);
  }

  function sendRawMessage(messageId, type, args) {
    log('send message', api._instanceId, messageId, type, args);
    var encodedArgs = encodeArgs(args);
    postMessage({
      id: api._instanceId,
      type: type,
      messageId: messageId,
      args: encodedArgs
    });
    log('message sent', api._instanceId, messageId);
  }

  api.type = function () {
    return 'worker';
  };

  api._remote = false;

  api._id = adapterFun('id', function (callback) {
    sendMessage('id', [], callback);
  });

  api.compact = adapterFun('compact', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('compact', [opts], callback);
  });

  api._info = function (callback) {
    sendMessage('info', [], callback);
  };

  api.get = adapterFun('get', function (id, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('get', [id, opts], callback);
  });

  // hacky code necessary due to implicit breaking change in
  // https://github.com/pouchdb/pouchdb/commits/0ddeae6b
  api._get = function (id, opts, callback) {
    api.get(id, opts, function (err, doc) {
      if (err) {
        return callback(err);
      }
      callback(null, {doc: doc});
    });
  };

  api.remove =
    adapterFun('remove', function (docOrId, optsOrRev, opts, callback) {
      var doc;
      if (typeof optsOrRev === 'string') {
        // id, rev, opts, callback style
        doc = {
          _id: docOrId,
          _rev: optsOrRev
        };
        if (typeof opts === 'function') {
          callback = opts;
          opts = {};
        }
      } else {
        // doc, opts, callback style
        doc = docOrId;
        if (typeof optsOrRev === 'function') {
          callback = optsOrRev;
          opts = {};
        } else {
          callback = opts;
          opts = optsOrRev;
        }
      }
      var rev = (doc._rev || opts.rev);

      sendMessage('remove', [doc._id, rev], callback);
  });

  api.getAttachment =
    adapterFun('getAttachment', function (docId, attachmentId, opts,
                                                callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      sendMessage('getAttachment', [docId, attachmentId, opts], callback);
  });

  api.removeAttachment =
    adapterFun('removeAttachment', function (docId, attachmentId, rev,
                                                   callback) {

      sendMessage('removeAttachment', [docId, attachmentId, rev], callback);
    });

  // Add the attachment given by blob and its contentType property
  // to the document with the given id, the revision given by rev, and
  // add it to the database given by host.
  api.putAttachment =
    adapterFun('putAttachment', function (docId, attachmentId, rev, blob,
                                                type, callback) {
      if (typeof type === 'function') {
        callback = type;
        type = blob;
        blob = rev;
        rev = null;
      }
      if (typeof type === 'undefined') {
        type = blob;
        blob = rev;
        rev = null;
      }

      if (typeof blob === 'string') {
        var binary;
        try {
          binary = atob(blob);
        } catch (err) {
          // it's not base64-encoded, so throw error
          return callback(errors.error(errors.BAD_ARG,
            'Attachments need to be base64 encoded'));
        }
        blob = utils.createBlob([utils.binaryStringToArrayBuffer(binary)], {type: type});
      }

      var args = [docId, attachmentId, rev, blob, type];
      sendMessage('putAttachment', args, callback);
    });

  api.put = adapterFun('put', utils.getArguments(function (args) {
    var temp, temptype, opts;
    var doc = args.shift();
    var id = '_id' in doc;
    var callback = args.pop();
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      return callback(errors.error(errors.NOT_AN_OBJECT));
    }

    doc = utils.clone(doc);

    preprocessAttachments(doc).then(function () {
      while (true) {
        temp = args.shift();
        temptype = typeof temp;
        if (temptype === "string" && !id) {
          doc._id = temp;
          id = true;
        } else if (temptype === "string" && id && !('_rev' in doc)) {
          doc._rev = temp;
        } else if (temptype === "object") {
          opts = utils.clone(temp);
        }
        if (!args.length) {
          break;
        }
      }
      opts = opts || {};

      sendMessage('put', [doc, opts], callback);
    })["catch"](callback);

  }));

  api.post = adapterFun('post', function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = utils.clone(opts);

    sendMessage('post', [doc, opts], callback);
  });

  api._bulkDocs = function (req, opts, callback) {
    sendMessage('bulkDocs', [req, opts], callback);
  };

  api._allDocs = function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('allDocs', [opts], callback);
  };

  api._changes = function (opts) {
    opts = utils.clone(opts);

    if (opts.continuous) {
      var messageId = uuid();
      api._changesListeners[messageId] = opts.onChange;
      api._callbacks[messageId] = opts.complete;
      sendRawMessage(messageId, 'liveChanges', [opts]);
      return {
        cancel: function () {
          sendRawMessage(messageId, 'cancelChanges', []);
        }
      };
    }

    sendMessage('changes', [opts], function (err, res) {
      if (err || res == null) {
        opts.complete(err);
        return callback(err);
      }
      res.results.forEach(function (change) {
        opts.onChange(change);
      });
      if (opts.returnDocs === false || opts.return_docs === false) {
        res.results = [];
      }
      opts.complete(null, res);
    });
  };

  // Given a set of document/revision IDs (given by req), tets the subset of
  // those that do NOT correspond to revisions stored in the database.
  // See http://wiki.apache.org/couchdb/HttpPostRevsDiff
  api.revsDiff = adapterFun('revsDiff', function (req, opts, callback) {
    // If no options were given, set the callback to be the second parameter
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    sendMessage('revsDiff', [req, opts], callback);
  });

  api._viewCleanup = adapterFun('viewCleanup', function (callback) {
    sendMessage('viewCleanup', [], callback);
  });

  api._close = function (callback) {
    api._closed = true;
    callback();
  };

  api.destroy = adapterFun('destroy', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('destroy', [], function (err, res) {
      if (err) {
        api.emit('error', err);
        return callback(err);
      }
      api._destroyed = true;
      worker.removeEventListener('message', workerListener);
      api.emit('destroyed');
      callback(null, res);
    });
  });

  // api.name was added in pouchdb 6.0.0
  api._instanceId = api.name || opts.originalName;
  api._callbacks = {};
  api._changesListeners = {};

  // TODO: remove this workaround when the changes filter plugin will be
  // removed from core
  api.changes = function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    opts = opts || {};

    // By default set return_docs to false if the caller has opts.live = true,
    // this will prevent us from collecting the set of changes indefinitely
    // resulting in growing memory
    opts.return_docs = ('return_docs' in opts) ? opts.return_docs : !opts.live;
    
    return new Changes(this, opts, callback);
  };

  worker.addEventListener('message', workerListener);

  var workerOpts = {
    name: api._instanceId,
    auto_compaction: !!opts.auto_compaction,
    storage: opts.storage,
    adapter: opts.worker_adapter
  };
  if (opts.worker_adapter) {
    workerOpts.worker_adapter = opts.worker_adapter;
  }
  if (opts.revs_limit) {
    workerOpts.revs_limit = opts.revs_limit;
  }

  sendMessage('createDatabase', [workerOpts], function (err) {
    if (err) {
      return callback(err);
    }
    callback(null, api);
  });
}

// WorkerPouch is a valid adapter.
WorkerPouch.valid = function () {
  return true;
};
WorkerPouch.use_prefix = false;

module.exports = WorkerPouch;

},{"1":1,"10":10,"13":13,"6":6,"7":7,"9":9}],3:[function(_dereq_,module,exports){
'use strict';
/* global webkitURL */

module.exports = function createWorker(code) {
  var createBlob = _dereq_(9).createBlob;
  var URLCompat = typeof URL !== 'undefined' ? URL : webkitURL;

  function makeBlobURI(script) {
    var blob = createBlob([script], {type: 'text/javascript'});
    return URLCompat.createObjectURL(blob);
  }

  var blob = createBlob([code], {type: 'text/javascript'});
  return new Worker(makeBlobURI(blob));
};
},{"9":9}],4:[function(_dereq_,module,exports){
(function (global){
'use strict';

// main script used with a blob-style worker

var extend = _dereq_(18).extend;
var WorkerPouchCore = _dereq_(2);
var createWorker = _dereq_(3);
var isSupportedBrowser = _dereq_(5);
var workerCode = _dereq_(11);

function WorkerPouch(opts, callback) {
  var api = this;

  var worker = window.__pouchdb_global_worker; // cache so there's only one
  if (!worker) {
    try {
      worker = createWorker(workerCode);
      worker.addEventListener('error', function (e) {
        if ('console' in global && 'warn' in console) {
          console.warn('worker threw an error', e.error);
        }
      });
      window.__pouchdb_global_worker = worker;
    } catch (e) {
      if ('console' in global && 'info' in console) {
        console.info('This browser is not supported by WorkerPouch. ' +
          'Please use isSupportedBrowser() to check.', e);
      }
      return callback(new Error('browser unsupported by worker-pouch'));
    }
  }

  var _opts = extend({
    worker: function () { return worker; }
  }, opts);

  WorkerPouchCore.call(this, _opts, callback);
}

WorkerPouch.valid = function () {
  return true;
};
WorkerPouch.use_prefix = false;

WorkerPouch.isSupportedBrowser = isSupportedBrowser;

module.exports = WorkerPouch;

/* istanbul ignore next */
if (typeof window !== 'undefined' && window.PouchDB) {
  window.PouchDB.adapter('worker', module.exports);
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"11":11,"18":18,"2":2,"3":3,"5":5}],5:[function(_dereq_,module,exports){
(function (global){
'use strict';

function _interopDefault (ex) {
  return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex;
}

var Promise = _interopDefault(_dereq_(19));
var createWorker = _dereq_(3);

module.exports = function isSupportedBrowser() {
  return Promise.resolve().then(function () {
    // synchronously throws in IE/Edge
    var worker = createWorker('' +
      'self.onmessage = function () {' +
      '  self.postMessage({' +
      '    hasIndexedDB: (typeof indexedDB !== "undefined")' +
      '  });' +
      '};');

    return new Promise(function (resolve, reject) {

      function listener(e) {
        worker.terminate();
        if (e.data.hasIndexedDB) {
          resolve();
          return;
        }
        reject();
      }

      function errorListener() {
        worker.terminate();
        reject();
      }

      worker.addEventListener('error', errorListener);
      worker.addEventListener('message', listener);
      worker.postMessage({});
    });
  }).then(function () {
    return true;
  }, function (err) {
    if ('console' in global && 'info' in console) {
      console.info('This browser is not supported by WorkerPouch', err);
    }
    return false;
  });
};
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"19":19,"3":3}],6:[function(_dereq_,module,exports){
(function (process){
'use strict';

var utils = _dereq_(9);
var log = _dereq_(13)('pouchdb:worker:client');
var isBrowser = typeof process === 'undefined' || process.browser;

exports.preprocessAttachments = function preprocessAttachments(doc) {
  if (!doc._attachments || !Object.keys(doc._attachments)) {
    return utils.Promise.resolve();
  }

  return utils.Promise.all(Object.keys(doc._attachments).map(function (key) {
    var attachment = doc._attachments[key];
    if (attachment.data && typeof attachment.data !== 'string') {
      if (isBrowser) {
        return new utils.Promise(function (resolve) {
          utils.readAsBinaryString(attachment.data, function (binary) {
            attachment.data = btoa(binary);
            resolve();
          });
        });
      } else {
        attachment.data = attachment.data.toString('base64');
      }
    }
  }));
};

function encodeObjectArg(arg) {
  // these can't be encoded by normal structured cloning
  var funcKeys = ['filter', 'map', 'reduce'];
  var keysToRemove = ['onChange', 'processChange', 'complete'];
  var clonedArg = {};
  Object.keys(arg).forEach(function (key) {
    if (keysToRemove.indexOf(key) !== -1) {
      return;
    }
    if (funcKeys.indexOf(key) !== -1 && typeof arg[key] === 'function') {
      clonedArg[key] = {
        type: 'func',
        func: arg[key].toString()
      };
    } else {
      clonedArg[key] = arg[key];
    }
  });
  return clonedArg;
}

exports.encodeArgs = function encodeArgs(args) {
  var result = [];
  args.forEach(function (arg) {
    if (arg === null || typeof arg !== 'object' ||
        Array.isArray(arg) || arg instanceof Blob || arg instanceof Date) {
      result.push(arg);
    } else {
      result.push(encodeObjectArg(arg));
    }
  });
  return result;
};

exports.padInt = function padInt(i, len) {
  var res = i.toString();
  while (res.length < len) {
    res = '0' + res;
  }
  return res;
};


exports.adapterFun = function adapterFun(name, callback) {

  function logApiCall(self, name, args) {
    if (!log.enabled) {
      return;
    }
    // db.name was added in pouch 6.0.0
    var dbName = self.name || self._db_name;
    var logArgs = [dbName, name];
    for (var i = 0; i < args.length - 1; i++) {
      logArgs.push(args[i]);
    }
    log.apply(null, logArgs);

    // override the callback itself to log the response
    var origCallback = args[args.length - 1];
    args[args.length - 1] = function (err, res) {
      var responseArgs = [dbName, name];
      responseArgs = responseArgs.concat(
        err ? ['error', err] : ['success', res]
      );
      log.apply(null, responseArgs);
      origCallback(err, res);
    };
  }


  return utils.toPromise(utils.getArguments(function (args) {
    if (this._closed) {
      return utils.Promise.reject(new Error('database is closed'));
    }
    var self = this;
    logApiCall(self, name, args);
    if (!this.taskqueue.isReady) {
      return new utils.Promise(function (fulfill, reject) {
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
};
}).call(this,_dereq_(29))
},{"13":13,"29":29,"9":9}],7:[function(_dereq_,module,exports){
"use strict";

var inherits = _dereq_(17);
inherits(PouchError, Error);

function PouchError(opts) {
  Error.call(opts.reason);
  this.status = opts.status;
  this.name = opts.error;
  this.message = opts.reason;
  this.error = true;
}

PouchError.prototype.toString = function () {
  return JSON.stringify({
    status: this.status,
    name: this.name,
    message: this.message
  });
};

exports.UNAUTHORIZED = new PouchError({
  status: 401,
  error: 'unauthorized',
  reason: "Name or password is incorrect."
});

exports.MISSING_BULK_DOCS = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: "Missing JSON list of 'docs'"
});

exports.MISSING_DOC = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'missing'
});

exports.REV_CONFLICT = new PouchError({
  status: 409,
  error: 'conflict',
  reason: 'Document update conflict'
});

exports.INVALID_ID = new PouchError({
  status: 400,
  error: 'invalid_id',
  reason: '_id field must contain a string'
});

exports.MISSING_ID = new PouchError({
  status: 412,
  error: 'missing_id',
  reason: '_id is required for puts'
});

exports.RESERVED_ID = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Only reserved document ids may start with underscore.'
});

exports.NOT_OPEN = new PouchError({
  status: 412,
  error: 'precondition_failed',
  reason: 'Database not open'
});

exports.UNKNOWN_ERROR = new PouchError({
  status: 500,
  error: 'unknown_error',
  reason: 'Database encountered an unknown error'
});

exports.BAD_ARG = new PouchError({
  status: 500,
  error: 'badarg',
  reason: 'Some query argument is invalid'
});

exports.INVALID_REQUEST = new PouchError({
  status: 400,
  error: 'invalid_request',
  reason: 'Request was invalid'
});

exports.QUERY_PARSE_ERROR = new PouchError({
  status: 400,
  error: 'query_parse_error',
  reason: 'Some query parameter is invalid'
});

exports.DOC_VALIDATION = new PouchError({
  status: 500,
  error: 'doc_validation',
  reason: 'Bad special document member'
});

exports.BAD_REQUEST = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Something wrong with the request'
});

exports.NOT_AN_OBJECT = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Document must be a JSON object'
});

exports.DB_MISSING = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'Database not found'
});

exports.IDB_ERROR = new PouchError({
  status: 500,
  error: 'indexed_db_went_bad',
  reason: 'unknown'
});

exports.WSQ_ERROR = new PouchError({
  status: 500,
  error: 'web_sql_went_bad',
  reason: 'unknown'
});

exports.LDB_ERROR = new PouchError({
  status: 500,
  error: 'levelDB_went_went_bad',
  reason: 'unknown'
});

exports.FORBIDDEN = new PouchError({
  status: 403,
  error: 'forbidden',
  reason: 'Forbidden by design doc validate_doc_update function'
});

exports.INVALID_REV = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Invalid rev format'
});

exports.FILE_EXISTS = new PouchError({
  status: 412,
  error: 'file_exists',
  reason: 'The database could not be created, the file already exists.'
});

exports.MISSING_STUB = new PouchError({
  status: 412,
  error: 'missing_stub'
});

exports.error = function (error, reason, name) {
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
    if (name !== undefined) {
      this.name = name;
    }
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
  CustomPouchError.prototype = PouchError.prototype;
  return new CustomPouchError(reason);
};

// Find one of the errors defined above based on the value
// of the specified property.
// If reason is provided prefer the error matching that reason.
// This is for differentiating between errors with the same name and status,
// eg, bad_request.
exports.getErrorTypeByProp = function (prop, value, reason) {
  var errors = exports;
  var keys = Object.keys(errors).filter(function (key) {
    var error = errors[key];
    return typeof error !== 'function' && error[prop] === value;
  });
  var key = reason && keys.filter(function (key) {
      var error = errors[key];
      return error.message === reason;
    })[0] || keys[0];
  return (key) ? errors[key] : null;
};

exports.generateErrorFromResponse = function (res) {
  var error, errName, errType, errMsg, errReason;
  var errors = exports;

  errName = (res.error === true && typeof res.name === 'string') ?
    res.name :
    res.error;
  errReason = res.reason;
  errType = errors.getErrorTypeByProp('name', errName, errReason);

  if (res.missing ||
    errReason === 'missing' ||
    errReason === 'deleted' ||
    errName === 'not_found') {
    errType = errors.MISSING_DOC;
  } else if (errName === 'doc_validation') {
    // doc validation needs special treatment since
    // res.reason depends on the validation error.
    // see utils.js
    errType = errors.DOC_VALIDATION;
    errMsg = errReason;
  } else if (errName === 'bad_request' && errType.message !== errReason) {
    // if bad_request error already found based on reason don't override.

    // attachment errors.
    if (errReason.indexOf('unknown stub attachment') === 0) {
      errType = errors.MISSING_STUB;
      errMsg = errReason;
    } else {
      errType = errors.BAD_REQUEST;
    }
  }

  // fallback to error by statys or unknown error.
  if (!errType) {
    errType = errors.getErrorTypeByProp('status', res.status, errReason) ||
    errors.UNKNOWN_ERROR;
  }

  error = errors.error(errType, errReason, errName);

  // Keep custom message.
  if (errMsg) {
    error.message = errMsg;
  }

  // Keep helpful response data in our error messages.
  if (res.id) {
    error.id = res.id;
  }
  if (res.status) {
    error.status = res.status;
  }
  if (res.statusText) {
    error.name = res.statusText;
  }
  if (res.missing) {
    error.missing = res.missing;
  }

  return error;
};

},{"17":17}],8:[function(_dereq_,module,exports){
'use strict';

function isBinaryObject(object) {
  return object instanceof ArrayBuffer ||
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
  // Blob
  return object.slice(0, object.size, object.type);
}

module.exports = function clone(object) {
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

  newObject = {};
  for (i in object) {
    if (Object.prototype.hasOwnProperty.call(object, i)) {
      var value = clone(object[i]);
      if (typeof value !== 'undefined') {
        newObject[i] = value;
      }
    }
  }
  return newObject;
};

},{}],9:[function(_dereq_,module,exports){
(function (process,global){
'use strict';

function _interopDefault (ex) {
  return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex;
}

var Promise = _interopDefault(_dereq_(19));

exports.lastIndexOf = function lastIndexOf(str, char) {
  for (var i = str.length - 1; i >= 0; i--) {
    if (str.charAt(i) === char) {
      return i;
    }
  }
  return -1;
};

exports.clone = _dereq_(8);

/* istanbul ignore next */
exports.once = function once(fun) {
  var called = false;
  return exports.getArguments(function (args) {
    if (called) {
      if ('console' in global && 'trace' in console) {
        console.trace();
      }
      throw new Error('once called  more than once');
    } else {
      called = true;
      fun.apply(this, args);
    }
  });
};
/* istanbul ignore next */
exports.getArguments = function getArguments(fun) {
  return function () {
    var len = arguments.length;
    var args = new Array(len);
    var i = -1;
    while (++i < len) {
      args[i] = arguments[i];
    }
    return fun.call(this, args);
  };
};
/* istanbul ignore next */
exports.toPromise = function toPromise(func) {
  //create the function we will be returning
  return exports.getArguments(function (args) {
    var self = this;
    var tempCB = (typeof args[args.length - 1] === 'function') ? args.pop() : false;
    // if the last argument is a function, assume its a callback
    var usedCB;
    if (tempCB) {
      // if it was a callback, create a new callback which calls it,
      // but do so async so we don't trap any errors
      usedCB = function (err, resp) {
        process.nextTick(function () {
          tempCB(err, resp);
        });
      };
    }
    var promise = new Promise(function (fulfill, reject) {
      try {
        var callback = exports.once(function (err, mesg) {
          if (err) {
            reject(err);
          } else {
            fulfill(mesg);
          }
        });
        // create a callback for this invocation
        // apply the function in the orig context
        args.push(callback);
        func.apply(self, args);
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
    promise.cancel = function () {
      return this;
    };
    return promise;
  });
};

exports.inherits = _dereq_(17);
exports.Promise = Promise;

var binUtil = _dereq_(21);

exports.createBlob = binUtil.createBlob;
exports.readAsArrayBuffer = binUtil.readAsArrayBuffer;
exports.readAsBinaryString = binUtil.readAsBinaryString;
exports.binaryStringToArrayBuffer = binUtil.binaryStringToArrayBuffer;
exports.arrayBufferToBinaryString = binUtil.arrayBufferToBinaryString;

}).call(this,_dereq_(29),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"17":17,"19":19,"21":21,"29":29,"8":8}],10:[function(_dereq_,module,exports){
"use strict";

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
var chars = (
'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
'abcdefghijklmnopqrstuvwxyz'
).split('');
function getValue(radix) {
  return 0 | Math.random() * radix;
}
function uuid(len, radix) {
  radix = radix || chars.length;
  var out = '';
  var i = -1;

  if (len) {
    // Compact form
    while (++i < len) {
      out += chars[getValue(radix)];
    }
    return out;
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
        out += '-';
        break;
      case 19:
        out += chars[(getValue(16) & 0x3) | 0x8];
        break;
      default:
        out += chars[getValue(16)];
    }
  }

  return out;
}



module.exports = uuid;


},{}],11:[function(_dereq_,module,exports){
// this code is automatically generated by bin/build.js
module.exports = "!function o(a,s,u){function c(t,e){if(!s[t]){if(!a[t]){var n=\"function\"==typeof require&&require;if(!e&&n)return n(t,!0);if(f)return f(t,!0);var r=new Error(\"Cannot find module '\"+t+\"'\");throw r.code=\"MODULE_NOT_FOUND\",r}var i=s[t]={exports:{}};a[t][0].call(i.exports,function(e){return c(a[t][1][e]||e)},i,i.exports,o,a,s,u)}return s[t].exports}for(var f=\"function\"==typeof require&&require,e=0;e<u.length;e++)c(u[e]);return c}({1:[function(e,t,s){\"use strict\";function i(e){Error.call(e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}e(37)(i,Error),i.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message})},s.UNAUTHORIZED=new i({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),s.MISSING_BULK_DOCS=new i({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),s.MISSING_DOC=new i({status:404,error:\"not_found\",reason:\"missing\"}),s.REV_CONFLICT=new i({status:409,error:\"conflict\",reason:\"Document update conflict\"}),s.INVALID_ID=new i({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),s.MISSING_ID=new i({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),s.RESERVED_ID=new i({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),s.NOT_OPEN=new i({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),s.UNKNOWN_ERROR=new i({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),s.BAD_ARG=new i({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),s.INVALID_REQUEST=new i({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),s.QUERY_PARSE_ERROR=new i({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),s.DOC_VALIDATION=new i({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),s.BAD_REQUEST=new i({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),s.NOT_AN_OBJECT=new i({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),s.DB_MISSING=new i({status:404,error:\"not_found\",reason:\"Database not found\"}),s.IDB_ERROR=new i({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),s.WSQ_ERROR=new i({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),s.LDB_ERROR=new i({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),s.FORBIDDEN=new i({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),s.INVALID_REV=new i({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),s.FILE_EXISTS=new i({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),s.MISSING_STUB=new i({status:412,error:\"missing_stub\"}),s.error=function(n,e,r){function t(e){for(var t in n)\"function\"!=typeof n[t]&&(this[t]=n[t]);void 0!==r&&(this.name=r),void 0!==e&&(this.reason=e)}return t.prototype=i.prototype,new t(e)},s.getErrorTypeByProp=function(n,r,t){var i=s,e=Object.keys(i).filter(function(e){var t=i[e];return\"function\"!=typeof t&&t[n]===r}),o=t&&e.filter(function(e){return i[e].message===t})[0]||e[0];return o?i[o]:null},s.generateErrorFromResponse=function(e){var t,n,r,i,o,a=s;return n=!0===e.error&&\"string\"==typeof e.name?e.name:e.error,o=e.reason,r=a.getErrorTypeByProp(\"name\",n,o),e.missing||\"missing\"===o||\"deleted\"===o||\"not_found\"===n?r=a.MISSING_DOC:\"doc_validation\"===n?(r=a.DOC_VALIDATION,i=o):\"bad_request\"===n&&r.message!==o&&(0===o.indexOf(\"unknown stub attachment\")?(r=a.MISSING_STUB,i=o):r=a.BAD_REQUEST),r=r||(a.getErrorTypeByProp(\"status\",e.status,o)||a.UNKNOWN_ERROR),t=a.error(r,o,n),i&&(t.message=i),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.statusText&&(t.name=e.statusText),e.missing&&(t.missing=e.missing),t}},{37:37}],2:[function(e,t,n){\"use strict\";var r,h=(r=e(47))&&\"object\"==typeof r&&\"default\"in r?r.default:r,d=e(1),i=e(6),p=i.decodeArgs,v={},g={},y=e(22)(\"pouchdb:worker\");t.exports=function(n,a){function s(e,t){\"function\"!=typeof n.postMessage?t.ports[0].postMessage(e):n.postMessage(e)}function u(e,t,n,r){y(\" -> sendError\",e,t,n),s({type:\"error\",id:e,messageId:t,content:i.createError(n)},r)}function c(e,t,n,r){y(\" -> sendSuccess\",e,t),s({type:\"success\",id:e,messageId:t,content:n},r)}function o(t,e,n,r,i){var o=v[\"$\"+t];if(!o)return u(t,n,{error:\"db not found\"},i);h.resolve().then(function(){return o[e].apply(o,r)}).then(function(e){c(t,n,e,i)}).catch(function(e){u(t,n,e,i)})}function f(n,r,e,i){var o=v[\"$\"+n];if(!o)return u(n,r,{error:\"db not found\"},i);h.resolve().then(function(){var t=o.changes(e[0]);(g[r]=t).on(\"change\",function(e){!function(e,t,n,r){y(\" -> sendUpdate\",e,t),s({type:\"update\",id:e,messageId:t,content:n},r)}(n,r,e,i)}).on(\"complete\",function(e){t.removeAllListeners(),delete g[r],c(n,r,e,i)}).on(\"error\",function(e){t.removeAllListeners(),delete g[r],u(n,r,e,i)})})}function l(e,t,n){return h.resolve().then(function(){e.on(\"error\",function(e){!function(e,t,n){y(\" -> sendUncaughtError\",e,t),s({type:\"uncaughtError\",id:e,content:i.createError(t)},n)}(t,e,n)})})}function r(e,t,n,r,i){switch(y(\"onReceiveMessage\",t,e,n,r,i),t){case\"createDatabase\":return function(t,n,e,r){var i=\"$\"+t,o=v[i];return o?l(o,t,r).then(function(){return c(t,n,{ok:!0,exists:!0},r)}):(\"string\"==typeof e[0]?e[0]:e[0].name)?void l(o=v[i]=a(e[0]),t,r).then(function(){c(t,n,{ok:!0},r)}).catch(function(e){u(t,n,e,r)}):u(t,n,{error:\"you must provide a database name\"},r)}(e,n,r,i);case\"id\":case\"info\":case\"put\":case\"allDocs\":case\"bulkDocs\":case\"post\":case\"get\":case\"remove\":case\"revsDiff\":case\"compact\":case\"viewCleanup\":case\"removeAttachment\":case\"putAttachment\":case\"query\":return o(e,t,n,r,i);case\"changes\":return function(e,t,n,r){var i=n[0];i&&\"object\"==typeof i&&(i.returnDocs=!0,i.return_docs=!0),o(e,\"changes\",t,n,r)}(e,n,r,i);case\"getAttachment\":return function(r,i,o,a){var s=v[\"$\"+r];if(!s)return u(r,i,{error:\"db not found\"},a);h.resolve().then(function(){var e=o[0],t=o[1],n=o[2];return\"object\"!=typeof n&&(n={}),s.get(e,n).then(function(e){if(!e._attachments||!e._attachments[t])throw d.MISSING_DOC;return s.getAttachment.apply(s,o).then(function(e){c(r,i,e,a)})})}).catch(function(e){u(r,i,e,a)})}(e,n,r,i);case\"liveChanges\":return f(e,n,r,i);case\"cancelChanges\":return function(e){var t=g[e];t&&t.cancel()}(n);case\"destroy\":return function(t,n,e,r){var i=\"$\"+t,o=v[i];if(!o)return u(t,n,{error:\"db not found\"},r);delete v[i],h.resolve().then(function(){return o.destroy.apply(o,e)}).then(function(e){c(t,n,e,r)}).catch(function(e){u(t,n,e,r)})}(e,n,r,i);default:return u(e,n,{error:\"unknown API method: \"+t},i)}}n.addEventListener(\"message\",function(e){if(e.data&&e.data.id&&e.data.args&&e.data.type&&e.data.messageId){var t=e.data.id;\"close\"===e.data.type?(y(\"closing worker\",t),delete v[\"$\"+t]):function(e,t,n){r(t,e.type,e.messageId,p(e.args),n)}(e.data,t,e)}})}},{1:1,22:22,47:47,6:6}],3:[function(e,t,n){\"use strict\";var r=e(2),i=e(4);r(self,i)},{2:2,4:4}],4:[function(e,t,n){\"use strict\";t.exports=e(70).plugin(e(61)).plugin(e(60)).plugin(e(79)).plugin(e(82)).plugin(e(63))},{60:60,61:61,63:63,70:70,79:79,82:82}],5:[function(_dereq_,module,exports){\"use strict\";var log=_dereq_(22)(\"pouchdb:worker\");module.exports=function safeEval(str){log(\"safeEvaling\",str);var target={};return eval(\"target.target = (\"+str+\");\"),log(\"returning\",target.target),target.target}},{22:22}],6:[function(e,t,n){\"use strict\";var r=e(5);n.createError=function(e){var t=e.status||500;return e.name&&e.message&&(\"Error\"!==e.name&&\"TypeError\"!==e.name||(-1!==e.message.indexOf(\"Bad special document member\")?e.name=\"doc_validation\":e.name=\"bad_request\"),e={error:e.name,name:e.name,reason:e.message,message:e.message,status:t}),e},n.decodeArgs=function(e){var n=[\"filter\",\"map\",\"reduce\"];return e.forEach(function(t){\"object\"!=typeof t||null===t||Array.isArray(t)||n.forEach(function(e){e in t&&null!==t[e]?\"func\"===t[e].type&&t[e].func&&(t[e]=r(t[e].func)):delete t[e]})}),e}},{5:5}],7:[function(e,t,n){(function(n){function e(e){this._db=e,this._operations=[],this._written=!1}e.prototype._checkWritten=function(){if(this._written)throw new Error(\"write() already called on this batch\")},e.prototype.put=function(e,t){this._checkWritten();var n=this._db._checkKey(e,\"key\",this._db._isBuffer);if(n)throw n;return this._db._isBuffer(e)||(e=String(e)),this._db._isBuffer(t)||(t=String(t)),\"function\"==typeof this._put?this._put(e,t):this._operations.push({type:\"put\",key:e,value:t}),this},e.prototype.del=function(e){this._checkWritten();var t=this._db._checkKey(e,\"key\",this._db._isBuffer);if(t)throw t;return this._db._isBuffer(e)||(e=String(e)),\"function\"==typeof this._del?this._del(e):this._operations.push({type:\"del\",key:e}),this},e.prototype.clear=function(){return this._checkWritten(),this._operations=[],\"function\"==typeof this._clear&&this._clear(),this},e.prototype.write=function(e,t){if(this._checkWritten(),\"function\"==typeof e&&(t=e),\"function\"!=typeof t)throw new Error(\"write() requires a callback argument\");return\"object\"!=typeof e&&(e={}),this._written=!0,\"function\"==typeof this._write?this._write(t):\"function\"==typeof this._db._batch?this._db._batch(this._operations,e,t):void n.nextTick(t)},t.exports=e}).call(this,e(88))},{88:88}],8:[function(e,t,n){(function(n){function e(e){this.db=e,this._ended=!1,this._nexting=!1}e.prototype.next=function(e){var t=this;if(\"function\"!=typeof e)throw new Error(\"next() requires a callback argument\");return t._ended?e(new Error(\"cannot call next() after end()\")):t._nexting?e(new Error(\"cannot call next() before previous next() has completed\")):(t._nexting=!0,\"function\"==typeof t._next?t._next(function(){t._nexting=!1,e.apply(null,arguments)}):void n.nextTick(function(){t._nexting=!1,e()}))},e.prototype.end=function(e){if(\"function\"!=typeof e)throw new Error(\"end() requires a callback argument\");return this._ended?e(new Error(\"end() already called on iterator\")):(this._ended=!0,\"function\"==typeof this._end?this._end(e):void n.nextTick(e))},t.exports=e}).call(this,e(88))},{88:88}],9:[function(o,a,e){(function(t,s){var e=o(130),n=o(8),r=o(7);function i(e){if(!arguments.length||void 0===e)throw new Error(\"constructor requires at least a location argument\");if(\"string\"!=typeof e)throw new Error(\"constructor requires a location string argument\");this.location=e,this.status=\"new\"}i.prototype.open=function(e,t){var n=this,r=this.status;if(\"function\"==typeof e&&(t=e),\"function\"!=typeof t)throw new Error(\"open() requires a callback argument\");\"object\"!=typeof e&&(e={}),e.createIfMissing=0!=e.createIfMissing,e.errorIfExists=!!e.errorIfExists,\"function\"==typeof this._open?(this.status=\"opening\",this._open(e,function(e){if(e)return n.status=r,t(e);n.status=\"open\",t()})):(this.status=\"open\",s.nextTick(t))},i.prototype.close=function(t){var n=this,r=this.status;if(\"function\"!=typeof t)throw new Error(\"close() requires a callback argument\");\"function\"==typeof this._close?(this.status=\"closing\",this._close(function(e){if(e)return n.status=r,t(e);n.status=\"closed\",t()})):(this.status=\"closed\",s.nextTick(t))},i.prototype.get=function(e,t,n){var r;if(\"function\"==typeof t&&(n=t),\"function\"!=typeof n)throw new Error(\"get() requires a callback argument\");return(r=this._checkKey(e,\"key\",this._isBuffer))?n(r):(this._isBuffer(e)||(e=String(e)),\"object\"!=typeof t&&(t={}),t.asBuffer=0!=t.asBuffer,\"function\"==typeof this._get?this._get(e,t,n):void s.nextTick(function(){n(new Error(\"NotFound\"))}))},i.prototype.put=function(e,t,n,r){var i;if(\"function\"==typeof n&&(r=n),\"function\"!=typeof r)throw new Error(\"put() requires a callback argument\");return(i=this._checkKey(e,\"key\",this._isBuffer))?r(i):(this._isBuffer(e)||(e=String(e)),null==t||this._isBuffer(t)||s.browser||(t=String(t)),\"object\"!=typeof n&&(n={}),\"function\"==typeof this._put?this._put(e,t,n,r):void s.nextTick(r))},i.prototype.del=function(e,t,n){var r;if(\"function\"==typeof t&&(n=t),\"function\"!=typeof n)throw new Error(\"del() requires a callback argument\");return(r=this._checkKey(e,\"key\",this._isBuffer))?n(r):(this._isBuffer(e)||(e=String(e)),\"object\"!=typeof t&&(t={}),\"function\"==typeof this._del?this._del(e,t,n):void s.nextTick(n))},i.prototype.batch=function(e,t,n){if(!arguments.length)return this._chainedBatch();if(\"function\"==typeof t&&(n=t),\"function\"==typeof e&&(n=e),\"function\"!=typeof n)throw new Error(\"batch(array) requires a callback argument\");if(!Array.isArray(e))return n(new Error(\"batch(array) requires an array argument\"));t&&\"object\"==typeof t||(t={});for(var r,i,o=0,a=e.length;o<a;o++)if(\"object\"==typeof(r=e[o])){if(i=this._checkKey(r.type,\"type\",this._isBuffer))return n(i);if(i=this._checkKey(r.key,\"key\",this._isBuffer))return n(i)}if(\"function\"==typeof this._batch)return this._batch(e,t,n);s.nextTick(n)},i.prototype.approximateSize=function(e,t,n){if(null==e||null==t||\"function\"==typeof e||\"function\"==typeof t)throw new Error(\"approximateSize() requires valid `start`, `end` and `callback` arguments\");if(\"function\"!=typeof n)throw new Error(\"approximateSize() requires a callback argument\");if(this._isBuffer(e)||(e=String(e)),this._isBuffer(t)||(t=String(t)),\"function\"==typeof this._approximateSize)return this._approximateSize(e,t,n);s.nextTick(function(){n(null,0)})},i.prototype._setupIteratorOptions=function(t){var n=this;return t=e(t),[\"start\",\"end\",\"gt\",\"gte\",\"lt\",\"lte\"].forEach(function(e){t[e]&&n._isBuffer(t[e])&&0===t[e].length&&delete t[e]}),t.reverse=!!t.reverse,t.keys=0!=t.keys,t.values=0!=t.values,t.limit=\"limit\"in t?t.limit:-1,t.keyAsBuffer=0!=t.keyAsBuffer,t.valueAsBuffer=0!=t.valueAsBuffer,t},i.prototype.iterator=function(e){return\"object\"!=typeof e&&(e={}),e=this._setupIteratorOptions(e),\"function\"==typeof this._iterator?this._iterator(e):new n(this)},i.prototype._chainedBatch=function(){return new r(this)},i.prototype._isBuffer=function(e){return t.isBuffer(e)},i.prototype._checkKey=function(e,t){if(null==e)return new Error(t+\" cannot be `null` or `undefined`\");if(this._isBuffer(e)){if(0===e.length)return new Error(t+\" cannot be an empty Buffer\")}else if(\"\"===String(e))return new Error(t+\" cannot be an empty String\")},a.exports=i}).call(this,{isBuffer:o(38)},o(88))},{130:130,38:38,7:7,8:8,88:88}],10:[function(e,t,n){n.AbstractLevelDOWN=e(9),n.AbstractIterator=e(8),n.AbstractChainedBatch=e(7),n.isLevelDOWN=e(11)},{11:11,7:7,8:8,9:9}],11:[function(e,t,n){var r=e(9);t.exports=function(t){return!(!t||\"object\"!=typeof t)&&Object.keys(r.prototype).filter(function(e){return\"_\"!=e[0]&&\"approximateSize\"!=e}).every(function(e){return\"function\"==typeof t[e]})}},{9:9}],12:[function(e,t,n){\"use strict\";t.exports=function(r){return function(){var e=arguments.length;if(e){for(var t=[],n=-1;++n<e;)t[n]=arguments[n];return r.call(this,t)}return r.call(this,[])}}},{}],13:[function(k,E,e){(function(t){\"use strict\";var e=k(58);function o(e,t){if(e===t)return 0;for(var n=e.length,r=t.length,i=0,o=Math.min(n,r);i<o;++i)if(e[i]!==t[i]){n=e[i],r=t[i];break}return n<r?-1:r<n?1:0}function a(e){return t.Buffer&&\"function\"==typeof t.Buffer.isBuffer?t.Buffer.isBuffer(e):!(null==e||!e._isBuffer)}var f=k(16),r=Object.prototype.hasOwnProperty,l=Array.prototype.slice,n=\"foo\"===function(){}.name;function s(e){return Object.prototype.toString.call(e)}function u(e){return!a(e)&&(\"function\"==typeof t.ArrayBuffer&&(\"function\"==typeof ArrayBuffer.isView?ArrayBuffer.isView(e):!!e&&(e instanceof DataView||!!(e.buffer&&e.buffer instanceof ArrayBuffer))))}var c=E.exports=g,i=/\\s*function\\s+([^\\(\\s]*)\\s*/;function h(e){if(f.isFunction(e)){if(n)return e.name;var t=e.toString().match(i);return t&&t[1]}}function d(e,t){return\"string\"==typeof e?e.length<t?e:e.slice(0,t):e}function p(e){if(n||!f.isFunction(e))return f.inspect(e);var t=h(e);return\"[Function\"+(t?\": \"+t:\"\")+\"]\"}function v(e,t,n,r,i){throw new c.AssertionError({message:n,actual:e,expected:t,operator:r,stackStartFunction:i})}function g(e,t){e||v(e,!0,t,\"==\",c.ok)}function y(e,t,n,r){if(e===t)return!0;if(a(e)&&a(t))return 0===o(e,t);if(f.isDate(e)&&f.isDate(t))return e.getTime()===t.getTime();if(f.isRegExp(e)&&f.isRegExp(t))return e.source===t.source&&e.global===t.global&&e.multiline===t.multiline&&e.lastIndex===t.lastIndex&&e.ignoreCase===t.ignoreCase;if(null!==e&&\"object\"==typeof e||null!==t&&\"object\"==typeof t){if(u(e)&&u(t)&&s(e)===s(t)&&!(e instanceof Float32Array||e instanceof Float64Array))return 0===o(new Uint8Array(e.buffer),new Uint8Array(t.buffer));if(a(e)!==a(t))return!1;var i=(r=r||{actual:[],expected:[]}).actual.indexOf(e);return-1!==i&&i===r.expected.indexOf(t)||(r.actual.push(e),r.expected.push(t),function(e,t,n,r){if(null==e||null==t)return!1;if(f.isPrimitive(e)||f.isPrimitive(t))return e===t;if(n&&Object.getPrototypeOf(e)!==Object.getPrototypeOf(t))return!1;var i=_(e),o=_(t);if(i&&!o||!i&&o)return!1;if(i)return e=l.call(e),t=l.call(t),y(e,t,n);var a,s,u=w(e),c=w(t);if(u.length!==c.length)return!1;for(u.sort(),c.sort(),s=u.length-1;0<=s;s--)if(u[s]!==c[s])return!1;for(s=u.length-1;0<=s;s--)if(a=u[s],!y(e[a],t[a],n,r))return!1;return!0}(e,t,n,r))}return n?e===t:e==t}function _(e){return\"[object Arguments]\"==Object.prototype.toString.call(e)}function m(e,t){if(!e||!t)return!1;if(\"[object RegExp]\"==Object.prototype.toString.call(t))return t.test(e);try{if(e instanceof t)return!0}catch(e){}return!Error.isPrototypeOf(t)&&!0===t.call({},e)}function b(e,t,n,r){var i;if(\"function\"!=typeof t)throw new TypeError('\"block\" argument must be a function');\"string\"==typeof n&&(r=n,n=null),i=function(e){var t;try{e()}catch(e){t=e}return t}(t),r=(n&&n.name?\" (\"+n.name+\").\":\".\")+(r?\" \"+r:\".\"),e&&!i&&v(i,n,\"Missing expected exception\"+r);var o=\"string\"==typeof r,a=!e&&i&&!n;if((!e&&f.isError(i)&&o&&m(i,n)||a)&&v(i,n,\"Got unwanted exception\"+r),e&&i&&n&&!m(i,n)||!e&&i)throw i}c.AssertionError=function(e){this.name=\"AssertionError\",this.actual=e.actual,this.expected=e.expected,this.operator=e.operator,e.message?(this.message=e.message,this.generatedMessage=!1):(this.message=function(e){return d(p(e.actual),128)+\" \"+e.operator+\" \"+d(p(e.expected),128)}(this),this.generatedMessage=!0);var t=e.stackStartFunction||v;if(Error.captureStackTrace)Error.captureStackTrace(this,t);else{var n=new Error;if(n.stack){var r=n.stack,i=h(t),o=r.indexOf(\"\\n\"+i);if(0<=o){var a=r.indexOf(\"\\n\",o+1);r=r.substring(a+1)}this.stack=r}}},f.inherits(c.AssertionError,Error),c.fail=v,c.ok=g,c.equal=function(e,t,n){e!=t&&v(e,t,n,\"==\",c.equal)},c.notEqual=function(e,t,n){e==t&&v(e,t,n,\"!=\",c.notEqual)},c.deepEqual=function(e,t,n){y(e,t,!1)||v(e,t,n,\"deepEqual\",c.deepEqual)},c.deepStrictEqual=function(e,t,n){y(e,t,!0)||v(e,t,n,\"deepStrictEqual\",c.deepStrictEqual)},c.notDeepEqual=function(e,t,n){y(e,t,!1)&&v(e,t,n,\"notDeepEqual\",c.notDeepEqual)},c.notDeepStrictEqual=function e(t,n,r){y(t,n,!0)&&v(t,n,r,\"notDeepStrictEqual\",e)},c.strictEqual=function(e,t,n){e!==t&&v(e,t,n,\"===\",c.strictEqual)},c.notStrictEqual=function(e,t,n){e===t&&v(e,t,n,\"!==\",c.notStrictEqual)},c.throws=function(e,t,n){b(!0,e,t,n)},c.doesNotThrow=function(e,t,n){b(!1,e,t,n)},c.ifError=function(e){if(e)throw e},c.strict=e(function e(t,n){t||v(t,!0,n,\"==\",e)},c,{equal:c.strictEqual,deepEqual:c.deepStrictEqual,notEqual:c.notStrictEqual,notDeepEqual:c.notDeepStrictEqual}),c.strict.strict=c.strict;var w=Object.keys||function(e){var t=[];for(var n in e)r.call(e,n)&&t.push(n);return t}}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{16:16,58:58}],14:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}})}:t.exports=function(e,t){e.super_=t;function n(){}n.prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e}},{}],15:[function(e,t,n){t.exports=function(e){return e&&\"object\"==typeof e&&\"function\"==typeof e.copy&&\"function\"==typeof e.fill&&\"function\"==typeof e.readUInt8}},{}],16:[function(O,e,C){(function(r,i){var s=/%[sdj%]/g;C.format=function(e){if(!m(e)){for(var t=[],n=0;n<arguments.length;n++)t.push(u(arguments[n]));return t.join(\" \")}n=1;for(var r=arguments,i=r.length,o=String(e).replace(s,function(e){if(\"%%\"===e)return\"%\";if(i<=n)return e;switch(e){case\"%s\":return String(r[n++]);case\"%d\":return Number(r[n++]);case\"%j\":try{return JSON.stringify(r[n++])}catch(e){return\"[Circular]\"}default:return e}}),a=r[n];n<i;a=r[++n])y(a)||!f(a)?o+=\" \"+a:o+=\" \"+u(a);return o},C.deprecate=function(e,t){if(b(i.process))return function(){return C.deprecate(e,t).apply(this,arguments)};if(!0===r.noDeprecation)return e;var n=!1;return function(){if(!n){if(r.throwDeprecation)throw new Error(t);r.traceDeprecation?console.trace(t):console.error(t),n=!0}return e.apply(this,arguments)}};var e,o={};function u(e,t){var n={seen:[],stylize:c};return 3<=arguments.length&&(n.depth=arguments[2]),4<=arguments.length&&(n.colors=arguments[3]),g(t)?n.showHidden=t:t&&C._extend(n,t),b(n.showHidden)&&(n.showHidden=!1),b(n.depth)&&(n.depth=2),b(n.colors)&&(n.colors=!1),b(n.customInspect)&&(n.customInspect=!0),n.colors&&(n.stylize=a),h(n,e,n.depth)}function a(e,t){var n=u.styles[t];return n?\"\u001b[\"+u.colors[n][0]+\"m\"+e+\"\u001b[\"+u.colors[n][1]+\"m\":e}function c(e,t){return e}function h(t,n,r){if(t.customInspect&&n&&S(n.inspect)&&n.inspect!==C.inspect&&(!n.constructor||n.constructor.prototype!==n)){var e=n.inspect(r,t);return m(e)||(e=h(t,e,r)),e}var i=function(e,t){if(b(t))return e.stylize(\"undefined\",\"undefined\");if(m(t)){var n=\"'\"+JSON.stringify(t).replace(/^\"|\"$/g,\"\").replace(/'/g,\"\\\\'\").replace(/\\\\\"/g,'\"')+\"'\";return e.stylize(n,\"string\")}if(_(t))return e.stylize(\"\"+t,\"number\");if(g(t))return e.stylize(\"\"+t,\"boolean\");if(y(t))return e.stylize(\"null\",\"null\")}(t,n);if(i)return i;var o=Object.keys(n),a=function(e){var n={};return e.forEach(function(e,t){n[e]=!0}),n}(o);if(t.showHidden&&(o=Object.getOwnPropertyNames(n)),E(n)&&(0<=o.indexOf(\"message\")||0<=o.indexOf(\"description\")))return d(n);if(0===o.length){if(S(n)){var s=n.name?\": \"+n.name:\"\";return t.stylize(\"[Function\"+s+\"]\",\"special\")}if(w(n))return t.stylize(RegExp.prototype.toString.call(n),\"regexp\");if(k(n))return t.stylize(Date.prototype.toString.call(n),\"date\");if(E(n))return d(n)}var u,c=\"\",f=!1,l=[\"{\",\"}\"];v(n)&&(f=!0,l=[\"[\",\"]\"]),S(n)&&(c=\" [Function\"+(n.name?\": \"+n.name:\"\")+\"]\");return w(n)&&(c=\" \"+RegExp.prototype.toString.call(n)),k(n)&&(c=\" \"+Date.prototype.toUTCString.call(n)),E(n)&&(c=\" \"+d(n)),0!==o.length||f&&0!=n.length?r<0?w(n)?t.stylize(RegExp.prototype.toString.call(n),\"regexp\"):t.stylize(\"[Object]\",\"special\"):(t.seen.push(n),u=f?function(t,n,r,i,e){for(var o=[],a=0,s=n.length;a<s;++a)x(n,String(a))?o.push(p(t,n,r,i,String(a),!0)):o.push(\"\");return e.forEach(function(e){e.match(/^\\d+$/)||o.push(p(t,n,r,i,e,!0))}),o}(t,n,r,a,o):o.map(function(e){return p(t,n,r,a,e,f)}),t.seen.pop(),function(e,t,n){if(60<e.reduce(function(e,t){return 0,0<=t.indexOf(\"\\n\")&&0,e+t.replace(/\\u001b\\[\\d\\d?m/g,\"\").length+1},0))return n[0]+(\"\"===t?\"\":t+\"\\n \")+\" \"+e.join(\",\\n  \")+\" \"+n[1];return n[0]+t+\" \"+e.join(\", \")+\" \"+n[1]}(u,c,l)):l[0]+c+l[1]}function d(e){return\"[\"+Error.prototype.toString.call(e)+\"]\"}function p(e,t,n,r,i,o){var a,s,u;if((u=Object.getOwnPropertyDescriptor(t,i)||{value:t[i]}).get?s=u.set?e.stylize(\"[Getter/Setter]\",\"special\"):e.stylize(\"[Getter]\",\"special\"):u.set&&(s=e.stylize(\"[Setter]\",\"special\")),x(r,i)||(a=\"[\"+i+\"]\"),s||(e.seen.indexOf(u.value)<0?-1<(s=y(n)?h(e,u.value,null):h(e,u.value,n-1)).indexOf(\"\\n\")&&(s=o?s.split(\"\\n\").map(function(e){return\"  \"+e}).join(\"\\n\").substr(2):\"\\n\"+s.split(\"\\n\").map(function(e){return\"   \"+e}).join(\"\\n\")):s=e.stylize(\"[Circular]\",\"special\")),b(a)){if(o&&i.match(/^\\d+$/))return s;a=(a=JSON.stringify(\"\"+i)).match(/^\"([a-zA-Z_][a-zA-Z_0-9]*)\"$/)?(a=a.substr(1,a.length-2),e.stylize(a,\"name\")):(a=a.replace(/'/g,\"\\\\'\").replace(/\\\\\"/g,'\"').replace(/(^\"|\"$)/g,\"'\"),e.stylize(a,\"string\"))}return a+\": \"+s}function v(e){return Array.isArray(e)}function g(e){return\"boolean\"==typeof e}function y(e){return null===e}function _(e){return\"number\"==typeof e}function m(e){return\"string\"==typeof e}function b(e){return void 0===e}function w(e){return f(e)&&\"[object RegExp]\"===t(e)}function f(e){return\"object\"==typeof e&&null!==e}function k(e){return f(e)&&\"[object Date]\"===t(e)}function E(e){return f(e)&&(\"[object Error]\"===t(e)||e instanceof Error)}function S(e){return\"function\"==typeof e}function t(e){return Object.prototype.toString.call(e)}function n(e){return e<10?\"0\"+e.toString(10):e.toString(10)}C.debuglog=function(t){if(b(e)&&(e=r.env.NODE_DEBUG||\"\"),t=t.toUpperCase(),!o[t])if(new RegExp(\"\\\\b\"+t+\"\\\\b\",\"i\").test(e)){var n=r.pid;o[t]=function(){var e=C.format.apply(C,arguments);console.error(\"%s %d: %s\",t,n,e)}}else o[t]=function(){};return o[t]},(C.inspect=u).colors={bold:[1,22],italic:[3,23],underline:[4,24],inverse:[7,27],white:[37,39],grey:[90,39],black:[30,39],blue:[34,39],cyan:[36,39],green:[32,39],magenta:[35,39],red:[31,39],yellow:[33,39]},u.styles={special:\"cyan\",number:\"yellow\",boolean:\"yellow\",undefined:\"grey\",null:\"bold\",string:\"green\",date:\"magenta\",regexp:\"red\"},C.isArray=v,C.isBoolean=g,C.isNull=y,C.isNullOrUndefined=function(e){return null==e},C.isNumber=_,C.isString=m,C.isSymbol=function(e){return\"symbol\"==typeof e},C.isUndefined=b,C.isRegExp=w,C.isObject=f,C.isDate=k,C.isError=E,C.isFunction=S,C.isPrimitive=function(e){return null===e||\"boolean\"==typeof e||\"number\"==typeof e||\"string\"==typeof e||\"symbol\"==typeof e||void 0===e},C.isBuffer=O(15);var l=[\"Jan\",\"Feb\",\"Mar\",\"Apr\",\"May\",\"Jun\",\"Jul\",\"Aug\",\"Sep\",\"Oct\",\"Nov\",\"Dec\"];function x(e,t){return Object.prototype.hasOwnProperty.call(e,t)}C.log=function(){console.log(\"%s - %s\",function(){var e=new Date,t=[n(e.getHours()),n(e.getMinutes()),n(e.getSeconds())].join(\":\");return[e.getDate(),l[e.getMonth()],t].join(\" \")}(),C.format.apply(C,arguments))},C.inherits=O(14),C._extend=function(e,t){if(!t||!f(t))return e;for(var n=Object.keys(t),r=n.length;r--;)e[n[r]]=t[n[r]];return e}}).call(this,O(88),\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{14:14,15:15,88:88}],17:[function(e,t,n){\"use strict\";n.byteLength=function(e){var t=l(e),n=t[0],r=t[1];return 3*(n+r)/4-r},n.toByteArray=function(e){for(var t,n=l(e),r=n[0],i=n[1],o=new f(function(e,t,n){return 3*(t+n)/4-n}(0,r,i)),a=0,s=0<i?r-4:r,u=0;u<s;u+=4)t=c[e.charCodeAt(u)]<<18|c[e.charCodeAt(u+1)]<<12|c[e.charCodeAt(u+2)]<<6|c[e.charCodeAt(u+3)],o[a++]=t>>16&255,o[a++]=t>>8&255,o[a++]=255&t;2===i&&(t=c[e.charCodeAt(u)]<<2|c[e.charCodeAt(u+1)]>>4,o[a++]=255&t);1===i&&(t=c[e.charCodeAt(u)]<<10|c[e.charCodeAt(u+1)]<<4|c[e.charCodeAt(u+2)]>>2,o[a++]=t>>8&255,o[a++]=255&t);return o},n.fromByteArray=function(e){for(var t,n=e.length,r=n%3,i=[],o=0,a=n-r;o<a;o+=16383)i.push(u(e,o,a<o+16383?a:o+16383));1==r?(t=e[n-1],i.push(s[t>>2]+s[t<<4&63]+\"==\")):2==r&&(t=(e[n-2]<<8)+e[n-1],i.push(s[t>>10]+s[t>>4&63]+s[t<<2&63]+\"=\"));return i.join(\"\")};for(var s=[],c=[],f=\"undefined\"!=typeof Uint8Array?Uint8Array:Array,r=\"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/\",i=0,o=r.length;i<o;++i)s[i]=r[i],c[r.charCodeAt(i)]=i;function l(e){var t=e.length;if(0<t%4)throw new Error(\"Invalid string. Length must be a multiple of 4\");var n=e.indexOf(\"=\");return-1===n&&(n=t),[n,n===t?0:4-n%4]}function u(e,t,n){for(var r,i,o=[],a=t;a<n;a+=3)r=(e[a]<<16&16711680)+(e[a+1]<<8&65280)+(255&e[a+2]),o.push(s[(i=r)>>18&63]+s[i>>12&63]+s[i>>6&63]+s[63&i]);return o.join(\"\")}c[\"-\".charCodeAt(0)]=62,c[\"_\".charCodeAt(0)]=63},{}],18:[function(e,t,n){},{}],19:[function(e,t,n){(function(i){var r=Object.prototype.toString,o=\"function\"==typeof i.alloc&&\"function\"==typeof i.allocUnsafe&&\"function\"==typeof i.from;t.exports=function(e,t,n){if(\"number\"==typeof e)throw new TypeError('\"value\" argument must not be a number');return function(e){return\"ArrayBuffer\"===r.call(e).slice(8,-1)}(e)?function(e,t,n){t>>>=0;var r=e.byteLength-t;if(r<0)throw new RangeError(\"'offset' is out of bounds\");if(void 0===n)n=r;else if(r<(n>>>=0))throw new RangeError(\"'length' is out of bounds\");return o?i.from(e.slice(t,t+n)):new i(new Uint8Array(e.slice(t,t+n)))}(e,t,n):\"string\"==typeof e?function(e,t){if(\"string\"==typeof t&&\"\"!==t||(t=\"utf8\"),!i.isEncoding(t))throw new TypeError('\"encoding\" must be a valid string encoding');return o?i.from(e,t):new i(e,t)}(e,t):o?i.from(e):new i(e)}}).call(this,e(20).Buffer)},{20:20}],20:[function(e,t,L){(function(l){\"use strict\";var r=e(17),o=e(35);L.Buffer=l,L.SlowBuffer=function(e){+e!=e&&(e=0);return l.alloc(+e)},L.INSPECT_MAX_BYTES=50;var n=2147483647;function a(e){if(n<e)throw new RangeError('The value \"'+e+'\" is invalid for option \"size\"');var t=new Uint8Array(e);return t.__proto__=l.prototype,t}function l(e,t,n){if(\"number\"!=typeof e)return i(e,t,n);if(\"string\"==typeof t)throw new TypeError('The \"string\" argument must be of type string. Received type number');return u(e)}function i(e,t,n){if(\"string\"==typeof e)return function(e,t){\"string\"==typeof t&&\"\"!==t||(t=\"utf8\");if(!l.isEncoding(t))throw new TypeError(\"Unknown encoding: \"+t);var n=0|h(e,t),r=a(n),i=r.write(e,t);i!==n&&(r=r.slice(0,i));return r}(e,t);if(ArrayBuffer.isView(e))return c(e);if(null==e)throw TypeError(\"The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type \"+typeof e);if(q(e,ArrayBuffer)||e&&q(e.buffer,ArrayBuffer))return function(e,t,n){if(t<0||e.byteLength<t)throw new RangeError('\"offset\" is outside of buffer bounds');if(e.byteLength<t+(n||0))throw new RangeError('\"length\" is outside of buffer bounds');var r;r=void 0===t&&void 0===n?new Uint8Array(e):void 0===n?new Uint8Array(e,t):new Uint8Array(e,t,n);return r.__proto__=l.prototype,r}(e,t,n);if(\"number\"==typeof e)throw new TypeError('The \"value\" argument must not be of type number. Received type number');var r=e.valueOf&&e.valueOf();if(null!=r&&r!==e)return l.from(r,t,n);var i=function(e){if(l.isBuffer(e)){var t=0|f(e.length),n=a(t);return 0===n.length||e.copy(n,0,0,t),n}if(void 0!==e.length)return\"number\"!=typeof e.length||D(e.length)?a(0):c(e);if(\"Buffer\"===e.type&&Array.isArray(e.data))return c(e.data)}(e);if(i)return i;if(\"undefined\"!=typeof Symbol&&null!=Symbol.toPrimitive&&\"function\"==typeof e[Symbol.toPrimitive])return l.from(e[Symbol.toPrimitive](\"string\"),t,n);throw new TypeError(\"The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type \"+typeof e)}function s(e){if(\"number\"!=typeof e)throw new TypeError('\"size\" argument must be of type number');if(e<0)throw new RangeError('The value \"'+e+'\" is invalid for option \"size\"')}function u(e){return s(e),a(e<0?0:0|f(e))}function c(e){for(var t=e.length<0?0:0|f(e.length),n=a(t),r=0;r<t;r+=1)n[r]=255&e[r];return n}function f(e){if(n<=e)throw new RangeError(\"Attempt to allocate Buffer larger than maximum size: 0x\"+n.toString(16)+\" bytes\");return 0|e}function h(e,t){if(l.isBuffer(e))return e.length;if(ArrayBuffer.isView(e)||q(e,ArrayBuffer))return e.byteLength;if(\"string\"!=typeof e)throw new TypeError('The \"string\" argument must be one of type string, Buffer, or ArrayBuffer. Received type '+typeof e);var n=e.length,r=2<arguments.length&&!0===arguments[2];if(!r&&0===n)return 0;for(var i=!1;;)switch(t){case\"ascii\":case\"latin1\":case\"binary\":return n;case\"utf8\":case\"utf-8\":return I(e).length;case\"ucs2\":case\"ucs-2\":case\"utf16le\":case\"utf-16le\":return 2*n;case\"hex\":return n>>>1;case\"base64\":return T(e).length;default:if(i)return r?-1:I(e).length;t=(\"\"+t).toLowerCase(),i=!0}}function d(e,t,n){var r=e[t];e[t]=e[n],e[n]=r}function p(e,t,n,r,i){if(0===e.length)return-1;if(\"string\"==typeof n?(r=n,n=0):2147483647<n?n=2147483647:n<-2147483648&&(n=-2147483648),D(n=+n)&&(n=i?0:e.length-1),n<0&&(n=e.length+n),n>=e.length){if(i)return-1;n=e.length-1}else if(n<0){if(!i)return-1;n=0}if(\"string\"==typeof t&&(t=l.from(t,r)),l.isBuffer(t))return 0===t.length?-1:v(e,t,n,r,i);if(\"number\"==typeof t)return t&=255,\"function\"==typeof Uint8Array.prototype.indexOf?i?Uint8Array.prototype.indexOf.call(e,t,n):Uint8Array.prototype.lastIndexOf.call(e,t,n):v(e,[t],n,r,i);throw new TypeError(\"val must be string, number or Buffer\")}function v(e,t,n,r,i){var o,a=1,s=e.length,u=t.length;if(void 0!==r&&(\"ucs2\"===(r=String(r).toLowerCase())||\"ucs-2\"===r||\"utf16le\"===r||\"utf-16le\"===r)){if(e.length<2||t.length<2)return-1;s/=a=2,u/=2,n/=2}function c(e,t){return 1===a?e[t]:e.readUInt16BE(t*a)}if(i){var f=-1;for(o=n;o<s;o++)if(c(e,o)===c(t,-1===f?0:o-f)){if(-1===f&&(f=o),o-f+1===u)return f*a}else-1!==f&&(o-=o-f),f=-1}else for(s<n+u&&(n=s-u),o=n;0<=o;o--){for(var l=!0,h=0;h<u;h++)if(c(e,o+h)!==c(t,h)){l=!1;break}if(l)return o}return-1}function g(e,t,n,r){n=Number(n)||0;var i=e.length-n;r?i<(r=Number(r))&&(r=i):r=i;var o=t.length;o/2<r&&(r=o/2);for(var a=0;a<r;++a){var s=parseInt(t.substr(2*a,2),16);if(D(s))return a;e[n+a]=s}return a}function y(e,t,n,r){return R(function(e){for(var t=[],n=0;n<e.length;++n)t.push(255&e.charCodeAt(n));return t}(t),e,n,r)}function _(e,t,n){return 0===t&&n===e.length?r.fromByteArray(e):r.fromByteArray(e.slice(t,n))}function m(e,t,n){n=Math.min(e.length,n);for(var r=[],i=t;i<n;){var o,a,s,u,c=e[i],f=null,l=239<c?4:223<c?3:191<c?2:1;if(i+l<=n)switch(l){case 1:c<128&&(f=c);break;case 2:128==(192&(o=e[i+1]))&&127<(u=(31&c)<<6|63&o)&&(f=u);break;case 3:o=e[i+1],a=e[i+2],128==(192&o)&&128==(192&a)&&2047<(u=(15&c)<<12|(63&o)<<6|63&a)&&(u<55296||57343<u)&&(f=u);break;case 4:o=e[i+1],a=e[i+2],s=e[i+3],128==(192&o)&&128==(192&a)&&128==(192&s)&&65535<(u=(15&c)<<18|(63&o)<<12|(63&a)<<6|63&s)&&u<1114112&&(f=u)}null===f?(f=65533,l=1):65535<f&&(f-=65536,r.push(f>>>10&1023|55296),f=56320|1023&f),r.push(f),i+=l}return function(e){var t=e.length;if(t<=b)return String.fromCharCode.apply(String,e);var n=\"\",r=0;for(;r<t;)n+=String.fromCharCode.apply(String,e.slice(r,r+=b));return n}(r)}L.kMaxLength=n,(l.TYPED_ARRAY_SUPPORT=function(){try{var e=new Uint8Array(1);return e.__proto__={__proto__:Uint8Array.prototype,foo:function(){return 42}},42===e.foo()}catch(e){return!1}}())||\"undefined\"==typeof console||\"function\"!=typeof console.error||console.error(\"This browser lacks typed array (Uint8Array) support which is required by `buffer` v5.x. Use `buffer` v4.x if you require old browser support.\"),Object.defineProperty(l.prototype,\"parent\",{enumerable:!0,get:function(){if(l.isBuffer(this))return this.buffer}}),Object.defineProperty(l.prototype,\"offset\",{enumerable:!0,get:function(){if(l.isBuffer(this))return this.byteOffset}}),\"undefined\"!=typeof Symbol&&null!=Symbol.species&&l[Symbol.species]===l&&Object.defineProperty(l,Symbol.species,{value:null,configurable:!0,enumerable:!1,writable:!1}),l.poolSize=8192,l.from=function(e,t,n){return i(e,t,n)},l.prototype.__proto__=Uint8Array.prototype,l.__proto__=Uint8Array,l.alloc=function(e,t,n){return function(e,t,n){return s(e),e<=0?a(e):void 0!==t?\"string\"==typeof n?a(e).fill(t,n):a(e).fill(t):a(e)}(e,t,n)},l.allocUnsafe=function(e){return u(e)},l.allocUnsafeSlow=function(e){return u(e)},l.isBuffer=function(e){return null!=e&&!0===e._isBuffer&&e!==l.prototype},l.compare=function(e,t){if(q(e,Uint8Array)&&(e=l.from(e,e.offset,e.byteLength)),q(t,Uint8Array)&&(t=l.from(t,t.offset,t.byteLength)),!l.isBuffer(e)||!l.isBuffer(t))throw new TypeError('The \"buf1\", \"buf2\" arguments must be one of type Buffer or Uint8Array');if(e===t)return 0;for(var n=e.length,r=t.length,i=0,o=Math.min(n,r);i<o;++i)if(e[i]!==t[i]){n=e[i],r=t[i];break}return n<r?-1:r<n?1:0},l.isEncoding=function(e){switch(String(e).toLowerCase()){case\"hex\":case\"utf8\":case\"utf-8\":case\"ascii\":case\"latin1\":case\"binary\":case\"base64\":case\"ucs2\":case\"ucs-2\":case\"utf16le\":case\"utf-16le\":return!0;default:return!1}},l.concat=function(e,t){if(!Array.isArray(e))throw new TypeError('\"list\" argument must be an Array of Buffers');if(0===e.length)return l.alloc(0);var n;if(void 0===t)for(n=t=0;n<e.length;++n)t+=e[n].length;var r=l.allocUnsafe(t),i=0;for(n=0;n<e.length;++n){var o=e[n];if(q(o,Uint8Array)&&(o=l.from(o)),!l.isBuffer(o))throw new TypeError('\"list\" argument must be an Array of Buffers');o.copy(r,i),i+=o.length}return r},l.byteLength=h,l.prototype._isBuffer=!0,l.prototype.swap16=function(){var e=this.length;if(e%2!=0)throw new RangeError(\"Buffer size must be a multiple of 16-bits\");for(var t=0;t<e;t+=2)d(this,t,t+1);return this},l.prototype.swap32=function(){var e=this.length;if(e%4!=0)throw new RangeError(\"Buffer size must be a multiple of 32-bits\");for(var t=0;t<e;t+=4)d(this,t,t+3),d(this,t+1,t+2);return this},l.prototype.swap64=function(){var e=this.length;if(e%8!=0)throw new RangeError(\"Buffer size must be a multiple of 64-bits\");for(var t=0;t<e;t+=8)d(this,t,t+7),d(this,t+1,t+6),d(this,t+2,t+5),d(this,t+3,t+4);return this},l.prototype.toLocaleString=l.prototype.toString=function(){var e=this.length;return 0===e?\"\":0===arguments.length?m(this,0,e):function(e,t,n){var r=!1;if((void 0===t||t<0)&&(t=0),t>this.length)return\"\";if((void 0===n||n>this.length)&&(n=this.length),n<=0)return\"\";if((n>>>=0)<=(t>>>=0))return\"\";for(e=e||\"utf8\";;)switch(e){case\"hex\":return E(this,t,n);case\"utf8\":case\"utf-8\":return m(this,t,n);case\"ascii\":return w(this,t,n);case\"latin1\":case\"binary\":return k(this,t,n);case\"base64\":return _(this,t,n);case\"ucs2\":case\"ucs-2\":case\"utf16le\":case\"utf-16le\":return S(this,t,n);default:if(r)throw new TypeError(\"Unknown encoding: \"+e);e=(e+\"\").toLowerCase(),r=!0}}.apply(this,arguments)},l.prototype.equals=function(e){if(!l.isBuffer(e))throw new TypeError(\"Argument must be a Buffer\");return this===e||0===l.compare(this,e)},l.prototype.inspect=function(){var e=\"\",t=L.INSPECT_MAX_BYTES;return e=this.toString(\"hex\",0,t).replace(/(.{2})/g,\"$1 \").trim(),this.length>t&&(e+=\" ... \"),\"<Buffer \"+e+\">\"},l.prototype.compare=function(e,t,n,r,i){if(q(e,Uint8Array)&&(e=l.from(e,e.offset,e.byteLength)),!l.isBuffer(e))throw new TypeError('The \"target\" argument must be one of type Buffer or Uint8Array. Received type '+typeof e);if(void 0===t&&(t=0),void 0===n&&(n=e?e.length:0),void 0===r&&(r=0),void 0===i&&(i=this.length),t<0||n>e.length||r<0||i>this.length)throw new RangeError(\"out of range index\");if(i<=r&&n<=t)return 0;if(i<=r)return-1;if(n<=t)return 1;if(this===e)return 0;for(var o=(i>>>=0)-(r>>>=0),a=(n>>>=0)-(t>>>=0),s=Math.min(o,a),u=this.slice(r,i),c=e.slice(t,n),f=0;f<s;++f)if(u[f]!==c[f]){o=u[f],a=c[f];break}return o<a?-1:a<o?1:0},l.prototype.includes=function(e,t,n){return-1!==this.indexOf(e,t,n)},l.prototype.indexOf=function(e,t,n){return p(this,e,t,n,!0)},l.prototype.lastIndexOf=function(e,t,n){return p(this,e,t,n,!1)},l.prototype.write=function(e,t,n,r){if(void 0===t)r=\"utf8\",n=this.length,t=0;else if(void 0===n&&\"string\"==typeof t)r=t,n=this.length,t=0;else{if(!isFinite(t))throw new Error(\"Buffer.write(string, encoding, offset[, length]) is no longer supported\");t>>>=0,isFinite(n)?(n>>>=0,void 0===r&&(r=\"utf8\")):(r=n,n=void 0)}var i=this.length-t;if((void 0===n||i<n)&&(n=i),0<e.length&&(n<0||t<0)||t>this.length)throw new RangeError(\"Attempt to write outside buffer bounds\");r=r||\"utf8\";for(var o,a,s,u,c,f,l,h,d,p=!1;;)switch(r){case\"hex\":return g(this,e,t,n);case\"utf8\":case\"utf-8\":return h=t,d=n,R(I(e,(l=this).length-h),l,h,d);case\"ascii\":return y(this,e,t,n);case\"latin1\":case\"binary\":return y(this,e,t,n);case\"base64\":return u=this,c=t,f=n,R(T(e),u,c,f);case\"ucs2\":case\"ucs-2\":case\"utf16le\":case\"utf-16le\":return a=t,s=n,R(function(e,t){for(var n,r,i,o=[],a=0;a<e.length&&!((t-=2)<0);++a)n=e.charCodeAt(a),r=n>>8,i=n%256,o.push(i),o.push(r);return o}(e,(o=this).length-a),o,a,s);default:if(p)throw new TypeError(\"Unknown encoding: \"+r);r=(\"\"+r).toLowerCase(),p=!0}},l.prototype.toJSON=function(){return{type:\"Buffer\",data:Array.prototype.slice.call(this._arr||this,0)}};var b=4096;function w(e,t,n){var r=\"\";n=Math.min(e.length,n);for(var i=t;i<n;++i)r+=String.fromCharCode(127&e[i]);return r}function k(e,t,n){var r=\"\";n=Math.min(e.length,n);for(var i=t;i<n;++i)r+=String.fromCharCode(e[i]);return r}function E(e,t,n){var r=e.length;(!t||t<0)&&(t=0),(!n||n<0||r<n)&&(n=r);for(var i=\"\",o=t;o<n;++o)i+=B(e[o]);return i}function S(e,t,n){for(var r=e.slice(t,n),i=\"\",o=0;o<r.length;o+=2)i+=String.fromCharCode(r[o]+256*r[o+1]);return i}function x(e,t,n){if(e%1!=0||e<0)throw new RangeError(\"offset is not uint\");if(n<e+t)throw new RangeError(\"Trying to access beyond buffer length\")}function O(e,t,n,r,i,o){if(!l.isBuffer(e))throw new TypeError('\"buffer\" argument must be a Buffer instance');if(i<t||t<o)throw new RangeError('\"value\" argument is out of bounds');if(n+r>e.length)throw new RangeError(\"Index out of range\")}function C(e,t,n,r){if(n+r>e.length)throw new RangeError(\"Index out of range\");if(n<0)throw new RangeError(\"Index out of range\")}function A(e,t,n,r,i){return t=+t,n>>>=0,i||C(e,0,n,4),o.write(e,t,n,r,23,4),n+4}function j(e,t,n,r,i){return t=+t,n>>>=0,i||C(e,0,n,8),o.write(e,t,n,r,52,8),n+8}l.prototype.slice=function(e,t){var n=this.length;(e=~~e)<0?(e+=n)<0&&(e=0):n<e&&(e=n),(t=void 0===t?n:~~t)<0?(t+=n)<0&&(t=0):n<t&&(t=n),t<e&&(t=e);var r=this.subarray(e,t);return r.__proto__=l.prototype,r},l.prototype.readUIntLE=function(e,t,n){e>>>=0,t>>>=0,n||x(e,t,this.length);for(var r=this[e],i=1,o=0;++o<t&&(i*=256);)r+=this[e+o]*i;return r},l.prototype.readUIntBE=function(e,t,n){e>>>=0,t>>>=0,n||x(e,t,this.length);for(var r=this[e+--t],i=1;0<t&&(i*=256);)r+=this[e+--t]*i;return r},l.prototype.readUInt8=function(e,t){return e>>>=0,t||x(e,1,this.length),this[e]},l.prototype.readUInt16LE=function(e,t){return e>>>=0,t||x(e,2,this.length),this[e]|this[e+1]<<8},l.prototype.readUInt16BE=function(e,t){return e>>>=0,t||x(e,2,this.length),this[e]<<8|this[e+1]},l.prototype.readUInt32LE=function(e,t){return e>>>=0,t||x(e,4,this.length),(this[e]|this[e+1]<<8|this[e+2]<<16)+16777216*this[e+3]},l.prototype.readUInt32BE=function(e,t){return e>>>=0,t||x(e,4,this.length),16777216*this[e]+(this[e+1]<<16|this[e+2]<<8|this[e+3])},l.prototype.readIntLE=function(e,t,n){e>>>=0,t>>>=0,n||x(e,t,this.length);for(var r=this[e],i=1,o=0;++o<t&&(i*=256);)r+=this[e+o]*i;return(i*=128)<=r&&(r-=Math.pow(2,8*t)),r},l.prototype.readIntBE=function(e,t,n){e>>>=0,t>>>=0,n||x(e,t,this.length);for(var r=t,i=1,o=this[e+--r];0<r&&(i*=256);)o+=this[e+--r]*i;return(i*=128)<=o&&(o-=Math.pow(2,8*t)),o},l.prototype.readInt8=function(e,t){return e>>>=0,t||x(e,1,this.length),128&this[e]?-1*(255-this[e]+1):this[e]},l.prototype.readInt16LE=function(e,t){e>>>=0,t||x(e,2,this.length);var n=this[e]|this[e+1]<<8;return 32768&n?4294901760|n:n},l.prototype.readInt16BE=function(e,t){e>>>=0,t||x(e,2,this.length);var n=this[e+1]|this[e]<<8;return 32768&n?4294901760|n:n},l.prototype.readInt32LE=function(e,t){return e>>>=0,t||x(e,4,this.length),this[e]|this[e+1]<<8|this[e+2]<<16|this[e+3]<<24},l.prototype.readInt32BE=function(e,t){return e>>>=0,t||x(e,4,this.length),this[e]<<24|this[e+1]<<16|this[e+2]<<8|this[e+3]},l.prototype.readFloatLE=function(e,t){return e>>>=0,t||x(e,4,this.length),o.read(this,e,!0,23,4)},l.prototype.readFloatBE=function(e,t){return e>>>=0,t||x(e,4,this.length),o.read(this,e,!1,23,4)},l.prototype.readDoubleLE=function(e,t){return e>>>=0,t||x(e,8,this.length),o.read(this,e,!0,52,8)},l.prototype.readDoubleBE=function(e,t){return e>>>=0,t||x(e,8,this.length),o.read(this,e,!1,52,8)},l.prototype.writeUIntLE=function(e,t,n,r){e=+e,t>>>=0,n>>>=0,r||O(this,e,t,n,Math.pow(2,8*n)-1,0);var i=1,o=0;for(this[t]=255&e;++o<n&&(i*=256);)this[t+o]=e/i&255;return t+n},l.prototype.writeUIntBE=function(e,t,n,r){e=+e,t>>>=0,n>>>=0,r||O(this,e,t,n,Math.pow(2,8*n)-1,0);var i=n-1,o=1;for(this[t+i]=255&e;0<=--i&&(o*=256);)this[t+i]=e/o&255;return t+n},l.prototype.writeUInt8=function(e,t,n){return e=+e,t>>>=0,n||O(this,e,t,1,255,0),this[t]=255&e,t+1},l.prototype.writeUInt16LE=function(e,t,n){return e=+e,t>>>=0,n||O(this,e,t,2,65535,0),this[t]=255&e,this[t+1]=e>>>8,t+2},l.prototype.writeUInt16BE=function(e,t,n){return e=+e,t>>>=0,n||O(this,e,t,2,65535,0),this[t]=e>>>8,this[t+1]=255&e,t+2},l.prototype.writeUInt32LE=function(e,t,n){return e=+e,t>>>=0,n||O(this,e,t,4,4294967295,0),this[t+3]=e>>>24,this[t+2]=e>>>16,this[t+1]=e>>>8,this[t]=255&e,t+4},l.prototype.writeUInt32BE=function(e,t,n){return e=+e,t>>>=0,n||O(this,e,t,4,4294967295,0),this[t]=e>>>24,this[t+1]=e>>>16,this[t+2]=e>>>8,this[t+3]=255&e,t+4},l.prototype.writeIntLE=function(e,t,n,r){if(e=+e,t>>>=0,!r){var i=Math.pow(2,8*n-1);O(this,e,t,n,i-1,-i)}var o=0,a=1,s=0;for(this[t]=255&e;++o<n&&(a*=256);)e<0&&0===s&&0!==this[t+o-1]&&(s=1),this[t+o]=(e/a>>0)-s&255;return t+n},l.prototype.writeIntBE=function(e,t,n,r){if(e=+e,t>>>=0,!r){var i=Math.pow(2,8*n-1);O(this,e,t,n,i-1,-i)}var o=n-1,a=1,s=0;for(this[t+o]=255&e;0<=--o&&(a*=256);)e<0&&0===s&&0!==this[t+o+1]&&(s=1),this[t+o]=(e/a>>0)-s&255;return t+n},l.prototype.writeInt8=function(e,t,n){return e=+e,t>>>=0,n||O(this,e,t,1,127,-128),e<0&&(e=255+e+1),this[t]=255&e,t+1},l.prototype.writeInt16LE=function(e,t,n){return e=+e,t>>>=0,n||O(this,e,t,2,32767,-32768),this[t]=255&e,this[t+1]=e>>>8,t+2},l.prototype.writeInt16BE=function(e,t,n){return e=+e,t>>>=0,n||O(this,e,t,2,32767,-32768),this[t]=e>>>8,this[t+1]=255&e,t+2},l.prototype.writeInt32LE=function(e,t,n){return e=+e,t>>>=0,n||O(this,e,t,4,2147483647,-2147483648),this[t]=255&e,this[t+1]=e>>>8,this[t+2]=e>>>16,this[t+3]=e>>>24,t+4},l.prototype.writeInt32BE=function(e,t,n){return e=+e,t>>>=0,n||O(this,e,t,4,2147483647,-2147483648),e<0&&(e=4294967295+e+1),this[t]=e>>>24,this[t+1]=e>>>16,this[t+2]=e>>>8,this[t+3]=255&e,t+4},l.prototype.writeFloatLE=function(e,t,n){return A(this,e,t,!0,n)},l.prototype.writeFloatBE=function(e,t,n){return A(this,e,t,!1,n)},l.prototype.writeDoubleLE=function(e,t,n){return j(this,e,t,!0,n)},l.prototype.writeDoubleBE=function(e,t,n){return j(this,e,t,!1,n)},l.prototype.copy=function(e,t,n,r){if(!l.isBuffer(e))throw new TypeError(\"argument should be a Buffer\");if(n=n||0,r||0===r||(r=this.length),t>=e.length&&(t=e.length),t=t||0,0<r&&r<n&&(r=n),r===n)return 0;if(0===e.length||0===this.length)return 0;if(t<0)throw new RangeError(\"targetStart out of bounds\");if(n<0||n>=this.length)throw new RangeError(\"Index out of range\");if(r<0)throw new RangeError(\"sourceEnd out of bounds\");r>this.length&&(r=this.length),e.length-t<r-n&&(r=e.length-t+n);var i=r-n;if(this===e&&\"function\"==typeof Uint8Array.prototype.copyWithin)this.copyWithin(t,n,r);else if(this===e&&n<t&&t<r)for(var o=i-1;0<=o;--o)e[o+t]=this[o+n];else Uint8Array.prototype.set.call(e,this.subarray(n,r),t);return i},l.prototype.fill=function(e,t,n,r){if(\"string\"==typeof e){if(\"string\"==typeof t?(r=t,t=0,n=this.length):\"string\"==typeof n&&(r=n,n=this.length),void 0!==r&&\"string\"!=typeof r)throw new TypeError(\"encoding must be a string\");if(\"string\"==typeof r&&!l.isEncoding(r))throw new TypeError(\"Unknown encoding: \"+r);if(1===e.length){var i=e.charCodeAt(0);(\"utf8\"===r&&i<128||\"latin1\"===r)&&(e=i)}}else\"number\"==typeof e&&(e&=255);if(t<0||this.length<t||this.length<n)throw new RangeError(\"Out of range index\");if(n<=t)return this;var o;if(t>>>=0,n=void 0===n?this.length:n>>>0,\"number\"==typeof(e=e||0))for(o=t;o<n;++o)this[o]=e;else{var a=l.isBuffer(e)?e:l.from(e,r),s=a.length;if(0===s)throw new TypeError('The value \"'+e+'\" is invalid for argument \"value\"');for(o=0;o<n-t;++o)this[o+t]=a[o%s]}return this};var t=/[^+/0-9A-Za-z-_]/g;function B(e){return e<16?\"0\"+e.toString(16):e.toString(16)}function I(e,t){var n;t=t||1/0;for(var r=e.length,i=null,o=[],a=0;a<r;++a){if(55295<(n=e.charCodeAt(a))&&n<57344){if(!i){if(56319<n){-1<(t-=3)&&o.push(239,191,189);continue}if(a+1===r){-1<(t-=3)&&o.push(239,191,189);continue}i=n;continue}if(n<56320){-1<(t-=3)&&o.push(239,191,189),i=n;continue}n=65536+(i-55296<<10|n-56320)}else i&&-1<(t-=3)&&o.push(239,191,189);if(i=null,n<128){if((t-=1)<0)break;o.push(n)}else if(n<2048){if((t-=2)<0)break;o.push(n>>6|192,63&n|128)}else if(n<65536){if((t-=3)<0)break;o.push(n>>12|224,n>>6&63|128,63&n|128)}else{if(!(n<1114112))throw new Error(\"Invalid code point\");if((t-=4)<0)break;o.push(n>>18|240,n>>12&63|128,n>>6&63|128,63&n|128)}}return o}function T(e){return r.toByteArray(function(e){if((e=(e=e.split(\"=\")[0]).trim().replace(t,\"\")).length<2)return\"\";for(;e.length%4!=0;)e+=\"=\";return e}(e))}function R(e,t,n,r){for(var i=0;i<r&&!(i+n>=t.length||i>=e.length);++i)t[i+n]=e[i];return i}function q(e,t){return e instanceof t||null!=e&&null!=e.constructor&&null!=e.constructor.name&&e.constructor.name===t.name}function D(e){return e!=e}}).call(this,e(20).Buffer)},{17:17,20:20,35:35}],21:[function(e,t,n){(function(e){function t(e){return Object.prototype.toString.call(e)}n.isArray=function(e){return Array.isArray?Array.isArray(e):\"[object Array]\"===t(e)},n.isBoolean=function(e){return\"boolean\"==typeof e},n.isNull=function(e){return null===e},n.isNullOrUndefined=function(e){return null==e},n.isNumber=function(e){return\"number\"==typeof e},n.isString=function(e){return\"string\"==typeof e},n.isSymbol=function(e){return\"symbol\"==typeof e},n.isUndefined=function(e){return void 0===e},n.isRegExp=function(e){return\"[object RegExp]\"===t(e)},n.isObject=function(e){return\"object\"==typeof e&&null!==e},n.isDate=function(e){return\"[object Date]\"===t(e)},n.isError=function(e){return\"[object Error]\"===t(e)||e instanceof Error},n.isFunction=function(e){return\"function\"==typeof e},n.isPrimitive=function(e){return null===e||\"boolean\"==typeof e||\"number\"==typeof e||\"string\"==typeof e||\"symbol\"==typeof e||void 0===e},n.isBuffer=e.isBuffer}).call(this,{isBuffer:e(38)})},{38:38}],22:[function(n,r,o){(function(t){function e(){var e;try{e=o.storage.debug}catch(e){}return!e&&void 0!==t&&\"env\"in t&&(e=t.env.DEBUG),e}(o=r.exports=n(23)).log=function(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)},o.formatArgs=function(e){var t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+o.humanize(this.diff),!t)return;var n=\"color: \"+this.color;e.splice(1,0,n,\"color: inherit\");var r=0,i=0;e[0].replace(/%[a-zA-Z%]/g,function(e){\"%%\"!==e&&(r++,\"%c\"===e&&(i=r))}),e.splice(i,0,n)},o.save=function(e){try{null==e?o.storage.removeItem(\"debug\"):o.storage.debug=e}catch(e){}},o.load=e,o.useColors=function(){if(\"undefined\"!=typeof window&&window.process&&\"renderer\"===window.process.type)return!0;if(\"undefined\"!=typeof navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/(edge|trident)\\/(\\d+)/))return!1;return\"undefined\"!=typeof document&&document.documentElement&&document.documentElement.style&&document.documentElement.style.WebkitAppearance||\"undefined\"!=typeof window&&window.console&&(window.console.firebug||window.console.exception&&window.console.table)||\"undefined\"!=typeof navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&31<=parseInt(RegExp.$1,10)||\"undefined\"!=typeof navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/applewebkit\\/(\\d+)/)},o.storage=\"undefined\"!=typeof chrome&&void 0!==chrome.storage?chrome.storage.local:function(){try{return window.localStorage}catch(e){}}(),o.colors=[\"#0000CC\",\"#0000FF\",\"#0033CC\",\"#0033FF\",\"#0066CC\",\"#0066FF\",\"#0099CC\",\"#0099FF\",\"#00CC00\",\"#00CC33\",\"#00CC66\",\"#00CC99\",\"#00CCCC\",\"#00CCFF\",\"#3300CC\",\"#3300FF\",\"#3333CC\",\"#3333FF\",\"#3366CC\",\"#3366FF\",\"#3399CC\",\"#3399FF\",\"#33CC00\",\"#33CC33\",\"#33CC66\",\"#33CC99\",\"#33CCCC\",\"#33CCFF\",\"#6600CC\",\"#6600FF\",\"#6633CC\",\"#6633FF\",\"#66CC00\",\"#66CC33\",\"#9900CC\",\"#9900FF\",\"#9933CC\",\"#9933FF\",\"#99CC00\",\"#99CC33\",\"#CC0000\",\"#CC0033\",\"#CC0066\",\"#CC0099\",\"#CC00CC\",\"#CC00FF\",\"#CC3300\",\"#CC3333\",\"#CC3366\",\"#CC3399\",\"#CC33CC\",\"#CC33FF\",\"#CC6600\",\"#CC6633\",\"#CC9900\",\"#CC9933\",\"#CCCC00\",\"#CCCC33\",\"#FF0000\",\"#FF0033\",\"#FF0066\",\"#FF0099\",\"#FF00CC\",\"#FF00FF\",\"#FF3300\",\"#FF3333\",\"#FF3366\",\"#FF3399\",\"#FF33CC\",\"#FF33FF\",\"#FF6600\",\"#FF6633\",\"#FF9900\",\"#FF9933\",\"#FFCC00\",\"#FFCC33\"],o.formatters.j=function(e){try{return JSON.stringify(e)}catch(e){return\"[UnexpectedJSONParseError]: \"+e.message}},o.enable(e())}).call(this,n(88))},{23:23,88:88}],23:[function(e,t,u){function n(e){var r;function s(){if(s.enabled){var i=s,e=+new Date,t=e-(r||e);i.diff=t,i.prev=r,i.curr=e,r=e;for(var o=new Array(arguments.length),n=0;n<o.length;n++)o[n]=arguments[n];o[0]=u.coerce(o[0]),\"string\"!=typeof o[0]&&o.unshift(\"%O\");var a=0;o[0]=o[0].replace(/%([a-zA-Z%])/g,function(e,t){if(\"%%\"===e)return e;a++;var n=u.formatters[t];if(\"function\"==typeof n){var r=o[a];e=n.call(i,r),o.splice(a,1),a--}return e}),u.formatArgs.call(i,o),(s.log||u.log||console.log.bind(console)).apply(i,o)}}return s.namespace=e,s.enabled=u.enabled(e),s.useColors=u.useColors(),s.color=function(e){var t,n=0;for(t in e)n=(n<<5)-n+e.charCodeAt(t),n|=0;return u.colors[Math.abs(n)%u.colors.length]}(e),s.destroy=i,\"function\"==typeof u.init&&u.init(s),u.instances.push(s),s}function i(){var e=u.instances.indexOf(this);return-1!==e&&(u.instances.splice(e,1),!0)}(u=t.exports=n.debug=n.default=n).coerce=function(e){return e instanceof Error?e.stack||e.message:e},u.disable=function(){u.enable(\"\")},u.enable=function(e){var t;u.save(e),u.names=[],u.skips=[];var n=(\"string\"==typeof e?e:\"\").split(/[\\s,]+/),r=n.length;for(t=0;t<r;t++)n[t]&&(\"-\"===(e=n[t].replace(/\\*/g,\".*?\"))[0]?u.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):u.names.push(new RegExp(\"^\"+e+\"$\")));for(t=0;t<u.instances.length;t++){var i=u.instances[t];i.enabled=u.enabled(i.namespace)}},u.enabled=function(e){if(\"*\"===e[e.length-1])return!0;var t,n;for(t=0,n=u.skips.length;t<n;t++)if(u.skips[t].test(e))return!1;for(t=0,n=u.names.length;t<n;t++)if(u.names[t].test(e))return!0;return!1},u.humanize=e(57),u.instances=[],u.names=[],u.skips=[],u.formatters={}},{57:57}],24:[function(e,t,n){var r=e(29).AbstractIterator;function i(e){r.call(this,e),this._options=e,this._iterator=null,this._operations=[]}e(37)(i,r),i.prototype.setDb=function(e){var t=this._iterator=e.iterator(this._options);this._operations.forEach(function(e){t[e.method].apply(t,e.args)})},i.prototype._operation=function(e,t){if(this._iterator)return this._iterator[e].apply(this._iterator,t);this._operations.push({method:e,args:t})},\"next end\".split(\" \").forEach(function(e){i.prototype[\"_\"+e]=function(){this._operation(e,arguments)}}),t.exports=i},{29:29,37:37}],25:[function(e,t,n){var r=e(29).AbstractLevelDOWN,i=e(37),o=e(24),a=\"put get del batch\".split(\" \");function s(e){r.call(this,\"\"),this._db=e,this._operations=[],this._iterators=[],u(this)}function u(t){a.forEach(function(e){t[\"_\"+e]=function(){this._operations.push({method:e,args:arguments})}}),\"function\"==typeof t._db.approximateSize&&(t.approximateSize=function(){this._operations.push({method:\"approximateSize\",args:arguments})}),t._iterator=function(e){var t=new o(e);return this._iterators.push(t),t}}i(s,r),s.prototype._open=function(e,t){var n=this;this._db.open(e,function(e){if(e)return t(e);n._operations.forEach(function(e){n._db[e.method].apply(n._db,e.args)}),n._operations=[],n._iterators.forEach(function(e){e.setDb(n._db)}),n._iterators=[],function(t){a.concat(\"iterator\").forEach(function(e){t[\"_\"+e]=function(){return this._db[e].apply(this._db,arguments)}}),t._db.approximateSize&&(t.approximateSize=function(){return this._db.approximateSize.apply(this._db,arguments)})}(n),t()})},s.prototype._close=function(t){var n=this;this._db.close(function(e){if(e)return t(e);u(n),t()})},s.prototype._serializeKey=function(e){return e},s.prototype._serializeValue=function(e){return e},t.exports=s,t.exports.DeferredIterator=o},{24:24,29:29,37:37}],26:[function(e,t,n){(function(n){function e(e){this._db=e,this._operations=[],this._written=!1}e.prototype._serializeKey=function(e){return this._db._serializeKey(e)},e.prototype._serializeValue=function(e){return this._db._serializeValue(e)},e.prototype._checkWritten=function(){if(this._written)throw new Error(\"write() already called on this batch\")},e.prototype.put=function(e,t){this._checkWritten();var n=this._db._checkKey(e,\"key\");if(n)throw n;return e=this._serializeKey(e),t=this._serializeValue(t),this._put(e,t),this},e.prototype._put=function(e,t){this._operations.push({type:\"put\",key:e,value:t})},e.prototype.del=function(e){this._checkWritten();var t=this._db._checkKey(e,\"key\");if(t)throw t;return e=this._serializeKey(e),this._del(e),this},e.prototype._del=function(e){this._operations.push({type:\"del\",key:e})},e.prototype.clear=function(){return this._checkWritten(),this._operations=[],this._clear(),this},e.prototype._clear=function(){},e.prototype.write=function(e,t){if(this._checkWritten(),\"function\"==typeof e&&(t=e),\"function\"!=typeof t)throw new Error(\"write() requires a callback argument\");return\"object\"!=typeof e&&(e={}),this._written=!0,\"function\"==typeof this._write?this._write(t):\"function\"==typeof this._db._batch?this._db._batch(this._operations,e,t):void n.nextTick(t)},t.exports=e}).call(this,e(88))},{88:88}],27:[function(e,t,n){(function(n){function e(e){this.db=e,this._ended=!1,this._nexting=!1}e.prototype.next=function(e){var t=this;if(\"function\"!=typeof e)throw new Error(\"next() requires a callback argument\");return t._ended?n.nextTick(e,new Error(\"cannot call next() after end()\")):t._nexting?n.nextTick(e,new Error(\"cannot call next() before previous next() has completed\")):(t._nexting=!0,t._next(function(){t._nexting=!1,e.apply(null,arguments)})),t},e.prototype._next=function(e){n.nextTick(e)},e.prototype.end=function(e){if(\"function\"!=typeof e)throw new Error(\"end() requires a callback argument\");if(this._ended)return n.nextTick(e,new Error(\"end() already called on iterator\"));this._ended=!0,this._end(e)},e.prototype._end=function(e){n.nextTick(e)},t.exports=e}).call(this,e(88))},{88:88}],28:[function(r,i,e){(function(o,s){var u=r(130),t=r(27),e=r(26),a=Object.prototype.hasOwnProperty,c=\"start end gt gte lt lte\".split(\" \");function n(e){if(!arguments.length||void 0===e)throw new Error(\"constructor requires at least a location argument\");if(\"string\"!=typeof e)throw new Error(\"constructor requires a location string argument\");this.location=e,this.status=\"new\"}n.prototype.open=function(e,t){var n=this,r=this.status;if(\"function\"==typeof e&&(t=e),\"function\"!=typeof t)throw new Error(\"open() requires a callback argument\");\"object\"!=typeof e&&(e={}),e.createIfMissing=!1!==e.createIfMissing,e.errorIfExists=!!e.errorIfExists,this.status=\"opening\",this._open(e,function(e){if(e)return n.status=r,t(e);n.status=\"open\",t()})},n.prototype._open=function(e,t){s.nextTick(t)},n.prototype.close=function(t){var n=this,r=this.status;if(\"function\"!=typeof t)throw new Error(\"close() requires a callback argument\");this.status=\"closing\",this._close(function(e){if(e)return n.status=r,t(e);n.status=\"closed\",t()})},n.prototype._close=function(e){s.nextTick(e)},n.prototype.get=function(e,t,n){if(\"function\"==typeof t&&(n=t),\"function\"!=typeof n)throw new Error(\"get() requires a callback argument\");var r=this._checkKey(e,\"key\");if(r)return s.nextTick(n,r);e=this._serializeKey(e),\"object\"!=typeof t&&(t={}),t.asBuffer=!1!==t.asBuffer,this._get(e,t,n)},n.prototype._get=function(e,t,n){s.nextTick(function(){n(new Error(\"NotFound\"))})},n.prototype.put=function(e,t,n,r){if(\"function\"==typeof n&&(r=n),\"function\"!=typeof r)throw new Error(\"put() requires a callback argument\");var i=this._checkKey(e,\"key\");if(i)return s.nextTick(r,i);e=this._serializeKey(e),t=this._serializeValue(t),\"object\"!=typeof n&&(n={}),this._put(e,t,n,r)},n.prototype._put=function(e,t,n,r){s.nextTick(r)},n.prototype.del=function(e,t,n){if(\"function\"==typeof t&&(n=t),\"function\"!=typeof n)throw new Error(\"del() requires a callback argument\");var r=this._checkKey(e,\"key\");if(r)return s.nextTick(n,r);e=this._serializeKey(e),\"object\"!=typeof t&&(t={}),this._del(e,t,n)},n.prototype._del=function(e,t,n){s.nextTick(n)},n.prototype.batch=function(e,t,n){if(!arguments.length)return this._chainedBatch();if(\"function\"==typeof t&&(n=t),\"function\"==typeof e&&(n=e),\"function\"!=typeof n)throw new Error(\"batch(array) requires a callback argument\");if(!Array.isArray(e))return s.nextTick(n,new Error(\"batch(array) requires an array argument\"));t&&\"object\"==typeof t||(t={});for(var r=new Array(e.length),i=0;i<e.length;i++){if(\"object\"!=typeof e[i]||null===e[i])return s.nextTick(n,new Error(\"batch(array) element must be an object and not `null`\"));var o=u(e[i]);if(\"put\"!==o.type&&\"del\"!==o.type)return s.nextTick(n,new Error(\"`type` must be 'put' or 'del'\"));var a=this._checkKey(o.key,\"key\");if(a)return s.nextTick(n,a);o.key=this._serializeKey(o.key),\"put\"===o.type&&(o.value=this._serializeValue(o.value)),r[i]=o}this._batch(r,t,n)},n.prototype._batch=function(e,t,n){s.nextTick(n)},n.prototype._setupIteratorOptions=function(e){return(e=function(e){var t={};for(var n in e)a.call(e,n)&&(i=n,-1!==c.indexOf(i)&&(\"\"===(r=e[n])||null==r||function(e){return o.isBuffer(e)&&0===e.length}(r))||(t[n]=e[n]));var r;var i;return t}(e)).reverse=!!e.reverse,e.keys=!1!==e.keys,e.values=!1!==e.values,e.limit=\"limit\"in e?e.limit:-1,e.keyAsBuffer=!1!==e.keyAsBuffer,e.valueAsBuffer=!1!==e.valueAsBuffer,e},n.prototype.iterator=function(e){return\"object\"!=typeof e&&(e={}),e=this._setupIteratorOptions(e),this._iterator(e)},n.prototype._iterator=function(e){return new t(this)},n.prototype._chainedBatch=function(){return new e(this)},n.prototype._serializeKey=function(e){return o.isBuffer(e)?e:String(e)},n.prototype._serializeValue=function(e){return null==e?\"\":o.isBuffer(e)||s.browser?e:String(e)},n.prototype._checkKey=function(e,t){return null==e?new Error(t+\" cannot be `null` or `undefined`\"):o.isBuffer(e)&&0===e.length?new Error(t+\" cannot be an empty Buffer\"):\"\"===String(e)?new Error(t+\" cannot be an empty String\"):void 0},i.exports=n}).call(this,{isBuffer:r(38)},r(88))},{130:130,26:26,27:27,38:38,88:88}],29:[function(e,t,n){n.AbstractLevelDOWN=e(28),n.AbstractIterator=e(27),n.AbstractChainedBatch=e(26)},{26:26,27:27,28:28}],30:[function(e,t,n){\"use strict\";function r(e){if(this._capacity=o(e),this._length=0,this._front=0,i(e)){for(var t=e.length,n=0;n<t;++n)this[n]=e[n];this._length=t}}r.prototype.toArray=function(){for(var e=this._length,t=new Array(e),n=this._front,r=this._capacity,i=0;i<e;++i)t[i]=this[n+i&r-1];return t},r.prototype.push=function(e){var t=arguments.length,n=this._length;if(1<t){var r=this._capacity;if(r<n+t){for(var i=0;i<t;++i){this._checkCapacity(n+1),this[o=this._front+n&this._capacity-1]=arguments[i],n++,this._length=n}return n}for(var o=this._front,i=0;i<t;++i)this[o+n&r-1]=arguments[i],o++;return this._length=n+t,n+t}return 0===t?n:(this._checkCapacity(n+1),this[i=this._front+n&this._capacity-1]=e,this._length=n+1,n+1)},r.prototype.pop=function(){var e=this._length;if(0!==e){var t=this._front+e-1&this._capacity-1,n=this[t];return this[t]=void 0,this._length=e-1,n}},r.prototype.shift=function(){var e=this._length;if(0!==e){var t=this._front,n=this[t];return this[t]=void 0,this._front=t+1&this._capacity-1,this._length=e-1,n}},r.prototype.unshift=function(e){var t=this._length,n=arguments.length;if(1<n){if((i=this._capacity)<t+n){for(var r=n-1;0<=r;r--){this._checkCapacity(t+1);var i=this._capacity;this[a=(this._front-1&i-1^i)-i]=arguments[r],t++,this._length=t,this._front=a}return t}var o=this._front;for(r=n-1;0<=r;r--){var a;this[a=(o-1&i-1^i)-i]=arguments[r],o=a}return this._front=o,this._length=t+n,t+n}if(0===n)return t;this._checkCapacity(t+1);i=this._capacity;return this[r=(this._front-1&i-1^i)-i]=e,this._length=t+1,this._front=r,t+1},r.prototype.peekBack=function(){var e=this._length;if(0!==e)return this[this._front+e-1&this._capacity-1]},r.prototype.peekFront=function(){if(0!==this._length)return this[this._front]},r.prototype.get=function(e){var t=e;if(t===(0|t)){var n=this._length;if(t<0&&(t+=n),!(t<0||n<=t))return this[this._front+t&this._capacity-1]}},r.prototype.isEmpty=function(){return 0===this._length},r.prototype.clear=function(){for(var e=this._length,t=this._front,n=this._capacity,r=0;r<e;++r)this[t+r&n-1]=void 0;this._length=0,this._front=0},r.prototype.valueOf=r.prototype.toString=function(){return this.toArray().toString()},r.prototype.removeFront=r.prototype.shift,r.prototype.removeBack=r.prototype.pop,r.prototype.insertFront=r.prototype.unshift,r.prototype.insertBack=r.prototype.push,r.prototype.enqueue=r.prototype.push,r.prototype.dequeue=r.prototype.shift,r.prototype.toJSON=r.prototype.toArray,Object.defineProperty(r.prototype,\"length\",{get:function(){return this._length},set:function(){throw new RangeError(\"\")}}),r.prototype._checkCapacity=function(e){this._capacity<e&&this._resizeTo(o(1.5*this._capacity+16))},r.prototype._resizeTo=function(e){var t=this._capacity;this._capacity=e;var n=this._front,r=this._length;t<n+r&&function(e,t,n,r,i){for(var o=0;o<i;++o)n[o+r]=e[o+t],e[o+t]=void 0}(this,0,this,t,n+r&t-1)};var i=Array.isArray;function o(e){if(\"number\"!=typeof e){if(!i(e))return 16;e=e.length}return function(e){return e>>>=0,e-=1,e|=e>>1,e|=e>>2,e|=e>>4,e|=e>>8,(e|=e>>16)+1}(Math.min(Math.max(16,e),1073741824))}t.exports=r},{}],31:[function(e,t,n){var r=e(89);function o(e,t,n){t&&\"string\"!=typeof t&&(t=t.message||t.name),r(this,{type:e,name:e,cause:\"string\"!=typeof t?t:n,message:t},\"ewr\")}function a(e,t){Error.call(this),Error.captureStackTrace&&Error.captureStackTrace(this,this.constructor),o.call(this,\"CustomError\",e,t)}a.prototype=new Error,t.exports=function(n){function e(e,t){return function(n,r,e){var i=function(e,t){o.call(this,r,e,t),\"FilesystemError\"==r&&(this.code=this.cause.code,this.path=this.cause.path,this.errno=this.cause.errno,this.message=(n.errno[this.cause.errno]?n.errno[this.cause.errno].description:this.cause.message)+(this.cause.path?\" [\"+this.cause.path+\"]\":\"\")),Error.call(this),Error.captureStackTrace&&Error.captureStackTrace(this,i)};return i.prototype=e?new e:new a,i}(n,e,t)}return{CustomError:a,FilesystemError:e(\"FilesystemError\"),createError:e}}},{89:89}],32:[function(e,t,n){var r=t.exports.all=[{errno:-2,code:\"ENOENT\",description:\"no such file or directory\"},{errno:-1,code:\"UNKNOWN\",description:\"unknown error\"},{errno:0,code:\"OK\",description:\"success\"},{errno:1,code:\"EOF\",description:\"end of file\"},{errno:2,code:\"EADDRINFO\",description:\"getaddrinfo error\"},{errno:3,code:\"EACCES\",description:\"permission denied\"},{errno:4,code:\"EAGAIN\",description:\"resource temporarily unavailable\"},{errno:5,code:\"EADDRINUSE\",description:\"address already in use\"},{errno:6,code:\"EADDRNOTAVAIL\",description:\"address not available\"},{errno:7,code:\"EAFNOSUPPORT\",description:\"address family not supported\"},{errno:8,code:\"EALREADY\",description:\"connection already in progress\"},{errno:9,code:\"EBADF\",description:\"bad file descriptor\"},{errno:10,code:\"EBUSY\",description:\"resource busy or locked\"},{errno:11,code:\"ECONNABORTED\",description:\"software caused connection abort\"},{errno:12,code:\"ECONNREFUSED\",description:\"connection refused\"},{errno:13,code:\"ECONNRESET\",description:\"connection reset by peer\"},{errno:14,code:\"EDESTADDRREQ\",description:\"destination address required\"},{errno:15,code:\"EFAULT\",description:\"bad address in system call argument\"},{errno:16,code:\"EHOSTUNREACH\",description:\"host is unreachable\"},{errno:17,code:\"EINTR\",description:\"interrupted system call\"},{errno:18,code:\"EINVAL\",description:\"invalid argument\"},{errno:19,code:\"EISCONN\",description:\"socket is already connected\"},{errno:20,code:\"EMFILE\",description:\"too many open files\"},{errno:21,code:\"EMSGSIZE\",description:\"message too long\"},{errno:22,code:\"ENETDOWN\",description:\"network is down\"},{errno:23,code:\"ENETUNREACH\",description:\"network is unreachable\"},{errno:24,code:\"ENFILE\",description:\"file table overflow\"},{errno:25,code:\"ENOBUFS\",description:\"no buffer space available\"},{errno:26,code:\"ENOMEM\",description:\"not enough memory\"},{errno:27,code:\"ENOTDIR\",description:\"not a directory\"},{errno:28,code:\"EISDIR\",description:\"illegal operation on a directory\"},{errno:29,code:\"ENONET\",description:\"machine is not on the network\"},{errno:31,code:\"ENOTCONN\",description:\"socket is not connected\"},{errno:32,code:\"ENOTSOCK\",description:\"socket operation on non-socket\"},{errno:33,code:\"ENOTSUP\",description:\"operation not supported on socket\"},{errno:34,code:\"ENOENT\",description:\"no such file or directory\"},{errno:35,code:\"ENOSYS\",description:\"function not implemented\"},{errno:36,code:\"EPIPE\",description:\"broken pipe\"},{errno:37,code:\"EPROTO\",description:\"protocol error\"},{errno:38,code:\"EPROTONOSUPPORT\",description:\"protocol not supported\"},{errno:39,code:\"EPROTOTYPE\",description:\"protocol wrong type for socket\"},{errno:40,code:\"ETIMEDOUT\",description:\"connection timed out\"},{errno:41,code:\"ECHARSET\",description:\"invalid Unicode character\"},{errno:42,code:\"EAIFAMNOSUPPORT\",description:\"address family for hostname not supported\"},{errno:44,code:\"EAISERVICE\",description:\"servname not supported for ai_socktype\"},{errno:45,code:\"EAISOCKTYPE\",description:\"ai_socktype not supported\"},{errno:46,code:\"ESHUTDOWN\",description:\"cannot send after transport endpoint shutdown\"},{errno:47,code:\"EEXIST\",description:\"file already exists\"},{errno:48,code:\"ESRCH\",description:\"no such process\"},{errno:49,code:\"ENAMETOOLONG\",description:\"name too long\"},{errno:50,code:\"EPERM\",description:\"operation not permitted\"},{errno:51,code:\"ELOOP\",description:\"too many symbolic links encountered\"},{errno:52,code:\"EXDEV\",description:\"cross-device link not permitted\"},{errno:53,code:\"ENOTEMPTY\",description:\"directory not empty\"},{errno:54,code:\"ENOSPC\",description:\"no space left on device\"},{errno:55,code:\"EIO\",description:\"i/o error\"},{errno:56,code:\"EROFS\",description:\"read-only file system\"},{errno:57,code:\"ENODEV\",description:\"no such device\"},{errno:58,code:\"ESPIPE\",description:\"invalid seek\"},{errno:59,code:\"ECANCELED\",description:\"operation canceled\"}];t.exports.errno={},t.exports.code={},r.forEach(function(e){t.exports.errno[e.errno]=e,t.exports.code[e.code]=e}),t.exports.custom=e(31)(t.exports),t.exports.create=t.exports.custom.createError},{31:31}],33:[function(e,t,n){var u=Object.create||function(e){function t(){}return t.prototype=e,new t},a=Object.keys||function(e){var t=[];for(var n in e)Object.prototype.hasOwnProperty.call(e,n)&&t.push(n);return n},o=Function.prototype.bind||function(e){var t=this;return function(){return t.apply(e,arguments)}};function r(){this._events&&Object.prototype.hasOwnProperty.call(this,\"_events\")||(this._events=u(null),this._eventsCount=0),this._maxListeners=this._maxListeners||void 0}((t.exports=r).EventEmitter=r).prototype._events=void 0,r.prototype._maxListeners=void 0;var i,s=10;try{var c={};Object.defineProperty&&Object.defineProperty(c,\"x\",{value:0}),i=0===c.x}catch(e){i=!1}function f(e){return void 0===e._maxListeners?r.defaultMaxListeners:e._maxListeners}function l(e,t,n,r){var i,o,a;if(\"function\"!=typeof n)throw new TypeError('\"listener\" argument must be a function');if((o=e._events)?(o.newListener&&(e.emit(\"newListener\",t,n.listener?n.listener:n),o=e._events),a=o[t]):(o=e._events=u(null),e._eventsCount=0),a){if(\"function\"==typeof a?a=o[t]=r?[n,a]:[a,n]:r?a.unshift(n):a.push(n),!a.warned&&(i=f(e))&&0<i&&a.length>i){a.warned=!0;var s=new Error(\"Possible EventEmitter memory leak detected. \"+a.length+' \"'+String(t)+'\" listeners added. Use emitter.setMaxListeners() to increase limit.');s.name=\"MaxListenersExceededWarning\",s.emitter=e,s.type=t,s.count=a.length,\"object\"==typeof console&&console.warn&&console.warn(\"%s: %s\",s.name,s.message)}}else a=o[t]=n,++e._eventsCount;return e}function h(){if(!this.fired)switch(this.target.removeListener(this.type,this.wrapFn),this.fired=!0,arguments.length){case 0:return this.listener.call(this.target);case 1:return this.listener.call(this.target,arguments[0]);case 2:return this.listener.call(this.target,arguments[0],arguments[1]);case 3:return this.listener.call(this.target,arguments[0],arguments[1],arguments[2]);default:for(var e=new Array(arguments.length),t=0;t<e.length;++t)e[t]=arguments[t];this.listener.apply(this.target,e)}}function d(e,t,n){var r={fired:!1,wrapFn:void 0,target:e,type:t,listener:n},i=o.call(h,r);return i.listener=n,r.wrapFn=i}function p(e,t,n){var r=e._events;if(!r)return[];var i=r[t];return i?\"function\"==typeof i?n?[i.listener||i]:[i]:n?function(e){for(var t=new Array(e.length),n=0;n<t.length;++n)t[n]=e[n].listener||e[n];return t}(i):g(i,i.length):[]}function v(e){var t=this._events;if(t){var n=t[e];if(\"function\"==typeof n)return 1;if(n)return n.length}return 0}function g(e,t){for(var n=new Array(t),r=0;r<t;++r)n[r]=e[r];return n}i?Object.defineProperty(r,\"defaultMaxListeners\",{enumerable:!0,get:function(){return s},set:function(e){if(\"number\"!=typeof e||e<0||e!=e)throw new TypeError('\"defaultMaxListeners\" must be a positive number');s=e}}):r.defaultMaxListeners=s,r.prototype.setMaxListeners=function(e){if(\"number\"!=typeof e||e<0||isNaN(e))throw new TypeError('\"n\" argument must be a positive number');return this._maxListeners=e,this},r.prototype.getMaxListeners=function(){return f(this)},r.prototype.emit=function(e,t,n,r){var i,o,a,s,u,c,f=\"error\"===e;if(c=this._events)f=f&&null==c.error;else if(!f)return!1;if(f){if(1<arguments.length&&(i=t),i instanceof Error)throw i;var l=new Error('Unhandled \"error\" event. ('+i+\")\");throw l.context=i,l}if(!(o=c[e]))return!1;var h=\"function\"==typeof o;switch(a=arguments.length){case 1:!function(e,t,n){if(t)e.call(n);else for(var r=e.length,i=g(e,r),o=0;o<r;++o)i[o].call(n)}(o,h,this);break;case 2:!function(e,t,n,r){if(t)e.call(n,r);else for(var i=e.length,o=g(e,i),a=0;a<i;++a)o[a].call(n,r)}(o,h,this,t);break;case 3:!function(e,t,n,r,i){if(t)e.call(n,r,i);else for(var o=e.length,a=g(e,o),s=0;s<o;++s)a[s].call(n,r,i)}(o,h,this,t,n);break;case 4:!function(e,t,n,r,i,o){if(t)e.call(n,r,i,o);else for(var a=e.length,s=g(e,a),u=0;u<a;++u)s[u].call(n,r,i,o)}(o,h,this,t,n,r);break;default:for(s=new Array(a-1),u=1;u<a;u++)s[u-1]=arguments[u];!function(e,t,n,r){if(t)e.apply(n,r);else for(var i=e.length,o=g(e,i),a=0;a<i;++a)o[a].apply(n,r)}(o,h,this,s)}return!0},r.prototype.on=r.prototype.addListener=function(e,t){return l(this,e,t,!1)},r.prototype.prependListener=function(e,t){return l(this,e,t,!0)},r.prototype.once=function(e,t){if(\"function\"!=typeof t)throw new TypeError('\"listener\" argument must be a function');return this.on(e,d(this,e,t)),this},r.prototype.prependOnceListener=function(e,t){if(\"function\"!=typeof t)throw new TypeError('\"listener\" argument must be a function');return this.prependListener(e,d(this,e,t)),this},r.prototype.removeListener=function(e,t){var n,r,i,o,a;if(\"function\"!=typeof t)throw new TypeError('\"listener\" argument must be a function');if(!(r=this._events))return this;if(!(n=r[e]))return this;if(n===t||n.listener===t)0==--this._eventsCount?this._events=u(null):(delete r[e],r.removeListener&&this.emit(\"removeListener\",e,n.listener||t));else if(\"function\"!=typeof n){for(i=-1,o=n.length-1;0<=o;o--)if(n[o]===t||n[o].listener===t){a=n[o].listener,i=o;break}if(i<0)return this;0===i?n.shift():function(e,t){for(var n=t,r=n+1,i=e.length;r<i;n+=1,r+=1)e[n]=e[r];e.pop()}(n,i),1===n.length&&(r[e]=n[0]),r.removeListener&&this.emit(\"removeListener\",e,a||t)}return this},r.prototype.removeAllListeners=function(e){var t,n,r;if(!(n=this._events))return this;if(!n.removeListener)return 0===arguments.length?(this._events=u(null),this._eventsCount=0):n[e]&&(0==--this._eventsCount?this._events=u(null):delete n[e]),this;if(0===arguments.length){var i,o=a(n);for(r=0;r<o.length;++r)\"removeListener\"!==(i=o[r])&&this.removeAllListeners(i);return this.removeAllListeners(\"removeListener\"),this._events=u(null),this._eventsCount=0,this}if(\"function\"==typeof(t=n[e]))this.removeListener(e,t);else if(t)for(r=t.length-1;0<=r;r--)this.removeListener(e,t[r]);return this},r.prototype.listeners=function(e){return p(this,e,!0)},r.prototype.rawListeners=function(e){return p(this,e,!1)},r.listenerCount=function(e,t){return\"function\"==typeof e.listenerCount?e.listenerCount(t):v.call(e,t)},r.prototype.listenerCount=v,r.prototype.eventNames=function(){return 0<this._eventsCount?Reflect.ownKeys(this._events):[]}},{}],34:[function(e,t,n){\"use strict\";t.exports=function(e){return new v(e||o,null)};function h(e,t,n,r,i,o){this._color=e,this.key=t,this.value=n,this.left=r,this.right=i,this._count=o}function u(e){return new h(e._color,e.key,e.value,e.left,e.right,e._count)}function d(e,t){return new h(e,t.key,t.value,t.left,t.right,t._count)}function p(e){e._count=1+(e.left?e.left._count:0)+(e.right?e.right._count:0)}function v(e,t){this._compare=e,this.root=t}var r=v.prototype;function a(e,t){this.tree=e,this._stack=t}Object.defineProperty(r,\"keys\",{get:function(){var n=[];return this.forEach(function(e,t){n.push(e)}),n}}),Object.defineProperty(r,\"values\",{get:function(){var n=[];return this.forEach(function(e,t){n.push(t)}),n}}),Object.defineProperty(r,\"length\",{get:function(){return this.root?this.root._count:0}}),r.insert=function(e,t){for(var n=this._compare,r=this.root,i=[],o=[];r;){var a=n(e,r.key);i.push(r),o.push(a),r=a<=0?r.left:r.right}i.push(new h(0,e,t,null,null,1));for(var s=i.length-2;0<=s;--s){r=i[s];o[s]<=0?i[s]=new h(r._color,r.key,r.value,i[s+1],r.right,r._count+1):i[s]=new h(r._color,r.key,r.value,r.left,i[s+1],r._count+1)}for(s=i.length-1;1<s;--s){var u=i[s-1];r=i[s];if(1===u._color||1===r._color)break;var c=i[s-2];if(c.left===u)if(u.left===r){if(!(f=c.right)||0!==f._color){if(c._color=0,c.left=u.right,u._color=1,u.right=c,i[s-2]=u,i[s-1]=r,p(c),p(u),3<=s)(l=i[s-3]).left===c?l.left=u:l.right=u;break}u._color=1,c.right=d(1,f),c._color=0,s-=1}else{if(!(f=c.right)||0!==f._color){if(u.right=r.left,c._color=0,c.left=r.right,r._color=1,r.left=u,r.right=c,i[s-2]=r,i[s-1]=u,p(c),p(u),p(r),3<=s)(l=i[s-3]).left===c?l.left=r:l.right=r;break}u._color=1,c.right=d(1,f),c._color=0,s-=1}else if(u.right===r){if(!(f=c.left)||0!==f._color){if(c._color=0,c.right=u.left,u._color=1,u.left=c,i[s-2]=u,i[s-1]=r,p(c),p(u),3<=s)(l=i[s-3]).right===c?l.right=u:l.left=u;break}u._color=1,c.left=d(1,f),c._color=0,s-=1}else{var f;if(!(f=c.left)||0!==f._color){var l;if(u.left=r.right,c._color=0,c.right=r.left,r._color=1,r.right=u,r.left=c,i[s-2]=r,i[s-1]=u,p(c),p(u),p(r),3<=s)(l=i[s-3]).right===c?l.right=r:l.left=r;break}u._color=1,c.left=d(1,f),c._color=0,s-=1}}return i[0]._color=1,new v(n,i[0])},r.forEach=function(e,t,n){if(this.root)switch(arguments.length){case 1:return function e(t,n){var r;if(n.left&&(r=e(t,n.left)))return r;return(r=t(n.key,n.value))||(n.right?e(t,n.right):void 0)}(e,this.root);case 2:return function e(t,n,r,i){if(n(t,i.key)<=0){var o;if(i.left&&(o=e(t,n,r,i.left)))return o;if(o=r(i.key,i.value))return o}if(i.right)return e(t,n,r,i.right)}(t,this._compare,e,this.root);case 3:if(0<=this._compare(t,n))return;return function e(t,n,r,i,o){var a,s=r(t,o.key),u=r(n,o.key);if(s<=0){if(o.left&&(a=e(t,n,r,i,o.left)))return a;if(0<u&&(a=i(o.key,o.value)))return a}if(0<u&&o.right)return e(t,n,r,i,o.right)}(t,n,this._compare,e,this.root)}},Object.defineProperty(r,\"begin\",{get:function(){for(var e=[],t=this.root;t;)e.push(t),t=t.left;return new a(this,e)}}),Object.defineProperty(r,\"end\",{get:function(){for(var e=[],t=this.root;t;)e.push(t),t=t.right;return new a(this,e)}}),r.at=function(e){if(e<0)return new a(this,[]);for(var t=this.root,n=[];;){if(n.push(t),t.left){if(e<t.left._count){t=t.left;continue}e-=t.left._count}if(!e)return new a(this,n);if(e-=1,!t.right)break;if(e>=t.right._count)break;t=t.right}return new a(this,[])},r.ge=function(e){for(var t=this._compare,n=this.root,r=[],i=0;n;){var o=t(e,n.key);r.push(n),o<=0&&(i=r.length),n=o<=0?n.left:n.right}return r.length=i,new a(this,r)},r.gt=function(e){for(var t=this._compare,n=this.root,r=[],i=0;n;){var o=t(e,n.key);r.push(n),o<0&&(i=r.length),n=o<0?n.left:n.right}return r.length=i,new a(this,r)},r.lt=function(e){for(var t=this._compare,n=this.root,r=[],i=0;n;){var o=t(e,n.key);r.push(n),0<o&&(i=r.length),n=o<=0?n.left:n.right}return r.length=i,new a(this,r)},r.le=function(e){for(var t=this._compare,n=this.root,r=[],i=0;n;){var o=t(e,n.key);r.push(n),0<=o&&(i=r.length),n=o<0?n.left:n.right}return r.length=i,new a(this,r)},r.find=function(e){for(var t=this._compare,n=this.root,r=[];n;){var i=t(e,n.key);if(r.push(n),0===i)return new a(this,r);n=i<=0?n.left:n.right}return new a(this,[])},r.remove=function(e){var t=this.find(e);return t?t.remove():this},r.get=function(e){for(var t=this._compare,n=this.root;n;){var r=t(e,n.key);if(0===r)return n.value;n=r<=0?n.left:n.right}};var i=a.prototype;function c(e,t){e.key=t.key,e.value=t.value,e.left=t.left,e.right=t.right,e._color=t._color,e._count=t._count}function o(e,t){return e<t?-1:t<e?1:0}Object.defineProperty(i,\"valid\",{get:function(){return 0<this._stack.length}}),Object.defineProperty(i,\"node\",{get:function(){return 0<this._stack.length?this._stack[this._stack.length-1]:null},enumerable:!0}),i.clone=function(){return new a(this.tree,this._stack.slice())},i.remove=function(){var e=this._stack;if(0===e.length)return this.tree;var t=new Array(e.length),n=e[e.length-1];t[t.length-1]=new h(n._color,n.key,n.value,n.left,n.right,n._count);for(var r=e.length-2;0<=r;--r){(n=e[r]).left===e[r+1]?t[r]=new h(n._color,n.key,n.value,t[r+1],n.right,n._count):t[r]=new h(n._color,n.key,n.value,n.left,t[r+1],n._count)}if((n=t[t.length-1]).left&&n.right){var i=t.length;for(n=n.left;n.right;)t.push(n),n=n.right;var o=t[i-1];t.push(new h(n._color,o.key,o.value,n.left,n.right,n._count)),t[i-1].key=n.key,t[i-1].value=n.value;for(r=t.length-2;i<=r;--r)n=t[r],t[r]=new h(n._color,n.key,n.value,n.left,t[r+1],n._count);t[i-1].left=t[i]}if(0===(n=t[t.length-1])._color){var a=t[t.length-2];a.left===n?a.left=null:a.right===n&&(a.right=null),t.pop();for(r=0;r<t.length;++r)t[r]._count--;return new v(this.tree._compare,t[0])}if(n.left||n.right){n.left?c(n,n.left):n.right&&c(n,n.right),n._color=1;for(r=0;r<t.length-1;++r)t[r]._count--;return new v(this.tree._compare,t[0])}if(1===t.length)return new v(this.tree._compare,null);for(r=0;r<t.length;++r)t[r]._count--;var s=t[t.length-2];return function(e){for(var t,n,r,i,o=e.length-1;0<=o;--o){if(t=e[o],0===o)return t._color=1;if((n=e[o-1]).left===t){if((r=n.right).right&&0===r.right._color){if(i=(r=n.right=u(r)).right=u(r.right),n.right=r.left,r.left=n,r.right=i,r._color=n._color,t._color=1,n._color=1,i._color=1,p(n),p(r),1<o)(a=e[o-2]).left===n?a.left=r:a.right=r;return e[o-1]=r}if(r.left&&0===r.left._color){if(i=(r=n.right=u(r)).left=u(r.left),n.right=i.left,r.left=i.right,i.left=n,i.right=r,i._color=n._color,n._color=1,r._color=1,t._color=1,p(n),p(r),p(i),1<o)(a=e[o-2]).left===n?a.left=i:a.right=i;return e[o-1]=i}if(1===r._color){if(0===n._color)return n._color=1,n.right=d(0,r);n.right=d(0,r);continue}r=u(r),n.right=r.left,r.left=n,r._color=n._color,n._color=0,p(n),p(r),1<o&&((a=e[o-2]).left===n?a.left=r:a.right=r),e[o-1]=r,e[o]=n,o+1<e.length?e[o+1]=t:e.push(t),o+=2}else{if((r=n.left).left&&0===r.left._color){if(i=(r=n.left=u(r)).left=u(r.left),n.left=r.right,r.right=n,r.left=i,r._color=n._color,t._color=1,n._color=1,i._color=1,p(n),p(r),1<o)(a=e[o-2]).right===n?a.right=r:a.left=r;return e[o-1]=r}if(r.right&&0===r.right._color){if(i=(r=n.left=u(r)).right=u(r.right),n.left=i.right,r.right=i.left,i.right=n,i.left=r,i._color=n._color,n._color=1,r._color=1,t._color=1,p(n),p(r),p(i),1<o)(a=e[o-2]).right===n?a.right=i:a.left=i;return e[o-1]=i}if(1===r._color){if(0===n._color)return n._color=1,n.left=d(0,r);n.left=d(0,r);continue}var a;r=u(r),n.left=r.right,r.right=n,r._color=n._color,n._color=0,p(n),p(r),1<o&&((a=e[o-2]).right===n?a.right=r:a.left=r),e[o-1]=r,e[o]=n,o+1<e.length?e[o+1]=t:e.push(t),o+=2}}}(t),s.left===n?s.left=null:s.right=null,new v(this.tree._compare,t[0])},Object.defineProperty(i,\"key\",{get:function(){if(0<this._stack.length)return this._stack[this._stack.length-1].key},enumerable:!0}),Object.defineProperty(i,\"value\",{get:function(){if(0<this._stack.length)return this._stack[this._stack.length-1].value},enumerable:!0}),Object.defineProperty(i,\"index\",{get:function(){var e=0,t=this._stack;if(0===t.length){var n=this.tree.root;return n?n._count:0}t[t.length-1].left&&(e=t[t.length-1].left._count);for(var r=t.length-2;0<=r;--r)t[r+1]===t[r].right&&(++e,t[r].left&&(e+=t[r].left._count));return e},enumerable:!0}),i.next=function(){var e=this._stack;if(0!==e.length){var t=e[e.length-1];if(t.right)for(t=t.right;t;)e.push(t),t=t.left;else for(e.pop();0<e.length&&e[e.length-1].right===t;)t=e[e.length-1],e.pop()}},Object.defineProperty(i,\"hasNext\",{get:function(){var e=this._stack;if(0===e.length)return!1;if(e[e.length-1].right)return!0;for(var t=e.length-1;0<t;--t)if(e[t-1].left===e[t])return!0;return!1}}),i.update=function(e){var t=this._stack;if(0===t.length)throw new Error(\"Can't update empty node!\");var n=new Array(t.length),r=t[t.length-1];n[n.length-1]=new h(r._color,r.key,e,r.left,r.right,r._count);for(var i=t.length-2;0<=i;--i)(r=t[i]).left===t[i+1]?n[i]=new h(r._color,r.key,r.value,n[i+1],r.right,r._count):n[i]=new h(r._color,r.key,r.value,r.left,n[i+1],r._count);return new v(this.tree._compare,n[0])},i.prev=function(){var e=this._stack;if(0!==e.length){var t=e[e.length-1];if(t.left)for(t=t.left;t;)e.push(t),t=t.right;else for(e.pop();0<e.length&&e[e.length-1].left===t;)t=e[e.length-1],e.pop()}},Object.defineProperty(i,\"hasPrev\",{get:function(){var e=this._stack;if(0===e.length)return!1;if(e[e.length-1].left)return!0;for(var t=e.length-1;0<t;--t)if(e[t-1].right===e[t])return!0;return!1}})},{}],35:[function(e,t,n){n.read=function(e,t,n,r,i){var o,a,s=8*i-r-1,u=(1<<s)-1,c=u>>1,f=-7,l=n?i-1:0,h=n?-1:1,d=e[t+l];for(l+=h,o=d&(1<<-f)-1,d>>=-f,f+=s;0<f;o=256*o+e[t+l],l+=h,f-=8);for(a=o&(1<<-f)-1,o>>=-f,f+=r;0<f;a=256*a+e[t+l],l+=h,f-=8);if(0===o)o=1-c;else{if(o===u)return a?NaN:1/0*(d?-1:1);a+=Math.pow(2,r),o-=c}return(d?-1:1)*a*Math.pow(2,o-r)},n.write=function(e,t,n,r,i,o){var a,s,u,c=8*o-i-1,f=(1<<c)-1,l=f>>1,h=23===i?Math.pow(2,-24)-Math.pow(2,-77):0,d=r?0:o-1,p=r?1:-1,v=t<0||0===t&&1/t<0?1:0;for(t=Math.abs(t),isNaN(t)||t===1/0?(s=isNaN(t)?1:0,a=f):(a=Math.floor(Math.log(t)/Math.LN2),t*(u=Math.pow(2,-a))<1&&(a--,u*=2),2<=(t+=1<=a+l?h/u:h*Math.pow(2,1-l))*u&&(a++,u/=2),f<=a+l?(s=0,a=f):1<=a+l?(s=(t*u-1)*Math.pow(2,i),a+=l):(s=t*Math.pow(2,l-1)*Math.pow(2,i),a=0));8<=i;e[n+d]=255&s,d+=p,s/=256,i-=8);for(a=a<<i|s,c+=i;0<c;e[n+d]=255&a,d+=p,a/=256,c-=8);e[n+d-p]|=128*v}},{}],36:[function(e,f,t){(function(t){\"use strict\";var n,r,e=t.MutationObserver||t.WebKitMutationObserver;if(e){var i=0,o=new e(c),a=t.document.createTextNode(\"\");o.observe(a,{characterData:!0}),n=function(){a.data=i=++i%2}}else if(t.setImmediate||void 0===t.MessageChannel)n=\"document\"in t&&\"onreadystatechange\"in t.document.createElement(\"script\")?function(){var e=t.document.createElement(\"script\");e.onreadystatechange=function(){c(),e.onreadystatechange=null,e.parentNode.removeChild(e),e=null},t.document.documentElement.appendChild(e)}:function(){setTimeout(c,0)};else{var s=new t.MessageChannel;s.port1.onmessage=c,n=function(){s.port2.postMessage(0)}}var u=[];function c(){var e,t;r=!0;for(var n=u.length;n;){for(t=u,u=[],e=-1;++e<n;)t[e]();n=u.length}r=!1}f.exports=function(e){1!==u.push(e)||r||n()}}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],37:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){t&&(e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}}))}:t.exports=function(e,t){if(t){e.super_=t;function n(){}n.prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e}}},{}],38:[function(e,t,n){function r(e){return!!e.constructor&&\"function\"==typeof e.constructor.isBuffer&&e.constructor.isBuffer(e)}t.exports=function(e){return null!=e&&(r(e)||function(e){return\"function\"==typeof e.readFloatLE&&\"function\"==typeof e.slice&&r(e.slice(0,0))}(e)||!!e._isBuffer)}},{}],39:[function(e,t,n){var r={}.toString;t.exports=Array.isArray||function(e){return\"[object Array]\"==r.call(e)}},{}],40:[function(e,t,n){var r=e(41);function i(e){this.opts=e||{},this.encodings=r}(t.exports=i).prototype._encoding=function(e){return\"string\"==typeof e&&(e=r[e]),e=e||r.id},i.prototype._keyEncoding=function(e,t){return this._encoding(t&&t.keyEncoding||e&&e.keyEncoding||this.opts.keyEncoding)},i.prototype._valueEncoding=function(e,t){return this._encoding(t&&(t.valueEncoding||t.encoding)||e&&(e.valueEncoding||e.encoding)||this.opts.valueEncoding||this.opts.encoding)},i.prototype.encodeKey=function(e,t,n){return this._keyEncoding(t,n).encode(e)},i.prototype.encodeValue=function(e,t,n){return this._valueEncoding(t,n).encode(e)},i.prototype.decodeKey=function(e,t){return this._keyEncoding(t).decode(e)},i.prototype.decodeValue=function(e,t){return this._valueEncoding(t).decode(e)},i.prototype.encodeBatch=function(e,n){var r=this;return e.map(function(e){var t={type:e.type,key:r.encodeKey(e.key,n,e)};return r.keyAsBuffer(n,e)&&(t.keyEncoding=\"binary\"),e.prefix&&(t.prefix=e.prefix),\"value\"in e&&(t.value=r.encodeValue(e.value,n,e),r.valueAsBuffer(n,e)&&(t.valueEncoding=\"binary\")),t})};var o=[\"lt\",\"gt\",\"lte\",\"gte\",\"start\",\"end\"];i.prototype.encodeLtgt=function(t){var n=this,r={};return Object.keys(t).forEach(function(e){r[e]=-1<o.indexOf(e)?n.encodeKey(t[e],t):t[e]}),r},i.prototype.createStreamDecoder=function(n){var r=this;return n.keys&&n.values?function(e,t){return{key:r.decodeKey(e,n),value:r.decodeValue(t,n)}}:n.keys?function(e){return r.decodeKey(e,n)}:n.values?function(e,t){return r.decodeValue(t,n)}:function(){}},i.prototype.keyAsBuffer=function(e){return this._keyEncoding(e).buffer},i.prototype.valueAsBuffer=function(e){return this._valueEncoding(e).buffer}},{41:41}],41:[function(e,t,i){(function(n){i.utf8=i[\"utf-8\"]={encode:function(e){return r(e)?e:String(e)},decode:function(e){return\"string\"==typeof e?e:String(e)},buffer:!1,type:\"utf8\"},i.json={encode:JSON.stringify,decode:JSON.parse,buffer:!1,type:\"json\"},i.binary={encode:function(e){return r(e)?e:new n(e)},decode:e,buffer:!0,type:\"binary\"},i.none={encode:e,decode:e,buffer:!1,type:\"id\"},i.id=i.none;function e(e){return e}function r(e){return null==e||n.isBuffer(e)}[\"hex\",\"ascii\",\"base64\",\"ucs2\",\"ucs-2\",\"utf16le\",\"utf-16le\"].forEach(function(t){i[t]={encode:function(e){return r(e)?e:new n(e,t)},decode:function(e){return e.toString(t)},buffer:!0,type:t}})}).call(this,e(20).Buffer)},{20:20}],42:[function(e,t,n){var r=e(32).create,i=r(\"LevelUPError\"),o=r(\"NotFoundError\",i);o.prototype.notFound=!0,o.prototype.status=404,t.exports={LevelUPError:i,InitializationError:r(\"InitializationError\",i),OpenError:r(\"OpenError\",i),ReadError:r(\"ReadError\",i),WriteError:r(\"WriteError\",i),NotFoundError:o,EncodingError:r(\"EncodingError\",i)}},{32:32}],43:[function(e,t,n){var r=e(37),i=e(101).Readable,o=e(130);function a(e,t){if(!(this instanceof a))return new a(e,t);t=t||{},i.call(this,o(t,{objectMode:!0})),this._iterator=e,this._destroyed=!1,this._options=t,this.on(\"end\",this._cleanup.bind(this))}r(t.exports=a,i),a.prototype._read=function(){var r=this,i=this._options;this._destroyed||this._iterator.next(function(e,t,n){if(!r._destroyed)return e?r.emit(\"error\",e):void(void 0===t&&void 0===n?r.push(null):!1!==i.keys&&!1===i.values?r.push(t):!1===i.keys&&!1!==i.values?r.push(n):r.push({key:t,value:n}))})},a.prototype.destroy=a.prototype._cleanup=function(){var t=this;this._destroyed||(this._destroyed=!0,this._iterator.end(function(e){if(e)return t.emit(\"error\",e);t.emit(\"close\")}))}},{101:101,130:130,37:37}],44:[function(e,t,n){var i=e(42).WriteError,o=e(46);function r(e){this._levelup=e,this.batch=e.db.batch(),this.ops=[],this.length=0}r.prototype.put=function(e,t){try{this.batch.put(e,t)}catch(e){throw new i(e)}return this.ops.push({type:\"put\",key:e,value:t}),this.length++,this},r.prototype.del=function(e){try{this.batch.del(e)}catch(e){throw new i(e)}return this.ops.push({type:\"del\",key:e}),this.length++,this},r.prototype.clear=function(){try{this.batch.clear()}catch(e){throw new i(e)}return this.ops=[],this.length=0,this},r.prototype.write=function(t){var e,n=this._levelup,r=this.ops;t||(e=(t=o()).promise);try{this.batch.write(function(e){if(e)return t(new i(e));n.emit(\"batch\",r),t()})}catch(e){throw new i(e)}return e},t.exports=r},{42:42,46:46}],45:[function(m,b,e){(function(i){var o=m(33).EventEmitter,e=m(123).inherits,t=m(130),a=m(25),n=m(43),s=m(44),r=m(42),u=m(13),c=m(46),f=r.WriteError,l=r.ReadError,h=r.NotFoundError,d=r.OpenError,p=r.InitializationError;function v(e,t,n){if(!(this instanceof v))return new v(e,t,n);var r;if(o.call(this),this.setMaxListeners(1/0),\"function\"==typeof t&&(n=t,t={}),t=t||{},!e||\"object\"!=typeof e){if(r=new p(\"First argument must be an abstract-leveldown compliant store\"),\"function\"==typeof n)return i.nextTick(n,r);throw r}u.equal(typeof e.status,\"string\",\".status required, old abstract-leveldown\"),this.options=y(t),this._db=e,this.db=new a(e),this.open(n)}function g(e,t){return\"function\"==typeof e?e:t}function y(e){return\"object\"==typeof e&&null!==e?e:{}}function _(e,t){if(!e._isOpening()&&!e.isOpen())return i.nextTick(t,new l(\"Database is not open\")),!0}v.prototype.emit=o.prototype.emit,v.prototype.once=o.prototype.once,e(v,o),v.prototype.open=function(t){var e,n=this;return t||(e=(t=c()).promise),this.isOpen()?i.nextTick(t,null,n):this._isOpening()?this.once(\"open\",function(){t(null,n)}):(this.emit(\"opening\"),this.db.open(this.options,function(e){if(e)return t(new d(e));n.db=n._db,t(null,n),n.emit(\"open\"),n.emit(\"ready\")})),e},v.prototype.close=function(e){var t,n=this;return e||(t=(e=c()).promise),this.isOpen()?(this.db.close(function(){n.emit(\"closed\"),e.apply(null,arguments)}),this.emit(\"closing\"),this.db=new a(this._db)):this.isClosed()?i.nextTick(e):\"closing\"===this.db.status?this.once(\"closed\",e):this._isOpening()&&this.once(\"open\",function(){n.close(e)}),t},v.prototype.isOpen=function(){return\"open\"===this.db.status},v.prototype._isOpening=function(){return\"opening\"===this.db.status},v.prototype.isClosed=function(){return/^clos|new/.test(this.db.status)},v.prototype.get=function(n,e,r){if(null==n)throw new l(\"get() requires a key argument\");var t;return(r=g(e,r))||(t=(r=c()).promise),_(this,r)||(e=y(e),this.db.get(n,e,function(e,t){if(e)return e=/notfound/i.test(e)||e.notFound?new h(\"Key not found in database [\"+n+\"]\",e):new l(e),r(e);r(null,t)})),t},v.prototype.put=function(t,n,e,r){if(null==t)throw new f(\"put() requires a key argument\");var i,o=this;return(r=g(e,r))||(i=(r=c()).promise),_(this,r)||(e=y(e),this.db.put(t,n,e,function(e){if(e)return r(new f(e));o.emit(\"put\",t,n),r()})),i},v.prototype.del=function(t,e,n){if(null==t)throw new f(\"del() requires a key argument\");var r,i=this;return(n=g(e,n))||(r=(n=c()).promise),_(this,n)||(e=y(e),this.db.del(t,e,function(e){if(e)return n(new f(e));i.emit(\"del\",t),n()})),r},v.prototype.batch=function(t,e,n){if(!arguments.length)return new s(this);if(!Array.isArray(t))throw new f(\"batch() requires an array argument\");var r,i=this;return(n=g(e,n))||(r=(n=c()).promise),_(this,n)||(e=y(e),this.db.batch(t,e,function(e){if(e)return n(new f(e));i.emit(\"batch\",t),n()})),r},v.prototype.readStream=v.prototype.createReadStream=function(e){return\"number\"!=typeof(e=t({keys:!0,values:!0},e)).limit&&(e.limit=-1),new n(this.db.iterator(e),e)},v.prototype.keyStream=v.prototype.createKeyStream=function(e){return this.createReadStream(t(e,{keys:!0,values:!1}))},v.prototype.valueStream=v.prototype.createValueStream=function(e){return this.createReadStream(t(e,{keys:!1,values:!0}))},v.prototype.toString=function(){return\"LevelUP\"},v.errors=r,b.exports=v.default=v}).call(this,m(88))},{123:123,13:13,130:130,25:25,33:33,42:42,43:43,44:44,46:46,88:88}],46:[function(e,t,n){t.exports=function(){var e,t=new Promise(function(n,r){e=function(e,t){e?r(e):n(t)}});return e.promise=t,e}},{}],47:[function(e,t,n){\"use strict\";var i=e(36);function c(){}var f={},o=[\"REJECTED\"],a=[\"FULFILLED\"],r=[\"PENDING\"];function s(e){if(\"function\"!=typeof e)throw new TypeError(\"resolver must be a function\");this.state=r,this.queue=[],this.outcome=void 0,e!==c&&d(this,e)}function u(e,t,n){this.promise=e,\"function\"==typeof t&&(this.onFulfilled=t,this.callFulfilled=this.otherCallFulfilled),\"function\"==typeof n&&(this.onRejected=n,this.callRejected=this.otherCallRejected)}function l(t,n,r){i(function(){var e;try{e=n(r)}catch(e){return f.reject(t,e)}e===t?f.reject(t,new TypeError(\"Cannot resolve promise with itself\")):f.resolve(t,e)})}function h(e){var t=e&&e.then;if(e&&(\"object\"==typeof e||\"function\"==typeof e)&&\"function\"==typeof t)return function(){t.apply(e,arguments)}}function d(t,e){var n=!1;function r(e){n||(n=!0,f.reject(t,e))}function i(e){n||(n=!0,f.resolve(t,e))}var o=p(function(){e(i,r)});\"error\"===o.status&&r(o.value)}function p(e,t){var n={};try{n.value=e(t),n.status=\"success\"}catch(e){n.status=\"error\",n.value=e}return n}(t.exports=s).prototype.finally=function(t){if(\"function\"!=typeof t)return this;var n=this.constructor;return this.then(function(e){return n.resolve(t()).then(function(){return e})},function(e){return n.resolve(t()).then(function(){throw e})})},s.prototype.catch=function(e){return this.then(null,e)},s.prototype.then=function(e,t){if(\"function\"!=typeof e&&this.state===a||\"function\"!=typeof t&&this.state===o)return this;var n=new this.constructor(c);this.state!==r?l(n,this.state===a?e:t,this.outcome):this.queue.push(new u(n,e,t));return n},u.prototype.callFulfilled=function(e){f.resolve(this.promise,e)},u.prototype.otherCallFulfilled=function(e){l(this.promise,this.onFulfilled,e)},u.prototype.callRejected=function(e){f.reject(this.promise,e)},u.prototype.otherCallRejected=function(e){l(this.promise,this.onRejected,e)},f.resolve=function(e,t){var n=p(h,t);if(\"error\"===n.status)return f.reject(e,n.value);var r=n.value;if(r)d(e,r);else{e.state=a,e.outcome=t;for(var i=-1,o=e.queue.length;++i<o;)e.queue[i].callFulfilled(t)}return e},f.reject=function(e,t){e.state=o,e.outcome=t;for(var n=-1,r=e.queue.length;++n<r;)e.queue[n].callRejected(t);return e},s.resolve=function(e){if(e instanceof this)return e;return f.resolve(new this(c),e)},s.reject=function(e){var t=new this(c);return f.reject(t,e)},s.all=function(e){var n=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var r=e.length,i=!1;if(!r)return this.resolve([]);var o=new Array(r),a=0,t=-1,s=new this(c);for(;++t<r;)u(e[t],t);return s;function u(e,t){n.resolve(e).then(function(e){o[t]=e,++a!==r||i||(i=!0,f.resolve(s,o))},function(e){i||(i=!0,f.reject(s,e))})}},s.race=function(e){var t=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var n=e.length,r=!1;if(!n)return this.resolve([]);var i=-1,o=new this(c);for(;++i<n;)a=e[i],t.resolve(a).then(function(e){r||(r=!0,f.resolve(o,e))},function(e){r||(r=!0,f.reject(o,e))});var a;return o}},{36:36}],48:[function(e,t,p){(function(o){function u(e,t){return Object.hasOwnProperty.call(e,t)}function a(e){return void 0!==e&&\"\"!==e}function u(e,t){return Object.hasOwnProperty.call(e,t)}function t(e,t){return Object.hasOwnProperty.call(e,t)&&t}p.compare=function(e,t){if(o.isBuffer(e)){for(var n=Math.min(e.length,t.length),r=0;r<n;r++){var i=e[r]-t[r];if(i)return i}return e.length-t.length}return e<t?-1:t<e?1:0};var n=p.lowerBoundKey=function(e){return t(e,\"gt\")||t(e,\"gte\")||t(e,\"min\")||(e.reverse?t(e,\"end\"):t(e,\"start\"))||void 0},s=p.lowerBound=function(e){var t=n(e);return t&&e[t]},r=p.lowerBoundInclusive=function(e){return!u(e,\"gt\")},i=p.upperBoundInclusive=function(e){return!u(e,\"lt\")},c=p.lowerBoundExclusive=function(e){return!r(e)},f=p.upperBoundExclusive=function(e){return!i(e)},l=p.upperBoundKey=function(e){return t(e,\"lt\")||t(e,\"lte\")||t(e,\"max\")||(e.reverse?t(e,\"start\"):t(e,\"end\"))||void 0},h=p.upperBound=function(e){var t=l(e);return t&&e[t]};function d(e){return e}p.toLtgt=function(e,t,n,r,i){t=t||{},n=n||d;var o=3<arguments.length,a=p.lowerBoundKey(e),s=p.upperBoundKey(e);return a?\"gt\"===a?t.gt=n(e.gt,!1):t.gte=n(e[a],!1):o&&(t.gte=n(r,!1)),s?\"lt\"===s?t.lt=n(e.lt,!0):t.lte=n(e[s],!0):o&&(t.lte=n(i,!0)),null!=e.reverse&&(t.reverse=!!e.reverse),u(t,\"max\")&&delete t.max,u(t,\"min\")&&delete t.min,u(t,\"start\")&&delete t.start,u(t,\"end\")&&delete t.end,t},p.contains=function(e,t,n){n=n||p.compare;var r=s(e);if(a(r)&&((i=n(t,r))<0||0===i&&c(e)))return!1;var i,o=h(e);if(a(o)&&(0<(i=n(t,o))||0===i&&f(e)))return!1;return!0},p.filter=function(t,n){return function(e){return p.contains(t,e,n)}}}).call(this,{isBuffer:e(38)})},{38:38}],49:[function(e,t,n){t.exports=e(51)},{51:51}],50:[function(p,v,e){(function(i){var e=p(37),t=p(10).AbstractLevelDOWN,r=p(10).AbstractIterator,o=p(48),n=p(34),a={},c=p(49);function s(e){return 0<o.compare(e,this._end)}function u(e){return 0<=o.compare(e,this._end)}function f(e){return o.compare(e,this._end)<0}function l(e){return o.compare(e,this._end)<=0}function h(e,t){r.call(this,e),this._limit=t.limit,-1===this._limit&&(this._limit=1/0);var n=e._store[e._location];this.keyAsBuffer=!1!==t.keyAsBuffer,this.valueAsBuffer=!1!==t.valueAsBuffer,this._reverse=t.reverse,this._options=t,this._done=0,this._reverse?(this._incr=\"prev\",this._start=o.upperBound(t),this._end=o.lowerBound(t),void 0===this._start?this._tree=n.end:o.upperBoundInclusive(t)?this._tree=n.le(this._start):this._tree=n.lt(this._start),this._end&&(o.lowerBoundInclusive(t)?this._test=u:this._test=s)):(this._incr=\"next\",this._start=o.lowerBound(t),this._end=o.upperBound(t),void 0===this._start?this._tree=n.begin:o.lowerBoundInclusive(t)?this._tree=n.ge(this._start):this._tree=n.gt(this._start),this._end&&(o.upperBoundInclusive(t)?this._test=l:this._test=f))}function d(e){if(!(this instanceof d))return new d(e);t.call(this,\"string\"==typeof e?e:\"\"),this._location=this.location?\"$\"+this.location:\"_tree\",this._store=this.location?a:this,this._store[this._location]=this._store[this._location]||n(o.compare)}e(h,r),h.prototype._next=function(e){var t,n;return this._done++>=this._limit?c(e):this._tree.valid?(t=this._tree.key,n=this._tree.value,this._test(t)?(this.keyAsBuffer&&(t=new i(t)),this.valueAsBuffer&&(n=new i(n)),this._tree[this._incr](),void c(function(){e(null,t,n)})):c(e)):c(e)},h.prototype._test=function(){return!0},d.clearGlobalStore=function(e){e?Object.keys(a).forEach(function(e){delete a[e]}):a={}},e(d,t),d.prototype._open=function(e,t){var n=this;c(function(){t(null,n)})},d.prototype._put=function(e,t,n,r){null==t&&(t=\"\");var i=this._store[this._location].find(e);i.valid?this._store[this._location]=i.update(t):this._store[this._location]=this._store[this._location].insert(e,t),c(r)},d.prototype._get=function(e,t,n){var r=this._store[this._location].get(e);if(void 0===r)return c(function(){n(new Error(\"NotFound\"))});!1===t.asBuffer||this._isBuffer(r)||(r=new i(String(r))),c(function(){n(null,r)})},d.prototype._del=function(e,t,n){this._store[this._location]=this._store[this._location].remove(e),c(n)},d.prototype._batch=function(e,t,n){for(var r,i,o,a=-1,s=e.length,u=this._store[this._location];++a<s;)e[a]&&(r=this._isBuffer(e[a].key)?e[a].key:String(e[a].key),o=u.find(r),u=\"put\"===e[a].type?(i=this._isBuffer(e[a].value)?e[a].value:String(e[a].value),o.valid?o.update(i):u.insert(r,i)):o.remove());this._store[this._location]=u,c(n)},d.prototype._iterator=function(e){return new h(this,e)},d.prototype._isBuffer=function(e){return i.isBuffer(e)},d.destroy=function(e,t){var n=\"$\"+e;n in a&&delete a[n],c(t)},v.exports=d}).call(this,p(20).Buffer)},{10:10,20:20,34:34,37:37,48:48,49:49}],51:[function(e,t,n){\"use strict\";var r,i,o,a=[e(54),e(53),e(52),e(55),e(56)],s=-1,u=[],c=!1;function f(){r&&i&&(r=!1,i.length?u=i.concat(u):s=-1,u.length&&l())}function l(){if(!r){r=!(c=!1);for(var e=u.length,t=setTimeout(f);e;){for(i=u,u=[];i&&++s<e;)i[s].run();s=-1,e=u.length}i=null,r=!(s=-1),clearTimeout(t)}}for(var h=-1,d=a.length;++h<d;)if(a[h]&&a[h].test&&a[h].test()){o=a[h].install(l);break}function p(e,t){this.fun=e,this.array=t}p.prototype.run=function(){var e=this.fun,t=this.array;switch(t.length){case 0:return e();case 1:return e(t[0]);case 2:return e(t[0],t[1]);case 3:return e(t[0],t[1],t[2]);default:return e.apply(null,t)}},t.exports=function(e){var t=new Array(arguments.length-1);if(1<arguments.length)for(var n=1;n<arguments.length;n++)t[n-1]=arguments[n];u.push(new p(e,t)),c||r||(c=!0,o())}},{52:52,53:53,54:54,55:55,56:56}],52:[function(e,t,r){(function(n){\"use strict\";r.test=function(){return!n.setImmediate&&void 0!==n.MessageChannel},r.install=function(e){var t=new n.MessageChannel;return t.port1.onmessage=e,function(){t.port2.postMessage(0)}}}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],53:[function(e,t,n){(function(i){\"use strict\";var o=i.MutationObserver||i.WebKitMutationObserver;n.test=function(){return o},n.install=function(e){var t=0,n=new o(e),r=i.document.createTextNode(\"\");return n.observe(r,{characterData:!0}),function(){r.data=t=++t%2}}}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],54:[function(e,t,n){(function(t){\"use strict\";n.test=function(){return void 0!==t&&!t.browser},n.install=function(e){return function(){t.nextTick(e)}}}).call(this,e(88))},{88:88}],55:[function(e,t,r){(function(n){\"use strict\";r.test=function(){return\"document\"in n&&\"onreadystatechange\"in n.document.createElement(\"script\")},r.install=function(t){return function(){var e=n.document.createElement(\"script\");return e.onreadystatechange=function(){t(),e.onreadystatechange=null,e.parentNode.removeChild(e),e=null},n.document.documentElement.appendChild(e),t}}}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],56:[function(e,t,n){\"use strict\";n.test=function(){return!0},n.install=function(e){return function(){setTimeout(e,0)}}},{}],57:[function(e,t,n){var r=36e5,i=864e5;function o(e,t,n){if(!(e<t))return e<1.5*t?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}t.exports=function(e,t){t=t||{};var n=typeof e;if(\"string\"==n&&0<e.length)return function(e){if(100<(e=String(e)).length)return;var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(!t)return;var n=parseFloat(t[1]);switch((t[2]||\"ms\").toLowerCase()){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return 315576e5*n;case\"days\":case\"day\":case\"d\":return n*i;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*r;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return 6e4*n;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return 1e3*n;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n;default:return}}(e);if(\"number\"==n&&!1===isNaN(e))return t.long?function(e){return o(e,i,\"day\")||o(e,r,\"hour\")||o(e,6e4,\"minute\")||o(e,1e3,\"second\")||e+\" ms\"}(e):function(e){if(i<=e)return Math.round(e/i)+\"d\";if(r<=e)return Math.round(e/r)+\"h\";if(6e4<=e)return Math.round(e/6e4)+\"m\";if(1e3<=e)return Math.round(e/1e3)+\"s\";return e+\"ms\"}(e);throw new Error(\"val is not a non-empty string or a valid number. val=\"+JSON.stringify(e))}},{}],58:[function(e,t,n){\"use strict\";var u=Object.getOwnPropertySymbols,c=Object.prototype.hasOwnProperty,f=Object.prototype.propertyIsEnumerable;t.exports=function(){try{if(!Object.assign)return!1;var e=new String(\"abc\");if(e[5]=\"de\",\"5\"===Object.getOwnPropertyNames(e)[0])return!1;for(var t={},n=0;n<10;n++)t[\"_\"+String.fromCharCode(n)]=n;if(\"0123456789\"!==Object.getOwnPropertyNames(t).map(function(e){return t[e]}).join(\"\"))return!1;var r={};return\"abcdefghijklmnopqrst\".split(\"\").forEach(function(e){r[e]=e}),\"abcdefghijklmnopqrst\"===Object.keys(Object.assign({},r)).join(\"\")}catch(e){return!1}}()?Object.assign:function(e,t){for(var n,r,i=function(e){if(null==e)throw new TypeError(\"Object.assign cannot be called with null or undefined\");return Object(e)}(e),o=1;o<arguments.length;o++){for(var a in n=Object(arguments[o]))c.call(n,a)&&(i[a]=n[a]);if(u){r=u(n);for(var s=0;s<r.length;s++)f.call(n,r[s])&&(i[r[s]]=n[r[s]])}}return i}},{}],59:[function(e,t,n){\"use strict\";var w=e(85),f=e(80),k=e(69),i=e(65),E=e(68),S=e(72),x=e(74),O=e(77);function C(){this.promise=new Promise(function(e){e()})}function r(e){if(!e)return\"undefined\";switch(typeof e){case\"function\":case\"string\":return e.toString();default:return JSON.stringify(e)}}function A(i,o,a,s,t,n){var u,c=function(e,t){return r(e)+r(t)+\"undefined\"}(a,s);if(!t&&(u=i._cachedViews=i._cachedViews||{})[c])return u[c];var e=i.info().then(function(e){var r=e.db_name+\"-mrview-\"+(t?\"temp\":f.stringMd5(c));return w.upsert(i,\"_local/\"+n,function(e){e.views=e.views||{};var t=o;-1===t.indexOf(\"/\")&&(t=o+\"/\"+o);var n=e.views[t]=e.views[t]||{};if(!n[r])return n[r]=!0,e}).then(function(){return i.registerDependentDatabase(r).then(function(e){var t=e.db;t.auto_compaction=!0;var n={name:r,db:t,sourceDB:i,adapter:i.adapter,mapFun:a,reduceFun:s};return n.db.get(\"_local/lastSeq\").catch(function(e){if(404!==e.status)throw e}).then(function(e){return n.seq=e?e.seq:0,u&&n.db.once(\"destroyed\",function(){delete u[c]}),n})})})});return u&&(u[c]=e),e}C.prototype.add=function(e){return this.promise=this.promise.catch(function(){}).then(function(){return e()}),this.promise},C.prototype.finish=function(){return this.promise};var j={},B=new C;function I(e){return-1===e.indexOf(\"/\")?[e,e]:e.split(\"/\")}function T(e,t){try{e.emit(\"error\",t)}catch(e){w.guardedConsole(\"error\",\"The user's map/reduce function threw an uncaught error.\\nYou can debug this error by doing:\\nmyDatabase.on('error', function (err) { debugger; });\\nPlease double-check your map/reduce function.\"),w.guardedConsole(\"error\",t)}}t.exports=function(s,t,p,u){function h(t,e,n){try{e(n)}catch(e){T(t,e)}}function v(t,e,n,r,i){try{return{output:e(n,r,i)}}catch(e){return T(t,e),{error:e}}}function d(e,t){var n=E.collate(e.key,t.key);return 0!==n?n:E.collate(e.value,t.value)}function g(e){var t=e.value;return t&&\"object\"==typeof t&&t._id||e.id}function f(t){return function(e){return t.include_docs&&t.attachments&&t.binary&&function(e){e.rows.forEach(function(e){var n=e.doc&&e.doc._attachments;n&&Object.keys(n).forEach(function(e){var t=n[e];n[e].data=i.base64StringToBlobOrBuffer(t.data,t.content_type)})})}(e),e}}function l(e,t,n,r){var i=t[e];void 0!==i&&(r&&(i=encodeURIComponent(JSON.stringify(i))),n.push(e+\"=\"+i))}function o(e){if(void 0!==e){var t=Number(e);return isNaN(t)||t!==parseInt(e,10)?e:t}}function c(n,e){var t=n.descending?\"endkey\":\"startkey\",r=n.descending?\"startkey\":\"endkey\";if(void 0!==n[t]&&void 0!==n[r]&&0<E.collate(n[t],n[r]))throw new O.QueryParseError(\"No rows can match your key range, reverse your start_key and end_key or set {descending : true}\");if(e.reduce&&!1!==n.reduce){if(n.include_docs)throw new O.QueryParseError(\"{include_docs:true} is invalid for reduce\");if(n.keys&&1<n.keys.length&&!n.group&&!n.group_level)throw new O.QueryParseError(\"Multi-key fetches for reduce views must use {group: true}\")}[\"group_level\",\"limit\",\"skip\"].forEach(function(e){var t=function(e){if(e){if(\"number\"!=typeof e)return new O.QueryParseError('Invalid value for integer: \"'+e+'\"');if(e<0)return new O.QueryParseError('Invalid value for positive integer: \"'+e+'\"')}}(n[e]);if(t)throw t})}function y(t){return function(e){if(404===e.status)return t;throw e}}function _(e,n,t){var r=\"_local/doc_\"+e,i={_id:r,keys:[]},o=t.get(e),c=o[0];return(function(e){return 1===e.length&&/^1-/.test(e[0].rev)}(o[1])?Promise.resolve(i):n.db.get(r).catch(y(i))).then(function(t){return function(e){return e.keys.length?n.db.allDocs({keys:e.keys,include_docs:!0}):Promise.resolve({rows:[]})}(t).then(function(e){return function(e,t){for(var r=[],i=new k.Set,n=0,o=t.rows.length;n<o;n++){var a=t.rows[n].doc;if(a&&(r.push(a),i.add(a._id),a._deleted=!c.has(a._id),!a._deleted)){var s=c.get(a._id);\"value\"in s&&(a.value=s.value)}}var u=O.mapToKeysArray(c);return u.forEach(function(e){if(!i.has(e)){var t={_id:e},n=c.get(e);\"value\"in n&&(t.value=n.value),r.push(t)}}),e.keys=O.uniq(u.concat(e.keys)),r.push(e),r}(t,e)})})}function r(e){var t=\"string\"==typeof e?e:e.name,n=j[t];return n=n||(j[t]=new C)}function m(e){return O.sequentialize(r(e),function(){return function(a){var s,u;var c=t(a.mapFun,function(e,t){var n={id:u._id,key:E.normalizeKey(e)};null!=t&&(n.value=E.normalizeKey(t)),s.push(n)}),f=a.seq||0;function r(e,t){return function(){return function(r,t,i){var e=\"_local/lastSeq\";return r.db.get(e).catch(y({_id:e,seq:0})).then(function(n){var e=O.mapToKeysArray(t);return Promise.all(e.map(function(e){return _(e,r,t)})).then(function(e){var t=w.flatten(e);return n.seq=i,t.push(n),r.db.bulkDocs({docs:t})})})}(a,e,t)}}var i=new C;function o(){return a.sourceDB.changes({return_docs:!0,conflicts:!0,include_docs:!0,style:\"all_docs\",since:f,limit:50}).then(e)}function e(e){var t=e.results;if(t.length){var n=function(e){for(var t=new k.Map,n=0,r=e.length;n<r;n++){var i=e[n];if(\"_\"!==i.doc._id[0]){s=[],(u=i.doc)._deleted||h(a.sourceDB,c,u),s.sort(d);var o=l(s);t.set(i.doc._id,[o,i.changes])}f=i.seq}return t}(t);if(i.add(r(n,f)),!(t.length<50))return o()}}function l(e){for(var t,n=new k.Map,r=0,i=e.length;r<i;r++){var o=e[r],a=[o.key,o.id];0<r&&0===E.collate(o.key,t)&&a.push(r),n.set(E.toIndexableString(a),o),t=o.key}return n}return o().then(function(){return i.finish()}).then(function(){a.seq=f})}(e)})()}function b(e,t){return O.sequentialize(r(e),function(){return function(r,i){var o,a=r.reduceFun&&!1!==i.reduce,s=i.skip||0;void 0===i.keys||i.keys.length||(i.limit=0,delete i.keys);function n(e){return e.include_docs=!0,r.db.allDocs(e).then(function(e){return o=e.total_rows,e.rows.map(function(e){if(\"value\"in e.doc&&\"object\"==typeof e.doc.value&&null!==e.doc.value){var t=Object.keys(e.doc.value).sort(),n=[\"id\",\"key\",\"value\"];if(!(t<n||n<t))return e.doc.value}var r=E.parseIndexableString(e.doc._id);return{key:r[0],id:r[1],value:\"value\"in e.doc?e.doc.value:null}})})}function e(t){var n;if(n=a?function(e,t,n){0===n.group_level&&delete n.group_level;var r=n.group||n.group_level,i=p(e.reduceFun),o=[],a=isNaN(n.group_level)?Number.POSITIVE_INFINITY:n.group_level;t.forEach(function(e){var t=o[o.length-1],n=r?e.key:null;if(r&&Array.isArray(n)&&(n=n.slice(0,a)),t&&0===E.collate(t.groupKey,n))return t.keys.push([e.key,e.id]),void t.values.push(e.value);o.push({keys:[[e.key,e.id]],values:[e.value],groupKey:n})}),t=[];for(var s=0,u=o.length;s<u;s++){var c=o[s],f=v(e.sourceDB,i,c.keys,c.values,!1);if(f.error&&f.error instanceof O.BuiltInError)throw f.error;t.push({value:f.error?null:f.output,key:c.groupKey})}return{rows:function(e,t,n){return n=n||0,\"number\"==typeof t?e.slice(n,t+n):0<n?e.slice(n):e}(t,n.limit,n.skip)}}(r,t,i):{total_rows:o,offset:s,rows:t},i.update_seq&&(n.update_seq=r.seq),i.include_docs){var e=O.uniq(t.map(g));return r.sourceDB.allDocs({keys:e,include_docs:!0,conflicts:i.conflicts,attachments:i.attachments,binary:i.binary}).then(function(e){var r=new k.Map;return e.rows.forEach(function(e){r.set(e.id,e.doc)}),t.forEach(function(e){var t=g(e),n=r.get(t);n&&(e.doc=n)}),n})}return n}{if(void 0!==i.keys){var t=i.keys.map(function(e){var t={startkey:E.toIndexableString([e]),endkey:E.toIndexableString([e,{}])};return i.update_seq&&(t.update_seq=!0),n(t)});return Promise.all(t).then(w.flatten).then(e)}var u,c,f={descending:i.descending};if(i.update_seq&&(f.update_seq=!0),\"start_key\"in i&&(u=i.start_key),\"startkey\"in i&&(u=i.startkey),\"end_key\"in i&&(c=i.end_key),\"endkey\"in i&&(c=i.endkey),void 0!==u&&(f.startkey=i.descending?E.toIndexableString([u,{}]):E.toIndexableString([u])),void 0!==c){var l=!1!==i.inclusive_end;i.descending&&(l=!l),f.endkey=E.toIndexableString(l?[c,{}]:[c])}if(void 0!==i.key){var h=E.toIndexableString([i.key]),d=E.toIndexableString([i.key,{}]);f.descending?(f.endkey=h,f.startkey=d):(f.startkey=h,f.endkey=d)}return a||(\"number\"==typeof i.limit&&(f.limit=i.limit),f.skip=s),n(f).then(e)}}(e,t)})()}function a(n,e,r){if(\"function\"==typeof n._query)return function(e,t,i){return new Promise(function(n,r){e._query(t,i,function(e,t){if(e)return r(e);n(t)})})}(n,e,r);if(w.isRemote(n))return function(e,t,n){var r,i,o,a=[],s=\"GET\";if(l(\"reduce\",n,a),l(\"include_docs\",n,a),l(\"attachments\",n,a),l(\"limit\",n,a),l(\"descending\",n,a),l(\"group\",n,a),l(\"group_level\",n,a),l(\"skip\",n,a),l(\"stale\",n,a),l(\"conflicts\",n,a),l(\"startkey\",n,a,!0),l(\"start_key\",n,a,!0),l(\"endkey\",n,a,!0),l(\"end_key\",n,a,!0),l(\"inclusive_end\",n,a),l(\"key\",n,a,!0),l(\"update_seq\",n,a),a=\"\"===(a=a.join(\"&\"))?\"\":\"?\"+a,void 0!==n.keys){var u=\"keys=\"+encodeURIComponent(JSON.stringify(n.keys));u.length+a.length+1<=2e3?a+=(\"?\"===a[0]?\"&\":\"?\")+u:(s=\"POST\",\"string\"==typeof t?r={keys:n.keys}:t.keys=n.keys)}if(\"string\"!=typeof t)return r=r||{},Object.keys(t).forEach(function(e){Array.isArray(t[e])?r[e]=t[e]:r[e]=t[e].toString()}),e.fetch(\"_temp_view\"+a,{headers:new x.Headers({\"Content-Type\":\"application/json\"}),method:\"POST\",body:JSON.stringify(r)}).then(function(e){return i=e.ok,o=e.status,e.json()}).then(function(e){if(!i)throw e.status=o,S.generateErrorFromResponse(e);return e}).then(f(n));var c=I(t);return e.fetch(\"_design/\"+c[0]+\"/_view/\"+c[1]+a,{headers:new x.Headers({\"Content-Type\":\"application/json\"}),method:s,body:JSON.stringify(r)}).then(function(e){return i=e.ok,o=e.status,e.json()}).then(function(e){if(!i)throw e.status=o,S.generateErrorFromResponse(e);return e.rows.forEach(function(e){if(e.value&&e.value.error&&\"builtin_reduce_error\"===e.value.error)throw new Error(e.reason)}),e}).then(f(n))}(n,e,r);if(\"string\"!=typeof e)return c(r,e),B.add(function(){return A(n,\"temp_view/temp_view\",e.map,e.reduce,!0,s).then(function(e){return O.fin(m(e).then(function(){return b(e,r)}),function(){return e.db.destroy()})})}),B.finish();var i=e,t=I(i),o=t[0],a=t[1];return n.get(\"_design/\"+o).then(function(e){var t=e.views&&e.views[a];if(!t)throw new O.NotFoundError(\"ddoc \"+e._id+\" has no view named \"+a);return u(e,a),c(r,t),A(n,i,t.map,t.reduce,!1,s).then(function(e){return\"ok\"===r.stale||\"update_after\"===r.stale?(\"update_after\"===r.stale&&w.nextTick(function(){m(e)}),b(e,r)):m(e).then(function(){return b(e,r)})})})}return{query:function(e,t,n){var r=this;\"function\"==typeof t&&(n=t,t={}),t=t?function(e){return e.group_level=o(e.group_level),e.limit=o(e.limit),e.skip=o(e.skip),e}(t):{},\"function\"==typeof e&&(e={map:e});var i=Promise.resolve().then(function(){return a(r,e,t)});return O.promisedCallback(i,n),i},viewCleanup:O.callbackify(function(){var e=this;return\"function\"==typeof e._viewCleanup?function(e){return new Promise(function(n,r){e._viewCleanup(function(e,t){if(e)return r(e);n(t)})})}(e):w.isRemote(e)?function(e){return e.fetch(\"_view_cleanup\",{headers:new x.Headers({\"Content-Type\":\"application/json\"}),method:\"POST\"}).then(function(e){return e.json()})}(e):function(n){return n.get(\"_local/\"+s).then(function(s){var u=new k.Map;Object.keys(s.views).forEach(function(e){var t=I(e),n=\"_design/\"+t[0],r=t[1],i=u.get(n);i||(i=new k.Set,u.set(n,i)),i.add(r)});var e={keys:O.mapToKeysArray(u),include_docs:!0};return n.allDocs(e).then(function(e){var a={};e.rows.forEach(function(i){var o=i.key.substring(8);u.get(i.key).forEach(function(e){var t=o+\"/\"+e;s.views[t]||(t=e);var n=Object.keys(s.views[t]),r=i.doc&&i.doc.views&&i.doc.views[e];n.forEach(function(e){a[e]=a[e]||r})})});var t=Object.keys(a).filter(function(e){return!a[e]}).map(function(e){return O.sequentialize(r(e),function(){return new n.constructor(e,n.__opts).destroy()})()});return Promise.all(t).then(function(){return{ok:!0}})})},y({ok:!0}))}(e)})}}},{65:65,68:68,69:69,72:72,74:74,77:77,80:80,85:85}],60:[function(n,r,e){(function(u){\"use strict\";var e,f=n(72),m=n(85),b=n(74),o=(e=n(12))&&\"object\"==typeof e&&\"default\"in e?e.default:e,l=n(65);var w=25,h=50,k=5e3,E=1e4,d={};function S(e){var n=(e.doc||e.ok)._attachments;n&&Object.keys(n).forEach(function(e){var t=n[e];t.data=l.base64StringToBlobOrBuffer(t.data,t.content_type)})}function p(e){return/^_design/.test(e)?\"_design/\"+encodeURIComponent(e.slice(8)):/^_local/.test(e)?\"_local/\"+encodeURIComponent(e.slice(7)):encodeURIComponent(e)}function v(n){return n._attachments&&Object.keys(n._attachments)?Promise.all(Object.keys(n._attachments).map(function(e){var t=n._attachments[e];if(t.data&&\"string\"!=typeof t.data)return new Promise(function(e){l.blobOrBufferToBase64(t.data,e)}).then(function(e){t.data=e})})):Promise.resolve()}function x(e,t){if(function(e){if(!e.prefix)return!1;var t=m.parseUri(e.prefix).protocol;return\"http\"===t||\"https\"===t}(t)){var n=t.name.substr(t.prefix.length);e=t.prefix.replace(/\\/?$/,\"/\")+encodeURIComponent(n)}var r=m.parseUri(e);(r.user||r.password)&&(r.auth={username:r.user,password:r.password});var i=r.path.replace(/(^\\/|\\/$)/g,\"\").split(\"/\");return r.db=i.pop(),-1===r.db.indexOf(\"%\")&&(r.db=encodeURIComponent(r.db)),r.path=i.join(\"/\"),r}function O(e,t){return C(e,e.db+\"/\"+t)}function C(e,t){var n=e.path?\"/\":\"\";return e.protocol+\"://\"+e.host+(e.port?\":\"+e.port:\"\")+\"/\"+e.path+n+t}function A(t){return\"?\"+Object.keys(t).map(function(e){return e+\"=\"+encodeURIComponent(t[e])}).join(\"&\")}function t(a,e){var t=this,g=x(a.name,a),n=O(g,\"\");a=m.clone(a);var r,s=function(e,t){if((t=t||{}).headers=t.headers||new b.Headers,a.auth||g.auth){var n=a.auth||g.auth,r=n.username+\":\"+n.password,i=l.btoa(unescape(encodeURIComponent(r)));t.headers.set(\"Authorization\",\"Basic \"+i)}var o=a.headers||{};return Object.keys(o).forEach(function(e){t.headers.append(e,o[e])}),function(e){var t=\"undefined\"!=typeof navigator&&navigator.userAgent?navigator.userAgent.toLowerCase():\"\",n=-1!==t.indexOf(\"msie\"),r=-1!==t.indexOf(\"trident\"),i=-1!==t.indexOf(\"edge\"),o=!(\"method\"in e)||\"GET\"===e.method;return(n||r||i)&&o}(t)&&(e+=(-1===e.indexOf(\"?\")?\"?\":\"&\")+\"_nonce=\"+Date.now()),(a.fetch||b.fetch)(e,t)};function i(e,n){return m.adapterFun(e,o(function(t){_().then(function(){return n.apply(this,t)}).catch(function(e){t.pop()(e)})})).bind(t)}function y(e,t,n){var r={};return(t=t||{}).headers=t.headers||new b.Headers,t.headers.get(\"Content-Type\")||t.headers.set(\"Content-Type\",\"application/json\"),t.headers.get(\"Accept\")||t.headers.set(\"Accept\",\"application/json\"),s(e,t).then(function(e){return r.ok=e.ok,r.status=e.status,e.json()}).then(function(e){if(r.data=e,!r.ok){r.data.status=r.status;var t=f.generateErrorFromResponse(r.data);if(n)return n(t);throw t}if(Array.isArray(r.data)&&(r.data=r.data.map(function(e){return e.error||e.missing?f.generateErrorFromResponse(e):e})),!n)return r;n(null,r.data)})}function _(){return a.skip_setup?Promise.resolve():r||((r=y(n).catch(function(e){return e&&e.status&&404===e.status?(m.explainError(404,\"PouchDB is just detecting if the remote exists.\"),y(n,{method:\"PUT\"})):Promise.reject(e)}).catch(function(e){return!(!e||!e.status||412!==e.status)||Promise.reject(e)})).catch(function(){r=null}),r)}function c(e){return e.split(\"/\").map(encodeURIComponent).join(\"/\")}m.nextTick(function(){e(null,t)}),t._remote=!0,t.type=function(){return\"http\"},t.id=i(\"id\",function(n){s(C(g,\"\")).then(function(e){return e.json()}).then(function(e){var t=e&&e.uuid?e.uuid+g.db:O(g,\"\");n(null,t)}).catch(function(e){n(e)})}),t.compact=i(\"compact\",function(r,i){\"function\"==typeof r&&(i=r,r={}),r=m.clone(r),y(O(g,\"_compact\"),{method:\"POST\"}).then(function(){!function n(){t.info(function(e,t){t&&!t.compact_running?i(null,{ok:!0}):setTimeout(n,r.interval||200)})}()})}),t.bulkGet=m.adapterFun(\"bulkGet\",function(s,u){var c=this;function e(t){var e={};s.revs&&(e.revs=!0),s.attachments&&(e.attachments=!0),s.latest&&(e.latest=!0),y(O(g,\"_bulk_get\"+A(e)),{method:\"POST\",body:JSON.stringify({docs:s.docs})}).then(function(e){s.attachments&&s.binary&&e.data.results.forEach(function(e){e.docs.forEach(S)}),t(null,e.data)}).catch(t)}function n(){var e=h,r=Math.ceil(s.docs.length/e),i=0,o=new Array(r);function t(n){return function(e,t){o[n]=t.results,++i===r&&u(null,{results:m.flatten(o)})}}for(var n=0;n<r;n++){var a=m.pick(s,[\"revs\",\"attachments\",\"binary\",\"latest\"]);a.docs=s.docs.slice(n*e,Math.min(s.docs.length,(n+1)*e)),m.bulkGetShim(c,a,t(n))}}var r=C(g,\"\"),t=d[r];\"boolean\"!=typeof t?e(function(e,t){e?(d[r]=!1,m.explainError(e.status,\"PouchDB is just detecting if the remote supports the _bulk_get API.\"),n()):(d[r]=!0,u(null,t))}):t?e(u):n()}),t._info=function(t){_().then(function(){return s(O(g,\"\"))}).then(function(e){return e.json()}).then(function(e){e.host=O(g,\"\"),t(null,e)}).catch(t)},t.fetch=function(e,t){return _().then(function(){return s(O(g,e),t)})},t.get=i(\"get\",function(t,o,n){\"function\"==typeof o&&(n=o,o={});var e={};function r(r){var i=r._attachments,e=i&&Object.keys(i);if(i&&e.length)return function(l,h){return new Promise(function(e,t){var n,r=0,i=0,o=0,a=l.length;function s(){++o===a?n?t(n):e():f()}function u(){r--,s()}function c(e){r--,n=n||e,s()}function f(){for(;r<h&&i<a;)r++,l[i++]().then(u,c)}f()})}(e.map(function(e){return function(){return function(e){var n=i[e],t=p(r._id)+\"/\"+c(e)+\"?rev=\"+r._rev;return s(O(g,t)).then(function(e){return void 0===u||u.browser?e.blob():e.buffer()}).then(function(t){return o.binary?(void 0===u||u.browser||(t.type=n.content_type),t):new Promise(function(e){l.blobOrBufferToBase64(t,e)})}).then(function(e){delete n.stub,delete n.length,n.data=e})}(e)}}),5)}(o=m.clone(o)).revs&&(e.revs=!0),o.revs_info&&(e.revs_info=!0),o.latest&&(e.latest=!0),o.open_revs&&(\"all\"!==o.open_revs&&(o.open_revs=JSON.stringify(o.open_revs)),e.open_revs=o.open_revs),o.rev&&(e.rev=o.rev),o.conflicts&&(e.conflicts=o.conflicts),o.update_seq&&(e.update_seq=o.update_seq),t=p(t),y(O(g,t+A(e))).then(function(e){return Promise.resolve().then(function(){if(o.attachments)return function(e){return Array.isArray(e)?Promise.all(e.map(function(e){if(e.ok)return r(e.ok)})):r(e)}(e.data)}).then(function(){n(null,e.data)})}).catch(function(e){e.docId=t,n(e)})}),t.remove=i(\"remove\",function(e,t,n,r){var i;\"string\"==typeof t?(i={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(i=e,n=\"function\"==typeof t?(r=t,{}):(r=n,t));var o=i._rev||n.rev;y(O(g,p(i._id))+\"?rev=\"+o,{method:\"DELETE\"},r).catch(r)}),t.getAttachment=i(\"getAttachment\",function(e,t,n,r){\"function\"==typeof n&&(r=n,n={});var i,o=n.rev?\"?rev=\"+n.rev:\"\",a=O(g,p(e))+\"/\"+c(t)+o;s(a,{method:\"GET\"}).then(function(e){if(i=e.headers.get(\"content-type\"),e.ok)return void 0===u||u.browser?e.blob():e.buffer();throw e}).then(function(e){void 0===u||u.browser||(e.type=i),r(null,e)}).catch(function(e){r(e)})}),t.removeAttachment=i(\"removeAttachment\",function(e,t,n,r){y(O(g,p(e)+\"/\"+c(t))+\"?rev=\"+n,{method:\"DELETE\"},r).catch(r)}),t.putAttachment=i(\"putAttachment\",function(e,t,n,r,i,o){\"function\"==typeof i&&(o=i,i=r,r=n,n=null);var a=p(e)+\"/\"+c(t),s=O(g,a);if(n&&(s+=\"?rev=\"+n),\"string\"==typeof r){var u;try{u=l.atob(r)}catch(e){return o(f.createError(f.BAD_ARG,\"Attachment is not a valid base64 string\"))}r=u?l.binaryStringToBlobOrBuffer(u,i):\"\"}y(s,{headers:new b.Headers({\"Content-Type\":i}),method:\"PUT\",body:r},o).catch(o)}),t._bulkDocs=function(e,t,n){e.new_edits=t.new_edits,_().then(function(){return Promise.all(e.docs.map(v))}).then(function(){return y(O(g,\"_bulk_docs\"),{method:\"POST\",body:JSON.stringify(e)},n)}).catch(n)},t._put=function(t,e,n){_().then(function(){return v(t)}).then(function(){return y(O(g,p(t._id)),{method:\"PUT\",body:JSON.stringify(t)})}).then(function(e){n(null,e.data)}).catch(function(e){e.docId=t&&t._id,n(e)})},t.allDocs=i(\"allDocs\",function(t,n){\"function\"==typeof t&&(n=t,t={});var e,r={},i=\"GET\";(t=m.clone(t)).conflicts&&(r.conflicts=!0),t.update_seq&&(r.update_seq=!0),t.descending&&(r.descending=!0),t.include_docs&&(r.include_docs=!0),t.attachments&&(r.attachments=!0),t.key&&(r.key=JSON.stringify(t.key)),t.start_key&&(t.startkey=t.start_key),t.startkey&&(r.startkey=JSON.stringify(t.startkey)),t.end_key&&(t.endkey=t.end_key),t.endkey&&(r.endkey=JSON.stringify(t.endkey)),void 0!==t.inclusive_end&&(r.inclusive_end=!!t.inclusive_end),void 0!==t.limit&&(r.limit=t.limit),void 0!==t.skip&&(r.skip=t.skip);var o=A(r);void 0!==t.keys&&(i=\"POST\",e={keys:t.keys}),y(O(g,\"_all_docs\"+o),{method:i,body:JSON.stringify(e)}).then(function(e){t.include_docs&&t.attachments&&t.binary&&e.data.rows.forEach(S),n(null,e.data)}).catch(n)}),t._changes=function(a){var s=\"batch_size\"in a?a.batch_size:w;!(a=m.clone(a)).continuous||\"heartbeat\"in a||(a.heartbeat=E);var e=\"timeout\"in a?a.timeout:3e4;\"timeout\"in a&&a.timeout&&e-a.timeout<k&&(e=a.timeout+k),\"heartbeat\"in a&&a.heartbeat&&e-a.heartbeat<k&&(e=a.heartbeat+k);var i={};\"timeout\"in a&&a.timeout&&(i.timeout=a.timeout);var u=void 0!==a.limit&&a.limit,c=u;if(a.style&&(i.style=a.style),(a.include_docs||a.filter&&\"function\"==typeof a.filter)&&(i.include_docs=!0),a.attachments&&(i.attachments=!0),a.continuous&&(i.feed=\"longpoll\"),a.seq_interval&&(i.seq_interval=a.seq_interval),a.conflicts&&(i.conflicts=!0),a.descending&&(i.descending=!0),a.update_seq&&(i.update_seq=!0),\"heartbeat\"in a&&a.heartbeat&&(i.heartbeat=a.heartbeat),a.filter&&\"string\"==typeof a.filter&&(i.filter=a.filter),a.view&&\"string\"==typeof a.view&&(i.filter=\"_view\",i.view=a.view),a.query_params&&\"object\"==typeof a.query_params)for(var t in a.query_params)a.query_params.hasOwnProperty(t)&&(i[t]=a.query_params[t]);var o,f=\"GET\";a.doc_ids?(i.filter=\"_doc_ids\",f=\"POST\",o={doc_ids:a.doc_ids}):a.selector&&(i.filter=\"_selector\",f=\"POST\",o={selector:a.selector});function l(e,t){if(!a.aborted){i.since=e,\"object\"==typeof i.since&&(i.since=JSON.stringify(i.since)),a.descending?u&&(i.limit=c):i.limit=!u||s<c?s:c;var n=O(g,\"_changes\"+A(i)),r={signal:d.signal,method:f,body:JSON.stringify(o)};h=e,a.aborted||_().then(function(){return y(n,r,t)}).catch(t)}}var h,d=new b.AbortController,p={results:[]},v=function(e,t){if(!a.aborted){var n=0;if(t&&t.results){n=t.results.length,p.last_seq=t.last_seq;var r=null,i=null;\"number\"==typeof t.pending&&(r=t.pending),\"string\"!=typeof p.last_seq&&\"number\"!=typeof p.last_seq||(i=p.last_seq);a.query_params,t.results=t.results.filter(function(e){c--;var t=m.filterChange(a)(e);return t&&(a.include_docs&&a.attachments&&a.binary&&S(e),a.return_docs&&p.results.push(e),a.onChange(e,r,i)),t})}else if(e)return a.aborted=!0,void a.complete(e);t&&t.last_seq&&(h=t.last_seq);var o=u&&c<=0||t&&n<s||a.descending;(!a.continuous||u&&c<=0)&&o?a.complete(null,p):m.nextTick(function(){l(h,v)})}};return l(a.since||0,v),{cancel:function(){a.aborted=!0,d.abort()}}},t.revsDiff=i(\"revsDiff\",function(e,t,n){\"function\"==typeof t&&(n=t,t={}),y(O(g,\"_revs_diff\"),{method:\"POST\",body:JSON.stringify(e)},n).catch(n)}),t._close=function(e){e()},t._destroy=function(e,t){y(O(g,\"\"),{method:\"DELETE\"}).then(function(e){t(null,e)}).catch(function(e){404===e.status?t(null,{ok:!0}):t(e)})}}t.valid=function(){return!0},r.exports=function(e){e.adapter(\"http\",t,!1),e.adapter(\"https\",t,!1)}}).call(this,n(88))},{12:12,65:65,72:72,74:74,85:85,88:88}],61:[function(e,t,n){\"use strict\";var b=e(85),j=e(72),r=e(76),d=e(65),B=e(69),I=e(64),T=e(81),i=5,R=\"document-store\",q=\"by-sequence\",D=\"attach-store\",L=\"attach-seq-store\",N=\"meta-store\",M=\"local-store\",p=\"detect-blob-support\";function P(n){return function(e){var t=\"unknown_error\";e.target&&e.target.error&&(t=e.target.error.name||e.target.error.message),n(j.createError(j.IDB_ERROR,t,e.type))}}function F(e,t,n){return{data:r.safeJsonStringify(e),winningRev:t,deletedOrLocal:n?\"1\":\"0\",seq:e.seq,id:e.id}}function U(e){if(!e)return null;var t=r.safeJsonParse(e.data);return t.winningRev=e.winningRev,t.deleted=\"1\"===e.deletedOrLocal,t.seq=e.seq,t}function C(e){if(!e)return e;var t=e._doc_id_rev.lastIndexOf(\":\");return e._id=e._doc_id_rev.substring(0,t-1),e._rev=e._doc_id_rev.substring(t+1),delete e._doc_id_rev,e}function v(e,t,n,r){n?r(e?\"string\"!=typeof e?e:d.base64StringToBlobOrBuffer(e,t):d.blob([\"\"],{type:t})):e?\"string\"!=typeof e?d.readAsBinaryString(e,function(e){r(d.btoa(e))}):r(e):r(\"\")}function A(t,n,i,e){var r=Object.keys(t._attachments||{});if(!r.length)return e&&e();var o=0;function a(){++o===r.length&&e&&e()}r.forEach(function(e){n.attachments&&n.include_docs?function(e,t){var n=e._attachments[t],r=n.digest;i.objectStore(D).get(r).onsuccess=function(e){n.body=e.target.result.body,a()}}(t,e):(t._attachments[e].stub=!0,a())})}function $(e,a){return Promise.all(e.map(function(o){if(o.doc&&o.doc._attachments){var e=Object.keys(o.doc._attachments);return Promise.all(e.map(function(n){var r=o.doc._attachments[n];if(\"body\"in r){var e=r.body,i=r.content_type;return new Promise(function(t){v(e,i,a,function(e){o.doc._attachments[n]=b.assign(b.pick(r,[\"digest\",\"content_type\"]),{data:e}),t()})})}}))}}))}function z(e,r,t){var i=[],o=t.objectStore(q),n=t.objectStore(D),a=t.objectStore(L),s=e.length;function u(){--s||function(){if(!i.length)return;i.forEach(function(t){a.index(\"digestSeq\").count(IDBKeyRange.bound(t+\"::\",t+\"::￿\",!1,!1)).onsuccess=function(e){e.target.result||n.delete(t)}})}()}e.forEach(function(e){var t=o.index(\"_doc_id_rev\"),n=r+\"::\"+e;t.getKey(n).onsuccess=function(e){var t=e.target.result;if(\"number\"!=typeof t)return u();o.delete(t),a.index(\"seq\").openCursor(IDBKeyRange.only(t)).onsuccess=function(e){var t=e.target.result;if(t){var n=t.value.digestSeq.split(\"::\")[0];i.push(n),a.delete(t.primaryKey),t.continue()}else u()}}})}function K(e,t,n){try{return{txn:e.transaction(t,n)}}catch(e){return{error:e}}}var W=new b.changesHandler;function g(a,e,s,l,t,n){for(var h,d,p,v,g,r,i,o,u=e.docs,c=0,f=u.length;c<f;c++){var y=u[c];y._id&&I.isLocalId(y._id)||(y=u[c]=I.parseDoc(y,s.new_edits,a)).error&&!i&&(i=y)}if(i)return n(i);var _=!1,m=0,b=new Array(u.length),w=new B.Map,k=!1,E=l._meta.blobSupport?\"blob\":\"base64\";function S(){_=!0,x()}function x(){o&&_&&(o.docCount+=m,r.put(o))}function O(){k||(W.notify(l._meta.name),n(null,b))}function C(e,t,n,r,i,o,a,s){e.metadata.winningRev=t,e.metadata.deleted=n;var u=e.data;if(u._id=e.metadata.id,u._rev=e.metadata.rev,r&&(u._deleted=!0),u._attachments&&Object.keys(u._attachments).length)return function(r,i,e,t,n,o){var a=r.data,s=0,u=Object.keys(a._attachments);function c(){s===u.length&&A(r,i,e,t,n,o)}function f(){s++,c()}u.forEach(function(e){var t=r.data._attachments[e];if(t.stub)s++,c();else{var n=t.data;delete t.data,t.revpos=parseInt(i,10),function(n,r,i){v.count(n).onsuccess=function(e){if(e.target.result)return i();var t={digest:n,body:r};v.put(t).onsuccess=i}}(t.digest,n,f)}})}(e,t,n,i,a,s);m+=o,x(),A(e,t,n,i,a,s)}function A(r,i,o,a,e,t){var n=r.data,s=r.metadata;function u(e){var t=r.stemmedRevs||[];a&&l.auto_compaction&&(t=t.concat(T.compactTree(r.metadata))),t&&t.length&&z(t,r.metadata.id,h),s.seq=e.target.result;var n=F(s,i,o);d.put(n).onsuccess=c}function c(){b[e]={ok:!0,id:s.id,rev:s.rev},w.set(r.metadata.id,r.metadata),function(e,t,n){var r=0,i=Object.keys(e.data._attachments||{});if(!i.length)return n();function o(){++r===i.length&&n()}for(var a=0;a<i.length;a++)s=i[a],c=void 0,u=e.data._attachments[s].digest,(c=g.put({seq:t,digestSeq:u+\"::\"+t})).onsuccess=o,c.onerror=function(e){e.preventDefault(),e.stopPropagation(),o()};var s,u,c}(r,s.seq,t)}n._doc_id_rev=s.id+\"::\"+s.rev,delete n._id,delete n._rev;var f=p.put(n);f.onsuccess=u,f.onerror=function(e){e.preventDefault(),e.stopPropagation(),p.index(\"_doc_id_rev\").getKey(n._doc_id_rev).onsuccess=function(e){p.put(n,e.target.result).onsuccess=u}}}I.preprocessAttachments(u,E,function(e){if(e)return n(e);!function(){var e=K(t,[R,q,D,M,L,N],\"readwrite\");if(e.error)return n(e.error);(h=e.txn).onabort=P(n),h.ontimeout=P(n),h.oncomplete=O,d=h.objectStore(R),p=h.objectStore(q),v=h.objectStore(D),g=h.objectStore(L),(r=h.objectStore(N)).get(N).onsuccess=function(e){o=e.target.result,x()},function(t){var r=[];if(u.forEach(function(n){n.data&&n.data._attachments&&Object.keys(n.data._attachments).forEach(function(e){var t=n.data._attachments[e];t.stub&&r.push(t.digest)})}),!r.length)return t();var n,i=0;r.forEach(function(e){!function(n,r){v.get(n).onsuccess=function(e){if(e.target.result)r();else{var t=j.createError(j.MISSING_STUB,\"unknown stub attachment with digest \"+n);t.status=412,r(t)}}}(e,function(e){e&&!n&&(n=e),++i===r.length&&t(n)})})}(function(e){if(e)return k=!0,n(e);!function(){if(!u.length)return;var e=0;function n(){++e===u.length&&I.processDocs(a.revs_limit,u,l,w,h,b,C,s,S)}function t(e){var t=U(e.target.result);t&&w.set(t.id,t),n()}for(var r=0,i=u.length;r<i;r++){var o=u[r];if(o._id&&I.isLocalId(o._id))n();else d.get(o.metadata.id).onsuccess=t}}()})}()})}function V(n,r,e,i,o){var a,s,t;function u(e){s=e.target.result,a&&o(a,s,t)}function c(e){a=e.target.result,s&&o(a,s,t)}function f(e){var t=e.target.result;if(!t)return o();o([t.key],[t.value],t)}-1===i&&(i=1e3),\"function\"==typeof n.getAll&&\"function\"==typeof n.getAllKeys&&1<i&&!e?(t={continue:function(){if(!a.length)return o();var e,t=a[a.length-1];if(r&&r.upper)try{e=IDBKeyRange.bound(t,r.upper,!0,r.upperOpen)}catch(e){if(\"DataError\"===e.name&&0===e.code)return o()}else e=IDBKeyRange.lowerBound(t,!0);r=e,s=a=null,n.getAll(r,i).onsuccess=u,n.getAllKeys(r,i).onsuccess=c}},n.getAll(r,i).onsuccess=u,n.getAllKeys(r,i).onsuccess=c):e?n.openCursor(r,\"prev\").onsuccess=f:n.openCursor(r).onsuccess=f}function y(i,e,t){var n,r,o=\"startkey\"in i&&i.startkey,a=\"endkey\"in i&&i.endkey,s=\"key\"in i&&i.key,u=\"keys\"in i&&i.keys,c=i.skip||0,f=\"number\"==typeof i.limit?i.limit:-1,l=!1!==i.inclusive_end;if(!u&&(r=(n=function(e,t,n,r,i){try{if(e&&t)return i?IDBKeyRange.bound(t,e,!n,!1):IDBKeyRange.bound(e,t,!1,!n);if(e)return i?IDBKeyRange.upperBound(e):IDBKeyRange.lowerBound(e);if(t)return i?IDBKeyRange.lowerBound(t,!n):IDBKeyRange.upperBound(t,!n);if(r)return IDBKeyRange.only(r)}catch(e){return{error:e}}return null}(o,a,l,s,i.descending))&&n.error)&&(\"DataError\"!==r.name||0!==r.code))return t(j.createError(j.IDB_ERROR,r.name,r.message));var h=[R,q,N];i.attachments&&h.push(D);var d=K(e,h,\"readonly\");if(d.error)return t(d.error);var p=d.txn;p.oncomplete=function(){i.attachments?$(k,i.binary).then(O):O()},p.onabort=P(t);var v,g,y,_=p.objectStore(R),m=p.objectStore(q),b=p.objectStore(N),w=m.index(\"_doc_id_rev\"),k=[];function E(e,t){var n={id:t.id,key:t.id,value:{rev:e}};t.deleted?u&&(k.push(n),n.value.deleted=!0,n.doc=null):c--<=0&&(k.push(n),i.include_docs&&function(n,r,e){var t=n.id+\"::\"+e;w.get(t).onsuccess=function(e){if(r.doc=C(e.target.result)||{},i.conflicts){var t=T.collectConflicts(n);t.length&&(r.doc._conflicts=t)}A(r.doc,i,p)}}(t,n,e))}function S(e){for(var t=0,n=e.length;t<n&&k.length!==f;t++){var r=e[t];if(r.error&&u)k.push(r);else{var i=U(r);E(i.winningRev,i)}}}function x(e,t,n){n&&(S(t),k.length<f&&n.continue())}function O(){var e={total_rows:v,offset:i.skip,rows:k};i.update_seq&&void 0!==g&&(e.update_seq=g),t(null,e)}return b.get(N).onsuccess=function(e){v=e.target.result.docCount},i.update_seq&&(y=function(e){e.target.result&&0<e.target.result.length&&(g=e.target.result[0])},m.openCursor(null,\"prev\").onsuccess=function(e){var t=e.target.result,n=void 0;return t&&t.key&&(n=t.key),y({target:{result:[n]}})}),r||0===f?void 0:u?function(r,e,i){var o=new Array(r.length),a=0;r.forEach(function(t,n){e.get(t).onsuccess=function(e){e.target.result?o[n]=e.target.result:o[n]={key:t,error:\"not_found\"},++a===r.length&&i(r,o,{})}})}(i.keys,_,x):-1===f?function(e,t,n){if(\"function\"!=typeof e.getAll){var r=[];e.openCursor(t).onsuccess=function(e){var t=e.target.result;t?(r.push(t.value),t.continue()):n({target:{result:r}})}}else e.getAll(t).onsuccess=n}(_,n,function(e){var t=e.target.result;i.descending&&(t=t.reverse()),S(t)}):void V(_,n,i.descending,f+c,x)}var o=!1,a=[];function s(){!o&&a.length&&(o=!0,a.shift()())}function _(c,e,t,n){if((c=b.clone(c)).continuous){var r=t+\":\"+b.uuid();return W.addListener(t,r,e,c),W.notify(t),{cancel:function(){W.removeListener(t,r)}}}var f=c.doc_ids&&new B.Set(c.doc_ids);c.since=c.since||0;var l=c.since,h=\"limit\"in c?c.limit:-1;0===h&&(h=1);var d,i,p,o,v=[],g=0,y=b.filterChange(c),_=new B.Map;function m(e,t,n,r){if(n.seq!==t)return r();if(n.winningRev===e._rev)return r(n,e);var i=e._id+\"::\"+n.winningRev;o.get(i).onsuccess=function(e){r(n,C(e.target.result))}}function a(){c.complete(null,{results:v,last_seq:l})}var s=[R,q];c.attachments&&s.push(D);var u=K(n,s,\"readonly\");if(u.error)return c.complete(u.error);(d=u.txn).onabort=P(c.complete),d.oncomplete=function(){!c.continuous&&c.attachments?$(v).then(a):a()},i=d.objectStore(q),p=d.objectStore(R),o=i.index(\"_doc_id_rev\"),V(i,c.since&&!c.descending?IDBKeyRange.lowerBound(c.since,!0):null,c.descending,h,function(r,e,o){if(o&&r.length){var a=new Array(r.length),s=new Array(r.length),i=0;e.forEach(function(e,n){!function(t,n,r){if(f&&!f.has(t._id))return r();var i=_.get(t._id);if(i)return m(t,n,i,r);p.get(t._id).onsuccess=function(e){i=U(e.target.result),_.set(t._id,i),m(t,n,i,r)}}(C(e),r[n],function(e,t){s[n]=e,a[n]=t,++i===r.length&&function(){for(var e=[],t=0,n=a.length;t<n&&g!==h;t++){var r=a[t];if(r){var i=s[t];e.push(u(i,r))}}Promise.all(e).then(function(e){for(var t=0,n=e.length;t<n;t++)e[t]&&c.onChange(e[t])}).catch(c.complete),g!==h&&o.continue()}()})})}function u(e,t){var n=c.processChange(t,e,c);l=n.seq=e.seq;var r=y(n);return\"object\"==typeof r?Promise.reject(r):r?(g++,c.return_docs&&v.push(n),c.attachments&&c.include_docs?new Promise(function(e){A(t,c,d,function(){$([n],c.binary).then(function(){e(n)})})}):Promise.resolve(n)):Promise.resolve()}})}var m,w=new B.Map,k=new B.Map;function u(t,e){var n=this;!function(e,n,r){a.push(function(){e(function(e,t){!function(e,t,n,r){try{e(t,n)}catch(t){r.emit(\"error\",t)}}(n,e,t,r),o=!1,b.nextTick(function(){s()})})}),s()}(function(e){!function(c,r,f){var l=r.name,h=null;function o(e,i){var o=e.objectStore(R);o.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),o.openCursor().onsuccess=function(e){var t=e.target.result;if(t){var n=t.value,r=T.isDeleted(n);n.deletedOrLocal=r?\"1\":\"0\",o.put(n),t.continue()}else i()}}function a(e,h){var d=e.objectStore(M),p=e.objectStore(R),v=e.objectStore(q);p.openCursor().onsuccess=function(e){var n=e.target.result;if(n){var t=n.value,r=t.id,i=T.isLocalId(r),o=T.winningRev(t);if(i){var a=r+\"::\"+o,s=r+\"::\",u=r+\"::~\",c=v.index(\"_doc_id_rev\"),f=IDBKeyRange.bound(s,u,!1,!1),l=c.openCursor(f);l.onsuccess=function(e){if(l=e.target.result){var t=l.value;t._doc_id_rev===a&&d.put(t),v.delete(l.primaryKey),l.continue()}else p.delete(n.primaryKey),n.continue()}}else n.continue()}else h&&h()}}function s(e,c){var t=e.objectStore(q),n=e.objectStore(D),f=e.objectStore(L);n.count().onsuccess=function(e){if(!e.target.result)return c();t.openCursor().onsuccess=function(e){var t=e.target.result;if(!t)return c();for(var n=t.value,r=t.primaryKey,i=Object.keys(n._attachments||{}),o={},a=0;a<i.length;a++){o[n._attachments[i[a]].digest]=!0}var s=Object.keys(o);for(a=0;a<s.length;a++){var u=s[a];f.put({seq:r,digestSeq:u+\"::\"+r})}t.continue()}}}function u(e){var u=e.objectStore(q),c=e.objectStore(R);c.openCursor().onsuccess=function(e){var t=e.target.result;if(t){var n,r,i,o,a=function(e){return e.data?U(e):(e.deleted=\"1\"===e.deletedOrLocal,e)}(t.value);if(a.winningRev=a.winningRev||T.winningRev(a),a.seq)return s();n=a.id+\"::\",r=a.id+\"::￿\",i=u.index(\"_doc_id_rev\").openCursor(IDBKeyRange.bound(n,r)),o=0,i.onsuccess=function(e){var t=e.target.result;if(!t)return a.seq=o,s();var n=t.primaryKey;o<n&&(o=n),t.continue()}}function s(){var e=F(a,a.winningRev,a.deleted);c.put(e).onsuccess=function(){t.continue()}}}}c._meta=null,c._remote=!1,c.type=function(){return\"idb\"},c._id=b.toPromise(function(e){e(null,c._meta.instanceId)}),c._bulkDocs=function(e,t,n){g(r,e,t,c,h,n)},c._get=function(e,i,t){var o,a,s,u=i.ctx;if(!u){var n=K(h,[R,q,D],\"readonly\");if(n.error)return t(n.error);u=n.txn}function c(){t(s,{doc:o,metadata:a,ctx:u})}u.objectStore(R).get(e).onsuccess=function(e){if(!(a=U(e.target.result)))return s=j.createError(j.MISSING_DOC,\"missing\"),c();var t;if(i.rev)t=i.latest?T.latest(i.rev,a):i.rev;else if(t=a.winningRev,T.isDeleted(a))return s=j.createError(j.MISSING_DOC,\"deleted\"),c();var n=u.objectStore(q),r=a.id+\"::\"+t;n.index(\"_doc_id_rev\").get(r).onsuccess=function(e){if(!(o=(o=e.target.result)&&C(o)))return s=j.createError(j.MISSING_DOC,\"missing\"),c();c()}}},c._getAttachment=function(e,t,n,r,i){var o;if(r.ctx)o=r.ctx;else{var a=K(h,[R,q,D],\"readonly\");if(a.error)return i(a.error);o=a.txn}var s=n.digest,u=n.content_type;o.objectStore(D).get(s).onsuccess=function(e){v(e.target.result.body,u,r.binary,function(e){i(null,e)})}},c._info=function(e){var n,t,r=K(h,[N,q],\"readonly\");if(r.error)return e(r.error);var i=r.txn;i.objectStore(N).get(N).onsuccess=function(e){t=e.target.result.docCount},i.objectStore(q).openCursor(null,\"prev\").onsuccess=function(e){var t=e.target.result;n=t?t.key:0},i.oncomplete=function(){e(null,{doc_count:t,update_seq:n,idb_attachment_format:c._meta.blobSupport?\"binary\":\"base64\"})}},c._allDocs=function(e,t){y(e,h,t)},c._changes=function(e){return _(e,c,l,h)},c._close=function(e){h.close(),w.delete(l),e()},c._getRevisionTree=function(e,n){var t=K(h,[R],\"readonly\");if(t.error)return n(t.error);t.txn.objectStore(R).get(e).onsuccess=function(e){var t=U(e.target.result);t?n(null,t.rev_tree):n(j.createError(j.MISSING_DOC))}},c._doCompaction=function(i,a,e){var t=K(h,[R,q,D,L],\"readwrite\");if(t.error)return e(t.error);var o=t.txn;o.objectStore(R).get(i).onsuccess=function(e){var t=U(e.target.result);T.traverseRevTree(t.rev_tree,function(e,t,n,r,i){var o=t+\"-\"+n;-1!==a.indexOf(o)&&(i.status=\"missing\")}),z(a,i,o);var n=t.winningRev,r=t.deleted;o.objectStore(R).put(F(t,n,r))},o.onabort=P(e),o.oncomplete=function(){e()}},c._getLocal=function(e,n){var t=K(h,[M],\"readonly\");if(t.error)return n(t.error);var r=t.txn.objectStore(M).get(e);r.onerror=P(n),r.onsuccess=function(e){var t=e.target.result;t?(delete t._doc_id_rev,n(null,t)):n(j.createError(j.MISSING_DOC))}},c._putLocal=function(n,r,i){\"function\"==typeof r&&(i=r,r={}),delete n._revisions;var o=n._rev,e=n._id;n._rev=o?\"0-\"+(parseInt(o.split(\"-\")[1],10)+1):\"0-1\";var a,t=r.ctx;if(!t){var s=K(h,[M],\"readwrite\");if(s.error)return i(s.error);(t=s.txn).onerror=P(i),t.oncomplete=function(){a&&i(null,a)}}var u,c=t.objectStore(M);o?(u=c.get(e)).onsuccess=function(e){var t=e.target.result;t&&t._rev===o?c.put(n).onsuccess=function(){a={ok:!0,id:n._id,rev:n._rev},r.ctx&&i(null,a)}:i(j.createError(j.REV_CONFLICT))}:((u=c.add(n)).onerror=function(e){i(j.createError(j.REV_CONFLICT)),e.preventDefault(),e.stopPropagation()},u.onsuccess=function(){a={ok:!0,id:n._id,rev:n._rev},r.ctx&&i(null,a)})},c._removeLocal=function(n,r,i){\"function\"==typeof r&&(i=r,r={});var o,e=r.ctx;if(!e){var t=K(h,[M],\"readwrite\");if(t.error)return i(t.error);(e=t.txn).oncomplete=function(){o&&i(null,o)}}var a=n._id,s=e.objectStore(M),u=s.get(a);u.onerror=P(i),u.onsuccess=function(e){var t=e.target.result;t&&t._rev===n._rev?(s.delete(a),o={ok:!0,id:a,rev:\"0-0\"},r.ctx&&i(null,o)):i(j.createError(j.MISSING_DOC))}},c._destroy=function(e,t){W.removeAllListeners(l);var n=k.get(l);n&&n.result&&(n.result.close(),w.delete(l));var r=indexedDB.deleteDatabase(l);r.onsuccess=function(){k.delete(l),b.hasLocalStorage()&&l in localStorage&&delete localStorage[l],t(null,{ok:!0})},r.onerror=P(t)};var e=w.get(l);if(e)return h=e.idb,c._meta=e.global,b.nextTick(function(){f(null,c)});var t=indexedDB.open(l,i);k.set(l,t),t.onupgradeneeded=function(e){var t=e.target.result;if(e.oldVersion<1)return function(e){var t=e.createObjectStore(R,{keyPath:\"id\"});e.createObjectStore(q,{autoIncrement:!0}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0}),e.createObjectStore(D,{keyPath:\"digest\"}),e.createObjectStore(N,{keyPath:\"id\",autoIncrement:!1}),e.createObjectStore(p),t.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),e.createObjectStore(M,{keyPath:\"_id\"});var n=e.createObjectStore(L,{autoIncrement:!0});n.createIndex(\"seq\",\"seq\"),n.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}(t);var n=e.currentTarget.transaction;e.oldVersion<3&&function(e){e.createObjectStore(M,{keyPath:\"_id\"}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0})}(t),e.oldVersion<4&&function(e){var t=e.createObjectStore(L,{autoIncrement:!0});t.createIndex(\"seq\",\"seq\"),t.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}(t);var r=[o,a,s,u],i=e.oldVersion;!function e(){var t=r[i-1];i++,t&&t(n,e)}()},t.onsuccess=function(e){(h=e.target.result).onversionchange=function(){h.close(),w.delete(l)},h.onabort=function(e){b.guardedConsole(\"error\",\"Database has a global failure\",e.target.error),h.close(),w.delete(l)};var t,n,r,i,o=h.transaction([N,p,R],\"readwrite\"),a=!1;function s(){void 0!==r&&a&&(c._meta={name:l,instanceId:i,blobSupport:r},w.set(l,{idb:h,global:c._meta}),f(null,c))}function u(){if(void 0!==n&&void 0!==t){var e=l+\"_id\";e in t?i=t[e]:t[e]=i=b.uuid(),t.docCount=n,o.objectStore(N).put(t)}}o.objectStore(N).get(N).onsuccess=function(e){t=e.target.result||{id:N},u()},function(e,t){e.objectStore(R).index(\"deletedOrLocal\").count(IDBKeyRange.only(\"0\")).onsuccess=function(e){t(e.target.result)}}(o,function(e){n=e,u()}),(m=m||function(r){return new Promise(function(n){var e=d.blob([\"\"]),t=r.objectStore(p).put(e,\"key\");t.onsuccess=function(){var e=navigator.userAgent.match(/Chrome\\/(\\d+)/),t=navigator.userAgent.match(/Edge\\//);n(t||!e||43<=parseInt(e[1],10))},t.onerror=r.onabort=function(e){e.preventDefault(),e.stopPropagation(),n(!1)}}).catch(function(){return!1})}(o)).then(function(e){r=e,s()}),o.oncomplete=function(){a=!0,s()},o.onabort=P(f)},t.onerror=function(){var e=\"Failed to open indexedDB, are you in private browsing mode?\";b.guardedConsole(\"error\",e),f(j.createError(j.IDB_ERROR,e))}}(n,t,e)},e,n.constructor)}u.valid=function(){try{return\"undefined\"!=typeof indexedDB&&\"undefined\"!=typeof IDBKeyRange}catch(e){return!1}},t.exports=function(e){e.adapter(\"idb\",u,!0)}},{64:64,65:65,69:69,72:72,76:76,81:81,85:85}],62:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}var I=e(65),b=e(69),T=e(85),p=r(e(45)),v=r(e(108)),w=e(118),g=r(e(12)),k=r(e(30)),R=r(e(19)),q=e(64),D=e(81),i=e(76),L=e(80),N=e(72);function E(e,t){var n=new Uint8Array(e);return I.blob([n],{type:t})}function o(e,t){var n=t.prefix()[0],r=e._cache,i=r.get(n);return i||(i=new b.Map,r.set(n,i)),i}function M(){this._batch=[],this._cache=new b.Map}M.prototype.get=function(e,n,r){var i=o(this,e),t=i.get(n);return t?T.nextTick(function(){r(null,t)}):null===t?T.nextTick(function(){r({name:\"NotFoundError\"})}):void e.get(n,function(e,t){if(e)return\"NotFoundError\"===e.name&&i.set(n,null),r(e);i.set(n,t),r(null,t)})},M.prototype.batch=function(e){for(var t=0,n=e.length;t<n;t++){var r=e[t],i=o(this,r.prefix);\"put\"===r.type?i.set(r.key,r.value):i.set(r.key,null)}this._batch=this._batch.concat(e)},M.prototype.execute=function(e,t){for(var n=new b.Set,r=[],i=this._batch.length-1;0<=i;i--){var o=this._batch[i],a=o.prefix.prefix()[0]+\"ÿ\"+o.key;n.has(a)||(n.add(a),r.push(o))}e.batch(r,t)};var S=new b.Map,P=\"_local_last_update_seq\",F=\"_local_doc_count\",x=\"_local_uuid\",O={encode:i.safeJsonStringify,decode:i.safeJsonParse,buffer:!1,type:\"cheap-json\"},U=new T.changesHandler;function C(e){return\"winningRev\"in e?e.winningRev:D.winningRev(e)}function A(e,t){return\"deleted\"in e?e.deleted:q.isDeleted(e,t)}function $(e,t,n){var r=[];return e.forEach(function(n){n.doc&&n.doc._attachments&&Object.keys(n.doc._attachments).forEach(function(e){var t=n.doc._attachments[e];\"data\"in t||r.push(t)})}),Promise.all(r.map(function(e){return function(o,e,a){var s=o.content_type;return new Promise(function(r,i){e.binaryStore.get(o.digest,function(e,t){var n;if(e){if(\"NotFoundError\"!==e.name)return i(e);n=a.binary?I.binaryStringToBlobOrBuffer(\"\",s):\"\"}else n=a.binary?E(t,s):t.toString(\"base64\");delete o.stub,delete o.length,o.data=n,r()})})}(e,t,n)}))}t.exports=function(t,n){t=T.clone(t);var r,y,_=this,j={},l=t.revs_limit,m=t.name;void 0===t.createIfMissing&&(t.createIfMissing=!0);var i,o=t.db,e=T.functionName(o);function a(){j.docStore=y.sublevel(\"document-store\",{valueEncoding:O}),j.bySeqStore=y.sublevel(\"by-sequence\",{valueEncoding:\"json\"}),j.attachmentStore=y.sublevel(\"attach-store\",{valueEncoding:\"json\"}),j.binaryStore=y.sublevel(\"attach-binary-store\",{valueEncoding:\"binary\"}),j.localStore=y.sublevel(\"local-store\",{valueEncoding:\"json\"}),j.metaStore=y.sublevel(\"meta-store\",{valueEncoding:\"json\"}),\"object\"==typeof t.migrate?t.migrate.doMigrationTwo(y,j,s):s()}function s(){j.metaStore.get(P,function(e,t){void 0===y._updateSeq&&(y._updateSeq=t||0),j.metaStore.get(F,function(e,t){y._docCount=e?0:t,j.metaStore.get(x,function(e,t){r=e?T.uuid():t,j.metaStore.put(x,r,function(){T.nextTick(function(){n(null,_)})})})})})}function u(e,t){try{e.apply(null,t)}catch(e){t[t.length-1](e)}}function c(){var e=y._queue.peekFront();\"read\"===e.type?function(e){var r=[e],t=1,n=y._queue.get(t);for(;void 0!==n&&\"read\"===n.type;)r.push(n),t++,n=y._queue.get(t);var i=0;r.forEach(function(e){var t=e.args,n=t[t.length-1];t[t.length-1]=g(function(e){n.apply(null,e),++i===r.length&&T.nextTick(function(){r.forEach(function(){y._queue.shift()}),y._queue.length&&c()})}),u(e.fun,t)})}(e):function(e){var t=e.args,n=t[t.length-1];t[t.length-1]=g(function(e){n.apply(null,e),T.nextTick(function(){y._queue.shift(),y._queue.length&&c()})}),u(e.fun,t)}(e)}function f(t){return g(function(e){y._queue.push({fun:t,args:e,type:\"write\"}),1===y._queue.length&&T.nextTick(c)})}function h(t){return g(function(e){y._queue.push({fun:t,args:e,type:\"read\"}),1===y._queue.length&&T.nextTick(c)})}function B(e){return(\"0000000000000000\"+e).slice(-16)}function d(e,t){\"destroy\"in o&&o.destroy(e,t)}S.has(e)?i=S.get(e):(i=new b.Map,S.set(e,i)),i.has(m)?(y=i.get(m),a()):i.set(m,v(p(o(m),t,function(e){if(e)return i.delete(m),n(e);(y=i.get(m))._docCount=-1,y._queue=new k,\"object\"==typeof t.migrate?t.migrate.doMigrationOne(m,y,a):a()}))),_._remote=!1,_.type=function(){return\"leveldb\"},_._id=function(e){e(null,r)},_._info=function(e){var t={doc_count:y._docCount,update_seq:y._updateSeq,backend_adapter:T.functionName(o)};return T.nextTick(function(){e(null,t)})},_._get=h(function(e,i,o){i=T.clone(i),j.docStore.get(e,function(e,n){if(e||!n)return o(N.createError(N.MISSING_DOC,\"missing\"));var r;if(i.rev)r=i.latest?D.latest(i.rev,n):i.rev;else if(r=C(n),A(n,r))return o(N.createError(N.MISSING_DOC,\"deleted\"));var t=n.rev_map[r];j.bySeqStore.get(B(t),function(e,t){if(!t)return o(N.createError(N.MISSING_DOC));if(\"_id\"in t&&t._id!==n.id)return o(new Error(\"wrong doc returned\"));if(t._id=n.id,\"_rev\"in t){if(t._rev!==r)return o(new Error(\"wrong doc returned\"))}else t._rev=r;return o(null,{doc:t,metadata:n})})})}),_._getAttachment=function(e,t,n,r,i){var o=n.digest,a=n.content_type;j.binaryStore.get(o,function(e,t){if(e)return\"NotFoundError\"!==e.name?i(e):i(null,r.binary?function(e){return I.blob([\"\"],{type:e})}(a):\"\");r.binary?i(null,E(t,a)):i(null,t.toString(\"base64\"))})},_._bulkDocs=f(function(e,t,w){var n=t.new_edits,k=new Array(e.docs.length),E=new b.Map,S=new b.Map,x=new M,O=0,C=y._updateSeq,o=e.docs,r=o.map(function(e){if(e._id&&q.isLocalId(e._id))return e;var t=q.parseDoc(e,n,_.__opts);return t.metadata&&!t.metadata.rev_map&&(t.metadata.rev_map={}),t}),i=r.filter(function(e){return e.error});if(i.length)return w(i[0]);function a(e,t){var n=Promise.resolve();e.forEach(function(e,r){n=n.then(function(){return new Promise(function(t,n){_._doCompactionNoLock(r,e,{ctx:x},function(e){if(e)return n(e);t()})})})}),n.then(function(){t()},t)}function s(){a(S,function(e){if(e&&f(e),_.auto_compaction)return function(e){var n=new b.Map;E.forEach(function(e,t){n.set(t,D.compactTree(e))}),a(n,e)}(f);f()})}function u(n,e,t,r,i,o,a,s){O+=o;var u=null,c=0;n.metadata.winningRev=e,n.metadata.deleted=t,n.data._id=n.metadata.id,n.data._rev=n.metadata.rev,r&&(n.data._deleted=!0),n.stemmedRevs.length&&S.set(n.metadata.id,n.stemmedRevs);var f,l,h=n.data._attachments?Object.keys(n.data._attachments):[];function d(e){c++,u||(e?s(u=e):c===h.length&&b())}function p(t,n,r,i){return function(e){!function(e,n,t,r,i){var o=e.data._attachments[t];delete o.data,o.digest=n,o.length=r.length;var a=e.metadata.id,s=e.metadata.rev;o.revpos=parseInt(s,10),A(a,s,n,function(e,t){return e?i(e):0===r.length?i(e):t?(x.batch([{type:\"put\",prefix:j.binaryStore,key:n,value:R(r,\"binary\")}]),void i()):i(e)})}(t,\"md5-\"+e,n,r,i)}}function v(t,n,r){return function(e){L.binaryMd5(e,p(t,n,e,r))}}for(var g=0;g<h.length;g++){var y,_=h[g],m=n.data._attachments[_];if(m.stub)A(n.data._id,n.data._rev,m.digest,d);else if(\"string\"==typeof m.data){try{y=I.atob(m.data)}catch(e){return void w(N.createError(N.BAD_ARG,\"Attachment is not a valid base64 string\"))}v(n,_,d)(y)}else f=m.data,l=v(n,_,d),I.readAsBinaryString(f,l)}function b(){var e=n.metadata.rev_map[n.metadata.rev];if(e)return s();e=++C,n.metadata.rev_map[n.metadata.rev]=n.metadata.seq=e;var t=[{key:B(e),value:n.data,prefix:j.bySeqStore,type:\"put\"},{key:n.metadata.id,value:n.metadata,prefix:j.docStore,type:\"put\"}];x.batch(t),k[a]={ok:!0,id:n.metadata.id,rev:n.metadata.rev},E.set(n.metadata.id,n.metadata),s()}h.length||b()}var c={};function A(r,i,o,t){function e(t){var e=[r,i].join(\"@\"),n={};return t?t.refs&&(n.refs=t.refs,n.refs[e]=!0):(n.refs={},n.refs[e]=!0),new Promise(function(e){x.batch([{type:\"put\",prefix:j.attachmentStore,key:o,value:n}]),e(!t)})}var n=c[o]||Promise.resolve();c[o]=n.then(function(){return new Promise(function(n,r){x.get(j.attachmentStore,o,function(e,t){if(e&&\"NotFoundError\"!==e.name)return r(e);n(t)})}).then(e).then(function(e){t(null,e)},t)})}function f(e){if(e)return T.nextTick(function(){w(e)});x.batch([{prefix:j.metaStore,type:\"put\",key:P,value:C},{prefix:j.metaStore,type:\"put\",key:F,value:y._docCount+O}]),x.execute(y,function(e){if(e)return w(e);y._docCount+=O,y._updateSeq=C,U.notify(m),T.nextTick(function(){w(null,k)})})}if(!r.length)return w(null,[]);!function(t){var r=[];if(o.forEach(function(n){n&&n._attachments&&Object.keys(n._attachments).forEach(function(e){var t=n._attachments[e];t.stub&&r.push(t.digest)})}),!r.length)return t();var n,i=0;r.forEach(function(e){!function(n,r){x.get(j.attachmentStore,n,function(e){if(e){var t=N.createError(N.MISSING_STUB,\"unknown stub attachment with digest \"+n);r(t)}else r()})}(e,function(e){e&&!n&&(n=e),++i===r.length&&t(n)})})}(function(e){if(e)return w(e);!function(e){var r,t=0;function i(){if(++t===o.length)return e(r)}o.forEach(function(n){if(n._id&&q.isLocalId(n._id))return i();x.get(j.docStore,n._id,function(e,t){e?\"NotFoundError\"!==e.name&&(r=e):E.set(n._id,t),i()})})}(function(e){if(e)return w(e);q.processDocs(l,r,_,E,x,k,u,t,s)})})}),_._allDocs=function(e,t){return\"keys\"in e?q.allDocsKeysQuery(this,e):h(function(h,a){h=T.clone(h),function(e){y.isClosed()?e(new Error(\"database is closed\")):e(null,y._docCount)}(function(e,t){if(e)return a(e);var u,n={},c=h.skip||0;if(h.startkey&&(n.gte=h.startkey),h.endkey&&(n.lte=h.endkey),h.key&&(n.gte=n.lte=h.key),h.descending){n.reverse=!0;var r=n.lte;n.lte=n.gte,n.gte=r}if(\"number\"==typeof h.limit&&(u=h.limit),0===u||\"gte\"in n&&\"lte\"in n&&n.gte>n.lte){var i={total_rows:t,offset:h.skip,rows:[]};return h.update_seq&&(i.update_seq=y._updateSeq),a(null,i)}var f=[],l=j.docStore.readStream(n),o=w.obj(function(e,t,i){var o=e.value,a=C(o),s=A(o,a);if(s){if(\"ok\"!==h.deleted)return void i()}else{if(0<c--)return void i();if(\"number\"==typeof u&&u--<=0)return l.unpipe(),l.destroy(),void i()}function n(e){var t={id:o.id,key:o.id,value:{rev:a}};if(h.include_docs){if(t.doc=e,t.doc._rev=t.value.rev,h.conflicts){var n=D.collectConflicts(o);n.length&&(t.doc._conflicts=n)}for(var r in t.doc._attachments)t.doc._attachments.hasOwnProperty(r)&&(t.doc._attachments[r].stub=!0)}if(!1===h.inclusive_end&&o.id===h.endkey)return i();if(s){if(\"ok\"!==h.deleted)return i();t.value.deleted=!0,t.doc=null}f.push(t),i()}if(h.include_docs){var r=o.rev_map[a];j.bySeqStore.get(B(r),function(e,t){n(t)})}else n()},function(e){Promise.resolve().then(function(){if(h.include_docs&&h.attachments)return $(f,j,h)}).then(function(){var e={total_rows:t,offset:h.skip,rows:f};h.update_seq&&(e.update_seq=y._updateSeq),a(null,e)},a),e()}).on(\"unpipe\",function(){o.end()});l.on(\"error\",a),l.pipe(o)})})(e,t)},_._changes=function(s){if((s=T.clone(s)).continuous){var e=m+\":\"+T.uuid();return U.addListener(m,e,_,s),U.notify(m),{cancel:function(){U.removeListener(m,e)}}}var u,c=s.descending,f=[],l=s.since||0,h=0,t={reverse:c};\"limit\"in s&&0<s.limit&&(u=s.limit),t.reverse||(t.start=B(s.since||0));var d=s.doc_ids&&new b.Set(s.doc_ids),p=T.filterChange(s),v=new b.Map;function g(){s.done=!0,s.return_docs&&s.limit&&s.limit<f.length&&(f.length=s.limit),n.unpipe(r),n.destroy(),s.continuous||s.cancelled||(s.include_docs&&s.attachments&&s.return_docs?$(f,j,s).then(function(){s.complete(null,{results:f,last_seq:l})}):s.complete(null,{results:f,last_seq:l}))}var n=j.bySeqStore.readStream(t),r=w.obj(function(e,t,i){if(u&&u<=h)return g(),i();if(s.cancelled||s.done)return i();var n,o=function(e){return parseInt(e,10)}(e.key),a=e.value;if(o===s.since&&!c)return i();if(d&&!d.has(a._id))return i();function r(r){var e=C(r);function n(e){var t=s.processChange(e,r,s);t.seq=r.seq;var n=p(t);if(\"object\"==typeof n)return s.complete(n);n&&(h++,s.attachments&&s.include_docs?$([t],j,s).then(function(){s.onChange(t)}):s.onChange(t),s.return_docs&&f.push(t)),i()}if(r.seq!==o)return i();if(l=o,e===a._rev)return n(a);var t=r.rev_map[e];j.bySeqStore.get(B(t),function(e,t){n(t)})}if(n=v.get(a._id))return r(n);j.docStore.get(a._id,function(e,t){if(s.cancelled||s.done||y.isClosed()||q.isLocalId(t.id))return i();v.set(a._id,t),r(t)})},function(e){if(s.cancelled)return e();s.return_docs&&s.limit&&s.limit<f.length&&(f.length=s.limit),e()}).on(\"unpipe\",function(){r.end(),g()});return n.pipe(r),{cancel:function(){s.cancelled=!0,g()}}},_._close=function(t){if(y.isClosed())return t(N.createError(N.NOT_OPEN));y.close(function(e){e?t(e):(i.delete(m),t())})},_._getRevisionTree=function(e,n){j.docStore.get(e,function(e,t){e?n(N.createError(N.MISSING_DOC)):n(null,t.rev_tree)})},_._doCompaction=f(function(e,t,n,r){_._doCompactionNoLock(e,t,n,r)}),_._doCompactionNoLock=function(c,f,l,h){if(\"function\"==typeof l&&(h=l,l={}),!f.length)return h();var d=l.ctx||new M;d.get(j.docStore,c,function(e,n){if(e)return h(e);var t=f.map(function(e){var t=n.rev_map[e];return delete n.rev_map[e],t});D.traverseRevTree(n.rev_tree,function(e,t,n,r,i){var o=t+\"-\"+n;-1!==f.indexOf(o)&&(i.status=\"missing\")});var s=[];s.push({key:n.id,value:n,type:\"put\",prefix:j.docStore});var r,i={},o=0;function a(e){if(e&&(r=e),++o===f.length){if(r)return h(r);!function(){var t=Object.keys(i);if(!t.length)return u();var n,r=0;function o(e){e&&(n=e),++r===t.length&&u(n)}var a=new b.Map;f.forEach(function(e){a.set(c+\"@\"+e,!0)}),t.forEach(function(i){d.get(j.attachmentStore,i,function(e,t){if(e)return\"NotFoundError\"===e.name?o():o(e);var n=Object.keys(t.refs||{}).filter(function(e){return!a.has(e)}),r={};n.forEach(function(e){r[e]=!0}),n.length?s.push({key:i,type:\"put\",value:{refs:r},prefix:j.attachmentStore}):s=s.concat([{key:i,type:\"del\",prefix:j.attachmentStore},{key:i,type:\"del\",prefix:j.binaryStore}]),o()})})}()}}function u(e){return e?h(e):(d.batch(s),l.ctx?h():void d.execute(y,h))}t.forEach(function(e){s.push({key:B(e),type:\"del\",prefix:j.bySeqStore}),d.get(j.bySeqStore,B(e),function(e,n){if(e)return\"NotFoundError\"===e.name?a():a(e);Object.keys(n._attachments||{}).forEach(function(e){var t=n._attachments[e].digest;i[t]=!0}),a()})})})},_._getLocal=function(e,n){j.localStore.get(e,function(e,t){e?n(N.createError(N.MISSING_DOC)):n(null,t)})},_._putLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={}),t.ctx?_._putLocalNoLock(e,t,n):_._putLocalWithLock(e,t,n)},_._putLocalWithLock=f(function(e,t,n){_._putLocalNoLock(e,t,n)}),_._putLocalNoLock=function(i,o,a){delete i._revisions;var s=i._rev,u=i._id,c=o.ctx||new M;c.get(j.localStore,u,function(e,t){if(e&&s)return a(N.createError(N.REV_CONFLICT));if(t&&t._rev!==s)return a(N.createError(N.REV_CONFLICT));i._rev=s?\"0-\"+(parseInt(s.split(\"-\")[1],10)+1):\"0-1\";var n=[{type:\"put\",prefix:j.localStore,key:u,value:i}];c.batch(n);var r={ok:!0,id:i._id,rev:i._rev};if(o.ctx)return a(null,r);c.execute(y,function(e){if(e)return a(e);a(null,r)})})},_._removeLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={}),t.ctx?_._removeLocalNoLock(e,t,n):_._removeLocalWithLock(e,t,n)},_._removeLocalWithLock=f(function(e,t,n){_._removeLocalNoLock(e,t,n)}),_._removeLocalNoLock=function(r,i,o){var a=i.ctx||new M;a.get(j.localStore,r._id,function(e,t){if(e)return\"NotFoundError\"!==e.name?o(e):o(N.createError(N.MISSING_DOC));if(t._rev!==r._rev)return o(N.createError(N.REV_CONFLICT));a.batch([{prefix:j.localStore,type:\"del\",key:r._id}]);var n={ok:!0,id:r._id,rev:\"0-0\"};if(i.ctx)return o(null,n);a.execute(y,function(e){if(e)return o(e);o(null,n)})})},_._destroy=function(e,t){var n,r=T.functionName(o);if(!S.has(r))return d(m,t);(n=S.get(r)).has(m)?(U.removeAllListeners(m),n.get(m).close(function(){n.delete(m),d(m,t)})):d(m,t)}}},{108:108,118:118,12:12,19:19,30:30,45:45,64:64,65:65,69:69,72:72,76:76,80:80,81:81,85:85}],63:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}var i=e(85),o=r(e(62)),a=r(e(50));function s(e,t){var n=i.assign({db:a},e);o.call(this,n,t)}s.valid=function(){return!0},s.use_prefix=!1,t.exports=function(e){e.adapter(\"memory\",s,!0)}},{50:50,62:62,85:85}],64:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var l=e(85),m=e(72),i=e(65),o=e(80),b=e(81),r=e(69);function a(e){return e.reduce(function(e,t){return e[t]=!0,e},{})}var h=a([\"_id\",\"_rev\",\"_attachments\",\"_deleted\",\"_revisions\",\"_revs_info\",\"_conflicts\",\"_deleted_conflicts\",\"_local_seq\",\"_rev_tree\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\",\"_removed\"]),d=a([\"_attachments\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\"]);function p(e){if(!/^\\d+-./.test(e))return m.createError(m.INVALID_REV);var t=e.indexOf(\"-\"),n=e.substring(0,t),r=e.substring(t+1);return{prefix:parseInt(n,10),id:r}}function w(e,t,n){var r,i,o;n=n||{deterministic_revs:!0};var a={status:\"available\"};if(e._deleted&&(a.deleted=!0),t)if(e._id||(e._id=l.uuid()),i=l.rev(e,n.deterministic_revs),e._rev){if((o=p(e._rev)).error)return o;e._rev_tree=[{pos:o.prefix,ids:[o.id,{status:\"missing\"},[[i,a,[]]]]}],r=o.prefix+1}else e._rev_tree=[{pos:1,ids:[i,a,[]]}],r=1;else if(e._revisions&&(e._rev_tree=function(e,t){for(var n=e.start-e.ids.length+1,r=e.ids,i=[r[0],t,[]],o=1,a=r.length;o<a;o++)i=[r[o],{status:\"missing\"},[i]];return[{pos:n,ids:i}]}(e._revisions,a),r=e._revisions.start,i=e._revisions.ids[0]),!e._rev_tree){if((o=p(e._rev)).error)return o;r=o.prefix,i=o.id,e._rev_tree=[{pos:r,ids:[i,a,[]]}]}l.invalidIdError(e._id),e._rev=r+\"-\"+i;var s={metadata:{},data:{}};for(var u in e)if(Object.prototype.hasOwnProperty.call(e,u)){var c=\"_\"===u[0];if(c&&!h[u]){var f=m.createError(m.DOC_VALIDATION,u);throw f.message=m.DOC_VALIDATION.message+\": \"+u,f}c&&!d[u]?s.metadata[u.slice(1)]=e[u]:s.data[u]=e[u]}return s}function s(t,e,n){var r=function(e){try{return i.atob(e)}catch(e){return{error:m.createError(m.BAD_ARG,\"Attachment is not a valid base64 string\")}}}(t.data);if(r.error)return n(r.error);t.length=r.length,t.data=\"blob\"===e?i.binaryStringToBlobOrBuffer(r,t.content_type):\"base64\"===e?i.btoa(r):r,o.binaryMd5(r,function(e){t.digest=\"md5-\"+e,n()})}function u(e,t,n){if(e.stub)return n();\"string\"==typeof e.data?s(e,t,n):function(t,n,r){o.binaryMd5(t.data,function(e){t.digest=\"md5-\"+e,t.length=t.data.size||t.data.length||0,\"binary\"===n?i.blobOrBufferToBinaryString(t.data,function(e){t.data=e,r()}):\"base64\"===n?i.blobOrBufferToBase64(t.data,function(e){t.data=e,r()}):r()})}(e,t,n)}function v(e,t,n,r,i,o,a,s){if(b.revExists(t.rev_tree,n.metadata.rev)&&!s)return r[i]=n,o();var u=t.winningRev||b.winningRev(t),c=\"deleted\"in t?t.deleted:b.isDeleted(t,u),f=\"deleted\"in n.metadata?n.metadata.deleted:b.isDeleted(n.metadata),l=/^1-/.test(n.metadata.rev);if(c&&!f&&s&&l){var h=n.data;h._rev=u,h._id=n.metadata.id,n=w(h,s)}var d=b.merge(t.rev_tree,n.metadata.rev_tree[0],e);if(s&&(c&&f&&\"new_leaf\"!==d.conflicts||!c&&\"new_leaf\"!==d.conflicts||c&&!f&&\"new_branch\"===d.conflicts)){var p=m.createError(m.REV_CONFLICT);return r[i]=p,o()}var v=n.metadata.rev;n.metadata.rev_tree=d.tree,n.stemmedRevs=d.stemmedRevs||[],t.rev_map&&(n.metadata.rev_map=t.rev_map);var g=b.winningRev(n.metadata),y=b.isDeleted(n.metadata,g),_=c===y?0:c<y?-1:1;a(n,g,y,v===g?y:b.isDeleted(n.metadata,v),!0,_,i,o)}n.invalidIdError=l.invalidIdError,n.normalizeDdocFunctionName=l.normalizeDdocFunctionName,n.parseDdocFunctionName=l.parseDdocFunctionName,n.isDeleted=b.isDeleted,n.isLocalId=b.isLocalId,n.allDocsKeysQuery=function(e,o){var t=o.keys,a={offset:o.skip};return Promise.all(t.map(function(i){var t=l.assign({key:i,deleted:\"ok\"},o);return[\"limit\",\"skip\",\"keys\"].forEach(function(e){delete t[e]}),new Promise(function(n,r){e._allDocs(t,function(e,t){if(e)return r(e);o.update_seq&&void 0!==t.update_seq&&(a.update_seq=t.update_seq),a.total_rows=t.total_rows,n(t.rows[0]||{key:i,error:\"not_found\"})})})})).then(function(e){return a.rows=e,a})},n.parseDoc=w,n.preprocessAttachments=function(e,o,t){if(!e.length)return t();var a,n=0;function s(){n++,e.length===n&&(a?t(a):t())}e.forEach(function(e){var t=e.data&&e.data._attachments?Object.keys(e.data._attachments):[],n=0;if(!t.length)return s();function r(e){a=e,++n===t.length&&s()}for(var i in e.data._attachments)e.data._attachments.hasOwnProperty(i)&&u(e.data._attachments[i],o,r)})},n.processDocs=function(u,e,i,c,o,f,l,h,t){u=u||1e3;var d=h.new_edits,a=new r.Map,n=0,s=e.length;function p(){++n===s&&t&&t()}e.forEach(function(e,n){if(e._id&&b.isLocalId(e._id)){var t=e._deleted?\"_removeLocal\":\"_putLocal\";i[t](e,{ctx:o},function(e,t){f[n]=e||t,p()})}else{var r=e.metadata.id;a.has(r)?(s--,a.get(r).push([e,n])):a.set(r,[[e,n]])}}),a.forEach(function(i,o){var a=0;function s(){++a<i.length?e():p()}function e(){var e=i[a],t=e[0],n=e[1];if(c.has(o))v(u,c.get(o),t,f,n,s,l,d);else{var r=b.merge([],t.metadata.rev_tree[0],u);t.metadata.rev_tree=r.tree,t.stemmedRevs=r.stemmedRevs||[],function(e,t,n){var r=b.winningRev(e.metadata),i=b.isDeleted(e.metadata,r);if(\"was_delete\"in h&&i)return f[t]=m.createError(m.MISSING_DOC,\"deleted\"),n();if(d&&function(e){return\"missing\"===e.metadata.rev_tree[0].ids[1].status}(e)){var o=m.createError(m.REV_CONFLICT);return f[t]=o,n()}l(e,r,i,i,!1,i?0:1,t,n)}(t,n,s)}}e()})},n.updateDoc=v},{65:65,69:69,72:72,80:80,81:81,85:85}],65:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});function r(e){return atob(e)}function i(e){return btoa(e)}function o(t,n){t=t||[],n=n||{};try{return new Blob(t,n)}catch(e){if(\"TypeError\"!==e.name)throw e;for(var r=new(\"undefined\"!=typeof BlobBuilder?BlobBuilder:\"undefined\"!=typeof MSBlobBuilder?MSBlobBuilder:\"undefined\"!=typeof MozBlobBuilder?MozBlobBuilder:WebKitBlobBuilder),i=0;i<t.length;i+=1)r.append(t[i]);return r.getBlob(n.type)}}function a(e){for(var t=e.length,n=new ArrayBuffer(t),r=new Uint8Array(n),i=0;i<t;i++)r[i]=e.charCodeAt(i);return n}function s(e,t){return o([a(e)],{type:t})}function u(e,n){var t=new FileReader,r=\"function\"==typeof t.readAsBinaryString;t.onloadend=function(e){var t=e.target.result||\"\";if(r)return n(t);n(function(e){for(var t=\"\",n=new Uint8Array(e),r=n.byteLength,i=0;i<r;i++)t+=String.fromCharCode(n[i]);return t}(t))},r?t.readAsBinaryString(e):t.readAsArrayBuffer(e)}function c(e,t){u(e,function(e){t(e)})}n.atob=r,n.btoa=i,n.base64StringToBlobOrBuffer=function(e,t){return s(r(e),t)},n.binaryStringToArrayBuffer=a,n.binaryStringToBlobOrBuffer=s,n.blob=o,n.blobOrBufferToBase64=function(e,t){c(e,function(e){t(i(e))})},n.blobOrBufferToBinaryString=c,n.readAsArrayBuffer=function(e,n){var t=new FileReader;t.onloadend=function(e){var t=e.target.result||new ArrayBuffer(0);n(t)},t.readAsArrayBuffer(e)},n.readAsBinaryString=u,n.typedBuffer=function(){}},{}],66:[function(e,t,n){\"use strict\";var u=e(85),c=e(72),f=e(84);function r(e,t){if(e.selector&&e.filter&&\"_selector\"!==e.filter){var n=\"string\"==typeof e.filter?e.filter:\"function\";return t(new Error('selector invalid for filter \"'+n+'\"'))}t()}function i(e){e.view&&!e.filter&&(e.filter=\"_view\"),e.selector&&!e.filter&&(e.filter=\"_selector\"),e.filter&&\"string\"==typeof e.filter&&(\"_view\"===e.filter?e.view=u.normalizeDdocFunctionName(e.view):e.filter=u.normalizeDdocFunctionName(e.filter))}function o(e,t){return t.filter&&\"string\"==typeof t.filter&&!t.doc_ids&&!u.isRemote(e.db)}function a(r,i){var o=i.complete;if(\"_view\"===i.filter){if(!i.view||\"string\"!=typeof i.view){var e=c.createError(c.BAD_REQUEST,\"`view` filter parameter not found or invalid.\");return o(e)}var a=u.parseDdocFunctionName(i.view);r.db.get(\"_design/\"+a[0],function(e,t){if(r.isCancelled)return o(null,{status:\"cancelled\"});if(e)return o(c.generateErrorFromResponse(e));var n=t&&t.views&&t.views[a[1]]&&t.views[a[1]].map;if(!n)return o(c.createError(c.MISSING_DOC,t.views?\"missing json key: \"+a[1]:\"missing json key: views\"));i.filter=function(e){var t=[\"return function(doc) {\",'  \"use strict\";',\"  var emitted = false;\",\"  var emit = function (a, b) {\",\"    emitted = true;\",\"  };\",\"  var view = \"+e+\";\",\"  view(doc);\",\"  if (emitted) {\",\"    return true;\",\"  }\",\"};\"].join(\"\\n\");return u.scopeEval(t,{})}(n),r.doChanges(i)})}else if(i.selector)i.filter=function(e){return f.matchesSelector(e,i.selector)},r.doChanges(i);else{var s=u.parseDdocFunctionName(i.filter);r.db.get(\"_design/\"+s[0],function(e,t){if(r.isCancelled)return o(null,{status:\"cancelled\"});if(e)return o(c.generateErrorFromResponse(e));var n=t&&t.filters&&t.filters[s[1]];if(!n)return o(c.createError(c.MISSING_DOC,t&&t.filters?\"missing json key: \"+s[1]:\"missing json key: filters\"));i.filter=function(e){return u.scopeEval('\"use strict\";\\nreturn '+e+\";\",{})}(n),r.doChanges(i)})}}t.exports=function(e){e._changesFilterPlugin={validate:r,normalize:i,shouldFilter:o,filter:a}}},{72:72,84:84,85:85}],67:[function(e,t,n){\"use strict\";var a=e(85),r=e(68),s=1,u=\"pouchdb\",c=5,f=0;function l(t,n,r,i,o){return t.get(n).catch(function(e){if(404===e.status)return\"http\"!==t.adapter&&\"https\"!==t.adapter||a.explainError(404,\"PouchDB is just checking if a remote checkpoint exists.\"),{session_id:i,_id:n,history:[],replicator:u,version:s};throw e}).then(function(e){if(!o.cancelled&&e.last_seq!==r)return e.history=(e.history||[]).filter(function(e){return e.session_id!==i}),e.history.unshift({last_seq:r,session_id:i}),e.history=e.history.slice(0,c),e.version=s,e.replicator=u,e.session_id=i,e.last_seq=r,t.put(e).catch(function(e){if(409===e.status)return l(t,n,r,i,o);throw e})})}function i(e,t,n,r,i){this.src=e,this.target=t,this.id=n,this.returnValue=r,this.opts=i||{}}i.prototype.writeCheckpoint=function(e,t){var n=this;return this.updateTarget(e,t).then(function(){return n.updateSource(e,t)})},i.prototype.updateTarget=function(e,t){return this.opts.writeTargetCheckpoint?l(this.target,this.id,e,t,this.returnValue):Promise.resolve(!0)},i.prototype.updateSource=function(e,t){if(this.opts.writeSourceCheckpoint){var n=this;return l(this.src,this.id,e,t,this.returnValue).catch(function(e){if(d(e))return!(n.opts.writeSourceCheckpoint=!1);throw e})}return Promise.resolve(!0)};var o={undefined:function(e,t){return 0===r.collate(e.last_seq,t.last_seq)?t.last_seq:0},1:function(e,t){return function(e,t){return e.session_id!==t.session_id?function e(t,n){var r=t[0];var i=t.slice(1);var o=n[0];var a=n.slice(1);if(!r||0===n.length)return{last_seq:f,history:[]};var s=r.session_id;if(h(s,n))return{last_seq:r.last_seq,history:t};var u=o.session_id;if(h(u,i))return{last_seq:o.last_seq,history:a};return e(i,a)}(e.history,t.history):{last_seq:e.last_seq,history:e.history}}(t,e).last_seq}};function h(e,t){var n=t[0],r=t.slice(1);return!(!e||0===t.length)&&(e===n.session_id||h(e,r))}function d(e){return\"number\"==typeof e.status&&4===Math.floor(e.status/100)}i.prototype.getCheckpoint=function(){var t=this;return t.opts&&t.opts.writeSourceCheckpoint&&!t.opts.writeTargetCheckpoint?t.src.get(t.id).then(function(e){return e.last_seq||f}).catch(function(e){if(404!==e.status)throw e;return f}):t.target.get(t.id).then(function(n){return t.opts&&t.opts.writeTargetCheckpoint&&!t.opts.writeSourceCheckpoint?n.last_seq||f:t.src.get(t.id).then(function(e){return n.version!==e.version?f:(t=n.version?n.version.toString():\"undefined\")in o?o[t](n,e):f;var t},function(e){if(404===e.status&&n.last_seq)return t.src.put({_id:t.id,last_seq:f}).then(function(){return f},function(e){return d(e)?(t.opts.writeSourceCheckpoint=!1,n.last_seq):f});throw e})}).catch(function(e){if(404!==e.status)throw e;return f})},t.exports=i},{68:68,85:85}],68:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var c=-324,f=3,u=\"\";function s(e,t){if(e===t)return 0;e=a(e),t=a(t);var n=i(e),r=i(t);if(n-r!=0)return n-r;switch(typeof e){case\"number\":return e-t;case\"boolean\":return e<t?-1:1;case\"string\":return function(e,t){return e===t?0:t<e?1:-1}(e,t)}return Array.isArray(e)?function(e,t){for(var n=Math.min(e.length,t.length),r=0;r<n;r++){var i=s(e[r],t[r]);if(0!==i)return i}return e.length===t.length?0:e.length>t.length?1:-1}(e,t):function(e,t){for(var n=Object.keys(e),r=Object.keys(t),i=Math.min(n.length,r.length),o=0;o<i;o++){var a=s(n[o],r[o]);if(0!==a)return a;if(0!==(a=s(e[n[o]],t[r[o]])))return a}return n.length===r.length?0:n.length>r.length?1:-1}(e,t)}function a(e){switch(typeof e){case\"undefined\":return null;case\"number\":return e===1/0||e===-1/0||isNaN(e)?null:e;case\"object\":var t=e;if(Array.isArray(e)){var n=e.length;e=new Array(n);for(var r=0;r<n;r++)e[r]=a(t[r])}else{if(e instanceof Date)return e.toJSON();if(null!==e)for(var i in e={},t)if(t.hasOwnProperty(i)){var o=t[i];void 0!==o&&(e[i]=a(o))}}}return e}function r(e){if(null!==e)switch(typeof e){case\"boolean\":return e?1:0;case\"number\":return function(e){if(0===e)return\"1\";var t=e.toExponential().split(/e\\+?/),n=parseInt(t[1],10),r=e<0,i=r?\"0\":\"2\",o=function(e,t,n){return function(e,t,n){for(var r=\"\",i=n-e.length;r.length<i;)r+=t;return r}(e,t,n)+e}(((r?-n:n)-c).toString(),\"0\",f);i+=u+o;var a=Math.abs(parseFloat(t[0]));r&&(a=10-a);var s=a.toFixed(20);return s=s.replace(/\\.?0+$/,\"\"),i+=u+s}(e);case\"string\":return e.replace(/\\u0002/g,\"\u0002\u0002\").replace(/\\u0001/g,\"\u0001\u0002\").replace(/\\u0000/g,\"\u0001\u0001\");case\"object\":var t=Array.isArray(e),n=t?e:Object.keys(e),r=-1,i=n.length,o=\"\";if(t)for(;++r<i;)o+=l(n[r]);else for(;++r<i;){var a=n[r];o+=l(a)+l(e[a])}return o}return\"\"}function l(e){return i(e=a(e))+u+r(e)+\"\\0\"}function h(e,t){var n,r=t;if(\"1\"===e[t])n=0,t++;else{var i=\"0\"===e[t];t++;var o=\"\",a=e.substring(t,t+f),s=parseInt(a,10)+c;for(i&&(s=-s),t+=f;;){var u=e[t];if(\"\\0\"===u)break;o+=u,t++}n=1===(o=o.split(\".\")).length?parseInt(o,10):parseFloat(o[0]+\".\"+o[1]),i&&(n-=10),0!==s&&(n=parseFloat(n+\"e\"+s))}return{num:n,length:t-r}}function d(e,t){var n=e.pop();if(t.length){var r=t[t.length-1];n===r.element&&(t.pop(),r=t[t.length-1]);var i=r.element,o=r.index;if(Array.isArray(i))i.push(n);else if(o===e.length-2){i[e.pop()]=n}else e.push(n)}}function i(e){var t=[\"boolean\",\"number\",\"string\",\"object\"].indexOf(typeof e);return~t?null===e?1:Array.isArray(e)?5:t<3?t+2:t+3:Array.isArray(e)?5:void 0}n.collate=s,n.normalizeKey=a,n.toIndexableString=l,n.parseIndexableString=function(e){for(var t=[],n=[],r=0;;){var i=e[r++];if(\"\\0\"!==i)switch(i){case\"1\":t.push(null);break;case\"2\":t.push(\"1\"===e[r]),r++;break;case\"3\":var o=h(e,r);t.push(o.num),r+=o.length;break;case\"4\":for(var a=\"\";;){var s=e[r];if(\"\\0\"===s)break;a+=s,r++}a=a.replace(/\\u0001\\u0001/g,\"\\0\").replace(/\\u0001\\u0002/g,\"\u0001\").replace(/\\u0002\\u0002/g,\"\u0002\"),t.push(a);break;case\"5\":var u={element:[],index:t.length};t.push(u.element),n.push(u);break;case\"6\":var c={element:{},index:t.length};t.push(c.element),n.push(c);break;default:throw new Error(\"bad collationIndex or unexpectedly reached end of input: \"+i)}else{if(1===t.length)return t.pop();d(t,n)}}}},{}],69:[function(e,t,n){\"use strict\";function r(e){return\"$\"+e}function i(){this._store={}}function o(e){if(this._store=new i,e&&Array.isArray(e))for(var t=0,n=e.length;t<n;t++)this.add(e[t])}Object.defineProperty(n,\"__esModule\",{value:!0}),i.prototype.get=function(e){var t=r(e);return this._store[t]},i.prototype.set=function(e,t){var n=r(e);return this._store[n]=t,!0},i.prototype.has=function(e){return r(e)in this._store},i.prototype.delete=function(e){var t=r(e),n=t in this._store;return delete this._store[t],n},i.prototype.forEach=function(e){for(var t=Object.keys(this._store),n=0,r=t.length;n<r;n++){var i=t[n];e(this._store[i],i=i.substring(1))}},Object.defineProperty(i.prototype,\"size\",{get:function(){return Object.keys(this._store).length}}),o.prototype.add=function(e){return this._store.set(e,!0)},o.prototype.has=function(e){return this._store.has(e)},o.prototype.forEach=function(n){this._store.forEach(function(e,t){n(t)})},Object.defineProperty(o.prototype,\"size\",{get:function(){return this._store.size}}),!function(){if(\"undefined\"==typeof Symbol||\"undefined\"==typeof Map||\"undefined\"==typeof Set)return!1;var e=Object.getOwnPropertyDescriptor(Map,Symbol.species);return e&&\"get\"in e&&Map[Symbol.species]===Map}()?(n.Set=o,n.Map=i):(n.Set=Set,n.Map=Map)},{}],70:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}var a=r(e(12)),c=e(85),S=e(81),i=r(e(71)),s=e(33),f=e(69),l=e(72),o=e(74),u=r(e(66));function h(n,t,r){s.EventEmitter.call(this);var i=this;this.db=n;var o=(t=t?c.clone(t):{}).complete=c.once(function(e,t){e?0<c.listenerCount(i,\"error\")&&i.emit(\"error\",e):i.emit(\"complete\",t),i.removeAllListeners(),n.removeListener(\"destroyed\",a)});function a(){i.cancel()}r&&(i.on(\"complete\",function(e){r(null,e)}),i.on(\"error\",r)),n.once(\"destroyed\",a),t.onChange=function(e,t,n){i.isCancelled||function(e,t,n,r){try{e.emit(\"change\",t,n,r)}catch(e){c.guardedConsole(\"error\",'Error in .on(\"change\", function):',e)}}(i,e,t,n)};var e=new Promise(function(n,r){t.complete=function(e,t){e?r(e):n(t)}});i.once(\"cancel\",function(){n.removeListener(\"destroyed\",a),t.complete(null,{status:\"cancelled\"})}),this.then=e.then.bind(e),this.catch=e.catch.bind(e),this.then(function(e){o(null,e)},o),n.taskqueue.isReady?i.validateChanges(t):n.taskqueue.addTask(function(e){e?t.complete(e):i.isCancelled?i.emit(\"cancel\"):i.validateChanges(t)})}function d(e,t,n){var r=[{rev:e._rev}];\"all_docs\"===n.style&&(r=S.collectLeaves(t.rev_tree).map(function(e){return{rev:e.rev}}));var i={id:t.id,changes:r,doc:e};return S.isDeleted(t,e._rev)&&(i.deleted=!0),n.conflicts&&(i.doc._conflicts=S.collectConflicts(t),i.doc._conflicts.length||delete i.doc._conflicts),i}function p(e,t){return e<t?-1:t<e?1:0}function v(n,r){return function(e,t){e||t[0]&&t[0].error?((e=e||t[0]).docId=r,n(e)):n(null,t.length?t[0]:t)}}function g(e,t){var n=p(e._id,t._id);return 0!==n?n:p(e._revisions?e._revisions.start:0,t._revisions?t._revisions.start:0)}function y(){for(var e in s.EventEmitter.call(this),y.prototype)\"function\"==typeof this[e]&&(this[e]=this[e].bind(this))}function _(){this.isReady=!1,this.failed=!1,this.queue=[]}function m(e,t){if(!(this instanceof m))return new m(e,t);var n=this;if(t=t||{},e&&\"object\"==typeof e&&(e=(t=e).name,delete t.name),void 0===t.deterministic_revs&&(t.deterministic_revs=!0),this.__opts=t=c.clone(t),n.auto_compaction=t.auto_compaction,n.prefix=m.prefix,\"string\"!=typeof e)throw new Error(\"Missing/invalid DB name\");var r=function(e,t){var n=e.match(/([a-z-]*):\\/\\/(.*)/);if(n)return{name:/https?/.test(n[1])?n[1]+\"://\"+n[2]:n[2],adapter:n[1]};var r=m.adapters,i=m.preferredAdapters,o=m.prefix,a=t.adapter;if(!a)for(var s=0;s<i.length&&(\"idb\"===(a=i[s])&&\"websql\"in r&&c.hasLocalStorage()&&localStorage[\"_pouch__websqldb_\"+o+e]);++s)c.guardedConsole(\"log\",'PouchDB is downgrading \"'+e+'\" to WebSQL to avoid data loss, because it was already opened with WebSQL.');var u=r[a];return{name:!(u&&\"use_prefix\"in u)||u.use_prefix?o+e:e,adapter:a}}((t.prefix||\"\")+e,t);if(t.name=r.name,t.adapter=t.adapter||r.adapter,n.name=e,n._adapter=t.adapter,m.emit(\"debug\",[\"adapter\",\"Picked adapter: \",t.adapter]),!m.adapters[t.adapter]||!m.adapters[t.adapter].valid())throw new Error(\"Invalid Adapter: \"+t.adapter);y.call(n),n.taskqueue=new _,n.adapter=t.adapter,m.adapters[t.adapter].call(n,t,function(e){if(e)return n.taskqueue.fail(e);!function(t){function e(e){t.removeListener(\"closed\",n),e||t.constructor.emit(\"destroyed\",t.name)}function n(){t.removeListener(\"destroyed\",e),t.constructor.emit(\"unref\",t)}t.once(\"destroyed\",e),t.once(\"closed\",n),t.constructor.emit(\"ref\",t)}(n),n.emit(\"created\",n),m.emit(\"created\",n.name),n.taskqueue.ready(n)})}i(h,s.EventEmitter),h.prototype.cancel=function(){this.isCancelled=!0,this.db.taskqueue.isReady&&this.emit(\"cancel\")},h.prototype.validateChanges=function(t){var n=t.complete,r=this;m._changesFilterPlugin?m._changesFilterPlugin.validate(t,function(e){if(e)return n(e);r.doChanges(t)}):r.doChanges(t)},h.prototype.doChanges=function(t){var n=this,r=t.complete;if(\"live\"in(t=c.clone(t))&&!(\"continuous\"in t)&&(t.continuous=t.live),t.processChange=d,\"latest\"===t.since&&(t.since=\"now\"),t.since||(t.since=0),\"now\"!==t.since){if(m._changesFilterPlugin){if(m._changesFilterPlugin.normalize(t),m._changesFilterPlugin.shouldFilter(this,t))return m._changesFilterPlugin.filter(this,t)}else[\"doc_ids\",\"filter\",\"selector\",\"view\"].forEach(function(e){e in t&&c.guardedConsole(\"warn\",'The \"'+e+'\" option was passed in to changes/replicate, but pouchdb-changes-filter plugin is not installed, so it was ignored. Please install the plugin to enable filtering.')});\"descending\"in t||(t.descending=!1),t.limit=0===t.limit?1:t.limit,t.complete=r;var i=this.db._changes(t);if(i&&\"function\"==typeof i.cancel){var o=n.cancel;n.cancel=a(function(e){i.cancel(),o.apply(this,e)})}}else this.db.info().then(function(e){n.isCancelled?r(null,{status:\"cancelled\"}):(t.since=e.update_seq,n.doChanges(t))},r)},i(y,s.EventEmitter),y.prototype.post=c.adapterFun(\"post\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e))return n(l.createError(l.NOT_AN_OBJECT));this.bulkDocs({docs:[e]},t,v(n,e._id))}),y.prototype.put=c.adapterFun(\"put\",function(n,t,r){if(\"function\"==typeof t&&(r=t,t={}),\"object\"!=typeof n||Array.isArray(n))return r(l.createError(l.NOT_AN_OBJECT));if(c.invalidIdError(n._id),S.isLocalId(n._id)&&\"function\"==typeof this._putLocal)return n._deleted?this._removeLocal(n,r):this._putLocal(n,r);var e,i,o,a,s=this;function u(e){\"function\"==typeof s._put&&!1!==t.new_edits?s._put(n,t,e):s.bulkDocs({docs:[n]},t,v(e,n._id))}t.force&&n._rev?(e=n._rev.split(\"-\"),i=e[1],o=parseInt(e[0],10)+1,a=c.rev(),n._revisions={start:o,ids:[a,i]},n._rev=o+\"-\"+a,t.new_edits=!1,u(function(e){var t=e?null:{ok:!0,id:n._id,rev:n._rev};r(e,t)})):u(r)}),y.prototype.putAttachment=c.adapterFun(\"putAttachment\",function(t,n,r,i,o){var a=this;function s(e){var t=\"_rev\"in e?parseInt(e._rev,10):0;return e._attachments=e._attachments||{},e._attachments[n]={content_type:o,data:i,revpos:++t},a.put(e)}return\"function\"==typeof o&&(o=i,i=r,r=null),void 0===o&&(o=i,i=r,r=null),o||c.guardedConsole(\"warn\",\"Attachment\",n,\"on document\",t,\"is missing content_type\"),a.get(t).then(function(e){if(e._rev!==r)throw l.createError(l.REV_CONFLICT);return s(e)},function(e){if(e.reason===l.MISSING_DOC.message)return s({_id:t});throw e})}),y.prototype.removeAttachment=c.adapterFun(\"removeAttachment\",function(e,n,r,i){var o=this;o.get(e,function(e,t){if(e)i(e);else if(t._rev===r){if(!t._attachments)return i();delete t._attachments[n],0===Object.keys(t._attachments).length&&delete t._attachments,o.put(t,i)}else i(l.createError(l.REV_CONFLICT))})}),y.prototype.remove=c.adapterFun(\"remove\",function(e,t,n,r){var i;\"string\"==typeof t?(i={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(i=e,n=\"function\"==typeof t?(r=t,{}):(r=n,t)),(n=n||{}).was_delete=!0;var o={_id:i._id,_rev:i._rev||n.rev,_deleted:!0};if(S.isLocalId(o._id)&&\"function\"==typeof this._removeLocal)return this._removeLocal(i,r);this.bulkDocs({docs:[o]},n,v(r,o._id))}),y.prototype.revsDiff=c.adapterFun(\"revsDiff\",function(i,e,o){\"function\"==typeof e&&(o=e,e={});var a=Object.keys(i);if(!a.length)return o(null,{});var s=0,u=new f.Map;function c(e,t){u.has(e)||u.set(e,{missing:[]}),u.get(e).missing.push(t)}a.map(function(r){this._getRevisionTree(r,function(e,t){if(e&&404===e.status&&\"missing\"===e.message)u.set(r,{missing:i[r]});else{if(e)return o(e);!function(s,e){var u=i[s].slice(0);S.traverseRevTree(e,function(e,t,n,r,i){var o=t+\"-\"+n,a=u.indexOf(o);-1!==a&&(u.splice(a,1),\"available\"!==i.status&&c(s,o))}),u.forEach(function(e){c(s,e)})}(r,t)}if(++s===a.length){var n={};return u.forEach(function(e,t){n[t]=e}),o(null,n)}})},this)}),y.prototype.bulkGet=c.adapterFun(\"bulkGet\",function(e,t){c.bulkGetShim(this,e,t)}),y.prototype.compactDocument=c.adapterFun(\"compactDocument\",function(r,i,o){var u=this;this._getRevisionTree(r,function(e,t){if(e)return o(e);var n=function(e){var o={},a=[];return S.traverseRevTree(e,function(e,t,n,r){var i=t+\"-\"+n;return e&&(o[i]=0),void 0!==r&&a.push({from:r,to:i}),i}),a.reverse(),a.forEach(function(e){void 0===o[e.from]?o[e.from]=1+o[e.to]:o[e.from]=Math.min(o[e.from],1+o[e.to])}),o}(t),a=[],s=[];Object.keys(n).forEach(function(e){n[e]>i&&a.push(e)}),S.traverseRevTree(t,function(e,t,n,r,i){var o=t+\"-\"+n;\"available\"===i.status&&-1!==a.indexOf(o)&&s.push(o)}),u._doCompaction(r,s,o)})}),y.prototype.compact=c.adapterFun(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={});e=e||{},this._compactionQueue=this._compactionQueue||[],this._compactionQueue.push({opts:e,callback:t}),1===this._compactionQueue.length&&function n(r){var e=r._compactionQueue[0],t=e.opts,i=e.callback;r.get(\"_local/compaction\").catch(function(){return!1}).then(function(e){e&&e.last_seq&&(t.last_seq=e.last_seq),r._compact(t,function(e,t){e?i(e):i(null,t),c.nextTick(function(){r._compactionQueue.shift(),r._compactionQueue.length&&n(r)})})})}(this)}),y.prototype._compact=function(e,n){var r=this,t={return_docs:!1,last_seq:e.last_seq||0},i=[];r.changes(t).on(\"change\",function(e){i.push(r.compactDocument(e.id,0))}).on(\"complete\",function(e){var t=e.last_seq;Promise.all(i).then(function(){return c.upsert(r,\"_local/compaction\",function(e){return(!e.last_seq||e.last_seq<t)&&(e.last_seq=t,e)})}).then(function(){n(null,{ok:!0})}).catch(n)}).on(\"error\",n)},y.prototype.get=c.adapterFun(\"get\",function(b,w,k){if(\"function\"==typeof w&&(k=w,w={}),\"string\"!=typeof b)return k(l.createError(l.INVALID_ID));if(S.isLocalId(b)&&\"function\"==typeof this._getLocal)return this._getLocal(b,k);var n=[],E=this;function r(){var a=[],s=n.length;if(!s)return k(null,a);n.forEach(function(o){E.get(b,{rev:o,revs:w.revs,latest:w.latest,attachments:w.attachments,binary:w.binary},function(e,t){if(e)a.push({missing:o});else{for(var n,r=0,i=a.length;r<i;r++)if(a[r].ok&&a[r].ok._rev===t._rev){n=!0;break}n||a.push({ok:t})}--s||k(null,a)})})}if(!w.open_revs)return this._get(b,w,function(e,t){if(e)return e.docId=b,k(e);var i=t.doc,n=t.metadata,o=t.ctx;if(w.conflicts){var r=S.collectConflicts(n);r.length&&(i._conflicts=r)}if(S.isDeleted(n,i._rev)&&(i._deleted=!0),w.revs||w.revs_info){for(var a=i._rev.split(\"-\"),s=parseInt(a[0],10),u=a[1],c=S.rootToLeaf(n.rev_tree),f=null,l=0;l<c.length;l++){var h=c[l],d=h.ids.map(function(e){return e.id}).indexOf(u);(d===s-1||!f&&-1!==d)&&(f=h)}var p=f.ids.map(function(e){return e.id}).indexOf(i._rev.split(\"-\")[1])+1,v=f.ids.length-p;if(f.ids.splice(p,v),f.ids.reverse(),w.revs&&(i._revisions={start:f.pos+f.ids.length-1,ids:f.ids.map(function(e){return e.id})}),w.revs_info){var g=f.pos+f.ids.length;i._revs_info=f.ids.map(function(e){return{rev:--g+\"-\"+e.id,status:e.opts.status}})}}if(w.attachments&&i._attachments){var y=i._attachments,_=Object.keys(y).length;if(0===_)return k(null,i);Object.keys(y).forEach(function(r){this._getAttachment(i._id,r,y[r],{rev:i._rev,binary:w.binary,ctx:o},function(e,t){var n=i._attachments[r];n.data=t,delete n.stub,delete n.length,--_||k(null,i)})},E)}else{if(i._attachments)for(var m in i._attachments)i._attachments.hasOwnProperty(m)&&(i._attachments[m].stub=!0);k(null,i)}});if(\"all\"===w.open_revs)this._getRevisionTree(b,function(e,t){if(e)return k(e);n=S.collectLeaves(t).map(function(e){return e.rev}),r()});else{if(!Array.isArray(w.open_revs))return k(l.createError(l.UNKNOWN_ERROR,\"function_clause\"));n=w.open_revs;for(var e=0;e<n.length;e++){var t=n[e];if(\"string\"!=typeof t||!/^\\d+-/.test(t))return k(l.createError(l.INVALID_REV))}r()}}),y.prototype.getAttachment=c.adapterFun(\"getAttachment\",function(n,r,i,o){var a=this;i instanceof Function&&(o=i,i={}),this._get(n,i,function(e,t){return e?o(e):t.doc._attachments&&t.doc._attachments[r]?(i.ctx=t.ctx,i.binary=!0,void a._getAttachment(n,r,t.doc._attachments[r],i,o)):o(l.createError(l.MISSING_DOC))})}),y.prototype.allDocs=c.adapterFun(\"allDocs\",function(t,e){if(\"function\"==typeof t&&(e=t,t={}),t.skip=void 0!==t.skip?t.skip:0,t.start_key&&(t.startkey=t.start_key),t.end_key&&(t.endkey=t.end_key),\"keys\"in t){if(!Array.isArray(t.keys))return e(new TypeError(\"options.keys must be an array\"));var n=[\"startkey\",\"endkey\",\"key\"].filter(function(e){return e in t})[0];if(n)return void e(l.createError(l.QUERY_PARSE_ERROR,\"Query parameter `\"+n+\"` is not compatible with multi-get\"));if(!c.isRemote(this)&&(function(e){var t=\"limit\"in e?e.keys.slice(e.skip,e.limit+e.skip):0<e.skip?e.keys.slice(e.skip):e.keys;e.keys=t,e.skip=0,delete e.limit,e.descending&&(t.reverse(),e.descending=!1)}(t),0===t.keys.length))return this._allDocs({limit:0},e)}return this._allDocs(t,e)}),y.prototype.changes=function(e,t){return\"function\"==typeof e&&(t=e,e={}),(e=e||{}).return_docs=\"return_docs\"in e?e.return_docs:!e.live,new h(this,e,t)},y.prototype.close=c.adapterFun(\"close\",function(e){return this._closed=!0,this.emit(\"closed\"),this._close(e)}),y.prototype.info=c.adapterFun(\"info\",function(n){var r=this;this._info(function(e,t){if(e)return n(e);t.db_name=t.db_name||r.name,t.auto_compaction=!(!r.auto_compaction||c.isRemote(r)),t.adapter=r.adapter,n(null,t)})}),y.prototype.id=c.adapterFun(\"id\",function(e){return this._id(e)}),y.prototype.type=function(){return\"function\"==typeof this._type?this._type():this.adapter},y.prototype.bulkDocs=c.adapterFun(\"bulkDocs\",function(e,i,o){if(\"function\"==typeof i&&(o=i,i={}),i=i||{},Array.isArray(e)&&(e={docs:e}),!e||!e.docs||!Array.isArray(e.docs))return o(l.createError(l.MISSING_BULK_DOCS));for(var t=0;t<e.docs.length;++t)if(\"object\"!=typeof e.docs[t]||Array.isArray(e.docs[t]))return o(l.createError(l.NOT_AN_OBJECT));var n;if(e.docs.forEach(function(t){t._attachments&&Object.keys(t._attachments).forEach(function(e){n=n||function(e){return\"_\"===e.charAt(0)&&e+\" is not a valid attachment name, attachment names cannot start with '_'\"}(e),t._attachments[e].content_type||c.guardedConsole(\"warn\",\"Attachment\",e,\"on document\",t._id,\"is missing content_type\")})}),n)return o(l.createError(l.BAD_REQUEST,n));\"new_edits\"in i||(i.new_edits=!(\"new_edits\"in e)||e.new_edits);var a=this;i.new_edits||c.isRemote(a)||e.docs.sort(g),function(e){for(var t=0;t<e.length;t++){var n=e[t];if(n._deleted)delete n._attachments;else if(n._attachments)for(var r=Object.keys(n._attachments),i=0;i<r.length;i++){var o=r[i];n._attachments[o]=c.pick(n._attachments[o],[\"data\",\"digest\",\"content_type\",\"length\",\"revpos\",\"stub\"])}}}(e.docs);var s=e.docs.map(function(e){return e._id});return this._bulkDocs(e,i,function(e,t){if(e)return o(e);if(i.new_edits||(t=t.filter(function(e){return e.error})),!c.isRemote(a))for(var n=0,r=t.length;n<r;n++)t[n].id=t[n].id||s[n];o(null,t)})}),y.prototype.registerDependentDatabase=c.adapterFun(\"registerDependentDatabase\",function(t,e){var n=new this.constructor(t,this.__opts);c.upsert(this,\"_local/_pouch_dependentDbs\",function(e){return e.dependentDbs=e.dependentDbs||{},!e.dependentDbs[t]&&(e.dependentDbs[t]=!0,e)}).then(function(){e(null,{db:n})}).catch(e)}),y.prototype.destroy=c.adapterFun(\"destroy\",function(e,o){\"function\"==typeof e&&(o=e,e={});var a=this,s=!(\"use_prefix\"in a)||a.use_prefix;function u(){a._destroy(e,function(e,t){if(e)return o(e);a._destroyed=!0,a.emit(\"destroyed\"),o(null,t||{ok:!0})})}if(c.isRemote(a))return u();a.get(\"_local/_pouch_dependentDbs\",function(e,t){if(e)return 404!==e.status?o(e):u();var n=t.dependentDbs,r=a.constructor,i=Object.keys(n).map(function(e){var t=s?e.replace(new RegExp(\"^\"+r.prefix),\"\"):e;return new r(t,a.__opts).destroy()});Promise.all(i).then(u,o)})}),_.prototype.execute=function(){var e;if(this.failed)for(;e=this.queue.shift();)e(this.failed);else for(;e=this.queue.shift();)e()},_.prototype.fail=function(e){this.failed=e,this.execute()},_.prototype.ready=function(e){this.isReady=!0,this.db=e,this.execute()},_.prototype.addTask=function(e){this.queue.push(e),this.failed&&this.execute()},i(m,y),m.adapters={},m.preferredAdapters=[],m.prefix=\"_pouch_\";var b=new s.EventEmitter;!function(t){Object.keys(s.EventEmitter.prototype).forEach(function(e){\"function\"==typeof s.EventEmitter.prototype[e]&&(t[e]=b[e].bind(b))});var r=t._destructionListeners=new f.Map;t.on(\"ref\",function(e){r.has(e.name)||r.set(e.name,[]),r.get(e.name).push(e)}),t.on(\"unref\",function(e){if(r.has(e.name)){var t=r.get(e.name),n=t.indexOf(e);n<0||(t.splice(n,1),1<t.length?r.set(e.name,t):r.delete(e.name))}}),t.on(\"destroyed\",function(e){if(r.has(e)){var t=r.get(e);r.delete(e),t.forEach(function(e){e.emit(\"destroyed\",!0)})}})}(m),m.adapter=function(e,t,n){t.valid()&&(m.adapters[e]=t,n&&m.preferredAdapters.push(e))},m.plugin=function(t){if(\"function\"==typeof t)t(m);else{if(\"object\"!=typeof t||0===Object.keys(t).length)throw new Error('Invalid plugin: got \"'+t+'\", expected an object or a function');Object.keys(t).forEach(function(e){m.prototype[e]=t[e]})}return this.__defaults&&(m.__defaults=c.assign({},this.__defaults)),m},m.defaults=function(e){function n(e,t){if(!(this instanceof n))return new n(e,t);t=t||{},e&&\"object\"==typeof e&&(e=(t=e).name,delete t.name),t=c.assign({},n.__defaults,t),m.call(this,e,t)}return i(n,m),n.preferredAdapters=m.preferredAdapters.slice(),Object.keys(m).forEach(function(e){e in n||(n[e]=m[e])}),n.__defaults=c.assign({},this.__defaults,e),n},m.fetch=function(e,t){return o.fetch(e,t)};m.plugin(u),m.version=\"7.0.0\",t.exports=m},{12:12,33:33,66:66,69:69,71:71,72:72,74:74,81:81,85:85}],71:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14}],72:[function(e,t,n){\"use strict\";var r;function i(e,t,n){Error.call(this,n),this.status=e,this.name=t,this.message=n,this.error=!0}Object.defineProperty(n,\"__esModule\",{value:!0}),((r=e(73))&&\"object\"==typeof r&&\"default\"in r?r.default:r)(i,Error),i.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var o=new i(401,\"unauthorized\",\"Name or password is incorrect.\"),a=new i(400,\"bad_request\",\"Missing JSON list of 'docs'\"),s=new i(404,\"not_found\",\"missing\"),u=new i(409,\"conflict\",\"Document update conflict\"),c=new i(400,\"bad_request\",\"_id field must contain a string\"),f=new i(412,\"missing_id\",\"_id is required for puts\"),l=new i(400,\"bad_request\",\"Only reserved document ids may start with underscore.\"),h=new i(412,\"precondition_failed\",\"Database not open\"),d=new i(500,\"unknown_error\",\"Database encountered an unknown error\"),p=new i(500,\"badarg\",\"Some query argument is invalid\"),v=new i(400,\"invalid_request\",\"Request was invalid\"),g=new i(400,\"query_parse_error\",\"Some query parameter is invalid\"),y=new i(500,\"doc_validation\",\"Bad special document member\"),_=new i(400,\"bad_request\",\"Something wrong with the request\"),m=new i(400,\"bad_request\",\"Document must be a JSON object\"),b=new i(404,\"not_found\",\"Database not found\"),w=new i(500,\"indexed_db_went_bad\",\"unknown\"),k=new i(500,\"web_sql_went_bad\",\"unknown\"),E=new i(500,\"levelDB_went_went_bad\",\"unknown\"),S=new i(403,\"forbidden\",\"Forbidden by design doc validate_doc_update function\"),x=new i(400,\"bad_request\",\"Invalid rev format\"),O=new i(412,\"file_exists\",\"The database could not be created, the file already exists.\"),C=new i(412,\"missing_stub\",\"A pre-existing attachment stub wasn't found\"),A=new i(413,\"invalid_url\",\"Provided URL is invalid\");n.UNAUTHORIZED=o,n.MISSING_BULK_DOCS=a,n.MISSING_DOC=s,n.REV_CONFLICT=u,n.INVALID_ID=c,n.MISSING_ID=f,n.RESERVED_ID=l,n.NOT_OPEN=h,n.UNKNOWN_ERROR=d,n.BAD_ARG=p,n.INVALID_REQUEST=v,n.QUERY_PARSE_ERROR=g,n.DOC_VALIDATION=y,n.BAD_REQUEST=_,n.NOT_AN_OBJECT=m,n.DB_MISSING=b,n.WSQ_ERROR=k,n.LDB_ERROR=E,n.FORBIDDEN=S,n.INVALID_REV=x,n.FILE_EXISTS=O,n.MISSING_STUB=C,n.IDB_ERROR=w,n.INVALID_URL=A,n.createError=function(n,e){function t(e){for(var t in n)\"function\"!=typeof n[t]&&(this[t]=n[t]);void 0!==e&&(this.reason=e)}return t.prototype=i.prototype,new t(e)},n.generateErrorFromResponse=function(e){if(\"object\"!=typeof e){var t=e;(e=d).data=t}return\"error\"in e&&\"conflict\"===e.error&&(e.name=\"conflict\",e.status=409),\"name\"in e||(e.name=e.error||\"unknown\"),\"status\"in e||(e.status=500),\"message\"in e||(e.message=e.message||e.reason),e}},{73:73}],73:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14}],74:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var r=\"undefined\"!=typeof AbortController?AbortController:function(){return{abort:function(){}}},i=fetch,o=Headers;n.fetch=i,n.Headers=o,n.AbortController=r},{}],75:[function(e,t,n){\"use strict\";var u=e(80),c=e(68);t.exports=function(e,t,n){var r=n.doc_ids?n.doc_ids.sort(c.collate):\"\",i=n.filter?n.filter.toString():\"\",o=\"\",a=\"\",s=\"\";return n.selector&&(s=JSON.stringify(n.selector)),n.filter&&n.query_params&&(o=JSON.stringify(function(n){return Object.keys(n).sort(c.collate).reduce(function(e,t){return e[t]=n[t],e},{})}(n.query_params))),n.filter&&\"_view\"===n.filter&&(a=n.view.toString()),Promise.all([e.id(),t.id()]).then(function(e){var t=e[0]+e[1]+i+a+o+r+s;return new Promise(function(e){u.binaryMd5(t,e)})}).then(function(e){return\"_local/\"+(e=e.replace(/\\//g,\".\").replace(/\\+/g,\"_\"))})}},{68:68,80:80}],76:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var r,i=(r=e(129))&&\"object\"==typeof r&&\"default\"in r?r.default:r;n.safeJsonParse=function(t){try{return JSON.parse(t)}catch(e){return i.parse(t)}},n.safeJsonStringify=function(t){try{return JSON.stringify(t)}catch(e){return i.stringify(t)}}},{129:129}],77:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}Object.defineProperty(n,\"__esModule\",{value:!0});var i=r(e(78)),o=e(69),a=r(e(12)),s=e(85);function u(e){this.status=400,this.name=\"query_parse_error\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,u)}catch(e){}}function c(e){this.status=404,this.name=\"not_found\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,c)}catch(e){}}function f(e){this.status=500,this.name=\"invalid_value\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,f)}catch(e){}}function l(e,t){return t&&e.then(function(e){s.nextTick(function(){t(null,e)})},function(e){s.nextTick(function(){t(e)})}),e}i(u,Error),i(c,Error),i(f,Error),n.uniq=function(e){var t=new o.Set(e),n=new Array(t.size),r=-1;return t.forEach(function(e){n[++r]=e}),n},n.sequentialize=function(n,r){return function(){var e=arguments,t=this;return n.add(function(){return r.apply(t,e)})}},n.fin=function(e,t){return e.then(function(e){return t().then(function(){return e})},function(e){return t().then(function(){throw e})})},n.callbackify=function(r){return a(function(e){var t=e.pop(),n=r.apply(this,e);return\"function\"==typeof t&&l(n,t),n})},n.promisedCallback=l,n.mapToKeysArray=function(e){var n=new Array(e.size),r=-1;return e.forEach(function(e,t){n[++r]=t}),n},n.QueryParseError=u,n.NotFoundError=c,n.BuiltInError=f},{12:12,69:69,78:78,85:85}],78:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14}],79:[function(e,t,n){\"use strict\";var r,i=e(77),o=e(85),a=(r=e(59))&&\"object\"==typeof r&&\"default\"in r?r.default:r;function u(e){var t=\"builtin \"+e+\" function requires map values to be numbers or number arrays\";return new i.BuiltInError(t)}function s(e){for(var t=0,n=0,r=e.length;n<r;n++){var i=e[n];if(\"number\"!=typeof i){if(!Array.isArray(i))throw u(\"_sum\");t=\"number\"==typeof t?[t]:t;for(var o=0,a=i.length;o<a;o++){var s=i[o];if(\"number\"!=typeof s)throw u(\"_sum\");void 0===t[o]?t.push(s):t[o]+=s}}else\"number\"==typeof t?t+=i:t[0]+=i}return t}var c=o.guardedConsole.bind(null,\"log\"),f=Array.isArray,l=JSON.parse;function h(e,t){return o.scopeEval(\"return (\"+e.replace(/;\\s*$/,\"\")+\");\",{emit:t,sum:s,log:c,isArray:f,toJSON:l})}var d={_sum:function(e,t){return s(t)},_count:function(e,t){return t.length},_stats:function(e,t){return{sum:s(t),min:Math.min.apply(null,t),max:Math.max.apply(null,t),count:t.length,sumsqr:function(e){for(var t=0,n=0,r=e.length;n<r;n++){var i=e[n];t+=i*i}return t}(t)}}};var p=a(\"mrviews\",function(e,t){if(\"function\"!=typeof e||2!==e.length)return h(e.toString(),t);var n=e;return function(e){return n(e,t)}},function(e){var t=e.toString(),n=function(e){if(/^_sum/.test(e))return d._sum;if(/^_count/.test(e))return d._count;if(/^_stats/.test(e))return d._stats;if(/^_/.test(e))throw new Error(e+\" is not a supported reduce function.\")}(t);return n||h(t)},function(e,t){var n=e.views&&e.views[t];if(\"string\"!=typeof n.map)throw new i.NotFoundError(\"ddoc \"+e._id+\" has no string view named \"+t+\", instead found object of type: \"+typeof n.map)});var v={query:function(e,t,n){return p.query.call(this,e,t,n)},viewCleanup:function(e){return p.viewCleanup.call(this,e)}};t.exports=v},{59:59,77:77,85:85}],80:[function(n,e,r){(function(e){\"use strict\";Object.defineProperty(r,\"__esModule\",{value:!0});var t,h=n(65),d=(t=n(105))&&\"object\"==typeof t&&\"default\"in t?t.default:t,p=e.setImmediate||e.setTimeout;function v(t,e,n,r,i){(0<n||r<e.size)&&(e=function(e,t,n){return e.webkitSlice?e.webkitSlice(t,n):e.slice(t,n)}(e,n,r)),h.readAsArrayBuffer(e,function(e){t.append(e),i()})}function g(e,t,n,r,i){(0<n||r<t.length)&&(t=t.substring(n,r)),e.appendBinary(t),i()}r.binaryMd5=function(n,t){var e=\"string\"==typeof n,r=e?n.length:n.size,i=Math.min(32768,r),o=Math.ceil(r/i),a=0,s=e?new d:new d.ArrayBuffer,u=e?g:v;function c(){p(l)}function f(){var e=function(e){return h.btoa(e)}(s.end(!0));t(e),s.destroy()}function l(){var e=a*i,t=e+i;u(s,n,e,t,++a<o?c:f)}l()},r.stringMd5=function(e){return d.hash(e)}}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{105:105,65:65}],81:[function(e,t,n){\"use strict\";function s(e){for(var t,n,r,i,o=e.rev_tree.slice();i=o.pop();){var a=i.ids,s=a[2],u=i.pos;if(s.length)for(var c=0,f=s.length;c<f;c++)o.push({pos:u+1,ids:s[c]});else{var l=!!a[1].deleted,h=a[0];t&&!(r!==l?r:n!==u?n<u:t<h)||(t=h,n=u,r=l)}}return n+\"-\"+t}function d(e,t){for(var n,r=e.slice();n=r.pop();)for(var i=n.pos,o=n.ids,a=o[2],s=t(0===a.length,i,o[0],n.ctx,o[1]),u=0,c=a.length;u<c;u++)r.push({pos:i+1,ids:a[u],ctx:s})}function r(e,t){return e.pos-t.pos}function u(e){var o=[];d(e,function(e,t,n,r,i){e&&o.push({rev:t+\"-\"+n,pos:t,opts:i})}),o.sort(r).reverse();for(var t=0,n=o.length;t<n;t++)delete o[t].pos;return o}function p(e){for(var t,n=[],r=e.slice();t=r.pop();){var i=t.pos,o=t.ids,a=o[0],s=o[1],u=o[2],c=0===u.length,f=t.history?t.history.slice():[];f.push({id:a,opts:s}),c&&n.push({pos:i+1-f.length,ids:f});for(var l=0,h=u.length;l<h;l++)r.push({pos:i+1,ids:u[l],history:f})}return n.reverse()}function b(e,t){return e.pos-t.pos}function v(e,t){for(var n,r,i=t,o=e.length;i<o;i++){var a=e[i],s=[a.id,a.opts,[]];r?(r[2].push(s),r=s):n=r=s}return n}function g(e,t){return e[0]<t[0]?-1:1}function w(e,t){for(var n,r,i,o=[{tree1:e,tree2:t}],a=!1;0<o.length;){var s=o.pop(),u=s.tree1,c=s.tree2;(u[1].status||c[1].status)&&(u[1].status=\"available\"===u[1].status||\"available\"===c[1].status?\"available\":\"missing\");for(var f=0;f<c[2].length;f++)if(u[2][0]){for(var l=!1,h=0;h<u[2].length;h++)u[2][h][0]===c[2][f][0]&&(o.push({tree1:u[2][h],tree2:c[2][f]}),l=!0);l||(a=\"new_branch\",n=u[2],r=c[2][f],void 0,i=function(e,t,n){for(var r,i=0,o=e.length;i<o;)n(e[r=i+o>>>1],t)<0?i=1+r:o=r;return i}(n,r,g),n.splice(i,0,r))}else a=\"new_leaf\",u[2][0]=c[2][f]}return{conflicts:a,tree:e}}function y(e,t,n){var r,i=[],o=!1,a=!1;if(!e.length)return{tree:[t],conflicts:\"new_leaf\"};for(var s=0,u=e.length;s<u;s++){var c=e[s];if(c.pos===t.pos&&c.ids[0]===t.ids[0])r=w(c.ids,t.ids),i.push({pos:c.pos,ids:r.tree}),o=o||r.conflicts,a=!0;else if(!0!==n){var f=c.pos<t.pos?c:t,l=c.pos<t.pos?t:c,h=l.pos-f.pos,d=[],p=[];for(p.push({ids:f.ids,diff:h,parent:null,parentIdx:null});0<p.length;){var v=p.pop();if(0!==v.diff)for(var g=v.ids[2],y=0,_=g.length;y<_;y++)p.push({ids:g[y],diff:v.diff-1,parent:v.ids,parentIdx:y});else v.ids[0]===l.ids[0]&&d.push(v)}var m=d[0];m?(r=w(m.ids,l.ids),m.parent[2][m.parentIdx]=r.tree,i.push({pos:f.pos,ids:f.ids}),o=o||r.conflicts,a=!0):i.push(c)}else i.push(c)}return a||i.push(t),i.sort(b),{tree:i,conflicts:o||\"internal_node\"}}function o(e){return e.ids}Object.defineProperty(n,\"__esModule\",{value:!0}),n.collectConflicts=function(e){for(var t=s(e),n=u(e.rev_tree),r=[],i=0,o=n.length;i<o;i++){var a=n[i];a.rev===t||a.opts.deleted||r.push(a.rev)}return r},n.collectLeaves=u,n.compactTree=function(e){var o=[];return d(e.rev_tree,function(e,t,n,r,i){\"available\"!==i.status||e||(o.push(t+\"-\"+n),i.status=\"missing\")}),o},n.isDeleted=function(e,t){for(var n,r=(t=t||s(e)).substring(t.indexOf(\"-\")+1),i=e.rev_tree.map(o);n=i.pop();){if(n[0]===r)return!!n[1].deleted;i=i.concat(n[2])}},n.isLocalId=function(e){return/^_local/.test(e)},n.merge=function(e,t,n){var r=y(e,t),i=function(e,t){for(var r,n,i=p(e),o=0,a=i.length;o<a;o++){var s,u=i[o],c=u.ids;if(c.length>t){r=r||{};var f=c.length-t;s={pos:u.pos+f,ids:v(c,f)};for(var l=0;l<f;l++){var h=u.pos+l+\"-\"+c[l].id;r[h]=!0}}else s={pos:u.pos,ids:v(c,0)};n=n?y(n,s,!0).tree:[s]}return r&&d(n,function(e,t,n){delete r[t+\"-\"+n]}),{tree:n,revs:r?Object.keys(r):[]}}(r.tree,n);return{tree:i.tree,stemmedRevs:i.revs,conflicts:r.conflicts}},n.revExists=function(e,t){for(var n,r=e.slice(),i=t.split(\"-\"),o=parseInt(i[0],10),a=i[1];n=r.pop();){if(n.pos===o&&n.ids[0]===a)return!0;for(var s=n.ids[2],u=0,c=s.length;u<c;u++)r.push({pos:n.pos+1,ids:s[u]})}return!1},n.rootToLeaf=p,n.traverseRevTree=d,n.winningRev=s,n.latest=function(e,t){for(var n,r=t.rev_tree.slice();n=r.pop();){var i=n.pos,o=n.ids,a=o[0],s=o[1],u=o[2],c=0===u.length,f=n.history?n.history.slice():[];if(f.push({id:a,pos:i,opts:s}),c)for(var l=0,h=f.length;l<h;l++){var d=f[l];if(d.pos+\"-\"+d.id===e)return i+\"-\"+a}for(var p=0,v=u.length;p<v;p++)r.push({pos:i+1,ids:u[p],history:f})}throw new Error(\"Unable to resolve latest revision for id \"+t.id+\", rev \"+e)}},{}],82:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}var N=e(85),M=r(e(67)),P=r(e(75)),F=e(72),i=e(33),o=r(e(83));function u(e){return/^1-/.test(e)}function c(t,n){var e=Object.keys(n._attachments);return Promise.all(e.map(function(e){return t.getAttachment(n._id,e,{rev:n._rev})}))}function U(t,n,r,i){r=N.clone(r);var o=[],a=!0;function s(e){return t.allDocs({keys:e,include_docs:!0,conflicts:!0}).then(function(e){if(i.cancelled)throw new Error(\"cancelled\");e.rows.forEach(function(e){e.deleted||!e.doc||!u(e.value.rev)||function(e){return e._attachments&&0<Object.keys(e._attachments).length}(e.doc)||function(e){return e._conflicts&&0<e._conflicts.length}(e.doc)||(e.doc._conflicts&&delete e.doc._conflicts,o.push(e.doc),delete r[e.id])})})}return Promise.resolve().then(function(){var e=Object.keys(r).filter(function(e){var t=r[e].missing;return 1===t.length&&u(t[0])});if(0<e.length)return s(e)}).then(function(){var e=function(e){var n=[];return Object.keys(e).forEach(function(t){e[t].missing.forEach(function(e){n.push({id:t,rev:e})})}),{docs:n,revs:!0,latest:!0}}(r);if(e.docs.length)return t.bulkGet(e).then(function(e){if(i.cancelled)throw new Error(\"cancelled\");return Promise.all(e.results.map(function(e){return Promise.all(e.docs.map(function(e){var i=e.ok;return e.error&&(a=!1),i&&i._attachments?function(n,r,i){var e=N.isRemote(r)&&!N.isRemote(n),o=Object.keys(i._attachments);return e?n.get(i._id).then(function(t){return Promise.all(o.map(function(e){return function(e,t,n){return!e._attachments||!e._attachments[n]||e._attachments[n].digest!==t._attachments[n].digest}(t,i,e)?r.getAttachment(i._id,e):n.getAttachment(t._id,e)}))}).catch(function(e){if(404!==e.status)throw e;return c(r,i)}):c(r,i)}(n,t,i).then(function(e){var r=Object.keys(i._attachments);return e.forEach(function(e,t){var n=i._attachments[r[t]];delete n.stub,delete n.length,n.data=e}),i}):i}))})).then(function(e){o=o.concat(N.flatten(e).filter(Boolean))})})}).then(function(){return{ok:a,docs:o}})}var $=0;function z(r,i,o,a,s){var u,n,c,f=[],l={seq:0,changes:[],docs:[]},h=!1,d=!1,p=!1,v=0,g=o.continuous||o.live||!1,t=o.batch_size||100,y=o.batches_limit||10,_=!1,m=o.doc_ids,b=o.selector,w=[],k=N.uuid();s=s||{ok:!0,start_time:(new Date).toISOString(),docs_read:0,docs_written:0,doc_write_failures:0,errors:[]};var E={};function e(){return c?Promise.resolve():P(r,i,o).then(function(e){n=e;var t={};t=!1===o.checkpoint?{writeSourceCheckpoint:!1,writeTargetCheckpoint:!1}:\"source\"===o.checkpoint?{writeSourceCheckpoint:!0,writeTargetCheckpoint:!1}:\"target\"===o.checkpoint?{writeSourceCheckpoint:!1,writeTargetCheckpoint:!0}:{writeSourceCheckpoint:!0,writeTargetCheckpoint:!0},c=new M(r,i,n,a,t)})}function S(){if(w=[],0!==u.docs.length){var n=u.docs,e={timeout:o.timeout};return i.bulkDocs({docs:n,new_edits:!1},e).then(function(e){if(a.cancelled)throw B(),new Error(\"cancelled\");var r=Object.create(null);e.forEach(function(e){e.error&&(r[e.id]=e)});var t=Object.keys(r).length;s.doc_write_failures+=t,s.docs_written+=n.length-t,n.forEach(function(e){var t=r[e._id];if(t){s.errors.push(t);var n=(t.name||\"\").toLowerCase();if(\"unauthorized\"!==n&&\"forbidden\"!==n)throw t;a.emit(\"denied\",N.clone(t))}else w.push(e)})},function(e){throw s.doc_write_failures+=n.length,e})}}function x(){if(u.error)throw new Error(\"There was a problem getting docs.\");s.last_seq=v=u.seq;var e=N.clone(s);return w.length&&(e.docs=w,\"number\"==typeof u.pending&&(e.pending=u.pending,delete u.pending),a.emit(\"change\",e)),h=!0,c.writeCheckpoint(u.seq,k).then(function(){if(h=!1,a.cancelled)throw B(),new Error(\"cancelled\");u=void 0,q()}).catch(function(e){throw L(e),e})}function O(){return U(r,i,u.diffs,a).then(function(e){u.error=!e.ok,e.docs.forEach(function(e){delete u.diffs[e._id],s.docs_read++,u.docs.push(e)})})}function C(){a.cancelled||u||(0!==f.length?(u=f.shift(),function(){var t={};return u.changes.forEach(function(e){\"_user/\"!==e.id&&(t[e.id]=e.changes.map(function(e){return e.rev}))}),i.revsDiff(t).then(function(e){if(a.cancelled)throw B(),new Error(\"cancelled\");u.diffs=e})}().then(O).then(S).then(x).then(C).catch(function(e){j(\"batch processing terminated with error\",e)})):A(!0))}function A(e){0!==l.changes.length?(e||d||l.changes.length>=t)&&(f.push(l),l={seq:0,changes:[],docs:[]},\"pending\"!==a.state&&\"stopped\"!==a.state||(a.state=\"active\",a.emit(\"active\")),C()):0!==f.length||u||((g&&E.live||d)&&(a.state=\"pending\",a.emit(\"paused\")),d&&B())}function j(e,t){p||(t.message||(t.message=e),s.ok=!1,s.status=\"aborting\",f=[],l={seq:0,changes:[],docs:[]},B(t))}function B(e){if(!(p||a.cancelled&&(s.status=\"cancelled\",h)))if(s.status=s.status||\"complete\",s.end_time=(new Date).toISOString(),s.last_seq=v,p=!0,e){(e=F.createError(e)).result=s;var t=(e.name||\"\").toLowerCase();\"unauthorized\"===t||\"forbidden\"===t?(a.emit(\"error\",e),a.removeAllListeners()):function(e,t,n,r){if(!1===e.retry)return t.emit(\"error\",n),t.removeAllListeners();if(\"function\"!=typeof e.back_off_function&&(e.back_off_function=N.defaultBackOff),t.emit(\"requestError\",n),\"active\"===t.state||\"pending\"===t.state){t.emit(\"paused\",n),t.state=\"stopped\";var i=function(){e.current_back_off=$};t.once(\"paused\",function(){t.removeListener(\"active\",i)}),t.once(\"active\",i)}e.current_back_off=e.current_back_off||$,e.current_back_off=e.back_off_function(e.current_back_off),setTimeout(r,e.current_back_off)}(o,a,e,function(){z(r,i,o,a)})}else a.emit(\"complete\",s),a.removeAllListeners()}function I(e,t,n){if(a.cancelled)return B();\"number\"==typeof t&&(l.pending=t),N.filterChange(o)(e)&&(l.seq=e.seq||n,l.changes.push(e),N.nextTick(function(){A(0===f.length&&E.live)}))}function T(e){if(_=!1,a.cancelled)return B();if(0<e.results.length)E.since=e.results[e.results.length-1].seq,q(),A(!0);else{var t=function(){g?(E.live=!0,q()):d=!0,A(!0)};u||0!==e.results.length?t():(h=!0,c.writeCheckpoint(e.last_seq,k).then(function(){h=!1,s.last_seq=v=e.last_seq,t()}).catch(L))}}function R(e){if(_=!1,a.cancelled)return B();j(\"changes rejected\",e)}function q(){if(!_&&!d&&f.length<y){_=!0,a._changes&&(a.removeListener(\"cancel\",a._abortChanges),a._changes.cancel()),a.once(\"cancel\",t);var e=r.changes(E).on(\"change\",I);e.then(n,n),e.then(T).catch(R),o.retry&&(a._changes=e,a._abortChanges=t)}function t(){e.cancel()}function n(){a.removeListener(\"cancel\",t)}}function D(){e().then(function(){if(!a.cancelled)return c.getCheckpoint().then(function(e){E={since:v=e,limit:t,batch_size:t,style:\"all_docs\",doc_ids:m,selector:b,return_docs:!0},o.filter&&(\"string\"!=typeof o.filter?E.include_docs=!0:E.filter=o.filter),\"heartbeat\"in o&&(E.heartbeat=o.heartbeat),\"timeout\"in o&&(E.timeout=o.timeout),o.query_params&&(E.query_params=o.query_params),o.view&&(E.view=o.view),q()});B()}).catch(function(e){j(\"getCheckpoint rejected with \",e)})}function L(e){h=!1,j(\"writeCheckpoint completed with error\",e)}a.ready(r,i),a.cancelled?B():(a._addedListeners||(a.once(\"cancel\",B),\"function\"==typeof o.complete&&(a.once(\"error\",o.complete),a.once(\"complete\",function(e){o.complete(null,e)})),a._addedListeners=!0),void 0===o.since?D():e().then(function(){return h=!0,c.writeCheckpoint(o.since,k)}).then(function(){h=!1,a.cancelled?B():(v=o.since,D())}).catch(L))}function a(){i.EventEmitter.call(this),this.cancelled=!1,this.state=\"pending\";var n=this,r=new Promise(function(e,t){n.once(\"complete\",e),n.once(\"error\",t)});n.then=function(e,t){return r.then(e,t)},n.catch=function(e){return r.catch(e)},n.catch(function(){})}function s(e,t){var n=t.PouchConstructor;return\"string\"==typeof e?new n(e,t):e}function m(e,t,n,r){if(\"function\"==typeof n&&(r=n,n={}),void 0===n&&(n={}),n.doc_ids&&!Array.isArray(n.doc_ids))throw F.createError(F.BAD_REQUEST,\"`doc_ids` filter parameter is not a list.\");n.complete=r,(n=N.clone(n)).continuous=n.continuous||n.live,n.retry=\"retry\"in n&&n.retry,n.PouchConstructor=n.PouchConstructor||this;var i=new a(n);return z(s(e,n),s(t,n),n,i),i}function f(e,t,n,r){return\"function\"==typeof n&&(r=n,n={}),void 0===n&&(n={}),(n=N.clone(n)).PouchConstructor=n.PouchConstructor||this,new l(e=s(e,n),t=s(t,n),n,r)}function l(e,t,n,r){var i=this;this.canceled=!1;var o=n.push?N.assign({},n,n.push):n,a=n.pull?N.assign({},n,n.pull):n;function s(e){i.emit(\"change\",{direction:\"pull\",change:e})}function u(e){i.emit(\"change\",{direction:\"push\",change:e})}function c(e){i.emit(\"denied\",{direction:\"push\",doc:e})}function f(e){i.emit(\"denied\",{direction:\"pull\",doc:e})}function l(){i.pushPaused=!0,i.pullPaused&&i.emit(\"paused\")}function h(){i.pullPaused=!0,i.pushPaused&&i.emit(\"paused\")}function d(){i.pushPaused=!1,i.pullPaused&&i.emit(\"active\",{direction:\"push\"})}function p(){i.pullPaused=!1,i.pushPaused&&i.emit(\"active\",{direction:\"pull\"})}this.push=m(e,t,o),this.pull=m(t,e,a),this.pushPaused=!0,this.pullPaused=!0;var v={};function g(n){return function(e,t){(\"change\"!==e||t!==s&&t!==u)&&(\"denied\"!==e||t!==f&&t!==c)&&(\"paused\"!==e||t!==h&&t!==l)&&(\"active\"!==e||t!==p&&t!==d)||(e in v||(v[e]={}),v[e][n]=!0,2===Object.keys(v[e]).length&&i.removeAllListeners(e))}}function y(e,t,n){-1==e.listeners(t).indexOf(n)&&e.on(t,n)}n.live&&(this.push.on(\"complete\",i.pull.cancel.bind(i.pull)),this.pull.on(\"complete\",i.push.cancel.bind(i.push))),this.on(\"newListener\",function(e){\"change\"===e?(y(i.pull,\"change\",s),y(i.push,\"change\",u)):\"denied\"===e?(y(i.pull,\"denied\",f),y(i.push,\"denied\",c)):\"active\"===e?(y(i.pull,\"active\",p),y(i.push,\"active\",d)):\"paused\"===e&&(y(i.pull,\"paused\",h),y(i.push,\"paused\",l))}),this.on(\"removeListener\",function(e){\"change\"===e?(i.pull.removeListener(\"change\",s),i.push.removeListener(\"change\",u)):\"denied\"===e?(i.pull.removeListener(\"denied\",f),i.push.removeListener(\"denied\",c)):\"active\"===e?(i.pull.removeListener(\"active\",p),i.push.removeListener(\"active\",d)):\"paused\"===e&&(i.pull.removeListener(\"paused\",h),i.push.removeListener(\"paused\",l))}),this.pull.on(\"removeListener\",g(\"pull\")),this.push.on(\"removeListener\",g(\"push\"));var _=Promise.all([this.push,this.pull]).then(function(e){var t={push:e[0],pull:e[1]};return i.emit(\"complete\",t),r&&r(null,t),i.removeAllListeners(),t},function(e){if(i.cancel(),r?r(e):i.emit(\"error\",e),i.removeAllListeners(),r)throw e});this.then=function(e,t){return _.then(e,t)},this.catch=function(e){return _.catch(e)}}o(a,i.EventEmitter),a.prototype.cancel=function(){this.cancelled=!0,this.state=\"cancelled\",this.emit(\"cancel\")},a.prototype.ready=function(e,t){var n=this;function r(){n.cancel()}n._readyCalled||(n._readyCalled=!0,e.once(\"destroyed\",r),t.once(\"destroyed\",r),n.once(\"complete\",function(){e.removeListener(\"destroyed\",r),t.removeListener(\"destroyed\",r)}))},o(l,i.EventEmitter),l.prototype.cancel=function(){this.canceled||(this.canceled=!0,this.push.cancel(),this.pull.cancel())},t.exports=function(e){e.replicate=m,e.sync=f,Object.defineProperty(e.prototype,\"replicate\",{get:function(){var r=this;return void 0===this.replicateMethods&&(this.replicateMethods={from:function(e,t,n){return r.constructor.replicate(e,r,t,n)},to:function(e,t,n){return r.constructor.replicate(r,e,t,n)}}),this.replicateMethods}}),e.prototype.sync=function(e,t,n){return this.constructor.sync(this,e,t,n)}}},{33:33,67:67,72:72,75:75,83:83,85:85}],83:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14}],84:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var s=e(85),a=e(68);function u(e,t){for(var n=e,r=0,i=t.length;r<i;r++){if(!(n=n[t[r]]))break}return n}function c(e,t){return e<t?-1:t<e?1:0}function f(e){for(var t=[],n=\"\",r=0,i=e.length;r<i;r++){var o=e[r];\".\"===o?n=0<r&&\"\\\\\"===e[r-1]?n.substring(0,n.length-1)+\".\":(t.push(n),\"\"):n+=o}return t.push(n),t}var r=[\"$or\",\"$nor\",\"$not\"];function l(e){return-1<r.indexOf(e)}function i(e){return Object.keys(e)[0]}function h(e){return e[i(e)]}function d(e){var i={};return e.forEach(function(t){Object.keys(t).forEach(function(e){var n=t[e];if(\"object\"!=typeof n&&(n={$eq:n}),l(e))n instanceof Array?i[e]=n.map(function(e){return d([e])}):i[e]=d([n]);else{var r=i[e]=i[e]||{};Object.keys(n).forEach(function(e){var t=n[e];return\"$gt\"===e||\"$gte\"===e?function(e,t,n){if(void 0!==n.$eq)return;void 0!==n.$gte?\"$gte\"===e?t>n.$gte&&(n.$gte=t):t>=n.$gte&&(delete n.$gte,n.$gt=t):void 0!==n.$gt?\"$gte\"===e?t>n.$gt&&(delete n.$gt,n.$gte=t):t>n.$gt&&(n.$gt=t):n[e]=t}(e,t,r):\"$lt\"===e||\"$lte\"===e?function(e,t,n){if(void 0!==n.$eq)return;void 0!==n.$lte?\"$lte\"===e?t<n.$lte&&(n.$lte=t):t<=n.$lte&&(delete n.$lte,n.$lt=t):void 0!==n.$lt?\"$lte\"===e?t<n.$lt&&(delete n.$lt,n.$lte=t):t<n.$lt&&(n.$lt=t):n[e]=t}(e,t,r):\"$ne\"===e?function(e,t){\"$ne\"in t?t.$ne.push(e):t.$ne=[e]}(t,r):\"$eq\"===e?function(e,t){delete t.$gt,delete t.$gte,delete t.$lt,delete t.$lte,delete t.$ne,t.$eq=e}(t,r):void(r[e]=t)})}})}),i}function o(e){var t=s.clone(e),n=!1;\"$and\"in t&&(t=d(t.$and),n=!0),[\"$or\",\"$nor\"].forEach(function(e){e in t&&t[e].forEach(function(e){for(var t=Object.keys(e),n=0;n<t.length;n++){var r=t[n],i=e[r];\"object\"==typeof i&&null!==i||(e[r]={$eq:i})}})}),\"$not\"in t&&(t.$not=d([t.$not]));for(var r=Object.keys(t),i=0;i<r.length;i++){var o=r[i],a=t[o];\"object\"!=typeof a||null===a?a={$eq:a}:\"$ne\"in a&&!n&&(a.$ne=[a.$ne]),t[o]=a}return t}function p(e){function o(n){return e.map(function(e){var t=f(i(e));return u(n,t)})}return function(e,t){var n=o(e.doc),r=o(t.doc),i=a.collate(n,r);return 0!==i?i:c(e.doc._id,t.doc._id)}}function v(e,t,n){if(e=e.filter(function(e){return g(e.doc,t.selector,n)}),t.sort){var r=p(t.sort);e=e.sort(r),\"string\"!=typeof t.sort[0]&&\"desc\"===h(t.sort[0])&&(e=e.reverse())}if(\"limit\"in t||\"skip\"in t){var i=t.skip||0,o=(\"limit\"in t?t.limit:e.length)+i;e=e.slice(i,o)}return e}function g(i,o,e){return e.every(function(e){var t=o[e],n=f(e),r=u(i,n);return l(e)?function(e,t,n){return\"$or\"!==e?\"$not\"!==e?!t.find(function(e){return g(n,e,Object.keys(e))}):!g(n,t,Object.keys(t)):t.some(function(e){return g(n,e,Object.keys(e))})}(e,t,i):y(t,i,n,r)})}function y(n,r,i,o){return!n||Object.keys(n).every(function(e){var t=n[e];return function(e,t,n,r,i){if(w[e])return w[e](t,n,r,i);throw new Error('unknown operator \"'+e+'\" - should be one of $eq, $lte, $lt, $gt, $gte, $exists, $ne, $in, $nin, $size, $mod, $regex, $elemMatch, $type, $allMatch or $all')}(e,r,t,i,o)})}function _(e){return null!=e}function m(e){return void 0!==e}function b(t,e){return e.some(function(e){return t instanceof Array?-1<t.indexOf(e):t===e})}var w={$elemMatch:function(t,n,r,e){return!!Array.isArray(e)&&(0!==e.length&&(\"object\"==typeof e[0]?e.some(function(e){return g(e,n,Object.keys(n))}):e.some(function(e){return y(n,t,r,e)})))},$allMatch:function(t,n,r,e){return!!Array.isArray(e)&&(0!==e.length&&(\"object\"==typeof e[0]?e.every(function(e){return g(e,n,Object.keys(n))}):e.every(function(e){return y(n,t,r,e)})))},$eq:function(e,t,n,r){return m(r)&&0===a.collate(r,t)},$gte:function(e,t,n,r){return m(r)&&0<=a.collate(r,t)},$gt:function(e,t,n,r){return m(r)&&0<a.collate(r,t)},$lte:function(e,t,n,r){return m(r)&&a.collate(r,t)<=0},$lt:function(e,t,n,r){return m(r)&&a.collate(r,t)<0},$exists:function(e,t,n,r){return t?m(r):!m(r)},$mod:function(e,t,n,r){return _(r)&&function(e,t){var n=t[0],r=t[1];if(0===n)throw new Error(\"Bad divisor, cannot divide by zero\");if(parseInt(n,10)!==n)throw new Error(\"Divisor is not an integer\");if(parseInt(r,10)!==r)throw new Error(\"Modulus is not an integer\");return parseInt(e,10)===e&&e%n===r}(r,t)},$ne:function(e,t,n,r){return t.every(function(e){return 0!==a.collate(r,e)})},$in:function(e,t,n,r){return _(r)&&b(r,t)},$nin:function(e,t,n,r){return _(r)&&!b(r,t)},$size:function(e,t,n,r){return _(r)&&function(e,t){return e.length===t}(r,t)},$all:function(e,t,n,r){return Array.isArray(r)&&function(t,e){return e.every(function(e){return-1<t.indexOf(e)})}(r,t)},$regex:function(e,t,n,r){return _(r)&&function(e,t){return new RegExp(t).test(e)}(r,t)},$type:function(e,t,n,r){return function(e,t){switch(t){case\"null\":return null===e;case\"boolean\":return\"boolean\"==typeof e;case\"number\":return\"number\"==typeof e;case\"string\":return\"string\"==typeof e;case\"array\":return e instanceof Array;case\"object\":return\"[object Object]\"==={}.toString.call(e)}throw new Error(t+\" not supported as a type.Please use one of object, string, array, number, boolean or null.\")}(r,t)}};n.massageSelector=o,n.matchesSelector=function(e,t){if(\"object\"!=typeof t)throw new Error(\"Selector error: expected a JSON object\");var n=v([{doc:e}],{selector:t=o(t)},Object.keys(t));return n&&1===n.length},n.filterInMemoryFields=v,n.createFieldSorter=p,n.rowFilter=g,n.isCombinationalField=l,n.getKey=i,n.getValue=h,n.getFieldFromDoc=u,n.setFieldInDoc=function(e,t,n){for(var r=0,i=t.length;r<i-1;r++){e=e[t[r]]={}}e[t[i-1]]=n},n.compare=c,n.parseField=f},{68:68,85:85}],85:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}Object.defineProperty(n,\"__esModule\",{value:!0});var i=r(e(12)),a=e(69),s=r(e(36)),o=e(33),u=r(e(86)),c=e(72),f=r(e(124)),l=e(80),h=e(85);function d(e){if(e instanceof ArrayBuffer)return function(e){if(\"function\"==typeof e.slice)return e.slice(0);var t=new ArrayBuffer(e.byteLength),n=new Uint8Array(t),r=new Uint8Array(e);return n.set(r),t}(e);var t=e.size,n=e.type;return\"function\"==typeof e.slice?e.slice(0,t,n):e.webkitSlice(0,t,n)}var p=Function.prototype.toString,v=p.call(Object);function g(e){var t,n,r;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;n<r;n++)t[n]=g(e[n]);return t}if(e instanceof Date)return e.toISOString();if(function(e){return\"undefined\"!=typeof ArrayBuffer&&e instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&e instanceof Blob}(e))return d(e);if(!function(e){var t=Object.getPrototypeOf(e);if(null===t)return!0;var n=t.constructor;return\"function\"==typeof n&&n instanceof n&&p.call(n)==v}(e))return e;for(n in t={},e)if(Object.prototype.hasOwnProperty.call(e,n)){var i=g(e[n]);void 0!==i&&(t[n]=i)}return t}function y(t){var n=!1;return i(function(e){if(n)throw new Error(\"once called more than once\");n=!0,t.apply(this,e)})}function _(a){return i(function(i){i=g(i);var o=this,t=\"function\"==typeof i[i.length-1]&&i.pop(),e=new Promise(function(n,r){var e;try{var t=y(function(e,t){e?r(e):n(t)});i.push(t),(e=a.apply(o,i))&&\"function\"==typeof e.then&&n(e)}catch(e){r(e)}});return t&&e.then(function(e){t(null,e)},t),e})}function m(e,t){for(var n={},r=0,i=t.length;r<i;r++){var o=t[r];o in e&&(n[o]=e[o])}return n}var b;function w(e){return e}function k(e){return[{ok:e}]}try{localStorage.setItem(\"_pouch_check_localstorage\",1),b=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(e){b=!1}function E(){return b}function S(){o.EventEmitter.call(this),this._listeners={},function(t){E()&&addEventListener(\"storage\",function(e){t.emit(e.key)})}(this)}function x(e){if(\"undefined\"!=typeof console&&\"function\"==typeof console[e]){var t=Array.prototype.slice.call(arguments,1);console[e].apply(console,t)}}u(S,o.EventEmitter),S.prototype.addListener=function(e,t,n,r){if(!this._listeners[t]){var i=this,o=!1;this._listeners[t]=a,this.on(e,a)}function a(){if(i._listeners[t])if(o)o=\"waiting\";else{o=!0;var e=m(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\",\"return_docs\"]);n.changes(e).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===o&&s(a),o=!1}).on(\"error\",function(){o=!1})}}},S.prototype.removeListener=function(e,t){t in this._listeners&&(o.EventEmitter.prototype.removeListener.call(this,e,this._listeners[t]),delete this._listeners[t])},S.prototype.notifyLocalWindows=function(e){E()&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},S.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};var O=\"function\"==typeof Object.assign?Object.assign:function(e){for(var t=Object(e),n=1;n<arguments.length;n++){var r=arguments[n];if(null!=r)for(var i in r)Object.prototype.hasOwnProperty.call(r,i)&&(t[i]=r[i])}return t};var C=function(){}.name?function(e){return e.name}:function(e){var t=e.toString().match(/^\\s*function\\s*(?:(\\S+)\\s*)?\\(/);return t&&t[1]?t[1]:\"\"};function A(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}var j=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],B=/(?:^|&)([^&=]*)=?([^&]*)/g,I=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/;function T(a,s,u){return new Promise(function(i,o){a.get(s,function(e,t){if(e){if(404!==e.status)return o(e);t={}}var n=t._rev,r=u(t);if(!r)return i({updated:!1,rev:n});r._id=s,r._rev=n,i(function(t,n,r){return t.put(n).then(function(e){return{updated:!0,rev:e.rev}},function(e){if(409!==e.status)throw e;return T(t,n._id,r)})}(a,r,u))})})}var R=f.v4;n.adapterFun=function(o,e){return _(i(function(r){if(this._closed)return Promise.reject(new Error(\"database is closed\"));if(this._destroyed)return Promise.reject(new Error(\"database is destroyed\"));var i=this;return function(r,i,e){if(r.constructor.listeners(\"debug\").length){for(var t=[\"api\",r.name,i],n=0;n<e.length-1;n++)t.push(e[n]);r.constructor.emit(\"debug\",t);var o=e[e.length-1];e[e.length-1]=function(e,t){var n=[\"api\",r.name,i];n=n.concat(e?[\"error\",e]:[\"success\",t]),r.constructor.emit(\"debug\",n),o(e,t)}}}(i,o,r),this.taskqueue.isReady?e.apply(this,r):new Promise(function(t,n){i.taskqueue.addTask(function(e){e?n(e):t(i[o].apply(i,r))})})}))},n.assign=O,n.bulkGetShim=function(s,u,e){var t=u.docs,c=new a.Map;t.forEach(function(e){c.has(e.id)?c.get(e.id).push(e):c.set(e.id,[e])});var n=c.size,r=0,f=new Array(n);function l(){++r===n&&function(){var n=[];f.forEach(function(t){t.docs.forEach(function(e){n.push({id:t.id,docs:[e]})})}),e(null,{results:n})}()}var i=[];c.forEach(function(e,t){i.push(t)});var o=0;function h(){if(!(o>=i.length)){var e=Math.min(o+6,i.length),t=i.slice(o,e);!function(e,a){e.forEach(function(r,e){var i=a+e,t=c.get(r),n=m(t[0],[\"atts_since\",\"attachments\"]);n.open_revs=t.map(function(e){return e.rev}),n.open_revs=n.open_revs.filter(w);var o=w;0===n.open_revs.length&&(delete n.open_revs,o=k),[\"revs\",\"attachments\",\"binary\",\"ajax\",\"latest\"].forEach(function(e){e in u&&(n[e]=u[e])}),s.get(r,n,function(e,t){var n;n=e?[{error:e}]:o(t),function(e,t,n){f[e]={id:t,docs:n},l()}(i,r,n),h()})})}(t,o),o+=t.length}}h()},n.changesHandler=S,n.clone=g,n.defaultBackOff=function(e){var t=0;return e||(t=2e3),function(e,t){return e=parseInt(e,10)||0,(t=parseInt(t,10))!=t||t<=e?t=(e||1)<<1:t+=1,6e5<t&&(e=3e5,t=6e5),~~((t-e)*Math.random()+e)}(e,t)},n.explainError=function(e,t){x(\"info\",\"The above \"+e+\" is totally normal. \"+t)},n.filterChange=function(r){var i={},o=r.filter&&\"function\"==typeof r.filter;return i.query=r.query_params,function(e){e.doc||(e.doc={});var t=o&&function(e,t,n){try{return!e(t,n)}catch(e){var r=\"Filter function threw: \"+e.toString();return c.createError(c.BAD_REQUEST,r)}}(r.filter,e.doc,i);if(\"object\"==typeof t)return t;if(t)return!1;if(r.include_docs){if(!r.attachments)for(var n in e.doc._attachments)e.doc._attachments.hasOwnProperty(n)&&(e.doc._attachments[n].stub=!0)}else delete e.doc;return!0}},n.flatten=function(e){for(var t=[],n=0,r=e.length;n<r;n++)t=t.concat(e[n]);return t},n.functionName=C,n.guardedConsole=x,n.hasLocalStorage=E,n.invalidIdError=function(e){var t;if(e?\"string\"!=typeof e?t=c.createError(c.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=c.createError(c.RESERVED_ID)):t=c.createError(c.MISSING_ID),t)throw t},n.isRemote=function(e){return\"boolean\"==typeof e._remote?e._remote:\"function\"==typeof e.type&&(x(\"warn\",\"db.type() is deprecated and will be removed in a future version of PouchDB\"),\"http\"===e.type())},n.listenerCount=function(e,t){return\"listenerCount\"in e?e.listenerCount(t):o.EventEmitter.listenerCount(e,t)},n.nextTick=s,n.normalizeDdocFunctionName=function(e){var t=A(e);return t?t.join(\"/\"):null},n.once=y,n.parseDdocFunctionName=A,n.parseUri=function(e){for(var t=I.exec(e),r={},n=14;n--;){var i=j[n],o=t[n]||\"\",a=-1!==[\"user\",\"password\"].indexOf(i);r[i]=a?decodeURIComponent(o):o}return r.queryKey={},r[j[12]].replace(B,function(e,t,n){t&&(r.queryKey[t]=n)}),r},n.pick=m,n.rev=function(e,t){var n=h.clone(e);return t?(delete n._rev_tree,l.stringMd5(JSON.stringify(n))):f.v4().replace(/-/g,\"\").toLowerCase()},n.scopeEval=function(e,t){var n=[],r=[];for(var i in t)t.hasOwnProperty(i)&&(n.push(i),r.push(t[i]));return n.push(e),Function.apply(null,n).apply(null,r)},n.toPromise=_,n.upsert=T,n.uuid=R},{12:12,124:124,33:33,36:36,69:69,72:72,80:80,85:85,86:86}],86:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14}],87:[function(e,t,n){(function(s){\"use strict\";!s.version||0===s.version.indexOf(\"v0.\")||0===s.version.indexOf(\"v1.\")&&0!==s.version.indexOf(\"v1.8.\")?t.exports={nextTick:function(e,t,n,r){if(\"function\"!=typeof e)throw new TypeError('\"callback\" argument must be a function');var i,o,a=arguments.length;switch(a){case 0:case 1:return s.nextTick(e);case 2:return s.nextTick(function(){e.call(null,t)});case 3:return s.nextTick(function(){e.call(null,t,n)});case 4:return s.nextTick(function(){e.call(null,t,n,r)});default:for(i=new Array(a-1),o=0;o<i.length;)i[o++]=arguments[o];return s.nextTick(function(){e.apply(null,i)})}}}:t.exports=s}).call(this,e(88))},{88:88}],88:[function(e,t,n){var r,i,o=t.exports={};function a(){throw new Error(\"setTimeout has not been defined\")}function s(){throw new Error(\"clearTimeout has not been defined\")}function u(t){if(r===setTimeout)return setTimeout(t,0);if((r===a||!r)&&setTimeout)return r=setTimeout,setTimeout(t,0);try{return r(t,0)}catch(e){try{return r.call(null,t,0)}catch(e){return r.call(this,t,0)}}}!function(){try{r=\"function\"==typeof setTimeout?setTimeout:a}catch(e){r=a}try{i=\"function\"==typeof clearTimeout?clearTimeout:s}catch(e){i=s}}();var c,f=[],l=!1,h=-1;function d(){l&&c&&(l=!1,c.length?f=c.concat(f):h=-1,f.length&&p())}function p(){if(!l){var e=u(d);l=!0;for(var t=f.length;t;){for(c=f,f=[];++h<t;)c&&c[h].run();h=-1,t=f.length}c=null,l=!1,function(t){if(i===clearTimeout)return clearTimeout(t);if((i===s||!i)&&clearTimeout)return i=clearTimeout,clearTimeout(t);try{i(t)}catch(e){try{return i.call(null,t)}catch(e){return i.call(this,t)}}}(e)}}function v(e,t){this.fun=e,this.array=t}function g(){}o.nextTick=function(e){var t=new Array(arguments.length-1);if(1<arguments.length)for(var n=1;n<arguments.length;n++)t[n-1]=arguments[n];f.push(new v(e,t)),1!==f.length||l||u(p)},v.prototype.run=function(){this.fun.apply(null,this.array)},o.title=\"browser\",o.browser=!0,o.env={},o.argv=[],o.version=\"\",o.versions={},o.on=g,o.addListener=g,o.once=g,o.off=g,o.removeListener=g,o.removeAllListeners=g,o.emit=g,o.prependListener=g,o.prependOnceListener=g,o.listeners=function(e){return[]},o.binding=function(e){throw new Error(\"process.binding is not supported\")},o.cwd=function(){return\"/\"},o.chdir=function(e){throw new Error(\"process.chdir is not supported\")},o.umask=function(){return 0}},{}],89:[function(e,t,n){var r,i;r=this,i=function(){var o=\"function\"==typeof Object.defineProperty?function(e,t,n){return Object.defineProperty(e,t,n),e}:function(e,t,n){return e[t]=n.value,e};return function(e,t,n,r){var i;if(r=function(e,t){function n(e){return r?!!t[e]:i&&-1<t.indexOf(e[0])}var r=\"object\"==typeof t,i=!r&&\"string\"==typeof t;return{enumerable:n(\"enumerable\"),configurable:n(\"configurable\"),writable:n(\"writable\"),value:e}}(n,r),\"object\"!=typeof t)return o(e,t,r);for(i in t)Object.hasOwnProperty.call(t,i)&&(r.value=t[i],o(e,i,r));return e}},void 0!==t&&t.exports?t.exports=i():r.prr=i()},{}],90:[function(e,t,n){t.exports=e(91)},{91:91}],91:[function(e,t,n){\"use strict\";var r=e(87).nextTick,i=Object.keys||function(e){var t=[];for(var n in e)t.push(n);return t};t.exports=l;var o=e(21);o.inherits=e(37);var a=e(93),s=e(95);o.inherits(l,a);for(var u=i(s.prototype),c=0;c<u.length;c++){var f=u[c];l.prototype[f]||(l.prototype[f]=s.prototype[f])}function l(e){if(!(this instanceof l))return new l(e);a.call(this,e),s.call(this,e),e&&!1===e.readable&&(this.readable=!1),e&&!1===e.writable&&(this.writable=!1),this.allowHalfOpen=!0,e&&!1===e.allowHalfOpen&&(this.allowHalfOpen=!1),this.once(\"end\",h)}function h(){this.allowHalfOpen||this._writableState.ended||r(d,this)}function d(e){e.end()}Object.defineProperty(l.prototype,\"destroyed\",{get:function(){return void 0!==this._readableState&&void 0!==this._writableState&&(this._readableState.destroyed&&this._writableState.destroyed)},set:function(e){void 0!==this._readableState&&void 0!==this._writableState&&(this._readableState.destroyed=e,this._writableState.destroyed=e)}}),l.prototype._destroy=function(e,t){this.push(null),this.end(),r(t,e)}},{21:21,37:37,87:87,93:93,95:95}],92:[function(e,t,n){\"use strict\";t.exports=o;var r=e(94),i=e(21);function o(e){if(!(this instanceof o))return new o(e);r.call(this,e)}i.inherits=e(37),i.inherits(o,r),o.prototype._transform=function(e,t,n){n(null,e)}},{21:21,37:37,94:94}],93:[function(R,q,e){(function(v,e){\"use strict\";var g=R(87).nextTick;q.exports=h;var a,y=R(39);h.ReadableState=o;function _(e,t){return e.listeners(t).length}R(33).EventEmitter;var i=R(98),s=R(104).Buffer,u=e.Uint8Array||function(){};var t=R(21);t.inherits=R(37);var n=R(18),m=void 0;m=n&&n.debuglog?n.debuglog(\"stream\"):function(){};var c,f=R(96),r=R(97);t.inherits(h,i);var l=[\"error\",\"close\",\"destroy\",\"pause\",\"resume\"];function o(e,t){e=e||{};var n=t instanceof(a=a||R(91));this.objectMode=!!e.objectMode,n&&(this.objectMode=this.objectMode||!!e.readableObjectMode);var r=e.highWaterMark,i=e.readableHighWaterMark,o=this.objectMode?16:16384;this.highWaterMark=r||0===r?r:n&&(i||0===i)?i:o,this.highWaterMark=Math.floor(this.highWaterMark),this.buffer=new f,this.length=0,this.pipes=null,this.pipesCount=0,this.flowing=null,this.ended=!1,this.endEmitted=!1,this.reading=!1,this.sync=!0,this.needReadable=!1,this.emittedReadable=!1,this.readableListening=!1,this.resumeScheduled=!1,this.destroyed=!1,this.defaultEncoding=e.defaultEncoding||\"utf8\",this.awaitDrain=0,this.readingMore=!1,this.decoder=null,this.encoding=null,e.encoding&&(c=c||R(99).StringDecoder,this.decoder=new c(e.encoding),this.encoding=e.encoding)}function h(e){if(a=a||R(91),!(this instanceof h))return new h(e);this._readableState=new o(e,this),this.readable=!0,e&&(\"function\"==typeof e.read&&(this._read=e.read),\"function\"==typeof e.destroy&&(this._destroy=e.destroy)),i.call(this)}function d(e,t,n,r,i){var o,a=e._readableState;null===t?(a.reading=!1,function(e,t){if(t.ended)return;if(t.decoder){var n=t.decoder.end();n&&n.length&&(t.buffer.push(n),t.length+=t.objectMode?1:n.length)}t.ended=!0,k(e)}(e,a)):(i||(o=function(e,t){var n;(function(e){return s.isBuffer(e)||e instanceof u})(t)||\"string\"==typeof t||void 0===t||e.objectMode||(n=new TypeError(\"Invalid non-string/buffer chunk\"));return n}(a,t)),o?e.emit(\"error\",o):a.objectMode||t&&0<t.length?(\"string\"==typeof t||a.objectMode||Object.getPrototypeOf(t)===s.prototype||(t=function(e){return s.from(e)}(t)),r?a.endEmitted?e.emit(\"error\",new Error(\"stream.unshift() after end event\")):p(e,a,t,!0):a.ended?e.emit(\"error\",new Error(\"stream.push() after EOF\")):(a.reading=!1,a.decoder&&!n?(t=a.decoder.write(t),a.objectMode||0!==t.length?p(e,a,t,!1):S(e,a)):p(e,a,t,!1))):r||(a.reading=!1));return function(e){return!e.ended&&(e.needReadable||e.length<e.highWaterMark||0===e.length)}(a)}function p(e,t,n,r){t.flowing&&0===t.length&&!t.sync?(e.emit(\"data\",n),e.read(0)):(t.length+=t.objectMode?1:n.length,r?t.buffer.unshift(n):t.buffer.push(n),t.needReadable&&k(e)),S(e,t)}Object.defineProperty(h.prototype,\"destroyed\",{get:function(){return void 0!==this._readableState&&this._readableState.destroyed},set:function(e){this._readableState&&(this._readableState.destroyed=e)}}),h.prototype.destroy=r.destroy,h.prototype._undestroy=r.undestroy,h.prototype._destroy=function(e,t){this.push(null),t(e)},h.prototype.push=function(e,t){var n,r=this._readableState;return r.objectMode?n=!0:\"string\"==typeof e&&((t=t||r.defaultEncoding)!==r.encoding&&(e=s.from(e,t),t=\"\"),n=!0),d(this,e,t,!1,n)},h.prototype.unshift=function(e){return d(this,e,null,!0,!1)},h.prototype.isPaused=function(){return!1===this._readableState.flowing},h.prototype.setEncoding=function(e){return c=c||R(99).StringDecoder,this._readableState.decoder=new c(e),this._readableState.encoding=e,this};var b=8388608;function w(e,t){return e<=0||0===t.length&&t.ended?0:t.objectMode?1:e!=e?t.flowing&&t.length?t.buffer.head.data.length:t.length:(e>t.highWaterMark&&(t.highWaterMark=function(e){return b<=e?e=b:(e--,e|=e>>>1,e|=e>>>2,e|=e>>>4,e|=e>>>8,e|=e>>>16,e++),e}(e)),e<=t.length?e:t.ended?t.length:(t.needReadable=!0,0))}function k(e){var t=e._readableState;t.needReadable=!1,t.emittedReadable||(m(\"emitReadable\",t.flowing),t.emittedReadable=!0,t.sync?g(E,e):E(e))}function E(e){m(\"emit readable\"),e.emit(\"readable\"),A(e)}function S(e,t){t.readingMore||(t.readingMore=!0,g(x,e,t))}function x(e,t){for(var n=t.length;!t.reading&&!t.flowing&&!t.ended&&t.length<t.highWaterMark&&(m(\"maybeReadMore read 0\"),e.read(0),n!==t.length);)n=t.length;t.readingMore=!1}function O(e){m(\"readable nexttick read 0\"),e.read(0)}function C(e,t){t.reading||(m(\"resume read 0\"),e.read(0)),t.resumeScheduled=!1,t.awaitDrain=0,e.emit(\"resume\"),A(e),t.flowing&&!t.reading&&e.read(0)}function A(e){var t=e._readableState;for(m(\"flow\",t.flowing);t.flowing&&null!==e.read(););}function j(e,t){return 0===t.length?null:(t.objectMode?n=t.buffer.shift():!e||e>=t.length?(n=t.decoder?t.buffer.join(\"\"):1===t.buffer.length?t.buffer.head.data:t.buffer.concat(t.length),t.buffer.clear()):n=function(e,t,n){var r;e<t.head.data.length?(r=t.head.data.slice(0,e),t.head.data=t.head.data.slice(e)):r=e===t.head.data.length?t.shift():n?function(e,t){var n=t.head,r=1,i=n.data;e-=i.length;for(;n=n.next;){var o=n.data,a=e>o.length?o.length:e;if(a===o.length?i+=o:i+=o.slice(0,e),0===(e-=a)){a===o.length?(++r,n.next?t.head=n.next:t.head=t.tail=null):(t.head=n).data=o.slice(a);break}++r}return t.length-=r,i}(e,t):function(e,t){var n=s.allocUnsafe(e),r=t.head,i=1;r.data.copy(n),e-=r.data.length;for(;r=r.next;){var o=r.data,a=e>o.length?o.length:e;if(o.copy(n,n.length-e,0,a),0===(e-=a)){a===o.length?(++i,r.next?t.head=r.next:t.head=t.tail=null):(t.head=r).data=o.slice(a);break}++i}return t.length-=i,n}(e,t);return r}(e,t.buffer,t.decoder),n);var n}function B(e){var t=e._readableState;if(0<t.length)throw new Error('\"endReadable()\" called on non-empty stream');t.endEmitted||(t.ended=!0,g(I,t,e))}function I(e,t){e.endEmitted||0!==e.length||(e.endEmitted=!0,t.readable=!1,t.emit(\"end\"))}function T(e,t){for(var n=0,r=e.length;n<r;n++)if(e[n]===t)return n;return-1}h.prototype.read=function(e){m(\"read\",e),e=parseInt(e,10);var t=this._readableState,n=e;if(0!==e&&(t.emittedReadable=!1),0===e&&t.needReadable&&(t.length>=t.highWaterMark||t.ended))return m(\"read: emitReadable\",t.length,t.ended),0===t.length&&t.ended?B(this):k(this),null;if(0===(e=w(e,t))&&t.ended)return 0===t.length&&B(this),null;var r,i=t.needReadable;return m(\"need readable\",i),(0===t.length||t.length-e<t.highWaterMark)&&m(\"length less than watermark\",i=!0),t.ended||t.reading?m(\"reading or ended\",i=!1):i&&(m(\"do read\"),t.reading=!0,t.sync=!0,0===t.length&&(t.needReadable=!0),this._read(t.highWaterMark),t.sync=!1,t.reading||(e=w(n,t))),null===(r=0<e?j(e,t):null)?(t.needReadable=!0,e=0):t.length-=e,0===t.length&&(t.ended||(t.needReadable=!0),n!==e&&t.ended&&B(this)),null!==r&&this.emit(\"data\",r),r},h.prototype._read=function(e){this.emit(\"error\",new Error(\"_read() is not implemented\"))},h.prototype.pipe=function(n,e){var r=this,i=this._readableState;switch(i.pipesCount){case 0:i.pipes=n;break;case 1:i.pipes=[i.pipes,n];break;default:i.pipes.push(n)}i.pipesCount+=1,m(\"pipe count=%d opts=%j\",i.pipesCount,e);var t=(!e||!1!==e.end)&&n!==v.stdout&&n!==v.stderr?a:p;function o(e,t){m(\"onunpipe\"),e===r&&t&&!1===t.hasUnpiped&&(t.hasUnpiped=!0,m(\"cleanup\"),n.removeListener(\"close\",h),n.removeListener(\"finish\",d),n.removeListener(\"drain\",s),n.removeListener(\"error\",l),n.removeListener(\"unpipe\",o),r.removeListener(\"end\",a),r.removeListener(\"end\",p),r.removeListener(\"data\",f),u=!0,!i.awaitDrain||n._writableState&&!n._writableState.needDrain||s())}function a(){m(\"onend\"),n.end()}i.endEmitted?g(t):r.once(\"end\",t),n.on(\"unpipe\",o);var s=function(t){return function(){var e=t._readableState;m(\"pipeOnDrain\",e.awaitDrain),e.awaitDrain&&e.awaitDrain--,0===e.awaitDrain&&_(t,\"data\")&&(e.flowing=!0,A(t))}}(r);n.on(\"drain\",s);var u=!1;var c=!1;function f(e){m(\"ondata\"),(c=!1)!==n.write(e)||c||((1===i.pipesCount&&i.pipes===n||1<i.pipesCount&&-1!==T(i.pipes,n))&&!u&&(m(\"false write response, pause\",r._readableState.awaitDrain),r._readableState.awaitDrain++,c=!0),r.pause())}function l(e){m(\"onerror\",e),p(),n.removeListener(\"error\",l),0===_(n,\"error\")&&n.emit(\"error\",e)}function h(){n.removeListener(\"finish\",d),p()}function d(){m(\"onfinish\"),n.removeListener(\"close\",h),p()}function p(){m(\"unpipe\"),r.unpipe(n)}return r.on(\"data\",f),function(e,t,n){if(\"function\"==typeof e.prependListener)return e.prependListener(t,n);e._events&&e._events[t]?y(e._events[t])?e._events[t].unshift(n):e._events[t]=[n,e._events[t]]:e.on(t,n)}(n,\"error\",l),n.once(\"close\",h),n.once(\"finish\",d),n.emit(\"pipe\",r),i.flowing||(m(\"pipe resume\"),r.resume()),n},h.prototype.unpipe=function(e){var t=this._readableState,n={hasUnpiped:!1};if(0===t.pipesCount)return this;if(1===t.pipesCount)return e&&e!==t.pipes||(e=e||t.pipes,t.pipes=null,t.pipesCount=0,t.flowing=!1,e&&e.emit(\"unpipe\",this,n)),this;if(!e){var r=t.pipes,i=t.pipesCount;t.pipes=null,t.pipesCount=0,t.flowing=!1;for(var o=0;o<i;o++)r[o].emit(\"unpipe\",this,n);return this}var a=T(t.pipes,e);return-1===a||(t.pipes.splice(a,1),t.pipesCount-=1,1===t.pipesCount&&(t.pipes=t.pipes[0]),e.emit(\"unpipe\",this,n)),this},h.prototype.addListener=h.prototype.on=function(e,t){var n=i.prototype.on.call(this,e,t);if(\"data\"===e)!1!==this._readableState.flowing&&this.resume();else if(\"readable\"===e){var r=this._readableState;r.endEmitted||r.readableListening||(r.readableListening=r.needReadable=!0,r.emittedReadable=!1,r.reading?r.length&&k(this):g(O,this))}return n},h.prototype.resume=function(){var e=this._readableState;return e.flowing||(m(\"resume\"),e.flowing=!0,function(e,t){t.resumeScheduled||(t.resumeScheduled=!0,g(C,e,t))}(this,e)),this},h.prototype.pause=function(){return m(\"call pause flowing=%j\",this._readableState.flowing),!1!==this._readableState.flowing&&(m(\"pause\"),this._readableState.flowing=!1,this.emit(\"pause\")),this},h.prototype.wrap=function(t){var n=this,r=this._readableState,i=!1;for(var e in t.on(\"end\",function(){if(m(\"wrapped end\"),r.decoder&&!r.ended){var e=r.decoder.end();e&&e.length&&n.push(e)}n.push(null)}),t.on(\"data\",function(e){m(\"wrapped data\"),r.decoder&&(e=r.decoder.write(e)),r.objectMode&&null==e||(r.objectMode||e&&e.length)&&(n.push(e)||(i=!0,t.pause()))}),t)void 0===this[e]&&\"function\"==typeof t[e]&&(this[e]=function(e){return function(){return t[e].apply(t,arguments)}}(e));for(var o=0;o<l.length;o++)t.on(l[o],this.emit.bind(this,l[o]));return this._read=function(e){m(\"wrapped _read\",e),i&&(i=!1,t.resume())},this},h._fromList=j}).call(this,R(88),\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{104:104,18:18,21:21,33:33,37:37,39:39,87:87,88:88,91:91,96:96,97:97,98:98,99:99}],94:[function(e,t,n){\"use strict\";t.exports=o;var r=e(91),i=e(21);function o(e){if(!(this instanceof o))return new o(e);r.call(this,e),this._transformState={afterTransform:function(e,t){var n=this._transformState;n.transforming=!1;var r=n.writecb;if(!r)return this.emit(\"error\",new Error(\"write callback called multiple times\"));n.writechunk=null,(n.writecb=null)!=t&&this.push(t),r(e);var i=this._readableState;i.reading=!1,(i.needReadable||i.length<i.highWaterMark)&&this._read(i.highWaterMark)}.bind(this),needTransform:!1,transforming:!1,writecb:null,writechunk:null,writeencoding:null},this._readableState.needReadable=!0,this._readableState.sync=!1,e&&(\"function\"==typeof e.transform&&(this._transform=e.transform),\"function\"==typeof e.flush&&(this._flush=e.flush)),this.on(\"prefinish\",a)}function a(){var n=this;\"function\"==typeof this._flush?this._flush(function(e,t){s(n,e,t)}):s(this,null,null)}function s(e,t,n){if(t)return e.emit(\"error\",t);if(null!=n&&e.push(n),e._writableState.length)throw new Error(\"Calling transform done when ws.length != 0\");if(e._transformState.transforming)throw new Error(\"Calling transform done when still transforming\");return e.push(null)}i.inherits=e(37),i.inherits(o,r),o.prototype.push=function(e,t){return this._transformState.needTransform=!1,r.prototype.push.call(this,e,t)},o.prototype._transform=function(e,t,n){throw new Error(\"_transform() is not implemented\")},o.prototype._write=function(e,t,n){var r=this._transformState;if(r.writecb=n,r.writechunk=e,r.writeencoding=t,!r.transforming){var i=this._readableState;(r.needTransform||i.needReadable||i.length<i.highWaterMark)&&this._read(i.highWaterMark)}},o.prototype._read=function(e){var t=this._transformState;null!==t.writechunk&&t.writecb&&!t.transforming?(t.transforming=!0,this._transform(t.writechunk,t.writeencoding,t.afterTransform)):t.needTransform=!0},o.prototype._destroy=function(e,t){var n=this;r.prototype._destroy.call(this,e,function(e){t(e),n.emit(\"close\")})}},{21:21,37:37,91:91}],95:[function(E,S,e){(function(e,t,n){\"use strict\";var s=E(87).nextTick;function l(e){var t=this;this.next=null,this.entry=null,this.finish=function(){!function(e,t,n){var r=e.entry;e.entry=null;for(;r;){var i=r.callback;t.pendingcb--,i(n),r=r.next}t.corkedRequestsFree?t.corkedRequestsFree.next=e:t.corkedRequestsFree=e}(t,e)}}S.exports=g;var u,c=!e.browser&&-1<[\"v0.10\",\"v0.9.\"].indexOf(e.version.slice(0,5))?n:s;g.WritableState=v;var r=E(21);r.inherits=E(37);var i={deprecate:E(120)},o=E(98),f=E(104).Buffer,a=t.Uint8Array||function(){};var h,d=E(97);function p(){}function v(e,t){u=u||E(91),e=e||{};var n=t instanceof u;this.objectMode=!!e.objectMode,n&&(this.objectMode=this.objectMode||!!e.writableObjectMode);var r=e.highWaterMark,i=e.writableHighWaterMark,o=this.objectMode?16:16384;this.highWaterMark=r||0===r?r:n&&(i||0===i)?i:o,this.highWaterMark=Math.floor(this.highWaterMark),this.finalCalled=!1,this.needDrain=!1,this.ending=!1,this.ended=!1,this.finished=!1;var a=(this.destroyed=!1)===e.decodeStrings;this.decodeStrings=!a,this.defaultEncoding=e.defaultEncoding||\"utf8\",this.length=0,this.writing=!1,this.corked=0,this.sync=!0,this.bufferProcessing=!1,this.onwrite=function(e){!function(e,t){var n=e._writableState,r=n.sync,i=n.writecb;if(function(e){e.writing=!1,e.writecb=null,e.length-=e.writelen,e.writelen=0}(n),t)!function(e,t,n,r,i){--t.pendingcb,n?(s(i,r),s(k,e,t),e._writableState.errorEmitted=!0,e.emit(\"error\",r)):(i(r),e._writableState.errorEmitted=!0,e.emit(\"error\",r),k(e,t))}(e,n,r,t,i);else{var o=b(n);o||n.corked||n.bufferProcessing||!n.bufferedRequest||m(e,n),r?c(_,e,n,o,i):_(e,n,o,i)}}(t,e)},this.writecb=null,this.writelen=0,this.bufferedRequest=null,this.lastBufferedRequest=null,this.pendingcb=0,this.prefinished=!1,this.errorEmitted=!1,this.bufferedRequestCount=0,this.corkedRequestsFree=new l(this)}function g(e){if(u=u||E(91),!(h.call(g,this)||this instanceof u))return new g(e);this._writableState=new v(e,this),this.writable=!0,e&&(\"function\"==typeof e.write&&(this._write=e.write),\"function\"==typeof e.writev&&(this._writev=e.writev),\"function\"==typeof e.destroy&&(this._destroy=e.destroy),\"function\"==typeof e.final&&(this._final=e.final)),o.call(this)}function y(e,t,n,r,i,o,a){t.writelen=r,t.writecb=a,t.writing=!0,t.sync=!0,n?e._writev(i,t.onwrite):e._write(i,o,t.onwrite),t.sync=!1}function _(e,t,n,r){n||function(e,t){0===t.length&&t.needDrain&&(t.needDrain=!1,e.emit(\"drain\"))}(e,t),t.pendingcb--,r(),k(e,t)}function m(e,t){t.bufferProcessing=!0;var n=t.bufferedRequest;if(e._writev&&n&&n.next){var r=t.bufferedRequestCount,i=new Array(r),o=t.corkedRequestsFree;o.entry=n;for(var a=0,s=!0;n;)(i[a]=n).isBuf||(s=!1),n=n.next,a+=1;i.allBuffers=s,y(e,t,!0,t.length,i,\"\",o.finish),t.pendingcb++,t.lastBufferedRequest=null,o.next?(t.corkedRequestsFree=o.next,o.next=null):t.corkedRequestsFree=new l(t),t.bufferedRequestCount=0}else{for(;n;){var u=n.chunk,c=n.encoding,f=n.callback;if(y(e,t,!1,t.objectMode?1:u.length,u,c,f),n=n.next,t.bufferedRequestCount--,t.writing)break}null===n&&(t.lastBufferedRequest=null)}t.bufferedRequest=n,t.bufferProcessing=!1}function b(e){return e.ending&&0===e.length&&null===e.bufferedRequest&&!e.finished&&!e.writing}function w(t,n){t._final(function(e){n.pendingcb--,e&&t.emit(\"error\",e),n.prefinished=!0,t.emit(\"prefinish\"),k(t,n)})}function k(e,t){var n=b(t);return n&&(function(e,t){t.prefinished||t.finalCalled||(\"function\"==typeof e._final?(t.pendingcb++,t.finalCalled=!0,s(w,e,t)):(t.prefinished=!0,e.emit(\"prefinish\")))}(e,t),0===t.pendingcb&&(t.finished=!0,e.emit(\"finish\"))),n}r.inherits(g,o),v.prototype.getBuffer=function(){for(var e=this.bufferedRequest,t=[];e;)t.push(e),e=e.next;return t},function(){try{Object.defineProperty(v.prototype,\"buffer\",{get:i.deprecate(function(){return this.getBuffer()},\"_writableState.buffer is deprecated. Use _writableState.getBuffer instead.\",\"DEP0003\")})}catch(e){}}(),\"function\"==typeof Symbol&&Symbol.hasInstance&&\"function\"==typeof Function.prototype[Symbol.hasInstance]?(h=Function.prototype[Symbol.hasInstance],Object.defineProperty(g,Symbol.hasInstance,{value:function(e){return!!h.call(this,e)||this===g&&(e&&e._writableState instanceof v)}})):h=function(e){return e instanceof this},g.prototype.pipe=function(){this.emit(\"error\",new Error(\"Cannot pipe, not readable\"))},g.prototype.write=function(e,t,n){var r=this._writableState,i=!1,o=!r.objectMode&&function(e){return f.isBuffer(e)||e instanceof a}(e);return o&&!f.isBuffer(e)&&(e=function(e){return f.from(e)}(e)),\"function\"==typeof t&&(n=t,t=null),t=o?\"buffer\":t||r.defaultEncoding,\"function\"!=typeof n&&(n=p),r.ended?function(e,t){var n=new Error(\"write after end\");e.emit(\"error\",n),s(t,n)}(this,n):(o||function(e,t,n,r){var i=!0,o=!1;return null===n?o=new TypeError(\"May not write null values to stream\"):\"string\"==typeof n||void 0===n||t.objectMode||(o=new TypeError(\"Invalid non-string/buffer chunk\")),o&&(e.emit(\"error\",o),s(r,o),i=!1),i}(this,r,e,n))&&(r.pendingcb++,i=function(e,t,n,r,i,o){if(!n){var a=function(e,t,n){e.objectMode||!1===e.decodeStrings||\"string\"!=typeof t||(t=f.from(t,n));return t}(t,r,i);r!==a&&(n=!0,i=\"buffer\",r=a)}var s=t.objectMode?1:r.length;t.length+=s;var u=t.length<t.highWaterMark;u||(t.needDrain=!0);if(t.writing||t.corked){var c=t.lastBufferedRequest;t.lastBufferedRequest={chunk:r,encoding:i,isBuf:n,callback:o,next:null},c?c.next=t.lastBufferedRequest:t.bufferedRequest=t.lastBufferedRequest,t.bufferedRequestCount+=1}else y(e,t,!1,s,r,i,o);return u}(this,r,o,e,t,n)),i},g.prototype.cork=function(){this._writableState.corked++},g.prototype.uncork=function(){var e=this._writableState;e.corked&&(e.corked--,e.writing||e.corked||e.finished||e.bufferProcessing||!e.bufferedRequest||m(this,e))},g.prototype.setDefaultEncoding=function(e){if(\"string\"==typeof e&&(e=e.toLowerCase()),!(-1<[\"hex\",\"utf8\",\"utf-8\",\"ascii\",\"binary\",\"base64\",\"ucs2\",\"ucs-2\",\"utf16le\",\"utf-16le\",\"raw\"].indexOf((e+\"\").toLowerCase())))throw new TypeError(\"Unknown encoding: \"+e);return this._writableState.defaultEncoding=e,this},g.prototype._write=function(e,t,n){n(new Error(\"_write() is not implemented\"))},g.prototype._writev=null,g.prototype.end=function(e,t,n){var r=this._writableState;\"function\"==typeof e?(n=e,t=e=null):\"function\"==typeof t&&(n=t,t=null),null!=e&&this.write(e,t),r.corked&&(r.corked=1,this.uncork()),r.ending||r.finished||function(e,t,n){t.ending=!0,k(e,t),n&&(t.finished?s(n):e.once(\"finish\",n));t.ended=!0,e.writable=!1}(this,r,n)},Object.defineProperty(g.prototype,\"destroyed\",{get:function(){return void 0!==this._writableState&&this._writableState.destroyed},set:function(e){this._writableState&&(this._writableState.destroyed=e)}}),g.prototype.destroy=d.destroy,g.prototype._undestroy=d.undestroy,g.prototype._destroy=function(e,t){this.end(),t(e)}}).call(this,E(88),\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{},E(119).setImmediate)},{104:104,119:119,120:120,21:21,37:37,87:87,88:88,91:91,97:97,98:98}],96:[function(e,t,n){\"use strict\";var s=e(104).Buffer,r=e(18);function i(){!function(e,t){if(!(e instanceof t))throw new TypeError(\"Cannot call a class as a function\")}(this,i),this.head=null,this.tail=null,this.length=0}t.exports=(i.prototype.push=function(e){var t={data:e,next:null};0<this.length?this.tail.next=t:this.head=t,this.tail=t,++this.length},i.prototype.unshift=function(e){var t={data:e,next:this.head};0===this.length&&(this.tail=t),this.head=t,++this.length},i.prototype.shift=function(){if(0!==this.length){var e=this.head.data;return 1===this.length?this.head=this.tail=null:this.head=this.head.next,--this.length,e}},i.prototype.clear=function(){this.head=this.tail=null,this.length=0},i.prototype.join=function(e){if(0===this.length)return\"\";for(var t=this.head,n=\"\"+t.data;t=t.next;)n+=e+t.data;return n},i.prototype.concat=function(e){if(0===this.length)return s.alloc(0);if(1===this.length)return this.head.data;for(var t,n,r,i=s.allocUnsafe(e>>>0),o=this.head,a=0;o;)t=o.data,n=i,r=a,t.copy(n,r),a+=o.data.length,o=o.next;return i},i),r&&r.inspect&&r.inspect.custom&&(t.exports.prototype[r.inspect.custom]=function(){var e=r.inspect({length:this.length});return this.constructor.name+\" \"+e})},{104:104,18:18}],97:[function(e,t,n){\"use strict\";var o=e(87).nextTick;function a(e,t){e.emit(\"error\",t)}t.exports={destroy:function(e,t){var n=this,r=this._readableState&&this._readableState.destroyed,i=this._writableState&&this._writableState.destroyed;return r||i?t?t(e):!e||this._writableState&&this._writableState.errorEmitted||o(a,this,e):(this._readableState&&(this._readableState.destroyed=!0),this._writableState&&(this._writableState.destroyed=!0),this._destroy(e||null,function(e){!t&&e?(o(a,n,e),n._writableState&&(n._writableState.errorEmitted=!0)):t&&t(e)})),this},undestroy:function(){this._readableState&&(this._readableState.destroyed=!1,this._readableState.reading=!1,this._readableState.ended=!1,this._readableState.endEmitted=!1),this._writableState&&(this._writableState.destroyed=!1,this._writableState.ended=!1,this._writableState.ending=!1,this._writableState.finished=!1,this._writableState.errorEmitted=!1)}}},{87:87}],98:[function(e,t,n){t.exports=e(33).EventEmitter},{33:33}],99:[function(e,t,n){\"use strict\";var r=e(104).Buffer,i=r.isEncoding||function(e){switch((e=\"\"+e)&&e.toLowerCase()){case\"hex\":case\"utf8\":case\"utf-8\":case\"ascii\":case\"binary\":case\"base64\":case\"ucs2\":case\"ucs-2\":case\"utf16le\":case\"utf-16le\":case\"raw\":return!0;default:return!1}};function o(e){var t;switch(this.encoding=function(e){var t=function(e){if(!e)return\"utf8\";for(var t;;)switch(e){case\"utf8\":case\"utf-8\":return\"utf8\";case\"ucs2\":case\"ucs-2\":case\"utf16le\":case\"utf-16le\":return\"utf16le\";case\"latin1\":case\"binary\":return\"latin1\";case\"base64\":case\"ascii\":case\"hex\":return e;default:if(t)return;e=(\"\"+e).toLowerCase(),t=!0}}(e);if(\"string\"!=typeof t&&(r.isEncoding===i||!i(e)))throw new Error(\"Unknown encoding: \"+e);return t||e}(e),this.encoding){case\"utf16le\":this.text=u,this.end=c,t=4;break;case\"utf8\":this.fillLast=s,t=4;break;case\"base64\":this.text=f,this.end=l,t=3;break;default:return this.write=h,void(this.end=d)}this.lastNeed=0,this.lastTotal=0,this.lastChar=r.allocUnsafe(t)}function a(e){return e<=127?0:e>>5==6?2:e>>4==14?3:e>>3==30?4:-1}function s(e){var t=this.lastTotal-this.lastNeed,n=function(e,t,n){if(128!=(192&t[0]))return e.lastNeed=0,\"�\".repeat(n);if(1<e.lastNeed&&1<t.length){if(128!=(192&t[1]))return e.lastNeed=1,\"�\".repeat(n+1);if(2<e.lastNeed&&2<t.length&&128!=(192&t[2]))return e.lastNeed=2,\"�\".repeat(n+2)}}(this,e,t);return void 0!==n?n:this.lastNeed<=e.length?(e.copy(this.lastChar,t,0,this.lastNeed),this.lastChar.toString(this.encoding,0,this.lastTotal)):(e.copy(this.lastChar,t,0,e.length),void(this.lastNeed-=e.length))}function u(e,t){if((e.length-t)%2!=0)return this.lastNeed=1,this.lastTotal=2,this.lastChar[0]=e[e.length-1],e.toString(\"utf16le\",t,e.length-1);var n=e.toString(\"utf16le\",t);if(n){var r=n.charCodeAt(n.length-1);if(55296<=r&&r<=56319)return this.lastNeed=2,this.lastTotal=4,this.lastChar[0]=e[e.length-2],this.lastChar[1]=e[e.length-1],n.slice(0,-1)}return n}function c(e){var t=e&&e.length?this.write(e):\"\";if(this.lastNeed){var n=this.lastTotal-this.lastNeed;return t+this.lastChar.toString(\"utf16le\",0,n)}return t}function f(e,t){var n=(e.length-t)%3;return 0==n?e.toString(\"base64\",t):(this.lastNeed=3-n,this.lastTotal=3,1==n?this.lastChar[0]=e[e.length-1]:(this.lastChar[0]=e[e.length-2],this.lastChar[1]=e[e.length-1]),e.toString(\"base64\",t,e.length-n))}function l(e){var t=e&&e.length?this.write(e):\"\";return this.lastNeed?t+this.lastChar.toString(\"base64\",0,3-this.lastNeed):t}function h(e){return e.toString(this.encoding)}function d(e){return e&&e.length?this.write(e):\"\"}(n.StringDecoder=o).prototype.write=function(e){if(0===e.length)return\"\";var t,n;if(this.lastNeed){if(void 0===(t=this.fillLast(e)))return\"\";n=this.lastNeed,this.lastNeed=0}else n=0;return n<e.length?t?t+this.text(e,n):this.text(e,n):t||\"\"},o.prototype.end=function(e){var t=e&&e.length?this.write(e):\"\";return this.lastNeed?t+\"�\".repeat(this.lastTotal-this.lastNeed):t},o.prototype.text=function(e,t){var n=function(e,t,n){var r=t.length-1;if(r<n)return 0;var i=a(t[r]);if(0<=i)return 0<i&&(e.lastNeed=i-1),i;if(--r<n)return 0;if(0<=(i=a(t[r])))return 0<i&&(e.lastNeed=i-2),i;if(--r<n)return 0;if(0<=(i=a(t[r])))return 0<i&&(2===i?i=0:e.lastNeed=i-3),i;return 0}(this,e,t);if(!this.lastNeed)return e.toString(\"utf8\",t);this.lastTotal=n;var r=e.length-(n-this.lastNeed);return e.copy(this.lastChar,0,r),e.toString(\"utf8\",t,r)},o.prototype.fillLast=function(e){if(this.lastNeed<=e.length)return e.copy(this.lastChar,this.lastTotal-this.lastNeed,0,this.lastNeed),this.lastChar.toString(this.encoding,0,this.lastTotal);e.copy(this.lastChar,this.lastTotal-this.lastNeed,0,e.length),this.lastNeed-=e.length}},{104:104}],100:[function(e,t,n){t.exports=e(101).PassThrough},{101:101}],101:[function(e,t,n){(((n=t.exports=e(93)).Stream=n).Readable=n).Writable=e(95),n.Duplex=e(91),n.Transform=e(94),n.PassThrough=e(92)},{91:91,92:92,93:93,94:94,95:95}],102:[function(e,t,n){t.exports=e(101).Transform},{101:101}],103:[function(e,t,n){t.exports=e(95)},{95:95}],104:[function(e,t,n){var r=e(20),i=r.Buffer;function o(e,t){for(var n in e)t[n]=e[n]}function a(e,t,n){return i(e,t,n)}i.from&&i.alloc&&i.allocUnsafe&&i.allocUnsafeSlow?t.exports=r:(o(r,n),n.Buffer=a),o(i,a),a.from=function(e,t,n){if(\"number\"==typeof e)throw new TypeError(\"Argument must not be a number\");return i(e,t,n)},a.alloc=function(e,t,n){if(\"number\"!=typeof e)throw new TypeError(\"Argument must be a number\");var r=i(e);return void 0!==t?\"string\"==typeof n?r.fill(t,n):r.fill(t):r.fill(0),r},a.allocUnsafe=function(e){if(\"number\"!=typeof e)throw new TypeError(\"Argument must be a number\");return i(e)},a.allocUnsafeSlow=function(e){if(\"number\"!=typeof e)throw new TypeError(\"Argument must be a number\");return r.SlowBuffer(e)}},{20:20}],105:[function(e,n,r){!function(e){if(\"object\"==typeof r)n.exports=e();else if(\"function\"==typeof define&&define.amd)define(e);else{var t;try{t=window}catch(e){t=self}t.SparkMD5=e()}}(function(c){\"use strict\";var r=[\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"];function f(e,t){var n=e[0],r=e[1],i=e[2],o=e[3];r=((r+=((i=((i+=((o=((o+=((n=((n+=(r&i|~r&o)+t[0]-680876936|0)<<7|n>>>25)+r|0)&r|~n&i)+t[1]-389564586|0)<<12|o>>>20)+n|0)&n|~o&r)+t[2]+606105819|0)<<17|i>>>15)+o|0)&o|~i&n)+t[3]-1044525330|0)<<22|r>>>10)+i|0,r=((r+=((i=((i+=((o=((o+=((n=((n+=(r&i|~r&o)+t[4]-176418897|0)<<7|n>>>25)+r|0)&r|~n&i)+t[5]+1200080426|0)<<12|o>>>20)+n|0)&n|~o&r)+t[6]-1473231341|0)<<17|i>>>15)+o|0)&o|~i&n)+t[7]-45705983|0)<<22|r>>>10)+i|0,r=((r+=((i=((i+=((o=((o+=((n=((n+=(r&i|~r&o)+t[8]+1770035416|0)<<7|n>>>25)+r|0)&r|~n&i)+t[9]-1958414417|0)<<12|o>>>20)+n|0)&n|~o&r)+t[10]-42063|0)<<17|i>>>15)+o|0)&o|~i&n)+t[11]-1990404162|0)<<22|r>>>10)+i|0,r=((r+=((i=((i+=((o=((o+=((n=((n+=(r&i|~r&o)+t[12]+1804603682|0)<<7|n>>>25)+r|0)&r|~n&i)+t[13]-40341101|0)<<12|o>>>20)+n|0)&n|~o&r)+t[14]-1502002290|0)<<17|i>>>15)+o|0)&o|~i&n)+t[15]+1236535329|0)<<22|r>>>10)+i|0,r=((r+=((i=((i+=((o=((o+=((n=((n+=(r&o|i&~o)+t[1]-165796510|0)<<5|n>>>27)+r|0)&i|r&~i)+t[6]-1069501632|0)<<9|o>>>23)+n|0)&r|n&~r)+t[11]+643717713|0)<<14|i>>>18)+o|0)&n|o&~n)+t[0]-373897302|0)<<20|r>>>12)+i|0,r=((r+=((i=((i+=((o=((o+=((n=((n+=(r&o|i&~o)+t[5]-701558691|0)<<5|n>>>27)+r|0)&i|r&~i)+t[10]+38016083|0)<<9|o>>>23)+n|0)&r|n&~r)+t[15]-660478335|0)<<14|i>>>18)+o|0)&n|o&~n)+t[4]-405537848|0)<<20|r>>>12)+i|0,r=((r+=((i=((i+=((o=((o+=((n=((n+=(r&o|i&~o)+t[9]+568446438|0)<<5|n>>>27)+r|0)&i|r&~i)+t[14]-1019803690|0)<<9|o>>>23)+n|0)&r|n&~r)+t[3]-187363961|0)<<14|i>>>18)+o|0)&n|o&~n)+t[8]+1163531501|0)<<20|r>>>12)+i|0,r=((r+=((i=((i+=((o=((o+=((n=((n+=(r&o|i&~o)+t[13]-1444681467|0)<<5|n>>>27)+r|0)&i|r&~i)+t[2]-51403784|0)<<9|o>>>23)+n|0)&r|n&~r)+t[7]+1735328473|0)<<14|i>>>18)+o|0)&n|o&~n)+t[12]-1926607734|0)<<20|r>>>12)+i|0,r=((r+=((i=((i+=((o=((o+=((n=((n+=(r^i^o)+t[5]-378558|0)<<4|n>>>28)+r|0)^r^i)+t[8]-2022574463|0)<<11|o>>>21)+n|0)^n^r)+t[11]+1839030562|0)<<16|i>>>16)+o|0)^o^n)+t[14]-35309556|0)<<23|r>>>9)+i|0,r=((r+=((i=((i+=((o=((o+=((n=((n+=(r^i^o)+t[1]-1530992060|0)<<4|n>>>28)+r|0)^r^i)+t[4]+1272893353|0)<<11|o>>>21)+n|0)^n^r)+t[7]-155497632|0)<<16|i>>>16)+o|0)^o^n)+t[10]-1094730640|0)<<23|r>>>9)+i|0,r=((r+=((i=((i+=((o=((o+=((n=((n+=(r^i^o)+t[13]+681279174|0)<<4|n>>>28)+r|0)^r^i)+t[0]-358537222|0)<<11|o>>>21)+n|0)^n^r)+t[3]-722521979|0)<<16|i>>>16)+o|0)^o^n)+t[6]+76029189|0)<<23|r>>>9)+i|0,r=((r+=((i=((i+=((o=((o+=((n=((n+=(r^i^o)+t[9]-640364487|0)<<4|n>>>28)+r|0)^r^i)+t[12]-421815835|0)<<11|o>>>21)+n|0)^n^r)+t[15]+530742520|0)<<16|i>>>16)+o|0)^o^n)+t[2]-995338651|0)<<23|r>>>9)+i|0,r=((r+=((o=((o+=(r^((n=((n+=(i^(r|~o))+t[0]-198630844|0)<<6|n>>>26)+r|0)|~i))+t[7]+1126891415|0)<<10|o>>>22)+n|0)^((i=((i+=(n^(o|~r))+t[14]-1416354905|0)<<15|i>>>17)+o|0)|~n))+t[5]-57434055|0)<<21|r>>>11)+i|0,r=((r+=((o=((o+=(r^((n=((n+=(i^(r|~o))+t[12]+1700485571|0)<<6|n>>>26)+r|0)|~i))+t[3]-1894986606|0)<<10|o>>>22)+n|0)^((i=((i+=(n^(o|~r))+t[10]-1051523|0)<<15|i>>>17)+o|0)|~n))+t[1]-2054922799|0)<<21|r>>>11)+i|0,r=((r+=((o=((o+=(r^((n=((n+=(i^(r|~o))+t[8]+1873313359|0)<<6|n>>>26)+r|0)|~i))+t[15]-30611744|0)<<10|o>>>22)+n|0)^((i=((i+=(n^(o|~r))+t[6]-1560198380|0)<<15|i>>>17)+o|0)|~n))+t[13]+1309151649|0)<<21|r>>>11)+i|0,r=((r+=((o=((o+=(r^((n=((n+=(i^(r|~o))+t[4]-145523070|0)<<6|n>>>26)+r|0)|~i))+t[11]-1120210379|0)<<10|o>>>22)+n|0)^((i=((i+=(n^(o|~r))+t[2]+718787259|0)<<15|i>>>17)+o|0)|~n))+t[9]-343485551|0)<<21|r>>>11)+i|0,e[0]=n+e[0]|0,e[1]=r+e[1]|0,e[2]=i+e[2]|0,e[3]=o+e[3]|0}function l(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e.charCodeAt(t)+(e.charCodeAt(t+1)<<8)+(e.charCodeAt(t+2)<<16)+(e.charCodeAt(t+3)<<24);return n}function h(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e[t]+(e[t+1]<<8)+(e[t+2]<<16)+(e[t+3]<<24);return n}function i(e){var t,n,r,i,o,a,s=e.length,u=[1732584193,-271733879,-1732584194,271733878];for(t=64;t<=s;t+=64)f(u,l(e.substring(t-64,t)));for(n=(e=e.substring(t-64)).length,r=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],t=0;t<n;t+=1)r[t>>2]|=e.charCodeAt(t)<<(t%4<<3);if(r[t>>2]|=128<<(t%4<<3),55<t)for(f(u,r),t=0;t<16;t+=1)r[t]=0;return i=(i=8*s).toString(16).match(/(.*?)(.{0,8})$/),o=parseInt(i[2],16),a=parseInt(i[1],16)||0,r[14]=o,r[15]=a,f(u,r),u}function n(e){var t,n=\"\";for(t=0;t<4;t+=1)n+=r[e>>8*t+4&15]+r[e>>8*t&15];return n}function a(e){var t;for(t=0;t<e.length;t+=1)e[t]=n(e[t]);return e.join(\"\")}function d(e,t){return(e=0|e||0)<0?Math.max(e+t,0):Math.min(e,t)}function o(e){return/[\\u0080-\\uFFFF]/.test(e)&&(e=unescape(encodeURIComponent(e))),e}function s(e){var t,n=[],r=e.length;for(t=0;t<r-1;t+=2)n.push(parseInt(e.substr(t,2),16));return String.fromCharCode.apply(String,n)}function u(){this.reset()}return\"5d41402abc4b2a76b9719d911017c592\"!==a(i(\"hello\"))&&function(e,t){var n=(65535&e)+(65535&t);return(e>>16)+(t>>16)+(n>>16)<<16|65535&n},\"undefined\"==typeof ArrayBuffer||ArrayBuffer.prototype.slice||(ArrayBuffer.prototype.slice=function(e,t){var n,r,i,o,a=this.byteLength,s=d(e,a),u=a;return t!==c&&(u=d(t,a)),u<s?new ArrayBuffer(0):(n=u-s,r=new ArrayBuffer(n),i=new Uint8Array(r),o=new Uint8Array(this,s,n),i.set(o),r)}),u.prototype.append=function(e){return this.appendBinary(o(e)),this},u.prototype.appendBinary=function(e){this._buff+=e,this._length+=e.length;var t,n=this._buff.length;for(t=64;t<=n;t+=64)f(this._hash,l(this._buff.substring(t-64,t)));return this._buff=this._buff.substring(t-64),this},u.prototype.end=function(e){var t,n,r=this._buff,i=r.length,o=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<i;t+=1)o[t>>2]|=r.charCodeAt(t)<<(t%4<<3);return this._finish(o,i),n=a(this._hash),e&&(n=s(n)),this.reset(),n},u.prototype.reset=function(){return this._buff=\"\",this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},u.prototype.getState=function(){return{buff:this._buff,length:this._length,hash:this._hash}},u.prototype.setState=function(e){return this._buff=e.buff,this._length=e.length,this._hash=e.hash,this},u.prototype.destroy=function(){delete this._hash,delete this._buff,delete this._length},u.prototype._finish=function(e,t){var n,r,i,o=t;if(e[o>>2]|=128<<(o%4<<3),55<o)for(f(this._hash,e),o=0;o<16;o+=1)e[o]=0;n=(n=8*this._length).toString(16).match(/(.*?)(.{0,8})$/),r=parseInt(n[2],16),i=parseInt(n[1],16)||0,e[14]=r,e[15]=i,f(this._hash,e)},u.hash=function(e,t){return u.hashBinary(o(e),t)},u.hashBinary=function(e,t){var n=a(i(e));return t?s(n):n},(u.ArrayBuffer=function(){this.reset()}).prototype.append=function(e){var t,n=function(e,t,n){var r=new Uint8Array(e.byteLength+t.byteLength);return r.set(new Uint8Array(e)),r.set(new Uint8Array(t),e.byteLength),n?r:r.buffer}(this._buff.buffer,e,!0),r=n.length;for(this._length+=e.byteLength,t=64;t<=r;t+=64)f(this._hash,h(n.subarray(t-64,t)));return this._buff=t-64<r?new Uint8Array(n.buffer.slice(t-64)):new Uint8Array(0),this},u.ArrayBuffer.prototype.end=function(e){var t,n,r=this._buff,i=r.length,o=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<i;t+=1)o[t>>2]|=r[t]<<(t%4<<3);return this._finish(o,i),n=a(this._hash),e&&(n=s(n)),this.reset(),n},u.ArrayBuffer.prototype.reset=function(){return this._buff=new Uint8Array(0),this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},u.ArrayBuffer.prototype.getState=function(){var e=u.prototype.getState.call(this);return e.buff=function(e){return String.fromCharCode.apply(null,new Uint8Array(e))}(e.buff),e},u.ArrayBuffer.prototype.setState=function(e){return e.buff=function(e,t){var n,r=e.length,i=new ArrayBuffer(r),o=new Uint8Array(i);for(n=0;n<r;n+=1)o[n]=e.charCodeAt(n);return t?o:i}(e.buff,!0),u.prototype.setState.call(this,e)},u.ArrayBuffer.prototype.destroy=u.prototype.destroy,u.ArrayBuffer.prototype._finish=u.prototype._finish,u.ArrayBuffer.hash=function(e,t){var n=a(function(e){var t,n,r,i,o,a,s=e.length,u=[1732584193,-271733879,-1732584194,271733878];for(t=64;t<=s;t+=64)f(u,h(e.subarray(t-64,t)));for(n=(e=t-64<s?e.subarray(t-64):new Uint8Array(0)).length,r=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],t=0;t<n;t+=1)r[t>>2]|=e[t]<<(t%4<<3);if(r[t>>2]|=128<<(t%4<<3),55<t)for(f(u,r),t=0;t<16;t+=1)r[t]=0;return i=(i=8*s).toString(16).match(/(.*?)(.{0,8})$/),o=parseInt(i[2],16),a=parseInt(i[1],16)||0,r[14]=o,r[15]=a,f(u,r),u}(new Uint8Array(e)));return t?s(n):n},u})},{}],106:[function(e,t,n){t.exports=r;var f=e(33).EventEmitter;function r(){f.call(this)}e(37)(r,f),r.Readable=e(101),r.Writable=e(103),r.Duplex=e(90),r.Transform=e(102),r.PassThrough=e(100),(r.Stream=r).prototype.pipe=function(t,e){var n=this;function r(e){t.writable&&!1===t.write(e)&&n.pause&&n.pause()}function i(){n.readable&&n.resume&&n.resume()}n.on(\"data\",r),t.on(\"drain\",i),t._isStdio||e&&!1===e.end||(n.on(\"end\",a),n.on(\"close\",s));var o=!1;function a(){o||(o=!0,t.end())}function s(){o||(o=!0,\"function\"==typeof t.destroy&&t.destroy())}function u(e){if(c(),0===f.listenerCount(this,\"error\"))throw e}function c(){n.removeListener(\"data\",r),t.removeListener(\"drain\",i),n.removeListener(\"end\",a),n.removeListener(\"close\",s),n.removeListener(\"error\",u),t.removeListener(\"error\",u),n.removeListener(\"end\",c),n.removeListener(\"close\",c),t.removeListener(\"close\",c)}return n.on(\"error\",u),t.on(\"error\",u),n.on(\"end\",c),n.on(\"close\",c),t.on(\"close\",c),t.emit(\"pipe\",n),t}},{100:100,101:101,102:102,103:103,33:33,37:37,90:90}],107:[function(e,t,n){var r=e(20).Buffer,i=r.isEncoding||function(e){switch(e&&e.toLowerCase()){case\"hex\":case\"utf8\":case\"utf-8\":case\"ascii\":case\"binary\":case\"base64\":case\"ucs2\":case\"ucs-2\":case\"utf16le\":case\"utf-16le\":case\"raw\":return!0;default:return!1}};var o=n.StringDecoder=function(e){switch(this.encoding=(e||\"utf8\").toLowerCase().replace(/[-_]/,\"\"),function(e){if(e&&!i(e))throw new Error(\"Unknown encoding: \"+e)}(e),this.encoding){case\"utf8\":this.surrogateSize=3;break;case\"ucs2\":case\"utf16le\":this.surrogateSize=2,this.detectIncompleteChar=s;break;case\"base64\":this.surrogateSize=3,this.detectIncompleteChar=u;break;default:return void(this.write=a)}this.charBuffer=new r(6),this.charReceived=0,this.charLength=0};function a(e){return e.toString(this.encoding)}function s(e){this.charReceived=e.length%2,this.charLength=this.charReceived?2:0}function u(e){this.charReceived=e.length%3,this.charLength=this.charReceived?3:0}o.prototype.write=function(e){for(var t=\"\";this.charLength;){var n=e.length>=this.charLength-this.charReceived?this.charLength-this.charReceived:e.length;if(e.copy(this.charBuffer,this.charReceived,0,n),this.charReceived+=n,this.charReceived<this.charLength)return\"\";if(e=e.slice(n,e.length),!(55296<=(i=(t=this.charBuffer.slice(0,this.charLength).toString(this.encoding)).charCodeAt(t.length-1))&&i<=56319)){if(this.charReceived=this.charLength=0,0===e.length)return t;break}this.charLength+=this.surrogateSize,t=\"\"}this.detectIncompleteChar(e);var r=e.length;this.charLength&&(e.copy(this.charBuffer,0,e.length-this.charReceived,r),r-=this.charReceived);var i;r=(t+=e.toString(this.encoding,0,r)).length-1;if(55296<=(i=t.charCodeAt(r))&&i<=56319){var o=this.surrogateSize;return this.charLength+=o,this.charReceived+=o,this.charBuffer.copy(this.charBuffer,o,0,o),e.copy(this.charBuffer,0,0,o),t.substring(0,r)}return t},o.prototype.detectIncompleteChar=function(e){for(var t=3<=e.length?3:e.length;0<t;t--){var n=e[e.length-t];if(1==t&&n>>5==6){this.charLength=2;break}if(t<=2&&n>>4==14){this.charLength=3;break}if(t<=3&&n>>3==30){this.charLength=4;break}}this.charReceived=t},o.prototype.end=function(e){var t=\"\";if(e&&e.length&&(t=this.write(e)),this.charReceived){var n=this.charReceived,r=this.charBuffer,i=this.encoding;t+=r.slice(0,n).toString(i)}return t}},{20:20}],108:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}var o=r(e(111)),i=r(e(109)),a=r(e(33)),s=r(e(117)),u=r(e(40));function c(){Error.call(this)}i(c,Error),c.prototype.name=\"NotFoundError\";var f=a.EventEmitter,l=new c,h=function(i,o,r,a){var s=new f;function u(e){var t,n={};if(a)for(t in a)void 0!==a[t]&&(n[t]=a[t]);if(e)for(t in e)void 0!==e[t]&&(n[t]=e[t]);return n}return s.sublevels={},s.options=a,s.version=\"6.5.4\",s.methods={},o=o||[],s.put=function(t,n,e,r){\"function\"==typeof e&&(r=e,e={}),i.apply([{key:t,value:n,prefix:o.slice(),type:\"put\"}],u(e),function(e){if(e)return r(e);s.emit(\"put\",t,n),r(null)})},s.prefix=function(){return o.slice()},s.batch=function(t,e,n){\"function\"==typeof e&&(n=e,e={}),t=t.map(function(e){return{key:e.key,value:e.value,prefix:e.prefix||o,keyEncoding:e.keyEncoding,valueEncoding:e.valueEncoding,type:e.type}}),i.apply(t,u(e),function(e){if(e)return n(e);s.emit(\"batch\",t),n(null)})},s.get=function(e,t,n){\"function\"==typeof t&&(n=t,t={}),i.get(e,o,u(t),function(e,t){e?n(l):n(null,t)})},s.sublevel=function(e,t){return s.sublevels[e]=s.sublevels[e]||h(i,o.concat(e),r,u(t))},s.readStream=s.createReadStream=function(e){var t;(e=u(e)).prefix=o;var n=i.iterator(e);return(t=r(e,i.createDecoder(e))).setIterator(n),t},s.close=function(e){i.close(e)},s.isOpen=i.isOpen,s.isClosed=i.isClosed,s},d=s.Readable;function p(e,t){if(!(this instanceof p))return new p(e,t);d.call(this,{objectMode:!0,highWaterMark:e.highWaterMark}),this._waiting=!1,this._options=e,this._makeData=t}i(p,d),p.prototype.setIterator=function(e){return this._iterator=e,this._destroyed?e.end(function(){}):this._waiting?(this._waiting=!1,this._read()):this},p.prototype._read=function(){var r=this;if(!r._destroyed)return r._iterator?void r._iterator.next(function(e,t,n){if(e||void 0===t&&void 0===n)return e||r._destroyed||r.push(null),r._cleanup(e);n=r._makeData(t,n),r._destroyed||r.push(n)}):this._waiting=!0},p.prototype._cleanup=function(e){if(!this._destroyed){this._destroyed=!0;var t=this;e&&\"iterator has ended\"!==e.message&&t.emit(\"error\",e),t._iterator?t._iterator.end(function(){t._iterator=null,t.emit(\"close\")}):t.emit(\"close\")}},p.prototype.destroy=function(){this._cleanup()};var v={encode:function(e){return\"ÿ\"+e[0]+\"ÿ\"+e[1]},decode:function(e){var t=e.toString(),n=t.indexOf(\"ÿ\",1);return[t.substring(1,n),t.substring(n+1)]},lowerBound:\"\\0\",upperBound:\"ÿ\"},g=new u;t.exports=function(e){return h(function(f,i,l){function h(e,t,n,r){return i.encode([e,l.encodeKey(t,n,r)])}return f.open(function(){}),{apply:function(e,t,n){t=t||{};for(var r,i,o,a=[],s=-1,u=e.length;++s<u;){var c=e[s];(o=(i=c).prefix)&&o.options&&(i.keyEncoding=i.keyEncoding||o.options.keyEncoding,i.valueEncoding=i.valueEncoding||o.options.valueEncoding),c.prefix=function(e){return\"function\"==typeof e}((r=c.prefix).prefix)?r.prefix():r,a.push({key:h(c.prefix,c.key,t,c),value:\"del\"!==c.type&&l.encodeValue(c.value,t,c),type:c.type})}f.db.batch(a,t,n)},get:function(e,t,n,r){return n.asBuffer=l.valueAsBuffer(n),f.db.get(h(t,e,n),n,function(e,t){e?r(e):r(null,l.decodeValue(t,n))})},createDecoder:function(n){return function(e,t){return{key:l.decodeKey(i.decode(e)[1],n),value:l.decodeValue(t,n)}}},isClosed:function(){return f.isClosed()},close:function(e){return f.close(e)},iterator:function(e){var t,n=function(e){var t={};for(var n in e)t[n]=e[n];return t}(e||{}),r=e.prefix||[];return o.toLtgt(e,n,function(e){return h(r,e,n,{})},i.lowerBound,i.upperBound),n.prefix=null,n.keyAsBuffer=n.valueAsBuffer=!1,\"number\"!=typeof n.limit&&(n.limit=-1),n.keyAsBuffer=i.buffer,n.valueAsBuffer=l.valueAsBuffer(n),t=f.db.iterator(n),{next:function(e){return t.next(e)},end:function(e){t.end(e)}}}}}(e,v,g),[],p,e.options)}},{109:109,111:111,117:117,33:33,40:40}],109:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14}],110:[function(e,t,n){t.exports=Array.isArray||function(e){return\"[object Array]\"==Object.prototype.toString.call(e)}},{}],111:[function(e,t,p){(function(o){function a(e){return void 0!==e&&\"\"!==e}function u(e,t){return Object.hasOwnProperty.call(e,t)}function t(e,t){return Object.hasOwnProperty.call(e,t)&&t}p.compare=function(e,t){if(o.isBuffer(e)){for(var n=Math.min(e.length,t.length),r=0;r<n;r++){var i=e[r]-t[r];if(i)return i}return e.length-t.length}return e<t?-1:t<e?1:0};var r=p.lowerBoundKey=function(e){return t(e,\"gt\")||t(e,\"gte\")||t(e,\"min\")||(e.reverse?t(e,\"end\"):t(e,\"start\"))||void 0},s=p.lowerBound=function(e,t){var n=r(e);return n?e[n]:t},n=p.lowerBoundInclusive=function(e){return!u(e,\"gt\")},i=p.upperBoundInclusive=function(e){return!u(e,\"lt\")},c=p.lowerBoundExclusive=function(e){return!n(e)},f=p.upperBoundExclusive=function(e){return!i(e)},l=p.upperBoundKey=function(e){return t(e,\"lt\")||t(e,\"lte\")||t(e,\"max\")||(e.reverse?t(e,\"start\"):t(e,\"end\"))||void 0},h=p.upperBound=function(e,t){var n=l(e);return n?e[n]:t};function d(e){return e}p.start=function(e,t){return e.reverse?h(e,t):s(e,t)},p.end=function(e,t){return e.reverse?s(e,t):h(e,t)},p.startInclusive=function(e){return e.reverse?i(e):n(e)},p.endInclusive=function(e){return e.reverse?n(e):i(e)},p.toLtgt=function(e,t,n,r,i){t=t||{},n=n||d;var o=3<arguments.length,a=p.lowerBoundKey(e),s=p.upperBoundKey(e);return a?\"gt\"===a?t.gt=n(e.gt,!1):t.gte=n(e[a],!1):o&&(t.gte=n(r,!1)),s?\"lt\"===s?t.lt=n(e.lt,!0):t.lte=n(e[s],!0):o&&(t.lte=n(i,!0)),null!=e.reverse&&(t.reverse=!!e.reverse),u(t,\"max\")&&delete t.max,u(t,\"min\")&&delete t.min,u(t,\"start\")&&delete t.start,u(t,\"end\")&&delete t.end,t},p.contains=function(e,t,n){n=n||p.compare;var r=s(e);if(a(r)&&((i=n(t,r))<0||0===i&&c(e)))return!1;var i,o=h(e);if(a(o)&&(0<(i=n(t,o))||0===i&&f(e)))return!1;return!0},p.filter=function(t,n){return function(e){return p.contains(t,e,n)}}}).call(this,{isBuffer:e(38)})},{38:38}],112:[function(s,u,e){(function(e){u.exports=o;var t=Object.keys||function(e){var t=[];for(var n in e)t.push(n);return t},n=s(21);n.inherits=s(109);var r=s(114),i=s(116);function o(e){if(!(this instanceof o))return new o(e);r.call(this,e),i.call(this,e),e&&!1===e.readable&&(this.readable=!1),e&&!1===e.writable&&(this.writable=!1),this.allowHalfOpen=!0,e&&!1===e.allowHalfOpen&&(this.allowHalfOpen=!1),this.once(\"end\",a)}function a(){this.allowHalfOpen||this._writableState.ended||e.nextTick(this.end.bind(this))}n.inherits(o,r),function(e,t){for(var n=0,r=e.length;n<r;n++)t(e[n],n)}(t(i.prototype),function(e){o.prototype[e]||(o.prototype[e]=i.prototype[e])})}).call(this,s(88))},{109:109,114:114,116:116,21:21,88:88}],113:[function(e,t,n){t.exports=o;var r=e(115),i=e(21);function o(e){if(!(this instanceof o))return new o(e);r.call(this,e)}i.inherits=e(109),i.inherits(o,r),o.prototype._transform=function(e,t,n){n(null,e)}},{109:109,115:115,21:21}],114:[function(b,w,e){(function(d){w.exports=n;var p=b(110),h=b(20).Buffer;n.ReadableState=t;var v=b(33).EventEmitter;v.listenerCount||(v.listenerCount=function(e,t){return e.listeners(t).length});var r,i=b(106),e=b(21);function t(e,t){var n=(e=e||{}).highWaterMark;this.highWaterMark=n||0===n?n:16384,this.highWaterMark=~~this.highWaterMark,this.buffer=[],this.length=0,this.pipes=null,this.pipesCount=0,this.flowing=!1,this.ended=!1,this.endEmitted=!1,this.reading=!1,this.calledRead=!1,this.sync=!0,this.needReadable=!1,this.emittedReadable=!1,this.readableListening=!1,this.objectMode=!!e.objectMode,this.defaultEncoding=e.defaultEncoding||\"utf8\",this.ranOut=!1,this.awaitDrain=0,this.readingMore=!1,this.decoder=null,this.encoding=null,e.encoding&&(r=r||b(107).StringDecoder,this.decoder=new r(e.encoding),this.encoding=e.encoding)}function n(e){if(!(this instanceof n))return new n(e);this._readableState=new t(e,this),this.readable=!0,i.call(this)}function o(e,t,n,r,i){var o=function(e,t){var n=null;h.isBuffer(t)||\"string\"==typeof t||null==t||e.objectMode||(n=new TypeError(\"Invalid non-string/buffer chunk\"));return n}(t,n);if(o)e.emit(\"error\",o);else if(null==n)t.reading=!1,t.ended||function(e,t){if(t.decoder&&!t.ended){var n=t.decoder.end();n&&n.length&&(t.buffer.push(n),t.length+=t.objectMode?1:n.length)}t.ended=!0,0<t.length?u(e):_(e)}(e,t);else if(t.objectMode||n&&0<n.length)if(t.ended&&!i){var a=new Error(\"stream.push() after EOF\");e.emit(\"error\",a)}else if(t.endEmitted&&i){a=new Error(\"stream.unshift() after end event\");e.emit(\"error\",a)}else!t.decoder||i||r||(n=t.decoder.write(n)),t.length+=t.objectMode?1:n.length,i?t.buffer.unshift(n):(t.reading=!1,t.buffer.push(n)),t.needReadable&&u(e),function(e,t){t.readingMore||(t.readingMore=!0,d.nextTick(function(){!function(e,t){var n=t.length;for(;!t.reading&&!t.flowing&&!t.ended&&t.length<t.highWaterMark&&(e.read(0),n!==t.length);)n=t.length;t.readingMore=!1}(e,t)}))}(e,t);else i||(t.reading=!1);return function(e){return!e.ended&&(e.needReadable||e.length<e.highWaterMark||0===e.length)}(t)}e.inherits=b(109),e.inherits(n,i),n.prototype.push=function(e,t){var n=this._readableState;return\"string\"!=typeof e||n.objectMode||(t=t||n.defaultEncoding)!==n.encoding&&(e=new h(e,t),t=\"\"),o(this,n,e,t,!1)},n.prototype.unshift=function(e){return o(this,this._readableState,e,\"\",!0)},n.prototype.setEncoding=function(e){r=r||b(107).StringDecoder,this._readableState.decoder=new r(e),this._readableState.encoding=e};var a=8388608;function s(e,t){return 0===t.length&&t.ended?0:t.objectMode?0===e?0:1:null===e||isNaN(e)?t.flowing&&t.buffer.length?t.buffer[0].length:t.length:e<=0?0:(e>t.highWaterMark&&(t.highWaterMark=function(e){if(a<=e)e=a;else{e--;for(var t=1;t<32;t<<=1)e|=e>>t;e++}return e}(e)),e>t.length?t.ended?t.length:(t.needReadable=!0,0):e)}function u(e){var t=e._readableState;t.needReadable=!1,t.emittedReadable||(t.emittedReadable=!0,t.sync?d.nextTick(function(){c(e)}):c(e))}function c(e){e.emit(\"readable\")}function g(e){var r,i=e._readableState;function t(e,t,n){!1===e.write(r)&&i.awaitDrain++}for(i.awaitDrain=0;i.pipesCount&&null!==(r=e.read());)if(1===i.pipesCount?t(i.pipes):m(i.pipes,t),e.emit(\"data\",r),0<i.awaitDrain)return;if(0===i.pipesCount)return i.flowing=!1,void(0<v.listenerCount(e,\"data\")&&f(e));i.ranOut=!0}function y(){this._readableState.ranOut&&(this._readableState.ranOut=!1,g(this))}function f(t,e){if(t._readableState.flowing)throw new Error(\"Cannot switch to old mode now.\");var n=e||!1,r=!1;t.readable=!0,t.pipe=i.prototype.pipe,t.on=t.addListener=i.prototype.on,t.on(\"readable\",function(){var e;for(r=!0;!n&&null!==(e=t.read());)t.emit(\"data\",e);null===e&&(r=!1,t._readableState.needReadable=!0)}),t.pause=function(){n=!0,this.emit(\"pause\")},t.resume=function(){n=!1,r?d.nextTick(function(){t.emit(\"readable\")}):this.read(0),this.emit(\"resume\")},t.emit(\"readable\")}function l(e,t){var n,r=t.buffer,i=t.length,o=!!t.decoder,a=!!t.objectMode;if(0===r.length)return null;if(0===i)n=null;else if(a)n=r.shift();else if(!e||i<=e)n=o?r.join(\"\"):h.concat(r,i),r.length=0;else{if(e<r[0].length)n=(f=r[0]).slice(0,e),r[0]=f.slice(e);else if(e===r[0].length)n=r.shift();else{n=o?\"\":new h(e);for(var s=0,u=0,c=r.length;u<c&&s<e;u++){var f=r[0],l=Math.min(e-s,f.length);o?n+=f.slice(0,l):f.copy(n,s,0,l),l<f.length?r[0]=f.slice(l):r.shift(),s+=l}}}return n}function _(e){var t=e._readableState;if(0<t.length)throw new Error(\"endReadable called on non-empty stream\");!t.endEmitted&&t.calledRead&&(t.ended=!0,d.nextTick(function(){t.endEmitted||0!==t.length||(t.endEmitted=!0,e.readable=!1,e.emit(\"end\"))}))}function m(e,t){for(var n=0,r=e.length;n<r;n++)t(e[n],n)}n.prototype.read=function(e){var t=this._readableState;t.calledRead=!0;var n,r=e;if((\"number\"!=typeof e||0<e)&&(t.emittedReadable=!1),0===e&&t.needReadable&&(t.length>=t.highWaterMark||t.ended))return u(this),null;if(0===(e=s(e,t))&&t.ended)return n=null,0<t.length&&t.decoder&&(n=l(e,t),t.length-=n.length),0===t.length&&_(this),n;var i=t.needReadable;return t.length-e<=t.highWaterMark&&(i=!0),(t.ended||t.reading)&&(i=!1),i&&(t.reading=!0,t.sync=!0,0===t.length&&(t.needReadable=!0),this._read(t.highWaterMark),t.sync=!1),i&&!t.reading&&(e=s(r,t)),null===(n=0<e?l(e,t):null)&&(t.needReadable=!0,e=0),t.length-=e,0!==t.length||t.ended||(t.needReadable=!0),t.ended&&!t.endEmitted&&0===t.length&&_(this),n},n.prototype._read=function(e){this.emit(\"error\",new Error(\"not implemented\"))},n.prototype.pipe=function(t,e){var n=this,r=this._readableState;switch(r.pipesCount){case 0:r.pipes=t;break;case 1:r.pipes=[r.pipes,t];break;default:r.pipes.push(t)}r.pipesCount+=1;var i=(!e||!1!==e.end)&&t!==d.stdout&&t!==d.stderr?a:u;function o(e){e===n&&u()}function a(){t.end()}r.endEmitted?d.nextTick(i):n.once(\"end\",i),t.on(\"unpipe\",o);var s=function(t){return function(){var e=t._readableState;e.awaitDrain--,0===e.awaitDrain&&g(t)}}(n);function u(){t.removeListener(\"close\",f),t.removeListener(\"finish\",l),t.removeListener(\"drain\",s),t.removeListener(\"error\",c),t.removeListener(\"unpipe\",o),n.removeListener(\"end\",a),n.removeListener(\"end\",u),t._writableState&&!t._writableState.needDrain||s()}function c(e){h(),t.removeListener(\"error\",c),0===v.listenerCount(t,\"error\")&&t.emit(\"error\",e)}function f(){t.removeListener(\"finish\",l),h()}function l(){t.removeListener(\"close\",f),h()}function h(){n.unpipe(t)}return t.on(\"drain\",s),t._events&&t._events.error?p(t._events.error)?t._events.error.unshift(c):t._events.error=[c,t._events.error]:t.on(\"error\",c),t.once(\"close\",f),t.once(\"finish\",l),t.emit(\"pipe\",n),r.flowing||(this.on(\"readable\",y),r.flowing=!0,d.nextTick(function(){g(n)})),t},n.prototype.unpipe=function(e){var t=this._readableState;if(0===t.pipesCount)return this;if(1===t.pipesCount)return e&&e!==t.pipes||(e=e||t.pipes,t.pipes=null,t.pipesCount=0,this.removeListener(\"readable\",y),t.flowing=!1,e&&e.emit(\"unpipe\",this)),this;if(e)return-1===(i=function(e,t){for(var n=0,r=e.length;n<r;n++)if(e[n]===t)return n;return-1}(t.pipes,e))||(t.pipes.splice(i,1),t.pipesCount-=1,1===t.pipesCount&&(t.pipes=t.pipes[0]),e.emit(\"unpipe\",this)),this;var n=t.pipes,r=t.pipesCount;t.pipes=null,t.pipesCount=0,this.removeListener(\"readable\",y),t.flowing=!1;for(var i=0;i<r;i++)n[i].emit(\"unpipe\",this);return this},n.prototype.addListener=n.prototype.on=function(e,t){var n=i.prototype.on.call(this,e,t);if(\"data\"!==e||this._readableState.flowing||f(this),\"readable\"===e&&this.readable){var r=this._readableState;r.readableListening||(r.readableListening=!0,r.emittedReadable=!1,r.needReadable=!0,r.reading?r.length&&u(this):this.read(0))}return n},n.prototype.resume=function(){f(this),this.read(0),this.emit(\"resume\")},n.prototype.pause=function(){f(this,!0),this.emit(\"pause\")},n.prototype.wrap=function(t){var n=this._readableState,r=!1,i=this;for(var e in t.on(\"end\",function(){if(n.decoder&&!n.ended){var e=n.decoder.end();e&&e.length&&i.push(e)}i.push(null)}),t.on(\"data\",function(e){n.decoder&&(e=n.decoder.write(e)),n.objectMode&&null==e||(n.objectMode||e&&e.length)&&(i.push(e)||(r=!0,t.pause()))}),t)\"function\"==typeof t[e]&&void 0===this[e]&&(this[e]=function(e){return function(){return t[e].apply(t,arguments)}}(e));return m([\"error\",\"close\",\"destroy\",\"pause\",\"resume\"],function(e){t.on(e,i.emit.bind(i,e))}),i._read=function(e){r&&(r=!1,t.resume())},i},n._fromList=l}).call(this,b(88))},{106:106,107:107,109:109,110:110,20:20,21:21,33:33,88:88}],115:[function(e,t,n){t.exports=a;var r=e(112),i=e(21);function o(e,n){this.afterTransform=function(e,t){return function(e,t,n){var r=e._transformState;r.transforming=!1;var i=r.writecb;if(!i)return e.emit(\"error\",new Error(\"no writecb in Transform class\"));r.writechunk=null,(r.writecb=null)!=n&&e.push(n);i&&i(t);var o=e._readableState;o.reading=!1,(o.needReadable||o.length<o.highWaterMark)&&e._read(o.highWaterMark)}(n,e,t)},this.needTransform=!1,this.transforming=!1,this.writecb=null,this.writechunk=null}function a(e){if(!(this instanceof a))return new a(e);r.call(this,e);this._transformState=new o(e,this);var t=this;this._readableState.needReadable=!0,this._readableState.sync=!1,this.once(\"finish\",function(){\"function\"==typeof this._flush?this._flush(function(e){s(t,e)}):s(t)})}function s(e,t){if(t)return e.emit(\"error\",t);var n=e._writableState,r=(e._readableState,e._transformState);if(n.length)throw new Error(\"calling transform done when ws.length != 0\");if(r.transforming)throw new Error(\"calling transform done when still transforming\");return e.push(null)}i.inherits=e(109),i.inherits(a,r),a.prototype.push=function(e,t){return this._transformState.needTransform=!1,r.prototype.push.call(this,e,t)},a.prototype._transform=function(e,t,n){throw new Error(\"not implemented\")},a.prototype._write=function(e,t,n){var r=this._transformState;if(r.writecb=n,r.writechunk=e,r.writeencoding=t,!r.transforming){var i=this._readableState;(r.needTransform||i.needReadable||i.length<i.highWaterMark)&&this._read(i.highWaterMark)}},a.prototype._read=function(e){var t=this._transformState;null!==t.writechunk&&t.writecb&&!t.transforming?(t.transforming=!0,this._transform(t.writechunk,t.writeencoding,t.afterTransform)):t.needTransform=!0}},{109:109,112:112,21:21}],116:[function(h,t,e){(function(a){t.exports=i;var s=h(20).Buffer;i.WritableState=r;var e=h(21);e.inherits=h(109);var n=h(106);function u(e,t,n){this.chunk=e,this.encoding=t,this.callback=n}function r(e,t){var n=(e=e||{}).highWaterMark;this.highWaterMark=n||0===n?n:16384,this.objectMode=!!e.objectMode,this.highWaterMark=~~this.highWaterMark,this.needDrain=!1,this.ending=!1,this.ended=!1;var r=(this.finished=!1)===e.decodeStrings;this.decodeStrings=!r,this.defaultEncoding=e.defaultEncoding||\"utf8\",this.length=0,this.writing=!1,this.sync=!0,this.bufferProcessing=!1,this.onwrite=function(e){!function(e,t){var n=e._writableState,r=n.sync,i=n.writecb;if(function(e){e.writing=!1,e.writecb=null,e.length-=e.writelen,e.writelen=0}(n),t)!function(e,t,n,r,i){n?a.nextTick(function(){i(r)}):i(r);e._writableState.errorEmitted=!0,e.emit(\"error\",r)}(e,0,r,t,i);else{var o=l(e,n);o||n.bufferProcessing||!n.buffer.length||function(e,t){t.bufferProcessing=!0;for(var n=0;n<t.buffer.length;n++){var r=t.buffer[n],i=r.chunk,o=r.encoding,a=r.callback,s=t.objectMode?1:i.length;if(c(e,t,s,i,o,a),t.writing){n++;break}}t.bufferProcessing=!1,n<t.buffer.length?t.buffer=t.buffer.slice(n):t.buffer.length=0}(e,n),r?a.nextTick(function(){f(e,n,o,i)}):f(e,n,o,i)}}(t,e)},this.writecb=null,this.writelen=0,this.buffer=[],this.errorEmitted=!1}function i(e){var t=h(112);if(!(this instanceof i||this instanceof t))return new i(e);this._writableState=new r(e,this),this.writable=!0,n.call(this)}function c(e,t,n,r,i,o){t.writelen=n,t.writecb=o,t.writing=!0,t.sync=!0,e._write(r,i,t.onwrite),t.sync=!1}function f(e,t,n,r){n||function(e,t){0===t.length&&t.needDrain&&(t.needDrain=!1,e.emit(\"drain\"))}(e,t),r(),n&&o(e,t)}function l(e,t){return t.ending&&0===t.length&&!t.finished&&!t.writing}function o(e,t){var n=l(0,t);return n&&(t.finished=!0,e.emit(\"finish\")),n}e.inherits(i,n),i.prototype.pipe=function(){this.emit(\"error\",new Error(\"Cannot pipe. Not readable.\"))},i.prototype.write=function(e,t,n){var r=this._writableState,i=!1;return\"function\"==typeof t&&(n=t,t=null),t=s.isBuffer(e)?\"buffer\":t||r.defaultEncoding,\"function\"!=typeof n&&(n=function(){}),r.ended?function(e,t,n){var r=new Error(\"write after end\");e.emit(\"error\",r),a.nextTick(function(){n(r)})}(this,0,n):function(e,t,n,r){var i=!0;if(!s.isBuffer(n)&&\"string\"!=typeof n&&null!=n&&!t.objectMode){var o=new TypeError(\"Invalid non-string/buffer chunk\");e.emit(\"error\",o),a.nextTick(function(){r(o)}),i=!1}return i}(this,r,e,n)&&(i=function(e,t,n,r,i){n=function(e,t,n){e.objectMode||!1===e.decodeStrings||\"string\"!=typeof t||(t=new s(t,n));return t}(t,n,r),s.isBuffer(n)&&(r=\"buffer\");var o=t.objectMode?1:n.length;t.length+=o;var a=t.length<t.highWaterMark;a||(t.needDrain=!0);t.writing?t.buffer.push(new u(n,r,i)):c(e,t,o,n,r,i);return a}(this,r,e,t,n)),i},i.prototype._write=function(e,t,n){n(new Error(\"not implemented\"))},i.prototype.end=function(e,t,n){var r=this._writableState;\"function\"==typeof e?(n=e,t=e=null):\"function\"==typeof t&&(n=t,t=null),null!=e&&this.write(e,t),r.ending||r.finished||function(e,t,n){t.ending=!0,o(e,t),n&&(t.finished?a.nextTick(n):e.once(\"finish\",n));t.ended=!0}(this,r,n)}}).call(this,h(88))},{106:106,109:109,112:112,20:20,21:21,88:88}],117:[function(e,t,n){var r=e(106);(n=t.exports=e(114)).Stream=r,(n.Readable=n).Writable=e(116),n.Duplex=e(112),n.Transform=e(115),n.PassThrough=e(113)},{106:106,112:112,113:113,114:114,115:115,116:116}],118:[function(r,u,e){(function(n){var t=r(102),i=r(123).inherits,o=r(130);function a(e){t.call(this,e),this._destroyed=!1}function s(e,t,n){n(null,e)}function e(r){return function(e,t,n){return\"function\"==typeof e&&(n=t,t=e,e={}),\"function\"!=typeof t&&(t=s),\"function\"!=typeof n&&(n=null),r(e,t,n)}}i(a,t),a.prototype.destroy=function(e){if(!this._destroyed){this._destroyed=!0;var t=this;n.nextTick(function(){e&&t.emit(\"error\",e),t.emit(\"close\")})}},u.exports=e(function(e,t,n){var r=new a(e);return r._transform=t,n&&(r._flush=n),r}),u.exports.ctor=e(function(t,e,n){function r(e){if(!(this instanceof r))return new r(e);this.options=o(t,e),a.call(this,this.options)}return i(r,a),r.prototype._transform=e,n&&(r.prototype._flush=n),r}),u.exports.obj=e(function(e,t,n){var r=new a(o({objectMode:!0,highWaterMark:16},e));return r._transform=t,n&&(r._flush=n),r})}).call(this,r(88))},{102:102,123:123,130:130,88:88}],119:[function(u,e,c){(function(e,t){var r=u(88).nextTick,n=Function.prototype.apply,i=Array.prototype.slice,o={},a=0;function s(e,t){this._id=e,this._clearFn=t}c.setTimeout=function(){return new s(n.call(setTimeout,window,arguments),clearTimeout)},c.setInterval=function(){return new s(n.call(setInterval,window,arguments),clearInterval)},c.clearTimeout=c.clearInterval=function(e){e.close()},s.prototype.unref=s.prototype.ref=function(){},s.prototype.close=function(){this._clearFn.call(window,this._id)},c.enroll=function(e,t){clearTimeout(e._idleTimeoutId),e._idleTimeout=t},c.unenroll=function(e){clearTimeout(e._idleTimeoutId),e._idleTimeout=-1},c._unrefActive=c.active=function(e){clearTimeout(e._idleTimeoutId);var t=e._idleTimeout;0<=t&&(e._idleTimeoutId=setTimeout(function(){e._onTimeout&&e._onTimeout()},t))},c.setImmediate=\"function\"==typeof e?e:function(e){var t=a++,n=!(arguments.length<2)&&i.call(arguments,1);return o[t]=!0,r(function(){o[t]&&(n?e.apply(null,n):e.call(null),c.clearImmediate(t))}),t},c.clearImmediate=\"function\"==typeof t?t:function(e){delete o[e]}}).call(this,u(119).setImmediate,u(119).clearImmediate)},{119:119,88:88}],120:[function(e,t,n){(function(n){function r(e){try{if(!n.localStorage)return!1}catch(e){return!1}var t=n.localStorage[e];return null!=t&&\"true\"===String(t).toLowerCase()}t.exports=function(e,t){if(r(\"noDeprecation\"))return e;var n=!1;return function(){if(!n){if(r(\"throwDeprecation\"))throw new Error(t);r(\"traceDeprecation\")?console.trace(t):console.warn(t),n=!0}return e.apply(this,arguments)}}}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],121:[function(e,t,n){arguments[4][14][0].apply(n,arguments)},{14:14}],122:[function(e,t,n){arguments[4][15][0].apply(n,arguments)},{15:15}],123:[function(e,t,n){arguments[4][16][0].apply(n,arguments)},{121:121,122:122,16:16,88:88}],124:[function(e,t,n){var r=e(127),i=e(128),o=i;o.v1=r,o.v4=i,t.exports=o},{127:127,128:128}],125:[function(e,t,n){for(var i=[],r=0;r<256;++r)i[r]=(r+256).toString(16).substr(1);t.exports=function(e,t){var n=t||0,r=i;return r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]}},{}],126:[function(e,t,n){var r=\"undefined\"!=typeof crypto&&crypto.getRandomValues.bind(crypto)||\"undefined\"!=typeof msCrypto&&msCrypto.getRandomValues.bind(msCrypto);if(r){var i=new Uint8Array(16);t.exports=function(){return r(i),i}}else{var o=new Array(16);t.exports=function(){for(var e,t=0;t<16;t++)0==(3&t)&&(e=4294967296*Math.random()),o[t]=e>>>((3&t)<<3)&255;return o}}},{}],127:[function(e,t,n){var p,v,g=e(126),y=e(125),_=0,m=0;t.exports=function(e,t,n){var r=t&&n||0,i=t||[],o=(e=e||{}).node||p,a=void 0!==e.clockseq?e.clockseq:v;if(null==o||null==a){var s=g();null==o&&(o=p=[1|s[0],s[1],s[2],s[3],s[4],s[5]]),null==a&&(a=v=16383&(s[6]<<8|s[7]))}var u=void 0!==e.msecs?e.msecs:(new Date).getTime(),c=void 0!==e.nsecs?e.nsecs:m+1,f=u-_+(c-m)/1e4;if(f<0&&void 0===e.clockseq&&(a=a+1&16383),(f<0||_<u)&&void 0===e.nsecs&&(c=0),1e4<=c)throw new Error(\"uuid.v1(): Can't create more than 10M uuids/sec\");_=u,v=a;var l=(1e4*(268435455&(u+=122192928e5))+(m=c))%4294967296;i[r++]=l>>>24&255,i[r++]=l>>>16&255,i[r++]=l>>>8&255,i[r++]=255&l;var h=u/4294967296*1e4&268435455;i[r++]=h>>>8&255,i[r++]=255&h,i[r++]=h>>>24&15|16,i[r++]=h>>>16&255,i[r++]=a>>>8|128,i[r++]=255&a;for(var d=0;d<6;++d)i[r+d]=o[d];return t||y(i)}},{125:125,126:126}],128:[function(e,t,n){var a=e(126),s=e(125);t.exports=function(e,t,n){var r=t&&n||0;\"string\"==typeof e&&(t=\"binary\"===e?new Array(16):null,e=null);var i=(e=e||{}).random||(e.rng||a)();if(i[6]=15&i[6]|64,i[8]=63&i[8]|128,t)for(var o=0;o<16;++o)t[r+o]=i[o];return t||s(i)}},{125:125,126:126}],129:[function(e,t,n){\"use strict\";function d(e,t,n){var r=n[n.length-1];e===r.element&&(n.pop(),r=n[n.length-1]);var i=r.element,o=r.index;if(Array.isArray(i))i.push(e);else if(o===t.length-2){i[t.pop()]=e}else t.push(e)}n.stringify=function(e){var t=[];t.push({obj:e});for(var n,r,i,o,a,s,u,c,f,l,h=\"\";n=t.pop();)if(r=n.obj,h+=n.prefix||\"\",i=n.val||\"\")h+=i;else if(\"object\"!=typeof r)h+=void 0===r?null:JSON.stringify(r);else if(null===r)h+=\"null\";else if(Array.isArray(r)){for(t.push({val:\"]\"}),o=r.length-1;0<=o;o--)a=0===o?\"\":\",\",t.push({obj:r[o],prefix:a});t.push({val:\"[\"})}else{for(u in s=[],r)r.hasOwnProperty(u)&&s.push(u);for(t.push({val:\"}\"}),o=s.length-1;0<=o;o--)f=r[c=s[o]],l=0<o?\",\":\"\",l+=JSON.stringify(c)+\":\",t.push({obj:f,prefix:l});t.push({val:\"{\"})}return h},n.parse=function(e){for(var t,n,r,i,o,a,s,u,c,f=[],l=[],h=0;;)if(\"}\"!==(t=e[h++])&&\"]\"!==t&&void 0!==t)switch(t){case\" \":case\"\\t\":case\"\\n\":case\":\":case\",\":break;case\"n\":h+=3,d(null,f,l);break;case\"t\":h+=3,d(!0,f,l);break;case\"f\":h+=4,d(!1,f,l);break;case\"0\":case\"1\":case\"2\":case\"3\":case\"4\":case\"5\":case\"6\":case\"7\":case\"8\":case\"9\":case\"-\":for(n=\"\",h--;;){if(r=e[h++],!/[\\d\\.\\-e\\+]/.test(r)){h--;break}n+=r}d(parseFloat(n),f,l);break;case'\"':for(i=\"\",o=void 0,a=0;'\"'!==(s=e[h++])||\"\\\\\"===o&&a%2==1;)i+=s,\"\\\\\"===(o=s)?a++:a=0;d(JSON.parse('\"'+i+'\"'),f,l);break;case\"[\":u={element:[],index:f.length},f.push(u.element),l.push(u);break;case\"{\":c={element:{},index:f.length},f.push(c.element),l.push(c);break;default:throw new Error(\"unexpectedly reached end of input: \"+t)}else{if(1===f.length)return f.pop();d(f.pop(),f,l)}}},{}],130:[function(e,t,n){t.exports=function(){for(var e={},t=0;t<arguments.length;t++){var n=arguments[t];for(var r in n)i.call(n,r)&&(e[r]=n[r])}return e};var i=Object.prototype.hasOwnProperty},{}]},{},[3]);";
},{}],12:[function(_dereq_,module,exports){
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
},{}],13:[function(_dereq_,module,exports){
(function (process){
/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = _dereq_(14);
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  '#0000CC', '#0000FF', '#0033CC', '#0033FF', '#0066CC', '#0066FF', '#0099CC',
  '#0099FF', '#00CC00', '#00CC33', '#00CC66', '#00CC99', '#00CCCC', '#00CCFF',
  '#3300CC', '#3300FF', '#3333CC', '#3333FF', '#3366CC', '#3366FF', '#3399CC',
  '#3399FF', '#33CC00', '#33CC33', '#33CC66', '#33CC99', '#33CCCC', '#33CCFF',
  '#6600CC', '#6600FF', '#6633CC', '#6633FF', '#66CC00', '#66CC33', '#9900CC',
  '#9900FF', '#9933CC', '#9933FF', '#99CC00', '#99CC33', '#CC0000', '#CC0033',
  '#CC0066', '#CC0099', '#CC00CC', '#CC00FF', '#CC3300', '#CC3333', '#CC3366',
  '#CC3399', '#CC33CC', '#CC33FF', '#CC6600', '#CC6633', '#CC9900', '#CC9933',
  '#CCCC00', '#CCCC33', '#FF0000', '#FF0033', '#FF0066', '#FF0099', '#FF00CC',
  '#FF00FF', '#FF3300', '#FF3333', '#FF3366', '#FF3399', '#FF33CC', '#FF33FF',
  '#FF6600', '#FF6633', '#FF9900', '#FF9933', '#FFCC00', '#FFCC33'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // NB: In an Electron preload script, document will be defined but not fully
  // initialized. Since we know we're in Chrome, we'll just detect this case
  // explicitly
  if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
    return true;
  }

  // Internet Explorer and Edge do not support colors.
  if (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
    return false;
  }

  // is webkit? http://stackoverflow.com/a/16459606/376773
  // document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
  return (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (typeof window !== 'undefined' && window.console && (window.console.firebug || (window.console.exception && window.console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    // double check webkit in userAgent just in case we are in a worker
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  try {
    return JSON.stringify(v);
  } catch (err) {
    return '[UnexpectedJSONParseError]: ' + err.message;
  }
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs(args) {
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return;

  var c = 'color: ' + this.color;
  args.splice(1, 0, c, 'color: inherit')

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-zA-Z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = exports.storage.debug;
  } catch(e) {}

  // If debug isn't set in LS, and we're in Electron, try to load $DEBUG
  if (!r && typeof process !== 'undefined' && 'env' in process) {
    r = process.env.DEBUG;
  }

  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage() {
  try {
    return window.localStorage;
  } catch (e) {}
}

}).call(this,_dereq_(29))
},{"14":14,"29":29}],14:[function(_dereq_,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = createDebug.debug = createDebug['default'] = createDebug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = _dereq_(20);

/**
 * Active `debug` instances.
 */
exports.instances = [];

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
 */

exports.formatters = {};

/**
 * Select a color.
 * @param {String} namespace
 * @return {Number}
 * @api private
 */

function selectColor(namespace) {
  var hash = 0, i;

  for (i in namespace) {
    hash  = ((hash << 5) - hash) + namespace.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  return exports.colors[Math.abs(hash) % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function createDebug(namespace) {

  var prevTime;

  function debug() {
    // disabled?
    if (!debug.enabled) return;

    var self = debug;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // turn the `arguments` into a proper Array
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %O
      args.unshift('%O');
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    // apply env-specific formatting (colors, etc.)
    exports.formatArgs.call(self, args);

    var logFn = debug.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }

  debug.namespace = namespace;
  debug.enabled = exports.enabled(namespace);
  debug.useColors = exports.useColors();
  debug.color = selectColor(namespace);
  debug.destroy = destroy;

  // env-specific initialization logic for debug instances
  if ('function' === typeof exports.init) {
    exports.init(debug);
  }

  exports.instances.push(debug);

  return debug;
}

function destroy () {
  var index = exports.instances.indexOf(this);
  if (index !== -1) {
    exports.instances.splice(index, 1);
    return true;
  } else {
    return false;
  }
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  exports.names = [];
  exports.skips = [];

  var i;
  var split = (typeof namespaces === 'string' ? namespaces : '').split(/[\s,]+/);
  var len = split.length;

  for (i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }

  for (i = 0; i < exports.instances.length; i++) {
    var instance = exports.instances[i];
    instance.enabled = exports.enabled(instance.namespace);
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  if (name[name.length - 1] === '*') {
    return true;
  }
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"20":20}],15:[function(_dereq_,module,exports){
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

},{}],16:[function(_dereq_,module,exports){
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
},{}],17:[function(_dereq_,module,exports){
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

},{}],18:[function(_dereq_,module,exports){
(function(factory) {
  if(typeof exports === 'object') {
    factory(exports);
  } else {
    factory(this);
  }
}).call(this, function(root) { 

  var slice   = Array.prototype.slice,
      each    = Array.prototype.forEach;

  var extend = function(obj) {
    if(typeof obj !== 'object') throw obj + ' is not an object' ;

    var sources = slice.call(arguments, 1); 

    each.call(sources, function(source) {
      if(source) {
        for(var prop in source) {
          if(typeof source[prop] === 'object' && obj[prop]) {
            extend.call(obj, obj[prop], source[prop]);
          } else {
            obj[prop] = source[prop];
          }
        } 
      }
    });

    return obj;
  }

  root.extend = extend;
});

},{}],19:[function(_dereq_,module,exports){
'use strict';
var immediate = _dereq_(16);

/* istanbul ignore next */
function INTERNAL() {}

var handlers = {};

var REJECTED = ['REJECTED'];
var FULFILLED = ['FULFILLED'];
var PENDING = ['PENDING'];

module.exports = Promise;

function Promise(resolver) {
  if (typeof resolver !== 'function') {
    throw new TypeError('resolver must be a function');
  }
  this.state = PENDING;
  this.queue = [];
  this.outcome = void 0;
  if (resolver !== INTERNAL) {
    safelyResolveThenable(this, resolver);
  }
}

Promise.prototype["finally"] = function (callback) {
  if (typeof callback !== 'function') {
    return this;
  }
  var p = this.constructor;
  return this.then(resolve, reject);

  function resolve(value) {
    function yes () {
      return value;
    }
    return p.resolve(callback()).then(yes);
  }
  function reject(reason) {
    function no () {
      throw reason;
    }
    return p.resolve(callback()).then(no);
  }
};
Promise.prototype["catch"] = function (onRejected) {
  return this.then(null, onRejected);
};
Promise.prototype.then = function (onFulfilled, onRejected) {
  if (typeof onFulfilled !== 'function' && this.state === FULFILLED ||
    typeof onRejected !== 'function' && this.state === REJECTED) {
    return this;
  }
  var promise = new this.constructor(INTERNAL);
  if (this.state !== PENDING) {
    var resolver = this.state === FULFILLED ? onFulfilled : onRejected;
    unwrap(promise, resolver, this.outcome);
  } else {
    this.queue.push(new QueueItem(promise, onFulfilled, onRejected));
  }

  return promise;
};
function QueueItem(promise, onFulfilled, onRejected) {
  this.promise = promise;
  if (typeof onFulfilled === 'function') {
    this.onFulfilled = onFulfilled;
    this.callFulfilled = this.otherCallFulfilled;
  }
  if (typeof onRejected === 'function') {
    this.onRejected = onRejected;
    this.callRejected = this.otherCallRejected;
  }
}
QueueItem.prototype.callFulfilled = function (value) {
  handlers.resolve(this.promise, value);
};
QueueItem.prototype.otherCallFulfilled = function (value) {
  unwrap(this.promise, this.onFulfilled, value);
};
QueueItem.prototype.callRejected = function (value) {
  handlers.reject(this.promise, value);
};
QueueItem.prototype.otherCallRejected = function (value) {
  unwrap(this.promise, this.onRejected, value);
};

function unwrap(promise, func, value) {
  immediate(function () {
    var returnValue;
    try {
      returnValue = func(value);
    } catch (e) {
      return handlers.reject(promise, e);
    }
    if (returnValue === promise) {
      handlers.reject(promise, new TypeError('Cannot resolve promise with itself'));
    } else {
      handlers.resolve(promise, returnValue);
    }
  });
}

handlers.resolve = function (self, value) {
  var result = tryCatch(getThen, value);
  if (result.status === 'error') {
    return handlers.reject(self, result.value);
  }
  var thenable = result.value;

  if (thenable) {
    safelyResolveThenable(self, thenable);
  } else {
    self.state = FULFILLED;
    self.outcome = value;
    var i = -1;
    var len = self.queue.length;
    while (++i < len) {
      self.queue[i].callFulfilled(value);
    }
  }
  return self;
};
handlers.reject = function (self, error) {
  self.state = REJECTED;
  self.outcome = error;
  var i = -1;
  var len = self.queue.length;
  while (++i < len) {
    self.queue[i].callRejected(error);
  }
  return self;
};

function getThen(obj) {
  // Make sure we only access the accessor once as required by the spec
  var then = obj && obj.then;
  if (obj && (typeof obj === 'object' || typeof obj === 'function') && typeof then === 'function') {
    return function appyThen() {
      then.apply(obj, arguments);
    };
  }
}

function safelyResolveThenable(self, thenable) {
  // Either fulfill, reject or reject with error
  var called = false;
  function onError(value) {
    if (called) {
      return;
    }
    called = true;
    handlers.reject(self, value);
  }

  function onSuccess(value) {
    if (called) {
      return;
    }
    called = true;
    handlers.resolve(self, value);
  }

  function tryToUnwrap() {
    thenable(onSuccess, onError);
  }

  var result = tryCatch(tryToUnwrap);
  if (result.status === 'error') {
    onError(result.value);
  }
}

function tryCatch(func, value) {
  var out = {};
  try {
    out.value = func(value);
    out.status = 'success';
  } catch (e) {
    out.status = 'error';
    out.value = e;
  }
  return out;
}

Promise.resolve = resolve;
function resolve(value) {
  if (value instanceof this) {
    return value;
  }
  return handlers.resolve(new this(INTERNAL), value);
}

Promise.reject = reject;
function reject(reason) {
  var promise = new this(INTERNAL);
  return handlers.reject(promise, reason);
}

Promise.all = all;
function all(iterable) {
  var self = this;
  if (Object.prototype.toString.call(iterable) !== '[object Array]') {
    return this.reject(new TypeError('must be an array'));
  }

  var len = iterable.length;
  var called = false;
  if (!len) {
    return this.resolve([]);
  }

  var values = new Array(len);
  var resolved = 0;
  var i = -1;
  var promise = new this(INTERNAL);

  while (++i < len) {
    allResolver(iterable[i], i);
  }
  return promise;
  function allResolver(value, i) {
    self.resolve(value).then(resolveFromAll, function (error) {
      if (!called) {
        called = true;
        handlers.reject(promise, error);
      }
    });
    function resolveFromAll(outValue) {
      values[i] = outValue;
      if (++resolved === len && !called) {
        called = true;
        handlers.resolve(promise, values);
      }
    }
  }
}

Promise.race = race;
function race(iterable) {
  var self = this;
  if (Object.prototype.toString.call(iterable) !== '[object Array]') {
    return this.reject(new TypeError('must be an array'));
  }

  var len = iterable.length;
  var called = false;
  if (!len) {
    return this.resolve([]);
  }

  var i = -1;
  var promise = new this(INTERNAL);

  while (++i < len) {
    resolver(iterable[i]);
  }
  return promise;
  function resolver(value) {
    self.resolve(value).then(function (response) {
      if (!called) {
        called = true;
        handlers.resolve(promise, response);
      }
    }, function (error) {
      if (!called) {
        called = true;
        handlers.reject(promise, error);
      }
    });
  }
}

},{"16":16}],20:[function(_dereq_,module,exports){
/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} [options]
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options) {
  options = options || {};
  var type = typeof val;
  if (type === 'string' && val.length > 0) {
    return parse(val);
  } else if (type === 'number' && isNaN(val) === false) {
    return options["long"] ? fmtLong(val) : fmtShort(val);
  }
  throw new Error(
    'val is not a non-empty string or a valid number. val=' +
      JSON.stringify(val)
  );
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str);
  if (str.length > 100) {
    return;
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(
    str
  );
  if (!match) {
    return;
  }
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
    default:
      return undefined;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  if (ms >= d) {
    return Math.round(ms / d) + 'd';
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h';
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm';
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's';
  }
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  return plural(ms, d, 'day') ||
    plural(ms, h, 'hour') ||
    plural(ms, m, 'minute') ||
    plural(ms, s, 'second') ||
    ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return;
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name;
  }
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],21:[function(_dereq_,module,exports){
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

},{}],22:[function(_dereq_,module,exports){
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
Map$1.prototype["delete"] = function (key) {
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

},{}],23:[function(_dereq_,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var inherits = _interopDefault(_dereq_(24));

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

},{"24":24}],24:[function(_dereq_,module,exports){
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

},{}],25:[function(_dereq_,module,exports){
(function (global){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var pouchdbBinaryUtils = _dereq_(21);
var Md5 = _interopDefault(_dereq_(30));

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
},{"21":21,"30":30}],26:[function(_dereq_,module,exports){
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

},{}],27:[function(_dereq_,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var getArguments = _interopDefault(_dereq_(12));
var pouchdbCollections = _dereq_(22);
var immediate = _interopDefault(_dereq_(16));
var events = _dereq_(15);
var inherits = _interopDefault(_dereq_(28));
var pouchdbErrors = _dereq_(23);
var uuidV4 = _interopDefault(_dereq_(31));
var pouchdbMd5 = _dereq_(25);
var pouchdbUtils = _dereq_(27);

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

},{"12":12,"15":15,"16":16,"22":22,"23":23,"25":25,"27":27,"28":28,"31":31}],28:[function(_dereq_,module,exports){
arguments[4][24][0].apply(exports,arguments)
},{"24":24}],29:[function(_dereq_,module,exports){
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

},{}],30:[function(_dereq_,module,exports){
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

},{}],31:[function(_dereq_,module,exports){
var v1 = _dereq_(34);
var v4 = _dereq_(35);

var uuid = v4;
uuid.v1 = v1;
uuid.v4 = v4;

module.exports = uuid;

},{"34":34,"35":35}],32:[function(_dereq_,module,exports){
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

},{}],33:[function(_dereq_,module,exports){
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

},{}],34:[function(_dereq_,module,exports){
var rng = _dereq_(33);
var bytesToUuid = _dereq_(32);

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

},{"32":32,"33":33}],35:[function(_dereq_,module,exports){
var rng = _dereq_(33);
var bytesToUuid = _dereq_(32);

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

},{"32":32,"33":33}],36:[function(_dereq_,module,exports){
'use strict';

module.exports = _dereq_(4);
},{"4":4}]},{},[36])(36)
});
