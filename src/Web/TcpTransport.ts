import { Logger } from "../../types/logger-factory";
import { OutgoingRequest } from "../../types/sip-message";
import { Transport as TransportDefinition } from "../../types/Web/transport";

import { TypeStrings } from "../Enums";
import { Exceptions } from "../Exceptions";
import { Grammar } from "../Grammar";
import { Transport as TransportBase } from "../Transport";
import { Utils } from "../Utils";

export enum TransportStatus {
  STATUS_CONNECTING,
  STATUS_OPEN,
  STATUS_CLOSING,
  STATUS_CLOSED
}

/**
 * Compute an amount of time in seconds to wait before sending another
 * keep-alive.
 * @returns {Number}
 */
const computeKeepAliveTimeout = (upperBound: number): number => {
  const lowerBound: number = upperBound * 0.8;
  return 1000 * (Math.random() * (upperBound - lowerBound) + lowerBound);
};

declare global {
  // tslint:disable-next-line:interface-name
  interface ElectronBridge {
    TcpSipClient: new (host: string, port: number, secure?: boolean, cert?: string) => {
      connect: () => void;
      disconnect: () => void;
      send: (data: string) => void;
      addEventListener: (event: string, listener: (...args: any[]) => void) => void;
    };
  }
  interface Window {
    jupiterElectron: ElectronBridge;
  }
}

/**
 * @class Transport
 * @param {Object} options
 */
export class TcpTransport extends TransportBase implements TransportDefinition {
  public static readonly C = TransportStatus;
  public type: TypeStrings;
  public server: any;
  public ws: any;

  private tcpSocket: any;

  private connectionPromise: Promise<any> | undefined;
  private connectDeferredResolve: ((obj: any) => void) | undefined;
  private connectionTimeout: any | undefined;

  private disconnectionPromise: Promise<any> | undefined;
  private disconnectDeferredResolve: ((obj: any) => void) | undefined;

  private reconnectionAttempts: number;
  private reconnectTimer: any | undefined;

  private status: TransportStatus;
  private configuration: any;

  private boundOnOpen: any;
  private boundOnMessage: any;
  private boundOnClose: any;
  private boundOnError: any;

  constructor(logger: Logger, options: any = {}) {
    super(logger, options);
    this.type = TypeStrings.Transport;

    this.reconnectionAttempts = 0;
    this.status = TransportStatus.STATUS_CONNECTING;
    this.configuration = {};
    this.loadConfig(options);
    this.logger.log("initialize the tcp transport");
  }

  /**
   * @returns {Boolean}
   */
  public isConnected(): boolean {
    return this.status === TransportStatus.STATUS_OPEN;
  }

  /**
   * Send a message.
   * @param {SIP.OutgoingRequest|String} msg
   * @param {Object} [options]
   * @returns {Promise}
   */
  protected sendPromise(msg: OutgoingRequest | string, options: any = {}): Promise<{msg: string}> {
    if (!this.statusAssert(TransportStatus.STATUS_OPEN, options.force)) {
      this.onError("unable to send message - tcp socket is not open");
      return Promise.reject();
    }

    const message: string = msg.toString();

    if (this.tcpSocket) {
      if (this.configuration.traceSip === true) {
        this.logger.log("sending tcp message:\n\n" + message + "\n");
      }
      this.tcpSocket.send(message);
      return Promise.resolve({msg: message});
    } else {
      this.onError("unable to send message - tcp channel does not exist");
      return Promise.reject();
    }
  }

  /**
   * Disconnect socket.
   */
  protected disconnectPromise(options: any = {}): Promise<any> {
    if (this.disconnectionPromise) { // Already disconnecting. Just return this.
      return this.disconnectionPromise;
    }
    options.code = options.code || 1000;

    if (!this.statusTransition(TransportStatus.STATUS_CLOSING, options.force)) {
      if (this.status === TransportStatus.STATUS_CLOSED) { // tcp socket is already closed
        return Promise.resolve({overrideEvent: true});
      } else if (this.connectionPromise) { // tcp socket is connecting, cannot move to disconneting yet
        return this.connectionPromise.then(() => Promise.reject("The tcp socket did not disconnect"))
        .catch(() => Promise.resolve({overrideEvent: true}));
      } else {
        // Cannot move to disconnecting, but not in connecting state.
        return Promise.reject("The tcp socket did not disconnect");
      }
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = undefined;
    }
    this.emit("disconnecting");
    this.disconnectionPromise = new Promise((resolve, reject) => {
      this.disconnectDeferredResolve = resolve;

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }

      if (this.tcpSocket) {
        this.logger.log("closing tcp socket " + this.server.wsUri);
        this.tcpSocket.disconnect();
      } else {
        reject("Attempted to disconnect but the websocket doesn't exist");
      }
    });

