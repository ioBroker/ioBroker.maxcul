import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { ReadlineParser, SerialPort } from 'serialport';

import type { CulPacket } from './culpacket';

/** Time between two attempts to (re)open a connection which was lost or could not be opened */
const RECONNECT_INTERVAL = 10000;

/** How a CUL is connected to this host */
export type CulConnectionOptions =
    | {
          /** CUL stick on a serial port */
          type: 'serial';
          /** Name/path of the serial port */
          port: string;
          baudrate: number;
      }
    | {
          /** CUN/CUNO reachable over the network */
          type: 'network';
          /** Host name or IP address */
          host: string;
          /** TCP port culfw is listening on */
          port: number;
      };

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function promiseWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                const err = new Error('operation timed out');
                err.name = 'TimeoutError';
                reject(err);
            }, ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

/** Events every transport emits */
interface CulTransportEvents {
    /** One complete line received from the CUL. The line break is already stripped */
    line: [line: string];
    error: [error: Error];
    close: [];
}

/**
 * Connection to a CUL. culfw talks the same line based protocol over a serial port and over TCP,
 * so only opening, closing and writing differ between the implementations.
 */
abstract class CulTransport extends EventEmitter<CulTransportEvents> {
    /** Human-readable name of the connection, used for logging */
    public abstract readonly name: string;

    private _parser: ReadlineParser | null = null;
    private _pipedStream: NodeJS.ReadableStream | null = null;

    /** True as long as data can be written */
    public abstract get isOpen(): boolean;

    public abstract open(): Promise<void>;

    /** Close the connection. Resolves immediately if it is not open */
    public abstract close(): Promise<void>;

    public abstract write(data: string): Promise<void>;

    /** Resolves as soon as everything written so far has left the send buffer */
    public abstract drain(): Promise<void>;

    /** Split the incoming bytes of `stream` into lines and emit them as `line` events */
    protected pipeLines(stream: NodeJS.ReadableStream): void {
        this.unpipeLines();
        // The ReadlineParser is created with the default encoding `utf8` and therefore emits strings
        const parser = new ReadlineParser({ delimiter: '\n' });
        stream.pipe(parser);
        parser.on('data', (line: string) => this.emit('line', line.replace(/\r/g, '')));
        this._parser = parser;
        this._pipedStream = stream;
    }

    /** Detach the parser of a previous connection, so that reconnecting does not deliver every line twice */
    protected unpipeLines(): void {
        if (!this._parser) {
            return;
        }
        this._pipedStream?.unpipe(this._parser);
        this._parser.removeAllListeners('data');
        this._parser.destroy();
        this._parser = null;
        this._pipedStream = null;
    }
}

/** CUL stick attached to a serial port */
class SerialTransport extends CulTransport {
    public readonly name: string;
    private readonly _port: SerialPort;

    constructor(path: string, baudRate: number) {
        super();
        this.name = `${path}@${baudRate}`;
        this._port = new SerialPort({ path, baudRate, autoOpen: false });
    }

    public get isOpen(): boolean {
        return this._port.isOpen;
    }

    public open(): Promise<void> {
        this._port.removeAllListeners('error');
        this._port.removeAllListeners('close');
        this._port.on('error', error => this.emit('error', error));
        this._port.on('close', () => this.emit('close'));
        this.pipeLines(this._port);

        return new Promise((resolve, reject) => {
            this._port.open(err => (err ? reject(err) : resolve()));
        });
    }

    public close(): Promise<void> {
        this.unpipeLines();
        if (!this._port.isOpen) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            this._port.close(err => (err ? reject(err) : resolve()));
        });
    }

    public write(data: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this._port.write(data, err => (err ? reject(err) : resolve()));
        });
    }

    public drain(): Promise<void> {
        return new Promise((resolve, reject) => {
            this._port.drain(err => (err ? reject(err) : resolve()));
        });
    }
}

