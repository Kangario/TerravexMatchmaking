const express = require("express");
const { createClient } = require("redis");

const app = express();
app.use(express.json());

const MATCH_SEARCH_STEP_MS = 10000;
const MATCH_SEARCH_RANGE_STEP = 100;
const FULL_QUEUE_SEARCH_AFTER_MS = 30000;

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
        unitsCount: unitsByPlayer.length,
        players: match.players.map(player => player.userId)
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
        { score: rating, value: userId },
    ]);

    return true;
}

async function getQueueMeta(userId) {
    const raw = await mmRedis.get(`mm:queue:meta:${userId}`);
    return raw ? JSON.parse(raw) : null;
}

async function getPendingPair(userId) {
    const pairKey = await mmRedis.get(`mm:user:pending:${userId}`);
    if (!pairKey) return null;

    const raw = await mmRedis.get(pairKey);
    if (!raw) {
        await mmRedis.del(`mm:user:pending:${userId}`);
        return null;
    }

    return { key: pairKey, data: JSON.parse(raw) };
}

async function isAvailableForPairing(userId) {
    const pendingPair = await getPendingPair(userId);
    return pendingPair === null;
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


// поиск соперника
async function findOpponent(userId) {
    const meta = await getQueueMeta(userId);
    if (!meta) return null;

    const waitTime = Date.now() - meta.joinedAt;

    const step = Math.floor(waitTime / MATCH_SEARCH_STEP_MS);
    const range = step * MATCH_SEARCH_RANGE_STEP;

    const minRating = meta.rating - range;
    const maxRating = meta.rating + range;

    let candidateIds = await mmRedis.zRangeByScore(
        "mm:queue:rating",
        minRating,
        maxRating
    );

    if (waitTime >= FULL_QUEUE_SEARCH_AFTER_MS) {
        candidateIds = await mmRedis.zRange("mm:queue:rating", 0, -1);
    }

    const candidates = [];

    for (const candidateId of candidateIds) {
        if (candidateId === userId) continue;
        if (!(await isAvailableForPairing(candidateId))) continue;

        const candidateMeta = await getQueueMeta(candidateId);
        if (!candidateMeta) continue;

        candidates.push({
            userId: candidateId,
            rating: candidateMeta.rating,
            joinedAt: candidateMeta.joinedAt,
            ratingDelta: Math.abs(candidateMeta.rating - meta.rating),
        });
    }

    candidates.sort((left, right) => {
        if (left.ratingDelta !== right.ratingDelta) {
            return left.ratingDelta - right.ratingDelta;
        }

        return left.joinedAt - right.joinedAt;
    });

    return candidates[0]?.userId || null;
}

async function createPendingPair(p1, p2) {
    const pairKey = `mm:pair:${[p1, p2].sort().join(":")}`;

    const pending = {
        p1,
        p2,
        accepted: [],
    };
    
    const created = await mmRedis.set(
        pairKey,
        JSON.stringify(pending),
        { NX: true }
    );
    
    if (created === null) {
        await mmRedis.set(`mm:user:pending:${p1}`, pairKey);
        await mmRedis.set(`mm:user:pending:${p2}`, pairKey);
        return pairKey;
    }
    
    await mmRedis.set(`mm:user:pending:${p1}`, pairKey);
    await mmRedis.set(`mm:user:pending:${p2}`, pairKey);

    return pairKey;
}

// принять pending и возможно создать матч
async function acceptPair(userId) {
    const pendingPair = await getPendingPair(userId);
    if (!pendingPair) return { status: "no_pending" };

    const { key: pairId, data: pending } = pendingPair;

    if (!pending.accepted.includes(userId)) {
        pending.accepted.push(userId);
        await mmRedis.set(pairId, JSON.stringify(pending));
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

    return { status: "match_created", match };

}

/* ---------------- ENDPOINTS ---------------- */

// 1️⃣ ВСТАТЬ В ОЧЕРЕДЬ
app.post("/matchmaking/enqueue", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "userId is required" });

        const pendingPair = await getPendingPair(userId);
        if (pendingPair) {
            return res.json({ status: "already_found" });
        }

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

        const pendingPair = await getPendingPair(userId);
        if (pendingPair) {
            const pending = pendingPair.data;
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

        const queueMeta = await getQueueMeta(userId);
        if (!queueMeta) {
            return res.json({ status: "not_in_queue" });
        }

        const opponentId = await findOpponent(userId);
        if (!opponentId) {
            return res.json({ status: "searching" });
        }

        const opponentAvailable = await isAvailableForPairing(opponentId);
        if (!opponentAvailable) {
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

app.post("/matchmaking/dequeue", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: "userId is required" });
        }

        // 1) Удаляем из рейтинговой очереди и меты
        const removedFromQueue = await mmRedis.zRem("mm:queue:rating", userId);
        await mmRedis.del(`mm:queue:meta:${userId}`);

        // 2) Если был в pending-паре — чистим пару и второго игрока
        const pendingKey = await mmRedis.get(`mm:user:pending:${userId}`);
        if (pendingKey) {
            const pendingRaw = await mmRedis.get(pendingKey);

            if (pendingRaw) {
                const pending = JSON.parse(pendingRaw);
                const opponentId = pending.p1 === userId ? pending.p2 : pending.p1;

                await mmRedis.del(`mm:user:pending:${opponentId}`);
            }

            await mmRedis.del(pendingKey);
            await mmRedis.del(`mm:user:pending:${userId}`);
        }

        // 3) Ссылку на матч у этого пользователя тоже убираем
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
