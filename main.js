/* jshint -W097 */// jshint strict:false
/*jslint node: true */

'use strict';
// you have to require the utils module and call adapter function
const utils = require('@iobroker/adapter-core'); // Get common adapter utils

let max;
const objects = {};
let SerialPort;
const devices = {};
const timers = {};
let limitOverflow = null;
let credits = 0;
let connected = false;
let creditsTimer;
let thermostatTimer;
var pairingTimer;

try {
    SerialPort = require('serialport');
} catch (err) {
    console.error('Cannot load serialport module');
}

const adapter = utils.Adapter('maxcul');

adapter.on('stateChange', (id, state) => {
    if (!id || !state || state.ack) return;
    if (!objects[id] || !objects[id].native) {
        adapter.log.warn('Unknown ID: ' + id);
        return;
    }
    if (!objects[id].common.write) {
        adapter.log.warn('id "' + id + '" is readonly');
        return;
    }
    let type;
    let dayType;
    let channel = id.split('.');
    const name = channel.pop();
    if (channel.length === 5) {
    type = channel[channel.length - 2];
    dayType = channel[channel.length - 1];
    } else {
    type = channel[channel.length - 1];
    }
    if (type === 'config' ||
        type === 'displayConfig' ||
        type === 'valveConfig') channel.pop();

    if (type === 'weekProfile') {
        if (/setPointUntilTime/.test(name) && state.val !== formatTimeString(state.val)) adapter.setForeignState(id , formatTimeString(state.val));
        if (!/send_/.test(name) || state.val === false) return;
        channel.pop();
        channel.pop();
    }

    if (type === 'vacationConfig') {
        if (/untilDate/.test(name) && state.val !== formatUntilDate(state.val)) adapter.setForeignState(id, formatUntilDate(state.val));
        return;
    }

    channel = channel.join('.');

    if (name === 'display') {
        if (!max) return;
        if (state.val === 'false' || state.val === '0') state.val = false;
        adapter.log.debug('sendSetDisplayActualTemperature(' + channel + ', ' + state.val + ')');
        max.sendSetDisplayActualTemperature(
            objects[channel].native.src,
            state.val);
    } 
    if (name === 'enablePairingMode') {
        if(!max) return;
        if(state.val === 'false' || state.val === '0') state.val = false;
        adapter.log.debug('Set Pairmode to ' + state.val);
        max.pairModeEnabled = state.val;
        if(max.pairModeEnabled === true)
        {
            pairingTimer = setTimeout(function () {
                max.pairModeEnabled = false;
                adapter.setState('info.enablePairingMode',false,true);
            }, 30000);
        } else {
            if(pairingTimer !== undefined)
                clearTimeout(pairingTimer);
            adapter.setState('info.enablePairingMode',false,true);
        }
    } else {
        if (timers[channel]) clearTimeout(timers[channel].timer);

        timers[channel] = timers[channel] || {};
        timers[channel][name] = state.val;
        timers[channel].timer = setTimeout(ch => sendInfo(ch), 1000, channel);
    }
});

adapter.on('unload', callback => {
    if (adapter && adapter.setState) adapter.setState('info.connection', false, true);
    if (max) max.disconnect();
    callback();
});

adapter.on('ready', main);

adapter.on('message', obj => {
    if (obj) {
        switch (obj.command) {
            case 'listUart':
                if (obj.callback) {
                    if (SerialPort) {
                        // read all found serial ports
                        SerialPort.list((err, ports) => {
                            adapter.log.info('List of port: ' + JSON.stringify(ports));
                            adapter.sendTo(obj.from, obj.command, ports, obj.callback);
                        });
                    } else {
                        adapter.log.warn('Module serialport is not available');
                        adapter.sendTo(obj.from, obj.command, [{comName: 'Not available'}], obj.callback);
                    }
                }

                break;
        }
    }
});

function checkPort(callback) {
    if (!adapter.config.serialport) {
        if (callback) callback('Port is not selected');
        return;
    }
    let sPort;
    try {
        sPort = new SerialPort(adapter.config.serialport || '/dev/ttyACM0', {
            baudRate: parseInt(adapter.config.baudrate, 10) || 9600,
            autoOpen: false
        });
        sPort.on('error', err => {
            if (sPort.isOpen) sPort.close();
            if (callback) callback(err);
            callback = null;
        });

        sPort.open(err => {
            if (sPort.isOpen) sPort.close();

            if (callback) callback(err);
            callback = null;
        });
    } catch (e) {
        adapter.log.error('Cannot open port: ' + e);
        try {
            if (sPort.isOpen) sPort.close();
        } catch (ee) {

        }
        if (callback) callback(e);
    }
}

function sendConfig(channel) {
    if (!max) return;
    max.sendConfig(
        objects[channel].native.src,
        timers[channel].comfortTemperature,
        timers[channel].ecoTemperature,
        timers[channel].minimumTemperature,
        timers[channel].maximumTemperature,
        timers[channel].offset,
        timers[channel].windowOpenTime,
        timers[channel].windowOpenTemperature,
        objects[channel].native.type);

    delete timers[channel].comfortTemperature;
    delete timers[channel].ecoTemperature;
    delete timers[channel].minimumTemperature;
    delete timers[channel].maximumTemperature;
    delete timers[channel].windowOpenTime;
    delete timers[channel].offset;
    delete timers[channel].windowOpenTemperature;
}

function sendValveConfig(channel) {
    if (!max) return;
    max.sendConfigValve(
        objects[channel].native.src,
        timers[channel].boostDuration,
        timers[channel].boostValvePosition,
        timers[channel].decalcificationDay,
        timers[channel].decalcificationHour,
        timers[channel].maxValveSetting,
        timers[channel].valveOffset,
        '00',
        objects[channel].native.type);

    delete timers[channel].boostDuration;
    delete timers[channel].boostValvePosition;
    delete timers[channel].decalcificationDay;
    delete timers[channel].decalcificationHour;
    delete timers[channel].maxValveSetting;
    delete timers[channel].valveOffset;
}