/** CUN/CUNO which exposes culfw over TCP */
class TcpTransport extends CulTransport {
    public readonly name: string;
    private readonly _host: string;
    private readonly _port: number;
    private _socket: Socket | null = null;

    constructor(host: string, port: number) {
        super();
        this.name = `${host}:${port}`;
        this._host = host;
        this._port = port;
    }

    public get isOpen(): boolean {
        return this._socket?.readyState === 'open';
    }

    public open(): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = new Socket();
            this._socket = socket;

            // Detect a CUN/CUNO which silently went away, otherwise a half-open connection would never be noticed
            socket.setKeepAlive(true, 30000);
            // The MAX! protocol waits for acknowledgements, so the commands must not be delayed by Nagle's algorithm
            socket.setNoDelay(true);

            const onConnectError = (error: Error): void => {
                socket.destroy();
                if (this._socket === socket) {
                    this._socket = null;
                }
                reject(error);
            };

            socket.once('error', onConnectError);

            socket.connect(this._port, this._host, () => {
                socket.off('error', onConnectError);
                socket.on('error', error => this.emit('error', error));
                socket.on('close', () => this.emit('close'));
                this.pipeLines(socket);
                resolve();
            });
        });
    }

    public close(): Promise<void> {
        const socket = this._socket;
        this._socket = null;
        this.unpipeLines();

        if (!socket || socket.destroyed) {
            return Promise.resolve();
        }
        return new Promise(resolve => {
            socket.once('close', () => resolve());
            socket.destroy();
        });
    }

    public write(data: string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this._socket || this._socket.readyState !== 'open') {
                reject(new Error('network connection is not open'));
                return;
            }
            this._socket.write(data, err => (err ? reject(err) : resolve()));
        });
    }

    public drain(): Promise<void> {
        // The callback of `socket.write` already fires when the data has left the send buffer
        return Promise.resolve();
    }
}

/** Events emitted by the communication layer */
export interface CommunicationServiceLayerEvents {
    error: [error: Error];
    close: [];
    /** The CUL answered the version request */
    ready: [];
    newPacketForTransmission: [];
    readyForNextPacketTransmission: [];
    /** Remaining credits and credits used in the last hour */
    creditsReceived: [credits: string, credits1: string];
    culFirmwareVersion: [version: string];
    culDataReceived: [data: string];
    /** Limit overflow: the 1% duty cycle of the 868 MHz band is exhausted */
    LOVF: [value: boolean];
    gotAck: [];
}

/** Transport layer which talks to the CUL over a serial port or over the network */
export class CommunicationServiceLayer extends EventEmitter<CommunicationServiceLayerEvents> {
    private readonly logger: ioBroker.Logger;
    private readonly _baseAddress: string;
    /** Name of the connection as it is shown in the log */
    public readonly connectionName: string;
    public ready = false;

    private readonly _transport: CulTransport;

    /** Packets waiting to be transmitted */
    private readonly _messageQueue: CulPacket[] = [];
    /** Raw commands waiting to be written to the CUL */
    private readonly _queuedWrites: string[] = [];
    private _queueSendInProgress = false;
    private _current: CulPacket | null = null;
    private _busy = false;
    private _ackResolver: (() => void) | null = null;
    private _currentSentPromise: Promise<void> | null = null;
    private _credits = 0;
    private _reconnectTimer: NodeJS.Timeout | null = null;
    /** True while `connect` is running, so that two connection attempts cannot overlap */
    private _connecting = false;
    /** True after `disconnect` was called, so that no reconnect is scheduled anymore */
    private _closedByUser = false;

