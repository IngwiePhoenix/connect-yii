module.exports = function fastcgi(newOptions) {
    var url   = require('url')
    , fs      = require('fs')
    , path    = require("path")
    , http    = require("http")
    , net     = require("net")
    , sys     = require("sys")
    , fastcgi = require("fastcgi-parser")
    , nphp    = require("./node-php.js");

    var debug = console;

    function makeHeaders(headers, params) {
        if (headers.length <= 0) {
            return params;
        }
        for (var prop in headers) {
            var head = headers[prop];
            prop = prop.replace(/-/, '_').toUpperCase();
            if (prop.indexOf('CONTENT_') < 0) {
                // Quick hack for PHP, might be more or less headers.
                prop = 'HTTP_' + prop;
            }
            params[params.length] = [prop, head]
        }
        return params;
    };

    // Let's mix those options.
    var options = {
        fastcgiPort: 9000,
        fastcgiHost: 'localhost',
        root: '',
        index: "index.php",
        serverName: "localhost",
        serverHost: "127.0.0.1",
        serverPort: 80,
        keepalive: false
    };
    for (var k in newOptions) {
        options[k] = newOptions[k];
    }

    return function PHPResponder(req, res, next) {
        var agent = new nphp.Agent(4, {
            root: options.root,
            host: options.fastcgiHost,
            port: options.fastcgiPort,
            server: {
                name: options.serverName,
                host: options.serverHost,
                port: options.serverPort
            },
            keepalive: options.keepalive
        });
        agent.on("error", function(err) {
            console.error("client.error");
            console.error(err);
            res.writeHead(500,{"Content-type":"text/plain"});
            res.end(JSON.stringify(err));
        });
        var script_dir = options.root;
        var matches = req.url.match(/(.+\.php)(.*?)/);
        if(matches != null) {
            var script_file = matches[1];
            var document_uri = url.parse(matches[1]).pathname;
            var path_info = matches[2];
        } else {
            if(req.url == "/") {
                var script_file = document_uri = "/"+options.index;
                var path_info = "";
            } else if(!fs.existsSync(script_dir+req.url)) {
                // This might be a trap with a .jpg file...check first.
                var document_uri = req.url;
                var script_file = "/"+options.index;
                var path_info = "";
            } else {
                return next();
            }
        }
        var request_uri = req.headers['x-request-uri'] ? req.headers['x-request-uri'] : req.url;
        var qs = url.parse(request_uri).query ? url.parse(request_uri).query : '';
        var headers = makeHeaders(req.headers, [
            ["SCRIPT_FILENAME",script_dir + script_file],
            ["REMOTE_ADDR",req.connection.remoteAddress],
            ["QUERY_STRING", qs],
            ["REQUEST_METHOD", req.method],
            ["SCRIPT_NAME", script_file],
            ["PATH_INFO", path_info],
            ["DOCUMENT_URI", document_uri],
            ["REQUEST_URI", document_uri],
            ["DOCUMENT_ROOT", script_dir],
            ["PHP_SELF", script_file],
            ["GATEWAY_PROTOCOL", "CGI/1.1"],
            ["SERVER_SOFTWARE", "node/" + process.version]
        ]);

        // Merging headers so othe rmiddlewares dont get lost.
        for(var hdr in req.headers) {
            var val = req.headers[hdr];
            var hdr_k = hdr.replace("-","_").toUpperCase();
            headers.push([hdr_k, val]);
        }
        req.php_headers = headers;

        agent.request(req, res, function(err, response) {
            if(err) {
                console.error(err.stack);
                res.writeHead(500, {"Content-type": "text/plain"});
                res.end(err);
                next();
            }
        });
    }
}