function sendTemperature(channel) {
    if (!max) return;
    adapter.log.debug('sendTemperature(' + channel + ', ' + timers[channel].desiredTemperature + ', ' + timers[channel].mode + ')');
    max.sendDesiredTemperature(
        objects[channel].native.src,
        timers[channel].desiredTemperature,
        timers[channel].mode,
        '00',
        objects[channel].native.type);
    delete timers[channel].mode;
    delete timers[channel].desiredTemperature;
}

function sendDayProfile(channel) {
    if (!max) return;

    var daySendArray = Object.keys(timers[channel]);
    var daySend = daySendArray.filter(function(item){
        return /^send_/.test(item);
    });
    var weekDay = daySend[0].slice(5,6);
    var dayType = daySend[0].slice(4);
    var sendId =  channel + '.weekProfile.' + dayType +'.';
    adapter.setState(sendId + daySend, false, true);

    max.sendProfileDay(
        objects[channel].native.src,
        weekDay,
        timers[channel]._01_setPointTemp,
        timers[channel]._01_setPointUntilTime,
        timers[channel]._02_setPointTemp,
        timers[channel]._02_setPointUntilTime,
        timers[channel]._03_setPointTemp,
        timers[channel]._03_setPointUntilTime,
        timers[channel]._04_setPointTemp,
        timers[channel]._04_setPointUntilTime,
        timers[channel]._05_setPointTemp,
        timers[channel]._05_setPointUntilTime,
        timers[channel]._06_setPointTemp,
        timers[channel]._06_setPointUntilTime,
        timers[channel]._07_setPointTemp,
        timers[channel]._07_setPointUntilTime,
        '00',
        objects[channel].native.type);

    max.sendProfileDay2(
        objects[channel].native.src,
        weekDay,
        timers[channel]._08_setPointTemp,
        timers[channel]._08_setPointUntilTime,
        timers[channel]._09_setPointTemp,
        timers[channel]._09_setPointUntilTime,
        timers[channel]._10_setPointTemp,
        timers[channel]._10_setPointUntilTime,
        timers[channel]._11_setPointTemp,
        timers[channel]._11_setPointUntilTime,
        timers[channel]._12_setPointTemp,
        timers[channel]._12_setPointUntilTime,
        timers[channel]._13_setPointTemp,
        timers[channel]._13_setPointUntilTime,
        '00',
        objects[channel].native.type);

    adapter.setState(sendId + '_01_setPointTemp', timers[channel]._01_setPointTemp, true);
    adapter.setState(sendId + '_01_setPointUntilTime', timers[channel]._01_setPointUntilTime, true);
    adapter.setState(sendId + '_02_setPointTemp', timers[channel]._02_setPointTemp, true);
    adapter.setState(sendId + '_02_setPointUntilTime', timers[channel]._02_setPointUntilTime, true);
    adapter.setState(sendId + '_03_setPointTemp', timers[channel]._03_setPointTemp, true);
    adapter.setState(sendId + '_03_setPointUntilTime', timers[channel]._03_setPointUntilTime, true);
    adapter.setState(sendId + '_04_setPointTemp', timers[channel]._04_setPointTemp, true);
    adapter.setState(sendId + '_04_setPointUntilTime', timers[channel]._04_setPointUntilTime, true);
    adapter.setState(sendId + '_05_setPointTemp', timers[channel]._05_setPointTemp, true);
    adapter.setState(sendId + '_05_setPointUntilTime', timers[channel]._05_setPointUntilTime, true);
    adapter.setState(sendId + '_06_setPointTemp', timers[channel]._06_setPointTemp, true);
    adapter.setState(sendId + '_06_setPointUntilTime', timers[channel]._06_setPointUntilTime, true);
    adapter.setState(sendId + '_07_setPointTemp', timers[channel]._07_setPointTemp, true);
    adapter.setState(sendId + '_07_setPointUntilTime', timers[channel]._07_setPointUntilTime, true);
    adapter.setState(sendId + '_08_setPointTemp', timers[channel]._08_setPointTemp, true);
    adapter.setState(sendId + '_08_setPointUntilTime', timers[channel]._08_setPointUntilTime, true);
    adapter.setState(sendId + '_09_setPointTemp', timers[channel]._09_setPointTemp, true);
    adapter.setState(sendId + '_09_setPointUntilTime', timers[channel]._09_setPointUntilTime, true);
    adapter.setState(sendId + '_10_setPointTemp', timers[channel]._10_setPointTemp, true);
    adapter.setState(sendId + '_10_setPointUntilTime', timers[channel]._10_setPointUntilTime, true);
    adapter.setState(sendId + '_11_setPointTemp', timers[channel]._11_setPointTemp, true);
    adapter.setState(sendId + '_11_setPointUntilTime', timers[channel]._11_setPointUntilTime, true);
    adapter.setState(sendId + '_12_setPointTemp', timers[channel]._12_setPointTemp, true);
    adapter.setState(sendId + '_12_setPointUntilTime', timers[channel]._12_setPointUntilTime, true);
    adapter.setState(sendId + '_13_setPointTemp', timers[channel]._13_setPointTemp, true);
    adapter.setState(sendId + '_14_setPointUntilTime', timers[channel]._13_setPointUntilTime, true);

    delete timers[channel]._01_setPointTemp;
    delete timers[channel]._01_setPointUntilTime;
    delete timers[channel]._02_setPointTemp;
    delete timers[channel]._02_setPointUntilTime;
    delete timers[channel]._03_setPointTemp;
    delete timers[channel]._03_setPointUntilTime;
    delete timers[channel]._04_setPointTemp;
    delete timers[channel]._04_setPointUntilTime;
    delete timers[channel]._05_setPointTemp;
    delete timers[channel]._05_setPointUntilTime;
    delete timers[channel]._06_setPointTemp;
    delete timers[channel]._06_setPointUntilTime;
    delete timers[channel]._07_setPointTemp;
    delete timers[channel]._07_setPointUntilTime;

    delete timers[channel]._08_setPointTemp;
    delete timers[channel]._08_setPointUntilTime;
    delete timers[channel]._09_setPointTemp;
    delete timers[channel]._09_setPointUntilTime;
    delete timers[channel]._10_setPointTemp;
    delete timers[channel]._10_setPointUntilTime;
    delete timers[channel]._11_setPointTemp;
    delete timers[channel]._11_setPointUntilTime;
    delete timers[channel]._12_setPointTemp;
    delete timers[channel]._12_setPointUntilTime;
    delete timers[channel]._13_setPointTemp;
    delete timers[channel]._13_setPointUntilTime;

    delete timers[channel][daySend];
}

