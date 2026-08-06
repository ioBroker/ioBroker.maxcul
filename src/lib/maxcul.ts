import { EventEmitter } from 'node:events';
import BitSet from 'bitset';
import moment from 'moment';
import { sprintf } from 'sprintf-js';
import { Parser as BinaryParser } from 'binary-parser';

import { CommunicationServiceLayer } from './communication-layer';
import { CulPacket } from './culpacket';
import type {
    PairDeviceData,
    PushButtonStateData,
    ShutterContactStateData,
    ThermostatStateData,
    WallThermostatControlData,
    WallThermostatStateData,
} from '../types';

/** Device types as they are reported in a PairPing packet */
export const DEVICE_TYPES = [
    'Cube',
    'HeatingThermostat',
    'HeatingThermostatPlus',
    'WallMountedThermostat',
    'ShutterContact',
    'PushButton',
] as const;

/**
 * MAX! command IDs. Only the entries with a `functionName` are handled by this driver,
 * the plain strings are documented but ignored.
 */
const COMMAND_LIST: Record<string, { functionName: string; id: string | number } | string> = {
    cmd00: { functionName: 'PairPing', id: '00' },
    cmd01: { functionName: 'PairPong', id: '01' },
    cmd02: { functionName: 'Ack', id: '02' },
    cmd03: { functionName: 'TimeInformation', id: '03' },
    cmd10: 'ConfigWeekProfile',
    cmd11: 'ConfigTemperatures',
    cmd12: 'ConfigValve',
    cmd20: 'AddLinkPartner',
    cmd21: 'RemoveLinkPartner',
    cmd22: 'SetGroupId',
    cmd23: 'RemoveGroupId',
    cmd30: { functionName: 'ShutterContactState', id: '30' },
    cmd40: 'SetTemperature',
    cmd42: { functionName: 'WallThermostatControl', id: '42' },
    cmd43: 'SetComfortTemperature',
    cmd44: 'SetEcoTemperature',
    cmd50: { functionName: 'PushButtonState', id: '50' },
    cmd60: { functionName: 'ThermostatState', id: 60 },
    cmd70: { functionName: 'WallThermostatState', id: '70' },
    cmd82: 'SetDisplayActualTemperature',
    cmdF1: 'WakeUp',
    cmdF0: 'Reset',
};

/** Boost duration in minutes mapped to the value which is sent to the device */
const BOOST_DURATIONS: { minutes: number; value: number }[] = [
    { minutes: 0, value: 0 },
    { minutes: 5, value: 1 },
    { minutes: 10, value: 2 },
    { minutes: 15, value: 3 },
    { minutes: 20, value: 4 },
    { minutes: 25, value: 5 },
    { minutes: 30, value: 6 },
    { minutes: 60, value: 7 },
];

/** Pad a hex string to at least two digits */
function pad2(value: string): string {
    return value.length < 2 ? `0${value}` : value;
}

/** Events emitted by the MAX! driver */
export interface MaxDriverEvents {
    LOVF: [];
    culFirmwareVersion: [version: string];
    creditsReceived: [credits: string, credits1: string];
    credits: [credits: string | null, credits1: string | null];
    checkTimeIntervalFired: [];
    PairDevice: [data: PairDeviceData];
    ShutterContactStateReceived: [data: ShutterContactStateData];
    WallThermostatStateReceived: [data: WallThermostatStateData];
    WallThermostatControlReceived: [data: WallThermostatControlData];
    PushButtonStateReceived: [data: PushButtonStateData];
    ThermostatStateReceived: [data: ThermostatStateData];
    deviceRequestTimeInformation: [src: string];
}

/** Encodes and decodes MAX! packets and hands them over to the communication layer */
export class MaxDriver extends EventEmitter<MaxDriverEvents> {
    public readonly deviceTypes = DEVICE_TYPES;
    /** If true, new devices are accepted for pairing */
    public pairModeEnabled: boolean;

