var express = require('express');
var app = express();
var fs = require('fs');
var bodyParser = require('body-parser');
var morgan = require('morgan');
var filewalker = require('filewalker');
var path = require('path');
var filewatcher = require('filewatcher');
var killable = require('killable');
var events = require('events');
var uuid = require('node-uuid');

var mysql = require('mysql');
var pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'omg'
});

global.pool = pool;
global.Promise = require('bluebird');

app.use(express.static('.'));

app.use(bodyParser.json());

app.use(morgan('short'));

app.get('/nodes', function(req, res) {
  var nodes = [];
  filewalker('./nodes')
    .on('file', function(p, s, filename) {
      eval("var value = " + fs.readFileSync(filename, 'utf-8'));
      var id = path.basename(filename).replace('.js', '');
      value.run += "";
      value.id = id;
      nodes.push(value);
    })
    .on('done', function() {
      res.status(200).send(nodes);
    })
  .walk();
});

app.delete('/nodes/:id', function(req, res) {
  fs.unlinkSync('nodes/' + req.params.id + '.js');
  res.status(200).send({
    message: 'file deleted'
  });
});

app.put('/nodes', function(req, res) {
  fs.writeFileSync('nodes/' + req.body.id + '.js', JSON.stringify(req.body, null, 2), 'utf-8');
  res.status(200).send({
    message: 'file written'
  });
});

var server = app.listen(8080, function () {});



// logic related to the other application
var watcher = filewatcher();
watcher.add('nodes');
var port = 8081;

var otherServer = null

var startServer = function() {
  var emitter = new events.EventEmitter();

  if (otherServer) {
    otherServer.kill(function(){
      otherServer = null;
      setTimeout(startServer);
    });
  } else {
    console.log("Restarting Your API Server at http://localhost:" + port);
    var otherApp = express();
    otherApp.use(bodyParser.json());
    otherApp.use(morgan('short'));

    routes = []
    filewalker('./nodes')
      .on('file', function(p, s, filename) {
        try {
          eval("var node = " + fs.readFileSync(filename, 'utf-8'));
          var id = path.basename(filename).replace('.js', '');
          eval("var run = " + node.run);
          node.run = run;
          routes.push(node)
        } catch (err) {
          console.log('err', err);
        }
      })
      .on('done', function() {
        routes.forEach(function(route) {
          if (route.on) {
            emitter.on(route.on, function(input) {
              var results = route.run(input);
              if (results instanceof Promise) {
                results.then(function(resl) {
                  emitter.emit(resl.event, resl);
                });
              } else {
                emitter.emit(results.event, results);
              }
            })
          }
        });

        otherApp.use(function(req, res, next) {
          var found = false;
          routes.forEach(function(route) {
            if (route.method && req.method === route.method.toUpperCase() && req.originalUrl === route.route) {
              found = true;
              var id = uuid.v4();
              var results = route.run({
                id: id,
                body: req.body,
                headers: req.headers,
                params: req.params,
                query: req.query
              });
              if (results instanceof Promise) {
                results.then(function(resl) {
                  emitter.once(id, function(input) {
                    res.status(input.status).send(input.data);
                  });
                  emitter.emit(resl.event, resl)
                  return;
                });
                return;
              } else {
                emitter.once(id, function(input) {
                  res.status(input.status).send(input.data);
                });
                emitter.emit(results.event, results)
                return;
              }
            }
          });
          if (!found) {
            res.status(404).send({err: 'route not found'});
          }
        });

        otherServer = otherApp.listen(port, function () {});
        killable(otherServer);
      })
    .walk();
  }
}
startServer()

watcher.on('change', function(file, stat) {
  console.log('files changed');
  startServer()
});
