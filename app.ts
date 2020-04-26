import Koa from 'koa';
import KoaRouter from 'koa-router';
import RawBody from 'raw-body';
import winston from 'winston';
import * as mqtt from 'async-mqtt';

import { Packet, StatusData } from './packet';

const BOILER_PORT = process.env.BOILER_PORT ? ( process.env.BOILER_PORT as any | 0) : 9105;
const BOILER_HOST = process.env.BOILER_HOST ? process.env.BOILER_HOST : '127.0.0.1';
const RESTAPI_PORT = process.env.RESTAPI_PORT ? ( process.env.RESTAPI_PORT as any | 0) : 8081;
const RESTAPI_HOST = process.env.RESTAPI_HOST ? process.env.RESTAPI_HOST : '127.0.0.1';
const TIMEOUT = 10 * 1000;
const HASS_NODEID = 'open-rinnai-server';
const MQTT_TOPIC_PREFIX = 'open-rinnai-server';


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


let mqttClient = process.env.MQTT_CONFIG ? mqtt.connect(JSON.parse(process.env.MQTT_CONFIG)) : null;

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
    let changedKeys = new Set();
    for (let i in oldState) {
        if ((oldState as any)[i] !== (newState as any)[i]) {
            logger.info(`property changed ${i} ${(oldState as any)[i]} => ${(newState as any)[i] }`);
            changedKeys.add(i);
        }
    }
    if (!oldState) {
        publishAvailability();
    }
    if (!oldState || changedKeys.has('isPowerOn') || changedKeys.has('combustionState')) {
        publishAction();
    }
    if (!oldState || changedKeys.has('isGoOut')) {
        publishAwayMode();
    }
    if (!oldState || changedKeys.has('desiredRoomTemp')) {
        publishTargetTemperature();
    }
    if (!oldState || changedKeys.has('desiredHotWaterTemp')) {
        publishTargetHotWaterTemperature();
    }
    if (!oldState || changedKeys.has('currentRoomTemp')) {
        publishCurrentTemperature();
    }
    if (!oldState || changedKeys.has('isPowerOn') || changedKeys.has('isHeatOn') || changedKeys.has('isHotWaterOn')) {
        publishMode();
    }
    if (!oldState || changedKeys.has('isHotWaterUsing')) {
        publishIsHotWaterUsing();
    }
    if (!oldState || changedKeys.has('currentWaterTemp')) {
        publishCurrentWaterTemperature();
    }
    if (!oldState || changedKeys.size) {
        publishFullState();
    }
}

boilerApp.use(boilerRouter.routes()).use(boilerRouter.allowedMethods()).listen(BOILER_PORT, BOILER_HOST);


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

restRouter.put("/desiredhotwatertemp", async (ctx) => {
    let temp = ctx.query.temp | 0;
    if (temp < 40 || 60 < temp) {
        throw new Error("invalid temp");
    }
    await sendCommand((state) => {
        state.desiredHotWaterTemp = temp;
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
        if (state.isGoOut && state.isHeatOn) state.isHeatOn = false;
        else state.isGoOut = 0;
    });
    ctx.body = '';
});

restApp.use(restRouter.routes()).use(restRouter.allowedMethods()).listen(RESTAPI_PORT, RESTAPI_HOST);



let mqttReportedAvailability = false;

