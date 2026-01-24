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
            if (!userId) return res.status(400).json({ error: "userId is required" });

            const userRaw = await usersRedis.get(`user:${userId}`);
            if (!userRaw) return res.status(404).json({ error: "User not found" });

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
            if (!userId) return res.status(400).json({ error: "userId is required" });

            // 1. Уже есть pending соперник?
            const pendingId = await mmRedis.get(`mm:user:pending:${userId}`);
            if (pendingId) {
                const pendingRaw = await mmRedis.get(pendingId);
                if (pendingRaw) {
                    const pending = JSON.parse(pendingRaw);
                    const opponentId = pending.p1 === userId ? pending.p2 : pending.p1;

                    const opponent = JSON.parse(await usersRedis.get(`user:${opponentId}`));

                    return res.json({
                        status: "found",
                        opponent: {
                            userId: opponent.userId,
                            username: opponent.username,
                            rating: opponent.rating,
                            level: opponent.level,
                        },
                    });
                } else {
                    await mmRedis.del(`mm:user:pending:${userId}`);
                }
            }

            // 2. Проверяем, в очереди ли игрок
            const metaRaw = await mmRedis.get(`mm:queue:meta:${userId}`);
            if (!metaRaw) return res.json({ status: "not_in_queue" });

            const meta = JSON.parse(metaRaw);
            const waitTime = Date.now() - meta.joinedAt;

            const step = Math.floor(waitTime / 10000);
            const range = Math.min(step * 100, 1000);

            const minRating = meta.rating - range;
            const maxRating = meta.rating + range;

            // 3. Ищем кандидатов
            const candidates = await mmRedis.zRangeByScore(
                "mm:queue:rating",
                minRating,
                maxRating
            );

            const opponentId = candidates.find(id => id !== userId);
            if (!opponentId) {
                return res.json({ status: "searching", waitTime, range });
            }

            // 4. Создаём pending pair (30 сек)
            const pairId = `mm:pending:${Date.now()}:${userId}`;

            const pending = {
                p1: userId,
                p2: opponentId,
                accepted: [],
            };

            await mmRedis.set(pairId, JSON.stringify(pending), { EX: 30 });
            await mmRedis.set(`mm:user:pending:${userId}`, pairId, { EX: 30 });
            await mmRedis.set(`mm:user:pending:${opponentId}`, pairId, { EX: 30 });

            const opponent = JSON.parse(await usersRedis.get(`user:${opponentId}`));

            return res.json({
                status: "found",
                opponent: {
                    userId: opponent.userId,
                    username: opponent.username,
                    rating: opponent.rating,
                    level: opponent.level,
                },
            });

        } catch (err) {
            console.error("Check error:", err);
            res.status(500).json({ error: "Internal server error" });
        }
    });

    app.post("/matchmaking/accept", async (req, res) => {
        try {
            const { userId } = req.body;
            if (!userId) return res.status(400).json({ error: "userId is required" });

            const pairId = await mmRedis.get(`mm:user:pending:${userId}`);
            if (!pairId) {
                return res.json({ status: "no_pending" });
            }

            const pendingRaw = await mmRedis.get(pairId);
            if (!pendingRaw) {
                await mmRedis.del(`mm:user:pending:${userId}`);
                return res.json({ status: "expired" });
            }

            const pending = JSON.parse(pendingRaw);

            if (!pending.accepted.includes(userId)) {
                pending.accepted.push(userId);
                await mmRedis.set(pairId, JSON.stringify(pending), { EX: 30 });
            }

            // если ещё не оба приняли
            if (pending.accepted.length < 2) {
                return res.json({ status: "waiting_other" });
            }

            // 🔹 ОБА ПРИНЯЛИ → создаём матч
            const { p1, p2 } = pending;

            // убираем из очереди
            await mmRedis.zRem("mm:queue:rating", p1);
            await mmRedis.zRem("mm:queue:rating", p2);
            await mmRedis.del(`mm:queue:meta:${p1}`);
            await mmRedis.del(`mm:queue:meta:${p2}`);

            // чистим pending
            await mmRedis.del(pairId);
            await mmRedis.del(`mm:user:pending:${p1}`);
            await mmRedis.del(`mm:user:pending:${p2}`);

            // загружаем игроков
            const u1 = JSON.parse(await usersRedis.get(`user:${p1}`));
            const u2 = JSON.parse(await usersRedis.get(`user:${p2}`));

            const matchId = `mm:match:${Date.now()}`;

            const match = {
                id: matchId,
                createdAt: Date.now(),
                players: [
                    {
                        userId: u1.userId,
                        username: u1.username,
                        rating: u1.rating,
                        level: u1.level,
                    },
                    {
                        userId: u2.userId,
                        username: u2.username,
                        rating: u2.rating,
                        level: u2.level,
                    },
                ],
                status: "waiting_for_game_server",
            };

            await mmRedis.set(matchId, JSON.stringify(match), { EX: 300 });
            await mmRedis.set(`mm:user:match:${p1}`, matchId, { EX: 300 });
            await mmRedis.set(`mm:user:match:${p2}`, matchId, { EX: 300 });

            return res.json({
                status: "match_created",
                match: {
                    id: matchId,
                    players: [
                        { userId: u1.userId, username: u1.username },
                        { userId: u2.userId, username: u2.username },
                    ],
                },
            });

        } catch (err) {
            console.error("Accept error:", err);
            res.status(500).json({ error: "Internal server error" });
        }
    });



    const PORT = process.env.PORT || 3000;

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Matchmaking server running on port ${PORT}`);
    });

}

start();
