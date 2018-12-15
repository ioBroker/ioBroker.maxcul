var hasProp = {}.hasOwnProperty;

var extend = function (child, parent) {
    for (var key in parent) {
        if (hasProp.call(parent, key)) child[key] = parent[key];
    }
    function ctor() {
        this.constructor = child;
    }

    ctor.prototype = parent.prototype;
    child.prototype = new ctor();
    child.__super__ = parent.prototype;
    return child;
};

module.exports = function (env) {
    var MaxDriver;
    var EventEmitter = require('events').EventEmitter;
    var BitSet = require('bitset');
    var Promise = require('bluebird');
    var Moment = require('moment');
    var Sprintf = require('sprintf-js').sprintf;
    var BinaryParser = require('binary-parser').Parser;
    var CommunicationServiceLayer = require(__dirname + '/communication-layer')(env);
    var CulPacket = require('./culpacket')(env);

    return MaxDriver = (function (superClass) {
        extend(MaxDriver, superClass);
        function MaxDriver(baseAddress, pairModeEnabled, serialPortName, baudrate) {
            this.deviceTypes = [
                'Cube',
                'HeatingThermostat',
                'HeatingThermostatPlus',
                'WallMountedThermostat',
                'ShutterContact',
                'PushButton'
            ];
            this.baseAddress = baseAddress;
            this.msgCount = 0;
            this.pairModeEnabled = pairModeEnabled;
            this.comLayer = new CommunicationServiceLayer(baudrate, serialPortName, this.baseAddress);

            this.comLayer.on('culDataReceived', (function (_this) {
                return function (data) {
                    return _this.handleIncommingMessage(data);
                };
            })(this));

            this.comLayer.on('LOVF', (function (_this) {
                return function (data) {
                    return  _this.emit('LOVF');
                };
            })(this));

            this.comLayer.on('culFirmwareVersion', (function (_this) {
                return function (data) {
                    _this.emit('culFirmwareVersion', data);
                    return env.logger.info('CUL FW Version: ' + data);
                };
            })(this));

            this.comLayer.on('creditsReceived', (function (_this) {
                return function (creidt, credit1) {
                    return _this.emit('creditsReceived', creidt, credit1);
                };
            })(this));

            setInterval((function (_this) {
                return function () {
                    return _this.emit('checkTimeIntervalFired');
                };
            })(this), 1000 * 60 * 60);
        }

        MaxDriver.prototype.connect = function () {
            return this.comLayer.connect();
        };

        MaxDriver.prototype.disconnect = function () {
            return this.comLayer.disconnect();
        };

        MaxDriver.prototype.decodeCmdId = function (id) {
            var key;
            key = 'cmd' + id;
            this.commandList = {
                cmd00: {
                    functionName: 'PairPing',
                    id: '00'
                },
                cmd01: {
                    functionName: 'PairPong',
                    id: '01'
                },
                cmd02: {
                    functionName: 'Ack',
                    id: '02'
                },
                cmd03: {
                    functionName: 'TimeInformation',
                    id: '03'
                },
                cmd10: 'ConfigWeekProfile',
                cmd11: 'ConfigTemperatures',
                cmd12: 'ConfigValve',
                cmd20: 'AddLinkPartner',
                cmd21: 'RemoveLinkPartner',
                cmd22: 'SetGroupId',
                cmd23: 'RemoveGroupId',
                cmd30: {
                    functionName: 'ShutterContactState',
                    id: '30'
                },
                cmd40: 'SetTemperature',
                cmd42: {
                    functionName: 'WallThermostatControl',
                    id: '42'
                },
                cmd43: 'SetComfortTemperature',
                cmd44: 'SetEcoTemperature',
                cmd50: {
                    functionName: 'PushButtonState',
                    id: '50'
                },
                cmd60: {
                    functionName: 'ThermostatState',
                    id: 60
                },
                cmd70: {
                    functionName: 'WallThermostatState',
                    id: '70'
                },
                cmd82: 'SetDisplayActualTemperature',
                cmdF1: 'WakeUp',
                cmdF0: 'Reset'
            };
            if (key in this.commandList) {
                return this.commandList[key]['functionName'];
            } else {
                return false;
            }
        };

        MaxDriver.prototype.handleIncommingMessage = function (message) {
            var packet;
            packet = this.parseIncommingMessage(message);

            if (packet.credits !== null) {
                return this.emit('credits', packet.credits, packet.credits1);
            } else
            if (packet) {
                if (packet.getSource() === this.baseAddress) {
                    return env.logger.debug('ignored auto-ack packet');
                } else {
                    if (packet.getCommand()) {
                        return this[packet.getCommand()](packet);
                    } else {
                        return env.logger.debug('received unknown command id ' + (packet.getRawType()));
                    }
                }
            } else {
                return env.logger.debug('message was no valid MAX! paket.');
            }
        };

        MaxDriver.prototype.parseIncommingMessage = function (message) {
            var data, packet, rssi;
            env.logger.debug('decoding Message ' + message);

            var m = message.match(/^(\d+)\w+(\d+)$/);
            if (m) {
                packet = new CulPacket();
                packet.credits = m[1];
                packet.credits1 = m[2];
                return packet;
            }

            message = message.replace(/\n/, '');
            message = message.replace(/\r/, '');
            rssi = parseInt(message.slice(-2), 16);
            if (rssi >= 128) {
                rssi = (rssi - 256) / 2 - 74;
            } else {
                rssi = rssi / 2 - 74;
            }
            env.logger.debug('RSSI for Message: ' + rssi);
            message = message.substring(0, message.length - 2);
            data = message.split(/Z(..)(..)(..)(..)(......)(......)(..)(.*)/);
            data.shift();
            if (data.length <= 1) {
                env.logger.debug('cannot split packet');
                return false;
            }
            packet = new CulPacket();
            packet.setLength(parseInt(data[0], 16));
            if (2 * packet.getLength() + 3 !== message.length) {
                env.logger.debug('packet length missmatch');
                return false;
            }
            packet.setMessageCount(parseInt(data[1], 16));
            packet.setFlag(parseInt(data[2], 16));
            packet.setGroupId(parseInt(data[6], 16));
            packet.setRawType(data[3]);
            packet.setSource(data[4]);
            packet.setDest(data[5]);
            packet.setRawPayload(data[7]);
            if (this.baseAddress === packet.getDest()) {
                packet.setForMe(true);
            } else {
                packet.setForMe(false);
            }
            packet.setCommand(this.decodeCmdId(data[3]));
            packet.setStatus('incomming');
            packet.rssi = rssi;
            return packet;
        };

        MaxDriver.prototype.sendMsg = function (cmdId, src, dest, payload, groupId, flags, deviceType) {
            var data, length, packet, temp;
            packet = new CulPacket();
            packet.setCommand(cmdId);
            packet.setSource(src);
            packet.setDest(dest);
            packet.setRawPayload(payload);
            packet.setGroupId(groupId);
            packet.setFlag(flags);
            packet.setMessageCount(this.msgCount + 1);
            packet.setRawType(deviceType);
            temp = Sprintf('%02x', packet.getMessageCount());
            data = temp + flags + cmdId + src + dest + groupId + payload;
            length = data.length / 2;
            length = Sprintf('%02x', length);
            packet.setRawPacket(length + data);
            return new Promise((function (_this) {
                return function (resolve, reject) {
                    packet.resolve = resolve;
                    packet.reject = reject;
                    return _this.comLayer.addPacketToTransportQueue(packet);
                };
            })(this));
        };

        MaxDriver.prototype.getCredits = function () {
            return new Promise((function (_this) {
                return function (resolve, reject) {
                    var packet = new CulPacket();
                    packet.resolve = resolve;
                    packet.reject = reject;
                    packet.getCredits = true;
                    return _this.comLayer.addPacketToTransportQueue(packet);
                };
            })(this));
        };

        MaxDriver.prototype.generateTimePayload = function () {
            var now, payload, prep;
            now = Moment();
            prep = {
                sec: now.seconds(),
                min: now.minutes(),
                hour: now.hours(),
                day: now.date(),
                month: now.month() + 1,
                year: now.diff('2000-01-01', 'years')
            };
            prep.compressedOne = prep.min | ((prep.month & 0x0C) << 4);
            prep.compressedTwo = prep.sec | ((prep.month & 0x03) << 6);
            payload = Sprintf('%02x', prep.year) + Sprintf('%02x', prep.day) + Sprintf('%02x', prep.hour) + Sprintf('%02x', prep.compressedOne) + Sprintf('%02x', prep.compressedTwo);
            return payload;
        };

        MaxDriver.prototype.sendTimeInformation = function (dest, deviceType) {
            var payload;
            payload = this.generateTimePayload();
            return this.sendMsg('03', this.baseAddress, dest, payload, '00', '04', deviceType || '');
        };

        MaxDriver.prototype.sendSetDisplayActualTemperature = function (dest, isDisplay) {
            return this.sendMsg('82', this.baseAddress, dest, isDisplay ? '04' : '00', '00', '04', 3);
        };

        MaxDriver.prototype.sendConfig = function (dest, comfortTemperature, ecoTemperature, minimumTemperature, maximumTemperature, offset, windowOpenTime, windowOpenTemperature, deviceType) {
            var comfortTemperatureValue, ecoTemperatureValue, maximumTemperaturenValue, minimumTemperatureValue, offsetValue, payload, windowOpenTempValue, windowOpenTimeValue;
            comfortTemperatureValue = Sprintf('%02x', comfortTemperature * 2);
            ecoTemperatureValue = Sprintf('%02x', ecoTemperature * 2);
            minimumTemperatureValue = Sprintf('%02x', minimumTemperature * 2);
            maximumTemperaturenValue = Sprintf('%02x', maximumTemperature * 2);
            offsetValue = Sprintf('%02x', (offset + 3.5) * 2);
            windowOpenTempValue = Sprintf('%02x', windowOpenTemperature * 2);
            windowOpenTimeValue = Sprintf('%02x', Math.ceil(windowOpenTime / 5));
            payload = comfortTemperatureValue + ecoTemperatureValue + maximumTemperaturenValue + minimumTemperatureValue + offsetValue + windowOpenTempValue + windowOpenTimeValue;
            this.sendMsg('11', this.baseAddress, dest, payload, '00', '00', deviceType);
            return Promise.resolve(true);
        };

        MaxDriver.prototype.sendDesiredTemperature = function (dest, temperature, mode, groupId, deviceType) {
            var modeBin, payloadBinary, payloadHex, temperatureBinary;
            mode = parseInt(mode, 10);
            modeBin = (function () {
                switch (mode) {
                    case 0: // auto
                        return '00';
                    case 1: // manual
                        return '01';
                    case 3: // boost
                        return '11';
                    default:
                        return '00';
                }
            })();
            if (temperature <= 4.5) {
                temperature = 4.5;
            }
            if (temperature >= 30.5) {
                temperature = 30.5;
            }
            if (mode === 0 && (typeof temperature === 'undefined' || temperature === null)) {
                payloadHex = '00';
            } else {
                temperature = (temperature * 2).toString(2);
                temperatureBinary = ('000000' + temperature).substr(-6);
                payloadBinary = modeBin + temperatureBinary;
                payloadHex = Sprintf('%02x', parseInt(payloadBinary, 2));
            }
            if (groupId === '00') {
                return this.sendMsg('40', this.baseAddress, dest, payloadHex, '00', '00', deviceType);
            } else {
                return this.sendMsg('40', this.baseAddress, dest, payloadHex, groupId, '04', deviceType);
            }
        };

        var duration = {
            60: 7,
            30: 6,
            25: 5,
            20: 4,
            15: 3,
            10: 2,
            5: 1,
            0: 0
        };

        MaxDriver.prototype.sendConfigValve = function (dest, boostDuration, boostValvePosition, decalcificationDay, decalcificationHour, maxValveSetting, valveOffset, groupId, deviceType) {
            boostValvePosition = parseInt(boostValvePosition, 10);
            if (boostValvePosition > 100) boostValvePosition = 100;
            if (boostValvePosition < 0) boostValvePosition = 0;
            boostDuration = parseInt(boostDuration, 10);
            if (boostDuration < 0) boostDuration = 0;
            if (boostDuration > 60) boostDuration = 60;

            for (var i in duration) {
                if (boostDuration <= i) {
                    boostDuration = duration[i];
                    break;
                }
            }
            decalcificationDay = parseInt(decalcificationDay, 10);
            if (decalcificationDay < 0) decalcificationDay = 0;
            if (decalcificationDay > 6) decalcificationDay = 0;
            decalcificationHour = parseInt(decalcificationHour, 10);
            if (decalcificationHour < 0) decalcificationHour = 0;
            if (decalcificationHour > 23) decalcificationHour = 0;

            maxValveSetting = parseInt(maxValveSetting, 10);
            if (maxValveSetting > 100) maxValveSetting = 100;
            if (maxValveSetting < 0) maxValveSetting = 0;

            valveOffset = parseInt(valveOffset, 10);
            if (valveOffset > 100) valveOffset = 100;
            if (valveOffset < 0) valveOffset = 0;

            var boost  = boostDuration << 5 | Math.round(boostValvePosition / 5);
            var decalc = decalcificationDay << 5 | decalcificationHour;
            boost  = boost & 0xFF;
            decalc = decalc & 0xFF;
            maxValveSetting = Math.floor(maxValveSetting * 255 / 100);
            valveOffset     = Math.floor(valveOffset * 255 / 100);
            boost = boost.toString(16);
            if (boost.length < 2) boost = '0' + boost;

            maxValveSetting = maxValveSetting.toString(16);
            if (maxValveSetting.length < 2) maxValveSetting = '0' + maxValveSetting;

            valveOffset = valveOffset.toString(16);
            if (valveOffset.length < 2) valveOffset = '0' + valveOffset;

            decalc = decalc.toString(16);
            if (decalc.length < 2) decalc = '0' + decalc;
            var payloadHex = boost + decalc + maxValveSetting + valveOffset;
            groupId = groupId.toString(16);
            if (groupId.length < 2) groupId = '0' + groupId;
            if (groupId === '00') {
                return this.sendMsg('12', this.baseAddress, dest, payloadHex, '00', '00', deviceType);
            } else {
                return this.sendMsg('12', this.baseAddress, dest, payloadHex, groupId, '04', deviceType);
            }
        };

        MaxDriver.prototype.parseTemperature = function (temperature) {
            if (temperature === 'on') {
                return 30.5;
            } else if (temperature === 'off') {
                return 4.5;
            } else {
                return temperature;
            }
        };

        MaxDriver.prototype.PairPing = function (packet) {
            var payloadBuffer, payloadParser, temp;
            env.logger.debug('handling PairPing packet');
            if (this.pairModeEnabled) {
                payloadBuffer = new Buffer(packet.getRawPayload(), 'hex');
                payloadParser = new BinaryParser().uint8('firmware').uint8('type').uint8('test');

                temp = payloadParser.parse(payloadBuffer);

                packet.setDecodedPayload(temp);

                this.emit('PairDevice', {src: packet.getSource(), type: parseInt(temp.type, 10), raw: packet.getRawPayload(), rssi: packet.rssi});

                if (packet.getDest() !== "000000" && packet.getForMe() !== true) {
                    env.logger.debug("handled PairPing packet is not for us");
                } else if (packet.getForMe()) {
                    env.logger.debug("beginn repairing with device " + (packet.getSource()));
                    return this.sendMsg("01", this.baseAddress, packet.getSource(), '00', '00', '00', '');
                } else if (packet.getDest() === "000000") {
                    env.logger.debug("beginn pairing of a new device with deviceId " + (packet.getSource()));
                    return this.sendMsg("01", this.baseAddress, packet.getSource(), '00', '00', '00', '');
                }
            } else {
                return env.logger.debug(', but pairing is disabled so ignore');
            }
        };

        MaxDriver.prototype.Ack = function (packet) {
            var payloadBuffer, payloadParser, temp;
            payloadBuffer = new Buffer(packet.getRawPayload(), 'hex');
            payloadParser = new BinaryParser().uint8('state');
            temp = payloadParser.parse(payloadBuffer);
            packet.setDecodedPayload(temp.state);
            if (packet.getDecodedPayload() === 1) {
                env.logger.debug('got OK-ACK Packet from ' + (packet.getSource()));
                return this.comLayer.ackPacket();
            } else {
                return env.logger.debug('got ACK Error (Invalid command/argument) from ' + (packet.getSource()) + ' with payload ' + (packet.getRawPayload()));
            }
        };

        MaxDriver.prototype.ShutterContactState = function (packet) {
            var rawBitData, shutterContactState;
            rawBitData = new BitSet('0x' + packet.getRawPayload());
            shutterContactState = {
                src: packet.getSource(),
                isOpen: rawBitData.get(1),
                rfError: rawBitData.get(6),
                batteryLow: rawBitData.get(7),
                rssi: packet.rssi
            };
            env.logger.debug('got data from shutter contact ' + (packet.getSource()) + ' ' + (rawBitData.toString()));
            return this.emit('ShutterContactStateReceived', shutterContactState);
        };

        MaxDriver.prototype.WallThermostatState = function (packet) {
            env.logger.debug("got data from wallthermostat state " + packet.getSource() + " with payload " + packet.getRawPayload());
            //18002A00E8
            //18002A00E6
            //18002200E7
            rawPayload = packet.getRawPayload()
      
            if( rawPayload.length >= 10)
              rawPayloadBuffer = new Buffer(rawPayload, 'hex')
      
              payloadParser = new BinaryParser().uint8('bits').uint8('displaymode').uint8('desiredRaw').uint8('null1').uint8('heaterTemperature')
      
              rawData = payloadParser.parse(rawPayloadBuffer)
      
              rawBitData = new BitSet(rawData.bits);
      
              WallthermostatState = {
                src : packet.getSource(),
                mode : rawBitData.slice(0,1).toString(16),
                desiredTemperature : rawData.desiredRaw / 2.0,
                measuredTemperature : rawData.heaterTemperature / 10.0,
                dstSetting : rawBitData.get(3),
                langateway : rawBitData.get(4),
                panel : rawBitData.get(5),
                rferror : rawBitData.get(6),
                batterylow : rawBitData.get(7),
              }
              return this.emit('WallThermostatStateRecieved',WallthermostatState);  
        };

        MaxDriver.prototype.WallThermostatControl = function (packet) {
            rawBitData = new BitSet('0x'+packet.getRawPayload())
            desiredRaw = '0x'+(packet.getRawPayload().substr(0,2))
            measuredRaw = '0x'+(packet.getRawPayload().substr(2,2))
            desired = (desiredRaw & 0x7F) / 2.0
            measured = ((((desiredRaw & 0x80)*1)<<1) | (measuredRaw)*1) / 10.0

            env.logger.debug("got data from wallthermostat " + packet.getSource() + " desired temp: " + desired + " - measured temp: "+ measured );

            WallThermostatControl =
            {
                src : packet.getSource(),
                desired : desired,
                measured : measured,
            };
            return this.emit('WallThermostatControlRecieved',WallThermostatControl);
        };

        MaxDriver.prototype.PushButtonState = function (packet) {
            var pushButtonState, rawBitData;
            rawBitData = new BitSet('0x' + packet.getRawPayload());
            pushButtonState = {
                src: packet.getSource(),
                pressed: rawBitData.get(0),
                rfError: rawBitData.get(6),
                batteryLow: rawBitData.get(7),
                rssi: packet.rssi
            };
            env.logger.debug('got data from push button ' + (packet.getSource()) + " " + (rawBitData.toString()));
            return this.emit('PushButtonStateReceived', pushButtonState);
        };

        MaxDriver.prototype.ThermostatState = function (packet) {
            var calculatedMeasuredTemperature, payloadParser, rawBitData, rawData, rawMode, rawPayload, rawPayloadBuffer, thermostatState, timeData, untilString;
            env.logger.debug("got data from heatingelement " + (packet.getSource()) + " with payload " + (packet.getRawPayload()));
            rawPayload = packet.getRawPayload();
            if (rawPayload.length >= 10) {
                rawPayloadBuffer = new Buffer(rawPayload, 'hex');
                if (rawPayload.length === 10) {
                    payloadParser = new BinaryParser().uint8('bits').uint8('valvePosition').uint8('desiredTemp').uint8('untilOne').uint8('untilTwo');
                } else {
                    payloadParser = new BinaryParser().uint8('bits').uint8('valvePosition').uint8('desiredTemp').uint8('untilOne').uint8('untilTwo').uint8('untilThree');
                }
                rawData = payloadParser.parse(rawPayloadBuffer);
                rawBitData = new BitSet(rawData.bits);
                rawMode = rawBitData.slice(0, 1).toString(16);
                if (rawData.untilTwo && rawMode[0] !== 2) {
                    calculatedMeasuredTemperature = (((rawData.untilOne & 0x01) << 8) + rawData.untilTwo) / 10;
                } else {
                    calculatedMeasuredTemperature = 0;
                }
                if (calculatedMeasuredTemperature !== 0 && calculatedMeasuredTemperature < 1) {
                    calculatedMeasuredTemperature = 0;
                }
                untilString = '';
                if (rawData.untilThree && rawMode[0] === 2) {
                    timeData = ParseDateTime(rawData.untilOne, rawData.untilTwo, rawData.untilThree);
                    untilString = timeData.dateString;
                }
                thermostatState = {
                    src: packet.getSource(),
                    mode: rawMode,
                    desiredTemperature: (rawData.desiredTemp & 0x7F) / 2.0,
                    valvePosition: rawData.valvePosition,
                    measuredTemperature: calculatedMeasuredTemperature,
                    dstSetting: rawBitData.get(3),
                    lanGateway: rawBitData.get(4),
                    panel: rawBitData.get(5),
                    rfError: rawBitData.get(6),
                    batteryLow: rawBitData.get(7),
                    untilString: untilString,
                    rssi: packet.rssi
                };
                return this.emit('ThermostatStateReceived', thermostatState);
            } else {
                return env.logger.debug("payload to short ?");
            }
        };

        MaxDriver.prototype.TimeInformation = function (packet) {
            env.logger.debug('got time information request from device ' + (packet.getSource()));
            return this.emit('deviceRequestTimeInformation', packet.getSource());
        };

        MaxDriver.prototype.ParseDateTime = function (byteOne, byteTwo, byteThree) {
            var timeData;
            timeData = {
                day: byteOne & 0x1F,
                month: ((byteTwo & 0xE0) >> 4) | (byteThree >> 7),
                year: byteTwo & 0x3F,
                time: byteThree & 0x3F,
                dateString: ''
            };
            if (timeData.time % 2) {
                timeData.time = parseInt(time / 2) + ':30';
            } else {
                timeData.time = parseInt(time / 2) + ':00';
            }
            timeData.dateString = timeData.day + '.' + timeData.month + '.' + timeData.year + ' ' + timeData.time;
            return timeData;
        };

        return MaxDriver;

    })(EventEmitter);
};
