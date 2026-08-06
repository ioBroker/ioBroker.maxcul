export type CulPacketStatus = 'new' | 'send' | 'incomming';

/** One MAX! radio packet which is sent to or was received from the CUL stick */
export class CulPacket {
    private length = 0;
    private messageCount = 0;
    private flag = 0;
    private groupid = 0;
    private source = '';
    private dest = '';
    private rawType: string | number = '';
    private rawPayload = '';
    private forMe = false;
    private command = '';
    private status: CulPacketStatus = 'new';
    private rawPacket = '';
    private sendTries = 0;
    private decodedPayload: unknown = null;

    /** If true, this packet does not carry data but only requests the remaining credits ("X") from the CUL */
    public getCredits = false;
    /** Remaining credits reported by the CUL */
    public credits: string | null = null;
    /** Credits used in the last hour reported by the CUL */
    public credits1: string | null = null;
    /** Signal strength of the received packet in dBm */
    public rssi?: number;
    /** Resolver of the promise which waits for this packet to be acknowledged */
    public resolve?: (value: boolean) => void;
    /** Rejecter of the promise which waits for this packet to be acknowledged */
    public reject?: (reason?: unknown) => void;

    public isCredits(): boolean {
        return this.getCredits;
    }

    public getLength(): number {
        return this.length;
    }

    public setLength(length: number): void {
        this.length = length;
    }

    public getMessageCount(): number {
        return this.messageCount;
    }

    public setMessageCount(messageCount: number): void {
        this.messageCount = messageCount;
    }

    public getFlag(): number {
        return this.flag;
    }

    public setFlag(flag: number): void {
        this.flag = flag;
    }

    public getGroupId(): number {
        return this.groupid;
    }

    public setGroupId(groupid: number): void {
        this.groupid = groupid;
    }

    public getSource(): string {
        return this.source;
    }

    public setSource(source: string): void {
        this.source = source.toLowerCase();
    }

    public getDest(): string {
        return this.dest;
    }

    public setDest(dest: string): void {
        this.dest = dest.toLowerCase();
    }

    public getRawType(): string | number {
        return this.rawType;
    }

    public setRawType(rawType: string | number): void {
        this.rawType = rawType;
    }

    public getForMe(): boolean {
        return this.forMe;
    }

    public setForMe(forMe: boolean): void {
        this.forMe = forMe;
    }

    public getCommand(): string {
        return this.command;
    }

    public setCommand(command: string): void {
        this.command = command;
    }

    public getStatus(): CulPacketStatus {
        return this.status;
    }

    public setStatus(status: CulPacketStatus): void {
        this.status = status;
    }

    public getRawPacket(): string {
        if (this.getCredits) {
            return 'X';
        }
        return this.rawPacket;
    }

    public setRawPacket(rawPacket: string): void {
        this.rawPacket = rawPacket;
    }

    public getRawPayload(): string {
        return this.rawPayload;
    }

    public setRawPayload(rawPayload: string): void {
        this.rawPayload = rawPayload.toUpperCase();
    }

    public getSendTries(): number {
        return this.sendTries;
    }

    public setSendTries(sendTries: number): void {
        this.sendTries = sendTries;
    }

    public getDecodedPayload(): unknown {
        return this.decodedPayload;
    }

    public setDecodedPayload(decodedPayload: unknown): void {
        this.decodedPayload = decodedPayload;
    }
}
