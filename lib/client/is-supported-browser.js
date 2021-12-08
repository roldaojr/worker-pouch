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
