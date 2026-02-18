const hasProp = {}.hasOwnProperty;
const extend = function (child, parent) {
    for (const key in parent) {
        if (hasProp.call(parent, key)) {
            child[key] = parent[key];
        }
    }
    function ctor() {
        this.constructor = child;
    }

    ctor.prototype = parent.prototype;
    child.prototype = new ctor();
    child.__super__ = parent.prototype;
    return child;
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function promiseWithTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                const err = new Error('operation timed out');
                err.name = 'TimeoutError';
                reject(err);
            }, ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

function serialOpen(port) {
    return new Promise((resolve, reject) => {
        port.open(err => (err ? reject(err) : resolve()));
    });
}

function serialClose(port) {
    return new Promise((resolve, reject) => {
        port.close(err => (err ? reject(err) : resolve()));
    });
}

function serialWrite(port, data) {
    return new Promise((resolve, reject) => {
        port.write(data, err => (err ? reject(err) : resolve()));
    });
}

function serialDrain(port) {
    return new Promise((resolve, reject) => {
        port.drain(err => (err ? reject(err) : resolve()));
    });
}

module.exports = function (env) {
    let CommunicationServiceLayer;
    const { EventEmitter } = require('node:events');
    const { SerialPort } = require('serialport');
    const { ReadlineParser } = require('@serialport/parser-readline');

    return (CommunicationServiceLayer = (function (superClass) {
        extend(CommunicationServiceLayer, superClass);

        function CommunicationServiceLayer(baudrate, serialPortName, _baseAddress) {
            this._baseAddress = _baseAddress;
            this.serialPortName = serialPortName;
            env.logger.info(`using serial device ${this.serialPortName}@${baudrate}`);
            this._messageQueue = [];
            this._queueSendInProgress = false;
            this._current = void 0;
            this._busy = false;
            this._ackResolver = null;
            this._currentSentPromise = null;
            this._serialDeviceInstance = new SerialPort({
                path: serialPortName,
                baudRate: baudrate,
                autoOpen: false,
            });
            this._queuedWrites = [];
            this._credits = 0;
        }

        CommunicationServiceLayer.prototype.connect = function () {
            this.ready = false;
            this._serialDeviceInstance.removeAllListeners('error');
            this._serialDeviceInstance.removeAllListeners('data');
            this._serialDeviceInstance.removeAllListeners('close');
            this.removeAllListeners('newPacketForTransmission');
            this.removeAllListeners('readyForNextPacketTransmission');
            this._serialDeviceParser = this._serialDeviceInstance.pipe(new ReadlineParser({ delimiter: '\n' }));
            this._serialDeviceInstance.on(
                'error',
                (function (_this) {
                    return function (error) {
                        _this.emit('error', error);
                        return env.logger.error(`serialport communication error ${error}`);
                    };
                })(this),
            );
            this._serialDeviceInstance.on(
                'close',
                (function (_this) {
                    return function () {
                        _this.emit('close');
                        _this.removeAllListeners('newPacketForTransmission');
                        return _this.removeAllListeners('readyForNextPacketTransmission');
                    };
                })(this),
            );
            this.on(
                'newPacketForTransmission',
                (function (_this) {
                    return function () {
                        return _this.processMessageQueue();
                    };
                })(this),
            );
            this.on(
                'readyForNextPacketTransmission',
                (function (_this) {
                    return function () {
                        return _this.processMessageQueue();
                    };
                })(this),
            );

            const _this = this;
            return serialOpen(this._serialDeviceInstance)
                .then(async function () {
                    const timeout = 30000;
                    env.logger.info(`serialPort ${_this.serialPortName} is open!`);
                    _this._serialDeviceParser.on('data', function (data) {
                        let dataString = `${data}`;
                        dataString = dataString.replace(/[\r]/g, '');
                        if (/^\d+\s+\d+$/.test(dataString)) {
                            const m = dataString.match(/^(\d+)\s+(\d+)$/);
                            _this._credits = parseInt(m[2], 10);
                            try {
                                return _this.emit('creditsReceived', m[2], m[1]);
                            } catch (error) {
                                return env.logger.error(
                                    `Error in maxcul.js 'creditsReceived' : ${error} | Raw data from CUL: ${data}`,
                                );
                            }
                        }
                        env.logger.debug(`incoming raw data from CUL: ${data}`);

                        if (/^V(.*)/.test(dataString)) {
                            _this.emit('culFirmwareVersion', dataString);
                            _this.ready = true;
                            return _this.emit('ready');
                        } else if (/^Z(.*)/.test(dataString)) {
                            try {
                                return _this.emit('culDataReceived', dataString);
                            } catch (error) {
                                return env.logger.error(
                                    `Error in maxcul.js 'culDataReceived' : ${error} | Raw data from CUL: ${data}`,
                                );
                            }
                        } else if (/^LOVF/.test(dataString)) {
                            try {
                                return _this.emit('LOVF', true);
                            } catch (error) {
                                return env.logger.error(
                                    `Error in maxcul.js 'LOVF' : ${error} | Raw data from CUL: ${data}`,
                                );
                            }
                        } else {
                            return env.logger.info(`received unknown data: ${dataString}`);
                        }
                    });

                    const readyPromise = new Promise(function (resolve) {
                        _this.once('ready', resolve);
                    });

                    try {
                        await delay(2000);
                        env.logger.debug('check CUL Firmware version');
                        await serialWrite(_this._serialDeviceInstance, 'V\n');
                        env.logger.debug('Requested CUL Version...');

                        await delay(4000);
                        env.logger.debug('enable MAX! Mode of the CUL868');
                        await serialWrite(_this._serialDeviceInstance, 'X20\n');
                        env.logger.debug('X20 written');
                        await serialDrain(_this._serialDeviceInstance);
                        env.logger.debug('X20 drained');
                        await serialWrite(_this._serialDeviceInstance, 'Zr\n');
                        env.logger.debug('Zr written');
                        await serialDrain(_this._serialDeviceInstance);
                        env.logger.debug('Zr drained');
                        await serialWrite(_this._serialDeviceInstance, `Za${_this._baseAddress}\n`);
                        env.logger.debug('Za written');
                        await serialDrain(_this._serialDeviceInstance);
                        env.logger.debug('Za drained');
                    } catch (err) {
                        env.logger.error(`Error during CUL initialization: ${err}`);
                    }

                    try {
                        await promiseWithTimeout(readyPromise, timeout);
                    } catch (err) {
                        if (err.name === 'TimeoutError') {
                            env.logger.info('Timeout on CUL connect, cul is available but not responding');
                        }
                    }
                })
                .catch(function (err) {
                    return env.logger.info(`Can not connect to serial port, cause: ${err.cause}`);
                });
        };

        CommunicationServiceLayer.prototype.disconnect = function () {
            if (this._serialDeviceInstance.isOpen) {
                return serialClose(this._serialDeviceInstance);
            }
            return false;
        };

        CommunicationServiceLayer.prototype.writeQueue = async function () {
            if (!this._queuedWrites.length) {
                return Promise.resolve(true);
            }

            this._queueSendInProgress = true;
            let command = this._queuedWrites[0];
            env.logger.debug(`writeQueue: first entry = ${JSON.stringify(command)}`);
            let delayMs = 2000;

            if (command[0] === 'X') {
                command = this._queuedWrites.shift();
                delayMs = 0;
            } else {
                if (this._credits < 220) {
                    command = 'X\n';
                    delayMs = 5000;
                } else {
                    command = this._queuedWrites.shift();
                    this._queuedWrites.unshift('X\n');
                }
            }

            try {
                await serialWrite(this._serialDeviceInstance, command);
            } catch (err) {
                env.logger.error(` Error on Write ${command}: ${err}`);
                setImmediate(() => this.writeQueue().catch(_e => {}), 100);
                return Promise.resolve(true);
            }
            env.logger.debug(`Send Packet to CUL: ${command.trim()}, awaiting drain event`);

            let drainError = false;
            try {
                await serialDrain(this._serialDeviceInstance);
            } catch (err) {
                env.logger.debug(`serial port buffer could not been drained (from ${command.trim()}): ${err}`);
                drainError = true;
            }
            !drainError && env.logger.debug(`serial port buffer have been drained (from ${command.trim()})`);

            env.logger.debug(`Send Packet to CUL: Wait ${delayMs} after sending ${command.trim()}`);

            setTimeout(() => {
                env.logger.debug(
                    `delayed next send by ${delayMs}ms (Queue length left = ${
                        this._queuedWrites.length
                    }, Current Credit = ${this._credits})`,
                );
                this._queueSendInProgress = false;
                this.writeQueue().catch(_e => {});
            }, delayMs);

            return Promise.resolve(true);
        };

        CommunicationServiceLayer.prototype.serialWrite = function (data) {
            let command;
            if (this._serialDeviceInstance.isOpen) {
                command = `Zs${data}\n`;
                /*                return this._serialDeviceInstance.writeAsync(command).then((function(_this) {
                    return function() {
                        env.logger.debug('Send Packet to CUL: ' + data + ', awaiting drain event');
                        return _this._serialDeviceInstance.drainAsync().then(function() {
                            return env.logger.debug('serial port buffer have been drained');
                        });
                    };
                })(this));*/
                if (this._queuedWrites.indexOf(command) === -1) {
                    this._queuedWrites.push(command);
                    if (this._queuedWrites.length === 1 && !this._queueSendInProgress) {
                        setImmediate(() => this.writeQueue());
                        return Promise.resolve();
                    }
                    env.logger.debug(`Queued send for ${command.trim()} (Queue length = ${this._queuedWrites.length})`);
                } else {
                    env.logger.debug(`Ignore command because already in queue ${command.trim()}`);
                }
                return Promise.resolve();
            }
            env.logger.debug('Can not send packet because serial port is not open');
            return Promise.reject('Error: serial port is not open');
        };

        CommunicationServiceLayer.prototype.serialRawWrite = function (data) {
            let command;
            if (this._serialDeviceInstance.isOpen) {
                command = `${data}\n`;
                /*                return this._serialDeviceInstance.writeAsync(command).then((function(_this) {
                    return function() {
                        return _this._serialDeviceInstance.drainAsync();
                    };
                })(this));*/
                if (this._queuedWrites.indexOf(command) === -1) {
                    this._queuedWrites.push(command);
                    if (this._queuedWrites.length === 1 && !this._queueSendInProgress) {
                        setImmediate(() => this.writeQueue());
                        return Promise.resolve();
                    }
                    env.logger.debug(`Queued send for ${command.trim()} (Queue length = ${this._queuedWrites.length})`);
                } else {
                    env.logger.debug(`Ignore command because already in queue ${command.trim()}`);
                }
                return Promise.resolve();
            }
            env.logger.debug('Can not send packet because serial port is not open');
            return Promise.reject('Error: serial port is not open');
        };

        CommunicationServiceLayer.prototype.addPacketToTransportQueue = function (packet) {
            if (packet.getRawType() === 'ShutterContact') {
                this._messageQueue.unshift(packet);
            } else {
                this._messageQueue.push(packet);
            }
            if (this._busy) {
                return;
            }
            return this.emit('newPacketForTransmission');
        };

        CommunicationServiceLayer.prototype.processMessageQueue = function () {
            let next;
            this._busy = true;
            if (!this._current) {
                next = this._messageQueue.shift();
            }
            if (!next) {
                // env.logger.debug('no packet to handle in send queue');
                this._busy = false;
                return;
            }
            if (next.getStatus === 'new') {
                next.setStatus('send');
                next.setSendTries(1);
            }
            this._current = next;
            return (this._currentSentPromise = this.sendPacket());
        };

        CommunicationServiceLayer.prototype.sendPacket = function () {
            const packet = this._current;

            return promiseWithTimeout(
                new Promise(
                    (function (_this) {
                        return function (resolve, reject) {
                            _this._ackResolver = resolve;
                            if (packet.isCredits()) {
                                _this.serialRawWrite(packet.getRawPacket()).catch(function (err) {
                                    return reject(err || new Error('Error from serialRawWrite'));
                                });
                                packet.resolve(true);
                                setTimeout(function () {
                                    _this._ackResolver();
                                    packet.resolve(true);
                                    return _this.cleanMessageQueueState();
                                }, 50);
                            } else {
                                _this.serialWrite(packet.getRawPacket()).catch(function (err) {
                                    return reject(err || new Error('Error from serialWrite'));
                                });
                            }
                            return _this.once('gotAck', function () {
                                _this._ackResolver();
                                packet.resolve(true);
                                return _this.cleanMessageQueueState();
                            });
                        };
                    })(this),
                ),
                3000,
            ).catch(
                (function (_this) {
                    return function (err) {
                        _this.removeAllListeners('gotAck');

                        if (err.name === 'TimeoutError') {
                            if (packet.getSendTries() < 3) {
                                packet.setSendTries(packet.getSendTries() + 1);
                                _this._currentSentPromise = _this.sendPacket(packet);
                                return env.logger.debug(
                                    `Retransmit packet ${packet.getRawPacket()}, try ${packet.getSendTries()} of 3`,
                                );
                            }
                            if (packet.getRawPacket().slice(14, 20) === '123456') {
                                packet.resolve(true);
                                env.logger.debug(
                                    'Time information has been sent three times, clean message queue state.',
                                );
                                return _this.cleanMessageQueueState();
                            }
                            packet.reject(`Packet ${packet.getRawPacket()} sent but no response!`);
                            return _this.cleanMessageQueueState();
                        }
                        packet.reject(`Packet ${packet.getRawPacket()} could not be sent! ${err}`);
                        return _this.cleanMessageQueueState();
                    };
                })(this),
            );
        };

        CommunicationServiceLayer.prototype.cleanMessageQueueState = function () {
            this._current = null;
            return this.emit('readyForNextPacketTransmission');
        };

        CommunicationServiceLayer.prototype.ackPacket = function () {
            return this.emit('gotAck');
        };

        return CommunicationServiceLayer;
    })(EventEmitter));
};
