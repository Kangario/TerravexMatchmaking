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

const gsRedis = createClient({
    username: 'default',
    password: 'o0EjuPkv0vCmo25LodqPxQMBvKDjzMpD',
    socket: {
        host: 'redis-16597.c328.europe-west3-1.gce.cloud.redislabs.com',
        port: 16597
    }
});

gsRedis.on('error', err => console.log('Redis Client Error', err));
usersRedis.on("error", err => console.error("Users Redis error:", err));
mmRedis.on("error", err => console.error("MM Redis error:", err));

/* ---------------- HELPERS ---------------- */

// записать матч в GameServerRedis
const crypto = require("node:crypto");

async function saveMatchToGameServer(match) {
    const key = `gs:match:${match.id}`;

    const unitsByPlayer = [];

    let teamId = 0;
    
    for (const p of match.players) {
        const heroes = await getUserUnits(p.userId);
        unitsByPlayer.push(...normalizeHeroes(heroes, p.userId, teamId));
        teamId++;
    }

    const gsMatch = {
        id: match.id,
        createdAt: match.createdAt,
        players: match.players,
        status: "waiting_for_server",
        seed: crypto.randomInt(0, 2 ** 31),
        units: unitsByPlayer
    };

    await gsRedis.set(key, JSON.stringify(gsMatch), { EX: 3600 }); // лучше 1 час

    await gsRedis.lPush("gs:queue:matches", match.id);

    console.log("🎮 Match saved to GS", {
        matchId: match.id,
        seed: gsMatch.seed,
        p1Units: unitsByPlayer[match.players[0].userId].length,
        p2Units: unitsByPlayer[match.players[1].userId].length
    });
}


async function getUserUnits(userId) {
    const raw = await usersRedis.get(`user:${userId}`);

    if (!raw) {
        throw new Error(`User ${userId} not found`);
    }

    const user = JSON.parse(raw);

    if (!user.equipmentHeroes || !Array.isArray(user.equipmentHeroes)) {
        throw new Error(`User ${userId} has no equipmentHeroes`);
    }

    console.log("👥 Units loaded", {
        userId,
        count: user.equipmentHeroes.length
    });

    return user.equipmentHeroes;
}
//Position helper
const FIELD_WIDTH = 15;
const FIELD_HEIGHT = 40;

function getRandomPositionByTeam(teamId) {
    const margin = 4;

    let minY, maxY;

    
    if (teamId === 0) {
        minY = 1;
        maxY = 1;
    } else {
        minY = 38;
        maxY = 38;
    }

    return {
        x: getRandomInt(margin, FIELD_WIDTH - margin),
        y: getRandomInt(minY, maxY),
    };
}

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeHeroes(equipmentHeroes, ownerId, teamId) {
    const usedPositions = new Set();

    return equipmentHeroes.map((h, index) => {

        let position;

        do {
            position = getRandomPositionByTeam(teamId);
        }
        while (usedPositions.has(`${position.x}_${position.y}`));

        usedPositions.add(`${position.x}_${position.y}`);

        return {
            id: `${ownerId}_${index}`,
            team: teamId,

            heroId: h.Id,
            templateId: h.InstanceId,
            playerId: ownerId,

            name: h.Name,
            gender: h.Gender,

            hp: h.HpMax,
            maxHp: h.HpMax,
            ap: h.MaxAP,

            initiative: h.Initiative,

            damageP: h.DamageP,
            damageM: h.DamageM,

            defenceP: h.DefenceP,
            defenceM: h.DefenceM,

            attackRange: h.AttackRange,
            moveCost: h.MoveCost,
            
            level: h.Lvl,
            
            skills: h.Skills,
            equipmentSlots: h.EquipmentSlots,
            
            position
        };
    });
}

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
        { score: now, value: userId },
    ]);

    return true;
}

// проверить есть ли уже матч
async function checkExistingMatch(userId) {
    const matchId = await mmRedis.get(`mm:user:match:${userId}`);
    if (!matchId) return null;

    // 🔹 ЧИТАЕМ МАТЧ УЖЕ ИЗ GameServerRedis
    const raw = await gsRedis.get(`gs:match:${matchId}`);
    if (!raw) {
        // матч пропал — чистим ссылку
        await mmRedis.del(`mm:user:match:${userId}`);
        return null;
    }

    return JSON.parse(raw);
}


