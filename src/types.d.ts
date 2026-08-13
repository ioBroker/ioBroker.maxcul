/** Configuration of the maxcul adapter. See `admin/jsonConfig.json` */
export interface MaxCulAdapterConfig {
    /** How the CUL is connected: `serial` for a CUL stick, `network` for a CUN/CUNO */
    connectionType: 'serial' | 'network';
    /** Name/path of the serial port the CUL stick is attached to. `DEBUG` starts the adapter with simulated devices */
    serialport: string;
    /** Baud rate of the CUL stick */
    baudrate: number | string;
    /** Host name or IP address of the CUN/CUNO. Only used if `connectionType` is `network` */
    host: string;
    /** TCP port culfw is listening on. Only used if `connectionType` is `network` */
    port: number | string;
    /** 6 digit HEX address this adapter uses as "cube" address */
    baseAddress: string;
    /** Polling interval in minutes. 0 disables the polling */
    scanner: number;
}

/** Properties every MAX! device payload has in common */
export interface MaxDeviceInfo {
    /** 6 digit HEX address of the device */
    src: string;
    /** Device type: 1 = HeatingThermostat, 2 = HeatingThermostatPlus, 3 = WallMountedThermostat, 4 = ShutterContact, 5 = PushButton */
    type?: number;
    /** Serial number of the device. Falls back to the uppercase `src` */
    serial?: string;
    /** Raw payload of the pairing packet */
    raw?: string;
    /** Signal strength of the received packet in dBm */
    rssi?: number;
}

export interface ThermostatStateData extends MaxDeviceInfo {
    mode: string | number;
    desiredTemperature: number;
    valvePosition: number;
    measuredTemperature?: number;
    dstSetting: number;
    lanGateway: number;
    panel: number;
    rfError: number;
    batteryLow: number;
    untilDate: string;
}

export interface WallThermostatStateData extends MaxDeviceInfo {
    mode: string | number;
    desiredTemperature: number;
    measuredTemperature: number;
    dstSetting: number;
    lanGateway: number;
    panel: number;
    rfError: number;
    batteryLow: number;
}

export interface WallThermostatControlData extends MaxDeviceInfo {
    desiredTemperature: number;
    measuredTemperature: number;
}

export interface ShutterContactStateData extends MaxDeviceInfo {
    isOpen: number;
    rfError: number;
    batteryLow: number;
}

export interface PushButtonStateData extends MaxDeviceInfo {
    pressed: number;
    rfError: number;
    batteryLow: number;
}

export interface PairDeviceData extends MaxDeviceInfo {
    type: number;
    raw: string;
}

/** Any payload emitted by the MAX! driver for a single device */
export type MaxDeviceData =
    | ThermostatStateData
    | WallThermostatStateData
    | WallThermostatControlData
    | ShutterContactStateData
    | PushButtonStateData
    | PairDeviceData;

/**
 * ioBroker object as it is cached by the adapter.
 * `lastReceived` is stored on the cached copy only and never written to the objects DB.
 */
export type MaxObject = (ioBroker.StateObject | ioBroker.ChannelObject) & { lastReceived?: number };

/**
 * Values collected for one channel before they are sent to the device.
 * The keys are the state names below the channel, so they cannot be typed exactly.
 */
export interface ChannelTimer {
    /** Debounce timer which triggers the transmission */
    timer?: NodeJS.Timeout | null;
    [state: string]: any;
}

/** Queued write of a state or an object */
export type Task =
    { type: 'state'; id: string; val: ioBroker.StateValue } | { type: 'object'; id: string; obj: MaxObject };
