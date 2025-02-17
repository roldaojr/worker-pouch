#!/usr/bin/env node
const browserify = require('browserify')
const envify = require('envify/custom')
const UglifyJS = require('uglify-js')
const fs = require('fs')

const writeFile = function (file, data, options) {
  return new Promise((resolve, reject) => {
    fs.writeFile(file, data, options, err => {
      if (err == null) {
        resolve()
      } else {
        reject(err)
      }
    })
  })
}
const mkdirpFn = require('mkdirp')

const mkdirp = function (dir, opts) {
  return new Promise((resolve, reject) => {
    mkdirpFn(dir, opts, err => {
      if (err == null) {
        resolve()
      } else {
        reject(err)
      }
    })
  })
}
const derequire = require('derequire')

function browserifyIt (entry) {
  return new Promise((resolve, reject) => {
    let data = ''
    const b = browserify().plugin('bundle-collapser/plugin')

    b.transform(envify(process.env))
    b.add(entry)
    const bundle = b.bundle()
    bundle.on('data', buf => {
      data += buf
    })
    bundle.on('end', () => {
      data = derequire(data)
      if (process.env.NODE_ENV === 'production') {
        data = UglifyJS.minify(data, {
          mangle: true,
          compress: true
        }).code
      }
      resolve(data)
    }).on('error', reject)
  })
}
return mkdirp('./lib/workerified').then(() => browserifyIt('./lib/worker/index.js')).then(data => {
  const code = `${'// this code is automatically generated by bin/build.js\n'
    + 'module.exports = '}${JSON.stringify(data)};`
  return writeFile('./lib/workerified/index.js', code, 'utf-8')
}).catch(err => {
  console.error(err.stack)
  process.exit(1)
})
