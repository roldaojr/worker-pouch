#!/usr/bin/env node
const wd = require('wd')
const sauceConnectLauncher = require('sauce-connect-launcher')
const selenium = require('selenium-standalone')
const querystring = require('querystring')
const devserver = require('./dev-server.js')

const testTimeout = 30 * 60 * 1000

const username = process.env.SAUCE_USERNAME
const accessKey = process.env.SAUCE_ACCESS_KEY

// process.env.CLIENT is a colon seperated list of
// (saucelabs|selenium):browserName:browserVerion:platform
const tmp = (process.env.CLIENT || 'selenium:firefox').split(':')
const client = {
  runner: tmp[0] || 'selenium',
  browser: tmp[1] || 'firefox',
  version: tmp[2] || null, // Latest
  platform: tmp[3] || null
}

let testUrl = 'http://127.0.0.1:8000/test/index.html'
if (typeof process.env.SUITE === 'string') {
  testUrl = `http://127.0.0.1:8000/test/index-suite${process.env.SUITE
  }.html`
}
const qs = {}

let sauceClient
let sauceConnectProcess
const tunnelId = process.env.TRAVIS_JOB_NUMBER || `tunnel-${Date.now()}`

if (client.runner === 'saucelabs') {
  qs.saucelabs = true
}
if (process.env.GREP) {
  qs.grep = process.env.GREP
}
testUrl += '?'
testUrl += querystring.stringify(qs)

if (process.env.TRAVIS
    && client.browser !== 'firefox'
    && client.browser !== 'phantomjs'
    && process.env.TRAVIS_SECURE_ENV_VARS === 'false') {
  console.error('Not running test, cannot connect to saucelabs')
  process.exit(1)
  return
}

function testError (e) {
  console.error(e)
  console.error('Doh, tests failed')
  sauceClient.quit()
  process.exit(3)
}

function postResult (result) {
  process.exit(!process.env.PERF && result.failed ? 1 : 0)
}

function testComplete (result) {
  console.log(result)

  sauceClient.quit().then(() => {
    if (sauceConnectProcess) {
      sauceConnectProcess.close(() => {
        postResult(result)
      })
    } else {
      postResult(result)
    }
  })
}

function startSelenium (callback) {
  // Start selenium
  const opts = {}
  selenium.install(opts, err => {
    if (err) {
      console.error('Failed to install selenium', err)
      process.exit(1)
    }
    selenium.start(opts, (err, server) => {
      sauceClient = wd.promiseChainRemote()
      callback()
    })
  })
}

function startSauceConnect (callback) {
  const options = {
    username,
    accessKey,
    tunnelIdentifier: tunnelId
  }

  sauceConnectLauncher(options, (err, process) => {
    if (err) {
      console.error('Failed to connect to saucelabs')
      console.error(err)
      return process.exit(1)
    }
    sauceConnectProcess = process
    sauceClient = wd.promiseChainRemote('localhost', 4445, username, accessKey)
    callback()
  })
}

function startTest () {
  console.log('Starting', client)

  const opts = {
    browserName: client.browser,
    version: client.version,
    platform: client.platform,
    tunnelTimeout: testTimeout,
    name: `${client.browser} - ${tunnelId}`,
    'max-duration': 60 * 30,
    'command-timeout': 599,
    'idle-timeout': 599,
    'tunnel-identifier': tunnelId
  }

  sauceClient.init(opts).get(testUrl, () => {
    /* jshint evil: true */
    var interval = setInterval(() => {
      sauceClient.eval('window.results', (err, results) => {
        if (err) {
          clearInterval(interval)
          testError(err)
        } else if (results.completed || results.failures.length) {
          clearInterval(interval)
          testComplete(results)
        } else {
          console.log('=> ', results)
        }
      })
    }, 10 * 1000)
  })
}

devserver.start(() => {
  if (client.runner === 'saucelabs') {
    startSauceConnect(startTest)
  } else {
    startSelenium(startTest)
  }
})