    constructor(logger: ioBroker.Logger, connection: CulConnectionOptions, baseAddress: string) {
        super();
        this.logger = logger;
        this._baseAddress = baseAddress;

        if (connection.type === 'network') {
            this._transport = new TcpTransport(connection.host, connection.port);
            this.connectionName = this._transport.name;
            this.logger.info(`using network device ${this.connectionName}`);
        } else {
            this._transport = new SerialTransport(connection.port, connection.baudrate);
            this.connectionName = this._transport.name;
            this.logger.info(`using serial device ${this.connectionName}`);
        }

        this._transport.on('line', line => this.handleLine(line));

        this._transport.on('error', error => {
            this.logger.error(`communication error on ${this.connectionName}: ${error.message}`);
            // Emitting `error` without a listener would throw, and a connection error must not kill the adapter
            if (this.listenerCount('error')) {
                this.emit('error', error);
            }
        });

        this._transport.on('close', () => {
            this.ready = false;
            this.emit('close');
            if (!this._closedByUser) {
                this.logger.info(`connection to ${this.connectionName} was closed`);
                this.scheduleReconnect();
            }
        });
    }

    /** Handle one line received from the CUL */
    private handleLine(line: string): void {
        if (/^\d+\s+\d+$/.test(line)) {
            const m = line.match(/^(\d+)\s+(\d+)$/);
            if (m) {
                this._credits = parseInt(m[2], 10);
                try {
                    this.emit('creditsReceived', m[2], m[1]);
                } catch (error) {
                    this.logger.error(`Error in maxcul.js 'creditsReceived' : ${error} | Raw data from CUL: ${line}`);
                }
            }
            return;
        }

        this.logger.debug(`incoming raw data from CUL: ${line}`);

        if (/^V(.*)/.test(line)) {
            this.emit('culFirmwareVersion', line);
            this.ready = true;
            this.emit('ready');
        } else if (/^Z(.*)/.test(line)) {
            try {
                this.emit('culDataReceived', line);
            } catch (error) {
                this.logger.error(`Error in maxcul.js 'culDataReceived' : ${error} | Raw data from CUL: ${line}`);
            }
        } else if (/^LOVF/.test(line)) {
            try {
                this.emit('LOVF', true);
            } catch (error) {
                this.logger.error(`Error in maxcul.js 'LOVF' : ${error} | Raw data from CUL: ${line}`);
            }
        } else {
            this.logger.info(`received unknown data: ${line}`);
        }
    }

