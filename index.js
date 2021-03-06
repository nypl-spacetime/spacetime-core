'use strict'

var config = require('spacetime-config')
var R = require('ramda')
var H = require('highland')
var Redis = require('redis')
var redisClient = Redis.createClient(config.redis.port, config.redis.host)
var redisDoneClient = Redis.createClient(config.redis.port, config.redis.host)
var normalize = require('histograph-uri-normalizer').normalize
var fuzzyDates = require('fuzzy-dates')

var graphmalizer = require('spacetime-db-graphmalizer')

function preprocess (message) {
  if (message.type === 'pit') {
    if (message.payload.validSince) {
      message.payload.validSince = fuzzyDates.convert(message.payload.validSince)
    }

    if (message.payload.validUntil) {
      message.payload.validUntil = fuzzyDates.convert(message.payload.validUntil)
    }

    // normalize IDs/URIs
    var id = normalize(message.payload.id || message.payload.uri, message.meta.dataset)
    message.payload.id = id
    delete message.payload.uri
  } else if (message.type === 'relation') {
    // normalize IDs/URIs
    var from = normalize(message.payload.from, message.meta.dataset)
    var to = normalize(message.payload.to, message.meta.dataset)

    message.payload.from = from
    message.payload.to = to
  }

  return message
}

// Create a stream from Redis queue
var redis = H(function redisGenerator (push, next) {
  // Function called on each Redis message (or timeout)
  function redisCallback (err, data) {
    // Handle error
    if (err) {
      push(err)
      next()
      return
    }

    // Attempt parse or error
    try {
      var d = JSON.parse(data[1])
      push(null, d)
      next()
    } catch (e) {
      push(e)
      next()
    }
  }

  // Blocking pull from Redis
  redisClient.brpop(config.redis.queue, 0, redisCallback)
})

function logError (err) {
  console.error(err.stack || err)
}

var dbs = [
  'postgis',
  'elasticsearch'
]

var commands = redis
  .errors(logError)
  .map(preprocess)
  .compact()

var dbModules = [graphmalizer]
dbs.forEach((db) => {
  var dbModule = require(`spacetime-db-${db}`)

  if (dbModule.initialize) {
    dbModule.initialize()
  }

  dbModules.push(dbModule)
})

function bulkAll(dbModules, messages, callback) {
  var doneMessages = messages
    .filter((message) => message.type === 'dataset-done')

  H(dbModules)
    .filter((module) => module.bulk)
    .map((module) => H.curry(module.bulk, messages.filter((message) => message.type !== 'dataset-done')))
    .nfcall([])
    .parallel(dbModules.length)
    .errors(callback)
    .done(() => {
      doneMessages.forEach((message) => {
        redisDoneClient
          .lpush(`${config.redis.queue}-dataset-done`, JSON.stringify(message.payload))
      })
      callback()
    })
}

commands
  .batchWithTimeOrCount(config.core.batchTimeout, config.core.batchSize)
  .map(H.curry(bulkAll, dbModules))
  .nfcall([])
  .series()
  .each(() => {})

console.log(config.logo.join('\n'))
console.log('Space/Time Core ready!')