// поиск первого доступного соперника без учета рейтинга
async function findOpponent(userId) {
    const candidates = await mmRedis.zRange("mm:queue:rating", 0, -1);
    return candidates.find(id => id !== userId) || null;
}

async function createMatchForPlayers(p1, p2) {
    await mmRedis.zRem("mm:queue:rating", p1);
    await mmRedis.zRem("mm:queue:rating", p2);
    await mmRedis.del(`mm:queue:meta:${p1}`);
    await mmRedis.del(`mm:queue:meta:${p2}`);

    const u1 = await getUser(p1);
    const u2 = await getUser(p2);

    const matchId = `mm:match:${Date.now()}`;

    const match = {
        id: matchId,
        createdAt: Date.now(),
        players: [
            { userId: u1.userId, username: u1.username, rating: u1.rating, level: u1.level , teamId: 0},
            { userId: u2.userId, username: u2.username, rating: u2.rating, level: u2.level , teamId: 1},
        ],
        status: "waiting_for_game_server",
    };

    // сохраняем в mmRedis (только чтобы клиенты узнали, что матч есть)
    await mmRedis.set(`mm:user:match:${p1}`, matchId, { EX: 300 });
    await mmRedis.set(`mm:user:match:${p2}`, matchId, { EX: 300 });

// 🔹 СОХРАНЯЕМ МАТЧ В GameServerRedis
    await saveMatchToGameServer(match);

// (опционально) можно вообще НЕ хранить сам матч в mmRedis
// mmRedis теперь используется только как сигнал "матч создан"

    return match;
}

async function tryCreateMatch(userId, opponentId) {
    const lockKey = `mm:matchlock:${[userId, opponentId].sort().join(":")}`;
    const locked = await mmRedis.set(lockKey, userId, { NX: true, EX: 5 });

    if (locked === null) {
        return checkExistingMatch(userId);
    }

    try {
        const [userStillQueued, opponentStillQueued] = await Promise.all([
            mmRedis.zScore("mm:queue:rating", userId),
            mmRedis.zScore("mm:queue:rating", opponentId),
        ]);

        if (userStillQueued === null || opponentStillQueued === null) {
            return checkExistingMatch(userId);
        }

        return await createMatchForPlayers(userId, opponentId);
    } finally {
        await mmRedis.del(lockKey);
    }
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

        const existing = await checkExistingMatch(userId);
        if (existing) {
            const opponent = existing.players.find(player => player.userId !== userId);
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

        const match = await tryCreateMatch(userId, opponentId);
        if (!match) {
            return res.json({ status: "searching" });
        }

        const opponent = match.players.find(player => player.userId !== userId);

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


// 3️⃣ ПРОВЕРКА СУЩЕСТВУЮЩЕГО МАТЧА
app.post("/matchmaking/match", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "userId is required" });

        // если матч уже есть
        const existing = await checkExistingMatch(userId);
        if (existing) {
            return res.json({ status: "has_match", match: existing });
        }

        return res.json({ status: "searching" });

    } catch (err) {
        console.error("Match error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/matchmaking/dequeue", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: "userId is required" });
        }

        // 1) Удаляем из рейтинговой очереди и меты
        const removedFromQueue = await mmRedis.zRem("mm:queue:rating", userId);
        await mmRedis.del(`mm:queue:meta:${userId}`);

        // 2) Ссылку на матч у этого пользователя тоже убираем
        await mmRedis.del(`mm:user:match:${userId}`);

        return res.json({
            status: "dequeued",
            removedFromQueue: removedFromQueue > 0
        });
    } catch (err) {
        console.error("Dequeue error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});



/* ---------------- START ---------------- */

async function start() {
    await usersRedis.connect();
    await mmRedis.connect();
    await gsRedis.connect();   // 🔹 ВАЖНО

    console.log(" Connected to Users Redis");
    console.log(" Connected to Matchmaking Redis");
    console.log(" Connected to GameServer Redis");  // 🔹

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Matchmaking server running on port ${PORT}`);
    });
}


start();
