const { createApp } = require("./src/app");

async function start() {
    const { app, clients } = createApp();
    const { usersRedis, mmRedis, gsRedis } = clients;

    await usersRedis.connect();
    await mmRedis.connect();
    await gsRedis.connect();

    console.log("Connected to Users Redis");
    console.log("Connected to Matchmaking Redis");
    console.log("Connected to GameServer Redis");

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Matchmaking server running on port ${PORT}`);
    });
}

start();
