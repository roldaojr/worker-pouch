'use strict';

module.exports = function safeEval (str) {
  const target = {}
  /* jshint evil: true */
  eval(`target.target = (${str});`)
  return target.target
}
