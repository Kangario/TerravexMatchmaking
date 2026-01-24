const express = require("express");
const { createClient } = require("redis");

const app = express();
app.use(express.json());

/* ---------------- REDIS ---------------- */

const usersRedis = createClient({
    socket: { host: "redis-17419.c328.europe-west3-1.gce.cloud.redislabs.com", port: 17419 },
    password: "af0gO9r23iS9w7sYd8T0XtQktQR0ZXnl",
});

const mmRedis = createClient({
    username: "default",
    password: "67zcdHUvuYYp23FZ4vDSDmQKJIyelSNf",
    socket: { host: "redis-16482.c328.europe-west3-1.gce.cloud.redislabs.com", port: 16482 },
});

usersRedis.on("error", err => console.error("Users Redis error:", err));
mmRedis.on("error", err => console.error("MM Redis error:", err));

/* ---------------- HELPERS ---------------- */

// получить пользователя
async function getUser(userId) {
    const raw = await usersRedis.get(`user:${userId}`);
    return raw ? JSON.parse(raw) : null;
}

// поставить в очередь
async function enqueueUser(userId, rating) {
    const exists = await mmRedis.zScore("mm:queue:rating", userId);
    if (exists !== null) return false;

    const now = Date.now();

    await mmRedis.set(`mm:queue:meta:${userId}`, JSON.stringify({
        rating,
        joinedAt: now,
    }));

    await mmRedis.zAdd("mm:queue:rating", [
        { score: rating, value: userId },
    ]);

    return true;
}

// проверить есть ли уже матч
async function checkExistingMatch(userId) {
    const matchId = await mmRedis.get(`mm:user:match:${userId}`);
    if (!matchId) return null;

    const raw = await mmRedis.get(matchId);
    if (!raw) {
        await mmRedis.del(`mm:user:match:${userId}`);
        return null;
    }

    return JSON.parse(raw);
}

// поиск соперника
async function findOpponent(userId) {
    const metaRaw = await mmRedis.get(`mm:queue:meta:${userId}`);
    if (!metaRaw) return null;

    const meta = JSON.parse(metaRaw);
    const waitTime = Date.now() - meta.joinedAt;

    const step = Math.floor(waitTime / 10000);
    const range = Math.min(step * 100, 1000);

    const minRating = meta.rating - range;
    const maxRating = meta.rating + range;

    const candidates = await mmRedis.zRangeByScore(
        "mm:queue:rating",
        minRating,
        maxRating
    );

    return candidates.find(id => id !== userId) || null;
}

// создать pending пару
async function createPendingPair(p1, p2) {
    const pairId = `mm:pending:${Date.now()}:${p1}`;

    const pending = {
        p1,
        p2,
        accepted: [],
    };

    await mmRedis.set(pairId, JSON.stringify(pending), { EX: 30 });
    await mmRedis.set(`mm:user:pending:${p1}`, pairId, { EX: 30 });
    await mmRedis.set(`mm:user:pending:${p2}`, pairId, { EX: 30 });

    return pairId;
}

// принять pending и возможно создать матч
async function acceptPair(userId) {
    const pairId = await mmRedis.get(`mm:user:pending:${userId}`);
    if (!pairId) return { status: "no_pending" };

    const raw = await mmRedis.get(pairId);
    if (!raw) {
        await mmRedis.del(`mm:user:pending:${userId}`);
        return { status: "expired" };
    }

    const pending = JSON.parse(raw);

    if (!pending.accepted.includes(userId)) {
        pending.accepted.push(userId);
        await mmRedis.set(pairId, JSON.stringify(pending), { EX: 30 });
    }

    if (pending.accepted.length < 2) {
        return { status: "waiting_other" };
    }

    // оба приняли → создаём матч
    const { p1, p2 } = pending;

    await mmRedis.zRem("mm:queue:rating", p1);
    await mmRedis.zRem("mm:queue:rating", p2);
    await mmRedis.del(`mm:queue:meta:${p1}`);
    await mmRedis.del(`mm:queue:meta:${p2}`);

    await mmRedis.del(pairId);
    await mmRedis.del(`mm:user:pending:${p1}`);
    await mmRedis.del(`mm:user:pending:${p2}`);

    const u1 = await getUser(p1);
    const u2 = await getUser(p2);

    const matchId = `mm:match:${Date.now()}`;

    const match = {
        id: matchId,
        createdAt: Date.now(),
        players: [
            { userId: u1.userId, username: u1.username, rating: u1.rating, level: u1.level },
            { userId: u2.userId, username: u2.username, rating: u2.rating, level: u2.level },
        ],
        status: "waiting_for_game_server",
    };

    await mmRedis.set(matchId, JSON.stringify(match), { EX: 300 });
    await mmRedis.set(`mm:user:match:${p1}`, matchId, { EX: 300 });
    await mmRedis.set(`mm:user:match:${p2}`, matchId, { EX: 300 });

    return { status: "match_created", match };
}

/* ---------------- ENDPOINTS ---------------- */

// 1️⃣ ВСТАТЬ В ОЧЕРЕДЬ
app.post("/matchmaking/enqueue", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "userId is required" });

        const user = await getUser(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        const ok = await enqueueUser(userId, user.rating);

        res.json({ status: ok ? "queued" : "already_in_queue" });

    } catch (err) {
        console.error("Enqueue error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});


// 2️⃣ ПРОВЕРКА ОЧЕРЕДИ (поиск соперника)
app.post("/matchmaking/check", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "userId is required" });

        // если уже есть pending
        const pendingId = await mmRedis.get(`mm:user:pending:${userId}`);
        if (pendingId) {
            const pending = JSON.parse(await mmRedis.get(pendingId));
            const opponentId = pending.p1 === userId ? pending.p2 : pending.p1;
            const opponent = await getUser(opponentId);

            return res.json({
                status: "found",
                opponent: {
                    userId: opponent.userId,
                    username: opponent.username,
                    rating: opponent.rating,
                    level: opponent.level,
                },
            });
        }

        const opponentId = await findOpponent(userId);
        if (!opponentId) {
            return res.json({ status: "searching" });
        }

        await createPendingPair(userId, opponentId);

        const opponent = await getUser(opponentId);

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


// 3️⃣ ПРОВЕРКА СУЩЕСТВУЮЩЕГО МАТЧА + ACCEPT
app.post("/matchmaking/match", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "userId is required" });

        // если матч уже есть
        const existing = await checkExistingMatch(userId);
        if (existing) {
            return res.json({ status: "has_match", match: existing });
        }

        // иначе пробуем принять pending
        const result = await acceptPair(userId);
        return res.json(result);

    } catch (err) {
        console.error("Match error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});


/* ---------------- START ---------------- */

async function start() {
    await usersRedis.connect();
    await mmRedis.connect();

    console.log(" Connected to Users Redis");
    console.log(" Connected to Matchmaking Redis");

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Matchmaking server running on port ${PORT}`);
    });
}

start();
