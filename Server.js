const express = require("express");
const { createClient } = require("redis");

const app = express();
app.use(express.json());

const usersRedis = createClient({
    socket: {
        host: "redis-17419.c328.europe-west3-1.gce.cloud.redislabs.com",
        port: 17419,
    },
    password: "af0gO9r23iS9w7sYd8T0XtQktQR0ZXnl",
});

const mmRedis = createClient({
    username: "default",
    password: "67zcdHUvuYYp23FZ4vDSDmQKJIyelSNf",
    socket: {
        host: "redis-16482.c328.europe-west3-1.gce.cloud.redislabs.com",
        port: 16482,
    },
});

usersRedis.on("error", (err) => console.error("Users Redis error:", err));
mmRedis.on("error", (err) => console.error("MM Redis error:", err));

async function start() {
    await usersRedis.connect();
    await mmRedis.connect();

    console.log(" Connected to Users Redis");
    console.log(" Connected to Matchmaking Redis");
    
    app.post("/matchmaking/enqueue", async (req, res) => {
        try {
            const { userId } = req.body;

            if (!userId) {
                return res.status(400).json({ error: "userId is required" });
            }
            
            const userRaw = await usersRedis.get(`user:${userId}`);
            if (!userRaw) {
                return res.status(404).json({ error: "User not found" });
            }

            const user = JSON.parse(userRaw);

            const exists = await mmRedis.zScore("mm:queue:rating", userId);
            if (exists !== null) {
                return res.json({ status: "already_in_queue" });
            }

            const now = Date.now();

            await mmRedis.set(
                `mm:queue:meta:${userId}`,
                JSON.stringify({
                    rating: user.rating,
                    joinedAt: now,
                })
            );

            await mmRedis.zAdd("mm:queue:rating", [
                { score: user.rating, value: userId },
            ]);

            res.json({ status: "queued" });
        } catch (err) {
            console.error("Enqueue error:", err);
            res.status(500).json({ error: "Internal server error" });
        }
    });


    app.post("/matchmaking/check", async (req, res) => {
        try {
            const { userId } = req.body;

            if (!userId) {
                return res.status(400).json({ error: "userId is required" });
            }

            // 🔹 1. Проверяем: игрок УЖЕ в матче?
            const existingMatchId = await mmRedis.get(`mm:user:match:${userId}`);
            if (existingMatchId) {
                const matchRaw = await mmRedis.get(existingMatchId);

                if (matchRaw) {
                    const match = JSON.parse(matchRaw);

                    return res.json({
                        status: "waiting_for_game_server",
                        match: {
                            id: match.id,
                            players: match.players.map(p => ({
                                userId: p.userId,
                                username: p.username,
                            })),
                        },
                    });
                } else {
                    // если матч удалён, чистим ссылку
                    await mmRedis.del(`mm:user:match:${userId}`);
                }
            }

            // 🔹 2. Проверяем: игрок вообще в очереди?
            const metaRaw = await mmRedis.get(`mm:queue:meta:${userId}`);
            if (!metaRaw) {
                return res.json({ status: "not_in_queue" });
            }

            const meta = JSON.parse(metaRaw);

            const waitTime = Date.now() - meta.joinedAt;

            const step = Math.floor(waitTime / 10000);
            const range = Math.min(step * 100, 1000);

            const minRating = meta.rating - range;
            const maxRating = meta.rating + range;

            // 🔹 3. Ищем кандидатов
            const candidates = await mmRedis.zRangeByScore(
                "mm:queue:rating",
                minRating,
                maxRating
            );

            const opponentId = candidates.find(id => id !== userId);

            if (!opponentId) {
                return res.json({
                    status: "searching",
                    waitTime,
                    range,
                });
            }

            // 🔹 4. Пытаемся забрать соперника из очереди
            const removed = await mmRedis.zRem("mm:queue:rating", opponentId);

            if (removed === 0) {
                // кто-то уже забрал этого соперника
                return res.json({
                    status: "searching",
                    waitTime,
                    range,
                });
            }

            // 🔹 5. Убираем и себя из очереди
            await mmRedis.zRem("mm:queue:rating", userId);
            await mmRedis.del(`mm:queue:meta:${userId}`);
            await mmRedis.del(`mm:queue:meta:${opponentId}`);

            // 🔹 6. Загружаем игроков
            const p1 = JSON.parse(await usersRedis.get(`user:${userId}`));
            const p2 = JSON.parse(await usersRedis.get(`user:${opponentId}`));

            const matchId = `mm:match:${Date.now()}`;

            const match = {
                id: matchId,
                createdAt: Date.now(),
                players: [
                    {
                        userId: p1.userId,
                        username: p1.username,
                        rating: p1.rating,
                        level: p1.level,
                        equipmentHeroes: p1.equipmentHeroes,
                    },
                    {
                        userId: p2.userId,
                        username: p2.username,
                        rating: p2.rating,
                        level: p2.level,
                        equipmentHeroes: p2.equipmentHeroes,
                    },
                ],
                status: "waiting_for_game_server",
            };

            // 🔹 7. Сохраняем матч
            await mmRedis.set(matchId, JSON.stringify(match), { EX: 300 });

            // 🔹 8. Привязываем ОБОИХ игроков к матчу
            await mmRedis.set(`mm:user:match:${userId}`, matchId, { EX: 300 });
            await mmRedis.set(`mm:user:match:${opponentId}`, matchId, { EX: 300 });

            // 🔹 9. Возвращаем матч ТЕКУЩЕМУ игроку
            return res.json({
                status: "waiting_for_game_server",
                match: {
                    id: matchId,
                    players: [
                        { userId: p1.userId, username: p1.username },
                        { userId: p2.userId, username: p2.username },
                    ],
                },
            });

        } catch (err) {
            console.error("Check error:", err);
            res.status(500).json({ error: "Internal server error" });
        }
    });


    const PORT = process.env.PORT || 3000;

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Matchmaking server running on port ${PORT}`);
    });

}

start();
