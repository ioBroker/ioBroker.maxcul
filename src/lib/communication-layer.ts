import { EventEmitter } from 'node:events';
import { ReadlineParser, SerialPort } from 'serialport';

import type { CulPacket } from './culpacket';

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

function serialOpen(port: SerialPort): Promise<void> {
    return new Promise((resolve, reject) => {
        port.open(err => (err ? reject(err) : resolve()));
    });
}

function serialClose(port: SerialPort): Promise<void> {
    return new Promise((resolve, reject) => {
        port.close(err => (err ? reject(err) : resolve()));
    });
}

function serialWrite(port: SerialPort, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
        port.write(data, err => (err ? reject(err) : resolve()));
    });
}

function serialDrain(port: SerialPort): Promise<void> {
    return new Promise((resolve, reject) => {
        port.drain(err => (err ? reject(err) : resolve()));
    });
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

/** Transport layer which talks to the CUL stick over the serial port */
export class CommunicationServiceLayer extends EventEmitter<CommunicationServiceLayerEvents> {
    private readonly logger: ioBroker.Logger;
    private readonly _baseAddress: string;
    public readonly serialPortName: string;
    public ready = false;

    private readonly _serialDeviceInstance: SerialPort;
    private _serialDeviceParser: ReadlineParser | null = null;

    /** Packets waiting to be transmitted */
    private readonly _messageQueue: CulPacket[] = [];
    /** Raw commands waiting to be written to the serial port */
    private readonly _queuedWrites: string[] = [];
    private _queueSendInProgress = false;
    private _current: CulPacket | null = null;
    private _busy = false;
    private _ackResolver: (() => void) | null = null;
    private _currentSentPromise: Promise<void> | null = null;
    private _credits = 0;

    constructor(logger: ioBroker.Logger, baudrate: number, serialPortName: string, baseAddress: string) {
        super();
        this.logger = logger;
        this._baseAddress = baseAddress;
        this.serialPortName = serialPortName;
        this.logger.info(`using serial device ${this.serialPortName}@${baudrate}`);
        this._serialDeviceInstance = new SerialPort({
            path: serialPortName,
            baudRate: baudrate,
            autoOpen: false,
        });
    }

    public connect(): Promise<void> {
        this.ready = false;
        this._serialDeviceInstance.removeAllListeners('error');
        this._serialDeviceInstance.removeAllListeners('data');
        this._serialDeviceInstance.removeAllListeners('close');
        this.removeAllListeners('newPacketForTransmission');
        this.removeAllListeners('readyForNextPacketTransmission');

        this._serialDeviceParser = this._serialDeviceInstance.pipe(new ReadlineParser({ delimiter: '\n' }));

        this._serialDeviceInstance.on('error', error => {
            this.emit('error', error);
            this.logger.error(`serialport communication error ${error}`);
        });

        this._serialDeviceInstance.on('close', () => {
            this.emit('close');
            this.removeAllListeners('newPacketForTransmission');
            this.removeAllListeners('readyForNextPacketTransmission');
        });

        this.on('newPacketForTransmission', () => this.processMessageQueue());
        this.on('readyForNextPacketTransmission', () => this.processMessageQueue());

        return serialOpen(this._serialDeviceInstance)
            .then(async () => {
                const timeout = 30000;
                this.logger.info(`serialPort ${this.serialPortName} is open!`);

                // The ReadlineParser is created with the default encoding `utf8` and therefore emits strings
                this._serialDeviceParser?.on('data', (data: string) => {
                    const dataString = data.replace(/\r/g, '');

                    if (/^\d+\s+\d+$/.test(dataString)) {
                        const m = dataString.match(/^(\d+)\s+(\d+)$/);
                        if (m) {
                            this._credits = parseInt(m[2], 10);
                            try {
                                this.emit('creditsReceived', m[2], m[1]);
                            } catch (error) {
                                this.logger.error(
                                    `Error in maxcul.js 'creditsReceived' : ${error} | Raw data from CUL: ${data}`,
                                );
                            }
                        }
                        return;
                    }

                    this.logger.debug(`incoming raw data from CUL: ${data}`);

                    if (/^V(.*)/.test(dataString)) {
                        this.emit('culFirmwareVersion', dataString);
                        this.ready = true;
                        this.emit('ready');
                    } else if (/^Z(.*)/.test(dataString)) {
                        try {
                            this.emit('culDataReceived', dataString);
                        } catch (error) {
                            this.logger.error(
                                `Error in maxcul.js 'culDataReceived' : ${error} | Raw data from CUL: ${data}`,
                            );
                        }
                    } else if (/^LOVF/.test(dataString)) {
                        try {
                            this.emit('LOVF', true);
                        } catch (error) {
                            this.logger.error(`Error in maxcul.js 'LOVF' : ${error} | Raw data from CUL: ${data}`);
                        }
                    } else {
                        this.logger.info(`received unknown data: ${dataString}`);
                    }
                });

                const readyPromise = new Promise<void>(resolve => {
                    this.once('ready', () => resolve());
                });

                try {
                    await delay(2000);
                    this.logger.debug('check CUL Firmware version');
                    await serialWrite(this._serialDeviceInstance, 'V\n');
                    this.logger.debug('Requested CUL Version...');

                    await delay(4000);
                    this.logger.debug('enable MAX! Mode of the CUL868');
                    await serialWrite(this._serialDeviceInstance, 'X20\n');
                    this.logger.debug('X20 written');
                    await serialDrain(this._serialDeviceInstance);
                    this.logger.debug('X20 drained');
                    await serialWrite(this._serialDeviceInstance, 'Zr\n');
                    this.logger.debug('Zr written');
                    await serialDrain(this._serialDeviceInstance);
                    this.logger.debug('Zr drained');
                    await serialWrite(this._serialDeviceInstance, `Za${this._baseAddress}\n`);
                    this.logger.debug('Za written');
                    await serialDrain(this._serialDeviceInstance);
                    this.logger.debug('Za drained');
                } catch (err) {
                    this.logger.error(`Error during CUL initialization: ${err}`);
                }

                try {
                    await promiseWithTimeout(readyPromise, timeout);
                } catch (err: any) {
                    if (err.name === 'TimeoutError') {
                        this.logger.info('Timeout on CUL connect, cul is available but not responding');
                    }
                }
            })
            .catch((err: any) => {
                this.logger.info(`Can not connect to serial port, cause: ${err.cause}`);
            });
    }

    public disconnect(): Promise<void> | false {
        if (this._serialDeviceInstance.isOpen) {
            return serialClose(this._serialDeviceInstance);
        }
        return false;
    }

    public async writeQueue(): Promise<boolean> {
        if (!this._queuedWrites.length) {
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
            await serialWrite(this._serialDeviceInstance, command);
        } catch (err) {
            this.logger.error(` Error on Write ${command}: ${err}`);
            setImmediate(() => this.writeQueue().catch(() => {}));
            return true;
        }
        this.logger.debug(`Send Packet to CUL: ${command.trim()}, awaiting drain event`);

        let drainError = false;
        try {
            await serialDrain(this._serialDeviceInstance);
        } catch (err) {
            this.logger.debug(`serial port buffer could not been drained (from ${command.trim()}): ${err}`);
            drainError = true;
        }
        if (!drainError) {
            this.logger.debug(`serial port buffer have been drained (from ${command.trim()})`);
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
        if (this._serialDeviceInstance.isOpen) {
            return this.enqueueWrite(`Zs${data}\n`);
        }
        this.logger.debug('Can not send packet because serial port is not open');
        return Promise.reject(new Error('Error: serial port is not open'));
    }

    public serialRawWrite(data: string): Promise<void> {
        if (this._serialDeviceInstance.isOpen) {
            return this.enqueueWrite(`${data}\n`);
        }
        this.logger.debug('Can not send packet because serial port is not open');
        return Promise.reject(new Error('Error: serial port is not open'));
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
