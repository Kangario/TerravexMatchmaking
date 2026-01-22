const express = require("express");
const { createClient } = require("redis");

const app = express();
app.use(express.json());

// 🟢 Redis БАЗА ПОЛЬЗОВАТЕЛЕЙ
const usersRedis = createClient({
    socket: {
        host: "redis-17419.c328.europe-west3-1.gce.cloud.redislabs.com",
        port: 17419,
    },
    password: "af0gO9r23iS9w7sYd8T0XtQktQR0ZXnl",
});

// 🔵 Redis БАЗА МАТЧМЕЙКИНГА
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

    console.log("✅ Connected to Users Redis");
    console.log("✅ Connected to Matchmaking Redis");

    // 🎯 1️⃣ ENQUEUE — игрок встал в очередь
    app.post("/matchmaking/enqueue", async (req, res) => {
        try {
            const { userId } = req.body;

            if (!userId) {
                return res.status(400).json({ error: "userId is required" });
            }

            // Берём профиль из users DB
            const userRaw = await usersRedis.get(`user:${userId}`);
            if (!userRaw) {
                return res.status(404).json({ error: "User not found" });
            }

            const user = JSON.parse(userRaw);

            // Проверяем, не стоит ли уже в очереди
            const exists = await mmRedis.zScore("mm:queue:rating", userId);
            if (exists !== null) {
                return res.json({ status: "already_in_queue" });
            }

            const now = Date.now();

            // Сохраняем мета (joinedAt + rating)
            await mmRedis.set(
                `mm:queue:meta:${userId}`,
                JSON.stringify({
                    rating: user.rating,
                    joinedAt: now,
                })
            );

            // Добавляем в рейтинг-очередь
            await mmRedis.zAdd("mm:queue:rating", [
                { score: user.rating, value: userId },
            ]);

            res.json({ status: "queued" });
        } catch (err) {
            console.error("Enqueue error:", err);
            res.status(500).json({ error: "Internal server error" });
        }
    });

    // 🎯 2️⃣ CHECK — игрок каждые 10 сек проверяет очередь
    app.post("/matchmaking/check", async (req, res) => {
        try {
            const { userId } = req.body;

            if (!userId) {
                return res.status(400).json({ error: "userId is required" });
            }

            const metaRaw = await mmRedis.get(`mm:queue:meta:${userId}`);
            if (!metaRaw) {
                return res.json({ status: "not_in_queue" });
            }

            const meta = JSON.parse(metaRaw);

            const waitTime = Date.now() - meta.joinedAt;

            // 🔥 ЛОГИКА РАСШИРЕНИЯ ДИАПАЗОНА
            // каждые 10 сек +100 рейтинга, максимум 1000
            const step = Math.floor(waitTime / 10000);
            const range = Math.min(step * 100, 1000);

            const minRating = meta.rating - range;
            const maxRating = meta.rating + range;

            // Ищем кандидатов
            const candidates = await mmRedis.zRangeByScore(
                "mm:queue:rating",
                minRating,
                maxRating
            );

            // Убираем самого себя
            const opponentId = candidates.find((id) => id !== userId);

            if (!opponentId) {
                return res.json({
                    status: "searching",
                    waitTime,
                    range,
                });
            }

            // 🔥 МАТЧ НАЙДЕН

            // Удаляем обоих из очереди
            await mmRedis.zRem("mm:queue:rating", userId, opponentId);
            await mmRedis.del(`mm:queue:meta:${userId}`);
            await mmRedis.del(`mm:queue:meta:${opponentId}`);

            // Загружаем профили
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

            // Сохраняем матч
            await mmRedis.set(matchId, JSON.stringify(match));

            // Отдаём клиенту безопасные данные
            res.json({
                status: "matched",
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

    app.listen(3000, () => {
        console.log("🚀 Matchmaking server running on http://localhost:3000");
    });
}

start();
