const { createClient } = require("redis");

function createRedisClients() {
    const usersRedis = createClient({
        socket: { host: "redis-17419.c328.europe-west3-1.gce.cloud.redislabs.com", port: 17419 },
        password: "af0gO9r23iS9w7sYd8T0XtQktQR0ZXnl",
    });

    const mmRedis = createClient({
        username: "default",
        password: "67zcdHUvuYYp23FZ4vDSDmQKJIyelSNf",
        socket: { host: "redis-16482.c328.europe-west3-1.gce.cloud.redislabs.com", port: 16482 },
    });

    const gsRedis = createClient({
        username: "default",
        password: "o0EjuPkv0vCmo25LodqPxQMBvKDjzMpD",
        socket: {
            host: "redis-16597.c328.europe-west3-1.gce.cloud.redislabs.com",
            port: 16597,
        },
    });

    usersRedis.on("error", err => console.error("Users Redis error:", err));
    mmRedis.on("error", err => console.error("MM Redis error:", err));
    gsRedis.on("error", err => console.error("GS Redis error:", err));

    return { usersRedis, mmRedis, gsRedis };
}

module.exports = {
    createRedisClients,
};
