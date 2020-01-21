import Koa from 'koa';
import KoaRouter from 'koa-router';
import RawBody from 'raw-body';
import winston from 'winston';
import { Packet, StatusData } from './packet';

const BOILER_PORT = process.env.BOILER_PORT ? ( process.env.BOILER_PORT as any | 0) : 9105;
const RESTAPI_PORT = process.env.RESTAPI_PORT ? ( process.env.RESTAPI_PORT as any | 0) : 8081;
const TIMEOUT = 10 * 1000;

const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            level: 'info',
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        new winston.transports.File({ filename: 'log.log' })
    ]
});

let boilerApp = new Koa();
let boilerRouter = new KoaRouter();

let boilerState: StatusData = null;
let lastBoilerTime = 0;

let commandQueue: { (resp: StatusData): void }[] = [];

boilerApp.use(async (ctx, next) => {
    try {
        await next();
    } catch (e) {
        logger.error(e);
        ctx.status = 200;
        ctx.type = "text/plain";
        ctx.body = '';
    }
});

boilerRouter.post('/register', async (ctx) => {
    let body = (await RawBody(ctx.req)).toString();

    logger.debug(`received from boiler ${body}`);

    let packet = new Packet().parse(body);
    if (packet.prefix !== "re0000" || packet.command !== 0x01) {
        logger.error(`Invalid packet ${body}`);
        return;
    }

    logger.info(`registered serial ${packet.data}`);

    let respPacket = new Packet();
    respPacket.command = 0x01;
    respPacket.prefix = "re0100";
    respPacket.data = "1".repeat(32); // Dummy Token

    ctx.type = "text/plain";
    ctx.body = respPacket.build();

    logger.info(`registered serial ${packet.data}`);
});
boilerRouter.post('/state', async (ctx) => {
    let body = (await RawBody(ctx.req)).toString();

    logger.debug(`received from boiler ${body}`);

    let packet = new Packet().parse(body);
    if (packet.prefix !== "re0101" || packet.command !== 0x01) {
        logger.error(`Invalid packet ${body}`);
        return;
    }

    let statusData = new StatusData().parse(packet.data);
    let oldState = boilerState;
    boilerState = statusData;
    lastBoilerTime = Date.now();
    onChangeState(oldState, boilerState);

    let respStatusData = new StatusData().parse(packet.data);
    let respPacket = new Packet();
    respPacket.command = packet.command;
    respPacket.prefix = packet.prefix;

    respStatusData.setCurrentTime();

    if (commandQueue.length) {
        respPacket.prefix = "sm0101";
        commandQueue.forEach((cb) => cb(respStatusData));
        commandQueue = [];
    }

    respPacket.data = respStatusData.build();
    ctx.type = "text/plain";
    ctx.body = respPacket.build();
    logger.debug(`send to boiler ${ctx.body}`);
});

function onChangeState(oldState: StatusData, newState: StatusData) {
    for (let i in oldState) {
        if ((oldState as any)[i] !== (newState as any)[i]) {
            logger.info(`property changed ${i} ${(oldState as any)[i]} => ${(newState as any)[i] }`);
        }
    }
}

boilerApp.use(boilerRouter.routes()).use(boilerRouter.allowedMethods()).listen(BOILER_PORT);


let restApp = new Koa();
let restRouter = new KoaRouter();

function isBoilerConnected() {
    return (Date.now() - lastBoilerTime) < TIMEOUT;
}

function sendCommand(cb: (resp: StatusData) => void) {
    return new Promise((resolve, reject) => {
        if (!isBoilerConnected()) return reject(new Error("dead"));
        let timer: NodeJS.Timeout = null;
        let done = (state: StatusData) => {
            if (done === null) return;
            clearTimeout(timer);
            resolve();
            cb(state);
        };
        timer = setTimeout(() => {
            let pos = commandQueue.indexOf(done);
            if (pos !== -1) {
                commandQueue.splice(pos, 1);
            }
            done = null;
            reject(new Error("timeout"));
        }, TIMEOUT);
        commandQueue.push(done);
    });
}

restApp.use(async (ctx, next) => {
    try {
        await next();
    } catch (e) {
        ctx.status = 400;
        ctx.type = "text/plain";
        ctx.body = e.message;
    }
});

restRouter.get("/", async (ctx) => {
    if (!isBoilerConnected()) {
        ctx.status = 410;
        ctx.body = "Boiler gone";
        return;
    }
    ctx.type = "json";
    ctx.body = JSON.stringify(boilerState, null, 4);
});

restRouter.put("/power/on", async (ctx) => {
    await sendCommand((state) => {
        state.isPowerOn = true;
    });
    ctx.body = '';
});

restRouter.put("/power/off", async (ctx) => {
    await sendCommand((state) => {
        state.isPowerOn = false;
    });
    ctx.body = '';
});

restRouter.put("/desiredtemp", async (ctx) => {
    let temp = ctx.query.temp | 0;
    if (temp < 15 || 30 < temp) {
        throw new Error("invalid temp");
    }
    await sendCommand((state) => {
        state.desiredRoomTemp = temp;
        state.desiredHeatWaterTemp = temp;
    });
    ctx.body = '';
});

restRouter.put("/preheat/on", async (ctx) => {
    await sendCommand((state) => {
        state.isPreHeat = true;
    });
    ctx.body = '';
});

restRouter.put("/preheat/off", async (ctx) => {
    await sendCommand((state) => {
        state.isPreHeat = false;
    });
    ctx.body = '';
});

restRouter.put("/quickheat/on", async (ctx) => {
    await sendCommand((state) => {
        state.isQuickHeat = true;
    });
    ctx.body = '';
});

restRouter.put("/quickheat/off", async (ctx) => {
    await sendCommand((state) => {
        state.isQuickHeat = false;
    });
    ctx.body = '';
});

restRouter.put("/heat/on", async (ctx) => {
    await sendCommand((state) => {
        state.isHeatOn = true;
    });
    ctx.body = '';
});

restRouter.put("/heat/off", async (ctx) => {
    await sendCommand((state) => {
        state.isHeatOn = false;
    });
    ctx.body = '';
});

restRouter.put("/hotwater/on", async (ctx) => {
    await sendCommand((state) => {
        state.isHotWaterOn = true;
    });
    ctx.body = '';
});

restRouter.put("/hotwater/off", async (ctx) => {
    await sendCommand((state) => {
        state.isHotWaterOn = false;
    });
    ctx.body = '';
});


restRouter.put("/goout/on", async (ctx) => {
    await sendCommand((state) => {
        state.isGoOut = 0x80;
    });
    ctx.body = '';
});

restRouter.put("/goout/off", async (ctx) => {
    await sendCommand((state) => {
        state.isGoOut = 0;
    });
    ctx.body = '';
});

restApp.use(restRouter.routes()).use(restRouter.allowedMethods()).listen(RESTAPI_PORT);
