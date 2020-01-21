class PacketReader {
    private buffer: string;
    private position: number;
    constructor(buffer: string) {
        this.buffer = buffer;
        this.position = 0;
    }
    readHexValue() {
        if (this.buffer.length < (this.position + 2)) throw new Error("out of range");
        let val = parseInt(this.buffer.substr(this.position, 2), 16);
        this.position += 2;
        return val;
    }
    readString(len: number) {
        if (this.buffer.length < (this.position + len)) throw new Error("out of range");
        let val = this.buffer.substr(this.position, len);
        this.position += len;
        return val;
    }
    ensureEOF() {
        if (this.position !== this.buffer.length) throw new Error("invalid packet size");
    }
}
class PacketBuilder {
    private buffer: string;
    constructor() {
        this.buffer = '';
    }
    appendFixedString(str: string, len: number) {
        if (str.length !== len) throw new Error("invalid string size");
        this.buffer += str;
    }
    appendHexValue(n: number) {
        n = n | 0;
        if (n < 0 || 0xff < n) throw new Error("out of range");
        this.buffer += n.toString(16).padStart(2, '0');
    }
    appendDecValue(n: number) {
        n = n | 0;
        if (n < 0 || 99 < n) throw new Error('out of range');
        this.buffer += n.toString(16).padStart(2, '0');
    }
    appendString(str: string) {
        this.buffer += str;
    }
    toString() {
        return this.buffer;
    }
};

export class Packet {
    public prefix: string;
    public command: number;
    public data: string;

    constructor() {
        this.prefix = 're0101';
        this.command = 0;
        this.data = '';
    }
    parse(packet: string) {
        let reader = new PacketReader(packet);

        this.prefix = reader.readString(6);
        this.command = reader.readHexValue();

        let dataLength = reader.readHexValue();
        this.data = reader.readString(dataLength);

        if (this.calcChecksum() !== reader.readHexValue()) throw new Error("invalid checksum");
        if (reader.readHexValue() != 0x7d) throw new Error("invalid tailer");
        reader.ensureEOF();
        return this;
    }
    build() {
        let builder = new PacketBuilder();
        builder.appendFixedString(this.prefix, 6);
        builder.appendHexValue(this.command);
        builder.appendHexValue(this.data.length);
        builder.appendString(this.data);
        builder.appendHexValue(this.calcChecksum());
        builder.appendHexValue(0x7d);
        return builder.toString();
    }
    calcChecksum() {
        let checksum = 0;
        for (let i = 0; i < this.data.length; i++) {
            checksum += this.data.charCodeAt(i);
        }
        return checksum % 256;
    }
}


export class StatusData {
    public isPowerOn: boolean;
    public isHeatMode: boolean;
    public isHeatOn: boolean;
    public isHotWaterOn: boolean;
    public isPreHeat: boolean;
    public isQuickHeat: boolean;
    public heatInfoUnk1: boolean;
    public heatInfoUnk2: boolean;

    public desiredRoomTemp: number;
    public desiredHeatWaterTemp: number;
    public desiredHotWaterTemp: number;

    public currentRoomTemp: number;
    public currentWaterTemp: number;

    public combustionState: number;
    public driveStatUnk1: boolean;
    public isHotWaterUsing: boolean;
    public driveStatUnk2: boolean;
    public driveStatUnk3: boolean;

    public unk1: string;

    public isGoOut: number;
    public modeData: number;
    public unk2: string;
    public reserveData: number;
    public unk3: string;
    public currentTime: string;
    public unk4: string;