async function initialPublish() {
    await mqttClient.publish(`homeassistant/climate/${HASS_NODEID}/config`, JSON.stringify({
        action_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/action`,
        availability_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/availability`,
        away_mode_command_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_away_mode`,
        away_mode_state_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/away_mode`,
        temperature_command_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_target_temperature`,
        temperature_state_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/target_temperature`,
        temperature_low_command_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_target_temperature`,
        temperature_low_state_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/target_temperature`,
        temperature_high_state_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/target_hot_water_temperature`,
        temperature_high_command_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_target_hot_water_temperature`,
        current_temperature_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/current_temperature`,
        mode_state_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/mode`,
        mode_command_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_mode`,
        max_temp: 60,
        min_temp: 15,
        precision: 1,
        modes: ['off', 'cool', 'auto', 'heat', 'dry'],
        unique_id: HASS_NODEID,
        device: {
            "identifiers": [HASS_NODEID],
            "name": "OpenRinnai"
        },
        name: 'OpenRinnai'
    }));

    await mqttClient.publish(`homeassistant/binary_sensor/${HASS_NODEID}/water_using/config`, JSON.stringify({
        availability_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/availability`,
        device: {
            "identifiers": [HASS_NODEID],
            "name": "OpenRinnai"
        },
        name: 'OpenRinnai Water Using',
        unique_id: `${HASS_NODEID}_water_using`,
        device_class: "moisture",
        state_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/is_hot_water_using`
    }));

    await mqttClient.publish(`homeassistant/sensor/${HASS_NODEID}/current_water_temperature/config`, JSON.stringify({
        availability_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/availability`,
        device: {
            "identifiers": [HASS_NODEID],
            "name": "OpenRinnai"
        },
        name: 'OpenRinnai Current Temperature',
        unique_id: `${HASS_NODEID}_current_water_temperature`,
        unit_of_measurement:"°C",
        device_class: "temperature",
        state_topic: `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/current_water_temperature`
    }));

    mqttReportedAvailability = !isBoilerConnected();
    await publishAvailability();

    await publishAction();
    await publishAwayMode();
    await publishTargetTemperature();
    await publishTargetHotWaterTemperature();
    await publishCurrentTemperature();
    await publishCurrentWaterTemperature();
    await publishMode();
    await publishIsHotWaterUsing();
    await publishFullState();
}
async function publishAvailability() {
    if (!mqttClient) return;

    let current = isBoilerConnected();
    if (mqttReportedAvailability !== current) {
        try {
            await mqttClient.publish(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/availability`, current ? "online" : "offline");
            mqttReportedAvailability = current;
        } catch(e) {}
    }
}

async function updateAvailability() {
    while (true) {
        await publishAvailability();
        await new Promise((resolve => setTimeout(resolve, 500)));
    }
}

async function publishAction() {
    if (!mqttClient) return;
    let val = 'off';
    if (boilerState && boilerState.isPowerOn) {
        switch (boilerState.combustionState) {
            case 1:
                val = 'idle';
                break;
            case 2:
                val = 'heating';
                break;
            case 4:
                val = 'drying';
                break;
        }
    }
    await mqttClient.publish(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/action`, val);
}

async function publishAwayMode() {
    if (!mqttClient) return;
    await mqttClient.publish(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/away_mode`, (boilerState != null && boilerState.isGoOut) ? "ON" : "OFF");
}

async function publishTargetTemperature() {
    if (!mqttClient) return;
    await mqttClient.publish(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/target_temperature`, (boilerState != null) ? boilerState.desiredRoomTemp.toString() : "0");
}

async function publishTargetHotWaterTemperature() {
    if (!mqttClient) return;
    await mqttClient.publish(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/target_hot_water_temperature`, (boilerState != null) ? boilerState.desiredHotWaterTemp.toString() : "0");
}

async function publishIsHotWaterUsing() {
    if (!mqttClient) return;
    await mqttClient.publish(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/is_hot_water_using`, (boilerState != null && boilerState.isHotWaterUsing) ? "ON": "OFF");
}

async function publishCurrentWaterTemperature() {
    if (!mqttClient) return;
    await mqttClient.publish(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/current_water_temperature`, (boilerState != null) ? boilerState.currentWaterTemp.toString() : "0");
}

async function publishCurrentTemperature() {
    if (!mqttClient) return;
    await mqttClient.publish(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/current_temperature`, (boilerState != null) ? boilerState.currentRoomTemp.toString() : "0");
}

async function publishMode() {
    if (!mqttClient) return;
    let val = 'off';
    if (!boilerState || !boilerState.isPowerOn) {
        val = 'off';
    } else if (boilerState.isHeatOn && boilerState.isHotWaterOn) {
        val = 'auto';
    } else if(boilerState.isHeatOn) {
        val = 'heat';
    } else if(boilerState.isHotWaterOn) {
        val = 'dry';
    } else {
        val = 'cool';
    }
    await mqttClient.publish(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/mode`, val);
}

async function publishFullState() {
    if (!mqttClient) return;
    if (!boilerState) return;
    await mqttClient.publish(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/state`, JSON.stringify(boilerState));
}

if (mqttClient) {
    mqttClient.on('connect', async () => {
        try {
            await mqttClient.subscribe(`hass/status`);
            await mqttClient.subscribe(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_away_mode`);
            await mqttClient.subscribe(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_target_temperature`);
            await mqttClient.subscribe(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_target_hot_water_temperature`);
            await mqttClient.subscribe(`${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_mode`);
            await initialPublish();
        } catch(e) {
            logger.error(e);
        }
    });

    mqttClient.on('message', async (topic, raw) => {
        try {
            let message = raw.toString();
            switch (topic) {
                case 'hass/status':
                    if (message === 'online') {
                        // https://github.com/Koenkk/zigbee2mqtt/blob/864e8b26d5cb6ef951299aea21423ffb25304b1d/lib/extension/homeassistant.js#L1862
                        setTimeout(() => {
                            initialPublish().catch((e) => logger.error(e));
                        }, 30 * 1000);
                    }
                    break;
                case `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_away_mode`:
                    await sendCommand((state) => {
                        if (message === "ON") {
                            state.isGoOut = 0x80;
                        } else if (message == "OFF") {
                            if (state.isHeatOn) state.isHeatOn = false;
                            else state.isGoOut = 0;
                        }
                    });
                    break;
                case `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_target_temperature`:
                {
                    let temp = parseInt(message);
                    if (temp < 15 || temp > 30) return;
                    await sendCommand((state) => {
                        state.desiredRoomTemp = temp;
                        state.desiredHeatWaterTemp = temp;
                    });
                    break;
                }
                case `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_target_hot_water_temperature`:
                {
                    let temp = parseInt(message);
                    if (temp < 40 || temp > 60) return;
                    await sendCommand((state) => {
                        state.desiredHotWaterTemp = temp;
                    });
                    break;
                }
                case `${MQTT_TOPIC_PREFIX}/${HASS_NODEID}/set_mode`:
                    await sendCommand((state) => {
                        switch (message) {
                            case "off":
                                state.isPowerOn = false;
                                break;
                            case "auto":
                                state.isPowerOn = true;
                                state.isHotWaterOn = true;
                                state.isHeatOn = true;
                                break;
                            case "heat":
                                state.isPowerOn = true;
                                state.isHotWaterOn = false;
                                state.isHeatOn = true;
                                break;
                            case "dry":
                                state.isPowerOn = true;
                                state.isHotWaterOn = true;
                                state.isHeatOn = false;
                                break;
                            case "cool":
                                state.isPowerOn = true;
                                state.isHotWaterOn = false;
                                state.isHeatOn = false;
                                break;
                        }
                    });
                    break;
            }
        } catch(e) {
            logger.error(e);
        }
    });
}

process.on('uncaughtException', (err) => {
    logger.error(err);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(reason);
});