    private readonly logger: ioBroker.Logger;
    private readonly baseAddress: string;
    private readonly comLayer: CommunicationServiceLayer;
    private readonly checkTimeInterval: NodeJS.Timeout;
    private msgCount = 0;

    constructor(
        logger: ioBroker.Logger,
        baseAddress: string,
        pairModeEnabled: boolean,
        serialPortName: string,
        baudrate: number,
    ) {
        super();
        this.logger = logger;
        this.baseAddress = baseAddress;
        this.pairModeEnabled = pairModeEnabled;
        this.comLayer = new CommunicationServiceLayer(logger, baudrate, serialPortName, this.baseAddress);

        this.comLayer.on('culDataReceived', data => this.handleIncommingMessage(data));

        this.comLayer.on('LOVF', () => this.emit('LOVF'));

        this.comLayer.on('culFirmwareVersion', data => {
            this.emit('culFirmwareVersion', data);
            this.logger.info(`CUL FW Version: ${data}`);
        });

        this.comLayer.on('creditsReceived', (credits, credits1) => this.emit('creditsReceived', credits, credits1));

        this.checkTimeInterval = setInterval(() => this.emit('checkTimeIntervalFired'), 1000 * 60 * 60);
    }

    public connect(): Promise<void> {
        return this.comLayer.connect();
    }

    public disconnect(): Promise<void> | false {
        clearInterval(this.checkTimeInterval);
        return this.comLayer.disconnect();
    }

    /** Translate a raw command ID into the name of the handler. Returns an empty string for unhandled commands */
    public decodeCmdId(id: string): string {
        const entry = COMMAND_LIST[`cmd${id}`];
        if (entry && typeof entry === 'object') {
            return entry.functionName;
        }
        return '';
    }

    public handleIncommingMessage(message: string): void {
        const packet = this.parseIncommingMessage(message);

        if (!packet) {
            this.logger.debug('message was no valid MAX! paket.');
            return;
        }

        if (packet.credits !== null) {
            this.emit('credits', packet.credits, packet.credits1);
            return;
        }

        if (packet.getSource() === this.baseAddress) {
            this.logger.debug('ignored auto-ack packet');
            return;
        }

        switch (packet.getCommand()) {
            case 'PairPing':
                this.PairPing(packet);
                break;
            case 'PairPong':
                this.PairPong();
                break;
            case 'Ack':
                this.Ack(packet);
                break;
            case 'TimeInformation':
                this.TimeInformation(packet);
                break;
            case 'ShutterContactState':
                this.ShutterContactState(packet);
                break;
            case 'WallThermostatControl':
                this.WallThermostatControl(packet);
                break;
            case 'PushButtonState':
                this.PushButtonState(packet);
                break;
            case 'ThermostatState':
                this.ThermostatState(packet);
                break;
            case 'WallThermostatState':
                this.WallThermostatState(packet);
                break;
            default:
                this.logger.debug(`received unknown command id ${packet.getRawType()}`);
                break;
        }
    }

    public parseIncommingMessage(message: string): CulPacket | false {
        this.logger.debug(`decoding Message ${message}`);

        const credits = message.match(/^(\d+)\w+(\d+)$/);
        if (credits) {
            const creditsPacket = new CulPacket();
            creditsPacket.credits = credits[1];
            creditsPacket.credits1 = credits[2];
            return creditsPacket;
        }

        message = message.replace(/\n/, '');
        message = message.replace(/\r/, '');

        let rssi = parseInt(message.slice(-2), 16);
        if (rssi >= 128) {
            rssi = (rssi - 256) / 2 - 74;
        } else {
            rssi = rssi / 2 - 74;
        }
        this.logger.debug(`RSSI for Message: ${rssi}`);

        message = message.substring(0, message.length - 2);
        const data = message.split(/Z(..)(..)(..)(..)(......)(......)(..)(..+)/);
        data.shift();
        if (data.length <= 1) {
            this.logger.debug('cannot split packet');
            return false;
        }

        const packet = new CulPacket();
        packet.setLength(parseInt(data[0], 16));
        if (2 * packet.getLength() + 3 !== message.length) {
            this.logger.debug('packet length missmatch');
            return false;
        }
        packet.setMessageCount(parseInt(data[1], 16));
        packet.setFlag(parseInt(data[2], 16));
        packet.setGroupId(parseInt(data[6], 16));
        packet.setRawType(data[3]);
        packet.setSource(data[4]);
        packet.setDest(data[5]);
        packet.setRawPayload(data[7]);
        packet.setForMe(this.baseAddress === packet.getDest());
        packet.setCommand(this.decodeCmdId(data[3]));
        packet.setStatus('incomming');
        packet.rssi = rssi;
        return packet;
    }