function sendVacationConfig(channel) {
    if (!max) return;

    max.sendVacation(
        objects[channel].native.src,
        timers[channel].vacationTemperature,
        timers[channel].mode,
        timers[channel].untilDate,
        '00',
        objects[channel].native.type);
    delete timers[channel].mode;
    delete timers[channel].vacationTemperature;
    delete timers[channel].untilDate;
}

function sendInfo(channel) {
    if (!timers[channel]) return;

    if (credits < 220) {
        adapter.log.warn('Not enough credits(' + credits + '). Wait for more...');
        timers[channel].timer = setTimeout(() => sendInfo(channel), 5000);
        return;
    }

    timers[channel].timer = null;

    if ((timers[channel].mode                !== undefined ||
        timers[channel].desiredTemperature   !== undefined) && timers[channel].mode !==2) {
        timers[channel].requestRunning = false;
        timers[channel].requestRunningMode = false;

        let count1 = 0;
        if (timers[channel].mode === undefined) {
            count1++;
            adapter.getForeignState(channel + '.mode', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 0;
                }
                timers[channel].mode = state.val;
                if (!--count1) sendTemperature(channel);
            });
        }
        if (timers[channel].desiredTemperature === undefined) {
            count1++;
            adapter.getForeignState(channel + '.desiredTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 21;
                }
                timers[channel].desiredTemperature = state.val;
                if (!--count1) sendTemperature(channel);
            });
        }
        if (!count1) sendTemperature(channel);
    }
    // comfortTemperature, ecoTemperature, minimumTemperature, maximumTemperature, offset, windowOpenTime, windowOpenTemperature
    if (timers[channel].comfortTemperature      !== undefined ||
        timers[channel].ecoTemperature          !== undefined ||
        timers[channel].minimumTemperature      !== undefined ||
        timers[channel].maximumTemperature      !== undefined ||
        timers[channel].offset                  !== undefined ||
        timers[channel].windowOpenTime          !== undefined ||
        timers[channel].windowOpenTemperature   !== undefined) {
        let count2 = 0;
        if (timers[channel].comfortTemperature === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.comfortTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 21;
                }
                timers[channel].comfortTemperature = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].ecoTemperature === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.ecoTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 17;
                }
                timers[channel].ecoTemperature = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].minimumTemperature === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.minimumTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 4.5;
                }
                timers[channel].minimumTemperature = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].maximumTemperature === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.maximumTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 30.5;
                }
                timers[channel].maximumTemperature = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].offset === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.offset', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 0;
                }
                timers[channel].offset = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].windowOpenTime === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.windowOpenTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 10;
                }
                timers[channel].windowOpenTime = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].windowOpenTemperature === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.windowOpenTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 12;
                }
                timers[channel].windowOpenTemperature = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (!count2) sendConfig(channel);
    }

    // boostDuration, boostValvePosition, decalcificationDay, decalcificationHour, maxValveSetting, valveOffset
    if (timers[channel].boostDuration         !== undefined ||
        timers[channel].boostValvePosition    !== undefined ||
        timers[channel].decalcificationDay    !== undefined ||
        timers[channel].decalcificationHour   !== undefined ||
        timers[channel].maxValveSetting       !== undefined ||
        timers[channel].valveOffset           !== undefined) {

        let count3 = 0;
        if (timers[channel].boostDuration === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.boostDuration', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 5;
                }
                timers[channel].boostDuration = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (timers[channel].boostValvePosition === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.boostValvePosition', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 100;
                }
                timers[channel].boostValvePosition = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (timers[channel].decalcificationDay === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.decalcificationDay', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 0;
                }
                timers[channel].decalcificationDay = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (timers[channel].decalcificationHour === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.decalcificationHour', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 12;
                }
                timers[channel].decalcificationHour = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (timers[channel].maxValveSetting === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.maxValveSetting', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 100;
                }
                timers[channel].maxValveSetting = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (timers[channel].valveOffset === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.valveOffset', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 0;
                }
                timers[channel].valveOffset = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (!count3) sendValveConfig(channel);
    }

    // weekProfile

    if ((timers[channel].send_0_saturday   !== undefined && timers[channel].send_0_saturday === true) ||
        (timers[channel].send_1_sunday     !== undefined && timers[channel].send_1_sunday === true) ||
        (timers[channel].send_2_monday     !== undefined && timers[channel].send_2_monday == true) ||
        (timers[channel].send_3_tuesday    !== undefined && timers[channel].send_3_tuesday === true) ||
        (timers[channel].send_4_wednesday  !== undefined && timers[channel].send_4_wednesday === true) ||
        (timers[channel].send_5_thursday   !== undefined && timers[channel].send_5_thursday === true) ||
        (timers[channel].send_6_friday     !== undefined && timers[channel].send_6_friday === true)) {

        let daySendArray = Object.keys(timers[channel]);
        let daySend = daySendArray.filter(function(item){
            return /^send_/.test(item);
        });
        let weekDay = daySend[0].substring(4);
        let count4 = 0;
        if (timers[channel]._01_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._01_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._01_setPointTemp = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._01_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._01_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._01_setPointUntilTime = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._02_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._02_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._02_setPointTemp = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._02_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._02_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._02_setPointUntilTime = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._03_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._03_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._03_setPointTemp = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._03_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._03_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._03_setPointUntilTime = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._04_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._04_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._04_setPointTemp = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._04_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._04_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._04_setPointUntilTime = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._05_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._05_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._05_setPointTemp = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._05_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._05_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._05_setPointUntilTime = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._06_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._06_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._06_setPointTemp = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._06_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._06_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._06_setPointUntilTime = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._07_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._07_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._07_setPointTemp = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._07_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._07_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._07_setPointUntilTime = state.val;
                if(!--count4) sendDayProfile(channel);
            });
        }
        if (timers[channel]._08_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._08_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._08_setPointTemp = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (timers[channel]._08_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._08_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._08_setPointUntilTime = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (timers[channel]._09_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._09_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._09_setPointTemp = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (timers[channel]._09_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._09_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._09_setPointUntilTime = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (timers[channel]._10_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._10_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._10_setPointTemp = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (timers[channel]._10_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._10_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._10_setPointUntilTime = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (timers[channel]._11_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._11_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._11_setPointTemp = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (timers[channel]._11_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._11_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._11_setPointUntilTime = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (timers[channel]._12_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._12_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._12_setPointTemp = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (timers[channel]._12_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._12_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._12_setPointUntilTime = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (timers[channel]._13_setPointTemp === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._13_setPointTemp', (err, state) => {
                if (!state || state.val === null || state.val === undefined || state.val == 0) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._13_setPointTemp = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (timers[channel]._13_setPointUntilTime === undefined) {
            count4++;
            adapter.getForeignState(channel + '.weekProfile.' + weekDay + '._13_setPointUntilTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel]._13_setPointUntilTime = state.val;
                if(!--count4) {
                    sendDayProfile(channel);
                }
            });
        }
        if (!count4) sendDayProfile(channel);
    }

    // vacationTemperature, untilDate
    if (timers[channel].mode !== undefined && timers[channel].mode === 2) {
        timers[channel].requestRunning = false;
        timers[channel].requestRunningMode = false;

        let count5 = 0;
        if (timers[channel].vacationTemperature === undefined) {
            count5++;
            adapter.getForeignState(channel + '.vacationConfig.vacationTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 17;
                }
                timers[channel].vacationTemperature = state.val;
                if (!--count5) sendVacationConfig(channel);
            });
        }
        if (timers[channel].untilDate === undefined) {
            count5++;
            adapter.getForeignState(channel + '.vacationConfig.untilDate', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = '';
                }
                timers[channel].untilDate = state.val;
                if (!--count5) sendVacationConfig(channel);
            });
        }
        if (!count5) sendVacationConfig(channel);
    }
}

const tasks = [];

function processTasks() {
    if (tasks.length) {
        const task = tasks.shift();
        if (task.type === 'state') {
            adapter.setForeignState(task.id, task.val, true, () => setTimeout(processTasks, 0));
        } else if (task.type === 'object') {
            adapter.getForeignObject(task.id, (err, obj) => {
                if (!obj) {
                    objects[task.id] = task.obj;
                    adapter.setForeignObject(task.id, task.obj, (err, res) => {
                        adapter.log.info('object ' + adapter.namespace + '.' + task.id + ' created');
                        setTimeout(processTasks, 0);
                    });
                } else {
                    let changed = false;
                    if (JSON.stringify(obj.native) !== JSON.stringify(task.obj.native)) {
                        obj.native = task.obj.native;
                        changed = true;
                    }

                    if (changed) {
                        objects[obj._id] = obj;
                        adapter.setForeignObject(obj._id, obj, (err, res) => {
                            adapter.log.info('object ' + adapter.namespace + '.' + obj._id + ' created');
                            setTimeout(processTasks, 0);
                        });
                    } else {
                        setTimeout(processTasks, 0);
                    }
                }
            });
        } else {
            adapter.log.error('Unknown task: ' + task.type);
            setTimeout(processTasks, 0);
        }
    }
}

function setStates(obj) {
    const id = obj.serial;
    const isStart = !tasks.length;
    if (!devices[obj.data.src]) return;

    devices[obj.data.src].lastReceived = new Date().getTime();

    for (const state in obj.data) {
        if (!obj.data.hasOwnProperty(state)) continue;
        if (state === 'src') continue;
        if (state === 'serial') continue;
        if (obj.data[state] === undefined) continue;

        const oid  = adapter.namespace + '.' + id + '.' + state;
        const meta = objects[oid];
        let val  = obj.data[state];

        if (state === 'mode' && timers[adapter.namespace + '.' + id] && timers[adapter.namespace + '.' + id].requestRunning) {
            adapter.log.debug(id + ': Ignore mode triggered by polling: ' + val);
            continue;
        }
        if (state === 'desiredTemperature' && timers[adapter.namespace + '.' + id] && timers[adapter.namespace + '.' + id].requestRunning) {
            adapter.log.debug(id + ': Ignore desiredTemperature triggered by polling: ' + val);
            adapter.log.debug(id + ': Set initially desiredTemperature after polling: ' + timers[adapter.namespace + '.' + id].requestRunning);
            adapter.log.debug(id + ': Set initially mode after polling: ' + timers[adapter.namespace + '.' + id].requestRunningMode);
            timers[adapter.namespace + '.' + id].desiredTemperature = timers[adapter.namespace + '.' + id].requestRunning;
            timers[adapter.namespace + '.' + id].mode = timers[adapter.namespace + '.' + id].requestRunningMode;
            timers[adapter.namespace + '.' + id].requestRunning = false;
            timers[adapter.namespace + '.' + id].requestRunningMode = false;

            setTimeout(channel => sendInfo(channel), 0, adapter.namespace + '.' + id);
            continue;
        }
        if (state === 'untilDate' && val !== "") {
        adapter.log.info('Device ' + adapter.namespace + '.' + id + ' in Vacation Mode until ' + val);
        }
        if (meta) {
            if (meta.common.type === 'boolean') {
                val = val === 'true' || val === true || val === 1 || val === '1' || val === 'on';
            } else if (meta.common.type === 'number') {
                if (val === 'on'  || val === 'true'  || val === true)  val = 1;
                if (val === 'off' || val === 'false' || val === false) val = 0;
                val = parseFloat(val);
            }
        }
        if (objects[oid]) {
            tasks.push({type: 'state', id: oid, val: val});
        }
    }
    if (isStart) processTasks();
}

function syncObjects(objs) {
    const isStart = !tasks.length;
    for (let i = 0; i < objs.length; i++) {
        if (objs[i].native && objs[i].native.type && !devices[objs[i].native.src]) {
            devices[objs[i].native.src] = objs[i];
        }
        tasks.push({type: 'object', id: objs[i]._id, obj: objs[i]});
    }
    if (isStart) processTasks()
}

function formatTimeString(timeString) {
    var timeStringNum = timeString.toString().match(/\d/g);

    if (timeStringNum !== null) {
        var formattedTimeString = timeStringNum.join('');

        if (formattedTimeString.length >= 3) {
            formattedTimeString = formattedTimeString.slice(0, 4);
            var leadingZeros = formattedTimeString.match(/^0+/g);
            formattedTimeString = ((Math.round((parseInt(formattedTimeString, 10)) / 5)) * 5).toString();
            if (formattedTimeString[(formattedTimeString.length - 2)] === '6') formattedTimeString = (parseInt(formattedTimeString, 10) + 40).toString();
            if (leadingZeros !== null) formattedTimeString = leadingZeros.join('').concat(formattedTimeString);
            formattedTimeString = formattedTimeString.substring((formattedTimeString.length - 4));
        }

        if (formattedTimeString.length === 1) formattedTimeString = '0' + formattedTimeString + ':' + '00';
        if (formattedTimeString.length === 2) formattedTimeString = formattedTimeString + ':' + '00';
        if (formattedTimeString.length === 3) formattedTimeString = '0' + formattedTimeString.substr(0, 1) + ':' + formattedTimeString.substr(1);
        if (formattedTimeString.length === 4) formattedTimeString = formattedTimeString.substr(0, 2) + ':' + formattedTimeString.substr(2);
    } else formattedTimeString = '';

    if (!/[01][0-9]:[0-5][05]/.test(formattedTimeString) &&
        !/[2][0-3]:[0-5][05]/.test(formattedTimeString)  &&
        !/24:00/.test(formattedTimeString)               ||
         /00:00/.test(formattedTimeString)) formattedTimeString = '';

    return formattedTimeString;
}

function formatUntilDate(untilDateTimeString) {
    var dateTimeStringNum = untilDateTimeString.match(/\d/g);

    if (dateTimeStringNum !== null && dateTimeStringNum.length >= 12) {
        var formattedDateTimeString = dateTimeStringNum.join('');

        //little-endian order. DIN 5008 alternative. Traditional format in German
        if (untilDateTimeString.search(/\W/) === 2) {
            var formattedYearString = formattedDateTimeString.slice(4, 8);
            var formattedMonthString = formattedDateTimeString.slice(2,4);
            var formattedDayString = formattedDateTimeString.slice(0,2);
            var formattedHourString = formattedDateTimeString.slice(8,10);
            var formattedMinuteString = formattedDateTimeString.slice(10,12);
        }
        //big-endian order. ISO 8601, EN 28601 and DIN 5008. International. Compatible with widget "jqui-ctrl-input Datetime"
        else if (untilDateTimeString.search(/\W/) === 4) {
            var formattedYearString = formattedDateTimeString.slice(0, 4);
            var formattedMonthString = formattedDateTimeString.slice(4,6);
            var formattedDayString = formattedDateTimeString.slice(6,8);
            var formattedHourString = formattedDateTimeString.slice(8,10);
            var formattedMinuteString = formattedDateTimeString.slice(10,12);
        } else return '';

        formattedMinuteString = ((Math.round((parseInt(formattedMinuteString)) / 30)) * 30).toString();

        if (formattedMinuteString === '60') {
            formattedMinuteString = '00';
            formattedHourString = (parseInt(formattedHourString, 10) + 1).toString();
        }
        if (formattedHourString.length < 2) formattedHourString = '0' + formattedHourString;
        if (formattedMinuteString.length < 2) formattedMinuteString = '0' + formattedMinuteString;
        if (/[2][0][1-5][1-9]/.test(formattedYearString) &&
            (/[0][0-9]/.test(formattedMonthString) || /[1][0-2]/.test(formattedMonthString)) &&
            (/[0-2][0-9]/.test(formattedDayString) || /[3][0-1]/.test(formattedDayString)) &&
            (/[01][0-9]/.test(formattedHourString) || /[2][0-3]/.test(formattedHourString) || /24/.test(formattedHourString))) {
//            formattedDateTimeString = formattedYearString + '-' + formattedMonthString + '-' +  formattedDayString + ' ' + formattedHourString + ':' + formattedMinuteString;
            formattedDateTimeString = formattedDayString + '-' + formattedMonthString + '-' + formattedYearString + ' ' + formattedHourString + ':' + formattedMinuteString;
        } else formattedDateTimeString = '';

    } else formattedDateTimeString = '';
    return formattedDateTimeString;
}

function hex2a(hexx) {
    const hex = hexx.toString();//force conversion
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
        const s = String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        // serial is ABC1324555
        if ((s >= 'A' && s <= 'Z') || (s >= 'a' && s <= 'z') || (s >= '0' && s <= '9')) {
            str += s;
        } else {
            return '';
        }
    }
    return str;
}

function createThermostat(data, prefix) {
    //const t = {
    //    "src": "160bd0",
    //    "mode": 1,                   // <==
    //    "desiredTemperature": 30.5,  // <==
    //    "valvePosition": 100,        // <==
    //    "measuredTemperature": 22.4, // <==
    //    "dstSetting": 1,             // <==
    //    "langateway": 1,             // <==
    //    "panel": 0,                  // <==
    //    "rfError": 0,                // <==
    //    "batteryLow": 0,             // <==
    //    "untilDate": ""
    //};

    // comfortTemperature, ecoTemperature, minimumTemperature, maximumTemperature, offset, windowOpenTime, windowOpenTemperature
    prefix = prefix || '';

    if (!data.serial && data.raw) {
        data.serial = hex2a(data.raw.substring(data.raw.length - 20));
    }

    if (!data.serial) {
        data.serial = data.src.toUpperCase();
    }

    let obj = {
        _id: adapter.namespace + '.' + data.serial,
        common: {
            role: 'thermostat',
            name: prefix + 'Thermostat ' + data.serial + ' | ' + data.src
        },
        type: 'channel',
        native: data
    };
    const objs = [obj];
    obj = {
        _id: adapter.namespace + '.' + data.serial + '.mode',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' mode',
            type: 'number',
            role: 'level.mode',
            read: true,
            write: true,
            states: {
                0: 'auto weekly',
                1: 'manual',
                2: 'vacation',
                3: 'boost',
                4: 'manual eco',
                5: 'manual comfort',
                6: 'manual window'
            }
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.measuredTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' current temperature',
            type: 'number',
            read: true,
            write: false,
            role: 'value.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.desiredTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' set temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valvePosition',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' valve',
            type: 'number',
            read: true,
            write: false,
            role: 'value.valve',
            unit: '%',
            min: 0,
            max: 100
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rfError',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' error',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.reachable'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.batteryLow',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' low battery',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.battery'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    // comfortTemperature,
    // ecoTemperature,
    // minimumTemperature,
    // maximumTemperature,
    // offset,
    // windowOpenTime,
    // windowOpenTemperature
    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.comfortTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' comfort temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.ecoTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' eco temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.minimumTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' minimum temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.maximumTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' maximum temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.offset',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' offset temperature',
            type: 'number',
            read: true,
            write: true,
            min: -3.5,
            max: 3.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.windowOpenTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' window open temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.windowOpenTime',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' window open time',
            type: 'number',
            read: true,
            write: true,
            role: 'level.interval',
            unit: 'min'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rssi',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' signal strength',
            type: 'number',
            read: true,
            write: false,
            role: 'value.rssi',
            unit: 'dBm'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.boostDuration',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' boost duration',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 60,
            role: 'level.duration',
            unit: 'min'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.boostValvePosition',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' boost valve position',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 100,
            role: 'level.valve',
            unit: '%'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.decalcificationDay',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' decalcification week day',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 6,
            states: {
                0: 'Saturday',
                1: 'Sunday',
                2: 'Monday',
                3: 'Tuesday',
                4: 'Wednesday',
                5: 'Thursday',
                6: 'Friday'
            },
            role: 'level.day',
            unit: ''
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.decalcificationHour',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' decalcification hour',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 23,
            role: 'level.hour',
            unit: 'hour'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.maxValveSetting',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' max valve position',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 100,
            role: 'level.valve',
            unit: '%'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.valveOffset',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' valve offset',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 100,
            role: 'level.valve',
            unit: '%'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.vacationConfig.vacationTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' set vacation temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.vacationConfig.untilDate',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' set vacation until date (dd-MM-yyyy HH:mm)',
            type: 'string',
            read: true,
            write: true,
            role: 'until.date',
            unit: ''
        },
        type: 'state',
        native: data
    };
    objs.push(obj);


    // weekProfile

    var weekDay, setPointNumber;
    for (var n = 0; n <= 6; n++) {

        switch (n) {
            case 0:
                weekDay='saturday';
                break;
            case 1:
                weekDay='sunday';
                break;
            case 2:
                weekDay='monday';
                break;
            case 3:
                weekDay='tuesday';
                break;
            case 4:
                weekDay='wednesday';
                break;
            case 5:
                weekDay='thursday';
                break;
            case 6:
                weekDay='friday';
                break;
        }

        for (var i = 1; i <= 13; i++) {
            setPointNumber = i.toString();
            if (i <= 9) setPointNumber = '0' + setPointNumber;
            obj = {
                _id: adapter.namespace + '.' + data.serial + '.weekProfile._' + n + '_' + weekDay + '._' + setPointNumber + '_setPointTemp',
                common: {
                    name: prefix + 'Thermostat ' + data.serial + ' ' + weekDay + ' setPoint ' + setPointNumber + ' temperature',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 4.5,
                    max: 30.5,
                    role: 'weekProfile.' + weekDay,
                    unit: '°C'
                },
                type: 'state',
                native: data
            };
            objs.push(obj);

            obj = {
                _id: adapter.namespace + '.' + data.serial + '.weekProfile._' + n + '_' + weekDay + '._' + setPointNumber + '_setPointUntilTime',
                common: {
                    name: prefix + 'Thermostat ' + data.serial + ' ' + weekDay + ' setPoint ' + setPointNumber + ' until time',
                    type: 'string',
                    read: true,
                    write: true,
                    role: 'weekProfile.' + weekDay
                },
                type: 'state',
                native: data
            };
            objs.push(obj);
        }

        obj = {
            _id: adapter.namespace + '.' + data.serial + '.weekProfile._' + n + '_' + weekDay + '.send_' + n + '_' + weekDay,
            common: {
                name: prefix + 'Thermostat ' + data.serial + ' send ' + weekDay + ' Profile ',
                type: 'boolean',
                read: true,
                write: true,
                role: 'weekProfile.' + weekDay
            },
            type: 'state',
            native: data
        };
        objs.push(obj);
    }

    syncObjects(objs);
}

function createWallThermostat(data) {
    createThermostat(data, 'Wall');

    const obj = {
        _id: adapter.namespace + '.' + data.serial + '.displayConfig.display',
        common: {
            name:  'WallThermostat ' + data.serial + ' display',
            type:  'boolean',
            desc:  'Display actual temperature',
            role:  'switch',
            read:  true,
            write: true
        },
        type:  'state',
        native: data
    };
    syncObjects([obj]);
}

function createButton(data) {
    //const t = {
    //    "src": "160bd0",
    //    "isOpen": 1,                   // <==
    //    "rfError": 30.5,  // <==
    //    "batteryLow": 100
    //};

    if (!data.serial && data.raw) {
        data.serial = hex2a(data.raw.substring(data.raw.length - 20));
    }

    if (!data.serial) data.serial = data.src.toUpperCase();

    let obj = {
        _id: adapter.namespace + '.' + data.serial,
        common: {
            role: 'button',
            name: 'Push button ' + data.serial
        },
        type: 'channel',
        native: data
    };
    const objs = [obj];
    obj = {
        _id: adapter.namespace + '.' + data.serial + '.pressed',
        common: {
            name: 'Push button ' + data.serial + ' pressed',
            type: 'boolean',
            role: 'button',
            read: true,
            write: false
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rfError',
        common: {
            name: 'Push button ' + data.serial + ' error',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.reachable'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.batteryLow',
        common: {
            name: 'Push button ' + data.serial + ' low battery',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.battery'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rssi',
        common: {
            name: 'Push button ' + data.serial + ' signal strength',
            type: 'number',
            read: true,
            write: false,
            role: 'value.rssi',
            unit: 'dBm'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    syncObjects(objs);
}

function createContact(data) {
    //const t = {
    //    "src": "160bd0",
    //    "isOpen": 1,                   // <==
    //    "rfError": 30.5,  // <==
    //    "batteryLow": 100
    //};

    if (!data.serial && data.raw) {
        data.serial = hex2a(data.raw.substring(data.raw.length - 20));
    }

    if (!data.serial) data.serial = data.src.toUpperCase();

    let obj = {
        _id: adapter.namespace + '.' + data.serial,
        common: {
            role: 'indicator',
            name: 'Contact ' + data.serial
        },
        type: 'channel',
        native: data
    };
    const objs = [obj];
    obj = {
        _id: adapter.namespace + '.' + data.serial + '.isOpen',
        common: {
            name: 'Contact ' + data.serial + ' opened',
            type: 'boolean',
            role: 'button',
            read: true,
            write: false
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rfError',
        common: {
            name: 'Contact ' + data.serial + ' error',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.reachable'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.batteryLow',
        common: {
            name: 'Contact ' + data.serial + ' low battery',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.battery'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rssi',
        common: {
            name: 'Contact ' + data.serial + ' signal strength',
            type: 'number',
            read: true,
            write: false,
            role: 'value.rssi',
            unit: 'dBm'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    syncObjects(objs);
}

function pollDevice(id) {
    const src = objects[id].native.src;
    if (credits < 400 || !devices[src]) {
        adapter.log.info('Not enough credit for Polling(min.400): ' + credits);
        return;
    }
    devices[src].lastReceived = new Date().getTime();
    adapter.getForeignState(id + '.mode', (err, state) => {
        adapter.getForeignState(id + '.desiredTemperature', (err, stateTemp) => {
            if (state && state.val !== null && state.val !== undefined && stateTemp && stateTemp.val !== null && stateTemp.val !== undefined) {
                let oldMode = state.val;
                let newMode = state.val;
                let oldVal = stateTemp.val;
                let newVal = stateTemp.val;
                if (state.val === 3) {
                    adapter.log.info('No Polling during boost-mode. Device: ' + id);
                    return;
                }
                if (state.val === 0 || state.val === 2) {
                    newMode = 1;
                } else {
                    newVal = newVal + 0.5;
                    if (newVal > 30) newVal = 29.5;
                    if (state.val > 3) {
                        oldMode = 1;
                        newMode = 1;
                    }
                }
                timers[id] = timers[id] || {};
                if (timers[id].requestRunning) {
                    adapter.log.info('Poll device : ' + newMode + ', ' + newVal + ' ignored, still running');
                    return;
                }
                timers[id].requestRunning = oldVal;
                timers[id].requestRunningMode = oldMode;
                adapter.log.info('Poll device ' + id + ' : ' + newMode + ', ' + newVal);

                max.sendDesiredTemperature(
                    src,
                    newVal,
                    newMode,
                    '00',
                    objects[id].native.type);
            }
        });
    });
}

function resetPollDevice(id) {
    var src = objects[id].native.src;
    if (credits < 120 || !devices[src]) {
        adapter.log.info('Not enough credit for Poll-Reset(min.120): ' + credits);
        return;
    }
    devices[src].lastReceived = new Date().getTime();
    adapter.getForeignState(id + '.mode', (err, state) => {
        adapter.getForeignState(id + '.desiredTemperature', (err, stateTemp) => {
            adapter.getForeignState(id + '.vacationConfig.untilDate', (err, untilDate) => {
                if (state && state.val !== null && state.val !== undefined) {
                        var oldMode = state.val;
                        var oldVal = stateTemp.val;
                        timers[id] = timers[id] || {};
                        timers[id].requestRunning = false;
                        timers[id].requestRunningMode = false;

                    if (oldMode === 2) {
                        adapter.log.info('Poll-Timeout: Reset Polling for device ' + id + ' : ' + oldMode + ', ' + oldVal + ', ' + untilDate.val);

                        max.sendVacation(
                            src,
                            oldVal,
                            oldMode,
                            untilDate.val,
                            '00',
                            objects[id].native.type);

                    } else {
                        adapter.log.info('Poll-Timeout: Reset Polling for device ' + id + ' : ' + oldMode + ', ' + oldVal);

                        max.sendDesiredTemperature(
                            src,
                            oldVal,
                            oldMode,
                            '00',
                            objects[id].native.type);
                    }
                }
            });
        });
    });
}

function connect() {
    adapter.setState('info.connection', false, true);
    if (!adapter.config.serialport) {
        adapter.log.warn('Please define the serial port.');
        return;
    }

    const env = {
        logger: adapter.log
    };

    const Max = require(__dirname + '/lib/maxcul')(env);

    max = new Max(adapter.config.baseAddress, true, adapter.config.serialport, parseInt(adapter.config.baudrate, 10) || 9600);

    creditsTimer = setInterval(() => max.getCredits(), 5000);

    if (adapter.config.scanner) {
        thermostatTimer = setInterval(() => {
            const now = new Date().getTime();
            let pollPause = 0;
            for (const id in objects) {
                if (objects.hasOwnProperty(id) && objects[id].type === 'channel' && (objects[id].native.type === 1 || objects[id].native.type === 2 || objects[id].native.type === 3)) {
                    if (devices[objects[id].native.src] && (!devices[objects[id].native.src].lastReceived || now - devices[objects[id].native.src].lastReceived > adapter.config.scanner * 60000)) {
                        setTimeout(function(pDevice) {
                            adapter.log.debug('Try to Poll Device: ' + pDevice);
                            pollDevice(pDevice);
                        },pollPause,id);
                        pollPause = pollPause + 5000;
                    }
                    if (devices[objects[id].native.src].lastReceived && timers[id]) {
                        var received = now - devices[objects[id].native.src].lastReceived;
                        adapter.log.debug(id + '  Request: ' + timers[id].requestRunningMode + ',' + timers[id].requestRunning + '  Last-Received: ' + received);
                        if (timers[id].requestRunning && now - devices[objects[id].native.src].lastReceived > 300000) {
                            setTimeout(function(resetPDevice) {
                                resetPollDevice(resetPDevice);
                            },pollPause,id);
                            pollPause = pollPause + 5000;
                        }
                    }
                }
            }
        }, 60000);
    }

    max.on('creditsReceived', (credit, credit1) => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }

        credits = parseInt(credit, 10);
        if (credits < 120) {
            if (!limitOverflow) {
                limitOverflow = true;
                adapter.setState('info.limitOverflow', true, true);
            }
        } else {
            if (limitOverflow === null || limitOverflow) {
                limitOverflow = false;
                adapter.setState('info.limitOverflow', false, true);
            }
        }
        adapter.setState('info.quota', credits, true);
    });

    max.on('ShutterContactStateReceived', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }
        adapter.log.debug('ShutterContactStateReceived: ' + JSON.stringify(data));
        if (devices[data.src]) {
            setStates({serial: devices[data.src].native.serial, data: data});
        } else {
            adapter.log.warn('Unknown device: ' + JSON.stringify(data));
            createContact(data);
        }
    });

    max.on('culFirmwareVersion', data => {
        adapter.setState('info.version', data, true);
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
    });

    max.on('WallThermostatStateReceived', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (devices[data.src]) {
            setStates({serial: devices[data.src].native.serial, data: data});
        } else {
            adapter.log.warn('Unknown device: ' + JSON.stringify(data));
            createWallThermostat(data);
        }
        adapter.log.debug('WallThermostatStateReceived: ' + JSON.stringify(data));
    });

    max.on('WallThermostatControlReceived', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (devices[data.src]) {
            setStates({serial: devices[data.src].native.serial, data: data});
        } else {
            adapter.log.warn('Unknown device: ' + JSON.stringify(data));
            //createWallThermostat(data);
        }
        adapter.log.debug('WallThermostatControlReceived: ' + JSON.stringify(data));
    });

    max.on('ThermostatStateReceived', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }
        //ThermostatStateReceived: {"src":"160bd0","mode":1,"desiredTemperature":30.5,"valvePosition":100,"measuredTemperature":22.4,"dstSetting":1,"lanGateway":1,"panel":0,"rfError":0,"batteryLow":0,"untilDate":""}
        if (devices[data.src]) {
            setStates({serial: devices[data.src].native.serial, data: data});
        } else {
            adapter.log.warn('Unknown device: ' + JSON.stringify(data));
            createThermostat(data);
        }
        adapter.log.debug('ThermostatStateReceived: ' + JSON.stringify(data));
    });

    max.on('PushButtonStateReceived', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }
        adapter.log.debug('PushButtonStateReceived: ' + JSON.stringify(data));
        if (devices[data.src]) {
            setStates({serial: devices[data.src].native.serial, data: data});
        } else {
            adapter.log.warn('Unknown device: ' + JSON.stringify(data));
            createButton(data);
        }
    });

    max.on('checkTimeIntervalFired', () => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }

        adapter.log.info('checkTimeIntervalFired');
        adapter.log.debug('Updating time information for deviceId');
        max.sendTimeInformation(adapter.config.baseAddress);
    });

    max.on('deviceRequestTimeInformation', src => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }
        adapter.log.info('deviceRequestTimeInformation: ' + JSON.stringify(src));
        adapter.log.debug('Updating time information for deviceId ' + src);
        if (devices[src]) {
            max.sendTimeInformation(src, devices[src].native.type);
        }
    });

    max.on('LOVF', () => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        adapter.log.debug('LOVF: credits=' + credits);
        if (!limitOverflow) {
            limitOverflow = true;
            adapter.setState('info.limitOverflow', true, true);
        }
    });

    max.on('PairDevice', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }
        adapter.log.info('PairDevice: ' + JSON.stringify(data));
        if (data.type === 1 || data.type === 2 /*|| data.type === 3*/) {
            createThermostat(data);
        } else if (data.type === 3) {
            createWallThermostat(data);
        } else if (data.type === 4) {
            createContact(data);
        } else if (data.type === 5) {
            createButton(data);
        } else {
            adapter.log.warn('Received unknown type: ' + JSON.stringify(data));
        }
    });

    if (adapter.config.serialport && adapter.config.serialport !== 'DEBUG') {
        max.connect();
    } else if (adapter.config.serialport === 'DEBUG') {
        setTimeout(() => {
            max.emit('PairDevice', {
                src: '160bd0',
                type: 1,
                raw: 'Z17000400160BD0123456001001A04E455130363731393837'
            });
        }, 100);

        setTimeout(() => {
            max.emit('ThermostatStateReceived', {
                src: '160bd0',
                mode: 1,
                desiredTemperature: 30.5,
                valvePosition: 100,
                measuredTemperature: 22.4,
                dstSetting: 1,
                lanGateway: 1,
                panel: 0,
                rfError: 0,
                batteryLow: 0,
                untilDate: '',
                rssi: 10
            });
        }, 1200);

        setTimeout(() => {
            max.emit('PairDevice', {
                src: '160bd1',
                type: 5,
                raw: 'Z17000400160BD0123456001001A04E455130363731393839'
            });
        }, 300);

        setTimeout(() => {
            max.emit('PushButtonStateReceived', {
                src: '160bd1',
                pressed: 1,
                rfError: 1,
                batteryLow: 0,
                rssi: 10
            });
        }, 1400);

        setTimeout(() => {
            max.emit('PairDevice', {
                src: '160bd2',
                type: 4,
                raw: 'Z17000400160BD0123456001001A04E455130363731393838'
            });
        }, 300);

        setTimeout(() => {
            max.emit('ShutterContactStateReceived', {
                src: '160bd2',
                isOpen: 0,
                rfError: 0,
                batteryLow: 1,
                rssi: 10
            });
        }, 1400);
    } else {
        adapter.log.warn('No serial port defined!');
    }
}

function main() {
    if (adapter.config.scanner === undefined) {
        adapter.config.scanner = 10;
    }
    adapter.config.scanner = parseInt(adapter.config.scanner, 10) || 0;

    adapter.objects.getObjectView('system', 'channel', {startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999'}, (err, res) => {
        for (let i = 0, l = res.rows.length; i < l; i++) {
            objects[res.rows[i].id] = res.rows[i].value;
        }
        adapter.objects.getObjectView('system', 'state', {startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999'}, (err, res) => {
            for (let i = 0, l = res.rows.length; i < l; i++) {
                objects[res.rows[i].id] = res.rows[i].value;
                if (objects[res.rows[i].id].native && objects[res.rows[i].id].native.src) {
                    devices[objects[res.rows[i].id].native.src] = objects[res.rows[i].id];
                }
            }
            connect();
            adapter.subscribeStates('*');
        });
    });
}
