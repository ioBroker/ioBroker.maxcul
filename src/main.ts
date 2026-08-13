/**
 *
 *      ioBroker maxcul Adapter
 *
 *      Javascript/Node.js based Busware CUL USB / culfw adapter
 *
 *      GPL-2.0-only License
 *
 */
import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import { SerialPort } from 'serialport';

import type { CulConnectionOptions } from './lib/communication-layer';
import { MaxDriver } from './lib/maxcul';
import type { ChannelTimer, MaxCulAdapterConfig, MaxDeviceData, MaxObject, Task } from './types';

/** Week days in the order the MAX! devices expect them */
const WEEK_DAYS = ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;

/** Numbers of the set points of one week profile day */
const SET_POINTS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13'] as const;

/** One state which has to be read before a group of values can be sent to the device */
interface StateToCollect {
    /** Key inside the channel timer */
    key: string;
    /** Full ID of the state to read */
    id: string;
    /** Value used if the state does not exist (yet) */
    default: ioBroker.StateValue;
    /** If true, a value of `0` is treated like a missing value */
    zeroIsEmpty?: boolean;
}

function formatTimeString(value: ioBroker.StateValue): string {
    let formattedTimeString: string;
    const timeStringNum = String(value).match(/\d/g);

    if (timeStringNum !== null) {
        formattedTimeString = timeStringNum.join('');

        if (formattedTimeString.length >= 3) {
            formattedTimeString = formattedTimeString.slice(0, 4);
            const leadingZeros = formattedTimeString.match(/^0+/g);
            formattedTimeString = (Math.round(parseInt(formattedTimeString, 10) / 5) * 5).toString();
            if (formattedTimeString[formattedTimeString.length - 2] === '6') {
                formattedTimeString = (parseInt(formattedTimeString, 10) + 40).toString();
            }
            if (leadingZeros !== null) {
                formattedTimeString = leadingZeros.join('').concat(formattedTimeString);
            }
            formattedTimeString = formattedTimeString.substring(formattedTimeString.length - 4);
        }

        if (formattedTimeString.length === 1) {
            formattedTimeString = `0${formattedTimeString}:00`;
        }
        if (formattedTimeString.length === 2) {
            formattedTimeString = `${formattedTimeString}:00`;
        }
        if (formattedTimeString.length === 3) {
            formattedTimeString = `0${formattedTimeString.substr(0, 1)}:${formattedTimeString.substr(1)}`;
        }
        if (formattedTimeString.length === 4) {
            formattedTimeString = `${formattedTimeString.substr(0, 2)}:${formattedTimeString.substr(2)}`;
        }
    } else {
        formattedTimeString = '';
    }

    if (
        (!/[01][0-9]:[0-5][05]/.test(formattedTimeString) &&
            !/[2][0-3]:[0-5][05]/.test(formattedTimeString) &&
            !/24:00/.test(formattedTimeString)) ||
        /00:00/.test(formattedTimeString)
    ) {
        formattedTimeString = '';
    }

    return formattedTimeString;
}

function formatUntilDate(value: ioBroker.StateValue): string {
    const untilDateTimeString = String(value);
    let formattedMinuteString: string;
    let formattedHourString: string;
    let formattedDayString: string;
    let formattedMonthString: string;
    let formattedYearString: string;
    let formattedDateTimeString: string;
    const dateTimeStringNum = untilDateTimeString.match(/\d/g);

    if (dateTimeStringNum !== null && dateTimeStringNum.length >= 12) {
        formattedDateTimeString = dateTimeStringNum.join('');

        // little-endian order. DIN 5008 alternative. Traditional format in German
        if (untilDateTimeString.search(/\W/) === 2) {
            formattedYearString = formattedDateTimeString.slice(4, 8);
            formattedMonthString = formattedDateTimeString.slice(2, 4);
            formattedDayString = formattedDateTimeString.slice(0, 2);
            formattedHourString = formattedDateTimeString.slice(8, 10);
            formattedMinuteString = formattedDateTimeString.slice(10, 12);
        } else if (untilDateTimeString.search(/\W/) === 4) {
            // big-endian order. ISO 8601, EN 28601 and DIN 5008. International.
            // Compatible with widget "jqui-ctrl-input Datetime"
            formattedYearString = formattedDateTimeString.slice(0, 4);
            formattedMonthString = formattedDateTimeString.slice(4, 6);
            formattedDayString = formattedDateTimeString.slice(6, 8);
            formattedHourString = formattedDateTimeString.slice(8, 10);
            formattedMinuteString = formattedDateTimeString.slice(10, 12);
        } else {
            return '';
        }

        formattedMinuteString = (Math.round(parseInt(formattedMinuteString) / 30) * 30).toString();

        if (formattedMinuteString === '60') {
            formattedMinuteString = '00';
            formattedHourString = (parseInt(formattedHourString, 10) + 1).toString();
        }
        if (formattedHourString.length < 2) {
            formattedHourString = `0${formattedHourString}`;
        }
        if (formattedMinuteString.length < 2) {
            formattedMinuteString = `0${formattedMinuteString}`;
        }
        if (
            /[2][0][1-5][1-9]/.test(formattedYearString) &&
            (/[0][0-9]/.test(formattedMonthString) || /[1][0-2]/.test(formattedMonthString)) &&
            (/[0-2][0-9]/.test(formattedDayString) || /[3][0-1]/.test(formattedDayString)) &&
            (/[01][0-9]/.test(formattedHourString) ||
                /[2][0-3]/.test(formattedHourString) ||
                /24/.test(formattedHourString))
        ) {
            formattedDateTimeString = `${formattedDayString}-${formattedMonthString}-${formattedYearString} ${
                formattedHourString
            }:${formattedMinuteString}`;
        } else {
            formattedDateTimeString = '';
        }
    } else {
        formattedDateTimeString = '';
    }
    return formattedDateTimeString;
}

