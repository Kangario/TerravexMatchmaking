const express = require("express");
const { createRedisClients } = require("./config/redis");
const UserService = require("./services/UserService");
const GameServerService = require("./services/GameServerService");
const MatchmakingService = require("./services/MatchmakingService");
const createMatchmakingRouter = require("./routes/matchmakingRoutes");

function createApp() {
    const app = express();
    app.use(express.json());

    const { usersRedis, mmRedis, gsRedis } = createRedisClients();
    const userService = new UserService(usersRedis);
    const gameServerService = new GameServerService(gsRedis, userService);
    const matchmakingService = new MatchmakingService(mmRedis, userService, gameServerService);

    app.use("/matchmaking", createMatchmakingRouter(matchmakingService, userService));

    return {
        app,
        clients: { usersRedis, mmRedis, gsRedis },
    };
}

module.exports = {
    createApp,
};