    /** Try to open the connection again after `RECONNECT_INTERVAL` */
    private scheduleReconnect(): void {
        if (this._closedByUser || this._reconnectTimer) {
            return;
        }
        this.logger.info(`Trying to connect to ${this.connectionName} again in ${RECONNECT_INTERVAL / 1000} seconds`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect().catch(err => this.logger.error(`Cannot reconnect to ${this.connectionName}: ${err}`));
        }, RECONNECT_INTERVAL);
    }

    public async connect(): Promise<void> {
        if (this._connecting) {
            // Another attempt is still running. Try again after it has finished
            this.logger.debug(`Connect to ${this.connectionName} is already in progress`);
            this.scheduleReconnect();
            return;
        }

        this._connecting = true;
        try {
            await this.openAndInitialize();
        } finally {
            this._connecting = false;
        }
    }

    private async openAndInitialize(): Promise<void> {
        this.ready = false;
        this._closedByUser = false;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        this.removeAllListeners('newPacketForTransmission');
        this.removeAllListeners('readyForNextPacketTransmission');
        this.on('newPacketForTransmission', () => this.processMessageQueue());
        this.on('readyForNextPacketTransmission', () => this.processMessageQueue());

        try {
            await this._transport.open();
        } catch (err) {
            this.logger.error(
                `Can not connect to ${this.connectionName}, cause: ${err instanceof Error ? err.message : err}`,
            );
            this.scheduleReconnect();
            return;
        }

        this.logger.info(`${this.connectionName} is open!`);

        // Wait for the version answer of the CUL, but stop waiting if the connection is gone again
        let settle: (() => void) | null = null;
        const connectionSettled = new Promise<void>(resolve => {
            settle = resolve;
        });
        const onSettled = (): void => settle?.();
        this.on('ready', onSettled);
        this.on('close', onSettled);

        try {
            await delay(2000);
            this.logger.debug('check CUL Firmware version');
            await this._transport.write('V\n');
            this.logger.debug('Requested CUL Version...');

            await delay(4000);
            this.logger.debug('enable MAX! Mode of the CUL868');
            await this._transport.write('X20\n');
            this.logger.debug('X20 written');
            await this._transport.drain();
            this.logger.debug('X20 drained');
            await this._transport.write('Zr\n');
            this.logger.debug('Zr written');
            await this._transport.drain();
            this.logger.debug('Zr drained');
            await this._transport.write(`Za${this._baseAddress}\n`);
            this.logger.debug('Za written');
            await this._transport.drain();
            this.logger.debug('Za drained');
        } catch (err) {
            this.logger.error(`Error during CUL initialization: ${err}`);
        }

        try {
            await promiseWithTimeout(connectionSettled, 30000);
        } catch (err: any) {
            if (err.name === 'TimeoutError') {
                this.logger.info('Timeout on CUL connect, cul is available but not responding');
            }
        } finally {
            this.removeListener('ready', onSettled);
            this.removeListener('close', onSettled);
        }

        if (!this._transport.isOpen) {
            return;
        }

        // Continue with everything that was queued while the connection was down
        if (this._queuedWrites.length && !this._queueSendInProgress) {
            setImmediate(() => this.writeQueue().catch(() => {}));
        }
        this.emit('readyForNextPacketTransmission');
    }

    public disconnect(): Promise<void> {
        this._closedByUser = true;
        this.ready = false;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        return this._transport.close();
    }

    public async writeQueue(): Promise<boolean> {
        if (!this._queuedWrites.length) {
            return true;
        }

        if (!this._transport.isOpen) {
            // Everything stays in the queue and is sent once the connection is back
            this.logger.debug(`Postpone ${this._queuedWrites.length} queued commands, connection is not open`);
            this._queueSendInProgress = false;
            return true;
        }

        this._queueSendInProgress = true;
        let command = this._queuedWrites[0];
        this.logger.debug(`writeQueue: first entry = ${JSON.stringify(command)}`);
        let delayMs = 2000;

        if (command[0] === 'X') {
            command = this._queuedWrites.shift()!;
            delayMs = 0;
        } else if (this._credits < 220) {
            command = 'X\n';
            delayMs = 5000;
        } else {
            command = this._queuedWrites.shift()!;
            this._queuedWrites.unshift('X\n');
        }

        try {
            await this._transport.write(command);
        } catch (err) {
            this.logger.error(` Error on Write ${command}: ${err}`);
            setImmediate(() => this.writeQueue().catch(() => {}));
            return true;
        }
        this.logger.debug(`Send Packet to CUL: ${command.trim()}, awaiting drain event`);

        let drainError = false;
        try {
            await this._transport.drain();
        } catch (err) {
            this.logger.debug(`send buffer could not been drained (from ${command.trim()}): ${err}`);
            drainError = true;
        }
        if (!drainError) {
            this.logger.debug(`send buffer have been drained (from ${command.trim()})`);
        }

        this.logger.debug(`Send Packet to CUL: Wait ${delayMs} after sending ${command.trim()}`);

        setTimeout(() => {
            this.logger.debug(
                `delayed next send by ${delayMs}ms (Queue length left = ${this._queuedWrites.length}, Current Credit = ${
                    this._credits
                })`,
            );
            this._queueSendInProgress = false;
            this.writeQueue().catch(() => {});
        }, delayMs);

        return true;
    }

    public serialWrite(data: string): Promise<void> {
        if (this._transport.isOpen) {
            return this.enqueueWrite(`Zs${data}\n`);
        }
        this.logger.debug('Can not send packet because the connection is not open');
        return Promise.reject(new Error(`Error: connection to ${this.connectionName} is not open`));
    }

    public serialRawWrite(data: string): Promise<void> {
        if (this._transport.isOpen) {
            return this.enqueueWrite(`${data}\n`);
        }
        this.logger.debug('Can not send packet because the connection is not open');
        return Promise.reject(new Error(`Error: connection to ${this.connectionName} is not open`));
    }

    private enqueueWrite(command: string): Promise<void> {
        if (this._queuedWrites.includes(command)) {
            this.logger.debug(`Ignore command because already in queue ${command.trim()}`);
            return Promise.resolve();
        }

        this._queuedWrites.push(command);
        if (this._queuedWrites.length === 1 && !this._queueSendInProgress) {
            setImmediate(() => this.writeQueue().catch(() => {}));
            return Promise.resolve();
        }
        this.logger.debug(`Queued send for ${command.trim()} (Queue length = ${this._queuedWrites.length})`);
        return Promise.resolve();
    }

    public addPacketToTransportQueue(packet: CulPacket): void {
        if (packet.getRawType() === 'ShutterContact') {
            this._messageQueue.unshift(packet);
        } else {
            this._messageQueue.push(packet);
        }
        if (this._busy) {
            return;
        }
        this.emit('newPacketForTransmission');
    }

    public processMessageQueue(): void {
        let next: CulPacket | undefined;
        this._busy = true;
        if (!this._current) {
            next = this._messageQueue.shift();
        }
        if (!next) {
            // this.logger.debug('no packet to handle in send queue');
            this._busy = false;
            return;
        }
        if (next.getStatus() === 'new') {
            next.setStatus('send');
            next.setSendTries(1);
        }
        this._current = next;
        this._currentSentPromise = this.sendPacket();
    }

    private sendPacket(): Promise<void> {
        const packet = this._current!;

        return promiseWithTimeout(
            new Promise<void>((resolve, reject) => {
                this._ackResolver = () => resolve();
                if (packet.isCredits()) {
                    this.serialRawWrite(packet.getRawPacket()).catch((err: unknown) =>
                        reject(err instanceof Error ? err : new Error('Error from serialRawWrite')),
                    );
                    packet.resolve?.(true);
                    setTimeout(() => {
                        this._ackResolver?.();
                        packet.resolve?.(true);
                        this.cleanMessageQueueState();
                    }, 50);
                } else {
                    this.serialWrite(packet.getRawPacket()).catch((err: unknown) =>
                        reject(err instanceof Error ? err : new Error('Error from serialWrite')),
                    );
                }
                this.once('gotAck', () => {
                    this._ackResolver?.();
                    packet.resolve?.(true);
                    this.cleanMessageQueueState();
                });
            }),
            3000,
        ).catch((err: any) => {
            this.removeAllListeners('gotAck');

            if (err.name === 'TimeoutError') {
                if (packet.getSendTries() < 3) {
                    packet.setSendTries(packet.getSendTries() + 1);
                    this._currentSentPromise = this.sendPacket();
                    this.logger.debug(`Retransmit packet ${packet.getRawPacket()}, try ${packet.getSendTries()} of 3`);
                    return;
                }
                if (packet.getRawPacket().slice(14, 20) === '123456') {
                    packet.resolve?.(true);
                    this.logger.debug('Time information has been sent three times, clean message queue state.');
                    this.cleanMessageQueueState();
                    return;
                }
                packet.reject?.(`Packet ${packet.getRawPacket()} sent but no response!`);
                this.cleanMessageQueueState();
                return;
            }
            packet.reject?.(`Packet ${packet.getRawPacket()} could not be sent! ${err}`);
            this.cleanMessageQueueState();
        });
    }

    public cleanMessageQueueState(): void {
        this._current = null;
        this.emit('readyForNextPacketTransmission');
    }

    public ackPacket(): void {
        this.emit('gotAck');
    }
}
