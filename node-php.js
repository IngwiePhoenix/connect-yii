var net = require("net");
var fastcgi = require("fastcgi-parser");
var dns = require("dns");
var events = require("events");
var url = require("url");
var inherits = require("util").inherits;
var HTTPParser = process.binding("http_parser").HTTPParser;

/*

* support X-SendFile

*/
var gid = 0;

function client(options) {
	var _fastcgi = this;
	var connection = new net.Stream();
	var htparser = new HTTPParser("response");
	var queue = [];
	var reqid = 0;
	var requests = {};
	var stats = {
		connections: 0
	}
	_fastcgi.stats = stats;
	var phprx = new RegExp("Status: (\\d{3}) (.*?)\\r\\n");
	var port = options.port || "/tmp/php.sock";
	var host = options.host;
	var keepalive = options.keepAlive || false;
	var shost = options.server.host || "127.0.0.1";
	var sport = options.server.port || 80;
	var sname = options.server.name || "localhost";
	var sredirectstatus = options.redirectStatus || null;
	var _current = null;

	////console.log("    --> psname",psname);

	connection.setNoDelay(true);
	connection.setTimeout(0);
	connection.params = [
		["DOCUMENT_ROOT", options.root || "/var/www/html"],
		["SERVER_PROTOCOL", "HTTP/1.1"],
		["GATEWAY_INTERFACE", "CGI/1.1"],
		["SERVER_SOFTWARE", "node.js"],
		["SERVER_ADDR", shost.toString()],
		["SERVER_PORT", sport.toString()],
		["SERVER_NAME", sname]
	];
	connection.writer = new fastcgi.writer();
	connection.parser = new fastcgi.parser();
	connection.parser.encoding = "binary";
	connection.writer.encoding = "binary";

	htparser.onHeaderField = function (b, start, len) {
		var slice = b.toString('ascii', start, start+len).toLowerCase();
		if (htparser.value != undefined) {
			var dest = _current.fcgi.headers;
			if (htparser.field in dest) {
				dest[htparser.field].push(htparser.value);
			} else {
				dest[htparser.field] = [htparser.value];
			}
			htparser.field = "";
			htparser.value = "";
		}
		if (htparser.field) {
			htparser.field += slice;
		} else {
			htparser.field = slice;
		}
	};

	htparser.onHeaderValue = function (b, start, len) {
		//console.log("  -> onHeaderValue",b.toString('ascii', start, start+len));
		var slice = b.toString('ascii', start, start+len);
		if (htparser.value) {
			htparser.value += slice;
		} else {
			htparser.value = slice;
		}
	};

	htparser.onHeadersComplete = function (info) {
		//console.log("  -> info:",info);
		if (htparser.field && (htparser.value != undefined)) {
			var dest = _current.fcgi.headers;
			if (htparser.field in dest) {
				dest[htparser.field].push(htparser.value);
			} else {
				dest[htparser.field] = [htparser.value];
			}
			htparser.field = null;
			htparser.value = null;
		}
		_current.fcgi.info = info;
		_current.resp.statusCode = info.statusCode;
		for(header in _current.fcgi.headers) {
			var head = _current.fcgi.headers[header];
			if(head.length > 1) {
				_current.resp.setHeader(header, head);
			}
			else {
				_current.resp.setHeader(header, head[0]);
			}
		}
	}

	htparser.onBody = function(buffer, start, len) {
		//console.log("  -> onBody");
		_current.resp.write(buffer.slice(start, start + len));
	}

	connection.parser.onHeader = function(header) {
		//console.log("  -> Header",header);
		_current = requests[header.recordId];
	}

	connection.parser.onBody = function(buffer, start, len) {
		//console.log("  -> connection.parser.onBody");
		//console.log(buffer.toString("utf8", start, start + len));
		if(!_current.fcgi.body) {
			htparser.reinitialize("response");
			_current.fcgi.headers = {};
			var content = buffer.toString("binary",start, start + len);
			var contents = content.split("\r\n\r\n");
			var status = contents[0];
			var match = status.match(phprx);
			// Add headers
			if(typeof contents[1] != "undefined") {
				// We have headers to use.
				var hdrs = contents[0].split("\r\n");
				for(i=0; i<hdrs.length; i++) {
					var parts = hdrs[i].split(": ");
					_current.resp.setHeader(parts[0], parts[1]);
				}
			}
			if(match) {
				var header = match[0];
				var buff = buffer.slice(start + header.length, start + len);
				status = new Buffer("HTTP/1.1 " + match[1] + " " + match[2] + "\r\n");
				try {
					var parsed = htparser.execute(status, 0, status.length);
					var parsed = htparser.execute(buffer, start, len);
					if(parsed.bytesParsed) {
						_current.resp.write(buff.slice(start + parsed.bytesParsed, start + len));
					}
					_current.resp.statusCode = match[1];
				}
				catch(ex) {
					_current.cb(ex);
				}
			} else {
				status = new Buffer("HTTP/1.1 200 OK\r\n");
				try {
					var parsed = htparser.execute(status, 0, status.length);
					var parsed = htparser.execute(buffer, start, len);
					if(parsed.bytesParsed) {
						_current.resp.write(buffer.slice(start + parsed.bytesParsed, start + len));
					}
					_current.resp.statusCode = 200;
				}
				catch(ex) {
					_current.cb(ex);
				}
			}
			var toPrint;// = contents[1] || contents[0];
			if(typeof contents[1] == "undefined") {
				toPrint = contents[0];
			} else {
				toPrint = contents[1];
			}
			////console.log("  -> Printing:", toPrint);
			////console.log("  -> Contents:",contents);
			_current.resp.write(toPrint);
			_current.fcgi.body = true;
		}
		else {
			try {
				var parsed = htparser.execute(buffer, start, len);
				////console.log("-> Parsed message:",parsed);
				if(parsed.message == "Parse Error" && ("bytesParsed" in parsed)) {
					_current.resp.write(buffer.slice(start + parsed.bytesParsed, start + len));
				}
			}
			catch(ex) {
				_current.cb(ex);
			}
		}
	}

	connection.parser.onRecord = function(record) {
		//console.log("  -> onRecord");
		var recordId = parseInt(record.header.recordId);
		var request = requests[recordId];
		switch(record.header.type) {
			case fastcgi.constants.record.FCGI_END:
				request.fcgi.status = record.body;
				if(record.body.status == 0 && record.body.protocolStatus == 0) {
					request.resp.end();
					delete requests[recordId];
					request.cb(null, record);
				}
				else {
					// error from fastcgi app - return 500;
					// if we want to use this (php doesn't) we need to buffer the whole response and wait to inspect this before sending any headers. that's just nasty!!
				}
				if(keepalive && queue.length > 0){
					next();
				}
				break;
			default:
				break;
		}
	};

	connection.parser.onError = function(err) {
		//console.log("onError", err);
		_fastcgi.emit("error", err);
	};

	if(sredirectstatus) {
		connection.params.push(["REDIRECT_STATUS", sredirectstatus.toString()]);
	}

	connection.ondata = function (buffer, start, end) {
		//console.log("  -> ondata");
		connection.parser.execute(buffer, start, end);
	};

	connection.addListener("connect", function() {
		stats.connections++;
		if(queue.length > 0) {
			next();
		}
	});

	connection.addListener("timeout", function() {
		connection.end();
	});

	connection.addListener("end", function() {
		if(queue.length > 0) {
			process.nextTick(_fastcgi.connect);
		}
	});

	connection.addListener("error", function(err) {
		_fastcgi.emit("error", err);
		connection.end();
	});

	this.connect = function() {
		if(!connection.fd) connection.connect(port, host);
	}

	this.end = function() {
		connection.end();
	}

	function next() {
		//debugger;
		var request = queue.shift();
		var req = request.req;
		req.resume();
		var params = connection.params.slice(0);
		params = req.php_headers;
		//console.log("Request headers", req.headers);
		//TODO: probably better to find a generic way of translating all http headers on request into PHP headers
		if("user-agent" in req.headers) {
			params.push(["HTTP_USER_AGENT", req.headers["user-agent"]]);
		}
		if("accept-encoding" in req.headers) {
			params.push(["HTTP_ACCEPT_ENCODING", req.headers["accept-encoding"]]);
		}
		if("cookie" in req.headers) {
			params.push(["HTTP_COOKIE", req.headers["cookie"]]);
		}
		if("connection" in req.headers) {
			params.push(["HTTP_CONNECTION", req.headers["connection"]]);
		}
		if("accept" in req.headers) {
			params.push(["HTTP_ACCEPT", req.headers["accept"]]);
		}
		if("host" in req.headers) {
			params.push(["HTTP_HOST", req.headers["host"]]);
		}
		if("content-type" in req.headers) {
			params.push(["CONTENT_TYPE", req.headers["content-type"]]);
		}
		if("content-length" in req.headers) {
			params.push(["CONTENT_LENGTH", req.headers["content-length"]]);
		}
		try {
			connection.writer.writeHeader({
				"version": fastcgi.constants.version,
				"type": fastcgi.constants.record.FCGI_BEGIN,
				"recordId": request.id,
				"contentLength": 8,
				"paddingLength": 0
			});
			connection.writer.writeBegin({
				"role": fastcgi.constants.role.FCGI_RESPONDER,
				"flags": keepalive?fastcgi.constants.keepalive.ON:fastcgi.constants.keepalive.OFF
			});
			connection.write(connection.writer.tobuffer());
			connection.writer.writeHeader({
				"version": fastcgi.constants.version,
				"type": fastcgi.constants.record.FCGI_PARAMS,
				"recordId": request.id,
				"contentLength": fastcgi.getParamLength(params),
				"paddingLength": 0
			});
			connection.writer.writeParams(params);
			connection.write(connection.writer.tobuffer());
			connection.writer.writeHeader({
				"version": fastcgi.constants.version,
				"type": fastcgi.constants.record.FCGI_PARAMS,
				"recordId": request.id,
				"contentLength": 0,
				"paddingLength": 0
			});
			connection.write(connection.writer.tobuffer());
			switch(req.method) {
				case "GET":
					connection.writer.writeHeader({
						"version": fastcgi.constants.version,
						"type": fastcgi.constants.record.FCGI_STDIN,
						"recordId": request.id,
						"contentLength": 0,
						"paddingLength": 0
					});
					connection.write(connection.writer.tobuffer());
					break;
				case "PUT":
					request.cb(new Error("not implemented"));
					break;
				case "POST":
					if(typeof req.rawBody == "undefined") {
						req.on("data", function(chunk) {
							//console.log("  -> POST:",chunk);
							connection.writer.writeHeader({
								"version": fastcgi.constants.version,
								"type": fastcgi.constants.record.FCGI_STDIN,
								"recordId": request.id,
								"contentLength": chunk.length,
								"paddingLength": 0
							});
							connection.writer.writeBody(chunk);
							connection.write(connection.writer.tobuffer());
						});
						req.on("end", function() {
							connection.writer.writeHeader({
								"version": fastcgi.constants.version,
								"type": fastcgi.constants.record.FCGI_STDIN,
								"recordId": request.id,
								"contentLength": 0,
								"paddingLength": 0
							});
							connection.write(connection.writer.tobuffer());
						});
					} else {
						// A raw body exists, so we can use it.
						var rbBuf = req.rawBody;
						var size = 32*1024; // kb -> bytes = what i want.
						for(var i=0; i*size<rbBuf.length; i++) {
							var from = i===0 ? 0 : (i*size);
							var to = ((i*size)+size);
							var nbuf = rbBuf.slice(from, to);
							connection.writer.writeHeader({
								"version": fastcgi.constants.version,
								"type": fastcgi.constants.record.FCGI_STDIN,
								"recordId": request.id,
								"contentLength": nbuf.length,
								"paddingLength": 0
							});
							connection.writer.writeBody(nbuf);
							connection.write(connection.writer.tobuffer());
						}
						// Done
						connection.writer.writeHeader({
							"version": fastcgi.constants.version,
							"type": fastcgi.constants.record.FCGI_STDIN,
							"recordId": request.id,
							"contentLength": 0,
							"paddingLength": 0
						});
						connection.write(connection.writer.tobuffer());
					}
					break;
				case "DELETE":
					request.cb(new Error("not implemented"));
					break;
			}
		}
		catch(ex) {
			connection.end();
			request.cb(ex);
		}
	}

	this.request = function(req, resp, cb) {
		requests[reqid] = {
			"id": reqid,
			"req": req,
			"resp": resp,
			"cb": cb,
			"fcgi": {}
		};
		queue.push(requests[reqid]);
		reqid++;
		if(reqid == 65535) {
			reqid = 0;
		}
		if(!connection.fd) {
			req.pause();
			_fastcgi.connect();
		} else if(keepalive && queue.length == 1){
			next();
		}
	}
}
inherits(client, events.EventEmitter);

function agent(nc, options) {
	var _agent = this;
	var i = nc;
	var current = 0;
	var clients = [];
	this.clients = clients;
	while(i--) {
		var c = new client(options);
		c.on("error", function(err) {
			_agent.emit("error", err);
		});
		clients.push(c);
	}
	this.request = function(req, resp, cb) {
		var client = clients[current];
		client.request(req, resp, cb);
		if(current == nc - 1) {
			current = 0;
		} else {
			current++;
		}
	}
}
inherits(agent, events.EventEmitter);

exports.Client = client;
exports.Agent = agent;
