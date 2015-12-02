/* Copyright (c) 2014-2015 Cristian Ianto, Richard Rodger, MIT License */
'use strict'

var _ = require('lodash')
var redis = require('redis')

module.exports = function (options) {
  var seneca = this
  var plugin = 'redis-sync-transport'

  var so = seneca.options()

  options = seneca.util.deepextend(
    {
      'redis-sync': {
        timeout: so.timeout ? so.timeout - 555 : 22222,
        type: 'redis-sync',
        host: 'localhost',
        port: 6379
      }
    },
    so.transport,
    options
  )


  var tu = seneca.export('transport/utils')

  seneca.add({role: 'transport', hook: 'listen', type: 'redis-sync'}, hook_listen_redis)
  seneca.add({role: 'transport', hook: 'client', type: 'redis-sync'}, hook_client_redis)

  function hook_listen_redis (args, done) {
    var seneca = this
    var type = args.type
    var listen_options = seneca.util.clean(_.extend({}, options[type], args))

    var redis_in = redis.createClient(listen_options.port, listen_options.host)
    var redis_out = redis.createClient(listen_options.port, listen_options.host)
    var redis_sync = redis.createClient(listen_options.port, listen_options.host)

    handle_events(redis_in)
    handle_events(redis_out)
    handle_events(redis_sync)

    function sync_handle (msgid, done) {
      // using incr to synchronize listeners
      // first incr gets to process the message
      redis_sync.incr('seneca/transport/' + msgid, function (err, result) {
        if (err) {
          seneca.log.error('transport', 'redis-sync-key', err)
          return done(err)
        }
        return done(null, result === 1)
      })
    }

    function post_handle (msgid) {
      // cleanup
      redis_sync.expire('seneca/transport/' + msgid, 60, function (err, result) {
        if (err || result !== 1) {
          seneca.log.error('transport', 'redis-sync-key-expire', err || new Error('expected 1 got ' + result))
        }
      })
    }

    redis_in.on('message', function (channel, msgstr) {
      var restopic = channel.replace(/_act$/, '_res')
      var data = tu.parseJSON(seneca, 'listen-' + type, msgstr)

      var msgid = data.origin + '/' + data.id
      sync_handle(msgid, function (err, handle) { // calls back with true if the message should be handled
        if (err) {
          seneca.log.error('transport', 'redis-sync-handle-message', err)
          return done(err)
        }
        if (handle) {
          tu.handle_request(seneca, data, listen_options, function (out) {
            if (out == null) return
            var outstr = tu.stringifyJSON(seneca, 'listen-' + type, out)
            redis_out.publish(restopic, outstr)
            post_handle(msgid)
          })
        }
      })
    })

    tu.listen_topics(seneca, args, listen_options, function (topic) {
      seneca.log.debug('listen', 'subscribe', topic + '_act', listen_options, seneca)
      redis_in.subscribe(topic + '_act')
    })

    seneca.add('role:seneca,cmd:close', function (close_args, done) {
      var closer = this

      redis_in.end()
      redis_out.end()
      redis_sync.end()
      closer.prior(close_args, done)
    })

    seneca.log.info('listen', 'open', listen_options, seneca)

    done()
  }

  function hook_client_redis (args, clientdone) {
    var seneca = this
    var type = args.type
    var client_options = seneca.util.clean(_.extend({}, options[type], args))

    tu.make_client(make_send, client_options, clientdone)

    console.warn('[seneca-redis-sync-transport]', 'WARNING: Ignoring invalid origin messages for seneca-redis-sync-tranport. ' +
      'This is to prevent seneca-transport from noisily logging on receipt of responses for other origins. This can only be ' +
      'properly solved in this transport by changing the implementation to route responses only to the origin. The current ' +
      'implementation introduces network and processing overhead.')

    function make_send (spec, topic, send_done) {
      var redis_in = redis.createClient(client_options.port, client_options.host)
      var redis_out = redis.createClient(client_options.port, client_options.host)

      handle_events(redis_in)
      handle_events(redis_out)

      redis_in.on('message', function (channel, msgstr) {
        var input = tu.parseJSON(seneca, 'client-' + type, msgstr)
        if(seneca.id === input.origin)  {
          tu.handle_response(seneca, input, client_options)
        }
      })

      seneca.log.debug('client', 'subscribe', topic + '_res', client_options, seneca)
      redis_in.subscribe(topic + '_res')

      send_done(null, function (args, done) {
        var outmsg = tu.prepare_request(this, args, done)
        var outstr = tu.stringifyJSON(seneca, 'client-' + type, outmsg)

        redis_out.publish(topic + '_act', outstr)
      })

      seneca.add('role:seneca,cmd:close', function (close_args, done) {
        var closer = this

        redis_in.end()
        redis_out.end()
        closer.prior(close_args, done)
      })
    }
  }

  function handle_events (redisclient) {
    // Die if you can't connect initially
    redisclient.on('ready', function () {
      redisclient.on('error', function (err) {
        seneca.log.error('transport', 'redis-sync', err)
      })
    })
  }

  return {
    name: plugin
  }
}