    return this.disconnectionPromise;
  }

  /**
   * Connect socket.
   */
  protected connectPromise(options: any = {}) {
    if (this.status === TransportStatus.STATUS_CLOSING && !options.force) {
      return Promise.reject("tcp socket " + this.server.wsUri + " is closing");
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    this.server = this.server || this.getNextWsServer(options.force);

    this.connectionPromise = new Promise((resolve, reject) => {
      if ((this.status === TransportStatus.STATUS_OPEN
        || this.status === TransportStatus.STATUS_CLOSING)
        && !options.force) {
        this.logger.warn("tcp socket: " + this.server.wsUri + " is already connected");
        reject("Failed status check - attempted to open a connection but already open/closing");
        return;
      }
      this.connectDeferredResolve = resolve;
      this.status = TransportStatus.STATUS_CONNECTING;
      this.emit("connecting");
      this.logger.log("connecting to tcp socket " + this.server.wsUri);
      this.disposeTcpSocket();
      const url = Grammar.parse(this.server.wsUri, "absoluteURI");
      this.tcpSocket = new window.jupiterElectron.TcpSipClient(url.host,
        url.port,
        url.scheme === "tls" ? true : false,
        this.server.certificate);
      this.tcpSocket.connect();
      this.connectionTimeout = setTimeout(() => {
        this.statusTransition(TransportStatus.STATUS_CLOSED);
        this.logger.warn("took too long to connect - exceeded time set in configuration.connectionTimeout: " +
          this.configuration.connectionTimeout + "s");
        this.emit("disconnected", {code: 1000});
        this.connectionPromise = undefined;
        reject("Connection timeout");
      }, this.configuration.connectionTimeout * 1000);

      this.boundOnOpen = this.onOpen.bind(this);
      this.boundOnMessage = this.onMessage.bind(this);
      this.boundOnClose = this.onClose.bind(this);
      this.boundOnError = this.onTcpSocketError.bind(this);

      this.tcpSocket.addEventListener("open", this.boundOnOpen);
      this.tcpSocket.addEventListener("message", this.boundOnMessage);
      this.tcpSocket.addEventListener("close", this.boundOnClose);
      this.tcpSocket.addEventListener("error", this.boundOnError);
    });

    return this.connectionPromise;
  }

  /**
   * @event
   * @param {event} e
   */
  protected onMessage(e: any): void {
    const data: any  = e.data;
    let finishedData: string;
    if (!data) {
      this.logger.warn("received empty message, message discarded");
      return;
    } else if (typeof data !== "string") { // WebSocket binary message.
      try {
        // the UInt8Data was here prior to types, and doesn't check
        finishedData = String.fromCharCode.apply(null, (new Uint8Array(data) as unknown as Array<number>));
      } catch (err) {
        this.logger.warn("received tcp socket binary message failed to be converted into string, message discarded");
        return;
      }

      if (this.configuration.traceSip === true) {
        this.logger.log("received tcp socket binary message:\n\n" + data + "\n");
      }
    } else { // tcp socket text message.
      if (this.configuration.traceSip === true) {
        this.logger.log("received tcp socket text message:\n\n" + data + "\n");
      }
      finishedData = data;
    }

    this.emit("message", finishedData);
  }

  // Transport Event Handlers

  /**
   * @event
   * @param {event} e
   */
  private onOpen(): void  {
    this.status = TransportStatus.STATUS_OPEN; // quietly force status to open
    this.emit("connected");
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = undefined;
    }

    this.logger.log("tcp socket " + this.server.wsUri + " connected");

    // Clear reconnectTimer since we are not disconnected
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    // Reset reconnectionAttempts
    this.reconnectionAttempts = 0;

    // Reset disconnection promise so we can disconnect from a fresh state
    this.disconnectionPromise = undefined;
    this.disconnectDeferredResolve = undefined;

    if (this.connectDeferredResolve) {
      this.connectDeferredResolve({overrideEvent: true});
    } else {
      this.logger.warn("Unexpected websocket.onOpen with no connectDeferredResolve");
    }
  }

  /**
   * @event
   * @param {event} e
   */
  private onClose(e: any): void {
    if (this.status !== TransportStatus.STATUS_CLOSING) {
      this.logger.warn("tcp socket closed without SIP.js requesting it");
      this.emit("transportError");
    }

    // Clean up connection variables so we can connect again from a fresh state
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }
    this.connectionTimeout = undefined;
    this.connectionPromise = undefined;
    this.connectDeferredResolve = undefined;

    // Check whether the user requested to close.
    if (this.disconnectDeferredResolve) {
      this.disconnectDeferredResolve({ overrideEvent: true });
      this.statusTransition(TransportStatus.STATUS_CLOSED);
      this.disconnectDeferredResolve = undefined;
      return;
    }

    this.status = TransportStatus.STATUS_CLOSED; // quietly force status to closed
    this.emit("disconnected", {code: "", reason: ""});
    this.reconnect();
  }

  private disposeTcpSocket(): void {
    if (this.tcpSocket) {
      this.tcpSocket.disconnect();
      this.tcpSocket = undefined;
    }
  }

  /**
   * @event
   * @param {string} e
   */
  private onError(e: any): void {
    this.logger.warn("Transport error: " + e);
    this.emit("transportError");
  }

  /**
   * @event
   * @private
   * @param {event} e
   */
  private onTcpSocketError(): void {
    this.onError("The tcp socket had an error");
  }

  /**
   * Reconnection attempt logic.
   */
  private reconnect(): void {
    if (this.reconnectionAttempts > 0) {
      this.logger.log("Reconnection attempt " + this.reconnectionAttempts + " failed");
    }

    if (this.noAvailableServers()) {
      this.logger.warn("no available tcp servers left - going to closed state");
      this.status = TransportStatus.STATUS_CLOSED;
      this.emit("closed");
      this.resetServerErrorStatus();
      return;
    }

    if (this.isConnected()) {
      this.logger.warn("attempted to reconnect while connected - forcing disconnect");
      this.disconnect({force: true});
    }

    this.reconnectionAttempts += 1;

    if (this.reconnectionAttempts > this.configuration.maxReconnectionAttempts) {
      this.logger.warn("maximum reconnection attempts for tcpSocket " + this.server.wsUri);
      this.logger.log("transport " + this.server.wsUri + " failed | connection state set to 'error'");
      this.server.isError = true;
      this.emit("transportError");
      this.server = this.getNextWsServer();
      this.reconnectionAttempts = 0;
      this.reconnect();
    } else {
      this.logger.log("trying to reconnect to tcp socket " +
        this.server.wsUri + " (reconnection attempt " + this.reconnectionAttempts + ")");
      this.reconnectTimer = setTimeout(() => {
        this.connect();
        this.reconnectTimer = undefined;
      }, (this.reconnectionAttempts === 1) ? 0 : this.configuration.reconnectionTimeout * 1000);
    }
  }

  /**
   * Resets the error state of all servers in the configuration
   */
  private resetServerErrorStatus(): void {
    for (const server of this.configuration.wsServers) {
      server.isError = false;
    }
  }

  /**
   * Retrieve the next server to which connect.
   * @param {Boolean} force allows bypass of server error status checking
   * @returns {Object} wsServer
   */
  private getNextWsServer(force: boolean = false): void {
    if (this.noAvailableServers()) {
      this.logger.warn("attempted to get next ws server but there are no available ws servers left");
      return;
    }
    // Order servers by weight
    let candidates: Array<any> = [];

    for (const wsServer of this.configuration.wsServers) {
      if (wsServer.isError && !force) {
        continue;
      } else if (candidates.length === 0) {
        candidates.push(wsServer);
      } else if (wsServer.weight > candidates[0].weight) {
        candidates = [wsServer];
      } else if (wsServer.weight === candidates[0].weight) {
        candidates.push(wsServer);
      }
    }

    const idx: number = Math.floor(Math.random() * candidates.length);
    return candidates[idx];
  }

  /**
   * Checks all configuration servers, returns true if all of them have isError: true and false otherwise
   * @returns {Boolean}
   */
  private noAvailableServers(): boolean {
    for (const server of this.configuration.wsServers) {
      if (!server.isError) {
        return false;
      }
    }
    return true;
  }

  // ==============================
  // Status Stuff
  // ==============================

  /**
   * Checks given status against instance current status. Returns true if they match
   * @param {Number} status
   * @param {Boolean} [force]
   * @returns {Boolean}
   */
  private statusAssert(status: TransportStatus, force: boolean): boolean {
    if (status === this.status) {
      return true;
    } else {
      if (force) {
        this.logger.warn("Attempted to assert " +
          Object.keys(TransportStatus)[this.status] + " as " +
          Object.keys(TransportStatus)[status] + "- continuing with option: 'force'");
        return true;
      } else {
        this.logger.warn("Tried to assert " +
        Object.keys(TransportStatus)[status] + " but is currently " +
        Object.keys(TransportStatus)[this.status]);
        return false;
      }
    }
  }

  /**
   * Transitions the status. Checks for legal transition via assertion beforehand
   * @param {Number} status
   * @param {Boolean} [force]
   * @returns {Boolean}
   */
  private statusTransition(status: TransportStatus, force: boolean = false): boolean {
    this.logger.log("Attempting to transition status from " +
      Object.keys(TransportStatus)[this.status] + " to " +
      Object.keys(TransportStatus)[status]);
    if ((status === TransportStatus.STATUS_CONNECTING && this.statusAssert(TransportStatus.STATUS_CLOSED, force)) ||
        (status === TransportStatus.STATUS_OPEN && this.statusAssert(TransportStatus.STATUS_CONNECTING, force)) ||
        (status === TransportStatus.STATUS_CLOSING && this.statusAssert(TransportStatus.STATUS_OPEN, force))    ||
        (status === TransportStatus.STATUS_CLOSED)) {
      this.status = status;
      return true;
    } else {
      this.logger.warn("Status transition failed - result: no-op - reason:" +
        " either gave an nonexistent status or attempted illegal transition");
      return false;
    }
  }

  // ==============================
  // Configuration Handling
  // ==============================

  /**
   * Configuration load.
   * returns {Boolean}
   */
  private loadConfig(configuration: any): void {
    const settings: {[name: string]: any} = {
      wsServers: [{
        scheme: "TCP",
        sipUri: "<sip:edge.sip.onsip.com;transport=tcp;lr>",
        weight: 0,
        wsUri: "tcp://edge.sip.onsip.com",
        isError: false
      }],

      connectionTimeout: 5,

      maxReconnectionAttempts: 3,
      reconnectionTimeout: 4,

      keepAliveInterval: 0,
      keepAliveDebounce: 10,

      // Logging
      traceSip: false
    };

    const configCheck: {mandatory: {[name: string]: any}, optional: {[name: string]: any}} =
      this.getConfigurationCheck();

    // Check Mandatory parameters
    for (const parameter in configCheck.mandatory) {
      if (!configuration.hasOwnProperty(parameter)) {
        throw new Exceptions.ConfigurationError(parameter);
      } else {
        const value: any = configuration[parameter];
        const checkedValue: any = configCheck.mandatory[parameter](value);
        if (checkedValue !== undefined) {
          settings[parameter] = checkedValue;
        } else {
          throw new Exceptions.ConfigurationError(parameter, value);
        }
      }
    }

    // Check Optional parameters
    for (const parameter in configCheck.optional) {
      if (configuration.hasOwnProperty(parameter)) {
        const value = configuration[parameter];

        // If the parameter value is an empty array, but shouldn't be, apply its default value.
        // If the parameter value is null, empty string, or undefined then apply its default value.
        // If it's a number with NaN value then also apply its default value.
        // NOTE: JS does not allow "value === NaN", the following does the work:
        if ((value instanceof Array && value.length === 0) ||
            (value === null || value === "" || value === undefined) ||
            (typeof(value) === "number" && isNaN(value))) { continue; }

        const checkedValue: any = configCheck.optional[parameter](value);
        if (checkedValue !== undefined) {
          settings[parameter] = checkedValue;
        } else {
          throw new Exceptions.ConfigurationError(parameter, value);
        }
      }
    }

    const skeleton: any = {}; // Fill the value of the configuration_skeleton
    for (const parameter in settings) {
      if (settings.hasOwnProperty(parameter)) {
        skeleton[parameter] = {
          value: settings[parameter],
        };
      }
    }

    Object.defineProperties(this.configuration, skeleton);

    this.logger.log("configuration parameters after validation:");
    for (const parameter in settings) {
      if (settings.hasOwnProperty(parameter)) {
        this.logger.log("· " + parameter + ": " + JSON.stringify(settings[parameter]));
      }
    }

    return;
  }

  /**
   * Configuration checker.
   * @return {Boolean}
   */
  private getConfigurationCheck(): {mandatory: {[name: string]: any}, optional: {[name: string]: any}} {
    return {
      mandatory: {
      },

      optional: {

        // Note: this function used to call 'this.logger.error' but calling 'this' with anything here is invalid
        wsServers: (wsServers: any): any => {
          /* Allow defining wsServers parameter as:
           *  String: "host"
           *  Array of Strings: ["host1", "host2"]
           *  Array of Objects: [{wsUri:"host1", weight:1}, {wsUri:"host2", weight:0}]
           *  Array of Objects and Strings: [{wsUri:"host1"}, "host2"]
           */
          if (typeof wsServers === "string") {
            wsServers = [{wsUri: wsServers}];
          } else if (wsServers instanceof Array) {
            for (let idx = 0; idx < wsServers.length; idx++) {
              if (typeof wsServers[idx] === "string") {
                wsServers[idx] = {wsUri: wsServers[idx]};
              }
            }
          } else {
            return;
          }

          if (wsServers.length === 0) {
            return false;
          }

          for (const wsServer of wsServers) {
            if (!wsServer.wsUri) {
              return;
            }
            if (wsServer.weight && !Number(wsServer.weight)) {
              return;
            }

            const url: any | -1 = Grammar.parse(wsServer.wsUri, "absoluteURI");

            if (url === -1) {
              return;
            }  else {
              wsServer.sipUri = "<sip:" + url.host +
                (url.port ? ":" + url.port : "") + ";transport=" + url.scheme.replace(/^wss$/i, "tcp") + ";lr>";

              if (!wsServer.weight) {
                wsServer.weight = 0;
              }

              wsServer.isError = false;
              wsServer.scheme = url.scheme.toUpperCase();
            }
          }
          return wsServers;
        },

        keepAliveInterval: (keepAliveInterval: string): number | undefined => {
          if (Utils.isDecimal(keepAliveInterval)) {
            const value: number = Number(keepAliveInterval);
            if (value > 0) {
              return value;
            }
          }
        },

        keepAliveDebounce: (keepAliveDebounce: string): number | undefined => {
          if (Utils.isDecimal(keepAliveDebounce)) {
            const value = Number(keepAliveDebounce);
            if (value > 0) {
              return value;
            }
          }
        },

        traceSip: (traceSip: boolean): boolean | undefined => {
          if (typeof traceSip === "boolean") {
            return traceSip;
          }
        },

        connectionTimeout: (connectionTimeout: string): number | undefined => {
          if (Utils.isDecimal(connectionTimeout)) {
            const value = Number(connectionTimeout);
            if (value > 0) {
              return value;
            }
          }
        },

        maxReconnectionAttempts: (maxReconnectionAttempts: string): number | undefined => {
          if (Utils.isDecimal(maxReconnectionAttempts)) {
            const value: number = Number(maxReconnectionAttempts);
            if (value >= 0) {
              return value;
            }
          }
        },

        reconnectionTimeout: (reconnectionTimeout: string): number | undefined => {
          if (Utils.isDecimal(reconnectionTimeout)) {
            const value: number = Number(reconnectionTimeout);
            if (value > 0) {
              return value;
            }
          }
        }

      }
    };
  }
}
