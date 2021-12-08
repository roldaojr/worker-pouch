#!/usr/bin/env node
const COUCH_HOST = process.env.COUCH_HOST || 'http://127.0.0.1:5984'
const HTTP_PORT = 8001
const CORS_PORT = 2020

const cors_proxy = require('corsproxy')
const watch = require('watch-glob')
const Promise = require('lie')
const http_proxy = require('pouchdb-http-proxy')
const http_server = require('http-server')
const debounce = require('lodash.debounce')
const fs = require('fs')
const browserify = require('browserify')

let filesWritten = false
let serverStarted = false
let readyCallback

let rebuildPromise = Promise.resolve()

function browserifyPromise (src, dest) {
  return new Promise((resolve, reject) => {
    browserify(src, { debug: true }).bundle().pipe(fs.createWriteStream(dest))
      .on('finish', resolve)
      .on('error', reject)
  })
}

function rebuildServiceWorker () {
  rebuildPromise = rebuildPromise.then(() => browserifyPromise(
    './test/custom-api/service-worker.js',
    './test/sw.js'
  )).then(() => {
    console.log('Rebuilt test/sw.js')
  }).catch(console.error)
  return rebuildPromise
}

function rebuildServiceWorkerTest () {
  rebuildPromise = rebuildPromise.then(() => browserifyPromise(
    './test/custom-api/service-worker-test.js',
    './test/sw-test-bundle.js'
  )).then(() => {
    console.log('Rebuilt test/sw-test-bundle.js')
  }).catch(console.error)
  return rebuildPromise
}

function rebuildTestBundle () {
  rebuildPromise = rebuildPromise.then(() => browserifyPromise(
    './test/test.js',
    './test/test-bundle.js'
  )).then(() => {
    console.log('Rebuilt test/test-bundle.js')
  }).catch(console.error)
  return rebuildPromise
}

function watchAll () {
  watch(
    ['./test/custom-api/service-worker.js'],
    debounce(rebuildServiceWorker, 700, { leading: true })
  )
  watch(
    ['./test/custom-api/service-worker-test.js'],
    debounce(rebuildServiceWorkerTest, 700, { leading: true })
  )
  watch(
    ['./test/test.js";'],
    debounce(rebuildTestBundle, 700, { leading: true })
  )
}

Promise.all([
  rebuildTestBundle(),
  rebuildServiceWorker(),
  rebuildServiceWorkerTest()
]).then(() => {
  console.log('Rebuilt test bundles')
  filesWritten = true
  checkReady()
})
function startServers (callback) {
  readyCallback = callback

  return new Promise((resolve, reject) => {
    http_server.createServer().listen(HTTP_PORT, err => {
      if (err) {
        return reject(err)
      }
      cors_proxy.options = { target: COUCH_HOST }
      http_proxy.createServer(cors_proxy).listen(CORS_PORT, err => {
        if (err) {
          return reject(err)
        }
        resolve()
      })
    })
  }).then(() => {
    console.log(`Tests: http://127.0.0.1:${HTTP_PORT}/test/index.html`)
    serverStarted = true
    checkReady()
  }).catch(err => {
    if (err) {
      console.log(err)
      process.exit(1)
    }
  })
}

function checkReady () {
  if (filesWritten && serverStarted && readyCallback) {
    readyCallback()
  }
}

if (require.main === module) {
  startServers()
  watchAll()
} else {
  module.exports.start = startServers
}
