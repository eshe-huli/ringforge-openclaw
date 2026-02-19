"use strict";
var WebSocket = require("ws");

function BridgeWebSocket(url) {
  var ws = new WebSocket(url);
  this._ws = ws;
  this.readyState = ws.readyState;
  
  var self = this;
  ws.on("open", function() { self.readyState = ws.readyState; });
  ws.on("close", function() { self.readyState = ws.readyState; });
}

BridgeWebSocket.prototype.send = function(data) { this._ws.send(data); };
BridgeWebSocket.prototype.close = function() { this._ws.close(); };
BridgeWebSocket.prototype.on = function(event, fn) { this._ws.on(event, fn); };
Object.defineProperty(BridgeWebSocket.prototype, "readyState", {
  get: function() { return this._ws ? this._ws.readyState : 3; },
  set: function() {}
});

BridgeWebSocket.OPEN = 1;
BridgeWebSocket.CLOSED = 3;

// Export for both CJS and ESM bundler compatibility
exports.default = BridgeWebSocket;
exports.BridgeWebSocket = BridgeWebSocket;