    constructor() {
        this.isPowerOn = false;
        this.isHeatMode = false;
        this.isHeatOn = false;
        this.isHotWaterOn = false;
        this.isPreHeat = false;
        this.isQuickHeat = false;
        this.heatInfoUnk1 = false;
        this.heatInfoUnk2 = false;

        this.desiredRoomTemp = 0;
        this.desiredHeatWaterTemp = 0;
        this.desiredHotWaterTemp = 0;

        this.currentRoomTemp = 0;
        this.currentWaterTemp = 0;

        this.combustionState = 1;
        this.driveStatUnk1 = false;
        this.isHotWaterUsing = false;
        this.driveStatUnk2 = false;
        this.driveStatUnk3 = false;

        this.unk1 = "ffff";
        this.isGoOut = 0;
        this.modeData = 0;
        this.unk2 = "0000";
        this.reserveData = 0;
        this.unk3 = "0000000000000000000000000000000000000000000000000000000000000000000000";
        this.currentTime = "00000000000000";
        this.unk4 = "0000000000000000000000000000000000000000";
    }
    parse(data: string) {
        let reader = new PacketReader(data);
        {
            let val = reader.readHexValue();
            this.isPowerOn = !!(val & 0x01);
            this.isHeatMode = !!(val & 0x02);
            this.isHeatOn = !!(val & 0x04);
            this.isHotWaterOn = !!(val & 0x08);
            this.isPreHeat = !!(val & 0x10);
            this.isQuickHeat = !!(val & 0x20);
            this.heatInfoUnk1 = !!(val & 0x40);
            this.heatInfoUnk2 = !!(val & 0x80);
        }

        this.desiredRoomTemp = reader.readHexValue();
        this.desiredHeatWaterTemp = reader.readHexValue();
        {
            let val = reader.readHexValue();
            this.desiredHotWaterTemp = val & 0x7f;
            if (val & 0x80) this.desiredHotWaterTemp = 0.5;
        }
        
        this.currentRoomTemp = reader.readHexValue();
        this.currentWaterTemp = reader.readHexValue();

        {
            let val = reader.readHexValue();
            this.combustionState = val & 0x0f;
            this.driveStatUnk1 = !!(val & 0x10);
            this.isHotWaterUsing = !!(val & 0x20);
            this.driveStatUnk2 = !!(val & 0x40);
            this.driveStatUnk3 = !!(val & 0x80);
        }

        this.unk1 = reader.readString(4);
        this.isGoOut = reader.readHexValue();
        this.modeData = reader.readHexValue();
        this.unk2 = reader.readString(4);
        this.reserveData = reader.readHexValue();

        this.unk3 = reader.readString(70);

        this.currentTime = reader.readString(14);

        this.unk4 = reader.readString(40);

        reader.ensureEOF();

        return this;
    }
    build() {
        let builder = new PacketBuilder();
        {
            let val = 0;
            if (this.isPowerOn) val |= 0x01;
            if (this.isHeatMode) val |= 0x02;
            if (this.isHeatOn) val |= 0x04;
            if (this.isHotWaterOn) val |= 0x08;
            if (this.isPreHeat) val |= 0x10;
            if (this.isQuickHeat) val |= 0x20;
            if (this.heatInfoUnk1) val |= 0x40;
            if (this.heatInfoUnk2) val |= 0x80;

            builder.appendHexValue(val);
        }

        builder.appendHexValue(this.desiredRoomTemp);
        builder.appendHexValue(this.desiredHeatWaterTemp);
        {
            let val = this.desiredHotWaterTemp & 0x7f;
            if (val !== this.desiredHotWaterTemp) {
                val |= 0x80;
            }
            builder.appendHexValue(val);
        }

        builder.appendHexValue(this.currentRoomTemp);
        builder.appendHexValue(this.currentWaterTemp);

        {
            let val = this.combustionState & 0x0f;
            if (this.driveStatUnk1) val |= 0x10;
            if (this.isHotWaterUsing) val |= 0x20;
            if (this.driveStatUnk2) val |= 0x40;
            if (this.driveStatUnk3) val |= 0x80;

            builder.appendHexValue(val);
        }

        builder.appendFixedString(this.unk1, 4);
        builder.appendHexValue(this.isGoOut);
        builder.appendHexValue(this.modeData);
        builder.appendFixedString(this.unk2, 4);
        builder.appendHexValue(this.reserveData);
        builder.appendFixedString(this.unk3, 70);
        builder.appendFixedString(this.currentTime, 14);
        builder.appendFixedString(this.unk4, 40);
        return builder.toString();
    }
    setCurrentTime() {
        let builder = new PacketBuilder();
        let date = new Date();
        builder.appendDecValue(date.getMinutes());
        builder.appendDecValue(date.getHours());
        builder.appendDecValue(date.getDay());
        builder.appendDecValue(date.getDate());
        builder.appendDecValue(date.getMonth() + 1);
        builder.appendDecValue(date.getFullYear() % 100);
        builder.appendDecValue(date.getSeconds());
        this.currentTime = builder.toString();
    }
}
