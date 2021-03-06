"use strict";

var domBuilder = require('dombuilder');
var log = require('domlog');

var tcp = require('min-stream-chrome/tcp.js');
var chain = require('min-stream/chain.js');
var demux = require('min-stream/demux.js');

var pktLine = require('git-pkt-line');
var listPack = require('git-list-pack/min.js');
var hydratePack = require('git-hydrate-pack');
var bops = require('bops');

window.log = log;

document.body.innerText = "";
document.body.appendChild(domBuilder([
  ["h1", "JS-Git ChromeApp"],
  ["form",
    {onsubmit: wrap(function (evt) {
      evt.preventDefault();
      clone(this.url.value, this.sideband.checked);
    })},
    ["input", {name: "url", size: 50, value: "git://github.com/creationix/conquest.git"}],
    ["input", {type:"submit", value: "Clone!"}],
    ["label",
      ["input", {type:"checkbox", checked:true, name:"sideband"}],
      "Include side-band support",
    ]
  ]
]));

log.setup({
  top: "150px",
  height: "auto",
  background: "#222"
});

// Wrap a function in one that redirects exceptions.
// Use for all event-source handlers.
function wrap(fn) {

  return function () {
    try {
      return fn.apply(this, arguments);
    }
    catch (err) {
      log(err);
    }
  };
}
// Same as wrap, but also checks err argument.  Use for callbacks.
function check(fn) {
  return function (err) {
    if (err) return log(err);
    try {
      return fn.apply(this, Array.prototype.slice.call(arguments, 1));
    }
    catch (err) {
      log(err);
    }
  };
}

var gitMatch = new RegExp("^git://([^/:]+)(?::([0-9]+))?(/.*)$");
function parseUrl(url) {
  var match = url.match(gitMatch);
  if (match) {
    return {
      type: "tcp",
      host: match[1],
      port: match[2] ? parseInt(match[2], 10) : 9418,
      path: match[3]
    };
  }
  throw new SyntaxError("Invalid url: " + url);
}

function clone(url, sideband) {
  log.container.textContent = "";
  url = parseUrl(url);
  log("Parsed Url", url);
  tcp.connect(url.host, url.port, check(function (socket) {

    log("Connected to server");

    chain
      .source(socket.source)
      // .map(logger("<"))
      .push(pktLine.deframer)
      // .map(logger("<-"))
      .pull(app)
      // .map(logger("->"))
      .push(pktLine.framer)
      // .map(logger(">"))
      .sink(socket.sink);
  }));


  function app(read) {

    var sources = demux(["line", "pack", "progress", "error"], read);

    var output = tube();

    log("Sending upload-pack request...");
    output.write(null, "git-upload-pack " + url.path + "\0host=" + url.host + "\0");

    var refs = {};
    var caps;

    consumeTill(sources.line, function (item) {
      if (item) {
        item = decodeLine(item);
        if (item.caps) caps = item.caps;
        refs[item[1]] = item[0];
        return true;
      }
    }, function (err) {
      if (err) return log(err);
      log("server capabilities", caps);
      log("remote refs", refs);
      var clientCaps = [];
      if (sideband) {
        if (caps["side-band-64k"]) {
          clientCaps.push("side-band-64k");
        }
        else if (caps["side-band"]) {
          clientCaps.push("side-band");
        }
      }
      log("Asking for HEAD", refs.HEAD)
      output.write(null, ["want", refs.HEAD].concat(clientCaps).join(" ") + "\n");
      output.write(null, null);
      output.write(null, "done");

      var seen = {};
      var pending = {};
      function find(oid, ready) {
        if (seen[oid]) ready(null, seen[oid]);
        else pending[oid] = ready;
      }

      chain
        .source(sources.pack)
        // .map(logger("rawpack"))
        .pull(listPack)
        // .map(logger("partlyparsed"))
        .push(hydratePack(find))
        // .map(logger("hydrated"))
        .map(function (item) {
          seen[item.hash] = item;
          if (pending[item.hash]) {
            pending[item.hash](null, item);
          }
          return item;
        })
        .map(parseObject)
        .map(logger("object"))
        .sink(devNull);

      devNull(sources.line);

      chain
        .source(sources.progress)
        .map(logger("progress"))
        .sink(devNull);

      devNull(sources.error);
    });

    return output;
  }

}

var parsers = {
  tree: function (item) {
    var list = [];
    var data = item.data;
    var hash;
    var mode;
    var path;
    var i = 0, l = data.length;
    while (i < l) {
      var start = i;
      while (data[i++] !== 0x20);
      mode = parseInt(bops.to(bops.subarray(data, start, i - 1)), 8);
      start = i;
      while (data[i++]);
      path = bops.to(bops.subarray(data, start, i - 1));
      hash = bops.to(bops.subarray(data, i, i + 20), "hex");
      i += 20;
      list.push({
        mode: mode,
        path: path,
        hash: hash
      });
    }
    return list;
  },
  blob: function (item) {
    return item.data;
  },
  commit: function (item) {
    var data = item.data;
    var i = 0, l = data.length;
    var key;
    var items = {parents:[]};
    while (i < l) {
      var start = i;
      while (data[i++] !== 0x20);
      key = bops.to(bops.subarray(data, start, i - 1));
      start = i;
      while (data[i++] !== 0x0a);
      var value = bops.to(bops.subarray(data, start, i - 1));
      if (key === "parent") {
        items.parents.push(value);
      }
      else items[key] = value;
      if (data[i] === 0x0a) {
        items.message = bops.to(bops.subarray(data, i + 1));
        break;
      }
    }
    return items;
  }
};

function parseObject(item) {
  var obj = {
    hash: item.hash
  };
  obj[item.type] = parsers[item.type](item);
  return obj;
}


function logger(message) {
  return function (item) {
    log(message, item);
    return item;
  };
}

// Eat all events in a stream
function devNull(read) {
  read(null, onRead);
  function onRead(err, item) {
    if (err) log(err);
    else if (item !== undefined) read(null, onRead);
  }
}

function consumeTill(read, check, callback) {
  read(null, onRead);
  function onRead(err, item) {
    if (item === undefined) {
      if (err) return callback(err);
      return callback();
    }
    if (!check(item)) return callback();
    read(null, onRead);
  }
}

function tube() {
  var dataQueue = [];
  var readQueue = [];
  var closed;
  function check() {
    while (!closed && readQueue.length && dataQueue.length) {
      readQueue.shift().apply(null, dataQueue.shift());
    }
  }
  function write(err, item) {
    dataQueue.push([err, item]);
    check();
  }
  function read(close, callback) {
    if (close) closed = close;
    if (closed) return callback();
    readQueue.push(callback);
    check();
  }
  read.write = write;
  return read;
}



// Decode a binary line
// returns the data array with caps and request tagging if they are found.
function decodeLine(line) {
  var result = [];

  if (line[line.length - 1] === "\0") {
    result.request = true;
    line = line.substr(0, line.length - 1);
  }
  line = line.trim();
  var parts = line.split("\0");
  result.push.apply(result, parts[0].split(" "));
  if (parts[1]) {
    result.caps = {};
    parts[1].split(" ").forEach(function (cap) {
      var pair = cap.split("=");
      result.caps[pair[0]] = pair[1] ? pair[1] : true;
    });
  }
  return result;
}