/** Decode a hex string into the ASCII serial number. Returns an empty string for non-printable payloads */
function hex2a(hexx: string): string {
    const hex = hexx.toString(); // force conversion
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

export class MaxCulAdapter extends Adapter {
    declare public config: MaxCulAdapterConfig;

    private max: MaxDriver | null = null;
    private readonly objects: Record<string, MaxObject> = {};
    private readonly devices: Record<string, MaxObject> = {};
    private readonly timers: Record<string, ChannelTimer> = {};
    private readonly pollTimers: Record<string, NodeJS.Timeout> = {};
    private readonly tasks: Task[] = [];

    private limitOverflow: boolean | null = null;
    private credits = 0;
    private isConnected = false;
    private creditsTimer: NodeJS.Timeout | null = null;
    private thermostatTimer: NodeJS.Timeout | null = null;
    private pairingTimer: NodeJS.Timeout | null = null;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({
            ...options,
            name: 'maxcul',
            ready: () => this.main(),
            stateChange: (id, state) => this.onStateChange(id, state),
            message: obj => this.onMessage(obj),
            unload: callback => this.onUnload(callback),
        });
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!id || !state || state.ack) {
            return;
        }
        const obj = this.objects[id];
        if (!obj?.native) {
            this.log.warn(`Unknown ID: ${id}`);
            return;
        }
        if (obj.type !== 'state' || !obj.common.write) {
            this.log.warn(`id "${id}" is readonly`);
            return;
        }

        const parts = id.split('.');
        const name = parts.pop()!;
        const type = parts.length === 5 ? parts[parts.length - 2] : parts[parts.length - 1];

        if (type === 'config' || type === 'displayConfig' || type === 'valveConfig') {
            parts.pop();
        }

        if (type === 'weekProfile') {
            if (/setPointUntilTime/.test(name) && state.val !== formatTimeString(state.val)) {
                this.setForeignState(id, formatTimeString(state.val));
            }
            if (!/send_/.test(name) || state.val === false) {
                return;
            }
            parts.pop();
            parts.pop();
        }

        if (type === 'vacationConfig') {
            if (/untilDate/.test(name) && state.val !== formatUntilDate(state.val)) {
                this.setForeignState(id, formatUntilDate(state.val));
            }
            return;
        }

        const channel = parts.join('.');

        if (name === 'display') {
            if (!this.max) {
                return;
            }
            const val = state.val === 'false' || state.val === '0' ? false : state.val;
            this.log.debug(`sendSetDisplayActualTemperature(${channel}, ${val})`);
            void this.max.sendSetDisplayActualTemperature(this.objects[channel].native.src, val);
        }

        if (name === 'enablePairingMode') {
            if (!this.max) {
                return;
            }
            const val = state.val === 'false' || state.val === '0' ? false : state.val;
            this.log.debug(`Set Pairing mode to ${val}`);

            const enabled = val === true || val === 'true' || val === 1 || val === '1';
            this.max.pairModeEnabled = enabled;

            if (enabled) {
                this.pairingTimer = setTimeout(() => {
                    if (this.max) {
                        this.max.pairModeEnabled = false;
                    }
                    void this.setState('info.enablePairingMode', false, true);
                }, 30000);
            } else {
                if (this.pairingTimer) {
                    clearTimeout(this.pairingTimer);
                    this.pairingTimer = null;
                }
                void this.setState('info.enablePairingMode', false, true);
            }
        } else {
            if (this.timers[channel]?.timer) {
                clearTimeout(this.timers[channel].timer);
            }

            this.timers[channel] ||= {};
            this.timers[channel][name] = state.val;
            this.timers[channel].timer = setTimeout(ch => this.sendInfo(ch), 1000, channel);
        }
    }

    private onMessage(obj: ioBroker.Message): void {
        if (!obj) {
            return;
        }
        switch (obj.command) {
            case 'listUart':
                if (obj.callback) {
                    SerialPort.list()
                        .then(ports => {
                            this.log.info(`List of ports: ${JSON.stringify(ports)}`);
                            const result = ports.map(p => ({ label: p.path, value: p.path }));
                            this.sendTo(obj.from, obj.command, result, obj.callback);
                        })
                        .catch(err => {
                            this.log.error(`Error listing serial ports: ${err}`);
                            this.sendTo(obj.from, obj.command, [], obj.callback);
                        });
                }
                break;
        }
    }

    private onUnload(callback: () => void): void {
        void this.setState('info.connection', false, true);

        if (this.creditsTimer) {
            clearInterval(this.creditsTimer);
            this.creditsTimer = null;
        }
        if (this.thermostatTimer) {
            clearInterval(this.thermostatTimer);
            this.thermostatTimer = null;
        }
        void this.max?.disconnect();
        this.max = null;

        if (this.pairingTimer) {
            clearTimeout(this.pairingTimer);
            this.pairingTimer = null;
        }

        Object.keys(this.timers).forEach(channel => {
            if (this.timers[channel]?.timer) {
                clearTimeout(this.timers[channel].timer);
                this.timers[channel].timer = null;
            }
        });

        Object.keys(this.pollTimers).forEach(id => {
            clearTimeout(this.pollTimers[id]);
            delete this.pollTimers[id];
        });

        callback();
    }

    // -----------------------------------------------------------------------------------------------
    // Sending of the collected values
    // -----------------------------------------------------------------------------------------------

    private sendConfig(channel: string): void {
        if (!this.max) {
            return;
        }
        const values = this.timers[channel];
        void this.max.sendConfig(
            this.objects[channel].native.src,
            values.comfortTemperature,
            values.ecoTemperature,
            values.minimumTemperature,
            values.maximumTemperature,
            values.offset,
            values.windowOpenTime,
            values.windowOpenTemperature,
            this.objects[channel].native.type,
        );

        delete values.comfortTemperature;
        delete values.ecoTemperature;
        delete values.minimumTemperature;
        delete values.maximumTemperature;
        delete values.windowOpenTime;
        delete values.offset;
        delete values.windowOpenTemperature;
    }

    private sendValveConfig(channel: string): void {
        if (!this.max) {
            return;
        }
        const values = this.timers[channel];
        void this.max.sendConfigValve(
            this.objects[channel].native.src,
            values.boostDuration,
            values.boostValvePosition,
            values.decalcificationDay,
            values.decalcificationHour,
            values.maxValveSetting,
            values.valveOffset,
            '00',
            this.objects[channel].native.type,
        );

        delete values.boostDuration;
        delete values.boostValvePosition;
        delete values.decalcificationDay;
        delete values.decalcificationHour;
        delete values.maxValveSetting;
        delete values.valveOffset;
    }

    private sendTemperature(channel: string): void {
        if (!this.max) {
            return;
        }
        const values = this.timers[channel];
        this.log.debug(`sendTemperature(${channel}, ${values.desiredTemperature}, ${values.mode})`);
        void this.max.sendDesiredTemperature(
            this.objects[channel].native.src,
            values.desiredTemperature,
            values.mode,
            '00',
            this.objects[channel].native.type,
        );
        delete values.mode;
        delete values.desiredTemperature;
    }

    private sendDayProfile(channel: string): void {
        if (!this.max) {
            return;
        }
        const values = this.timers[channel];

        const daySend = Object.keys(values).filter(item => /^send_/.test(item));
        const weekDay = daySend[0].slice(5, 6);
        const dayType = daySend[0].slice(4);
        const sendId = `${channel}.weekProfile.${dayType}.`;
        void this.setState(sendId + daySend[0], false, true);

        void this.max.sendProfileDay(
            this.objects[channel].native.src,
            weekDay,
            values._01_setPointTemp,
            values._01_setPointUntilTime,
            values._02_setPointTemp,
            values._02_setPointUntilTime,
            values._03_setPointTemp,
            values._03_setPointUntilTime,
            values._04_setPointTemp,
            values._04_setPointUntilTime,
            values._05_setPointTemp,
            values._05_setPointUntilTime,
            values._06_setPointTemp,
            values._06_setPointUntilTime,
            values._07_setPointTemp,
            values._07_setPointUntilTime,
            '00',
            this.objects[channel].native.type,
        );

        void this.max.sendProfileDay2(
            this.objects[channel].native.src,
            weekDay,
            values._08_setPointTemp,
            values._08_setPointUntilTime,
            values._09_setPointTemp,
            values._09_setPointUntilTime,
            values._10_setPointTemp,
            values._10_setPointUntilTime,
            values._11_setPointTemp,
            values._11_setPointUntilTime,
            values._12_setPointTemp,
            values._12_setPointUntilTime,
            values._13_setPointTemp,
            values._13_setPointUntilTime,
            '00',
            this.objects[channel].native.type,
        );

        for (const setPoint of SET_POINTS) {
            void this.setState(`${sendId}_${setPoint}_setPointTemp`, values[`_${setPoint}_setPointTemp`], true);
            void this.setState(
                `${sendId}_${setPoint}_setPointUntilTime`,
                values[`_${setPoint}_setPointUntilTime`],
                true,
            );

            delete values[`_${setPoint}_setPointTemp`];
            delete values[`_${setPoint}_setPointUntilTime`];
        }

        delete values[daySend[0]];
    }

    private sendVacationConfig(channel: string): void {
        if (!this.max) {
            return;
        }
        const values = this.timers[channel];
        void this.max.sendVacation(
            this.objects[channel].native.src,
            values.vacationTemperature,
            values.mode,
            values.untilDate,
            '00',
            this.objects[channel].native.type,
        );
        delete values.mode;
        delete values.vacationTemperature;
        delete values.untilDate;
    }

    /**
     * Read all states of `entries` which are not known yet and call `send` afterwards.
     * Missing states (and, if requested, states with the value `0`) fall back to their default.
     */
    private collectStates(channel: string, entries: StateToCollect[], send: (channel: string) => void): void {
        const missing = entries.filter(entry => this.timers[channel][entry.key] === undefined);
        if (!missing.length) {
            send(channel);
            return;
        }

        let count = missing.length;
        for (const entry of missing) {
            void this.getForeignState(entry.id, (_err, state) => {
                const isEmpty =
                    !state ||
                    state.val === null ||
                    state.val === undefined ||
                    (entry.zeroIsEmpty && Number(state.val) === 0);
                this.timers[channel][entry.key] = isEmpty ? entry.default : state.val;
                if (!--count) {
                    send(channel);
                }
            });
        }
    }

    private sendInfo(channel: string): void {
        const values = this.timers[channel];
        if (!values) {
            return;
        }

        if (this.credits < 220) {
            this.log.warn(`Not enough credits(${this.credits}). Wait for more...`);
            values.timer = setTimeout(() => this.sendInfo(channel), 5000);
            return;
        }

        values.timer = null;

        // desiredTemperature and mode
        if ((values.mode !== undefined || values.desiredTemperature !== undefined) && values.mode !== 2) {
            values.requestRunning = false;
            values.requestRunningMode = false;

            this.collectStates(
                channel,
                [
                    { key: 'mode', id: `${channel}.mode`, default: 0 },
                    { key: 'desiredTemperature', id: `${channel}.desiredTemperature`, default: 21 },
                ],
                ch => this.sendTemperature(ch),
            );
        }

        // comfortTemperature, ecoTemperature, minimumTemperature, maximumTemperature, offset, windowOpenTime,
        // windowOpenTemperature
        const configEntries: StateToCollect[] = [
            { key: 'comfortTemperature', id: `${channel}.config.comfortTemperature`, default: 21 },
            { key: 'ecoTemperature', id: `${channel}.config.ecoTemperature`, default: 17 },
            { key: 'minimumTemperature', id: `${channel}.config.minimumTemperature`, default: 4.5 },
            { key: 'maximumTemperature', id: `${channel}.config.maximumTemperature`, default: 30.5 },
            { key: 'offset', id: `${channel}.config.offset`, default: 0 },
            { key: 'windowOpenTime', id: `${channel}.config.windowOpenTime`, default: 10 },
            { key: 'windowOpenTemperature', id: `${channel}.config.windowOpenTemperature`, default: 12 },
        ];
        if (configEntries.some(entry => values[entry.key] !== undefined)) {
            this.collectStates(channel, configEntries, ch => this.sendConfig(ch));
        }

        // boostDuration, boostValvePosition, decalcificationDay, decalcificationHour, maxValveSetting, valveOffset
        const valveEntries: StateToCollect[] = [
            { key: 'boostDuration', id: `${channel}.valveConfig.boostDuration`, default: 5 },
            { key: 'boostValvePosition', id: `${channel}.valveConfig.boostValvePosition`, default: 100 },
            { key: 'decalcificationDay', id: `${channel}.valveConfig.decalcificationDay`, default: 0 },
            { key: 'decalcificationHour', id: `${channel}.valveConfig.decalcificationHour`, default: 12 },
            { key: 'maxValveSetting', id: `${channel}.valveConfig.maxValveSetting`, default: 100 },
            { key: 'valveOffset', id: `${channel}.valveConfig.valveOffset`, default: 0 },
        ];
        if (valveEntries.some(entry => values[entry.key] !== undefined)) {
            this.collectStates(channel, valveEntries, ch => this.sendValveConfig(ch));
        }

        // weekProfile
        if (WEEK_DAYS.some((day, index) => values[`send_${index}_${day}`] === true)) {
            const daySend = Object.keys(values).filter(item => /^send_/.test(item));
            const weekDay = daySend[0].substring(4);

            const profileEntries: StateToCollect[] = [];
            for (const setPoint of SET_POINTS) {
                profileEntries.push({
                    key: `_${setPoint}_setPointTemp`,
                    id: `${channel}.weekProfile.${weekDay}._${setPoint}_setPointTemp`,
                    default: '',
                    zeroIsEmpty: true,
                });
                profileEntries.push({
                    key: `_${setPoint}_setPointUntilTime`,
                    id: `${channel}.weekProfile.${weekDay}._${setPoint}_setPointUntilTime`,
                    default: '',
                });
            }

            this.collectStates(channel, profileEntries, ch => this.sendDayProfile(ch));
        }

        // vacationTemperature, untilDate
        if (values.mode !== undefined && values.mode === 2) {
            values.requestRunning = false;
            values.requestRunningMode = false;

            this.collectStates(
                channel,
                [
                    {
                        key: 'vacationTemperature',
                        id: `${channel}.vacationConfig.vacationTemperature`,
                        default: 17,
                    },
                    { key: 'untilDate', id: `${channel}.vacationConfig.untilDate`, default: '' },
                ],
                ch => this.sendVacationConfig(ch),
            );
        }
    }

    // -----------------------------------------------------------------------------------------------
    // Object and state synchronisation
    // -----------------------------------------------------------------------------------------------

    private processTasks(): void {
        if (!this.tasks.length) {
            return;
        }
        const task = this.tasks.shift()!;

        if (task.type === 'state') {
            this.setForeignState(task.id, task.val, true, () => setImmediate(() => this.processTasks()));
            return;
        }

        void this.getForeignObject(task.id, (_err, obj) => {
            if (!obj) {
                this.objects[task.id] = task.obj;
                this.setForeignObject(task.id, task.obj, () => {
                    this.log.info(`object ${this.namespace}.${task.id} created`);
                    setImmediate(() => this.processTasks());
                });
                return;
            }

            if (JSON.stringify(obj.native) !== JSON.stringify(task.obj.native)) {
                obj.native = task.obj.native;
                this.objects[obj._id] = obj as MaxObject;
                this.setForeignObject(obj._id, obj, () => {
                    this.log.info(`object ${this.namespace}.${obj._id} created`);
                    setImmediate(() => this.processTasks());
                });
            } else {
                setImmediate(() => this.processTasks());
            }
        });
    }

    private setStates(obj: { serial: string; data: MaxDeviceData }): void {
        const id = obj.serial;
        const isStart = !this.tasks.length;
        const device = this.devices[obj.data.src];
        if (!device) {
            return;
        }

        device.lastReceived = new Date().getTime();

        const data = obj.data as unknown as Record<string, ioBroker.StateValue | undefined>;
        const channelId = `${this.namespace}.${id}`;

        for (const state in data) {
            if (!Object.prototype.hasOwnProperty.call(data, state)) {
                continue;
            }
            if (state === 'src' || state === 'serial' || data[state] === undefined) {
                continue;
            }

            const oid = `${channelId}.${state}`;
            const meta = this.objects[oid];
            let val = data[state];

            if (state === 'mode' && this.timers[channelId]?.requestRunning) {
                this.log.debug(`${id}: Ignore mode triggered by polling: ${val}`);
                continue;
            }
            if (state === 'desiredTemperature' && this.timers[channelId]?.requestRunning) {
                this.log.debug(`${id}: Ignore desiredTemperature triggered by polling: ${val}`);
                this.log.debug(
                    `${id}: Set initially desiredTemperature after polling: ${this.timers[channelId].requestRunning}`,
                );
                this.log.debug(`${id}: Set initially mode after polling: ${this.timers[channelId].requestRunningMode}`);
                this.timers[channelId].desiredTemperature = this.timers[channelId].requestRunning;
                this.timers[channelId].mode = this.timers[channelId].requestRunningMode;
                this.timers[channelId].requestRunning = false;
                this.timers[channelId].requestRunningMode = false;

                setImmediate(() => this.sendInfo(channelId));
                continue;
            }
            if (state === 'untilDate' && val !== '') {
                this.log.info(`Device ${channelId} in Vacation Mode until ${val}`);
            }

            if (meta?.type === 'state') {
                if (meta.common.type === 'boolean') {
                    val = val === 'true' || val === true || val === 1 || val === '1' || val === 'on';
                } else if (meta.common.type === 'number') {
                    if (val === 'on' || val === 'true' || val === true) {
                        val = 1;
                    }
                    if (val === 'off' || val === 'false' || val === false) {
                        val = 0;
                    }
                    val = parseFloat(val as string);
                }
            }
            if (meta) {
                this.tasks.push({ type: 'state', id: oid, val });
            }
        }

        if (isStart) {
            this.processTasks();
        }
    }

    private syncObjects(objs: MaxObject[]): void {
        const isStart = !this.tasks.length;
        for (const obj of objs) {
            if (obj.native?.type && !this.devices[obj.native.src]) {
                this.devices[obj.native.src] = obj;
            }
            this.tasks.push({ type: 'object', id: obj._id, obj });
        }
        if (isStart) {
            this.processTasks();
        }
    }

    // -----------------------------------------------------------------------------------------------
    // Object creation
    // -----------------------------------------------------------------------------------------------

    private createThermostat(data: MaxDeviceData, prefix?: string): void {
        // comfortTemperature, ecoTemperature, minimumTemperature, maximumTemperature, offset, windowOpenTime,
        // windowOpenTemperature
        prefix ||= '';

        if (!data.serial && data.raw) {
            data.serial = hex2a(data.raw.substring(data.raw.length - 20));
        }
        data.serial ||= data.src.toUpperCase();

        const serial = data.serial;
        const base = `${this.namespace}.${serial}`;

        const objs: MaxObject[] = [
            {
                _id: base,
                common: {
                    role: 'thermostat',
                    name: `${prefix}Thermostat ${serial} | ${data.src}`,
                },
                type: 'channel',
                native: data,
            },
            {
                _id: `${base}.mode`,
                common: {
                    name: `${prefix}Thermostat ${serial} mode`,
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
                        6: 'manual window',
                    },
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.measuredTemperature`,
                common: {
                    name: `${prefix}Thermostat ${serial} current temperature`,
                    type: 'number',
                    read: true,
                    write: false,
                    role: 'value.temperature',
                    unit: '°C',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.desiredTemperature`,
                common: {
                    name: `${prefix}Thermostat ${serial} set temperature`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 4.5,
                    max: 30.5,
                    role: 'level.temperature',
                    unit: '°C',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.valvePosition`,
                common: {
                    name: `${prefix}Thermostat ${serial} valve`,
                    type: 'number',
                    read: true,
                    write: false,
                    role: 'value.valve',
                    unit: '%',
                    min: 0,
                    max: 100,
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.rfError`,
                common: {
                    name: `${prefix}Thermostat ${serial} error`,
                    type: 'boolean',
                    read: true,
                    write: false,
                    role: 'indicator.reachable',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.batteryLow`,
                common: {
                    name: `${prefix}Thermostat ${serial} low battery`,
                    type: 'boolean',
                    read: true,
                    write: false,
                    role: 'indicator.battery',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.config.comfortTemperature`,
                common: {
                    name: `${prefix}Thermostat ${serial} comfort temperature`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 4.5,
                    max: 30.5,
                    role: 'level.temperature',
                    unit: '°C',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.config.ecoTemperature`,
                common: {
                    name: `${prefix}Thermostat ${serial} eco temperature`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 4.5,
                    max: 30.5,
                    role: 'level.temperature',
                    unit: '°C',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.config.minimumTemperature`,
                common: {
                    name: `${prefix}Thermostat ${serial} minimum temperature`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 4.5,
                    max: 30.5,
                    role: 'level.temperature',
                    unit: '°C',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.config.maximumTemperature`,
                common: {
                    name: `${prefix}Thermostat ${serial} maximum temperature`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 4.5,
                    max: 30.5,
                    role: 'level.temperature',
                    unit: '°C',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.config.offset`,
                common: {
                    name: `${prefix}Thermostat ${serial} offset temperature`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: -3.5,
                    max: 3.5,
                    role: 'level.temperature',
                    unit: '°C',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.config.windowOpenTemperature`,
                common: {
                    name: `${prefix}Thermostat ${serial} window open temperature`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 4.5,
                    max: 30.5,
                    role: 'level.temperature',
                    unit: '°C',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.config.windowOpenTime`,
                common: {
                    name: `${prefix}Thermostat ${serial} window open time`,
                    type: 'number',
                    read: true,
                    write: true,
                    role: 'level.interval',
                    unit: 'min',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.rssi`,
                common: {
                    name: `${prefix}Thermostat ${serial} signal strength`,
                    type: 'number',
                    read: true,
                    write: false,
                    role: 'value.rssi',
                    unit: 'dBm',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.valveConfig.boostDuration`,
                common: {
                    name: `${prefix}Thermostat ${serial} boost duration`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 60,
                    role: 'level.duration',
                    unit: 'min',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.valveConfig.boostValvePosition`,
                common: {
                    name: `${prefix}Thermostat ${serial} boost valve position`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    role: 'level.valve',
                    unit: '%',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.valveConfig.decalcificationDay`,
                common: {
                    name: `${prefix}Thermostat ${serial} decalcification week day`,
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
                        6: 'Friday',
                    },
                    role: 'level.day',
                    unit: '',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.valveConfig.decalcificationHour`,
                common: {
                    name: `${prefix}Thermostat ${serial} decalcification hour`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 23,
                    role: 'level.hour',
                    unit: 'hour',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.valveConfig.maxValveSetting`,
                common: {
                    name: `${prefix}Thermostat ${serial} max valve position`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    role: 'level.valve',
                    unit: '%',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.valveConfig.valveOffset`,
                common: {
                    name: `${prefix}Thermostat ${serial} valve offset`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    role: 'level.valve',
                    unit: '%',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.vacationConfig.vacationTemperature`,
                common: {
                    name: `${prefix}Thermostat ${serial} set vacation temperature`,
                    type: 'number',
                    read: true,
                    write: true,
                    min: 4.5,
                    max: 30.5,
                    role: 'level.temperature',
                    unit: '°C',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.vacationConfig.untilDate`,
                common: {
                    name: `${prefix}Thermostat ${serial} set vacation until date (dd-MM-yyyy HH:mm)`,
                    type: 'string',
                    read: true,
                    write: true,
                    role: 'until.date',
                    unit: '',
                },
                type: 'state',
                native: data,
            },
        ];

        // weekProfile
        WEEK_DAYS.forEach((weekDay, n) => {
            for (const setPointNumber of SET_POINTS) {
                objs.push({
                    _id: `${base}.weekProfile._${n}_${weekDay}._${setPointNumber}_setPointTemp`,
                    common: {
                        name: `${prefix}Thermostat ${serial} ${weekDay} setPoint ${setPointNumber} temperature`,
                        type: 'number',
                        read: true,
                        write: true,
                        min: 4.5,
                        max: 30.5,
                        role: `weekProfile.${weekDay}`,
                        unit: '°C',
                    },
                    type: 'state',
                    native: data,
                });

                objs.push({
                    _id: `${base}.weekProfile._${n}_${weekDay}._${setPointNumber}_setPointUntilTime`,
                    common: {
                        name: `${prefix}Thermostat ${serial} ${weekDay} setPoint ${setPointNumber} until time`,
                        type: 'string',
                        read: true,
                        write: true,
                        role: `weekProfile.${weekDay}`,
                    },
                    type: 'state',
                    native: data,
                });
            }

            objs.push({
                _id: `${base}.weekProfile._${n}_${weekDay}.send_${n}_${weekDay}`,
                common: {
                    name: `${prefix}Thermostat ${serial} send ${weekDay} Profile `,
                    type: 'boolean',
                    read: true,
                    write: true,
                    role: `weekProfile.${weekDay}`,
                },
                type: 'state',
                native: data,
            });
        });

        this.syncObjects(objs);
    }

    private createWallThermostat(data: MaxDeviceData): void {
        this.createThermostat(data, 'Wall');

        this.syncObjects([
            {
                _id: `${this.namespace}.${data.serial}.displayConfig.display`,
                common: {
                    name: `WallThermostat ${data.serial} display`,
                    type: 'boolean',
                    desc: 'Display actual temperature',
                    role: 'switch',
                    read: true,
                    write: true,
                },
                type: 'state',
                native: data,
            },
        ]);
    }

    private createButton(data: MaxDeviceData): void {
        if (!data.serial && data.raw) {
            data.serial = hex2a(data.raw.substring(data.raw.length - 20));
        }
        data.serial ||= data.src.toUpperCase();

        const serial = data.serial;
        const base = `${this.namespace}.${serial}`;

        this.syncObjects([
            {
                _id: base,
                common: {
                    role: 'button',
                    name: `Push button ${serial}`,
                },
                type: 'channel',
                native: data,
            },
            {
                _id: `${base}.pressed`,
                common: {
                    name: `Push button ${serial} pressed`,
                    type: 'boolean',
                    role: 'button',
                    read: true,
                    write: false,
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.rfError`,
                common: {
                    name: `Push button ${serial} error`,
                    type: 'boolean',
                    read: true,
                    write: false,
                    role: 'indicator.reachable',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.batteryLow`,
                common: {
                    name: `Push button ${serial} low battery`,
                    type: 'boolean',
                    read: true,
                    write: false,
                    role: 'indicator.battery',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.rssi`,
                common: {
                    name: `Push button ${serial} signal strength`,
                    type: 'number',
                    read: true,
                    write: false,
                    role: 'value.rssi',
                    unit: 'dBm',
                },
                type: 'state',
                native: data,
            },
        ]);
    }

    private createContact(data: MaxDeviceData): void {
        if (!data.serial && data.raw) {
            data.serial = hex2a(data.raw.substring(data.raw.length - 20));
        }
        data.serial ||= data.src.toUpperCase();

        const serial = data.serial;
        const base = `${this.namespace}.${serial}`;

        this.syncObjects([
            {
                _id: base,
                common: {
                    role: 'indicator',
                    name: `Window/door contact ${serial}`,
                },
                type: 'channel',
                native: data,
            },
            {
                _id: `${base}.isOpen`,
                common: {
                    name: `Contact ${serial} opened`,
                    type: 'boolean',
                    role: 'button',
                    read: true,
                    write: false,
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.rfError`,
                common: {
                    name: `Contact ${serial} error`,
                    type: 'boolean',
                    read: true,
                    write: false,
                    role: 'indicator.reachable',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.batteryLow`,
                common: {
                    name: `Contact ${serial} low battery`,
                    type: 'boolean',
                    read: true,
                    write: false,
                    role: 'indicator.battery',
                },
                type: 'state',
                native: data,
            },
            {
                _id: `${base}.rssi`,
                common: {
                    name: `Contact ${serial} signal strength`,
                    type: 'number',
                    read: true,
                    write: false,
                    role: 'value.rssi',
                    unit: 'dBm',
                },
                type: 'state',
                native: data,
            },
        ]);
    }

    // -----------------------------------------------------------------------------------------------
    // Polling
    // -----------------------------------------------------------------------------------------------

    private pollDevice(id: string): void {
        const src = this.objects[id].native.src;
        if (this.credits < 400 || !this.devices[src]) {
            this.log.info(`Not enough credit for Polling(min.400): ${this.credits}`);
            return;
        }
        this.devices[src].lastReceived = new Date().getTime();

        void this.getForeignState(`${id}.mode`, (_err, state) => {
            void this.getForeignState(`${id}.desiredTemperature`, (_errTemp, stateTemp) => {
                if (
                    state?.val === null ||
                    state?.val === undefined ||
                    stateTemp?.val === null ||
                    stateTemp?.val === undefined
                ) {
                    return;
                }

                let oldMode = state.val as number;
                let newMode = state.val as number;
                const oldVal = stateTemp.val as number;
                let newVal = stateTemp.val as number;

                if (state.val === 3) {
                    this.log.info(`No Polling during boost-mode. Device: ${id}`);
                    return;
                }
                if (state.val === 0 || state.val === 2) {
                    newMode = 1;
                } else {
                    newVal = newVal + 0.5;
                    if (newVal > 30) {
                        newVal = 29.5;
                    }
                    if (oldMode > 3) {
                        oldMode = 1;
                        newMode = 1;
                    }
                }

                this.timers[id] ||= {};
                if (this.timers[id].requestRunning) {
                    this.log.info(`Poll device : ${newMode}, ${newVal} ignored, still running`);
                    return;
                }
                this.timers[id].requestRunning = oldVal;
                this.timers[id].requestRunningMode = oldMode;
                this.log.info(`Poll device ${id} : ${newMode}, ${newVal}`);

                void this.max?.sendDesiredTemperature(src, newVal, newMode, '00', this.objects[id].native.type);
            });
        });
    }

    private resetPollDevice(id: string): void {
        const src = this.objects[id].native.src;
        if (this.credits < 120 || !this.devices[src]) {
            this.log.info(`Not enough credit for Poll-Reset(min.120): ${this.credits}`);
            return;
        }
        this.devices[src].lastReceived = new Date().getTime();

        void this.getForeignState(`${id}.mode`, (_err, state) => {
            void this.getForeignState(`${id}.desiredTemperature`, (_errTemp, stateTemp) => {
                void this.getForeignState(`${id}.vacationConfig.untilDate`, (_errDate, untilDate) => {
                    if (!state || state.val === null || state.val === undefined) {
                        return;
                    }
                    const oldMode = state.val as number;
                    const oldVal = stateTemp?.val as number;

                    this.timers[id] ||= {};
                    this.timers[id].requestRunning = false;
                    this.timers[id].requestRunningMode = false;

                    if (oldMode === 2) {
                        this.log.info(
                            `Poll-Timeout: Reset Polling for device ${id} : ${oldMode}, ${oldVal}, ${untilDate?.val}`,
                        );
                        void this.max?.sendVacation(
                            src,
                            oldVal,
                            oldMode,
                            String(untilDate?.val ?? ''),
                            '00',
                            this.objects[id].native.type,
                        );
                    } else {
                        this.log.info(`Poll-Timeout: Reset Polling for device ${id} : ${oldMode}, ${oldVal}`);
                        void this.max?.sendDesiredTemperature(src, oldVal, oldMode, '00', this.objects[id].native.type);
                    }
                });
            });
        });
    }

    // -----------------------------------------------------------------------------------------------
    // Connection to the CUL stick
    // -----------------------------------------------------------------------------------------------

    /** Mark the adapter as connected and reset the limit overflow indicator */
    private setConnected(resetLimitOverflow: boolean): void {
        if (!this.isConnected) {
            this.isConnected = true;
            void this.setState('info.connection', true, true);
        }
        if (resetLimitOverflow && this.limitOverflow) {
            this.limitOverflow = false;
            void this.setState('info.limitOverflow', false, true);
        }
    }

    /** Build the connection options from the configuration. Returns `null` if the configuration is incomplete */
    private getConnectionOptions(): CulConnectionOptions | null {
        if (this.config.connectionType === 'network') {
            if (!this.config.host) {
                this.log.warn('Please define the host name or IP address of the CUN/CUNO.');
                return null;
            }
            return {
                type: 'network',
                host: this.config.host,
                port: parseInt(String(this.config.port), 10) || 2323,
            };
        }

        if (!this.config.serialport) {
            this.log.warn('Please define the serial port.');
            return null;
        }
        return {
            type: 'serial',
            port: this.config.serialport,
            baudrate: parseInt(String(this.config.baudrate), 10) || 9600,
        };
    }

    private connect(): void {
        void this.setState('info.connection', false, true);

        const connection = this.getConnectionOptions();
        if (!connection) {
            return;
        }

        const max = new MaxDriver(this.log, this.config.baseAddress, true, connection);
        this.max = max;

        this.creditsTimer = setInterval(
            () => max.getCredits().catch(e => this.log.debug(`Cannot request credits: ${e}`)),
            5000,
        );

        if (this.config.scanner) {
            this.thermostatTimer = setInterval(() => this.checkDevices(), 60000);
        }

        max.on('creditsReceived', credit => {
            this.setConnected(false);

            this.credits = parseInt(credit, 10);
            if (this.credits < 120) {
                if (!this.limitOverflow) {
                    this.limitOverflow = true;
                    void this.setState('info.limitOverflow', true, true);
                }
            } else if (this.limitOverflow === null || this.limitOverflow) {
                this.limitOverflow = false;
                void this.setState('info.limitOverflow', false, true);
            }
            void this.setState('info.quota', this.credits, true);
        });

        max.on('ShutterContactStateReceived', data => {
            this.setConnected(true);
            this.log.debug(`ShutterContactStateReceived: ${JSON.stringify(data)}`);

            data.type ||= 4;

            if (this.devices[data.src]) {
                this.setStates({ serial: this.devices[data.src].native.serial, data });
            } else {
                this.log.warn(`Unknown device: ${JSON.stringify(data)}`);
                this.createContact(data);
            }
        });

        max.on('culFirmwareVersion', data => {
            void this.setState('info.version', data, true);
            this.setConnected(false);
        });

        max.on('WallThermostatStateReceived', data => {
            this.setConnected(false);
            if (this.devices[data.src]) {
                this.setStates({ serial: this.devices[data.src].native.serial, data });
            } else {
                this.log.warn(`Unknown device: ${JSON.stringify(data)}`);
                this.createWallThermostat(data);
            }
            this.log.debug(`WallThermostatStateReceived: ${JSON.stringify(data)}`);
        });

        max.on('WallThermostatControlReceived', data => {
            this.setConnected(false);
            if (this.devices[data.src]) {
                this.setStates({ serial: this.devices[data.src].native.serial, data });
            } else {
                this.log.warn(`Unknown device: ${JSON.stringify(data)}`);
                //this.createWallThermostat(data);
            }
            this.log.debug(`WallThermostatControlReceived: ${JSON.stringify(data)}`);
        });

        max.on('ThermostatStateReceived', data => {
            this.setConnected(true);
            //ThermostatStateReceived: {"src":"160bd0","mode":1,"desiredTemperature":30.5,"valvePosition":100,
            // "measuredTemperature":22.4,"dstSetting":1,"lanGateway":1,"panel":0,"rfError":0,"batteryLow":0,"untilDate":""}

            data.type ||= 2;

            if (this.devices[data.src]) {
                this.setStates({ serial: this.devices[data.src].native.serial, data });
            } else {
                this.log.warn(`Unknown device: ${JSON.stringify(data)}`);
                this.createThermostat(data);
            }
            this.log.debug(`ThermostatStateReceived: ${JSON.stringify(data)}`);
        });

        max.on('PushButtonStateReceived', data => {
            this.setConnected(true);
            this.log.debug(`PushButtonStateReceived: ${JSON.stringify(data)}`);

            data.type ||= 5;

            if (this.devices[data.src]) {
                this.setStates({ serial: this.devices[data.src].native.serial, data });
            } else {
                this.log.warn(`Unknown device: ${JSON.stringify(data)}`);
                this.createButton(data);
            }
        });

        max.on('checkTimeIntervalFired', () => {
            this.setConnected(true);

            this.log.info('checkTimeIntervalFired');
            this.log.debug('Updating time information for deviceId');
            void max.sendTimeInformation(this.config.baseAddress);
        });

        max.on('deviceRequestTimeInformation', src => {
            this.setConnected(true);
            this.log.info(`deviceRequestTimeInformation: ${JSON.stringify(src)}`);
            this.log.debug(`Updating time information for deviceId ${src}`);
            if (this.devices[src]) {
                void max.sendTimeInformation(src, this.devices[src].native.type);
            }
        });

        max.on('LOVF', () => {
            this.setConnected(false);
            this.log.debug(`LOVF: credits=${this.credits}`);
            if (!this.limitOverflow) {
                this.limitOverflow = true;
                void this.setState('info.limitOverflow', true, true);
            }
        });

        max.on('PairDevice', data => {
            this.setConnected(true);
            this.log.info(`PairDevice: ${JSON.stringify(data)}`);
            if (data.type === 1 || data.type === 2 /*|| data.type === 3*/) {
                this.createThermostat(data);
            } else if (data.type === 3) {
                this.createWallThermostat(data);
            } else if (data.type === 4) {
                this.createContact(data);
            } else if (data.type === 5) {
                this.createButton(data);
            } else {
                this.log.warn(`Received unknown type: ${JSON.stringify(data)}`);
            }
        });

        if (connection.type === 'serial' && connection.port === 'DEBUG') {
            this.emitDebugDevices(max);
        } else {
            void max.connect();
        }
    }

    /** Periodically poll thermostats which did not report for a while */
    private checkDevices(): void {
        const now = new Date().getTime();
        let pollPause = 0;

        for (const id of Object.keys(this.objects)) {
            const obj = this.objects[id];
            if (obj.type !== 'channel' || (obj.native.type !== 1 && obj.native.type !== 2 && obj.native.type !== 3)) {
                continue;
            }

            const device = this.devices[obj.native.src];
            if (device && (!device.lastReceived || now - device.lastReceived > this.config.scanner * 60000)) {
                this.pollTimers[id] = setTimeout(
                    pDevice => {
                        delete this.pollTimers[pDevice];
                        this.log.debug(`Try to Poll Device: ${pDevice}`);
                        this.pollDevice(pDevice);
                    },
                    pollPause,
                    id,
                );
                pollPause += 5000;
            }

            if (device?.lastReceived && this.timers[id]) {
                const received = now - device.lastReceived;
                this.log.debug(
                    `${id}  Request: ${this.timers[id].requestRunningMode},${
                        this.timers[id].requestRunning
                    }  Last-Received: ${received}`,
                );
                if (this.timers[id].requestRunning && received > 300000) {
                    this.pollTimers[`reset_${id}`] = setTimeout(
                        resetPDevice => {
                            delete this.pollTimers[`reset_${resetPDevice}`];
                            this.resetPollDevice(resetPDevice);
                        },
                        pollPause,
                        id,
                    );
                    pollPause += 5000;
                }
            }
        }
    }

    /** Simulate some devices if the serial port is set to `DEBUG` */
    private emitDebugDevices(max: MaxDriver): void {
        setTimeout(() => {
            max.emit('PairDevice', {
                src: '160bd0',
                type: 1,
                raw: 'Z17000400160BD0123456001001A04E455130363731393837',
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
                rssi: 10,
            });
        }, 1200);

        setTimeout(() => {
            max.emit('PairDevice', {
                src: '160bd1',
                type: 5,
                raw: 'Z17000400160BD0123456001001A04E455130363731393839',
            });
        }, 300);

        setTimeout(() => {
            max.emit('PushButtonStateReceived', {
                src: '160bd1',
                pressed: 1,
                rfError: 1,
                batteryLow: 0,
                rssi: 10,
            });
        }, 1400);

        setTimeout(() => {
            max.emit('PairDevice', {
                src: '160bd2',
                type: 4,
                raw: 'Z17000400160BD0123456001001A04E455130363731393838',
            });
        }, 300);

        setTimeout(() => {
            max.emit('ShutterContactStateReceived', {
                src: '160bd2',
                isOpen: 0,
                rfError: 0,
                batteryLow: 1,
                rssi: 10,
            });
        }, 1400);
    }

    private main(): void {
        if (this.config.scanner === undefined) {
            this.config.scanner = 10;
        }
        this.config.scanner = parseInt(String(this.config.scanner), 10) || 0;

        this.getObjectView(
            'system',
            'channel',
            { startkey: `${this.namespace}.`, endkey: `${this.namespace}.香` },
            (_err, res) => {
                for (const row of res?.rows || []) {
                    this.objects[row.id] = row.value;
                }

                this.getObjectView(
                    'system',
                    'state',
                    { startkey: `${this.namespace}.`, endkey: `${this.namespace}.香` },
                    (_errState, resState) => {
                        for (const row of resState?.rows || []) {
                            const obj = row.value as MaxObject;
                            this.objects[row.id] = obj;
                            if (obj.native?.src) {
                                this.devices[obj.native.src] = obj;
                            }
                        }
                        this.connect();
                        this.subscribeStates('*');
                    },
                );
            },
        );
    }
}

// If started as allInOne/compact mode => return function to create instance
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<AdapterOptions> | undefined) => new MaxCulAdapter(options);
} else {
    // or start the instance directly
    (() => new MaxCulAdapter())();
}