    public sendMsg(
        cmdId: string,
        src: string,
        dest: string,
        payload: string,
        groupId: string,
        flags: string,
        deviceType: string | number,
    ): Promise<boolean | void> {
        const packet = new CulPacket();
        packet.setCommand(cmdId);
        packet.setSource(src);
        packet.setDest(dest);
        packet.setRawPayload(payload);
        packet.setGroupId(parseInt(groupId, 16));
        packet.setFlag(parseInt(flags, 16));
        // The message counter is one byte and must be increased for every new message, so that the
        // receiver can tell a new message apart from a retransmission (a retransmit keeps its counter).
        this.msgCount = (this.msgCount + 1) & 0xff;
        packet.setMessageCount(this.msgCount);
        packet.setRawType(deviceType);

        const data = sprintf('%02x', packet.getMessageCount()) + flags + cmdId + src + dest + groupId + payload;
        packet.setRawPacket(sprintf('%02x', data.length / 2) + data);

        return new Promise<boolean>((resolve, reject) => {
            packet.resolve = resolve;
            packet.reject = reject;
            this.comLayer.addPacketToTransportQueue(packet);
        }).catch(error => {
            this.logger.info(error);
        });
    }

    public getCredits(): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            const packet = new CulPacket();
            packet.resolve = resolve;
            packet.reject = reject;
            packet.getCredits = true;
            this.comLayer.addPacketToTransportQueue(packet);
        });
    }

    public generateTimePayload(): string {
        const now = moment();
        const sec = now.seconds();
        const min = now.minutes();
        const hour = now.hours();
        const day = now.date();
        const month = now.month() + 1;
        const year = now.diff('2000-01-01', 'years');
        const compressedOne = min | ((month & 0x0c) << 4);
        const compressedTwo = sec | ((month & 0x03) << 6);

        return (
            sprintf('%02x', year) +
            sprintf('%02x', day) +
            sprintf('%02x', hour) +
            sprintf('%02x', compressedOne) +
            sprintf('%02x', compressedTwo)
        );
    }

    public sendTimeInformation(dest: string, deviceType?: string | number): Promise<boolean | void> {
        const payload = this.generateTimePayload();
        return this.sendMsg('03', this.baseAddress, dest, payload, '00', '04', deviceType || '');
    }

    public sendSetDisplayActualTemperature(dest: string, isDisplay: unknown): Promise<boolean | void> {
        return this.sendMsg('82', this.baseAddress, dest, isDisplay ? '04' : '00', '00', '04', 3);
    }

    public sendConfig(
        dest: string,
        comfortTemperature: number,
        ecoTemperature: number,
        minimumTemperature: number,
        maximumTemperature: number,
        offset: number | string,
        windowOpenTime: number,
        windowOpenTemperature: number,
        deviceType: string | number,
    ): Promise<boolean> {
        const payload =
            sprintf('%02x', comfortTemperature * 2) +
            sprintf('%02x', ecoTemperature * 2) +
            sprintf('%02x', maximumTemperature * 2) +
            sprintf('%02x', minimumTemperature * 2) +
            sprintf('%02x', (parseFloat(String(offset)) + 3.5) * 2) +
            sprintf('%02x', windowOpenTemperature * 2) +
            sprintf('%02x', Math.ceil(windowOpenTime / 5));

        void this.sendMsg('11', this.baseAddress, dest, payload, '00', '00', deviceType);
        return Promise.resolve(true);
    }

    public sendDesiredTemperature(
        dest: string,
        temperature: number | null | undefined,
        mode: number | string,
        groupId: string,
        deviceType: string | number,
    ): Promise<boolean | void> {
        const modeNum = parseInt(String(mode), 10);
        let modeBin: string;
        switch (modeNum) {
            case 0: // auto weekly
                modeBin = '00';
                break;
            case 1: // manual
                modeBin = '01';
                break;
            case 2: // vacation
                modeBin = '10';
                break;
            case 3: // boost
                modeBin = '11';
                break;
            case 4: // manual eco
                modeBin = '02';
                break;
            case 5: // manual comfort
                modeBin = '03';
                break;
            case 6: // manual window
                modeBin = '04';
                break;
            default:
                modeBin = '00';
                break;
        }

        let temp = temperature === null ? 0 : temperature;
        if (temp !== undefined) {
            if (temp <= 4.5) {
                temp = 4.5;
            }
            if (temp >= 30.5) {
                temp = 30.5;
            }
        }

        let payloadHex: string;
        if (modeNum === 0 && (temp === undefined || modeBin === '00')) {
            payloadHex = '00';
        } else if (modeBin === '02') {
            payloadHex = '41';
        } else if (modeBin === '03') {
            payloadHex = '42';
        } else if (modeBin === '04') {
            payloadHex = '43';
        } else {
            const temperatureBinary = `000000${(temp! * 2).toString(2)}`.substr(-6);
            payloadHex = sprintf('%02x', parseInt(modeBin + temperatureBinary, 2));
        }

        if (groupId === '00') {
            return this.sendMsg('40', this.baseAddress, dest, payloadHex, '00', '00', deviceType);
        }
        return this.sendMsg('40', this.baseAddress, dest, payloadHex, groupId, '04', deviceType);
    }

    public sendConfigValve(
        dest: string,
        boostDuration: number | string,
        boostValvePosition: number | string,
        decalcificationDay: number | string,
        decalcificationHour: number | string,
        maxValveSetting: number | string,
        valveOffset: number | string,
        groupId: string,
        deviceType: string | number,
    ): Promise<boolean | void> {
        let boostValvePositionNum = parseInt(String(boostValvePosition), 10);
        if (boostValvePositionNum > 100) {
            boostValvePositionNum = 100;
        }
        if (boostValvePositionNum < 0) {
            boostValvePositionNum = 0;
        }

        let boostDurationNum = parseInt(String(boostDuration), 10);
        if (boostDurationNum < 0) {
            boostDurationNum = 0;
        }
        if (boostDurationNum > 60) {
            boostDurationNum = 60;
        }
        for (const step of BOOST_DURATIONS) {
            if (boostDurationNum <= step.minutes) {
                boostDurationNum = step.value;
                break;
            }
        }

        let decalcificationDayNum = parseInt(String(decalcificationDay), 10);
        if (decalcificationDayNum < 0 || decalcificationDayNum > 6) {
            decalcificationDayNum = 0;
        }

        let decalcificationHourNum = parseInt(String(decalcificationHour), 10);
        if (decalcificationHourNum < 0 || decalcificationHourNum > 23) {
            decalcificationHourNum = 0;
        }

        let maxValveSettingNum = parseInt(String(maxValveSetting), 10);
        if (maxValveSettingNum > 100) {
            maxValveSettingNum = 100;
        }
        if (maxValveSettingNum < 0) {
            maxValveSettingNum = 0;
        }

        let valveOffsetNum = parseInt(String(valveOffset), 10);
        if (valveOffsetNum > 100) {
            valveOffsetNum = 100;
        }
        if (valveOffsetNum < 0) {
            valveOffsetNum = 0;
        }

        const boost = ((boostDurationNum << 5) | Math.round(boostValvePositionNum / 5)) & 0xff;
        const decalc = ((decalcificationDayNum << 5) | decalcificationHourNum) & 0xff;
        maxValveSettingNum = Math.floor((maxValveSettingNum * 255) / 100);
        valveOffsetNum = Math.floor((valveOffsetNum * 255) / 100);

        const payloadHex =
            pad2(boost.toString(16)) +
            pad2(decalc.toString(16)) +
            pad2(maxValveSettingNum.toString(16)) +
            pad2(valveOffsetNum.toString(16));

        const group = pad2(groupId);
        if (group === '00') {
            return this.sendMsg('12', this.baseAddress, dest, payloadHex, '00', '00', deviceType);
        }
        return this.sendMsg('12', this.baseAddress, dest, payloadHex, group, '04', deviceType);
    }

    /**
     * Encode one set point of a week profile.
     * Returns `null` if the set point is not configured and the caller has to repeat the previous one.
     */
    private encodeSetPoint(setPTemp: number | string, setPTime: string): string | null {
        if (setPTemp === 0 || setPTime === '') {
            return null;
        }
        let temp = parseInt(String(setPTemp), 10);
        if (temp <= 4.5) {
            temp = 4.5;
        }
        if (temp >= 30.5) {
            temp = 30.5;
        }
        const time = parseInt(setPTime.slice(0, 2)) * 12 + Math.round(parseInt(setPTime.slice(3, 5)) / 5);
        const setPointByteOne = (((temp * 2) << 1) | (time >> 8)).toString(16);
        const setPointByteTwo = (time & 0xff).toString(16);
        return (
            (setPointByteOne.length === 1 ? `0${setPointByteOne}` : setPointByteOne) +
            (setPointByteTwo.length === 1 ? `0${setPointByteTwo}` : setPointByteTwo)
        );
    }

    /** Build the payload of a week profile message out of the given set points */
    private buildProfilePayload(
        prefix: string,
        weekDay: number | string,
        setPoints: [number | string, string][],
    ): string {
        let payloadHex = `${prefix}${parseInt(String(weekDay), 10).toString(16)}`;

        setPoints.forEach(([setPTemp, setPTime], index) => {
            const encoded = this.encodeSetPoint(setPTemp, setPTime);
            if (encoded) {
                payloadHex += encoded;
            } else if (index === 0) {
                payloadHex += '4520';
            } else {
                payloadHex += payloadHex.substr(-4);
            }
        });

        return payloadHex;
    }

    /** Send the set points 1 - 7 of one week day */
    public sendProfileDay(
        dest: string,
        weekDay: number | string,
        setPTemp1: number | string,
        setPTime1: string,
        setPTemp2: number | string,
        setPTime2: string,
        setPTemp3: number | string,
        setPTime3: string,
        setPTemp4: number | string,
        setPTime4: string,
        setPTemp5: number | string,
        setPTime5: string,
        setPTemp6: number | string,
        setPTime6: string,
        setPTemp7: number | string,
        setPTime7: string,
        groupId: string,
        deviceType: string | number,
    ): Promise<boolean | void> {
        const payloadHex = this.buildProfilePayload('0', weekDay, [
            [setPTemp1, setPTime1],
            [setPTemp2, setPTime2],
            [setPTemp3, setPTime3],
            [setPTemp4, setPTime4],
            [setPTemp5, setPTime5],
            [setPTemp6, setPTime6],
            [setPTemp7, setPTime7],
        ]);

        const group = pad2(groupId);
        return this.sendMsg('10', this.baseAddress, dest, payloadHex, group, group === '00' ? '00' : '04', deviceType);
    }

    /** Send the set points 8 - 13 of one week day */
    public sendProfileDay2(
        dest: string,
        weekDay: number | string,
        setPTemp8: number | string,
        setPTime8: string,
        setPTemp9: number | string,
        setPTime9: string,
        setPTemp10: number | string,
        setPTime10: string,
        setPTemp11: number | string,
        setPTime11: string,
        setPTemp12: number | string,
        setPTime12: string,
        setPTemp13: number | string,
        setPTime13: string,
        groupId: string,
        deviceType: string | number,
    ): Promise<boolean | void> {
        const payloadHex = this.buildProfilePayload('1', weekDay, [
            [setPTemp8, setPTime8],
            [setPTemp9, setPTime9],
            [setPTemp10, setPTime10],
            [setPTemp11, setPTime11],
            [setPTemp12, setPTime12],
            [setPTemp13, setPTime13],
        ]);

        const group = pad2(groupId);
        return this.sendMsg('10', this.baseAddress, dest, payloadHex, group, group === '00' ? '00' : '04', deviceType);
    }

    public sendVacation(
        dest: string,
        temperature: number,
        mode: number | string,
        untilDate: string,
        groupId: string,
        deviceType: string | number,
    ): Promise<boolean | void> | void {
        const untilDateNum = untilDate.match(/\d/g);
        const modeBin = parseInt(String(mode), 10).toString(2);

        if (untilDateNum === null) {
            this.logger.warn('No "untilDate" defined in "vacationConfig"');
            return;
        }

        let temp = temperature;
        if (temp <= 4.5) {
            temp = 4.5;
        }
        if (temp >= 30.5) {
            temp = 30.5;
        }

        const untilString = untilDateNum.join('');
        const untilYear = parseInt(untilString.slice(6, 8), 10);
        const untilMonth = parseInt(untilString.slice(2, 4), 10);
        const untilDay = parseInt(untilString.slice(0, 2), 10);
        const untilHour = parseInt(untilString.slice(8, 10), 10);
        const untilMinute = parseInt(untilString.slice(10, 12), 10);

        const temperatureBinary = `000000${(temp * 2).toString(2)}`.substr(-6);
        const payloadHex =
            sprintf('%02x', parseInt(modeBin + temperatureBinary, 2)) +
            pad2((((untilMonth >> 1) << 5) | untilDay).toString(16)) +
            pad2((((untilMonth & 0x1) << 7) | untilYear).toString(16)) +
            pad2((untilHour * 2 + untilMinute / 30).toString(16));

        if (groupId === '00') {
            return this.sendMsg('40', this.baseAddress, dest, payloadHex, '00', '00', deviceType);
        }
        return this.sendMsg('40', this.baseAddress, dest, payloadHex, groupId, '04', deviceType);
    }

    public parseTemperature(temperature: number | string): number | string {
        if (temperature === 'on') {
            return 30.5;
        }
        if (temperature === 'off') {
            return 4.5;
        }
        return temperature;
    }

    public PairPing(packet: CulPacket): void {
        this.logger.debug('handling PairPing packet');
        if (packet.getRawPayload().length <= 25) {
            this.logger.debug('Ignore PairPing. Payload is incomplete.');
            return;
        }
        if (!this.pairModeEnabled) {
            this.logger.debug(', but pairing is disabled so ignore');
            return;
        }

        const payloadBuffer = Buffer.from(packet.getRawPayload(), 'hex');
        const payloadParser = new BinaryParser().uint8('firmware').uint8('type').uint8('test');
        const temp = payloadParser.parse(payloadBuffer);

        packet.setDecodedPayload(temp);

        this.emit('PairDevice', {
            src: packet.getSource(),
            type: Number(temp.type),
            raw: packet.getRawPayload(),
            rssi: packet.rssi,
        });

        if (packet.getDest() !== '000000' && !packet.getForMe()) {
            this.logger.debug('handled PairPing packet is not for us');
        } else if (packet.getForMe()) {
            this.logger.debug(`beginn repairing with device ${packet.getSource()}`);
            void this.sendMsg('01', this.baseAddress, packet.getSource(), '00', '00', '00', '');
        } else if (packet.getDest() === '000000') {
            this.logger.debug(`beginn pairing of a new device with deviceId ${packet.getSource()}`);
            void this.sendMsg('01', this.baseAddress, packet.getSource(), '00', '00', '00', '');
        }
    }

    public PairPong(): void {
        this.logger.debug('Ignore not requested pairing pong');
    }

    public Ack(packet: CulPacket): void {
        const payloadBuffer = Buffer.from(packet.getRawPayload(), 'hex');
        const payloadParser = new BinaryParser().uint8('state');
        const temp = payloadParser.parse(payloadBuffer);
        packet.setDecodedPayload(temp.state);
        if (packet.getDecodedPayload() === 1) {
            this.logger.debug(`got OK-ACK Packet from ${packet.getSource()}`);
            this.comLayer.ackPacket();
            return;
        }
        this.logger.debug(
            `got ACK Error (Invalid command/argument) from ${packet.getSource()} with payload ${packet.getRawPayload()}`,
        );
    }

    public ShutterContactState(packet: CulPacket): void {
        const rawBitData = new BitSet(`0x${packet.getRawPayload().substr(0, 2)}`);
        const shutterContactState: ShutterContactStateData = {
            src: packet.getSource(),
            isOpen: rawBitData.get(1),
            rfError: rawBitData.get(6),
            batteryLow: rawBitData.get(7),
            rssi: packet.rssi,
        };
        this.logger.debug(`got data from shutter contact ${packet.getSource()} ${rawBitData.toString()}`);
        this.emit('ShutterContactStateReceived', shutterContactState);
    }

    public WallThermostatState(packet: CulPacket): void {
        this.logger.debug(
            `got data from wallthermostat state ${packet.getSource()} with payload ${packet.getRawPayload()}`,
        );
        //18002A00E8
        //18002A00E6
        //18002200E7
        const rawPayload = packet.getRawPayload();

        if (rawPayload.length < 10) {
            this.logger.debug('Ignore WallThermostatState. Payload is incomplete');
            return;
        }

        const rawPayloadBuffer = Buffer.from(rawPayload, 'hex');

        const payloadParser = new BinaryParser()
            .uint8('bits')
            .uint8('displaymode')
            .uint8('desiredRaw')
            .uint16('heaterTemperature');

        const rawData = payloadParser.parse(rawPayloadBuffer);
        const rawBitData = new BitSet(rawData.bits);

        const wallThermostatState: WallThermostatStateData = {
            src: packet.getSource(),
            mode: rawBitData.slice(0, 1).toString(16),
            desiredTemperature: rawData.desiredRaw / 2.0,
            measuredTemperature: rawData.heaterTemperature / 10.0,
            dstSetting: rawBitData.get(3),
            lanGateway: rawBitData.get(4),
            panel: rawBitData.get(5),
            rfError: rawBitData.get(6),
            batteryLow: rawBitData.get(7),
        };
        this.emit('WallThermostatStateReceived', wallThermostatState);
    }

    public WallThermostatControl(packet: CulPacket): void {
        if (packet.getRawPayload().length <= 3) {
            this.logger.debug('Ignore WallThermostatControl. Payload is incomplete.');
            return;
        }
        const desiredRaw = parseInt(packet.getRawPayload().substr(0, 2), 16);
        const measuredRaw = parseInt(packet.getRawPayload().substr(2, 2), 16);
        const desired = (desiredRaw & 0x7f) / 2.0;
        const measured = (((desiredRaw & 0x80) << 1) | measuredRaw) / 10.0;

        this.logger.debug(
            `got data from wallthermostat ${packet.getSource()} desired temp: ${desired} - measured temp: ${measured}`,
        );

        const wallThermostatControl: WallThermostatControlData = {
            src: packet.getSource(),
            desiredTemperature: desired,
            measuredTemperature: measured,
        };
        this.emit('WallThermostatControlReceived', wallThermostatControl);
    }

    public PushButtonState(packet: CulPacket): void {
        const rawBitData = new BitSet(`0x${packet.getRawPayload().substr(2, 2)}`);
        const pushButtonState: PushButtonStateData = {
            src: packet.getSource(),
            pressed: rawBitData.get(0),
            rfError: rawBitData.get(6),
            batteryLow: rawBitData.get(7),
            rssi: packet.rssi,
        };
        this.logger.debug(`got data from push button ${packet.getSource()} ${rawBitData.toString()}`);
        this.emit('PushButtonStateReceived', pushButtonState);
    }

    public ThermostatState(packet: CulPacket): void {
        this.logger.debug(`got data from heatingelement ${packet.getSource()} with payload ${packet.getRawPayload()}`);

        const rawPayload = packet.getRawPayload();
        if (rawPayload.length < 10) {
            this.logger.debug('Ignore ThermostatState. Payload is incomplete');
            return;
        }

        const rawPayloadBuffer = Buffer.from(rawPayload, 'hex');
        let payloadParser: BinaryParser;
        if (rawPayload.length === 10) {
            payloadParser = new BinaryParser()
                .uint8('bits')
                .uint8('valvePosition')
                .uint8('desiredTemp')
                .uint8('untilOne')
                .uint8('untilTwo');
        } else {
            payloadParser = new BinaryParser()
                .uint8('bits')
                .uint8('valvePosition')
                .uint8('desiredTemp')
                .uint8('untilOne')
                .uint8('untilTwo')
                .uint8('untilThree');
        }

        const rawData = payloadParser.parse(rawPayloadBuffer);
        const rawBitData = new BitSet(rawData.bits);
        const rawMode = rawBitData.slice(0, 1).toString(16);

        let calculatedMeasuredTemperature: number;
        if (rawData.untilTwo && rawMode !== '2') {
            calculatedMeasuredTemperature = (((rawData.untilOne & 0x01) << 8) + rawData.untilTwo) / 10;
        } else {
            calculatedMeasuredTemperature = 0;
        }
        if (calculatedMeasuredTemperature !== 0 && calculatedMeasuredTemperature < 1) {
            calculatedMeasuredTemperature = 0;
        }

        let untilString = '';
        if (rawData.untilThree && rawMode === '2') {
            untilString = this.ParseDateTime(rawData.untilOne, rawData.untilTwo, rawData.untilThree).dateString;
        }

        const thermostatState: ThermostatStateData = {
            src: packet.getSource(),
            mode: rawMode,
            desiredTemperature: (rawData.desiredTemp & 0x7f) / 2.0,
            valvePosition: rawData.valvePosition,
            dstSetting: rawBitData.get(3),
            lanGateway: rawBitData.get(4),
            panel: rawBitData.get(5),
            rfError: rawBitData.get(6),
            batteryLow: rawBitData.get(7),
            untilDate: untilString,
            rssi: packet.rssi,
        };
        if (calculatedMeasuredTemperature !== 0) {
            thermostatState.measuredTemperature = calculatedMeasuredTemperature;
        }

        this.emit('ThermostatStateReceived', thermostatState);
    }

    public TimeInformation(packet: CulPacket): void {
        this.logger.debug(`got time information request from device ${packet.getSource()}`);
        this.emit('deviceRequestTimeInformation', packet.getSource());
    }

    public ParseDateTime(
        byteOne: number,
        byteTwo: number,
        byteThree: number,
    ): { day: string; month: string; year: string; time: string; dateString: string } {
        const day = `0${byteOne & 0x1f}`.slice(-2);
        const month = `0${((byteOne & 0xe0) >> 4) | (byteTwo >> 7)}`.slice(-2);
        const year = `20${byteTwo & 0x3f}`;
        const rawTime = byteThree & 0x3f;
        const hours = `0${Math.floor(rawTime / 2)}`.slice(-2);
        const time = rawTime % 2 ? `${hours}:30` : `${hours}:00`;

        return { day, month, year, time, dateString: `${day}-${month}-${year} ${time}` };
    }
}
